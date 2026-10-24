/**
 * A discussion level's autostart after its setup, and each call it makes to
 * its lead.
 *
 * `runDiscussionAutostart` starts the run clock, resets the coordinator turn,
 * and finishes at once when the stage is already COMPLETED. Unless the restored
 * state holds a locked roster, it asks the lead for one, takes a default roster
 * when every roster reply was refused, and calls `set_roster`. It calls
 * `create_brief` when the roster has not been announced. Outside Team chat it
 * runs one `converse` pass. In Team chat it loops: reconcile a recovered pass,
 * run a specialist pass, publish the lead's continuation or completion, or ask
 * the lead for a decision. It finishes with `runtime.stage_autostart.end` and
 * the level advance. That promise is returned, not awaited, so a rejection from
 * the end event or the advance does not reach the failure arm. The failure arm
 * suspends on an agent question; otherwise it moves the stage to FAILED unless
 * the session is shutting down, persists, renders, writes a
 * `delegated_discussion_autostart` error row and an end event, and requests the
 * run failure unless the session is shutting down.
 *
 * `runDiscussionCoordinatorCall` is one call to the lead.
 * Each attempt takes a start time, adds one to the coordinator run id,
 * renders, and buys the lead's reply through the durable coordinator slot
 * named by the call's `invocationId`. `executeCoordinatorAttempt` marks the
 * lead's metrics and logs a `start` agent-run record, then an `end` on
 * success (and renders), an `awaiting_input` end on a question, or a `fail`
 * (and renders). A reply the call's `parse` refuses reaches here as
 * `CoordinatorCallRejectedError`: it logs `runtime.coordinator_reply.rejected`
 * and the next attempt appends the refusal to the user message. Every other
 * error propagates.
 *
 * Runtime state outside the level state is read and written through the
 * ports at each use. The level state is read through `readLevelState` at each
 * use and updated in place. The discussion clock goes through
 * `readDiscussionClock` and `writeDiscussionClock`, and the discussion start
 * time through `readDiscussionStartedAt` and `writeDiscussionStartedAt`. This module has no environment reads of its own;
 * `runAgent` reads the provider's environment when it launches the lead.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  toModelSelectionRecord,
} from "../contracts/agent-model-selection.js";
import { whenDefined } from "../core/optional-properties.js";
import type { BudgetLedger } from "../core/budget-ledger.js";
import type {
  AgentMetrics,
  DiscussionContinuationProgress,
  DiscussionStageConfig,
  DiscussionState,
  HumanInputRoutingContext,
  LevelConfig,
  LevelState,
  LoadedAgent,
  TeamConfig,
} from "../core/types.js";
import {
  applyCostTrackingPolicy,
  runAgent,
} from "../domains/agent-execution/agent-runner.js";
import {
  logAgentRun,
  logRuntimeEvent,
  logToolUse,
} from "../domains/runtime/logger.js";
import {
  acceptDiscussionLeadDecision,
  beginDiscussionContinuation,
  beginDiscussionSpecialistPass,
  buildDiscussionLeadDecisionInvocationId,
  buildDiscussionLeadDispatchId,
  markDiscussionLeadContinuation,
  markDiscussionPassComplete,
  resolveDiscussionContinuationAction,
  resolveDiscussionDispatchBudget,
  resolveDiscussionEffectiveTargets,
  deriveDiscussionContributionStatus,
} from "../core/discussion-continuation-control.js";
import { withDirectAgentBudgetAdmission } from "./direct-agent-budget-admission.js";
import { executeCoordinatorAttempt } from "./coordinator-attempt.js";
import {
  CoordinatorCallRejectedError,
  CoordinatorCallRejectionExhaustedError,
  MAX_COORDINATOR_CALL_ATTEMPTS,
  executeDurableCoordinatorCall,
  reconcileDurableCoordinatorCost,
} from "./durable-coordinator-call.js";
import { appendValidationRetryInstruction } from "../domains/agent-execution/failure-policy.js";
import {
  describeAutostartError,
  failRecordedLevelState,
  type AutostartSessionIds,
  type StageAutostartPorts,
} from "./stage-autostart.js";
import { STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from "../core/constants.js";
import { combineAbortSignals } from "../core/timeout-manager.js";
import { getDiscussionOutputPath } from "../engines/discussion.js";
import {
  DELEGATED_DISCUSSION_ROSTER_LIMIT,
  buildDelegatedDiscussionAutostartPlan,
  buildDelegatedDiscussionContinuationRequest,
  extractStandingRoster,
  parseDelegatedDiscussionContinuationDecision,
  parseDelegatedDiscussionCoordinatorSelection,
  unionDelegatedDiscussionRoster,
  type DelegatedDiscussionCoordinatorSelection,
  type DelegatedDiscussionRosterSelectionRequest,
  type DelegatedDiscussionRosterUnion,
} from "../domains/delegation/delegated-discussion-autostart.js";
import {
  buildArtifactMetadata,
  parseMarkdownArtifact,
  writeMarkdownArtifact,
} from "../domains/runtime/artifacts.js";
import type { RuntimeToolInvoker } from "../domains/runtime/runtime-context.js";
import { shouldRecordRuntimeAutostartFailure } from "../domains/runtime/runtime-autostart-failure.js";
import { publishAcceptedTeamChatMessage } from "../domains/runtime/team-chat-messages.js";
import {
  canTransitionStageStatus,
  transitionStageStatus,
} from "../domains/stage/stage-lifecycle.js";
import {
  buildDiscussionSetupToolCallId,
  prepareDiscussionPassAttempt,
} from "./discussion-pass-recovery.js";

export type DiscussionCoordinatorResult = Awaited<ReturnType<typeof runAgent>>;

/** One lead call: its durable slot, its prompt, and how its reply is parsed. */
export interface DiscussionCoordinatorCall<T> {
  readonly invocationId: string;
  /** Written to every record as `trigger_tool` or `tool_name`. */
  readonly triggerTool: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly parse: (result: DiscussionCoordinatorResult) => T;
}

