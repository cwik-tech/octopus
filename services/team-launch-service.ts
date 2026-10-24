/**
 * One place that starts a chat-selected Team.
 *
 * Both the message endpoint and `POST /sessions/:id/tasks` reach a Team the
 * same way: resolve its generated wrapper Workflow, pin a fresh plan to it, and
 * hand it to the ordinary apply path. Keeping that in one service is what stops
 * the two entry points from drifting into two admission policies.
 */

import * as crypto from "node:crypto";

import { whenDefined } from "../core/optional-properties.js";

import type { RunLauncher } from "../domains/run/run-launcher.js";
import type { RunStore } from "../domains/run/run-store.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import { isRunPlanRevisionBlocked } from "../domains/sessions/run-plan-helpers.js";
import type { WorkspaceProjectContextSelection } from "../contracts/projects.js";
import type { RunPlan } from "../contracts/run-plan.js";
import type {
  ChatMessage,
  SessionSummary,
  SessionTask,
  SessionTaskSourceTurn,
} from "../contracts/sessions.js";
import { hashCanonicalJson } from "../core/canonical-json-hash.js";
import { ServiceError } from "./service-errors.js";
import { resolveChatFileBudget } from "./agent-chat-history.js";
import {
  applyRunPlanService,
  createRunPlanService,
} from "./run-orchestrator-service.js";
import {
  buildChatMessage,
  conversationTurnMessageId,
} from "./session-service.js";
import { loadTeamChatRuntimeBrief } from "./team-chat-context.js";
import { composeTeamChatBriefWithCarriedContext } from "../contracts/team-chat-brief.js";
import {
  ensureTeamChatTarget,
  TeamChatTargetError,
} from "./team-chat-target.js";
import type { TaskQueue } from "./task-queue.js";
import type { WorkflowMcpPreflightService } from "./workflow-mcp-preflight-service.js";
import {
  buildSessionChatFileContext,
  lockSessionChatFiles,
} from "./session-chat-file-context.js";
import { generateSessionTitle } from "../domains/sessions/session-title.js";

/**
 * The identity of a Team submission.
 *
 * Over the request only — the Team addressed and what was said to it. The plan
 * it produces and the wrapper Workflow it resolves to are outputs, so hashing
 * either would make a legitimate retry look like a different ask.
 */
export function teamTurnFingerprint(request: {
  text: string;
  teamId: string;
  projectContext?: WorkspaceProjectContextSelection;
  contextResultIds?: readonly string[];
}): string {
  return hashCanonicalJson({
    text: request.text,
    teamId: request.teamId,
    projectContext: request.projectContext ?? null,
    // Spread only when present, so a turn stored before context existed hashes
    // the exact keys it always did and still replays.
    // Sorted for the hash only; attachment order is preserved elsewhere.
    ...(request.contextResultIds && request.contextResultIds.length > 0
      ? { contextResultIds: [...request.contextResultIds].sort() }
      : {}),
  }).value;
}

/** Map a Team resolution failure onto the status it has always answered with. */
export function teamChatTargetStatus(error: unknown): number {
  if (!(error instanceof TeamChatTargetError)) return 500;
  if (error.code === "unknown_team") return 404;
  if (error.code === "team_not_user_invocable") return 403;
  return 500;
}

export interface TeamLaunchOptions {
  sessionId: string;
  sessionStore: SessionStore;
  runStore?: RunStore;
  taskQueue?: TaskQueue;
  taskLauncher?: RunLauncher;
  repoRootPath?: string;
  workspacePath?: string;
  workflowsRegistryPath?: string;
  workspaceProjectService?: WorkspaceProjectService;
  workspaceProjectContextStore?: WorkspaceProjectContextStore;
  mcpWorkflowPreflightService?: WorkflowMcpPreflightService;
  teamId: string;
  brief: string;
  /**
   * Results this turn carries forward, already resolved by the dispatcher.
   *
   * Prefixed to the brief rather than folded into the runtime frame: the frame
   * counts the user's own lines, and this is not one of them.
   */
  continuationContext?: string;
  projectContext?: WorkspaceProjectContextSelection;
  /** Present when the caller can name the turn this launch belongs to. */
  sourceTurn?: SessionTaskSourceTurn;
}

export interface TeamLaunchResult {
  task: SessionTask;
  plan: RunPlan;
  user: ChatMessage;
  session?: SessionSummary;
  /** True when this request returned a task it had already started. */
  replayed: boolean;
}

