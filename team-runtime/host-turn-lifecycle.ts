/**
 * The host turn's lifecycle: the outer-turn claim, and what the runtime does
 * when Pi starts, ends and settles a turn.
 *
 * `index.ts` registers the `agent_start`, `agent_end` and `agent_settled`
 * handlers and hands each one's extension context here, with the ports it
 * builds once. This module is the only code that sets or clears the claim. The
 * claim itself lives where the follow-up queue reads it, and reaches this
 * module through `OuterTurnClaim`.
 *
 * - `startHostTurn` opens an outer turn when no turn owns the host: it starts
 *   a new coordinator run, then claims the host with a snapshot of the turn's
 *   starting position. An `agent_start` inside a turn that is already claimed
 *   (a retry, a queued continuation) changes neither.
 * - `endHostTurn` records the end of one model call against the turn that owns
 *   the host, requests no completion, and flushes follow-ups.
 * - `settleHostTurn` settles the turn's host entry and, on a handover, moves
 *   the host to the new level's pair and arms it, all while the claim is held.
 *   It then releases the claim, flushes follow-ups and emits completion when
 *   nothing was owed. A settle that cannot prepare its destination fails the
 *   run and releases the claim, so a later settle returns at once.
 *
 * It reads no environment and no runtime context. Each read reaches it through
 * a port called at the step that reads it, and each effect through a port
 * named for what it does.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { whenDefined } from "../core/optional-properties.js";
import type { AgentRunEvent, LevelConfig } from "../core/types.js";
import type { ModelSelectionRecord } from "../contracts/agent-model-selection.js";
import type { OuterTurnOwner } from "../domains/runtime/runtime-context.js";

// ── Ports ─────────────────────────────────────────────────────────────────

/** The outer-turn claim: who owns the host while Pi runs a turn. */
export interface OuterTurnClaim {
  /** The turn that owns the host, or null between turns. */
  current(): OuterTurnOwner | null;
  claim(owner: OuterTurnOwner): void;
  release(): void;
}

/** The coordinator run id and post-advance fence, read as a turn opens. */
export interface CoordinatorRunCounters {
  readonly runId: number;
  /** The run in which the level last advanced, or null once passed. */
  readonly levelAdvancedRunId: number | null;
}

/**
 * The bookkeeping a new coordinator run applies. Seven members because each is
 * one effect, and `startHostTurn` applies them in a fixed order.
 */
export interface CoordinatorRunBookkeeping {
  read(): CoordinatorRunCounters;
  /** Raises the coordinator run id by one. */
  raiseRunId(): void;
  clearUsedLevelTools(): void;
  clearInvocationAdmissions(): void;
  /** Forgets that the run with this id was sent a tool-failure follow-up. */
  clearFollowUpMarker(runId: number): void;
  resetToolCallCount(): void;
  clearLevelAdvanceFence(): void;
}

/** The coordinator fields a turn's snapshot names. */
export interface TurnCoordinator {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
}

/** Where the run is when an outer turn opens, read in one call. */
export interface TurnStartingPosition {
  readonly level: LevelConfig | undefined;
  readonly coordinator: TurnCoordinator | undefined;
  /** The level's admitted host entry, if it has one. */
  readonly admitted: { readonly selection: ModelSelectionRecord } | undefined;
  /**
   * How the host's pair would be decided for this coordinator now. Resolved
   * only when the level has no admitted host entry; undefined otherwise.
   */
  readonly desiredHostModelSelection: ModelSelectionRecord | undefined;
  readonly levelIndex: number;
}

/**
 * Reads of the run's position. Five members because each is made at a
 * different step of a different handler, and reading them together would read
 * some at the wrong moment and some that the step does not need.
 */
export interface RunPositionReads {
  /** Read once, when an outer turn opens. */
  startingPosition(): TurnStartingPosition;
  /** The current level index, read when a turn settles. */
  levelIndex(): number;
  currentLevel(): LevelConfig | undefined;
  /** The current level's coordinator's name, or null when it has none. */
  currentCoordinatorName(): string | null;
  /** How many tool calls the coordinator has made in this run. */
  toolCallsThisRun(): number;
}

/** What an agent-runs record names, or null before a Team and session exist. */
export interface RunRecordIdentity {
  readonly outputDir: string;
  readonly sessionId: string;
  readonly rootSessionId: string | undefined;
  readonly team: string;
}

