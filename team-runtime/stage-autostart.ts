/**
 * Runs the stage tool of a runtime-owned level (pipeline, chain, broadcast or
 * review) when the Team Runtime starts that stage itself.
 *
 * Success: `runtime.stage_autostart.begin`, the run clock, the invoke, a
 * `runtime_autostart` row in `tool-use.jsonl`, `runtime.stage_autostart.end`
 * with `is_error: false`, then the level advance. The advance runs inside the
 * same `try`, so an advance that throws takes the failure arm too.
 *
 * Failure: an agent question goes to `suspendForAgentQuestion` and the arm
 * stops there. Otherwise, while the shutdown signal has not fired, the level
 * state read at that moment moves to FAILED when the transition is allowed.
 * Then persist, render, an error row, and an end event with `is_error` and
 * `cancelled`. The run failure is requested only when the shutdown signal has
 * not fired.
 *
 * `runDelegatedRoutingAutostart` runs a routing level's coordinator instead.
 * Success: `runtime.stage_autostart.begin`, then inside the `try` the run
 * clock, the coordinator marked active, a persist, and one durable coordinator
 * call keyed `<session>:routing:<level>:visit:<visit>:decision`. The reply body
 * is written as the routing artifact and published to team chat when chat mode
 * is on, the budget policy runs on the run total, the coordinator is marked
 * done, `runtime.stage_autostart.end` names the artifact, and the level
 * advances. It writes no tool-use row. Its failure arm is the one above, with
 * two differences: when the failure is recorded the coordinator is marked
 * failed before the FAILED transition, and no error row is written.
 *
 * Runtime state outside the level state is written through
 * `StageAutostartPorts`, and the session ids are read through it at each
 * record, as the runtime state holds them then. The routing arm also reads the
 * run total, budget ledger, shutdown signal, chat mode and Team name through
 * `DelegatedRoutingAutostartPorts` at each use. This module has no
 * environment reads of its own; `runAgent`, which the routing arm calls, reads
 * the provider's environment when it launches the coordinator. It invokes the
 * stage tool only through `RuntimeToolInvoker.invoke`.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BudgetLedger } from "../core/budget-ledger.js";
import { STAGE_LIFECYCLE_STATUS } from "../core/constants.js";
import { whenDefined } from "../core/optional-properties.js";
import type {
  AgentRunResult,
  LevelState,
  LoadedAgent,
  RoutingStageConfig,
} from "../core/types.js";
import { runAgent } from "../domains/agent-execution/agent-runner.js";
import type { DelegatedRoutingAutostartPlan } from "../domains/delegation/delegated-routing-autostart.js";
import {
  buildArtifactMetadata,
  parseMarkdownArtifact,
  writeMarkdownArtifact,
} from "../domains/runtime/artifacts.js";
import { logRuntimeEvent, logToolUse } from "../domains/runtime/logger.js";
import type { RuntimeToolInvoker } from "../domains/runtime/runtime-context.js";
import { shouldRecordRuntimeAutostartFailure } from "../domains/runtime/runtime-autostart-failure.js";
import { publishAcceptedTeamChatMessage } from "../domains/runtime/team-chat-messages.js";
import {
  canTransitionStageStatus,
  transitionStageStatus,
} from "../domains/stage/stage-lifecycle.js";
import { withDirectAgentBudgetAdmission } from "./direct-agent-budget-admission.js";
import {
  executeDurableCoordinatorCall,
  reconcileDurableCoordinatorCost,
} from "./durable-coordinator-call.js";

/** The assignment and level every record of one autostart names. */
export interface AutostartRunIdentity {
  readonly assignmentPath: string;
  readonly levelId: string;
  readonly stageType: string;
}

/** The session ids the runtime state holds when a record is written. */
export interface AutostartSessionIds {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
}

/** The runtime-state writes an autostart makes, bound to one level. */
export interface StageAutostartPorts {
  persist(): void;
  render(): void;
  /** Returns true when the error was an agent question and the run is suspended. */
  suspendForAgentQuestion(error: unknown): boolean;
  requestRunFailure(error: string): void;
  advanceLevel(): Promise<void>;
  /** Starts the run clock unless it is already running. */
  startRunClock(): void;
  /** Read at each record rather than once, because a later session_start can change them. */
  readSessionIds(): AutostartSessionIds;
}

