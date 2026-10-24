import { registerActiveAgentTurn } from './active-agent-turns.js';
import { updateAgentProgress, type AgentProgressSnapshot } from '../contracts/agent-progress.js';
import {
  loadAgentReplySpeakers as loadRequestedAgents,
  createGenericAgentReplySpeaker as createGenericAssistant,
  runAgentReply,
  withAgentReplyConnectionKind as withConnectionKind,
  shouldPublishAgentReplyExcelDocument as shouldPublishExcelDocument,
  publishAgentReplyExcelDocument as publishChatExcelDocument,
  type AgentReplySpeaker as ChatSpeaker,
  type AgentReplyMcpMeta as AgentChatMcpMeta,
  type AgentReplyRunInput,
  type AgentReplyResult,
} from "./agent-reply-service.js";
import {
  AgentChatProviderInterruptedError,
  AgentChatTurnCancelledError,
  AGENT_CHAT_PROVIDER_INTERRUPTED_CODE,
  AGENT_REPLY_PROVIDER_DEADLINE_MS as AGENT_CHAT_PROVIDER_DEADLINE_MS,
  AGENT_REPLY_PROVIDER_CLEANUP_BUDGET_MS as AGENT_CHAT_PROVIDER_CLEANUP_BUDGET_MS,
  runAgentReplyLifecycle,
  withoutMaskingAgentReplyCause as withoutMaskingCause,
  recordAgentReplyPublished as recordAgentTurnTerminal,
} from "./agent-reply-lifecycle.js";
export { describeSpeakerFailure } from "./agent-reply-service.js";
export type { AgentReplyMcpMeta as AgentChatMcpMeta } from "./agent-reply-service.js";
export { AgentChatProviderInterruptedError, AgentChatTurnCancelledError, AGENT_CHAT_PROVIDER_INTERRUPTED_CODE } from "./agent-reply-lifecycle.js";

import { whenDefined } from "../core/optional-properties.js"
import { captureSessionDocuments, captureProjectDocuments, captureDeliveryDocuments, renderDocumentManifest } from './document-context-service.js';
import { resolveRuntimeFileParserLauncher, type FileParserLauncher } from '../core/file-parser-launcher.js';
import { requestsWholeDocument } from '../domains/document-access/document-review.js';
import { createDocumentToolAdapters } from './document-tool-adapters.js';
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { hashCanonicalJson } from "../core/canonical-json-hash.js";
import type { ProviderProtocolEvent } from "../contracts/provider.js";
import type { AgentTextStreamHub } from "../domains/runtime/agent-text-stream-hub.js";
import type { AgentTextStreamInput } from "../contracts/agent-text-stream.js";
import type { ModelSelection } from "../contracts/agent-model-selection.js";
import { generateSessionTitle } from "../domains/sessions/session-title.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import type {
  ChatMessage,
  ChatTurnRequest,
  SessionSummary,
} from "../contracts/sessions.js";
import { excludeTurnUserMessage, isValidSessionId } from "../contracts/sessions.js";
import { resolveChatFileBudget } from "./agent-chat-history.js";
import { ServiceError } from "./service-errors.js";
import {
  enrichHistoryWithDeliveryContent,
  type DeliveryArtifactReader,
} from "./delivery-context.js";
import { buildChatMessage, conversationTurnMessageId } from "./session-service.js";
import type { McpAgentToolService } from "./mcp-agent-tool-service.js";
import type { AgentTurnJournalRecorder } from "./agent-turn-journal-recorder.js";
import {
  isLostConversationTurnClaim,
  type ConversationTurnJournalRecorder,
} from "./conversation-turn-journal-recorder.js";
import {
  CONVERSATION_TURN_MAX_RESPONSES,
  type ConversationTurnOrigin,
} from "../domains/conversations/conversation-turn-journal.js";
import {
  buildSessionChatFileContext,
  lockSessionChatFiles,
} from "./session-chat-file-context.js";
import { buildFrontDoorCatalog } from "./front-door-context.js";
import { isFrontDoorAgent } from "../domains/sessions/front-door.js";
import type { WorkspaceProjectContextSelection } from "../contracts/projects.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import { buildWorkspaceProjectChatContext } from "./project-context-service.js";
import { contextLimit } from "../core/context-limits.js";
import { buildFolderMapContext } from "./folder-map-context.js";
import { createFolderToolAdapters } from "./folder-tool-adapters.js";
import type { SharedFolderService } from "./shared-folder-service.js";
import { withSessionChatActivity, type SessionChatActivity } from './session-activity-service.js';
import type { AgentDialogueService } from './agent-dialogue-service.js';
import { AGENT_DIALOGUE_ACTIVATION_PROMPT, createAgentDialogueToolAdapter } from './agent-dialogue-tool-adapter.js';
import {
  WORKFLOW_LAUNCH_ACTIVATION_PROMPT,
  createWorkflowLaunchToolAdapter,
  type WorkflowLaunchOutcome,
} from './workflow-launch-tool-adapter.js';
import type { RunPlanTaskQueue } from './run-orchestrator-service.js';
import type { WorkflowMcpPreflightService } from './workflow-mcp-preflight-service.js';
import type { RunPlan } from '../contracts/run-plan.js';
import type { SessionTask } from '../contracts/sessions.js';
import { normalizeMcpAgentPath } from '../domains/mcp/mcp-settings.js';
import type { ResourceLibraryService } from './resource-library-service.js';

export interface AgentChatReplyMeta {
  speakerId: string;
  speakerName: string;
  model: string;
  fallback: boolean;
  reason?: string;
  mcp?: AgentChatMcpMeta;
  /**
   * Settings that stopped applying because this reply ran on an approved
   * substitute pair, by name.
   *
   * Recorded with the reply rather than left to inference: an approved switch
   * can legitimately drop a setting the new provider has no field for, and a
   * reply that reads differently for that reason is otherwise unexplainable.
   */
  droppedProviderOptions?: readonly string[];
  /**
   * The turn had folders attached and this reply came from a plain call with
   * no tools: the model saw the folder map but could not open a file.
   */
  folderToolsUnavailable?: boolean;
}

/**
 * How a chat turn reaches its assignment's journal.
 *
 * A function rather than the registry itself: the chat service has no business
 * knowing about workspaces, journal handles, or enrollment modes, and this way
 * a test can drive the whole lifecycle with a recorder of its own.
 */
export type AgentTurnJournalResolver = (input: {
  readonly scope: {
    readonly sessionId: string;
    readonly runId: string;
    readonly assignmentId: string;
  };
  readonly agentPath: string;
  readonly signal?: AbortSignal;
}) => Promise<AgentTurnJournalRecorder | undefined>;

/**
 * How a chat turn reaches its own conversation activity.
 *
 * A function rather than a resolved recorder, for the same reason the agent
 * journal is one: opening an activity writes a manifest and syncs it, and the
 * turn must reserve its display channel — an in-memory operation a subscriber
 * is already waiting on — before it pays for any of that.
 */
export type ConversationTurnJournalResolver = (input: {
  readonly sessionId: string;
  readonly turnId: string;
}) => Promise<ConversationTurnJournalRecorder | undefined>;

/**
 * The result of one ordinary session chat turn.
 */
export interface AgentChatTurnResult {
  user: ChatMessage;
  replies: ChatMessage[];
  /** True when this response replayed a turn that was already persisted. */
  replayed?: boolean;
  /** True when the replayed turn is missing replies (a crash mid-generation). */
  incomplete?: boolean;
  session?: SessionSummary;
  /**
   * The task and plan of a Workflow the front door launched through its
   * `start_workflow` tool during this turn, when it did.
   */
  task?: SessionTask;
  plan?: RunPlan;
  meta: {
    replies: AgentChatReplyMeta[];
    titleModel?: string;
    titleFallback?: boolean;
    titleReason?: string;
  };
}

