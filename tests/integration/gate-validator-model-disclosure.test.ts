/**
 * Which model decided a gate, and whether the run says so.
 *
 * Two gate conditions dispatch a named Agent to judge the work: `agent_verdict`
 * asks for a token, and `validation` asks for PASS or FAIL. Both already run
 * that Agent on the pair it resolved for itself — which is right and stays —
 * but neither passes the assignment it belongs to, so the run records no
 * telemetry for the call and no account of which model made the decision. A
 * gate is one of the more consequential things a model does in a run, and it
 * was the least visible.
 *
 * These are Agents, not the application's own background work. Their record is
 * the Agent's own selection: `agent` when it chose, `app-default` when it
 * inherited. Resolving them as helpers would force the application default and
 * report a model the Agent never ran on.
 *
 * Driven against the real `checkGate`, the real provider adapter and a real
 * assignment directory, with only the HTTP boundary owned.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { checkGate } from '../../engines/gate-checker.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
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
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import type { GateConfig, LoadedAgent, RuntimeState } from '../../core/types.js'

initProviders()

const APP_DEFAULT_MODEL = 'app-default-gate-model'
const CHOSEN_MODEL = 'validator-own-model'
const VERDICT = 'APPROVED'
/** A real Anthropic model id, so the priced control below is not a fiction. */
const PAID_MODEL = 'claude-haiku-4-5-20251001'
/** A balance the run already carried, so an overwrite is visible as one. */
const INITIAL_COST = 0.5
/** One million input and one million output tokens at $1 each. */
const EXPECTED_CALL_COST = 2

