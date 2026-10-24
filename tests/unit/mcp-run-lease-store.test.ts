import assert from 'node:assert/strict'
import test from 'node:test'

import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { validateMcpRunLease } from '../../domains/mcp/mcp-broker-policy.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'

test('MCP run leases bind session, run, assignment, and allowed agents', () => {
  let nowMs = 1_000
  const store = new McpRunLeaseStore({ now: () => nowMs, defaultTtlMs: 500 })
  const lease = store.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    allowedAgentPaths: ['agents/beta', 'agents/alpha', 'agents/alpha'],
  })
  assert.deepEqual(lease.allowedAgentPaths, ['agents/alpha', 'agents/beta'])
  const context = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: lease.leaseId,
    sessionId: lease.sessionId,
    runId: lease.runId,
    assignmentId: lease.assignmentId,
    agentPath: 'agents/alpha',
  } as const
  assert.equal(validateMcpRunLease(context, store.resolve(context), nowMs), null)

  assert.equal(
    validateMcpRunLease(
      { ...context, agentPath: 'agents/gamma' },
      store.resolve(context),
      nowMs,
    )?.code,
    'lease_invalid',
  )
  assert.equal(
    validateMcpRunLease(
      { ...context, assignmentId: 'assignment-2' },
      store.resolve(context),
      nowMs,
    )?.code,
    'lease_invalid',
  )

  nowMs = lease.expiresAtMs
  assert.equal(
    validateMcpRunLease(context, store.resolve(context), nowMs)?.code,
    'lease_expired',
  )
  assert.equal(store.revoke(lease.leaseId), true)
  assert.equal(store.resolve(context), null)
})

test('MCP run lease revocation is scoped and invalid input fails closed', () => {
  const store = new McpRunLeaseStore({ now: () => 2_000 })
  const first = store.issue({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    allowedAgentPaths: ['agents/alpha'],
  })
  const second = store.issue({
    sessionId: 'session-1',
    runId: 'run-2',
    assignmentId: 'assignment-2',
    allowedAgentPaths: ['agents/alpha'],
  })
  assert.equal(store.revokeRun({ sessionId: 'session-1', runId: 'run-1' }), 1)
  assert.equal(store.resolve({ leaseId: first.leaseId }), null)
  assert.equal(store.resolve({ leaseId: second.leaseId })?.runId, 'run-2')

  assert.throws(() => store.issue({
    sessionId: 'session-1',
    runId: 'run-3',
    assignmentId: 'assignment-3',
    allowedAgentPaths: ['../escape'],
  }))
  assert.throws(() => store.issue({
    sessionId: 'session-1',
    runId: 'run-3',
    assignmentId: 'assignment-3',
    allowedAgentPaths: [],
  }))
  assert.throws(() => store.issue({
    sessionId: 'session-1',
    runId: 'run-3',
    assignmentId: 'assignment-3',
    allowedAgentPaths: ['agents/alpha'],
    ttlMs: 0,
  }))
})
