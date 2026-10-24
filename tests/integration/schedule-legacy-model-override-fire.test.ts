/**
 * What a schedule carrying a retired model override actually runs on.
 *
 * A schedule saved before the setting was retired still holds a `modelOverride`
 * in `schedules.json`, and the overview row used to print it as a bare
 * `provider/model` beside the target and timezone — which are operative. So the
 * row said the schedule runs on that pair. It does not: the Agent runs with its
 * own provider and model, or with the one application default.
 *
 * `schedule-model-override-retired.test.ts` proves the request is refused and
 * that the wrapper Team omits the setting. Neither says anything about what a
 * fire actually dispatches, which is the part a person was being misinformed
 * about, so this drives a real one: the durable queue, the real detached
 * session-task launcher, and a loopback provider this test owns. The evidence
 * is the set of models the provider was asked for.
 *
 * The stored schedule is not repaired. Its authored configuration — including
 * the retired setting — is left exactly as it was, because rewriting somebody's
 * file to make a display honest is the wrong end of the problem.
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
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import type { SessionTask } from '../../contracts/sessions.js'
import { defaultIsProcessAlive } from '../../domains/sessions/task-process-supervisor.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

const PROVIDER_KEY = 'schedule-legacy-override-key'
/** What the fixture's Agent names in its own file. */
const AGENT_MODEL = 'gpt-5-mini'
/**
 * The application default, set deliberately to something the Agent does not
 * name. Anything falling back to it would be visible in the provider's record.
 */
const TITLE_MODEL = 'app-default-title-model'
/**
 * The retired setting the stored schedule carries. Never dispatched.
 *
 * Deliberately an OpenAI model id, not a real Anthropic one. A regression that
 * actually honoured this override has to stay on the loopback this test owns:
 * `providers/anthropic.ts` defaults to the real API unless a `base_url` is
 * supplied, so an Anthropic id here could send a genuine external request — or
 * fail off-fixture without being recorded at all, which would hide the very
 * regression this is watching for.
 */
const RETIRED_OVERRIDE = { provider: 'openai', model: 'retired-schedule-model' } as const

// The parent process registers its built-in providers exactly as the real API
// boot does (`server/api-server.ts:57`). Without it the schedule service's own
// title helper takes a mechanical fallback and never reaches the fixture, which
// would let this test record an incomplete boot as the expected result.
initProviders()

/** A phrase from the fixture Agent's own persona, so its turn can be told apart. */
const AGENT_PERSONA_MARKER = 'Produce the requested test result.'
/** The same, for the Agent that names no pair of its own. */
const INHERITING_PERSONA_MARKER = 'Answer as the inheriting scheduler agent.'

