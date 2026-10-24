/**
 * Team Runtime — Level Lifecycle
 *
 * Manages the level state machine: gate evaluation, level advancement,
 * loopback handling, experience reflections.
 *
 * These three functions form one cohesive unit — "what happens when a
 * level finishes" — and are tightly coupled through shared state traversal
 * patterns.  They are extracted from index.ts (S2-T5).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isTerminalGate,
  type LevelConfig,
  type LevelState,
  type GateConfig,
  type GateResult,
  type TeamConfig,
} from "../core/types.js";
import {
  STAGE_TYPE,
  LEVEL_STATUS,
  STAGE_LIFECYCLE_STATUS,
  DEFAULT_MAX_LOOPBACKS,
} from "../core/constants.js";
import {
  checkGate,
  runGateTransform,
  writeGateReport,
  type GateTransformResult,
} from "../engines/gate-checker.js";
import { logLevelTransition, logRuntimeEvent } from "../domains/runtime/logger.js";
import { generateMinutes } from "../domains/agent-execution/minutes.js";
import {
  isDiscussionComplete,
  getDiscussionOutputPath,
} from "../engines/discussion.js";
import { isPipelineComplete } from "../engines/pipeline.js";
import { isChainComplete, getChainOutputPath } from "../engines/chain.js";
import {
  isBroadcastComplete,
  getBroadcastOutputPath,
} from "../engines/broadcast.js";
import { isReviewComplete, getReviewOutputPath } from "../engines/review.js";
import type { RuntimeContext } from "../domains/runtime/runtime-context.js";
import { runExperienceReflections } from "./experience-reflections.js";
import { getAssignmentPath } from "../domains/runtime/runtime-paths.js";
import {
  canTransitionStageStatus,
  transitionStageStatus,
} from "../domains/stage/stage-lifecycle.js";
import { buildStageEntryFollowUp } from "../domains/stage/stage-entry.js";
import { enqueueFollowUp } from "../domains/runtime/follow-up.js";
import { deleteCheckpoint } from "../domains/runtime/checkpoint.js";
import { roundUsd } from '../core/budget-ledger.js';
import { resolveRelativePathInside } from '../core/path-safety.js';
import { parseMarkdownArtifact } from '../domains/runtime/artifacts.js';
import { canRuntimeAutostartInline } from '../domains/runtime/runtime-owned-stage.js';
import { deriveEffectiveStageContractsForTeam } from '../domains/stage/stage-contracts.js';
export { runExperienceReflections } from "./experience-reflections.js";

// ── Callbacks ────────────────────────────────────────────────────────────────

/**
 * Functions that can't be derived from RuntimeContext alone and must be
 * provided by the caller (index.ts).
 */
export interface LifecycleCallbacks {
  /** Direct Team chat completes after one discussion response pass. */
  teamChatMode?: boolean;
  /** Re-register engine tools for the newly active level. */
  registerLevelTools: () => void;
  /** Start deterministic runtime-owned levels directly when supported. */
  startActiveLevel?: (extCtx: ExtensionContext) => Promise<boolean>;
  /**
   * Whether the runtime, rather than a coordinator, will drive this level.
   *
   * Injected because it is a deployment question, not a routing one: the answer
   * comes from how the process was launched. Deciding it here would make this
   * module read its own environment, and would let the two transitions answer
   * the same question differently. Only a level the runtime drives may be armed
   * at advance time; a host-managed one waits for the turn that enters it.
   */
  runtimeOwnsLevel: (level: LevelConfig) => boolean;
  /**
   * Put the host on the newly active level's pair and arm its stage.
   *
   * Injected for the same reason as `runtimeOwnsLevel`: it is a host concern,
   * not a routing one. A turn in flight defers to its own `agent_settled`; with
   * no turn in flight this is the last moment before the level's entry is sent.
   * Returns false when the host could not be prepared, and nothing may be sent.
   */
  prepareHostForActiveLevel: (extCtx: ExtensionContext) => Promise<boolean>;
  /** Defer the terminal run event until the host has finished its activity. */
  requestRunCompletion?: (completion: {
    assignmentPath: string;
    levelId: string;
    stageType: string;
  }) => void;
  /**
   * Record that the newly active level is owed an opening entry, on the exact
   * pair that level's coordinator resolves to right now.
   *
   * Called immediately before `persistState`, so the destination and the entry
   * that enters it reach the disk in one write. Split across two writes there
   * would be a crash window in which a checkpoint names a level with no record
   * of the entry that was going to enter it — which is what a restart then
   * replays blindly.
   *
   * The pair is resolved once, here, and never recomputed: a recovering process
   * reads the application default out of its *own* environment, so re-resolving
   * would silently move the resumed entry onto a different model.
   */
  admitHostEntryForActiveLevel?: () => void;
  /** Persist current runtime state to session storage. */
  persistState: () => void;
  /** Update the dashboard widget for the given extension context. */
  updateDashboard: (extCtx: ExtensionContext) => void;
}

