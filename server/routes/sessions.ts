import { cancelActiveAgentTurn } from '../../services/active-agent-turns.js';
import { whenDefined } from '../../core/optional-properties.js'
import { handleCanvasRoutes } from './canvas.js'
import { handleCanvasDocumentRoutes } from './canvas-documents.js'
import { handleCanvasOfficeRoutes } from './canvas-office-documents.js'
import { projectDocumentReviews } from '../../services/document-review-projection.js';
import * as path from 'node:path';
import type * as http from "node:http";
import { URL } from "node:url";

import type { RunLauncher } from "../../domains/run/run-launcher.js";
import type { RunStore } from "../../domains/run/run-store.js";
import type { FileParserLauncher } from "../../core/file-parser-launcher.js";
import {
  SessionStoreError,
  type SessionCreateResult,
  type SessionStore,
} from "../../domains/sessions/session-store.js";
import { isRunPlanRevisionBlocked } from "../../domains/sessions/run-plan-helpers.js";
import { SessionActivityConflictError } from '../../domains/sessions/session-activity-claims.js';
import { assertSessionDialogueInactive } from '../../services/session-activity-service.js';
import type { WorkspaceProjectService } from "../../domains/projects/workspace-project-service.js";
import type { WorkspaceProjectContextStore } from "../../domains/projects/project-context-store.js";
import { sanitizeUploadFilename } from "../../domains/sessions/session-normalizers.js";
import {
  isTerminalTaskStatus,
  isValidSessionId,
} from "../../contracts/sessions.js";
import type {
  ChatMessage,
  ConversationTurnOutcome,
  SessionTask,
} from "../../contracts/sessions.js";
import { recoverInterruptedAgentChatTurns } from "../../services/interrupted-agent-chat-recovery.js";
import { agentChatTurnWiring } from "../../services/agent-chat-turn-wiring.js";
import { getRuntimeDefaultModelState } from "../../domains/provider/default-model-selection.js";
import {
  acceptModelChoice,
  offerModelChoiceForTurn,
} from "../../services/agent-model-choice-service.js";
import {
  readModelChoiceAcceptance,
  type ModelChoiceAcceptance,
  type ModelChoiceOffer,
} from "../../contracts/model-choice.js";
import { randomUUID } from "node:crypto";

