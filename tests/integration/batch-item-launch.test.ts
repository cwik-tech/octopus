import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import { evaluateMcpWorkflowPreflight } from '../../domains/mcp/mcp-workflow-preflight.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { prepareBatchItem } from '../../services/batch-admission-coordinator.js'
import { BatchService } from '../../services/batch-service.js'
import { TaskQueue } from '../../services/task-queue.js'

test('Batch item launch uses the real session parser run-plan and TaskQueue path', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-item-launch-'))
  const registryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-item-registry-'))
  t.after(async () => {
    await fs.rm(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
    await fs.rm(registryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })
  })
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  await fs.writeFile(path.join(sourcePath, 'brief.txt'), 'BATCH_REAL_PARSER_TOKEN')
  const workflowsRegistryPath = await writeWorkflowRegistry(registryDirectory)
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    workflowsRegistryPath,
    taskLauncher: { async startRun() { return await new Promise<never>(() => undefined) } },
  })
  const store = new BatchStore({ workspacePath })
  const folderAccessPolicy = new DefaultBatchFolderAccessPolicy({
    workspacePath,
    repoRootPath: process.cwd(),
  })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy,
    validateWorkflow: async () => true,
  })
  const mcpPreflight = evaluateMcpWorkflowPreflight({
    workflowId: 'batch-test-workflow',
    generatedAt: '2026-08-06T00:00:00.000Z',
    steps: [{
      stepId: 'write',
      scheduledAgents: [{
        agentPath: 'agents/writer',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        supportState: 'supported',
      }],
    }],
    servers: [],
    grants: [],
  })

  try {
    await taskQueue.initialize()
    await service.initialize()
    const batch = await service.create({
      name: 'Launch',
      workflowId: 'batch-test-workflow',
      folderPath: sourcePath,
      fileExtensions: ['txt'],
      rerunPolicy: 'always',
    })
    const execution = await service.runNow(batch.id)
    const item = execution.items[0]!

    const prepared = await prepareBatchItem({
      store,
      executionId: execution.id,
      batchId: batch.id,
      itemId: item.id,
      sessionStore,
      createSession: (input) => sessionStore.createSession(input),
      folderAccessPolicy,
      fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
      taskQueue,
      workspacePath,
      repoRootPath: process.cwd(),
      workflowsRegistryPath,
      mcpWorkflowPreflightService: { async resolve() { return mcpPreflight } },
    })

    assert.equal(prepared.status, 'queued', prepared.failureDetail)
    assert.ok(prepared.sessionId)
    assert.ok(prepared.runPlanId)
    assert.ok(prepared.taskId)
    const session = await sessionStore.getSession(prepared.sessionId!)
    assert.deepEqual(session?.origin, {
      kind: 'batch',
      batchId: batch.id,
      executionId: execution.id,
      itemId: item.id,
    })
    const [file] = await sessionStore.listFiles(prepared.sessionId!)
    assert.equal(file?.parseStatus, 'parsed')
    const task = await sessionStore.getTaskRecord(prepared.sessionId!, prepared.taskId!)
    assert.equal(task?.admission?.source, 'batch')
    assert.ok(task?.mcpResolutionPath)
    const resolution = JSON.parse(await fs.readFile(task!.mcpResolutionPath!, 'utf8')) as {
      workflowId?: string
    }
    assert.equal(resolution.workflowId, 'batch-test-workflow')
    assert.ok(task?.cwd.startsWith(path.join(workspacePath, 'sessions')))
    assert.match(task?.brief ?? '', /Run workflow batch-test-workflow\./)
    assert.match(task?.brief ?? '', /<file name="brief\.txt" parse_status="parsed">/)
    assert.match(task?.brief ?? '', /BATCH_REAL_PARSER_TOKEN/)
  } finally {
    await taskQueue.close(1)
    await owner.release()
  }
})

test('Batch rejects a human-input workflow before creating a session or staging its source', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-human-input-'))
  const registryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-human-input-registry-'))
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true })
    await fs.rm(registryDirectory, { recursive: true, force: true })
  })
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  await fs.writeFile(path.join(sourcePath, 'brief.txt'), 'HUMAN_INPUT_BATCH_TOKEN')
  const workflowsRegistryPath = await writeWorkflowRegistry(registryDirectory, true)
  const store = new BatchStore({ workspacePath })
  const folderAccessPolicy = new DefaultBatchFolderAccessPolicy({
    workspacePath,
    repoRootPath: process.cwd(),
  })
  const service = new BatchService({
    workspacePath,
    store,
    folderAccessPolicy,
    validateWorkflow: async () => true,
  })
  const sessionStore = new FileSystemSessionStore(workspacePath)

  await service.initialize()
  const batch = await service.create({
    name: 'Human input is interactive',
    workflowId: 'batch-test-workflow',
    folderPath: sourcePath,
    fileExtensions: ['txt'],
    rerunPolicy: 'always',
  })
  const execution = await service.runNow(batch.id)
  const item = execution.items[0]!

  const prepared = await prepareBatchItem({
    store,
    executionId: execution.id,
    batchId: batch.id,
    itemId: item.id,
    sessionStore,
    createSession: async () => {
      throw new Error('A human-input Batch must be rejected before session creation')
    },
    folderAccessPolicy,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
    taskQueue: {} as TaskQueue,
    workspacePath,
    repoRootPath: process.cwd(),
    workflowsRegistryPath,
  })

  assert.equal(prepared.status, 'setup_failed')
  assert.equal(prepared.failureCode, 'workflow_requires_input')
  assert.deepEqual(await sessionStore.listSessions(), [])
  await service.close()
})

async function writeWorkflowRegistry(
  directory: string,
  includeHumanInput = false,
): Promise<string> {
  const registryPath = path.join(directory, 'registry.yaml')
  await fs.writeFile(registryPath, [
    'batch-test-workflow:',
    '  description: Write a result from a Batch file.',
    '  template_path: ./batch-test-workflow.yaml',
    '  tags:',
    '    - writing',
    '',
  ].join('\n'))
  await fs.writeFile(path.join(directory, 'batch-test-workflow.yaml'), [
    'workflow:',
    '  id: batch-test-workflow',
    '  description: Write a result from a Batch file.',
    '  input:',
    '    artifact: incoming-brief.md',
    '  steps:',
    '    - id: write',
    '      type: team',
    '      team: writing-team',
    '      input_artifact: incoming-brief.md',
    '      result_artifact: final-draft.md',
    ...(includeHumanInput
      ? [
          '    - id: human-feedback',
          '      type: human-in-the-loop',
          '      input_artifact: review/final-draft.md',
          '      result_artifact: feedback/round-one.json',
        ]
      : []),
    '  output:',
    '    from_step: write',
    '    artifact: final-draft.md',
    '  on_blocked: stop',
    '  on_failed: stop',
    '',
  ].join('\n'))
  return registryPath
}