export interface PendingStageEntryState {
  pendingStageEntryLevelId: string | null;
  levelAdvancedCoordinatorRunId: number | null;
  usedLevelToolsThisCoordinatorTurn: Set<string>;
}

export function activatePendingStageEntry(input: {
  state: PendingStageEntryState;
  currentLevelId: string;
  clearInvocationAdmissions: () => void;
  registerLevelTools: () => void;
}): void {
  if (input.state.pendingStageEntryLevelId !== input.currentLevelId) return;

  // Registration is the fail-closed boundary. Keep the pending marker until
  // every governed tool has been registered successfully, so a missing
  // runtime authority cannot make the new stage appear active without tools.
  input.state.levelAdvancedCoordinatorRunId = null;
  input.state.usedLevelToolsThisCoordinatorTurn.clear();
  input.clearInvocationAdmissions();
  input.registerLevelTools();
  input.state.pendingStageEntryLevelId = null;
}

/**
 * Whether a destination keeps completed work that a `target` loopback did not
 * reset, so the walk traverses it instead of re-entering it.
 */
function retainsCompletedWork(
  destinationState: LevelState | undefined,
  isLoopback: boolean,
): boolean {
  return (
    !isLoopback &&
    destinationState?.stageStatus === STAGE_LIFECYCLE_STATUS.COMPLETED
  );
}

// ── assertActive ─────────────────────────────────────────────────────────────

/**
 * Guard that the given level is currently ACTIVE.
 * Throws if the level state doesn't exist or has a different status.
 * Use at the entry point of operations that require an active level.
 */
export function assertActive(ctx: RuntimeContext, levelId: string): LevelState {
  const ls = ctx.state.levelStates.get(levelId);
  if (!ls) throw new Error(`No level state for '${levelId}'`);
  if (ls.status !== LEVEL_STATUS.ACTIVE) {
    throw new Error(`Level '${levelId}' is ${ls.status}, expected active`);
  }
  return ls;
}

function requireTeamConfig(ctx: RuntimeContext): TeamConfig {
  if (!ctx.teamConfig) {
    throw new Error("Cannot move between team levels before the team config is loaded");
  }
  return ctx.teamConfig;
}

function hasUsableChainOutput(outputPath: string): boolean {
  let artifactContents: string;
  try {
    if (!fs.statSync(outputPath).isFile()) return false;
    artifactContents = fs.readFileSync(outputPath, "utf8");
  } catch {
    return false;
  }

  const parsed = parseMarkdownArtifact(artifactContents);
  if (!parsed.body.trim()) return false;

  const artifactStatus = String(parsed.metadata.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["blocked", "needs_input", "failed", "error"].includes(artifactStatus)) {
    return false;
  }

  return !/^\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?(?:blocked|needs[_ -]?input|failed|error)\b/im.test(
    parsed.body,
  );
}

function completeStageAfterPassedGate(levelState: LevelState): void {
  if (levelState.stageStatus === "blocked") {
    transitionStageStatus(levelState, "running");
  }
  transitionStageStatus(levelState, "completed");
}

// ── isLevelReadyForGate ──────────────────────────────────────────────────────

