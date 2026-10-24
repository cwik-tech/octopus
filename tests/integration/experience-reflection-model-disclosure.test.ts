/**
 * Which model wrote an Agent's experience entry, and whether the run says so.
 *
 * When a discussion level ends, each participating Agent is spawned once more
 * to reflect on the session and append to its own experience file. That runs on
 * the Agent's own pair — which is right and stays — but the dispatch never
 * received the assignment it belonged to, so the run kept no telemetry for it
 * and no account of which model did the writing.
 *
 * These are Agents, not the application's own background work. The record is
 * the Agent's own selection: `agent` when it chose, `app-default` when it
 * inherited. Resolving them against the application default would report a
 * model the Agent never ran on.
 *
 * Driven against the real `runExperienceReflections`, the real provider adapter
 * and a real assignment directory, with only the HTTP boundary owned.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { runExperienceReflections } from '../../team-runtime/experience-reflections.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import { STAGE_TYPE } from '../../core/constants.js'
import { parseProviderError } from '../../domains/provider/provider-error.js'
import {
  MCP_WORKER_ACTIVITY_SCOPE_ID_ENV,
  MCP_WORKER_AGENT_DISPLAY_NAME_ENV,
  MCP_WORKER_TURN_CONTRACT_VERSION,
  MCP_WORKER_TURN_URL_ENV,
  MCP_WORKER_WORKFLOW_STEP_ID_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'
import type {
  LevelConfig,
  LoadedAgent,
  RuntimeState,
} from '../../core/types.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'

initProviders()

const APP_DEFAULT_MODEL = 'app-default-reflection-model'
const CHOSEN_MODEL = 'analyst-own-model'
const REFLECTION_ANSWER = '- **What worked:** the phased plan.'
/** A balance the run already carried, so an overwrite is visible as one. */
const INITIAL_COST = 0.5
/** A real Anthropic model id, so the priced control below is not a fiction. */
const PAID_MODEL = 'claude-haiku-4-5-20251001'
/** One million input and one million output tokens at $1 each. */
const EXPECTED_CALL_COST = 2

interface RecordingProvider {
  readonly url: string
  models(): string[]
  close(): Promise<void>
}

