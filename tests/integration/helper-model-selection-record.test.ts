/**
 * Which model the two internal helpers run on.
 *
 * Compressing a long discussion and writing a run's minutes are the
 * application's own work. Neither owns an Agent, so by the one rule this phase
 * exists for, each runs on the one application default — and each says so.
 *
 * Neither did. Both called `runAgent` with `model: MINUTES_MODEL`, the literal
 * string `"default"`, and no provider at all, and `runAgent` substitutes
 * `anthropic` when none is given. So whatever a person had chosen in Settings,
 * these two went somewhere else entirely, named a model id that is not a model,
 * and disclosed nothing.
 *
 * Driven through the real helpers, the real `runAgent` and the real provider
 * adapters, with only the HTTP boundary owned. The existing unit tests for both
 * files mock `runAgent` itself, which is exactly why they could not see this:
 * the dispatch choice is the thing under test here.
 *
 * The paid boundary is closed deliberately rather than incidentally. A fake
 * `ANTHROPIC_API_KEY` is present throughout, so the substituted provider gets
 * as far as building a request and the deny below *observes* it — without the
 * key that adapter refuses first, and "nothing was attempted" would be true for
 * the wrong reason. Every non-loopback request is refused before it is made and
 * recorded per test, so each case states where the run actually went.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { compressConversation } from '../../domains/agent-execution/context-compressor.js'
import { generateMinutes } from '../../domains/agent-execution/minutes.js'
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import { RateLimiter } from '../../core/rate-limiter.js'
import type { ConversationMessage } from '../../core/types.js'
import type { RuntimeState, TeamConfig } from '../../core/types.js'

initProviders()
requireMinutesTemplate()

const DEFAULT_MODEL = 'app-default-helper-model'
/** A real Anthropic model id, so the priced control below is not a fiction. */
const PAID_MODEL = 'claude-haiku-4-5-20251001'
const COMPRESSION_ANSWER = 'Rounds one and two agreed on a phased rollout.'
const MINUTES_ANSWER = '## Decisions\n\n- Phased rollout agreed.'

interface RecordingProvider {
  readonly url: string
  /** The model each received request named, in arrival order. */
  models(): string[]
  close(): Promise<void>
}

/**
 * An OpenAI-compatible endpoint, which is what a configured connection speaks.
 */
async function startRecordingProvider(answer: string): Promise<RecordingProvider> {
  return startProvider((model) => JSON.stringify({
    model,
    choices: [{ message: { role: 'assistant', content: answer } }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  }))
}

/** The Anthropic Messages shape, for the one case that runs that adapter. */
async function startAnthropicProvider(answer: string): Promise<RecordingProvider> {
  return startProvider((model) => JSON.stringify({
    id: 'msg_helper',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: answer }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  }))
}

/**
 * An endpoint that receives the request and refuses it.
 *
 * A real dispatch that fails, rather than a dispatch that never happened —
 * which is the only way to tell "the helper asked and was refused" from "the
 * helper asked nothing".
 */
async function startFailingProvider(
  attempted: string[],
): Promise<RecordingProvider> {
  const provider = await startProvider((model) => {
    attempted.push(model)
    return JSON.stringify({ error: { message: 'the provider refused' } })
  }, 502)
  return provider
}