export interface TurnRecords {
  runRecordIdentity(): RunRecordIdentity | null;
  writeAgentRun(outputDir: string, event: AgentRunEvent): void;
  /** Writes a host lifecycle event attributed to the turn that owns the host. */
  hostLifecycleEvent(event: string, extra: Record<string, unknown>): void;
  /** The assignment directory, or null before a Team and session exist. */
  assignmentOutputDir(): string | null;
}

export interface CoordinatorMetrics {
  markActive(coordinatorName: string): void;
  markDoneWhenActive(coordinatorName: string): void;
}

/** The signals the host run lifetime takes from the turn lifecycle. */
export interface HostRunSignals {
  turnStarted(): void;
  turnSettled(): void;
  runFailed(): void;
}

export interface FollowUpQueue {
  /** Whether any follow-up is queued. */
  anyOwed(): boolean;
  flush(): void;
}

export interface RunFailureRequest {
  readonly assignmentPath: string;
  readonly levelId: string;
  readonly stageType: string;
  readonly error: string;
}

export interface RunCompletionRequests {
  emitWhenIdle(idle: boolean): void;
  requestRunFailure(failure: RunFailureRequest): void;
}

/**
 * What a settle does to the host entry and the stage entries. Five members
 * because a settle and its failure path each perform them at separate steps.
 */
export interface SettlementOperations {
  settleHostEntry(levelId: string | null): void;
  /** Resolves false when the host could not be put on the level's pair. */
  enterActiveLevelOnItsOwnPair(extCtx: ExtensionContext): Promise<boolean>;
  activatePendingStageEntry(): void;
  discardPendingStageEntries(reason: string): void;
  clearPendingStageEntry(): void;
}

/** The config error that blocks further prompts. */
export interface BlockedReport {
  configErrorRecorded(): boolean;
  record(message: string): void;
  /** Writes the recorded config errors to stderr and the assignment, and notifies the UI. */
  show(extCtx: ExtensionContext): void;
}

export interface DashboardOperations {
  rememberExtensionContext(extCtx: ExtensionContext): void;
  manageRefreshTimer(): void;
  refresh(extCtx: ExtensionContext): void;
}

export interface Clock {
  now(): number;
  /** The current time as an ISO 8601 string. */
  timestamp(): string;
}

/**
 * Everything the lifecycle reads or changes. Twelve groups, one per concern;
 * each member is one operation or one read.
 */
export interface HostTurnLifecyclePorts {
  readonly claim: OuterTurnClaim;
  readonly coordinatorRun: CoordinatorRunBookkeeping;
  readonly position: RunPositionReads;
  readonly records: TurnRecords;
  readonly metrics: CoordinatorMetrics;
  readonly hostRun: HostRunSignals;
  readonly followUps: FollowUpQueue;
  readonly completion: RunCompletionRequests;
  readonly settlement: SettlementOperations;
  readonly blockedReport: BlockedReport;
  readonly dashboard: DashboardOperations;
  readonly clock: Clock;
}

// ── Pure decisions ────────────────────────────────────────────────────────

/** What opening a new coordinator run does to the run id and the fence. */
export interface NewRunDecision {
  readonly runId: number;
  /** True when the new run is past the run in which the level advanced. */
  readonly clearsLevelAdvanceFence: boolean;
}

export function newRunDecision(current: CoordinatorRunCounters): NewRunDecision {
  const runId = current.runId + 1;
  return {
    runId,
    clearsLevelAdvanceFence:
      current.levelAdvancedRunId !== null && runId > current.levelAdvancedRunId,
  };
}

/**
 * The snapshot an outer turn is claimed with.
 *
 * The admitted entry's selection names the coordinator's pair and the host's
 * selection when the level has one; otherwise the coordinator's own pair and
 * the desired host selection do.
 */