/**
 * Resolve the Team's wrapper Workflow, or say why it cannot be reached.
 *
 * Kept separate so both callers translate `TeamChatTargetError` the same way,
 * rather than one answering `404` and the other a bare `500`.
 */
export async function resolveTeamWorkflowId(input: {
  teamId: string;
  repoRootPath?: string;
  workflowsRegistryPath?: string;
}): Promise<string> {
  if (!input.repoRootPath) {
    throw new ServiceError(
      "bad_request",
      "Team chat targets require a repository root.",
    );
  }
  const target = await ensureTeamChatTarget(
    { teamId: input.teamId },
    {
      repoRootPath: input.repoRootPath,
      ...whenDefined(input.workflowsRegistryPath, (registryPath) => ({
        workflowsRegistryPath: registryPath,
      })),
    },
  );
  return target.workflowId;
}

/**
 * Find the task a turn already started, or say the id belongs to a different ask.
 *
 * This is the whole reason `sourceTurn` is durable. Task admission's status
 * gates stop a *concurrent* second launch, but they reopen the moment a run
 * finishes — so without a committed turn identity, resending a completed Team
 * brief would quietly start a second run.
 */
async function findReplayableTeamTask(input: {
  sessionId: string;
  sessionStore: SessionStore;
  sourceTurn: SessionTaskSourceTurn;
}): Promise<SessionTask | undefined> {
  const tasks = await input.sessionStore.listTaskRecords(input.sessionId);
  const claimed = tasks.filter(
    (task) => task.sourceTurn?.turnId === input.sourceTurn.turnId,
  );
  const match = claimed[0];
  if (!match) return undefined;
  if (match.sourceTurn?.fingerprint !== input.sourceTurn.fingerprint) {
    throw new ServiceError("conflict", "turn_id_reused");
  }
  return match;
}

