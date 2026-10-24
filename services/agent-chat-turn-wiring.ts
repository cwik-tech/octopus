/**
 * The collaborators every agent chat turn needs, built once.
 *
 * An agent chat turn is started from more than one place: the ordinary message
 * dispatch, and a user-approved retry on the application default. Each of them
 * assembling its own option bag is how one of them ends up without journals,
 * without tool support, or without a cancellation signal — which is exactly
 * what happened to the approved retry. Building the bag here means a turn is
 * wired the same way whoever starts it.
 */

import { whenDefined } from "../core/optional-properties.js";
import type { AgentTextStreamHub } from "../domains/runtime/agent-text-stream-hub.js";
import type { McpAgentToolService } from "./mcp-agent-tool-service.js";
import type { AgentDialogueService } from './agent-dialogue-service.js';
import type { SharedFolderService } from "./shared-folder-service.js";
import type { WorkspaceConversationJournalRegistry } from "./workspace-conversation-journal-registry.js";
import type { WorkspaceExecutionJournalRegistry } from "./workspace-execution-journal-registry.js";
import type { RunPlanTaskQueue } from "./run-orchestrator-service.js";
import type { WorkflowMcpPreflightService } from "./workflow-mcp-preflight-service.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import { createDeliveryArtifactReader } from "./delivery-context.js";
import {
  resolveAgentTurnJournalRecorder,
  type AgentTurnJournalEventObserver,
} from "./agent-turn-journal-recorder.js";
import { resolveConversationTurnJournalRecorder } from "./conversation-turn-journal-recorder.js";
import type { runSessionAgentChatTurn } from "./agent-chat-service.js";
import type { FileParserLauncher } from '../core/file-parser-launcher.js';
import type { ResourceLibraryService } from './resource-library-service.js';

type TurnParams = Parameters<typeof runSessionAgentChatTurn>[0];

/** Everything a turn needs that is not about *this* turn's content. */
export type AgentChatTurnWiring = Pick<
  TurnParams,
  | "workspaceProjectService"
  | "workspaceProjectContextStore"
  | "mcpAgentToolService"
  | "agentDialogueService"
  | "fileParserLauncher"
  | "sharedFolderService"
  | "agentTurnJournal"
  | "conversationJournal"
  | "textStreamHub"
  | "readDeliveryArtifact"
  | "resolveConnectionKind"
  | "taskQueue"
  | "workspacePath"
  | "workflowsRegistryPath"
  | "mcpWorkflowPreflightService"
  | "resourceLibraryService"
>;

export interface AgentChatTurnWiringSources {
  readonly resourceLibraryService?: ResourceLibraryService | undefined;
  readonly fileParserLauncher?: FileParserLauncher | undefined;
  readonly workspacePath?: string | undefined;
  readonly workflowsRegistryPath?: string | undefined;
  readonly workspaceProjectService?: WorkspaceProjectService | undefined;
  readonly workspaceProjectContextStore?:
    | WorkspaceProjectContextStore
    | undefined;
  readonly mcpAgentToolService?: McpAgentToolService | undefined;
  readonly agentDialogueService?: Pick<AgentDialogueService, 'start'> | undefined;
  /**
   * Admission behind the front door's `start_workflow` tool, wired here for
   * the same reason everything else is: a turn started from the retry path
   * must not quietly lack the ability the original turn had.
   */
  readonly taskQueue?: RunPlanTaskQueue | undefined;
  /**
   * The capability check every other launch route performs. Without it the
   * chat route would admit a Workflow whose required tools are missing.
   */
  readonly mcpWorkflowPreflightService?:
    | Pick<WorkflowMcpPreflightService, "resolve">
    | undefined;
  /** Resolves each turn's attached folders; absent where folder access is off. */
  readonly sharedFolderService?: SharedFolderService | undefined;
  readonly agentTextStreamHub?: AgentTextStreamHub | undefined;
  readonly conversationJournalRegistry?:
    | WorkspaceConversationJournalRegistry
    | undefined;
  readonly executionJournalRegistry?:
    | WorkspaceExecutionJournalRegistry
    | undefined;
  /**
   * Derives provider health from what each turn records. Never authoritative,
   * and wired here for the same reason everything else is: a turn started from
   * the retry path must not quietly lack it.
   */
  readonly providerFailureHealth?: AgentTurnJournalEventObserver | undefined;
  /**
   * What kind of connection a `connection:<id>` provider routes to.
   *
   * Wired here rather than looked up inside the turn: connection settings live
   * a layer above the dispatch. Without it every connection-routed speaker is
   * budgeted against the generic window instead of its own, which for a local
   * model is roughly four times too much.
   */
  readonly resolveConnectionKind?:
    | ((provider: string) => string | undefined)
    | undefined;
}

export function agentChatTurnWiring(
  sources: AgentChatTurnWiringSources,
): AgentChatTurnWiring {
  return {
    ...whenDefined(sources.resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
    ...whenDefined(sources.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
    ...whenDefined(sources.resolveConnectionKind, (resolveConnectionKind) => ({
      resolveConnectionKind,
    })),
    ...whenDefined(sources.workspaceProjectService, (service) => ({
      workspaceProjectService: service,
    })),
    ...whenDefined(sources.workspaceProjectContextStore, (store) => ({
      workspaceProjectContextStore: store,
    })),
    ...whenDefined(sources.mcpAgentToolService, (service) => ({
      mcpAgentToolService: service,
    })),
    ...whenDefined(sources.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
    ...whenDefined(sources.taskQueue, (taskQueue) => ({ taskQueue })),
    ...whenDefined(sources.workspacePath, (workspacePath) => ({ workspacePath })),
    ...whenDefined(sources.mcpWorkflowPreflightService, (mcpWorkflowPreflightService) => ({
      mcpWorkflowPreflightService,
    })),
    ...whenDefined(sources.agentDialogueService, (service) => ({ agentDialogueService: service })),
    ...whenDefined(sources.sharedFolderService, (service) => ({
      sharedFolderService: service,
    })),
    ...whenDefined(sources.executionJournalRegistry, (registry) => ({
      agentTurnJournal: (input: {
        readonly scope: {
          readonly sessionId: string;
          readonly runId: string;
          readonly assignmentId: string;
        };
        readonly agentPath: string;
        readonly signal?: AbortSignal;
      }) =>
        resolveAgentTurnJournalRecorder({
          registry,
          scope: input.scope,
          agentPath: input.agentPath,
          requestId: `agent-chat-${input.scope.assignmentId}`,
          processIdentity: input.scope.runId,
          ...whenDefined(sources.providerFailureHealth, (observer) => ({
            observer,
          })),
          ...whenDefined(input.signal, (signal) => ({ signal })),
        }),
    })),
    ...whenDefined(sources.conversationJournalRegistry, (registry) => ({
      conversationJournal: (input: {
        readonly sessionId: string;
        readonly turnId: string;
      }) =>
        resolveConversationTurnJournalRecorder({
          registry,
          owner: {
            kind: "run-session",
            conversationId: input.sessionId,
            sessionId: input.sessionId,
          },
          turnId: input.turnId,
          ...whenDefined(sources.workspacePath, (workspacePath) => ({
            workspacePath,
          })),
        }),
    })),
    ...whenDefined(sources.agentTextStreamHub, (hub) => ({
      textStreamHub: hub,
    })),
    ...whenDefined(
      sources.workspacePath
        ? createDeliveryArtifactReader(sources.workspacePath)
        : undefined,
      (readDeliveryArtifact) => ({ readDeliveryArtifact }),
    ),
  };
}
