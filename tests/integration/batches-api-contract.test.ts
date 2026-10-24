import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { URL } from 'node:url'

import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import { BatchService } from '../../services/batch-service.js'
import { handleBatchesRoutes } from '../../server/routes/batches.js'

test('Batch REST contract provides strict CRUD, preflight, execution pagination, and cancellation', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batches-api-'))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  await fs.writeFile(path.join(sourcePath, 'one.txt'), 'one')
  const overflowPath = path.join(workspacePath, 'overflow')
  await fs.mkdir(overflowPath)
  await Promise.all(Array.from({ length: 51 }, (_, index) =>
    fs.writeFile(path.join(overflowPath, `${String(index).padStart(2, '0')}.txt`), 'x'),
  ))
  const store = new BatchStore({ workspacePath })
  let id = 1
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    randomUUID: () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
  })
  await service.initialize()
  const server = http.createServer((req, res) => {
    void handleBatchesRoutes({ req, res, url: new URL(req.url!, 'http://localhost'), runtime: service })
      .catch((error) => {
        res.statusCode = 500
        res.end(String(error))
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    // HTTP 202 acknowledges cancellation before its durable writes finish.
    await service.close()
    await fs.rm(workspacePath, { recursive: true, force: true })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const invalid = await request(baseUrl, '/batches', 'POST', {
    name: 'Invalid',
    workflowId: 'workflow',
    folderPath: sourcePath,
    fileExtensions: [],
    rerunPolicy: 'always',
    unknown: true,
  })
  assert.equal(invalid.response.status, 400)
  assert.equal(invalid.body.code, 'invalid_batch_request')

  const created = await request(baseUrl, '/batches', 'POST', {
    name: 'Files',
    workflowId: 'workflow',
    folderPath: sourcePath,
    fileExtensions: ['txt'],
    rerunPolicy: 'always',
  })
  assert.equal(created.response.status, 201)
  const batchId = String(created.body.id)
  assert.equal((await request(baseUrl, '/batches')).body.batches.length, 1)
  assert.equal((await request(baseUrl, `/batches/${batchId}`)).body.id, batchId)

  const preflight = await request(baseUrl, `/batches/${batchId}/preflight`, 'POST')
  assert.equal(preflight.response.status, 200)
  assert.equal(preflight.body.fileCount, 1)
  assert.deepEqual(preflight.body.extensionCounts, { '.txt': 1 })
  assert.equal(preflight.body.requiresConfirmation, false)
  const run = await request(baseUrl, `/batches/${batchId}/run-now`, 'POST')
  assert.equal(run.response.status, 202)
  assert.match(String(run.body.executionId), /^exec_/)
  const executions = await request(baseUrl, `/batches/${batchId}/executions?limit=1`)
  assert.equal(executions.body.executions.length, 1)
  const detail = await request(
    baseUrl,
    `/batches/${batchId}/executions/${run.body.executionId}?limit=1`,
  )
  assert.equal(detail.body.items[0].fileName, 'one.txt')

  const cancelled = await request(
    baseUrl,
    `/batches/${batchId}/executions/${run.body.executionId}/cancel`,
    'POST',
  )
  assert.equal(cancelled.response.status, 202)
  assert.ok(cancelled.body.cancelRequestedAt)

  const overflow = await request(baseUrl, '/batches', 'POST', {
    name: 'Overflow',
    workflowId: 'workflow',
    folderPath: overflowPath,
    fileExtensions: ['.txt'],
    rerunPolicy: 'always',
  })
  const tooLarge = await request(baseUrl, `/batches/${overflow.body.id}/preflight`, 'POST')
  assert.equal(tooLarge.response.status, 413)
  assert.equal(tooLarge.body.code, 'batch_too_large')
  assert.deepEqual(tooLarge.body.limits, {
    fileCount: 51,
    totalBytes: 0,
    maxFiles: 50,
    maxFileBytes: 100 * 1024 * 1024,
    maxTotalBytes: 500 * 1024 * 1024,
  })
})

test('Batch REST summaries expose mixed terminal file outcomes as partially completed', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batches-api-partial-'))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  const store = new BatchStore({ workspacePath })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({
      workspacePath,
      repoRootPath: workspacePath,
    }),
    validateWorkflow: async () => true,
  })
  await service.initialize()
  const definition = {
    id: 'batch_00000000-0000-4000-8000-000000000090',
    revision: 1,
    name: 'Pitch decks',
    workflowId: 'pitch-deck-evaluation',
    folderPath: sourcePath,
    fileExtensions: ['.pdf'],
    rerunPolicy: 'always' as const,
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
  await store.writeDefinitions([definition])
  await store.writeExecution({
    id: 'exec_00000000-0000-4000-8000-000000000091',
    batchId: definition.id,
    definitionSnapshot: definition,
    sourceFolderCanonicalPath: sourcePath,
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'completed',
    items: [
      {
        id: 'item_00000000-0000-4000-8000-000000000092',
        ordinal: 0,
        fileName: 'finished.pdf',
        sourceSize: 1,
        sourceMtime: '2026-08-06T10:00:00.000Z',
        sourceSha256: 'b'.repeat(64),
        status: 'done',
        resultArtifacts: [],
        createdAt: '2026-08-06T10:00:00.000Z',
        updatedAt: '2026-08-06T10:02:00.000Z',
        completedAt: '2026-08-06T10:02:00.000Z',
      },
      {
        id: 'item_00000000-0000-4000-8000-000000000093',
        ordinal: 1,
        fileName: 'blocked.pdf',
        sourceSize: 1,
        sourceMtime: '2026-08-06T10:00:00.000Z',
        sourceSha256: 'c'.repeat(64),
        status: 'blocked',
        failureCode: 'task_blocked',
        failureDetail: 'Expected final artifact was not produced.',
        resultArtifacts: [],
        createdAt: '2026-08-06T10:00:00.000Z',
        updatedAt: '2026-08-06T10:03:00.000Z',
        completedAt: '2026-08-06T10:03:00.000Z',
      },
    ],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:03:00.000Z',
    completedAt: '2026-08-06T10:03:00.000Z',
  })
  const server = http.createServer((req, res) => {
    void handleBatchesRoutes({
      req,
      res,
      url: new URL(req.url!, 'http://localhost'),
      runtime: service,
    }).catch((error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await service.close()
    await fs.rm(workspacePath, { recursive: true, force: true })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const response = await request(`http://127.0.0.1:${address.port}`, '/batches')

  assert.equal(response.response.status, 200)
  assert.equal(response.body.batches[0]?.latestExecution?.status, 'partially_completed')
})

async function request(
  baseUrl: string,
  route: string,
  method = 'GET',
  body?: unknown,
): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return {
    response,
    body: await response.json(),
  }
}