async function startProvider(
  answer: string,
  onRequest?: () => void,
): Promise<RecordingProvider> {
  const models: string[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let model = ''
      try {
        model = String((JSON.parse(raw) as { model?: unknown }).model ?? '')
      } catch {
        model = ''
      }
      models.push(model)
      onRequest?.()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model,
        choices: [{ message: { role: 'assistant', content: answer } }],
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    models: () => [...models],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

/**
 * Refuses one named Agent's reflection and answers everyone else.
 *
 * Keyed on the Agent's own system prompt, so the refusal lands on exactly one
 * participant rather than on whichever request happened to arrive first.
 */
async function startFailingForAgent(
  refusedAgent: string,
  answer: string,
): Promise<RecordingProvider> {
  const models: string[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let model = ''
      try {
        model = String((JSON.parse(raw) as { model?: unknown }).model ?? '')
      } catch {
        model = ''
      }
      models.push(model)
      if (raw.includes(`You are ${refusedAgent}`)) {
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'the provider refused' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model,
        choices: [{ message: { role: 'assistant', content: answer } }],
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    models: () => [...models],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

/** The Anthropic Messages shape, for the one case that runs that adapter. */
async function startAnthropicProvider(answer: string): Promise<RecordingProvider> {
  const models: string[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let model = ''
      try {
        model = String((JSON.parse(raw) as { model?: unknown }).model ?? '')
      } catch {
        model = ''
      }
      models.push(model)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'msg_reflection',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    models: () => [...models],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

/**
 * A real worker-turn endpoint, answering the way the parent would.
 *
 * Owned and benign: it exists to be *not* called.
 */
async function startWorkerEndpoint(
  onRequest: () => void,
): Promise<RecordingProvider> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      onRequest()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        version: MCP_WORKER_TURN_CONTRACT_VERSION,
        kind: 'completed',
        text: REFLECTION_ANSWER,
        model: CHOSEN_MODEL,
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        availableToolCount: 0,
        toolCallCount: 0,
        executedToolCallCount: 0,
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    models: () => [],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

/** Refuses every request that is not to the loopback, and records it. */
function denyNonLoopback(): { attempted: string[]; restore(): void } {
  const attempted: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    const { hostname } = new URL(url)
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
      return realFetch(input, init)
    }
    attempted.push(hostname)
    throw new Error(`Refused a non-loopback request to ${hostname}`)
  }
  return {
    attempted,
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

function ownedAssignment(t: TestContext): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-disclosure-')),
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

/**
 * An Agent as the loader would have produced it.
 *
 * `selection` is the point: it is how the run knows whether the pair was this
 * Agent's own decision or one it inherited, and `provider`/`model` alone cannot
 * tell those apart.
 */
function reflectingAgent(
  name: string,
  providerName: string,
  choice: 'own' | 'inherited',
): LoadedAgent {
  const model = choice === 'own' ? CHOSEN_MODEL : APP_DEFAULT_MODEL
  return {
    name,
    model,
    thinking: 'low',
    systemPrompt: `You are ${name}.`,
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
    knowledgeContent: '',
    agentDir: '/unused',
    color: 21,
    provider: providerName,
    selection: {
      provider: providerName,
      model,
      source: choice === 'own' ? 'agent' : 'app-default',
      reason: choice === 'own' ? 'explicit-agent-choice' : 'agent-default',
    },
  } as LoadedAgent
}

const LEVEL: LevelConfig = {
  id: 'deliberation',
  name: 'Deliberation',
  order: 0,
  stage: {
    type: STAGE_TYPE.DISCUSSION,
    coordinator: 'lead',
    participants: ['analyst'],
    config: {
      mode: 'deliberate',
      min_rounds: 1,
      max_rounds: 1,
      constraints: { max_time_minutes: 1, max_budget_usd: 2 },
      output: { format: 'discussion.md', user_review: false },
    },
  },
} as unknown as LevelConfig

function runtimeState(): RuntimeState {
  return {
    sessionId: 'reflection-session',
    rootSessionId: 'reflection-root-session',
    currentLevelIndex: 0,
    levelStates: new Map([['deliberation', {
      engineState: {
        type: STAGE_TYPE.DISCUSSION,
        round: 1,
        approvedRoster: ['analyst'],
        messages: [{
          from: 'analyst',
          to: 'lead',
          round: 1,
          timestamp: '2026-09-09T10:00:00.000Z',
          type: 'position',
          message: 'A phased rollout is cheaper to reverse.',
        }],
      },
    } as unknown as never]]),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

function runtimeContext(
  agents: Map<string, LoadedAgent>,
  state: RuntimeState,
  workspacePath: string,
  controller: AbortController,
): RuntimeContext {
  return {
    agents,
    state,
    teamConfig: {
      team: { name: 'warehouse-board', description: 'test', version: '0.1.0' },
      workspace: { path: workspacePath, watch: false },
      agents: [],
      levels: [LEVEL],
      gates: [],
    },
    shutdownController: controller,
  } as unknown as RuntimeContext
}

/** Every agent-run record this assignment holds. */
function recordedAgentRuns(assignmentPath: string): Record<string, unknown>[] {
  const journal = getAssignmentLogPath(assignmentPath, 'agent-runs.jsonl')
  if (!fs.existsSync(journal)) return []
  return fs
    .readFileSync(journal, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
}

async function withOwnedProvider<T>(
  provider: RecordingProvider,
  run: (owned: {
    providerName: string
    deny: { attempted: string[]; restore(): void }
  }) => Promise<T>,
): Promise<T> {
  const connectionId = randomUUID()
  const providerName = `connection:${connectionId}`
  const previousDefault = getRuntimeDefaultModelState()
  const deny = denyNonLoopback()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Reflection provider',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'reflection-key',
    },
  ])
  setRuntimeDefaultModelState({
    status: 'available',
    provider: providerName,
    model: APP_DEFAULT_MODEL,
  })
  try {
    return await run({ providerName, deny })
  } finally {
    deny.restore()
    setRuntimeDefaultModelState(previousDefault)
    setConfiguredProviderConnections([])
  }
}

test('a reflection records the model that wrote it, before asking', async (t) => {
  const assignment = ownedAssignment(t)
  let recordedAtSend: Record<string, unknown>[] = []
  const provider = await startProvider(REFLECTION_ANSWER, () => {
    recordedAtSend = recordedAgentRuns(assignment)
  })
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const state = runtimeState()
      const agents = new Map([
        ['analyst', reflectingAgent('analyst', providerName, 'own')],
      ])
      await runExperienceReflections(
        LEVEL,
        runtimeContext(agents, state, assignment, new AbortController()),
        assignment,
      )

      // The Agent's own pair, which this dispatch already used correctly.
      assert.deepEqual(provider.models(), [CHOSEN_MODEL])
      assert.deepEqual(deny.attempted, [])
      // And the account existed when the request went out.
      const start = recordedAtSend.find((entry) => entry.event === 'start')
      assert.ok(start, JSON.stringify(recordedAtSend))
      assert.equal(start.agent_name, 'analyst')
      assert.equal(start.session_id, 'reflection-session')
      assert.equal(start.assignment_path, assignment)
      assert.deepEqual(start.model_selection, {
        provider: providerName,
        model: CHOSEN_MODEL,
        source: 'agent',
        reason: 'explicit-agent-choice',
        caller: 'agent',
      })
    })
  } finally {
    await provider.close()
  }
})

test('a reflection on an inherited pair is recorded as inherited', async (t) => {
  // The other half of the provenance rule. An Agent that named no pair of its
  // own runs on the application default, and the record has to say that rather
  // than crediting it with a choice it never made.
  const assignment = ownedAssignment(t)
  const provider = await startProvider(REFLECTION_ANSWER)
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const agents = new Map([
        ['analyst', reflectingAgent('analyst', providerName, 'inherited')],
      ])
      await runExperienceReflections(
        LEVEL,
        runtimeContext(agents, runtimeState(), assignment, new AbortController()),
        assignment,
      )

      assert.deepEqual(provider.models(), [APP_DEFAULT_MODEL])
      assert.deepEqual(deny.attempted, [])
      const start = recordedAgentRuns(assignment).find(
        (entry) => entry.event === 'start',
      )
      assert.ok(start, 'the reflection recorded no dispatch')
      assert.deepEqual(start.model_selection, {
        provider: providerName,
        model: APP_DEFAULT_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      })
    })
  } finally {
    await provider.close()
  }
})

test('a cancelled reflection records nothing, asks nothing, and still propagates', async (t) => {
  // Nothing is recorded for a call that will not be made — and the caller's
  // contract is unchanged. A cancelled phase rejected before this capability
  // existed, because the dispatch threw on the aborted signal and the handler
  // rethrew it; swallowing that would turn an interrupted shutdown into a
  // silent success at `level-lifecycle.ts`.
  const assignment = ownedAssignment(t)
  const provider = await startProvider(REFLECTION_ANSWER)
  const controller = new AbortController()
  controller.abort()
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const agents = new Map([
        ['analyst', reflectingAgent('analyst', providerName, 'own')],
      ])
      await assert.rejects(() => runExperienceReflections(
        LEVEL,
        runtimeContext(agents, runtimeState(), assignment, controller),
        assignment,
      ))

      assert.deepEqual(provider.models(), [])
      assert.deepEqual(deny.attempted, [])
      assert.deepEqual(recordedAgentRuns(assignment), [])
    })
  } finally {
    await provider.close()
  }
})