/** What every lead call of one discussion autostart shares. */
export interface DiscussionCoordinatorCallInput {
  readonly assignmentPath: string;
  /** `team.name` is read at each use. */
  readonly teamConfig: Pick<TeamConfig, "team">;
  /** `id` is read at each use. */
  readonly level: Pick<LevelConfig, "id">;
  /** `type` is read at each use. */
  readonly stage: Pick<DiscussionStageConfig, "type">;
  /** The lead. Its fields are read at each use. */
  readonly coordinator: LoadedAgent;
  /** The lead's metrics entry, updated by `executeCoordinatorAttempt`. */
  readonly coordinatorMetrics: AgentMetrics | undefined;
  /** Whether the lead is given a question context, and whether a recovering start may resume its answered question. */
  readonly humanQuestions: boolean;
  /** The stage's `max_time_minutes`. */
  readonly maxDiscussionTimeMinutes: number | undefined;
  /**
   * The runtime's fault-injection value. `crash_after_discussion_selection_receipt`
   * kills the process once a `delegated_discussion_plan` result is durable.
   */
  readonly faultInjection: string | undefined;
  /** Called when the durable call invokes the lead, if the stage has a time allowance. */
  readonly readDiscussionClock: () => DiscussionContinuationProgress;
}

/** The runtime-state reads and writes a lead call makes. */
export interface DiscussionCoordinatorCallPorts {
  /** Adds one to the runtime's coordinator run id. */
  advanceCoordinatorRunId(): void;
  render(): void;
  persist(): void;
  readSessionIds(): AutostartSessionIds;
  readTotalCost(): number;
  writeTotalCost(totalCost: number): void;
  readBudgetLedger(): BudgetLedger | undefined;
  readShutdownSignal(): AbortSignal;
  /** Whether this start recovers a run. Called only when `humanQuestions` is true. */
  readRecoveryMode(): boolean;
}

