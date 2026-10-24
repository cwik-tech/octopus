import type { BrowserManager } from "../domains/browser/browser-manager.js";
import type { FileParserLauncher } from "../core/file-parser-launcher.js";
import type { McpProviderSupportResolver } from "../domains/mcp/mcp-provider-support.js";
import type { RunLauncher } from "../domains/run/run-launcher.js";
import type { RunStore } from "../domains/run/run-store.js";
import type { DeepResearchPlanRunner } from "../services/deep-research-plan-service.js";
import type { DeepResearchSettingsService } from "../services/deep-research-settings-service.js";
import type { AgentTextStreamHub } from "../domains/runtime/agent-text-stream-hub.js";
import type { AgentTextDeltaTokenRegistry } from "../domains/runtime/agent-text-delta-tokens.js";
import type { McpAgentToolService } from "../services/mcp-agent-tool-service.js";
import type { McpInteractionService } from "../services/mcp-interaction-service.js";
import type { McpResourceImportService } from "../services/mcp-resource-import-service.js";
import type { McpSettingsService } from "../services/mcp-settings-service.js";
import type { ProviderSettingsService } from "../services/provider-settings-service.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import type { WorkspaceProjectFileCatalogService } from "../services/project-file-catalog-service.js";
import type { WorkspaceProjectMemoryService } from "../services/project-memory-service.js";
import type { WorkspaceProjectExportService } from "../services/project-export-service.js";
import type { WorkspaceProjectDetailsService } from "../services/project-details-service.js";
import type { TeamFileStore } from "../domains/team-files/team-file-store.js";
import type { BatchFolderAccessPolicy } from '../domains/batches/batch-folder-access.js'
import type { BatchFolderGrantStore } from '../domains/batches/batch-folder-grant-store.js'
import type { ToolModuleOptions } from "./tools/tool-registry.js";
import type { AgentDialogueClock } from '../services/agent-dialogue-service.js'
import type { VoiceControlOptions } from './voice-control/voice-control-runtime.js'

export interface StartedApiServer {
  host: string;
  port: number;
  close(): Promise<void>;
  url: string;
}

export interface ApiServerOptions {
  agentDialogueClock?: AgentDialogueClock;
  apiToken?: string;
  /**
   * Optional second credential whose only authority is POST
   * /settings/provider-execute. Handed to untrusted provider CLI children so
   * they can reach the credential broker without holding the master apiToken.
   */
  brokerToken?: string;
  store: RunStore;
  launcher: RunLauncher;
  taskLauncher?: RunLauncher;
  fileParserLauncher?: FileParserLauncher;
  sessionStore?: SessionStore;
  workspaceProjectService?: WorkspaceProjectService;
  workspaceProjectContextStore?: WorkspaceProjectContextStore;
  workspaceProjectFileCatalogService?: WorkspaceProjectFileCatalogService;
  workspaceProjectMemoryService?: WorkspaceProjectMemoryService;
  workspaceProjectExportService?: WorkspaceProjectExportService;
  workspaceProjectDetailsService?: WorkspaceProjectDetailsService;
  recoverInterruptedTasks?: boolean;
  onListening?: (server: Pick<StartedApiServer, "host" | "port" | "url"> & {
    /** Broker-scoped URL for POST /settings/provider-execute (set when brokerToken is configured). */
    brokerUrl?: string;
  }) => void | Promise<void>;
  teamFileStore?: TeamFileStore;
  workflowsRegistryPath?: string;
  repoRootPath?: string;
  resourceLibraryRootPath?: string;
  requireResourceLibraryMigrationApproval?: boolean;
  builtinResourceRootPath?: string;
  host?: string;
  port?: number;
  /**
   * How long graceful shutdown gives in-flight work to finish, in
   * milliseconds (AC18). One window: the drain and the composition disposal
   * underneath it share the same absolute deadline.
   */
  shutdownDeadlineMs?: number;
  eventPollIntervalMs?: number;
  deepResearchPlanningHeartbeatMs?: number;
  /**
   * How long a stream GET waits for its channel to be opened by the matching
   * POST. Injectable so tests can prove the bounded deadline without waiting
   * out the production value.
   */
  agentTextStreamWaitMs?: number;
  workspacePath?: string;
  providerSettingsService?: ProviderSettingsService;
  mcpProviderSupportResolver?: McpProviderSupportResolver;
  mcpSettingsService?: McpSettingsService;
  mcpAgentToolService?: McpAgentToolService;
  /**
   * Supply the ephemeral text-stream hub. Injected like the other services so a
   * test can observe waiter lifecycle directly instead of the server growing a
   * diagnostics endpoint that exists only for tests.
   */
  agentTextStreamHub?: AgentTextStreamHub;
  /**
   * Credentials for run children posting display frames. Absent means the
   * ingest endpoint does not exist at all, not that it is open.
   */
  agentTextStreamDeltaTokens?: AgentTextDeltaTokenRegistry;
  mcpResourceImportService?: McpResourceImportService;
  mcpInteractionService?: McpInteractionService;
  browserManager?: BrowserManager;
  browserProfilePath?: string;
  toolModuleOptions?: ToolModuleOptions;
  deepResearchSettingsService?: DeepResearchSettingsService;
  deepResearchPlanRunner?: DeepResearchPlanRunner;
  batchFolderAccessPolicy?: BatchFolderAccessPolicy;
  batchFolderGrantStore?: BatchFolderGrantStore;
  /**
   * Grants for folders shared with agents, one per folder picked in the native
   * dialog. Separate from the Batch grants so one feature's picks never widen
   * what the other admits. Without it, no folder can be shared.
   */
  sharedFolderGrantStore?: BatchFolderGrantStore;
  /**
   * The desktop app's data folder (Electron `userData`). Shared folders may not
   * overlap it or the workspace (docs/feature-local-folder-access.md, SEC-3).
   */
  appDataPath?: string;
  /**
   * Serves Octopus's tools to outside apps such as a voice layer on
   * `/_pipeline-mcp`, under their own token, and advertises them in the
   * discovery folder (docs/feature-voice-control-mcp.md). Absent means the
   * path does not exist.
   */
  voiceControl?: VoiceControlOptions;
}