test('a journal that fails after the send does not fail the reflection phase', async (t) => {
  // The account is written before the send, and that is where refusing to
  // dispatch belongs. Afterwards the model has already run and the Agent has
  // already written its entry — so a journal that breaks between those two
  // moments must not reject a best-effort phase and block level completion.
  //
  // The fault is introduced by the provider itself, mid-call: the journal is
  // moved aside and a directory put in its place while the request is in
  // flight, so the terminal write fails the way a disk problem would.
  const assignment = ownedAssignment(t)
  const journal = getAssignmentLogPath(assignment, 'agent-runs.jsonl')
  let breakJournal = true
  const provider = await startProvider(REFLECTION_ANSWER, () => {
    if (!breakJournal) return
    breakJournal = false
    fs.renameSync(journal, `${journal}.moved`)
    fs.mkdirSync(journal, { recursive: true })
  })
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const agents = new Map([
        ['analyst', reflectingAgent('analyst', providerName, 'own')],
      ])
      // Resolves. The reflection is optional work whose result is already
      // written; the phase reporting failure here would stop the level.
      await runExperienceReflections(
        LEVEL,
        runtimeContext(agents, runtimeState(), assignment, new AbortController()),
        assignment,
      )

      // The model really was asked, and the account written before it was.
      assert.deepEqual(provider.models(), [CHOSEN_MODEL])
      assert.deepEqual(deny.attempted, [])
      const before = fs
        .readFileSync(`${journal}.moved`, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => (JSON.parse(line) as { event?: unknown }).event)
      assert.deepEqual(before, ['start'])
    })
  } finally {
    await provider.close()
  }
})

