import assert from 'node:assert/strict'
import test from 'node:test'

import { BudgetLedger } from '../../core/budget-ledger.js'
import { STAGE_TYPE } from '../../core/constants.js'
import type { DiscussionState } from '../../core/types.js'
import {
  acceptDiscussionLeadDecision,
  beginDiscussionContinuation,
  beginDiscussionSpecialistPass,
  beginDiscussionSpecialistPassAttempt,
  markDiscussionLeadContinuation,
  markDiscussionPassComplete,
  resolveDiscussionEffectiveTargets,
  resolveDiscussionContinuationAction,
  buildDiscussionLeadDecisionInvocationId,
  buildDiscussionLeadDispatchId,
  buildDiscussionRosterDispatchId,
  buildDiscussionSpecialistInvocationId,
  resolveDiscussionDispatchBudget,
  recordDiscussionTargetCompletion,
  reopenDiscussionSpecialistPassForRecovery,
} from '../../core/discussion-continuation-control.js'
import { withDirectAgentBudgetAdmission } from '../../team-runtime/direct-agent-budget-admission.js'

function makeDiscussion(round: number): DiscussionState {
  return {
    type: STAGE_TYPE.DISCUSSION,
    round,
    messages: [],
    outputPath: '/tmp/discussion',
    approvedRoster: ['specialist'],
    rosterAnnounced: true,
  }
}

test('a partial synthesis may publish below the pass floor after successful participants reached quorum', () => {
  const discussion = makeDiscussion(1)
  discussion.approvedRoster = ['specialist', 'missing']
  discussion.messages = [
    { from: 'specialist', to: 'all', round: 1, timestamp: '2026-10-03T00:00:00Z', type: 'position', message: 'Accepted evidence.' },
    { from: 'missing', to: 'all', round: 1, timestamp: '2026-10-03T00:00:00Z', type: 'error', message: 'Contribution failed.' },
  ]
  discussion.continuation = acceptDiscussionLeadDecision(beginDiscussionContinuation(1000), {
    decision: 'complete', reason: 'Missing contribution.', finalResponse: 'Available evidence.',
  })
  assert.deepEqual(resolveDiscussionContinuationAction(discussion, 4, 1000, 3), {
    kind: 'publish_completion', reason: 'Missing contribution.', finalResponse: 'Available evidence.',
  })
  assert.throws(() => resolveDiscussionContinuationAction(discussion, 4, 1000, 3, { minSuccessfulParticipants: 2 }), /minimum/)
})

test('a persisted continuation assignment resumes the next specialist pass without replaying earlier work', () => {
  const discussion = makeDiscussion(1)
  discussion.continuation = markDiscussionLeadContinuation(
    beginDiscussionContinuation(1_000),
    {
      message: 'Resolve the remaining evidence gap.',
      targets: ['specialist'],
    },
  )

  assert.deepEqual(resolveDiscussionContinuationAction(discussion, 4, 1_000), {
    kind: 'specialist_pass',
    passNumber: 2,
    input: {
      message: 'Resolve the remaining evidence gap.',
      to: ['specialist'],
    },
  })
})

test('a fully checkpointed specialist pass reconciles without dispatching provider work again', () => {
  const discussion = makeDiscussion(1)
  discussion.messages.push({
    from: 'fallback-specialist',
    target: 'specialist',
    to: 'all',
    round: 2,
    timestamp: new Date(0).toISOString(),
    type: 'position',
    message: 'Persisted accepted response.',
    dispatchId: 'dispatch-specialist',
  })
  discussion.continuation = recordDiscussionTargetCompletion(
    beginDiscussionSpecialistPass(
      markDiscussionLeadContinuation(beginDiscussionContinuation(1_000), {
        message: 'Resolve the evidence gap.',
        targets: ['specialist'],
      }),
      2,
      ['specialist'],
    ),
    'specialist',
    true,
  )

  assert.deepEqual(resolveDiscussionContinuationAction(discussion, 4, 1_000), {
    kind: 'reconcile_specialist_pass',
    passNumber: 2,
    targetCount: 1,
    successfulCount: 1,
    acceptedMessages: [discussion.messages[0]],
  })
  assert.equal(discussion.continuation.phase, 'running_specialist_pass')
  if (discussion.continuation.phase !== 'running_specialist_pass') return
  assert.deepEqual(discussion.continuation.completedTargets, ['specialist'])
  assert.deepEqual(discussion.continuation.successfulTargets, ['specialist'])
})

test('each recovered specialist pass receives a fresh governed attempt number', () => {
  const running = beginDiscussionSpecialistPass(
    beginDiscussionContinuation(1_000),
    1,
    ['specialist'],
  )

  const firstAttempt = beginDiscussionSpecialistPassAttempt(running)
  const recoveredAttempt = beginDiscussionSpecialistPassAttempt(firstAttempt)

  assert.equal(firstAttempt.attemptNumber, 1)
  assert.equal(recoveredAttempt.attemptNumber, 2)
  assert.equal(recoveredAttempt.passNumber, 1)
})