/**
 * Check whether the current level has reached a state where gate evaluation
 * should proceed.  Each engine type has its own readiness criteria.
 */
export function isLevelReadyForGate(
  level: LevelConfig,
  assignmentPath: string,
  ctx: RuntimeContext,
  planPath?: string,
): boolean {
  const levelState = ctx.state.levelStates.get(level.id);
  const engineState = levelState?.engineState ?? null;

  if (
    level.stage.type === STAGE_TYPE.PIPELINE &&
    (
      levelState?.stageStatus === 'blocked' ||
      levelState?.stageStatus === 'failed'
    )
  ) {
    return false;
  }

  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING: {
      const configuredOutput = level.stage.config.output.path
        ? path.join(
            level.stage.config.output.path,
            level.stage.config.output.format,
          )
        : level.stage.config.output.format;
      const effectiveOutput = ctx.teamConfig
        ? deriveEffectiveStageContractsForTeam(ctx.teamConfig, level.id).output
        : undefined;
      const candidates = new Set([
        effectiveOutput?.completion_artifact,
        ...(effectiveOutput?.artifacts?.map((artifact) => artifact.path) ?? []),
        configuredOutput,
      ]);
      for (const candidate of candidates) {
        if (!candidate) continue;
        const outputPath = resolveRelativePathInside(
          assignmentPath,
          candidate.split(path.sep).join('/'),
        );
        if (outputPath && fs.existsSync(outputPath)) return true;
      }
      return false;
    }
    case STAGE_TYPE.DISCUSSION: {
      if (engineState?.type !== STAGE_TYPE.DISCUSSION) return false;
      if (!engineState.approvedRoster) return false;
      const outputPath = getDiscussionOutputPath(level.stage, assignmentPath);
      if (fs.existsSync(outputPath)) return true;
      return isDiscussionComplete(engineState, level.stage);
    }

    case STAGE_TYPE.PIPELINE: {
      if (!planPath) return false;
      return isPipelineComplete(planPath);
    }

    case STAGE_TYPE.CHAIN: {
      if (engineState?.type !== STAGE_TYPE.CHAIN) return false;
      const outputPath = getChainOutputPath(level.stage, assignmentPath);
      if (levelState?.stageStatus === 'failed') return false;
      if (hasUsableChainOutput(outputPath)) return true;
      if (levelState?.stageStatus === 'blocked') {
        return false;
      }
      return isChainComplete(engineState);
    }

    case STAGE_TYPE.BROADCAST: {
      if (engineState?.type !== STAGE_TYPE.BROADCAST) return false;
      const outputPath = getBroadcastOutputPath(level.stage, assignmentPath);
      if (fs.existsSync(outputPath)) return true;
      return isBroadcastComplete(engineState);
    }

    case STAGE_TYPE.REVIEW: {
      if (engineState?.type !== STAGE_TYPE.REVIEW) return false;
      const outputPath = getReviewOutputPath(level.stage, assignmentPath);
      if (fs.existsSync(outputPath)) return true;
      // Having spent every permitted iteration is bookkeeping, not success.
      // Without this, a review whose producer or reviewer failed on its last
      // iteration reads as finished, and a gate-less final level completes it
      // as though it had delivered. Chain already draws this line at :276.
      if (levelState?.stageStatus === 'failed') return false;
      return isReviewComplete(engineState);
    }
  }
}

// ── Gate Transform Execution ─────────────────────────────────────────────────

type TransformOutcome = {
  transformResult: GateTransformResult | undefined;
  shouldBlock: boolean;
};

/**
 * Execute the gate transform (if configured) and return the result.
 * Returns `shouldBlock: true` when a hard transform failure should prevent
 * level advancement.
 */