export async function runDiscussionCoordinatorCall<T>(
  call: DiscussionCoordinatorCall<T>,
  input: DiscussionCoordinatorCallInput,
  ports: DiscussionCoordinatorCallPorts,
): Promise<{
  result: DiscussionCoordinatorResult;
  value: T;
  startedAtMs: number;
}> {
  const {
    assignmentPath: outputDir,
    teamConfig: activeTeamConfig,
    level: discussionLevel,
    stage: discussionStage,
    coordinator: discussionCoordinator,
    coordinatorMetrics,
    humanQuestions,
    maxDiscussionTimeMinutes,
  } = input;
  // A reply the runtime refuses is bought again with the reason fed back
  // into the prompt — the same shape `dispatchWithFailurePolicy` uses for
  // agent dispatches, which the coordinator cannot call because its call
  // is not a dispatch. The durable slot counts the attempts, so the budget
  // holds across a restart and a slot that always fails still stops.
  let retryInstruction: string | undefined;
  for (;;) {
    const startedAt = Date.now();
    ports.advanceCoordinatorRunId();
    ports.render();
    // The retry instruction deliberately stays out of the request identity.
    // The digest names the slot, and a slot whose identity changed on every
    // attempt would be refused as a changed request rather than retried.
    const attemptUserMessage = appendValidationRetryInstruction(
      call.userMessage,
      retryInstruction,
    );
    try {
      return await executeCoordinatorAttempt({
        metrics: coordinatorMetrics,
        startedAt,
        operation: async () => {
          return executeDurableCoordinatorCall({
            assignmentPath: outputDir,
            invocationId: call.invocationId,
            resumeAfterQuestion: humanQuestions && ports.readRecoveryMode(),
            request: {
              provider: discussionCoordinator.provider,
              model: discussionCoordinator.model,
              thinking: discussionCoordinator.thinking,
              ...whenDefined(
                discussionCoordinator.providerConfig,
                (providerConfig) => ({ providerConfig }),
              ),
              systemPrompt: call.systemPrompt,
              userMessage: call.userMessage,
              outputSchema: call.outputSchema,
              ...whenDefined(maxDiscussionTimeMinutes, (timeoutMinutes) => ({
                timeoutMinutes,
              })),
            },
            baseTotalCost: ports.readTotalCost(),
            now: () => new Date().toISOString(),
            // See the routing call site: shutdown cancels the receipt-lock
            // wait as well as the provider call.
            signal: ports.readShutdownSignal(),
            invoke: () => {
              const timeoutMinutes = maxDiscussionTimeMinutes === undefined
                ? undefined
                : resolveDiscussionDispatchBudget(
                    input.readDiscussionClock(),
                    maxDiscussionTimeMinutes,
                    Date.now(),
                    call.triggerTool === "delegated_discussion_decision" ? "lead-decision" : "work",
                  ).timeoutMinutes;
              return withDirectAgentBudgetAdmission({
                ledger: ports.readBudgetLedger(),
                totalCost: ports.readTotalCost(),
                signal: ports.readShutdownSignal(),
                operation: () => {
                  const callIds = ports.readSessionIds();
                  return runAgent({
                    systemPrompt: call.systemPrompt,
                    userMessage: attemptUserMessage,
                    model: discussionCoordinator.model,
                    thinking: discussionCoordinator.thinking,
                    provider: discussionCoordinator.provider,
                    ...whenDefined(discussionCoordinator.providerConfig, (providerConfig) => ({
                      providerConfig,
                    })),
                    tools: [],
                    cwd: outputDir,
                    outputPath: outputDir,
                    outputSchema: call.outputSchema,
                    ...whenDefined(callIds.sessionId, (sessionId) => ({ sessionId })),
                    ...whenDefined(callIds.rootSessionId, (rootSessionId) => ({
                      rootSessionId,
                    })),
                    agentName: discussionCoordinator.name,
                    ...(humanQuestions ? { questionContext: {
                      logicalInvocationId: call.invocationId, dispatchId: call.invocationId,
                      teamId: activeTeamConfig.team.name, stageId: discussionLevel.id,
                    } } : {}),
                    signal: ports.readShutdownSignal(),
                    ...whenDefined(timeoutMinutes, (value) => ({ timeoutMinutes: value })),
                  });
                },
              });
            },
            onDurableResult: (_result, baseTotalCost, postTotalCost) => {
              // Test-only crash point: the provider result is durable, while
              // cost and discussion state deliberately remain uncheckpointed.
              if (
                call.triggerTool === "delegated_discussion_plan" &&
                input.faultInjection ===
                  "crash_after_discussion_selection_receipt"
              ) {
                process.kill(process.pid, "SIGKILL");
              }
              ports.writeTotalCost(reconcileDurableCoordinatorCost(
                ports.readTotalCost(),
                baseTotalCost,
                postTotalCost,
              ));
              ports.persist();
            },
            prepare: (result) => {
              const acceptedText = applyCostTrackingPolicy({
                provider: discussionCoordinator.provider,
                costTracked: result.costTracked,
                budgetPolicy: ports.readBudgetLedger()?.policy,
                text: result.text,
              });
              const budgetLedger = ports.readBudgetLedger();
              if (budgetLedger?.policy === "warn") {
                budgetLedger.applyPolicy(ports.readTotalCost());
              }
              return { ...result, text: acceptedText };
            },
            accept: call.parse,
          });
        },
        usage: ({ result }) => ({
          cost: result.cost,
          contextTokens: result.contextTokens,
          model: result.model,
        }),
        onStart: () => {
          const startIds = ports.readSessionIds();
          logAgentRun(outputDir, {
            timestamp: new Date().toISOString(),
            event: "start",
            session_id: startIds.sessionId,
            ...whenDefined(startIds.rootSessionId, (root_session_id) => ({
              root_session_id,
            })),
            assignment_path: outputDir,
            team: activeTeamConfig.team.name,
            level_id: discussionLevel.id,
            stage_type: discussionStage.type,
            trigger_tool: call.triggerTool,
            agent_name: discussionCoordinator.name,
            agent_type: "agent",
            from: activeTeamConfig.team.name,
            to: discussionCoordinator.name,
            status: "active",
            model: discussionCoordinator.model,
            provider: discussionCoordinator.provider,
            // Recorded here as well as on dispatched workers: a direct
            // discussion is started by the runtime rather than by the
            // dispatcher, so without this the one agent whose model the
            // user can see running is the one with no provenance.
            ...whenDefined(
              discussionCoordinator.selection ?? undefined,
              (selection) => ({
                model_selection: toModelSelectionRecord(selection, "agent"),
              }),
            ),
          });
        },
        onComplete: ({ result }) => {
          const endIds = ports.readSessionIds();
          logAgentRun(outputDir, {
            timestamp: new Date().toISOString(),
            event: "end",
            session_id: endIds.sessionId,
            ...whenDefined(endIds.rootSessionId, (root_session_id) => ({
              root_session_id,
            })),
            assignment_path: outputDir,
            team: activeTeamConfig.team.name,
            level_id: discussionLevel.id,
            stage_type: discussionStage.type,
            trigger_tool: call.triggerTool,
            agent_name: discussionCoordinator.name,
            agent_type: "agent",
            from: activeTeamConfig.team.name,
            to: discussionCoordinator.name,
            status: "completed",
            duration_ms: Date.now() - startedAt,
            model: result.model,
            provider: discussionCoordinator.provider,
          });
          ports.render();
        },
        onWait: () => {
          logAgentRun(outputDir, {
            timestamp: new Date().toISOString(), event: 'end', session_id: ports.readSessionIds().sessionId,
            assignment_path: outputDir, team: activeTeamConfig.team.name,
            level_id: discussionLevel.id, stage_type: discussionStage.type,
            trigger_tool: call.triggerTool, agent_name: discussionCoordinator.name,
            agent_type: 'agent', status: 'awaiting_input',
            model: discussionCoordinator.model, provider: discussionCoordinator.provider,
          });
        },
        onFail: () => {
          const failIds = ports.readSessionIds();
          logAgentRun(outputDir, {
            timestamp: new Date().toISOString(),
            event: "fail",
            session_id: failIds.sessionId,
            ...whenDefined(failIds.rootSessionId, (root_session_id) => ({
              root_session_id,
            })),
            assignment_path: outputDir,
            team: activeTeamConfig.team.name,
            level_id: discussionLevel.id,
            stage_type: discussionStage.type,
            trigger_tool: call.triggerTool,
            agent_name: discussionCoordinator.name,
            agent_type: "agent",
            from: activeTeamConfig.team.name,
            to: discussionCoordinator.name,
            status: "failed",
            duration_ms: Date.now() - startedAt,
            model: discussionCoordinator.model,
            provider: discussionCoordinator.provider,
          });
          ports.render();
        },
      });
    } catch (error) {
      // Only a refused reply is retried here. Everything else — an
      // indeterminate outcome, an exhausted budget, a provider failure —
      // keeps its own meaning and propagates.
      if (error instanceof CoordinatorCallRejectedError) {
        // Frequency data, not a failure condition. `outputSchema` reaches
        // only two CLI providers as a real constraint and is dropped by
        // every API provider, and `providers/claude.ts:347-349` concedes
        // even a CLI may ignore it. Recording each refusal on a call that
        // did request a schema makes that rate measurable before anyone
        // changes provider behaviour on a hunch.
        const rejectedIds = ports.readSessionIds();
        logRuntimeEvent(outputDir, {
          timestamp: new Date().toISOString(),
          event: "runtime.coordinator_reply.rejected",
          session_id: rejectedIds.sessionId,
          root_session_id: rejectedIds.rootSessionId,
          level_id: discussionLevel.id,
          stage_type: discussionStage.type,
          tool_name: call.triggerTool,
          agent_name: discussionCoordinator.name,
          provider: discussionCoordinator.provider,
          model: discussionCoordinator.model,
          attempt: error.attemptNumber,
          output_schema_requested: true,
          reason: error.rejectionReason,
        });
        retryInstruction = error.rejectionReason;
        continue;
      }
      throw error;
    }
  }
}

/**
 * What a discussion autostart reads after its setup. Each of its lead calls
 * takes the same object as its input.
 */
