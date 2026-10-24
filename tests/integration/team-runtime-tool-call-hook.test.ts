/**
 * What Pi's `tool_call` hook may refuse, observed through the real Team Runtime.
 *
 * Pi runs the registered `tool_call` handler before it executes a tool, and
 * executes the tool only when the handler returns nothing. The runtime's
 * handler is a bypass detector: it refuses a tool this runtime did not
 * register, and nothing else. Which agent may use which tool is decided by the
 * capability policy inside the registered wrapper, when the tool runs, and
 * that decision is recorded in the assignment's tool-use log with a code.
 *
 * `tests/integration/team-runtime-host-level-transition.test.ts` covers the
 * other half: the hook does not spend the one-use-per-turn level-tool budget.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  findFilesContaining,
  type FixtureRuntime,
} from '../support/team-runtime-fixture-boot.js'

const INTAKE_GRANT = ['spawn_team', 'inspect-task-state']

function recordsFor(
  runtime: FixtureRuntime,
  fileName: string,
  toolCallId: string,
): Array<Record<string, unknown>> {
  return runtime
    .readAssignmentJsonl(fileName)
    .filter((record) => record.tool_call_id === toolCallId)
}

function unregisteredToolRefusal(toolName: string): unknown {
  return {
    block: true,
    terminate: true,
    reason: `Tool '${toolName}' has no Team Runtime capability registration.`,
  }
}

test('the tool_call hook lets through a registered tool the agent was not granted, and the capability policy refuses it when it runs', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'hook-not-granted',
    team: { coordinator: { name: 'intake-agent', tools: INTAKE_GRANT } },
  })
  try {
    const registeredNames = runtime.host.registered.map((tool) => tool.name)
    assert.ok(
      registeredNames.includes('browser'),
      `browser is registered for every level; got ${registeredNames.join(', ')}`,
    )

    const toolCallId = 'call-browser-not-granted'
    const hookResult = await runtime.host.callToolCall({
      toolName: 'browser',
      toolCallId,
      input: { action: 'observe' },
    })
    assert.equal(
      hookResult,
      undefined,
      'the hook refuses only unregistered or shadowed tools, not tools the agent lacks',
    )

    await assert.rejects(
      runtime.host.invokeTool('browser', toolCallId, { action: 'observe' }),
      (error: unknown) => {
        assert.equal(
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
          'tool_not_allowed_for_agent',
        )
        return true
      },
    )

    const toolUse = recordsFor(runtime, ASSIGNMENT_LOG.toolUse, toolCallId)
    assert.equal(toolUse.length, 1, `one tool-use record for the call; got ${JSON.stringify(toolUse)}`)
    assert.equal(toolUse[0]?.policy_code, 'tool_not_allowed_for_agent')
    assert.equal(toolUse[0]?.blocked_by_capability_policy, true)
    assert.equal(
      toolUse[0]?.blocked_capability_bypass,
      undefined,
      'the refusal came from the policy, not from the hook',
    )

    // The hook still observed the call it let through.
    assert.deepEqual(
      recordsFor(runtime, ASSIGNMENT_LOG.runtimeEvents, toolCallId).map((record) => record.event),
      ['tool.call_observed'],
    )
    assert.deepEqual(
      recordsFor(runtime, ASSIGNMENT_LOG.hostEvents, toolCallId).map((record) => record.event),
      ['host.tool_call'],
    )
  } finally {
    await runtime.close()
  }
})

test('every tool_call is counted and observed, and a call the hook blocks gets one tool-use record even after its execution end', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'hook-blocked',
    team: { coordinator: { name: 'intake-agent', tools: INTAKE_GRANT } },
  })
  try {
    const allowedCallId = 'call-inspect-observed'
    const blockedCallId = 'call-unregistered-tool'

    assert.equal(
      await runtime.host.callToolCall({ toolName: 'inspect-task-state', toolCallId: allowedCallId }),
      undefined,
    )
    assert.deepEqual(
      await runtime.host.callToolCall({ toolName: 'extension_bypass', toolCallId: blockedCallId }),
      unregisteredToolRefusal('extension_bypass'),
    )

    // Both calls count toward the turn, the blocked one included.
    const hostToolCalls = runtime
      .readAssignmentJsonl(ASSIGNMENT_LOG.hostEvents)
      .filter((record) => record.event === 'host.tool_call')
    assert.deepEqual(
      hostToolCalls.map((record) => record.tool_call_id),
      [allowedCallId, blockedCallId],
    )
    const [allowedCount, blockedCount] = hostToolCalls.map((record) => record.tool_calls_in_turn)
    assert.equal(typeof allowedCount, 'number')
    assert.equal(blockedCount, Number(allowedCount) + 1)
    assert.deepEqual(
      runtime
        .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
        .filter((record) => record.event === 'tool.call_observed')
        .map((record) => record.tool_call_id),
      [allowedCallId, blockedCallId],
    )

    // Pi still reports the end of a blocked call. The block already wrote the
    // record, so the end must not add a second one.
    await runtime.host.callHandler('tool_execution_end', {
      type: 'tool_execution_end',
      toolName: 'extension_bypass',
      toolCallId: blockedCallId,
      result: { content: [], details: undefined },
      isError: true,
    })

    const toolUse = recordsFor(runtime, ASSIGNMENT_LOG.toolUse, blockedCallId)
    assert.equal(toolUse.length, 1, `one tool-use record for the blocked call; got ${JSON.stringify(toolUse)}`)
    assert.equal(toolUse[0]?.blocked_capability_bypass, true)
    assert.equal(toolUse[0]?.policy_code, 'ungoverned_tool_call')
    assert.equal(toolUse[0]?.agent_name, 'intake-agent')
  } finally {
    await runtime.close()
  }
})

test('in config-error mode the tool_call hook returns the bypass refusal and records nothing', {
  timeout: 60_000,
}, async () => {
  // A later level's coordinator has no persona file, so boot stops with a
  // config error before any tool registers.
  const runtime = await bootFixtureRuntime({
    label: 'hook-config-error',
    team: {
      coordinator: { name: 'intake-agent', tools: INTAKE_GRANT },
      laterLevels: [{ id: 'review', coordinator: { name: 'auditor', loadable: false } }],
    },
  })
  try {
    assert.ok(
      runtime.host.notifications.some(
        (notice) => notice.level === 'error' && notice.message.includes("'auditor'"),
      ),
      `precondition: the boot reported a config error; got ${JSON.stringify(runtime.host.notifications)}`,
    )

    const toolCallId = 'call-during-config-error'
    assert.deepEqual(
      await runtime.host.callToolCall({ toolName: 'browser', toolCallId }),
      unregisteredToolRefusal('browser'),
    )
    assert.deepEqual(
      findFilesContaining(runtime.root, toolCallId),
      [],
      'a call made while the Team cannot run leaves no record anywhere',
    )
  } finally {
    await runtime.close()
  }
})

test('in setup mode the tool_call hook returns the bypass refusal and records nothing', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({ label: 'hook-setup-mode', setupMode: true })
  try {
    assert.ok(
      runtime.host.notifications.some((notice) => notice.message.includes('No team.yaml found')),
      `precondition: the boot entered setup mode; got ${JSON.stringify(runtime.host.notifications)}`,
    )

    const toolCallId = 'call-during-setup'
    assert.deepEqual(
      await runtime.host.callToolCall({ toolName: 'browser', toolCallId }),
      unregisteredToolRefusal('browser'),
    )
    assert.deepEqual(findFilesContaining(runtime.root, toolCallId), [])
  } finally {
    await runtime.close()
  }
})
