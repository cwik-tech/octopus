import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { after, before } from 'node:test'

import { DEEP_RESEARCH_STABLE_SYSTEM_PROMPT } from '../../domains/deep-research/deep-research-prompt-envelope.js'
import { MCP_WORKER_TURN_CONTRACT_VERSION } from '../../domains/mcp/mcp-worker-turn.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import type { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpWorkerTurnService } from '../../services/mcp-worker-turn-service.js'
import {
  startOpenAiToolLoopFixture,
  type OpenAiToolLoopFixture,
} from '../support/openai-tool-loop-fixture.js'

/**
 * The provider fixture refuses a Deep Research request whose text contradicts
 * the stage it routes to. That guard exists because the regression it names —
 * the evidence-turn block injected into every worker, section writers and
 * synthesizers included — passed the whole suite: the fixture answered the
 * stage marker and ignored the injected rules.
 *
 * No suite reaches the guard on its own. Every Deep Research journey points its
 * agents straight at this fixture, so `McpWorkerTurnService` never composes
 * their prompts and no rules block is injected for the guard to judge. These
 * cases are therefore the guard's only committed protection: they compose the
 * prompts through the real service, send them over the real transport, and
 * pin refusal and acceptance for each branch.
 *
 * Each branch is pinned at both of the fixture's call sites, because each one
 * reads its request text from a different body shape and the guard is only as
 * good as the text it is handed: `/v1/chat/completions`, and `/v1/responses` —
 * the endpoint the `openai` provider posts to, and therefore the one every
 * Electron Deep Research journey travels.
 */

const repoRoot = process.cwd()
const SECTION_WRITER_AGENT_PROMPT = fs.readFileSync(
  path.join(
    repoRoot,
    'agents',
    'research-section-writer',
    'research-section-writer.md',
  ),
  'utf8',
)
/**
 * The heading the section writer's agent file opens with. Both the fixture's
 * stage routing and its guard key on it, so a rename breaks these cases loudly
 * instead of quietly routing somewhere else.
 */
const SECTION_WRITER_HEADING = '# Research Section Writer'
/** What the runtime fences into a section-writer request, in miniature. */
const SECTION_DOSSIER_MESSAGE = [
  '# Section Evidence Dossier',
  '',
  'Draft the report section "Launch evidence" using only the evidence below.',
  '',
  '```json',
  JSON.stringify({
    sectionId: 'launch-evidence',
    title: 'Launch evidence',
    claims: [{
      claimId: 'claim-T1',
      statement: 'The launch evidence is verified and ready for a bounded decision',
    }],
    sources: [{
      sourceId: 'source-T1',
      canonicalUrl: 'https://127.0.0.1/launch-evidence',
    }],
  }, null, 2),
  '```',
].join('\n')
const RESEARCH_ASSIGNMENT_MESSAGE = [
  'ASSIGNMENT_JSON',
  '---BEGIN UNTRUSTED DATA---',
  JSON.stringify({
    question: 'Which official sources document current coding-agent controls?',
  }),
  '---END UNTRUSTED DATA---',
].join('\n')

let fixture: OpenAiToolLoopFixture
/**
 * The prompts under test, every one of them composed by the real
 * `withMcpToolRules` inside `McpWorkerTurnService`. Quoting the rule wording
 * here instead would let production reword a rule while these cases kept
 * proving the guard against the old text.
 */
let sectionWriterWithEvidenceBlock: string
let sectionWriterWithJsonOnlyRule: string
let sectionWriterWithoutEvidenceBlock: string
let evidenceTurnAcquire: string
let evidenceTurnPacketCorrection: string
let evidenceTurnWithoutMode: string
let evidenceTurnCarryingBothModes: string
let acquireRules: string
/** The first line the acquire mode adds — the evidence-turn marker itself. */
let evidenceTurnMarkerRule: string
/** The rest of the acquire block, which carries the JSON-only order. */
let acquireRulesAfterMarker: string
/** The lines the packet-correction mode adds and the acquire mode does not. */
let packetCorrectionRules: string

