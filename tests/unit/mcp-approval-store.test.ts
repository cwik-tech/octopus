import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  McpApprovalError,
  hashMcpApprovalArguments,
  type McpApprovalExactBinding,
  type McpApprovalRequestInput,
} from '../../domains/mcp/mcp-approval.js'
import { McpApprovalStore } from '../../domains/mcp/mcp-approval-store.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

const START_TIME = Date.parse('2026-07-12T18:00:00.000Z')

interface Harness {
  readonly workspacePath: string
  readonly assignmentPath: string
  readonly statePath: string
  readonly store: McpApprovalStore
  readonly now: { value: number }
  cleanup(): void
}

function createHarness(prefix = 'mcp-approval-unit-'): Harness {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  const now = { value: START_TIME }
  return {
    workspacePath,
    assignmentPath: location.assignmentPath,
    statePath: path.join(location.assignmentPath, 'mcp', 'approvals', 'state.json'),
    store: new McpApprovalStore({
      workspacePath,
      sessionId: location.sessionId,
      runId: location.runId,
      assignmentId: location.assignmentId,
      now: () => now.value,
    }),
    now,
    cleanup() {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    },
  }
}

function request(
  interactionId: string,
  toolCallId: string,
  argumentsValue: unknown,
  overrides: Partial<McpApprovalRequestInput> = {},
): McpApprovalRequestInput {
  return {
    interactionId,
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/researcher',
    serverId: 'database-server',
    namespacedToolName: 'mcp__database-server__query',
    toolCallId,
    toolRisk: 'mutating',
    arguments: argumentsValue,
    ...overrides,
  }
}

function exactBinding(
  input: McpApprovalRequestInput,
): McpApprovalExactBinding {
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    assignmentId: input.assignmentId,
    agentPath: input.agentPath,
    serverId: input.serverId,
    namespacedToolName: input.namespacedToolName,
    toolCallId: input.toolCallId,
    toolRisk: input.toolRisk,
    argumentsHash: hashMcpApprovalArguments(input.arguments).argumentsHash,
  }
}

function hasApprovalCode(code: McpApprovalError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpApprovalError && error.code === code
}

test('approval argument hashing is canonical and rejects non-JSON or pollution-shaped input', () => {
  const first = hashMcpApprovalArguments({
    z: [3, { b: true, a: null }],
    a: 'value',
  })
  const reordered = hashMcpApprovalArguments({
    a: 'value',
    z: [3, { a: null, b: true }],
  })
  const changed = hashMcpApprovalArguments({
    a: 'different',
    z: [3, { a: null, b: true }],
  })
  assert.deepEqual(first.argumentNames, ['a', 'z'])
  assert.deepEqual(first.argumentsHash, reordered.argumentsHash)
  assert.notEqual(first.argumentsHash.value, changed.argumentsHash.value)
  assert.match(first.argumentsHash.value, /^[a-f0-9]{64}$/)

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const sparse = new Array(2)
  sparse[1] = 'value'
  const accessor: Record<string, unknown> = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get: () => 'must-not-run-as-json',
  })
  const withSymbol = { value: 'safe' } as Record<PropertyKey, unknown>
  withSymbol[Symbol('hidden')] = 'hidden'

  for (const invalid of [
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: 1n },
    { value: Symbol('invalid') },
    { value: () => 'invalid' },
    { value: new Date() },
    { value: cyclic },
    { value: sparse },
    { value: accessor },
    withSymbol,
    JSON.parse('{"__proto__":"blocked"}') as unknown,
    { nested: { constructor: 'blocked' } },
    { nested: { prototype: 'blocked' } },
  ]) {
    assert.throws(
      () => hashMcpApprovalArguments(invalid),
      hasApprovalCode('invalid_request'),
    )
  }
})

