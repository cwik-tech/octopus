import { whenDefined } from "../core/optional-properties.js";
import type { FileParserLauncher } from '../core/file-parser-launcher.js';

import type { RunLauncher } from "../domains/run/run-launcher.js";
import type { RunStore } from "../domains/run/run-store.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import {
  resolveSessionDispatch,
  type SessionDispatchDecision,
  type SessionMessageTarget,
} from "../domains/sessions/session-dispatch.js";
import type { AgentTextStreamHub } from "../domains/runtime/agent-text-stream-hub.js";
import type { WorkspaceProjectContextSelection } from "../contracts/projects.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import type { WorkspaceConversationJournalRegistry } from "./workspace-conversation-journal-registry.js";
import type { WorkspaceExecutionJournalRegistry } from "./workspace-execution-journal-registry.js";
import type { McpAgentToolService } from "./mcp-agent-tool-service.js";
import type { WorkflowMcpPreflightService } from "./workflow-mcp-preflight-service.js";
import type { TaskQueue } from "./task-queue.js";
import type { SessionMessageDispatchResponse } from "../contracts/sessions.js";
import { ServiceError } from "./service-errors.js";
import {
  ensureAgentChatRepoRoot,
  runSessionAgentChatTurn,
} from "./agent-chat-service.js";
import { agentChatTurnWiring } from "./agent-chat-turn-wiring.js";
import type { SharedFolderService } from "./shared-folder-service.js";
import type { AgentTurnJournalEventObserver } from "./agent-turn-journal-recorder.js";
import { recoverInterruptedAgentChatTurns } from "./interrupted-agent-chat-recovery.js";
import { logProcessWarning } from "../domains/runtime/logger.js";
import {
  runOrchestratorMessageService,
  selectSessionWorkflowService,
} from "./run-orchestrator-service.js";
import {
  launchSessionTeamTask,
  teamTurnFingerprint,
} from "./team-launch-service.js";
import {
  classifyClaimedConversationTurn,
  readAdmittedTurnResponder,
  receptionistRequestFingerprint,
} from "./session-service.js";
import { GENERAL_AGENT_NAME } from "../domains/sessions/front-door.js";
import { frontDoorPersonaPath } from "../domains/sessions/front-door-persona.js";
import { resolveContinuationContext } from "./continuation-resolver.js";
import * as fs from "node:fs";
import { withSessionChatActivity, type SessionChatActivity } from './session-activity-service.js';
import type { AgentDialogueService } from './agent-dialogue-service.js';
import type { ResourceLibraryService } from './resource-library-service.js';

/**
 * This request's identity, computed exactly as the Coordinator turn will.
 *
 * Kept beside the dispatch so the two never disagree about what "the same
 * request" means; a divergence here would make a replay look like a new turn.
 */
function coordinatorRequestFingerprint(request: SessionDispatchRequest): string {
  return receptionistRequestFingerprint({
    text: request.text,
    ...whenDefined(request.provider, (provider) => ({ provider })),
    ...whenDefined(request.model, (model) => ({ model })),
    ...whenDefined(request.projectContext, (projectContext) => ({
      projectContext,
    })),
    ...whenDefined(request.target, (target) => ({ target })),
    ...(request.contextResultIds && request.contextResultIds.length > 0
      ? { contextResultIds: request.contextResultIds }
      : {}),
  });
}

export interface SessionDispatchServiceOptions {
  resourceLibraryService?: ResourceLibraryService;
  /**
   * What kind of connection a `connection:<id>` provider routes to.
   *
   * Threaded from the composition root, which owns provider settings. Optional
   * like everything else here, which is how it once shipped disconnected: two
   * option objects dropped it and the type checker had nothing to say, because
   * an absent optional field is indistinguishable from one nobody wired.
   */
  readonly resolveConnectionKind?: (provider: string) => string | undefined;

