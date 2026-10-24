import { whenDefined } from '../../core/optional-properties.js'
/**
 * Team Runtime — Checkpoint Serialization & Resume
 *
 * Lightweight crash-recovery mechanism that serializes runtime state to disk
 * after every stage completion and periodically during long-running stages.
 * On boot, detects an existing checkpoint and offers/resumes from it.
 */

import * as fs from "node:fs";
import type {
  RuntimeState,
  LevelState,
  DiscussionContinuationAssignment,
  DiscussionContinuationProgress,
  DiscussionSetupProgress,
  DiscussionState,
  PipelineState,
  ChainState,
  BroadcastState,
  ReviewState,
} from "../../core/types.js";
import { STAGE_TYPE } from "../../core/constants.js";
import { serializeHostEntryAdmission } from "../../contracts/host-entry-admission.js";
import { reviewQuestionPhaseSchema } from "../../contracts/review-question-phase.js";
import { broadcastSettledSlotsSchema, pipelineQuestionTaskIdsSchema } from "../../contracts/agent-question-engine-progress.js";
import { writeFileAtomicSync } from "../../core/file-mutation.js";
import {
  ensureRunPrivateRuntimeDirectory,
  getRunRuntimePaths,
  RUN_CHECKPOINT_FILENAME,
} from "./runtime-paths.js";

export const CHECKPOINT_FILENAME = RUN_CHECKPOINT_FILENAME;

export interface RuntimeCheckpoint {
  version: 1;
  savedAt: string;
  sessionId: string;
  currentLevelIndex: number;
  totalCost: number;
  startTime: number;
  questionPausedAt?: number;
  levelStates: Array<{
    levelId: string;
    status: string;
    stageStatus: string;
    loopbackCount?: number;
    visitCount?: number;
    engineState: SerializedEngineState | null;
  }>;
  spawnDepth: number;
  rootSessionId?: string;
  parentSessionId?: string;
  /**
   * The stage entry the host had admitted when this checkpoint was written.
   *
   * `unknown` on purpose: it comes back off disk untrusted, and
   * `readHostEntryAdmission` is what turns it into a decision. Typing it as the
   * parsed shape here would invite a caller to read it as one without asking.
   * It is also parsed on its own path rather than inside
   * `restoreLevelStatesFromCheckpoint`, so a record this build cannot read
   * refuses only itself and does not take the run's position down with it.
   */
  hostEntryAdmission?: unknown;
}

type SerializedEngineState =
  | { type: "discussion"; state: DiscussionState }
  | { type: "pipeline"; state: PipelineState }
  | { type: "chain"; state: ChainState }
  | { type: "broadcast"; state: BroadcastState }
  | { type: "review"; state: ReviewState };

/**
 * Serialize a RuntimeState into a checkpoint object.
 * Maps are converted to arrays for JSON compatibility.
 */