test('explicit recovery reopens only unsuccessful targets in a failed specialist pass', () => {
  const running = beginDiscussionSpecialistPassAttempt(
    beginDiscussionSpecialistPass(
      beginDiscussionContinuation(1_000),
      1,
      ['accepted-specialist', 'failed-specialist'],
    ),
  )
  const withAccepted = recordDiscussionTargetCompletion(
    running,
    'accepted-specialist',
    true,
  )
  const failed = recordDiscussionTargetCompletion(
    withAccepted,
    'failed-specialist',
    false,
  )
  assert.equal(failed.phase, 'running_specialist_pass')
  if (failed.phase !== 'running_specialist_pass') return

  const reopened = reopenDiscussionSpecialistPassForRecovery(failed)

  assert.deepEqual(reopened.completedTargets, ['accepted-specialist'])
  assert.deepEqual(reopened.successfulTargets, ['accepted-specialist'])
  assert.equal(reopened.attemptNumber, 1)
  assert.equal(
    beginDiscussionSpecialistPassAttempt(reopened).attemptNumber,
    2,
  )
})

test('the first pass persists the exact directly addressed roster subset', () => {
  assert.deepEqual(
    resolveDiscussionEffectiveTargets(
      ['specialist', 'other-specialist'],
      1,
      {
        interactionId: 'human-feedback-1',
        source: 'Reviewed evidence.',
        messages: [{
          id: 'message-1',
          text: '@specialist address this point.',
          recipients: ['specialist', 'unselected-agent'],
        }],
      },
    ),
    ['specialist'],
  )
})

test('a completed specialist pass resumes at the lead decision instead of dispatching the roster twice', () => {
  const discussion = makeDiscussion(2)
  discussion.continuation = markDiscussionPassComplete(
    beginDiscussionContinuation(1_000),
  )

  assert.deepEqual(resolveDiscussionContinuationAction(discussion, 4, 1_000), {
    kind: 'lead_decision',
  })
})

test('an accepted continuation is republished from durable state before its exact assignment runs', () => {
  const discussion = makeDiscussion(1)
  discussion.continuation = acceptDiscussionLeadDecision(
    markDiscussionPassComplete(beginDiscussionContinuation(1_000)),
    {
      decision: 'continue',
      reason: 'Evidence is still missing.',
      message: 'Resolve the evidence gap.',
      targets: ['specialist'],
    },
  )

  assert.deepEqual(resolveDiscussionContinuationAction(discussion, 4, 1_000), {
    kind: 'publish_continuation',
    reason: 'Evidence is still missing.',
    message: 'Resolve the evidence gap.',
    targets: ['specialist'],
  })
})

test('an accepted completion is republished from durable state without asking the lead again', () => {
  const discussion = makeDiscussion(2)
  discussion.continuation = acceptDiscussionLeadDecision(
    markDiscussionPassComplete(beginDiscussionContinuation(1_000)),
    {
      decision: 'complete',
      reason: 'The question is resolved.',
      finalResponse: 'Use the revised teaching sequence.',
    },
  )

  assert.deepEqual(resolveDiscussionContinuationAction(discussion, 4, 1_000), {
    kind: 'publish_completion',
    reason: 'The question is resolved.',
    finalResponse: 'Use the revised teaching sequence.',
  })
})

test('a recovered continuation cannot publish another pass at the safety ceiling', () => {
  const discussion = makeDiscussion(4)
  discussion.continuation = acceptDiscussionLeadDecision(
    markDiscussionPassComplete(beginDiscussionContinuation(1_000)),
    {
      decision: 'continue',
      reason: 'More evidence would be useful.',
      message: 'Do another pass.',
      targets: ['specialist'],
    },
  )

  assert.throws(
    () => resolveDiscussionContinuationAction(discussion, 4, 1_000, 2),
    /safety ceiling/i,
  )
})

test('a recovered completion cannot publish before the minimum pass floor', () => {
  const discussion = makeDiscussion(1)
  discussion.continuation = acceptDiscussionLeadDecision(
    markDiscussionPassComplete(beginDiscussionContinuation(1_000)),
    {
      decision: 'complete',
      reason: 'The lead claims the work is done.',
      finalResponse: 'Publish this too-early answer.',
    },
  )

  assert.throws(
    () => resolveDiscussionContinuationAction(discussion, 4, 1_000, 2),
    /minimum/i,
  )
})

test('a legacy checkpoint with completed rounds resumes at the lead decision', () => {
  const discussion = makeDiscussion(1)

  assert.deepEqual(resolveDiscussionContinuationAction(discussion, 4, 1_000), {
    kind: 'lead_decision',
  })
})