test('a reflection keeps its own provider route when a worker endpoint is injected', async (t) => {
  // The trap the gate capability fell into, closed here before it can happen.
  // A dispatch carrying an agent identity is routed through the parent's
  // worker/tool loop whenever one is injected, and internal runtime calls
  // deliberately have none. The name belongs on the record, not the dispatch.
  const assignment = ownedAssignment(t)
  const workerRequests: string[] = []
  const worker = await startWorkerEndpoint(() => workerRequests.push('worker'))
  const provider = await startProvider(REFLECTION_ANSWER)
  // The *whole* environment a worker turn needs, not just the endpoint. The
  // request is built and validated before it is sent, so with only a URL the
  // contract build fails and nothing is requested — which would leave this
  // passing against the very implementation it exists to catch.
  const workerEnvironment: Record<string, string> = {
    [MCP_WORKER_TURN_URL_ENV]: `${worker.url}/worker-turn`,
    [MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]: 'reflection-lane',
    [MCP_WORKER_AGENT_DISPLAY_NAME_ENV]: 'Analyst',
    [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'reflection-step',
    [RUNTIME_SESSION_ID_ENV]: '22222222-2222-4222-8222-222222222222',
    [RUNTIME_RUN_ID_ENV]: 'run-reflection',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-reflection',
    TEAM_RUNTIME_TASK_ID: 'task-reflection',
    TEAM_RUNTIME_PROCESS_IDENTITY: 'process-reflection',
    TEAM_RUNTIME_WORKFLOW_ID: 'reflection-workflow',
  }
  const previousEnvironment = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(workerEnvironment)) {
    previousEnvironment.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const agents = new Map([
        ['analyst', reflectingAgent('analyst', providerName, 'own')],
      ])
      await runExperienceReflections(
        LEVEL,
        runtimeContext(agents, runtimeState(), assignment, new AbortController()),
        assignment,
      )

      // The Agent's own provider answered, and the worker was never asked.
      assert.deepEqual(provider.models(), [CHOSEN_MODEL])
      assert.deepEqual(workerRequests, [])
      assert.deepEqual(deny.attempted, [])
    })
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await worker.close()
    await provider.close()
  }
})