export function outerTurnOwnerSnapshot(input: {
  readonly position: TurnStartingPosition;
  readonly hostProvider: string | null;
  readonly hostModel: string | null;
  readonly coordinatorRunId: number;
  readonly startedAt: number;
}): OuterTurnOwner {
  const { level, coordinator, admitted } = input.position;
  return {
    coordinatorName: coordinator?.name ?? null,
    coordinatorProvider:
      admitted?.selection.provider ?? coordinator?.provider ?? null,
    coordinatorModel: admitted?.selection.model ?? coordinator?.model ?? null,
    hostModelSelection:
      admitted?.selection ?? input.position.desiredHostModelSelection,
    levelIndex: input.position.levelIndex,
    levelId: level?.id ?? null,
    stageType: level?.stage.type ?? null,
    hostProvider: input.hostProvider,
    hostModel: input.hostModel,
    coordinatorRunId: input.coordinatorRunId,
    startedAt: input.startedAt,
  };
}

/** What a turn's own snapshot says about it when one of its calls ends. */
export interface EndOfTurnAttribution {
  readonly turnDurationMs: number;
  readonly hostProvider: string | null;
  readonly hostModel: string | null;
  readonly coordinatorName: string | null;
  readonly levelId: string | undefined;
  readonly stageType: string | undefined;
  readonly coordinatorModel: string | undefined;
  readonly coordinatorProvider: string | undefined;
}

export function endOfTurnAttribution(
  owner: OuterTurnOwner,
  endedAt: number,
): EndOfTurnAttribution {
  return {
    turnDurationMs: endedAt - owner.startedAt,
    hostProvider: owner.hostProvider,
    hostModel: owner.hostModel,
    coordinatorName: owner.coordinatorName,
    levelId: owner.levelId ?? undefined,
    stageType: owner.stageType ?? undefined,
    coordinatorModel: owner.coordinatorModel ?? undefined,
    coordinatorProvider: owner.coordinatorProvider ?? undefined,
  };
}

/** True when the run moved to another level while the turn was running. */
export function isHandover(
  settledOwner: OuterTurnOwner,
  currentLevelIndex: number,
): boolean {
  return settledOwner.levelIndex !== currentLevelIndex;
}

/**
 * Why a settle could not hand the host to the level the run moved to.
 *
 * Only this word reaches durable data or the user. The underlying refusal or
 * arming error is never read.
 */
export type SettlePreparationFailure =
  | "host_pair_unavailable"
  | "stage_arming_failed";

export function settleFailureMessage(
  levelId: string | undefined,
  reason: SettlePreparationFailure,
): string {
  return (
    `Level '${levelId ?? "unknown"}' could not be entered: ` +
    `${reason}. Team execution is blocked.`
  );
}

// ── Handlers ──────────────────────────────────────────────────────────────

/**
 * `agent_start`.
 *
 * Opens an outer turn only when no turn owns the host. Opening one raises the
 * run id, clears the used level tools, the invocation admissions and the new
 * run's follow-up marker, resets the tool-call count, clears the post-advance
 * fence once the new run is past it, and then claims the host with a snapshot
 * of the starting position. A retry or queued continuation inside a claimed
 * turn changes none of these.
 *
 * Then, for every `agent_start`: reads the claim, tells the host run lifetime
 * a turn started, marks the owning coordinator active and writes its
 * agent-runs start record, writes `host.agent_start`, and refreshes the
 * dashboard.
 */
