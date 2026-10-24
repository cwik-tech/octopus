import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import type { SessionTask } from '../../contracts/sessions.js'
import {
  defaultIsProcessAlive,
  taskProcessTarget,
} from '../../domains/sessions/task-process-supervisor.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-real-api-'))
}

test('real API and workers enforce live limits and drain five tasks in durable FIFO order', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  const previousDelay = process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
  const previousMaximum = process.env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = '1'
  process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = '4000'
  delete process.env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS
  const realLauncher = new SessionTaskRunnerLauncher(process.cwd())
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: realLauncher,
    taskLauncher: realLauncher,
    sessionStore,
    workspacePath,
    repoRootPath: process.cwd(),
    workflowsRegistryPath: path.join(process.cwd(), 'workflows', 'registry.yaml'),
  })
  const accepted: SessionTask[] = []
  const observedProcessTargets = new Set<number>()

  try {
    const initialSettings = await fetch(`${server.url}/settings/scheduling`)
    assert.equal(initialSettings.status, 200)
    assert.equal(
      ((await initialSettings.json()) as { maximumConcurrentTasks: number })
        .maximumConcurrentTasks,
      3,
    )

    for (let index = 0; index < 5; index += 1) {
      const createdSession = await fetch(`${server.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Real queue task ${index + 1}` }),
      })
      assert.equal(createdSession.status, 201)
      const session = (await createdSession.json()) as { id: string }
      const response = await fetch(`${server.url}/sessions/${session.id}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'discussion-to-writing3',
          brief:
            `Analyze queue acceptance scenario ${index + 1} for an engineering audience and produce a concise technical decision memo with risks, recommendation, and success criteria.`,
        }),
      })
      const payload = await response.json()
      assert.equal(response.status, 202, JSON.stringify(payload))
      accepted.push(payload as SessionTask)
    }

    await waitFor(async () => {
      const tasks = await readAcceptedTasks(sessionStore, accepted)
      return tasks.slice(0, 3).every((task) =>
        task.admission?.phase === 'granted' && hasLiveWorker(task)
      ) && tasks.slice(3).every((task) =>
        task.admission?.phase === 'pending' &&
        task.pid === undefined &&
        task.processGroupId === undefined
      )
    }, 'three live real workers and two pending admissions')

    let current = await readAcceptedTasks(sessionStore, accepted)
    assert.deepEqual(
      current.map((task) => task.admission?.phase),
      ['granted', 'granted', 'granted', 'pending', 'pending'],
    )
    const firstWavePids = current.slice(0, 3).map((task) => task.pid)
    const firstWaveProcessGroups = current
      .slice(0, 3)
      .map((task) => task.processGroupId)
    assert.equal(new Set(firstWavePids).size, 3)
    assert.equal(new Set(firstWaveProcessGroups).size, 3)
    assert.ok(firstWavePids.every((pid) => typeof pid === 'number' && pid > 0))
    assert.ok(
      firstWaveProcessGroups.every(
        (processGroupId) => typeof processGroupId === 'number' && processGroupId > 0,
      ),
    )
    assert.deepEqual(firstWavePids, firstWaveProcessGroups)
    for (const task of current.slice(0, 3)) {
      const target = taskProcessTarget(task)
      assert.notEqual(target, null)
      observedProcessTargets.add(target!)
      assert.equal(defaultIsProcessAlive(target!), true)
    }
    assert.equal(current[3]?.pid, undefined)
    assert.equal(current[4]?.pid, undefined)
    assert.ok(current[3]?.admission && current[4]?.admission)
    assert.ok(
      BigInt(current[3]!.admission!.order) < BigInt(current[4]!.admission!.order),
      'the fourth task must have an earlier durable queue order than the fifth',
    )

    const lowered = await updateMaximumConcurrentTasks(server.url, 1)
    assert.equal(lowered.maximumConcurrentTasks, 1)
    assert.equal(lowered.source, 'persisted')
    current = await readAcceptedTasks(sessionStore, accepted)
    assert.deepEqual(
      current.map((task) => task.admission?.phase),
      ['granted', 'granted', 'granted', 'pending', 'pending'],
      'lowering the limit must not evict already granted workers',
    )

    // The first wave exits normally after the dry-run startup delay. Once all
    // three grants release, the live limit of one may admit only task four.
    await waitFor(async () => {
      const tasks = await readAcceptedTasks(sessionStore, accepted)
      return tasks.slice(0, 3).every((task) =>
        task.status === 'done' && !hasLiveWorker(task)
      ) && tasks[3]?.admission?.phase === 'granted' &&
        hasLiveWorker(tasks[3]) &&
        tasks[4]?.admission?.phase === 'pending' &&
        tasks[4]?.pid === undefined
    }, 'natural completion to release one live FIFO slot', 12_000)

    current = await readAcceptedTasks(sessionStore, accepted)
    assert.deepEqual(
      current.slice(0, 3).map((task) => task.status),
      ['done', 'done', 'done'],
    )
    assert.equal(current[3]?.admission?.phase, 'granted')
    assert.equal(current[4]?.admission?.phase, 'pending')
    const fourthAdmission = current[3]?.admission
    assert.equal(fourthAdmission?.phase, 'granted')
    assert.equal(typeof fourthAdmission.grantedAt, 'string')
    const fourthGrantTime = Date.parse(fourthAdmission.grantedAt)
    const fourthTarget = taskProcessTarget(current[3]!)
    assert.notEqual(fourthTarget, null)
    observedProcessTargets.add(fourthTarget!)

    const raised = await updateMaximumConcurrentTasks(server.url, 3)
    assert.equal(raised.maximumConcurrentTasks, 3)
    assert.equal(raised.source, 'persisted')
    await waitFor(async () => {
      const fifth = await sessionStore.getTaskRecord(
        accepted[4]!.sessionId,
        accepted[4]!.id,
      )
      return fifth?.admission?.phase === 'granted' && hasLiveWorker(fifth)
    }, 'raising the live limit to drain the fifth task')

    current = await readAcceptedTasks(sessionStore, accepted)
    const fifthAdmission = current[4]?.admission
    assert.equal(fifthAdmission?.phase, 'granted')
    assert.equal(typeof fifthAdmission.grantedAt, 'string')
    assert.ok(
      fourthGrantTime <= Date.parse(fifthAdmission.grantedAt),
      'FIFO task four must be granted before task five',
    )
    const fifthTarget = taskProcessTarget(current[4]!)
    assert.notEqual(fifthTarget, null)
    observedProcessTargets.add(fifthTarget!)
    assert.equal(defaultIsProcessAlive(fifthTarget!), true)

    const persistedSettings = await fetch(`${server.url}/settings/scheduling`)
    assert.equal(persistedSettings.status, 200)
    assert.equal(
      ((await persistedSettings.json()) as { maximumConcurrentTasks: number })
        .maximumConcurrentTasks,
      3,
    )
  } finally {
    for (const task of accepted) {
      const current = await sessionStore.getTaskRecord(task.sessionId, task.id)
      if (
        current &&
        current.status !== 'done' &&
        current.status !== 'failed' &&
        current.status !== 'blocked' &&
        current.status !== 'cancelled'
      ) {
        await fetch(`${server.url}/sessions/${task.sessionId}/tasks/${task.id}`, {
          method: 'DELETE',
        }).catch(() => undefined)
      }
    }
    await server.close()
    await waitFor(
      () => [...observedProcessTargets].every((target) => !defaultIsProcessAlive(target)),
      'all real worker process groups to stop',
    ).catch(() => {
      for (const target of observedProcessTargets) {
        if (!defaultIsProcessAlive(target)) continue
        try {
          process.kill(target, 'SIGKILL')
        } catch {
          // Best-effort cleanup after a failed assertion.
        }
      }
    })
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    if (previousDelay === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = previousDelay
    }
    if (previousMaximum === undefined) {
      delete process.env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS
    } else {
      process.env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS = previousMaximum
    }
    fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('failed settings persistence leaves the live cap unchanged for real workers', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  const previousDelay = process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
  const previousMaximum = process.env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = '1'
  process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = '6000'
  delete process.env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS
  const realLauncher = new SessionTaskRunnerLauncher(process.cwd())
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: realLauncher,
    taskLauncher: realLauncher,
    sessionStore,
    workspacePath,
    repoRootPath: process.cwd(),
    workflowsRegistryPath: path.join(process.cwd(), 'workflows', 'registry.yaml'),
  })
  const accepted: SessionTask[] = []
  const observedProcessTargets = new Set<number>()

  try {
    const saved = await updateMaximumConcurrentTasks(server.url, 2)
    assert.equal(saved.maximumConcurrentTasks, 2)
    const settingsPath = path.join(workspacePath, 'task-queue', 'settings.json')
    const preservedSettingsPath = path.join(
      workspacePath,
      'task-queue',
      'settings-before-failure.json',
    )
    fs.renameSync(settingsPath, preservedSettingsPath)
    fs.mkdirSync(settingsPath)

    const failedResponse = await fetch(`${server.url}/settings/scheduling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumConcurrentTasks: 4 }),
    })
    assert.equal(failedResponse.status, 500)
    assert.deepEqual(await failedResponse.json(), {
      error: 'Scheduling settings could not be persisted.',
      code: 'settings_persistence_failed',
      retryable: true,
    })
    assert.deepEqual(JSON.parse(fs.readFileSync(preservedSettingsPath, 'utf8')), {
      version: 1,
      maximumConcurrentTasks: 2,
    })
    const snapshotResponse = await fetch(`${server.url}/settings/scheduling`)
    assert.equal(snapshotResponse.status, 200)
    assert.equal(
      ((await snapshotResponse.json()) as { maximumConcurrentTasks: number })
        .maximumConcurrentTasks,
      2,
    )

    for (let index = 0; index < 3; index += 1) {
      const createdSession = await fetch(`${server.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Persistence failure task ${index + 1}` }),
      })
      assert.equal(createdSession.status, 201)
      const session = (await createdSession.json()) as { id: string }
      const response = await fetch(`${server.url}/sessions/${session.id}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'discussion-to-writing3',
          brief:
            `Verify failed scheduling persistence for task ${index + 1} with a concrete engineering memo, risks, decision, and acceptance criteria.`,
        }),
      })
      const payload = await response.json()
      assert.equal(response.status, 202, JSON.stringify(payload))
      accepted.push(payload as SessionTask)
    }

    await waitFor(async () => {
      const tasks = await readAcceptedTasks(sessionStore, accepted)
      return tasks.slice(0, 2).every((task) =>
        task.admission?.phase === 'granted' && hasLiveWorker(task)
      ) && tasks[2]?.admission?.phase === 'pending' &&
        tasks[2]?.pid === undefined &&
        tasks[2]?.processGroupId === undefined
    }, 'the unchanged live cap of two real workers')

    const current = await readAcceptedTasks(sessionStore, accepted)
    assert.deepEqual(
      current.map((task) => task.admission?.phase),
      ['granted', 'granted', 'pending'],
    )
    for (const task of current.slice(0, 2)) {
      const target = taskProcessTarget(task)
      assert.notEqual(target, null)
      observedProcessTargets.add(target!)
      assert.equal(defaultIsProcessAlive(target!), true)
    }
  } finally {
    for (const task of accepted) {
      const current = await sessionStore.getTaskRecord(task.sessionId, task.id)
      if (
        current &&
        current.status !== 'done' &&
        current.status !== 'failed' &&
        current.status !== 'blocked' &&
        current.status !== 'cancelled'
      ) {
        await fetch(`${server.url}/sessions/${task.sessionId}/tasks/${task.id}`, {
          method: 'DELETE',
        }).catch(() => undefined)
      }
    }
    await server.close()
    await waitFor(
      () => [...observedProcessTargets].every((target) => !defaultIsProcessAlive(target)),
      'persistence-test worker process groups to stop',
    ).catch(() => {
      for (const target of observedProcessTargets) {
        if (!defaultIsProcessAlive(target)) continue
        try {
          process.kill(target, 'SIGKILL')
        } catch {
          // Best-effort cleanup after a failed assertion.
        }
      }
    })
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    if (previousDelay === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS = previousDelay
    }
    if (previousMaximum === undefined) {
      delete process.env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS
    } else {
      process.env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS = previousMaximum
    }
    fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 5 })
  }
})

async function updateMaximumConcurrentTasks(
  serverUrl: string,
  maximumConcurrentTasks: number,
): Promise<{ maximumConcurrentTasks: number; source: string }> {
  const response = await fetch(`${serverUrl}/settings/scheduling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maximumConcurrentTasks }),
  })
  const payload = await response.json()
  assert.equal(response.status, 200, JSON.stringify(payload))
  return payload as { maximumConcurrentTasks: number; source: string }
}

function hasLiveWorker(task: SessionTask | undefined): boolean {
  if (!task) return false
  const target = taskProcessTarget(task)
  return target !== null && defaultIsProcessAlive(target)
}

async function readAcceptedTasks(
  store: FileSystemSessionStore,
  tasks: readonly SessionTask[],
): Promise<SessionTask[]> {
  return Promise.all(tasks.map(async (task) => {
    const current = await store.getTaskRecord(task.sessionId, task.id)
    assert.ok(current)
    return current
  }))
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
