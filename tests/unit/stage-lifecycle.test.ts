import test from 'node:test'
import assert from 'node:assert/strict'

import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import {
  canTransitionStageStatus,
  getInitialStageStatus,
  transitionStageStatus,
} from '../../domains/stage/stage-lifecycle.js'
import type { LevelState } from '../../core/types.js'

test('getInitialStageStatus returns ready for an active level', () => {
  assert.equal(getInitialStageStatus(true), STAGE_LIFECYCLE_STATUS.READY)
})

test('getInitialStageStatus returns not_started for an inactive level', () => {
  assert.equal(getInitialStageStatus(false), STAGE_LIFECYCLE_STATUS.NOT_STARTED)
})

test('canTransitionStageStatus allows the initial deterministic lifecycle path', () => {
  assert.equal(
    canTransitionStageStatus(STAGE_LIFECYCLE_STATUS.NOT_STARTED, STAGE_LIFECYCLE_STATUS.READY),
    true,
  )
  assert.equal(
    canTransitionStageStatus(STAGE_LIFECYCLE_STATUS.READY, STAGE_LIFECYCLE_STATUS.RUNNING),
    true,
  )
  assert.equal(
    canTransitionStageStatus(STAGE_LIFECYCLE_STATUS.RUNNING, STAGE_LIFECYCLE_STATUS.COMPLETED),
    true,
  )
})

test('canTransitionStageStatus rejects invalid transitions', () => {
  assert.equal(
    canTransitionStageStatus(STAGE_LIFECYCLE_STATUS.NOT_STARTED, STAGE_LIFECYCLE_STATUS.COMPLETED),
    false,
  )
  assert.equal(
    canTransitionStageStatus(STAGE_LIFECYCLE_STATUS.COMPLETED, STAGE_LIFECYCLE_STATUS.RUNNING),
    false,
  )
})

test('transitionStageStatus mutates level state on valid transitions', () => {
  const levelState: LevelState = {
    status: 'active',
    stageStatus: STAGE_LIFECYCLE_STATUS.READY,
    engineState: null,
    loopbackCount: 0,
  }

  transitionStageStatus(levelState, STAGE_LIFECYCLE_STATUS.RUNNING)

  assert.equal(levelState.stageStatus, STAGE_LIFECYCLE_STATUS.RUNNING)
})

test('transitionStageStatus throws on invalid transitions', () => {
  const levelState: LevelState = {
    status: 'active',
    stageStatus: STAGE_LIFECYCLE_STATUS.NOT_STARTED,
    engineState: null,
    loopbackCount: 0,
  }

  assert.throws(
    () => transitionStageStatus(levelState, STAGE_LIFECYCLE_STATUS.COMPLETED),
    /Invalid stage status transition/,
  )
})