  sessionStore: SessionStore;
  runStore?: RunStore;
  taskQueue?: TaskQueue;
  taskLauncher?: RunLauncher;
  repoRootPath?: string;
  workspacePath?: string;
  workflowsRegistryPath?: string;
  workspaceProjectService?: WorkspaceProjectService;
  workspaceProjectContextStore?: WorkspaceProjectContextStore;
  mcpAgentToolService?: McpAgentToolService;
  agentDialogueService?: Pick<AgentDialogueService, 'start'>;
  fileParserLauncher?: FileParserLauncher;
  sharedFolderService?: SharedFolderService;
  mcpWorkflowPreflightService?: WorkflowMcpPreflightService;
  agentTextStreamHub?: AgentTextStreamHub;
  conversationJournalRegistry?: WorkspaceConversationJournalRegistry;
  executionJournalRegistry?: WorkspaceExecutionJournalRegistry;
  /** Derives provider health from what each turn records. Never authoritative. */
  providerFailureHealth?: AgentTurnJournalEventObserver;
}

export interface SessionDispatchRequest {
  sessionId: string;
  text: string;
  provider?: string;
  model?: string;
  projectContext?: WorkspaceProjectContextSelection;
  target?: SessionMessageTarget;
  /**
   * Completed results this turn carries forward.
   *
   * Resolved once, here, and given to whichever responder the target names.
   * Resolving per destination is how the same follow-up came to have context
   * when the General Agent answered it and none when a specialist did.
   */
  contextResultIds?: readonly string[];
  /** This turn's durable identity. Minted at the route when the client omits one. */
  turnId: string;
  /** Who named `turnId`: the caller, or this server on its behalf. */
  turnOrigin: "client" | "server";
  /** The client's own channel id, when it opened a preview stream. */
  streamChannelId?: string;
  signal?: AbortSignal;
  /** Trusted ownership passed between nested server entry points only. */
  chatActivity?: SessionChatActivity;
}

/**
 * Narrow the envelope to its Agents branch.
 *
 * A helper rather than an inline check because the discriminant sits one level
 * down, on `dispatch.kind`, which TypeScript will not use to narrow the outer
 * union on its own.
 */
export function isAgentsDispatchResponse(
  body: SessionMessageDispatchResponse,
): body is Extract<
  SessionMessageDispatchResponse,
  { dispatch: { kind: "agents" } }
> {
  return body.dispatch.kind === "agents";
}

export interface SessionDispatchResult {
  /** `201` for a turn this request admitted, `200` for an exact replay. */
  statusCode: 201 | 200;
  body: SessionMessageDispatchResponse;
}

/**
 * The single conversational entry point.
 *
 * Everything this function does before delegating is deliberately cheap and
 * side-effect free: read the session, read the plan, decide. Nothing reserves a
 * stream, appends a message, or touches a journal here, because the delegate
 * that owns the turn has to be the one that opens its own channel exactly once
 * — two openers on one turn id is a self-inflicted `turn_in_flight` conflict.
 */
export async function dispatchSessionMessage(
  options: SessionDispatchServiceOptions,
  request: SessionDispatchRequest,
): Promise<SessionDispatchResult> {
  return withSessionChatActivity(options.sessionStore, request.sessionId, (chatActivity) => dispatchClaimedSessionMessage(options, { ...request, chatActivity }), request.chatActivity);
}