interface RecordingProvider {
  readonly url: string
  /** The model each received request named, in arrival order. */
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
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
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
 * Owned and benign: it exists to be *not* called. A gate reaching it at all is
 * the defect, so what it returns only has to be a valid completed turn.
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
        text: VERDICT,
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
        id: 'msg_gate',
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
 * Refuses every request that is not to the loopback, and records it.
 *
 * At the HTTP boundary rather than at any module. A gate that dispatched
 * somewhere nobody selected would otherwise leave the loopback empty and look
 * like a gate that asked nothing at all.
 */
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

/** An assignment of this test's own, removed when it ends. */
function ownedAssignment(t: TestContext): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gate-disclosure-')),
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function runtimeState(): RuntimeState {
  return {
    sessionId: 'gate-session',
    rootSessionId: 'gate-root-session',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: INITIAL_COST,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

/**
 * A validator Agent, as the loader would have produced it.
 *
 * `selection` is the whole point: it is how the run knows whether this pair was
 * the Agent's own decision or the one it inherited, and a record built from
 * `provider`/`model` alone could not tell those apart.
 */
function validatorAgent(
  providerName: string,
  choice: 'own' | 'inherited' | 'none',
): LoadedAgent {
  const model = choice === 'own' ? CHOSEN_MODEL : APP_DEFAULT_MODEL
  return {
    name: 'gate-validator',
    model: choice === 'none' ? '' : model,
    thinking: 'low',
    systemPrompt: 'You are the gate validator.',
    experienceContent: '',
    experienceEnabled: false,
    skillsContent: '',
    knowledgeContent: '',
    agentDir: '/unused',
    color: 33,
    provider: choice === 'none' ? '' : providerName,
    selection: choice === 'none'
      ? null
      : {
          provider: providerName,
          model,
          source: choice === 'own' ? 'agent' : 'app-default',
          reason: choice === 'own' ? 'explicit-agent-choice' : 'agent-default',
        },
  } as LoadedAgent
}

interface Owned {
  readonly providerName: string
  readonly deny: { attempted: string[]; restore(): void }
}

async function withOwnedProvider<T>(
  provider: RecordingProvider,
  run: (owned: Owned) => Promise<T>,
): Promise<T> {
  const connectionId = randomUUID()
  const providerName = `connection:${connectionId}`
  const previousDefault = getRuntimeDefaultModelState()
  const deny = denyNonLoopback()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Gate provider',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'gate-key',
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

/** Every agent-run record this assignment holds, in order. */
function recordedAgentRuns(assignmentPath: string): Record<string, unknown>[] {
  const journal = getAssignmentLogPath(assignmentPath, 'agent-runs.jsonl')
  if (!fs.existsSync(journal)) return []
  return fs
    .readFileSync(journal, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
}

const VERDICT_GATE: GateConfig = {
  from: 'review',
  to: 'done',
  condition: { type: 'agent_verdict', validator: 'gate-validator', verdict: VERDICT },
}

const VALIDATION_GATE: GateConfig = {
  from: 'review',
  to: 'done',
  condition: {
    type: 'validation',
    validator: 'gate-validator',
    strictness: 'hard',
  },
}

test('an agent-verdict gate records the model that decided it, before asking', async (t) => {
  const assignment = ownedAssignment(t)
  let recordedAtSend: Record<string, unknown>[] = []
  const provider = await startProvider(VERDICT, () => {
    recordedAtSend = recordedAgentRuns(assignment)
  })
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const state = runtimeState()
      const result = await checkGate(
        VERDICT_GATE,
        assignment,
        state,
        new Map([['gate-validator', validatorAgent(providerName, 'own')]]),
      )

      assert.equal(result.passed, true, result.reason)
      // The Agent's own pair, which this dispatch already used correctly.
      assert.deepEqual(provider.models(), [CHOSEN_MODEL])
      assert.deepEqual(deny.attempted, [])
      // And the account of it existed when the request went out.
      const start = recordedAtSend.find((entry) => entry.event === 'start')
      assert.ok(start, JSON.stringify(recordedAtSend))
      assert.equal(start.agent_name, 'gate-validator')
      assert.equal(start.session_id, 'gate-session')
      assert.equal(start.assignment_path, assignment)
      assert.deepEqual(start.model_selection, {
        provider: providerName,
        model: CHOSEN_MODEL,
        // Its own decision, recorded as its own. Resolving this as a background
        // helper would have reported the application default instead.
        source: 'agent',
        reason: 'explicit-agent-choice',
        caller: 'agent',
      })
      // Stated exactly rather than as `>= 0`, which could not tell charging
      // that works from charging that was dropped. A configured connection
      // reports no cost of its own (`providers/configured-provider.ts:226`), so
      // what this pins is that the run's existing balance survives the gate
      // untouched. The priced case below covers a call that does cost money.
      assert.equal(state.totalCost, INITIAL_COST)
    })
  } finally {
    await provider.close()
  }
})

test('a validation gate records an inherited pair as inherited', async (t) => {
  // The other half of the provenance rule, at the other gate. A validator that
  // named no pair of its own runs on the application default, and the record
  // has to say that rather than crediting the Agent with a choice it never
  // made — or crediting the default to an Agent that did choose.
  const assignment = ownedAssignment(t)
  const provider = await startProvider('PASS')
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const result = await checkGate(
        VALIDATION_GATE,
        assignment,
        runtimeState(),
        new Map([['gate-validator', validatorAgent(providerName, 'inherited')]]),
      )

      assert.equal(result.passed, true, result.reason)
      assert.deepEqual(provider.models(), [APP_DEFAULT_MODEL])
      assert.deepEqual(deny.attempted, [])
      const start = recordedAgentRuns(assignment).find(
        (entry) => entry.event === 'start',
      )
      assert.ok(start, 'the validation gate recorded no dispatch')
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

test('a gate keeps its own provider route when a worker endpoint is injected', async (t) => {
  // Disclosure must not move the dispatch. A call that carries an agent
  // identity is routed through the parent's worker/tool loop whenever one is
  // injected (`mcp-worker-turn-client.ts:146`), and its own comment says
  // internal runtime calls deliberately have none. Naming the validator on the
  // record is right; naming it on the dispatch silently opted every gate in a
  // worker-enabled run onto another route, where it failed outright.
  //
  // The worker endpoint here is real and owned, and it counts what it receives:
  // zero is the assertion.
  const assignment = ownedAssignment(t)
  const workerRequests: string[] = []
  const worker = await startWorkerEndpoint(() => workerRequests.push('worker'))
  const provider = await startProvider(VERDICT)
  // The *whole* environment a worker turn needs, not just the endpoint. The
  // request is built and validated before it is sent, so with only the URL set
  // the contract build fails and no request is made — which would leave this
  // test passing against the broken implementation it exists to catch.
  const workerEnvironment: Record<string, string> = {
    [MCP_WORKER_TURN_URL_ENV]: `${worker.url}/worker-turn`,
    [MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]: 'gate-lane',
    [MCP_WORKER_AGENT_DISPLAY_NAME_ENV]: 'Gate Validator',
    [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'gate-step',
    [RUNTIME_SESSION_ID_ENV]: '11111111-1111-4111-8111-111111111111',
    [RUNTIME_RUN_ID_ENV]: 'run-gate',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-gate',
    TEAM_RUNTIME_TASK_ID: 'task-gate',
    TEAM_RUNTIME_PROCESS_IDENTITY: 'process-gate',
    TEAM_RUNTIME_WORKFLOW_ID: 'gate-workflow',
  }
  const previousEnvironment = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(workerEnvironment)) {
    previousEnvironment.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const result = await checkGate(
        VERDICT_GATE,
        assignment,
        runtimeState(),
        new Map([['gate-validator', validatorAgent(providerName, 'own')]]),
      )

      assert.equal(result.passed, true, result.reason)
      // The gate's own provider answered, and the worker was never asked.
      assert.deepEqual(provider.models(), [CHOSEN_MODEL])
      assert.deepEqual(workerRequests, [])
      assert.deepEqual(deny.attempted, [])
      // The record still names the validator, which is where the name belongs.
      const start = recordedAgentRuns(assignment).find(
        (entry) => entry.event === 'start',
      )
      assert.equal(start?.agent_name, 'gate-validator')
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

/**
 * What the process said while a test ran.
 *
 * A terminal record that could not be written is reported on the process
 * boundary, because the journal that would normally hold it is the thing that
 * just failed. So this is the only place the report can be asserted.
 */
function captureProcessWarnings(t: TestContext): string[] {
  const lines: string[] = []
  const real = console.error
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(' '))
  }
  t.after(() => {
    console.error = real
  })
  return lines
}

test('a journal that fails after the send still returns a gate verdict', async (t) => {
  // Refusing to dispatch belongs *before* the send, where the account is
  // written. Afterwards the validator has already answered, and a journal that
  // breaks in between must not turn a gate into a thrown error: `checkGate`
  // returns verdicts, and a caller that gets an exception instead has no gate
  // result at all.
  //
  // The fault is introduced by the provider itself, mid-call: the journal is
  // moved aside and a directory put in its place while the request is in
  // flight, so the terminal write fails the way a disk problem would.
  const assignment = ownedAssignment(t)
  const journal = getAssignmentLogPath(assignment, 'agent-runs.jsonl')
  const warnings = captureProcessWarnings(t)
  let breakJournal = true
  const provider = await startProvider(VERDICT, () => {
    if (!breakJournal) return
    breakJournal = false
    fs.renameSync(journal, `${journal}.moved`)
    fs.mkdirSync(journal, { recursive: true })
  })
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const result = await checkGate(
        VERDICT_GATE,
        assignment,
        runtimeState(),
        new Map([['gate-validator', validatorAgent(providerName, 'own')]]),
      )

      // The validator answered, so the gate reports what it decided.
      assert.equal(result.passed, true, result.reason)
      assert.deepEqual(provider.models(), [CHOSEN_MODEL])
      assert.deepEqual(deny.attempted, [])
      // And the account written before the send survives.
      const before = fs
        .readFileSync(`${journal}.moved`, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => (JSON.parse(line) as { event?: unknown }).event)
      assert.deepEqual(before, ['start'])

      // The write that failed is reported rather than swallowed — and reported
      // as a category with identity, never with the underlying error, whose
      // message carries filesystem paths.
      const reported = warnings
        .map((line): Record<string, unknown> | null => {
          try {
            const parsed: unknown = JSON.parse(line)
            return typeof parsed === 'object' && parsed !== null
              ? (parsed as Record<string, unknown>)
              : null
          } catch {
            return null
          }
        })
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .filter((entry) => entry.event === 'runtime.agent_run_record_write_failed')
      assert.equal(
        reported.length,
        1,
        `the failed terminal write must report itself once; saw ${JSON.stringify(warnings)}`,
      )
      const [only] = reported
      assert.equal(only?.error, 'record_write_failed')
      assert.equal(only?.lifecycle, 'end')
      assert.equal(only?.agent_name, 'gate-validator')
      assert.ok(
        !JSON.stringify(only).includes(assignment),
        'the reported warning must not carry a filesystem path',
      )
    })
  } finally {
    await provider.close()
  }
})

test('a priced gate dispatch still charges the run', async (t) => {
  // The cost control on a route that actually produces one. The real Anthropic
  // adapter, intercepted at the HTTP boundary against an owned server, with
  // pricing supplied through the supported `TEAM_PROVIDER_PRICING_JSON` hook
  // rather than by changing what the product charges for anything.
  const assignment = ownedAssignment(t)
  const attempted: string[] = []
  const realFetch = globalThis.fetch
  const previousKey = process.env.ANTHROPIC_API_KEY
  const previousPricing = process.env.TEAM_PROVIDER_PRICING_JSON
  const provider = await startAnthropicProvider(VERDICT)
  process.env.ANTHROPIC_API_KEY = 'gate-fixture-key-not-real'
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
    const validator = validatorAgent('anthropic', 'own')
    const result = await checkGate(
      VERDICT_GATE,
      assignment,
      state,
      new Map([['gate-validator', { ...validator, model: PAID_MODEL, selection: {
        provider: 'anthropic',
        model: PAID_MODEL,
        source: 'agent',
        reason: 'explicit-agent-choice',
      } } as LoadedAgent]]),
    )

    assert.equal(result.passed, true, result.reason)
    assert.deepEqual(provider.models(), [PAID_MODEL])
    // Reached the owned server through the rewrite, so the paid host was named
    // but never actually contacted.
    assert.deepEqual(attempted, ['api.anthropic.com'])
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

test('a gate whose record cannot be written asks nothing', async (t) => {
  // Fail closed. A gate decides whether a run advances, so deciding it on a
  // model nothing recorded is the account this capability exists to prevent.
  // A real filesystem fault, narrow enough to break only the journal: its own
  // path is a directory, so appending to it fails the way a full disk would.
  const assignment = ownedAssignment(t)
  fs.mkdirSync(path.dirname(getAssignmentLogPath(assignment, 'agent-runs.jsonl')), {
    recursive: true,
  })
  fs.mkdirSync(getAssignmentLogPath(assignment, 'agent-runs.jsonl'), {
    recursive: true,
  })
  const provider = await startProvider(VERDICT)
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      // The outcome is captured rather than awaited directly, so the assertion
      // that matters here — that no model was asked anything — is reached even
      // if the gate throws. Without that, an implementation that dispatched and
      // then failed on a later write would fail this test for the wrong reason
      // and hide whether the dispatch happened.
      const outcome = await checkGate(
        VERDICT_GATE,
        assignment,
        runtimeState(),
        new Map([['gate-validator', validatorAgent(providerName, 'own')]]),
      ).then(
        (passedResult) => ({ threw: false as const, passedResult }),
        (error: unknown) => ({ threw: true as const, error }),
      )

      assert.deepEqual(provider.models(), [])
      assert.deepEqual(deny.attempted, [])
      assert.equal(outcome.threw, false, String(
        outcome.threw ? outcome.error : '',
      ))
      assert.equal(outcome.passedResult?.passed, false)
      assert.match(String(outcome.passedResult?.reason), /could not be recorded/i)
    })
  } finally {
    await provider.close()
  }
})

test('a gate cancelled mid-flight still closes the record it opened', async (t) => {
  // Every start needs a terminal record. A run interrupted while a validator
  // was thinking would otherwise leave a dispatch that began and never ended,
  // which reads as one still in flight.
  const assignment = ownedAssignment(t)
  const cancelled = new AbortController()
  const provider = await startProvider(VERDICT, () => {
    // Cancelled once the request has actually reached the provider, so this is
    // an interruption of a dispatch rather than a refusal to start one.
    cancelled.abort()
  })
  try {
    await withOwnedProvider(provider, async ({ providerName }) => {
      await assert.rejects(() => checkGate(
        VERDICT_GATE,
        assignment,
        runtimeState(),
        new Map([['gate-validator', validatorAgent(providerName, 'own')]]),
        undefined,
        cancelled.signal,
      ))

      const events = recordedAgentRuns(assignment).map((entry) => entry.event)
      assert.deepEqual(events, ['start', 'fail'], JSON.stringify(events))
    })
  } finally {
    await provider.close()
  }
})

test('a soft validation gate still proceeds when its validator cannot run', async (t) => {
  // Existing behaviour, stated so it cannot be changed by accident. A soft gate
  // converts every dispatch failure into "proceed" — including an unresolvable
  // pair. That is deliberately not a hard refusal, and this capability does not
  // alter it; what it adds is that nothing is dispatched or recorded first.
  const assignment = ownedAssignment(t)
  const provider = await startProvider('PASS')
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const result = await checkGate(
        {
          ...VALIDATION_GATE,
          condition: {
            type: 'validation',
            validator: 'gate-validator',
            strictness: 'soft',
          },
        },
        assignment,
        runtimeState(),
        new Map([['gate-validator', validatorAgent(providerName, 'none')]]),
      )

      assert.equal(result.passed, true, result.reason)
      assert.match(String(result.reason), /soft gate/i)
      assert.deepEqual(provider.models(), [])
      assert.deepEqual(deny.attempted, [])
      assert.deepEqual(recordedAgentRuns(assignment), [])
    })
  } finally {
    await provider.close()
  }
})