export async function launchSessionTeamTask(
  options: TeamLaunchOptions,
): Promise<TeamLaunchResult> {
  const { sessionStore, sessionId, teamId } = options;

  // Before anything is planned or admitted: a retry must cost nothing and must
  // not depend on the plan's current status to be recognised.
  if (options.sourceTurn) {
    const existing = await findReplayableTeamTask({
      sessionId,
      sessionStore,
      sourceTurn: options.sourceTurn,
    });
    if (existing) {
      const plan = await sessionStore.getRunPlan(sessionId);
      if (!plan) {
        throw new ServiceError("conflict", "Run plan no longer exists");
      }
      // The task is durable but its brief may not be: a crash between the task
      // commit and the transcript append leaves exactly that gap. Handing back
      // a message nobody stored would show the user a conversation the next
      // reload does not have, so the line is restored rather than invented.
      const user = await persistTeamBrief({
        sessionId,
        sessionStore,
        brief: options.brief,
        ...whenDefined(options.sourceTurn, (sourceTurn) => ({ sourceTurn })),
      });
      // The session as it already stands. Nothing is named again — this turn
      // was named the first time, and a second attempt beside the first would
      // claim a model use that never happened. But a repeat is what a client
      // sends when the first response was lost, so it still has to carry the
      // record of the model that did name the session, or that client is left
      // with an account that exists and never reaches it.
      const session =
        (await attemptSessionTitle(() => sessionStore.getSession(sessionId))) ??
        undefined;
      return {
        task: existing,
        plan,
        user,
        ...whenDefined(session, (updated) => ({ session: updated })),
        replayed: true,
      };
    }
  }

  const savedPlan = await sessionStore.getRunPlan(sessionId);
  if (savedPlan && isRunPlanRevisionBlocked(savedPlan.status)) {
    throw new ServiceError(
      "conflict",
      "A Team run is already active",
      {
        detail:
          "Wait for the active Team run to finish before sending another prompt.",
        plan: savedPlan,
      },
    );
  }

  const workflowId = await resolveTeamWorkflowId({
    teamId,
    ...whenDefined(options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
    ...whenDefined(options.workflowsRegistryPath, (registryPath) => ({
      workflowsRegistryPath: registryPath,
    })),
  });

  // A chat-selected team is an explicit user choice, so it always gets a fresh
  // plan pinned to its wrapper. The wrapper is hidden from the catalog, so
  // planning has to be told to consider internal workflows.
  const plan = await createRunPlanService({
    sessionId,
    sessionStore,
    ...whenDefined(options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
    ...whenDefined(options.workflowsRegistryPath, (registryPath) => ({
      workflowsRegistryPath: registryPath,
    })),
    goal: options.brief,
    workflowId,
    selectionSource: "user" as const,
    briefReadinessPolicy: "non-empty" as const,
    includeInternalWorkflows: true,
  });

  const launchBrief = options.brief
    ? withContinuationContext(
        await loadTeamChatRuntimeBrief({
          currentMessage: options.brief,
          ...whenDefined(options.runStore, (runStore) => ({ runStore })),
          sessionId,
          sessionStore,
          teamId,
        }),
        options.continuationContext,
      )
    : options.brief;

  const launched = await applyRunPlanService({
    sessionId,
    sessionStore,
    ...whenDefined(options.taskQueue, (taskQueue) => ({ taskQueue })),
    ...whenDefined(options.taskLauncher, (taskLauncher) => ({ taskLauncher })),
    ...whenDefined(options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
    ...whenDefined(options.workspacePath, (workspacePath) => ({ workspacePath })),
    ...whenDefined(options.workflowsRegistryPath, (registryPath) => ({
      workflowsRegistryPath: registryPath,
    })),
    plan,
    workflowId,
    ...whenDefined(launchBrief, (brief) => ({ brief })),
    targetKind: "team-chat" as const,
    teamId,
    ...whenDefined(options.sourceTurn, (sourceTurn) => ({ sourceTurn })),
    ...whenDefined(options.projectContext, (projectContext) => ({
      projectContext,
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
  });

  if (!launched.ok) {
    throw teamLaunchFailure(launched);
  }

  // Persisted only after task admission succeeds. Otherwise a rejected prompt
  // would look delivered even though the Team never received it.
  const durableUser = await persistTeamBrief({
    sessionId,
    sessionStore,
    brief: options.brief,
    ...whenDefined(options.sourceTurn, (sourceTurn) => ({ sourceTurn })),
  });
  // Everything from here to the title write is optional work laid over a launch
  // that has already happened: the task is admitted, the Team is working, and
  // the brief the user submitted is durable above. So the whole block is
  // best-effort — the transcript read and the file context as much as the
  // generation and the write. Without that, a fault in naming a session
  // rejected a request whose Team was already running it, and the caller was
  // told their prompt had failed.
  const renamed = await attemptSessionTitle(async () => {
    const history = await sessionStore.listChatMessages(sessionId);
    return renameSessionForTeamLaunch({
      sessionId,
      sessionStore,
      history,
      taskId: launched.task.id,
      ...whenDefined(launchBrief, (brief) => ({ launchBrief: brief })),
    });
  });
  // The session as it stands, whatever the naming did. A title that failed or
  // came back unusable still made an attempt, and that attempt is recorded —
  // this response is the only thing that carries it to the screen, so returning
  // no session at all would leave a person with no account of a model that
  // really was about to be used. Read best-effort for the same reason the block
  // above is, and it claims no rename that did not happen: what comes back is
  // whatever the session already says.
  const session =
    renamed ??
    (await attemptSessionTitle(() => sessionStore.getSession(sessionId))) ??
    undefined;

  return {
    task: launched.task,
    plan: launched.plan,
    user: durableUser,
    ...whenDefined(session, (updated) => ({ session: updated })),
    replayed: false,
  };
}

/**
 * The brief with the turn's carried results after its closed frame.
 *
 * The composition rule lives with the frame contract it protects, because
 * getting it wrong is not a formatting mistake: text placed ahead of the brief
 * becomes the first frame-begin line the reader finds, and can then declare its
 * own message length and its own standing roster. See
 * `composeTeamChatBriefWithCarriedContext`.
 */
function withContinuationContext(
  brief: string,
  continuationContext: string | undefined,
): string {
  return composeTeamChatBriefWithCarriedContext(brief, continuationContext);
}

/**
 * Put the submitted brief in the transcript exactly once.
 *
 * Idempotent on the turn's identity, so both the first launch and any later
 * replay converge on one durable line. A turn-scoped message is addressed by a
 * deterministic id rather than a random one: "already present" has to mean the
 * same line, not merely a line from the same turn.
 */
async function persistTeamBrief(input: {
  sessionId: string;
  sessionStore: SessionStore;
  brief: string;
  sourceTurn?: SessionTaskSourceTurn;
}): Promise<ChatMessage> {
  if (!input.sourceTurn) {
    const message = buildChatMessage("user", input.brief);
    await input.sessionStore.appendChatMessage(input.sessionId, message);
    return message;
  }
  const { turnId, fingerprint } = input.sourceTurn;
  const message = buildChatMessage("user", input.brief, {
    id: conversationTurnMessageId(turnId, "user"),
    schemaVersion: 2 as const,
    conversationId: input.sessionId,
    kind: "chat" as const,
    source: { kind: "conversation-turn" as const, turnId },
    turnId,
    turnRequest: { fingerprint, expectedReplies: 0 },
  });
  const written = await input.sessionStore.appendChatMessageIfAbsent(
    input.sessionId,
    message,
  );
  if (written === "unknown-session") {
    throw new ServiceError("not_found", "Session not found");
  }
  if (written === "invalid-message") {
    throw new ServiceError("conflict", "turn_message_invalid");
  }
  if (written === "appended") return message;
  // Something else wrote this turn's line. The transcript is the authority on
  // what was said, so the durable one is adopted rather than duplicated.
  const history = await input.sessionStore.listChatMessages(input.sessionId);
  return (
    history.find(
      (candidate) =>
        candidate.role === "user" && candidate.turnId === turnId,
    ) ?? message
  );
}

/** Turn a refused apply into the error the route has always answered with. */
function teamLaunchFailure(
  launched: Exclude<Awaited<ReturnType<typeof applyRunPlanService>>, { ok: true }>,
): ServiceError {
  if (launched.status === "needs_input") {
    return new ServiceError("conflict", "Task brief required", {
      assistant: launched.assistant,
      plan: launched.plan,
    });
  }
  if (launched.status === "conflict") {
    return new ServiceError("conflict", launched.error, {
      detail: launched.detail,
      retryable: launched.retryable,
      diagnostics: launched.diagnostics,
      plan: launched.plan,
    });
  }
  return new ServiceError(
    launched.statusCode === 409 ? "conflict" : "bad_request",
    launched.error,
    { detail: launched.detail, plan: launched.plan },
  );
}

/**
 * Runs optional post-admission work, and answers `undefined` when it fails.
 *
 * Naming a session is a convenience laid over a launch that has already
 * happened. A fault here — reading the transcript, locking the session's files,
 * resolving their context, recording the selection, or writing the title — must
 * cost the title and nothing else, because the task the caller is waiting for
 * is already admitted and its brief is already durable.
 */
async function attemptSessionTitle<T>(
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

/** Name the session after its first Team brief. */
async function renameSessionForTeamLaunch(input: {
  sessionId: string;
  sessionStore: SessionStore;
  history: ChatMessage[];
  /** The admitted task this naming belongs to. A launch has no chat turn. */
  taskId: string;
  launchBrief?: string;
}): Promise<SessionSummary | undefined> {
  const session = await input.sessionStore.getSession(input.sessionId);
  if (!session) return undefined;
  const titleFiles = await lockSessionChatFiles(
    input.sessionStore,
    input.sessionId,
  );
  const titleFileContext = await buildSessionChatFileContext({
    sessionId: input.sessionId,
    sessionStore: input.sessionStore,
    files: titleFiles,
    // Titling runs on the application default and names no model of its own, so
    // it takes the conservative budget an unresolved roster gets rather than the
    // old flat character caps.
    ...resolveChatFileBudget([]),
  });
  const titleContext = [titleFileContext, input.launchBrief]
    .filter(
      (value) =>
        typeof value === "string" &&
        value.trim().length > 0 &&
        value !== "(none)",
    )
    .join("\n\n");
  const titleTurn = await generateSessionTitle({
    session,
    history: input.history,
    ...whenDefined(titleContext || undefined, (context) => ({ context })),
    // Recorded before the send, and owned by the task this launch admitted.
    // A launch has no chat turn to own it, and a task identity is not a turn
    // identity: whatever reads this back has to resolve the task, never match
    // the string against a turn. A session that cannot take the record
    // declines the call rather than letting a model name it with nothing to
    // say so.
    onSelected: (selection) =>
      input.sessionStore.appendSessionTitleAttempt(input.sessionId, {
        operation: "team-launch",
        owner: input.taskId,
        attemptId: crypto.randomUUID(),
        selection,
        at: new Date().toISOString(),
      }),
  });
  if (!titleTurn.title) return undefined;
  await input.sessionStore.updateSessionTitle(input.sessionId, titleTurn.title);
  return (await input.sessionStore.getSession(input.sessionId)) ?? undefined;
}
