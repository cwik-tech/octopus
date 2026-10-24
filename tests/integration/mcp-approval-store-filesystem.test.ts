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

const START_TIME = Date.parse('2026-07-12T19:00:00.000Z')

function request(index: number): McpApprovalRequestInput {
  return {
    interactionId: `approval-${index}`,
    sessionId: 'session-concurrent',
    runId: 'run-concurrent',
    assignmentId: 'assignment-concurrent',
    agentPath: 'agents/researcher',
    serverId: 'database-server',
    namespacedToolName: 'mcp__database-server__query',
    toolCallId: `call-${index}`,
    toolRisk: 'mutating',
    arguments: { index, query: `select ${index}` },
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

function approvalErrorCode(error: unknown): string | undefined {
  return error instanceof McpApprovalError ? error.code : undefined
}

test('real filesystem mutations stay atomic across concurrent parent store instances', async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-approval-concurrency-'),
  )
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-concurrent',
    runId: 'run-concurrent',
    assignmentId: 'assignment-concurrent',
  })
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  const options = {
    workspacePath,
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
    now: () => START_TIME,
    maxRecords: 128,
  } as const
  const firstStore = new McpApprovalStore(options)
  const secondStore = new McpApprovalStore(options)
  const statePath = path.join(
    location.assignmentPath,
    'mcp',
    'approvals',
    'state.json',
  )

  try {
    const inputs = Array.from({ length: 48 }, (_value, index) => request(index))
    await Promise.all(
      inputs.map((input, index) =>
        (index % 2 === 0 ? firstStore : secondStore).createRequest(input),
      ),
    )
    assert.equal((await firstStore.list()).length, inputs.length)

    const target = inputs[0]!
    const binding = exactBinding(target)
    const competing = await Promise.allSettled([
      firstStore.respond({
        ...binding,
        interactionId: target.interactionId,
        responseId: 'response-approve',
        decision: 'approve',
        scope: 'once',
      }),
      secondStore.respond({
        ...binding,
        interactionId: target.interactionId,
        responseId: 'response-deny',
        decision: 'deny',
      }),
    ])
    const fulfilled = competing.filter((result) => result.status === 'fulfilled')
    const rejected = competing.filter((result) => result.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    const rejectedResult = rejected[0]
    assert.ok(rejectedResult && rejectedResult.status === 'rejected')
    assert.equal(approvalErrorCode(rejectedResult.reason), 'already_resolved')

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      version: number
      requests: Array<{ interactionId: string; status: string }>
    }
    assert.equal(persisted.version, 1)
    assert.equal(persisted.requests.length, inputs.length)
    assert.equal(
      persisted.requests.filter(
        (record) =>
          record.interactionId === target.interactionId &&
          (record.status === 'approved-once' || record.status === 'denied'),
      ).length,
      1,
    )
    assert.deepEqual(
      fs
        .readdirSync(path.dirname(statePath))
        .filter((entry) => entry.endsWith('.tmp')),
      [],
    )
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700)
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a restarted parent atomically interrupts pending v1 requests and preserves terminal decisions', async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-approval-restart-'),
  )
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-concurrent',
    runId: 'run-concurrent',
    assignmentId: 'assignment-concurrent',
  })
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  const now = { value: START_TIME }
  const options = {
    workspacePath,
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
    now: () => now.value,
  } as const
  const original = new McpApprovalStore(options)
  const pending = request(100)
  const approved = request(101)

  try {
    await original.createRequest(pending)
    await original.createRequest(approved)
    await original.respond({
      ...exactBinding(approved),
      interactionId: approved.interactionId,
      responseId: 'response-before-restart',
      decision: 'approve',
      scope: 'run',
    })

    now.value += 15_000
    const restarted = new McpApprovalStore(options)
    assert.deepEqual(
      (await restarted.recoverPendingAfterRestart()).map(
        (view) => view.interactionId,
      ),
      [pending.interactionId],
    )
    assert.equal((await restarted.get(pending.interactionId))?.status, 'interrupted')
    assert.equal((await restarted.get(approved.interactionId))?.status, 'approved-run')
    assert.deepEqual(await restarted.recoverPendingAfterRestart(), [])

    const statePath = path.join(
      location.assignmentPath,
      'mcp',
      'approvals',
      'state.json',
    )
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      version: number
      requests: Array<{ status: string }>
    }
    assert.equal(persisted.version, 1)
    assert.deepEqual(
      persisted.requests.map((record) => record.status).sort(),
      ['approved-run', 'interrupted'],
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('approval storage fails closed on corrupt, future, or cross-assignment state', async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-approval-invalid-state-'),
  )
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-concurrent',
    runId: 'run-concurrent',
    assignmentId: 'assignment-concurrent',
  })
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  const store = new McpApprovalStore({
    workspacePath,
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
    now: () => START_TIME,
  })
  const statePath = path.join(
    location.assignmentPath,
    'mcp',
    'approvals',
    'state.json',
  )

  try {
    await store.createRequest(request(200))
    const validState = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<
      string,
      unknown
    >
    for (const invalid of [
      { ...validState, version: 2 },
      {
        ...validState,
        assignment: {
          sessionId: 'session-concurrent',
          runId: 'run-concurrent',
          assignmentId: 'other-assignment',
        },
      },
    ]) {
      fs.writeFileSync(statePath, JSON.stringify(invalid), { mode: 0o600 })
      await assert.rejects(
        new McpApprovalStore({
          workspacePath,
          sessionId: location.sessionId,
          runId: location.runId,
          assignmentId: location.assignmentId,
        }).list(),
        (error: unknown) => approvalErrorCode(error) === 'storage_invalid',
      )
    }
    fs.writeFileSync(statePath, '{not-json', { mode: 0o600 })
    await assert.rejects(
      store.list(),
      (error: unknown) => approvalErrorCode(error) === 'storage_invalid',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('approval storage rejects a symlinked canonical assignment', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-approval-symlink-'),
  )
  const outsidePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-approval-outside-'),
  )
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-concurrent',
    runId: 'run-concurrent',
    assignmentId: 'assignment-concurrent',
  })
  assert.ok(location)
  fs.mkdirSync(path.dirname(location.assignmentPath), { recursive: true })
  fs.symlinkSync(outsidePath, location.assignmentPath, 'dir')

  try {
    const store = new McpApprovalStore({
      workspacePath,
      sessionId: location.sessionId,
      runId: location.runId,
      assignmentId: location.assignmentId,
    })
    await assert.rejects(
      store.list(),
      (error: unknown) => approvalErrorCode(error) === 'storage_invalid',
    )
    assert.equal(fs.readdirSync(outsidePath).length, 0)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})
