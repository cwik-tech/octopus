/**
 * Which model named a scheduled run's artifact.
 *
 * A schedule fires with nobody watching. Before it admits anything it asks a
 * model for a sensible filename for the result — work that owns no Agent, so
 * under master §7 D1 it runs on the one application default, and it said
 * nothing about that. The other three title callers now do.
 *
 * This one differs from all of them in what owns the record. There is no chat
 * turn and no admitted task yet: the naming happens *before* admission
 * (`services/schedule-service.ts:421-424`). What does exist is the fire's own
 * session, created and persisted one per occurrence before any of this
 * (`:389-403`), and `SchedulePendingFire` carries no other identity
 * (`contracts/schedules.ts:28-31`). So the session is the fire, and the record
 * lives on it.
 *
 * The first case drives a real fire — the durable queue, the real detached
 * launcher, an owned loopback provider — because what is being proved is what a
 * fire actually asks for and what actually ends up in the file. The two after it
 * drive the naming helper directly against the same owned provider, because what
 * they are about is what happens when the record cannot be taken, and admission
 * has nothing to do with that.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { ScheduleService } from '../../services/schedule-service.js'
import { createScheduledAgentTargetResolver } from '../../services/scheduled-agent-target.js'
import { TaskQueue } from '../../services/task-queue.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import { defaultIsProcessAlive } from '../../domains/sessions/task-process-supervisor.js'
import { generateScheduledArtifactFilename } from '../../domains/scheduling/scheduled-artifact-filename.js'
import type { SessionTask } from '../../contracts/sessions.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

const PROVIDER_KEY = 'schedule-artifact-filename-key'
/** What the fixture's Agent names in its own file. */
const AGENT_MODEL = 'gpt-5-mini'
/** The one application default, named so nothing else can be mistaken for it. */
const DEFAULT_MODEL = 'app-default-filename-model'
/** A phrase from the fixture Agent's own persona, so its turn is identifiable. */
const AGENT_PERSONA_MARKER = 'Produce the requested test result.'
/** A phrase only the naming helper's own system prompt carries. */
const NAMING_PROMPT_MARKER = 'session title that summarizes'
const BRIEF = 'Produce a concise report about detached worker provider readiness.'
/**
 * What the brief alone yields, when no model is asked.
 *
 * `deriveTitleFromBrief` recognises "report about" and appends "Overview"
 * (`job-title-sanitize.ts:145-152`), so the mechanical name is deliberately not
 * the same string the model answers with — otherwise a test could not tell
 * which of the two produced it.
 */
const DETERMINISTIC_FILENAME = 'detached-worker-provider-readiness-overview.md'
/** What the naming model answers when it is asked. */
const GENERATED_FILENAME = 'detached-worker-provider-readiness.md'

// The parent process registers its built-in providers exactly as the real API
// boot does (`server/api-server.ts:57`).
initProviders()

interface RecordingProvider {
  readonly url: string
  /** Every model asked for, in order. */
  models(): string[]
  /** The models named by requests carrying `marker`, in order. */
  modelsMatching(marker: string): string[]
  close(): Promise<void>
}

/**
 * The only endpoint this fire may reach.
 *
 * Serves both the Responses and the Chat Completions shapes, because the
 * Agent's own turn and the naming helper do not go through the same one. The
 * whole body is kept so a request can be attributed to the caller that made it:
 * a combined set of model ids cannot, since two callers that swapped models
 * would produce the same set and pass.
 */