export async function runSessionAgentChatTurn(params: {
  sessionId: string;
  session: SessionSummary;
  sessionStore: SessionStore;
  repoRootPath: string;
  resourceLibraryService?: Pick<ResourceLibraryService, 'createAgentProjection'>;
  /**
   * Where Workflows are registered, for the front door's catalog.
   *
   * Absent means the catalog lists no Workflows, which is what a deployment
   * without a registry honestly has. No other speaker reads it.
   */
  workflowsRegistryPath?: string;
  /**
   * Results this turn carries forward, already resolved.
   *
   * Resolved by the dispatcher once per admitted turn, so every speaker in a
   * multi-agent turn reads the same snapshot of the same past.
   */
  continuationContext?: string;
  /**
   * The ids behind `continuationContext`, for this turn's identity only.
   *
   * The ids and not the resolved text: an artifact rewritten between a send
   * and its retry would otherwise turn an ordinary replay into a conflict,
   * and what the user chose is what makes one request different from another.
   */
  contextResultIds?: readonly string[];
  text: string;
  agentNames: string[];
  provider?: string;
  model?: string;
  mcpAgentToolService?: Pick<McpAgentToolService, "runTurn">;
  agentDialogueService?: Pick<AgentDialogueService, 'start'>;
  /**
   * Launch collaborators for the front door's `start_workflow` tool.
   *
   * The tool is offered to the front door only when both are present — where
   * they are not, a launch could not be admitted, so the model is never
   * invited to attempt one.
   */
  taskQueue?: RunPlanTaskQueue;
  workspacePath?: string;
  /**
   * The capability preflight every launch route performs. Optional so a
   * composition without one keeps its old behavior, but the dispatch
   * compositions wire the real service.
   */
  mcpWorkflowPreflightService?: Pick<WorkflowMcpPreflightService, "resolve">;
  /** Trusted dispatch ownership, never accepted from an HTTP request. */
  chatActivity?: SessionChatActivity;
  fileParserLauncher?: FileParserLauncher;
  /**
   * Resolves this turn's attached folders on the server
   * (docs/feature-local-folder-access.md). Absent where folder access is off.
   */
  sharedFolderService?: Pick<SharedFolderService, "resolveTurnFolders" | "toolPolicy">;
  signal?: AbortSignal;
  /** Absent where this composition records no agent-turn evidence. */
  agentTurnJournal?: AgentTurnJournalResolver;
  readDeliveryArtifact?: DeliveryArtifactReader;
  projectContext?: WorkspaceProjectContextSelection;
  workspaceProjectService?: Pick<
    WorkspaceProjectService,
    "getProjectRecord" | "getSession"
  >;
  workspaceProjectContextStore?: WorkspaceProjectContextStore;
  /** Client-minted idempotency key and stream channel id. */
  turnId?: string;
  /**
   * One approved attempt on the application default, for one named agent.
   *
   * Server-authored only: it is produced by validating a model-choice offer
   * the user was actually shown, never taken from a request body. It replaces
   * that agent's own selection for this turn alone and changes nothing the
   * agent has saved.
   */
  approvedSelection?: {
    readonly agentName: string;
    readonly selection: ModelSelection;
    /**
     * The offer this attempt spends, recorded on the turn so the offer cannot
     * be spent twice. Omitted only by callers that authorize no offer.
     */
    readonly offer?: {
      readonly offerId: string;
    };
  };
  /** Who named `turnId`: the caller, or this server on its behalf. */
  turnOrigin?: ConversationTurnOrigin;
  /**
   * Earlier turns whose user message is this same question, re-asked.
   *
   * An approved retry runs under a fresh turn id, so the failed attempt's copy
   * of the question stays in the transcript. Without naming it here the model
   * reads the question twice, which is the duplication the history filter was
   * added to remove.
   */
  supersedesTurnIds?: readonly string[];
  /**
   * What kind of connection a `connection:<id>` provider routes to.
   *
   * Supplied by the composition root, which can read connection settings. Absent
   * here means every connection-routed speaker is budgeted against the generic
   * window rather than its own.
   */
  resolveConnectionKind?: (provider: string) => string | undefined;
  /**
   * The turn's aggregate lifecycle, when this session is enrolled.
   *
   * One record for the whole turn, above the per-reply `agent.turn` streams.
   * Absent means the turn runs exactly as it used to, with no barrier.
   */
  conversationJournal?: ConversationTurnJournalResolver;
  /** Display-only text stream. Absent means the turn simply does not stream. */
  textStreamHub?: AgentTextStreamHub;
  /**
   * How long the whole provider operation may take before it is interrupted.
   *
   * A policy ceiling, injected rather than fixed, so a test can express the
   * same rule in milliseconds. Absent means the default below.
   */
  providerDeadlineMs?: number;
  /**
   * How long an interrupted operation is given to unwind before the turn stops
   * waiting on it. Injected for the same reason as the deadline.
   */
  providerCleanupBudgetMs?: number;
}): Promise<AgentChatTurnResult> {
  return withSessionChatActivity(params.sessionStore, params.sessionId, (chatActivity) => runClaimedSessionAgentChatTurn({ ...params, chatActivity }), params.chatActivity);
}

function dialogueEnabledToolService(params: Parameters<typeof runSessionAgentChatTurn>[0]): Pick<McpAgentToolService, 'runTurn'> | undefined {
  const service = params.mcpAgentToolService;
  const dialogue = params.agentDialogueService;
  const activity = params.chatActivity;
  if (!service || !dialogue || !activity) return service;
  return {
    runTurn: (input) => {
      const agentPath = normalizeMcpAgentPath(input.agentPath);
      if (!agentPath) return service.runTurn(input);
      const adapter = createAgentDialogueToolAdapter({
        sessionId: params.sessionId, currentAgentId: agentPath.slice('agents/'.length), activity, service: dialogue,
        context: {
          ...whenDefined(params.projectContext, (projectContext) => ({ projectContext })),
          ...whenDefined(params.contextResultIds, (ids) => ({ contextResultIds: [...ids] })),
        },
      });
      return service.runTurn({ ...input, systemPrompt: `${input.systemPrompt}\n\n${AGENT_DIALOGUE_ACTIVATION_PROMPT}`, turnBuiltinAgentTools: [...(input.turnBuiltinAgentTools ?? []), adapter] });
    },
  };
}

/**
 * The front door's chat-confirmed launch, wired exactly like the dialogue tool.
 *
 * The adapter is per-turn and offered only to the front door: a specialist that
 * could start Workflows from prose is a regression, not a feature. What it
 * launched is written to `launched` so the turn result can report it.
 */
function workflowLaunchEnabledToolService(params: {
  turnParams: Parameters<typeof runSessionAgentChatTurn>[0];
  service: Pick<McpAgentToolService, 'runTurn'> | undefined;
  turnId: string;
  fingerprint: string;
  launched: { current?: WorkflowLaunchOutcome };
}): Pick<McpAgentToolService, 'runTurn'> | undefined {
  const { service, turnParams } = params;
  if (!service || !turnParams.taskQueue || !turnParams.workspacePath || !turnParams.workflowsRegistryPath) {
    return service;
  }
  const { taskQueue, workspacePath, workflowsRegistryPath } = turnParams;
  return {
    runTurn: (input) => {
      const agentPath = normalizeMcpAgentPath(input.agentPath);
      const agentId = agentPath?.slice('agents/'.length) ?? '';
      if (!agentPath || !isFrontDoorAgent(agentId)) return service.runTurn(input);
      const adapter = createWorkflowLaunchToolAdapter({
        workerModel: { provider: input.provider, model: input.model },
        sessionId: turnParams.sessionId,
        sessionStore: turnParams.sessionStore,
        repoRootPath: turnParams.repoRootPath,
        workspacePath,
        workflowsRegistryPath,
        taskQueue,
        ...whenDefined(turnParams.mcpWorkflowPreflightService, (mcpWorkflowPreflightService) => ({
          mcpWorkflowPreflightService,
        })),
        // The launch is this turn's work: it carries the turn's project
        // selection and carried results, exactly as the Coordinator's
        // chat-confirmed launch does.
        ...whenDefined(turnParams.projectContext, (projectContext) => ({ projectContext })),
        ...whenDefined(turnParams.workspaceProjectService, (workspaceProjectService) => ({
          workspaceProjectService,
        })),
        ...whenDefined(turnParams.workspaceProjectContextStore, (workspaceProjectContextStore) => ({
          workspaceProjectContextStore,
        })),
        ...whenDefined(turnParams.continuationContext, (continuationContext) => ({
          continuationContext,
        })),
        goal: turnParams.text,
        sourceTurn: { turnId: params.turnId, fingerprint: params.fingerprint },
        onLaunched: (outcome) => {
          params.launched.current = outcome;
        },
      });
      return service.runTurn({
        ...input,
        systemPrompt: `${input.systemPrompt}\n\n${WORKFLOW_LAUNCH_ACTIVATION_PROMPT}`,
        turnBuiltinAgentTools: [...(input.turnBuiltinAgentTools ?? []), adapter],
      });
    },
  };
}

