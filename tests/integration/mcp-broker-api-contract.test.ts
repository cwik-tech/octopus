import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  hostAuditedParallelReadEffect,
  serialCapabilityEffect,
} from '../../contracts/capability-effect.js'
import type { CapabilityDispatchEvent } from '../../contracts/capability-dispatch.js'
import type { McpConnectionSnapshot } from '../../domains/mcp/mcp-client-manager.js'
import type {
  McpAuditEventInput,
  McpAuditEventView,
  McpToolResultEvidenceView,
} from '../../domains/mcp/mcp-evidence-store.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import {
  CapabilityDispatchLifecycleCoordinator,
  UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
} from '../../services/capability-dispatch-lifecycle.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerCallRequest,
  type McpBrokerRequestContext,
  type McpNamespacedTool,
  type McpRunLeaseClaims,
} from '../../domains/mcp/mcp-runtime.js'
import type { McpServerView } from '../../domains/mcp/mcp-settings.js'
import {
  McpApprovalCoordinator,
  type McpApprovalCoordinatorDecision,
  type McpApprovalCoordinatorRequest,
} from '../../domains/mcp/mcp-approval-coordinator.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

const nowMs = Date.parse('2026-07-12T18:00:00.000Z')

function auditEventView(
  event: McpAuditEventInput,
  sequence: number,
): McpAuditEventView {
  return {
    version: 1,
    eventId: `test-audit-${sequence}`,
    type: event.type,
    status: event.type,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    runId: event.runId,
    assignmentId: event.assignmentId,
    agentPath: event.agentPath,
    serverId: event.serverId,
  }
}

function context(
  requestId: string,
  overrides: Partial<McpBrokerRequestContext> = {},
): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId,
    leaseId: 'lease-contract',
    sessionId: 'session-contract',
    runId: 'run-contract',
    assignmentId: 'assignment-contract',
    agentPath: 'agents/tool-user',
    ...overrides,
  }
}

function lease(requestContext: McpBrokerRequestContext): McpRunLeaseClaims {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    audience: 'mcp-broker',
    leaseId: requestContext.leaseId,
    sessionId: requestContext.sessionId,
    runId: requestContext.runId,
    assignmentId: requestContext.assignmentId,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    allowedAgentPaths: [requestContext.agentPath],
  }
}

function serverView(id: string): McpServerView {
  return {
    id,
    name: `${id} tools`,
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: 'stdio',
      command: 'node',
      args: [],
      environmentKeys: [],
      hasSecrets: false,
    },
    status: 'connected',
    capabilities: { tools: { listChanged: false }, logging: false },
  }
}

function tool(
  serverId: string,
  namespacedName: string,
  toolName = 'contract-tool',
): McpNamespacedTool {
  return {
    serverId,
    serverName: `${serverId} tools`,
    toolName,
    namespacedName,
    inputSchema: {
      type: 'object',
      properties: { marker: { type: 'string' } },
      required: ['marker'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    risk: 'read-only',
    effect: serialCapabilityEffect('read-only'),
    requiresApproval: false,
  }
}

function snapshot(
  serverId: string,
  tools: readonly McpNamespacedTool[],
): McpConnectionSnapshot {
  return {
    serverId,
    serverName: `${serverId} tools`,
    capabilities: { tools: { listChanged: false }, logging: false },
    tools,
    resources: [],
    connectedAt: '2026-07-12T17:59:00.000Z',
  }
}

function toolResultEvidence(
  namespacedToolName: string,
): McpToolResultEvidenceView {
  return {
    evidencePath: 'evidence/mcp-result',
    record: {
      evidenceId: 'mcp_tool_result_completed_audit',
      kind: 'tool-result',
      sessionId: 'session-contract',
      runId: 'run-contract',
      assignmentId: 'assignment-contract',
      agentPath: 'agents/tool-user',
      serverId: 'server-a',
      recordedAt: new Date(nowMs).toISOString(),
      toolCallId: 'completed-audit-shared-call',
      namespacedToolName,
    },
    totalBytes: 16,
    aggregateHash: {
      algorithm: 'sha256',
      value: 'a'.repeat(64),
    },
    contents: [],
  }
}

function callRequest(
  requestId: string,
  namespacedToolName: string,
  overrides: Partial<McpBrokerRequestContext> = {},
): McpBrokerCallRequest {
  return {
    context: context(requestId, overrides),
    toolCallId: `call-${requestId}`,
    namespacedToolName,
    arguments: { marker: 'contract' },
  }
}

test('broker API omits ambiguous namespace mappings and refuses ambiguous calls', async () => {
  const collisionName = 'mcp__server-a__contract-tool'
  const snapshots = new Map([
    ['server-a', snapshot('server-a', [
      tool('server-a', collisionName),
      tool('server-a', collisionName),
    ])],
  ])
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: {
      listServers: async () => [serverView('server-a')],
    },
    clientManager: {
      getSnapshot: (serverId) => snapshots.get(serverId) ?? null,
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })

  const listed = await broker.listTools({ context: context('collision-list') })
  assert.equal(listed.contractVersion, MCP_RUNTIME_CONTRACT_VERSION)
  assert.equal(listed.authorizedServerCount, 1)
  assert.deepEqual(listed.tools, [])
  assert.deepEqual(listed.errors.map((error) => error.code), ['protocol_error'])

  const called = await broker.callTool(callRequest('collision-call', collisionName))
  assert.equal(called.isError, true)
  assert.equal(called.error?.code, 'protocol_error')
  assert.deepEqual(called.content, [])
  assert.equal(managerCalls, 0)
})

test('broker API refuses new calls as cancelled after lifecycle shutdown begins', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  const lifecycle = new CapabilityDispatchLifecycleCoordinator()
  lifecycle.beginShutdown()
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle,
    settingsService: {
      listServers: async () => [serverView('server-a')],
    },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })

  const result = await broker.callTool(callRequest('shutdown-call', namespacedName))

  assert.equal(result.isError, true)
  assert.equal(result.error?.code, 'cancelled')
  assert.equal(result.error?.retryable, false)
  assert.equal(managerCalls, 0)
})