test('a gate whose validator has no usable pair asks nothing and does not pass', async (t) => {
  // Fail closed, in the safe direction. There is nothing truthful to record and
  // nothing anybody chose to run on, so the gate does not quietly dispatch on
  // an empty pair — and it refuses rather than approving work it never checked.
  const assignment = ownedAssignment(t)
  const provider = await startProvider(VERDICT)
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      const result = await checkGate(
        VERDICT_GATE,
        assignment,
        runtimeState(),
        new Map([['gate-validator', validatorAgent(providerName, 'none')]]),
      )

      assert.equal(result.passed, false)
      assert.deepEqual(provider.models(), [])
      assert.deepEqual(deny.attempted, [])
      assert.deepEqual(recordedAgentRuns(assignment), [])
    })
  } finally {
    await provider.close()
  }
})

test('a cancelled gate records nothing and asks nothing', async (t) => {
  // Nothing is recorded for a call that will not be made. A durable record
  // naming a model that was asked for nothing is the same false account as an
  // unrecorded call, told the other way round.
  //
  // The cancellation still propagates rather than becoming a failed gate —
  // `gate-checker.ts` rethrows on an aborted signal deliberately, and that is
  // preserved. What changes is that nothing is dispatched or recorded on the
  // way to it.
  const assignment = ownedAssignment(t)
  const provider = await startProvider(VERDICT)
  const cancelled = new AbortController()
  cancelled.abort()
  try {
    await withOwnedProvider(provider, async ({ providerName, deny }) => {
      await assert.rejects(() => checkGate(
        VERDICT_GATE,
        assignment,
        runtimeState(),
        new Map([['gate-validator', validatorAgent(providerName, 'own')]]),
        undefined,
        cancelled.signal,
      ))

      assert.deepEqual(provider.models(), [])
      assert.deepEqual(deny.attempted, [])
      assert.deepEqual(recordedAgentRuns(assignment), [])
    })
  } finally {
    await provider.close()
  }
})