async function runClaimedSessionAgentChatTurn(params: Parameters<typeof runSessionAgentChatTurn>[0]): Promise<AgentChatTurnResult> {
  const dialogueToolService = dialogueEnabledToolService(params);
  let projectContext = "";
  if (params.projectContext) {
    if (!params.workspaceProjectService || !params.workspaceProjectContextStore) {
      throw new ServiceError("bad_request", "Project context is unavailable");
    }
    try {
      projectContext = await buildWorkspaceProjectChatContext({
        sessionId: params.sessionId,
        selection: params.projectContext,
        projectService: params.workspaceProjectService,
        contextStore: params.workspaceProjectContextStore,
      });
    } catch (error) {
      throw new ServiceError(
        "bad_request",
        error instanceof Error ? error.message : "Invalid project context selection",
      );
    }
  }
  if (params.turnId !== undefined && !isValidSessionId(params.turnId)) {
    throw new ServiceError("bad_request", "turnId must be a UUID");
  }
  const turnId = params.turnId ?? crypto.randomUUID();
  const providerDeadlineMs =
    params.providerDeadlineMs ?? AGENT_CHAT_PROVIDER_DEADLINE_MS;
  const providerCleanupBudgetMs =
    params.providerCleanupBudgetMs ?? AGENT_CHAT_PROVIDER_CLEANUP_BUDGET_MS;
  const turnRequest: ChatTurnRequest = {
    fingerprint: requestFingerprint(params),
    expectedReplies: 0,
    // Named at admission, never re-derived. A replay has to be checked under
    // the scheme this turn was hashed with, and which responder owns an
    // untargeted turn changes as soon as a Workflow is selected.
    responder: "agents",
  };
  // What the front door's `start_workflow` tool launched during this turn, if
  // anything. The tool executes inside the provider loop, so the turn reads
  // the outcome back through this ref after the replies are durable.
  const workflowLaunch: { current?: WorkflowLaunchOutcome } = {};
  const mcpAgentToolService = workflowLaunchEnabledToolService({
    turnParams: params,
    service: dialogueToolService,
    turnId,
    fingerprint: turnRequest.fingerprint,
    launched: workflowLaunch,
  });

  // A client-supplied id is an idempotency key, so a duplicate must be
  // classified before anything is generated or persisted.
  if (params.turnId !== undefined) {
    const replay = await classifyAgentChatReplay({
      sessionId: params.sessionId,
      sessionStore: params.sessionStore,
      turnId,
      fingerprint: turnRequest.fingerprint,
      ...whenDefined(params.textStreamHub, (definedValue) => ({ hub: definedValue })),
      ...whenDefined(params.agentTurnJournal, (agentTurnJournal) => ({
        agentTurnJournal,
      })),
      ...whenDefined(params.conversationJournal, (conversationJournal) => ({
        conversationJournal,
      })),
    });
    if (replay) return replay;
  }

  // Reserve the channel BEFORE any persistence or expensive work.
  //
  // Two requests carrying the same client-minted turnId can both classify as
  // new: neither finds a persisted user message, and neither finds an open
  // channel. Opening the channel first makes it the mutual exclusion, so the
  // loser is rejected before it can append a second user message. `openChannel`
  // throws when the id is already held, which is exactly the collision signal.
  const hub = params.textStreamHub;
  let channelOpen = false;
  /** The reply currently being produced, until its terminal is published. */
  let pendingReplyId: string | undefined;
  if (hub) {
    try {
      hub.openChannel(turnId, params.sessionId);
      channelOpen = true;
    } catch {
      throw new ServiceError("conflict", "turn_in_flight");
    }
  }

  // Resolved inside the reservation, not before it: the channel is what a
  // waiting subscriber is blocked on, and opening a journal is disk work.
  const activeTurn = registerActiveAgentTurn(params.sessionStore, params.sessionId, turnId, params.signal);
  params = { ...params, signal: activeTurn.signal };
  let conversationRecorder: ConversationTurnJournalRecorder | undefined;
  // How far the aggregate lifecycle got. A turn that never opened one has no
  // ending of its own to record, and a turn past preparation has already named
  // its replies — which changes what its ending honestly says.
  let conversationStarted = false;
  let conversationPrepared = false;
  let conversationEnded = false;
  /**
   * The failure this turn is already reporting, once it has one.
   *
   * Cleanup runs in a `finally`, and a throw there replaces whatever exception
   * was in flight. Without this the caller would be told why a lease stuck
   * instead of why their reply was never stored.
   */
  let reportedFailure: { readonly cause: unknown } | undefined;
  /** Reply identities the aggregate claimed, once preparation named them. */
  let claimedReplyIds: readonly string[] = [];
  /** Reply identities the transcript is proven to hold. */
  const durableReplyIds: string[] = [];

  try {
    // Before anything is persisted, so a journal that is enrolled but
    // unreachable fails the turn closed rather than publishing replies with no
    // evidence behind them.
    conversationRecorder = params.conversationJournal
      ? await params.conversationJournal({
          sessionId: params.sessionId,
          turnId,
        })
      : undefined;

    const files = await lockSessionChatFiles(
      params.sessionStore,
      params.sessionId,
    );

    const projection = params.agentNames.length > 0
      ? await params.resourceLibraryService?.createAgentProjection({
          scopeId: `${params.sessionId}/${turnId}`, agentIds: params.agentNames,
        })
      : undefined;
    const requestedAgents = loadRequestedAgents({
      repoRootPath: projection?.rootPath ?? params.repoRootPath,
      agentNames: params.agentNames,
      ...whenDefined(params.resolveConnectionKind, (resolveConnectionKind) => ({
        resolveConnectionKind,
      })),
      ...whenDefined(params.approvedSelection, (approvedSelection) => ({
        approvedSelection,
      })),
      ...whenDefined(params.provider, (provider) => ({ provider })),
      ...whenDefined(params.model, (model) => ({ model })),
      ...(params.agentNames.some(isFrontDoorAgent)
        ? {
            catalog: buildFrontDoorCatalog({
              repoRootPath: params.repoRootPath,
              ...whenDefined(params.workflowsRegistryPath, (registryPath) => ({
                workflowsRegistryPath: registryPath,
              })),
            }),
          }
        : {}),
    });
    const speakers =
      requestedAgents.length > 0
        ? requestedAgents
        : [
            // The fallback speaker needs its connection kind too. Roster
            // speakers get it inside loadRequestedAgents; this one is built
            // here and would otherwise be the one path still budgeted against
            // the generic window.
            withConnectionKind(
              createGenericAssistant({
                ...whenDefined(params.provider, (definedValue) => ({ provider: definedValue })),
                ...whenDefined(params.model, (definedValue) => ({ model: definedValue })),
              }),
              params.resolveConnectionKind,
            ),
          ];
    // Built after the roster, not before it: the file block is rendered once
    // and read by every speaker, so it is sized against the smallest window
    // among them. Before this it was a flat 24,000 characters per file and
    // 60,000 in total, identical whether the reader held 32k tokens or a
    // million.
    const attachmentBudget = resolveChatFileBudget(speakers);
    const wholeDocument = requestsWholeDocument(params.text);
    const needsParser = files.some((file) => !file.outputs?.text || wholeDocument && file.name.toLowerCase().endsWith('.pdf')) || params.projectContext?.fileNames.some((name) => !/\.(md|txt|csv|json)$/i.test(name));
    const parserLauncher = needsParser ? params.fileParserLauncher ?? resolveRuntimeFileParserLauncher({ defaultRepoRootPath: params.repoRootPath }) : undefined;
    const admittedDocuments = await captureSessionDocuments({
      sessionId: params.sessionId,
      files,
      sessionStore: params.sessionStore,
      ...(files.length > 0 ? { sourceRoot: params.sessionStore.inputsDir(params.sessionId) } : {}),
      requirePageIndex: wholeDocument,
      ...whenDefined(parserLauncher, (parserLauncher) => ({ parserLauncher })),
      ...whenDefined(params.signal, (signal) => ({ signal })),
    });
    if (params.projectContext && params.workspaceProjectContextStore && params.workspaceProjectService) {
      const projectDocuments = await captureProjectDocuments({ selection: params.projectContext, store: params.workspaceProjectContextStore, ...whenDefined(parserLauncher, (parserLauncher) => ({ parserLauncher })), ...whenDefined(params.signal, (signal) => ({ signal })) });
      admittedDocuments.push(...projectDocuments);
      projectContext = await buildWorkspaceProjectChatContext({ sessionId: params.sessionId, selection: params.projectContext, projectService: params.workspaceProjectService, contextStore: params.workspaceProjectContextStore, admittedDocuments: projectDocuments });
    }
    admittedDocuments.push(...await captureDeliveryDocuments({ sessionId: params.sessionId, history: await params.sessionStore.listChatMessages(params.sessionId), ...whenDefined(params.readDeliveryArtifact, (readArtifact) => ({ readArtifact })), ...whenDefined(params.signal, (signal) => ({ signal })) }));
    const documentContext = renderDocumentManifest(admittedDocuments);
    const documentTools = createDocumentToolAdapters({
      documents: admittedDocuments,
      scope: { sessionId: params.sessionId, runId: turnId },
    });
    const fileContext = await buildSessionChatFileContext({
      admittedDocuments,
      sessionId: params.sessionId,
      sessionStore: params.sessionStore,
      files,
      ...attachmentBudget,
    });
    // Resolved once for the whole turn, on the server, from what the chat has
    // attached. Every speaker gets the same map and tools bound to the same
    // folders; a later change applies from the next turn.
    const turnFolders = params.sharedFolderService
      ? await params.sharedFolderService.resolveTurnFolders(params.sessionId)
      : [];
    const folderContext = params.sharedFolderService && turnFolders.length > 0
      ? await buildFolderMapContext({
          folders: turnFolders,
          policy: params.sharedFolderService.toolPolicy,
          maxTokens: Math.floor(
            attachmentBudget.totalMaxTokens * contextLimit("share.folderMap"),
          ),
          ...whenDefined(params.signal, (signal) => ({ signal })),
        })
      : "";
    const folderTools = params.sharedFolderService && turnFolders.length > 0
      ? createFolderToolAdapters({
          folders: turnFolders,
          policy: params.sharedFolderService.toolPolicy,
        })
      : [];
    if (
      conversationRecorder &&
      speakers.length > CONVERSATION_TURN_MAX_RESPONSES
    ) {
      // Refused before anything runs. A roster larger than one turn record can
      // hold would otherwise fail at preparation — after every speaker had
      // already been paid for and half of them published.
      throw new ServiceError(
        "bad_request",
        `A chat turn may address at most ${CONVERSATION_TURN_MAX_RESPONSES} agents`,
      );
    }

    // Deterministic, because the turn record names every reply before any of
    // them exists. A random id could not be claimed in advance, and a
    // preparation that cannot name what it is about to write is not one a
    // crash can be diagnosed from.
    // Written with the user's message, before the barrier and before any
    // provider call, so a turn still running or one that failed outright can
    // still name the pair each speaker was admitted on. Server-authored: a
    // caller cannot assert its own provenance.
    const admittedSelections = Object.fromEntries(
      speakers.flatMap((speaker) =>
        speaker.selection ? [[speaker.id, speaker.selection] as const] : [],
      ),
    );
    const persistedUserMessage = buildChatMessage("user", params.text, {
      id: conversationTurnMessageId(turnId, "user"),
      schemaVersion: 2,
      conversationId: params.sessionId,
      kind: "chat",
      source: { kind: "conversation-turn", turnId },
      turnId,
      turnRequest: {
        ...turnRequest,
        expectedReplies: speakers.length,
        ...(Object.keys(admittedSelections).length > 0
          ? { admittedSelections }
          : {}),
        // Durable before anything runs, so an offer's consumption survives a
        // crash between the approval and the attempt.
        ...whenDefined(params.approvedSelection?.offer, (approvedOffer) => ({
          approvedOffer,
        })),
        // Recorded so a later authorized attempt at *this* request can be the
        // same request. Rebuilt from the project as it stands when it runs,
        // exactly as this attempt built it.
        ...whenDefined(params.projectContext, (projectContext) => ({
          projectContext,
        })),
      },
    });
    await appendTurnMessage({
      sessionStore: params.sessionStore,
      sessionId: params.sessionId,
      message: persistedUserMessage,
    });

    // The barrier. Durable after the user's message and before any assignment
    // or provider request, so a crash can never leave work this turn started
    // that no record accounts for.
    if (conversationRecorder) {
      try {
        await conversationRecorder.recordStarted({
          surface: "run-selected-agents",
          userMessageId: persistedUserMessage.id,
          requestDigest: turnRequest.fingerprint,
          expectedResponseCount: speakers.length,
          origin: params.turnOrigin ?? "client",
          // No requested provider or model. Each speaker asks for its own and
          // its `agent.turn` records it; one value here would attribute a
          // single speaker's request to the whole roster.
        });
      } catch (error) {
        // One failure means another request already claimed this turn and is
        // still running it. Every other recording failure is a journal that
        // could not be written, which is not a duplicate request.
        if (isLostConversationTurnClaim(error)) {
          throw new ServiceError("conflict", "turn_in_flight");
        }
        throw error;
      }
      conversationStarted = true;
    }

    // Every reply this turn will publish, decided before any of them runs.
    //
    // Hoisted out of the speaker loop because the aggregate has to name the
    // whole set at once: a preparation written per speaker would be a second,
    // third and fourth claim about the same turn, and none of them could say
    // how many replies were still to come.
    const planned: PlannedReply[] = [];
    for (const [speakerOrdinal, speaker] of speakers.entries()) {
      // Every selected agent gets an assignment, whether or not MCP tools are
      // available. The assignment is where this reply's durable evidence
      // lives, and gating it on the tool service made a turn that failed
      // before any tool call leave no trace at all.
      const assignmentId =
        speaker.type === "agent" ? crypto.randomUUID() : undefined;
      let assignmentPath: string | undefined;
      if (assignmentId) {
        const location = await params.sessionStore.ensureAgentChatAssignment(
          params.sessionId,
          turnId,
          assignmentId,
        );
        if (!location) {
          throw new ServiceError(
            "internal",
            "Could not create the agent chat assignment.",
          );
        }
        assignmentPath = location.assignmentPath;
      }
      planned.push({
        speaker,
        speakerOrdinal,
        replyId: `${speaker.id}:${speakerOrdinal}`,
        assistantMessageId: conversationTurnMessageId(
          turnId,
          "assistant",
          speakerOrdinal,
        ),
        ...whenDefined(assignmentId, (definedValue) => ({
          assignmentId: definedValue,
        })),
        ...whenDefined(assignmentPath, (definedValue) => ({
          assignmentPath: definedValue,
        })),
      });
    }

    claimedReplyIds = planned.map((reply) => reply.assistantMessageId);
    // Durable before the first reply is written. The crash window this opens —
    // links named, replies missing — is exactly what an operator needs to
    // follow: every assignment it names really ran, whether or not its reply
    // reached the transcript.
    if (conversationRecorder) {
      await conversationRecorder.recordPrepared({
        assistantMessageIds: claimedReplyIds,
        ...whenDefined(assignmentLinksOf(planned), (assignments) => ({
          assignments,
        })),
      });
      conversationPrepared = true;
    }

    // Published for every reply with an admitted selection, before any
    // provider request, so the bubble of a reply still being produced names
    // the provider and model that reply was admitted on without waiting for
    // the first token. The selection's own source tells default use from an
    // explicit choice: an explicit choice that equals today's default still
    // carries source "agent". The durable record on the user's message stays
    // the authority; this frame is a preview, and a lost one costs the live
    // label and nothing else.
    if (hub) {
      for (const plannedReply of planned) {
        const selection = plannedReply.speaker.selection;
        if (!selection) continue;
        hub.publish(turnId, {
          type: "selection",
          replyId: plannedReply.replyId,
          speaker: plannedReply.speaker.id,
          selection,
        });
      }
    }

    const replies: ChatMessage[] = [];
    const replyMeta: AgentChatReplyMeta[] = [];

    for (const plannedReply of planned) {
      const { speaker, speakerOrdinal, replyId, assignmentId, assignmentPath } =
        plannedReply;
      // Held only for the window in which this reply has no terminal yet. A
      // throw inside that window is the one case where the bubble would
      // otherwise be left open forever.
      pendingReplyId = replyId;
      // The turn's own question is rendered under its own heading below, and
      // it was persisted before this read, so it would otherwise close the
      // quoted history as well. Earlier speakers' replies in this same turn
      // stay: each later speaker is meant to see them.
      const history = await enrichHistoryWithDeliveryContent(
        excludeTurnUserMessage(
          await params.sessionStore.listChatMessages(params.sessionId),
          // This turn, and any attempt it re-asks. An approved retry carries the
          // original question under a fresh turn id, so excluding only this one
          // leaves the failed attempt's identical copy in the quoted history.
          [turnId, ...(params.supersedesTurnIds ?? [])],
        ),
        params.readDeliveryArtifact,
      );

      // Deliveries are still an MCP-path concern; only the journal is not.
      const mcpAssignmentId = params.mcpAgentToolService
        ? assignmentId
        : undefined;
      const mcpAssignmentPath = params.mcpAgentToolService
        ? assignmentPath
        : undefined;
      const agentPath = `agents/${speaker.id}`;
      const recorder =
        assignmentId && params.agentTurnJournal
          ? await params.agentTurnJournal({
              scope: {
                sessionId: params.sessionId,
                runId: turnId,
                assignmentId,
              },
              agentPath,
              ...whenDefined(params.signal, (signal) => ({ signal })),
            })
          : undefined;
      let progress: AgentProgressSnapshot | undefined;
      const publishProgress = (event: NonNullable<ProviderProtocolEvent['progress']>) => {
        if (params.signal?.aborted || !hub?.isOpen(turnId)) return;
        const next = updateAgentProgress(progress, event, Date.now());
        if (next === progress) return;
        progress = next;
        hub.publish(turnId, { type: 'progress', replyId, progress: next });
      };
      publishProgress({ kind: 'observed', phase: 'starting' });
      await runAgentReplyLifecycle({
        turnId, replyId, speakerOrdinal, agentPath,
        requestedProvider: speaker.provider,
        requestedModel: speaker.model,
        ...whenDefined(recorder, (recorder) => ({ recorder })),
        providerDeadlineMs,
        providerCleanupBudgetMs,
        ...whenDefined(params.signal, (signal) => ({ signal })),
        generate: (signal) => runSpeakerTurn({
          ...whenDefined(projection?.rootPath, (resourceRootPath) => ({ resourceRootPath })),
          speaker,
          fileContext,
          projectContext,
          documentContext,
          documentTools,
          documentSources: admittedDocuments,
          ...(admittedDocuments.length > 0 ? { documentReviewCacheDir: path.join(path.dirname(params.sessionStore.inputsDir(params.sessionId)), 'document-review') } : {}),
          folderContext,
          folderTools,
          history,
          // Every speaker, not only the front door. A follow-up the user
          // attached a result to means the same thing whoever they addressed
          // it to, and losing it by picking a specialist is the discontinuity
          // this contract exists to remove.
          ...whenDefined(params.continuationContext, (definedValue) => ({
            continuation: definedValue,
          })),
          latestUserText: params.text,
          sessionId: params.sessionId,
          turnId,
          ...whenDefined(mcpAssignmentId, (definedValue) => ({ mcpAssignmentId: definedValue })),
          ...whenDefined(mcpAssignmentPath, (definedValue) => ({ mcpAssignmentPath: definedValue })),
          ...whenDefined(mcpAgentToolService, (definedValue) => ({ mcpAgentToolService: definedValue })),
          signal,
          ...whenDefined(hub, (definedHub) => ({
            progressReporting: true,
            onProtocolEvent: (event: ProviderProtocolEvent) => {
              if (event.kind === 'progress' && event.progress) { publishProgress(event.progress); return; }
              if (event.kind !== "text" || !event.text) return;
              // Most providers report no activity events, so arriving text is the
              // observed evidence that the answer is being written.
              publishProgress({ kind: 'observed', phase: 'answering' });
              definedHub.publish(turnId, {
                type: "delta",
                replyId,
                channel: "text",
                text: event.text,
              });
            },
          })),
        }),
        prepare: async (result) => {
          // `result.fallback` is set for ANY caught provider error — network, auth,
          // a missing model. Almost all of those produced no answer at all, so they
          // close the bubble as an error. Truncation is the exception, and it is
          // recognised only from a typed provider code rather than inferred from
          // the failure text: the user has already read the partial answer, and
          // telling them nothing was produced would contradict what is on screen.
          //
          // Decided here but published after the message is written. Generating a
          // delivery and appending the message can both fail, and a bubble closes
          // exactly once: a terminal sent now could not be withdrawn, so the user
          // would be told their reply was finished and then find nothing in the
          // transcript.
          const terminal: AgentTextStreamInput = result.truncated
            ? { type: "final", replyId, reason: "truncated" }
            : result.fallback
              ? {
                  type: "error",
                  replyId,
                  message: result.reason ?? result.text,
                }
              : { type: "final", replyId, reason: "completed" };
          // Publication can fail on its own, and it happens before anything is
          // prepared, so its terminal names no reply.
          const delivery = await (async () =>
            mcpAssignmentId && !result.fallback && result.artifacts?.length
              ? {
                  taskId: mcpAssignmentId,
                  artifacts: result.artifacts.map((artifact) => ({
                    runId: mcpAssignmentId,
                    ...artifact,
                  })),
                }
              : mcpAssignmentId && mcpAssignmentPath && !result.fallback &&
                shouldPublishExcelDocument(speaker, params.text)
                ? await publishChatExcelDocument({
                    markdown: result.text,
                    assignmentId: mcpAssignmentId,
                    assignmentPath: mcpAssignmentPath,
                    turnId,
                    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
                  })
                : undefined)();
          const message = buildChatMessage("assistant", result.text, {
            id: plannedReply.assistantMessageId,
            schemaVersion: 2,
            conversationId: params.sessionId,
            kind: "chat",
            source: { kind: "conversation-turn", turnId },
            turnId,
            speaker: {
              type: speaker.type,
              id: speaker.id,
              name: speaker.name,
              ...(result.droppedProviderOptions?.length
                ? {
                    droppedProviderOptions: [...result.droppedProviderOptions],
                  }
                : {}),
            },
            ...(delivery ? { delivery } : {}),
            // A pointer to the evidence, not a copy of it. Without this the
            // transcript and the journal share no addressable identity.
            ...(assignmentId
              ? { execution: { runId: turnId, assignmentId } }
              : {}),
            // The sibling pointer, naming the turn-level publication rather than
            // this reply's own execution. Written only where the activity exists:
            // a pointer is followed, and one naming an activity nobody recorded
            // sends every reader to evidence that was never created.
            ...(conversationRecorder
              ? {
                  conversation: {
                    conversationId: params.sessionId,
                    activityId: turnId,
                    turnId,
                  },
                }
              : {}),
          });
          return {
            kind: "publish" as const,
            assistantMessageId: message.id,
            text: result.text,
            value: { message, result, terminal },
            persist: async () => {
              await appendTurnMessage({
                sessionStore: params.sessionStore,
                sessionId: params.sessionId,
                message,
              });
              // The moment the fact becomes true, and nothing later may take it
              // back. The two journals fail independently: recording this after
              // the assignment's own terminal made a lost `agent.turn` terminal
              // erase a reply the transcript was already holding, and the turn
              // then ended by denying a message the user can still reload.
              durableReplyIds.push(message.id);
            },
          };
        },
        afterPublication: ({ message, result, terminal }) => {
          hub?.publish(turnId, terminal);
          pendingReplyId = undefined;
          replies.push(message);
          replyMeta.push({
            speakerId: speaker.id,
            speakerName: speaker.name,
            model: result.model,
            fallback: result.fallback,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.mcp ? { mcp: result.mcp } : {}),
            ...(result.droppedProviderOptions?.length
              ? { droppedProviderOptions: [...result.droppedProviderOptions] }
              : {}),
            // Folders reach a model only through the folder tools. A reply from
            // the plain call, the lane of models with no tools in chat, saw the
            // map and nothing inside it.
            ...(folderTools.length > 0 &&
            result.journal.outcome === "success" &&
            result.journal.route === "direct-provider"
              ? { folderToolsUnavailable: true }
              : {}),
          });
        },
      });
    }

    // Only now, with every reply the user will keep already durable. Recorded
    // before the title, because naming a session is a convenience laid over a
    // conversation and its outcome must not decide what the turn is said to
    // have published.
    if (conversationRecorder) {
      await conversationRecorder.recordCompleted({
        assistantMessageIds: claimedReplyIds,
      });
      conversationEnded = true;
    }

    // Everything from here to the title write is optional work laid over a
    // conversation that has already finished: every reply is durable and the
    // turn is recorded complete above. So the whole block is best-effort — the
    // reads it needs as much as the generation and the write. Without that, a
    // fault in naming a session rejected a request whose answer was already on
    // disk, and the caller got no replies at all.
    const titleTurn = await attemptSessionTitle(async () => {
    const history = await params.sessionStore.listChatMessages(params.sessionId);
    const titleContext = [fileContext, projectContext]
      .filter((value) => value.trim().length > 0 && value !== "(none)")
      .join("\n\n");
    // Naming a session is this server's own work and owns no Agent, so it runs
    // on the one application default (master §7 D1). It used to take the first
    // speaker's pair, and a bare pair carries no ownership: a named Agent's
    // pair is that Agent's decision rather than the title's, and a speaker that
    // inherited the default would have had the default reported as somebody's
    // own choice.
    //
    // The one exception is a model a person picked for this turn with no Agent
    // involved. That is the only thing anyone chose here, so titling keeps it
    // rather than discarding a real decision. Read from the speaker's own
    // recorded source, never inferred from the fact that a pair was resolved.
    const onlySpeaker = speakers.length === 1 ? speakers[0] : undefined;
    const adHocTitleChoice = onlySpeaker?.selection?.source === "user"
      ? { provider: onlySpeaker.provider, model: onlySpeaker.model }
      : undefined;
    const generated = await generateSessionTitle({
      session: params.session,
      history,
      ...whenDefined(titleContext || undefined, (context) => ({ context })),
      ...whenDefined(adHocTitleChoice, (choice) => choice),
      ...whenDefined(params.signal, (signal) => ({ signal })),
      // Recorded before the send, and owned by the turn that caused it. A
      // session that cannot take the record declines the call rather than
      // letting a model name it with nothing to say so.
      onSelected: (selection) =>
        params.sessionStore.appendSessionTitleAttempt(params.sessionId, {
          operation: requestedAgents.length > 0 ? "selected-agent-chat" : "session-chat",
          owner: turnId,
          attemptId: crypto.randomUUID(),
          selection,
          at: new Date().toISOString(),
        }),
    });
    const updatedSession = generated.title
      ? await params.sessionStore.updateSessionTitle(
          params.sessionId,
          generated.title,
        )
      : null;
    return { generated, updatedSession };
    });

    // The session as it stands, whatever titling did. A failed or unusable
    // title still made an attempt, and that attempt is recorded — returning no
    // session at all would leave the page with no account of a model that was
    // really about to be used, which is the whole point of recording it. Read
    // best-effort for the same reason the block above is.
    const session = titleTurn?.updatedSession
      ?? (await attemptSessionTitle(() =>
        params.sessionStore.getSession(params.sessionId),
      ));

    return {
      user: persistedUserMessage,
      replies,
      ...(session ? { session } : {}),
      ...whenDefined(workflowLaunch.current, (outcome) => ({
        task: outcome.task,
        plan: outcome.plan,
      })),
      meta: {
        replies: replyMeta,
        titleModel: titleTurn?.generated.model ?? "",
        titleFallback: titleTurn?.generated.fallback ?? true,
        // A reason only where there is one. Reporting a failure beside a title
        // that worked tells a reader two contradictory things about one turn;
        // the block below supplies one only when titling did not complete.
        ...whenDefined(
          titleTurn
            ? titleTurn.generated.reason
            : "the session could not be titled",
          (titleReason) => ({ titleReason }),
        ),
      },
    };
  } catch (error) {
    reportedFailure = { cause: error };
    // Whether this turn's ending is its own to record is decided by how far it
    // got. The process is alive and it saw the failure, so recording the
    // outcome closes the window instead of leaving a `started` that every later
    // reader has to guess about.
    if (conversationRecorder && conversationStarted && !conversationEnded) {
      await recordConversationTurnEnding({
        recorder: conversationRecorder,
        cause: error,
        aborted: params.signal?.aborted === true,
        claimedReplyIds: conversationPrepared ? claimedReplyIds : undefined,
        durableReplyIds,
      });
    }
    // Resolving the journal created the activity, and the turn may fail before
    // it ever reaches its start barrier. `abandon` scans first and gives back
    // only what is provably empty, so a journal that recorded anything at all
    // — including a `started` whose outcome nobody can prove — is kept.
    if (!conversationStarted) {
      await withoutMaskingCause(
        error,
        () => conversationRecorder?.abandon(),
        "conversation activity not abandoned",
      );
    }
    throw error;
  } finally {
    activeTurn.release();
    // The lease is this request's, not the turn's: an operator read or a
    // reconciliation may hold the same activity, and only the last holder
    // closes it. Releasing twice is idempotent.
    //
    // A turn that is already failing keeps its own reason: the release is still
    // attempted and its fault reported, but it may not become the answer the
    // caller gets. A turn that succeeded has no reason to protect, so a lease
    // that cannot be given back is the only thing that went wrong and it
    // surfaces — the same rule the per-reply journal above follows.
    if (reportedFailure) {
      await withoutMaskingCause(
        reportedFailure.cause,
        () => conversationRecorder?.release(),
        "conversation journal lease not released",
      );
    } else {
      await conversationRecorder?.release();
    }
    // A reply that never reached its terminal has to get one. Closing the
    // channel alone would leave the reader watching text that stops mid-answer
    // with no account of why.
    if (pendingReplyId !== undefined) {
      hub?.publish(turnId, {
        type: "error",
        replyId: pendingReplyId,
        message: "This reply did not complete.",
      });
    }
    // Closes on every exit, including a throw between reservation and
    // generation, so a failed turn never strands its channel until TTL.
    if (channelOpen) hub?.closeChannel(turnId);
  }
}

