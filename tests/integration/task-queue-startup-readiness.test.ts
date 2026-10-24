import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import {
  getConfiguredProviderConnection,
  setConfiguredProviderConnections,
} from '../../providers/configured-provider.js'
import { executeProvider, getProvider } from '../../providers/index.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { TaskAdmission } from '../../contracts/sessions.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'

const repoRoot = process.cwd()
const stdioFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)
const codec = {
  encrypt: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
}

interface LifecycleEvent {
  event: 'ready' | 'stopped'
  pid: number
  timestamp: string
}

interface ReadinessObservation {
  observedAt: number
  providerBaseUrl?: string
  mcpConnected: boolean
  mcpPid?: number
  mcpReady: boolean
}

test('startup readiness ignores an empty PID marker until publication finishes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-pid-marker-'))
  const markerPath = path.join(directory, 'waiting.pid')
  try {
    fs.writeFileSync(markerPath, '', 'utf8')
    assert.equal(readPublishedProcessId(markerPath), undefined)
    fs.writeFileSync(markerPath, '12345', 'utf8')
    assert.equal(readPublishedProcessId(markerPath), 12345)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

class ReadinessObservingLauncher implements RunLauncher {
  callCount = 0
  observation: ReadinessObservation | null = null
  providerResult: string | null = null

  constructor(
    private readonly providerName: string,
    private readonly providerBaseUrl: string,
    private readonly mcpServerId: string,
    private readonly mcpManager: McpClientManager,
    private readonly lifecyclePath: string,
  ) {}

  async startRun(request: { cwd: string }) {
    this.callCount += 1
    const provider = getConfiguredProviderConnection(this.providerName)
    const mcpSnapshot = this.mcpManager.getSnapshot(this.mcpServerId)
    this.observation = {
      observedAt: Date.now(),
      ...whenDefined(provider?.baseUrl, (providerBaseUrl) => ({ providerBaseUrl })),
      mcpConnected: this.mcpManager.isConnected(this.mcpServerId),
      ...whenDefined(mcpSnapshot?.processId, (mcpPid) => ({ mcpPid })),
      mcpReady: Boolean(
        mcpSnapshot?.processId &&
          readLifecycle(this.lifecyclePath).some(
            (event) =>
              event.event === 'ready' && event.pid === mcpSnapshot.processId,
          ),
      ),
    }
    const result = await executeProvider(getProvider(this.providerName), {
      systemPrompt: 'Return the readiness marker.',
      userMessage: 'Verify the configured provider runtime is hydrated.',
      model: 'fixture/chat-model',
      thinking: 'low',
    })
    this.providerResult = result.text
    return { launched: true as const, pid: process.pid, cwd: request.cwd }
  }
}

test(
  'startup hydration completes provider runtime and real MCP reconnection before the first durable grant',
  { timeout: 20_000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'task-queue-startup-readiness-'),
    )
    const workspacePath = path.join(directory, 'workspace')
    const providerSettingsPath = path.join(directory, 'provider-settings.json')
    const mcpSettingsPath = path.join(directory, 'mcp-settings.json')
    const lifecyclePath = path.join(directory, 'mcp-lifecycle.jsonl')
    const startupGatePath = path.join(directory, 'mcp-startup-gate')
    const startupWaitingPath = path.join(directory, 'mcp-startup-waiting.pid')
    const providerFixture = await startProviderFixture()
    const bootstrapProviderService = new ProviderSettingsService({
      storagePath: providerSettingsPath,
      secretCodec: codec,
    })
    const providerConnection = await bootstrapProviderService.saveConnection({
      kind: 'openai-compatible',
      name: 'Startup readiness provider',
      baseUrl: `${providerFixture.url}/v1`,
      apiKey: 'startup-readiness-key',
      enabled: true,
    })
    const validatedProvider = await bootstrapProviderService.validateConnection(
      providerConnection.id,
    )
    assert.equal(validatedProvider.status, 'connected')
    await bootstrapProviderService.setModelEnabled(
      providerConnection.id,
      'fixture/chat-model',
      true,
    )
    const providerName = configuredProviderName(providerConnection.id)

    fs.writeFileSync(startupGatePath, 'open', 'utf8')
    const bootstrapMcpManager = new McpClientManager({
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 3_000,
      closeTimeoutMs: 1_000,
    })
    const bootstrapMcpService = new McpSettingsService({
      storagePath: mcpSettingsPath,
      secretCodec: codec,
      clientManager: bootstrapMcpManager,
    })
    const mcpServer = await bootstrapMcpService.saveServer({
      id: 'startup-readiness-mcp',
      name: 'Startup readiness MCP',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [stdioFixturePath],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_FIXTURE_LIFECYCLE_PATH: {
            operation: 'replace',
            value: lifecyclePath,
          },
          MCP_FIXTURE_STARTUP_GATE_PATH: {
            operation: 'replace',
            value: startupGatePath,
          },
          MCP_FIXTURE_STARTUP_WAITING_PATH: {
            operation: 'replace',
            value: startupWaitingPath,
          },
        },
      },
    })
    await bootstrapMcpService.validateServer(mcpServer.id, {
      stdioTrustAcknowledged: true,
    })
    const bootstrapMcpPid = bootstrapMcpManager.getSnapshot(mcpServer.id)?.processId
    assert.ok(bootstrapMcpPid)
    await waitFor(
      () => hasLifecycleEvent(lifecyclePath, 'ready', bootstrapMcpPid),
      'the initial real MCP fixture connection',
    )
    await bootstrapMcpService.closeAll()
    await waitFor(
      () => hasLifecycleEvent(lifecyclePath, 'stopped', bootstrapMcpPid),
      'the initial MCP fixture process to stop',
    )
    fs.rmSync(startupGatePath, { force: true })
    fs.rmSync(startupWaitingPath, { force: true })

    // Clear the bootstrap service's process-global registration so only the
    // service passed to startApiServer can republish this provider.
    setConfiguredProviderConnections([])
    const runtimeProviderService = new ProviderSettingsService({
      storagePath: providerSettingsPath,
      secretCodec: codec,
    })
    const runtimeMcpManager = new McpClientManager({
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 3_000,
      closeTimeoutMs: 1_000,
    })
    const runtimeMcpService = new McpSettingsService({
      storagePath: mcpSettingsPath,
      secretCodec: codec,
      clientManager: runtimeMcpManager,
    })
    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({
      title: 'Startup readiness queue',
    })
    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: 'startup-readiness-workflow',
      brief: 'Do not grant this task until every startup dependency is ready.',
    })
    assert.ok(task)
    const pendingAdmission: Extract<TaskAdmission, { phase: 'pending' }> = {
      version: 1,
      phase: 'pending',
      requestId: 'startup-readiness-pending-request',
      order: '1',
      requestedAt: new Date().toISOString(),
      executionKind: 'initial',
      source: 'startup_repair',
      expectedExecutionAttemptId: null,
    }
    const seeded = await sessionStore.compareAndSetTaskRecord(
      session.id,
      task.id,
      ['queued'],
      { admission: pendingAdmission },
      { expectedExecutionAttemptId: null },
    )
    assert.equal(seeded?.updated, true)

    const launcher = new ReadinessObservingLauncher(
      providerName,
      `${providerFixture.url}/v1`,
      mcpServer.id,
      runtimeMcpManager,
      lifecyclePath,
    )
    let server: StartedApiServer | null = null
    let startup: Promise<StartedApiServer> | null = null

    try {
      startup = startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher,
        taskLauncher: launcher,
        sessionStore,
        repoRootPath: repoRoot,
        workspacePath,
        providerSettingsService: runtimeProviderService,
        mcpSettingsService: runtimeMcpService,
      })

      let reconnectingMcpPid: number | undefined
      await waitFor(
        () => {
          reconnectingMcpPid = readPublishedProcessId(startupWaitingPath)
          return reconnectingMcpPid !== undefined
        },
        'the real MCP reconnect to reach its startup barrier',
      )
      assert.ok(reconnectingMcpPid)
      assert.ok(Number.isInteger(reconnectingMcpPid) && reconnectingMcpPid > 0)
      assert.notEqual(reconnectingMcpPid, bootstrapMcpPid)
      assert.equal(runtimeMcpManager.isConnected(mcpServer.id), false)

      const hydratedProvider = getConfiguredProviderConnection(providerName)
      assert.equal(hydratedProvider?.baseUrl, `${providerFixture.url}/v1`)
      assert.equal(hydratedProvider?.apiKey, 'startup-readiness-key')

      await assertTaskStillPending(sessionStore, session.id, task.id)
      assert.equal(launcher.callCount, 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      await assertTaskStillPending(sessionStore, session.id, task.id)
      assert.equal(launcher.callCount, 0)

      fs.writeFileSync(startupGatePath, 'open', 'utf8')
      server = await startup
      await waitFor(
        () => launcher.observation !== null && launcher.providerResult !== null,
        'the first queued task launch after startup readiness',
      )

      const observation = launcher.observation
      assert.ok(observation)
      assert.equal(observation.providerBaseUrl, `${providerFixture.url}/v1`)
      assert.equal(observation.mcpConnected, true)
      assert.equal(observation.mcpPid, reconnectingMcpPid)
      assert.equal(observation.mcpReady, true)
      assert.equal(launcher.providerResult, 'startup-provider-ready')
      assert.equal(providerFixture.chatRequests(), 1)

      const current = await sessionStore.getTaskRecord(session.id, task.id)
      assert.ok(current)
      assert.equal(current.admission?.phase, 'granted')
      assert.equal(current.executionAttemptNumber, 1)
      assert.equal(launcher.callCount, 1)
      const readyEvent = readLifecycle(lifecyclePath).find(
        (event) =>
          event.event === 'ready' && event.pid === reconnectingMcpPid,
      )
      assert.ok(readyEvent)
      assert.ok(
        Date.parse(current.admission.grantedAt) >= Date.parse(readyEvent.timestamp),
        'The first durable grant must not predate the real MCP ready event',
      )
      assert.ok(
        observation.observedAt >= Date.parse(readyEvent.timestamp),
        'The launcher must not run before the real MCP ready event',
      )
    } finally {
      fs.writeFileSync(startupGatePath, 'open', 'utf8')
      if (!server && startup) server = await startup.catch(() => null)
      await server?.close().catch(() => undefined)
      await runtimeMcpService.closeAll().catch(() => undefined)
      await bootstrapMcpService.closeAll().catch(() => undefined)
      setConfiguredProviderConnections([])
      await providerFixture.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

async function assertTaskStillPending(
  sessionStore: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
): Promise<void> {
  const task = await sessionStore.getTaskRecord(sessionId, taskId)
  assert.ok(task)
  assert.equal(task.status, 'queued')
  assert.equal(task.admission?.phase, 'pending')
  assert.equal(task.admission.requestId, 'startup-readiness-pending-request')
  assert.equal(task.executionAttemptId, undefined)
  assert.equal(task.attemptStartedAt, undefined)
}

function readLifecycle(filePath: string): LifecycleEvent[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LifecycleEvent)
}

