/**
 * Authoring one `SKILL.md` from an instruction, with one bounded repair.
 *
 * There is no fallback document. Every other generator here can fall back to
 * something serviceable because the alternative is no Agent at all; this one
 * would be writing over a skill the user already has, and a placeholder
 * published in place of a rewrite is worse than a failure that changed
 * nothing. A provider that cannot be reached, or answers twice with something
 * that breaks the specification, ends the operation.
 *
 * For an update the Agent's current document goes in as context and is never
 * validated. It may well be broken — that is usually why the rewrite was
 * requested — and only what comes back has to conform.
 */

import { whenDefined } from '../../core/optional-properties.js'
import { PROVIDER_HTTP_REQUEST_TIMEOUT_MS } from '../../core/timeout-manager.js'
import {
  loadArchitectConfig,
  WorkflowArchitectNotConfiguredError,
} from '../provider/architect-model-config.js'
import { callModel, readApiKey, type ModelMessage } from '../provider/model-client.js'
import type { PlannedAgentGenerationGate } from './planned-agent-builder.js'
import { SKILL_AUTHORING_RULES } from './skill-authoring-rules.js'
import {
  findSkillBatchViolations,
  type SkillSpecViolation,
} from './skill-spec-validation.js'

export interface SkillGenerationRequest {
  agentId: string
  action: 'create' | 'update'
  name: string
  instruction: string
  /** The skill's current document, for an update. */
  currentSource?: string
}

export interface SkillGenerationResult {
  /** The exact `SKILL.md` bytes to publish. */
  source: string
  /** Whether the first candidate was invalid and one repair was requested. */
  repaired: boolean
}

export class SkillGenerationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SkillGenerationError'
  }
}

/**
 * How long one authoring call may take.
 *
 * The shared model client puts a deadline on its HTTP routes, but the
 * architect model can be a CLI provider, and that route forwards the caller's
 * signal without adding one of its own. A skill author is never interactive,
 * so a call nobody is bounding would hang the whole operation. The deadline is
 * therefore composed here, for every route and for the repair as much as the
 * first call.
 */
export const SKILL_AUTHOR_TIMEOUT_MS = PROVIDER_HTTP_REQUEST_TIMEOUT_MS

const SKILL_AUTHOR_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 1 },
  },
  required: ['name', 'body'],
  additionalProperties: false,
}

export async function generateSkillDocument(params: {
  repoRoot: string
  request: SkillGenerationRequest
  provider?: string
  model?: string
  signal?: AbortSignal
  gate?: PlannedAgentGenerationGate
  /** Deadline for one provider call, first and repair alike. */
  timeoutMs?: number
}): Promise<SkillGenerationResult> {
  throwIfAborted(params.signal)
  const route = resolveRoute(params)
  const systemPrompt = buildSkillAuthorSystemPrompt()
  const messages: ModelMessage[] = [
    { role: 'user', content: renderSkillBrief(params.request) },
  ]

  const timeoutMs = params.timeoutMs ?? SKILL_AUTHOR_TIMEOUT_MS
  const first = await callSkillAuthor(params, route, systemPrompt, messages, timeoutMs)
  if (!isUnreadable(first)) {
    const firstViolations = findCandidateViolations(params.request, first)
    if (firstViolations.length === 0) return { source: first.body, repaired: false }
  }

  // Exactly one repair, whether the first answer could not be read or was read
  // and refused. A second round would let a provider that cannot follow the
  // specification spend the operation's whole budget discovering that.
  const repairMessages: ModelMessage[] = [
    ...messages,
    {
      role: 'assistant',
      content: isUnreadable(first)
        ? first.text
        : JSON.stringify({ name: first.name, body: first.body }),
    },
    { role: 'user', content: renderRepairRequest(params.request, first) },
  ]
  const second = await callSkillAuthor(params, route, systemPrompt, repairMessages, timeoutMs)
  if (isUnreadable(second)) {
    throw new SkillGenerationError(
      `The skill author did not return a usable answer for \`${params.request.name}\` after one repair: ${second.unreadable}`,
    )
  }
  const secondViolations = findCandidateViolations(params.request, second)
  if (secondViolations.length === 0) return { source: second.body, repaired: true }

  throw new SkillGenerationError(
    `The authored skill \`${params.request.name}\` still breaks the Agent Skills specification after one repair: ${
      describeViolations(secondViolations)
    }`,
  )
}