/**
 * One reply this turn will publish, settled before any of it is produced.
 *
 * The aggregate has to name every reply and every assignment before the first
 * provider request, so the identities cannot be minted as the loop reaches
 * them. Deciding them all up front is what makes the turn record a claim a
 * crash can be checked against, rather than a summary written afterwards.
 */
interface PlannedReply {
  readonly speaker: ChatSpeaker;
  readonly speakerOrdinal: number;
  /** This reply's stream channel identity; not a message id. */
  readonly replyId: string;
  readonly assistantMessageId: string;
  /** Absent for a speaker that runs in process and has no assignment. */
  readonly assignmentId?: string;
  readonly assignmentPath?: string;
}

/**
 * The assignment links this turn claims, or nothing when it claims none.
 *
 * A turn answered entirely by the generic in-process assistant has no
 * assignment to link, and an empty list would say something different — that
 * links were expected and none were found.
 */
function assignmentLinksOf(
  planned: readonly PlannedReply[],
): readonly { assignmentId: string; assistantMessageId: string }[] | undefined {
  const links = planned.flatMap((reply) =>
    reply.assignmentId === undefined
      ? []
      : [
          {
            assignmentId: reply.assignmentId,
            assistantMessageId: reply.assistantMessageId,
          },
        ],
  );
  return links.length > 0 ? links : undefined;
}