test('approval persistence is canonical, redacted, idempotent, and digest-bound', async () => {
  const harness = createHarness()
  const secret = 'database-password-3b2ad1'
  const pendingInput = request('approval-1', 'call-1', {
    password: secret,
    query: 'select count(*) from customers',
  })

  try {
    const pending = await harness.store.createRequest(pendingInput)
    assert.equal(pending.status, 'pending')
    assert.deepEqual(pending.argumentNames, ['password', 'query'])
    assert.equal('argumentsHash' in pending, false)
    assert.equal('responseId' in pending, false)
    assert.equal(JSON.stringify(pending).includes(secret), false)

    const persistedPending = fs.readFileSync(harness.statePath, 'utf8')
    assert.equal(persistedPending.includes(secret), false)
    assert.match(persistedPending, /"algorithm": "sha256"/)
    assert.equal(
      fs.existsSync(
        path.join(harness.workspacePath, 'assignments', 'assignment-1'),
      ),
      false,
    )

    const replayedCreate = await harness.store.createRequest(pendingInput)
    assert.deepEqual(replayedCreate, pending)
    assert.equal((await harness.store.list()).length, 1)

    await assert.rejects(
      harness.store.createRequest({
        ...pendingInput,
        arguments: { password: 'changed', query: 'select 1' },
      }),
      hasApprovalCode('binding_mismatch'),
    )

    const reusedProviderCallId = await harness.store.createRequest({
      ...pendingInput,
      interactionId: 'approval-2',
      arguments: { query: 'select 2' },
    })
    assert.equal(reusedProviderCallId.toolCallId, pendingInput.toolCallId)
    assert.equal((await harness.store.list()).length, 2)

    const response = {
      ...exactBinding(pendingInput),
      interactionId: pendingInput.interactionId,
      responseId: 'response-1',
      decision: 'approve',
      scope: 'once',
    } as const
    const approved = await harness.store.respond(response)
    assert.equal(approved.status, 'approved-once')
    assert.equal(approved.decision, 'approve')
    assert.equal(approved.approvalScope, 'once')
    assert.equal('argumentsHash' in approved, false)
    assert.equal('responseId' in approved, false)
    assert.deepEqual(await harness.store.respond(response), approved)

    await assert.rejects(
      harness.store.respond({ ...response, responseId: 'response-2' }),
      hasApprovalCode('already_resolved'),
    )
    await assert.rejects(
      harness.store.respond({
        ...response,
        argumentsHash: hashMcpApprovalArguments({ changed: true }).argumentsHash,
      }),
      hasApprovalCode('binding_mismatch'),
    )
    await assert.rejects(
      harness.store.respond({ ...response, sessionId: 'other-session' }),
      hasApprovalCode('not_found'),
    )

    const persistedApproved = fs.readFileSync(harness.statePath, 'utf8')
    assert.equal(persistedApproved.includes(secret), false)
    assert.match(persistedApproved, /"responseId": "response-1"/)
  } finally {
    harness.cleanup()
  }
})

