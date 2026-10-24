import assert from 'node:assert/strict'
import test from 'node:test'

import type { CapabilityDispatchResult } from '../../contracts/capability-dispatch.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'

test('coalesces an in-flight invocation with the same canonical argument digest', async () => {
  const bindings = makeBindings()
  const leader = bindings.acquire(makeAcquireInput())
  const follower = bindings.acquire(makeAcquireInput())

  assert.equal(leader.kind, 'leader')
  assert.equal(follower.kind, 'follower')
  if (leader.kind !== 'leader' || follower.kind !== 'follower') return

  const result = makeCompletedResult()
  const followerResult = follower.wait(new AbortController().signal)
  leader.complete(result)

  assert.equal(await followerResult, result)
})

test('rejects changed arguments under the same stable invocation identity', () => {
  const bindings = makeBindings()
  const leader = bindings.acquire(makeAcquireInput())

  assert.equal(leader.kind, 'leader')
  if (leader.kind !== 'leader') return

  const activeConflict = bindings.acquire(
    makeAcquireInput({ argumentDigest: 'digest-changed' }),
  )
  assert.deepEqual(activeConflict, {
    kind: 'conflict',
    code: 'invocation_identity_conflict',
  })

  leader.complete(makeCompletedResult())
  const retainedConflict = bindings.acquire(
    makeAcquireInput({ argumentDigest: 'digest-changed-again' }),
  )
  assert.deepEqual(retainedConflict, {
    kind: 'conflict',
    code: 'invocation_identity_conflict',
  })
})

test('cancelling a coalesced follower does not cancel the leader result', async () => {
  const bindings = makeBindings()
  const leader = bindings.acquire(makeAcquireInput())
  const follower = bindings.acquire(makeAcquireInput())

  assert.equal(leader.kind, 'leader')
  assert.equal(follower.kind, 'follower')
  if (leader.kind !== 'leader' || follower.kind !== 'follower') return

  const followerController = new AbortController()
  const followerResult = follower.wait(followerController.signal)
  followerController.abort(new DOMException('follower stopped waiting', 'AbortError'))

  await assert.rejects(
    followerResult,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )

  const result = makeCompletedResult()
  leader.complete(result)
  const replay = bindings.acquire(makeAcquireInput())

  assert.equal(replay.kind, 'retained')
  if (replay.kind !== 'retained') return
  assert.equal(replay.result, result)
})

test('admits same-invocation followers before enforcing per-scope leader capacity', () => {
  const bindings = makeBindings({ maxActivePerScope: 1 })
  const leader = bindings.acquire(makeAcquireInput())
  const follower = bindings.acquire(makeAcquireInput())
  const distinctInvocation = bindings.acquire(
    makeAcquireInput({ dispatchId: 'dispatch-2' }),
  )

  assert.equal(leader.kind, 'leader')
  assert.equal(follower.kind, 'follower')
  assert.deepEqual(distinctInvocation, {
    kind: 'capacity-exceeded',
    code: 'capacity_exceeded',
  })

  if (leader.kind !== 'leader') return
  leader.complete(makeCompletedResult())
  assert.equal(
    bindings.acquire(makeAcquireInput({ dispatchId: 'dispatch-2' })).kind,
    'leader',
  )
})

test('returns the retained terminal result for the same invocation and digest', () => {
  const bindings = makeBindings()
  const leader = bindings.acquire(makeAcquireInput())

  assert.equal(leader.kind, 'leader')
  if (leader.kind !== 'leader') return

  const result = makeCompletedResult()
  leader.complete(result)
  const replay = bindings.acquire(makeAcquireInput())

  assert.equal(replay.kind, 'retained')
  if (replay.kind !== 'retained') return
  assert.equal(replay.result, result)
})

