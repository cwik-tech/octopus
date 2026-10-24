import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
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
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsRequest } from '../support/fake-chat-completions-server.js'

const scenarios = [
  { name: 'a Team or Workflow worker reads the final section of its frozen upload after the live file changes', question: 'Find FINAL_FACT.', whole: false },
  { name: 'a worker reviews the entire frozen document in bounded batches before answering', question: 'Review the entire document and find FINAL_FACT.', whole: true },
]
for (const scenario of scenarios) test(scenario.name, { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-documents-'))
  const workspacePath = path.join(directory, 'workspace')
  // Replace only the nondeterministic model at the HTTP boundary.
  const script = scenario.whole ? [
    { match: (request: FakeChatCompletionsRequest) => Boolean(request.systemPrompt?.includes('Review this fragment') && request.userMessage?.includes('FINAL_FACT=72391')), content: JSON.stringify({ evidence: ['FINAL_FACT=72391'] }) },
    ...Array.from({ length: 30 }, () => ({ match: (request: FakeChatCompletionsRequest) => Boolean(request.systemPrompt?.includes('Review this fragment')), content: JSON.stringify({ evidence: [] }) })),
    { content: 'The captured final fact is 72391.' },
  ] : [
    { toolCalls: [{ id: 'tail-search', name: 'document_search', arguments: { query: 'FINAL_FACT' } }] },
    { content: 'The captured final fact is 72391.' },
  ]
  const model = await startFakeChatCompletionsServer({ models: ['reader'], script })
  const codec = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8') }
  const providers = new ProviderSettingsService({ storagePath: path.join(directory, 'providers.json'), secretCodec: codec })
  const connection = await providers.saveConnection({ kind: 'openai-compatible', name: 'Reader', baseUrl: `${model.url}/v1`, apiKey: 'test-secret', enabled: true })
  await providers.validateConnection(connection.id)
  await providers.setModelEnabled(connection.id, 'reader', true)
  const provider = configuredProviderName(connection.id)
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Frozen source' })
  await store.saveUploadedFile(session.id, { filename: 'evidence.md', contents: Buffer.from('background '.repeat(12_000) + '\nFINAL_FACT=72391') })
  await new SourceFileParserLauncher(process.cwd()).parseDirectory(store.inputsDir(session.id))
  const resolution = evaluateMcpWorkflowPreflight({ workflowId: 'reader-workflow', generatedAt: '2026-10-09T00:00:00.000Z', steps: [{ stepId: 'read', scheduledAgents: [{ agentPath: 'agents/reader', provider, model: 'reader', supportState: 'supported' }] }], servers: [], grants: [] }).snapshot
  const task = await store.createTaskRecord(session.id, { workflowId: 'reader-workflow', brief: 'Find FINAL_FACT.', mcpResolution: resolution })
  assert.ok(task?.assignmentId)
  const processIdentity = '55555555-5555-4555-8555-555555555555'
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => undefined, 1000)', '--', `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  await once(child, 'message', { signal: AbortSignal.timeout(5_000) })
  assert.ok(child.pid)
  const manager = new McpClientManager()
  try {
    const running = await store.compareAndSetTaskRecord(session.id, task.id, ['queued'], { status: 'running', processIdentity, executionAttemptId: processIdentity, ownerInstanceId: store.getInstanceId(), pid: child.pid })
    assert.equal(running?.updated, true)
    // Change the mutable derivative after admission; workers must read the seal.
    const parsed = path.join(store.inputsDir(session.id), 'parsed', 'evidence.md')
    fs.writeFileSync(parsed, 'FINAL_FACT=CHANGED')
    const settings = new McpSettingsService({ storagePath: path.join(directory, 'mcps.json'), secretCodec: codec, clientManager: manager })
    const leases = new McpRunLeaseStore()
    const broker = new McpParentBroker({ lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE, settingsService: settings, clientManager: settings.getBrokerClientManager(), grantResolver: ({ context, serverId }) => settings.isAgentGranted(context.agentPath, serverId), leaseResolver: (context) => leases.resolve(context) })
    const service = new McpWorkerTurnService({ workspacePath, sessionStore: store, agentToolService: new McpAgentToolService({ broker, leaseStore: leases, providerSettingsService: providers }) })
    const result = await service.runTurn({ version: MCP_WORKER_TURN_CONTRACT_VERSION, sessionId: session.id, runId: task.runId, assignmentId: task.assignmentId, taskId: task.id, processIdentity, workflowId: 'reader-workflow', workflowStepId: 'read', agentPath: 'agents/reader', provider, model: 'reader', thinking: 'low', systemPrompt: 'Use document evidence.', userMessage: scenario.question }, AbortSignal.timeout(20_000))
    assert.equal(result.kind, 'completed')
    assert.match(JSON.stringify(model.requests.at(-1)?.body.messages), /FINAL_FACT=72391/)
    assert.match(JSON.stringify(model.requests.slice(1).map((request) => request.body.messages)), /FINAL_FACT=72391/)
    assert.doesNotMatch(JSON.stringify(model.requests), /FINAL_FACT=CHANGED/)
    assert.equal(model.requests.some((request) => request.systemPrompt?.includes('Review this fragment')), scenario.whole)
  } finally {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    await manager.closeAll()
    await model.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