export function serializeCheckpoint(state: RuntimeState): RuntimeCheckpoint {
  const levelStates: RuntimeCheckpoint["levelStates"] = [];

  for (const [levelId, ls] of state.levelStates.entries()) {
    const engineState = ls.engineState
      ? serializeEngineState(ls.engineState)
      : null;
    levelStates.push({
      levelId,
      status: ls.status,
      stageStatus: ls.stageStatus,
      loopbackCount: ls.loopbackCount ?? 0,
      visitCount: ls.visitCount ?? 0,
      engineState,
    });
  }

  return {
    version: 1,
    savedAt: new Date().toISOString(),
    sessionId: state.sessionId,
    currentLevelIndex: state.currentLevelIndex,
    totalCost: state.totalCost,
    startTime: state.startTime,
    ...whenDefined(state.questionPausedAt, (questionPausedAt) => ({ questionPausedAt })),
    levelStates,
    spawnDepth: state.spawnDepth,
    ...whenDefined(state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
    ...whenDefined(state.parentSessionId, (parentSessionId) => ({ parentSessionId })),
    // Absent when nothing is admitted, and absent rather than null: the reader
    // distinguishes "no admission field" — a checkpoint written before this
    // record existed — from "a field that cannot be read", and those two lead
    // to opposite recovery decisions.
    ...whenDefined(state.hostEntryAdmission, (admission) => ({
      hostEntryAdmission: serializeHostEntryAdmission(admission),
    })),
  };
}

function serializeEngineState(
  state: NonNullable<LevelState["engineState"]>,
): SerializedEngineState {
  switch (state.type) {
    case STAGE_TYPE.DISCUSSION:
      return { type: "discussion", state };
    case STAGE_TYPE.PIPELINE:
      return { type: "pipeline", state };
    case STAGE_TYPE.CHAIN:
      return { type: "chain", state };
    case STAGE_TYPE.BROADCAST:
      return { type: "broadcast", state };
    case STAGE_TYPE.REVIEW:
      return { type: "review", state };
    default:
      return assertUnsupportedEngineState(state);
  }
}

/**
 * Write a checkpoint inside one exact run storage directory.
 *
 * Scoped product runs pass their assignment directory. Legacy direct CLI
 * runs pass the workspace directory; both keep state below private `.runtime`.
 */
export function writeCheckpoint(
  assignmentPath: string,
  state: RuntimeState,
): void {
  const checkpoint = serializeCheckpoint(state);
  // The storage directory first, exactly as before: callers may pass a path
  // whose parents do not exist yet, and creating them is this function's job.
  fs.mkdirSync(assignmentPath, { recursive: true });
  // Then `.runtime`, by the one function that owns its mode. Left to the atomic
  // write below, it would be created as a missing parent at the umask — and the
  // journal refuses a relaxed private directory and never repairs it, so an
  // assignment checkpointed before its first governed tool could never enrol.
  ensureRunPrivateRuntimeDirectory(assignmentPath);
  const { checkpointPath } = getRunRuntimePaths(assignmentPath);
  writeFileAtomicSync(
    checkpointPath,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
  );
}

/**
 * Delete the checkpoint file (call on clean completion).
 */
export function deleteCheckpoint(assignmentPath: string): void {
  const { checkpointPath } = getRunRuntimePaths(assignmentPath);
  if (fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath);
  }
}

/**
 * Check whether a resumable checkpoint exists for one assignment.
 */
export function hasCheckpoint(assignmentPath: string): boolean {
  const { checkpointPath } = getRunRuntimePaths(assignmentPath);
  if (!fs.existsSync(checkpointPath)) return false;
  try {
    const data = JSON.parse(
      fs.readFileSync(checkpointPath, "utf8"),
    ) as RuntimeCheckpoint;
    return data.version === 1 && typeof data.sessionId === "string";
  } catch {
    return false;
  }
}

/**
 * Read and partially restore a checkpoint.
 * Returns the checkpoint data; the caller is responsible for wiring it back
 * into a full RuntimeContext (re-loading agents, team config, etc.).
 */