async function startProvider(
  body: (model: string) => string,
  status = 200,
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
      const payload = body(model)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(payload)
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

interface NetworkDeny {
  /** Hosts this test attempted to reach that are not the loopback. */
  readonly attempted: string[]
  restore(): void
}

/**
 * Refuses every request that is not to the loopback, and records it.
 *
 * At the HTTP boundary rather than at any module: nothing inside `runAgent`,
 * the provider registry or an adapter is replaced, so what these tests observe
 * is where the real dispatch decided to go. An optional rewrite lets one case
 * run a real paid adapter end to end against an owned server instead.
 */
function denyNonLoopback(options: { rewriteTo?: string } = {}): NetworkDeny {
  const attempted: string[] = []
  const realFetch = globalThis.fetch
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
    if (options.rewriteTo === undefined) {
      throw new Error(`Refused a non-loopback request to ${parsed.hostname}`)
    }
    return realFetch(`${options.rewriteTo}${parsed.pathname}`, init)
  }
  return {
    attempted,
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

interface OwnedDefault {
  readonly providerName: string
  readonly deny: NetworkDeny
}

/**
 * Runs with an owned application default and a closed paid boundary.
 *
 * `state` is stated whole rather than as a pair, so the unset and unavailable
 * cases are the same fixture as the usable one with one field changed.
 */
async function withDefault<T>(
  state:
    | { status: 'available'; provider: string; model: string }
    | { status: 'unset' }
    | { status: 'unavailable'; provider: string; model: string },
  connection: { id: string; baseUrl: string } | null,
  run: (owned: OwnedDefault) => Promise<T>,
  denyOptions: { rewriteTo?: string } = {},
): Promise<T> {
  const previousDefault = getRuntimeDefaultModelState()
  const previousKey = process.env.ANTHROPIC_API_KEY
  const deny = denyNonLoopback(denyOptions)
  // Present, and fake. The substituted provider must get far enough to be
  // observed; a missing key would make it refuse first and hide where it went.
  process.env.ANTHROPIC_API_KEY = 'helper-fixture-key-not-real'
  if (connection) {
    setConfiguredProviderConnections([
      {
        id: connection.id,
        kind: 'openai-compatible',
        name: 'Helper provider',
        baseUrl: `${connection.baseUrl}/v1`,
        apiKey: 'helper-key',
      },
    ])
  }
  setRuntimeDefaultModelState(state)
  try {
    return await run({
      providerName: state.status === 'unset' ? '' : state.provider,
      deny,
    })
  } finally {
    deny.restore()
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    setRuntimeDefaultModelState(previousDefault)
    setConfiguredProviderConnections([])
  }
}

const MESSAGES: ConversationMessage[] = [
  {
    from: 'analyst',
    to: 'all',
    message: 'The first option is a phased rollout across three depots.',
    round: 1,
    type: 'position',
    timestamp: '2026-09-09T10:00:00.000Z',
  },
  {
    from: 'editor',
    to: 'all',
    message: 'A phased rollout is cheaper to reverse than a single cutover.',
    round: 1,
    type: 'position',
    timestamp: '2026-09-09T10:00:01.000Z',
  },
]

function compressionInput(outputPath: string) {
  return {
    messages: MESSAGES,
    teamName: 'warehouse-board',
    levelId: 'deliberation',
    currentRound: 3,
    runIdentity: {
      outputPath,
      sessionId: 'compression-session',
      levelId: 'deliberation',
    },
  }
}

/**
 * An assignment of this test's own, removed when it ends.
 *
 * Per test rather than shared: these cases read the journal they wrote, and a
 * directory shared between them would let one case pass on another's record.
 */
function ownedAssignment(t: TestContext, prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}


// ── Compression ─────────────────────────────────────────────────────────────

test('compressing a discussion runs on the application default', async (t) => {
  const assignment = ownedAssignment(t, 'helper-compression-default-')
  const provider = await startRecordingProvider(COMPRESSION_ANSWER)
  const connectionId = randomUUID()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        const result = await compressConversation(compressionInput(assignment))

        // The whole pair, from the one application default. Not `"default"`,
        // and not a provider nobody selected.
        assert.deepEqual(provider.models(), [DEFAULT_MODEL])
        // And nowhere else was even attempted. This is the assertion the fake
        // key exists for: it fails while the substituted provider is still in
        // the path, rather than passing because that path could not start.
        assert.deepEqual(deny.attempted, [])
        assert.equal(result.summary, COMPRESSION_ANSWER)
        assert.equal(result.compressedUpToRound, 2)
        // A configured connection reports no cost of its own, and this does not
        // invent one (`providers/configured-provider.ts:226`).
        assert.equal(result.cost, 0)
      },
    )
  } finally {
    await provider.close()
  }
})

test('compressing a discussion with no usable default asks nothing', async (t) => {
  // The existing mechanical fallback, reached without a dispatch rather than
  // through one that failed. Asking a model nobody selected is the failure this
  // avoids; producing no summary at all would be a different one.
  const assignment = ownedAssignment(t, 'helper-compression-unset-')
  const provider = await startRecordingProvider(COMPRESSION_ANSWER)
  try {
    await withDefault({ status: 'unset' }, null, async ({ deny }) => {
      const result = await compressConversation(compressionInput(assignment))

      assert.deepEqual(provider.models(), [])
      assert.deepEqual(deny.attempted, [])
      assert.equal(result.cost, 0)
      assert.equal(result.compressedUpToRound, 2)
      // Built from the messages themselves, so it names who spoke.
      assert.match(result.summary, /analyst/)
    })
  } finally {
    await provider.close()
  }
})