export interface EngineToolAutostartInput {
  readonly identity: AutostartRunIdentity;
  readonly toolName: string;
  readonly invoker: RuntimeToolInvoker;
  readonly toolInput: Readonly<{ action?: "resume" }>;
  /** Whether the tool starts the run clock. */
  readonly isEngineTool: boolean;
  /** Written to the begin event. */
  readonly registeredTools: readonly string[];
  /** Called in the failure arm when anything in the `try` threw and the error is not an agent question. */
  readonly readLevelState: () => LevelState | undefined;
  readonly signal: AbortSignal;
  readonly extensionContext: ExtensionContext;
}

export async function runEngineToolAutostart(
  input: EngineToolAutostartInput,
  ports: StageAutostartPorts,
): Promise<true> {
  const { identity, toolName } = input;
  const toolCallId = `runtime-autostart-${randomUUID()}-${toolName}`;

  const beginIds = ports.readSessionIds();
  logRuntimeEvent(identity.assignmentPath, {
    timestamp: new Date().toISOString(),
    event: "runtime.stage_autostart.begin",
    session_id: beginIds.sessionId,
    root_session_id: beginIds.rootSessionId,
    level_id: identity.levelId,
    stage_type: identity.stageType,
    tool_name: toolName,
    tool_call_id: toolCallId,
    registered_tools: input.registeredTools,
  });

  if (input.isEngineTool) ports.startRunClock();

  try {
    await input.invoker.invoke({
      toolCallId,
      input: input.toolInput,
      signal: input.signal,
      extensionContext: input.extensionContext,
    });
    const endIds = ports.readSessionIds();
    logToolUse(
      identity.assignmentPath,
      toolName,
      toolCallId,
      false,
      endIds.rootSessionId,
      {
        runtime_autostart: true,
        level_id: identity.levelId,
        stage_type: identity.stageType,
      },
    );
    logRuntimeEvent(identity.assignmentPath, {
      timestamp: new Date().toISOString(),
      event: "runtime.stage_autostart.end",
      session_id: endIds.sessionId,
      root_session_id: endIds.rootSessionId,
      level_id: identity.levelId,
      stage_type: identity.stageType,
      tool_name: toolName,
      tool_call_id: toolCallId,
      is_error: false,
    });
    await ports.advanceLevel();
    return true;
  } catch (err) {
    return recordEngineToolAutostartFailure(input, toolCallId, err, ports);
  }
}

/**
 * The failure arm. A throwing `persist` stops it before the error row, the end
 * event and the run failure.
 */
function recordEngineToolAutostartFailure(
  input: EngineToolAutostartInput,
  toolCallId: string,
  err: unknown,
  ports: StageAutostartPorts,
): true {
  if (ports.suspendForAgentQuestion(err)) return true;
  const { identity, toolName } = input;
  const errorText = describeAutostartError(err);
  const recordFailure = shouldRecordRuntimeAutostartFailure(input.signal);
  failRecordedLevelState(recordFailure, input.readLevelState());
  ports.persist();
  ports.render();
  const failureIds = ports.readSessionIds();
  logToolUse(
    identity.assignmentPath,
    toolName,
    toolCallId,
    true,
    failureIds.rootSessionId,
    {
      runtime_autostart: true,
      level_id: identity.levelId,
      stage_type: identity.stageType,
      error: errorText,
    },
  );
  logRuntimeEvent(identity.assignmentPath, {
    timestamp: new Date().toISOString(),
    event: "runtime.stage_autostart.end",
    session_id: failureIds.sessionId,
    root_session_id: failureIds.rootSessionId,
    level_id: identity.levelId,
    stage_type: identity.stageType,
    tool_name: toolName,
    tool_call_id: toolCallId,
    is_error: recordFailure,
    cancelled: !recordFailure,
    error: errorText,
  });
  if (recordFailure) ports.requestRunFailure(errorText);
  return true;
}

/** Updates to the coordinator's metrics entry the caller read when the autostart started. */
export interface CoordinatorMetricsPort {
  markActive(): void;
  markDone(
    result: Pick<AgentRunResult, "cost" | "contextTokens" | "model">,
  ): void;
  markFailed(error: string): void;
}

/** The runtime-state reads and writes a delegated routing autostart adds. */
export interface DelegatedRoutingAutostartPorts extends StageAutostartPorts {
  readonly coordinatorMetrics: CoordinatorMetricsPort;
  readTotalCost(): number;
  writeTotalCost(totalCost: number): void;
  readBudgetLedger(): BudgetLedger | undefined;
  readShutdownSignal(): AbortSignal;
  /** Whether accepted replies are published to team chat. Read after the call returns. */
  readChatMode(): boolean;
  /** Read when the routing artifact is written. */
  readTeamName(): string;
}

