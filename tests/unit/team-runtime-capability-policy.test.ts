import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
} from '../../contracts/capability-dispatch.js'
import {
  TeamRuntimeCapabilityPolicy,
  type TeamRuntimePolicyCoordinator,
  type TeamRuntimeToolPolicySnapshot,
} from '../../team-runtime/capability-tool-policy.js'

const CONTEXT: CapabilityExecutionContext = {
  contractVersion: 1,
  requestId: 'request-policy-1',
  sessionId: 'session-policy-1',
  runId: 'run-policy-1',
  assignmentId: 'assignment-policy-1',
  taskId: 'task-policy-1',
  agentPath: 'agents/coordinator',
  authority: {
    kind: 'runtime-assignment',
    processIdentity: 'process-policy-1',
  },
}

test('Team Runtime policy denies model tools when the level is runtime-owned', async () => {
  const fixture = makePolicy({ coordinator: null })

  const decision = await fixture.policy.evaluate(makeEvaluation('call-1'))

  assert.equal(decision.kind, 'deny')
  if (decision.kind === 'deny') {
    assert.equal(decision.code, 'runtime_owned_tool_denied')
  }
})

test('Team Runtime policy denies engine tools unavailable at the current level', async () => {
  const fixture = makePolicy({ levelAllowedTools: new Set(['handoff']) })

  const decision = await fixture.policy.evaluate(makeEvaluation('call-1'))

  assert.equal(decision.kind, 'deny')
  if (decision.kind === 'deny') {
    assert.equal(decision.code, 'tool_not_allowed_in_level')
  }
})

test('Team Runtime policy denies tools outside the effective agent allowlist', async () => {
  const fixture = makePolicy({
    levelAllowedTools: new Set(['dispatch']),
    coordinator: { name: 'coordinator', allowedTools: ['handoff'] },
  })

  const decision = await fixture.policy.evaluate(makeEvaluation('call-1'))

  assert.equal(decision.kind, 'deny')
  if (decision.kind === 'deny') {
    assert.equal(decision.code, 'tool_not_allowed_for_agent')
  }
})

test('Team Runtime policy denies engine use after the current turn advanced', async () => {
  const fixture = makePolicy({
    coordinatorRunId: 7,
    levelAdvancedCoordinatorRunId: 7,
  })

  const decision = await fixture.policy.evaluate(makeEvaluation('call-1'))

  assert.equal(decision.kind, 'deny')
  if (decision.kind === 'deny') {
    assert.equal(decision.code, 'post_advance_tool_denied')
  }
})

test('Team Runtime policy admits one level-tool call across dispatcher reauthorization only', async () => {
  const fixture = makePolicy()

  const initial = await fixture.policy.evaluate(makeEvaluation('call-1'))
  const reauthorization = await fixture.policy.evaluate(makeEvaluation('call-1'))
  const duplicate = await fixture.policy.evaluate(makeEvaluation('call-2'))

  assert.deepEqual(initial, { kind: 'allow' })
  assert.deepEqual(reauthorization, { kind: 'allow' })
  assert.equal(duplicate.kind, 'deny')
  if (duplicate.kind === 'deny') {
    assert.equal(duplicate.code, 'duplicate_level_tool')
  }
})

test('Team Runtime policy admits only the host-constructed runtime invocation channel', async () => {
  const fixture = makePolicy({ coordinator: null })

  const runtimeDecision = await fixture.policy.evaluate(makeEvaluation(
    'runtime-call-1',
    { kind: 'engine', id: 'team-runtime:runtime-autostart', version: '1' },
  ))
  const forgedDecision = await fixture.policy.evaluate(makeEvaluation(
    'runtime-call-2',
    { kind: 'engine', id: 'untrusted-runtime-source', version: '1' },
  ))

  assert.deepEqual(runtimeDecision, { kind: 'allow' })
  assert.equal(forgedDecision.kind, 'deny')
})

test('a granted governed file tool may be called more than once in a coordinator turn', async () => {
  // A level tool is admitted once per coordinator turn, because using it is how
  // a stage advances. A file tool is not that kind of tool: a coordinator that
  // may write may write twice, and capping it would be a new restriction
  // invented by the fix rather than by the grant.
  const fixture = makePolicy({
    levelAllowedTools: new Set(['mcp__pipeline_skills__load_skill']),
    engineTools: new Set(['dispatch']),
    coordinator: {
      name: 'coordinator',
      allowedTools: ['mcp__pipeline_skills__load_skill', 'write'],
    },
  })
  fixture.policy.register({
    capabilityId: 'team-runtime.pi.write',
    toolName: 'write',
  })

  const first = await fixture.policy.evaluate(makeWriteEvaluation('write-call-1'))
  const second = await fixture.policy.evaluate(makeWriteEvaluation('write-call-2'))

  assert.deepEqual(first, { kind: 'allow' })
  assert.deepEqual(second, { kind: 'allow' })
})

function makeWriteEvaluation(
  toolCallId: string,
): Parameters<TeamRuntimeCapabilityPolicy['evaluate']>[0] {
  return {
    context: CONTEXT,
    invocation: {
      capabilityId: 'team-runtime.pi.write',
      source: { kind: 'engine', id: 'team-runtime:pi-model', version: '1' },
      toolCallId,
    },
    effect: { kind: 'mutating', concurrency: 'serial' },
    risk: 'mutating',
  }
}

function makePolicy(
  overrides: Partial<Omit<TeamRuntimeToolPolicySnapshot, 'coordinator'>> & {
    coordinator?: TeamRuntimePolicyCoordinator | null
  } = {},
): {
  readonly policy: TeamRuntimeCapabilityPolicy
  readonly snapshot: TeamRuntimeToolPolicySnapshot
} {
  const {
    coordinator = { name: 'coordinator', allowedTools: ['dispatch'] },
    ...rest
  } = overrides
  const snapshot: TeamRuntimeToolPolicySnapshot = {
    levelId: 'level-1',
    coordinatorRunId: 1,
    levelAdvancedCoordinatorRunId: null,
    levelAllowedTools: new Set(['dispatch']),
    engineTools: new Set(['dispatch']),
    usedLevelToolsThisCoordinatorTurn: new Set(),
    ...rest,
    ...(coordinator ? { coordinator } : {}),
  }
  const policy = new TeamRuntimeCapabilityPolicy({
    getSnapshot: () => snapshot,
    trustedRuntimeSource: {
      kind: 'engine',
      id: 'team-runtime:runtime-autostart',
      version: '1',
    },
  })
  policy.register({
    capabilityId: 'team-runtime.engine.dispatch',
    toolName: 'dispatch',
  })
  return { policy, snapshot }
}

function makeEvaluation(
  toolCallId: string,
  source: CapabilityInvocationIdentity['source'] = {
    kind: 'engine',
    id: 'team-runtime:pi-model',
    version: '1',
  },
): Parameters<TeamRuntimeCapabilityPolicy['evaluate']>[0] {
  return {
    context: CONTEXT,
    invocation: {
      capabilityId: 'team-runtime.engine.dispatch',
      source,
      toolCallId,
    },
    effect: { kind: 'mutating', concurrency: 'serial' },
    risk: 'mutating',
  }
}