test('compressing a discussion whose default cannot run asks nothing', async (t) => {
  // A configured default that cannot currently run is not a licence to pick
  // something else. It is the same answer as no default at all.
  const assignment = ownedAssignment(t, 'helper-compression-unavailable-')
  const provider = await startRecordingProvider(COMPRESSION_ANSWER)
  try {
    await withDefault(
      { status: 'unavailable', provider: 'connection:missing', model: DEFAULT_MODEL },
      null,
      async ({ deny }) => {
        const result = await compressConversation(compressionInput(assignment))

        assert.deepEqual(provider.models(), [])
        assert.deepEqual(deny.attempted, [])
        assert.match(result.summary, /analyst/)
      },
    )
  } finally {
    await provider.close()
  }
})

test('a cancelled compression asks nothing and does not fall back', async (t) => {
  // Preserved behaviour: an aborted round rethrows rather than being replaced
  // by a mechanical summary, and it reaches no provider on the way.
  const assignment = ownedAssignment(t, 'helper-compression-cancelled-')
  const provider = await startRecordingProvider(COMPRESSION_ANSWER)
  const connectionId = randomUUID()
  const cancelled = new AbortController()
  cancelled.abort()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        await assert.rejects(() => compressConversation({
          ...compressionInput(assignment),
          signal: cancelled.signal,
        }))
        assert.deepEqual(provider.models(), [])
        assert.deepEqual(deny.attempted, [])
        // And nothing was written down either. A durable notice naming a model
        // that was never asked for anything is the same false account as an
        // unrecorded call, told the other way round — so "asks nothing" is only
        // half the rule, and the half that is easy to keep by accident.
        assert.deepEqual(recordedHelperSelections(assignment), [])
      },
    )
  } finally {
    await provider.close()
  }
})

test('compressing a discussion records the model before it asks it, under the owning run', async (t) => {
  // The positive half of the rule, at the other helper: the account is durable
  // by the time the request goes out, and it belongs to the run that caused the
  // work rather than to nobody.
  const assignment = ownedAssignment(t, 'helper-compression-record-')
  let recordedAtSend: Record<string, unknown>[] = []
  const provider = await startProvider((model) => {
    recordedAtSend = recordedHelperSelections(assignment)
    return JSON.stringify({
      model,
      choices: [{ message: { role: 'assistant', content: COMPRESSION_ANSWER } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })
  })
  const connectionId = randomUUID()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async () => {
        await compressConversation(compressionInput(assignment))

        assert.equal(recordedAtSend.length, 1, JSON.stringify(recordedAtSend))
        const record = recordedAtSend[0]
        assert.ok(record)
        assert.deepEqual(record.model_selection, {
          provider: `connection:${connectionId}`,
          model: DEFAULT_MODEL,
          source: 'app-default',
          reason: 'agent-default',
          caller: 'compression',
        })
        assert.equal(record.session_id, 'compression-session')
        assert.equal(record.level_id, 'deliberation')
      },
    )
  } finally {
    await provider.close()
  }
})

/**
 * An assignment whose runtime journal cannot be written, and nothing else.
 *
 * A real filesystem fault rather than a replaced module: the journal's own path
 * is a directory, so appending to it fails the way a full disk or a permission
 * change would. Deliberately narrow — making the whole `logs` directory
 * unwritable also breaks the artifact writes that follow, and the call would
 * then fail for a reason that has nothing to do with this rule.
 */
function unwritableAssignment(t: TestContext, prefix: string): string {
  const directory = ownedAssignment(t, prefix)
  fs.mkdirSync(path.join(directory, 'logs', 'runtime-events.jsonl'), {
    recursive: true,
  })
  return directory
}