export interface DiscussionAutostartInput extends DiscussionCoordinatorCallInput {
  /** `team.name` is read at each use, and the roster plan is built from it. */
  readonly teamConfig: TeamConfig;
  /** `id` and `stage.type` are read at each use. */
  readonly level: LevelConfig;
  /** The level's stage. `participants` and `config` are read at each use. */
  readonly stage: DiscussionStageConfig;
  /**
   * The discussion state the setup restored or created. Its
   * `activationStartedAtMs` is moved back when the roster call's durable
   * start is earlier.
   */
  readonly restoredState: DiscussionState;
  /** The autostart's `tool_call_id`, and the prefix of its setup call ids and of the roster chat messages' dispatch ids. */
  readonly toolCallPrefix: string;
  readonly delegatedBrief: string;
  /** The roster request. */
  readonly coordinatorRequest: DelegatedDiscussionRosterSelectionRequest;
  readonly tools: {
    readonly setRoster: RuntimeToolInvoker;
    readonly createBrief: RuntimeToolInvoker;
    readonly converse: RuntimeToolInvoker;
  };
  readonly extensionContext: ExtensionContext;
  /** Called at each read of the level's state. */
  readonly readLevelState: () => LevelState | undefined;
  /** Replaces the clock `readDiscussionClock` returns. */
  readonly writeDiscussionClock: (clock: DiscussionContinuationProgress) => void;
  readonly readDiscussionStartedAt: () => number;
  readonly writeDiscussionStartedAt: (startedAtMs: number) => void;
}

/**
 * The runtime-state reads and writes of a discussion autostart. Each of its
 * lead calls takes the same object as its ports, and `readSessionIds` returns
 * the parent session id as well.
 */
export interface DiscussionAutostartPorts
  extends DiscussionCoordinatorCallPorts,
    Pick<
      StageAutostartPorts,
      "suspendForAgentQuestion" | "requestRunFailure" | "advanceLevel" | "startRunClock"
    > {
  /**
   * Clears the level tools used this coordinator turn and the capability
   * policy's invocation admissions, and sets the coordinator's tool-call count
   * to zero.
   */
  resetCoordinatorTurn(): void;
  /** Whether the run is a Team chat. */
  readChatMode(): boolean;
  /** Read when a lead decision request is built. */
  readTeamConfig(): TeamConfig;
  readHumanInputRouting(): HumanInputRoutingContext | undefined;
  hasLoadedAgent(agentName: string): boolean;
}

