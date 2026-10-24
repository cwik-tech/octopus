import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MCP_RUNTIME_CONTRACT_VERSION as CANONICAL_MCP_RUNTIME_CONTRACT_VERSION,
  normalizeMcpCapabilityName as canonicalNormalizeMcpCapabilityName,
  normalizeMcpCapabilityRequirement as canonicalNormalizeMcpCapabilityRequirement,
  type McpBrokerRequestContext as CanonicalMcpBrokerRequestContext,
  type McpJsonObject as CanonicalMcpJsonObject,
  type McpJsonPrimitive as CanonicalMcpJsonPrimitive,
  type McpJsonSchema as CanonicalMcpJsonSchema,
  type McpJsonValue as CanonicalMcpJsonValue,
} from '../../contracts/mcp.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import {
  MCP_ABSENT_AGENT_GRANT_ENABLED,
  MCP_NEW_SERVER_ENABLED_BY_DEFAULT,
  MCP_SETTINGS_SCHEMA_VERSION,
  isMcpServerGrantedToAgent,
  normalizeMcpCapabilityName as domainNormalizeMcpCapabilityName,
  normalizeMcpCapabilityAliases,
  normalizeMcpAgentPath,
  normalizeMcpServerInput,
  redactMcpServer,
  type McpServerSettings,
} from '../../domains/mcp/mcp-settings.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  MCP_RUNTIME_EVENT_TYPES,
  MCP_SANITIZED_ERROR_CODES,
  classifyMcpToolRisk,
  doMcpCapabilityAliasesSatisfyRequirement,
  doesMcpRunLeaseAllowAgent,
  isMcpRunLeaseActive,
  mcpToolRequiresApproval,
  namespaceMcpToolName,
  normalizeMcpCapabilityRequirement,
  resolveMcpCapabilityEffect,
  type McpApprovalInteraction,
  type McpApprovalResolution,
  type McpBrokerCallRequest,
  type McpBrokerRequestContext as DomainMcpBrokerRequestContext,
  type McpEvidenceRecord,
  type McpInteractionStatus,
  type McpJsonObject as DomainMcpJsonObject,
  type McpJsonPrimitive as DomainMcpJsonPrimitive,
  type McpJsonSchema as DomainMcpJsonSchema,
  type McpJsonValue as DomainMcpJsonValue,
  type McpProviderSupport,
  type McpResourceAttachment,
  type McpRunLeaseClaims,
  type McpWorkflowCapabilityRequirement,
} from '../../domains/mcp/mcp-runtime.js'

type IsBidirectionallyAssignable<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left]
      ? true
      : false
    : false

type Assert<T extends true> = T

type McpFoundationTypeCompatibility = readonly [
  Assert<IsBidirectionallyAssignable<
    typeof CANONICAL_MCP_RUNTIME_CONTRACT_VERSION,
    typeof MCP_RUNTIME_CONTRACT_VERSION
  >>,
  Assert<IsBidirectionallyAssignable<
    CanonicalMcpJsonPrimitive,
    DomainMcpJsonPrimitive
  >>,
  Assert<IsBidirectionallyAssignable<
    CanonicalMcpJsonValue,
    DomainMcpJsonValue
  >>,
  Assert<IsBidirectionallyAssignable<
    CanonicalMcpJsonObject,
    DomainMcpJsonObject
  >>,
  Assert<IsBidirectionallyAssignable<
    CanonicalMcpJsonSchema,
    DomainMcpJsonSchema
  >>,
  Assert<IsBidirectionallyAssignable<
    CanonicalMcpBrokerRequestContext,
    DomainMcpBrokerRequestContext
  >>,
  Assert<IsBidirectionallyAssignable<
    typeof canonicalNormalizeMcpCapabilityName,
    typeof domainNormalizeMcpCapabilityName
  >>,
  Assert<IsBidirectionallyAssignable<
    typeof canonicalNormalizeMcpCapabilityRequirement,
    typeof normalizeMcpCapabilityRequirement
  >>,
]

const mcpFoundationTypeCompatibility: McpFoundationTypeCompatibility = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
]

test('MCP foundation contract and domain paths are the same bindings and types', () => {
  assert.deepEqual(mcpFoundationTypeCompatibility, Array(8).fill(true))
  assert.strictEqual(
    MCP_RUNTIME_CONTRACT_VERSION,
    CANONICAL_MCP_RUNTIME_CONTRACT_VERSION,
  )
  assert.equal(CANONICAL_MCP_RUNTIME_CONTRACT_VERSION, 1)
  assert.strictEqual(
    domainNormalizeMcpCapabilityName,
    canonicalNormalizeMcpCapabilityName,
  )
  assert.strictEqual(
    normalizeMcpCapabilityRequirement,
    canonicalNormalizeMcpCapabilityRequirement,
  )
})

