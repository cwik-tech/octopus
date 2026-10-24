/**
 * One bounded correction round for the skills an Agent draft carried.
 *
 * The Agent Architect writes a persona and its skills in one answer, and it
 * sometimes writes a `description` that says what a skill is about and never
 * says when to use it. The model reproduces that mistake on every
 * regeneration, so a build that only reports the violation can be retried
 * forever without ever succeeding. This is the same bounded repair the
 * single-skill author already does, applied to the skills of a planned Agent
 * before anything is staged.
 *
 * Only the document is rewritten. A folder name the specification rejects, and
 * two skills claiming one folder, are decided by fields outside the document,
 * so no rewrite of the document can fix them; those are refused without
 * spending a provider call, exactly as they fail today.
 *
 * There is no generation gate here. The caller already holds this Agent's
 * permit for the whole of its generation, and the draft call it covered has
 * returned by the time a repair runs, so there is no second concurrent call to
 * bound. A repair that waited for a permit its own caller is holding would
 * never be admitted.
 */

import type { GeneratedSkill } from '../../contracts/agent-generator.js'
import { whenDefined } from '../../core/optional-properties.js'
import { PROVIDER_HTTP_REQUEST_TIMEOUT_MS } from '../../core/timeout-manager.js'
import {
  loadArchitectConfig,
  WorkflowArchitectNotConfiguredError,
} from '../provider/architect-model-config.js'
import { callModel, readApiKey, type ModelMessage } from '../provider/model-client.js'
import { SKILL_AUTHORING_RULES } from './skill-authoring-rules.js'
import {
  findSkillBatchViolations,
  SKILL_SPEC_MAX_NAME_LENGTH,
  SKILL_SPEC_NAME_PATTERN,
  SkillSpecViolationError,
  type SkillPublicationSource,
  type SkillSpecViolation,
} from './skill-spec-validation.js'

/**
 * The generated skills as the publication boundary sees them.
 *
 * Identical to what `commit-agent` builds for the same skills, and the single
 * place this module and its caller agree on a skill's path. A caller that
 * spelled a path differently would hand over violations this module could
 * match to no skill, and every repair would silently be refused as
 * unrepairable.
 */
export function describeGeneratedSkillSources(
  skills: readonly GeneratedSkill[],
): SkillPublicationSource[] {
  return skills.map((skill) => ({
    origin: 'generated',
    folderName: skill.name,
    source: skill.body,
    skillPath: skillPathFor(skill.name),
  }))
}

export interface SkillSpecRepairResult {
  /** Every skill in plan order, with only the repaired bodies replaced. */
  skills: GeneratedSkill[]
  /** Folder names whose document a repair rewrote, in plan order. */
  repairedSkillNames: string[]
}

/** Raised when a document still breaks the specification after one repair. */
export class SkillSpecRepairError extends Error {
  constructor(readonly violations: readonly SkillSpecViolation[]) {
    super(
      `Skill still does not satisfy the Agent Skills specification after one repair: ${
        violations
          .map((violation) => `${violation.skillPath}: ${violation.problem}`)
          .join('; ')
      }`,
    )
    this.name = 'SkillSpecRepairError'
  }
}

/**
 * How long one repair call may take.
 *
 * The shared model client bounds its HTTP routes, but the architect model can
 * be a CLI provider, and that route forwards the caller's signal without
 * adding one of its own. Nobody is watching a repair, so a call nobody is
 * bounding would hold the Agent's generation permit indefinitely.
 */
export const SKILL_SPEC_REPAIR_TIMEOUT_MS = PROVIDER_HTTP_REQUEST_TIMEOUT_MS

const SKILL_REPAIR_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 1 },
  },
  required: ['name', 'body'],
  additionalProperties: false,
}