before(async () => {
  fixture = await startOpenAiToolLoopFixture(repoRoot)

  evidenceTurnAcquire = await composedWorkerSystemPrompt({
    agentPath: 'agents/web-researcher',
    systemPrompt: DEEP_RESEARCH_STABLE_SYSTEM_PROMPT,
    evidenceMode: 'acquire',
  })
  evidenceTurnPacketCorrection = await composedWorkerSystemPrompt({
    agentPath: 'agents/web-researcher',
    systemPrompt: DEEP_RESEARCH_STABLE_SYSTEM_PROMPT,
    evidenceMode: 'reuse-existing',
  })
  // The same researcher outside the evidence lane: the ordinary rules block and
  // nothing else. It is a Deep Research prompt whose injected block names no
  // mode — the inverse of the regression, and a runtime that dropped the mode.
  evidenceTurnWithoutMode = await composedWorkerSystemPrompt({
    agentPath: 'agents/web-researcher',
    systemPrompt: DEEP_RESEARCH_STABLE_SYSTEM_PROMPT,
  })
  sectionWriterWithoutEvidenceBlock = await composedWorkerSystemPrompt({
    agentPath: 'agents/research-section-writer',
    systemPrompt: SECTION_WRITER_AGENT_PROMPT,
  })

  // `withMcpToolRules` appends its block to the caller's prompt, so the block a
  // mode produces is what the composed prompt adds past that prompt's end.
  assert.ok(evidenceTurnAcquire.startsWith(DEEP_RESEARCH_STABLE_SYSTEM_PROMPT))
  assert.ok(evidenceTurnPacketCorrection.startsWith(DEEP_RESEARCH_STABLE_SYSTEM_PROMPT))
  assert.ok(evidenceTurnWithoutMode.startsWith(DEEP_RESEARCH_STABLE_SYSTEM_PROMPT))
  acquireRules = evidenceTurnAcquire.slice(DEEP_RESEARCH_STABLE_SYSTEM_PROMPT.length)
  const ordinaryRules = evidenceTurnWithoutMode.slice(
    DEEP_RESEARCH_STABLE_SYSTEM_PROMPT.length,
  )
  const packetCorrectionLines = evidenceTurnPacketCorrection
    .slice(DEEP_RESEARCH_STABLE_SYSTEM_PROMPT.length)
    .split('\n')
    .filter((line) => line.trim().length > 0 && !ordinaryRules.includes(line))
  assert.ok(packetCorrectionLines.length > 0)
  packetCorrectionRules = packetCorrectionLines.join('\n')
  // The acquire block's own lines, in the order production writes them. Taken
  // positionally so no rule wording is copied into this file.
  const acquireOnlyLines = acquireRules
    .split('\n')
    .filter((line) => line.trim().length > 0 && !ordinaryRules.includes(line))
  assert.ok(acquireOnlyLines.length > 1)
  evidenceTurnMarkerRule = acquireOnlyLines[0] ?? ''
  acquireRulesAfterMarker = acquireOnlyLines.slice(1).join('\n')

  // The regression itself: the section writer's own prompt under the block the
  // evidence lane appends. The fixed service will not compose it — that is the
  // fix — so it is reassembled from the two halves production still writes.
  sectionWriterWithEvidenceBlock = SECTION_WRITER_AGENT_PROMPT + acquireRules
  // The same regression with the marker line missing, so the JSON-only order is
  // the only evidence rule left standing. See the case that sends it.
  sectionWriterWithJsonOnlyRule = [
    SECTION_WRITER_AGENT_PROMPT + ordinaryRules,
    acquireRulesAfterMarker,
  ].join('\n')
  evidenceTurnCarryingBothModes = [
    evidenceTurnAcquire,
    ...packetCorrectionLines,
  ].join('\n')
})

after(async () => {
  await fixture.close()
})

