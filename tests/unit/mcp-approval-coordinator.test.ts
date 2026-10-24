import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  McpApprovalCoordinator,
  type McpApprovalCoordinatorRequest,
  type McpApprovalCoordinatorScope,
} from '../../domains/mcp/mcp-approval-coordinator.js'
import { McpApprovalError } from '../../domains/mcp/mcp-approval.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

interface Harness {
  readonly workspacePath: string
  readonly scope: McpApprovalCoordinatorScope
  readonly coordinator: McpApprovalCoordinator
  cleanup(): void
}

function createHarness(): Harness {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-approval-coordinator-'),
  )
  const scope = {
    sessionId: 'session-approval',
    runId: 'run-approval',
    assignmentId: 'assignment-approval',
  }
  createAssignment(workspacePath, scope)
  return {
    workspacePath,
    scope,
    coordinator: new McpApprovalCoordinator({
      workspacePath,
      pollIntervalMs: 5,
    }),
    cleanup: () => fs.rmSync(workspacePath, { recursive: true, force: true }),
  }
}

function createAssignment(
  workspacePath: string,
  scope: McpApprovalCoordinatorScope,
): void {
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
}

function request(
  scope: McpApprovalCoordinatorScope,
  toolCallId: string,
  overrides: Partial<McpApprovalCoordinatorRequest> = {},
): McpApprovalCoordinatorRequest {
  const context: McpBrokerRequestContext = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: `request-${toolCallId}`,
    leaseId: 'lease-approval',
    ...scope,
    agentPath: 'agents/researcher',
  }
  return {
    context,
    serverId: 'database-server',
    namespacedToolName: 'mcp__database-server__write',
    toolCallId,
    toolRisk: 'mutating',
    arguments: { query: `update records set marker = '${toolCallId}'` },
    timeoutMs: 2_000,
    ...overrides,
  }
}

