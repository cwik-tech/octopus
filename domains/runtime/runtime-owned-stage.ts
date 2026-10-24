import type { ChainState, LevelConfig } from '../../core/types.js'
import { STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'

type StageLifecycleStatus =
  typeof STAGE_LIFECYCLE_STATUS[keyof typeof STAGE_LIFECYCLE_STATUS]

export type RuntimeOwnedStageTool =
  | 'dispatch'
  | 'handoff'
  | 'broadcast'
  | 'submit_for_review'

interface RuntimeAutostartOwnershipParams {
  startingLevelId: string | undefined
  activeLevelId: string | undefined
  started: boolean
  activeLevelOwnership: boolean
}

/** Preserve a destination level's decision when starting one stage advances into another. */
export function resolveRuntimeAutostartOwnership(
  params: RuntimeAutostartOwnershipParams,
): boolean {
  return params.startingLevelId === params.activeLevelId
    ? params.started
    : params.activeLevelOwnership
}

export function resolveRuntimeRecoveryStageStatus(
  current: StageLifecycleStatus,
  recoveryMode: boolean,
): StageLifecycleStatus {
  return recoveryMode && current === STAGE_LIFECYCLE_STATUS.FAILED
    ? STAGE_LIFECYCLE_STATUS.READY
    : current
}

export interface RecoveredChainRestart {
  stageStatus: StageLifecycleStatus
  autostartInput: { action?: 'resume' }
}

/**
 * How recovery restarts a chain an interrupted attempt left unfinished.
 *
 * Resume starts a new execution attempt. The step that was in flight when the
 * old attempt died never answered: its process was stopped, or it outlived its
 * parent and saved the stage BLOCKED when the parent stopped answering. Neither
 * is a decision about the work, so the step runs again. An agent's own BLOCKED
 * verdict is written to the step file first and keeps the stage Blocked, and a
 * chain whose outputs cover every step has nothing left to run.
 */
export function resolveRecoveredChainRestart(input: {
  recoveryMode: boolean
  stageStatus: StageLifecycleStatus
  chain: ChainState
  inFlightStepBlockedByAgent: boolean
}): RecoveredChainRestart {
  const { recoveryMode, stageStatus, chain } = input
  if (
    !recoveryMode ||
    input.inFlightStepBlockedByAgent ||
    chain.outputs.length >= chain.totalSteps
  ) {
    return { stageStatus, autostartInput: {} }
  }
  return {
    stageStatus:
      stageStatus === STAGE_LIFECYCLE_STATUS.BLOCKED
        ? STAGE_LIFECYCLE_STATUS.READY
        : stageStatus,
    // The chain refuses a plain start once a step is recorded, and a resume
    // continues from its first step without an output.
    autostartInput: chain.currentStep > 0 ? { action: 'resume' } : {},
  }
}

export function resolveRuntimeOwnedStageTool(
  level: LevelConfig,
): RuntimeOwnedStageTool | undefined {
  switch (level.stage.type) {
    case STAGE_TYPE.PIPELINE:
      return 'dispatch'
    case STAGE_TYPE.CHAIN:
      return 'handoff'
    case STAGE_TYPE.BROADCAST:
      return 'broadcast'
    case STAGE_TYPE.REVIEW:
      return 'submit_for_review'
    default:
      return undefined
  }
}

export function canRuntimeAutostartInline(level: LevelConfig): boolean {
  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:
    case STAGE_TYPE.DISCUSSION:
    case STAGE_TYPE.PIPELINE:
    case STAGE_TYPE.CHAIN:
    case STAGE_TYPE.BROADCAST:
    case STAGE_TYPE.REVIEW:
      return true
  }
}
