import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import {
  mirrorRepositoryWithoutFrontDoor,
  removeMirroredRepository,
} from '../helpers/repository-mirror.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import {
  MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE,
} from '../../domains/scheduling/scheduling-settings.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SchedulingSettingsServiceError } from '../../services/scheduling-settings-service.js'
import { TASK_QUEUE_EVENT_FILENAME } from '../../core/task-queue-events.js'
import {
  TASK_QUEUE_CONTROL_DIRECTORY,
  TASK_QUEUE_OWNER_FILENAME,
  WorkspaceDispatcherOwnerError,
} from '../../core/workspace-dispatcher-owner.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-api-'))
}

function launcher(counter: { calls: number }) {
  return {
    async startRun(request: { cwd: string }) {
      counter.calls += 1
      return { launched: true as const, pid: process.pid, cwd: request.cwd }
    },
  }
}

async function withStructuredModelResponse(
  content: string,
  fn: () => Promise<void>,
): Promise<void> {
  let calls = 0
  const provider = createServer((_req, res) => {
    calls += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      model: 'queue-readiness-model',
      choices: [{ message: { content } }],
    }))
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address() as AddressInfo
  const previousKey = process.env.DEEPSEEK_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
  process.env.DEEPSEEK_API_KEY = 'test-key'
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL =
    `http://127.0.0.1:${address.port}/chat/completions`
  try {
    await fn()
    assert.equal(calls, 1)
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
    if (previousUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
    } else {
      process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = previousUrl
    }
    await new Promise<void>((resolve, reject) => {
      provider.close((error) => error ? reject(error) : resolve())
    })
  }
}

