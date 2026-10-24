import assert from 'node:assert/strict'
import test from 'node:test'

import { DISCUSSION_MODE, LEVEL_STATUS, STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { DiscussionState, LevelState, StageConfig } from '../../core/types.js'
import { planStageRecovery, stageRecoveryChanged } from '../../team-runtime/stage-recovery.js'

/**
 * Direct checks on the recovery decisions for a discussion pass.
 *
 * The entrypoint tests in
 * `tests/integration/team-runtime-discussion-coordinator-call.test.ts` show a
 * recovery asking the member again. They cannot show that the reopen alone
 * counts as a change, because the discussion autostart persists the reopened
 * pass before anything outside the process reads the checkpoint, and they
 * cannot show that deciding the reopen changes nothing. These check both.
 */

const RESTORED_START_TIME = Date.parse('2026-01-01T00:00:00.000Z')

const DISCUSSION_STAGE: StageConfig = {
  type: STAGE_TYPE.DISCUSSION,
  coordinator: 'lead',
  participants: ['analyst'],
  config: {
    mode: DISCUSSION_MODE.DELIBERATE,
    min_rounds: 1,
    max_rounds: 2,
    constraints: { max_time_minutes: 10, max_budget_usd: 1 },
    output: { format: 'decision.md', user_review: false },
  },
}

/** A pass restored mid-run: `analyst` finished, without success. */
function makePassWithFailedMember(): DiscussionState {
  return {
    type: STAGE_TYPE.DISCUSSION,
    round: 1,
    messages: [],
    outputPath: 'decision.md',
    approvedRoster: ['analyst'],
    rosterAnnounced: true,
    continuation: {
      phase: 'running_specialist_pass',
      startedAtMs: RESTORED_START_TIME,
      passNumber: 1,
      attemptNumber: 1,
      targets: ['analyst'],
      completedTargets: ['analyst'],
      successfulTargets: [],
    },
  }
}

function makeLevelState(engineState: DiscussionState): LevelState {
  return {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
    engineState,
    loopbackCount: 0,
    visitCount: 0,
  }
}

test('a recovery decides to reopen a running specialist pass whose member finished without success, and leaves the restored state as it was', () => {
  const discussion = makePassWithFailedMember()
  const levelState = makeLevelState(discussion)
  const restored = structuredClone(levelState)

  const plan = planStageRecovery(levelState, DISCUSSION_STAGE, true)

  assert.equal(plan.recoveredStatus, undefined, 'a waiting stage keeps its status')
  assert.equal(plan.chain, undefined)
  assert.ok(plan.reopenedPass, 'the running pass is reopened')
  assert.equal(plan.reopenedPass.discussion, discussion, 'the reopen names the restored discussion')
  assert.deepEqual(plan.reopenedPass.continuation, {
    phase: 'running_specialist_pass',
    startedAtMs: RESTORED_START_TIME,
    passNumber: 1,
    attemptNumber: 1,
    targets: ['analyst'],
    completedTargets: [],
    successfulTargets: [],
  })
  assert.deepEqual(levelState, restored, 'deciding changes nothing')
})

test('without a recovery a running specialist pass is not reopened and nothing changes', () => {
  const levelState = makeLevelState(makePassWithFailedMember())

  const plan = planStageRecovery(levelState, DISCUSSION_STAGE, false)

  assert.deepEqual(plan, { recoveredStatus: undefined, reopenedPass: undefined, chain: undefined })
  assert.equal(stageRecoveryChanged(plan, undefined), false)
})

test('a reopened specialist pass alone counts as a change, so the level is persisted', () => {
  const plan = planStageRecovery(makeLevelState(makePassWithFailedMember()), DISCUSSION_STAGE, true)
  assert.equal(plan.recoveredStatus, undefined, 'precondition: the status did not change')

  assert.equal(stageRecoveryChanged(plan, undefined), true)
})
