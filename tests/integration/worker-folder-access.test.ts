import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import { WorkspaceProjectService } from '../../domains/projects/workspace-project-service.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { SharedFolderStore } from '../../domains/shared-folders/shared-folder-store.js'
import { SharedFolderAccessPolicy } from '../../domains/shared-folders/shared-folder-access-policy.js'
import { evaluateMcpWorkflowPreflight } from '../../domains/mcp/mcp-workflow-preflight.js'
import { MCP_WORKER_TURN_CONTRACT_VERSION } from '../../domains/mcp/mcp-worker-turn.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpWorkerTurnService } from '../../services/mcp-worker-turn-service.js'
import { SharedFolderService } from '../../services/shared-folder-service.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsTurn, type FakeChatCompletionsRequest } from '../support/fake-chat-completions-server.js'

function toolContents(request: FakeChatCompletionsRequest | undefined): string {
  const messages = request?.body.messages
  return JSON.stringify(Array.isArray(messages) ? messages.filter((message: unknown) =>
    typeof message === 'object' && message !== null && 'role' in message && message.role === 'tool') : [])
}

async function makeWorker(t: TestContext, script: readonly FakeChatCompletionsTurn[]) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-folders-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspacePath = path.join(directory, 'workspace')
  // Paid and nondeterministic provider replaced only at its HTTP boundary.
  const model = await startFakeChatCompletionsServer({ models: ['reader'], script })
  t.after(() => model.close())
  const codec = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8') }
  const providers = new ProviderSettingsService({ storagePath: path.join(directory, 'providers.json'), secretCodec: codec })
  const connection = await providers.saveConnection({ kind: 'openai-compatible', name: 'Reader', baseUrl: `${model.url}/v1`, apiKey: 'test-secret', enabled: true })
  await providers.validateConnection(connection.id)
  await providers.setModelEnabled(connection.id, 'reader', true)
  const provider = configuredProviderName(connection.id)
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Codebase review' })
  const projects = new WorkspaceProjectService({ sessionStore: store, projectStore: new WorkspaceProjectStore({ workspacePath }), membershipStore: new WorkspaceProjectMembershipStore({ workspacePath }) })
  const grants = new BatchFolderGrantStore(path.join(directory, 'grants.json'))
  await grants.initialize()
  const sharedFolderService = new SharedFolderService({ store: new SharedFolderStore(workspacePath), projects,
    policy: new SharedFolderAccessPolicy({ protectedPaths: [workspacePath], listGrants: () => grants.list() }) })
  t.after(() => sharedFolderService.close())
  const root = path.join(directory, 'codebases')
  fs.mkdirSync(path.join(root, 'gateway', 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'engine', 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'gateway', 'src', 'main.ts'), 'export const gateway = "CITRUS-731";')
  fs.writeFileSync(path.join(root, 'engine', 'src', 'main.ts'), 'export const engine = "CEDAR-952";')
  await grants.grant(root)
  const attached = await sharedFolderService.attachToSession(session.id, root)
  assert.equal(attached.kind, 'attached')
  assert.ok('folder' in attached)
  const resolution = evaluateMcpWorkflowPreflight({ workflowId: 'reader-workflow', generatedAt: '2026-10-17T00:00:00.000Z', steps: [{ stepId: 'read', scheduledAgents: [{ agentPath: 'agents/reader', provider, model: 'reader', supportState: 'supported' }] }], servers: [], grants: [] }).snapshot
  const task = await store.createTaskRecord(session.id, { workflowId: 'reader-workflow', brief: 'Inspect both codebases.', mcpResolution: resolution })
  assert.ok(task?.assignmentId)
  const processIdentity = '55555555-5555-4555-8555-555555555555'
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => undefined, 1000)', '--', `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(async () => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited })
  await once(child, 'message', { signal: AbortSignal.timeout(5_000) })
  assert.ok(child.pid)
  const running = await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], { status: 'running', processIdentity, executionAttemptId: processIdentity, ownerInstanceId: store.getInstanceId(), pid: child.pid })
  assert.equal(running?.updated, true)
  const manager = new McpClientManager()
  t.after(() => manager.closeAll())
  const settings = new McpSettingsService({ storagePath: path.join(directory, 'mcps.json'), secretCodec: codec, clientManager: manager })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({ lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE, settingsService: settings, clientManager: settings.getBrokerClientManager(), grantResolver: ({ context, serverId }) => settings.isAgentGranted(context.agentPath, serverId), leaseResolver: (context) => leases.resolve(context) })
  const options = { workspacePath, sessionStore: store, sharedFolderService,
    agentToolService: new McpAgentToolService({ broker, leaseStore: leases, providerSettingsService: providers }) }
  const service = new McpWorkerTurnService(options)
  const request = { version: MCP_WORKER_TURN_CONTRACT_VERSION, sessionId: session.id, runId: task.runId, assignmentId: task.assignmentId, taskId: task.id, processIdentity, workflowId: 'reader-workflow', workflowStepId: 'read', agentPath: 'agents/reader', provider, model: 'reader', thinking: 'low' as const, systemPrompt: 'Inspect the attached codebases.', userMessage: 'Report both identifiers.' }
  return { service, request, model, folderId: attached.folder.id, root, grants, sharedFolderService, store }
}