export async function repairGeneratedSkills(params: {
  repoRoot: string
  skills: readonly GeneratedSkill[]
  /** The violations the publication boundary raised for exactly these skills. */
  violations: readonly SkillSpecViolation[]
  provider?: string
  model?: string
  signal?: AbortSignal
  /** Deadline for one repair call. */
  timeoutMs?: number
}): Promise<SkillSpecRepairResult> {
  throwIfAborted(params.signal)
  const skills = params.skills.map((skill) => ({ ...skill }))
  if (params.violations.length === 0) return { skills, repairedSkillNames: [] }

  const repairable = findRepairableSkills(skills)
  const byPath = groupViolationsByPath(params.violations)
  for (const skillPath of byPath.keys()) {
    // A violation about something a rewritten document cannot change ends the
    // operation before any provider is asked. Reported with the error the
    // publication boundary itself raises, so the failure a user sees is the
    // one they would have seen without this round at all.
    if (!repairable.has(skillPath)) throw new SkillSpecViolationError(params.violations)
  }

  const route = resolveRoute(params)
  const timeoutMs = params.timeoutMs ?? SKILL_SPEC_REPAIR_TIMEOUT_MS
  const repairedSkillNames: string[] = []
  const remaining: SkillSpecViolation[] = []
  // Sequential on purpose: the caller holds one permit for this Agent, and
  // repairing several skills at once would put more calls in flight than that
  // permit accounts for.
  for (const [skillPath, violations] of byPath) {
    throwIfAborted(params.signal)
    const candidate = repairable.get(skillPath)
    if (!candidate) continue
    const repaired = await repairOneSkill({
      ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
      route,
      timeoutMs,
      skill: candidate.skill,
      skillPath,
      violations,
    })
    if ('problem' in repaired) {
      remaining.push({ skillPath, problem: repaired.problem })
      continue
    }
    skills[candidate.index] = { ...candidate.skill, body: repaired.body }
    repairedSkillNames.push(candidate.skill.name)
  }

  if (remaining.length > 0) throw new SkillSpecRepairError(remaining)
  return { skills, repairedSkillNames }
}

interface RepairCandidate {
  index: number
  skill: GeneratedSkill
}

/**
 * The skills whose problems a rewritten document could actually fix, by path.
 *
 * Everything here is what `findSkillBatchViolations` decides from fields
 * outside the document: an unusable folder name, and a folder two skills
 * claim. Excluding them is what keeps a provider call from being spent on a
 * violation it has no way to address.
 */
function findRepairableSkills(
  skills: readonly GeneratedSkill[],
): Map<string, RepairCandidate> {
  const claims = new Map<string, number>()
  for (const skill of skills) {
    claims.set(skill.name, (claims.get(skill.name) ?? 0) + 1)
  }
  const repairable = new Map<string, RepairCandidate>()
  for (const [index, skill] of skills.entries()) {
    const folderName = skill.name
    if (!folderName) continue
    if (!SKILL_SPEC_NAME_PATTERN.test(folderName)) continue
    if (folderName.length > SKILL_SPEC_MAX_NAME_LENGTH) continue
    if ((claims.get(folderName) ?? 0) > 1) continue
    repairable.set(skillPathFor(folderName), { index, skill })
  }
  return repairable
}

/** Where a generated skill's problems are reported. */
function skillPathFor(folderName: string): string {
  return `skills/${folderName || '(unnamed)'}/SKILL.md`
}

function groupViolationsByPath(
  violations: readonly SkillSpecViolation[],
): Map<string, SkillSpecViolation[]> {
  const grouped = new Map<string, SkillSpecViolation[]>()
  for (const violation of violations) {
    const existing = grouped.get(violation.skillPath)
    if (existing) existing.push(violation)
    else grouped.set(violation.skillPath, [violation])
  }
  return grouped
}

interface SkillSpecRepairRoute {
  apiKey: string
  provider: string
  model: string
}