async function dispatchClaimedSessionMessage(
  options: SessionDispatchServiceOptions,
  request: SessionDispatchRequest,
): Promise<SessionDispatchResult> {
  const session = await options.sessionStore.getSession(request.sessionId);
  if (!session) throw new ServiceError("not_found", "Session not found");

  const plan = await options.sessionStore.getRunPlan(request.sessionId);
  // One read, two questions. Who admitted this turn id decides the untargeted
  // branch; whether anyone admitted it decides whether the request may still
  // be refused over its context.
  //
  // Read for every turn, including targeted ones. Skipping it where a target
  // was named left this undefined there by construction, so the context guard
  // below read every targeted retry as a first send — and carrying a result to
  // a named specialist is this feature's main path.
  const admittedResponder = await readAdmittedTurnResponder({
    sessionId: request.sessionId,
    sessionStore: options.sessionStore,
    turnId: request.turnId,
  });
  // Passed whether or not a target was named: the rule returns on an explicit
  // target before it reads this, so replay identity cannot outrank an order.
  const decision = resolveSessionDispatch({
    ...whenDefined(request.target, (target) => ({ target })),
    plan,
    ...whenDefined(admittedResponder, (responder) => ({
      admittedResponder: responder,
    })),
    frontDoorAvailable: isFrontDoorInstalled(options.repoRootPath),
  });

  // One snapshot for this turn, whatever answers it. A rejected id is a refusal
  // rather than a silent omission: a turn a caller attached a result to must
  // not quietly answer without it.
  //
  // A turn that named nothing gets the session's recent finished work instead.
  // The composer stopped asking, because a session is one topic and a Team's
  // conclusions never enter the transcript the next agent reads — so left to
  // itself, the obvious follow-up question reached a reader who could not see
  // what it was about.
  const continuation = await resolveContinuationContext({
    sessionId: request.sessionId,
    selectedIds: request.contextResultIds ?? [],
    carryRecentWhenUnchosen: true,
    sessionStore: options.sessionStore,
    ...whenDefined(options.runStore, (runStore) => ({ runStore })),
    ...whenDefined(request.signal, (signal) => ({ signal })),
  });
  // Only a turn nobody has admitted yet may be refused over its context.
  //
  // A turn id already held is either an exact replay, which owes the caller
  // the answer it already gave, or a different request under a used id, which
  // owes it `turn_id_reused`. Refusing here ran ahead of both: a client
  // retrying after a dropped response got 400 because the artifact it had
  // referenced was rewritten in the meantime, losing an answer the server had
  // already produced and paid for. Every delegate settles that question for
  // itself before it uses the context, so deferring to them costs nothing.
  if (continuation.rejected.length > 0) {
    const claimed =
      admittedResponder !== undefined ||
      (decision.kind === "team" &&
        (await teamTurnAlreadyLaunched({
          sessionId: request.sessionId,
          sessionStore: options.sessionStore,
          turnId: request.turnId,
        })));
    if (!claimed) {
      const first = continuation.rejected[0];
      throw new ServiceError(
        "bad_request",
        `Context result ${first?.id ?? ""} is ${first?.reason ?? "unusable"}`,
        { code: "context_result_rejected" },
      );
    }
  }
  const context = continuation.context;

  if (decision.kind === "agents") {
    return dispatchToAgents(options, request, decision.agentNames, session, context);
  }
  if (decision.kind === "general-agent") {
    return dispatchToAgents(
      options,
      request,
      [GENERAL_AGENT_NAME],
      session,
      context,
    );
  }
  if (decision.kind === "team") {
    return dispatchToTeam(options, request, decision.teamId, context);
  }
  return dispatchToCoordinator(options, request, decision, context);
}

/**
 * Whether a Team turn is on record while the transcript has not caught up.
 *
 * A Team commits its task record before it appends the user's brief, so
 * between those two writes the task is the only evidence the turn was
 * admitted. That gap is exactly what `findReplayableTeamTask` covers, and
 * asking the transcript alone would call such a turn new and refuse it over
 * its context, discarding a run the session had already started.
 *
 * Asked only when a result was actually rejected, which is the rare path.
 */
async function teamTurnAlreadyLaunched(input: {
  sessionId: string;
  sessionStore: SessionStore;
  turnId: string;
}): Promise<boolean> {
  const tasks = await input.sessionStore
    .listTaskRecords(input.sessionId)
    .catch(() => []);
  return tasks.some((task) => task.sourceTurn?.turnId === input.turnId);
}

/**
 * Whether this deployment ships the front door's persona.
 *
 * A file check rather than a build flag, because the persona is the agent: a
 * repository the user edited, reset, or trimmed is the authority on whether
 * the General Agent exists, and a deployment without it must keep answering
 * untargeted turns the way it always did.
 */