test('the discussion safety ceiling refuses another specialist pass', () => {
  const discussion = makeDiscussion(4)
  discussion.continuation = markDiscussionLeadContinuation(
    beginDiscussionContinuation(1_000),
    { message: 'Do more work.', targets: ['specialist'] },
  )

  assert.throws(
    () => resolveDiscussionContinuationAction(discussion, 4, 1_000),
    /safety ceiling/i,
  )
})

test('a recovered continuation cannot target an agent outside the locked roster', () => {
  const discussion = makeDiscussion(1)
  discussion.continuation = markDiscussionLeadContinuation(
    beginDiscussionContinuation(1_000),
    { message: 'Do more work.', targets: ['unselected-agent'] },
  )

  assert.throws(
    () => resolveDiscussionContinuationAction(discussion, 4, 1_000),
    /locked roster/i,
  )
})

test('one persisted deadline bounds every dispatch, and running out asks the Team to finish', () => {
  const progress = beginDiscussionContinuation(60_000)

  // Inside the budget, the remaining allowance bounds the next dispatch.
  const inBudget = resolveDiscussionDispatchBudget(progress, 10, 120_000)
  assert.equal(inBudget.exhausted, false)
  assert.equal(inBudget.timeoutMinutes, 9)

  // Past it, the discussion is out of time — but a spent budget is a reason to
  // wrap up, not a reason to fail the run, so this reports rather than throws
  // and still leaves enough time to publish a synthesis.
  const spent = resolveDiscussionDispatchBudget(progress, 10, 660_000)
  assert.equal(spent.exhausted, true)
  assert.ok(
    spent.timeoutMinutes > 0,
    'a wrap-up call still needs a usable timeout',
  )
})

test('a hard budget reached by specialists blocks the next lead call before provider execution', async () => {
  const ledger = new BudgetLedger({ capUsd: 1, policy: 'halt' })
  let providerCalled = false

  await assert.rejects(
    withDirectAgentBudgetAdmission({
      ledger,
      totalCost: 1,
      operation: async () => {
        providerCalled = true
        return 'unexpected'
      },
    }),
    /budget/i,
  )
  assert.equal(providerCalled, false)
})

test('a warn-only budget still permits the lead to synthesize', async () => {
  const ledger = new BudgetLedger({ capUsd: 1, policy: 'warn' })

  const result = await withDirectAgentBudgetAdmission({
    ledger,
    totalCost: 1,
    operation: async (admission) => admission.remainingBudget,
  })

  assert.equal(result, 0)
})

test('a completion forced by a spent time budget is not blocked by the pass floor', () => {
  // The floor exists to stop a lead finishing prematurely. When the stage has
  // run out of its configured time the remaining passes are never going to
  // happen, so enforcing the floor would only convert a usable synthesis into
  // a failed run — which is the outcome the time budget change exists to end.
  const discussion = {
    type: STAGE_TYPE.DISCUSSION,
    round: 1,
    messages: [],
    outputPath: '/tmp/assignment',
    approvedRoster: ['member'],
    continuation: {
      phase: 'publishing_completion' as const,
      startedAtMs: 1_000,
      reason: 'The time limit was reached.',
      finalResponse: 'Here is the answer the work so far supports.',
    },
  }

  assert.throws(
    () => resolveDiscussionContinuationAction(discussion as never, 6, 1_000, 2),
    /minimum pass floor/i,
  )

  const waived = resolveDiscussionContinuationAction(
    discussion as never,
    6,
    1_000,
    Math.max(1, Math.min(2, discussion.round)),
  )
  assert.equal(waived.kind, 'publish_completion')

  // The floor never waives below one pass: a policy of zero is not valid.
  assert.throws(
    () => resolveDiscussionContinuationAction(discussion as never, 6, 1_000, 0),
    /round policy|minimum/i,
  )
})

test('a wrap-up decision is bought in its own durable slot', () => {
  // The wrap-up request differs from an in-budget request at the same round —
  // different instruction, different schema — and a slot is bound to a digest
  // of the request that created it. Sharing one slot would make a decision
  // attempted before the deadline and retried after it fail on a digest
  // mismatch, which is the retry the attempt budget exists to allow.
  const base = {
    sessionId: 'session-1',
    levelId: 'discuss',
    visitCount: 0,
    round: 1,
  }

  assert.notEqual(
    buildDiscussionLeadDecisionInvocationId({ ...base, outOfTime: false }),
    buildDiscussionLeadDecisionInvocationId({ ...base, outOfTime: true }),
  )
  assert.equal(
    buildDiscussionLeadDecisionInvocationId({ ...base, outOfTime: true }),
    buildDiscussionLeadDecisionInvocationId({ ...base, outOfTime: true }),
  )
  assert.notEqual(
    buildDiscussionLeadDecisionInvocationId({ ...base, outOfTime: true }),
    buildDiscussionLeadDecisionInvocationId({ ...base, round: 2, outOfTime: true }),
  )
})