test('a compression whose account cannot be written asks nothing', async (t) => {
  // Fail closed. A model used with no durable account of it is exactly what
  // this capability exists to prevent, so an unwritable journal produces the
  // mechanical summary rather than an undisclosed model call.
  const assignment = unwritableAssignment(t, 'helper-compression-unwritable-')
  const provider = await startRecordingProvider(COMPRESSION_ANSWER)
  const connectionId = randomUUID()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        const result = await compressConversation(compressionInput(assignment))

        assert.deepEqual(provider.models(), [])
        assert.deepEqual(deny.attempted, [])
        assert.match(result.summary, /analyst/)
        assert.equal(result.cost, 0)
      },
    )
  } finally {
    await provider.close()
  }
})

test('minutes whose account cannot be written ask nothing', async (t) => {
  // The same, at the other helper: the mechanical minutes are written and no
  // model is asked anything.
  const assignment = unwritableAssignment(t, 'helper-minutes-unwritable-')
  const provider = await startRecordingProvider(MINUTES_ANSWER)
  const connectionId = randomUUID()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        const { teamConfig, runtimeState } = minutesFixture(assignment)
        const minutes = await generateMinutes(teamConfig, runtimeState, assignment)

        assert.deepEqual(provider.models(), [])
        assert.deepEqual(deny.attempted, [])
        assert.match(minutes, /Meeting Minutes/)
        assert.match(minutes, /analyst/)
        assert.equal(runtimeState.totalCost, 0)
      },
    )
  } finally {
    await provider.close()
  }
})

test('a compression whose provider fails still keeps the account of what it asked', async (t) => {
  // The dispatch really happens here — the request reaches the owned endpoint
  // and comes back a failure — which is what separates this from the cases
  // above where nothing was sent. Two things then have to hold: the round is
  // not lost, and the record of the model that was about to run stands. It was
  // written before the send precisely so a failure cannot erase it.
  const assignment = ownedAssignment(t, 'helper-compression-provider-fault-')
  const attempted: string[] = []
  const provider = await startFailingProvider(attempted)
  const connectionId = randomUUID()
  const warnings = captureProcessWarnings(t)
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        const result = await compressConversation(compressionInput(assignment))

        // Asked, and refused — not skipped.
        assert.deepEqual(attempted, [DEFAULT_MODEL])
        assert.deepEqual(deny.attempted, [])
        assert.match(result.summary, /analyst/)
        assert.equal(result.cost, 0)

        const records = recordedHelperSelections(assignment)
        assert.equal(records.length, 1, JSON.stringify(records))
        assert.deepEqual(records[0]?.model_selection, {
          provider: `connection:${connectionId}`,
          model: DEFAULT_MODEL,
          source: 'app-default',
          reason: 'agent-default',
          caller: 'compression',
        })

        // And the round says it fell back. Both helpers share the disclosure
        // rule, so they share the reporting rule too: reporting one and not the
        // other is the same gap in a smaller place.
        const reported = reportedFallbacks(warnings)
        assert.equal(
          reported.length,
          1,
          `the fallback must report itself once; saw ${JSON.stringify(warnings)}`,
        )
        assert.equal(reported[0]?.helper, 'compression')
        assert.equal(reported[0]?.error, 'summary_unavailable')
        assert.ok(
          !JSON.stringify(reported[0]).includes('the provider refused'),
          'the reported warning must not carry the provider’s own text',
        )
      },
    )
  } finally {
    await provider.close()
  }
})