function isFrontDoorInstalled(repoRootPath: string | undefined): boolean {
  if (!repoRootPath) return false;
  return fs.existsSync(frontDoorPersonaPath(repoRootPath));
}

/**
 * A turn addressed to named Agents.
 *
 * `ensureAgentChatRepoRoot` is resolved here rather than at the route, because
 * it is only this branch's precondition: a deployment with no `agents/`
 * directory can still hold an ordinary conversation, and failing every
 * Coordinator turn over an Agent requirement would be a regression the shared
 * endpoint introduced.
 */
async function dispatchToAgents(
  options: SessionDispatchServiceOptions,
  request: SessionDispatchRequest,
  agentNames: string[],
  session: Awaited<ReturnType<SessionStore["getSession"]>>,
  continuationContext: string | undefined,
): Promise<SessionDispatchResult> {
  if (!session) throw new ServiceError("not_found", "Session not found");
  // Before admission, not after. A client that posts without first loading the
  // transcript would otherwise leave every abandoned turn holding its slot,
  // and a conversation whose backlog nothing clears eventually refuses new
  // work. Bounded, and it asks no provider anything: the abandoned call's
  // outcome is unknown, and re-running it is the duplicate the replay rule
  // exists to prevent.
  if (options.conversationJournalRegistry && options.workspacePath) {
    await recoverInterruptedAgentChatTurns({
      workspacePath: options.workspacePath,
      sessionId: request.sessionId,
      conversationRegistry: options.conversationJournalRegistry,
      messages: await options.sessionStore.listChatMessages(request.sessionId),
      ...whenDefined(options.executionJournalRegistry, (executionRegistry) => ({
        executionRegistry,
      })),
      ...whenDefined(options.agentTextStreamHub, (hub) => ({ hub })),
    }).catch((error: unknown) => {
      // Non-fatal: a turn that cannot be repaired must not stop the user
      // sending a new one. Named so the failure is findable rather than
      // inferred from a slot that never comes back.
      logProcessWarning(
        "interrupted-chat-recovery",
        `Session ${request.sessionId} admitted a turn without catch-up ` +
          `(${error instanceof Error ? error.name : "unknown fault"}).`,
      );
      return [];
    });
  }
  const turn = await runSessionAgentChatTurn({
    sessionId: request.sessionId,
    session,
    sessionStore: options.sessionStore,
    repoRootPath: ensureAgentChatRepoRoot(options.repoRootPath),
    ...whenDefined(options.workflowsRegistryPath, (registryPath) => ({
      workflowsRegistryPath: registryPath,
    })),
    text: request.text,
    agentNames,
    ...whenDefined(continuationContext, (context) => ({
      continuationContext: context,
    })),
    ...(request.contextResultIds && request.contextResultIds.length > 0
      ? { contextResultIds: request.contextResultIds }
      : {}),
    ...whenDefined(request.provider, (provider) => ({ provider })),
    ...whenDefined(request.model, (model) => ({ model })),
    ...whenDefined(request.projectContext, (projectContext) => ({
      projectContext,
    })),
    ...whenDefined(request.signal, (signal) => ({ signal })),
    turnId: request.turnId,
    turnOrigin: request.turnOrigin,
    ...whenDefined(request.chatActivity, (chatActivity) => ({ chatActivity })),
    ...agentChatTurnWiring(options),
    ...whenDefined(options.resolveConnectionKind, (resolveConnectionKind) => ({
      resolveConnectionKind,
    })),
  });

  return {
    statusCode: turn.replayed ? 200 : 201,
    body: {
      dispatch: { kind: "agents", agentNames: [...agentNames] },
      user: turn.user,
      messages: turn.replies,
      meta: turn.meta,
      ...whenDefined(turn.session, (updated) => ({ session: updated })),
      // A chat-confirmed launch reports what it started, the way a Team
      // dispatch does.
      ...whenDefined(turn.task, (task) => ({ task })),
      ...whenDefined(turn.plan, (plan) => ({ plan })),
      replayed: turn.replayed === true,
      ...whenDefined(turn.incomplete, (incomplete) => ({ incomplete })),
    },
  };
}

