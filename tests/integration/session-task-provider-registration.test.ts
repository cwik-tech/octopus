import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { launchSessionTask } from '../../services/task-service.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
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

test('detached session workers initialize built-in providers before workflow dispatch', async () => {
  const fixture = createSchedulerFixture('session-worker-providers-')
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'session-worker-provider-workspace-'))
  const provider = await startOpenAiResponsesFixture()
  const previousApiKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  process.env.OPENAI_API_KEY = 'detached-worker-provider-key'
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`
  delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN

  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: 'detached-provider-registration-test',
  })
  let task: SessionTask | undefined
  try {
    const session = await store.createSession({ title: 'Detached provider registration' })
    const launched = await launchSessionTask({
      sessionId: session.id,
      sessionStore: store,
      taskLauncher: new SessionTaskRunnerLauncher(process.cwd()),
      repoRootPath: fixture.repoRootPath,
      workspacePath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
      workflowId: fixture.workflowId,
      briefMarkdown: '# Task Brief\n\nConfirm detached provider registration.\n',
      startupTimeoutMs: 5_000,
    })
    assert.equal(
      launched.ok,
      true,
      launched.ok
        ? undefined
        : ('detail' in launched ? launched.detail : launched.error),
    )
    if (!launched.ok) return

    task = launched.task
    task = await waitForTerminalTask(store, session.id, launched.task.id)
    assert.equal(task.status, 'done', task.error)
    assert.equal(provider.requestCount(), 1)
    assert.ok(task.assignmentPath)
    if (task.pid) {
      await waitForProcessStop(
        process.platform === 'win32'
          ? task.pid
          : -(task.processGroupId ?? task.pid),
      )
    }
    assert.match(
      fs.readFileSync(
        path.join(task.assignmentPath, `workflow-${fixture.workflowId}-result.md`),
        'utf8',
      ),
      /Detached worker provider ready/,
    )
  } finally {
    if (task?.pid) {
      const target = process.platform === 'win32'
        ? task.pid
        : -(task.processGroupId ?? task.pid)
      if (task.status !== 'done' && task.status !== 'failed') {
        try {
          process.kill(target, 'SIGKILL')
        } catch {
          // The worker may have exited between the terminal check and cleanup.
        }
      }
      await waitForProcessStop(target)
    }
    restoreEnvironment('OPENAI_API_KEY', previousApiKey)
    restoreEnvironment('OPENAI_BASE_URL', previousBaseUrl)
    restoreEnvironment('TEAM_RUNTIME_TASK_RUNNER_DRY_RUN', previousDryRun)
    await provider.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('scheduled agent runs create and publish a semantic artifact filename', async () => {
  const fixture = createSchedulerFixture('scheduled-agent-named-artifact-')
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scheduled-agent-named-artifact-workspace-'),
  )
  const provider = await startOpenAiResponsesFixture()
  const previousApiKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  process.env.OPENAI_API_KEY = 'detached-worker-provider-key'
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`
  // The title helper owns no agent, so it runs on the deliberate application
  // default and on nothing else. Published here rather than through a separate
  // title endpoint, because a second model source is what was removed. The
  // detached worker inherits it through the environment.
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'openai',
    model: TITLE_MODEL,
  })
  delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN

  const store = new FileSystemSessionStore(workspacePath, {
    instanceId: 'scheduled-agent-named-artifact-test',
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
  const firedAt = new Date('2026-07-20T18:42:07.321Z')
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
    now: () => firedAt,
  })
  let task: SessionTask | undefined
  try {
    await taskQueue.initialize()
    await scheduleService.initialize()
    const schedule = await scheduleService.create({
      name: 'Named scheduled result',
      kind: 'agent',
      target: fixture.agentName,
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

    assert.equal(provider.titleRequestCount(), 1)
    assert.equal(provider.requestCount(), 1)
    assert.ok(task.workflowSnapshotPath)
    assert.match(
      fs.readFileSync(task.workflowSnapshotPath, 'utf8'),
      /result_artifact: detached-worker-provider-report\.md/,
    )

    const deliveryMessage = (await store.listChatMessages(launched.sessionId))
      .find((message) => message.delivery)
    const artifact = deliveryMessage?.delivery?.artifacts[0]
    assert.equal(artifact?.path, 'detached-worker-provider-report.md')
    assert.ok(artifact)
    const storedArtifact = await new FileSystemRunStore(workspacePath).readArtifact(
      artifact.runId,
      artifact.path,
    )
    assert.ok(storedArtifact)
    assert.equal(typeof storedArtifact.content, 'string')
    assert.match(String(storedArtifact.content), /Detached worker provider ready/)
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
  timeoutMs = 10_000,
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

async function waitForProcessStop(target: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (defaultIsProcessAlive(target) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(defaultIsProcessAlive(target), false)
}

async function startOpenAiResponsesFixture(): Promise<{
  url: string
  requestCount(): number
  titleRequestCount(): number
  close(): Promise<void>
}> {
  let requests = 0
  let titleRequests = 0
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== 'Bearer detached-worker-provider-key') {
      response.writeHead(404).end('not found')
      return
    }
    if (request.url !== '/v1/responses') {
      response.writeHead(404).end('not found')
      return
    }
    // Both the worker and the title helper reach the same adapter now: the
    // helper runs on the one application default rather than through a
    // separate endpoint of its own. They are told apart by the model each
    // names, which is the only thing that actually distinguishes them.
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      let model = ''
      try {
        model = String(
          (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown })
            .model ?? '',
        )
      } catch {
        model = ''
      }
      if (model === TITLE_MODEL) {
        titleRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          model: TITLE_MODEL,
          output_text: 'Detached Worker Provider Report',
          usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 },
        }))
        return
      }
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model: 'gpt-5-mini',
        output_text: '# Result\n\nDetached worker provider ready.\n',
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Provider fixture did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    titleRequestCount: () => titleRequests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

/** The application default this fixture publishes, for the title helper. */
const TITLE_MODEL = 'gpt-title-fixture'

initProviders()

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