export function startHostTurn(
  extCtx: ExtensionContext,
  ports: HostTurnLifecyclePorts,
): void {
  const { claim, coordinatorRun, position, records, clock } = ports;
  const startsOuterTurn = claim.current() === null;
  if (startsOuterTurn) {
    const run = newRunDecision(coordinatorRun.read());
    coordinatorRun.raiseRunId();
    coordinatorRun.clearUsedLevelTools();
    coordinatorRun.clearInvocationAdmissions();
    coordinatorRun.clearFollowUpMarker(run.runId);
    coordinatorRun.resetToolCallCount();
    if (run.clearsLevelAdvanceFence) coordinatorRun.clearLevelAdvanceFence();
    const startingPosition = position.startingPosition();
    claim.claim(
      outerTurnOwnerSnapshot({
        position: startingPosition,
        hostProvider: extCtx.model?.provider ?? null,
        hostModel: extCtx.model?.id ?? null,
        coordinatorRunId: run.runId,
        startedAt: clock.now(),
      }),
    );
  }
  const owner = claim.current();
  // After the claim: the host run lifetime reads the claim to decide whether a
  // turn is in flight.
  ports.hostRun.turnStarted();
  // The owning coordinator, which after a mid-turn advance is not the current
  // level's.
  const coordinatorName = owner?.coordinatorName ?? null;
  if (coordinatorName) {
    ports.metrics.markActive(coordinatorName);
    const identity = records.runRecordIdentity();
    if (identity) {
      records.writeAgentRun(identity.outputDir, {
        timestamp: clock.timestamp(),
        event: "start",
        session_id: identity.sessionId,
        ...whenDefined(identity.rootSessionId, (root_session_id) => ({
          root_session_id,
        })),
        assignment_path: identity.outputDir,
        team: identity.team,
        ...whenDefined(owner?.levelId ?? undefined, (level_id) => ({ level_id })),
        ...whenDefined(owner?.stageType ?? undefined, (stage_type) => ({
          stage_type,
        })),
        trigger_tool: "coordinator",
        agent_name: coordinatorName,
        agent_type: "agent",
        from: identity.team,
        to: coordinatorName,
        status: "active",
        ...whenDefined(owner?.coordinatorModel ?? undefined, (model) => ({
          model,
        })),
        ...whenDefined(owner?.coordinatorProvider ?? undefined, (provider) => ({
          provider,
        })),
        ...whenDefined(owner?.hostModelSelection, (model_selection) => ({
          model_selection,
        })),
      });
    }
  }
  records.hostLifecycleEvent("host.agent_start", {
    host_provider: extCtx.model?.provider ?? null,
    host_model: extCtx.model?.id ?? null,
  });
  ports.dashboard.manageRefreshTimer();
  ports.dashboard.refresh(extCtx);
}

/**
 * `agent_end`: the end of one model call, not of the outer turn.
 *
 * Attributes the call to the turn that owns the host, from its snapshot, and
 * to the current position only when no turn owns it. Writes `host.agent_end`,
 * and `host.agent_end.no_tool_call` when the run made no tool call, marks the
 * coordinator done when it is active, writes its agent-runs end record, and
 * flushes follow-ups. It requests no completion; `settleHostTurn` does.
 */
export function endHostTurn(
  extCtx: ExtensionContext,
  ports: HostTurnLifecyclePorts,
): void {
  const { position, records, clock } = ports;
  const owner = ports.claim.current();
  const owned = owner === null ? null : endOfTurnAttribution(owner, clock.now());
  const turnDurationMs = owned === null ? null : owned.turnDurationMs;
  const hostProvider = owned ? owned.hostProvider : (extCtx.model?.provider ?? null);
  const hostModel = owned ? owned.hostModel : (extCtx.model?.id ?? null);
  records.hostLifecycleEvent("host.agent_end", {
    host_provider: hostProvider,
    host_model: hostModel,
    tool_calls_in_turn: position.toolCallsThisRun(),
    turn_duration_ms: turnDurationMs,
    idle_turn: position.toolCallsThisRun() === 0,
  });
  if (position.toolCallsThisRun() === 0) {
    records.hostLifecycleEvent("host.agent_end.no_tool_call", {
      host_provider: hostProvider,
      host_model: hostModel,
      turn_duration_ms: turnDurationMs,
    });
  }

  const coordinatorName = owned
    ? owned.coordinatorName
    : position.currentCoordinatorName();
  if (coordinatorName) {
    ports.metrics.markDoneWhenActive(coordinatorName);
    const identity = records.runRecordIdentity();
    if (identity) {
      records.writeAgentRun(identity.outputDir, {
        timestamp: clock.timestamp(),
        event: "end",
        session_id: identity.sessionId,
        ...whenDefined(identity.rootSessionId, (root_session_id) => ({
          root_session_id,
        })),
        assignment_path: identity.outputDir,
        team: identity.team,
        ...whenDefined(owned ? owned.levelId : position.currentLevel()?.id, (level_id) => ({ level_id })),
        ...whenDefined(owned ? owned.stageType : position.currentLevel()?.stage.type, (stage_type) => ({
          stage_type,
        })),
        trigger_tool: "coordinator",
        agent_name: coordinatorName,
        agent_type: "agent",
        from: identity.team,
        to: coordinatorName,
        status: "completed",
        ...whenDefined(owned?.coordinatorModel, (model) => ({
          model,
        })),
        ...whenDefined(owned?.coordinatorProvider, (provider) => ({
          provider,
        })),
      });
    }
  }
  ports.followUps.flush();
  ports.dashboard.refresh(extCtx);
}