export async function runDiscussionAutostart(
  input: DiscussionAutostartInput,
  ports: DiscussionAutostartPorts,
): Promise<true> {
  const {
    assignmentPath: outputDir,
    teamConfig: activeTeamConfig,
    level,
    stage: discussionStage,
    coordinator: discussionCoordinator,
    humanQuestions,
    maxDiscussionTimeMinutes,
    restoredState: restoredDiscussionState,
    toolCallPrefix,
    delegatedBrief,
    coordinatorRequest,
    extensionContext: extCtx,
    readLevelState,
    readDiscussionClock,
    writeDiscussionClock,
    readDiscussionStartedAt,
    writeDiscussionStartedAt,
  } = input;
  const {
    setRoster: setRosterTool,
    createBrief: createBriefTool,
    converse: converseTool,
  } = input.tools;

  /** Whether the stage has spent its configured time allowance. */
  const isDiscussionOutOfTime = (
    continuation: DiscussionContinuationProgress | undefined,
  ): boolean =>
    maxDiscussionTimeMinutes !== undefined &&
    resolveDiscussionDispatchBudget(
      continuation ?? readDiscussionClock(),
      maxDiscussionTimeMinutes,
      Date.now(),
    ).exhausted;

  const finishDiscussionAutostart = async (): Promise<true> => {
    const endIds = ports.readSessionIds();
    logRuntimeEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: "runtime.stage_autostart.end",
      session_id: endIds.sessionId,
      root_session_id: endIds.rootSessionId,
      level_id: level.id,
      stage_type: level.stage.type,
      tool_name: "delegated_discussion_autostart",
      tool_call_id: toolCallPrefix,
      is_error: false,
    });
    await ports.advanceLevel();
    return true;
  };

  try {
    ports.startRunClock();
    ports.resetCoordinatorTurn();
    if (
      readLevelState()?.stageStatus ===
      STAGE_LIFECYCLE_STATUS.COMPLETED
    ) {
      return finishDiscussionAutostart();
    }
    let setupState = readLevelState()?.engineState;
    let setupPlan: ReturnType<
      typeof buildDelegatedDiscussionAutostartPlan
    > | undefined;
    if (
      setupState?.type === STAGE_TYPE.DISCUSSION &&
      setupState.approvedRoster?.length &&
      setupState.rosterAnnounced !== true
    ) {
      if (!setupState.setup) {
        throw new Error(
          "Discussion recovery found a locked roster without its accepted selection rationale.",
        );
      }
      const setupMatchesRoster =
        setupState.setup.agents.length === setupState.approvedRoster.length &&
        setupState.setup.agents.every(
          (agentName, index) => setupState?.type === STAGE_TYPE.DISCUSSION &&
            setupState.approvedRoster?.[index] === agentName,
        );
      if (!setupMatchesRoster) {
        throw new Error(
          "Discussion recovery found a setup selection that differs from the locked roster.",
        );
      }
      setupPlan = buildDelegatedDiscussionAutostartPlan(
        activeTeamConfig,
        level,
        delegatedBrief,
        {
          agents: setupState.setup.agents,
          rosterRationale: setupState.setup.rosterRationale,
        },
      );
    } else if (
      setupState?.type !== STAGE_TYPE.DISCUSSION ||
      !setupState.approvedRoster?.length
    ) {
      let selection:
        | {
          readonly value: DelegatedDiscussionCoordinatorSelection;
          readonly startedAtMs: number;
        }
        | undefined;
      let rosterDegradationReason: string | undefined;
      // What this conversation already established, carried in the brief.
      const standingRoster = extractStandingRoster(delegatedBrief);
      try {
        selection = await runDiscussionCoordinatorCall({
          invocationId:
            `${ports.readSessionIds().sessionId}:discussion:${level.id}:` +
            `visit:${readLevelState()?.visitCount ?? 0}:selection`,
          triggerTool: "delegated_discussion_plan",
          systemPrompt: `${discussionCoordinator.systemPrompt}\n\n${coordinatorRequest.systemPrompt}`,
          userMessage: coordinatorRequest.userMessage,
          outputSchema: coordinatorRequest.outputSchema,
          parse: (result) => {
            const parsedSelection = parseDelegatedDiscussionCoordinatorSelection(
              result.text,
              discussionStage.participants,
              coordinatorRequest.selectionMode,
            );
            if (!parsedSelection.ok) {
              throw new Error(
                `Discussion lead returned an invalid roster selection: ${parsedSelection.reason}`,
              );
            }
            return parsedSelection.value;
          },
        }, input, ports);
      } catch (error) {
        // The lead was asked, and was retried to the whole attempt budget,
        // and still never produced a usable roster. Starting the discussion
        // with a default roster is strictly better than ending the run
        // before a single specialist has spoken — which is what session
        // b8e6afd8 did. Every other failure keeps its own meaning.
        if (!(error instanceof CoordinatorCallRejectionExhaustedError)) {
          throw error;
        }
        rosterDegradationReason = error.rejectionReason;
      }
      if (selection) {
        const receiptStartedAtMs = Math.min(
          readDiscussionStartedAt(),
          selection.startedAtMs,
        );
        if (receiptStartedAtMs !== readDiscussionStartedAt()) {
          writeDiscussionStartedAt(receiptStartedAtMs);
          restoredDiscussionState.activationStartedAtMs = receiptStartedAtMs;
          writeDiscussionClock(beginDiscussionContinuation(receiptStartedAtMs));
        }
      }
      // Additive only, enforced here rather than in the prompt: a lead that
      // named a subset of the standing roster has added nothing and removed
      // nothing. A user who addressed a specialist in turn 1 must still be
      // able to address them in turn 4.
      let rosterUnion: DelegatedDiscussionRosterUnion | undefined;
      if (selection) {
        rosterUnion = unionDelegatedDiscussionRoster({
          standingRoster,
          selection: selection.value,
          eligibleParticipants: discussionStage.participants,
        });
      }
      setupPlan = buildDelegatedDiscussionAutostartPlan(
        activeTeamConfig,
        level,
        delegatedBrief,
        rosterUnion === undefined
          ? undefined
          : {
            agents: rosterUnion.agents,
            rosterRationale: rosterUnion.rosterRationale,
          },
        ...(rosterDegradationReason === undefined && standingRoster.length === 0
          ? []
          : [{
            ...(rosterDegradationReason === undefined
              ? {}
              : { rosterDegradationReason }),
            standingRoster,
          }]),
      );
      if (rosterUnion !== undefined && rosterUnion.refusedAdditions.length > 0) {
        // The cap held and an addition could not be honoured. Surfaced
        // rather than dropped: the user asked about something the roster
        // now cannot cover, and that is theirs to know.
        const refusedIds = ports.readSessionIds();
        logRuntimeEvent(outputDir, {
          timestamp: new Date().toISOString(),
          event: "runtime.discussion.roster.addition_refused",
          session_id: refusedIds.sessionId,
          root_session_id: refusedIds.rootSessionId,
          level_id: level.id,
          stage_type: level.stage.type,
          tool_name: "delegated_discussion_plan",
          agent_name: discussionCoordinator.name,
          limit: DELEGATED_DISCUSSION_ROSTER_LIMIT,
          standing_roster: rosterUnion.agents,
          refused_additions: rosterUnion.refusedAdditions,
        });
        publishAcceptedTeamChatMessage(
          {
            chatMode: ports.readChatMode(),
            levelId: level.id,
            outputPath: outputDir,
            teamName: activeTeamConfig.team.name,
            state: ports.readSessionIds(),
          },
          {
            agentName: discussionCoordinator.name,
            dispatchId: `${toolCallPrefix}-roster-addition-refused`,
            messageType: "framing",
            stageType: level.stage.type,
            text:
              `This conversation already has the maximum of ` +
              `${DELEGATED_DISCUSSION_ROSTER_LIMIT} specialists ` +
              `(${rosterUnion.agents.join(", ")}), so I could not add ` +
              `${rosterUnion.refusedAdditions.join(", ")} for this message. ` +
              `Start a new chat with this Team if you need them.`,
          },
        );
      }
      if (rosterDegradationReason !== undefined) {
        // Visible in the run record and visible to the person who asked.
        // A roster nobody chose, presented as if the lead had chosen it,
        // would misrepresent the discussion that follows.
        const degradedIds = ports.readSessionIds();
        logRuntimeEvent(outputDir, {
          timestamp: new Date().toISOString(),
          event: "runtime.discussion.roster.degraded",
          session_id: degradedIds.sessionId,
          root_session_id: degradedIds.rootSessionId,
          level_id: level.id,
          stage_type: level.stage.type,
          tool_name: "delegated_discussion_plan",
          agent_name: discussionCoordinator.name,
          attempts: MAX_COORDINATOR_CALL_ATTEMPTS,
          reason: rosterDegradationReason,
          roster: setupPlan.agents,
        });
        publishAcceptedTeamChatMessage(
          {
            chatMode: ports.readChatMode(),
            levelId: level.id,
            outputPath: outputDir,
            teamName: activeTeamConfig.team.name,
            state: ports.readSessionIds(),
          },
          {
            agentName: discussionCoordinator.name,
            dispatchId: `${toolCallPrefix}-roster-degraded`,
            messageType: "framing",
            stageType: level.stage.type,
            text:
              `I did not choose this roster. My roster reply was rejected ` +
              `${MAX_COORDINATOR_CALL_ATTEMPTS} times (${rosterDegradationReason}), ` +
              `so the runtime started the discussion with a default roster: ` +
              `${setupPlan.agents.join(", ")}.`,
          },
        );
      }
      const setRosterCallId = buildDiscussionSetupToolCallId(
        toolCallPrefix,
        "set-roster",
      );
      await setRosterTool.invoke({
        toolCallId: setRosterCallId,
        input: { agents: setupPlan.agents },
        signal: ports.readShutdownSignal(),
        extensionContext: extCtx,
      });
      logToolUse(
        outputDir,
        "set_roster",
        setRosterCallId,
        false,
        ports.readSessionIds().rootSessionId,
        {
          runtime_autostart: true,
          delegated_discussion_autostart: true,
          level_id: level.id,
          stage_type: level.stage.type,
        },
      );
      setupState = readLevelState()?.engineState;
      if (setupState?.type !== STAGE_TYPE.DISCUSSION) {
        throw new Error("Roster selection did not create discussion state.");
      }
      // Read back from the plan, not the selection: on a degraded start
      // there is no selection, and the plan is what `set_roster` was
      // actually given in both cases.
      setupState.setup = {
        phase: "awaiting_roster_announcement",
        agents: [...setupPlan.agents],
        rosterRationale: { ...setupPlan.briefParams.roster_rationale },
      };
      ports.persist();
    }

    const initializedDiscussionState =
      readLevelState()?.engineState;
    if (initializedDiscussionState?.type !== STAGE_TYPE.DISCUSSION) {
      throw new Error("Discussion setup did not create recoverable state.");
    }
    if (initializedDiscussionState.rosterAnnounced !== true) {
      if (!setupPlan) {
        throw new Error(
          "Discussion setup cannot announce a roster without its accepted selection.",
        );
      }
      const createBriefCallId = buildDiscussionSetupToolCallId(
        toolCallPrefix,
        "create-brief",
      );
      await createBriefTool.invoke({
        toolCallId: createBriefCallId,
        input: setupPlan.briefParams,
        signal: ports.readShutdownSignal(),
        extensionContext: extCtx,
      });
      logToolUse(
        outputDir,
        "create_brief",
        createBriefCallId,
        false,
        ports.readSessionIds().rootSessionId,
        {
          runtime_autostart: true,
          delegated_discussion_autostart: true,
          level_id: level.id,
          stage_type: level.stage.type,
        },
      );
      if (ports.readChatMode()) {
        delete initializedDiscussionState.setup;
      }
    }
    if (ports.readChatMode() && !initializedDiscussionState.continuation) {
      initializedDiscussionState.continuation = initializedDiscussionState.round > 0
        ? markDiscussionPassComplete(readDiscussionClock())
        : readDiscussionClock();
    }
    ports.persist();
    if (
      !ports.readChatMode() &&
      input.faultInjection === "crash_after_discussion_setup_checkpoint"
    ) {
      process.kill(process.pid, "SIGKILL");
    }

    const invokeDiscussionPass = async (
      passNumber: number,
      passInput: Readonly<Record<string, unknown>>,
      passToolCallId: string,
      attemptNumber?: number,
    ): Promise<void> => {
      const remainingMinutes = maxDiscussionTimeMinutes === undefined
        ? undefined
        : resolveDiscussionDispatchBudget(
            readDiscussionClock(),
            maxDiscussionTimeMinutes,
            Date.now(),
          ).timeoutMinutes;
      const passSignal = combineAbortSignals(
        ports.readShutdownSignal(),
        remainingMinutes === undefined
          ? undefined
          : AbortSignal.timeout(
              Math.max(1, Math.ceil(remainingMinutes * 60_000)),
            ),
      );
      await converseTool.invoke({
        toolCallId: passToolCallId,
        input: passInput,
        signal: passSignal,
        extensionContext: extCtx,
      });
      logToolUse(
        outputDir,
        "converse",
        passToolCallId,
        false,
        ports.readSessionIds().rootSessionId,
        {
          runtime_autostart: true,
          delegated_discussion_autostart: true,
          level_id: level.id,
          stage_type: level.stage.type,
          pass: passNumber,
          ...whenDefined(attemptNumber, (attempt) => ({ attempt })),
        },
      );
      const levelState = readLevelState();
      if (
        levelState?.stageStatus === STAGE_LIFECYCLE_STATUS.BLOCKED ||
        levelState?.stageStatus === STAGE_LIFECYCLE_STATUS.FAILED
      ) {
        throw new Error(
          `Discussion specialist pass ${passNumber} ended with stage status '${levelState.stageStatus}'.`,
        );
      }
      if (ports.readChatMode()) {
        const discussionState = levelState?.engineState;
        if (
          discussionState?.type !== STAGE_TYPE.DISCUSSION ||
          !discussionState.continuation
        ) {
          throw new Error(
            `Discussion continuation state is unavailable after specialist pass ${passNumber}.`,
          );
        }
        discussionState.continuation = markDiscussionPassComplete(
          discussionState.continuation,
        );
      }
      ports.persist();
    };

    if (!ports.readChatMode()) {
      await invokeDiscussionPass(
        1,
        {},
        `discussion-pass:${level.id}:1`,
      );
      delete initializedDiscussionState.setup;
      ports.persist();
      if (
        input.faultInjection ===
        "crash_after_non_chat_discussion_completion_checkpoint"
      ) {
        process.kill(process.pid, "SIGKILL");
      }
    } else {
      let leadCompleted = false;
      while (!leadCompleted) {
        const discussionState = readLevelState()?.engineState;
        if (discussionState?.type !== STAGE_TYPE.DISCUSSION) {
          throw new Error("Discussion continuation state is unavailable.");
        }
        // One reading of the clock for the whole turn. The continuation
        // is the stage's own progress record when it has one; a legacy
        // state without it falls back to the same clock the pass timer
        // uses, so the floor, the request and the slot cannot disagree
        // about whether this discussion is out of time.
        const discussionOutOfTime = isDiscussionOutOfTime(
          discussionState.continuation,
        );
        // The floor stops a lead finishing prematurely. Once the stage is
        // out of time the passes it would require can no longer happen, so
        // holding it would only turn a usable synthesis back into the
        // failed run this budget exists to prevent.
        const discussionMinimum = Math.min(
          Math.max(1, discussionStage.config.min_successful_participants ?? 1),
          Math.max(1, discussionState.approvedRoster?.length ?? 0),
        );
        const nextAction = resolveDiscussionContinuationAction(
          discussionState,
          discussionStage.config.max_rounds,
          readDiscussionStartedAt(),
          discussionStage.config.min_rounds,
          {
            outOfTime: discussionOutOfTime,
            minSuccessfulParticipants: discussionMinimum,
          },
        );
        if (nextAction.kind === "reconcile_specialist_pass") {
          const recoveredPass = discussionState.continuation;
          if (recoveredPass?.phase !== "running_specialist_pass") {
            throw new Error("Discussion recovery requires a running pass.");
          }
          // Older checkpoints recorded failed targets without transcript errors.
          // Restore those outcomes before asking the lead to synthesize.
          for (const target of recoveredPass.completedTargets) {
            if (recoveredPass.successfulTargets.includes(target)) continue;
            if (discussionState.messages.some((message) =>
              message.round === nextAction.passNumber &&
              message.type === 'error' &&
              (message.target ?? message.from) === target
            )) continue;
            discussionState.messages.push({
              round: nextAction.passNumber,
              from: target,
              target,
              to: discussionCoordinator.name,
              type: 'error',
              message: 'This participant did not complete its contribution.',
              timestamp: new Date().toISOString(),
            });
          }
          const contributions = deriveDiscussionContributionStatus(discussionState.messages, discussionState.approvedRoster ?? []);
          if (contributions.successfulCount < discussionMinimum) {
            throw new Error(
              `Recovered discussion pass ${nextAction.passNumber} has only ` +
                `${contributions.successfulCount} successful participant responses, ` +
                `but ${discussionMinimum} were required.`,
            );
          }
          if (!discussionState.continuation) {
            throw new Error("Discussion continuation clock is unavailable.");
          }
          for (const acceptedMessage of nextAction.acceptedMessages) {
            publishAcceptedTeamChatMessage(
              {
                chatMode: true,
                levelId: level.id,
                outputPath: outputDir,
                teamName: activeTeamConfig.team.name,
                state: ports.readSessionIds(),
              },
              {
                agentName: acceptedMessage.from,
                ...whenDefined(
                  acceptedMessage.dispatchId,
                  (dispatchId) => ({ dispatchId }),
                ),
                messageType: acceptedMessage.type,
                stageType: level.stage.type,
                text: acceptedMessage.message,
              },
            );
          }
          discussionState.continuation = markDiscussionPassComplete(
            discussionState.continuation,
          );
          ports.persist();
          continue;
        }
        if (nextAction.kind === "specialist_pass") {
          if (!discussionState.continuation) {
            throw new Error("Discussion continuation clock is unavailable.");
          }
          // Exactly one dispatch is left once the budget is spent, and it
          // belongs to the lead's wrap-up. Starting a fresh roster pass on
          // the wrap-up allowance is the runaway the budget exists to stop.
          // A pass already in flight is not affected: it reaches this loop
          // as `reconcile_specialist_pass`, and its specialists were paid.
          if (
            discussionOutOfTime &&
            discussionState.continuation.phase === "awaiting_specialist_pass"
          ) {
            discussionState.continuation = markDiscussionPassComplete(
              discussionState.continuation,
            );
            ports.persist();
            continue;
          }
          if (
            discussionState.continuation.phase !==
              "running_specialist_pass"
          ) {
            if (
              discussionState.continuation.phase !==
                "awaiting_specialist_pass"
            ) {
              throw new Error(
                "A new specialist pass requires an awaiting pass state.",
              );
            }
            const plannedTargets =
              discussionState.continuation.assignment?.targets ??
              discussionState.approvedRoster ??
              [];
            const effectiveTargets = resolveDiscussionEffectiveTargets(
              plannedTargets,
              nextAction.passNumber,
              ports.readHumanInputRouting(),
            ).filter((target) => ports.hasLoadedAgent(target));
            discussionState.continuation = beginDiscussionSpecialistPass(
              discussionState.continuation,
              nextAction.passNumber,
              effectiveTargets,
            );
            ports.persist();
          }
          const preparedAttempt = prepareDiscussionPassAttempt(
            discussionState.continuation,
            level.id,
          );
          discussionState.continuation = preparedAttempt.continuation;
          ports.persist();
          await invokeDiscussionPass(
            nextAction.passNumber,
            nextAction.input,
            preparedAttempt.toolCallId,
            preparedAttempt.continuation.attemptNumber,
          );
          continue;
        }
        const leadCallId = buildDiscussionLeadDispatchId({
          levelId: level.id,
          visitCount:
            readLevelState()?.visitCount ?? 0,
          round: discussionState.round,
        });
        if (nextAction.kind === "publish_continuation") {
          publishAcceptedTeamChatMessage(
            {
              chatMode: true,
              levelId: level.id,
              outputPath: outputDir,
              teamName: activeTeamConfig.team.name,
              state: ports.readSessionIds(),
            },
            {
              agentName: discussionCoordinator.name,
              dispatchId: leadCallId,
              messageType: "framing",
              stageType: level.stage.type,
              text: `${nextAction.reason}\n\n${nextAction.message}`,
            },
          );
          if (!discussionState.continuation) {
            throw new Error("Discussion continuation clock is unavailable.");
          }
          discussionState.continuation = markDiscussionLeadContinuation(
            discussionState.continuation,
            {
              targets: nextAction.targets,
              message: nextAction.message,
            },
          );
          ports.persist();
          continue;
        }
        if (nextAction.kind === "publish_completion") {
          const { failedParticipants } = deriveDiscussionContributionStatus(discussionState.messages, discussionState.approvedRoster ?? [])
          const partialNotice = failedParticipants.length > 0
            ? `Partial Team answer: ${failedParticipants.join(', ')} did not complete ${failedParticipants.length === 1 ? 'its' : 'their'} contribution.`
            : undefined
          const finalResponse = partialNotice ? `${partialNotice}\n\n${nextAction.finalResponse}` : nextAction.finalResponse
          publishAcceptedTeamChatMessage(
            {
              chatMode: true,
              levelId: level.id,
              outputPath: outputDir,
              teamName: activeTeamConfig.team.name,
              state: ports.readSessionIds(),
            },
            {
              agentName: discussionCoordinator.name,
              dispatchId: leadCallId,
              messageType: "synthesis",
              stageType: level.stage.type,
              text: finalResponse,
            },
          );
          const discussionOutputPath = getDiscussionOutputPath(
            discussionStage,
            outputDir,
          );
          const finalResponseBody = parseMarkdownArtifact(
            nextAction.finalResponse,
          ).body.trim();
          if (!finalResponseBody) {
            throw new Error(
              "Discussion lead completion cannot publish an empty artifact.",
            );
          }
          const artifactIds = ports.readSessionIds();
          writeMarkdownArtifact(
            discussionOutputPath,
            partialNotice ? `${partialNotice}\n\n${finalResponseBody}` : finalResponseBody,
            buildArtifactMetadata({
              filePath: discussionOutputPath,
              rootDir: outputDir,
              artifactType: "result",
              artifactRole: "final",
              sessionId: artifactIds.sessionId,
              ...whenDefined(
                artifactIds.rootSessionId,
                (rootSessionId) => ({ rootSessionId }),
              ),
              ...whenDefined(
                artifactIds.parentSessionId,
                (parentSessionId) => ({ parentSessionId }),
              ),
              team: activeTeamConfig.team.name,
              agent: discussionCoordinator.name,
              level: level.id,
              stageType: level.stage.type,
              status: "complete",
            }),
          );
          const completedLevelState = readLevelState();
          if (
            completedLevelState &&
            completedLevelState.stageStatus !== STAGE_LIFECYCLE_STATUS.COMPLETED
          ) {
            if (
              !canTransitionStageStatus(
                completedLevelState.stageStatus,
                STAGE_LIFECYCLE_STATUS.COMPLETED,
              )
            ) {
              throw new Error(
                `Discussion cannot complete from stage status '${completedLevelState.stageStatus}'.`,
              );
            }
            transitionStageStatus(
              completedLevelState,
              STAGE_LIFECYCLE_STATUS.COMPLETED,
            );
          }
          ports.persist();
          leadCompleted = true;
          continue;
        }
        const selectedAgents = discussionState.approvedRoster;
        if (!selectedAgents || selectedAgents.length === 0) {
          throw new Error(
            `Discussion roster is unavailable after specialist pass ${discussionState.round}.`,
          );
        }

        // Running out of time ends the deliberation, not the run: the lead
        // is asked for the best synthesis the work so far supports instead
        // of being allowed to open another round.
        const outOfTime = isDiscussionOutOfTime(
          discussionState.continuation,
        );
        const leadRequest = buildDelegatedDiscussionContinuationRequest({
          humanQuestions,
          teamConfig: ports.readTeamConfig(),
          level,
          delegatedBrief,
          selectedAgents,
          completedRounds: discussionState.round,
          transcript: discussionState.messages,
          failedParticipants: deriveDiscussionContributionStatus(discussionState.messages, selectedAgents).failedParticipants,
          ...(outOfTime ? { outOfTime: true } : {}),
        });
        const decision = await runDiscussionCoordinatorCall({
          // A wrap-up decision is a different request from an in-budget
          // one at the same round, and a durable slot is bound to the
          // request that created it — so it needs its own slot.
          invocationId: buildDiscussionLeadDecisionInvocationId({
            sessionId: ports.readSessionIds().sessionId,
            levelId: level.id,
            visitCount:
              readLevelState()?.visitCount ?? 0,
            round: discussionState.round,
            outOfTime,
          }),
          triggerTool: "delegated_discussion_decision",
          systemPrompt: `${discussionCoordinator.systemPrompt}\n\n${leadRequest.systemPrompt}`,
          userMessage: leadRequest.userMessage,
          outputSchema: leadRequest.outputSchema,
          parse: (result) => {
            const parsedDecision = parseDelegatedDiscussionContinuationDecision(
              result.text,
              selectedAgents,
              leadRequest.allowedDecision,
            );
            if (!parsedDecision.ok) {
              throw new Error(
                `Discussion lead returned an invalid continuation decision: ${parsedDecision.reason}`,
              );
            }
            return parsedDecision.value;
          },
        }, input, ports);
        if (!discussionState.continuation) {
          throw new Error("Discussion continuation clock is unavailable.");
        }
        discussionState.continuation = acceptDiscussionLeadDecision(
          discussionState.continuation,
          decision.value,
        );
        ports.persist();
        continue;
      }
    }

    return finishDiscussionAutostart();
  } catch (err) {
    if (ports.suspendForAgentQuestion(err)) return true;
    const errorText = describeAutostartError(err);
    const recordFailure = shouldRecordRuntimeAutostartFailure(
      ports.readShutdownSignal(),
    );
    failRecordedLevelState(recordFailure, readLevelState());
    ports.persist();
    ports.render();
    logToolUse(
      outputDir,
      "delegated_discussion_autostart",
      toolCallPrefix,
      true,
      ports.readSessionIds().rootSessionId,
      {
        runtime_autostart: true,
        delegated_discussion_autostart: true,
        level_id: level.id,
        stage_type: level.stage.type,
        error: errorText,
      },
    );
    const failureIds = ports.readSessionIds();
    logRuntimeEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: "runtime.stage_autostart.end",
      session_id: failureIds.sessionId,
      root_session_id: failureIds.rootSessionId,
      level_id: level.id,
      stage_type: level.stage.type,
      tool_name: "delegated_discussion_autostart",
      tool_call_id: toolCallPrefix,
      is_error: recordFailure,
      cancelled: !recordFailure,
      error: errorText,
    });
    if (recordFailure) ports.requestRunFailure(errorText);
    return true;
  }
}