test('a schedule carrying a retired override fires on the Agent’s own pair', async () => {
  const fixture = createSchedulerFixture('schedule-legacy-override-')
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'schedule-legacy-override-workspace-'),
  )
  const provider = await startRecordingProvider()
  const previousApiKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  process.env.OPENAI_API_KEY = PROVIDER_KEY
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`
  // The title helper owns no Agent, so it runs on the deliberate application
  // default. Named distinctly from the Agent's own model so the two can be told
  // apart in the provider's record.
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'openai',
    model: TITLE_MODEL,
  })
  delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN

  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: 'schedule-legacy-override-test',
  })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const taskQueue = new TaskQueue({
    sessionStore: store,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    // The real launcher, not a blocking stand-in: this test is about what a
    // fire dispatches, which only a real one can show.
    taskLauncher: new SessionTaskRunnerLauncher(process.cwd()),
    tickIntervalMs: 25,
  })
  const firedAt = new Date('2026-07-20T18:42:07.321Z')
  const storagePath = path.join(workspacePath, 'task-queue', 'schedules.json')
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
  const personaPath = path.join(
    fixture.repoRootPath,
    'agents',
    fixture.agentName,
    `${fixture.agentName}.md`,
  )
  const personaBefore = fs.readFileSync(personaPath, 'utf8')
  let task: SessionTask | undefined
  try {
    await taskQueue.initialize()
    await scheduleService.initialize()
    // A record of the shape saved before the HTTP boundary began refusing the
    // field. The service still accepts it, which is how such records exist.
    const schedule = await scheduleService.create({
      name: 'Legacy override schedule',
      kind: 'agent',
      target: fixture.agentName,
      prompt: 'Produce a concise report about detached worker provider readiness.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      enabled: true,
      modelOverride: { ...RETIRED_OVERRIDE },
    })
    assert.deepEqual(
      schedule.modelOverride,
      { ...RETIRED_OVERRIDE },
      'the stored record has to carry the retired setting, or this proves nothing',
    )

    const launched = await scheduleService.runNow(schedule.id)
    task = await waitForTerminalTask(store, launched.sessionId, launched.taskId)
    assert.equal(task.status, 'done', task.error)
    if (task.pid) {
      await waitForProcessStop(
        process.platform === 'win32'
          ? task.pid
          : -(task.processGroupId ?? task.pid),
      )
    }

    // The Agent's own turn, identified by a phrase from its own persona rather
    // than by position, ran on the pair its file names.
    assert.deepEqual(
      provider.modelsMatching(AGENT_PERSONA_MARKER),
      [AGENT_MODEL],
      `the Agent's own turn did not run on its own pair: ${JSON.stringify(provider.models())}`,
    )
    // And the retired setting reached no request at all — not the Agent's turn,
    // not the title helper's, not anything else this fire caused.
    assert.equal(
      provider.models().includes(RETIRED_OVERRIDE.model),
      false,
      `a retired override was dispatched: ${JSON.stringify(provider.models())}`,
    )
    // Every model this fire asked for, and nothing else. Two callers, told
    // apart by attribution rather than by the set: the Agent's own turn on its
    // own pair, and the schedule service's artifact-filename helper, which owns
    // no Agent and therefore runs on the application default.
    assert.deepEqual(
      [...provider.models()].sort(),
      [AGENT_MODEL, TITLE_MODEL].sort(),
      JSON.stringify(provider.models()),
    )
    assert.equal(
      provider.modelsMatching(AGENT_PERSONA_MARKER).includes(TITLE_MODEL),
      false,
      'the Agent’s own turn must not have run on the application default',
    )

    // The authored configuration is intact. `schedules.json` legitimately
    // changes for fire and status bookkeeping, so this reads the schedule's own
    // definition rather than the whole file.
    const stored = (await scheduleService.list()).find(
      (entry) => entry.id === schedule.id,
    )
    assert.ok(stored)
    assert.equal(stored.name, 'Legacy override schedule')
    assert.equal(stored.target, fixture.agentName)
    assert.equal(stored.cron, '0 9 * * *')
    assert.equal(stored.timezone, 'America/Detroit')
    assert.equal(stored.prompt, schedule.prompt)
    assert.deepEqual(
      stored.modelOverride,
      { ...RETIRED_OVERRIDE },
      'a fire must not quietly repair somebody’s stored schedule',
    )
    // The Agent's own file is untouched: the fire reads it, and writes nothing.
    assert.equal(fs.readFileSync(personaPath, 'utf8'), personaBefore)
    // And the wrapper Team the schedule runs through names no model either.
    // Found by its own directory rather than by a stored id, because the view
    // this service returns deliberately carries no execution target.
    const wrapperDirectory = fs
      .readdirSync(path.join(fixture.repoRootPath, 'teams'))
      .find((entry) => entry.startsWith('scheduled-agent-'))
    assert.ok(wrapperDirectory, 'the fire should have written a wrapper Team')
    const wrapperYaml = fs.readFileSync(
      path.join(fixture.repoRootPath, 'teams', wrapperDirectory, 'team.yaml'),
      'utf8',
    )
    assert.doesNotMatch(wrapperYaml, /^\s+provider:/mu)
    assert.doesNotMatch(wrapperYaml, /^\s+model:/mu)
  } finally {
    await scheduleService.close()
    await taskQueue.close(1)
    await owner.release()
    restoreEnvironment('OPENAI_API_KEY', previousApiKey)
    restoreEnvironment('OPENAI_BASE_URL', previousBaseUrl)
    setRuntimeDefaultModelState(undefined)
    restoreEnvironment('TEAM_RUNTIME_TASK_RUNNER_DRY_RUN', previousDryRun)
    await provider.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * The other half of the rule, on the same real path.
 *
 * An Agent that names no pair runs on the one application default — and the run
 * has to say so, or a person reading the history cannot tell an inherited pair
 * from a chosen one. This fires such an Agent for real and reads both what the
 * provider was asked for and what the run recorded about the decision.
 */
test('a scheduled Agent that names no pair fires on the app default and records it', async () => {
  const fixture = createSchedulerFixture('schedule-inherited-default-')
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'schedule-inherited-default-workspace-'),
  )
  const provider = await startRecordingProvider()
  const previousApiKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  process.env.OPENAI_API_KEY = PROVIDER_KEY
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'openai',
    model: TITLE_MODEL,
  })
  delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN

  // Inheritance is the absence of a pair, never a copy of today's default.
  const inheritingAgent = 'inheriting-agent'
  fs.mkdirSync(path.join(fixture.repoRootPath, 'agents', inheritingAgent), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(fixture.repoRootPath, 'agents', inheritingAgent, `${inheritingAgent}.md`),
    [
      '---',
      'name: Inheriting Agent',
      'description: Agent that names no pair of its own.',
      '---',
      '',
      INHERITING_PERSONA_MARKER,
      '',
    ].join('\n'),
  )

  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: 'schedule-inherited-default-test',
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
  const scheduleService = new ScheduleService({
    storagePath: path.join(workspacePath, 'task-queue', 'schedules.json'),
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
    now: () => new Date('2026-07-20T18:42:07.321Z'),
  })
  let task: SessionTask | undefined
  try {
    await taskQueue.initialize()
    await scheduleService.initialize()
    const schedule = await scheduleService.create({
      name: 'Inheriting schedule',
      kind: 'agent',
      target: inheritingAgent,
      prompt: 'Produce a concise report about detached worker provider readiness.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      enabled: true,
    })
    const launched = await scheduleService.runNow(schedule.id)
    task = await waitForTerminalTask(store, launched.sessionId, launched.taskId)
    assert.equal(task.status, 'done', task.error)
    if (task.pid) {
      await waitForProcessStop(
        process.platform === 'win32'
          ? task.pid
          : -(task.processGroupId ?? task.pid),
      )
    }

    // What was dispatched, attributed to this Agent's own turn.
    assert.deepEqual(
      provider.modelsMatching(INHERITING_PERSONA_MARKER),
      [TITLE_MODEL],
      `the inheriting Agent did not run on the application default: ${JSON.stringify(provider.models())}`,
    )

    // And what the run said about the decision, from its own durable record.
    //
    // `workflows/runner.ts` writes the selection on the Agent step's start, at
    // that step's own child assignment — not at the parent task's. So the log
    // is found by walking the workspace for `agent-runs.jsonl`, the raw form
    // (`domains/runtime/logger.ts`), rather than assumed to sit beside the task.
    const started = readAgentRunLogs(workspacePath).filter(
      (record) => record.event === 'start' && record.model_selection,
    )
    assert.equal(started.length, 1, JSON.stringify(started))
    // Tied to the Agent whose turn it was, so the record cannot belong to some
    // other dispatch that happened to name the same pair.
    assert.equal(started[0]?.agent_name, inheritingAgent, JSON.stringify(started[0]))
    assert.deepEqual(
      started[0]?.model_selection,
      {
        provider: 'openai',
        model: TITLE_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      },
      JSON.stringify(started[0]?.model_selection),
    )
  } finally {
    await scheduleService.close()
    await taskQueue.close(1)
    await owner.release()
    restoreEnvironment('OPENAI_API_KEY', previousApiKey)
    restoreEnvironment('OPENAI_BASE_URL', previousBaseUrl)
    setRuntimeDefaultModelState(undefined)
    restoreEnvironment('TEAM_RUNTIME_TASK_RUNNER_DRY_RUN', previousDryRun)
    await provider.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

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

interface AgentRunRecord {
  readonly event?: string
  readonly agent_name?: string
  readonly model_selection?: {
    provider?: string
    model?: string
    source?: string
    reason?: string
    caller?: string
  }
}

/**
 * Every `agent-runs.jsonl` under the workspace, in raw form.
 *
 * Walked rather than addressed: a run in the session layout writes its log
 * under `sessions/<id>/runs/<id>/assignments/<id>/logs`, and a workflow step's
 * Agent writes at the step's own child assignment rather than at the parent
 * task's.
 */
function readAgentRunLogs(workspace: string): AgentRunRecord[] {
  const records: AgentRunRecord[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name !== 'agent-runs.jsonl') continue
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (line.trim()) records.push(JSON.parse(line) as AgentRunRecord)
      }
    }
  }
  walk(workspace)
  return records
}

async function waitForProcessStop(target: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (defaultIsProcessAlive(target) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(defaultIsProcessAlive(target), false)
}

/** The only endpoint this fire may reach, recording every model it is asked for. */
async function startRecordingProvider(): Promise<{
  url: string
  models(): string[]
  modelsMatching(marker: string): string[]
  close(): Promise<void>
}> {
  const requests: Array<{ model: string; body: string }> = []
  const server = http.createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.headers.authorization !== `Bearer ${PROVIDER_KEY}` ||
      request.url !== '/v1/responses'
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
      // The whole body is kept, so a request can be attributed to the caller
      // that made it. A combined set of model ids cannot: two callers that
      // swapped models would produce the same set and pass.
      requests.push({ model, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model,
        output_text: model === TITLE_MODEL
          ? 'Detached Worker Provider Report'
          : '# Result\n\nDetached worker provider ready.\n',
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    models: () => [...new Set(requests.map((entry) => entry.model))],
    modelsMatching: (marker: string) => [
      ...new Set(
        requests
          .filter((entry) => entry.body.includes(marker))
          .map((entry) => entry.model),
      ),
    ],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