async function startRecordingProvider(
  onNamingRequest?: () => void,
): Promise<RecordingProvider> {
  const requests: Array<{ model: string; body: string }> = []
  const server = http.createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.headers.authorization !== `Bearer ${PROVIDER_KEY}`
    ) {
      response.writeHead(404).end('not found')
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let model = ''
      try {
        model = String((JSON.parse(body) as { model?: unknown }).model ?? '')
      } catch {
        model = ''
      }
      requests.push({ model, body })
      const isNaming = body.includes(NAMING_PROMPT_MARKER)
      if (isNaming) onNamingRequest?.()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model,
        // The Responses shape the Agent's turn reads…
        output_text: isNaming
          ? 'Detached Worker Provider Readiness'
          : '# Result\n\nDetached worker provider ready.\n',
        // …and the Chat Completions shape the naming helper reads.
        choices: [{
          message: {
            role: 'assistant',
            content: isNaming
              ? 'Detached Worker Provider Readiness'
              : '# Result\n\nDetached worker provider ready.\n',
          },
        }],
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
          prompt_tokens: 12,
          completion_tokens: 8,
        },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    models: () => requests.map((entry) => entry.model),
    modelsMatching: (marker: string) =>
      requests.filter((entry) => entry.body.includes(marker)).map((entry) => entry.model),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

/**
 * Waits for the fire's detached worker to reach a terminal state.
 *
 * A separate OS process publishes nothing this test can subscribe to, so its
 * own durable record is the only signal — the same bounded read this
 * repository's other real-fire journey uses
 * (`schedule-legacy-model-override-fire.test.ts:386`). Bounded and diagnostic:
 * a task that never settles fails saying what it last was, rather than hanging.
 */