async function waitForPending(
  coordinator: McpApprovalCoordinator,
  scope: McpApprovalCoordinatorScope,
  toolCallId: string,
) {
  const deadline = Date.now() + 2_000
  while (true) {
    const interaction = (await coordinator.list(scope)).find(
      (candidate) =>
        candidate.toolCallId === toolCallId && candidate.status === 'pending',
    )
    if (interaction) return interaction
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${toolCallId}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function approvalCode(code: McpApprovalError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpApprovalError && error.code === code
}

test('coordinator keeps exact bindings private and provides stable approve-once response replay', async () => {
  const harness = createHarness()
  const secret = 'coordinator-argument-secret-981f'
  const input = request(harness.scope, 'call-once', {
    arguments: { password: secret, query: 'update safe_table set active = true' },
  })

  try {
    const waiting = harness.coordinator.requestApproval(input)
    const pending = await waitForPending(
      harness.coordinator,
      harness.scope,
      input.toolCallId,
    )
    assert.match(pending.interactionId, /^mcp_approval_[a-f0-9]{64}$/)
    assert.deepEqual(pending.argumentNames, ['password', 'query'])
    assert.equal('argumentsHash' in pending, false)
    assert.equal('responseId' in pending, false)
    assert.doesNotMatch(JSON.stringify(pending), new RegExp(secret))

    const response = {
      interactionId: pending.interactionId,
      responseId: 'response-once',
      decision: 'approve',
      scope: 'once',
    } as const
    const approved = await harness.coordinator.respond(harness.scope, response)
    assert.equal(approved.status, 'approved-once')
    assert.deepEqual(
      await harness.coordinator.respond(harness.scope, response),
      approved,
    )
    const decision = await waiting
    assert.equal(decision.outcome, 'approved')
    assert.equal(decision.reused, false)
    assert.equal(decision.interaction.interactionId, pending.interactionId)

    const exactReplay = await harness.coordinator.requestApproval({
      ...input,
      context: { ...input.context, requestId: 'request-once-replay' },
    })
    assert.equal(exactReplay.outcome, 'approved')
    assert.equal(exactReplay.interaction.interactionId, pending.interactionId)

    await assert.rejects(
      harness.coordinator.respond(harness.scope, {
        ...response,
        responseId: 'different-response',
      }),
      approvalCode('already_resolved'),
    )

    const state = fs.readFileSync(
      path.join(
        harness.workspacePath,
        'sessions',
        harness.scope.sessionId,
        'runs',
        harness.scope.runId,
        'assignments',
        harness.scope.assignmentId,
        'mcp',
        'approvals',
        'state.json',
      ),
      'utf8',
    )
    assert.doesNotMatch(state, new RegExp(secret))
    assert.match(state, /"argumentsHash"/)
  } finally {
    harness.cleanup()
  }
})

test('run approval reuse is exact to assignment, agent, server, tool, risk, and run', async () => {
  const harness = createHarness()
  try {
    const firstInput = request(harness.scope, 'call-run')
    const waiting = harness.coordinator.requestApproval(firstInput)
    const pending = await waitForPending(
      harness.coordinator,
      harness.scope,
      firstInput.toolCallId,
    )
    await harness.coordinator.respond(harness.scope, {
      interactionId: pending.interactionId,
      responseId: 'response-run',
      decision: 'approve',
      scope: 'run',
    })
    assert.equal((await waiting).outcome, 'approved')

    const reused = await harness.coordinator.requestApproval(request(
      harness.scope,
      'call-run-reused',
      { arguments: firstInput.arguments },
    ))
    assert.equal(reused.outcome, 'approved')
    assert.equal(reused.reused, true)
    assert.equal(reused.interaction.interactionId, pending.interactionId)

    for (const [label, changed] of [
      ['tool', { namespacedToolName: 'mcp__database-server__delete' }],
      ['risk', { toolRisk: 'destructive' as const }],
      ['arguments', { arguments: { query: 'changed argument value' } }],
    ] as const) {
      const controller = new AbortController()
      const changedInput = request(harness.scope, `call-changed-${label}`, {
        ...changed,
        signal: controller.signal,
      })
      const changedWaiting = harness.coordinator.requestApproval(changedInput)
      const changedPending = await waitForPending(
        harness.coordinator,
        harness.scope,
        changedInput.toolCallId,
      )
      assert.notEqual(changedPending.interactionId, pending.interactionId)
      controller.abort()
      assert.equal((await changedWaiting).outcome, 'cancelled')
    }

    const otherScope = {
      ...harness.scope,
      runId: 'run-other',
      assignmentId: 'assignment-other',
    }
    createAssignment(harness.workspacePath, otherScope)
    const runController = new AbortController()
    const otherRun = request(otherScope, 'call-other-run', {
      signal: runController.signal,
    })
    const otherWaiting = harness.coordinator.requestApproval(otherRun)
    await waitForPending(harness.coordinator, otherScope, otherRun.toolCallId)
    runController.abort()
    assert.equal((await otherWaiting).outcome, 'cancelled')
  } finally {
    harness.cleanup()
  }
})

test('coordinator resolves denial, public cancellation, timeout expiry, and restart interruption', async () => {
  const harness = createHarness()
  try {
    const deniedInput = request(harness.scope, 'call-denied')
    const deniedWaiting = harness.coordinator.requestApproval(deniedInput)
    const deniedPending = await waitForPending(
      harness.coordinator,
      harness.scope,
      deniedInput.toolCallId,
    )
    await harness.coordinator.respond(harness.scope, {
      interactionId: deniedPending.interactionId,
      responseId: 'response-denied',
      decision: 'deny',
    })
    assert.equal((await deniedWaiting).outcome, 'denied')

    const cancelledInput = request(harness.scope, 'call-cancelled')
    const cancelledWaiting = harness.coordinator.requestApproval(cancelledInput)
    const cancelledPending = await waitForPending(
      harness.coordinator,
      harness.scope,
      cancelledInput.toolCallId,
    )
    await harness.coordinator.cancel(
      harness.scope,
      cancelledPending.interactionId,
    )
    assert.equal((await cancelledWaiting).outcome, 'cancelled')

    const timedOut = await harness.coordinator.requestApproval(request(
      harness.scope,
      'call-expired',
      { timeoutMs: 35 },
    ))
    assert.equal(timedOut.outcome, 'expired')
    assert.equal(timedOut.interaction.status, 'expired')

    const interruptedInput = request(harness.scope, 'call-interrupted')
    const interruptedWaiting = harness.coordinator.requestApproval(
      interruptedInput,
    )
    await waitForPending(
      harness.coordinator,
      harness.scope,
      interruptedInput.toolCallId,
    )
    const restarted = new McpApprovalCoordinator({
      workspacePath: harness.workspacePath,
      pollIntervalMs: 5,
    })
    const afterRestart = await restarted.list(harness.scope)
    assert.equal(
      afterRestart.find(
        (entry) => entry.toolCallId === interruptedInput.toolCallId,
      )?.status,
      'interrupted',
    )
    assert.deepEqual(
      (await restarted.recoverPendingAfterRestart(harness.scope)).map(
        (entry) => entry.toolCallId,
      ),
      [interruptedInput.toolCallId],
    )
    assert.equal((await interruptedWaiting).outcome, 'interrupted')
  } finally {
    harness.cleanup()
  }
})

test('interaction callback failure cancels the exact pending approval and propagates the failure', async () => {
  const harness = createHarness()
  const callbackFailure = new Error('approval interaction evidence failed')
  const input = request(harness.scope, 'call-callback-failure', {
    onInteraction: async () => {
      throw callbackFailure
    },
  })

  try {
    await assert.rejects(
      harness.coordinator.requestApproval(input),
      (error: unknown) => error === callbackFailure,
    )

    const interactions = await harness.coordinator.list(harness.scope)
    const cancelled = interactions.find(
      (interaction) => interaction.toolCallId === input.toolCallId,
    )
    assert.equal(cancelled?.status, 'cancelled')
  } finally {
    harness.cleanup()
  }
})