test('MCP settings default new servers on and keep secrets out of server views', () => {
  assert.equal(MCP_SETTINGS_SCHEMA_VERSION, 1)
  assert.equal(MCP_NEW_SERVER_ENABLED_BY_DEFAULT, true)

  const normalized = normalizeMcpServerInput({
    name: '  Example tools  ',
    capabilityAliases: [
      { capability: ' Catalog.Lookup ', access: 'read' },
      { capability: 'catalog.lookup', access: 'write' },
      { capability: 'https://endpoint.invalid/mcp', access: 'any' },
    ],
    transport: {
      type: 'stdio',
      command: '  node  ',
      args: ['server.js'],
      secretEnvironment: {
        API_TOKEN: { operation: 'replace', value: 'plaintext-secret' },
      },
    },
  })
  assert.equal(normalized.enabled, true)
  assert.equal(normalized.name, 'Example tools')
  assert.deepEqual(normalized.capabilityAliases, [
    { capability: 'catalog.lookup', access: 'any' },
  ])
  assert.equal(normalized.transport.type, 'stdio')
  assert.equal(normalized.transport.command, 'node')

  const stored: McpServerSettings = {
    id: 'server-1',
    name: normalized.name,
    enabled: normalized.enabled,
    capabilityAliases: normalized.capabilityAliases,
    transport: {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      encryptedEnvironment: {
        API_TOKEN: {
          format: 'opaque-platform-ciphertext',
          ciphertext: 'encrypted-secret-value',
        },
      },
    },
    status: 'connected',
    capabilities: { tools: { listChanged: true }, logging: false },
  }
  const view = redactMcpServer(stored)
  const serializedView = JSON.stringify(view)
  assert.deepEqual(view.transport.type === 'stdio' ? view.transport.environmentKeys : [], [
    'API_TOKEN',
  ])
  assert.equal(serializedView.includes('encrypted-secret-value'), false)
  assert.equal(serializedView.includes('ciphertext'), false)
  assert.deepEqual(view.capabilityAliases, normalized.capabilityAliases)

  const explicitlyDisabled = normalizeMcpServerInput({
    name: 'Disabled server',
    enabled: false,
    transport: { type: 'streamable-http', url: ' https://example.test/mcp ' },
  })
  assert.equal(explicitlyDisabled.enabled, false)
})

test('Streamable HTTP OAuth views expose metadata without token material', () => {
  const normalized = normalizeMcpServerInput({
    name: 'Remote example',
    transport: {
      type: 'streamable-http',
      url: ' https://example.test/mcp ',
      authentication: {
        type: 'oauth',
        authorizationServerUrl: ' https://auth.example.test ',
        clientId: ' example-client ',
        scopes: [' tools.read ', 'tools.read', 'tools.write'],
        secretCredentials: {
          CLIENT_SECRET: { operation: 'preserve' },
        },
      },
    },
  })
  assert.equal(normalized.transport.type, 'streamable-http')
  assert.deepEqual(
    normalized.transport.type === 'streamable-http'
      ? normalized.transport.authentication
      : null,
    {
      type: 'oauth',
      authorizationServerUrl: 'https://auth.example.test',
      clientId: 'example-client',
      scopes: ['tools.read', 'tools.write'],
      secretCredentials: {
        CLIENT_SECRET: { operation: 'preserve' },
      },
    },
  )

  const stored: McpServerSettings = {
    id: 'remote-1',
    name: normalized.name,
    enabled: normalized.enabled,
    capabilityAliases: [],
    transport: {
      type: 'streamable-http',
      url: 'https://example.test/mcp',
      encryptedHeaders: {},
      authentication: {
        type: 'oauth',
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'example-client',
        scopes: ['tools.read', 'tools.write'],
        status: 'authorized',
        encryptedCredentials: {
          ACCESS_TOKEN: {
            format: 'opaque-platform-ciphertext',
            ciphertext: 'encrypted-access-token',
          },
        },
      },
    },
    status: 'connected',
    capabilities: { logging: false },
  }
  const view = redactMcpServer(stored)
  const serializedView = JSON.stringify(view)
  assert.equal(view.transport.type, 'streamable-http')
  assert.deepEqual(
    view.transport.type === 'streamable-http' ? view.transport.authentication : null,
    {
      type: 'oauth',
      authorizationServerUrl: 'https://auth.example.test',
      clientId: 'example-client',
      scopes: ['tools.read', 'tools.write'],
      status: 'authorized',
      hasCredentials: true,
    },
  )
  assert.equal(serializedView.includes('encrypted-access-token'), false)
  assert.equal(serializedView.includes('ACCESS_TOKEN'), false)
})

