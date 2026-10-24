import test from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { URL } from 'node:url'

import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import type { BatchDefinition, BatchExecution } from '../../domains/batches/batch-types.js'
import { handleBatchesRoutes } from '../../server/routes/batches.js'
import { BatchService } from '../../services/batch-service.js'

const batchId = 'batch_00000000-0000-4000-8000-000000000001'
const executionId = 'exec_00000000-0000-4000-8000-000000000002'
const itemId = 'item_00000000-0000-4000-8000-000000000003'

test('Batch artifact download returns verified binary copies and becomes gone after explicit cleanup', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-artifact-api-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const content = Buffer.from([0, 1, 2, 127, 128, 255])
  const destinationPath = `${batchId}/${executionId}/${itemId}/01-result.bin`
  const artifactPath = path.join(workspacePath, 'batch-results', destinationPath)
  await fs.mkdir(path.dirname(artifactPath), { recursive: true })
  await fs.writeFile(artifactPath, content)
  const store = new BatchStore({ workspacePath })
  await store.initialize()
  const definition = makeDefinition(workspacePath)
  await store.writeDefinitions([definition])
  await store.writeExecution(makeExecution(definition, destinationPath, content))
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
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}/batches/${batchId}/executions/${executionId}`
  const artifactUrl = `${baseUrl}/items/${itemId}/artifacts/0`

  const downloaded = await fetch(artifactUrl)
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream')
  assert.match(downloaded.headers.get('content-disposition') ?? '', /01-result\.bin/)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content)

  const invalidIndex = await fetch(`${baseUrl}/items/${itemId}/artifacts/not-a-number`)
  assert.equal(invalidIndex.status, 400)
  assert.equal((await invalidIndex.json()).code, 'invalid_batch_request')
  const missingArtifact = await fetch(`${baseUrl}/items/${itemId}/artifacts/1`)
  assert.equal(missingArtifact.status, 404)
  assert.equal((await missingArtifact.json()).code, 'artifact_not_found')

  const outsideArtifactPath = path.join(workspacePath, 'outside-result.bin')
  await fs.writeFile(outsideArtifactPath, content)
  await fs.rm(artifactPath)
  await fs.symlink(outsideArtifactPath, artifactPath)
  const symlinkArtifact = await fetch(artifactUrl)
  assert.equal(symlinkArtifact.status, 404)
  assert.equal((await symlinkArtifact.json()).code, 'artifact_not_found')

  const cleared = await fetch(`${baseUrl}/results`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(cleared.status, 204)
  const afterClear = await fetch(artifactUrl)
  assert.equal(afterClear.status, 410)
  assert.equal((await afterClear.json()).code, 'artifact_cleared')
})

function makeDefinition(workspacePath: string): BatchDefinition {
  return {
    id: batchId,
    revision: 1,
    name: 'Artifact API',
    workflowId: 'workflow',
    folderPath: workspacePath,
    fileExtensions: [],
    rerunPolicy: 'always',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makeExecution(
  definition: BatchDefinition,
  destinationPath: string,
  content: Buffer,
): BatchExecution {
  return {
    id: executionId,
    batchId,
    definitionSnapshot: definition,
    sourceFolderCanonicalPath: definition.folderPath,
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'completed',
    items: [{
      id: itemId,
      ordinal: 0,
      fileName: 'source.bin',
      sourceSize: 1,
      sourceMtime: '2026-08-06T10:00:00.000Z',
      sourceSha256: 'b'.repeat(64),
      status: 'done',
      sessionId: 'session-1',
      taskId: 'task-1',
      resultArtifacts: [{
        role: 'final',
        sourceRunId: 'run-1',
        sourcePath: 'result.bin',
        destinationPath,
        mediaType: 'application/octet-stream',
        byteLength: content.byteLength,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      }],
      createdAt: '2026-08-06T10:00:00.000Z',
      updatedAt: '2026-08-06T10:01:00.000Z',
      completedAt: '2026-08-06T10:01:00.000Z',
    }],
    retainedResultBytes: content.byteLength,
    startedAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:01:00.000Z',
    completedAt: '2026-08-06T10:01:00.000Z',
  }
}