test('a reflection whose record cannot be written asks nothing', async (t) => {
  // Fail closed before the send. One Agent here, and the name says so: an
  // earlier title claimed this also showed the other participants still
  // running, which it never did — that is the case below.
  //
  // The fault is real and narrow: the journal's own path is a directory, so
  // appending to it fails the way a full disk would.
  const assignment = ownedAssignment(t)
  fs.mkdirSync(getAssignmentLogPath(assignment, 'agent-runs.jsonl'), {
    recursive: true,
  })
  const provider = await startProvider(REFLECTION_ANSWER)
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const agents = new Map([
        ['analyst', reflectingAgent('analyst', providerName, 'own')],
      ])
      await runExperienceReflections(
        LEVEL,
        runtimeContext(agents, runtimeState(), assignment, new AbortController()),
        assignment,
      )

      assert.deepEqual(provider.models(), [])
      assert.deepEqual(deny.attempted, [])
    })
  } finally {
    await provider.close()
  }
})

test('one failing reflection does not suppress the others', async (t) => {
  // Existing behaviour, stated so it cannot be lost. Each reflection swallows
  // its own error, so a participant whose provider refuses must not take the
  // rest of the phase down with it — and every one of them still leaves a
  // record of the model it was about to use.
  const assignment = ownedAssignment(t)
  const provider = await startFailingForAgent('lead', REFLECTION_ANSWER)
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const agents = new Map([
        ['lead', reflectingAgent('lead', providerName, 'own')],
        ['analyst', reflectingAgent('analyst', providerName, 'inherited')],
      ])
      await runExperienceReflections(
        LEVEL,
        runtimeContext(agents, runtimeState(), assignment, new AbortController()),
        assignment,
      )

      assert.deepEqual(deny.attempted, [])
      const runs = recordedAgentRuns(assignment)
      // Both were accounted for before either was asked.
      assert.deepEqual(
        runs.filter((entry) => entry.event === 'start').map((entry) => entry.agent_name).sort(),
        ['analyst', 'lead'],
      )
      // The one that worked finished; the one that was refused is recorded as
      // failed rather than left open.
      assert.deepEqual(
        runs.filter((entry) => entry.event === 'end').map((entry) => entry.agent_name),
        ['analyst'],
      )
      assert.deepEqual(
        runs.filter((entry) => entry.event === 'fail').map((entry) => entry.agent_name),
        ['lead'],
      )
    })
  } finally {
    await provider.close()
  }
})

test('a reflection cancelled mid-flight closes its record and still propagates', async (t) => {
  // Every start needs a terminal record, and a shutdown that interrupts a
  // reflection still has to reach the caller. Cancelled once the request has
  // reached the provider, so this is an interruption of a dispatch rather than
  // a refusal to start one.
  const assignment = ownedAssignment(t)
  const controller = new AbortController()
  const provider = await startProvider(REFLECTION_ANSWER, () => {
    controller.abort()
  })
  try {
    await withOwnedProvider(provider, async ({ providerName }) => {
      const agents = new Map([
        ['analyst', reflectingAgent('analyst', providerName, 'own')],
      ])
      const error = await runExperienceReflections(
        LEVEL,
        runtimeContext(agents, runtimeState(), assignment, controller),
        assignment,
      ).then(() => null, (thrown: unknown) => thrown)

      assert.ok(error, 'an interrupted phase has to reach its caller')
      assert.equal(parseProviderError(error).kind, 'cancelled', String(error))
      // The model was asked, so this interrupted a dispatch rather than
      // refusing to start one.
      assert.deepEqual(provider.models(), [CHOSEN_MODEL])
      const events = recordedAgentRuns(assignment).map((entry) => entry.event)
      assert.deepEqual(events, ['start', 'fail'], JSON.stringify(events))
    })
  } finally {
    await provider.close()
  }
})