/**
 * Write one line of this turn, failing closed on anything but a durable write.
 *
 * `appendChatMessage` is a bare append: no uniqueness check, no flush, and no
 * validation. These lines declare transcript version 2, and the reader refuses
 * a version-2 line it cannot understand whole — so a bare append could report
 * success for a line that vanishes on the next reload, which is the one
 * outcome a durability barrier must never allow.
 */
async function appendTurnMessage(input: {
  sessionStore: SessionStore;
  sessionId: string;
  message: ChatMessage;
}): Promise<void> {
  const written = await input.sessionStore.appendChatMessageIfAbsent(
    input.sessionId,
    input.message,
  );
  if (written === "appended" || written === "already-present") return;
  if (written === "unknown-session") {
    throw new ServiceError("not_found", "Session not found");
  }
  // `conflict` is this identity already holding different bytes;
  // `invalid-message` is a line no reader would return. Both mean the line the
  // caller is about to be told about is not on the transcript.
  throw new ServiceError(
    "internal",
    written === "conflict"
      ? "A different message is already stored under this turn identity"
      : "The chat message could not be stored",
  );
}

/**
 * End the aggregate for a turn that threw, in the terms of what it published.
 *
 * This record answers for publication, not for the request. A turn can fail
 * with every reply it claimed already on the transcript — the assignment's own
 * terminal is a separate journal that fails separately — and in that case the
 * publication really did finish. Saying otherwise would deny a message the
 * user can still reload, and leave the aggregate contradicting its own list of
 * durable replies.
 *
 * Never raises. The turn has already failed and its caller is about to see
 * why; a second fault raised while recording the first would replace the
 * reason with a note about the journal.
 */