async function executeGateTransformIfNeeded(
  gate: GateConfig,
  gateResult: GateResult,
  assignmentPath: string,
  extCtx: ExtensionContext,
  ctx: RuntimeContext,
  gateIndex: number,
): Promise<TransformOutcome> {
  if (!gate.transform)
    return { transformResult: undefined, shouldBlock: false };

  const effectiveStrictness =
    gate.transform.strictness ??
    (gate.condition.type === "validation" ? gate.condition.strictness : "hard");

  if (effectiveStrictness === "off")
    return { transformResult: undefined, shouldBlock: false };

  // Ensure gate-checks dir exists before running transform
  const gateChecksDir = path.join(assignmentPath, "gate-checks");
  if (!fs.existsSync(gateChecksDir))
    fs.mkdirSync(gateChecksDir, { recursive: true });

  const transformResult = await runGateTransform(
    gate.transform,
    assignmentPath,
    ctx.teamRoot,
  );
  ctx.state.totalCost = roundUsd(ctx.state.totalCost + transformResult.cost);

  if (transformResult.error) {
    if (transformResult.routeUnavailable || effectiveStrictness === "hard") {
      extCtx.ui.notify(
        transformResult.routeUnavailable
          ? `Gate transform route unavailable: ${transformResult.error}`
          : `Gate transform failed: ${transformResult.error}`,
        "warning",
      );
      await writeGateReport(
        gate,
        gateIndex,
        gateResult,
        assignmentPath,
        transformResult,
      );
      return { transformResult, shouldBlock: true };
    }
    extCtx.ui.notify(
      `Gate transform warning (soft): ${transformResult.error}`,
      "warning",
    );
  } else {
    extCtx.ui.notify(
      `Gate transform complete → ${gate.transform.output || "gate-checks/transform-output.md"}`,
      "info",
    );
  }

  return { transformResult, shouldBlock: false };
}

// ── Completion Gate ──────────────────────────────────────────────────────────

/** Handle the completion gate path when gate passed. */
async function handleCompletionGatePassed(
  currentLevel: LevelConfig,
  extCtx: ExtensionContext,
  ctx: RuntimeContext,
  assignmentPath: string,
  callbacks: LifecycleCallbacks,
): Promise<void> {
  const currentLevelState = ctx.state.levelStates.get(currentLevel.id);
  if (currentLevelState) {
    currentLevelState.status = LEVEL_STATUS.COMPLETED;
    completeStageAfterPassedGate(currentLevelState);
  }

  if (!callbacks.teamChatMode) {
    await runExperienceReflections(currentLevel, ctx, assignmentPath);
  }

  if (!ctx.state.endTime) ctx.state.endTime = Date.now();
  ctx.levelAdvancedCoordinatorRunId = ctx.coordinatorRunId;
  // Clean up checkpoint on successful completion
  if (ctx.teamConfig) {
    deleteCheckpoint(assignmentPath);
  }
  extCtx.ui.notify(
    callbacks.teamChatMode
      ? "Team chat response complete."
      : "Assignment complete — all completion checks passed.",
    "info",
  );
  callbacks.persistState();

  if (!callbacks.teamChatMode) {
    try {
      await generateMinutes(
        requireTeamConfig(ctx),
        ctx.state,
        assignmentPath,
        ctx.shutdownController.signal,
      );
    } catch (err) {
      if (ctx.shutdownController.signal.aborted) throw err;
      console.error("[team-runtime] Minutes generation failed:", err);
    }
  }

  if (callbacks.requestRunCompletion) {
    callbacks.requestRunCompletion({
      assignmentPath,
      levelId: currentLevel.id,
      stageType: currentLevel.stage.type,
    });
    return;
  }

  // Compatibility fallback for callers that have not adopted deferred
  // completion emission yet.
  logRuntimeEvent(assignmentPath, {
    timestamp: new Date().toISOString(),
    event: "run.completed",
    session_id: ctx.state.sessionId,
    root_session_id: ctx.state.rootSessionId,
    parent_session_id: ctx.state.parentSessionId,
    assignment_path: assignmentPath,
    team: ctx.teamConfig?.team.name ?? null,
    level_id: currentLevel.id,
    stage_type: currentLevel.stage.type,
  });
}