test('every discussion identity keys on the visit, not the loopback count', () => {
  // A level between a loopback's target and its source re-runs without its
  // loopback count changing — that counter only advances for the level a gate
  // targeted, because it also bounds `max_loopbacks`. Keying identity on it
  // makes the second visit reproduce the first visit's identities, and the
  // durable message boundary then drops the new contributions as duplicates.
  const first = { sessionId: 's', levelId: 'discuss', visitCount: 0 }
  const second = { ...first, visitCount: 1 }

  assert.notEqual(
    buildDiscussionRosterDispatchId(first.levelId, first.visitCount),
    buildDiscussionRosterDispatchId(second.levelId, second.visitCount),
  )
  assert.notEqual(
    buildDiscussionSpecialistInvocationId({ ...first, round: 1, target: 'member' }),
    buildDiscussionSpecialistInvocationId({ ...second, round: 1, target: 'member' }),
  )
  assert.notEqual(
    buildDiscussionLeadDispatchId({ levelId: first.levelId, visitCount: first.visitCount, round: 1 }),
    buildDiscussionLeadDispatchId({ levelId: second.levelId, visitCount: second.visitCount, round: 1 }),
  )
  assert.notEqual(
    buildDiscussionLeadDecisionInvocationId({ ...first, round: 1, outOfTime: false }),
    buildDiscussionLeadDecisionInvocationId({ ...second, round: 1, outOfTime: false }),
  )
})

test('an out-of-time completion publishes even when no pass ever ran', () => {
  // Reachable: the budget can be spent before pass 1 begins — a slow roster
  // selection against a 2-minute stage budget does it. The floor cannot be
  // waived by lowering `minRounds`, because a policy of zero is invalid, so
  // the waiver has to be stated rather than smuggled through the number.
  const discussion = {
    type: STAGE_TYPE.DISCUSSION,
    round: 0,
    messages: [],
    outputPath: '/tmp/assignment',
    approvedRoster: ['member'],
    continuation: {
      phase: 'publishing_completion' as const,
      startedAtMs: 1_000,
      reason: 'The time limit was reached before any specialist ran.',
      finalResponse: 'No specialist contribution was possible in the time allowed.',
    },
  }

  assert.throws(
    () => resolveDiscussionContinuationAction(discussion as never, 6, 1_000, 2),
    /minimum pass floor/i,
  )

  const waived = resolveDiscussionContinuationAction(
    discussion as never,
    6,
    1_000,
    2,
    { outOfTime: true },
  )
  assert.equal(waived.kind, 'publish_completion')
})

test('a lead dispatch identity exists for a wrap-up that precedes any pass', () => {
  // A specialist identity always names the round it answered, so a round of
  // zero is meaningless there. A lead decision is different: when the stage
  // runs out of time before pass 1, the lead is still asked to close the
  // discussion, and that dispatch needs an identity of its own.
  assert.throws(
    () => buildDiscussionSpecialistInvocationId({
      sessionId: 's', levelId: 'd', visitCount: 0, round: 0, target: 'member',
    }),
    /positive integer/,
  )
  assert.equal(
    buildDiscussionLeadDispatchId({ levelId: 'd', visitCount: 0, round: 0 }),
    buildDiscussionLeadDispatchId({ levelId: 'd', visitCount: 0, round: 0 }),
  )
  assert.notEqual(
    buildDiscussionLeadDispatchId({ levelId: 'd', visitCount: 0, round: 0 }),
    buildDiscussionLeadDispatchId({ levelId: 'd', visitCount: 0, round: 1 }),
  )
})

test('a lead decision receives two minutes to finish when specialists leave only 50.82 seconds', () => {
  const progress = beginDiscussionContinuation(1_000)

  const budget = resolveDiscussionDispatchBudget(progress, 6, 310_180, 'lead-decision')

  assert.equal(budget.exhausted, false)
  assert.equal(budget.timeoutMinutes, 2)
})

test('the lead allowance does not extend a specialist pass beyond the remaining work time', () => {
  const progress = beginDiscussionContinuation(1_000)

  const budget = resolveDiscussionDispatchBudget(progress, 6, 310_180)

  assert.equal(budget.exhausted, false)
  assert.equal(budget.timeoutMinutes * 60_000, 50_820)
})

test('a lead decision keeps a larger remaining work allowance', () => {
  const progress = beginDiscussionContinuation(1_000)

  const budget = resolveDiscussionDispatchBudget(progress, 6, 61_000, 'lead-decision')

  assert.equal(budget.exhausted, false)
  assert.equal(budget.timeoutMinutes, 5)
})