async function recordConversationTurnEnding(input: {
  recorder: ConversationTurnJournalRecorder;
  cause: unknown;
  aborted: boolean;
  /** The replies preparation named, or absent when it never got that far. */
  claimedReplyIds?: readonly string[] | undefined;
  durableReplyIds: readonly string[];
}): Promise<void> {
  const claimed = input.claimedReplyIds;
  const published =
    claimed !== undefined &&
    claimed.length > 0 &&
    claimed.every((identity) => input.durableReplyIds.includes(identity));
  await withoutMaskingCause(
    input.cause,
    () =>
      published
        ? // Everything this turn claimed is durable, so the ending is the same
          // one the success path writes. It is the identical event, so a turn
          // that threw at its own completion records this idempotently rather
          // than a second, conflicting terminal.
          input.recorder.recordCompleted({ assistantMessageIds: claimed })
        : input.cause instanceof AgentChatProviderInterruptedError
          ? // Checked before the signal, because both endings can land on one
            // turn and only this one says what ended it. Nothing was published
            // because nothing was produced, so `reply_not_published` — which
            // says replies existed and did not reach the transcript — would be
            // a different fault in a different place.
            input.recorder.recordFailed({
              failure: { code: "provider_interrupted", phase: "provider" },
            })
          : input.aborted
            ? // The client went away first. That is the user's intent, and
              // recording it as a failure would misattribute the outcome.
              input.recorder.recordCancelled({
                phase: claimed === undefined ? "preparation" : "provider",
              })
          : input.recorder.recordFailed(
              claimed === undefined
                ? { failure: { code: "preparation_failed", phase: "preparation" } }
                : {
                    // Past preparation the honest reading is not "the turn
                    // failed" but "these replies were published and the rest
                    // were not" — which is the only reading that describes a
                    // multi-speaker turn that lost one of its speakers.
                    failure: {
                      code: "reply_not_published",
                      phase: "publication",
                    },
                    assistantMessageIds: input.durableReplyIds,
                  },
            ),
    "conversation turn terminal not recorded",
  );
}

