import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { URL } from 'node:url'

import type { BatchDefinitionInput, BatchPatch } from '../../contracts/batches.js'
import { BatchStoreUnavailableError } from '../../domains/batches/batch-store.js'
import {
  handleBatchesRoutes,
  type BatchesRouteRuntime,
} from '../../server/routes/batches.js'
import { BatchServiceError } from '../../services/batch-service.js'

test('Batch routes validate and normalize create and patch bodies before service dispatch', async (t) => {
  const created: BatchDefinitionInput[] = []
  const updated: BatchPatch[] = []
  const runtime = runtimeWith({
    async create(input) {
      created.push(input)
      return { ...input, id: 'batch-1', revision: 1, createdAt: 'now', updatedAt: 'now' }
    },
    async update(_batchId, patch) {
      updated.push(patch)
      return {
        id: 'batch-1',
        revision: 2,
        name: patch.name ?? 'Batch',
        workflowId: 'workflow',
        folderPath: '/tmp/files',
        fileExtensions: [],
        rerunPolicy: 'always',
        createdAt: 'now',
        updatedAt: 'now',
      }
    },
  })
  const baseUrl = await startServer(t, runtime)

  const invalidCreate = await jsonRequest(baseUrl, '/batches', 'POST', {
    name: 'Batch',
    workflowId: 'workflow',
    folderPath: '/tmp/files',
    fileExtensions: [],
    rerunPolicy: 'always',
    unknown: true,
  })
  const invalidPatch = await jsonRequest(baseUrl, '/batches/batch-1', 'PATCH', {
    expectedRevision: 1,
    name: 'Changed',
    unknown: true,
  })
  assert.equal(invalidCreate.response.status, 400)
  assert.equal(invalidPatch.response.status, 400)
  assert.equal(created.length, 0)
  assert.equal(updated.length, 0)

  const validCreate = await jsonRequest(baseUrl, '/batches', 'POST', {
    name: ' Batch ',
    workflowId: ' workflow ',
    folderPath: '/tmp/files',
    fileExtensions: ['TXT'],
    rerunPolicy: 'always',
  })
  const validPatch = await jsonRequest(baseUrl, '/batches/batch-1', 'PATCH', {
    expectedRevision: 1,
    name: ' Changed ',
  })
  assert.equal(validCreate.response.status, 201)
  assert.equal(validPatch.response.status, 200)
  assert.equal(created[0]?.name, 'Batch')
  assert.deepEqual(created[0]?.fileExtensions, ['.txt'])
  assert.equal(updated[0]?.name, 'Changed')
})

test('Batch routes return a distinct generic internal error for unexpected failures', async (t) => {
  const baseUrl = await startServer(t, runtimeWith({
    async list() {
      throw new Error('private filesystem detail')
    },
  }))

  const result = await jsonRequest(baseUrl, '/batches')

  assert.equal(result.response.status, 500)
  assert.deepEqual(result.body, {
    error: 'Batch request failed.',
    code: 'internal_batch_error',
  })
})

test('Batch routes fail closed when the durable store becomes unavailable', async (t) => {
  const baseUrl = await startServer(t, runtimeWith({
    async list() {
      throw new BatchStoreUnavailableError('private corruption detail')
    },
  }))

  const result = await jsonRequest(baseUrl, '/batches')

  assert.equal(result.response.status, 503)
  assert.deepEqual(result.body, {
    error: 'Batches are unavailable.',
    code: 'batch_service_unavailable',
  })
})

test('Batch routes map grant-not-found service errors to HTTP 404', async (t) => {
  const baseUrl = await startServer(t, runtimeWith({
    async get() {
      throw new BatchServiceError('grant_not_found', 'Grant not found.')
    },
  }))

  const result = await jsonRequest(baseUrl, '/batches/batch-1')

  assert.equal(result.response.status, 404)
  assert.deepEqual(result.body, {
    error: 'Grant not found.',
    code: 'grant_not_found',
  })
})

test('Batch action routes reject supplied null and string bodies', async (t) => {
  let preflightCalls = 0
  const baseUrl = await startServer(t, runtimeWith({
    async preflight() {
      preflightCalls += 1
      throw new Error('must not dispatch')
    },
  }))

  const nullBody = await rawJsonRequest(baseUrl, '/batches/batch-1/preflight', 'null')
  const stringBody = await rawJsonRequest(baseUrl, '/batches/batch-1/preflight', '""')

  assert.equal(nullBody.response.status, 400)
  assert.equal(stringBody.response.status, 400)
  assert.equal(preflightCalls, 0)
})

function runtimeWith(overrides: Partial<BatchesRouteRuntime>): BatchesRouteRuntime {
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected runtime call')
  }
  return {
    list: unavailable,
    get: unavailable,
    create: unavailable,
    update: unavailable,
    delete: unavailable,
    preflight: unavailable,
    runNow: unavailable,
    listExecutionsPage: unavailable,
    getExecutionItemsPage: unavailable,
    cancelExecution: unavailable,
    clearExecutionResults: unavailable,
    readResultArtifact: unavailable,
    ...overrides,
  }
}

async function startServer(t: TestContext, runtime: BatchesRouteRuntime): Promise<string> {
  const server = http.createServer((req, res) => {
    void handleBatchesRoutes({
      req,
      res,
      url: new URL(req.url!, 'http://localhost'),
      runtime,
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function jsonRequest(
  baseUrl: string,
  route: string,
  method = 'GET',
  body?: unknown,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { response, body: await response.json() }
}

async function rawJsonRequest(
  baseUrl: string,
  route: string,
  body: string,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return { response, body: await response.json() }
}