test('a cancellation survives a journal that fails at the same moment', async (t) => {
  // Two faults at once. The record cannot be closed *and* the run is being
  // interrupted — and the caller must still hear the cancellation rather than a
  // logging error standing in for it.
  const assignment = ownedAssignment(t)
  const journal = getAssignmentLogPath(assignment, 'agent-runs.jsonl')
  const controller = new AbortController()
  const provider = await startProvider(REFLECTION_ANSWER, () => {
    fs.renameSync(journal, `${journal}.moved`)
    fs.mkdirSync(journal, { recursive: true })
    controller.abort()
  })
  try {
    await withOwnedProvider(provider, async ({ providerName }) => {
      const agents = new Map([
        ['analyst', reflectingAgent('analyst', providerName, 'own')],
      ])
      const error = await runExperienceReflections(
        LEVEL,
        runtimeContext(agents, runtimeState(), assignment, controller),
        assignment,
      ).then(() => null, (thrown: unknown) => thrown)

      assert.ok(error, 'a cancelled phase has to reach its caller')
      // Classified as a cancellation by the product's own reader, not merely
      // "some error that is not EISDIR" — an unrelated transport fault would
      // satisfy that and prove nothing about the cancellation surviving.
      assert.equal(parseProviderError(error).kind, 'cancelled', String(error))
      // And the model really was asked, so this is an interrupted dispatch
      // rather than one that never started.
      assert.deepEqual(provider.models(), [CHOSEN_MODEL])
    })
  } finally {
    await provider.close()
  }
})

test('a priced reflection adds its exact cost to the run', async (t) => {
  // The cost control on a route that actually produces one. A configured
  // connection reports no cost of its own, so proving accumulation there would
  // assert `0 === 0`. This runs the real Anthropic adapter — intercepted at the
  // HTTP boundary against an owned server, with pricing supplied through the
  // supported `TEAM_PROVIDER_PRICING_JSON` hook.
  const assignment = ownedAssignment(t)
  const attempted: string[] = []
  const realFetch = globalThis.fetch
  const previousKey = process.env.ANTHROPIC_API_KEY
  const previousPricing = process.env.TEAM_PROVIDER_PRICING_JSON
  const provider = await startAnthropicProvider(REFLECTION_ANSWER)
  process.env.ANTHROPIC_API_KEY = 'reflection-fixture-key-not-real'
  process.env.TEAM_PROVIDER_PRICING_JSON = JSON.stringify({
    [`anthropic:${PAID_MODEL}`]: { inputPerMillion: 1, outputPerMillion: 1 },
  })
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    const parsed = new URL(url)
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return realFetch(input, init)
    }
    attempted.push(parsed.hostname)
    return realFetch(`${provider.url}${parsed.pathname}`, init)
  }
  try {
    const state = runtimeState()
    state.totalCost = INITIAL_COST
    const analyst = reflectingAgent('analyst', 'anthropic', 'own')
    const agents = new Map([['analyst', {
      ...analyst,
      model: PAID_MODEL,
      selection: {
        provider: 'anthropic',
        model: PAID_MODEL,
        source: 'agent',
        reason: 'explicit-agent-choice',
      },
    } as LoadedAgent]])
    await runExperienceReflections(
      LEVEL,
      runtimeContext(agents, state, assignment, new AbortController()),
      assignment,
    )

    assert.deepEqual(provider.models(), [PAID_MODEL])
    // Named but never actually contacted: the rewrite sent it to the owned
    // server instead.
    assert.deepEqual(attempted, ['api.anthropic.com'])
    // One million input and one million output tokens at $1 each, on top of
    // what the run already carried.
    assert.equal(state.totalCost, INITIAL_COST + EXPECTED_CALL_COST)
  } finally {
    globalThis.fetch = realFetch
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    if (previousPricing === undefined) delete process.env.TEAM_PROVIDER_PRICING_JSON
    else process.env.TEAM_PROVIDER_PRICING_JSON = previousPricing
    await provider.close()
  }
})
