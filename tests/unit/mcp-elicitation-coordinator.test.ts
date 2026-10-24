import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { McpElicitationCoordinator } from '../../domains/mcp/mcp-elicitation-coordinator.js'
import type { McpClientElicitationHandlerInput } from '../../domains/mcp/mcp-client-manager.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

test('elicitation coordinator returns accepted form values only to the waiting protocol call', async () => {
  const harness = createHarness()
  const coordinator = new McpElicitationCoordinator({
    workspacePath: harness.workspacePath,
    waitTimeoutMs: 2_000,
  })
  const input = formInput(harness.scope)
  const secretValue = 'ephemeral-coordinator-value-45da'

  try {
    const waiting = coordinator.requestElicitation(input)
    const pending = await waitForPending(coordinator, harness.scope)
    assert.equal(pending.mode, 'form')
    assert.equal(pending.status, 'pending')
    assert.equal(pending.parentRequestId, input.context.requestId)

    const response = {
      interactionId: pending.interactionId,
      responseId: 'response-form-1',
      action: 'accept' as const,
      values: { topic: secretValue, count: 2 },
    }
    const resolved = await coordinator.respond(harness.scope, response)
    assert.equal(resolved.status, 'accepted')
    assert.deepEqual(await waiting, {
      action: 'accept',
      content: { count: 2, topic: secretValue },
    })
    assert.equal(
      (await coordinator.respond(harness.scope, response)).status,
      'accepted',
    )

    const persisted = fs.readFileSync(
      path.join(
        harness.assignmentPath,
        'mcp',
        'elicitations',
        'state.json',
      ),
      'utf8',
    )
    assert.doesNotMatch(persisted, new RegExp(secretValue))
    assert.match(persisted, /"valuesHash"/)
  } finally {
    harness.cleanup()
  }
})

test('elicitation coordinator maps caller cancellation and timeout to safe terminal outcomes', async () => {
  const harness = createHarness()
  const coordinator = new McpElicitationCoordinator({
    workspacePath: harness.workspacePath,
    // Leave enough room for the explicit caller-cancellation assertion even
    // when the full suite is exercising many real child processes in parallel.
    waitTimeoutMs: 1_000,
  })
  try {
    const caller = new AbortController()
    const cancelledWaiting = coordinator.requestElicitation({
      ...urlInput(harness.scope, 'cancelled'),
      signal: caller.signal,
    })
    await waitForPending(coordinator, harness.scope)
    caller.abort()
    assert.deepEqual(await cancelledWaiting, { action: 'cancel' })

    const timedOut = await coordinator.requestElicitation(
      urlInput(harness.scope, 'expired'),
    )
    assert.deepEqual(timedOut, { action: 'cancel' })
    const views = await coordinator.list(harness.scope)
    assert.deepEqual(
      views.map((view) => view.status).sort(),
      ['cancelled', 'expired'],
    )
  } finally {
    harness.cleanup()
  }
})

test('elicitation cancellation converges safely when the TTL wins the store-lock race', async () => {
  const harness = createHarness()
  let now = 0
  const coordinator = new McpElicitationCoordinator({
    workspacePath: harness.workspacePath,
    waitTimeoutMs: 2_000,
    now: () => now,
  })
  try {
    const caller = new AbortController()
    const waiting = coordinator.requestElicitation({
      ...urlInput(harness.scope, 'expiry-race'),
      signal: caller.signal,
    })
    const pending = await waitForPending(coordinator, harness.scope)
    now = Date.parse(pending.expiresAt) + 1
    caller.abort()

    assert.deepEqual(await waiting, { action: 'cancel' })
    assert.equal((await coordinator.get(harness.scope, pending.interactionId))?.status, 'expired')
  } finally {
    harness.cleanup()
  }
})

function createHarness() {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-elicitation-coordinator-'),
  )
  const scope = {
    sessionId: 'session-elicitation',
    runId: 'run-elicitation',
    assignmentId: 'assignment-elicitation',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  return {
    workspacePath,
    assignmentPath: location.assignmentPath,
    scope,
    cleanup: () => fs.rmSync(workspacePath, { recursive: true, force: true }),
  }
}

function baseInput(
  scope: { sessionId: string; runId: string; assignmentId: string },
  requestId: string,
): Omit<McpClientElicitationHandlerInput, 'request'> {
  return {
    serverId: 'public-data',
    context: {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId: `parent-${requestId}`,
      leaseId: 'lease-elicitation',
      ...scope,
      agentPath: 'agents/researcher',
    },
    toolCallId: `tool-${requestId}`,
    namespacedToolName: 'mcp__public-data__collect',
    signal: new AbortController().signal,
  }
}

function formInput(
  scope: { sessionId: string; runId: string; assignmentId: string },
): McpClientElicitationHandlerInput {
  return {
    ...baseInput(scope, 'form'),
    request: {
      mode: 'form',
      message: 'Choose public data options.',
      requestedSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', minLength: 2 },
          count: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['topic', 'count'],
      },
    },
  }
}

function urlInput(
  scope: { sessionId: string; runId: string; assignmentId: string },
  suffix: string,
): McpClientElicitationHandlerInput {
  return {
    ...baseInput(scope, suffix),
    request: {
      mode: 'url',
      message: 'Open authorization.',
      url: `https://example.test/authorize/${suffix}`,
      elicitationId: `elicitation-${suffix}`,
    },
  }
}

async function waitForPending(
  coordinator: McpElicitationCoordinator,
  scope: { sessionId: string; runId: string; assignmentId: string },
) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const pending = (await coordinator.list(scope)).find(
      (view) => view.status === 'pending',
    )
    if (pending) return pending
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for pending elicitation')
}
