import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_MCP_APPROVAL_WAIT_TIMEOUT_MS,
  McpApprovalCoordinator,
} from '../../domains/mcp/mcp-approval-coordinator.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpEvidenceStore } from '../../domains/mcp/mcp-evidence-store.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerCallRequest,
  type McpBrokerRequestContext,
  type McpJsonObject,
  type McpRunLeaseClaims,
} from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import {
  McpSettingsService,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'

const repoRoot = process.cwd()
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'mcp')
const nowMs = Date.parse('2026-07-12T18:00:00.000Z')

const codec: McpSecretCodec = {
  encrypt(value) {
    return Buffer.from(
      Buffer.from(value, 'utf8').map((byte) => byte ^ 0x71),
    ).toString('base64')
  },
  decrypt(value) {
    return Buffer.from(
      Buffer.from(value, 'base64').map((byte) => byte ^ 0x71),
    ).toString('utf8')
  },
}

interface HttpFixture {
  readonly child: ChildProcess
  readonly pid: number
  readonly url: string
}

function createWorkspace(prefix: string): { directory: string; storagePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { directory, storagePath: path.join(directory, 'mcp-settings.json') }
}

function brokerContext(
  requestId: string,
  overrides: Partial<McpBrokerRequestContext> = {},
): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId,
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/tool-user',
    ...overrides,
  }
}

function activeLease(
  context: McpBrokerRequestContext,
  expiresAtMs = nowMs + 60_000,
): McpRunLeaseClaims {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    audience: 'mcp-broker',
    leaseId: context.leaseId,
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs,
    allowedAgentPaths: [context.agentPath],
  }
}

function toolCall(
  requestId: string,
  toolCallId: string,
  namespacedToolName: string,
  argumentsValue: McpJsonObject,
  contextOverrides: Partial<McpBrokerRequestContext> = {},
): McpBrokerCallRequest {
  return {
    context: brokerContext(requestId, contextOverrides),
    toolCallId,
    namespacedToolName,
    arguments: argumentsValue,
  }
}

async function configureStdioServer(
  service: McpSettingsService,
  serverId = 'stdio-tools',
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const secretEnvironment = Object.fromEntries(
    Object.entries({
      MCP_FIXTURE_TEST_SECRET: 'broker-stdio-secret-8a21',
      ...environment,
    }).map(([key, value]) => [key, { operation: 'replace' as const, value }]),
  )
  await service.saveServer({
    id: serverId,
    name: 'Local tools',
    transport: {
      type: 'stdio',
      command: 'node',
      args: [path.join(fixtureRoot, 'stdio-server.mjs')],
      cwd: repoRoot,
      secretEnvironment,
    },
  })
  await service.validateServer(serverId, { stdioTrustAcknowledged: true })
}

async function startHttpFixture(): Promise<HttpFixture> {
  const child = spawn(
    process.execPath,
    [path.join(fixtureRoot, 'streamable-http-server.mjs')],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  if (!child.stdout) throw new Error('HTTP fixture stdout is unavailable')
  const ready = await Promise.race([
    new Promise<{ pid: number; url: string }>((resolve, reject) => {
      let buffered = ''
      const onExit = () => reject(new Error(`HTTP fixture exited early: ${stderr}`))
      const onData = (chunk: Buffer | string) => {
        buffered += String(chunk)
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        try {
          const message = JSON.parse(buffered.slice(0, newline)) as {
            type?: string
            pid?: number
            url?: string
          }
          if (
            message.type === 'ready' &&
            typeof message.pid === 'number' &&
            typeof message.url === 'string'
          ) {
            child.stdout?.off('data', onData)
            child.off('exit', onExit)
            resolve({ pid: message.pid, url: message.url })
          }
        } catch (error) {
          reject(error)
        }
      }
      child.stdout?.on('data', onData)
      child.once('exit', onExit)
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error('HTTP fixture readiness timed out')),
        3_000,
      ).unref()
    }),
  ])
  return { child, pid: ready.pid, url: ready.url }
}

async function stopChild(fixture: HttpFixture): Promise<void> {
  if (!isProcessAlive(fixture.pid)) return
  fixture.child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => fixture.child.once('exit', () => resolve())),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 3_000).unref()
    }),
  ])
  if (isProcessAlive(fixture.pid)) fixture.child.kill('SIGKILL')
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

function createAssignment(
  workspacePath: string,
  scope: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
  },
): string {
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  return location.assignmentPath
}