test('a compression cancelled while queued records nothing', async () => {
  // The account is written before the model is used, which makes *when* it is
  // written part of the contract. Written before the limiter admits the call, a
  // round cancelled while it waited would leave a durable notice saying the
  // application default was used for work that never ran.
  //
  // Synchronised on the limiter itself, with no polling and no waiting. This
  // test holds the only slot, so the compression's own `acquire` queues
  // synchronously behind it (`core/rate-limiter.ts:24-37`) — which is why the
  // count can simply be asserted rather than waited for.
  const directory = ownedDirectory('helper-compression-queued-')
  const provider = await startRecordingProvider(COMPRESSION_ANSWER)
  const connectionId = randomUUID()
  const limiter = new RateLimiter({ maxConcurrent: 1, delayBetweenMs: 0 })
  const cancelled = new AbortController()
  let slotHeld = false
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        await limiter.acquire()
        slotHeld = true
        const queued = compressConversation({
          ...compressionInput(directory),
          rateLimiter: limiter,
          signal: cancelled.signal,
          runIdentity: {
            outputPath: directory,
            sessionId: 'queued-compression-session',
            levelId: 'deliberation',
          },
        })
        assert.equal(limiter.pending, 1)
        cancelled.abort()
        limiter.release()
        slotHeld = false
        await assert.rejects(() => queued)

        assert.deepEqual(recordedHelperSelections(directory), [])
        assert.deepEqual(provider.models(), [])
        assert.deepEqual(deny.attempted, [])
      },
    )
  } finally {
    if (slotHeld) limiter.release()
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a compression with no run to disclose to asks nothing', async (t) => {
  // Disclosure is not optional. A helper with nowhere to record what it is
  // about to use does not use it — it compresses mechanically instead, which is
  // the same answer it gives when no default is usable.
  const provider = await startRecordingProvider(COMPRESSION_ANSWER)
  const connectionId = randomUUID()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        const { runIdentity: _omitted, ...withoutOwner } =
          compressionInput(ownedAssignment(t, 'helper-compression-unused-'))
        const result = await compressConversation(withoutOwner)

        assert.deepEqual(provider.models(), [])
        assert.deepEqual(deny.attempted, [])
        assert.match(result.summary, /analyst/)
      },
    )
  } finally {
    await provider.close()
  }
})

// ── Minutes ─────────────────────────────────────────────────────────────────

