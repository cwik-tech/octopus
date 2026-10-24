import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  handleDeepResearchSettingsRoutes,
  type DeepResearchSettingsRouteRuntime,
} from '../../server/routes/deep-research-settings.js'
import type {
  DeepResearchSettingsApiError,
  DeepResearchSettingsSnapshot,
} from '../../domains/deep-research/deep-research-settings.js'
import { DeepResearchSettingsService } from '../../services/deep-research-settings-service.js'

interface TestServer {
  readonly url: string
  close(): Promise<void>
}

function createStorage(): {
  readonly directory: string
  readonly storagePath: string
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-route-'))
  return {
    directory,
    storagePath: path.join(directory, 'deep-research', 'settings.json'),
  }
}

async function startRouteServer(
  runtime?: DeepResearchSettingsRouteRuntime,
): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleDeepResearchSettingsRoutes({
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
    server.listen(0, '127.0.0.1', resolve)
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

test('Deep Research settings route exposes defaults and durably patches the exact contract', async () => {
  const storage = createStorage()
  const service = new DeepResearchSettingsService({
    storagePath: storage.storagePath,
  })
  const runtime: DeepResearchSettingsRouteRuntime = {
    snapshot: () => service.snapshot(),
    update: (values) => service.update(values),
  }
  const server = await startRouteServer(runtime)
  try {
    const defaultResponse = await fetch(`${server.url}/settings/deep-research`)
    assert.equal(defaultResponse.status, 200)
    assert.equal(defaultResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await responseJson<DeepResearchSettingsSnapshot>(defaultResponse), {
      schemaVersion: 3,
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
      constraints: {
        maxDurationMinutes: { minimum: 5, maximum: 120 },
        maxResearcherAgents: { minimum: 1, maximum: 8 },
      },
      source: 'default',
      editable: true,
    })

    const patchResponse = await fetch(`${server.url}/settings/deep-research`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxDurationMinutes: 75,
        maxResearcherAgents: 5,
      }),
    })
    assert.equal(patchResponse.status, 200)
    assert.equal(patchResponse.headers.get('cache-control'), 'no-store')
    const saved = await responseJson<DeepResearchSettingsSnapshot>(patchResponse)
    assert.equal(saved.source, 'persisted')
    assert.equal(saved.maxDurationMinutes, 75)
    assert.equal(saved.maxResearcherAgents, 5)
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.storagePath, 'utf8')), {
      schemaVersion: 3,
      maxDurationMinutes: 75,
      maxResearcherAgents: 5,
    })

    const restartedService = new DeepResearchSettingsService({
      storagePath: storage.storagePath,
    })
    assert.equal((await restartedService.snapshot()).maxDurationMinutes, 75)
    assert.equal((await restartedService.snapshot()).maxResearcherAgents, 5)
  } finally {
    await server.close()
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('route rejects malformed fields and methods without changing persisted settings', async () => {
  const storage = createStorage()
  const service = new DeepResearchSettingsService({
    storagePath: storage.storagePath,
  })
  await service.update({ maxDurationMinutes: 30, maxResearcherAgents: 4 })
  const server = await startRouteServer({
    snapshot: () => service.snapshot(),
    update: (values) => service.update(values),
  })
  try {
    for (const { body, error: expectedError } of [
      {
        body: {},
        error:
          'Request body must contain only maxDurationMinutes and maxResearcherAgents.',
      },
      {
        body: null,
        error: 'Request body must be a JSON object.',
      },
      {
        body: { maxDurationMinutes: 20 },
        error:
          'Request body must contain only maxDurationMinutes and maxResearcherAgents.',
      },
      {
        body: { maxDurationMinutes: '20', maxResearcherAgents: 4 },
        error:
          'Maximum research duration must be an integer from 5 through 120 minutes.',
      },
      {
        body: { maxDurationMinutes: 4, maxResearcherAgents: 4 },
        error:
          'Maximum research duration must be an integer from 5 through 120 minutes.',
      },
      {
        body: { maxDurationMinutes: 121, maxResearcherAgents: 4 },
        error:
          'Maximum research duration must be an integer from 5 through 120 minutes.',
      },
      {
        body: { maxDurationMinutes: 20, maxResearcherAgents: 0 },
        error: 'Maximum researcher agents must be an integer from 1 through 8.',
      },
      {
        body: { maxDurationMinutes: 20, maxResearcherAgents: 9 },
        error: 'Maximum researcher agents must be an integer from 1 through 8.',
      },
      {
        body: {
          maxDurationMinutes: 20,
          maxResearcherAgents: 4,
          unknown: true,
        },
        error:
          'Request body must contain only maxDurationMinutes and maxResearcherAgents.',
      },
    ]) {
      const response = await fetch(`${server.url}/settings/deep-research`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400)
      const error = await responseJson<DeepResearchSettingsApiError>(response)
      assert.deepEqual(error, {
        error: expectedError,
        code: 'invalid_request',
        retryable: false,
      })
    }

    const malformed = await fetch(`${server.url}/settings/deep-research`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.deepEqual(
      await responseJson<DeepResearchSettingsApiError>(malformed),
      {
        error: 'Invalid JSON request body',
        code: 'invalid_request',
        retryable: false,
      },
    )

    const methodResponse = await fetch(`${server.url}/settings/deep-research`, {
      method: 'POST',
    })
    assert.equal(methodResponse.status, 405)
    assert.equal(methodResponse.headers.get('allow'), 'GET, PATCH')
    assert.equal((await service.snapshot()).maxDurationMinutes, 30)
    assert.equal((await service.snapshot()).maxResearcherAgents, 4)
  } finally {
    await server.close()
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('absent runtime and real persistence failure return structured stable errors', async () => {
  const storage = createStorage()
  const service = new DeepResearchSettingsService({
    storagePath: storage.storagePath,
  })
  await service.update({ maxDurationMinutes: 30, maxResearcherAgents: 4 })
  const controlDirectory = path.dirname(storage.storagePath)
  const movedControlDirectory = `${controlDirectory}-moved`
  fs.renameSync(controlDirectory, movedControlDirectory)
  fs.writeFileSync(controlDirectory, 'blocks-directory-recreation')

  const unavailableServer = await startRouteServer()
  const failingServer = await startRouteServer({
    snapshot: () => service.snapshot(),
    update: (values) => service.update(values),
  })
  try {
    for (const method of ['GET', 'PATCH']) {
      const response = await fetch(`${unavailableServer.url}/settings/deep-research`, {
        method,
        ...(method === 'PATCH'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                maxDurationMinutes: 20,
                maxResearcherAgents: 8,
              }),
            }
          : {}),
      })
      assert.equal(response.status, 503)
      assert.deepEqual(await responseJson<DeepResearchSettingsApiError>(response), {
        error: 'Deep Research settings are unavailable.',
        code: 'deep_research_settings_unavailable',
        retryable: false,
      })
    }

    const failedResponse = await fetch(`${failingServer.url}/settings/deep-research`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxDurationMinutes: 60,
        maxResearcherAgents: 6,
      }),
    })
    assert.equal(failedResponse.status, 500)
    assert.deepEqual(await responseJson<DeepResearchSettingsApiError>(failedResponse), {
      error: 'Deep Research settings could not be persisted.',
      code: 'settings_persistence_failed',
      retryable: true,
    })
    assert.equal((await service.snapshot()).maxDurationMinutes, 30)
  } finally {
    await Promise.all([unavailableServer.close(), failingServer.close()])
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})
import { whenDefined } from '../../core/optional-properties.js'