test('broker API fails closed before MCP transport when durable journal authority is unavailable', async (t) => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-broker-journal-unavailable-'),
  )
  const journals = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'tenant-mcp-contract',
    mode: 'authoritative',
    // Drive the real registry's storage-open failure deterministically.
    journalOpener: async () => {
      throw new Error('journal unavailable')
    },
  })
  t.after(async () => {
    await journals.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  })
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    durable: (input) => journals.resolve(input),
    settingsService: {
      listServers: async () => [serverView('server-a')],
    },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })

  const result = await broker.callTool(
    callRequest('journal-unavailable', namespacedName),
  )

  assert.equal(result.isError, true)
  assert.equal(result.error?.code, 'internal')
  assert.equal(result.error?.retryable, true)
  assert.equal(managerCalls, 0)
})

test('broker API re-interns cloned effects and rejects cloned parallel authority', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const sourceTool: McpNamespacedTool = {
    ...tool('server-a', namespacedName),
    effect: hostAuditedParallelReadEffect(),
  }
  const serverSnapshot = snapshot('server-a', [sourceTool])
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: {
      listServers: async () => [serverView('server-a')],
    },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => ({ content: [] }),
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })

  const listed = await broker.listTools({ context: context('effect-list') })

  assert.equal(listed.tools.length, 1)
  assert.strictEqual(
    listed.tools[0]?.effect,
    serialCapabilityEffect('read-only'),
  )
  assert.equal(Object.isFrozen(listed.tools[0]?.effect), true)
})

test('broker API sanitizes resolver and server errors without returning raw values', async () => {
  const rawSecret = 'raw-server-error-secret-bc31'
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  const settingsService = { listServers: async () => [serverView('server-a')] }
  const clientManager = {
    getSnapshot: () => serverSnapshot,
    callTool: async () => ({
      isError: true,
      content: [{ type: 'text', text: rawSecret }],
      _meta: { credential: rawSecret },
    }),
  }
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService,
    clientManager,
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })

  const toolFailure = await broker.callTool(callRequest('server-error', namespacedName))
  assert.equal(toolFailure.error?.code, 'tool_failed')
  assert.deepEqual(toolFailure.content, [])
  assert.doesNotMatch(JSON.stringify(toolFailure), new RegExp(rawSecret))

  const resolverSecret = 'resolver-internal-secret-f105'
  const brokenGrantBroker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService,
    clientManager,
    grantResolver: () => {
      throw new Error(resolverSecret)
    },
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })
  const grantFailure = await brokenGrantBroker.callTool(
    callRequest('grant-error', namespacedName),
  )
  assert.equal(grantFailure.error?.code, 'internal')
  assert.doesNotMatch(JSON.stringify(grantFailure), new RegExp(resolverSecret))

  const brokenLeaseBroker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService,
    clientManager,
    grantResolver: () => true,
    leaseResolver: () => {
      throw new Error(resolverSecret)
    },
    now: () => new Date(nowMs),
  })
  const leaseFailure = await brokenLeaseBroker.listTools({
    context: context('lease-error'),
  })
  assert.deepEqual(leaseFailure.errors.map((error) => error.code), ['internal'])
  assert.doesNotMatch(JSON.stringify(leaseFailure), new RegExp(resolverSecret))
})