test('agent grants use stable agent paths and absent grants are off', () => {
  assert.equal(MCP_ABSENT_AGENT_GRANT_ENABLED, false)
  assert.equal(normalizeMcpAgentPath(' agents/sample-agent '), 'agents/sample-agent')
  assert.equal(normalizeMcpAgentPath('agents\\sample-agent'), 'agents/sample-agent')
  assert.equal(normalizeMcpAgentPath('../agents/sample-agent'), null)

  const grants = [
    { agentPath: 'agents/sample-agent', serverId: 'server-1', enabled: true },
  ] as const
  assert.equal(
    isMcpServerGrantedToAgent({ grants, agentPath: 'agents/sample-agent', serverId: 'server-1' }),
    true,
  )
  assert.equal(
    isMcpServerGrantedToAgent({ grants, agentPath: 'agents/other-agent', serverId: 'server-1' }),
    false,
  )
})

test('tool namespacing and conservative risk policy are deterministic', () => {
  const dotted = namespaceMcpToolName('server-1', 'catalog.lookup')
  const slashed = namespaceMcpToolName('server-1', 'catalog/lookup')
  assert.match(dotted, /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/)
  assert.notEqual(dotted, slashed)
  assert.equal(dotted, namespaceMcpToolName('server-1', 'catalog.lookup'))

  assert.equal(classifyMcpToolRisk({ readOnlyHint: true }), 'read-only')
  assert.equal(classifyMcpToolRisk({ destructiveHint: true }), 'destructive')
  assert.equal(classifyMcpToolRisk({ readOnlyHint: false }), 'mutating')
  assert.equal(classifyMcpToolRisk({}), 'unknown')
  assert.equal(mcpToolRequiresApproval('read-only'), false)
  assert.equal(mcpToolRequiresApproval('unknown'), true)
  assert.equal(mcpToolRequiresApproval('destructive'), true)
  assert.equal(mcpToolRequiresApproval('destructive', 'always'), true)
})

test('MCP effect mapping is strict, explicit, and fail-closed', () => {
  assert.strictEqual(
    resolveMcpCapabilityEffect({ destructiveHint: true }),
    serialCapabilityEffect('destructive'),
  )
  assert.strictEqual(
    resolveMcpCapabilityEffect({
      destructiveHint: true,
      readOnlyHint: false,
    }),
    serialCapabilityEffect('destructive'),
  )
  assert.strictEqual(
    resolveMcpCapabilityEffect({ readOnlyHint: false }),
    serialCapabilityEffect('mutating'),
  )
  assert.strictEqual(
    resolveMcpCapabilityEffect({ readOnlyHint: true }),
    serialCapabilityEffect('read-only'),
  )
  assert.strictEqual(
    resolveMcpCapabilityEffect({}),
    serialCapabilityEffect('unknown'),
  )

  const contradictory = { destructiveHint: true, readOnlyHint: true }
  assert.strictEqual(
    resolveMcpCapabilityEffect(contradictory),
    serialCapabilityEffect('unknown'),
  )
  const contradictoryRisk = classifyMcpToolRisk(contradictory)
  assert.equal(contradictoryRisk, 'destructive')
  assert.equal(mcpToolRequiresApproval(contradictoryRisk), true)

  const malformedInputs: readonly unknown[] = [
    { readOnlyHint: 'true' },
    { readOnlyHint: 1 },
    { readOnlyHint: null },
    { destructiveHint: 'true' },
    { destructiveHint: 1 },
    { destructiveHint: null },
  ]
  for (const input of malformedInputs) {
    assert.strictEqual(
      resolveMcpCapabilityEffect(input),
      serialCapabilityEffect('unknown'),
    )
  }
})

test('run leases are time-bound and scoped to canonical agent paths', () => {
  const claims: McpRunLeaseClaims = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    audience: 'mcp-broker',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    issuedAtMs: 1_000,
    expiresAtMs: 2_000,
    allowedAgentPaths: ['agents/sample-agent'],
  }
  assert.equal(isMcpRunLeaseActive(claims, 1_500), true)
  assert.equal(isMcpRunLeaseActive(claims, 2_000), false)
  assert.equal(doesMcpRunLeaseAllowAgent(claims, 'agents\\sample-agent'), true)
  assert.equal(doesMcpRunLeaseAllowAgent(claims, 'agents/other-agent'), false)
})