function readQueueEvents(workspacePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(
    path.join(
      workspacePath,
      TASK_QUEUE_CONTROL_DIRECTORY,
      TASK_QUEUE_EVENT_FILENAME,
    ),
    'utf8',
  ).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('full session API exposes durable live scheduling settings and closes ownership cleanly', async () => {
  const workspacePath = makeWorkspace()
  const directLauncher = { calls: 0 }
  const start = () => startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: launcher(directLauncher),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
  })
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined

  try {
    server = await start()
    const initialResponse = await fetch(`${server.url}/settings/scheduling`)
    assert.equal(initialResponse.status, 200)
    assert.deepEqual(await initialResponse.json(), {
      maximumConcurrentTasks: 3,
      constraints: { minimum: 1, maximum: 64 },
      source: 'default',
      editable: true,
    })

    const explicitDefaultResponse = await fetch(`${server.url}/settings/scheduling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumConcurrentTasks: 3 }),
    })
    assert.equal(explicitDefaultResponse.status, 200)
    assert.deepEqual(await explicitDefaultResponse.json(), {
      maximumConcurrentTasks: 3,
      constraints: { minimum: 1, maximum: 64 },
      source: 'persisted',
      editable: true,
    })
    const settingsPath = path.join(workspacePath, 'task-queue', 'settings.json')
    const explicitDefaultInode = fs.statSync(settingsPath).ino

    const sameValueResponse = await fetch(`${server.url}/settings/scheduling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumConcurrentTasks: 3 }),
    })
    assert.equal(sameValueResponse.status, 200)
    assert.deepEqual(await sameValueResponse.json(), {
      maximumConcurrentTasks: 3,
      constraints: { minimum: 1, maximum: 64 },
      source: 'persisted',
      editable: true,
    })
    assert.equal(fs.statSync(settingsPath).ino, explicitDefaultInode)

    const patchResponse = await fetch(`${server.url}/settings/scheduling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumConcurrentTasks: 2 }),
    })
    assert.equal(patchResponse.status, 200)
    assert.deepEqual(await patchResponse.json(), {
      maximumConcurrentTasks: 2,
      constraints: { minimum: 1, maximum: 64 },
      source: 'persisted',
      editable: true,
    })
    const persisted = JSON.parse(fs.readFileSync(
      settingsPath,
      'utf8',
    )) as { version: number; maximumConcurrentTasks: number }
    assert.deepEqual(persisted, { version: 1, maximumConcurrentTasks: 2 })
    assert.equal(
      fs.statSync(settingsPath).mode & 0o777,
      0o600,
    )

    await assert.rejects(start(), (error: unknown) => {
      assert.ok(error instanceof WorkspaceDispatcherOwnerError)
      assert.equal(error.code, 'workspace_in_use')
      return true
    })

    await server.close()
    server = undefined
    const restarted = await start()
    try {
      const response = await fetch(`${restarted.url}/settings/scheduling`)
      assert.equal(response.status, 200)
      assert.equal(
        ((await response.json()) as { maximumConcurrentTasks: number })
          .maximumConcurrentTasks,
        2,
      )
    } finally {
      await restarted.close()
    }
  } finally {
    await server?.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('invalid environment and persisted settings fail full API startup without leaking ownership', async () => {
  const workspacePath = makeWorkspace()
  const calls = { calls: 0 }
  const previousMaximum = process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE]
  const ownerPath = path.join(
    workspacePath,
    TASK_QUEUE_CONTROL_DIRECTORY,
    TASK_QUEUE_OWNER_FILENAME,
  )
  const start = () => startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: launcher(calls),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
  })

  try {
    process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE] = '0'
    await assert.rejects(start(), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /TEAM_RUNTIME_MAX_CONCURRENT_TASKS/)
      return true
    })
    assert.equal(fs.existsSync(ownerPath), false)

    delete process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE]
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true })
    fs.writeFileSync(
      path.join(workspacePath, 'task-queue', 'settings.json'),
      JSON.stringify({ version: 2, maximumConcurrentTasks: 3 }),
    )
    await assert.rejects(start(), (error: unknown) => {
      assert.ok(error instanceof SchedulingSettingsServiceError)
      assert.equal(error.code, 'configuration_invalid')
      return true
    })
    assert.equal(fs.existsSync(ownerPath), false)
    assert.equal(calls.calls, 0)
  } finally {
    if (previousMaximum === undefined) {
      delete process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE]
    } else {
      process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE] = previousMaximum
    }
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('concurrent HTTP limit updates leave file, snapshot, and queue event order consistent', async () => {
  const workspacePath = makeWorkspace()
  const calls = { calls: 0 }
  const previousMaximum = process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE]
  delete process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE]
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: launcher(calls),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
  })

  try {
    const requestedValues = [4, 6, 2, 5]
    const results = await Promise.all(requestedValues.map(async (maximumConcurrentTasks) => {
      const response = await fetch(`${server.url}/settings/scheduling`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maximumConcurrentTasks }),
      })
      const payload = await response.json() as {
        maximumConcurrentTasks: number
        source: string
      }
      assert.equal(response.status, 200)
      assert.equal(payload.maximumConcurrentTasks, maximumConcurrentTasks)
      assert.equal(payload.source, 'persisted')
      return payload
    }))
    assert.equal(results.length, requestedValues.length)

    const limitEvents = readQueueEvents(workspacePath).filter(
      (event) => event.event === 'task_queue.limit_updated',
    )
    assert.equal(limitEvents.length, requestedValues.length)
    assert.deepEqual(
      new Set(limitEvents.map((event) => event.maximum_concurrent_tasks)),
      new Set(requestedValues),
    )
    const lastLinearizedValue = limitEvents.at(-1)?.maximum_concurrent_tasks
    assert.equal(typeof lastLinearizedValue, 'number')

    const snapshotResponse = await fetch(`${server.url}/settings/scheduling`)
    assert.equal(snapshotResponse.status, 200)
    const snapshot = await snapshotResponse.json() as {
      maximumConcurrentTasks: number
      source: string
    }
    assert.equal(snapshot.maximumConcurrentTasks, lastLinearizedValue)
    assert.equal(snapshot.source, 'persisted')
    assert.equal(
      JSON.parse(fs.readFileSync(
        path.join(workspacePath, 'task-queue', 'settings.json'),
        'utf8',
      )).maximumConcurrentTasks,
      lastLinearizedValue,
    )
  } finally {
    await server.close()
    if (previousMaximum === undefined) {
      delete process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE]
    } else {
      process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE] = previousMaximum
    }
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('conversational start language leaves a ready plan while task admission is recovering', async () => {
  const workspacePath = makeWorkspace()
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Conversational readiness' })
  // This case scripts one Run Coordinator decision and asserts it was used, and
  // an untargeted turn is the only way the endpoint reaches the Coordinator.
  // The repository's own workflows are what the launch is checked against, so
  // the mirror keeps everything except the front door.
  const repoRootPath = mirrorRepositoryWithoutFrontDoor('task-queue-repo-')
  const calls = { calls: 0 }
  let observedStatus = 0
  let observedRetryAfter: string | null = null
  let observedBody: unknown

  try {
    await withStructuredModelResponse(
      JSON.stringify({
        message: 'The selected workflow is approved for execution.',
        selectionAction: 'select',
        workflowId: 'discussion-to-writing3',
        launchIntent: 'start',
        deepResearchPlanAction: 'keep',
      }),
      async () => {
        const server = await startApiServer({
          store: new FileSystemRunStore(workspacePath),
          launcher: launcher(calls),
          sessionStore,
          workspacePath,
          repoRootPath,
          workflowsRegistryPath: path.join(repoRootPath, 'workflows', 'registry.yaml'),
          onListening: async ({ url }) => {
            const response = await fetch(`${url}/sessions/${session.id}/messages`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                text:
                  'Create a concise technical decision memo for engineering leaders, covering queue risks, implementation constraints, and measurable success criteria. Start it now.',
                provider: 'deepseek',
                model: 'queue-readiness-model',
              }),
            })
            observedStatus = response.status
            observedRetryAfter = response.headers.get('retry-after')
            observedBody = await response.json()
          },
        })
        await server.close()
      },
    )

    assert.equal(observedStatus, 201)
    assert.equal(observedRetryAfter, null)
    assert.equal((observedBody as { plan?: { status?: string } }).plan?.status, 'ready')
    assert.equal((observedBody as { task?: unknown }).task, undefined)
    // A first request that says "start" is not a confirmation of a ready plan,
    // so nothing launches and the reply says why instead of naming a control.
    assert.match(
      (observedBody as { messages?: { text?: string }[] }).messages?.[0]?.text ?? '',
      /could not start/i,
    )
    const plan = await sessionStore.getRunPlan(session.id)
    assert.equal(plan?.status, 'ready')
    assert.equal(plan?.applyClaimId, undefined)
    assert.equal((await sessionStore.listTaskRecords(session.id)).length, 0)
    assert.equal(calls.calls, 0)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    removeMirroredRepository(repoRootPath)
  }
})

test('full session API rejects direct run launch while lightweight API retains it', async () => {
  const workspacePath = makeWorkspace()
  const fullCalls = { calls: 0 }
  const lightweightCalls = { calls: 0 }
  const full = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: launcher(fullCalls),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
  })
  const lightweight = await startApiServer({
    store: new FileSystemRunStore(path.join(workspacePath, 'lightweight')),
    launcher: launcher(lightweightCalls),
  })

  try {
    const rejected = await fetch(`${full.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: workspacePath }),
    })
    assert.equal(rejected.status, 409)
    assert.deepEqual(await rejected.json(), {
      error:
        'Top-level runs require durable session task admission; use the session Apply endpoint.',
      code: 'task_admission_required',
      retryable: false,
    })
    assert.equal(fullCalls.calls, 0)

    const unavailable = await fetch(`${lightweight.url}/settings/scheduling`)
    assert.equal(unavailable.status, 503)
    assert.equal(
      ((await unavailable.json()) as { code: string }).code,
      'scheduling_unavailable',
    )
    const launched = await fetch(`${lightweight.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: workspacePath }),
    })
    assert.equal(launched.status, 202)
    assert.equal(lightweightCalls.calls, 1)
  } finally {
    await Promise.all([full.close(), lightweight.close()])
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('scheduling GET stays readable while live mutation is gated during queue recovery', async () => {
  const workspacePath = makeWorkspace()
  const calls = { calls: 0 }
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Recovery gate' })
  let observedGetStatus = 0
  let observedPatchStatus = 0
  let observedPatchCode = ''
  let observedRetryAfter: string | null = null
  let observedApplyStatus = 0
  let observedApplyCode = ''
  let observedApplyRetryAfter: string | null = null

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: launcher(calls),
    sessionStore,
    workspacePath,
    onListening: async ({ url }) => {
      const get = await fetch(`${url}/settings/scheduling`)
      observedGetStatus = get.status
      const patch = await fetch(`${url}/settings/scheduling`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maximumConcurrentTasks: 4 }),
      })
      observedPatchStatus = patch.status
      observedRetryAfter = patch.headers.get('retry-after')
      observedPatchCode = ((await patch.json()) as { code: string }).code
      const apply = await fetch(`${url}/sessions/${session.id}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'not-reached', brief: 'not reached' }),
      })
      observedApplyStatus = apply.status
      observedApplyRetryAfter = apply.headers.get('retry-after')
      observedApplyCode = ((await apply.json()) as { code: string }).code
    },
  })

  try {
    assert.equal(observedGetStatus, 200)
    assert.equal(observedPatchStatus, 503)
    assert.equal(observedPatchCode, 'task_admission_recovering')
    assert.equal(observedRetryAfter, '1')
    assert.equal(observedApplyStatus, 503)
    assert.equal(observedApplyCode, 'task_admission_recovering')
    assert.equal(observedApplyRetryAfter, '1')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