/**
 * `agent_settled`: the end of the whole outer turn.
 *
 * Returns at once when no turn owns the host, which is also how a settle after
 * a failed one stops. Otherwise, with the claim held: settles the turn's host
 * entry, then on a handover enters the new level on its own pair (switch, then
 * arm), or else activates a pending stage entry. A follow-up timer that fires
 * during the switch's await finds the claim held and defers.
 *
 * When that fails, `failSettlePreparation` ends the run. When it succeeds:
 * reads whether any follow-up was owed, releases the claim, flushes
 * follow-ups, emits completion only when nothing was owed, tells the host run
 * lifetime the turn settled, and refreshes the dashboard.
 */
export async function settleHostTurn(
  extCtx: ExtensionContext,
  ports: HostTurnLifecyclePorts,
): Promise<void> {
  const { claim, settlement, followUps } = ports;
  const settledOwner = claim.current();
  if (!settledOwner) return;
  ports.dashboard.rememberExtensionContext(extCtx);
  const handedOver = isHandover(settledOwner, ports.position.levelIndex());

  try {
    // Settles only an entry that is still dispatching for the level that
    // settled; a destination's pending admission is left alone. Inside the
    // try because it writes.
    settlement.settleHostEntry(settledOwner.levelId);
    if (handedOver) {
      const prepared = await settlement.enterActiveLevelOnItsOwnPair(extCtx);
      if (!prepared) {
        failSettlePreparation(extCtx, "host_pair_unavailable", ports);
        return;
      }
    } else {
      settlement.activatePendingStageEntry();
    }
  } catch {
    // No binding: the thrown value can quote a request, a header or a
    // credential, so it is never read, logged or stored.
    failSettlePreparation(extCtx, "stage_arming_failed", ports);
    return;
  }

  // Read before the flush, which removes what it dispatches.
  const owedWorkOnEntry = followUps.anyOwed();
  // Released before the flush, which defers every follow-up while a turn
  // holds the claim.
  claim.release();
  followUps.flush();
  ports.completion.emitWhenIdle(!owedWorkOnEntry);
  ports.hostRun.turnSettled();
  ports.dashboard.refresh(extCtx);
}

/**
 * End the run at the settle that could not prepare its destination.
 *
 * Discards the queued stage entries and requests the run's failure; a throw
 * from either goes to stderr and the rest still runs. Clears the pending stage
 * entry. Records and shows the config error only when none is recorded yet.
 * Then releases the claim, tells the host run lifetime the run failed, and
 * refreshes the dashboard, ignoring a refresh that throws.
 */
function failSettlePreparation(
  extCtx: ExtensionContext,
  reason: SettlePreparationFailure,
  ports: HostTurnLifecyclePorts,
): void {
  const { settlement, blockedReport } = ports;
  const destination = ports.position.currentLevel();
  const message = settleFailureMessage(destination?.id, reason);

  try {
    settlement.discardPendingStageEntries(`settle_${reason}`);

    const outputDir = ports.records.assignmentOutputDir();
    if (outputDir) {
      // Failing drops any queued success, so a completion this turn requested
      // is never emitted.
      ports.completion.requestRunFailure({
        assignmentPath: outputDir,
        levelId: destination?.id ?? "",
        stageType: destination?.stage.type ?? "",
        error: message,
      });
    }
  } catch (error) {
    console.error(
      "[team-runtime] Failed to record a blocked settlement:",
      error instanceof Error ? error.message : String(error),
    );
  }
  settlement.clearPendingStageEntry();
  // A refused pair arrives with its error already recorded and shown; an
  // arming failure arrives with none.
  if (!blockedReport.configErrorRecorded()) {
    blockedReport.record(message);
    try {
      blockedReport.show(extCtx);
    } catch (error) {
      console.error(
        "[team-runtime] Failed to report a blocked settlement:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Released only now: the discard above asks the host run lifetime to
  // reconsider, and while the claim is held that finds a turn in flight
  // instead of stopping as if no work remained. The lifetime is then told the
  // run failed.
  ports.claim.release();
  ports.hostRun.runFailed();
  try {
    ports.dashboard.refresh(extCtx);
  } catch {
    // A dashboard that cannot be drawn does not stop the failure.
  }
}