test('broker API normalizes non-text JSON output and bounds tracked run state', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return {
          content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
          structuredContent: { z: 2, a: true },
          _meta: { ignored: true },
        }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    limits: { maxTrackedRuns: 1 },
    now: () => new Date(nowMs),
  })

  const first = await broker.callTool(callRequest('json-output', namespacedName))
  assert.equal(first.isError, false)
  assert.deepEqual(first.content, [
    {
      type: 'json',
      value: { data: 'aW1hZ2U=', mimeType: 'image/png', type: 'image' },
    },
    { type: 'json', value: { a: true, z: 2 } },
  ])

  const blockedRun = await broker.callTool(callRequest(
    'blocked-run',
    namespacedName,
    { runId: 'run-other' },
  ))
  assert.equal(blockedRun.error?.code, 'result_too_large')
  assert.equal(managerCalls, 1)

  broker.releaseRun({
    sessionId: 'session-contract',
    runId: 'run-contract',
    assignmentId: 'assignment-contract',
    leaseId: 'lease-contract',
  })
  const releasedCapacity = await broker.callTool(callRequest(
    'released-run',
    namespacedName,
    { runId: 'run-other' },
  ))
  assert.equal(releasedCapacity.isError, false)
  assert.equal(managerCalls, 2)
})

test('broker API returns sanitized contract failures for malformed runtime inputs', async () => {
  const inputSecret = 'malformed-request-secret-7e12'
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [] },
    clientManager: {
      getSnapshot: () => null,
      callTool: async () => ({ content: [] }),
    },
    grantResolver: () => true,
    leaseResolver: () => null,
    now: () => new Date(nowMs),
  })

  const malformedList = await broker.listTools({
    context: { ...context('ignored'), requestId: `${inputSecret}\n` },
  } as unknown as Parameters<McpParentBroker['listTools']>[0])
  assert.equal(malformedList.requestId, 'invalid-request')
  assert.deepEqual(malformedList.errors.map((error) => error.code), ['invalid_request'])

  const malformedCall = await broker.callTool({
    context: context('malformed-call'),
    toolCallId: `${inputSecret}\n`,
    namespacedToolName: 'not-namespaced',
    arguments: { secret: inputSecret },
  } as unknown as McpBrokerCallRequest)
  assert.equal(malformedCall.toolCallId, 'invalid-tool-call')
  assert.equal(malformedCall.error?.code, 'invalid_request')
  assert.doesNotMatch(JSON.stringify([malformedList, malformedCall]), new RegExp(inputSecret))
})

test('broker deadline and cancellation cover lease, grant, and transport boundaries', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  const settingsService = { listServers: async () => [serverView('server-a')] }
  const connectedManager = {
    getSnapshot: () => serverSnapshot,
    callTool: async () => new Promise<never>(() => undefined),
  }

  const hangingLease = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService,
    clientManager: connectedManager,
    grantResolver: () => true,
    leaseResolver: () => new Promise<never>(() => undefined),
    limits: { perCallTimeoutMs: 25 },
    now: () => new Date(nowMs),
  })
  const leaseTimeout = await hangingLease.callTool(
    callRequest('lease-timeout', namespacedName, { runId: 'run-lease-timeout' }),
  )
  assert.equal(leaseTimeout.error?.code, 'timeout')

  const grantController = new AbortController()
  const hangingGrant = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService,
    clientManager: connectedManager,
    grantResolver: () => new Promise<never>(() => undefined),
    leaseResolver: (requestContext) => lease(requestContext),
    limits: { perCallTimeoutMs: 1_000 },
    now: () => new Date(nowMs),
  })
  const grantCall = hangingGrant.callTool(
    callRequest('grant-cancel', namespacedName, { runId: 'run-grant-cancel' }),
    { signal: grantController.signal },
  )
  setTimeout(() => grantController.abort(), 10)
  assert.equal((await grantCall).error?.code, 'cancelled')

  const hangingTransport = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService,
    clientManager: connectedManager,
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    limits: { perCallTimeoutMs: 25 },
    approvalWaitTimeoutMs: 25,
    now: () => new Date(nowMs),
  })
  const transportTimeout = await hangingTransport.callTool(
    callRequest('transport-timeout', namespacedName, { runId: 'run-transport-timeout' }),
  )
  assert.equal(transportTimeout.error?.code, 'timeout')
})

