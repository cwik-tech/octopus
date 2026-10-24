import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MCP_BROKER_LIMITS,
  canonicalizeMcpJson,
  normalizeMcpBrokerLimits,
  validateMcpBrokerCallRequest,
  validateMcpBrokerContext,
  validateMcpRunLease,
} from '../../domains/mcp/mcp-broker-policy.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
  type McpRunLeaseClaims,
} from '../../domains/mcp/mcp-runtime.js'

const nowMs = Date.parse('2026-07-12T18:00:00.000Z')

function context(
  overrides: Partial<McpBrokerRequestContext> = {},
): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/tool-user',
    ...overrides,
  }
}

function lease(overrides: Partial<McpRunLeaseClaims> = {}): McpRunLeaseClaims {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    audience: 'mcp-broker',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    allowedAgentPaths: ['agents/tool-user'],
    ...overrides,
  }
}

test('broker limits normalize invalid values without weakening defaults', () => {
  assert.deepEqual(normalizeMcpBrokerLimits({
    perCallTimeoutMs: 125.9,
    maxInputBytes: 0,
    maxOutputBytes: Number.NaN,
    maxCallsPerRun: -1,
  }), {
    ...DEFAULT_MCP_BROKER_LIMITS,
    perCallTimeoutMs: 125,
  })
})

test('broker context validation canonicalizes agent paths and rejects control characters', () => {
  const valid = validateMcpBrokerContext(context({
    agentPath: ' agents/tool-user ',
    agentId: 'lane-market',
    agentDisplayName: 'Market Analyst',
    activityScopeId: 'lane-market',
  }))
  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.equal(valid.value.agentPath, 'agents/tool-user')
    assert.equal(valid.value.agentId, 'lane-market')
    assert.equal(valid.value.agentDisplayName, 'Market Analyst')
    assert.equal(valid.value.activityScopeId, 'lane-market')
  }

  const invalid = validateMcpBrokerContext(context({ requestId: 'secret\nvalue' }))
  assert.equal(invalid.ok, false)
  if (!invalid.ok) {
    assert.equal(invalid.error.code, 'invalid_request')
    assert.doesNotMatch(JSON.stringify(invalid.error), /secret/)
  }
  assert.equal(
    validateMcpBrokerContext(
      context({ agentDisplayName: 'Market\nforged' }),
    ).ok,
    false,
  )
})

test('lease validation distinguishes expiry from identity and agent-scope failures', () => {
  assert.equal(validateMcpRunLease(context(), lease(), nowMs), null)
  assert.equal(
    validateMcpRunLease(
      context(),
      lease({ issuedAtMs: nowMs - 2_000, expiresAtMs: nowMs - 1 }),
      nowMs,
    )?.code,
    'lease_expired',
  )
  assert.equal(
    validateMcpRunLease(context(), lease({ assignmentId: 'other-assignment' }), nowMs)?.code,
    'lease_invalid',
  )
  assert.equal(
    validateMcpRunLease(context(), lease({ allowedAgentPaths: ['agents/other'] }), nowMs)?.code,
    'lease_invalid',
  )
  assert.equal(
    validateMcpRunLease(
      context(),
      lease({ issuedAtMs: nowMs + 1, expiresAtMs: nowMs + 60_000 }),
      nowMs,
    )?.code,
    'lease_invalid',
  )
})

test('canonical JSON is stable and rejects cycles, non-finite values, and excessive depth', () => {
  assert.equal(
    canonicalizeMcpJson({ z: [3, { b: true, a: null }], a: 'value' }),
    '{"a":"value","z":[3,{"a":null,"b":true}]}',
  )
  assert.throws(() => canonicalizeMcpJson({ invalid: Number.POSITIVE_INFINITY }))

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalizeMcpJson(cyclic))

  let deep: unknown = null
  for (let index = 0; index < 70; index += 1) deep = [deep]
  assert.throws(() => canonicalizeMcpJson(deep))
})

test('call validation applies canonical input sizing and never reflects rejected values', () => {
  const limits = normalizeMcpBrokerLimits({ maxInputBytes: 32 })
  const valid = validateMcpBrokerCallRequest({
    context: context(),
    toolCallId: 'call-1',
    namespacedToolName: 'mcp__server__tool',
    arguments: { b: 2, a: 1 },
  }, limits)
  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.equal(valid.value.canonicalArguments, '{"a":1,"b":2}')
    assert.deepEqual(valid.value.request.arguments, { a: 1, b: 2 })
  }

  const secret = 'oversized-sensitive-value-428e'
  const rejected = validateMcpBrokerCallRequest({
    context: context(),
    toolCallId: 'call-2',
    namespacedToolName: 'mcp__server__tool',
    arguments: { value: secret },
  }, limits)
  assert.equal(rejected.ok, false)
  if (!rejected.ok) {
    assert.equal(rejected.error.code, 'result_too_large')
    assert.doesNotMatch(JSON.stringify(rejected.error), new RegExp(secret))
  }
})

test('broker call validation uses strict shared canonical JSON without invoking accessors', () => {
  let getterCalls = 0
  const accessorArguments: Record<string, unknown> = {}
  Object.defineProperty(accessorArguments, 'marker', {
    enumerable: true,
    get: () => {
      getterCalls += 1
      return 'must-not-run'
    },
  })

  const accessor = validateMcpBrokerCallRequest({
    context: context(),
    toolCallId: 'strict-accessor-call',
    namespacedToolName: 'mcp__server__tool',
    arguments: accessorArguments,
  }, normalizeMcpBrokerLimits())
  const unsafeKey = validateMcpBrokerCallRequest({
    context: context(),
    toolCallId: 'strict-key-call',
    namespacedToolName: 'mcp__server__tool',
    arguments: { nested: { constructor: 'blocked' } },
  }, normalizeMcpBrokerLimits())

  assert.equal(accessor.ok, false)
  assert.equal(getterCalls, 0)
  assert.equal(unsafeKey.ok, false)
})
