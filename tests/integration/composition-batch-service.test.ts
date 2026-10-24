import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer } from '../../server/api-server.js'
import { buildServices, initializeBatchRuntime } from '../../server/composition.js'
import { BatchService, BatchServiceError } from '../../services/batch-service.js'

test('API composition initializes Batch after TaskQueue and exposes the registered routes', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-composition-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  const server = await startBatchServer(workspacePath)
  t.after(() => server.close())

  const response = await fetch(`${server.url}/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Composed Batch',
      workflowId: 'discussion-to-executive-summary',
      folderPath: sourcePath,
      fileExtensions: ['txt'],
      rerunPolicy: 'always',
    }),
  })
  assert.equal(response.status, 201)
  assert.match(String((await response.json()).id), /^batch_/)
})

test('corrupt Batch state leaves only Batch routes unavailable', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-composition-corrupt-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const definitionsPath = path.join(workspacePath, 'task-queue', 'batches', 'definitions.json')
  await fs.mkdir(path.dirname(definitionsPath), { recursive: true })
  await fs.writeFile(definitionsPath, '{broken')
  const server = await startBatchServer(workspacePath)
  t.after(() => server.close())

  assert.equal((await fetch(`${server.url}/health`)).status, 200)
  const batches = await fetch(`${server.url}/batches`)
  assert.equal(batches.status, 503)
  assert.equal((await batches.json()).code, 'batch_service_unavailable')
})

test('Batch coordinator initialization failure disables the service and closes partial coordinator state', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-composition-coordinator-failure-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const events: string[] = []
  const reportedErrors: unknown[] = []
  const service = new BatchService({
    workspacePath,
    store: new BatchStore({ workspacePath }),
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
  })
  const coordinator = {
    async initialize() {
      events.push('coordinator:initializing')
      throw new Error('coordinator initialization failed')
    },
    async close() {
      events.push('coordinator:closed')
    },
  }

  await initializeBatchRuntime({
    service,
    coordinator,
    onError: (error) => reportedErrors.push(error),
  })

  assert.deepEqual(events, ['coordinator:initializing', 'coordinator:closed'])
  assert.equal(reportedErrors.length, 1)
  assert.match(String(reportedErrors[0]), /coordinator initialization failed/)
  await assert.rejects(
    service.list(),
    (error) => error instanceof BatchServiceError && error.code === 'batch_service_unavailable',
  )
})

test('composition disposal closes its initialized Batch service', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-composition-close-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const repoRootPath = process.cwd()
  const launcher = {
    async startRun() {
      return { launched: true as const, pid: process.pid, cwd: repoRootPath }
    },
  }
  const composition = await buildServices({
    store: new FileSystemRunStore(workspacePath),
    launcher,
    taskLauncher: launcher,
    fileParserLauncher: new SourceFileParserLauncher(repoRootPath),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath,
    workflowsRegistryPath: path.join(repoRootPath, 'workflows', 'registry.yaml'),
  })
  const service = composition.services.batchService
  assert.ok(service)
  await service.initialize()
  assert.deepEqual(await service.list(), [])

  await composition.dispose()

  await assert.rejects(
    service.list(),
    (error) => error instanceof BatchServiceError && error.code === 'batch_service_unavailable',
  )
})

async function startBatchServer(workspacePath: string) {
  const repoRootPath = process.cwd()
  const launcher = {
    async startRun() {
      return { launched: true as const, pid: process.pid, cwd: repoRootPath }
    },
  }
  return startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher,
    taskLauncher: launcher,
    fileParserLauncher: new SourceFileParserLauncher(repoRootPath),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath,
    workflowsRegistryPath: path.join(repoRootPath, 'workflows', 'registry.yaml'),
  })
}