test('broker API rejects oversized schemas and list payloads before exposing tools', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const oversizedTool: McpNamespacedTool = {
    ...tool('server-a', namespacedName),
    inputSchema: {
      type: 'object',
      description: 'schema-padding'.repeat(100),
    },
  }
  let managerCalls = 0
  const settingsService = { listServers: async () => [serverView('server-a')] }
  const schemaBroker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService,
    clientManager: {
      getSnapshot: () => snapshot('server-a', [oversizedTool]),
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    limits: { maxSchemaBytes: 64 },
    now: () => new Date(nowMs),
  })

  const schemaList = await schemaBroker.listTools({ context: context('schema-list') })
  assert.deepEqual(schemaList.tools, [])
  assert.deepEqual(schemaList.errors.map((error) => error.code), ['protocol_error'])
  const schemaCall = await schemaBroker.callTool(
    callRequest('schema-call', namespacedName, { runId: 'run-schema-call' }),
  )
  assert.equal(schemaCall.error?.code, 'protocol_error')
  assert.equal(managerCalls, 0)

  const listBroker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService,
    clientManager: {
      getSnapshot: () => snapshot('server-a', [tool('server-a', namespacedName)]),
      callTool: async () => ({ content: [] }),
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    limits: { maxOutputBytes: 32 },
    now: () => new Date(nowMs),
  })
  const oversizedList = await listBroker.listTools({ context: context('oversized-list') })
  assert.deepEqual(oversizedList.tools, [])
  assert.deepEqual(oversizedList.errors.map((error) => error.code), ['result_too_large'])
})

test('approval-blocked leaders retain MCP admission while identical followers coalesce before capacity checks', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const riskyTool: McpNamespacedTool = {
    ...tool('server-a', namespacedName),
    annotations: { readOnlyHint: false },
    risk: 'mutating',
    effect: serialCapabilityEffect('mutating'),
    requiresApproval: true,
  }
  const serverSnapshot = snapshot('server-a', [riskyTool])
  let managerCalls = 0
  let announceApproval!: () => void
  const approvalStarted = new Promise<void>((resolve) => {
    announceApproval = resolve
  })
  let approve!: () => void
  const approvalGate = new Promise<void>((resolve) => {
    approve = resolve
  })
  const approvalCoordinator = {
    requestApproval: async (
      input: McpApprovalCoordinatorRequest,
    ): Promise<McpApprovalCoordinatorDecision> => {
      const pending = {
        interactionId: 'interaction-admission',
        kind: 'approval' as const,
        sessionId: input.context.sessionId,
        runId: input.context.runId,
        assignmentId: input.context.assignmentId,
        agentPath: input.context.agentPath,
        serverId: input.serverId,
        namespacedToolName: input.namespacedToolName,
        toolCallId: input.toolCallId,
        toolRisk: input.toolRisk,
        argumentNames: ['marker'],
        status: 'pending' as const,
        createdAt: '2026-07-12T18:00:00.000Z',
        expiresAt: '2026-07-12T18:01:00.000Z',
      }
      await input.onInteraction?.(pending)
      announceApproval()
      await approvalGate
      return {
        outcome: 'approved',
        interaction: {
          ...pending,
          status: 'approved-once',
          resolvedAt: '2026-07-12T18:00:01.000Z',
          decision: 'approve',
          approvalScope: 'once',
        },
        reused: false,
      }
    },
  }
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return { content: [{ type: 'text', text: 'approved' }] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    approvalCoordinator,
    limits: { maxConcurrentCallsPerRun: 1 },
    now: () => new Date(nowMs),
  })
  const leaderRequest: McpBrokerCallRequest = {
    ...callRequest('approval-leader', namespacedName),
    toolCallId: 'shared-approval-call',
  }

  const leader = broker.callTool(leaderRequest)
  await approvalStarted
  const conflicting = await broker.callTool({
    ...leaderRequest,
    context: context('approval-conflict'),
    arguments: { marker: 'changed' },
  })
  const overCapacity = await broker.callTool({
    ...callRequest('approval-capacity', namespacedName),
    toolCallId: 'distinct-approval-call',
  })
  const follower = broker.callTool({
    ...leaderRequest,
    context: context('approval-follower'),
  })

  assert.equal(conflicting.error?.code, 'invalid_request')
  assert.equal(overCapacity.error?.code, 'result_too_large')
  assert.equal(managerCalls, 0)
  approve()
  const [leaderResult, followerResult] = await Promise.all([leader, follower])
  assert.equal(leaderResult.isError, false)
  assert.equal(followerResult.isError, false)
  assert.equal(followerResult.requestId, 'approval-follower')
  assert.equal(managerCalls, 1)
})

