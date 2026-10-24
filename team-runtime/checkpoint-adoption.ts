/**
 * What a Team Runtime session start adopts from the checkpoint at its
 * assignment.
 *
 * These functions are pure: they read only their arguments, change nothing
 * and return decisions or values. Two of them throw on invalid checkpoint
 * data, and throwing is their only effect. `startSession` reads the
 * environment, the checkpoint file and the clock, and applies them in this
 * order: whether a checkpoint may be read, whose checkpoint it is, then for
 * its own checkpoint the header (ids, level index and cost), the run clock,
 * which can throw, the rest of the header, and then the admission and level
 * states, which can throw, before it commits them. For another session's
 * checkpoint, `foreignCheckpointRefusal` says whether the start stops.
 */
import { agentQuestionClockSchema } from "../contracts/agent-questions.js";
import {
  readHostEntryAdmission,
  type HostEntryAdmissionReading,
} from "../contracts/host-entry-admission.js";
import {
  resumeAgentQuestionClock,
  resumeAgentQuestionDiscussionClock,
} from "../core/agent-question-clock.js";
import type { RunAssignmentLocation } from "../core/run-assignment-location.js";
import type { LevelState } from "../core/types.js";
import {
  restoreLevelStatesFromCheckpoint,
  type RuntimeCheckpoint,
} from "../domains/runtime/checkpoint.js";

/** Whose checkpoint the start read, and the checkpoint when there was one. */
export type CheckpointOwnership =
  | { readonly kind: "own"; readonly checkpoint: RuntimeCheckpoint }
  | { readonly kind: "foreign"; readonly checkpoint: RuntimeCheckpoint }
  | { readonly kind: "unread" };

/** The header an adopted checkpoint gives the run, apart from its clock. */
export interface AdoptedCheckpointHeader {
  readonly rootSessionId: string;
  /** `undefined` when the checkpoint names no parent: the run then has none. */
  readonly parentSessionId: string | undefined;
  readonly currentLevelIndex: number;
  readonly totalCost: number;
  readonly timerStarted: boolean;
  readonly spawnDepth: number;
}

/** The admission and level states an adopted checkpoint gives the run. */
export interface AdoptedCheckpointLevels {
  readonly admission: HostEntryAdmissionReading;
  readonly levelStates: Map<string, LevelState>;
}

/**
 * Whether this start may read a checkpoint at its assignment: under
 * `TEAM_RUNTIME_RECOVERY=1`, for a scoped assignment, or when Pi restored a
 * persisted runtime session id.
 */
export function checkpointResumeAllowed(input: {
  readonly recoveryFlag: string | undefined;
  readonly assignmentLocation: RunAssignmentLocation | undefined;
  readonly persistedRuntimeSessionId: string | undefined;
}): boolean {
  return (
    input.recoveryFlag === "1" ||
    Boolean(input.assignmentLocation) ||
    Boolean(input.persistedRuntimeSessionId)
  );
}

/**
 * Whether the checkpoint read is this session's, another session's, or none
 * (`null`, when the file could not be read).
 */
export function checkpointOwnership(
  checkpoint: RuntimeCheckpoint | null,
  sessionId: string,
): CheckpointOwnership {
  if (checkpoint === null) return { kind: "unread" };
  return checkpoint.sessionId === sessionId
    ? { kind: "own", checkpoint }
    : { kind: "foreign", checkpoint };
}

/**
 * The run's ids, level index, cost, timer flag and spawn depth from its own
 * checkpoint. A checkpoint that names no root is its own root.
 */
export function adoptedCheckpointHeader(
  checkpoint: RuntimeCheckpoint,
): AdoptedCheckpointHeader {
  return {
    rootSessionId: checkpoint.rootSessionId ?? checkpoint.sessionId,
    parentSessionId: checkpoint.parentSessionId,
    currentLevelIndex: checkpoint.currentLevelIndex,
    totalCost: checkpoint.totalCost,
    timerStarted: checkpoint.startTime > 0,
    spawnDepth: checkpoint.spawnDepth,
  };
}

/**
 * The resumed run clock's start: the checkpoint's start, moved forward by the
 * time from its question pause until `now` when it was saved paused. Throws
 * the clock schema's `ZodError` when the start or the pause is invalid.
 */
export function resumedCheckpointStartTime(
  checkpoint: RuntimeCheckpoint,
  now: number,
): number {
  return resumeAgentQuestionClock(agentQuestionClockSchema.parse(checkpoint), now);
}

/**
 * The admission reading and the level states of an adopted checkpoint. The
 * admission is read first. The level states are revived from a copy of the
 * checkpoint's, which throws on invalid engine state, and when the run clock
 * was resumed later than the checkpoint's start (`resumedStartTime`), each
 * discussion's clocks move forward by the same span.
 */
export function adoptedCheckpointLevels(
  checkpoint: RuntimeCheckpoint,
  resumedStartTime: number,
): AdoptedCheckpointLevels {
  const admission = readHostEntryAdmission(checkpoint.hostEntryAdmission);
  // The restore writes only top-level keys of each engine state's `state`, so
  // copying each level record down to that depth leaves the checkpoint as it
  // was read without walking fields it never reads.
  const levelStates = restoreLevelStatesFromCheckpoint({
    ...checkpoint,
    levelStates: checkpoint.levelStates.map(copyForRevival),
  });
  const humanWaitingMs = resumedStartTime - checkpoint.startTime;
  for (const [levelId, levelState] of levelStates) {
    if (levelState.engineState?.type === "discussion" && humanWaitingMs > 0) {
      levelStates.set(levelId, {
        ...levelState,
        engineState: resumeAgentQuestionDiscussionClock(
          levelState.engineState,
          humanWaitingMs,
        ),
      });
    }
  }
  return { admission, levelStates };
}

/**
 * The message a scoped assignment stops with when the checkpoint at its path
 * belongs to another session. A direct session has no assignment location and
 * goes on, so it gets `undefined`.
 */
export function foreignCheckpointRefusal(
  checkpointSessionId: string,
  assignmentLocation: Pick<RunAssignmentLocation, "assignmentId"> | undefined,
): string | undefined {
  if (!assignmentLocation) return undefined;
  return (
    `Checkpoint session '${checkpointSessionId}' does not match ` +
    `assignment '${assignmentLocation.assignmentId}'.`
  );
}

type SerializedLevelState = RuntimeCheckpoint["levelStates"][number];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One level of `value` copied when it is an array or a record; any other value as it is. */
function copyOneLevel<T>(value: T): T {
  if (Array.isArray(value)) return Object.assign([], value);
  if (isPlainRecord(value)) return { ...value };
  return value;
}

/**
 * A level record whose engine state and its `state` are fresh copies one level
 * deep. A value that is not a record is passed through unchanged, so the
 * restore refuses a malformed checkpoint with the same error as before.
 */
function copyForRevival(levelState: SerializedLevelState): SerializedLevelState {
  if (!isPlainRecord(levelState)) return levelState;
  const engineState = levelState.engineState;
  if (!isPlainRecord(engineState)) return { ...levelState };
  return { ...levelState, engineState: withCopiedState(engineState) };
}

function withCopiedState<E extends { state: unknown }>(engineState: E): E {
  return { ...engineState, state: copyOneLevel(engineState.state) };
}