function resolveRoute(params: {
  repoRoot: string
  provider?: string
  model?: string
}): SkillSpecRepairRoute {
  let config
  try {
    config = loadArchitectConfig(params.repoRoot)
  } catch (error) {
    throw new Error(
      `Skill repair is not configured: ${
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
    throw new Error(`Skill repair cannot reach ${provider}: ${key.envVar} is not set`)
  }
  return { apiKey: key.apiKey, provider, model }
}

/** A corrected document, or why this skill is still not publishable. */
type OneRepairOutcome = { body: string } | { problem: string }

async function repairOneSkill(params: {
  signal?: AbortSignal
  route: SkillSpecRepairRoute
  timeoutMs: number
  skill: GeneratedSkill
  skillPath: string
  violations: readonly SkillSpecViolation[]
}): Promise<OneRepairOutcome> {
  const messages: ModelMessage[] = [
    { role: 'user', content: renderRepairRequest(params.skill, params.violations) },
  ]
  const answer = await callSkillRepair(params, messages)
  if (answer === null) {
    return {
      problem: 'the repair did not return a JSON object carrying `name` and `body`',
    }
  }
  if (answer.name !== params.skill.name) {
    // The folder is settled before the repair is asked for. A document
    // authored for a different skill published here would put one skill's
    // content under another skill's name.
    return {
      problem:
        `the repair returned skill \`${answer.name}\`, but this document belongs to \`${params.skill.name}\``,
    }
  }
  const stillWrong = findSkillBatchViolations([{
    origin: 'generated',
    folderName: params.skill.name,
    source: answer.body,
    skillPath: params.skillPath,
  }])
  const first = stillWrong[0]
  if (first) return { problem: first.problem }
  return { body: answer.body }
}

interface SkillCandidate {
  name: string
  body: string
}

/**
 * One repair call, bounded by its own deadline.
 *
 * The caller's withdrawal and this call's deadline are kept apart even though
 * the provider is handed one signal: they mean different things, and reporting
 * a deadline as a cancellation would tell the user they stopped something they
 * never touched.
 */
async function callSkillRepair(
  params: { signal?: AbortSignal; route: SkillSpecRepairRoute; timeoutMs: number },
  messages: ModelMessage[],
): Promise<SkillCandidate | null> {
  throwIfAborted(params.signal)
  const deadline = AbortSignal.timeout(params.timeoutMs)
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline])
    : deadline
  let result
  try {
    result = await callModel(params.route.apiKey, {
      provider: params.route.provider,
      model: params.route.model,
      systemPrompt: buildSkillRepairSystemPrompt(),
      messages,
      outputSchema: SKILL_REPAIR_OUTPUT_SCHEMA,
      signal,
    })
  } catch (error) {
    throwIfAborted(params.signal)
    if (deadline.aborted) throw deadlineError(params.timeoutMs)
    throw error
  }
  throwIfAborted(params.signal)
  if (!result.ok) {
    if (deadline.aborted) throw deadlineError(params.timeoutMs)
    throw new Error(`The skill repair did not answer: ${result.reason}`)
  }
  return parseSkillCandidate(result.text)
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

function buildSkillRepairSystemPrompt(): string {
  return [
    '# Skill Repair',
    '',
    'You correct exactly one SKILL.md that an Agent draft already produced. The',
    'Agent, its persona, its other skills, and this skill\'s folder name are all',
    'settled and are not yours to change. Fix the problems you are given and',
    'return the complete corrected file, keeping everything else about the',
    'document as it was.',
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
    '  "body": "<the full corrected SKILL.md, including its YAML frontmatter>"',
    '}',
    '```',
    '',
    'Return the folder name exactly as given. This is the only correction',
    'round: a second document that breaks the specification ends the build and',
    'nothing is written.',
  ].join('\n')
}

function renderRepairRequest(
  skill: GeneratedSkill,
  violations: readonly SkillSpecViolation[],
): string {
  return [
    `Skill folder name: \`${skill.name}\``,
    '',
    'The SKILL.md below breaks the Agent Skills specification:',
    '',
    ...violations.map((violation) => `- ${violation.problem}`),
    '',
    'That document was:',
    '',
    '```md',
    skill.body,
    '```',
    '',
    'Return the corrected file as a single JSON object with exactly `name` and',
    '`body`, in a fenced ```json ... ``` block and nothing else.',
  ].join('\n')
}

function deadlineError(timeoutMs: number): Error {
  return new Error(`The skill repair did not answer within ${timeoutMs}ms`)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('Skill repair cancelled')
  error.name = 'AbortError'
  throw error
}