import { decodeSafePathSegment } from "../../core/path-safety.js";
import {
  parseSessionCreateBody,
  parseSessionAgentChatMessageBody,
  parseSessionMessageBody,
  parseSessionTitleBody,
} from "../../services/session-service.js";
import {
  ensureAgentChatRepoRoot,
  runSessionAgentChatTurn,
} from "../../services/agent-chat-service.js";
import {
  dispatchSessionMessage,
  isAgentsDispatchResponse,
  type SessionDispatchServiceOptions,
} from "../../services/session-dispatch-service.js";
import { createDeliveryArtifactReader } from "../../services/delivery-context.js";
import {
  ensureResultReferences,
  resolveContinuationContext,
} from "../../services/continuation-resolver.js";
import {
  openAgentQuestionWorkflowStore,
  openModelChoiceWorkflowStore,
} from "../../services/workflow-task-state-stores.js";
import type { WorkspaceExecutionJournalRegistry } from "../../services/workspace-execution-journal-registry.js";
import type { WorkspaceConversationJournalRegistry } from "../../services/workspace-conversation-journal-registry.js";
import {
  cancelSessionTask,
  parseTaskCreateBody,
} from "../../services/task-service.js";
import {
  applyRunPlanService,
  createRunPlanService,
  parseRunPlanWorkflowSelectionBody,
  runOrchestratorMessageService,
  selectRunPlanWorkflowService,
} from "../../services/run-orchestrator-service.js";
import {
  ApiRequestError,
  createRequestAbort,
  parseApiRequest,
  readJsonBody,
  writeJson,
} from "../http.js";
import { readFilenameHeader, readUploadBody } from "../upload-body.js";
import { withFileMutationLock } from "../../core/file-mutation.js";
import { buildChatMessage } from "../../services/session-service.js";
import { TeamChatTargetError } from "../../services/team-chat-target.js";
import {
  launchSessionTeamTask,
  teamChatTargetStatus,
} from "../../services/team-launch-service.js";
import { handleAgentTextStreamRequest } from "./agent-text-stream-route.js";
import type { AgentTextStreamHub } from "../../domains/runtime/agent-text-stream-hub.js";
import type { AgentDialogueService } from '../../services/agent-dialogue-service.js'
import { handleSessionDialogueRoutes } from './session-dialogues.js'
import type { McpAgentToolService } from "../../services/mcp-agent-tool-service.js";
import type { SharedFolderService } from "../../services/shared-folder-service.js";
import { SHARED_FOLDER_ROUTE_PATTERN, handleSharedFolderRoutes } from "./shared-folders.js";
import type { WorkflowMcpPreflightService } from "../../services/workflow-mcp-preflight-service.js";
import type { McpResourceImportService } from "../../services/mcp-resource-import-service.js";
import {
  TaskQueueError,
  type TaskQueue,
} from "../../services/task-queue.js";
import {
  approveDeepResearchPlanService,
  cancelDeepResearchPlanAttemptService,
  getDeepResearchPlanAttemptEventsService,
  getDeepResearchPlanAttemptService,
  parseResearchPlanApprovalBody,
  parseResearchPlanGenerationBody,
  startDeepResearchPlanService,
  type DeepResearchPlanRunner,
  type DeepResearchPlanSettingsRuntime,
} from "../../services/deep-research-plan-service.js";
import {
  isTerminalDeepResearchPlanningStatus,
  type DeepResearchPlanningEvent,
} from "../../contracts/deep-research-planning.js";
import { buildDeepResearchJourneySnapshot } from "../../services/deep-research-journey-service.js";
import { DEEP_RESEARCH_WORKFLOW_ID } from "../../contracts/deep-research-journey.js";
import { writeWorkspaceProjectServiceError } from "./projects.js";
import {
  FileSystemWorkflowStateStore,
  WorkflowStateStoreError,
  isTerminalWorkflowStepStatus,
  terminalTaskStatusForWorkflow,
} from "../../workflows/workflow-state-store.js";
import type { WorkflowExecutionSnapshot } from "../../workflows/workflow-state-store.js";
import { humanInputSubmissionRequestSchema } from '../../contracts/schemas/human-input-requests.js'
import { agentQuestionViewSchema, submitAgentInputSchema } from '../../contracts/agent-questions.js'
import { MAX_HUMAN_INPUT_BODY_BYTES } from '../../contracts/human-input.js'
import {
  openHumanInputInteraction,
  readHumanInputSource,
  submitHumanInputFeedback,
  type HumanInputRecipientViolation,
  type SubmitHumanInputResult,
} from '../../services/workflow-human-input-service.js'
import { logProcessWarning, logRuntimeEvent } from '../../domains/runtime/logger.js'
import { generateSessionTitle } from '../../domains/sessions/session-title.js'
import { loadTeamChatRuntimeBrief } from '../../services/team-chat-context.js'
import type { AgentTurnJournalEventObserver } from '../../services/agent-turn-journal-recorder.js'
import { resolveAgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import {
  buildSessionChatFileContext,
  lockSessionChatFiles,
} from '../../services/session-chat-file-context.js'

/**
 * Route a create through whichever layer owns session identity here, using the
 * claim-aware entry point where it exists so a replayed create stays
 * distinguishable from a new one.
 */
async function createSessionForRequest(
  options: SessionRoutesOptions,
  sessionStore: SessionStore,
  body: {
    title?: string;
    projectId?: string;
    id?: string;
    creationToken?: string;
  },
): Promise<SessionCreateResult> {
  if (options.workspaceProjectService) {
    return options.workspaceProjectService.createSessionWithClaim(body);
  }
  return sessionStore.createSessionWithClaim(body);
}

/** A create that cannot proceed answers 409, never a 500 from a raw errno. */
function writeSessionStoreError(
  res: http.ServerResponse,
  error: unknown,
): boolean {
  if (!(error instanceof SessionStoreError)) return false;
  writeJson(res, 409, { error: error.message, code: error.code });
  return true;
}

function sessionDispatchOptions(
  options: SessionRoutesOptions,
  sessionStore: SessionStore,
): SessionDispatchServiceOptions {
  return {
    sessionStore,
    ...whenDefined(options.resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
    ...whenDefined(options.runStore, (definedValue) => ({ runStore: definedValue })),
    ...whenDefined(options.taskQueue, (definedValue) => ({ taskQueue: definedValue })),
    ...whenDefined(options.taskLauncher, (definedValue) => ({ taskLauncher: definedValue })),
    ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
    ...whenDefined(options.workspacePath, (definedValue) => ({ workspacePath: definedValue })),
    ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
    ...whenDefined(options.workspaceProjectService, (definedValue) => ({ workspaceProjectService: definedValue })),
    ...whenDefined(options.workspaceProjectContextStore, (definedValue) => ({ workspaceProjectContextStore: definedValue })),
    ...whenDefined(options.mcpAgentToolService, (definedValue) => ({ mcpAgentToolService: definedValue })),
    ...whenDefined(options.agentDialogueService, (definedValue) => ({ agentDialogueService: definedValue })),
    ...whenDefined(options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
    ...whenDefined(options.sharedFolderService, (definedValue) => ({ sharedFolderService: definedValue })),
    ...whenDefined(options.mcpWorkflowPreflightService, (definedValue) => ({ mcpWorkflowPreflightService: definedValue })),
    ...whenDefined(options.agentTextStreamHub, (definedValue) => ({ agentTextStreamHub: definedValue })),
    ...whenDefined(options.conversationJournalRegistry, (definedValue) => ({ conversationJournalRegistry: definedValue })),
    ...whenDefined(options.executionJournalRegistry, (definedValue) => ({ executionJournalRegistry: definedValue })),
    ...whenDefined(options.providerFailureHealth, (definedValue) => ({ providerFailureHealth: definedValue })),
    ...whenDefined(options.resolveConnectionKind, (definedValue) => ({ resolveConnectionKind: definedValue })),
  };
}

export interface SessionRoutesOptions {
  resourceLibraryService?: import('../../services/resource-library-service.js').ResourceLibraryService;
  agentDialogueService?: AgentDialogueService;
  sessionStore?: SessionStore;
  runStore?: RunStore;
  workspaceProjectService?: WorkspaceProjectService;
  workspaceProjectContextStore?: WorkspaceProjectContextStore;
  taskQueue?: TaskQueue;
  taskLauncher?: RunLauncher;
  fileParserLauncher?: FileParserLauncher;
  workflowsRegistryPath?: string;
  repoRootPath?: string;
  workspacePath?: string;
  mcpAgentToolService?: McpAgentToolService;
  sharedFolderService?: SharedFolderService;
  agentTextStreamHub?: AgentTextStreamHub;
  agentTextStreamHeartbeatMs?: number;
  agentTextStreamWaitMs?: number;
  mcpWorkflowPreflightService?: WorkflowMcpPreflightService;
  mcpResourceImportService?: McpResourceImportService;
  deepResearchSettings?: DeepResearchPlanSettingsRuntime;
  deepResearchPlanRunner?: DeepResearchPlanRunner;
  deepResearchPlanningHeartbeatMs?: number;
  onTaskCancellationRequested?: (
    sessionId: string,
    taskId: string,
  ) => void;
  /**
   * The workspace journal registry. Answering a human-input prompt is an
   * authoritative workflow transition, so an enrolled assignment must record
   * it on the canonical journal rather than only in the projection (ADR §9).
   */
  executionJournalRegistry?: WorkspaceExecutionJournalRegistry;
  providerFailureHealth?: AgentTurnJournalEventObserver;
  conversationJournalRegistry?: WorkspaceConversationJournalRegistry;
  /**
   * What kind of connection a `connection:<id>` provider routes to.
   *
   * Supplied by the composition root, which owns provider settings. A turn
   * cannot look this up itself — prompt assembly is synchronous and settings
   * reads are not — and without it a local connection is budgeted against the
   * generic window rather than its own.
   */
  resolveConnectionKind?: (provider: string) => string | undefined;
  /** Injected identity source; the route does not mint one in place. */
  newTurnId?: () => string;
}

/**
 * What became of the turns this transcript cannot explain.
 *
 * Empty where the composition records no conversation evidence — a build with
 * journalling switched off has nothing to read, and a fabricated outcome would
 * be worse than none. A fault is reported and then absorbed: the user asked for
 * their conversation, and a session that cannot be explained must still open.
 */
async function readSessionTurnOutcomes(
  options: SessionRoutesOptions,
  sessionId: string,
  messages: readonly ChatMessage[],
): Promise<readonly ConversationTurnOutcome[]> {
  const { conversationJournalRegistry, workspacePath } = options;
  if (!conversationJournalRegistry || !workspacePath) return [];
  return recoverInterruptedAgentChatTurns({
    workspacePath,
    sessionId,
    conversationRegistry: conversationJournalRegistry,
    messages,
    ...whenDefined(options.executionJournalRegistry, (executionRegistry) => ({
      executionRegistry,
    })),
    ...whenDefined(options.agentTextStreamHub, (hub) => ({ hub })),
  }).catch((error: unknown) => {
    // Non-fatal by design — the user asked for their conversation, and a
    // session that cannot be explained must still open — but never silent.
    // Which session, and what class of fault, is the whole of what an operator
    // needs; the fault's own words are an errno naming a path inside the
    // workspace and do not belong in a log line this route writes.
    logProcessWarning(
      "session-turn-outcomes",
      `Session ${sessionId} loaded without turn outcomes ` +
        `(${error instanceof Error ? error.name : "unknown fault"}).`,
    );
    return [];
  });
}

/**
 * The model-choice offers this session's recent failed turns have earned.
 *
 * Computed, never stored: the offer is derived from the durable failure and
 * the current application default every time it is read, so it cannot go stale
 * in a second place. Absorbed on fault for the same reason as the outcomes
 * above — a session that cannot be explained must still open.
 */
async function readSessionModelChoiceOffers(
  options: SessionRoutesOptions,
  sessionId: string,
  messages: readonly ChatMessage[],
): Promise<readonly ModelChoiceOffer[]> {
  const { conversationJournalRegistry, sessionStore } = options;
  if (!conversationJournalRegistry || !sessionStore) return [];
  const turnIds = [
    ...new Set(
      messages
        .filter((message) => message.role === "user" && message.turnId)
        .map((message) => message.turnId as string),
    ),
  ].slice(-MODEL_CHOICE_OFFER_LOOKBACK);
  const offers: ModelChoiceOffer[] = [];
  for (const turnId of turnIds) {
    const offer = await offerModelChoiceForTurn({
      sessionId,
      turnId,
      sessionStore,
      conversationRegistry: conversationJournalRegistry,
      ...whenDefined(options.executionJournalRegistry, (executionRegistry) => ({
        executionRegistry,
      })),
    }).catch((error: unknown) => {
      logProcessWarning(
        "session-model-choice",
        `Session ${sessionId} turn ${turnId} could not be offered a model ` +
          `choice (${error instanceof Error ? error.name : "unknown fault"}).`,
      );
      return undefined;
    });
    if (offer) offers.push(offer);
  }
  return offers;
}

/** How far back a reopened session looks for an offerable failure. */
const MODEL_CHOICE_OFFER_LOOKBACK = 20;

function requiredRouteSegment(tail: readonly string[], index: number): string {
  const segment = tail[index];
  if (segment === undefined) throw new Error(`Missing route segment at index ${index}`);
  return segment;
}

export async function handleSessionRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  options: SessionRoutesOptions;
}): Promise<boolean> {
  try { return await handleSessionRoutesWithActivity(params); } catch (error) {
    if (!(error instanceof SessionActivityConflictError)) throw error;
    writeJson(params.res, 409, { error: error.message, code: error.code });
    return true;
  }
}

async function handleSessionRoutesWithActivity(params: Parameters<typeof handleSessionRoutes>[0]): Promise<boolean> {
  const { req, res, url, options } = params;

  if (await handleSessionDialogueRoutes({ req, res, url, ...whenDefined(options.agentDialogueService, (service) => ({ service })) })) return true;

  // `/sessions/:id/folders` lives under this prefix; its own module owns it.
  if (SHARED_FOLDER_ROUTE_PATTERN.test(url.pathname)) {
    return handleSharedFolderRoutes({
      req,
      res,
      url,
      ...whenDefined(options.sharedFolderService, (service) => ({ service })),
      ...whenDefined(options.sessionStore, (sessionStore) => ({ sessionStore })),
    });
  }

  if (url.pathname === "/sessions") {
    if (!options.sessionStore) {
      writeJson(res, 501, {
        error: "Sessions are not configured on this server",
      });
      return true;
    }

    if (req.method === "GET") {
      const sessions = options.workspaceProjectService
        ? await options.workspaceProjectService.listSessions()
        : await options.sessionStore.listSessions();
      writeJson(res, 200, { sessions });
      return true;
    }

    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      const body = parseSessionCreateBody(payload);
      try {
        const created = await createSessionForRequest(
          options,
          options.sessionStore,
          body,
        );
        // `201` for the session this request made, `200` for the one it had
        // already made and is being told about a second time.
        writeJson(res, created.outcome === "created" ? 201 : 200, created.session);
      } catch (error) {
        if (writeSessionStoreError(res, error)) return true;
        if (!writeWorkspaceProjectServiceError(res, error)) throw error;
      }
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  const sessionRoute = decodeSessionRoute(url);
  if (!sessionRoute) return false;
  if (!isValidSessionId(sessionRoute.sessionId)) {
    writeJson(res, 400, { error: "Invalid session id" });
    return true;
  }

  if (!options.sessionStore) {
    writeJson(res, 501, {
      error: "Sessions are not configured on this server",
    });
    return true;
  }

  if (sessionRoute.tail[0] === 'canvas' && sessionRoute.tail[1] === 'office') {
    return handleCanvasOfficeRoutes({ req, res, url, sessionId: sessionRoute.sessionId, options })
  }
  if (sessionRoute.tail[0] === 'canvas' && sessionRoute.tail.length === 2 && sessionRoute.tail[1] === 'document') {
    return handleCanvasDocumentRoutes({ req, res, url, sessionId: sessionRoute.sessionId, options })
  }

  if (sessionRoute.tail[0] === 'canvas' && (sessionRoute.tail.length === 1 || (sessionRoute.tail.length === 2 && sessionRoute.tail[1] === 'content'))) {
    return handleCanvasRoutes({ req, res, url, sessionId: sessionRoute.sessionId, options })
  }

  if (req.method === "GET" && sessionRoute.tail.length === 0) {
    const session = options.workspaceProjectService
      ? await options.workspaceProjectService.getSession(sessionRoute.sessionId)
      : await options.sessionStore.getSession(sessionRoute.sessionId);
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }
    writeJson(res, 200, session);
    return true;
  }

  if (req.method === 'POST' && sessionRoute.tail.length === 1 &&
      (sessionRoute.tail[0] === 'messages' || sessionRoute.tail[0] === 'agent-chat' || sessionRoute.tail[0] === 'tasks')) {
    // Admission must recover the same dead dialogue records and recordless
    // claims as opening the chat, while keeping any live owner's claim.
    await options.agentDialogueService?.list(sessionRoute.sessionId);
  }

  if (req.method === "PATCH" && sessionRoute.tail.length === 0) {
    const payload = await readJsonBody(req);
    const body = parseSessionTitleBody(payload);
    const updated = await options.sessionStore.updateSessionTitle(
      sessionRoute.sessionId,
      body.title,
    );
    if (!updated) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }
    const session = options.workspaceProjectService
      ? await options.workspaceProjectService.getSession(sessionRoute.sessionId)
      : updated;
    writeJson(res, 200, session);
    return true;
  }

  if (req.method === "DELETE" && sessionRoute.tail.length === 0) {
    if (url.searchParams.has('onlyIfEmpty')) {
      if (url.searchParams.getAll('onlyIfEmpty').length !== 1 || url.searchParams.get('onlyIfEmpty') !== 'true') {
        writeJson(res, 400, { error: 'onlyIfEmpty must be true' });
        return true;
      }
      if (!options.sessionStore.discardSessionIfEmpty) {
        writeJson(res, 501, { error: 'Empty-session rollback is not configured' });
        return true;
      }
      const discarded = await options.sessionStore.discardSessionIfEmpty(sessionRoute.sessionId);
      if (discarded !== 'deleted') {
        writeJson(res, discarded === 'not_found' ? 404 : 409, {
          error: discarded === 'not_found' ? 'Session not found' : 'The chat has saved work or active ownership',
        });
        return true;
      }
      res.statusCode = 204;
      res.end();
      return true;
    }
    if (options.taskQueue && !options.taskQueue.isReady()) {
      writeAdmissionRecovering(res);
      return true;
    }
    await options.agentDialogueService?.stopAndWait(sessionRoute.sessionId);
    const deletion = options.sessionStore.deleteSessionIfNoActiveTasks
      ? await options.sessionStore.deleteSessionIfNoActiveTasks(
          sessionRoute.sessionId,
        )
      : {
          deleted: await options.sessionStore.deleteSession(
            sessionRoute.sessionId,
          ),
        };
    if (!deletion.deleted && deletion.reason === 'dialogue_active') {
      writeJson(res, 409, { error: 'A new Agent dialogue owns this chat', code: 'dialogue_active' });
      return true;
    }
    if (!deletion.deleted && deletion.reason === "active_tasks") {
      writeJson(res, 409, {
        error: "Cancel active tasks before deleting the session",
      });
      return true;
    }
    // Nothing to cancel: a task has ended, but its processes could not be
    // confirmed stopped, and the session keeps its record until they are.
    if (!deletion.deleted && deletion.reason === "process_cleanup_pending") {
      writeJson(res, 409, {
        error:
          "A task in this session has ended, but its processes could not yet be confirmed stopped. " +
          "Delete the session once that cleanup finishes.",
      });
      return true;
    }
    if (!deletion.deleted) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }
    // The chat's folder list went with it, so a folder nothing else attaches
    // loses its parses and parsed text before the delete is answered.
    await options.sharedFolderService?.handleOwnerDeleted();
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (req.method === 'POST' && sessionRoute.tail.length === 3 &&
      sessionRoute.tail[0] === 'turns' && sessionRoute.tail[2] === 'cancel') {
    const turnId = sessionRoute.tail[1];
    if (!turnId || !isValidSessionId(turnId)) {
      writeJson(res, 400, { error: 'turnId must be a UUID' });
      return true;
    }
    if (!await options.sessionStore.getSession(sessionRoute.sessionId) ||
        !cancelActiveAgentTurn(options.sessionStore, sessionRoute.sessionId, turnId)) {
      writeJson(res, 404, { error: 'Running turn not found' });
      return true;
    }
    writeJson(res, 202, { status: 'cancelling' });
    return true;
  }

  if (sessionRoute.tail.length === 1 && sessionRoute.tail[0] === "messages") {
    const session = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }

    if (req.method === "GET") {
      const messages = await options.sessionStore.listChatMessages(
        sessionRoute.sessionId,
      );
      // Opening a session is also when the turns nobody finished get finished.
      // A startup sweep alone would not do: a session opened days later must
      // not stay silent because the process that could have repaired it was
      // busy at boot (ADR 2026-08-31).
      const outcomes = await readSessionTurnOutcomes(
        options,
        sessionRoute.sessionId,
        messages,
      );
      const modelChoices = await readSessionModelChoiceOffers(
        options,
        sessionRoute.sessionId,
        messages,
      );
      const hub = options.agentTextStreamHub;
      const activeTurnIds = messages.flatMap((message) => {
        if (message.role !== "user" || message.turnId === undefined ||
          hub?.ownerOf(message.turnId) !== sessionRoute.sessionId || !hub.isOpen(message.turnId)) return [];
        // Optional title generation keeps the channel open after the answer is saved.
        const expected = message.turnRequest?.expectedReplies;
        const saved = messages.filter((reply) => reply.role === "assistant" && reply.turnId === message.turnId).length;
        return expected !== undefined && expected > 0 && saved >= expected ? [] : [message.turnId];
      });
      writeJson(res, 200, { messages, outcomes, modelChoices, activeTurnIds });
      return true;
    }

    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      const body = parseSessionMessageBody(payload);
      // A client that goes away mid-turn is a cancellation, not a failure. The
      // signal is what lets the turn record that difference.
      const requestAbort = createRequestAbort(req, res);
      let dispatched;
      try {
        dispatched = await dispatchSessionMessage(
          sessionDispatchOptions(options, options.sessionStore),
          {
            sessionId: sessionRoute.sessionId,
            text: body.text,
            ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
            ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
            ...whenDefined(body.projectContext, (definedValue) => ({ projectContext: definedValue })),
            ...whenDefined(body.target, (definedValue) => ({ target: definedValue })),
            ...whenDefined(body.contextResultIds, (definedValue) => ({
              contextResultIds: definedValue,
            })),
            // A caller that predates turn identities still gets one, so its turn
            // is as observable as any other. The client's own id, when it sent
            // one, stays the preview channel and keeps its replay semantics.
            turnId: body.turnId ?? mintTurnId(options.newTurnId),
            // Decided here because this is the only place that still knows. One
            // line further in, a minted identity and a supplied one are the same
            // string.
            turnOrigin: body.turnId === undefined ? 'server' : 'client',
            ...whenDefined(body.turnId, (definedValue) => ({ streamChannelId: definedValue })),
            signal: requestAbort.signal,
          },
        );
      } finally {
        requestAbort.dispose();
      }
      // `201` for a turn this request admitted, `200` for one that was already
      // durable. Both branches of the unified endpoint answer the same way, so
      // a caller never has to know which delegate ran to read the status.
      writeJson(res, dispatched.statusCode, dispatched.body);
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  // One approved attempt on the application default, for one failed turn.
  // The body says which offer and once; it can never say which model.
  if (
    sessionRoute.tail.length === 3 &&
    sessionRoute.tail[0] === "turns" &&
    sessionRoute.tail[2] === "model-choice"
  ) {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const session = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }
    const acceptance = readModelChoiceAcceptance(await readJsonBody(req));
    if (!acceptance) {
      writeJson(res, 400, {
        error:
          "A model choice approval names only the offer it approves and an idempotency key.",
      });
      return true;
    }
    if (
      !options.conversationJournalRegistry ||
      !options.repoRootPath
    ) {
      writeJson(res, 501, {
        error: "Model choice is not configured on this server",
      });
      return true;
    }
    // A client that goes away mid-attempt is a cancellation, not a failure.
    const requestAbort = createRequestAbort(req, res);
    let accepted;
    try {
      accepted = await acceptModelChoice({
        sessionId: sessionRoute.sessionId,
        turnId: requiredRouteSegment(sessionRoute.tail, 1),
        session,
        sessionStore: options.sessionStore,
        repoRootPath: options.repoRootPath,
        conversationRegistry: options.conversationJournalRegistry,
        acceptance,
        // The approved attempt is an ordinary agent chat turn. It gets the
        // same journals, tool service, preview stream and cancellation an
        // ordinary one gets; a retry that quietly ran without them would be
        // untraceable and uncancellable exactly when a user is watching it
        // most closely.
        turnWiring: agentChatTurnWiring(options),
        signal: requestAbort.signal,
        ...whenDefined(options.executionJournalRegistry, (executionRegistry) => ({
          executionRegistry,
        })),
      });
    } finally {
      requestAbort.dispose();
    }
    if (!accepted.ok) {
      writeJson(res, 409, {
        error: accepted.error.message,
        code: accepted.error.code,
      });
      return true;
    }
    writeJson(res, 200, { turnId: accepted.turnId });
    return true;
  }

  if (sessionRoute.tail.length === 1 && sessionRoute.tail[0] === "results") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const session = await options.sessionStore.getSession(sessionRoute.sessionId);
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }
    // Deriving as well as reading, so a run that completed before results were
    // recorded is still offerable. Publication is idempotent, so this settles
    // after the first call.
    const results = await ensureResultReferences({
      sessionId: sessionRoute.sessionId,
      sessionStore: options.sessionStore,
    });
    writeJson(res, 200, { results });
    return true;
  }

  if (sessionRoute.tail.length === 1 && sessionRoute.tail[0] === "run-plan") {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const session = await options.sessionStore.getSession(sessionRoute.sessionId);
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }
    const plan = await options.sessionStore.getRunPlan(sessionRoute.sessionId);
    writeJson(res, 200, { plan });
    return true;
  }

  if (
    sessionRoute.tail.length === 2 &&
    sessionRoute.tail[0] === "run-plan" &&
    sessionRoute.tail[1] === "workflow"
  ) {
    if (req.method !== "PUT") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const payload = await readJsonBody(req);
    const body = parseRunPlanWorkflowSelectionBody(payload);
    const plan = await selectRunPlanWorkflowService({
      sessionId: sessionRoute.sessionId,
      sessionStore: options.sessionStore,
      ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
      ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
      workflowId: body.workflowId,
      expectedPlanId: body.expectedPlanId,
    });
    writeJson(res, 200, { plan });
    return true;
  }

  if (
    sessionRoute.tail.length === 2 &&
    sessionRoute.tail[0] === "run-plan" &&
    sessionRoute.tail[1] === "research-plan"
  ) {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!options.repoRootPath) {
      writeJson(res, 501, { error: "Research planning is not configured" });
      return true;
    }
    const payload = await readJsonBody(req);
    const body = parseResearchPlanGenerationBody(payload);
    const attempt = await startDeepResearchPlanService({
      sessionId: sessionRoute.sessionId,
      sessionStore: options.sessionStore,
      repoRootPath: options.repoRootPath,
      expectedPlanId: body.expectedPlanId,
      ...whenDefined(options.deepResearchSettings, (definedValue) => ({ settings: definedValue })),
      ...whenDefined(options.deepResearchPlanRunner, (definedValue) => ({ runner: definedValue })),
    });
    writeJson(res, 202, { attempt });
    return true;
  }

  if (
    sessionRoute.tail.length === 4 &&
    sessionRoute.tail[0] === "run-plan" &&
    sessionRoute.tail[1] === "research-plan" &&
    sessionRoute.tail[2] === "attempts"
  ) {
    res.setHeader("cache-control", "no-store");
    const attemptId = requiredRouteSegment(sessionRoute.tail, 3);
    if (req.method === "GET") {
      const attempt = await getDeepResearchPlanAttemptService({
        sessionId: sessionRoute.sessionId,
        sessionStore: options.sessionStore,
        attemptId,
      });
      writeJson(res, 200, { attempt });
      return true;
    }
    if (req.method === "DELETE") {
      const attempt = await cancelDeepResearchPlanAttemptService({
        sessionId: sessionRoute.sessionId,
        sessionStore: options.sessionStore,
        attemptId,
      });
      writeJson(res, attempt.status === "cancelling" ? 202 : 200, {
        attempt,
      });
      return true;
    }
    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (
    sessionRoute.tail.length === 5 &&
    sessionRoute.tail[0] === "run-plan" &&
    sessionRoute.tail[1] === "research-plan" &&
    sessionRoute.tail[2] === "attempts" &&
    sessionRoute.tail[4] === "events"
  ) {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const attemptId = requiredRouteSegment(sessionRoute.tail, 3);
    const sessionStore = options.sessionStore;
    const initial = await getDeepResearchPlanAttemptService({
      sessionId: sessionRoute.sessionId,
      sessionStore,
      attemptId,
    });
    const fromSequence = Math.max(
      0,
      Number.parseInt(url.searchParams.get("from") ?? "", 10) || 0,
    );
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    let stopped = false;
    let nextSequence = fromSequence;
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const closeStream = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    res.once("error", closeStream);
    res.once("close", closeStream);
    req.once("close", closeStream);
    res.write(": connected\n\n");
    heartbeat = setInterval(() => {
      if (stopped || res.writableEnded || res.destroyed) return;
      try {
        res.write(`: keep-alive ${new Date().toISOString()}\n\n`);
      } catch (error) {
        console.warn(
          `[deep-research-planning] SSE heartbeat failed session=${sessionRoute.sessionId} attempt=${attemptId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        closeStream();
      }
    }, options.deepResearchPlanningHeartbeatMs ?? 15_000);

    const pump = async () => {
      if (stopped) return;
      try {
        const page = await getDeepResearchPlanAttemptEventsService({
          sessionId: sessionRoute.sessionId,
          sessionStore,
          attemptId,
          fromSequence: nextSequence,
        });
        for (const event of page.events) {
          if (stopped) return;
          await writePlanningSseEvent(res, event);
          nextSequence = event.sequence + 1;
        }
        const latest = page.snapshot;
        if (isTerminalDeepResearchPlanningStatus(latest.status)) {
          closeStream();
          return;
        }
        timer = setTimeout(() => void pump(), 150);
      } catch (error) {
        if (!stopped) {
          console.warn(
            `[deep-research-planning] SSE pump failed session=${sessionRoute.sessionId} attempt=${attemptId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        closeStream();
      }
    };
    void pump();
    return true;
  }

  if (
    sessionRoute.tail.length === 3 &&
    sessionRoute.tail[0] === "run-plan" &&
    sessionRoute.tail[1] === "research-plan" &&
    sessionRoute.tail[2] === "approve"
  ) {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const payload = await readJsonBody(req);
    const body = parseResearchPlanApprovalBody(payload);
    const plan = await approveDeepResearchPlanService({
      sessionId: sessionRoute.sessionId,
      sessionStore: options.sessionStore,
      expectedPlanId: body.expectedPlanId,
      expectedResearchPlanHash: body.expectedResearchPlanHash,
    });
    writeJson(res, 200, { plan });
    return true;
  }

  if (
    req.method === "GET" &&
    sessionRoute.tail.length === 2 &&
    sessionRoute.tail[0] === "agent-chat" &&
    sessionRoute.tail[1] === "stream"
  ) {
    // The session in the path must exist: a channel id alone must not confirm
    // anything, and a wait must not be granted for a session that is not there.
    const streamSession = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!streamSession) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }

    // The session owns every text channel opened for it, whichever kind of
    // turn opened it. The rules below the ownership check are lane-independent
    // and live in one place.
    return handleAgentTextStreamRequest({
      hub: options.agentTextStreamHub,
      req,
      res,
      url,
      ownerId: sessionRoute.sessionId,
      ...whenDefined(options.agentTextStreamWaitMs, (waitMs) => ({ waitMs })),
      ...whenDefined(options.agentTextStreamHeartbeatMs, (heartbeatMs) => ({
        heartbeatMs,
      })),
    });
  }

  if (
    sessionRoute.tail.length === 2 &&
    sessionRoute.tail[0] === "agent-chat" &&
    sessionRoute.tail[1] === "messages"
  ) {
    const session = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }

    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      const body = parseSessionAgentChatMessageBody(payload);
      const requestAbort = createRequestAbort(req, res);
      let dispatched;
      try {
        // The compatibility adapter. This route is an Agents dispatch spelled a
        // different way, so it goes through the one dispatch service rather
        // than keeping a second copy of the same turn logic alive beside it.
        // Only its response shape is legacy, and only until its callers move.
        dispatched = await dispatchSessionMessage(
          sessionDispatchOptions(options, options.sessionStore),
          {
            sessionId: sessionRoute.sessionId,
            text: body.text,
            target: { kind: "agents", agentNames: body.agentNames },
            ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
            ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
            ...whenDefined(body.projectContext, (definedValue) => ({ projectContext: definedValue })),
            turnId: body.turnId ?? mintTurnId(options.newTurnId),
            turnOrigin: body.turnId === undefined ? 'server' : 'client',
            ...whenDefined(body.turnId, (definedValue) => ({ streamChannelId: definedValue })),
            signal: requestAbort.signal,
          },
        );
      } finally {
        requestAbort.dispose();
      }
      const agentTurn = dispatched.body;
      if (!isAgentsDispatchResponse(agentTurn)) {
        throw new ApiRequestError("Agent chat dispatch was rerouted", 500);
      }
      // A replay is a 200 so the client and the tests can tell it apart from a
      // turn that was actually generated.
      writeJson(res, dispatched.statusCode, {
        user: agentTurn.user,
        replies: agentTurn.messages,
        meta: agentTurn.meta,
        ...whenDefined(agentTurn.session, (definedValue) => ({ session: definedValue })),
        ...(agentTurn.replayed ? { replayed: true } : {}),
        ...whenDefined(agentTurn.incomplete, (definedValue) => ({ incomplete: definedValue })),
      });
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (sessionRoute.tail.length === 1 && sessionRoute.tail[0] === "files") {
    const session = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }

    if (req.method === "GET") {
      const files = options.mcpResourceImportService
        ? await options.mcpResourceImportService.listSessionFiles(
            sessionRoute.sessionId,
          )
        : await options.sessionStore.listFiles(sessionRoute.sessionId);
      const tasks = await options.sessionStore.listTaskRecords(sessionRoute.sessionId);
      const reviewedFiles = await projectDocumentReviews({ files, cacheDirs: [path.join(path.dirname(options.sessionStore.inputsDir(sessionRoute.sessionId)), 'document-review'), ...tasks.flatMap((task) => task.runPath ? [path.join(task.runPath, 'document-review')] : [])] });
      writeJson(res, 200, { files: reviewedFiles });
      return true;
    }

    if (req.method === "POST") {
      const rawFilename = readFilenameHeader(req);
      if (!rawFilename) {
        writeJson(res, 400, {
          error: "Missing required header: x-filename",
        });
        return true;
      }
      const filename = decodeHeaderValue(rawFilename);
      const contents = await readUploadBody(req);
      const sessionStore = options.sessionStore;
      const inputsDir = sessionStore.inputsDir(sessionRoute.sessionId);
      const uploaded = await withFileMutationLock(inputsDir, async () => {
        const normalizedFilename = sanitizeUploadFilename(filename);
        const existing = (
          await sessionStore.listFiles(sessionRoute.sessionId)
        ).find((file) => file.name === normalizedFilename);
        if (existing?.usedAt) {
          throw new ApiRequestError(
            "This attachment has been used in chat and cannot be replaced",
            409,
          );
        }
        const saved = await sessionStore.saveUploadedFile(
          sessionRoute.sessionId,
          { filename, contents },
        );
        if (!saved) return null;

        if (options.fileParserLauncher) {
          try {
            await options.fileParserLauncher.parseDirectory(inputsDir);
          } catch (error) {
            throw new ApiRequestError(
              `File uploaded, but parsing failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              502,
            );
          }
        }

        const refreshed = (
          await sessionStore.listFiles(sessionRoute.sessionId)
        ).find((file) => file.name === saved.name);
        return refreshed ?? saved;
      });
      if (!uploaded) {
        writeJson(res, 400, { error: "Invalid filename" });
        return true;
      }
      writeJson(res, 201, uploaded);
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (sessionRoute.tail.length === 2 && sessionRoute.tail[0] === "files") {
    const session = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }

    if (req.method === "DELETE") {
      const filename = requiredRouteSegment(sessionRoute.tail, 1);
      const sessionStore = options.sessionStore;
      const deletion = sessionStore.deleteFileIfUnused
        ? await sessionStore.deleteFileIfUnused(
            sessionRoute.sessionId,
            filename,
          )
        : (await withFileMutationLock(
              sessionStore.inputsDir(sessionRoute.sessionId),
              () =>
                sessionStore.deleteFile(
                  sessionRoute.sessionId,
                  filename,
                ),
            ))
          ? "deleted"
          : "not_found";
      if (deletion === "locked") {
        writeJson(res, 409, {
          error: "This attachment has been used in chat and cannot be deleted",
        });
        return true;
      }
      if (deletion === "not_found") {
        writeJson(res, 404, { error: "File not found" });
        return true;
      }
      res.statusCode = 204;
      res.end();
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (sessionRoute.tail.length === 2 && sessionRoute.tail[0] === "tasks") {
    const taskId = requiredRouteSegment(sessionRoute.tail, 1);
    if (!isValidSessionId(taskId)) {
      writeJson(res, 400, { error: "Invalid task id" });
      return true;
    }
    const session = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }

    if (req.method === "GET") {
      const task = await options.sessionStore.getTaskRecord(
        sessionRoute.sessionId,
        taskId,
      );
      if (!task) {
        writeJson(res, 404, { error: "Task not found" });
        return true;
      }
      writeJson(res, 200, task);
      return true;
    }

    if (req.method === "DELETE") {
      options.onTaskCancellationRequested?.(
        sessionRoute.sessionId,
        taskId,
      );
      const task = await cancelSessionTask({
        sessionId: sessionRoute.sessionId,
        taskId,
        sessionStore: options.sessionStore,
        ...whenDefined(options.executionJournalRegistry, (executionJournalRegistry) => ({ executionJournalRegistry })),
      });
      options.taskQueue?.wake();
      if (!task) {
        writeJson(res, 404, { error: "Task not found" });
        return true;
      }
      writeJson(res, 200, task);
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  // The offer a suspended run is waiting on, and the approval that releases it.
  // Deliberately separate from the human-input route: one waits for content a
  // person writes, the other for a decision about how to run, and one answer
  // must never release the other wait.
  if (
    sessionRoute.tail.length === 3 &&
    sessionRoute.tail[0] === "tasks" &&
    sessionRoute.tail[2] === "model-choice"
  ) {
    const taskId = requiredRouteSegment(sessionRoute.tail, 1);
    if (!isValidSessionId(taskId)) {
      writeJson(res, 400, { error: "Invalid task id" });
      return true;
    }
    const task = await options.sessionStore.getTaskRecord(
      sessionRoute.sessionId,
      taskId,
    );
    if (!task) {
      writeJson(res, 404, { error: "Task not found" });
      return true;
    }
    if (!task.assignmentPath) {
      writeJson(res, 409, { error: "Task has no durable workflow assignment" });
      return true;
    }
    // Which store (the flushed projection for an ended task, the
    // journal-backed canonical store otherwise) is the service's rule.
    const store = await openModelChoiceWorkflowStore(
      { executionJournalRegistry: options.executionJournalRegistry },
      task,
      task.assignmentPath,
    );
    const snapshot = await store.load();
    const waiting = snapshot?.state.steps.find(
      (step) => step.status === "awaiting_model_choice" && step.modelChoice,
    );
    if (req.method !== "GET" && req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!snapshot) {
      writeJson(res, 404, { error: "No model choice is awaiting a decision" });
      return true;
    }
    // The approval is read and identified before anything is resolved, so a
    // request naming an offer this run is not waiting on still authorizes
    // nothing and still changes nothing.
    let approval:
      | { acceptance: ModelChoiceAcceptance; queue: TaskQueue }
      | undefined;
    if (req.method === "POST") {
      const queue = options.taskQueue;
      if (!queue?.isReady()) {
        writeAdmissionRecovering(res);
        return true;
      }
      const acceptance = readModelChoiceAcceptance(await readJsonBody(req));
      if (!acceptance) {
        writeJson(res, 400, {
          error:
            "A model choice approval names only the offer it approves and an idempotency key.",
        });
        return true;
      }
      // Approving is two durable writes, and a process that stopped between
      // them leaves the workflow holding a permission nothing acted on. The
      // offer is gone, because it became the authorization; answering "nothing
      // is waiting" would tell a person their decision was lost when it was
      // recorded. So the approval is looked for where it went, and the answer
      // is the attempt it already authorized rather than a second one.
      if (!waiting?.modelChoice) {
        const recovered = classifyApprovedModelChoice({
          snapshot,
          task,
          offerId: acceptance.offerId,
        });
        if (!recovered) {
          writeJson(res, 404, {
            error: "No model choice is awaiting a decision",
          });
          return true;
        }
        if (recovered.kind === "other-offer") {
          writeJson(res, 409, {
            error: "That model choice is no longer available.",
            code: "offer-not-found",
          });
          return true;
        }
        if (recovered.kind === "conflict") {
          writeJson(res, 409, {
            error: recovered.message,
            code: "already-accepted",
          });
          return true;
        }
        try {
          // Admitted only when nothing is admitted yet. An approval that has
          // already been acted on is answered from the task as it stands: the
          // attempt exists, and asking the queue again would be asking for a
          // second one. The pair is the one already persisted — the application
          // default is deliberately not consulted, because the user approved
          // the pair they were shown, not whatever Settings says now.
          const continued =
            recovered.kind === "needs-admission"
              ? await queue.enqueueContinuation({
                  sessionId: sessionRoute.sessionId,
                  taskId,
                  from: "awaiting_model_choice",
                  source: "model_choice",
                })
              : task;
          writeJson(res, 202, {
            task: continued,
            workflowRevision: snapshot.state.revision,
            stepId: recovered.stepId,
          });
        } catch (error) {
          if (error instanceof TaskQueueError) {
            writeJson(res, statusForHumanInputQueueError(error), {
              error: error.message,
            });
            return true;
          }
          throw error;
        }
        return true;
      }
      if (acceptance.offerId !== waiting.modelChoice.offerId) {
        writeJson(res, 409, {
          error: "That model choice is no longer available.",
          code: "offer-not-found",
        });
        return true;
      }
      approval = { acceptance, queue };
    }
    // A read of a run with nothing pending. An approval never reaches this:
    // every path above that found no pending offer has already answered, either
    // from the approval it recovered or by refusing.
    if (!waiting?.modelChoice) {
      writeJson(res, 404, { error: "No model choice is awaiting a decision" });
      return true;
    }
    // Reading and approving answer the same question — which offer is current —
    // so they resolve it once, here. Answering a read from stored state alone
    // would put a pair Settings has already moved past back on screen as the
    // one actionable choice, and the approval that followed could only be
    // refused. Resolving authorizes nothing; it only makes the stored offer
    // tell the truth.
    let current: ResolvedModelChoiceOffer;
    try {
      current = await resolveCurrentModelChoiceOffer({
        store,
        revision: snapshot.state.revision,
        waiting: waiting.modelChoice,
        stepId: waiting.stepId,
      });
    } catch (error) {
      if (error instanceof WorkflowStateStoreError) {
        writeJson(res, statusForHumanInputStoreError(error), {
          error: error.message,
        });
        return true;
      }
      throw error;
    }
    if (current.kind === "conflict") {
      writeJson(res, 409, { error: current.message, code: current.code });
      return true;
    }
    if (req.method === "GET" || !approval) {
      writeJson(res, 200, {
        workflowRevision: current.revision,
        stepId: current.stepId,
        offer: current.offer,
      });
      return true;
    }
    // The approval named the offer that has just been replaced. Admitting it
    // would schedule work on a pair that can only be refused once it is already
    // running, so the fresh offer goes back instead and has to be approved on
    // its own.
    if (current.kind === "refreshed") {
      writeJson(res, 409, {
        error:
          "The application default changed after this retry was offered. Approve the refreshed offer instead.",
        code: "default-changed",
        workflowRevision: current.revision,
        stepId: current.stepId,
        offer: current.offer,
      });
      return true;
    }
    try {
      const approved = await store.approveModelChoice({
        expectedRevision: current.revision,
        offerId: approval.acceptance.offerId,
      });
      logRuntimeEvent(task.assignmentPath, {
        timestamp: new Date().toISOString(),
        event: "workflow.model_choice.approved",
        session_id: task.runId,
        root_session_id: task.runId,
        assignment_path: task.assignmentPath,
        team: `workflow:${task.workflowId}`,
        workflow_id: task.workflowId,
        product_session_id: task.sessionId,
        task_id: task.id,
        step_id: waiting.stepId,
        offer_id: approval.acceptance.offerId,
        agent_name: waiting.modelChoice.agentName,
        approved_provider: waiting.modelChoice.proposedDefault.provider,
        approved_model: waiting.modelChoice.proposedDefault.model,
      });
      const continued = await approval.queue.enqueueContinuation({
        sessionId: sessionRoute.sessionId,
        taskId,
        from: "awaiting_model_choice",
        source: "model_choice",
      });
      writeJson(res, 202, {
        task: continued,
        workflowRevision: approved.revision,
        stepId: waiting.stepId,
      });
    } catch (error) {
      if (error instanceof WorkflowStateStoreError) {
        writeJson(res, statusForHumanInputStoreError(error), {
          error: error.message,
        });
        return true;
      }
      if (error instanceof TaskQueueError) {
        writeJson(res, statusForHumanInputQueueError(error), {
          error: error.message,
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  if (
    (sessionRoute.tail.length === 3 || sessionRoute.tail.length === 5) &&
    sessionRoute.tail[0] === 'tasks' && sessionRoute.tail[2] === 'agent-questions'
  ) {
    const taskId = requiredRouteSegment(sessionRoute.tail, 1)
    if (!isValidSessionId(taskId)) { writeJson(res, 400, { error: 'Invalid task id' }); return true }
    const task = await options.sessionStore.getTaskRecord(sessionRoute.sessionId, taskId)
    if (!task) { writeJson(res, 404, { error: 'Task not found' }); return true }
    if (!task.assignmentPath) { writeJson(res, req.method === 'GET' ? 200 : 409, req.method === 'GET' ? [] : { error: 'Task has no durable assignment.' }); return true }
    const acceptingAnswers = task.status === 'running' || task.status === 'awaiting_input'
    const store = await openAgentQuestionWorkflowStore(
      { executionJournalRegistry: options.executionJournalRegistry },
      task,
      task.assignmentPath,
      { writesAnswer: req.method !== 'GET' && acceptingAnswers },
    )
    try {
      if (req.method === 'GET' && sessionRoute.tail.length === 3) {
        const snapshot = await store.loadAgentQuestionSnapshot()
        const views = []
        for (const interaction of snapshot?.state.agentQuestions?.interactions ?? []) {
          const saved = await store.readAgentQuestionDisplay(interaction)
          views.push(agentQuestionViewSchema.parse({
            interactionId: interaction.interactionId, revision: interaction.revision,
            taskId, sessionId: task.sessionId, requestDigest: interaction.requestDigest,
            requestedAt: interaction.requestedAt, questionIds: interaction.questionIds,
            agentId: interaction.invocation.agentId, agentDisplayName: interaction.invocation.agentDisplayName,
            dispatchId: interaction.invocation.dispatchId, childRunId: interaction.invocation.childRunId,
            status: interaction.status, request: saved.request,
            // An answered round carries the refusal of a later one, so the card
            // can keep the exchange and still say why the run stopped.
            ...('blockCode' in interaction && interaction.blockCode ? { blockCode: interaction.blockCode } : {}),
            ...(interaction.status === 'cancelled' ? { cancellationReason: interaction.cancellationReason } : {}),
            canSubmit: (task.status === 'awaiting_input' || task.status === 'running') && interaction.status === 'pending',
            ...(saved.answers ? { answers: saved.answers } : {}),
          }))
        }
        writeJson(res, 200, views)
        return true
      }
      if (req.method !== 'POST' || sessionRoute.tail.length !== 5 || sessionRoute.tail[4] !== 'submit') {
        writeJson(res, 405, { error: 'Method not allowed' }); return true
      }
      const payload = parseApiRequest(submitAgentInputSchema, await readJsonBody(req, 160_000))
      if (payload.taskId !== taskId || payload.sessionId !== sessionRoute.sessionId ||
          payload.interactionId !== sessionRoute.tail[3]) {
        writeJson(res, 409, { error: 'Question belongs to a different run.' }); return true
      }
      if (!acceptingAnswers) {
        const acknowledged = await store.acknowledgeResolvedAgentInput(payload)
        writeJson(res, 202, { status: acknowledged.status }); return true
      }
      if (!options.taskQueue?.isReady()) { writeAdmissionRecovering(res); return true }
      const submitted = await store.submitAgentInput(payload)
      if (submitted.status === 'submitted' && task.status !== 'running') {
        await options.taskQueue.enqueueContinuation({ sessionId: task.sessionId, taskId, source: 'agent_question' })
      }
      writeJson(res, 202, { status: submitted.status })
    } catch (error) {
      if (error instanceof WorkflowStateStoreError) {
        writeJson(res, statusForHumanInputStoreError(error), { error: error.message }); return true
      }
      if (error instanceof TaskQueueError) {
        writeJson(res, statusForHumanInputQueueError(error), { error: error.message }); return true
      }
      throw error
    }
    return true
  }

  if (
    (sessionRoute.tail.length === 3 || sessionRoute.tail.length === 5) &&
    sessionRoute.tail[0] === "tasks" &&
    sessionRoute.tail[2] === "human-in-the-loop"
  ) {
    const taskId = requiredRouteSegment(sessionRoute.tail, 1);
    if (!isValidSessionId(taskId)) {
      writeJson(res, 400, { error: "Invalid task id" });
      return true;
    }
    const humanInputDeps = {
      sessionStore: options.sessionStore,
      executionJournalRegistry: options.executionJournalRegistry,
      taskQueue: options.taskQueue,
      now: () => new Date(),
    };
    // Journal and store errors from opening are not caught here, so they
    // reach the global handler as 500, before any method check.
    const opened = await openHumanInputInteraction(humanInputDeps, {
      sessionId: sessionRoute.sessionId,
      taskId,
    });
    if (opened.kind === "task_not_found") {
      writeJson(res, 404, { error: "Task not found" });
      return true;
    }
    if (opened.kind === "no_assignment") {
      writeJson(res, 409, { error: "Task has no durable workflow assignment" });
      return true;
    }
    if (opened.kind === "interaction_not_found") {
      writeJson(res, 404, { error: "Human-in-the-loop interaction not found" });
      return true;
    }
    const { open } = opened;
    if (sessionRoute.tail.length === 3) {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      try {
        writeJson(res, 200, await readHumanInputSource(open))
      } catch (error) {
        if (error instanceof WorkflowStateStoreError) {
          writeJson(res, statusForHumanInputStoreError(error), { error: error.message })
          return true
        }
        throw error
      }
      return true;
    }
    if (
      req.method !== "POST"
    ) {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (
      sessionRoute.tail[3] !== open.interaction.interactionId ||
      sessionRoute.tail[4] !== "submit"
    ) {
      writeJson(res, 404, { error: "Human-in-the-loop interaction not found" });
      return true;
    }
    let submitted: SubmitHumanInputResult;
    try {
      // The service checks queue readiness before it calls readRequest, so a
      // 503 wins over the 415, 413 and schema 400 that the body read throws.
      submitted = await submitHumanInputFeedback(humanInputDeps, open, {
        readRequest: async () => parseApiRequest(
          humanInputSubmissionRequestSchema,
          await readJsonBody(req, MAX_HUMAN_INPUT_BODY_BYTES),
        ),
      });
    } catch (error) {
      if (error instanceof WorkflowStateStoreError) {
        writeJson(res, statusForHumanInputStoreError(error), { error: error.message });
        return true;
      }
      if (error instanceof TaskQueueError) {
        writeJson(res, statusForHumanInputQueueError(error), { error: error.message });
        return true;
      }
      throw error;
    }
    if (submitted.kind === "admission_recovering") {
      writeAdmissionRecovering(res);
      return true;
    }
    if (submitted.kind === "recipient_rejected") {
      throw new ApiRequestError(humanInputRecipientViolationMessage(submitted.violation), 400);
    }
    writeJson(res, 202, {
      task: submitted.task,
      workflowRevision: submitted.workflowRevision,
      interaction: submitted.interaction,
    });
    return true;
  }

  if (
    sessionRoute.tail.length === 3 &&
    sessionRoute.tail[0] === "tasks" &&
    sessionRoute.tail[2] === "deep-research"
  ) {
    res.setHeader("cache-control", "no-store");
    const taskId = requiredRouteSegment(sessionRoute.tail, 1);
    if (!isValidSessionId(taskId)) {
      writeJson(res, 400, { error: "Invalid task id" });
      return true;
    }
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const session = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }
    const task = await options.sessionStore.getTaskRecord(
      sessionRoute.sessionId,
      taskId,
    );
    if (!task) {
      writeJson(res, 404, { error: "Task not found" });
      return true;
    }
    if (task.workflowId !== DEEP_RESEARCH_WORKFLOW_ID) {
      writeJson(res, 409, { error: "Task is not a Deep Research workflow" });
      return true;
    }
    if (!options.workspacePath) {
      writeJson(res, 501, {
        error: "Deep Research journey is not configured on this server",
      });
      return true;
    }
    const runPlan = await options.sessionStore.getRunPlan(
      sessionRoute.sessionId,
    );
    const snapshot = await buildDeepResearchJourneySnapshot({
      workspacePath: options.workspacePath,
      task,
      runPlan,
    });
    writeJson(res, 200, snapshot);
    return true;
  }

  if (
    sessionRoute.tail.length === 3 &&
    sessionRoute.tail[0] === "tasks" &&
    sessionRoute.tail[2] === "resume"
  ) {
    const taskId = requiredRouteSegment(sessionRoute.tail, 1);
    if (!isValidSessionId(taskId)) {
      writeJson(res, 400, { error: "Invalid task id" });
      return true;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const task = await options.sessionStore.getTaskRecord(
      sessionRoute.sessionId,
      taskId,
    );
    if (!task) {
      writeJson(res, 404, { error: "Task not found" });
      return true;
    }
    if (!options.taskQueue?.isReady()) {
      writeAdmissionRecovering(res);
      return true;
    }
    try {
      const resumed = await options.taskQueue.enqueueRecovery({
        sessionId: sessionRoute.sessionId,
        taskId,
        source: "manual_resume",
      });
      writeJson(res, 202, resumed);
      return true;
    } catch (error) {
      if (error instanceof TaskQueueError) {
        if (error.code === "task_admission_recovering") {
          writeAdmissionRecovering(res);
        } else {
          writeJson(res, 409, {
            error: "Task cannot be resumed",
            detail: error.message,
            code: error.code,
            retryable: false,
            task,
          });
        }
        return true;
      }
      throw error;
    }
  }

  if (sessionRoute.tail.length === 1 && sessionRoute.tail[0] === "tasks") {
    const session = await options.sessionStore.getSession(
      sessionRoute.sessionId,
    );
    if (!session) {
      writeJson(res, 404, { error: "Session not found" });
      return true;
    }

    if (req.method === "GET") {
      const tasks = await options.sessionStore.listTaskRecords(
        sessionRoute.sessionId,
      );
      writeJson(res, 200, { tasks });
      return true;
    }

    if (req.method === "POST") {
      await assertSessionDialogueInactive(options.sessionStore, sessionRoute.sessionId);
      if (!options.taskQueue?.isReady()) {
        writeAdmissionRecovering(res);
        return true;
      }
      const payload = await readJsonBody(req);
      const body = parseTaskCreateBody(payload);
      // The fourth consumer. A Workflow task brief is written once and read by
      // everything the run does, so a result the user attached has to reach it
      // here or not at all.
      const taskContinuation = await resolveContinuationContext({
        sessionId: sessionRoute.sessionId,
        selectedIds: body.contextResultIds ?? [],
        sessionStore: options.sessionStore,
        ...whenDefined(options.runStore, (runStore) => ({ runStore })),
      });
      if (taskContinuation.rejected.length > 0) {
        const first = taskContinuation.rejected[0];
        writeJson(res, 400, {
          error: "Context result rejected",
          detail: `Context result ${first?.id ?? ""} is ${first?.reason ?? "unusable"}`,
        });
        return true;
      }
;
      const savedPlan = await options.sessionStore.getRunPlan(
        sessionRoute.sessionId,
      );
      const teamId = body.teamId;
      const isTeamLaunch = teamId !== undefined;
      // A chat-selected Team goes through the one Team launch service the
      // message endpoint uses, so both entry points share one admission policy
      // rather than keeping two copies of it in step by hand.
      if (isTeamLaunch) {
        let launched;
        try {
          launched = await launchSessionTeamTask({
            sessionId: sessionRoute.sessionId,
            sessionStore: options.sessionStore,
            ...whenDefined(options.runStore, (definedValue) => ({ runStore: definedValue })),
            ...whenDefined(options.taskQueue, (definedValue) => ({ taskQueue: definedValue })),
            ...whenDefined(options.taskLauncher, (definedValue) => ({ taskLauncher: definedValue })),
            ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
            ...whenDefined(options.workspacePath, (definedValue) => ({ workspacePath: definedValue })),
            ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
            ...whenDefined(options.workspaceProjectService, (definedValue) => ({ workspaceProjectService: definedValue })),
            ...whenDefined(options.workspaceProjectContextStore, (definedValue) => ({ workspaceProjectContextStore: definedValue })),
            ...whenDefined(options.mcpWorkflowPreflightService, (definedValue) => ({ mcpWorkflowPreflightService: definedValue })),
            teamId,
            brief: body.brief ?? "",
            ...whenDefined(taskContinuation.context, (context) => ({
              continuationContext: context,
            })),
            ...whenDefined(body.projectContext, (definedValue) => ({ projectContext: definedValue })),
          });
        } catch (error) {
          if (error instanceof TeamChatTargetError) {
            writeJson(res, teamChatTargetStatus(error), {
              error: "Team is not available",
              detail: error.message,
            });
            return true;
          }
          throw error;
        }
        writeJson(res, 202, launched.task);
        return true;
      }
      const workflowId = body.workflowId;
      const plan =
        savedPlan &&
        ((savedPlan.status === "ready" &&
          !body.brief &&
          (!workflowId ||
            workflowId === savedPlan.selectedWorkflow?.id)) ||
          savedPlan.status === "applying" ||
          savedPlan.status === "queued" ||
          savedPlan.status === "running")
          ? savedPlan
          : await createRunPlanService({
              sessionId: sessionRoute.sessionId,
              sessionStore: options.sessionStore,
              ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
              ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
              goal: body.brief ?? "",
              ...whenDefined(workflowId, (definedValue) => ({ workflowId: definedValue })),
            });
      const launchBrief = body.brief;
      const launched = await applyRunPlanService({
        sessionId: sessionRoute.sessionId,
        sessionStore: options.sessionStore,
        taskQueue: options.taskQueue,
        ...whenDefined(options.taskLauncher, (definedValue) => ({ taskLauncher: definedValue })),
        ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
        ...whenDefined(options.workspacePath, (definedValue) => ({ workspacePath: definedValue })),
        ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
        plan,
        ...whenDefined(workflowId, (definedValue) => ({ workflowId: definedValue })),
        ...whenDefined(launchBrief, (definedValue) => ({ brief: definedValue })),
        // Not conditioned on a request brief. Launching an already-ready plan
        // sends none, and the effective brief is the plan's own.
        ...whenDefined(taskContinuation.context, (context) => ({
          continuationContext: context,
        })),
        ...whenDefined(body.projectContext, (definedValue) => ({ projectContext: definedValue })),
        ...whenDefined(options.workspaceProjectService, (definedValue) => ({ workspaceProjectService: definedValue })),
        ...whenDefined(options.workspaceProjectContextStore, (definedValue) => ({ workspaceProjectContextStore: definedValue })),
        ...whenDefined(options.mcpWorkflowPreflightService, (definedValue) => ({ mcpWorkflowPreflightService: definedValue })),
      });
      if (!launched.ok && launched.status === "needs_input") {
        writeJson(res, 409, {
          error: "Task brief required",
          assistant: launched.assistant,
          plan: launched.plan,
        });
        return true;
      }
      if (launched.ok) {
        writeJson(res, 202, launched.task);
        return true;
      }
      if (launched.status === "conflict") {
        writeJson(res, 409, {
          error: launched.error,
          detail: launched.detail,
          retryable: launched.retryable,
          diagnostics: launched.diagnostics,
          plan: launched.plan,
        });
        return true;
      }
      if (launched.statusCode === 409) {
        writeJson(res, 409, {
          error: launched.error,
          detail: launched.detail,
          plan: launched.plan,
        });
        return true;
      }
      if (launched.statusCode === 500) {
        writeJson(res, 500, { error: launched.error });
        return true;
      }
      if (launched.statusCode === 400) {
        writeJson(res, 400, {
          error: launched.error,
          detail: launched.detail,
          plan: launched.plan,
        });
        return true;
      }
      writeJson(res, 502, {
        error: launched.error,
        detail: launched.detail,
        task: launched.task,
      });
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  writeJson(res, 405, { error: "Method not allowed" });
  return true;
}

function humanInputRecipientViolationMessage(violation: HumanInputRecipientViolation): string {
  switch (violation.kind) {
    case "unknown":
      return `Unknown human-input recipient @${violation.mentionToken}`;
    case "ambiguous":
      return `Ambiguous human-input recipient @${violation.mentionToken}`;
    case "mismatch":
      return "Human-input message recipients must exactly match its literal @mentions";
  }
}

/**
 * The approval a crashed request already recorded, if this one may act on it.
 *
 * Bound to the same identity the queue's own startup repair uses: the durable
 * workflow must belong to this task, session, run and workflow, and its owner
 * must be the task's current execution attempt. A disagreement means this task
 * is not the one that workflow is waiting on, and continuing it would run
 * somebody else's approval.
 *
 * The offer id must match exactly. `other-offer` is the honest answer when this
 * run does hold an unadmitted approval but for a different offer: that is a
 * request naming the wrong decision, not a run with nothing to decide.
 *
 * A step whose continuation admission is already recorded *is* returned, as
 * `already-answered`: the attempt it names exists, and the caller is told which
 * one it is. What never happens is a second admission — that receipt is
 * once-only authority, and re-admitting through it is exactly what it refuses.
 */
type ApprovedModelChoiceRecovery =
  /** Approved, nothing admitted yet: this request admits the one continuation. */
  | { kind: "needs-admission"; stepId: string }
  /** Already admitted, or already run: answered from what exists, never re-admitted. */
  | { kind: "already-answered"; stepId: string }
  | { kind: "other-offer" }
  | { kind: "conflict"; message: string };

function classifyApprovedModelChoice(input: {
  snapshot: WorkflowExecutionSnapshot;
  task: SessionTask;
  offerId: string;
}): ApprovedModelChoiceRecovery | undefined {
  const { snapshot, task } = input;
  if (
    snapshot.manifest.taskId !== task.id ||
    snapshot.manifest.sessionId !== task.sessionId ||
    snapshot.manifest.rootRunId !== task.runId ||
    snapshot.manifest.workflowId !== task.workflowId
  ) {
    return undefined;
  }
  const approved = snapshot.state.steps.filter(
    (step) => step.approvedModelChoice !== undefined,
  );
  if (approved.length === 0) return undefined;
  const matching = approved.find(
    (step) => step.approvedModelChoice?.offerId === input.offerId,
  );
  if (!matching) return { kind: "other-offer" };

  const owner = snapshot.state.ownerExecutionAttemptId;
  const receipt = matching.modelChoiceContinuationAdmissionRequestId;
  const settled = isTerminalWorkflowStepStatus(matching.status);
  const admission = task.admission;

  // Nothing is admitted. Either the crash landed before the admission, or the
  // continuation has already run and its admission has since cleared.
  if (!admission) {
    // A consumed approval has to show the whole chain, not one link of it. The
    // continuation was admitted (its receipt is on the step), it ran to a
    // settled step, the task reached a terminal status, and the workflow is
    // still owned by that task's execution attempt. Accepting a receipt alone,
    // or a settled step alone, would report success over a half-written state
    // — which is corruption, not a replay.
    // Production commits the workflow's terminal outcome first and sets the
    // task terminal after it, so a settled run has both — and the two agree
    // through the mapping the store already owns. A terminal task over a
    // still-running workflow is a half-written ending, not a finished one.
    const consumed =
      receipt !== undefined &&
      settled &&
      isTerminalTaskStatus(task.status) &&
      terminalTaskStatusForWorkflow(snapshot.state.status) === task.status &&
      task.executionAttemptId !== undefined &&
      owner === task.executionAttemptId;
    if (consumed) {
      return { kind: "already-answered", stepId: matching.stepId };
    }
    if (receipt !== undefined || settled) {
      return {
        kind: "conflict",
        message:
          "This approval's continuation is only partly recorded, so it cannot be reported as complete.",
      };
    }
    if (task.status !== "awaiting_model_choice") {
      return {
        kind: "conflict",
        message: `This run is ${task.status}, so its model choice cannot be admitted.`,
      };
    }
    if (!task.executionAttemptId || owner !== task.executionAttemptId) {
      return {
        kind: "conflict",
        message:
          "This task is not the execution the workflow is waiting on, so its approval cannot be continued here.",
      };
    }
    return { kind: "needs-admission", stepId: matching.stepId };
  }

  // An admission exists. It has to be the one this approval produced, not some
  // other claim on the same task.
  if (
    admission.source !== "model_choice" ||
    admission.executionKind !== "continuation"
  ) {
    return {
      kind: "conflict",
      message: "This task already has a different admission.",
    };
  }
  // A staged admission has not been raised, so nothing is running for it and
  // nothing can be reported from it.
  if (admission.phase !== "pending" && admission.phase !== "granted") {
    return {
      kind: "conflict",
      message: "This task's admission has not been raised yet.",
    };
  }
  // Linked to the workflow either side of the claim, and to the task on both
  // sides of it. Matching the workflow owner alone says the admission was
  // raised against this run; it does not say the task is still the execution
  // that admission belongs to.
  //
  // Before the claim the workflow is still owned by the attempt the admission
  // was raised against, and the task sits either on that attempt (pending) or
  // on the one the grant handed it (granted). After the claim the step carries
  // this admission's receipt and the workflow has moved to the granted attempt.
  // A receipt means a claim already happened, so the pre-claim shape cannot
  // apply however well the owner matches: accepting it would tie this approval
  // to an admission that is not the one its continuation was claimed under.
  const linkedBeforeClaim =
    receipt === undefined &&
    admission.expectedExecutionAttemptId === owner &&
    task.executionAttemptId ===
      (admission.phase === "granted"
        ? admission.executionAttemptId
        : admission.expectedExecutionAttemptId);
  const linkedAfterClaim =
    receipt !== undefined &&
    receipt === admission.requestId &&
    admission.phase === "granted" &&
    owner === admission.executionAttemptId &&
    // Redundant today: `normalizeTaskRecord` refuses to persist a granted
    // admission whose task does not carry that attempt. Kept so this rule does
    // not depend on a guarantee made somewhere else, and recorded as untested
    // for that reason.
    task.executionAttemptId === admission.executionAttemptId;
  if (!linkedBeforeClaim && !linkedAfterClaim) {
    return {
      kind: "conflict",
      message:
        "This task's admission belongs to a different execution than the approval it is being asked to continue.",
    };
  }
  return { kind: "already-answered", stepId: matching.stepId };
}

/**
 * Which offer a waiting run is actually able to honour right now.
 *
 * `current` is the stored offer, still naming the pair the application default
 * names. `refreshed` is its replacement, written because the default moved.
 * `conflict` is the honest answer when no default could serve the retry at all:
 * the wait is left exactly as it is, answerable once Settings are fixed.
 */
type ResolvedModelChoiceOffer =
  | {
      kind: "current" | "refreshed";
      offer: ModelChoiceOffer;
      revision: number;
      stepId: string;
    }
  | {
      kind: "conflict";
      code: "no-app-default" | "default-equals-failed-choice";
      message: string;
    };

/**
 * The one rule both reading and approving a model choice go through.
 *
 * The pair is taken from the runtime default here on the server; a request
 * never supplies one, because an approval that could name its own pair would
 * be an arbitrary model-override API rather than consent to a pair the user
 * was shown.
 *
 * A default that cannot serve the retry produces no replacement: refreshing to
 * an unset, unavailable, or already-failed pair would have to invent an
 * eligible one, and offering a retry onto the pair that just failed describes
 * changing models when nothing would change.
 */
async function resolveCurrentModelChoiceOffer(input: {
  store: FileSystemWorkflowStateStore;
  revision: number;
  waiting: ModelChoiceOffer;
  stepId: string;
}): Promise<ResolvedModelChoiceOffer> {
  const currentDefault = getRuntimeDefaultModelState();
  const proposed = input.waiting.proposedDefault;
  if (
    currentDefault.status === "available" &&
    currentDefault.provider === proposed.provider &&
    currentDefault.model === proposed.model
  ) {
    return {
      kind: "current",
      offer: input.waiting,
      revision: input.revision,
      stepId: input.stepId,
    };
  }
  if (currentDefault.status !== "available") {
    return {
      kind: "conflict",
      code: "no-app-default",
      message:
        "No application default model is available, so this retry cannot be offered on one.",
    };
  }
  const failed = input.waiting.failedChoice;
  if (
    currentDefault.provider === failed.provider &&
    currentDefault.model === failed.model
  ) {
    return {
      kind: "conflict",
      code: "default-equals-failed-choice",
      message:
        "The application default is now the pair that already failed, so retrying on it would change nothing.",
    };
  }
  const replacement = await input.store.refreshModelChoiceOffer({
    expectedRevision: input.revision,
    offerId: input.waiting.offerId,
    proposedDefault: {
      provider: currentDefault.provider,
      model: currentDefault.model,
    },
  });
  return {
    kind: "refreshed",
    offer: replacement.offer,
    revision: replacement.revision,
    stepId: replacement.stepId,
  };
}

function statusForHumanInputStoreError(error: WorkflowStateStoreError): number {
  switch (error.code) {
    case 'invalid_state':
      return 400
    case 'not_found':
      return 404
    case 'already_exists':
    case 'artifact_invalid':
    case 'ownership_conflict':
    case 'revision_conflict':
      return 409
    case 'lock_timeout':
      return 503
    case 'corrupt':
    case 'identity_mismatch':
    case 'unsupported_version':
      return 500
  }
}

function statusForHumanInputQueueError(error: TaskQueueError): number {
  if (error.code === 'task_admission_recovering' || error.code === 'task_queue_closed') {
    return 503
  }
  return error.code === 'task_admission_conflict' ? 409 : 500
}

function writePlanningSseEvent(
  res: http.ServerResponse,
  event: DeepResearchPlanningEvent,
): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    return Promise.reject(new Error("SSE response is closed"));
  }
  const payload =
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (res.write(payload)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("error", onError);
      res.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("SSE response closed before draining"));
    };
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
  });
}

function writeAdmissionRecovering(res: http.ServerResponse): void {
  res.setHeader("retry-after", "1");
  writeJson(res, 503, {
    error: "Task admission is still recovering.",
    code: "task_admission_recovering",
    retryable: true,
  });
}

function decodeSessionRoute(
  url: URL,
): { sessionId: string; tail: string[] } | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "sessions" || !parts[1]) return null;
  return {
    sessionId: decodeSessionRouteSegment(parts[1], "session id"),
    tail: parts
      .slice(2)
      .map((part) => decodeSessionRouteSegment(part, "session path")),
  };
}

function decodeSessionRouteSegment(value: string, label: string): string {
  const decoded = decodeSafePathSegment(value);
  if (!decoded) {
    throw new ApiRequestError(`Invalid ${label}`, 400);
  }
  return decoded;
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Write one agent-text-stream delivery.
 *
 * `id` is omitted for the `reset` prelude, which is the whole reason this is
 * not `writeSseEvent` from the runs route: an event with no `id:` leaves the
 * client's last-event-id untouched, so SSE ids stay strictly monotonic even
 * though the reset precedes frames whose cursors are higher than the range it
 * warns about.
 *
 * Resolves only once the socket accepts the write, so the caller can keep at
 * most one write outstanding.
 */

/**
 * A server-minted turn identity.
 *
 * Injected where composition supplies one; the fallback exists so a route
 * assembled without that wiring still journals rather than silently skipping.
 */
function mintTurnId(injected?: () => string): string {
  return injected ? injected() : randomUUID();
}