test('releasing an MCP run during approval keeps its capacity until the admitted leader settles', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const safeNamespacedName = 'mcp__server-a__safe-contract-tool'
  const riskyTool: McpNamespacedTool = {
    ...tool('server-a', namespacedName),
    annotations: { readOnlyHint: false },
    risk: 'mutating',
    effect: serialCapabilityEffect('mutating'),
    requiresApproval: true,
  }
  let announceApproval!: () => void
  const approvalStarted = new Promise<void>((resolve) => {
    announceApproval = resolve
  })
  let approve!: () => void
  const approvalGate = new Promise<void>((resolve) => {
    approve = resolve
  })
  const approvalCoordinator = {
    requestApproval: async (
      input: McpApprovalCoordinatorRequest,
    ): Promise<McpApprovalCoordinatorDecision> => {
      const pending = {
        interactionId: 'interaction-release-pending',
        kind: 'approval' as const,
        sessionId: input.context.sessionId,
        runId: input.context.runId,
        assignmentId: input.context.assignmentId,
        agentPath: input.context.agentPath,
        serverId: input.serverId,
        namespacedToolName: input.namespacedToolName,
        toolCallId: input.toolCallId,
        toolRisk: input.toolRisk,
        argumentNames: ['marker'],
        status: 'pending' as const,
        createdAt: '2026-07-12T18:00:00.000Z',
        expiresAt: '2026-07-12T18:01:00.000Z',
      }
      await input.onInteraction?.(pending)
      announceApproval()
      await approvalGate
      return {
        outcome: 'approved',
        interaction: {
          ...pending,
          status: 'approved-once',
          resolvedAt: '2026-07-12T18:00:01.000Z',
          decision: 'approve',
          approvalScope: 'once',
        },
        reused: false,
      }
    },
  }
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => snapshot('server-a', [
        riskyTool,
        tool('server-a', safeNamespacedName, 'safe-contract-tool'),
      ]),
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    approvalCoordinator,
    limits: { maxTrackedRuns: 1 },
    now: () => new Date(nowMs),
  })
  const leaderRequest = callRequest('release-pending-leader', namespacedName)

  const leader = broker.callTool(leaderRequest)
  await approvalStarted
  broker.releaseRun({
    sessionId: leaderRequest.context.sessionId,
    runId: leaderRequest.context.runId,
    assignmentId: leaderRequest.context.assignmentId,
    leaseId: leaderRequest.context.leaseId,
  })
  const blockedWhilePending = await broker.callTool(callRequest(
    'release-pending-other-run',
    safeNamespacedName,
    { runId: 'run-after-release' },
  ))

  assert.equal(blockedWhilePending.error?.code, 'result_too_large')
  assert.equal(managerCalls, 0)
  approve()
  assert.equal((await leader).isError, false)

  const admittedAfterSettlement = await broker.callTool(callRequest(
    'release-settled-other-run',
    safeNamespacedName,
    { runId: 'run-after-release' },
  ))
  assert.equal(admittedAfterSettlement.isError, false)
  assert.equal(managerCalls, 2)
})