test('workflow requirements stay semantic while runtime records remain traceable', () => {
  const requirement: McpWorkflowCapabilityRequirement = {
    capability: ' Catalog.Lookup ',
    access: 'read',
    necessity: 'required',
    rationale: 'Retrieve relevant records.',
  }
  assert.deepEqual(normalizeMcpCapabilityRequirement(requirement), {
    capability: 'catalog.lookup',
    access: 'read',
    necessity: 'required',
    rationale: 'Retrieve relevant records.',
  })
  assert.equal(
    normalizeMcpCapabilityRequirement({
      capability: 'https://specific-server.test/mcp',
      access: 'any',
      necessity: 'required',
    }),
    null,
  )
  assert.deepEqual(Object.keys(requirement).sort(), ['access', 'capability', 'necessity', 'rationale'])
  const aliases = normalizeMcpCapabilityAliases([
    { capability: 'catalog.lookup', access: 'read' },
  ])
  assert.equal(doMcpCapabilityAliasesSatisfyRequirement(aliases, requirement), true)
  assert.equal(
    doMcpCapabilityAliasesSatisfyRequirement(aliases, {
      capability: 'catalog.lookup',
      access: 'write',
      necessity: 'required',
    }),
    false,
  )

  const context = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    workflowId: 'workflow-1',
    workflowStepId: 'step-1',
    agentPath: 'agents/sample-agent',
  } as const
  const call: McpBrokerCallRequest = {
    context,
    toolCallId: 'tool-call-1',
    namespacedToolName: namespaceMcpToolName('server-1', 'search'),
    arguments: { key: 'example' },
  }
  const attachment: McpResourceAttachment = {
    attachmentId: 'attachment-1',
    name: 'result.md',
    mimeType: 'text/markdown',
    content: { encoding: 'utf8', text: '# Result' },
    provenance: {
      kind: 'immutable-mcp-snapshot',
      immutable: true,
      snapshotId: 'snapshot-1',
      serverId: 'server-1',
      resourceUri: 'resource://result/1',
      capturedAt: '2026-07-12T12:00:00.000Z',
      contentHash: { algorithm: 'sha256', value: 'abc123' },
      toolCallId: call.toolCallId,
    },
  }
  const evidence: McpEvidenceRecord = {
    evidenceId: 'evidence-1',
    kind: 'resource-snapshot',
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    workflowId: context.workflowId,
    workflowStepId: context.workflowStepId,
    agentPath: context.agentPath,
    serverId: 'server-1',
    recordedAt: '2026-07-12T12:00:00.000Z',
    attachmentId: attachment.attachmentId,
    provenance: attachment.provenance,
  }
  const providerSupport: McpProviderSupport = {
    provider: 'openai',
    state: 'supported',
    mode: 'native-tool-loop',
  }
  const approval: McpApprovalInteraction = {
    interactionId: 'approval-1',
    kind: 'approval',
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    workflowId: context.workflowId,
    workflowStepId: context.workflowStepId,
    agentPath: context.agentPath,
    serverId: 'server-1',
    status: 'pending',
    createdAt: '2026-07-12T12:00:00.000Z',
    toolCallId: call.toolCallId,
    namespacedToolName: call.namespacedToolName,
    toolRisk: 'unknown',
    argumentNames: Object.keys(call.arguments),
    argumentsHash: { algorithm: 'sha256', value: 'arguments-hash' },
  }
  const approvalResolution: McpApprovalResolution = {
    interactionId: approval.interactionId,
    decision: 'approve',
    scope: 'run',
  }
  const denialResolution: McpApprovalResolution = {
    interactionId: approval.interactionId,
    decision: 'deny',
  }
  const interruptedStatus: McpInteractionStatus = 'interrupted'
  assert.equal(attachment.provenance.immutable, true)
  assert.equal(evidence.provenance?.snapshotId, 'snapshot-1')
  assert.deepEqual(
    {
      sessionId: evidence.sessionId,
      runId: evidence.runId,
      assignmentId: evidence.assignmentId,
      workflowId: evidence.workflowId,
      workflowStepId: evidence.workflowStepId,
    },
    {
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
      workflowId: 'workflow-1',
      workflowStepId: 'step-1',
    },
  )
  assert.equal(providerSupport.state, 'supported')
  assert.deepEqual(approval.argumentNames, ['key'])
  assert.equal(approval.assignmentId, 'assignment-1')
  assert.equal(approval.argumentsHash.value, 'arguments-hash')
  assert.equal(approvalResolution.scope, 'run')
  assert.equal('scope' in denialResolution, false)
  assert.equal(interruptedStatus, 'interrupted')
  assert.equal(MCP_SANITIZED_ERROR_CODES.includes('server_revoked'), true)
  assert.equal(MCP_RUNTIME_EVENT_TYPES.includes('mcp.tool.progress'), true)
  assert.equal(MCP_RUNTIME_EVENT_TYPES.includes('mcp.resource.attached'), true)
  assert.equal(MCP_RUNTIME_EVENT_TYPES.includes('mcp.evidence.recorded'), true)
})