async function runSpeakerTurn(input: AgentReplyRunInput): Promise<AgentReplyResult> {
  const result = await runAgentReply(input);
  return result.fallback || result.text.length > 0
    ? result
    : { ...result, text: "(No response.)" };
}

/**
 * Runs optional post-reply work, and answers `undefined` when it fails.
 *
 * Naming a session is a convenience laid over a conversation that has already
 * finished. A fault here — reading the history, resolving context, recording
 * the selection, or writing the title — must cost the title and nothing else,
 * because the answer the caller is waiting for is already durable and the turn
 * is already recorded as complete.
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

/**
 * A stable identity for the logical request behind a turn.
 *
 * `agentNames` order is preserved rather than sorted: `replyId` embeds the
 * speaker ordinal, so a reordered roster is a different request.
 */
function requestFingerprint(request: {
  text: string;
  agentNames: string[];
  provider?: string;
  model?: string;
  projectContext?: WorkspaceProjectContextSelection;
  contextResultIds?: readonly string[];
}): string {
  return hashCanonicalJson({
    text: request.text,
    agentNames: request.agentNames,
    provider: request.provider ?? null,
    model: request.model ?? null,
    projectContext: request.projectContext ?? null,
    // Spread only when present, so a turn stored before context existed hashes
    // the exact keys it always did and still replays.
    // Sorted for the hash only; attachment order is preserved elsewhere.
    ...(request.contextResultIds && request.contextResultIds.length > 0
      ? { contextResultIds: [...request.contextResultIds].sort() }
      : {}),
  }).value;
}

/**
 * Classify a turn that carries a client-minted id.
 *
 * The durable chat log is the authority here, not the in-memory hub: after a
 * restart or a channel eviction the hub is empty, and `appendChatMessage` has
 * no uniqueness check, so a replay would otherwise persist a second turn.
 *
 * Returns the response to send, or `undefined` when this is a new turn.
 */