export interface DelegatedRoutingAutostartInput {
  readonly identity: AutostartRunIdentity;
  /** Its `config.constraints.max_time_minutes` is read when the durable request is built and again when the coordinator runs. */
  readonly stage: RoutingStageConfig;
  readonly coordinator: LoadedAgent;
  readonly plan: Pick<DelegatedRoutingAutostartPlan, "systemPrompt" | "userMessage">;
  /** Whether the coordinator is given a question context. */
  readonly humanQuestions: boolean;
  readonly resumeAfterQuestion: boolean;
  /** Written to the question context and the team chat message. */
  readonly teamId: string;
  /** The routing artifact's path. */
  readonly outputPath: string;
  /** Written to the successful end event as `output_artifact`. */
  readonly relativeOutputPath: string;
  /** Called when the call is keyed, and in the failure arm when the error is not an agent question. */
  readonly readLevelState: () => LevelState | undefined;
}

export async function runDelegatedRoutingAutostart(
  input: DelegatedRoutingAutostartInput,
  ports: DelegatedRoutingAutostartPorts,
): Promise<true> {
  const { identity, stage, coordinator, plan } = input;
  const outputDir = identity.assignmentPath;
  const runtimeCallId = `runtime-autostart-${randomUUID()}-delegated-routing`;
  const beginIds = ports.readSessionIds();
  logRuntimeEvent(outputDir, {
    timestamp: new Date().toISOString(),
    event: "runtime.stage_autostart.begin",
    session_id: beginIds.sessionId,
    root_session_id: beginIds.rootSessionId,
    level_id: identity.levelId,
    stage_type: identity.stageType,
    tool_name: "delegated_routing_autostart",
    tool_call_id: runtimeCallId,
  });

  try {
    ports.startRunClock();
    ports.coordinatorMetrics.markActive();
    ports.persist();
    const invocationId = `${ports.readSessionIds().sessionId}:routing:${identity.levelId}:visit:${input.readLevelState()?.visitCount ?? 0}:decision`;
    const routingCall = await executeDurableCoordinatorCall({
      assignmentPath: outputDir,
      invocationId,
      resumeAfterQuestion: input.resumeAfterQuestion,
      request: {
        provider: coordinator.provider,
        model: coordinator.model,
        thinking: coordinator.thinking,
        ...whenDefined(coordinator.providerConfig, (providerConfig) => ({
          providerConfig,
        })),
        systemPrompt: `${coordinator.systemPrompt}\n\n${plan.systemPrompt}`,
        userMessage: plan.userMessage,
        ...whenDefined(
          stage.config.constraints?.max_time_minutes,
          (timeoutMinutes) => ({ timeoutMinutes }),
        ),
      },
      baseTotalCost: ports.readTotalCost(),
      now: () => new Date().toISOString(),
      // Waiting for the receipt lock is cancelled by the same shutdown that
      // cancels the provider call, so a stopping run does not sit out the
      // lock's timeout before it can exit.
      signal: ports.readShutdownSignal(),
      invoke: () => withDirectAgentBudgetAdmission({
        ledger: ports.readBudgetLedger(),
        totalCost: ports.readTotalCost(),
        signal: ports.readShutdownSignal(),
        operation: () => {
          const callIds = ports.readSessionIds();
          return runAgent({
            systemPrompt: `${coordinator.systemPrompt}\n\n${plan.systemPrompt}`,
            userMessage: plan.userMessage,
            model: coordinator.model,
            thinking: coordinator.thinking,
            provider: coordinator.provider,
            ...whenDefined(coordinator.providerConfig, (providerConfig) => ({
              providerConfig,
            })),
            tools: [],
            cwd: outputDir,
            outputPath: outputDir,
            ...whenDefined(callIds.sessionId, (sessionId) => ({ sessionId })),
            ...whenDefined(callIds.rootSessionId, (rootSessionId) => ({
              rootSessionId,
            })),
            agentName: coordinator.name,
            ...(input.humanQuestions ? { questionContext: {
              logicalInvocationId: invocationId, dispatchId: invocationId,
              teamId: input.teamId, stageId: identity.levelId,
            } } : {}),
            signal: ports.readShutdownSignal(),
            ...whenDefined(
              stage.config.constraints?.max_time_minutes,
              (timeoutMinutes) => ({ timeoutMinutes }),
            ),
          });
        },
      }),
      onDurableResult: (_result, baseTotalCost, postTotalCost) => {
        ports.writeTotalCost(reconcileDurableCoordinatorCost(
          ports.readTotalCost(),
          baseTotalCost,
          postTotalCost,
        ));
        ports.persist();
      },
      accept: (result) => {
        const artifactBody = parseMarkdownArtifact(result.text).body.trim();
        if (!artifactBody) {
          throw new Error(
            "Delegated routing coordinator returned an empty artifact.",
          );
        }
        return artifactBody;
      },
    });
    const result = routingCall.result;
    const artifactBody = routingCall.value;
    const artifactIds = ports.readSessionIds();
    writeMarkdownArtifact(
      input.outputPath,
      artifactBody,
      buildArtifactMetadata({
        filePath: input.outputPath,
        rootDir: outputDir,
        artifactType: "result",
        artifactRole: "final",
        sessionId: artifactIds.sessionId,
        ...whenDefined(artifactIds.rootSessionId, (rootSessionId) => ({
          rootSessionId,
        })),
        ...whenDefined(artifactIds.parentSessionId, (parentSessionId) => ({
          parentSessionId,
        })),
        team: ports.readTeamName(),
        agent: coordinator.name,
        level: identity.levelId,
        stageType: identity.stageType,
        status: "completed",
        title: "Routing decision",
      }),
    );
    publishAcceptedTeamChatMessage({
      chatMode: ports.readChatMode(), levelId: identity.levelId,
      outputPath: outputDir, teamName: input.teamId, state: ports.readSessionIds(),
    }, { agentName: coordinator.name, dispatchId: invocationId,
      stageType: identity.stageType, text: artifactBody });
    ports.readBudgetLedger()?.applyPolicy(ports.readTotalCost());
    ports.coordinatorMetrics.markDone(result);
    const endIds = ports.readSessionIds();
    logRuntimeEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: "runtime.stage_autostart.end",
      session_id: endIds.sessionId,
      root_session_id: endIds.rootSessionId,
      level_id: identity.levelId,
      stage_type: identity.stageType,
      tool_name: "delegated_routing_autostart",
      tool_call_id: runtimeCallId,
      output_artifact: input.relativeOutputPath,
      is_error: false,
    });
    await ports.advanceLevel();
    return true;
  } catch (error) {
    return recordDelegatedRoutingAutostartFailure(
      input,
      runtimeCallId,
      error,
      ports,
    );
  }
}

