import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  handleSchedulingSettingsRoutes,
  type SchedulingSettingsRouteRuntime,
} from '../../server/routes/scheduling-settings.js'
import type {
  SchedulingSettingsApiError,
  SchedulingSettingsSnapshot,
} from '../../domains/scheduling/scheduling-settings.js'
import { SchedulingSettingsService } from '../../services/scheduling-settings-service.js'

interface TestServer {
  readonly url: string
  close(): Promise<void>
}

function createStorage(): {
  readonly directory: string
  readonly controlDirectory: string
  readonly storagePath: string
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduling-route-'))
  const controlDirectory = path.join(directory, 'task-queue')
  return {
    directory,
    controlDirectory,
    storagePath: path.join(controlDirectory, 'settings.json'),
  }
}

function createRuntime(
  service: SchedulingSettingsService,
  isReady: () => boolean = () => true,
): SchedulingSettingsRouteRuntime {
  return {
    isReady,
    snapshot: () => service.snapshot(),
    updateMaximumConcurrentTasks: (value) =>
      service.updateMaximumConcurrentTasks(value),
  }
}

async function startRouteServer(
  runtime?: SchedulingSettingsRouteRuntime,
): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleSchedulingSettingsRoutes({
        req,
        res,
        url: new URL(req.url ?? '/', 'http://127.0.0.1'),
        ...whenDefined(runtime, (definedRuntime) => ({ runtime: definedRuntime })),
      })
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    })().catch((error: unknown) => {
      res.statusCode = 500
      res.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json() as T
}

test('scheduling settings route exposes the default and durably patches the exact contract', async () => {
  const storage = createStorage()
  const service = new SchedulingSettingsService({
    storagePath: storage.storagePath,
    environment: {},
  })
  const server = await startRouteServer(createRuntime(service))
  try {
    const defaultResponse = await fetch(`${server.url}/settings/scheduling`)
    assert.equal(defaultResponse.status, 200)
    assert.equal(defaultResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await responseJson<SchedulingSettingsSnapshot>(defaultResponse), {
      maximumConcurrentTasks: 3,
      constraints: { minimum: 1, maximum: 64 },
      source: 'default',
      editable: true,
    })

    const patchResponse = await fetch(`${server.url}/settings/scheduling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumConcurrentTasks: 4 }),
    })
    assert.equal(patchResponse.status, 200)
    assert.equal(patchResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await responseJson<SchedulingSettingsSnapshot>(patchResponse), {
      maximumConcurrentTasks: 4,
      constraints: { minimum: 1, maximum: 64 },
      source: 'persisted',
      editable: true,
    })
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.storagePath, 'utf8')), {
      version: 1,
      maximumConcurrentTasks: 4,
    })

    for (const { body, error: expectedError } of [
      {
        body: {},
        error: 'Request body must contain only maximumConcurrentTasks.',
      },
      {
        body: null,
        error: 'Request body must be a JSON object.',
      },
      {
        body: { maximumConcurrentTasks: '4' },
        error: 'Maximum concurrent tasks must be an integer from 1 through 64.',
      },
      {
        body: { maximumConcurrentTasks: 4.5 },
        error: 'Maximum concurrent tasks must be an integer from 1 through 64.',
      },
      {
        body: { maximumConcurrentTasks: 0 },
        error: 'Maximum concurrent tasks must be an integer from 1 through 64.',
      },
      {
        body: { maximumConcurrentTasks: -1 },
        error: 'Maximum concurrent tasks must be an integer from 1 through 64.',
      },
      {
        body: { maximumConcurrentTasks: 65 },
        error: 'Maximum concurrent tasks must be an integer from 1 through 64.',
      },
      {
        body: { maximumConcurrentTasks: 4, unknown: true },
        error: 'Request body must contain only maximumConcurrentTasks.',
      },
    ]) {
      const invalidResponse = await fetch(`${server.url}/settings/scheduling`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(invalidResponse.status, 400)
      const invalid = await responseJson<SchedulingSettingsApiError>(invalidResponse)
      assert.deepEqual(invalid, {
        error: expectedError,
        code: 'invalid_request',
        retryable: false,
      })
    }
    const malformedResponse = await fetch(`${server.url}/settings/scheduling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(malformedResponse.status, 400)
    assert.deepEqual(
      await responseJson<SchedulingSettingsApiError>(malformedResponse),
      {
        error: 'Invalid JSON request body',
        code: 'invalid_request',
        retryable: false,
      },
    )
    assert.equal((await service.snapshot()).maximumConcurrentTasks, 4)

    const methodResponse = await fetch(`${server.url}/settings/scheduling`, {
      method: 'POST',
    })
    assert.equal(methodResponse.status, 405)
    assert.equal(methodResponse.headers.get('allow'), 'GET, PATCH')
    assert.deepEqual(await responseJson<SchedulingSettingsApiError>(methodResponse), {
      error: 'Method not allowed.',
      code: 'method_not_allowed',
      retryable: false,
    })
  } finally {
    await server.close()
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('GET remains available during recovery while PATCH is retryable and an absent runtime is unavailable', async () => {
  const storage = createStorage()
  const service = new SchedulingSettingsService({
    storagePath: storage.storagePath,
    environment: {},
  })
  const recoveringServer = await startRouteServer(createRuntime(service, () => false))
  const unavailableServer = await startRouteServer()
  try {
    const getResponse = await fetch(`${recoveringServer.url}/settings/scheduling`)
    assert.equal(getResponse.status, 200)

    const patchResponse = await fetch(
      `${recoveringServer.url}/settings/scheduling`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maximumConcurrentTasks: 4 }),
      },
    )
    assert.equal(patchResponse.status, 503)
    assert.equal(patchResponse.headers.get('retry-after'), '1')
    assert.deepEqual(await responseJson<SchedulingSettingsApiError>(patchResponse), {
      error: 'Task admission is still recovering.',
      code: 'task_admission_recovering',
      retryable: true,
    })

    for (const method of ['GET', 'PATCH']) {
      const response = await fetch(`${unavailableServer.url}/settings/scheduling`, {
        method,
        ...(method === 'PATCH'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ maximumConcurrentTasks: 4 }),
            }
          : {}),
      })
      assert.equal(response.status, 503)
      assert.deepEqual(await responseJson<SchedulingSettingsApiError>(response), {
        error: 'Scheduling and Queue settings are unavailable.',
        code: 'scheduling_unavailable',
        retryable: false,
      })
    }
  } finally {
    await recoveringServer.close()
    await unavailableServer.close()
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('environment management and real persistence failures use stable route errors without changing the old value', async () => {
  const environmentStorage = createStorage()
  const failingStorage = createStorage()
  const environmentService = new SchedulingSettingsService({
    storagePath: environmentStorage.storagePath,
    environment: { TEAM_RUNTIME_MAX_CONCURRENT_TASKS: '5' },
  })
  const failingService = new SchedulingSettingsService({
    storagePath: failingStorage.storagePath,
    environment: {},
  })
  await failingService.updateMaximumConcurrentTasks(2)
  const movedControlDirectory = `${failingStorage.controlDirectory}-moved`
  fs.renameSync(failingStorage.controlDirectory, movedControlDirectory)
  fs.writeFileSync(failingStorage.controlDirectory, 'blocks-directory-recreation')

  const environmentServer = await startRouteServer(createRuntime(environmentService))
  const failingServer = await startRouteServer(createRuntime(failingService))
  try {
    const managedResponse = await fetch(`${environmentServer.url}/settings/scheduling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumConcurrentTasks: 5 }),
    })
    assert.equal(managedResponse.status, 409)
    assert.deepEqual(await responseJson<SchedulingSettingsApiError>(managedResponse), {
      error: 'Maximum concurrent tasks is managed by TEAM_RUNTIME_MAX_CONCURRENT_TASKS.',
      code: 'managed_by_environment',
      retryable: false,
    })

    const failedResponse = await fetch(`${failingServer.url}/settings/scheduling`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maximumConcurrentTasks: 4 }),
    })
    assert.equal(failedResponse.status, 500)
    assert.deepEqual(await responseJson<SchedulingSettingsApiError>(failedResponse), {
      error: 'Scheduling settings could not be persisted.',
      code: 'settings_persistence_failed',
      retryable: true,
    })
    assert.equal((await failingService.snapshot()).maximumConcurrentTasks, 2)
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(movedControlDirectory, 'settings.json'), 'utf8'),
      ).maximumConcurrentTasks,
      2,
    )
  } finally {
    await environmentServer.close()
    await failingServer.close()
    fs.rmSync(environmentStorage.directory, { recursive: true, force: true })
    fs.rmSync(failingStorage.directory, { recursive: true, force: true })
  }
})
import { whenDefined } from '../../core/optional-properties.js'
