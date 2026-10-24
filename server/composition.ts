import { YoutubeSettingsService } from '../services/youtube-settings-service.js'
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { whenDefined } from "../core/optional-properties.js";
import type { RouteCredentialScope } from "../contracts/route-credentials.js";
import type { CapabilityAssignmentScope } from "../contracts/capability-dispatch.js";

import { CreateJobRegistry } from "./create-job-registry.js";
import { TurnMetricStore } from "./turn-metric-store.js";
import { ResourceArchitectStore } from "./resource-architect-store.js";
import type { ApiServerOptions } from "./api-types.js";
import type { SchedulingQueueRouteRuntime } from "./routes/scheduling-queue.js";
import type { SchedulingSettingsRouteRuntime } from "./routes/scheduling-settings.js";
import {
  buildToolRegistry,
  providerAgentTools,
  type RegisteredToolContribution,
} from "./tools/tool-registry.js";
import { BrowserManager } from "../domains/browser/browser-manager.js";
import { McpEvidenceStore } from "../domains/mcp/mcp-evidence-store.js";
import { McpParentBroker } from "../domains/mcp/mcp-parent-broker.js";
import { createMcpProviderSupportResolver } from "../domains/mcp/mcp-provider-support.js";
import { McpRunLeaseStore } from "../domains/mcp/mcp-run-lease-store.js";
import { McpWorkerTurnRunLauncher } from "../domains/mcp/mcp-worker-turn-launcher.js";
import { DEEP_RESEARCH_SETTINGS_RELATIVE_PATH } from "../domains/deep-research/deep-research-settings.js";
import {
  MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE,
  parseMaximumConcurrentTasksEnvironmentValue,
  SCHEDULING_SETTINGS_RELATIVE_PATH,
} from "../domains/scheduling/scheduling-settings.js";
import { SCHEDULES_RELATIVE_PATH } from "../domains/scheduling/schedule-types.js";
import { SessionTaskRunnerLauncher } from "../domains/sessions/session-task-launcher.js";
import { WorkspaceProjectMembershipStore } from "../domains/projects/project-membership-store.js";
import { WorkspaceProjectMemoryStore } from "../domains/projects/project-memory-store.js";
import { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import { WorkspaceProjectStore } from "../domains/projects/project-store.js";
import { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import { WorkspaceProjectFileCatalogService } from "../services/project-file-catalog-service.js";
import { WorkspaceProjectMemoryService } from "../services/project-memory-service.js";
import { WorkspaceProjectDetailsService } from "../services/project-details-service.js";
import { WorkspaceProjectExportService } from "../services/project-export-service.js";
import { ResourceLibraryService } from "../services/resource-library-service.js";
import { DeepResearchSettingsService } from "../services/deep-research-settings-service.js";
import { McpAgentGrantsService } from "../services/mcp-agent-grants-service.js";
import { McpAgentToolService } from "../services/mcp-agent-tool-service.js";
import { MAX_CONCURRENT_TOOL_CALLS_CEILING } from "../domains/provider/provider-tool-loop.js";
import { McpInteractionService } from "../services/mcp-interaction-service.js";
import { McpResourceImportService } from "../services/mcp-resource-import-service.js";
import { McpSettingsService } from "../services/mcp-settings-service.js";
import { McpWorkerTurnService } from "../services/mcp-worker-turn-service.js";
import { RuntimeCapabilityAuthorityResolver } from "../services/runtime-capability-authority.js";
import { CapabilityDispatchRuntime } from "../services/capability-dispatch-runtime.js";
import { CapabilityDispatchLifecycleCoordinator } from "../services/capability-dispatch-lifecycle.js";
import {
  ExecutionJournalInspectionService,
  type ExecutionJournalAuthorizationRequest,
} from "../services/execution-journal-inspection.js";
import {
  resolveExecutionJournalOptions,
  WorkspaceExecutionJournalRegistry,
} from "../services/workspace-execution-journal-registry.js";
import { ProviderFailureHealthService } from "../services/provider-failure-health-service.js";
import { startWorkspaceExecutionJournal } from "../services/execution-journal-tenant-pin.js";
import { WorkspaceConversationJournalRegistry } from "../services/workspace-conversation-journal-registry.js";
import { ConversationJournalInspectionService } from "../services/conversation-journal-inspection.js";
import { logProcessWarning } from "../domains/runtime/logger.js";
import {
  parseWebEvidenceRolloutConfig,
  WEB_EVIDENCE_CLAIM_COHORTS_ENV,
  WEB_EVIDENCE_CLAIMS_MODE_ENV,
  WEB_EVIDENCE_CLAIMS_PERCENT_ENV,
  WEB_EVIDENCE_LINKS_MODE_ENV,
  WEB_EVIDENCE_LINKS_PERCENT_ENV,
  webEvidenceRolloutRequiresRecorder,
  WebEvidenceRolloutConfigurationError,
} from "../domains/browser/web-evidence-rollout.js";
import { resolveWebEvidenceValidationRecorder } from "../services/web-evidence-validation-recorder.js";
import { ProviderSettingsService } from "../services/provider-settings-service.js";
import {
  hasProjectScheduleReferenceInFile,
  ScheduleService,
} from "../services/schedule-service.js";
import { createScheduledAgentTargetResolver } from "../services/scheduled-agent-target.js";
import { SchedulingSettingsService } from "../services/scheduling-settings-service.js";
import { TaskQueue } from "../services/task-queue.js";
import { WorkflowMcpPreflightService } from "../services/workflow-mcp-preflight-service.js";
import { McpResourceClientService } from "../domains/mcp/mcp-resource-client-service.js";
import { McpResourceImportStore } from "../domains/mcp/mcp-resource-import-store.js";
import { WorkspaceDispatcherOwner } from "../core/workspace-dispatcher-owner.js";
import { DefaultBatchFolderAccessPolicy } from '../domains/batches/batch-folder-access.js'
import type { BatchFolderGrantStore } from '../domains/batches/batch-folder-grant-store.js'
import { SharedFolderAccessPolicy } from '../domains/shared-folders/shared-folder-access-policy.js'
import { SharedFolderStore } from '../domains/shared-folders/shared-folder-store.js'
import { SharedFolderService } from '../services/shared-folder-service.js'
import { BatchStore } from '../domains/batches/batch-store.js'
import { BatchArtifactWriter } from '../services/batch-artifact-writer.js'
import {
  BatchAdmissionCoordinator,
  prepareBatchItem,
} from '../services/batch-admission-coordinator.js'
import { BatchService, hasProjectBatchReferenceInFile } from '../services/batch-service.js'
import { cancelSessionTask } from '../services/task-service.js'
import { validateWorkflowForLaunch } from '../services/run-orchestrator-service.js'
import { listWorkflowEntries } from '../services/workflow-service.js'
import { AgentTextStreamHub } from "../domains/runtime/agent-text-stream-hub.js";
import { AgentDialogueService } from '../services/agent-dialogue-service.js'
import { createVoiceLayerLink } from './voice-control/voice-layer-link.js'
import {
  createVoiceControlRuntime,
  type VoiceControlRuntime,
} from "./voice-control/voice-control-runtime.js";
import {
  AgentTextDeltaEndpoint,
  AgentTextDeltaTokenRegistry,
} from "../domains/runtime/agent-text-delta-tokens.js";
import {
  createAgentTextStreamLaunchRuntime,
  type AgentTextStreamLaunchPort,
} from "../domains/runtime/agent-text-delta-launch.js";

const PENDING_CREATE_CANCEL_TTL_MS = 60_000;

export interface ServiceActivationContext {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly publicUrl: string;
  readonly brokerUrl?: string;
}

export interface LifecycleAction<Context = void> {
  readonly name: string;
  readonly run: (context: Context) => void | Promise<void>;
}

export interface LifecycleResource {
  readonly name: string;
  /**
   * `deadlineMs` is the *absolute* end of the shutdown window this disposal
   * belongs to (AC18). Resources that drain work honour it; the rest ignore
   * it. Passing it through rather than letting each resource start its own
   * window is what keeps one configured shutdown from becoming several in
   * series.
   */
  readonly dispose: (options?: {
    readonly deadlineMs?: number;
  }) => void | Promise<void>;
}

/**
 * The capability runtime and its journal registry, disposed as one unit
 * (AC18).
 *
 * They are not independent resources at shutdown. Runtime shutdown records an
 * explicit decision for every attempt still unsettled at the deadline, and
 * `disposeResources` deliberately continues past a failure so unrelated
 * cleanup still runs — so as separate entries the registry would be closed
 * immediately after a failed finalization was caught, closing a stream with
 * no decision in it. Bound together, the registry closes only once the
 * runtime's shutdown has actually succeeded.
 */
export function createRuntimeJournalOwnership(input: {
  readonly runtime: {
    close(options?: { readonly deadlineMs?: number }): Promise<void>;
  };
  readonly registry: { close(): Promise<void> };
}): LifecycleResource {
  return {
    name: "capability-runtime-and-journals",
    dispose: async (options) => {
      await input.runtime.close(
        options?.deadlineMs === undefined
          ? undefined
          : { deadlineMs: options.deadlineMs },
      );
      await input.registry.close();
    },
  };
}

export interface CompositionLifecycle {
  start(): Promise<void>;
  activateAfterListen(context: ServiceActivationContext): Promise<void>;
  /** Bars new work at shutdown start, before anything is disposed (AC18). */
  beginShutdown(): void;
  dispose(options?: { readonly deadlineMs?: number }): Promise<void>;
}

export interface ServerServices {
  readonly agentDialogueService?: AgentDialogueService;
  readonly hasSessionTaskRuntime: boolean;
  readonly createJobRegistry: CreateJobRegistry;
  readonly resourceArchitectStore: ResourceArchitectStore;
  /** The Workflow Architect's own durable turn records, in its own directory. */
  readonly workflowArchitectTurnStore: TurnMetricStore;
  readonly providerSettingsService: ProviderSettingsService;
  readonly mcpSettingsService: McpSettingsService;
  readonly mcpInteractionService?: McpInteractionService;
  readonly mcpAgentGrantsService: McpAgentGrantsService | null;
  readonly mcpAgentToolService: McpAgentToolService;
  /** Ephemeral, display-only agent text stream. Holds no durable state. */
  readonly agentTextStreamHub: AgentTextStreamHub;
  readonly agentTextStreamDeltaTokens: AgentTextDeltaTokenRegistry;
  readonly agentTextStreamDeltaEndpoint: AgentTextDeltaEndpoint;
  readonly agentTextStreamLaunchPort: AgentTextStreamLaunchPort;
  readonly mcpResourceImportService?: McpResourceImportService;
  readonly mcpWorkerTurnService?: McpWorkerTurnService;
  readonly mcpWorkerTurnPath?: string;
  readonly capabilityDispatchRuntime?: CapabilityDispatchRuntime;
  /**
   * The one journal registry for this workspace. Exposed so every consumer in
   * this process shares it rather than opening a second authority.
   */
  readonly executionJournalRegistry?: WorkspaceExecutionJournalRegistry;
  /**
   * What runs have discovered about each provider, derived from the journal.
   * Read by both health endpoints so an exhausted key found mid-run reaches
   * the Run tab and the Create tab alike.
   */
  readonly providerFailureHealth?: ProviderFailureHealthService;
  readonly conversationJournalRegistry?: WorkspaceConversationJournalRegistry;
  /**
   * What kind of connection a `connection:<id>` provider routes to.
   *
   * A sync lookup rather than the settings service itself, because prompt
   * assembly runs inside a turn and cannot await a settings read.
   */
  readonly resolveConnectionKind?: (provider: string) => string | undefined;
  readonly conversationJournalInspection?: ConversationJournalInspectionService;
  readonly executionJournalInspection?: ExecutionJournalInspectionService;
  readonly toolContributions: readonly RegisteredToolContribution[];
  readonly deepResearchSettingsService?: DeepResearchSettingsService;
  readonly authoritativeTaskLauncher: ApiServerOptions["taskLauncher"];
  readonly taskQueue?: TaskQueue;
  readonly schedulingSettingsRuntime?: SchedulingSettingsRouteRuntime;
  readonly schedulingQueueRuntime?: SchedulingQueueRouteRuntime;
  readonly mcpWorkflowPreflightService?: WorkflowMcpPreflightService;
  readonly scheduleService?: ScheduleService;
  readonly batchService?: BatchService;
  readonly batchFolderGrantStore?: BatchFolderGrantStore;
  /** The shared folders' own grant list, listed and revoked in Settings. */
  readonly sharedFolderGrantStore?: BatchFolderGrantStore;
  readonly sharedFolderService?: SharedFolderService;
  readonly workspaceProjectService?: WorkspaceProjectService;
  readonly workspaceProjectContextStore?: WorkspaceProjectContextStore;
  readonly workspaceProjectFileCatalogService?: WorkspaceProjectFileCatalogService;
  readonly workspaceProjectMemoryService?: WorkspaceProjectMemoryService;
  readonly workspaceProjectExportService?: WorkspaceProjectExportService;
  readonly workspaceProjectDetailsService?: WorkspaceProjectDetailsService;
  readonly resourceLibraryService?: ResourceLibraryService;
  /** Octopus's MCP server for outside apps, when voice control is configured. */
  readonly voiceControl?: VoiceControlRuntime;
  trackMcpWorkerTurn(
    controller: AbortController,
    scope: { readonly sessionId: string; readonly taskId: string },
  ): void;
  settleMcpWorkerTurn(controller: AbortController): void;
  cancelMcpWorkerTurnsForTask(sessionId: string, taskId: string): void;
}

export interface ServerComposition extends CompositionLifecycle {
  readonly services: ServerServices;
}

export async function initializeBatchRuntime(params: {
  readonly service: Pick<BatchService, 'initialize' | 'markUnavailable'>
  readonly coordinator?: Pick<BatchAdmissionCoordinator, 'initialize' | 'close'>
  readonly onError?: (error: unknown) => void
}): Promise<void> {
  try {
    await params.service.initialize()
    await params.coordinator?.initialize()
  } catch (error) {
    await params.coordinator?.close().catch(() => undefined)
    params.service.markUnavailable()
    params.onError?.(error)
  }
}

export function createCompositionLifecycle(params: {
  readonly startActions: readonly LifecycleAction[];
  readonly activationActions: readonly LifecycleAction<ServiceActivationContext>[];
  readonly resourcesInOwnershipOrder: readonly LifecycleResource[];
  /** Bars new work at shutdown start, before anything is disposed (AC18). */
  readonly beginShutdown?: () => void;
}): CompositionLifecycle {
  let startPromise: Promise<void> | undefined;
  let activationPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;

  /** Resources already disposed successfully; never disposed twice. */
  const disposed = new Set<LifecycleResource>();

  const dispose = (options?: {
    readonly deadlineMs?: number;
  }): Promise<void> => {
    if (disposePromise) return disposePromise;
    // Handled rather than floating: the rejection handler clears the memo and
    // rethrows, so the memo is empty before any caller sees the failure and a
    // retry cannot collide with the attempt it is replacing.
    //
    // A failed disposal is retryable for the same reason a failed journal
    // append is (AC6): the fault may be transient, and shutdown must be able
    // to try again rather than being stuck with its first bad outcome.
    const attempt = disposeResources(
      params.resourcesInOwnershipOrder,
      disposed,
      options,
    ).catch((error: unknown) => {
      disposePromise = undefined;
      throw error;
    });
    disposePromise = attempt;
    return attempt;
  };

  /**
   * Bar new work without tearing anything down (AC18).
   *
   * The HTTP listener and capability dispatch are two doors into the same
   * process. A graceful shutdown has to shut both at the same moment and only
   * then drain, or out-of-band MCP and worker dispatch keeps arriving while
   * the server waits for the requests it already has.
   */
  const beginShutdown = (): void => {
    params.beginShutdown?.();
  };

  return {
    start() {
      if (disposePromise) {
        return Promise.reject(new Error("Composition has been disposed"));
      }
      startPromise ??= runActions(params.startActions, undefined).catch(
        async (error) => {
          await dispose().catch(() => undefined);
          throw error;
        },
      );
      return startPromise;
    },
    async activateAfterListen(context) {
      if (!startPromise) {
        throw new Error("Composition must start before activation");
      }
      await startPromise;
      if (disposePromise) {
        throw new Error("Composition has been disposed");
      }
      activationPromise ??= runActions(
        params.activationActions,
        context,
      ).catch(async (error) => {
        await dispose().catch(() => undefined);
        throw error;
      });
      return activationPromise;
    },
    beginShutdown,
    dispose,
  };
}

export async function buildServices(
  options: ApiServerOptions,
): Promise<ServerComposition> {
  const resourcesInOwnershipOrder: LifecycleResource[] = [];
  let dispatcherOwner: WorkspaceDispatcherOwner | undefined;

  try {
    const deepResearchSettingsService =
      options.deepResearchSettingsService ??
      (options.workspacePath
        ? new DeepResearchSettingsService({
            storagePath: path.join(
              options.workspacePath,
              DEEP_RESEARCH_SETTINGS_RELATIVE_PATH,
            ),
          })
        : undefined);
    const sessionTaskRuntime =
      options.workspacePath && options.sessionStore
        ? { workspacePath: options.workspacePath, sessionStore: options.sessionStore }
        : undefined;
    const hasSessionTaskRuntime = sessionTaskRuntime !== undefined;
    const resourceLibraryService =
      options.repoRootPath && options.resourceLibraryRootPath
        ? new ResourceLibraryService({
            repoRootPath: options.repoRootPath,
            rootPath: options.resourceLibraryRootPath,
            ...whenDefined(options.builtinResourceRootPath, (builtinResourceRootPath) => ({ builtinResourceRootPath })),
            ...whenDefined(options.requireResourceLibraryMigrationApproval, (requireMigrationApproval) => ({ requireMigrationApproval })),
          })
        : undefined;
    const workspaceProjectContextStore =
      options.workspaceProjectContextStore ??
      (options.workspacePath
        ? new WorkspaceProjectContextStore({ workspacePath: options.workspacePath })
        : undefined);
    const workspaceProjectService =
      options.workspaceProjectService ??
      (sessionTaskRuntime
        ? new WorkspaceProjectService({
            projectStore: new WorkspaceProjectStore({
              workspacePath: sessionTaskRuntime.workspacePath,
            }),
            membershipStore: new WorkspaceProjectMembershipStore({
              workspacePath: sessionTaskRuntime.workspacePath,
            }),
            ...whenDefined(workspaceProjectContextStore, (projectContextStore) => ({ projectContextStore })),
            sessionStore: sessionTaskRuntime.sessionStore,
            hasBlockingReference: (projectId) =>
              Promise.all([
                hasProjectScheduleReferenceInFile(
                  path.join(sessionTaskRuntime.workspacePath, SCHEDULES_RELATIVE_PATH),
                  projectId,
                ),
                hasProjectBatchReferenceInFile(
                  path.join(
                    sessionTaskRuntime.workspacePath,
                    'task-queue',
                    'batches',
                    'definitions.json',
                  ),
                  projectId,
                ),
              ]).then((references) => references.some(Boolean)),
          })
        : undefined);
    const workspaceProjectFileCatalogService =
      options.workspaceProjectFileCatalogService ??
      (workspaceProjectService && workspaceProjectContextStore && options.sessionStore
        ? new WorkspaceProjectFileCatalogService({
            projectService: workspaceProjectService,
            projectContextStore: workspaceProjectContextStore,
            sessionStore: options.sessionStore,
            runStore: options.store,
          })
        : undefined);
    const workspaceProjectMemoryService =
      options.workspaceProjectMemoryService ??
      (workspaceProjectService && options.workspacePath
        ? new WorkspaceProjectMemoryService({
            projectService: workspaceProjectService,
            memoryStore: new WorkspaceProjectMemoryStore({
              workspacePath: options.workspacePath,
            }),
          })
        : undefined);
    let schedulingSettingsService: SchedulingSettingsService | undefined;
    let schedulingSnapshot:
      | Awaited<ReturnType<SchedulingSettingsService["snapshot"]>>
      | undefined;
    if (sessionTaskRuntime) {
      parseMaximumConcurrentTasksEnvironmentValue(
        process.env[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE],
      );
      const owner = await WorkspaceDispatcherOwner.acquire({
        workspacePath: sessionTaskRuntime.workspacePath,
      });
      dispatcherOwner = owner;
      resourcesInOwnershipOrder.push({
        name: "workspace-dispatcher-owner",
        dispose: () => owner.release(),
      });
      schedulingSettingsService = new SchedulingSettingsService({
        storagePath: path.join(
          sessionTaskRuntime.workspacePath,
          SCHEDULING_SETTINGS_RELATIVE_PATH,
        ),
      });
      schedulingSnapshot = await schedulingSettingsService.snapshot();
    }

    const createJobRegistry = new CreateJobRegistry({
      pendingCancellationTtlMs: PENDING_CREATE_CANCEL_TTL_MS,
      ...whenDefined(options.workspacePath, (workspacePath) => ({ workspacePath })),
    });
    resourcesInOwnershipOrder.push({
      name: "create-job-registry",
      dispose: () => createJobRegistry.close(),
    });
    const resourceArchitectStore = new ResourceArchitectStore(
      options.workspacePath,
    );
    const workflowArchitectTurnStore = new TurnMetricStore(
      options.workspacePath,
      "workflow-architect-telemetry",
    );
    const providerSettingsService =
      options.providerSettingsService ?? new ProviderSettingsService();
    const mcpSettingsService =
      options.mcpSettingsService ?? new McpSettingsService();
    resourcesInOwnershipOrder.push({
      name: "mcp-settings-service",
      dispose: () => mcpSettingsService.closeAll(),
    });
    const mcpInteractionService =
      options.mcpInteractionService ??
      (options.workspacePath
        ? new McpInteractionService({ workspacePath: options.workspacePath })
        : undefined);
    const mcpProviderSupportResolver =
      options.mcpProviderSupportResolver ??
      createMcpProviderSupportResolver(providerSettingsService);
    const mcpAgentGrantsService = options.repoRootPath
      ? new McpAgentGrantsService({
          repoRootPath: options.repoRootPath,
          settingsService: mcpSettingsService,
          providerSupportResolver: mcpProviderSupportResolver,
        })
      : null;
    const mcpRunLeaseStore = new McpRunLeaseStore();
    resourcesInOwnershipOrder.push({
      name: "mcp-run-leases",
      dispose: () => mcpRunLeaseStore.clear(),
    });
    const browserManager =
      options.browserManager ??
      (options.workspacePath && options.repoRootPath
        ? new BrowserManager({
            profilePath:
              options.browserProfilePath ??
              path.join(
                path.dirname(options.workspacePath),
                "browser-profile",
              ),
            allowHttpLocalhost: process.env.NODE_ENV === "test",
            ...whenDefined(options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
          })
        : undefined);
    if (browserManager) {
      resourcesInOwnershipOrder.push({
        name: "browser-manager",
        dispose: () => browserManager.close(),
      });
    }
    const runtimeCapabilityAuthority =
      options.workspacePath && options.sessionStore
        ? new RuntimeCapabilityAuthorityResolver({
            workspacePath: options.workspacePath,
            sessionStore: options.sessionStore,
          })
        : undefined;
    const assignmentLifecycle = options.sessionStore?.subscribeTaskTerminal
      ? {
          subscribeTaskTerminal:
            options.sessionStore.subscribeTaskTerminal.bind(options.sessionStore),
        }
      : undefined;
    const capabilityDispatchLifecycle =
      new CapabilityDispatchLifecycleCoordinator();
    // Resolved once, here, so an unrecognised flag or an unusable tenant fails
    // startup naming what is wrong — rather than resolving to `disabled` and
    // reading as protection that is on (ADR A-1, A-4).
    const executionJournalOptions = options.workspacePath
      ? await startWorkspaceExecutionJournal({
          workspacePath: options.workspacePath,
        })
      : resolveExecutionJournalOptions();
    for (const deprecation of executionJournalOptions.deprecations) {
      logProcessWarning("execution-journal", deprecation);
    }
    // One registry per process (ADR §16). `released` and `closed` are
    // per-registry state, so a second instance would not honour the first's
    // teardown bar — which is only reachable once more than one consumer
    // exists, and AC5 is about to add three.
    const executionJournalRegistry = options.workspacePath
      ? new WorkspaceExecutionJournalRegistry({
          workspacePath: options.workspacePath,
          tenantId: executionJournalOptions.tenantId,
          mode: executionJournalOptions.mode,
        })
      : undefined;
    // A derived view of what runs have discovered about each provider. One per
    // process, because both health endpoints read it and a second instance
    // would answer from a different fold of the same journals.
    const providerFailureHealth = options.workspacePath
      ? new ProviderFailureHealthService({
          workspacePath: options.workspacePath,
        })
      : undefined;
    await providerFailureHealth?.load();
    // Conversation activities share the resolved mode and tenant but not the
    // registry. Their keys, roots and leases are per-activity, and folding them
    // into the assignment registry is exactly what would force a synthetic
    // assignment for chat that has none.
    const conversationJournalRegistry = options.workspacePath
      ? new WorkspaceConversationJournalRegistry({
          workspacePath: options.workspacePath,
          tenantId: executionJournalOptions.tenantId,
          mode:
            executionJournalOptions.mode === "authoritative"
              ? "authoritative"
              : "disabled",
        })
      : undefined;
    // Registered the moment it exists, not beside whoever happens to close
    // things. Disposal runs in reverse of this list, so a registry acquired
    // here — before the runtime and the routes that use it — is released after
    // they have drained, which is the order the guarantee needs. Registering it
    // beside the capability teardown instead meant the normal workspace path
    // never closed it at all, and a disposed composition left a registry still
    // willing to open activities.
    if (conversationJournalRegistry) {
      const ownedRegistry = conversationJournalRegistry;
      resourcesInOwnershipOrder.push({
        name: "conversation-journal-registry",
        dispose: () => ownedRegistry.close(),
      });
    }
    if (executionJournalRegistry) {
      // The session store performs terminal workflow reconciliation, so it is
      // a journal writer too. It is constructed by the caller, before the
      // registry exists, so the binding happens here (ADR §9).
      //
      // Disposal is registered once the capability runtime is known, below:
      // who owns the registry at teardown depends on whether one exists.
      options.sessionStore?.useExecutionJournalRegistry?.(
        executionJournalRegistry,
      );
    }
    // Resolved once, here, so an unrecognised setting fails startup naming the
    // variable and the value rather than degrading enforcement mid-turn — and
    // so no domain logic ever reads the environment (plan §6.2). `shadow` and
    // `enforce` exist to produce rollout evidence, so either mode without a
    // journal that can actually enroll new validation telemetry is a startup
    // failure, not a silent cohort with zero rejections. A registry object is
    // not enough: with durable journals disabled the registry exists but
    // refuses to enroll new assignments.
    const webEvidenceRolloutConfig = parseWebEvidenceRolloutConfig({
      links: process.env[WEB_EVIDENCE_LINKS_MODE_ENV],
      linksPercent: process.env[WEB_EVIDENCE_LINKS_PERCENT_ENV],
      claims: process.env[WEB_EVIDENCE_CLAIMS_MODE_ENV],
      claimsPercent: process.env[WEB_EVIDENCE_CLAIMS_PERCENT_ENV],
      claimCohorts: process.env[WEB_EVIDENCE_CLAIM_COHORTS_ENV],
    });
    if (
      webEvidenceRolloutRequiresRecorder(webEvidenceRolloutConfig) &&
      (!executionJournalRegistry ||
        executionJournalOptions.mode !== "authoritative")
    ) {
      throw new WebEvidenceRolloutConfigurationError(
        webEvidenceRolloutConfig.links.mode !== "off"
          ? WEB_EVIDENCE_LINKS_MODE_ENV
          : WEB_EVIDENCE_CLAIMS_MODE_ENV,
        webEvidenceRolloutConfig.links.mode !== "off"
          ? webEvidenceRolloutConfig.links.mode
          : webEvidenceRolloutConfig.claims.mode,
        "shadow and enforce modes record sanitized validation telemetry " +
          "through the workspace execution journal, which cannot enroll new " +
          "assignments without a workspace with durable journals " +
          "authoritative. Use 'off', or start with a journaled workspace.",
      );
    }
    const webEvidenceRollout = {
      config: webEvidenceRolloutConfig,
      ...whenDefined(executionJournalRegistry, (registry) => ({
        resolveRecorder: (recorderInput: {
          readonly scope: CapabilityAssignmentScope;
          readonly agentPath: string;
          readonly requestId: string;
          readonly signal?: AbortSignal | undefined;
        }) =>
          resolveWebEvidenceValidationRecorder({
            registry,
            scope: recorderInput.scope,
            agentPath: recorderInput.agentPath,
            requestId: recorderInput.requestId,
            processIdentity: OPERATOR_PROCESS_INSTANCE_ID,
            ...whenDefined(recorderInput.signal, (signal) => ({ signal })),
          }),
      })),
    };
    const capabilityDispatchRuntime =
      options.workspacePath && runtimeCapabilityAuthority
        ? new CapabilityDispatchRuntime({
            workspacePath: options.workspacePath,
            runtimeAuthority: runtimeCapabilityAuthority,
            leaseResolver: (context) => mcpRunLeaseStore.resolve(context),
            lifecycle: capabilityDispatchLifecycle,
            ...whenDefined(executionJournalRegistry, (registry) => ({
              executionJournalRegistry: registry,
            })),
            ...(assignmentLifecycle ? { assignmentLifecycle } : {}),
            ...(mcpInteractionService
              ? {
                  approvalCoordinator:
                    mcpInteractionService.approvalCoordinator,
                }
              : {}),
          })
        : undefined;
    // Registered once both are known, because who owns the journal registry
    // at teardown depends on whether a capability runtime exists (AC18).
    if (capabilityDispatchRuntime && executionJournalRegistry) {
      // One unit: the registry closes only once runtime shutdown has actually
      // recorded a decision for everything still unsettled. As two entries
      // the registry would close straight after a failed shutdown was caught.
      resourcesInOwnershipOrder.push(
        createRuntimeJournalOwnership({
          runtime: capabilityDispatchRuntime,
          registry: executionJournalRegistry,
        }),
      );
    } else if (capabilityDispatchRuntime) {
      resourcesInOwnershipOrder.push({
        name: "capability-dispatch-runtime",
        dispose: (options) =>
          capabilityDispatchRuntime.close(
            options?.deadlineMs === undefined
              ? undefined
              : { deadlineMs: options.deadlineMs },
          ),
      });
    } else {
      resourcesInOwnershipOrder.push({
        name: executionJournalRegistry
          ? "capability-lifecycle-and-journals"
          : "capability-dispatch-lifecycle",
        dispose: async (options) => {
          await capabilityDispatchLifecycle.close(
            options?.deadlineMs === undefined
              ? undefined
              : { deadlineMs: options.deadlineMs },
          );
          await executionJournalRegistry?.close();
        },
      });
    }
    // Operator surface over the durable journals in this workspace. Without it
    // a blocked dispatch is invisible after a restart (ADR §15) and, once it
    // is visible, unresolvable (ADR §7 option 3).
    //
    // Resolutions go through the registry this composition already owns, so an
    // operator write shares its cache and its teardown bars rather than
    // opening a second authority over the same assignment (D4).
    //
    // The principal is assembled here and nowhere else. Its per-request half
    // is the credential scope the transport resolved; its server half is the
    // sealed tenant and this process's own instance id. None of it can be
    // influenced by a caller, which is the only reason it is worth recording.
    const executionJournalInspection = options.workspacePath
      ? new ExecutionJournalInspectionService({
          workspacePath: options.workspacePath,
          authority: TRANSPORT_AUTHENTICATED_JOURNAL_AUTHORITY,
          // The report's counters come from the journals this process already
          // holds open, and only from those: they are per-handle and
          // in-memory, so there is nothing on disk to read them from.
          ...whenDefined(executionJournalRegistry, (registry) => ({
            journals: registry,
          })),
          ...whenDefined(executionJournalRegistry, (registry) => ({
            resolution: {
              ports: registry,
              principal: ({
                credentialScope,
              }: {
                readonly credentialScope: RouteCredentialScope;
              }) => ({
                credentialScope,
                tenantId: executionJournalOptions.tenantId,
                processInstanceId: OPERATOR_PROCESS_INSTANCE_ID,
              }),
            },
          })),
        })
      : undefined;
    const conversationJournalInspection = options.workspacePath
      ? new ConversationJournalInspectionService({
          workspacePath: options.workspacePath,
          // The same operator policy the assignment journals answer to, so
          // the two surfaces cannot drift into two different rules.
          authority: TRANSPORT_AUTHENTICATED_JOURNAL_AUTHORITY,
          ...whenDefined(conversationJournalRegistry, (registry) => ({ registry })),
        })
      : undefined;
    const toolContributions = buildToolRegistry({
      ...whenDefined(options.workspacePath, (workspacePath) => ({ workspacePath })),
      ...whenDefined(options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
      ...whenDefined(runtimeCapabilityAuthority, (authority) => ({ runtimeCapabilityAuthority: authority })),
      ...whenDefined(capabilityDispatchRuntime?.dispatcher, (dispatcher) => ({ capabilityDispatcher: dispatcher })),
      ...whenDefined(browserManager, (presentBrowserManager) => ({ browserManager: presentBrowserManager })),
      ...whenDefined(options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
      providerSettingsService,
      createWorkerEndpointToken: () => randomPathToken(),
      ...(mcpInteractionService
        ? {
            approvalCoordinator:
              mcpInteractionService.approvalCoordinator,
            approvalWaitTimeoutMs:
              mcpInteractionService.approvalCoordinator.waitTimeoutMs,
          }
        : {}),
      ...whenDefined(options.toolModuleOptions, (moduleOptions) => ({ moduleOptions })),
    });
    const mcpEvidenceWorkspacePath = options.workspacePath;
    const mcpParentBroker = new McpParentBroker({
      lifecycle: capabilityDispatchLifecycle,
      settingsService: mcpSettingsService,
      clientManager: mcpSettingsService.getBrokerClientManager(),
      grantResolver: ({ context, serverId }) =>
        mcpSettingsService.isAgentGranted(context.agentPath, serverId),
      leaseResolver: (context) => mcpRunLeaseStore.resolve(context),
      ...(capabilityDispatchRuntime
        ? { capabilityEvidence: capabilityDispatchRuntime.evidencePort }
        : {}),
      ...whenDefined(executionJournalRegistry, (registry) => ({
        durable: (input: Parameters<typeof registry.resolve>[0]) =>
          registry.resolve(input),
      })),
      ...(mcpInteractionService
        ? {
            approvalCoordinator: mcpInteractionService.approvalCoordinator,
            approvalWaitTimeoutMs:
              mcpInteractionService.approvalCoordinator.waitTimeoutMs,
          }
        : {}),
      ...(mcpEvidenceWorkspacePath
        ? {
            evidenceStoreFactory: (scope) =>
              new McpEvidenceStore({
                workspacePath: mcpEvidenceWorkspacePath,
                ...scope,
              }),
          }
        : {}),
    });
    const agentTextStreamHub =
      options.agentTextStreamHub ?? new AgentTextStreamHub()
    const agentTextStreamDeltaTokens =
      options.agentTextStreamDeltaTokens ?? new AgentTextDeltaTokenRegistry()
    const agentTextStreamDeltaEndpoint = new AgentTextDeltaEndpoint()
    // Subscribes once for terminal cleanup: a run that actually started
    // outlives its launch call, so something has to release its channel when
    // it ends.
    const agentTextStreamLaunch = createAgentTextStreamLaunchRuntime({
      hub: agentTextStreamHub,
      tokens: agentTextStreamDeltaTokens,
      endpoint: agentTextStreamDeltaEndpoint,
      ...whenDefined(options.sessionStore, (sessionStore) => ({
        assignmentLifecycle: sessionStore,
      })),
    })
    resourcesInOwnershipOrder.push({
      name: "agent-text-stream-launch",
      dispose: () => agentTextStreamLaunch.dispose(),
    });
    const mcpAgentToolService =
      options.mcpAgentToolService ??
      new McpAgentToolService({
        broker: mcpParentBroker,
        leaseStore: mcpRunLeaseStore,
        providerSettingsService,
        providerSupportResolver: mcpProviderSupportResolver,
        builtinAgentTools: providerAgentTools(toolContributions),
        ...whenDefined(
          configuredMaxConcurrentToolCalls(),
          (maxConcurrentToolCalls) => ({ maxConcurrentToolCalls }),
        ),
        youtubeQuotaFallback: async () => {
          const settings = toolContributions.find((tool) => tool.name === 'youtube')?.services.youtubeSettingsService
          if (!(settings instanceof YoutubeSettingsService)) return undefined
          const config = await settings.runtimeGemini()
          if (!config.apiKey) return undefined
          return { model: config.model, target: {
            apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            apiKey: config.apiKey,
          } }
        },
        webEvidence: webEvidenceRollout,
      });
    // Folder grants come from the native picker only. Without the grant store
    // nothing can be admitted, so no shared folder service is offered at all.
    // Project membership decides which project folders a chat gets. Documents
    // in shared folders are parsed, local-only, into the workspace's folder
    // index by the server's own parser; without one they can't be read.
    const sharedFolderGrantStore = options.sharedFolderGrantStore
    const sharedFolderWorkspacePath = options.workspacePath
    const sharedFolderService = sharedFolderWorkspacePath && sharedFolderGrantStore && workspaceProjectService
      ? new SharedFolderService({
          store: new SharedFolderStore(sharedFolderWorkspacePath),
          policy: new SharedFolderAccessPolicy({
            protectedPaths: [
              sharedFolderWorkspacePath,
              ...(options.appDataPath ? [options.appDataPath] : []),
              ...(options.voiceControl?.discoveryDir === undefined ? [] : [options.voiceControl.discoveryDir]),
            ],
            listGrants: () => sharedFolderGrantStore.list(),
          }),
          projects: workspaceProjectService,
          ...whenDefined(options.fileParserLauncher, (launcher) => ({
            index: { workspacePath: sharedFolderWorkspacePath, launcher },
          })),
        })
      : undefined
    if (sharedFolderService && sharedFolderGrantStore) {
      resourcesInOwnershipOrder.push({
        name: 'shared-folder-service',
        dispose: () => sharedFolderService.close(),
      })
      // Revoking a grant stops the folder's parses and deletes its parsed text (LF-12).
      resourcesInOwnershipOrder.push({
        name: 'shared-folder-grant-subscription',
        dispose: sharedFolderGrantStore.subscribe(() => sharedFolderService.handleGrantsChanged()),
      })
    }
    const mcpWorkerTurnService =
      options.workspacePath && options.sessionStore
        ? new McpWorkerTurnService({
            ...whenDefined(resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
            ...whenDefined(options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
            workspacePath: options.workspacePath,
            sessionStore: options.sessionStore,
            agentToolService: mcpAgentToolService,
            ...whenDefined(sharedFolderService, (sharedFolderService) => ({ sharedFolderService })),
            // Only an approved retry consults this: it is the one pair the
            // sealed record did not already answer for.
            providerSupportResolver: mcpProviderSupportResolver,
            ...whenDefined(
              runtimeCapabilityAuthority,
              (resolver) => ({ authorityResolver: resolver }),
            ),
            // An approved model choice is authorized from the workflow's own
            // record, which for an enrolled run has to be rebuilt from its
            // journal rather than read from the projection.
            ...whenDefined(
              executionJournalRegistry,
              (registry) => ({ executionJournalRegistry: registry }),
            ),
          })
        : undefined;
    const mcpWorkerTurnPath = mcpWorkerTurnService
      ? `/_pipeline-worker/${randomPathToken()}`
      : undefined;
    let mcpWorkerTurnUrl: string | undefined;
    const toolEndpointUrls = new Map<string, string>();
    const activeMcpWorkerTurns = new Set<AbortController>();
    const mcpWorkerTurnsByTask = new Map<
      string,
      Set<AbortController>
    >();
    resourcesInOwnershipOrder.push({
      name: "active-mcp-worker-turns",
      dispose: () => {
        for (const controller of activeMcpWorkerTurns) controller.abort();
        activeMcpWorkerTurns.clear();
        mcpWorkerTurnsByTask.clear();
      },
    });
    const taskLauncherDelegate =
      options.taskLauncher ??
      (options.repoRootPath
        ? new SessionTaskRunnerLauncher(options.repoRootPath)
        : undefined);
    const authoritativeTaskLauncher =
      mcpWorkerTurnService && taskLauncherDelegate
        ? new McpWorkerTurnRunLauncher(
            taskLauncherDelegate,
            () => mcpWorkerTurnUrl,
            () =>
              toolContributions.flatMap((contribution) => {
                const endpoint = contribution.workerEndpoint;
                const url = endpoint
                  ? toolEndpointUrls.get(endpoint.environmentVariable)
                  : undefined;
                return endpoint && url
                  ? [{
                      environmentVariable:
                        endpoint.environmentVariable,
                      url,
                    }]
                  : [];
              }),
          )
        : options.taskLauncher;
    const taskQueue =
      dispatcherOwner &&
      schedulingSnapshot &&
      options.workspacePath &&
      options.sessionStore
        ? new TaskQueue({
            ...whenDefined(resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
            sessionStore: options.sessionStore,
            ...whenDefined(executionJournalRegistry, (registry) => ({
              executionJournalRegistry: registry,
            })),
            owner: dispatcherOwner,
            maximumConcurrentTasks:
              schedulingSnapshot.maximumConcurrentTasks,
            repoRootPath:
              options.repoRootPath ??
              path.resolve(
                path.dirname(fileURLToPath(import.meta.url)),
                "..",
              ),
            workspacePath: options.workspacePath,
            textStream: agentTextStreamLaunch.port,
            ...whenDefined(options.voiceControl?.sessionChanged, (onSessionChanged) => ({ onSessionChanged })),
            ...whenDefined(options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
            ...whenDefined(authoritativeTaskLauncher, (taskLauncher) => ({ taskLauncher })),
            durableRecoveryEnabled:
              options.recoverInterruptedTasks !== false &&
              process.env.TEAM_RUNTIME_DURABLE_RECOVERY !== "0",
          })
        : undefined;
    if (taskQueue) {
      resourcesInOwnershipOrder.push({
        name: "task-queue",
        dispose: () => taskQueue.close(),
      });
    }
    const schedulingSettingsRuntime =
      schedulingSettingsService && taskQueue
        ? {
            snapshot: () => schedulingSettingsService.snapshot(),
            updateMaximumConcurrentTasks: (
              maximumConcurrentTasks: number,
            ) =>
              taskQueue.updateMaximumConcurrentTasks(
                maximumConcurrentTasks,
                () =>
                  schedulingSettingsService.updateMaximumConcurrentTasks(
                    maximumConcurrentTasks,
                  ),
              ),
            isReady: () => taskQueue.isReady(),
          }
        : undefined;
    const schedulingQueueRuntime = taskQueue
      ? { snapshot: () => taskQueue.snapshot() }
      : undefined;
    const mcpWorkflowPreflightService = options.repoRootPath
      ? new WorkflowMcpPreflightService({
          repoRootPath: options.repoRootPath,
          settingsService: mcpSettingsService,
          providerSupportResolver: mcpProviderSupportResolver,
        })
      : undefined;
    const scheduleService =
      sessionTaskRuntime && options.repoRootPath
        ? new ScheduleService({
            storagePath: path.join(
              sessionTaskRuntime.workspacePath,
              SCHEDULES_RELATIVE_PATH,
            ),
            sessionStore: sessionTaskRuntime.sessionStore,
            ...whenDefined(executionJournalRegistry, (registry) => ({ executionJournalRegistry: registry })),
            ...whenDefined(taskQueue, (presentTaskQueue) => ({ taskQueue: presentTaskQueue })),
            repoRootPath: options.repoRootPath,
            workspacePath: sessionTaskRuntime.workspacePath,
            ...whenDefined(options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
            ...whenDefined(mcpWorkflowPreflightService, (presentService) => ({ mcpWorkflowPreflightService: presentService })),
            ...whenDefined(workspaceProjectService, (presentService) => ({ workspaceProjectService: presentService })),
            ...whenDefined(workspaceProjectContextStore, (presentStore) => ({ workspaceProjectContextStore: presentStore })),
            resolveAgentTarget: createScheduledAgentTargetResolver({
              repoRootPath: options.repoRootPath,
              ...whenDefined(options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
            }),
          })
        : undefined;
    const workspaceProjectExportService =
      options.workspaceProjectExportService ??
      (workspaceProjectService &&
      workspaceProjectContextStore &&
      workspaceProjectMemoryService
        ? new WorkspaceProjectExportService({
            projectService: workspaceProjectService,
            contextStore: workspaceProjectContextStore,
            memoryService: workspaceProjectMemoryService,
            ...whenDefined(scheduleService, (presentScheduleService) => ({ scheduleService: presentScheduleService })),
          })
        : undefined);
    const workspaceProjectDetailsService =
      options.workspaceProjectDetailsService ??
      (workspaceProjectService &&
      workspaceProjectContextStore &&
      workspaceProjectMemoryService
        ? new WorkspaceProjectDetailsService({
            projectService: workspaceProjectService,
            contextStore: workspaceProjectContextStore,
            memoryService: workspaceProjectMemoryService,
            ...whenDefined(scheduleService, (presentScheduleService) => ({ scheduleService: presentScheduleService })),
          })
        : undefined);
    if (scheduleService) {
      resourcesInOwnershipOrder.push({
        name: "schedule-service",
        dispose: () => scheduleService.close(),
      });
    }
    const batchStore = taskQueue && options.workspacePath
      ? new BatchStore({ workspacePath: options.workspacePath })
      : undefined
    const batchFolderAccessPolicy = options.workspacePath && options.repoRootPath
      ? options.batchFolderAccessPolicy ?? new DefaultBatchFolderAccessPolicy({
          workspacePath: options.workspacePath,
          repoRootPath: options.repoRootPath,
          ...whenDefined(options.batchFolderGrantStore, (grantStore) => ({
            listGrants: () => grantStore.list(),
          })),
        })
      : undefined
    const batchArtifactWriter = options.workspacePath
      ? new BatchArtifactWriter({ workspacePath: options.workspacePath, runStore: options.store })
      : undefined
    const { fileParserLauncher, repoRootPath, workflowsRegistryPath } = options
    const batchCoordinator =
      batchStore &&
      taskQueue &&
      sessionTaskRuntime &&
      fileParserLauncher &&
      repoRootPath &&
      workflowsRegistryPath &&
      batchFolderAccessPolicy
        ? new BatchAdmissionCoordinator({
            store: batchStore,
            sessionStore: sessionTaskRuntime.sessionStore,
            taskQueue,
            ...(batchArtifactWriter ? { artifactWriter: batchArtifactWriter } : {}),
            prepareItem: ({ batchId, executionId, itemId, signal }) => prepareBatchItem({
              store: batchStore,
              batchId,
              executionId,
              itemId,
              sessionStore: sessionTaskRuntime.sessionStore,
              createSession: (input) => workspaceProjectService
                ? workspaceProjectService.createSession(input)
                : sessionTaskRuntime.sessionStore.createSession(input),
              folderAccessPolicy: batchFolderAccessPolicy,
              fileParserLauncher,
              taskQueue,
              workspacePath: sessionTaskRuntime.workspacePath,
              repoRootPath,
              workflowsRegistryPath,
              ...(mcpWorkflowPreflightService ? { mcpWorkflowPreflightService } : {}),
              signal,
            }),
          })
        : undefined
    const batchService =
      batchStore && batchFolderAccessPolicy && sessionTaskRuntime &&
      repoRootPath && workflowsRegistryPath && taskQueue
        ? new BatchService({
            workspacePath: sessionTaskRuntime.workspacePath,
            store: batchStore,
            folderAccessPolicy: batchFolderAccessPolicy,
            isTaskQueueReady: () => taskQueue.isReady(),
            validateWorkflow: async (workflowId) => {
              const entry = listWorkflowEntries(options.workflowsRegistryPath, { includeInternal: true })
                .find((workflow) => workflow.id === workflowId)
              if (!entry || (entry.tags ?? []).includes('batch-ineligible') ||
                (entry.tags ?? []).includes('scheduler-generated')) return false
              return validateWorkflowForLaunch({
                repoRootPath,
                ...whenDefined(options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
                workflowId,
              }).length === 0
            },
            ...(workspaceProjectService ? {
              validateProject: async (projectId: string) => {
                try {
                  return (await workspaceProjectService.getProject(projectId)).status === 'active'
                } catch {
                  return false
                }
              },
            } : {}),
            cancelTask: (sessionId, taskId) => cancelSessionTask({
              sessionId,
              taskId,
              sessionStore: sessionTaskRuntime.sessionStore,
              ...whenDefined(executionJournalRegistry, (registry) => ({ executionJournalRegistry: registry })),
            }),
            ...(batchCoordinator ? { coordinator: batchCoordinator } : {}),
          })
        : undefined
    if (batchCoordinator) {
      resourcesInOwnershipOrder.push({
        name: 'batch-admission-coordinator',
        dispose: () => batchCoordinator.close(),
      })
    }
    if (batchService) {
      resourcesInOwnershipOrder.push({
        name: 'batch-service',
        dispose: () => batchService.close(),
      })
    }
    const unsubscribeBatchGrantChanges =
      options.batchFolderGrantStore && batchCoordinator && batchFolderAccessPolicy
        ? options.batchFolderGrantStore.subscribe(() => {
            void batchCoordinator.reconcileFolderAccess(batchFolderAccessPolicy)
              .catch(() => batchCoordinator.wake())
          })
        : undefined
    if (unsubscribeBatchGrantChanges) {
      resourcesInOwnershipOrder.push({
        name: 'batch-folder-grant-subscription',
        dispose: unsubscribeBatchGrantChanges,
      })
    }
    const mcpResourceImportService =
      options.mcpResourceImportService ??
      (options.workspacePath && options.sessionStore
        ? new McpResourceImportService({
            resourceClient: new McpResourceClientService({
              settingsService: mcpSettingsService,
              clientManager: mcpSettingsService.getResourceClientManager(),
            }),
            importStore: new McpResourceImportStore({
              workspacePath: options.workspacePath,
            }),
            sessionStore: options.sessionStore,
            ...whenDefined(options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
          })
        : undefined);

    const dialogueVoiceLink = options.voiceControl?.discoveryDir === undefined
      ? undefined
      : createVoiceLayerLink({ discoveryDir: options.voiceControl.discoveryDir, appId: 'octopus' });
    if (dialogueVoiceLink) resourcesInOwnershipOrder.push({ name: 'dialogue-voice-link', dispose: () => dialogueVoiceLink.close() });

    const agentDialogueService = options.workspacePath && options.sessionStore && options.repoRootPath
      ? new AgentDialogueService({
          workspacePath: options.workspacePath, sessionStore: options.sessionStore, repoRootPath: options.repoRootPath,
          agentTextStreamHub, mcpAgentToolService,
          runStore: options.store,
          ...whenDefined(dialogueVoiceLink, (link) => ({ voiceDelivery: {
            say: async (input, callOptions) => { await link.refresh(); return link.say(input, callOptions) },
            setStatus: async (input) => { await link.refresh(); return link.setStatus(input) },
          } satisfies import('../services/agent-dialogue-service.js').AgentDialogueVoiceDelivery })),
          ...whenDefined(workspaceProjectService, (workspaceProjectService) => ({ workspaceProjectService })),
          ...whenDefined(workspaceProjectContextStore, (workspaceProjectContextStore) => ({ workspaceProjectContextStore })),
          ...whenDefined(sharedFolderService, (sharedFolderService) => ({ sharedFolderService })),
          ...whenDefined(options.agentDialogueClock, (clock) => ({ clock })),
          ...whenDefined(executionJournalRegistry, (registry) => ({ executionJournalRegistry: registry })),
          ...whenDefined(providerFailureHealth, (observer) => ({ providerFailureHealth: observer })),
          resolveConnectionKind: (provider) => providerSettingsService.connectionKindFor(provider),
        }) : undefined;
    if (agentDialogueService) resourcesInOwnershipOrder.push({ name: 'agent-dialogue', dispose: () => agentDialogueService.close() });

    // Acquired last so discovery and external requests close before services.
    const voiceControl = options.voiceControl
      ? createVoiceControlRuntime(options.voiceControl, {
          runStore: options.store,
          ...whenDefined(agentDialogueService, (service) => ({ findDialogueSession: (dialogueId: string, signal: AbortSignal) => service.findSessionId(dialogueId, signal) })),
          ...whenDefined(options.sessionStore, (sessionStore) => ({ sessionStore })),
          ...whenDefined(options.workspacePath, (workspacePath) => ({ workspacePath })),
        })
      : undefined;
    if (voiceControl) {
      resourcesInOwnershipOrder.push({
        name: "voice-control",
        dispose: () => voiceControl.dispose(),
      });
    }

    const lifecycle = createCompositionLifecycle({
      // Barring capability dispatch is the second half of "stop accepting":
      // the HTTP listener closes the one door, this closes the other.
      beginShutdown: () => {
        agentDialogueService?.beginShutdown();
        if (capabilityDispatchRuntime) {
          capabilityDispatchRuntime.beginShutdown();
          return;
        }
        capabilityDispatchLifecycle.beginShutdown();
      },
      startActions: [
        {
          name: "resource-library-initialization",
          run: async () => {
            await resourceLibraryService?.initialize();
          },
        },
        {
          name: "provider-settings-hydration",
          run: () => providerSettingsService.hydrateRuntime(),
        },
        {
          name: "mcp-elicitation-configuration",
          run: () =>
            mcpInteractionService
              ? mcpSettingsService.configureElicitationHandler(
                  mcpInteractionService.handleElicitation,
                )
              : undefined,
        },
        {
          name: "mcp-settings-hydration",
          run: () => mcpSettingsService.hydrate(),
        },
        {
          // A cache the app can rebuild: a failure here never stops the server.
          name: "shared-folder-index-startup",
          run: () =>
            sharedFolderService?.start().catch((error: unknown) => {
              console.error("Shared folder index startup failed.", error);
            }),
        },
        ...toolContributions.flatMap(
          (contribution) => contribution.startActions ?? [],
        ),
      ],
      activationActions: [
        {
          // The child needs the address, which exists only once the server is
          // listening. The token is minted per run and never lives here.
          name: "agent-text-stream-endpoint",
          run: ({ baseUrl }) => {
            agentTextStreamDeltaEndpoint.bind(baseUrl);
          },
        },
        {
          name: "listening-callback",
          run: ({ host, port, publicUrl, brokerUrl }) =>
            options.onListening?.({
              host,
              port,
              url: publicUrl,
              ...whenDefined(brokerUrl, (presentBrokerUrl) => ({ brokerUrl: presentBrokerUrl })),
            }),
        },
        {
          name: "task-queue-initialization",
          run: async () => {
            await taskQueue?.initialize();
          },
        },
        {
          name: "schedule-service-initialization",
          run: () => scheduleService?.initialize(),
        },
        {
          name: 'batch-service-initialization',
          run: () => {
            if (!batchService) return
            return initializeBatchRuntime({
              service: batchService,
              ...(batchCoordinator ? { coordinator: batchCoordinator } : {}),
              onError: (error) => console.error('Batch runtime initialization failed.', error),
            })
          },
        },
        {
          // Advertised last: by now every service a tool calls is ready.
          name: 'voice-control-activation',
          run: ({ baseUrl, publicUrl }) => voiceControl?.activate({ baseUrl, publicUrl }),
        },
      ],
      resourcesInOwnershipOrder,
    });

    const trackMcpWorkerTurn: ServerServices["trackMcpWorkerTurn"] = (
      controller,
      scope,
    ) => {
      activeMcpWorkerTurns.add(controller);
      const key = taskKey(scope.sessionId, scope.taskId);
      const controllers =
        mcpWorkerTurnsByTask.get(key) ?? new Set<AbortController>();
      controllers.add(controller);
      mcpWorkerTurnsByTask.set(key, controllers);
    };
    const settleMcpWorkerTurn: ServerServices["settleMcpWorkerTurn"] = (
      controller,
    ) => {
      activeMcpWorkerTurns.delete(controller);
      for (const [key, controllers] of mcpWorkerTurnsByTask) {
        controllers.delete(controller);
        if (controllers.size === 0) mcpWorkerTurnsByTask.delete(key);
      }
    };
    const cancelMcpWorkerTurnsForTask: ServerServices["cancelMcpWorkerTurnsForTask"] =
      (sessionId, taskId) => {
        const key = taskKey(sessionId, taskId);
        for (const controller of mcpWorkerTurnsByTask.get(key) ?? []) {
          controller.abort();
        }
        mcpWorkerTurnsByTask.delete(key);
      };

    return {
      services: {
        ...whenDefined(agentDialogueService, (service) => ({ agentDialogueService: service })),
        hasSessionTaskRuntime,
        createJobRegistry,
        resourceArchitectStore,
        workflowArchitectTurnStore,
        providerSettingsService,
        mcpSettingsService,
        ...whenDefined(mcpInteractionService, (presentService) => ({ mcpInteractionService: presentService })),
        mcpAgentGrantsService,
        mcpAgentToolService,
        agentTextStreamHub,
        agentTextStreamDeltaTokens,
        agentTextStreamDeltaEndpoint,
        agentTextStreamLaunchPort: agentTextStreamLaunch.port,
        ...whenDefined(mcpResourceImportService, (presentService) => ({ mcpResourceImportService: presentService })),
        ...whenDefined(executionJournalInspection, (service) => ({ executionJournalInspection: service })),
        ...whenDefined(mcpWorkerTurnService, (presentService) => ({ mcpWorkerTurnService: presentService })),
        ...whenDefined(mcpWorkerTurnPath, (presentPath) => ({ mcpWorkerTurnPath: presentPath })),
        ...whenDefined(capabilityDispatchRuntime, (runtime) => ({ capabilityDispatchRuntime: runtime })),
        ...whenDefined(executionJournalRegistry, (registry) => ({ executionJournalRegistry: registry })),
        ...whenDefined(providerFailureHealth, (service) => ({ providerFailureHealth: service })),
        ...whenDefined(conversationJournalRegistry, (registry) => ({ conversationJournalRegistry: registry })),
        ...whenDefined(conversationJournalInspection, (service) => ({ conversationJournalInspection: service })),
        // Prompt assembly is synchronous and settings reads are not, so the
        // composition root hands the turn a sync lookup rather than the service.
        resolveConnectionKind: (provider: string) =>
          providerSettingsService.connectionKindFor(provider),
        toolContributions,
        ...whenDefined(deepResearchSettingsService, (presentService) => ({ deepResearchSettingsService: presentService })),
        authoritativeTaskLauncher,
        ...whenDefined(taskQueue, (presentTaskQueue) => ({ taskQueue: presentTaskQueue })),
        ...whenDefined(schedulingSettingsRuntime, (presentRuntime) => ({ schedulingSettingsRuntime: presentRuntime })),
        ...whenDefined(schedulingQueueRuntime, (presentRuntime) => ({ schedulingQueueRuntime: presentRuntime })),
        ...whenDefined(mcpWorkflowPreflightService, (presentService) => ({ mcpWorkflowPreflightService: presentService })),
        ...whenDefined(scheduleService, (presentService) => ({ scheduleService: presentService })),
        ...whenDefined(batchService, (presentService) => ({ batchService: presentService })),
        ...whenDefined(options.batchFolderGrantStore, (batchFolderGrantStore) => ({ batchFolderGrantStore })),
        ...whenDefined(sharedFolderGrantStore, (presentStore) => ({ sharedFolderGrantStore: presentStore })),
        ...whenDefined(sharedFolderService, (presentService) => ({ sharedFolderService: presentService })),
        ...whenDefined(workspaceProjectService, (presentService) => ({ workspaceProjectService: presentService })),
        ...whenDefined(workspaceProjectContextStore, (presentStore) => ({ workspaceProjectContextStore: presentStore })),
        ...whenDefined(workspaceProjectFileCatalogService, (presentService) => ({ workspaceProjectFileCatalogService: presentService })),
        ...whenDefined(workspaceProjectMemoryService, (presentService) => ({ workspaceProjectMemoryService: presentService })),
        ...whenDefined(workspaceProjectExportService, (presentService) => ({ workspaceProjectExportService: presentService })),
        ...whenDefined(workspaceProjectDetailsService, (presentService) => ({ workspaceProjectDetailsService: presentService })),
        ...whenDefined(resourceLibraryService, (service) => ({ resourceLibraryService: service })),
        ...whenDefined(voiceControl, (runtime) => ({ voiceControl: runtime })),
        trackMcpWorkerTurn,
        settleMcpWorkerTurn,
        cancelMcpWorkerTurnsForTask,
      },
      start: lifecycle.start,
      activateAfterListen: async (context) => {
        mcpWorkerTurnUrl = endpointUrl(
          context.baseUrl,
          mcpWorkerTurnPath,
        );
        toolEndpointUrls.clear();
        for (const contribution of toolContributions) {
          const endpoint = contribution.workerEndpoint;
          if (!endpoint) continue;
          const url = endpointUrl(context.baseUrl, endpoint.path);
          if (url) {
            toolEndpointUrls.set(endpoint.environmentVariable, url);
          }
        }
        await lifecycle.activateAfterListen(context);
      },
      beginShutdown: lifecycle.beginShutdown,
      dispose: lifecycle.dispose,
    };
  } catch (error) {
    // Construction failed, so nothing has been disposed yet; this set is
    // local to the unwind and never shared with the lifecycle's own.
    await disposeResources(
      resourcesInOwnershipOrder,
      new Set<LifecycleResource>(),
    ).catch(() => undefined);
    throw error;
  }
}

async function runActions<Context>(
  actions: readonly LifecycleAction<Context>[],
  context: Context,
): Promise<void> {
  for (const action of actions) {
    await action.run(context);
  }
}

/**
 * Dispose in reverse ownership order, continuing past a failure.
 *
 * Continuing matters: one resource that cannot close must not strand every
 * unrelated one behind it. Resources whose teardown genuinely depends on
 * another's success are bound into a single resource instead — see
 * `createRuntimeJournalOwnership`.
 *
 * `disposed` carries across retries so a second attempt closes only what had
 * not succeeded. Closing an already-closed resource is its own hazard, and a
 * retry exists to finish the job rather than repeat it.
 */
async function disposeResources(
  resourcesInOwnershipOrder: readonly LifecycleResource[],
  disposed: Set<LifecycleResource>,
  options?: { readonly deadlineMs?: number },
): Promise<void> {
  let firstError: unknown;
  for (const resource of [...resourcesInOwnershipOrder].reverse()) {
    if (disposed.has(resource)) continue;
    try {
      await resource.dispose(options);
      disposed.add(resource);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function randomPathToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * This process, for the audit trail on an operator resolution.
 *
 * Minted once per process rather than per composition, because that is what it
 * claims to identify. Not a secret and never used as one: it distinguishes two
 * runs of the same server in a journal read months later, which is as much as
 * a shared-secret transport can honestly say about who acted.
 */
const OPERATOR_PROCESS_INSTANCE_ID = randomBytes(8).toString("hex");

function endpointUrl(
  baseUrl: string,
  endpointPath: string | undefined,
): string | undefined {
  return endpointPath ? `${baseUrl}${endpointPath}` : undefined;
}

function taskKey(sessionId: string, taskId: string): string {
  return `${sessionId}\0${taskId}`;
}

/**
 * Operational override for same-turn read fan-out. `1` is the rollback switch:
 * it reproduces sequential execution without a redeploy. Values outside
 * `1..MAX_CONCURRENT_TOOL_CALLS_CEILING` are ignored so a typo falls back to
 * the loop default instead of failing every turn.
 */
export function configuredMaxConcurrentToolCalls(
  configuredValue = process.env.PIPELINE_MAX_CONCURRENT_TOOL_CALLS,
): number | undefined {
  const configured = Number(configuredValue ?? "");
  if (
    !Number.isSafeInteger(configured) ||
    configured < 1 ||
    configured > MAX_CONCURRENT_TOOL_CALLS_CEILING
  ) {
    return undefined;
  }
  return configured;
}

/**
 * The production journal-inspection policy.
 *
 * Reads admit what the transport already admitted: the loopback API accepts a
 * request only when it carries the launch token in its path, and the broker
 * credential is refused every route but provider-execute.
 *
 * Resolutions are different, and this is the check that makes the difference
 * real. A resolution decides what the next dispatch on an identity does, so it
 * requires the full-scope credential to have been resolved for *this* request.
 * A server started with no token — `startDefaultApiServer` is one — never
 * authenticates anyone, so no scope is resolved and the write path is shut.
 * That is the whole of AC11a's prerequisite: the endpoint cannot be reached
 * unauthenticated, because there is nothing to reach it with.
 *
 * One policy covers both operator surfaces. The subject of the request is
 * discriminated — an assignment scope or a conversation scope — so the rule
 * that differs for conversation reads is stated here rather than in a second
 * authority that could drift away from this one.
 */
export const TRANSPORT_AUTHENTICATED_JOURNAL_AUTHORITY = Object.freeze({
  authorize: async (
    request: ExecutionJournalAuthorizationRequest,
  ): Promise<boolean> => {
    if (request.action === "resolve") return request.credentialScope === "full";
    // A conversation lifecycle report is content-free but not fact-free: it
    // says which conversations exist and how their turns ended. `broker` is
    // the narrow credential a worker holds so it can reach the credential
    // broker, and that is not its business.
    if ("conversationScope" in request) {
      return request.credentialScope !== "broker";
    }
    return true;
  },
});

/**
 * Re-exported from the registry module, where it now lives so the task-worker
 * process can resolve the same flag without importing the composition root.
 */
export { resolveExecutionJournalOptions };
