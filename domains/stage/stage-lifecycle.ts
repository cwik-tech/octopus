/**
 * Stage-lifecycle helpers.
 *
 * This module introduces an explicit stage-state model that is separate from
 * the coarse level status (`pending` / `active` / `completed` / `failed`).
 * The runtime does not yet drive all workflow behavior from this model, but
 * the state machine and persistence layer are now centralized here so later
 * phases can build on it deterministically.
 */

import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import type { LevelState } from '../../core/types.js'

export type StageLifecycleStatus =
  typeof STAGE_LIFECYCLE_STATUS[keyof typeof STAGE_LIFECYCLE_STATUS]

const VALID_STAGE_STATUS_TRANSITIONS: Record<StageLifecycleStatus, ReadonlySet<StageLifecycleStatus>> = {
  [STAGE_LIFECYCLE_STATUS.NOT_STARTED]: new Set([
    STAGE_LIFECYCLE_STATUS.READY,
    STAGE_LIFECYCLE_STATUS.BLOCKED,
    STAGE_LIFECYCLE_STATUS.FAILED,
  ]),
  [STAGE_LIFECYCLE_STATUS.READY]: new Set([
    STAGE_LIFECYCLE_STATUS.RUNNING,
    STAGE_LIFECYCLE_STATUS.COMPLETED,
    STAGE_LIFECYCLE_STATUS.BLOCKED,
    STAGE_LIFECYCLE_STATUS.FAILED,
  ]),
  [STAGE_LIFECYCLE_STATUS.RUNNING]: new Set([
    STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
    STAGE_LIFECYCLE_STATUS.WAITING_ON_VALIDATOR,
    STAGE_LIFECYCLE_STATUS.REVISING,
    STAGE_LIFECYCLE_STATUS.COMPLETED,
    STAGE_LIFECYCLE_STATUS.BLOCKED,
    STAGE_LIFECYCLE_STATUS.FAILED,
  ]),
  [STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER]: new Set([
    STAGE_LIFECYCLE_STATUS.RUNNING,
    STAGE_LIFECYCLE_STATUS.REVISING,
    STAGE_LIFECYCLE_STATUS.COMPLETED,
    STAGE_LIFECYCLE_STATUS.BLOCKED,
    STAGE_LIFECYCLE_STATUS.FAILED,
  ]),
  [STAGE_LIFECYCLE_STATUS.WAITING_ON_VALIDATOR]: new Set([
    STAGE_LIFECYCLE_STATUS.RUNNING,
    STAGE_LIFECYCLE_STATUS.REVISING,
    STAGE_LIFECYCLE_STATUS.COMPLETED,
    STAGE_LIFECYCLE_STATUS.BLOCKED,
    STAGE_LIFECYCLE_STATUS.FAILED,
  ]),
  [STAGE_LIFECYCLE_STATUS.REVISING]: new Set([
    STAGE_LIFECYCLE_STATUS.RUNNING,
    STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
    STAGE_LIFECYCLE_STATUS.WAITING_ON_VALIDATOR,
    STAGE_LIFECYCLE_STATUS.COMPLETED,
    STAGE_LIFECYCLE_STATUS.BLOCKED,
    STAGE_LIFECYCLE_STATUS.FAILED,
  ]),
  [STAGE_LIFECYCLE_STATUS.COMPLETED]: new Set(),
  [STAGE_LIFECYCLE_STATUS.BLOCKED]: new Set([
    STAGE_LIFECYCLE_STATUS.READY,
    STAGE_LIFECYCLE_STATUS.RUNNING,
    STAGE_LIFECYCLE_STATUS.FAILED,
  ]),
  [STAGE_LIFECYCLE_STATUS.FAILED]: new Set([
    STAGE_LIFECYCLE_STATUS.READY,
  ]),
}

export function getInitialStageStatus(isActive: boolean): StageLifecycleStatus {
  return isActive ? STAGE_LIFECYCLE_STATUS.READY : STAGE_LIFECYCLE_STATUS.NOT_STARTED
}

export function canTransitionStageStatus(
  from: StageLifecycleStatus,
  to: StageLifecycleStatus,
): boolean {
  if (from === to) return true
  return VALID_STAGE_STATUS_TRANSITIONS[from].has(to)
}

export function transitionStageStatus(
  levelState: LevelState,
  next: StageLifecycleStatus,
): void {
  if (!canTransitionStageStatus(levelState.stageStatus, next)) {
    throw new Error(`Invalid stage status transition: ${levelState.stageStatus} -> ${next}`)
  }
  levelState.stageStatus = next
}