/** A Team whose one level holds the discussion the minutes are written from. */
function minutesFixture(
  outputPath: string,
  totalCost = 0,
): { teamConfig: TeamConfig; runtimeState: RuntimeState } {
  const teamConfig: TeamConfig = {
    team: { name: 'Warehouse Board', description: 'Test team', version: '1.0.0' },
    workspace: { path: outputPath, watch: false },
    gates: [],
    agents: [],
    levels: [{
      id: 'discussion',
      name: 'Discussion',
      order: 1,
      stage: {
        type: STAGE_TYPE.DISCUSSION,
        coordinator: 'facilitator',
        participants: ['analyst'],
        config: {
          mode: 'deliberate',
          min_rounds: 1,
          max_rounds: 1,
          constraints: { max_time_minutes: 1, max_budget_usd: 2 },
          output: { format: 'discussion.md', user_review: false },
        },
      },
    }],
  }
  const runtimeState: RuntimeState = {
    sessionId: 'helper-minutes-session',
    currentLevelIndex: 0,
    levelStates: new Map([['discussion', {
      status: LEVEL_STATUS.COMPLETED,
      stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
      engineState: {
        type: STAGE_TYPE.DISCUSSION,
        round: 1,
        messages: MESSAGES,
        outputPath,
      },
      loopbackCount: 0,
    }]]),
    totalCost,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
  return { teamConfig, runtimeState }
}

function ownedDirectory(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/**
 * The precondition every minutes case here rests on.
 *
 * `loadMinutesTemplate` resolves `examples/` relative to its own module, and a
 * missing template is not an error to the helper — minutes fall back to their
 * mechanical form and ask no model anything. So without this check the negative
 * cases below would pass for the wrong reason and the positive ones would fail
 * confusingly. The asset itself is staged by `tests/run-tests.mjs`, where the
 * compiled tree is built; nothing here creates or removes it.
 */
function requireMinutesTemplate(): void {
  const templatePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'examples',
    'minutes-template.md',
  )
  assert.ok(
    fs.existsSync(templatePath) &&
      fs.readFileSync(templatePath, 'utf8').length > 0,
    `the minutes template must be readable at ${templatePath}, ` +
      'or every minutes case here is vacuous',
  )
}

test('writing a run’s minutes runs on the application default', async () => {
  const provider = await startRecordingProvider(MINUTES_ANSWER)
  const directory = ownedDirectory('helper-minutes-')
  const connectionId = randomUUID()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        const { teamConfig, runtimeState } = minutesFixture(directory)
        const minutes = await generateMinutes(teamConfig, runtimeState, directory)

        assert.deepEqual(provider.models(), [DEFAULT_MODEL])
        assert.deepEqual(deny.attempted, [])
        assert.match(minutes, /Phased rollout agreed/)
      },
    )
  } finally {
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('writing minutes with no usable default asks nothing', async () => {
  const provider = await startRecordingProvider(MINUTES_ANSWER)
  const directory = ownedDirectory('helper-minutes-none-')
  try {
    await withDefault({ status: 'unset' }, null, async ({ deny }) => {
      const { teamConfig, runtimeState } = minutesFixture(directory)
      const minutes = await generateMinutes(teamConfig, runtimeState, directory)

      assert.deepEqual(provider.models(), [])
      assert.deepEqual(deny.attempted, [])
      // The mechanical minutes still name the run and who spoke in it.
      assert.match(minutes, /Meeting Minutes/)
      assert.match(minutes, /analyst/)
      assert.equal(runtimeState.totalCost, 0)
    })
  } finally {
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Every helper selection this assignment recorded, from its own journal.
 *
 * Read from the runtime's log rather than from a callback, because what has to
 * be true is that the account is *durable* by the time the request goes out —
 * an in-memory notification would be gone with the process.
 */
function recordedHelperSelections(
  assignmentPath: string,
): Record<string, unknown>[] {
  const journal = path.join(assignmentPath, 'logs', 'runtime-events.jsonl')
  if (!fs.existsSync(journal)) return []
  return fs
    .readFileSync(journal, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.model_selection !== undefined)
}

test('writing minutes records the model before it asks it, under the owning run', async () => {
  // The same rule the other callers keep, and the reason this is not merely
  // logging: a person is told which model did this work, and the account has to
  // exist before the model is used rather than after it succeeds.
  const directory = ownedDirectory('helper-minutes-record-')
  let recordedAtSend: Record<string, unknown>[] = []
  const provider = await startProvider((model) => {
    recordedAtSend = recordedHelperSelections(directory)
    return JSON.stringify({
      model,
      choices: [{ message: { role: 'assistant', content: MINUTES_ANSWER } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })
  })
  const connectionId = randomUUID()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async () => {
        const { teamConfig, runtimeState } = minutesFixture(directory)
        await generateMinutes(teamConfig, runtimeState, directory)

        assert.equal(recordedAtSend.length, 1, JSON.stringify(recordedAtSend))
        const record = recordedAtSend[0]
        assert.ok(record)
        assert.deepEqual(record.model_selection, {
          provider: `connection:${connectionId}`,
          model: DEFAULT_MODEL,
          source: 'app-default',
          reason: 'agent-default',
          // Truthful about what this was. Writing minutes is not an Agent's
          // turn, not a chat, not authoring and not a title.
          caller: 'minutes',
        })
        // Owned by the run that asked for it, so the conversation that caused
        // this work is the one that can show it.
        assert.equal(record.session_id, runtimeState.sessionId)
      },
    )
  } finally {
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('minutes that ask nothing record nothing', async () => {
  // A record naming a model that was never asked for anything is the same false
  // account as an unrecorded call, told the other way round.
  const directory = ownedDirectory('helper-minutes-no-record-')
  const provider = await startRecordingProvider(MINUTES_ANSWER)
  try {
    await withDefault({ status: 'unset' }, null, async () => {
      const { teamConfig, runtimeState } = minutesFixture(directory)
      await generateMinutes(teamConfig, runtimeState, directory)

      assert.deepEqual(recordedHelperSelections(directory), [])
    })
  } finally {
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * What the process said while a test ran.
 *
 * The minutes fallback is the only place in this capability that reports on the
 * process boundary rather than into the run's journal, because the run is
 * getting its minutes either way and the fallback is not a failure of the run.
 * That makes it the one thing a journal reader cannot find, so it has to be
 * asserted where it is actually written.
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

/** The fallback reports among whatever else the process said. */
function reportedFallbacks(lines: readonly string[]): Record<string, unknown>[] {
  return lines
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
    .filter((entry) => entry.event === 'runtime.helper_summary_unavailable')
}

test('minutes that fall back say why, instead of degrading in silence', async (t) => {
  // The fallback is correct — a run still gets its minutes when the summarizing
  // model cannot answer. Saying nothing about it is not. Every desktop build
  // shipped without the prompt template this helper reads, so every run took
  // this path and wrote "LLM summarization unavailable" into its minutes with
  // no account anywhere of what was unavailable or why.
  //
  // Driven through a refusing provider rather than by hiding the template: the
  // template is a shared asset that other cases here depend on, and a test that
  // removed it would be changing what another test reads.
  requireMinutesTemplate()
  const directory = ownedDirectory('helper-minutes-fallback-reason-')
  const attempted: string[] = []
  const provider = await startFailingProvider(attempted)
  const connectionId = randomUUID()
  const warnings = captureProcessWarnings(t)
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async () => {
        const { teamConfig, runtimeState } = minutesFixture(directory)
        const minutes = await generateMinutes(teamConfig, runtimeState, directory)

        // The run still gets its minutes: this is a fallback, not a failure.
        assert.match(minutes, /LLM summarization unavailable/)
        // And the provider really was asked, so the fallback is the one this
        // case means to exercise.
        assert.deepEqual(attempted, [DEFAULT_MODEL])

        const reported = reportedFallbacks(warnings)
        assert.equal(
          reported.length,
          1,
          `the fallback must report itself once; saw ${JSON.stringify(warnings)}`,
        )
        const [only] = reported
        assert.equal(only?.error, 'summary_unavailable')
        assert.equal(only?.helper, 'minutes')
        assert.equal(only?.session_id, runtimeState.sessionId)
        // Identity and a fixed category only. A provider's own message can
        // quote a request, a header or a filesystem path, and nothing this
        // repository writes down may carry that.
        assert.equal(only?.reason, undefined)
        assert.ok(
          !JSON.stringify(only).includes('the provider refused'),
          'the reported warning must not carry the provider’s own text',
        )
      },
    )
  } finally {
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('minutes cancelled before they start record nothing', async () => {
  // The same rule at the other helper, and the existing behaviour it has to
  // keep: `generateMinutes` rethrows a cancellation rather than answering it
  // with mechanical minutes. What changes is that nothing is asked and nothing
  // is recorded on the way to that rethrow.
  const directory = ownedDirectory('helper-minutes-cancelled-')
  const provider = await startRecordingProvider(MINUTES_ANSWER)
  const connectionId = randomUUID()
  const cancelled = new AbortController()
  cancelled.abort()
  try {
    await withDefault(
      { status: 'available', provider: `connection:${connectionId}`, model: DEFAULT_MODEL },
      { id: connectionId, baseUrl: provider.url },
      async ({ deny }) => {
        const { teamConfig, runtimeState } = minutesFixture(directory)
        await assert.rejects(
          () => generateMinutes(teamConfig, runtimeState, directory, cancelled.signal),
        )

        assert.deepEqual(recordedHelperSelections(directory), [])
        assert.deepEqual(provider.models(), [])
        assert.deepEqual(deny.attempted, [])
      },
    )
  } finally {
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a priced default still accumulates the run’s cost', async () => {
  // The cost control, on a path that actually produces one. A configured
  // connection reports no cost, so proving accumulation there would assert
  // `0 === 0`. This runs the real Anthropic adapter — intercepted at the HTTP
  // boundary, against an owned server, with the pricing supplied through the
  // supported `TEAM_PROVIDER_PRICING_JSON` hook rather than by changing what
  // the product charges for anything.
  const provider = await startAnthropicProvider(MINUTES_ANSWER)
  const directory = ownedDirectory('helper-minutes-cost-')
  const previousPricing = process.env.TEAM_PROVIDER_PRICING_JSON
  process.env.TEAM_PROVIDER_PRICING_JSON = JSON.stringify({
    [`anthropic:${PAID_MODEL}`]: { inputPerMillion: 1, outputPerMillion: 1 },
  })
  try {
    await withDefault(
      { status: 'available', provider: 'anthropic', model: PAID_MODEL },
      null,
      async ({ deny }) => {
        const { teamConfig, runtimeState } = minutesFixture(directory, 1)
        await generateMinutes(teamConfig, runtimeState, directory)

        assert.deepEqual(provider.models(), [PAID_MODEL])
        // Reached the owned server through the rewrite, so the paid host was
        // named but never actually contacted.
        assert.deepEqual(deny.attempted, ['api.anthropic.com'])
        // One million input and one million output tokens at $1 each.
        assert.equal(runtimeState.totalCost, 3)
        assert.match(
          fs.readFileSync(path.join(directory, 'minutes.md'), 'utf8'),
          /\*\*Cost:\*\* \$3/,
        )
      },
      { rewriteTo: provider.url },
    )
  } finally {
    if (previousPricing === undefined) delete process.env.TEAM_PROVIDER_PRICING_JSON
    else process.env.TEAM_PROVIDER_PRICING_JSON = previousPricing
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