/**
 * Throws the error authoring would throw when no skill can be authored at all:
 * skill authoring is not configured, or its provider's API key is not set.
 *
 * Neither is about the skill being authored. A caller that reports progress
 * per skill checks this first, so the failure is not blamed on one skill.
 */
export function assertSkillAuthoringReachable(params: {
  repoRoot: string
  provider?: string
  model?: string
}): void {
  resolveRoute(params)
}

interface SkillCandidate {
  name: string
  body: string
}

interface SkillAuthorRoute {
  apiKey: string
  provider: string
  model: string
}

function resolveRoute(params: {
  repoRoot: string
  provider?: string
  model?: string
}): SkillAuthorRoute {
  let config
  try {
    config = loadArchitectConfig(params.repoRoot)
  } catch (error) {
    throw new SkillGenerationError(
      `Skill authoring is not configured: ${
        error instanceof WorkflowArchitectNotConfiguredError || error instanceof Error
          ? error.message
          : String(error)
      }`,
      { cause: error },
    )
  }
  const provider = params.provider?.trim() || config.provider
  const model = params.model?.trim() || config.model
  const key = readApiKey(provider)
  if (key.apiKey == null) {
    throw new SkillGenerationError(
      `Skill authoring cannot reach ${provider}: ${key.envVar} is not set`,
    )
  }
  return { apiKey: key.apiKey, provider, model }
}

/**
 * One provider call, inside the shared budget.
 *
 * The repair is a provider call like any other, so it waits for capacity like
 * any other. A repair that skipped the gate would let one operation hold two
 * slots and quietly double the configured cap.
 */
async function callSkillAuthor(
  params: { signal?: AbortSignal; gate?: PlannedAgentGenerationGate },
  route: SkillAuthorRoute,
  systemPrompt: string,
  messages: ModelMessage[],
  timeoutMs: number,
): Promise<SkillAuthorAnswer> {
  throwIfAborted(params.signal)
  await params.gate?.acquire(params.signal)
  // The caller's withdrawal and this call's own deadline are kept apart even
  // though the provider is given one signal: they mean different things, and
  // reporting a deadline as a cancellation would tell the user they stopped
  // something they never touched.
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline])
    : deadline
  let result
  try {
    throwIfAborted(params.signal)
    result = await callModel(route.apiKey, {
      provider: route.provider,
      model: route.model,
      systemPrompt,
      messages,
      outputSchema: SKILL_AUTHOR_OUTPUT_SCHEMA,
      signal,
    })
  } catch (error) {
    throwIfAborted(params.signal)
    if (deadline.aborted) throw deadlineError(timeoutMs)
    throw error
  } finally {
    params.gate?.release()
  }
  throwIfAborted(params.signal)
  if (!result.ok) {
    if (deadline.aborted) throw deadlineError(timeoutMs)
    throw new SkillGenerationError(`The skill author did not answer: ${result.reason}`)
  }
  const candidate = parseSkillCandidate(result.text)
  if (!candidate) {
    // Unreadable output is exactly the mistake one correction round exists to
    // fix, so it is reported rather than thrown: the caller decides whether a
    // repair is still available.
    return {
      unreadable: `it was not a JSON object carrying \`name\` and \`body\`: ${
        result.text.slice(0, 200)
      }`,
      text: result.text,
    }
  }
  return candidate
}

/** What one call produced: a candidate, or why it could not be read as one. */
type SkillAuthorAnswer = SkillCandidate | { unreadable: string; text: string }

function isUnreadable(
  answer: SkillAuthorAnswer,
): answer is { unreadable: string; text: string } {
  return "unreadable" in answer
}

/**
 * Reads the answer as untrusted text.
 *
 * Nothing is cast: the candidate is built from two named fields, both of which
 * have to be non-empty strings, or there is no candidate at all.
 */
function parseSkillCandidate(text: string): SkillCandidate | null {
  const source = extractJson(text)
  if (!source) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  if (!('name' in parsed) || !('body' in parsed)) return null
  const name = parsed.name
  const body = parsed.body
  if (typeof name !== 'string' || name.length === 0) return null
  if (typeof body !== 'string' || body.length === 0) return null
  return { name, body }
}