async function classifyAgentChatReplay(input: {
  sessionId: string;
  sessionStore: SessionStore;
  turnId: string;
  fingerprint: string;
  hub?: AgentTextStreamHub;
  agentTurnJournal?: AgentTurnJournalResolver;
  conversationJournal?: ConversationTurnJournalResolver;
}): Promise<AgentChatTurnResult | undefined> {
  const history = await input.sessionStore.listChatMessages(input.sessionId);
  const user = history.find(
    (message) => message.role === "user" && message.turnId === input.turnId,
  );

  if (!user) {
    // Nothing persisted yet. A duplicate can still be racing the first request
    // between `openChannel` and the user-message append.
    if (input.hub?.isOpen(input.turnId)) {
      throw new ServiceError("conflict", "turn_in_flight");
    }
    return undefined;
  }

  if (!user.turnRequest) {
    // Written before turns recorded their request. It cannot be verified, and
    // returning an unverified prior answer is worse than refusing.
    throw new ServiceError("conflict", "turn_id_unverifiable");
  }
  if (user.turnRequest.fingerprint !== input.fingerprint) {
    throw new ServiceError("conflict", "turn_id_reused");
  }

  const replies = history.filter(
    (message) => message.role === "assistant" && message.turnId === input.turnId,
  );
  const expected = user.turnRequest.expectedReplies;

  if (replies.length > expected) {
    // The log disagrees with the recorded request. Refusing is the only safe
    // answer; falling through would classify a corrupt turn as a clean replay.
    throw new ServiceError("conflict", "turn_corrupt");
  }
  // The user message is persisted before generation begins, so a healthy
  // in-flight turn looks exactly like a crashed one in the log for its whole
  // duration. Only the hub can tell them apart — and it has to be asked before
  // anything reconciles, because a turn still running owns its own journal.
  const incomplete = replies.length < expected;
  if (incomplete && input.hub?.isOpen(input.turnId)) {
    throw new ServiceError("conflict", "turn_in_flight");
  }

  // Every reply that is durable, whether or not the roster finished. A
  // multi-speaker turn that lost its first terminal and then died would
  // otherwise stay `reply_pending` on that assignment through every retry,
  // because the roster it belongs to can never complete.
  await reconcileAgentTurnTerminals({
    sessionId: input.sessionId,
    replies,
    turnId: input.turnId,
    ...whenDefined(input.agentTurnJournal, (agentTurnJournal) => ({
      agentTurnJournal,
    })),
  });

  // And the turn above them. The window between the last reply reaching the
  // transcript and the aggregate terminal being appended is real, and a crash
  // inside it leaves a turn every later reader sees as still publishing.
  //
  // Resolved here rather than for every request: a turn that is not a replay
  // never reaches this line, and opening its activity to discover there was
  // nothing to reconcile would make every new turn pay for the rare one.
  if (input.conversationJournal) {
    const recorder = await input.conversationJournal({
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
    if (recorder) {
      // The same rule the per-reply reconciliation below follows: the lease is
      // handed back on every path, and on the failing one its own fault is
      // reported rather than becoming the answer. A caller told the lease stuck
      // would never learn that the aggregate could not be reconciled.
      let reconciliationFailure: { readonly cause: unknown } | undefined;
      try {
        await reconcileConversationTurnTerminal({ recorder, replies });
      } catch (error) {
        reconciliationFailure = { cause: error };
        throw error;
      } finally {
        if (reconciliationFailure) {
          await withoutMaskingCause(
            reconciliationFailure.cause,
            () => recorder.release(),
            "conversation journal lease not released",
          );
        } else {
          await recorder.release();
        }
      }
    }
  }

  // A launch this turn admitted is part of the answer its replay owes. The
  // task committed the turn's identity at admission for exactly this lookup:
  // recovering it and its plan is a store read, and a retry must neither
  // relaunch nor answer as if nothing started — including when the reply
  // itself was lost after admission (the incomplete window above).
  const launchedTask = (
    await input.sessionStore.listTaskRecords(input.sessionId)
  ).find(
    (task) =>
      task.sourceTurn?.turnId === input.turnId &&
      task.sourceTurn.fingerprint === input.fingerprint,
  );
  const launchedPlan = launchedTask
    ? await input.sessionStore.getRunPlan(input.sessionId)
    : null;

  return {
    user,
    replies,
    replayed: true,
    ...(incomplete ? { incomplete: true } : {}),
    ...whenDefined(launchedTask, (task) => ({ task })),
    ...(launchedTask && launchedPlan && launchedPlan.id === launchedTask.runPlanId
      ? { plan: launchedPlan }
      : {}),
    meta: { replies: [] },
  };
}

/**
 * Finish a turn whose reply was stored but whose terminal never landed.
 *
 * The window between persisting the assistant message and appending the
 * terminal is real, and a crash inside it leaves a turn an operator reads as
 * `reply_pending` forever. A retry carrying the same `turnId` already replays
 * the stored reply; this closes its journal from the durable `prepared`
 * metadata, without asking the provider anything.
 *
 * The message must actually exist for the reconciliation to run. Anything else
 * is left alone: claiming a completion for a reply nobody can find would turn
 * an honest unresolved state into a false one.
 */
async function reconcileAgentTurnTerminals(input: {
  sessionId: string;
  replies: readonly ChatMessage[];
  turnId: string;
  agentTurnJournal?: AgentTurnJournalResolver;
}): Promise<void> {
  const resolve = input.agentTurnJournal;
  if (!resolve) return;
  for (const reply of input.replies) {
    const execution = reply.execution;
    if (!execution || execution.runId !== input.turnId) continue;
    const recorder = await resolve({
      scope: {
        sessionId: input.sessionId,
        runId: execution.runId,
        assignmentId: execution.assignmentId,
      },
      agentPath: `agents/${reply.speaker?.id ?? "unknown"}`,
    });
    if (!recorder) continue;
    // Reconciliation borrows the journal exactly as a turn does, so it has to
    // hand it back on every path — including the one where it decides there is
    // nothing to reconcile.
    let reconciliationFailure: { readonly cause: unknown } | undefined;
    try {
      const summary = await recorder.readSummary();
      if (
        summary?.state !== "reply_pending" ||
        summary.assistantMessageId !== reply.id ||
        summary.route === undefined ||
        summary.outcome === undefined
      ) {
        continue;
      }
      if (summary.failureAtPreparation) {
        await recorder.recordFailed({
          turnId: input.turnId,
          replyId: summary.replyId,
          assistantMessageId: reply.id,
          route: summary.route,
          failure: summary.failureAtPreparation,
        });
        continue;
      }
      await recorder.recordCompleted({
        turnId: input.turnId,
        replyId: summary.replyId,
        assistantMessageId: reply.id,
        route: summary.route,
      });
    } catch (error) {
      reconciliationFailure = { cause: error };
      throw error;
    } finally {
      if (reconciliationFailure) {
        await withoutMaskingCause(
          reconciliationFailure.cause,
          () => recorder.release(),
          "journal lease not released",
        );
      } else {
        await recorder.release();
      }
    }
  }
}

/**
 * Close an aggregate whose replies are all durable but whose terminal was lost.
 *
 * Only on proof. The claimed replies have to be on the transcript, in the
 * identities preparation named — a completion recorded for a turn still missing
 * one of them would turn an honest unresolved state into a false one, and the
 * unresolved state is exactly what tells an operator where to look.
 */
async function reconcileConversationTurnTerminal(input: {
  recorder: ConversationTurnJournalRecorder;
  replies: readonly ChatMessage[];
}): Promise<void> {
  // Not caught. A read that failed says nothing about whether this turn needs
  // closing, and treating it as "nothing to do" let a replay report success for
  // a reconciliation that never happened — the one thing the caller could not
  // find out for themselves. The per-reply reconciliation propagates the same
  // fault for the same reason.
  const summary = await input.recorder.readSummary();
  if (summary.state !== "prepared") return;
  const durable = new Set(input.replies.map((reply) => reply.id));
  if (!summary.assistantMessageIds.every((identity) => durable.has(identity))) {
    return;
  }
  await input.recorder.recordCompleted({
    assistantMessageIds: summary.assistantMessageIds,
  });
}

export function ensureAgentChatRepoRoot(repoRootPath: string | undefined): string {
  if (!repoRootPath) {
    throw new ServiceError("internal",
      "Agent chat requires repoRootPath to be configured"
    );
  }
  const agentsDir = path.join(repoRootPath, "agents");
  if (!fs.existsSync(agentsDir)) {
    throw new ServiceError("bad_request", "No agents directory is configured");
  }
  return repoRootPath;
}
