import assert from 'node:assert/strict'
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { SessionTask } from '../../contracts/sessions.js'
import {
  defaultIsProcessAlive,
  taskProcessTarget,
} from '../../domains/sessions/task-process-supervisor.js'
import {
  TASK_QUEUE_CONTROL_DIRECTORY,
  TASK_QUEUE_OWNER_FILENAME,
} from '../../core/workspace-dispatcher-owner.js'

interface ApiFixtureMessage {
  type: 'ready' | 'error'
  pid: number
  url?: string
  name?: string
  code?: string
  message?: string
}

interface ApiFixtureProcess {
  child: ChildProcessWithoutNullStreams
  stderr: string[]
}

interface WorkspaceOwnerRecord {
  pid: number
  epoch: string
}

test(
  'API SIGKILL preserves a real running worker and restart drains pending FIFO',
  { timeout: 35_000, skip: process.platform === 'win32' },
  async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'task-queue-api-crash-'),
    )
    const controlDirectory = path.join(
      workspacePath,
      TASK_QUEUE_CONTROL_DIRECTORY,
    )
    fs.mkdirSync(controlDirectory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(controlDirectory, 'settings.json'),
      `${JSON.stringify({ version: 1, maximumConcurrentTasks: 1 }, null, 2)}\n`,
      { mode: 0o600 },
    )
    const store = new FileSystemSessionStore(workspacePath)
    const fixtures: ApiFixtureProcess[] = []
    const workerTargets = new Set<number>()

    try {
      const firstApi = spawnApiFixture(workspacePath)
      fixtures.push(firstApi)
      const firstReady = await readFixtureMessage(firstApi)
      assert.equal(firstReady.type, 'ready')
      assert.ok(firstReady.url)
      const firstOwner = readOwnerRecord(workspacePath)
      assert.equal(firstOwner.pid, firstApi.child.pid)

      const firstTask = await createTask(
        firstReady.url,
        'Crash survivor',
        'Create a precise engineering decision memo about durable queue recovery, including risks, invariants, restart behavior, and acceptance criteria.',
      )
      const attachedFirst = await waitForTask(
        store,
        firstTask,
        (task) =>
          task.status === 'queued' &&
          task.admission?.phase === 'granted' &&
          typeof task.pid === 'number' &&
          typeof task.processGroupId === 'number' &&
          defaultIsProcessAlive(taskProcessTarget(task)!),
        'the first real worker to be granted and attached',
      )
      const firstTarget = taskProcessTarget(attachedFirst)
      assert.notEqual(firstTarget, null)
      workerTargets.add(firstTarget!)
      const pauseAtRunning = pauseWorkerAtDurableRunning(store, firstTask)

      const secondTask = await createTask(
        firstReady.url,
        'Pending FIFO successor',
        'Create a follow-up technical memo that evaluates the recovered queue outcome for platform engineers and lists operational success measures.',
      )
      const pendingBeforeCrash = await waitForTask(
        store,
        secondTask,
        (task) =>
          task.admission?.phase === 'pending' &&
          task.pid === undefined &&
          task.processGroupId === undefined,
        'the second task to remain pending at cap one',
      )
      const pausedFirst = await pauseAtRunning
      assert.equal(pausedFirst.status, 'running')
      assert.equal(defaultIsProcessAlive(firstTarget!), true)
      const firstAdmission = pausedFirst.admission
      const pendingAdmission = pendingBeforeCrash.admission
      assert.equal(firstAdmission?.phase, 'granted')
      assert.equal(pendingAdmission?.phase, 'pending')
      assert.ok(BigInt(firstAdmission.order) < BigInt(pendingAdmission.order))

      assert.equal(firstApi.child.kill('SIGKILL'), true)
      const firstExit = await waitForExit(firstApi)
      assert.equal(firstExit.code, null)
      assert.equal(firstExit.signal, 'SIGKILL')
      assert.equal(defaultIsProcessAlive(firstTarget!), true)

      const secondApi = spawnApiFixture(workspacePath)
      fixtures.push(secondApi)
      const secondReady = await readFixtureMessage(secondApi, 15_000)
      assert.equal(secondReady.type, 'ready')
      assert.ok(secondReady.url)
      const secondOwner = readOwnerRecord(workspacePath)
      assert.equal(secondOwner.pid, secondApi.child.pid)
      assert.notEqual(secondOwner.epoch, firstOwner.epoch)

      const adoptedFirst = await store.getTaskRecord(
        firstTask.sessionId,
        firstTask.id,
      )
      const preservedPending = await store.getTaskRecord(
        secondTask.sessionId,
        secondTask.id,
      )
      assert.equal(adoptedFirst?.status, 'running')
      assert.equal(adoptedFirst?.pid, pausedFirst.pid)
      assert.equal(adoptedFirst?.processGroupId, pausedFirst.processGroupId)
      assert.equal(adoptedFirst?.executionAttemptId, pausedFirst.executionAttemptId)
      assert.equal(adoptedFirst?.admission?.phase, 'granted')
      assert.equal(adoptedFirst?.admission?.requestId, firstAdmission.requestId)
      assert.equal(adoptedFirst?.admission?.grantId, firstAdmission.grantId)
      assert.equal(adoptedFirst?.admission?.ownerEpoch, firstOwner.epoch)
      assert.equal(defaultIsProcessAlive(firstTarget!), true)
      assert.equal(preservedPending?.admission?.phase, 'pending')
      assert.equal(preservedPending?.admission?.requestId, pendingAdmission.requestId)
      assert.equal(preservedPending?.admission?.order, pendingAdmission.order)
      assert.equal(preservedPending?.pid, undefined)

      await new Promise<void>((resolve) => setTimeout(resolve, 250))
      const stillPending = await store.getTaskRecord(secondTask.sessionId, secondTask.id)
      assert.equal(stillPending?.admission?.phase, 'pending')
      assert.equal(stillPending?.pid, undefined)

      const pauseDrainedAtRunning = pauseWorkerAtDurableRunning(
        store,
        secondTask,
        18_000,
      )
      process.kill(firstTarget!, 'SIGCONT')
      const drained = await pauseDrainedAtRunning
      const completedFirst = await store.getTaskRecord(
        firstTask.sessionId,
        firstTask.id,
      )
      assert.equal(completedFirst?.status, 'done')
      assert.equal(completedFirst?.admission, undefined)
      assert.equal(defaultIsProcessAlive(firstTarget!), false)
      assert.equal(drained.admission?.phase, 'granted')
      assert.equal(drained.admission.order, pendingAdmission.order)
      assert.equal(drained.admission.requestId, pendingAdmission.requestId)
      assert.equal(drained.admission.ownerEpoch, secondOwner.epoch)
      const secondTarget = taskProcessTarget(drained)
      assert.notEqual(secondTarget, null)
      workerTargets.add(secondTarget!)

      const cancelled = await fetch(
        `${secondReady.url}/sessions/${secondTask.sessionId}/tasks/${secondTask.id}`,
        { method: 'DELETE' },
      )
      const cancelledPayload = await cancelled.json() as SessionTask | { error: string }
      assert.equal(cancelled.status, 200, JSON.stringify(cancelledPayload))
      assert.equal((cancelledPayload as SessionTask).status, 'cancelled')
      await waitFor(
        () => !defaultIsProcessAlive(secondTarget!),
        'the drained worker process group to stop after cancellation',
      )

      secondApi.child.stdin.end('close\n')
      const secondExit = await waitForExit(secondApi)
      assert.equal(secondExit.code, 0, secondApi.stderr.join(''))
      assert.equal(secondExit.signal, null)
    } finally {
      for (const fixture of fixtures) {
        if (
          fixture.child.exitCode === null &&
          fixture.child.signalCode === null
        ) {
          fixture.child.kill('SIGKILL')
        }
      }
      for (const target of workerTargets) {
        if (!defaultIsProcessAlive(target)) continue
        try {
          process.kill(target, 'SIGCONT')
          process.kill(target, 'SIGKILL')
        } catch {
          // Best-effort cleanup after a failed assertion.
        }
      }
      await Promise.all(
        fixtures.map((fixture) => waitForExit(fixture, 5_000).catch(() => undefined)),
      )
      fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5 })
    }
  },
)

