/**
 * What a recovery changes on a restored level before the Team Runtime
 * autostarts it.
 *
 * These functions are pure: they read only their arguments, change nothing
 * and return decisions. `startStageAutostart` applies them in this order: the
 * recovered stage status, then the reopened discussion specialist pass, then,
 * for a recovering chain, it reads the in-flight step's verdict file and
 * applies the chain restart decided from the status as it is by then. It
 * persists once when `stageRecoveryChanged` says anything changed.
 */
import { STAGE_TYPE } from "../core/constants.js";
import { reopenDiscussionSpecialistPassForRecovery } from "../core/discussion-continuation-control.js";
import type {
  ChainStageConfig,
  ChainState,
  DiscussionContinuationProgress,
  DiscussionState,
  LevelState,
  StageConfig,
} from "../core/types.js";
import {
  resolveRecoveredChainRestart,
  resolveRuntimeRecoveryStageStatus,
} from "../domains/runtime/runtime-owned-stage.js";

type StageStatus = LevelState["stageStatus"];
type RunningSpecialistPass = Extract<
  DiscussionContinuationProgress,
  { phase: "running_specialist_pass" }
>;

export interface StageRecoveryPlan {
  /** The status the stage moves to, when it differs from the restored one. */
  readonly recoveredStatus: StageStatus | undefined;
  /** The restored discussion and its running pass reopened for another attempt. */
  readonly reopenedPass:
    | { readonly discussion: DiscussionState; readonly continuation: RunningSpecialistPass }
    | undefined;
  /** A recovering chain, whose restart waits on its in-flight step's verdict. */
  readonly chain:
    | { readonly stage: ChainStageConfig; readonly state: ChainState }
    | undefined;
}

export interface ChainRecoveryPlan {
  /** The status the chain restart moves the stage to, when it differs. */
  readonly restartStatus: StageStatus | undefined;
  /** The chain's autostart input: `{ action: "resume" }` or `{}`. */
  readonly chainInput: { action?: "resume" };
}

/**
 * The recovered status and the reopened specialist pass for a restored level,
 * and whether it is a recovering chain.
 */
export function planStageRecovery(
  levelState: Pick<LevelState, "stageStatus" | "engineState">,
  stage: StageConfig,
  isRecovery: boolean,
): StageRecoveryPlan {
  const recoveryStatus = resolveRuntimeRecoveryStageStatus(
    levelState.stageStatus,
    isRecovery,
  );
  const engineState = levelState.engineState;
  // A participant that failed or was skipped is checkpointed as completed
  // the moment it ends, while the pass is still `waiting_on_worker` and
  // its quorum verdict has not been reached. Only a repeat attempt can
  // repair it, so every recovery of a running pass must reopen those
  // targets — not just the recoveries that arrive on a failed stage.
  const reopenedPass =
    isRecovery &&
    engineState?.type === STAGE_TYPE.DISCUSSION &&
    engineState.continuation?.phase === "running_specialist_pass"
      ? {
          discussion: engineState,
          continuation: reopenDiscussionSpecialistPassForRecovery(
            engineState.continuation,
          ),
        }
      : undefined;
  return {
    recoveredStatus:
      recoveryStatus !== levelState.stageStatus ? recoveryStatus : undefined,
    reopenedPass,
    // An interrupted chain restarts at its first unanswered step unless
    // that step's agent recorded its own BLOCKED verdict.
    chain:
      isRecovery &&
      stage.type === STAGE_TYPE.CHAIN &&
      engineState?.type === STAGE_TYPE.CHAIN
        ? { stage, state: engineState }
        : undefined,
  };
}

/** The chain restart, from the stage status once the recovered status is applied. */
export function planChainRecovery(input: {
  readonly stageStatus: StageStatus;
  readonly chain: ChainState;
  readonly isRecovery: boolean;
  readonly inFlightStepBlockedByAgent: boolean;
}): ChainRecoveryPlan {
  const restart = resolveRecoveredChainRestart({
    recoveryMode: input.isRecovery,
    stageStatus: input.stageStatus,
    chain: input.chain,
    inFlightStepBlockedByAgent: input.inFlightStepBlockedByAgent,
  });
  return {
    restartStatus:
      restart.stageStatus !== input.stageStatus ? restart.stageStatus : undefined,
    chainInput: restart.autostartInput,
  };
}

/** Whether applying the plans changed the level, so its checkpoint is written. */
export function stageRecoveryChanged(
  plan: StageRecoveryPlan,
  chainPlan: ChainRecoveryPlan | undefined,
): boolean {
  return (
    plan.recoveredStatus !== undefined ||
    plan.reopenedPass !== undefined ||
    chainPlan?.restartStatus !== undefined
  );
}