export function readCheckpoint(
  assignmentPath: string,
): RuntimeCheckpoint | null {
  const { checkpointPath } = getRunRuntimePaths(assignmentPath);
  if (!fs.existsSync(checkpointPath)) return null;
  try {
    const data = JSON.parse(
      fs.readFileSync(checkpointPath, "utf8"),
    ) as RuntimeCheckpoint;
    if (data.version !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Build a human-readable resume summary from a checkpoint.
 */
export function formatCheckpointSummary(checkpoint: RuntimeCheckpoint): string {
  const completedStages = checkpoint.levelStates.filter(
    (ls) => ls.status === "completed",
  ).length;
  const totalStages = checkpoint.levelStates.length;
  const currentLevel = checkpoint.levelStates[checkpoint.currentLevelIndex];
  const currentLevelId = currentLevel?.levelId ?? "unknown";

  return (
    `Resuming session ${checkpoint.sessionId.slice(0, 8)}…\n` +
    `  Level: ${currentLevelId} (index ${checkpoint.currentLevelIndex + 1}/${totalStages})\n` +
    `  Completed stages: ${completedStages}/${totalStages}\n` +
    `  Total cost so far: $${checkpoint.totalCost.toFixed(2)}\n` +
    `  Checkpoint saved: ${checkpoint.savedAt}`
  );
}

/**
 * Restore levelStates Map from a checkpoint.
 * This is a partial restore — engineState objects are revived but Maps inside
 * them (e.g., discussion messages arrays) stay as arrays.
 */
export function restoreLevelStatesFromCheckpoint(
  checkpoint: RuntimeCheckpoint,
): Map<string, LevelState> {
  const map = new Map<string, LevelState>();

  for (const ls of checkpoint.levelStates) {
    map.set(ls.levelId, {
      status: ls.status as LevelState["status"],
      stageStatus: ls.stageStatus as LevelState["stageStatus"],
      engineState: ls.engineState ? reviveEngineState(ls.engineState) : null,
      loopbackCount: ls.loopbackCount ?? 0,
      visitCount: ls.visitCount ?? 0,
    });
  }

  return map;
}

function reviveEngineState(
  serialized: SerializedEngineState,
): NonNullable<LevelState["engineState"]> {
  switch (serialized.type) {
    case "discussion": {
      const activationStartedAtMs = Reflect.get(
        serialized.state,
        "activationStartedAtMs",
      );
      if (
        activationStartedAtMs !== undefined &&
        (
          typeof activationStartedAtMs !== "number" ||
          !Number.isFinite(activationStartedAtMs) ||
          activationStartedAtMs < 0
        )
      ) {
        throw new Error(
          "Discussion checkpoint has an invalid activation start timestamp.",
        );
      }
      const setup = parseDiscussionSetupCheckpoint(
        Reflect.get(serialized.state, "setup"),
      );
      if (setup === undefined) {
        delete serialized.state.setup;
      } else {
        serialized.state.setup = setup;
      }
      const continuation = parseDiscussionContinuationCheckpoint(
        Reflect.get(serialized.state, "continuation"),
      );
      if (continuation === undefined) {
        delete serialized.state.continuation;
      } else {
        validateDiscussionContinuationCheckpoint(
          serialized.state,
          continuation,
        );
        serialized.state.continuation = continuation;
      }
      return serialized.state;
    }
    case "pipeline": {
      const ids: unknown = Reflect.get(serialized.state, "questionTaskIds");
      if (ids !== undefined) serialized.state.questionTaskIds = pipelineQuestionTaskIdsSchema.parse(ids);
      return serialized.state;
    }
    case "chain":
      return serialized.state;
    case "broadcast": {
      const slots: unknown = Reflect.get(serialized.state, "settledSlots");
      if (slots !== undefined) serialized.state.settledSlots = broadcastSettledSlotsSchema.parse(slots);
      return serialized.state;
    }
    case "review": {
      const phase: unknown = Reflect.get(serialized.state, "pendingPhase");
      if (phase !== undefined) serialized.state.pendingPhase = reviewQuestionPhaseSchema.parse(phase);
      return serialized.state;
    }
    default:
      return assertUnsupportedSerializedEngineState(serialized);
  }
}

function parseDiscussionContinuationCheckpoint(
  value: unknown,
): DiscussionContinuationProgress | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Discussion continuation checkpoint must be an object.");
  }
  const startedAtMs = value.startedAtMs;
  if (
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    startedAtMs < 0
  ) {
    throw new Error(
      "Discussion continuation checkpoint has an invalid start timestamp.",
    );
  }
  if (value.phase === "awaiting_lead_decision") {
    if (Object.keys(value).some((key) => !["phase", "startedAtMs"].includes(key))) {
      throw new Error(
        "Discussion continuation checkpoint contains fields invalid for a lead decision.",
      );
    }
    return { phase: "awaiting_lead_decision", startedAtMs };
  }
  if (value.phase === "running_specialist_pass") {
    const passNumber = value.passNumber;
    if (typeof passNumber !== "number" || !Number.isInteger(passNumber) || passNumber <= 0) {
      throw new Error("Discussion continuation checkpoint has an invalid pass number.");
    }
    const completedTargets = requireCheckpointNameList(
      value.completedTargets,
      "completed targets",
    );
    const successfulTargets = requireCheckpointNameList(
      value.successfulTargets,
      "successful targets",
    );
    const attemptNumberValue = value.attemptNumber;
    const attemptNumber = attemptNumberValue === undefined
      ? 0
      : attemptNumberValue;
    if (
      typeof attemptNumber !== "number" ||
      !Number.isInteger(attemptNumber) ||
      attemptNumber < 0
    ) {
      throw new Error(
        "Discussion continuation checkpoint has an invalid attempt number.",
      );
    }
    if (successfulTargets.some((target) => !completedTargets.includes(target))) {
      throw new Error(
        "Discussion continuation checkpoint successes must be completed targets.",
      );
    }
    const targets = value.targets === undefined
      ? undefined
      : requireCheckpointNames(value.targets, "pass targets");
    requireCheckpointKeys(
      value,
      [
        "phase",
        "startedAtMs",
        "passNumber",
        "attemptNumber",
        "targets",
        "assignment",
        "completedTargets",
        "successfulTargets",
      ],
      "Discussion continuation checkpoint",
    );
    const assignment = parseDiscussionAssignmentCheckpoint(value.assignment);
    return {
      phase: "running_specialist_pass",
      startedAtMs,
      passNumber,
      attemptNumber,
      ...whenDefined(targets, (presentTargets) => ({
        targets: presentTargets,
      })),
      ...whenDefined(assignment, (presentAssignment) => ({
        assignment: presentAssignment,
      })),
      completedTargets,
      successfulTargets,
    };
  }
  if (value.phase === "publishing_continuation") {
    const reason = requireCheckpointText(value.reason, "continuation reason");
    const message = requireCheckpointText(value.message, "continuation message");
    const targets = requireCheckpointNames(value.targets, "continuation targets");
    requireCheckpointKeys(
      value,
      ["phase", "startedAtMs", "reason", "message", "targets"],
      "Discussion continuation checkpoint",
    );
    return {
      phase: "publishing_continuation",
      startedAtMs,
      reason,
      message,
      targets,
    };
  }
  if (value.phase === "publishing_completion") {
    const reason = requireCheckpointText(value.reason, "completion reason");
    const finalResponse = requireCheckpointText(
      value.finalResponse,
      "completion response",
    );
    requireCheckpointKeys(
      value,
      ["phase", "startedAtMs", "reason", "finalResponse"],
      "Discussion continuation checkpoint",
    );
    return {
      phase: "publishing_completion",
      startedAtMs,
      reason,
      finalResponse,
    };
  }
  if (value.phase !== "awaiting_specialist_pass") {
    throw new Error("Discussion continuation checkpoint has an invalid phase.");
  }
  if (
    Object.keys(value).some(
      (key) => !["phase", "startedAtMs", "assignment"].includes(key),
    )
  ) {
    throw new Error("Discussion continuation checkpoint contains unknown fields.");
  }
  if (value.assignment === undefined) {
    return { phase: "awaiting_specialist_pass", startedAtMs };
  }
  if (!isRecord(value.assignment)) {
    throw new Error("Discussion continuation checkpoint assignment must be an object.");
  }
  const message = value.assignment.message;
  const targets = value.assignment.targets;
  if (
    typeof message !== "string" ||
    !message.trim() ||
    !Array.isArray(targets) ||
    targets.length === 0 ||
    !targets.every((target): target is string =>
      typeof target === "string" && Boolean(target.trim()),
    ) ||
    new Set(targets).size !== targets.length
  ) {
    throw new Error("Discussion continuation checkpoint assignment is invalid.");
  }
  if (
    Object.keys(value.assignment).some(
      (key) => !["message", "targets"].includes(key),
    )
  ) {
    throw new Error(
      "Discussion continuation checkpoint assignment contains unknown fields.",
    );
  }
  return {
    phase: "awaiting_specialist_pass",
    startedAtMs,
    assignment: { message, targets: [...targets] },
  };
}

function validateDiscussionContinuationCheckpoint(
  discussion: DiscussionState,
  continuation: DiscussionContinuationProgress,
): void {
  const round = Reflect.get(discussion, "round");
  if (typeof round !== "number" || !Number.isInteger(round) || round < 0) {
    throw new Error("Discussion checkpoint has an invalid round.");
  }
  const approvedRoster = requireCheckpointNameList(
    Reflect.get(discussion, "approvedRoster"),
    "approved roster",
  );
  const requireRosterTargets = (targets: readonly string[]): void => {
    if (targets.some((target) => !approvedRoster.includes(target))) {
      throw new Error(
        "Discussion continuation checkpoint targets must stay inside the approved roster.",
      );
    }
  };

  if (continuation.phase === "awaiting_specialist_pass") {
    if (round > 0 && continuation.assignment === undefined) {
      throw new Error(
        "Discussion continuation checkpoint requires the next pass assignment.",
      );
    }
    if (continuation.assignment) {
      requireRosterTargets(continuation.assignment.targets);
    }
    return;
  }
  if (continuation.phase === "running_specialist_pass") {
    if (
      continuation.passNumber !== round &&
      continuation.passNumber !== round + 1
    ) {
      throw new Error(
        "Discussion continuation checkpoint pass does not match its round.",
      );
    }
    if (continuation.passNumber === 1 && continuation.assignment) {
      throw new Error(
        "Discussion continuation checkpoint cannot assign follow-up work on the first pass.",
      );
    }
    if (continuation.passNumber > 1 && !continuation.assignment) {
      throw new Error(
        "Discussion continuation checkpoint requires an assignment after the first pass.",
      );
    }
    const passTargets = continuation.targets ??
      continuation.assignment?.targets ??
      approvedRoster;
    requireRosterTargets(passTargets);
    if (
      continuation.assignment &&
      continuation.targets &&
      continuation.assignment.targets.some(
        (target) => !continuation.targets?.includes(target),
      )
    ) {
      throw new Error(
        "Discussion continuation checkpoint pass targets must include its assignment targets.",
      );
    }
    if (
      continuation.completedTargets.some(
        (target) => !passTargets.includes(target),
      )
    ) {
      throw new Error(
        "Discussion continuation checkpoint completed targets must belong to the pass.",
      );
    }
    if (
      continuation.completedTargets.length > 0 &&
      round !== continuation.passNumber
    ) {
      throw new Error(
        "Discussion continuation checkpoint cannot complete targets before the pass round begins.",
      );
    }
    const messages = Reflect.get(discussion, "messages");
    if (!Array.isArray(messages)) {
      throw new Error("Discussion checkpoint messages must be an array.");
    }
    if (
      continuation.successfulTargets.some(
        (target) => !hasAcceptedDiscussionEvidence(
          messages,
          target,
          continuation.passNumber,
        ),
      )
    ) {
      throw new Error(
        "Discussion continuation checkpoint successful targets require same-pass accepted evidence.",
      );
    }
    return;
  }
  if (continuation.phase === "publishing_continuation") {
    requireRosterTargets(continuation.targets);
  }
}

function hasAcceptedDiscussionEvidence(
  messages: readonly unknown[],
  target: string,
  passNumber: number,
): boolean {
  return messages.some((message) => {
    if (!isRecord(message)) return false;
    const from = message.from;
    const assignedTarget = message.target === undefined
      ? from
      : message.target;
    return (
      typeof from === "string" &&
      Boolean(from.trim()) &&
      assignedTarget === target &&
      message.round === passNumber &&
      message.type === "position" &&
      typeof message.message === "string" &&
      Boolean(message.message.trim()) &&
      typeof message.dispatchId === "string" &&
      Boolean(message.dispatchId.trim())
    );
  });
}

function parseDiscussionSetupCheckpoint(
  value: unknown,
): DiscussionSetupProgress | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.phase !== "awaiting_roster_announcement") {
    throw new Error("Discussion setup checkpoint has an invalid phase.");
  }
  requireCheckpointKeys(
    value,
    ["phase", "agents", "rosterRationale"],
    "Discussion setup checkpoint",
  );
  const agents = requireCheckpointNames(value.agents, "setup agents");
  if (!isRecord(value.rosterRationale)) {
    throw new Error("Discussion setup checkpoint rationale must be an object.");
  }
  const rationaleNames = Object.keys(value.rosterRationale);
  if (
    rationaleNames.length !== agents.length ||
    rationaleNames.some((name) => !agents.includes(name))
  ) {
    throw new Error(
      "Discussion setup checkpoint rationale must match the selected agents.",
    );
  }
  const rosterRationale: Record<string, string> = {};
  for (const agent of agents) {
    rosterRationale[agent] = requireCheckpointText(
      value.rosterRationale[agent],
      `rationale for '${agent}'`,
    );
  }
  return {
    phase: "awaiting_roster_announcement",
    agents,
    rosterRationale,
  };
}

function requireCheckpointText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Discussion checkpoint ${label} must be non-empty text.`);
  }
  return value;
}

function requireCheckpointNames(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string =>
      typeof item === "string" && Boolean(item.trim()),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Discussion checkpoint ${label} must be unique names.`);
  }
  return [...value];
}

function requireCheckpointNameList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string =>
      typeof item === "string" && Boolean(item.trim()),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Discussion checkpoint ${label} must be unique names.`);
  }
  return [...value];
}

function parseDiscussionAssignmentCheckpoint(
  value: unknown,
): DiscussionContinuationAssignment | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Discussion continuation checkpoint assignment must be an object.");
  }
  requireCheckpointKeys(
    value,
    ["message", "targets"],
    "Discussion continuation checkpoint assignment",
  );
  return {
    message: requireCheckpointText(value.message, "assignment message"),
    targets: requireCheckpointNames(value.targets, "assignment targets"),
  };
}

function requireCheckpointKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unknown fields.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertUnsupportedEngineState(value: never): never {
  throw new Error(`Unsupported engine state: ${JSON.stringify(value)}`);
}

function assertUnsupportedSerializedEngineState(value: never): never {
  throw new Error(
    `Unsupported serialized engine state: ${JSON.stringify(value)}`,
  );
}