/** Handle the completion gate path when gate failed. */
function handleCompletionGateFailed(
  gate: GateConfig,
  assignmentPath: string,
  ctx: RuntimeContext,
  currentLevel: LevelConfig,
  extCtx: ExtensionContext,
): void {
  const artifactName =
    gate.condition.type === "artifact_exists"
      ? gate.condition.artifact
      : "the required output";
  const targetPath = path.join(assignmentPath, artifactName);
  const isCoordinatorLessDeterministicStage =
    !currentLevel.stage.coordinator &&
    currentLevel.stage.type === STAGE_TYPE.REVIEW;

  if (isCoordinatorLessDeterministicStage) {
    extCtx.ui.notify(
      `Stage blocked: expected output artifact '${artifactName}' was not produced.`,
      "warning",
    );
  } else {
    enqueueFollowUp(
      ctx,
      `**COMPLETION GATE FAILED:** \`${artifactName}\` has not been created yet.\n\n` +
        `You MUST write this file before the assignment can be marked complete.\n` +
        `Use the \`write\` tool to save it to: \`${targetPath}\`\n\n` +
        `This file should be a comprehensive report synthesizing all the work done in this assignment.`,
      // Named with its level for the same reason the tool-failure notice is:
      // this starts another turn on that level, and the level's durable record
      // has to say a turn is outstanding while it runs.
      {
        kind: "runtime_notice",
        levelId: currentLevel.id,
        stageType: currentLevel.stage.type,
      },
    );
  }

  const activeLevel = ctx.teamConfig?.levels[ctx.state.currentLevelIndex];
  if (!activeLevel) return;
  const levelState = ctx.state.levelStates.get(activeLevel.id);
  if (!levelState) return;
  if (
    !levelState.stageStatus ||
    canTransitionStageStatus(levelState.stageStatus, "blocked")
  ) {
    transitionStageStatus(levelState, "blocked");
  }
}

// ── Level Advance ────────────────────────────────────────────────────────────

/**
 * Perform the actual level advance after gate has passed.
 * Handles loopback detection, level state transitions, and post-advance tasks.
 */