/**
 * The routing failure arm. A throwing `persist` stops it before the end event
 * and the run failure.
 */
function recordDelegatedRoutingAutostartFailure(
  input: DelegatedRoutingAutostartInput,
  runtimeCallId: string,
  error: unknown,
  ports: DelegatedRoutingAutostartPorts,
): true {
  if (ports.suspendForAgentQuestion(error)) return true;
  const { identity } = input;
  const errorText = describeAutostartError(error);
  const recordFailure = shouldRecordRuntimeAutostartFailure(
    ports.readShutdownSignal(),
  );
  if (recordFailure) ports.coordinatorMetrics.markFailed(errorText);
  failRecordedLevelState(recordFailure, input.readLevelState());
  ports.persist();
  ports.render();
  const failureIds = ports.readSessionIds();
  logRuntimeEvent(identity.assignmentPath, {
    timestamp: new Date().toISOString(),
    event: "runtime.stage_autostart.end",
    session_id: failureIds.sessionId,
    root_session_id: failureIds.rootSessionId,
    level_id: identity.levelId,
    stage_type: identity.stageType,
    tool_name: "delegated_routing_autostart",
    tool_call_id: runtimeCallId,
    is_error: recordFailure,
    cancelled: !recordFailure,
    error: errorText,
  });
  if (recordFailure) ports.requestRunFailure(errorText);
  return true;
}

/** The error's stack, else its message, else its string form. */
export function describeAutostartError(err: unknown): string {
  return err instanceof Error ? err.stack || err.message : String(err);
}

/**
 * Moves the level state to FAILED when the failure is recorded, the state
 * exists, it is not FAILED already, and the lifecycle allows the transition.
 */
export function failRecordedLevelState(
  recordFailure: boolean,
  levelState: LevelState | undefined,
): void {
  if (
    recordFailure &&
    levelState &&
    levelState.stageStatus !== STAGE_LIFECYCLE_STATUS.FAILED &&
    canTransitionStageStatus(
      levelState.stageStatus,
      STAGE_LIFECYCLE_STATUS.FAILED,
    )
  ) {
    transitionStageStatus(levelState, STAGE_LIFECYCLE_STATUS.FAILED);
  }
}