test('releases a scope after its active leader settles without abandoning existing followers', async () => {
  const bindings = makeBindings()
  const leader = bindings.acquire(makeAcquireInput())
  const follower = bindings.acquire(makeAcquireInput())

  assert.equal(leader.kind, 'leader')
  assert.equal(follower.kind, 'follower')
  if (leader.kind !== 'leader' || follower.kind !== 'follower') return

  const followerResult = follower.wait(new AbortController().signal)
  bindings.releaseScope('scope-1')

  const result = makeCompletedResult()
  leader.complete(result)
  assert.equal(await followerResult, result)
  assert.equal(bindings.acquire(makeAcquireInput()).kind, 'leader')
})

test('assignment release evicts retained bindings across authority scopes without touching a sibling assignment', () => {
  const bindings = makeBindings()
  const firstScope = encodedScopeKey({
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    authority: 'lease-1',
  })
  const secondScope = encodedScopeKey({
    assignmentId: 'assignment-1',
    taskId: 'task-2',
    authority: 'lease-2',
  })
  const siblingScope = encodedScopeKey({
    assignmentId: 'assignment-2',
    taskId: 'task-1',
    authority: 'lease-1',
  })
  const scopes = [firstScope, secondScope, siblingScope]

  for (const scopeKey of scopes) {
    const leader = bindings.acquire(makeAcquireInput({ scopeKey }))
    assert.equal(leader.kind, 'leader')
    if (leader.kind === 'leader') leader.complete(makeCompletedResult())
  }

  bindings.releaseAssignment({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })

  assert.equal(
    bindings.acquire(makeAcquireInput({ scopeKey: firstScope })).kind,
    'leader',
  )
  assert.equal(
    bindings.acquire(makeAcquireInput({ scopeKey: secondScope })).kind,
    'leader',
  )
  assert.equal(
    bindings.acquire(makeAcquireInput({ scopeKey: siblingScope })).kind,
    'retained',
  )
})

function makeBindings(
  overrides: Partial<ConstructorParameters<typeof CapabilityInvocationBindings>[0]> = {},
): CapabilityInvocationBindings {
  return new CapabilityInvocationBindings({
    maxActivePerScope: 2,
    maxRetainedPerScope: 8,
    ...overrides,
  })
}

function makeAcquireInput(
  overrides: Partial<{
    readonly scopeKey: string
    readonly dispatchId: string
    readonly argumentDigest: string
  }> = {},
): {
  readonly scopeKey: string
  readonly dispatchId: string
  readonly argumentDigest: string
} {
  return {
    scopeKey: 'scope-1',
    dispatchId: 'dispatch-1',
    argumentDigest: 'digest-1',
    ...overrides,
  }
}

function makeCompletedResult(): CapabilityDispatchResult {
  return {
    status: 'completed',
    dispatchId: 'dispatch-1',
    value: { ok: true },
    costTracked: false,
    budgetOverrun: false,
  }
}

function encodedScopeKey(input: {
  readonly assignmentId: string
  readonly taskId: string
  readonly authority: string
}): string {
  return [
    'session-1',
    'run-1',
    input.assignmentId,
    input.taskId,
    input.authority,
  ].join('\0')
}

test('an abandoned binding is not retained, so the same call may be attempted again', async () => {
  // A transient infrastructure failure (an unavailable journal) must not
  // become the permanent answer for this tool call: retaining it would replay
  // the failure instead of reopening on the next attempt.
  const bindings = new CapabilityInvocationBindings({
    maxActivePerScope: 4,
    maxRetainedPerScope: 32,
  })
  const acquireInput = {
    scopeKey: 'scope-abandon',
    dispatchId: 'dispatch-abandon',
    argumentDigest: 'digest-abandon',
    scope: {
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    },
  }

  const first = bindings.acquire(acquireInput)
  assert.equal(first.kind, 'leader')
  if (first.kind !== 'leader') return
  first.abandon({
    status: 'failed',
    dispatchId: 'dispatch-abandon',
    code: 'durable_journal_unavailable',
  })

  const second = bindings.acquire(acquireInput)
  assert.equal(
    second.kind,
    'leader',
    'the next attempt must lead again rather than replay a retained failure',
  )
})