async function waitForTerminalTask(
  store: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
  timeoutMs = 20_000,
): Promise<SessionTask> {
  const deadline = Date.now() + timeoutMs
  let lastTask: SessionTask | null = null
  while (Date.now() < deadline) {
    const task = await store.getTaskRecord(sessionId, taskId)
    lastTask = task
    if (
      task &&
      (task.status === 'done' ||
        task.status === 'failed' ||
        task.status === 'blocked' ||
        task.status === 'cancelled')
    ) {
      return task
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `Task '${taskId}' did not reach a terminal state within ${timeoutMs}ms: ` +
      JSON.stringify(lastTask),
  )
}

/**
 * The session this exact schedule's current fire is using, read from its own
 * durable record.
 *
 * `schedule-service.ts:397-403` persists `pendingFire` before it names
 * anything, so by the time a naming request goes out this is already on disk.
 * Read by schedule id rather than by taking the newest session directory: a
 * guess at which session is "the" one is exactly how a fixture comes to assert
 * against the wrong fire.
 */
function pendingFireSessionId(storagePath: string, scheduleId: string): string | null {
  if (!fs.existsSync(storagePath)) return null
  const parsed: unknown = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return null
  const schedules = Reflect.get(parsed, 'schedules')
  if (!Array.isArray(schedules)) return null
  for (const entry of schedules) {
    if (typeof entry !== 'object' || entry === null) continue
    if (Reflect.get(entry, 'id') !== scheduleId) continue
    const runtime = Reflect.get(entry, 'runtime')
    if (typeof runtime !== 'object' || runtime === null) return null
    const pendingFire = Reflect.get(runtime, 'pendingFire')
    if (typeof pendingFire !== 'object' || pendingFire === null) return null
    const sessionId = Reflect.get(pendingFire, 'sessionId')
    return typeof sessionId === 'string' ? sessionId : null
  }
  return null
}

/**
 * Waits for the detached worker to be gone before the fixture is torn down.
 *
 * A live child holding the workspace open while it is deleted is a different
 * failure from anything under test, and one that lands in whichever test runs
 * next.
 */
async function waitForProcessStop(target: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (defaultIsProcessAlive(target) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(defaultIsProcessAlive(target), false)
}

/** The recorded history as it stands on disk, unvalidated. */
function storedAttempts(metadataPath: string): unknown[] {
  const raw = fs.readFileSync(metadataPath, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return []
  const attempts = Reflect.get(parsed, 'titleAttempts')
  return Array.isArray(attempts) ? attempts : []
}

test('a fired schedule records the model that named its artifact, before that model is used', async () => {
  const fixture = createSchedulerFixture('schedule-artifact-filename-')
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'schedule-artifact-filename-workspace-'),
  )
  const storagePath = path.join(workspacePath, 'task-queue', 'schedules.json')
  let scheduleId = ''
  let sessionAtSend: string | null = null
  let historyAtSend: unknown[] = []
  const metadataPath = (id: string) =>
    path.join(workspacePath, 'sessions', id, 'session.json')
  // Read at the moment the naming request reaches the provider, so "recorded
  // before the send" is proved where it matters. The session is resolved from
  // this schedule's own persisted fire, because the naming happens *inside*
  // `runNow` — anything the test learns from that call's return value is learnt
  // too late to be read here.
  const provider = await startRecordingProvider(() => {
    sessionAtSend = scheduleId ? pendingFireSessionId(storagePath, scheduleId) : null
    historyAtSend = sessionAtSend ? storedAttempts(metadataPath(sessionAtSend)) : []
  })

  const previousApiKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  const previousDefault = getRuntimeDefaultModelState()
  process.env.OPENAI_API_KEY = PROVIDER_KEY
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`
  delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'openai',
    model: DEFAULT_MODEL,
  })

  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: 'schedule-artifact-filename-test',
  })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const taskQueue = new TaskQueue({
    sessionStore: store,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    taskLauncher: new SessionTaskRunnerLauncher(process.cwd()),
    tickIntervalMs: 25,
  })
  const firedAt = new Date('2026-09-09T18:42:07.321Z')
  const scheduleService = new ScheduleService({
    storagePath,
    sessionStore: store,
    taskQueue,
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    resolveAgentTarget: createScheduledAgentTargetResolver({
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    }),
    tickIntervalMs: 60_000,
    now: () => firedAt,
  })

  try {
    await taskQueue.initialize()
    await scheduleService.initialize()
    const schedule = await scheduleService.create({
      name: 'Artifact filename schedule',
      kind: 'agent',
      target: fixture.agentName,
      prompt: BRIEF,
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      enabled: true,
    })

    // Known before the fire starts, because the naming happens during it.
    scheduleId = schedule.id
    const launched = await scheduleService.runNow(schedule.id)
    const task = await waitForTerminalTask(store, launched.sessionId, launched.taskId)
    assert.equal(task.status, 'done', task.error)
    if (task.pid) {
      await waitForProcessStop(
        process.platform === 'win32' ? task.pid : -(task.processGroupId ?? task.pid),
      )
    }

    // The name the naming actually produced, read from the workflow this fire
    // ran. Without this the record could be right about a model whose answer
    // went nowhere.
    assert.ok(task.workflowSnapshotPath, JSON.stringify(task))
    assert.match(
      fs.readFileSync(task.workflowSnapshotPath, 'utf8'),
      new RegExp(GENERATED_FILENAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )

    // Two callers, told apart by what they said rather than by position. The
    // Agent's own turn is still running the schedule; only the other one is the
    // optional naming this capability is about.
    assert.deepEqual(
      provider.modelsMatching(AGENT_PERSONA_MARKER),
      [AGENT_MODEL],
      `the Agent's own turn did not run on its own pair: ${JSON.stringify(provider.models())}`,
    )
    assert.deepEqual(
      provider.modelsMatching(NAMING_PROMPT_MARKER),
      [DEFAULT_MODEL],
      `the naming did not run on the application default: ${JSON.stringify(provider.models())}`,
    )

    // The entry was already on disk when the naming request went out, on the
    // session this schedule's own fire had already recorded.
    assert.equal(sessionAtSend, launched.sessionId)
    assert.equal(historyAtSend.length, 1, JSON.stringify(historyAtSend))
    const atSend = historyAtSend[0]
    assert.ok(atSend && typeof atSend === 'object', JSON.stringify(atSend))
    assert.deepEqual(Reflect.get(atSend, 'selection'), {
      provider: 'openai',
      model: DEFAULT_MODEL,
      source: 'app-default',
      reason: 'agent-default',
      caller: 'title',
    }, JSON.stringify(atSend))

    // What the fire's own session now says, read back through the ordinary read.
    const reloaded = await store.getSession(launched.sessionId)
    assert.ok(reloaded)
    const attempts = reloaded.titleAttempts ?? []
    assert.equal(attempts.length, 1, JSON.stringify(attempts))
    const attempt = attempts[0]
    assert.ok(attempt)
    assert.equal(attempt.operation, 'scheduled-filename')
    // The fire is the owner, and its session is the only identity a fire has.
    assert.equal(attempt.owner, launched.sessionId)
    assert.ok(attempt.attemptId, 'and it carries an identity of its own')
    assert.equal(attempt.selection.model, DEFAULT_MODEL)
    assert.equal(attempt.selection.source, 'app-default')

    // ── The application default changes ────────────────────────────────────
    setRuntimeDefaultModelState({
      status: 'available',
      provider: 'openai',
      model: 'a-different-default-entirely',
    })
    const reopened = await store.getSession(launched.sessionId)
    assert.ok(reopened)
    // The record is what happened, not what Settings says now.
    assert.equal(reopened.titleAttempts?.[0]?.selection.model, DEFAULT_MODEL)
  } finally {
    setRuntimeDefaultModelState(previousDefault)
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousBaseUrl
    if (previousDryRun !== undefined) {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    await scheduleService.close()
    await taskQueue.close(1)
    await owner.release()
    await provider.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a naming whose selection cannot be recorded asks no model, and still names the file', async () => {
  // The record is taken before the send, so an owner that cannot take it
  // declines and nothing is dispatched. The schedule is not held up by that:
  // the deterministic name derived from the brief is what it already falls back
  // to, and no second name is invented for this case.
  const provider = await startRecordingProvider()
  const previousApiKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousDefault = getRuntimeDefaultModelState()
  process.env.OPENAI_API_KEY = PROVIDER_KEY
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'openai',
    model: DEFAULT_MODEL,
  })

  try {
    const filename = await generateScheduledArtifactFilename({
      brief: BRIEF,
      firedAt: new Date('2026-09-09T18:42:07.321Z'),
      onSelected: async () => false,
    })

    assert.deepEqual(provider.models(), [])
    // The exact name a person would get, derived from the brief. Stated rather
    // than recomputed: rebuilding it here with the production helper would make
    // this agree with itself whatever the helper did.
    assert.equal(filename, DETERMINISTIC_FILENAME)
  } finally {
    setRuntimeDefaultModelState(previousDefault)
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousBaseUrl
    await provider.close()
  }
})

test('a naming with no application default asks no model, and records nothing', async () => {
  // Nothing to run on and nothing invented to fill the gap. The name still
  // comes from the brief, and no attempt claims a model was about to be used.
  const provider = await startRecordingProvider()
  const previousApiKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousDefault = getRuntimeDefaultModelState()
  process.env.OPENAI_API_KEY = PROVIDER_KEY
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`
  // Stated, not cleared. Passing `undefined` rehydrates whatever
  // `PIPELINE_DEFAULT_MODEL_SELECTION` holds in the ambient environment
  // (`default-model-selection.ts:27-39`), so this test would otherwise depend
  // on the machine it runs on — and could reach a real default.
  setRuntimeDefaultModelState({ status: 'unset' })
  const recorded: unknown[] = []

  try {
    const filename = await generateScheduledArtifactFilename({
      brief: BRIEF,
      firedAt: new Date('2026-09-09T18:42:07.321Z'),
      onSelected: async (selection) => {
        recorded.push(selection)
        return true
      },
    })

    assert.deepEqual(provider.models(), [])
    assert.deepEqual(recorded, [])
    assert.match(filename, /\.md$/)
  } finally {
    setRuntimeDefaultModelState(previousDefault)
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousBaseUrl
    await provider.close()
  }
})