/**
 * Everything wrong with one candidate.
 *
 * The name is compared exactly. A candidate that authored a different skill is
 * not this skill under another label: publishing it would put one skill's
 * content in another skill's folder.
 */
function findCandidateViolations(
  request: SkillGenerationRequest,
  candidate: SkillCandidate,
): SkillSpecViolation[] {
  const skillPath = `agents/${request.agentId}/skills/${request.name}/SKILL.md`
  const violations: SkillSpecViolation[] = []
  if (candidate.name !== request.name) {
    violations.push({
      skillPath,
      problem:
        `the author returned skill \`${candidate.name}\`, but this operation authors \`${request.name}\``,
    })
  }
  violations.push(
    ...findSkillBatchViolations([{
      origin: 'generated',
      folderName: request.name,
      source: candidate.body,
      skillPath,
    }]),
  )
  return violations
}

function describeViolations(violations: readonly SkillSpecViolation[]): string {
  return violations.map((violation) => violation.problem).join('; ')
}

function buildSkillAuthorSystemPrompt(): string {
  return [
    '# Skill Author',
    '',
    'You author exactly one SKILL.md file for an Agent that already exists. You',
    'do not write the persona, you do not touch any other skill, and you do not',
    'decide which skill is being changed — all of that is settled before you are',
    'asked. Write the complete file the instruction describes.',
    '',
    SKILL_AUTHORING_RULES,
    '',
    '## What you return',
    '',
    'A single JSON object, in a fenced ```json ... ``` block, with no other',
    'prose:',
    '',
    '```json',
    '{',
    '  "name": "<the exact skill folder name you were given>",',
    '  "body": "<the full SKILL.md file, including its YAML frontmatter>"',
    '}',
    '```',
    '',
    'Return the folder name exactly as given. Do not rename the skill, do not',
    'shorten it, and do not add surrounding whitespace: it is the folder the',
    'file is written into and the `name` its own frontmatter must carry.',
  ].join('\n')
}

function renderSkillBrief(request: SkillGenerationRequest): string {
  const lines = [
    `Agent: \`${request.agentId}\``,
    `Skill folder name: \`${request.name}\``,
    request.action === 'create'
      ? 'Action: create a skill this Agent does not have yet.'
      : 'Action: rewrite a skill this Agent already has.',
    '',
    'Instruction:',
    request.instruction,
  ]
  if (request.action === 'update' && request.currentSource !== undefined) {
    lines.push(
      '',
      'The skill\'s current SKILL.md follows. It is context for the rewrite, not',
      'a model to copy: it may itself break the rules above, in which case fixing',
      'it is part of what you were asked to do.',
      '',
      '```md',
      request.currentSource,
      '```',
    )
  }
  return lines.join('\n')
}

function renderRepairRequest(
  request: SkillGenerationRequest,
  answer: SkillAuthorAnswer,
): string {
  const closing = [
    '',
    'Return the corrected file as a single JSON object with exactly `name` and',
    '`body`, in a fenced ```json ... ``` block and nothing else. This is the',
    'only correction round: a second unusable answer ends the operation and',
    'nothing is written to the Agent.',
  ]
  if (isUnreadable(answer)) {
    return [
      `Your answer for \`${request.name}\` could not be read: ${answer.unreadable}`,
      ...closing,
    ].join('\n')
  }
  const violations = findCandidateViolations(request, answer)
  return [
    `The SKILL.md you returned for \`${request.name}\` breaks the Agent Skills`,
    'specification:',
    '',
    ...violations.map((violation) => `- ${violation.problem}`),
    '',
    'That document was:',
    '',
    '```md',
    answer.body,
    '```',
    ...closing,
  ].join('\n')
}

/** The first complete JSON object in the reply, fenced or bare. */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)?.[1]
  if (fenced) return fenced.trim()
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') quoted = !quoted
    if (quoted) continue
    if (character === '{') depth += 1
    if (character === '}' && --depth === 0) return text.slice(start, index + 1)
  }
  return null
}

function deadlineError(timeoutMs: number): SkillGenerationError {
  return new SkillGenerationError(
    `The skill author did not answer within ${timeoutMs}ms`,
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('Skill authoring cancelled')
  error.name = 'AbortError'
  throw error
}