async function advanceLevel(
  gate: GateConfig,
  currentLevel: LevelConfig,
  targetIdx: number,
  transformResult:
    | { outputPath: string; error?: string; cost: number }
    | undefined,
  gateResult: GateResult,
  extCtx: ExtensionContext,
  ctx: RuntimeContext,
  assignmentPath: string,
  callbacks: LifecycleCallbacks,
): Promise<void> {
  const gateIndex = requireTeamConfig(ctx).gates.indexOf(gate);
  await writeGateReport(
    gate,
    gateIndex,
    gateResult,
    assignmentPath,
    transformResult,
  );

  // A `target` loopback resets only the target, so levels between the target
  // and the source keep their completed work. Re-entering such a level is a
  // traversal, not an illegal transition: it is activated as-is and its gate is
  // re-evaluated against the evidence it already holds. See
  // docs/adr/2026-08-20-Loopback-Revisit-Semantics.md.
  const isLoopback = targetIdx < ctx.state.currentLevelIndex;
  const destinationLevel = requireTeamConfig(ctx).levels[targetIdx];
  if (!destinationLevel) throw new Error(`Missing target level at index ${targetIdx}`);
  const destinationState = ctx.state.levelStates.get(destinationLevel.id);
  const destinationRetainsCompletedWork = retainsCompletedWork(
    destinationState,
    isLoopback,
  );

  const currentLevelState = ctx.state.levelStates.get(currentLevel.id);
  // A traversed level was never re-executed on this visit: its stage was
  // already `completed` when the walk arrived. Completing it again and running
  // its reflections a second time would pay the provider cost twice and append
  // duplicate scratch-pad artifacts.
  //
  // `completed` on entry uniquely denotes a traversed level here.
  // `completeStageAfterPassedGate`, declared above, is this module's only
  // writer of `completed`, and both of its call sites run *below* this point.
  // The one other way a completed level reaches gate evaluation — a team-chat
  // discussion — returns from `tryAdvanceLevel` before `advanceLevel` is ever
  // called. The condition is read from persisted level state rather than
  // call-stack context, so it holds identically after a restart.
  const sourceAlreadyCompleted =
    currentLevelState?.stageStatus === STAGE_LIFECYCLE_STATUS.COMPLETED;
  if (currentLevelState) {
    currentLevelState.status = LEVEL_STATUS.COMPLETED;
    if (!sourceAlreadyCompleted) completeStageAfterPassedGate(currentLevelState);
  }

  if (!sourceAlreadyCompleted) {
    await runExperienceReflections(currentLevel, ctx, assignmentPath);
  }

  // Loopback: target is an earlier level
  if (isLoopback) {
    const targetState = ctx.state.levelStates.get(gate.to);
    if (targetState) {
      targetState.loopbackCount++;
    }
    const resetEndIndex = gate.reset_scope === "target_through_source"
      ? ctx.state.currentLevelIndex
      : targetIdx;
    for (let index = targetIdx; index <= resetEndIndex; index += 1) {
      const resetLevel = requireTeamConfig(ctx).levels[index];
      const resetState = resetLevel
        ? ctx.state.levelStates.get(resetLevel.id)
        : undefined;
      if (!resetLevel || !resetState) continue;
      // Every level this loopback re-enters starts a new visit, not just the
      // one the gate targeted. Durable dispatch identities key off this, so a
      // level that re-ran without it would republish under its first visit's
      // identities and be deduplicated into silence.
      resetState.visitCount = (resetState.visitCount ?? 0) + 1;
      resetRuntimeOwnedStageState(assignmentPath, resetLevel);
      resetState.status = LEVEL_STATUS.PENDING;
      resetState.stageStatus = "not_started";
      resetState.engineState = null;
    }
  }

  ctx.state.currentLevelIndex = targetIdx;
  // Stage ownership is level-scoped. The destination must establish its own
  // ownership before the input interceptor can suppress a host turn.
  ctx.delegatedAutostartOwnsStage = false;
  const newLevel = destinationLevel;
  const newLevelState = ctx.state.levelStates.get(newLevel.id);
  if (newLevelState) {
    newLevelState.status = LEVEL_STATUS.ACTIVE;
    // A retained level's work is genuinely complete, so it is activated as-is;
    // `completed` is terminal and does not accept `ready`.
    if (!destinationRetainsCompletedWork) {
      transitionStageStatus(newLevelState, "ready");
    }
  }

  logLevelTransition(
    assignmentPath,
    currentLevel.id,
    newLevel.id,
    gate.condition,
  );

  extCtx.ui.notify(
    `Level advanced: ${currentLevel.name} \u2192 ${newLevel.name}` +
      (isLoopback ? " (loopback)" : ""),
    "info",
  );

  callbacks.updateDashboard(extCtx);
  // Advancing is not entering. A gate can be satisfied in the middle of a
  // coordinator's turn, and that coordinator still owns the host loop;
  // registering the destination's tools here would put them in front of it, on
  // its pair, before anything has entered the stage.
  //
  // `canRuntimeAutostartInline` cannot make that distinction on its own: it
  // answers true for every member of `STAGE_TYPE`
  // (`runtime-owned-stage.ts:55-65`), so it describes which stage *shapes* the
  // runtime could drive, not which runs it actually owns.
  //
  // Read here rather than below because the admission depends on it: a level
  // the runtime drives itself is entered by its own autostart, not by a queued
  // entry, so there is nothing to admit. A traversal is likewise not an entry —
  // it re-evaluates a level that already produced its evidence and walks on.
  const runtimeOwnsDestination =
    canRuntimeAutostartInline(newLevel) && callbacks.runtimeOwnsLevel(newLevel);
  if (!destinationRetainsCompletedWork && !runtimeOwnsDestination) {
    callbacks.admitHostEntryForActiveLevel?.();
  }
  callbacks.persistState();
  ctx.levelAdvancedCoordinatorRunId = ctx.coordinatorRunId;

  if (destinationRetainsCompletedWork) {
    // Traversal, not re-execution: the level already produced its evidence, so
    // its own gate is evaluated against it and the walk continues forward. Each
    // traversal moves the index forward, so this terminates.
    await tryAdvanceLevel(extCtx, ctx, callbacks);
    return;
  }

  if (runtimeOwnsDestination) {
    callbacks.registerLevelTools();
  }

  const startedByRuntime = runtimeOwnsDestination
    ? ((await callbacks.startActiveLevel?.(extCtx)) ?? false)
    : false;

  if (startedByRuntime) {
    ctx.pendingStageEntryLevelId = null;
  } else {
    // Keep the next stage inert until the turn that actually enters it. A gate
    // can be satisfied mid-turn, in which case that turn's `agent_settled`
    // prepares the destination; it can also be satisfied with no turn in
    // flight, and then nothing else will.
    ctx.pendingStageEntryLevelId = newLevel.id;
    // The rarer path: the runtime owned the destination but declined to start
    // it, so this entry was not admitted above. Admitted and persisted here
    // instead, still before the queue's own delayed wake-up can dispatch it.
    //
    // Gated on the caller having an admission to record. A runtime that keeps
    // no durable state passes no callback, and giving it an extra write here
    // would be a state save for a record that does not exist.
    if (runtimeOwnsDestination && callbacks.admitHostEntryForActiveLevel) {
      callbacks.admitHostEntryForActiveLevel();
      callbacks.persistState();
    }
    const prepared = await callbacks.prepareHostForActiveLevel(extCtx);
    if (!prepared) return;
    enqueueFollowUp(ctx, buildStageEntryFollowUp(newLevel), {
      kind: "stage_entry",
      levelId: newLevel.id,
      stageType: newLevel.stage.type,
    });
  }

  generateMinutes(
    requireTeamConfig(ctx),
    ctx.state,
    assignmentPath,
    ctx.shutdownController.signal,
  ).catch((err) =>
    console.error("[team-runtime] Minutes generation failed:", err),
  );
}