test('an approved durable interaction fails closed when its resolution audit cannot be appended', async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-resolution-audit-failure-'),
  )
  const scope = {
    sessionId: 'session-contract',
    runId: 'run-contract',
    assignmentId: 'assignment-contract',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })

  const namespacedName = 'mcp__server-a__contract-tool'
  const riskyTool: McpNamespacedTool = {
    ...tool('server-a', namespacedName),
    annotations: { readOnlyHint: false },
    risk: 'mutating',
    effect: serialCapabilityEffect('mutating'),
    requiresApproval: true,
  }
  const coordinator = new McpApprovalCoordinator({
    workspacePath,
    pollIntervalMs: 5,
  })
  const attemptedAuditTypes: McpAuditEventInput['type'][] = []
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => snapshot('server-a', [riskyTool]),
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    approvalCoordinator: coordinator,
    evidenceStoreFactory: () => ({
      appendAuditEvent: async (event: McpAuditEventInput) => {
        attemptedAuditTypes.push(event.type)
        if (event.type === 'mcp.approval.resolved') {
          throw new Error('injected approval resolution audit failure')
        }
        return auditEventView(event, attemptedAuditTypes.length)
      },
      importToolResultEvidence: async () => {
        throw new Error('transport result evidence must remain unreachable')
      },
    }),
    now: () => new Date(nowMs),
  })
  const request = callRequest('resolution-audit-failure', namespacedName)

  try {
    const waiting = broker.callTool(request)
    const interaction = await waitForPendingApproval(
      coordinator,
      scope,
      request.toolCallId,
    )
    await coordinator.respond(scope, {
      interactionId: interaction.interactionId,
      responseId: 'resolution-audit-response',
      decision: 'approve',
      scope: 'once',
    })

    const result = await waiting
    assert.equal(result.error?.code, 'internal')
    assert.equal(managerCalls, 0)
    assert.deepEqual(attemptedAuditTypes, [
      'mcp.tool.requested',
      'mcp.approval.requested',
      'mcp.approval.resolved',
    ])
    assert.equal(
      (await coordinator.get(scope, interaction.interactionId))?.status,
      'approved-once',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an approval-request audit failure cancels the exact durable interaction before transport', async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-request-audit-failure-'),
  )
  const scope = {
    sessionId: 'session-contract',
    runId: 'run-contract',
    assignmentId: 'assignment-contract',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })

  const namespacedName = 'mcp__server-a__contract-tool'
  const riskyTool: McpNamespacedTool = {
    ...tool('server-a', namespacedName),
    annotations: { readOnlyHint: false },
    risk: 'mutating',
    effect: serialCapabilityEffect('mutating'),
    requiresApproval: true,
  }
  const coordinator = new McpApprovalCoordinator({
    workspacePath,
    pollIntervalMs: 5,
  })
  const attemptedAuditTypes: McpAuditEventInput['type'][] = []
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => snapshot('server-a', [riskyTool]),
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    approvalCoordinator: coordinator,
    evidenceStoreFactory: () => ({
      appendAuditEvent: async (event: McpAuditEventInput) => {
        attemptedAuditTypes.push(event.type)
        if (event.type === 'mcp.approval.requested') {
          throw new Error('injected approval request audit failure')
        }
        return auditEventView(event, attemptedAuditTypes.length)
      },
      importToolResultEvidence: async () => {
        throw new Error('transport result evidence must remain unreachable')
      },
    }),
    now: () => new Date(nowMs),
  })
  const request = callRequest('request-audit-failure', namespacedName)
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 100)

  try {
    const result = await broker.callTool(request, { signal: controller.signal })
    const interaction = (await coordinator.list(scope)).find(
      (candidate) => candidate.toolCallId === request.toolCallId,
    )

    assert.equal(result.error?.code, 'internal')
    assert.equal(managerCalls, 0)
    assert.deepEqual(attemptedAuditTypes, [
      'mcp.tool.requested',
      'mcp.approval.requested',
      'mcp.tool.failed',
    ])
    assert.equal(interaction?.status, 'cancelled')
  } finally {
    clearTimeout(abortTimer)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('canonical MCP arguments coalesce across recursive key ordering', async () => {
  const namespacedName = 'mcp__server-a__canonical-tool'
  const canonicalTool: McpNamespacedTool = {
    ...tool('server-a', namespacedName, 'canonical-tool'),
    inputSchema: {
      type: 'object',
      properties: {
        marker: { type: 'string' },
        nested: {
          type: 'object',
          properties: {
            alpha: { type: 'number' },
            beta: { type: 'number' },
          },
          required: ['alpha', 'beta'],
          additionalProperties: false,
        },
      },
      required: ['marker', 'nested'],
      additionalProperties: false,
    },
  }
  const serverSnapshot = snapshot('server-a', [canonicalTool])
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })
  const first: McpBrokerCallRequest = {
    context: context('canonical-first'),
    toolCallId: 'canonical-shared-call',
    namespacedToolName: namespacedName,
    arguments: { marker: 'same', nested: { beta: 2, alpha: 1 } },
  }
  const reordered: McpBrokerCallRequest = {
    ...first,
    context: context('canonical-reordered'),
    arguments: { nested: { alpha: 1, beta: 2 }, marker: 'same' },
  }

  const [firstResult, reorderedResult] = await Promise.all([
    broker.callTool(first),
    broker.callTool(reordered),
  ])

  assert.equal(firstResult.isError, false)
  assert.equal(reorderedResult.isError, false)
  assert.equal(reorderedResult.requestId, 'canonical-reordered')
  assert.equal(managerCalls, 1)
})