function hasLifecycleEvent(
  filePath: string,
  event: LifecycleEvent['event'],
  pid: number,
): boolean {
  return readLifecycle(filePath).some(
    (entry) => entry.event === event && entry.pid === pid,
  )
}

function readPublishedProcessId(markerPath: string): number | undefined {
  if (!fs.existsSync(markerPath)) return undefined
  // Another process can observe the file between open and writeFileSync's write.
  const processId = Number(fs.readFileSync(markerPath, 'utf8'))
  return Number.isInteger(processId) && processId > 0 ? processId : undefined
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function startProviderFixture(): Promise<{
  url: string
  chatRequests(): number
  close(): Promise<void>
}> {
  let chatRequests = 0
  const server = createServer((request, response) => {
    if (
      request.method === 'GET' &&
      request.url === '/v1/models' &&
      request.headers.authorization === 'Bearer startup-readiness-key'
    ) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        data: [{ id: 'fixture/chat-model', name: 'Fixture Chat Model' }],
      }))
      return
    }
    if (
      request.method === 'POST' &&
      request.url === '/v1/chat/completions' &&
      request.headers.authorization === 'Bearer startup-readiness-key'
    ) {
      chatRequests += 1
      void readRequestBody(request).then((body) => {
        const payload = JSON.parse(body) as { model?: string }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          model: payload.model,
          choices: [{ message: { content: 'startup-provider-ready' } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }))
      })
      return
    }
    response.statusCode = 401
    response.end(JSON.stringify({ error: 'unauthorized' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    chatRequests: () => chatRequests,
    close: () => closeServer(server),
  }
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}
import { whenDefined } from '../../core/optional-properties.js'