function resetRuntimeOwnedStageState(
  assignmentPath: string,
  level: LevelConfig,
): void {
  if (level.stage.type !== STAGE_TYPE.PIPELINE) return;
  const runtimePlanPath = resolveRelativePathInside(
    assignmentPath,
    `.runtime/pipeline/${level.id}/plan.md`,
  );
  if (!runtimePlanPath) {
    throw new Error(`Cannot reset unsafe pipeline runtime path for level '${level.id}'.`);
  }
  fs.rmSync(runtimePlanPath, { force: true });
  fs.rmSync(`${runtimePlanPath}.status.lock`, { force: true });
}

// ── tryAdvanceLevel ──────────────────────────────────────────────────────────

/**
 * Check whether the current level is complete and, if so, evaluate its gate
 * and advance (or loop back) to the next level.
 *
 * This is the core state-machine transition function. It is called every time
 * a tool execution ends.
 */
export async function tryAdvanceLevel(
  extCtx: ExtensionContext,
  ctx: RuntimeContext,
  callbacks: LifecycleCallbacks,
): Promise<void> {
  const currentLevel = requireTeamConfig(ctx).levels[ctx.state.currentLevelIndex];
  if (!currentLevel) return;

  // Guard: the current level must be active
  assertActive(ctx, currentLevel.id);

  const assignmentPath = getAssignmentPath(ctx);
  const gates = requireTeamConfig(ctx).gates.filter((g) => g.from === currentLevel.id);

  const currentLevelState = ctx.state.levelStates.get(currentLevel.id);
  if (
    callbacks.teamChatMode &&
    currentLevel.stage.type === STAGE_TYPE.DISCUSSION &&
    currentLevelState?.stageStatus === STAGE_LIFECYCLE_STATUS.COMPLETED &&
    gates.every((gate) => isTerminalGate(gate.to))
  ) {
    await handleCompletionGatePassed(
      currentLevel,
      extCtx,
      ctx,
      assignmentPath,
      callbacks,
    );
    return;
  }

  // Resolve plan path for pipeline stages (before the loop — same for all gates)
  let planPath: string | undefined;
  if (currentLevel.stage.type === STAGE_TYPE.PIPELINE) {
    planPath = path.join(
      assignmentPath,
      ".runtime",
      "pipeline",
      currentLevel.id,
      "plan.md",
    );
  }

  if (gates.length === 0) {
    // A team may route out of every level but its last, and a single-level
    // team may declare no gate at all — the shape every scheduled single-agent
    // target is generated with. Only `handleCompletionGatePassed` writes the
    // terminal run event, so without this the stage finished its work and
    // shutdown still recorded the run as incomplete, which the parent reads as
    // blocked. Earlier gate-less levels keep the old behaviour: they wait for
    // whatever else advances them.
    if (
      ctx.state.currentLevelIndex === requireTeamConfig(ctx).levels.length - 1 &&
      isLevelReadyForGate(currentLevel, assignmentPath, ctx, planPath)
    ) {
      await handleCompletionGatePassed(
        currentLevel,
        extCtx,
        ctx,
        assignmentPath,
        callbacks,
      );
    }
    return;
  }

  if (!isLevelReadyForGate(currentLevel, assignmentPath, ctx, planPath)) return;

  // Evaluate gates top-to-bottom; first passing gate wins.
  for (const gate of gates) {
    const isCompletionGate = isTerminalGate(gate.to);

    const gateResult = await checkGate(
      gate,
      assignmentPath,
      ctx.state,
      ctx.agents,
      planPath,
      ctx.shutdownController.signal,
      // So the validator's own run record names the Team it belongs to, the
      // way every other dispatch in this assignment does.
      ctx.teamConfig?.team.name,
    );

    if (isCompletionGate) {
      if (gateResult.passed) {
        await handleCompletionGatePassed(
          currentLevel,
          extCtx,
          ctx,
          assignmentPath,
          callbacks,
        );
      } else if (gates.length === 1) {
        // Only notify on failure for single-gate configs to preserve existing behavior.
        // In a routing table, a failing completion gate is silent — other gates are not evaluated.
        handleCompletionGateFailed(
          gate,
          assignmentPath,
          ctx,
          currentLevel,
          extCtx,
        );
      }
      return; // Completion gate always ends evaluation regardless of pass/fail
    }

    if (!gateResult.passed) continue; // Try next gate in the routing table

    const targetIdx = requireTeamConfig(ctx).levels.findIndex((l) => l.id === gate.to);
    if (targetIdx < 0) {
      console.error(
        `[team-runtime] Gate from '${currentLevel.id}' references unknown level '${gate.to}'. ` +
          `Check team.yaml gates configuration.`,
      );
      return;
    }

    // A capped loopback must not complete the current level and return early:
    // doing so leaves the completed level indexed as current with no active
    // level. Treat this route as unavailable and continue to later forward
    // routing-table entries instead.
    if (targetIdx < ctx.state.currentLevelIndex) {
      const targetState = ctx.state.levelStates.get(gate.to);
      const maxLoopbacks = gate.max_loopbacks ?? DEFAULT_MAX_LOOPBACKS;
      if (targetState && targetState.loopbackCount >= maxLoopbacks) {
        extCtx.ui.notify(
          `Loopback limit reached for level '${gate.to}'. Skipping this route and evaluating forward gates.`,
          "warning",
        );
        continue;
      }
    }

    // This gate passed — execute its transform (if any) and advance.
    const gateIndex = requireTeamConfig(ctx).gates.indexOf(gate);
    const { transformResult, shouldBlock } = await executeGateTransformIfNeeded(
      gate,
      gateResult,
      assignmentPath,
      extCtx,
      ctx,
      gateIndex,
    );

    if (shouldBlock) {
      const isRecoverableLoopbackRefusal =
        targetIdx < ctx.state.currentLevelIndex &&
        transformResult?.routeUnavailable === true;
      if (isRecoverableLoopbackRefusal) {
        extCtx.ui.notify(
          `Loopback route to '${gate.to}' was refused during write-free preflight. Evaluating forward gates.`,
          "warning",
        );
        continue;
      }
      return;
    }

    await advanceLevel(
      gate,
      currentLevel,
      targetIdx,
      transformResult,
      gateResult,
      extCtx,
      ctx,
      assignmentPath,
      callbacks,
    );
    return; // Stop at first passing gate — do not evaluate remaining gates
  }
}