test('an identical follower cancellation never aborts its admitted leader', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  let managerCalls = 0
  let announceTransport!: () => void
  const transportStarted = new Promise<void>((resolve) => {
    announceTransport = resolve
  })
  let finishTransport!: () => void
  const transportGate = new Promise<void>((resolve) => {
    finishTransport = resolve
  })
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        announceTransport()
        await transportGate
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })
  const leaderRequest: McpBrokerCallRequest = {
    ...callRequest('follower-leader', namespacedName),
    toolCallId: 'follower-shared-call',
  }

  const leader = broker.callTool(leaderRequest)
  await transportStarted
  const followerController = new AbortController()
  const follower = broker.callTool(
    {
      ...leaderRequest,
      context: context('follower-cancelled'),
    },
    { signal: followerController.signal },
  )
  followerController.abort()

  assert.equal((await follower).error?.code, 'cancelled')
  finishTransport()
  assert.equal((await leader).isError, false)
  assert.equal(managerCalls, 1)
})

test('caller cancellation after transport fulfillment does not discard bounded MCP settlement', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  let leaseChecks = 0
  let announceSettlement!: () => void
  const settlementStarted = new Promise<void>((resolve) => {
    announceSettlement = resolve
  })
  let finishSettlement!: () => void
  const settlementGate = new Promise<void>((resolve) => {
    finishSettlement = resolve
  })
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return { content: [{ type: 'text', text: 'committed-result' }] }
      },
    },
    grantResolver: () => true,
    leaseResolver: async (requestContext) => {
      leaseChecks += 1
      if (leaseChecks === 3) {
        announceSettlement()
        await settlementGate
      }
      return lease(requestContext)
    },
    now: () => new Date(nowMs),
  })
  const controller = new AbortController()

  const pending = broker.callTool(
    callRequest('cancel-after-result', namespacedName),
    { signal: controller.signal },
  )
  await settlementStarted
  controller.abort()
  finishSettlement()
  const result = await pending

  assert.equal(result.isError, false)
  assert.deepEqual(result.content, [
    { type: 'text', text: 'committed-result' },
  ])
  assert.equal(managerCalls, 1)
  assert.equal(leaseChecks, 3)
})

test('a completed-audit failure after transport is retained and never executes the MCP call twice', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  const attemptedAuditTypes: McpAuditEventInput['type'][] = []
  let managerCalls = 0
  const evidence = toolResultEvidence(namespacedName)
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return { content: [{ type: 'text', text: 'committed-result' }] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    evidenceStoreFactory: () => ({
      appendAuditEvent: async (event: McpAuditEventInput) => {
        attemptedAuditTypes.push(event.type)
        if (event.type === 'mcp.tool.completed') {
          throw new Error('injected completed audit failure')
        }
        return auditEventView(event, attemptedAuditTypes.length)
      },
      importToolResultEvidence: async () => evidence,
    }),
    now: () => new Date(nowMs),
  })
  const firstRequest: McpBrokerCallRequest = {
    ...callRequest('completed-audit-first', namespacedName),
    toolCallId: 'completed-audit-shared-call',
  }

  const first = await broker.callTool(firstRequest)
  const replay = await broker.callTool({
    ...firstRequest,
    context: context('completed-audit-replay'),
  })

  assert.equal(first.error?.code, 'internal')
  assert.equal(replay.error?.code, 'internal')
  assert.equal(replay.requestId, 'completed-audit-replay')
  assert.equal(managerCalls, 1)
  assert.deepEqual(attemptedAuditTypes, [
    'mcp.tool.requested',
    'mcp.tool.started',
    'mcp.tool.completed',
  ])
})