test('a managed Team worker reads files in both nested codebases with folder tools', { timeout: 15_000 }, async (t) => {
  const first: Record<string, unknown> = { path: 'gateway/src/main.ts' }
  const second: Record<string, unknown> = { path: 'engine/src/main.ts' }
  const worker = await makeWorker(t, [
    { toolCalls: [{ id: 'read-gateway', name: 'folder_read', arguments: first }, { id: 'read-engine', name: 'folder_read', arguments: second }] },
    { content: 'Both codebases inspected.' },
  ])
  first.folder = worker.folderId
  second.folder = worker.folderId
  const result = await worker.service.runTurn(worker.request, AbortSignal.timeout(10_000))
  assert.equal(result.kind, 'completed', 'the worker must run the folder tool loop rather than fall back without tools')
  assert.match(worker.model.requests[0]?.userMessage ?? '', /<attached_folders/)
  assert.match(toolContents(worker.model.requests.at(-1)), /CITRUS-731/)
  assert.match(toolContents(worker.model.requests.at(-1)), /CEDAR-952/)
  assert.doesNotMatch(worker.model.requests[0]?.userMessage ?? '', /CITRUS-731|CEDAR-952/)
})

test('a managed worker cannot read a folder attached only to another chat', { timeout: 15_000 }, async (t) => {
  const foreignRead: Record<string, unknown> = { path: 'private.ts' }
  const worker = await makeWorker(t, [
    { toolCalls: [{ id: 'foreign-read', name: 'folder_read', arguments: foreignRead }] },
    { content: 'Access refused.' },
  ])
  const other = await worker.store.createSession({ title: 'Other chat' })
  const privateRoot = path.join(path.dirname(worker.root), 'private')
  fs.mkdirSync(privateRoot)
  fs.writeFileSync(path.join(privateRoot, 'private.ts'), 'OTHER-CHAT-SECRET')
  await worker.grants.grant(privateRoot)
  const attached = await worker.sharedFolderService.attachToSession(other.id, privateRoot)
  assert.ok('folder' in attached)
  foreignRead.folder = attached.folder.id
  const result = await worker.service.runTurn(worker.request, AbortSignal.timeout(10_000))
  assert.equal(result.kind, 'completed')
  assert.match(toolContents(worker.model.requests.at(-1)), /Unknown folder/)
  assert.doesNotMatch(JSON.stringify(worker.model.requests), /OTHER-CHAT-SECRET/)
})

test('revoking a folder grant during a managed worker turn refuses its next read', { timeout: 15_000 }, async (t) => {
  const read: Record<string, unknown> = { path: 'gateway/src/main.ts' }
  let revoke: () => Promise<unknown> = async () => undefined
  let release = (): void => undefined
  let fail = (_error: unknown): void => undefined
  const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
  const worker = await makeWorker(t, [
    { match: () => { void revoke().then(release, fail); return true }, gate,
      toolCalls: [{ id: 'revoked-read', name: 'folder_read', arguments: read }] },
    { content: 'Access removed.' },
  ])
  read.folder = worker.folderId
  revoke = () => worker.grants.revoke(worker.root)
  const result = await worker.service.runTurn(worker.request, AbortSignal.timeout(10_000))
  assert.equal(result.kind, 'completed')
  assert.match(toolContents(worker.model.requests.at(-1)), /Access to this folder was removed/)
  assert.doesNotMatch(JSON.stringify(worker.model.requests), /CITRUS-731/)
})