function spawnApiFixture(workspacePath: string): ApiFixtureProcess {
  const fixturePath = path.resolve(
    process.cwd(),
    'tests',
    'fixtures',
    'task-queue-crash-api-child.ts',
  )
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fixturePath, workspacePath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEAM_RUNTIME_TASK_RUNNER_DRY_RUN: '1',
        TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS: '4000',
        TEAM_RUNTIME_MAX_CONCURRENT_TASKS: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  return { child, stderr }
}

async function createTask(
  baseUrl: string,
  title: string,
  brief: string,
): Promise<SessionTask> {
  const sessionResponse = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const session = await sessionResponse.json() as { id: string }
  assert.equal(sessionResponse.status, 201)
  const taskResponse = await fetch(`${baseUrl}/sessions/${session.id}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workflowId: 'discussion-to-writing3',
      brief,
    }),
  })
  const task = await taskResponse.json()
  assert.equal(taskResponse.status, 202, JSON.stringify(task))
  return task as SessionTask
}

function pauseWorkerAtDurableRunning(
  store: FileSystemSessionStore,
  task: Pick<SessionTask, 'sessionId' | 'id'>,
  timeoutMs = 10_000,
): Promise<SessionTask> {
  const taskDirectory = store.taskDir(task.sessionId, task.id)
  const taskPath = path.join(taskDirectory, 'task.json')
  const taskLockPath = path.join(taskDirectory, '.task.lock')
  return new Promise<SessionTask>((resolve, reject) => {
    let settled = false
    let inspecting = false
    const watcher = fs.watch(taskDirectory, () => inspect())
    const interval = setInterval(inspect, 2)
    const timeout = setTimeout(() => {
      finish()
      reject(new Error('Timed out pausing the real worker at durable running state'))
    }, timeoutMs)
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(interval)
      watcher.close()
    }
    function inspect(): void {
      if (settled || inspecting) return
      inspecting = true
      try {
        const current = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as SessionTask
        if (current.status !== 'running') return
        const target = taskProcessTarget(current)
        if (target === null || !defaultIsProcessAlive(target)) return
        if (fs.existsSync(taskLockPath)) return
        process.kill(target, 'SIGSTOP')
        finish()
        resolve(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          finish()
          reject(error)
        }
      } finally {
        inspecting = false
      }
    }
    inspect()
  })
}

async function waitForTask(
  store: FileSystemSessionStore,
  task: Pick<SessionTask, 'sessionId' | 'id'>,
  predicate: (task: SessionTask) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<SessionTask> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await store.getTaskRecord(task.sessionId, task.id)
    if (current && predicate(current)) return current
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function readFixtureMessage(
  fixture: ApiFixtureProcess,
  timeoutMs = 10_000,
): Promise<ApiFixtureMessage> {
  const { child, stderr } = fixture
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(
        `Timed out waiting for API fixture ${child.pid}: ${stderr.join('')}`,
      ))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onEarlyExit)
    }
    const onData = (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as ApiFixtureMessage)
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(
        `API fixture exited before ready (${code ?? signal}): ${stderr.join('')}`,
      ))
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onEarlyExit)
  })
}

function waitForExit(
  fixture: ApiFixtureProcess,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const { child, stderr } = fixture
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(
        `Timed out waiting for API fixture ${child.pid}: ${stderr.join('')}`,
      ))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      resolve({ code, signal })
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function readOwnerRecord(workspacePath: string): WorkspaceOwnerRecord {
  const record = JSON.parse(fs.readFileSync(path.join(
    workspacePath,
    TASK_QUEUE_CONTROL_DIRECTORY,
    TASK_QUEUE_OWNER_FILENAME,
  ), 'utf8')) as WorkspaceOwnerRecord
  assert.equal(typeof record.pid, 'number')
  assert.equal(typeof record.epoch, 'string')
  return record
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