test('a common terminal-evidence failure after transport returns retained internal and never executes twice', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  const attemptedDispatchEvents: CapabilityDispatchEvent[] = []
  let managerCalls = 0
  const evidence = toolResultEvidence(namespacedName)
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return { content: [{ type: 'text', text: 'committed-result' }] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    evidenceStoreFactory: () => ({
      appendAuditEvent: async (event: McpAuditEventInput) =>
        auditEventView(event, 1),
      importToolResultEvidence: async () => evidence,
    }),
    capabilityEvidence: {
      append: (event) => {
        attemptedDispatchEvents.push(event)
        if (event.type === 'capability.dispatch.completed') {
          throw new Error('injected common terminal evidence failure')
        }
      },
    },
    now: () => new Date(nowMs),
  })
  const firstRequest: McpBrokerCallRequest = {
    ...callRequest('common-terminal-first', namespacedName),
    toolCallId: 'common-terminal-shared-call',
  }

  const first = await broker.callTool(firstRequest)
  const replay = await broker.callTool({
    ...firstRequest,
    context: context('common-terminal-replay'),
  })

  assert.equal(first.error?.code, 'internal')
  assert.equal(replay.error?.code, 'internal')
  assert.equal(replay.requestId, 'common-terminal-replay')
  assert.equal(managerCalls, 1)
  assert.deepEqual(
    attemptedDispatchEvents.map((event) => event.type),
    [
      'capability.dispatch.requested',
      'capability.dispatch.started',
      'capability.dispatch.completed',
    ],
  )
  assert.equal(
    new Set(attemptedDispatchEvents.map((event) => event.dispatchId)).size,
    1,
  )
  assert.equal(attemptedDispatchEvents[0]?.sourceKind, 'mcp')
  assert.equal(attemptedDispatchEvents[0]?.sourceId, 'mcp-parent-broker')
  assert.equal(
    attemptedDispatchEvents.filter(
      (event) => event.type === 'capability.dispatch.completed',
    ).length,
    1,
  )
})

test('post-result authority revocation wins inside an acquired completion fence', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  const serverSnapshot = snapshot('server-a', [tool('server-a', namespacedName)])
  const guardController = new AbortController()
  let revocationCode: 'grant_required' | null = null
  let fencesAcquired = 0
  let fencesReleased = 0
  let leaseChecks = 0
  let announceSettlement!: () => void
  const settlementStarted = new Promise<void>((resolve) => {
    announceSettlement = resolve
  })
  let finishSettlement!: () => void
  const settlementGate = new Promise<void>((resolve) => {
    finishSettlement = resolve
  })
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: {
      listServers: async () => [serverView('server-a')],
      getAuthorizationGuard: () => ({
        signal: guardController.signal,
        getRevocationCode: () => revocationCode,
        beginCompletion: () => {
          fencesAcquired += 1
          return {
            release: () => {
              fencesReleased += 1
            },
          }
        },
      }),
    },
    clientManager: {
      getSnapshot: () => serverSnapshot,
      callTool: async () => {
        managerCalls += 1
        return { content: [{ type: 'text', text: 'must-not-be-accepted' }] }
      },
    },
    grantResolver: () => true,
    leaseResolver: async (requestContext) => {
      leaseChecks += 1
      if (leaseChecks === 3) {
        announceSettlement()
        await settlementGate
      }
      return lease(requestContext)
    },
    now: () => new Date(nowMs),
  })

  const waiting = broker.callTool(
    callRequest('revoke-after-result', namespacedName),
  )
  await settlementStarted
  revocationCode = 'grant_required'
  guardController.abort()
  finishSettlement()
  const result = await waiting

  assert.equal(result.error?.code, 'grant_required')
  assert.deepEqual(result.content, [])
  assert.equal(managerCalls, 1)
  assert.equal(fencesAcquired, 1)
  assert.equal(fencesReleased, 1)
})

test('cached MCP results are refused after the authorized tool descriptor changes', async () => {
  const namespacedName = 'mcp__server-a__contract-tool'
  let currentTool = tool('server-a', namespacedName)
  let managerCalls = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: { listServers: async () => [serverView('server-a')] },
    clientManager: {
      getSnapshot: () => snapshot('server-a', [currentTool]),
      callTool: async () => {
        managerCalls += 1
        return { content: [] }
      },
    },
    grantResolver: () => true,
    leaseResolver: (requestContext) => lease(requestContext),
    now: () => new Date(nowMs),
  })
  const request: McpBrokerCallRequest = {
    ...callRequest('descriptor-first', namespacedName),
    toolCallId: 'descriptor-shared-call',
  }

  assert.equal((await broker.callTool(request)).isError, false)
  currentTool = {
    ...currentTool,
    annotations: { ...currentTool.annotations, destructiveHint: true },
    risk: 'destructive',
    effect: serialCapabilityEffect('destructive'),
    requiresApproval: true,
  }
  const replay = await broker.callTool({
    ...request,
    context: context('descriptor-replay'),
  })

  assert.equal(replay.error?.code, 'tool_not_found')
  assert.equal(managerCalls, 1)
})

async function waitForPendingApproval(
  coordinator: McpApprovalCoordinator,
  scope: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
  },
  toolCallId: string,
) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const interaction = (await coordinator.list(scope)).find(
      (candidate) =>
        candidate.toolCallId === toolCallId && candidate.status === 'pending',
    )
    if (interaction) return interaction
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for approval ${toolCallId}`)
}