test('the fixture refuses a section-writer turn carrying the evidence-turn block', async () => {
  const answer = await askChatCompletionsFixture(
    sectionWriterWithEvidenceBlock,
    SECTION_DOSSIER_MESSAGE,
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.ok(answer.errorMessage.includes(SECTION_WRITER_HEADING))
  assert.ok(
    acquireRules
      .split('\n')
      .some((rule) => rule.trim().length > 0 && answer.errorMessage.includes(rule)),
  )
  assert.equal(answer.content, '')
})

test('the fixture drafts the same section once the evidence-turn block is gone', async () => {
  const answer = await askChatCompletionsFixture(
    sectionWriterWithoutEvidenceBlock,
    SECTION_DOSSIER_MESSAGE,
  )

  assert.equal(answer.status, 200)
  assert.equal(answer.errorMessage, '')
  const draft: unknown = JSON.parse(answer.content)
  assert.equal(recordField(draft, 'status'), 'section_complete')
  assert.equal(recordField(draft, 'sectionId'), 'launch-evidence')
})

test('the fixture refuses an evidence turn whose injected block names no mode', async () => {
  const answer = await askChatCompletionsFixture(
    evidenceTurnWithoutMode,
    RESEARCH_ASSIGNMENT_MESSAGE,
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.match(answer.errorMessage, /MCP tool rules:/)
  assert.equal(answer.content, '')
})

test('the fixture answers an evidence turn in either governed mode', async () => {
  const acquired = await askChatCompletionsFixture(evidenceTurnAcquire, RESEARCH_ASSIGNMENT_MESSAGE)
  const corrected = await askChatCompletionsFixture(
    evidenceTurnPacketCorrection,
    RESEARCH_ASSIGNMENT_MESSAGE,
  )

  // No stage answer is scripted for a bare researcher turn, so the fixture's
  // ordinary "nothing to say" reply is what acceptance looks like here.
  assert.equal(acquired.status, 200)
  assert.equal(acquired.errorMessage, '')
  assert.equal(acquired.content, 'NOOP')
  assert.equal(corrected.status, 200)
  assert.equal(corrected.errorMessage, '')
  assert.equal(corrected.content, 'NOOP')
})

test('the fixture refuses an evidence turn carrying both governed modes', async () => {
  const answer = await askChatCompletionsFixture(
    evidenceTurnCarryingBothModes,
    RESEARCH_ASSIGNMENT_MESSAGE,
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.match(answer.errorMessage, /both the acquire rules and the bounded packet-correction rule/)
  assert.equal(answer.content, '')
})

test('the fixture refuses a contradiction its stage routing reads from the user message', async () => {
  // The fixture picks its answer from the system prompt and the user messages
  // together, so a guard reading only the system prompt can be walked around:
  // the agent file goes in the user message, the evidence rules stay in the
  // system prompt, and the routing answers as the section writer regardless.
  const answer = await askChatCompletionsFixture(
    `You are a worker.${acquireRules}`,
    [SECTION_WRITER_AGENT_PROMPT, SECTION_DOSSIER_MESSAGE].join('\n\n'),
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.ok(answer.errorMessage.includes(SECTION_WRITER_HEADING))
  assert.equal(answer.content, '')
})

test('the responses endpoint refuses a section-writer turn carrying the evidence-turn block', async () => {
  const answer = await askResponsesFixture(
    sectionWriterWithEvidenceBlock,
    SECTION_DOSSIER_MESSAGE,
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.ok(answer.errorMessage.includes(SECTION_WRITER_HEADING))
  assert.ok(
    acquireRules
      .split('\n')
      .some((rule) => rule.trim().length > 0 && answer.errorMessage.includes(rule)),
  )
  assert.equal(answer.content, '')
})

test('the responses endpoint refuses a section-writer turn ordered to answer in JSON only', async () => {
  // The guard lists the JSON-only order as a refusable rule in its own right,
  // but nothing production composes reaches that entry: the order rides in the
  // same block as the evidence-turn marker, which sits on an earlier line and
  // is matched first. Dropping the marker line is what puts the entry to work,
  // and the JSON-only half is the one that corrupts the answer — it orders a
  // section writer to reply with a bare JSON object instead of the prose the
  // run asked for. This is also the only case that makes the fixture's copy of
  // that sentence load-bearing: reword it in production without rewording it in
  // the fixture and the refusal below disappears.
  assert.ok(!sectionWriterWithJsonOnlyRule.includes(evidenceTurnMarkerRule))
  assert.ok(!sectionWriterWithJsonOnlyRule.includes(packetCorrectionRules))

  const answer = await askResponsesFixture(
    sectionWriterWithJsonOnlyRule,
    SECTION_DOSSIER_MESSAGE,
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.ok(answer.errorMessage.includes(SECTION_WRITER_HEADING))
  const quotedRule = answer.errorMessage.match(/carries "([\s\S]+)"$/)?.[1]
  assert.ok(quotedRule)
  assert.ok(acquireRulesAfterMarker.includes(quotedRule))
  assert.equal(answer.content, '')
})

test('the responses endpoint drafts the same section once the evidence-turn block is gone', async () => {
  const answer = await askResponsesFixture(
    sectionWriterWithoutEvidenceBlock,
    SECTION_DOSSIER_MESSAGE,
  )

  assert.equal(answer.status, 200)
  assert.equal(answer.errorMessage, '')
  const draft: unknown = JSON.parse(answer.content)
  assert.equal(recordField(draft, 'status'), 'section_complete')
  assert.equal(recordField(draft, 'sectionId'), 'launch-evidence')
})

test('the responses endpoint refuses an evidence turn whose injected block names no mode', async () => {
  const answer = await askResponsesFixture(
    evidenceTurnWithoutMode,
    RESEARCH_ASSIGNMENT_MESSAGE,
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.match(answer.errorMessage, /MCP tool rules:/)
  assert.equal(answer.content, '')
})

test('the responses endpoint answers an evidence turn in either governed mode', async () => {
  const acquired = await askResponsesFixture(
    evidenceTurnAcquire,
    RESEARCH_ASSIGNMENT_MESSAGE,
  )
  const corrected = await askResponsesFixture(
    evidenceTurnPacketCorrection,
    RESEARCH_ASSIGNMENT_MESSAGE,
  )

  // No stage answer is scripted for a bare researcher turn, so the fixture's
  // ordinary "nothing to say" reply is what acceptance looks like here.
  assert.equal(acquired.status, 200)
  assert.equal(acquired.errorMessage, '')
  assert.equal(acquired.content, 'NOOP')
  assert.equal(corrected.status, 200)
  assert.equal(corrected.errorMessage, '')
  assert.equal(corrected.content, 'NOOP')
})

test('the responses endpoint refuses an evidence turn carrying both governed modes', async () => {
  const answer = await askResponsesFixture(
    evidenceTurnCarryingBothModes,
    RESEARCH_ASSIGNMENT_MESSAGE,
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.match(answer.errorMessage, /both the acquire rules and the bounded packet-correction rule/)
  assert.equal(answer.content, '')
})

test('the responses endpoint refuses a contradiction its stage routing reads from the user message', async () => {
  // A responses body carries the system prompt and the user message as separate
  // input entries, and the fixture's stage routing reads both of them joined.
  // A guard that judged only the `role: "system"` entry could therefore be
  // walked around here exactly as it could on chat completions.
  const answer = await askResponsesFixture(
    `You are a worker.${acquireRules}`,
    [SECTION_WRITER_AGENT_PROMPT, SECTION_DOSSIER_MESSAGE].join('\n\n'),
  )

  assert.equal(answer.status, 400)
  assert.match(answer.errorMessage, /Deep Research prompt contradiction/)
  assert.ok(answer.errorMessage.includes(SECTION_WRITER_HEADING))
  assert.equal(answer.content, '')
})

interface FixtureAnswer {
  readonly status: number
  readonly errorMessage: string
  readonly content: string
}

async function askChatCompletionsFixture(
  systemPrompt: string,
  userMessage: string,
): Promise<FixtureAnswer> {
  const response = await fetch(`${fixture.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture/deep-research',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  })
  const payload: unknown = await response.json()
  const error = recordField(payload, 'error')
  const errorMessage = recordField(error, 'message')
  const choices = recordField(payload, 'choices')
  const message = Array.isArray(choices)
    ? recordField(choices[0], 'message')
    : undefined
  const content = recordField(message, 'content')
  return {
    status: response.status,
    errorMessage: typeof errorMessage === 'string' ? errorMessage : '',
    content: typeof content === 'string' ? content : '',
  }
}

/**
 * The same ask, in the body the `openai` provider builds for `/v1/responses`
 * (`providers/openai.ts:86-102`): the prompt and the message as separate input
 * entries, each carrying one `input_text` part. `stream` and the reasoning
 * effort ride along because the real client always sends them; the fixture
 * answers one JSON body either way.
 */
async function askResponsesFixture(
  systemPrompt: string,
  userMessage: string,
): Promise<FixtureAnswer> {
  const response = await fetch(`${fixture.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture/deep-research',
      stream: true,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: userMessage }],
        },
      ],
      reasoning: { effort: 'medium' },
    }),
  })
  const payload: unknown = await response.json()
  const error = recordField(payload, 'error')
  const errorMessage = recordField(error, 'message')
  const content = recordField(payload, 'output_text')
  return {
    status: response.status,
    errorMessage: typeof errorMessage === 'string' ? errorMessage : '',
    content: typeof content === 'string' ? content : '',
  }
}

function recordField(value: unknown, field: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.hasOwn(value, field)
    ? Object.getOwnPropertyDescriptor(value, field)?.value
    : undefined
}

/**
 * The system prompt `McpWorkerTurnService` hands its provider for one turn.
 * Everything the service needs around the prompt is the minimum the sealed
 * authorization path reads: a resolution file on disk, an authority that points
 * at it, and an agent-tool service that records the composed turn instead of
 * calling a provider.
 */
async function composedWorkerSystemPrompt(
  options: {
    readonly agentPath: string
    readonly systemPrompt: string
    readonly evidenceMode?: 'acquire' | 'reuse-existing'
  },
): Promise<string> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-fixture-guard-')),
  )
  try {
    const identity = {
      sessionId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      assignmentId: '33333333-3333-4333-8333-333333333333',
      taskId: '44444444-4444-4444-8444-444444444444',
      processIdentity: '55555555-5555-4555-8555-555555555555',
      workflowId: 'deep-research-report',
      workflowStepId: 'research',
    }
    const location = buildSessionRunAssignmentLocation(
      path.join(directory, 'workspace'),
      identity,
    )
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })
    const resolutionPath = path.join(location.runPath, 'mcp-resolution.json')
    const scheduledAgent = {
      agentPath: options.agentPath,
      provider: 'codex',
      model: 'gpt-5.5',
      supportState: 'supported',
    }
    fs.writeFileSync(resolutionPath, JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      workflowId: identity.workflowId,
      scheduledAgentPaths: [scheduledAgent.agentPath],
      scheduledAgents: [scheduledAgent],
      authorization: {
        state: 'non-authoritative',
        brokerRechecksAtCallTime: true,
      },
      workflowRequirements: [],
      steps: [{
        stepId: identity.workflowStepId,
        scheduledAgentPaths: [scheduledAgent.agentPath],
        scheduledAgents: [scheduledAgent],
        effectiveRequirements: [],
        matches: [],
      }],
      warnings: [],
    }), { mode: 0o444 })

    let observedInput:
      | Parameters<McpAgentToolService['runTurn']>[0]
      | undefined
    const service = new McpWorkerTurnService({
      workspacePath: path.join(directory, 'workspace'),
      sessionStore: {
        async getTaskRecord() {
          return {
            id: identity.taskId,
            sessionId: identity.sessionId,
            runId: identity.runId,
            assignmentId: identity.assignmentId,
            workflowId: identity.workflowId,
            processIdentity: identity.processIdentity,
            status: 'running',
            runPath: location.runPath,
            mcpResolutionPath: resolutionPath,
          } as never
        },
        ownsTaskProcess: () => false,
      },
      authorityResolver: {
        async authorize() {
          return {
            taskId: identity.taskId,
            workflowId: identity.workflowId,
            runPath: location.runPath,
            assignmentPath: fs.realpathSync(location.assignmentPath),
            mcpResolutionPath: resolutionPath,
          }
        },
      },
      agentToolService: {
        async runTurn(input) {
          observedInput = input
          return {
            kind: 'no-tools',
            providerSupport: {
              provider: 'codex',
              state: 'supported',
              mode: 'host-tool-bridge',
            },
          }
        },
      },
    })

    await service.runTurn({
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      ...identity,
      // Only a scoped web-researcher turn with an approved question reaches the
      // evidence lane, which is exactly what the mode gate requires.
      ...(options.evidenceMode
        ? {
            activityScopeId: 'lane-safety',
            governedWebEvidenceMode: options.evidenceMode,
          }
        : {}),
      agentPath: options.agentPath,
      provider: 'codex',
      model: 'default',
      thinking: 'medium',
      systemPrompt: options.systemPrompt,
      userMessage: options.evidenceMode
        ? RESEARCH_ASSIGNMENT_MESSAGE
        : 'Draft the section from the supplied dossier.',
    })
    const composed = observedInput?.systemPrompt
    assert.equal(typeof composed, 'string')
    return composed ?? ''
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