/**
 * A turn the General Agent answers in planning mode, with or without a
 * Workflow governing it.
 *
 * An explicit Workflow target is applied to the plan first, through the same
 * compare-and-set selection service the dedicated selection endpoint uses, and
 * only then does the Coordinator run against the revised plan. Selecting is
 * not starting: a launch happens only when the turn is an unambiguous
 * confirmation of an unchanged, ready plan (or the user presses Begin
 * workflow), which `runSessionMessageTurn` enforces.
 */
async function dispatchToCoordinator(
  options: SessionDispatchServiceOptions,
  request: SessionDispatchRequest,
  decision: Extract<
    SessionDispatchDecision,
    { kind: "coordinator" } | { kind: "workflow" }
  >,
  continuationContext: string | undefined,
): Promise<SessionDispatchResult> {
  if (decision.kind === "workflow") {
    // Selecting is durable, so what the transcript already says about this
    // turn id has to be settled before it happens.
    //
    // An exact retry skips it: the compare-and-set describes the plan as it was
    // when the turn was admitted, and this turn is what changed it, so
    // re-running it would reject a request this session has already answered.
    // A turn id held by a different request is refused here rather than after,
    // because a turn nobody accepted must not leave the plan revised behind it.
    const claimed = await classifyClaimedConversationTurn({
      sessionId: request.sessionId,
      sessionStore: options.sessionStore,
      turnId: request.turnId,
      fingerprint: coordinatorRequestFingerprint(request),
    });
    if (claimed === "reused" || claimed === "unverifiable") {
      throw new ServiceError("conflict", `turn_id_${claimed}`, {
        code: `turn_id_${claimed}`,
      });
    }
    if (claimed === "unclaimed") {
      await applyExplicitWorkflowSelection(options, request);
    }
  }

  const turn = await runOrchestratorMessageService({
    ...whenDefined(options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
    sessionId: request.sessionId,
    sessionStore: options.sessionStore,
    ...whenDefined(options.taskQueue, (taskQueue) => ({ taskQueue })),
    ...whenDefined(options.taskLauncher, (taskLauncher) => ({ taskLauncher })),
    ...whenDefined(options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
    ...whenDefined(options.workspacePath, (workspacePath) => ({ workspacePath })),
    ...whenDefined(options.workflowsRegistryPath, (registryPath) => ({
      workflowsRegistryPath: registryPath,
    })),
    text: request.text,
    ...whenDefined(continuationContext, (context) => ({
      continuationContext: context,
    })),
    ...(request.contextResultIds && request.contextResultIds.length > 0
      ? { contextResultIds: request.contextResultIds }
      : {}),
    ...whenDefined(request.provider, (provider) => ({ provider })),
    ...whenDefined(request.model, (model) => ({ model })),
    ...whenDefined(request.projectContext, (projectContext) => ({
      projectContext,
    })),
    ...whenDefined(request.target, (target) => ({ target })),
    ...whenDefined(options.workspaceProjectService, (service) => ({
      workspaceProjectService: service,
    })),
    ...whenDefined(options.workspaceProjectContextStore, (store) => ({
      workspaceProjectContextStore: store,
    })),
    ...whenDefined(options.mcpWorkflowPreflightService, (service) => ({
      mcpWorkflowPreflightService: service,
    })),
    turnId: request.turnId,
    turnOrigin: request.turnOrigin,
    ...whenDefined(request.streamChannelId, (channelId) => ({
      streamChannelId: channelId,
    })),
    ...whenDefined(options.agentTextStreamHub, (hub) => ({ textStreamHub: hub })),
    ...whenDefined(options.conversationJournalRegistry, (registry) => ({
      conversationJournalRegistry: registry,
    })),
    ...whenDefined(request.signal, (signal) => ({ signal })),
  });

  const statusCode = turn.replayed ? 200 : 201;
  const common = {
    user: turn.user,
    messages: [turn.assistant],
    plan: turn.plan,
    // A chat-confirmed launch reports the task it admitted, the way the Team
    // branch does.
    ...whenDefined(turn.task, (task) => ({ task })),
    meta: turn.meta,
    ...whenDefined(turn.session, (updated) => ({ session: updated })),
    replayed: turn.replayed === true,
  };

  if (decision.kind === "workflow") {
    return {
      statusCode,
      body: {
        dispatch: { kind: "workflow", workflowId: decision.workflowId },
        ...common,
      },
    };
  }
  return {
    statusCode,
    body: {
      dispatch: {
        kind: "coordinator",
        ...(decision.selectedWorkflowId === undefined
          ? {}
          : { selectedWorkflowId: decision.selectedWorkflowId }),
      },
      ...common,
    },
  };
}

/** A turn that starts one Team task, or replays the one it already started. */
async function dispatchToTeam(
  options: SessionDispatchServiceOptions,
  request: SessionDispatchRequest,
  teamId: string,
  continuationContext: string | undefined,
): Promise<SessionDispatchResult> {
  const launched = await launchSessionTeamTask({
    sessionId: request.sessionId,
    sessionStore: options.sessionStore,
    ...whenDefined(options.runStore, (runStore) => ({ runStore })),
    ...whenDefined(options.taskQueue, (taskQueue) => ({ taskQueue })),
    ...whenDefined(options.taskLauncher, (taskLauncher) => ({ taskLauncher })),
    ...whenDefined(options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
    ...whenDefined(options.workspacePath, (workspacePath) => ({ workspacePath })),
    ...whenDefined(options.workflowsRegistryPath, (registryPath) => ({
      workflowsRegistryPath: registryPath,
    })),
    ...whenDefined(options.workspaceProjectService, (service) => ({
      workspaceProjectService: service,
    })),
    ...whenDefined(options.workspaceProjectContextStore, (store) => ({
      workspaceProjectContextStore: store,
    })),
    ...whenDefined(options.mcpWorkflowPreflightService, (service) => ({
      mcpWorkflowPreflightService: service,
    })),
    teamId,
    brief: request.text,
    ...whenDefined(continuationContext, (context) => ({
      continuationContext: context,
    })),
    ...whenDefined(request.projectContext, (projectContext) => ({
      projectContext,
    })),
    sourceTurn: {
      turnId: request.turnId,
      fingerprint: teamTurnFingerprint({
        text: request.text,
        teamId,
        ...(request.contextResultIds && request.contextResultIds.length > 0
          ? { contextResultIds: request.contextResultIds }
          : {}),
        ...whenDefined(request.projectContext, (projectContext) => ({
          projectContext,
        })),
      }),
    },
  });

  return {
    statusCode: launched.replayed ? 200 : 201,
    body: {
      dispatch: { kind: "team", teamId },
      user: launched.user,
      // A Team turn publishes only the brief; every reply it produces belongs
      // to the task's own execution journal, not to this conversation.
      messages: [],
      plan: launched.plan,
      task: launched.task,
      ...whenDefined(launched.session, (updated) => ({ session: updated })),
      replayed: launched.replayed,
    },
  };
}

/**
 * Apply an explicit Workflow target to the persisted plan.
 *
 * Selecting, never launching. The Coordinator then answers against the plan
 * this produced; a launch still requires an unambiguous chat confirmation of
 * the unchanged, ready plan or the Begin workflow action.
 */
async function applyExplicitWorkflowSelection(
  options: SessionDispatchServiceOptions,
  request: SessionDispatchRequest,
): Promise<void> {
  const target = request.target;
  if (!target || target.kind !== "workflow") {
    throw new ServiceError("bad_request", "Workflow dispatch requires a target");
  }
  await selectSessionWorkflowService({
    sessionId: request.sessionId,
    sessionStore: options.sessionStore,
    ...whenDefined(options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
    ...whenDefined(options.workflowsRegistryPath, (registryPath) => ({
      workflowsRegistryPath: registryPath,
    })),
    workflowId: target.workflowId,
    expectedPlanId: target.expectedPlanId,
    selectionSource: "user",
  });
}