test('approval store enforces every terminal transition and immutable terminal state', async () => {
  const harness = createHarness()
  const once = request('approval-once', 'call-once', { operation: 'write' })
  const run = request('approval-run', 'call-run', { operation: 'update' })
  const denied = request('approval-denied', 'call-denied', { operation: 'drop' })
  const cancelled = request('approval-cancelled', 'call-cancelled', { operation: 'stop' })
  const expiring = request(
    'approval-expired',
    'call-expired',
    { operation: 'late' },
    { ttlMs: 1_000 },
  )
  const interrupted = request('approval-interrupted', 'call-interrupted', {
    operation: 'restart',
  })

  try {
    await Promise.all(
      [once, run, denied, cancelled, expiring, interrupted].map((input) =>
        harness.store.createRequest(input),
      ),
    )
    assert.equal(
      (
        await harness.store.respond({
          ...exactBinding(once),
          interactionId: once.interactionId,
          responseId: 'response-once',
          decision: 'approve',
          scope: 'once',
        })
      ).status,
      'approved-once',
    )
    assert.equal(
      (
        await harness.store.respond({
          ...exactBinding(run),
          interactionId: run.interactionId,
          responseId: 'response-run',
          decision: 'approve',
          scope: 'run',
        })
      ).status,
      'approved-run',
    )
    assert.equal(
      (
        await harness.store.respond({
          ...exactBinding(denied),
          interactionId: denied.interactionId,
          responseId: 'response-denied',
          decision: 'deny',
        })
      ).status,
      'denied',
    )
    assert.equal(
      (
        await harness.store.cancel({
          ...exactBinding(cancelled),
          interactionId: cancelled.interactionId,
        })
      ).status,
      'cancelled',
    )
    assert.equal(
      (
        await harness.store.cancel({
          ...exactBinding(cancelled),
          interactionId: cancelled.interactionId,
        })
      ).status,
      'cancelled',
    )

    harness.now.value += 1_000
    assert.deepEqual(
      (await harness.store.expirePending()).map((view) => view.interactionId),
      ['approval-expired'],
    )
    assert.equal((await harness.store.get(expiring.interactionId))?.status, 'expired')
    await assert.rejects(
      harness.store.respond({
        ...exactBinding(expiring),
        interactionId: expiring.interactionId,
        responseId: 'response-too-late',
        decision: 'approve',
        scope: 'once',
      }),
      hasApprovalCode('expired'),
    )

    assert.deepEqual(
      (await harness.store.recoverPendingAfterRestart()).map(
        (view) => view.interactionId,
      ),
      ['approval-interrupted'],
    )
    assert.equal(
      (await harness.store.get(interrupted.interactionId))?.status,
      'interrupted',
    )
    await assert.rejects(
      harness.store.respond({
        ...exactBinding(interrupted),
        interactionId: interrupted.interactionId,
        responseId: 'response-after-restart',
        decision: 'deny',
      }),
      hasApprovalCode('already_resolved'),
    )
  } finally {
    harness.cleanup()
  }
})

test('run approvals are reusable only for the exact unexpired run tool scope', async () => {
  const harness = createHarness()
  const runInput = request(
    'approval-run-reuse',
    'call-run-reuse',
    { database: 'catalog', statement: 'update products set active = true' },
    { ttlMs: 10_000 },
  )
  const query = {
    sessionId: runInput.sessionId,
    runId: runInput.runId,
    assignmentId: runInput.assignmentId,
    agentPath: runInput.agentPath,
    serverId: runInput.serverId,
    namespacedToolName: runInput.namespacedToolName,
    toolRisk: runInput.toolRisk,
  } as const

  try {
    await harness.store.createRequest(runInput)
    await harness.store.respond({
      ...exactBinding(runInput),
      interactionId: runInput.interactionId,
      responseId: 'response-run-reuse',
      decision: 'approve',
      scope: 'run',
    })

    const beforeLookup = fs.readFileSync(harness.statePath, 'utf8')
    assert.equal(
      (await harness.store.findReusableRunApproval(query))?.interactionId,
      runInput.interactionId,
    )
    assert.equal(fs.readFileSync(harness.statePath, 'utf8'), beforeLookup)

    for (const mismatch of [
      { ...query, sessionId: 'other-session' },
      { ...query, runId: 'other-run' },
      { ...query, assignmentId: 'other-assignment' },
      { ...query, agentPath: 'agents/other' },
      { ...query, serverId: 'other-server' },
      { ...query, namespacedToolName: 'mcp__database-server__other' },
      { ...query, toolRisk: 'destructive' as const },
    ]) {
      assert.equal(await harness.store.findReusableRunApproval(mismatch), null)
    }

    harness.now.value += 10_000
    assert.equal(await harness.store.findReusableRunApproval(query), null)
    assert.equal((await harness.store.get(runInput.interactionId))?.status, 'approved-run')
  } finally {
    harness.cleanup()
  }
})