async function waitForApproval(
  coordinator: McpApprovalCoordinator,
  scope: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
  },
  toolCallId: string,
) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const interaction = (await coordinator.list(scope)).find(
      (candidate) =>
        candidate.toolCallId === toolCallId && candidate.status === 'pending',
    )
    if (interaction) return interaction
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for approval ${toolCallId}`)
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

test('parent broker lists and calls only globally active, effectively granted real MCP tools', { timeout: 15_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-parent-broker-')
  const manager = new McpClientManager({ connectTimeoutMs: 3_000, requestTimeoutMs: 3_000 })
  const service = new McpSettingsService({ storagePath, secretCodec: codec, clientManager: manager })
  const httpFixture = await startHttpFixture()
  const grants = new Set(['stdio-tools'])
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: service,
    clientManager: manager,
    grantResolver: ({ serverId }) => grants.has(serverId),
    leaseResolver: (context) => activeLease(context),
    now: () => new Date(nowMs),
  })

  try {
    await configureStdioServer(service)
    await service.saveServer({
      id: 'http-tools',
      name: 'Remote tools',
      transport: {
        type: 'streamable-http',
        url: httpFixture.url,
        secretHeaders: {
          Authorization: {
            operation: 'replace',
            value: 'Bearer broker-http-secret-5c10',
          },
        },
      },
    })
    await service.validateServer('http-tools')

    const stdioOnly = await broker.listTools({ context: brokerContext('list-1') })
    assert.equal(stdioOnly.authorizedServerCount, 1)
    assert.deepEqual(stdioOnly.tools.map((tool) => tool.namespacedName), [
      'mcp__stdio-tools__echo-marker',
    ])
    assert.deepEqual(stdioOnly.errors, [])

    const called = await broker.callTool(toolCall(
      'call-request-1',
      'tool-call-1',
      'mcp__stdio-tools__echo-marker',
      { marker: 'broker-stdio' },
    ))
    assert.equal(called.isError, false)
    assert.deepEqual(called.content, [
      { type: 'text', text: 'echo-marker:broker-stdio' },
    ])
    assert.deepEqual(called.attachments, [])
    assert.deepEqual(called.evidence, [])

    grants.add('http-tools')
    const both = await broker.listTools({ context: brokerContext('list-2') })
    assert.equal(both.authorizedServerCount, 2)
    assert.deepEqual(both.tools.map((tool) => tool.namespacedName), [
      'mcp__http-tools__echo-marker',
      'mcp__stdio-tools__echo-marker',
    ])

    const httpCalled = await broker.callTool(toolCall(
      'call-request-2',
      'tool-call-2',
      'mcp__http-tools__echo-marker',
      { marker: 'broker-http' },
    ))
    assert.equal(httpCalled.isError, false)
    assert.deepEqual(httpCalled.content, [
      { type: 'text', text: 'echo-marker:broker-http' },
    ])

    await service.setServerEnabled('http-tools', false)
    const afterDisable = await broker.listTools({ context: brokerContext('list-3') })
    assert.equal(afterDisable.authorizedServerCount, 1)
    assert.deepEqual(afterDisable.tools.map((tool) => tool.serverId), ['stdio-tools'])

    const serialized = JSON.stringify([stdioOnly, called, both, httpCalled, afterDisable])
    assert.doesNotMatch(serialized, /broker-(stdio|http)-secret/)
    assert.doesNotMatch(serialized, /ciphertext|Authorization/)
  } finally {
    await service.closeAll()
    await stopChild(httpFixture)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('parent broker provides exact-once calls and rechecks grants and leases before execution and cache access', { timeout: 12_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-broker-exact-once-')
  const manager = new McpClientManager({ connectTimeoutMs: 3_000 })
  const service = new McpSettingsService({ storagePath, secretCodec: codec, clientManager: manager })
  let managerCalls = 0
  let isGranted = true
  let leaseExpiry = nowMs + 60_000
  const instrumentedManager = {
    getSnapshot: manager.getSnapshot.bind(manager),
    callTool: async (...parameters: Parameters<McpClientManager['callTool']>) => {
      managerCalls += 1
      return manager.callTool(...parameters)
    },
  }
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: service,
    clientManager: instrumentedManager,
    grantResolver: () => isGranted,
    leaseResolver: (context) => activeLease(context, leaseExpiry),
    now: () => new Date(nowMs),
  })

  try {
    await configureStdioServer(service)
    const firstRequest = toolCall(
      'exact-request-1',
      'exact-call-1',
      'mcp__stdio-tools__echo-marker',
      { marker: 'exact-once' },
    )
    const [first, retry] = await Promise.all([
      broker.callTool(firstRequest),
      broker.callTool({
        ...firstRequest,
        context: { ...firstRequest.context, requestId: 'exact-request-2' },
      }),
    ])
    assert.equal(first.isError, false)
    assert.deepEqual(retry.content, first.content)
    assert.equal(retry.requestId, 'exact-request-2')
    assert.equal(managerCalls, 1)

    const mutableFirstContent = first.content as unknown[]
    mutableFirstContent.push({ type: 'text', text: 'caller mutation' })
    const immutableRetry = await broker.callTool({
      ...firstRequest,
      context: { ...firstRequest.context, requestId: 'exact-request-immutable' },
    })
    assert.deepEqual(immutableRetry.content, [
      { type: 'text', text: 'echo-marker:exact-once' },
    ])
    assert.equal(managerCalls, 1)

    const changedArguments = await broker.callTool({
      ...firstRequest,
      context: { ...firstRequest.context, requestId: 'exact-request-3' },
      arguments: { marker: 'changed' },
    })
    assert.equal(changedArguments.error?.code, 'invalid_request')
    assert.equal(managerCalls, 1)

    isGranted = false
    const revokedCache = await broker.callTool({
      ...firstRequest,
      context: { ...firstRequest.context, requestId: 'exact-request-4' },
    })
    assert.equal(revokedCache.error?.code, 'grant_required')
    assert.deepEqual(revokedCache.content, [])
    assert.equal(managerCalls, 1)

    isGranted = true
    leaseExpiry = nowMs - 1
    const expiredCache = await broker.callTool({
      ...firstRequest,
      context: { ...firstRequest.context, requestId: 'exact-request-5' },
    })
    assert.equal(expiredCache.error?.code, 'lease_expired')
    assert.equal(managerCalls, 1)

    leaseExpiry = nowMs + 60_000
    const invalidArguments = await broker.callTool(toolCall(
      'schema-request',
      'schema-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 42 },
    ))
    assert.equal(invalidArguments.error?.code, 'invalid_request')
    assert.equal(managerCalls, 1)

    let approvalManagerCalls = 0
    const approvalManager = {
      getSnapshot: (serverId: string) => {
        const current = manager.getSnapshot(serverId)
        return current
          ? {
              ...current,
              tools: current.tools.map((currentTool) => ({
                ...currentTool,
                annotations: { ...currentTool.annotations, readOnlyHint: false },
                risk: 'mutating' as const,
                requiresApproval: true,
              })),
            }
          : null
      },
      callTool: async (...parameters: Parameters<McpClientManager['callTool']>) => {
        approvalManagerCalls += 1
        return manager.callTool(...parameters)
      },
    }
    const approvalBroker = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: service,
      clientManager: approvalManager,
      grantResolver: () => true,
      leaseResolver: (requestContext) => activeLease(requestContext),
      now: () => new Date(nowMs),
    })
    const approvalRequired = await approvalBroker.callTool(toolCall(
      'approval-request',
      'approval-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'must-not-run' },
      { runId: 'run-approval' },
    ))
    assert.equal(approvalRequired.error?.code, 'approval_required')
    assert.equal(approvalManagerCalls, 0)

    let grantChecks = 0
    const grantRevokedBetweenChecks = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: service,
      clientManager: instrumentedManager,
      grantResolver: () => {
        grantChecks += 1
        return grantChecks === 1
      },
      leaseResolver: (context) => activeLease(context),
      now: () => new Date(nowMs),
    })
    const freshGrantResult = await grantRevokedBetweenChecks.callTool(toolCall(
      'fresh-grant-request',
      'fresh-grant-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'must-not-run' },
      { runId: 'run-fresh-grant' },
    ))
    assert.equal(freshGrantResult.error?.code, 'grant_required')
    assert.equal(managerCalls, 1)

    let leaseChecks = 0
    const leaseRevokedBetweenChecks = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: service,
      clientManager: instrumentedManager,
      grantResolver: () => true,
      leaseResolver: (context) => {
        leaseChecks += 1
        return leaseChecks === 1 ? activeLease(context) : null
      },
      now: () => new Date(nowMs),
    })
    const freshLeaseResult = await leaseRevokedBetweenChecks.callTool(toolCall(
      'fresh-lease-request',
      'fresh-lease-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'must-not-run' },
      { runId: 'run-fresh-lease' },
    ))
    assert.equal(freshLeaseResult.error?.code, 'lease_invalid')
    assert.equal(managerCalls, 1)
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('parent broker enforces output, aggregate, call-count, concurrency, timeout, and cancellation limits', { timeout: 15_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-broker-limits-')
  const manager = new McpClientManager({ connectTimeoutMs: 3_000 })
  const service = new McpSettingsService({ storagePath, secretCodec: codec, clientManager: manager })
  let managerCalls = 0
  const instrumentedManager = {
    getSnapshot: manager.getSnapshot.bind(manager),
    callTool: async (...parameters: Parameters<McpClientManager['callTool']>) => {
      managerCalls += 1
      return manager.callTool(...parameters)
    },
  }
  const baseOptions = {
    settingsService: service,
    clientManager: instrumentedManager,
    grantResolver: () => true,
    leaseResolver: (context: McpBrokerRequestContext) => activeLease(context),
    now: () => new Date(nowMs),
  }

  try {
    await configureStdioServer(service)

    const outputLimited = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      ...baseOptions,
      limits: { maxOutputBytes: 16 },
    })
    const tooLarge = await outputLimited.callTool(toolCall(
      'output-request',
      'output-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'output-limit' },
      { runId: 'run-output' },
    ))
    assert.equal(tooLarge.error?.code, 'result_too_large')

    const aggregateLimited = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      ...baseOptions,
      limits: { maxOutputBytes: 1_000, maxOutputBytesPerRun: 100 },
    })
    const aggregateFirst = await aggregateLimited.callTool(toolCall(
      'aggregate-request-1',
      'aggregate-call-1',
      'mcp__stdio-tools__echo-marker',
      { marker: 'aggregate-first' },
      { runId: 'run-aggregate' },
    ))
    const aggregateSecond = await aggregateLimited.callTool(toolCall(
      'aggregate-request-2',
      'aggregate-call-2',
      'mcp__stdio-tools__echo-marker',
      { marker: 'aggregate-second' },
      { runId: 'run-aggregate' },
    ))
    assert.equal(aggregateFirst.isError, false)
    assert.equal(aggregateSecond.error?.code, 'result_too_large')

    const callLimited = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      ...baseOptions,
      limits: { maxCallsPerRun: 1 },
    })
    const callFirst = await callLimited.callTool(toolCall(
      'count-request-1',
      'count-call-1',
      'mcp__stdio-tools__echo-marker',
      { marker: 'first' },
      { runId: 'run-count' },
    ))
    const callsBeforeLimit = managerCalls
    const callSecond = await callLimited.callTool(toolCall(
      'count-request-2',
      'count-call-2',
      'mcp__stdio-tools__echo-marker',
      { marker: 'second' },
      { runId: 'run-count' },
    ))
    assert.equal(callFirst.isError, false)
    assert.equal(callSecond.error?.code, 'result_too_large')
    assert.equal(managerCalls, callsBeforeLimit)

    let releaseDelayedCall: (() => void) | undefined
    let delayedCalls = 0
    let receivedTimeout: number | undefined
    let receivedSignal: AbortSignal | undefined
    const delayedManager = {
      getSnapshot: manager.getSnapshot.bind(manager),
      callTool: async (...parameters: Parameters<McpClientManager['callTool']>) => {
        delayedCalls += 1
        receivedSignal = parameters[2]?.signal
        receivedTimeout = parameters[2]?.timeoutMs
        await new Promise<void>((resolve) => {
          releaseDelayedCall = resolve
        })
        return manager.callTool(...parameters)
      },
    }
    const concurrentLimited = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      ...baseOptions,
      clientManager: delayedManager,
      limits: { maxConcurrentCallsPerRun: 1, perCallTimeoutMs: 321 },
    })
    const controller = new AbortController()
    const pending = concurrentLimited.callTool(toolCall(
      'concurrent-request-1',
      'concurrent-call-1',
      'mcp__stdio-tools__echo-marker',
      { marker: 'pending' },
      { runId: 'run-concurrent' },
    ), { signal: controller.signal })
    await waitForCondition(() => delayedCalls === 1, 'first delayed broker call')
    const rejectedConcurrent = await concurrentLimited.callTool(toolCall(
      'concurrent-request-2',
      'concurrent-call-2',
      'mcp__stdio-tools__echo-marker',
      { marker: 'concurrent' },
      { runId: 'run-concurrent' },
    ))
    assert.equal(rejectedConcurrent.error?.code, 'result_too_large')
    assert.equal(
      receivedTimeout,
      DEFAULT_MCP_APPROVAL_WAIT_TIMEOUT_MS + 321,
    )
    assert.ok(receivedSignal)
    assert.equal(receivedSignal.aborted, false)
    releaseDelayedCall?.()
    assert.equal((await pending).isError, false)

    const cancelledController = new AbortController()
    cancelledController.abort()
    const callsBeforeCancellation = managerCalls
    const cancelled = await concurrentLimited.callTool(toolCall(
      'cancel-request',
      'cancel-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'cancelled' },
      { runId: 'run-cancelled' },
    ), { signal: cancelledController.signal })
    assert.equal(cancelled.error?.code, 'cancelled')
    assert.equal(managerCalls, callsBeforeCancellation)
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('parent broker waits for exact approval, calls a real MCP once, and records redacted immutable evidence', { timeout: 15_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-broker-approval-')
  const callsPath = path.join(directory, 'fixture-calls.jsonl')
  const lifecyclePath = path.join(directory, 'fixture-lifecycle.jsonl')
  const assignmentPath = createAssignment(directory, {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  const manager = new McpClientManager({ connectTimeoutMs: 3_000 })
  const service = new McpSettingsService({
    storagePath,
    secretCodec: codec,
    clientManager: manager,
  })
  let managerCalls = 0
  const riskyManager = {
    getSnapshot: (serverId: string) => {
      const current = manager.getSnapshot(serverId)
      return current
        ? {
            ...current,
            tools: current.tools.map((tool) => ({
              ...tool,
              annotations: { ...tool.annotations, readOnlyHint: false },
              risk: 'mutating' as const,
              requiresApproval: true,
            })),
          }
        : null
    },
    callTool: async (...parameters: Parameters<McpClientManager['callTool']>) => {
      managerCalls += 1
      return manager.callTool(...parameters)
    },
  }
  const coordinator = new McpApprovalCoordinator({
    workspacePath: directory,
    pollIntervalMs: 5,
  })
  const evidenceStore = new McpEvidenceStore({
    workspacePath: directory,
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    now: () => new Date(nowMs),
  })
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: service,
    clientManager: riskyManager,
    grantResolver: () => true,
    leaseResolver: (context) => activeLease(context),
    approvalCoordinator: coordinator,
    approvalWaitTimeoutMs: 2_000,
    evidenceStoreFactory: () => evidenceStore,
    now: () => new Date(nowMs),
  })
  const privateMarker = 'approval-argument-value-28c1'
  const firstRequest = toolCall(
    'approval-execute-request',
    'approval-execute-call',
    'mcp__stdio-tools__echo-marker',
    { marker: privateMarker },
  )

  try {
    await configureStdioServer(service, 'stdio-tools', {
      MCP_FIXTURE_CALLS_PATH: callsPath,
      MCP_FIXTURE_LIFECYCLE_PATH: lifecyclePath,
    })
    const invalidSchema = await broker.callTool(toolCall(
      'approval-invalid-schema-request',
      'approval-invalid-schema-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 42 },
    ))
    assert.equal(invalidSchema.error?.code, 'invalid_request')
    assert.equal(managerCalls, 0)
    assert.deepEqual(await evidenceStore.listAuditEvents(), [])

    const waiting = broker.callTool(firstRequest)
    const pending = await waitForApproval(coordinator, {
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    }, firstRequest.toolCallId)
    assert.equal(managerCalls, 0)
    assert.deepEqual(readJsonLines(callsPath), [])
    assert.equal('argumentsHash' in pending, false)
    assert.deepEqual(
      (await evidenceStore.listAuditEvents()).map((event) => event.type),
      ['mcp.tool.requested', 'mcp.approval.requested'],
    )

    await coordinator.respond({
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    }, {
      interactionId: pending.interactionId,
      responseId: 'approval-execute-response',
      decision: 'approve',
      scope: 'once',
    })
    const result = await waiting
    assert.equal(result.isError, false)
    assert.deepEqual(result.content, [
      { type: 'text', text: `echo-marker:${privateMarker}` },
    ])
    assert.equal(managerCalls, 1)
    assert.equal(readJsonLines(callsPath).length, 1)
    assert.equal(result.evidence.length, 1)
    assert.equal(result.evidence[0]?.kind, 'tool-result')

    const evidence = await evidenceStore.listToolResultEvidence()
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0]?.record.evidenceId, result.evidence[0]?.evidenceId)
    const content = evidence[0]?.contents[0]
    assert.ok(content)
    const contentPath = path.join(
      evidence[0]!.evidencePath,
      ...content.storedPath.split('/'),
    )
    assert.equal(
      fs.readFileSync(contentPath, 'utf8'),
      `echo-marker:${privateMarker}`,
    )
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(contentPath).mode & 0o222, 0)
    }

    const events = await evidenceStore.listAuditEvents()
    assert.deepEqual(events.map((event) => event.type), [
      'mcp.tool.requested',
      'mcp.approval.requested',
      'mcp.approval.resolved',
      'mcp.tool.started',
      'mcp.tool.completed',
    ])
    assert.deepEqual(events[0]?.argumentNames, ['marker'])
    assert.match(events[0]?.argumentsHash?.value ?? '', /^[a-f0-9]{64}$/)
    assert.equal(events[4]?.resultByteCount, Buffer.byteLength(
      `echo-marker:${privateMarker}`,
    ))
    assert.match(events[4]?.resultHash?.value ?? '', /^[a-f0-9]{64}$/)
    assert.equal(events.every((event) => !('requestId' in event)), true)

    const rawAudit = fs.readFileSync(
      path.join(assignmentPath, 'mcp', 'audit', 'events.jsonl'),
      'utf8',
    )
    for (const forbidden of [
      privateMarker,
      `echo-marker:${privateMarker}`,
      'broker-stdio-secret-8a21',
      'MCP_FIXTURE_TEST_SECRET',
      path.join(fixtureRoot, 'stdio-server.mjs'),
      'Authorization',
      'http://',
      'https://',
    ]) {
      assert.equal(rawAudit.includes(forbidden), false)
    }

    const replay = await broker.callTool({
      ...firstRequest,
      context: { ...firstRequest.context, requestId: 'approval-replay-request' },
    })
    assert.equal(replay.isError, false)
    assert.equal(replay.requestId, 'approval-replay-request')
    assert.equal(managerCalls, 1)
    assert.equal(readJsonLines(callsPath).length, 1)

    const runApprovalRequest = toolCall(
      'run-approval-request',
      'run-approval-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'run-approved-marker' },
    )
    const runWaiting = broker.callTool(runApprovalRequest)
    const runPending = await waitForApproval(coordinator, {
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    }, runApprovalRequest.toolCallId)
    await coordinator.respond({
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    }, {
      interactionId: runPending.interactionId,
      responseId: 'run-approval-response',
      decision: 'approve',
      scope: 'run',
    })
    assert.equal((await runWaiting).isError, false)

    const runReuse = await broker.callTool(toolCall(
      'run-reuse-request',
      'run-reuse-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'run-approved-marker' },
    ))
    assert.equal(runReuse.isError, false)
    assert.equal(managerCalls, 3)
    assert.equal(
      (await coordinator.list({
        sessionId: 'session-1',
        runId: 'run-1',
        assignmentId: 'assignment-1',
      })).length,
      2,
    )

    const changedController = new AbortController()
    const changedArguments = toolCall(
      'run-changed-request',
      'run-changed-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'changed-run-argument' },
    )
    const changedWaiting = broker.callTool(changedArguments, {
      signal: changedController.signal,
    })
    await waitForApproval(coordinator, {
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    }, changedArguments.toolCallId)
    assert.equal(managerCalls, 3)
    changedController.abort()
    assert.equal((await changedWaiting).error?.code, 'cancelled')
    const completeAudit = fs.readFileSync(
      path.join(assignmentPath, 'mcp', 'audit', 'events.jsonl'),
      'utf8',
    )
    for (const argumentValue of [
      privateMarker,
      'run-approved-marker',
      'changed-run-argument',
    ]) {
      assert.equal(completeAudit.includes(argumentValue), false)
    }
  } finally {
    await service.closeAll()
    const pids = new Set(
      readJsonLines(lifecyclePath)
        .map((event) => event.pid)
        .filter((pid): pid is number => typeof pid === 'number'),
    )
    for (const pid of pids) {
      await waitForCondition(() => !isProcessAlive(pid), `fixture ${pid} stop`)
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('approval denial, cancellation, timeout, revocation, and disable never reach the real MCP transport', { timeout: 15_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-broker-denials-')
  const callsPath = path.join(directory, 'fixture-calls.jsonl')
  const lifecyclePath = path.join(directory, 'fixture-lifecycle.jsonl')
  const scope = {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  }
  const assignmentPath = createAssignment(directory, scope)
  const manager = new McpClientManager({ connectTimeoutMs: 3_000 })
  const service = new McpSettingsService({
    storagePath,
    secretCodec: codec,
    clientManager: manager,
  })
  let managerCalls = 0
  let granted = true
  const riskyManager = {
    getSnapshot: (serverId: string) => {
      const current = manager.getSnapshot(serverId)
      return current
        ? {
            ...current,
            tools: current.tools.map((tool) => ({
              ...tool,
              annotations: { ...tool.annotations, readOnlyHint: false },
              risk: 'mutating' as const,
              requiresApproval: true,
            })),
          }
        : null
    },
    callTool: async (...parameters: Parameters<McpClientManager['callTool']>) => {
      managerCalls += 1
      return manager.callTool(...parameters)
    },
  }
  const coordinator = new McpApprovalCoordinator({
    workspacePath: directory,
    pollIntervalMs: 5,
  })
  const evidenceStore = new McpEvidenceStore({
    workspacePath: directory,
    ...scope,
    now: () => new Date(nowMs),
  })
  const brokerOptions = {
    settingsService: service,
    clientManager: riskyManager,
    grantResolver: () => granted,
    leaseResolver: (context: McpBrokerRequestContext) => activeLease(context),
    approvalCoordinator: coordinator,
    evidenceStoreFactory: () => evidenceStore,
    now: () => new Date(nowMs),
  }
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    ...brokerOptions,
    approvalWaitTimeoutMs: 1_000,
  })

  try {
    await configureStdioServer(service, 'stdio-tools', {
      MCP_FIXTURE_CALLS_PATH: callsPath,
      MCP_FIXTURE_LIFECYCLE_PATH: lifecyclePath,
    })

    const deniedRequest = toolCall(
      'denied-request',
      'denied-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'denied-private-value' },
    )
    const deniedWaiting = broker.callTool(deniedRequest)
    const denied = await waitForApproval(
      coordinator,
      scope,
      deniedRequest.toolCallId,
    )
    assert.equal(managerCalls, 0)
    await coordinator.respond(scope, {
      interactionId: denied.interactionId,
      responseId: 'denied-response',
      decision: 'deny',
    })
    assert.equal((await deniedWaiting).error?.code, 'approval_denied')

    const cancelledController = new AbortController()
    const cancelledRequest = toolCall(
      'approval-cancelled-request',
      'approval-cancelled-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'cancelled-private-value' },
    )
    const cancelledWaiting = broker.callTool(cancelledRequest, {
      signal: cancelledController.signal,
    })
    await waitForApproval(coordinator, scope, cancelledRequest.toolCallId)
    cancelledController.abort()
    assert.equal((await cancelledWaiting).error?.code, 'cancelled')

    const timeoutBroker = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      ...brokerOptions,
      approvalWaitTimeoutMs: 35,
    })
    const timedOut = await timeoutBroker.callTool(toolCall(
      'approval-timeout-request',
      'approval-timeout-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'timeout-private-value' },
      { leaseId: 'lease-timeout' },
    ))
    assert.equal(timedOut.error?.code, 'timeout')

    const revokedRequest = toolCall(
      'approval-revoked-request',
      'approval-revoked-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'revoked-private-value' },
      { leaseId: 'lease-revoked' },
    )
    const revokedWaiting = broker.callTool(revokedRequest)
    const revoked = await waitForApproval(
      coordinator,
      scope,
      revokedRequest.toolCallId,
    )
    granted = false
    await coordinator.respond(scope, {
      interactionId: revoked.interactionId,
      responseId: 'revoked-response',
      decision: 'approve',
      scope: 'once',
    })
    assert.equal((await revokedWaiting).error?.code, 'grant_required')

    granted = true
    const disabledRequest = toolCall(
      'approval-disabled-request',
      'approval-disabled-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'disabled-private-value' },
      { leaseId: 'lease-disabled' },
    )
    const disabledWaiting = broker.callTool(disabledRequest)
    const disabled = await waitForApproval(
      coordinator,
      scope,
      disabledRequest.toolCallId,
    )
    await service.setServerEnabled('stdio-tools', false)
    await coordinator.respond(scope, {
      interactionId: disabled.interactionId,
      responseId: 'disabled-response',
      decision: 'approve',
      scope: 'once',
    })
    assert.equal((await disabledWaiting).error?.code, 'server_disabled')

    assert.equal(managerCalls, 0)
    assert.deepEqual(readJsonLines(callsPath), [])
    assert.deepEqual(await evidenceStore.listToolResultEvidence(), [])
    const restartedEvidence = new McpEvidenceStore({
      workspacePath: directory,
      ...scope,
      now: () => new Date(nowMs),
    })
    const audit = await restartedEvidence.listAuditEvents()
    assert.equal(
      audit.filter((event) => event.type === 'mcp.approval.requested').length,
      5,
    )
    assert.equal(
      audit.filter((event) => event.type === 'mcp.approval.resolved').length,
      5,
    )
    assert.ok(audit.some((event) => event.type === 'mcp.tool.cancelled'))
    assert.ok(audit.some(
      (event) => event.type === 'mcp.tool.failed' &&
        event.errorCode === 'approval_denied',
    ))
    assert.ok(audit.some(
      (event) => event.type === 'mcp.tool.failed' &&
        event.errorCode === 'timeout',
    ))
    const rawAudit = fs.readFileSync(
      path.join(assignmentPath, 'mcp', 'audit', 'events.jsonl'),
      'utf8',
    )
    for (const value of [
      'denied-private-value',
      'cancelled-private-value',
      'timeout-private-value',
      'revoked-private-value',
      'disabled-private-value',
      'broker-stdio-secret-8a21',
    ]) {
      assert.equal(rawAudit.includes(value), false)
    }
  } finally {
    await service.closeAll()
    const pids = new Set(
      readJsonLines(lifecyclePath)
        .map((event) => event.pid)
        .filter((pid): pid is number => typeof pid === 'number'),
    )
    for (const pid of pids) {
      await waitForCondition(() => !isProcessAlive(pid), `fixture ${pid} stop`)
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('live cancellation and grant/global revocation stop real MCP calls before evidence and survive restart', { timeout: 20_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-live-revocation-')
  const callsPath = path.join(directory, 'calls.jsonl')
  const lifecyclePath = path.join(directory, 'lifecycle.jsonl')
  const toolStartedPath = path.join(directory, 'tool-started.pid')
  const toolGatePath = path.join(directory, 'tool-gate')
  const scope = {
    sessionId: 'session-1',
    runId: 'run-live-revocation',
    assignmentId: 'assignment-live-revocation',
  }
  createAssignment(directory, scope)
  const evidenceStore = new McpEvidenceStore({
    workspacePath: directory,
    ...scope,
    now: () => new Date(nowMs),
  })
  const manager = new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 5_000,
    closeTimeoutMs: 500,
  })
  const service = new McpSettingsService({
    storagePath,
    secretCodec: codec,
    clientManager: manager,
  })
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: service,
    clientManager: manager,
    grantResolver: ({ context, serverId }) =>
      service.isAgentGranted(context.agentPath, serverId),
    leaseResolver: (context) => activeLease(context),
    evidenceStoreFactory: () => evidenceStore,
    limits: { perCallTimeoutMs: 5_000 },
    now: () => new Date(nowMs),
  })
  let reloadedService: McpSettingsService | null = null

  const startBlockedCall = async (
    requestId: string,
    toolCallId: string,
    signal?: AbortSignal,
  ) => {
    fs.rmSync(toolStartedPath, { force: true })
    const pending = broker.callTool(toolCall(
      requestId,
      toolCallId,
      'mcp__stdio-tools__echo-marker',
      { marker: 'wait-for-lifecycle' },
      {
        runId: scope.runId,
        assignmentId: scope.assignmentId,
      },
    ), signal ? { signal } : {})
    await waitForCondition(
      () => fs.existsSync(toolStartedPath),
      `${toolCallId} transport start`,
    )
    return { pending }
  }

  try {
    await configureStdioServer(service, 'stdio-tools', {
      MCP_FIXTURE_CALLS_PATH: callsPath,
      MCP_FIXTURE_LIFECYCLE_PATH: lifecyclePath,
      MCP_FIXTURE_TOOL_STARTED_PATH: toolStartedPath,
      MCP_FIXTURE_TOOL_GATE_PATH: toolGatePath,
    })
    await service.setAgentGrant('agents/tool-user', 'stdio-tools', true)

    const cancellation = new AbortController()
    const cancelledCall = await startBlockedCall(
      'live-cancel-request',
      'live-cancel-call',
      cancellation.signal,
    )
    cancellation.abort()
    assert.equal((await cancelledCall.pending).error?.code, 'cancelled')

    const revokedCall = await startBlockedCall(
      'live-grant-request',
      'live-grant-call',
    )
    const revokeGrant = service.setAgentGrant(
      'agents/tool-user',
      'stdio-tools',
      false,
    )
    assert.equal((await revokedCall.pending).error?.code, 'grant_required')
    assert.equal((await revokeGrant).enabled, false)

    await service.setAgentGrant('agents/tool-user', 'stdio-tools', true)
    const disabledCall = await startBlockedCall(
      'live-disable-request',
      'live-disable-call',
    )
    const disableServer = service.setServerEnabled('stdio-tools', false)
    assert.equal((await disabledCall.pending).error?.code, 'server_disabled')
    assert.equal((await disableServer).status, 'disabled')

    assert.deepEqual(readJsonLines(callsPath), [])
    assert.deepEqual(await evidenceStore.listToolResultEvidence(), [])
    const audit = await evidenceStore.listAuditEvents()
    assert.equal(
      audit.some((event) => event.type === 'mcp.tool.completed'),
      false,
    )
    assert.equal(
      audit.filter((event) => event.type === 'mcp.tool.started').length,
      3,
    )
    assert.equal(
      audit.filter((event) => event.type === 'mcp.tool.cancelled').length,
      1,
    )
    assert.deepEqual(
      audit
        .filter((event) => event.type === 'mcp.tool.failed')
        .map((event) => event.errorCode)
        .sort(),
      ['grant_required', 'server_disabled'],
    )

    await service.closeAll()
    const reloadedManager = new McpClientManager({ connectTimeoutMs: 1_000 })
    reloadedService = new McpSettingsService({
      storagePath,
      secretCodec: codec,
      clientManager: reloadedManager,
    })
    await reloadedService.hydrate()
    assert.equal((await reloadedService.getServer('stdio-tools'))?.status, 'disabled')
    assert.equal(reloadedManager.isConnected('stdio-tools'), false)
    assert.equal(
      await reloadedService.isAgentGranted('agents/tool-user', 'stdio-tools'),
      true,
    )
    const restartedEvidence = new McpEvidenceStore({
      workspacePath: directory,
      ...scope,
    })
    assert.equal((await restartedEvidence.listAuditEvents()).length, audit.length)
    assert.deepEqual(await restartedEvidence.listToolResultEvidence(), [])
  } finally {
    fs.writeFileSync(toolGatePath, 'release', 'utf8')
    await reloadedService?.closeAll().catch(() => undefined)
    await service.closeAll().catch(() => undefined)
    for (const event of readJsonLines(lifecyclePath)) {
      const processId = event.pid
      if (typeof processId === 'number' && isProcessAlive(processId)) {
        process.kill(processId, 'SIGKILL')
      }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('parallel assignments and leases in one run keep independent limits, cache, and release state', { timeout: 12_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-broker-isolation-')
  const manager = new McpClientManager({ connectTimeoutMs: 3_000 })
  const service = new McpSettingsService({
    storagePath,
    secretCodec: codec,
    clientManager: manager,
  })
  const gates = new Map<string, () => void>()
  let managerCalls = 0
  const delayedManager = {
    getSnapshot: manager.getSnapshot.bind(manager),
    callTool: async (...parameters: Parameters<McpClientManager['callTool']>) => {
      managerCalls += 1
      const marker = String(parameters[1].arguments?.marker ?? '')
      if (marker === 'assignment-a' || marker === 'assignment-b') {
        await new Promise<void>((resolve) => gates.set(marker, resolve))
      }
      return manager.callTool(...parameters)
    },
  }
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: service,
    clientManager: delayedManager,
    grantResolver: () => true,
    leaseResolver: (context) => activeLease(context),
    limits: { maxCallsPerRun: 1, maxConcurrentCallsPerRun: 1 },
    now: () => new Date(nowMs),
  })
  const assignmentA = {
    runId: 'shared-run',
    assignmentId: 'assignment-a',
    leaseId: 'lease-a',
  }
  const assignmentB = {
    runId: 'shared-run',
    assignmentId: 'assignment-b',
    leaseId: 'lease-b',
  }

  try {
    await configureStdioServer(service)
    const pendingA = broker.callTool(toolCall(
      'isolation-request-a',
      'isolation-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'assignment-a' },
      assignmentA,
    ))
    const pendingB = broker.callTool(toolCall(
      'isolation-request-b',
      'isolation-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'assignment-b' },
      assignmentB,
    ))
    await waitForCondition(() => managerCalls === 2, 'isolated calls to start')

    broker.releaseRun({
      sessionId: 'session-1',
      ...assignmentA,
    })
    gates.get('assignment-a')?.()
    assert.equal((await pendingA).isError, false)
    gates.get('assignment-b')?.()
    assert.equal((await pendingB).isError, false)

    const bStillLimited = await broker.callTool(toolCall(
      'isolation-request-b-2',
      'isolation-call-2',
      'mcp__stdio-tools__echo-marker',
      { marker: 'assignment-b-again' },
      assignmentB,
    ))
    assert.equal(bStillLimited.error?.code, 'result_too_large')
    assert.equal(managerCalls, 2)

    const aReleased = await broker.callTool(toolCall(
      'isolation-request-a-2',
      'isolation-call-2',
      'mcp__stdio-tools__echo-marker',
      { marker: 'assignment-a-after-release' },
      assignmentA,
    ))
    assert.equal(aReleased.isError, false)
    assert.equal(managerCalls, 3)
  } finally {
    for (const release of gates.values()) release()
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('concurrent sessions and runs keep independent real-call limits and release state', { timeout: 12_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-session-run-isolation-')
  const callsPath = path.join(directory, 'calls.jsonl')
  const manager = new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
  })
  const service = new McpSettingsService({
    storagePath,
    secretCodec: codec,
    clientManager: manager,
  })
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: service,
    clientManager: manager,
    grantResolver: () => true,
    leaseResolver: (context) => activeLease(context),
    limits: { maxCallsPerRun: 1, maxConcurrentCallsPerRun: 1 },
    now: () => new Date(nowMs),
  })
  const scopes = [
    {
      sessionId: 'session-a',
      runId: 'shared-run',
      assignmentId: 'shared-assignment',
      leaseId: 'lease-a',
    },
    {
      sessionId: 'session-b',
      runId: 'shared-run',
      assignmentId: 'shared-assignment',
      leaseId: 'lease-b',
    },
    {
      sessionId: 'session-a',
      runId: 'other-run',
      assignmentId: 'shared-assignment',
      leaseId: 'lease-c',
    },
  ] as const

  try {
    await configureStdioServer(service, 'stdio-tools', {
      MCP_FIXTURE_CALLS_PATH: callsPath,
    })
    const initial = await Promise.all(scopes.map((scope, index) =>
      broker.callTool(toolCall(
        `session-run-request-${index}`,
        'shared-tool-call-id',
        'mcp__stdio-tools__echo-marker',
        { marker: `session-run-${index}` },
        scope,
      )),
    ))
    assert.deepEqual(initial.map((result) => result.isError), [false, false, false])
    assert.equal(readJsonLines(callsPath).length, 3)

    const sessionBStillLimited = await broker.callTool(toolCall(
      'session-b-limited-request',
      'session-b-second-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'session-b-limited' },
      scopes[1],
    ))
    assert.equal(sessionBStillLimited.error?.code, 'result_too_large')

    broker.releaseRun(scopes[0])
    const sessionAReleased = await broker.callTool(toolCall(
      'session-a-released-request',
      'session-a-second-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'session-a-released' },
      scopes[0],
    ))
    assert.equal(sessionAReleased.isError, false)
    assert.equal(readJsonLines(callsPath).length, 4)

    const otherRunStillLimited = await broker.callTool(toolCall(
      'other-run-limited-request',
      'other-run-second-call',
      'mcp__stdio-tools__echo-marker',
      { marker: 'other-run-limited' },
      scopes[2],
    ))
    assert.equal(otherRunStillLimited.error?.code, 'result_too_large')
    assert.equal(readJsonLines(callsPath).length, 4)
  } finally {
    await service.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
