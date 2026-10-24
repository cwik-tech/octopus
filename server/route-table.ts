import type { ApiServerOptions } from "./api-types.js";
import type { ServerServices } from "./composition.js";
import { handleAgentTextStreamIngestRoute } from "./routes/agent-text-stream-ingest.js";
import { APP_MCP_PATH } from "./voice-control/app-mcp-endpoint.js";
import { AGENT_TEXT_STREAM_INGEST_PATH } from "../domains/runtime/agent-text-delta-tokens.js";
import { whenDefined } from "../core/optional-properties.js";
import { handleAgentRoutes } from "./routes/agents.js";
import {
  handleCreateNotFoundRoute,
  handleCreateSupportRoutes,
} from "./routes/create-support.js";
import { handleResourceArchitectRoutes } from "./routes/resource-architect.js";
import { handleDeepResearchSettingsRoutes } from "./routes/deep-research-settings.js";
import { handleMcpAgentGrantRoutes } from "./routes/mcp-agent-grants.js";
import { handleMcpInteractionRoutes } from "./routes/mcp-interactions.js";
import { handleExecutionJournalRoutes } from "./routes/execution-journals.js";
import { handleMcpResourceRoutes } from "./routes/mcp-resources.js";
import { handleMcpSettingsRoutes } from "./routes/mcp-settings.js";
import { handleMcpWorkerTurnRoute } from "./routes/mcp-worker-turn.js";
import { handleProviderSettingsRoutes } from "./routes/provider-settings.js";
import { handleProjectRoutes } from "./routes/projects.js";
import { handleResourceLibraryRoutes } from "./routes/resource-library.js";
import {
  handleRunCollectionRoutes,
  handleRunDetailRoutes,
} from "./routes/runs.js";
import { handleSchedulesRoutes } from "./routes/schedules.js";
import { handleBatchesRoutes } from "./routes/batches.js";
import { handleBatchFolderGrantRoutes } from "./routes/batch-folder-grants.js";
import { handleSharedFolderGrantRoutes } from "./routes/shared-folder-grants.js";
import { handleSchedulingQueueRoutes } from "./routes/scheduling-queue.js";
import { handleSchedulingSettingsRoutes } from "./routes/scheduling-settings.js";
import { handleSessionRoutes } from "./routes/sessions.js";
import { handleTeamBuilderRoutes } from "./routes/team-builder.js";
import { handleTeamFilesRoutes } from "./routes/team-files.js";
import { handleTeamMetadataRoute } from "./routes/team-metadata.js";
import { handleWorkflowRoutes } from "./routes/workflows.js";
import {
  projectRouteInventory,
  type RouteHandler,
  type RouteInventoryEntry,
  type RoutePathDescription,
  type RouteRegistration,
} from "./routing.js";

export interface ApiRouteServices {
  readonly options: ApiServerOptions;
  readonly composition: ServerServices;
  readonly eventPollIntervalMs: number;
  readonly resourceArchitectReviewEnabled?: boolean;
}

export type ApiRouteRegistration = RouteRegistration<ApiRouteServices>;

export function createApiRouteTable(
  routeServices: ApiRouteServices,
): readonly ApiRouteRegistration[] {
  const routes: ApiRouteRegistration[] = [];
  const services = routeServices.composition;

  addCapabilityRoute(routes, {
    id: "mcp-worker-turn-capability",
    available: Boolean(services.mcpWorkerTurnService),
    ...whenDefined(services.mcpWorkerTurnPath, (path) => ({ path })),
    handler: async ({ req, res, services: contextServices }) => {
      const runtime = contextServices.composition;
      if (!runtime.mcpWorkerTurnService) return false;
      await handleMcpWorkerTurnRoute({
        req,
        res,
        service: runtime.mcpWorkerTurnService,
        onActiveController: runtime.trackMcpWorkerTurn,
        onSettledController: runtime.settleMcpWorkerTurn,
      });
      return true;
    },
  });
  // Authorized by a header rather than by the token-in-path scheme, because
  // this credential must never travel in a URL. It is registered only when a
  // token registry exists, so a deployment without one has no endpoint at all
  // rather than an unguarded one.
  addCapabilityRoute(routes, {
    id: "agent-text-stream-ingest",
    available: Boolean(services.agentTextStreamDeltaTokens),
    path: AGENT_TEXT_STREAM_INGEST_PATH,
    handler: async ({ req, res, services: contextServices }) => {
      const runtime = contextServices.composition;
      if (!runtime.agentTextStreamDeltaTokens) return false;
      await handleAgentTextStreamIngestRoute({
        req,
        res,
        hub: runtime.agentTextStreamHub,
        tokens: runtime.agentTextStreamDeltaTokens,
      });
      return true;
    },
  });
  // Authorized by its own bearer header, not the token-in-path scheme, and
  // registered only when voice control is configured, so a server without it
  // has no endpoint at all (docs/adr/2026-10-09-Voice-Control-Through-MCP.md).
  if (services.voiceControl) {
    routes.push(
      route({
        id: "voice-control-mcp",
        stage: "pre-auth-capability",
        authorization: "capability",
        streaming: "mixed",
        methods: ["POST", "GET", "DELETE"],
        path: exact(APP_MCP_PATH),
        handler: ({ req, res, url, services: contextServices }) =>
          contextServices.composition.voiceControl?.endpoint.handle(req, res, url) ??
            false,
      }),
    );
  }
  routes.push(...toolRoutesForStage(services, "pre-auth-capability"));

  routes.push(
    apiRoute({
      id: "deep-research-settings",
      methods: ["GET", "PATCH"],
      path: exact("/settings/deep-research"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleDeepResearchSettingsRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.deepResearchSettingsService, (runtime) => ({ runtime })),
        }),
    }),
    apiRoute({
      id: "scheduling-settings",
      methods: ["GET", "PATCH"],
      path: exact("/settings/scheduling"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleSchedulingSettingsRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.schedulingSettingsRuntime, (runtime) => ({ runtime })),
        }),
    }),
    // Both grant lists in Settings: Batch's and the shared folders' own. One
    // entry with two exact paths, recorded as reviewed drift in
    // tests/unit/api-route-table.test.ts, so no route after it is renumbered.
    apiRoute({
      id: "batch-folder-grants",
      methods: ["GET", "DELETE"],
      path: pattern("^/settings/(?:batch|shared)-folder-grants$"),
      handler: async ({ req, res, url, services: contextServices }) =>
        await handleBatchFolderGrantRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.batchFolderGrantStore, (runtime) => ({ runtime })),
        }) ||
        handleSharedFolderGrantRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.sharedFolderGrantStore, (runtime) => ({ runtime })),
        }),
    }),
  );
  routes.push(...toolRoutesForStage(services, "api"));
  routes.push(
    apiRoute({
      id: "scheduling-queue",
      methods: ["GET"],
      path: exact("/scheduling/queue"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleSchedulingQueueRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.schedulingQueueRuntime, (runtime) => ({ runtime })),
        }),
    }),
    apiRoute({
      id: "schedules",
      methods: ["GET", "POST", "PATCH", "DELETE"],
      path: pattern("^/schedules(?:/.*)?$"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleSchedulesRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.scheduleService, (runtime) => ({ runtime })),
        }),
    }),
    apiRoute({
      id: "batches",
      methods: ["GET", "POST", "PATCH", "DELETE"],
      path: pattern("^/batches(?:/.*)?$"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleBatchesRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.batchService, (runtime) => ({ runtime })),
        }),
    }),
    apiRoute({
      id: "provider-execute",
      authorization: "api-or-broker",
      methods: ["POST"],
      path: exact("/settings/provider-execute"),
      handler: ({ req, res, url, services: contextServices }) => {
        if (url.pathname !== "/settings/provider-execute") return false;
        return handleProviderSettingsRoutes({
          req,
          res,
          url,
          service: contextServices.composition.providerSettingsService,
        });
      },
    }),
    apiRoute({
      id: "provider-settings",
      methods: ["GET", "POST", "PATCH", "DELETE"],
      path: pattern(
        "^/settings/(?:providers(?:/[^/]+(?:/(?:validate|models))?)?|model-catalog|default-model|cli(?:/refresh|/[^/]+(?:/models)?))$",
      ),
      handler: ({ req, res, url, services: contextServices }) => {
        if (url.pathname === "/settings/provider-execute") return false;
        return handleProviderSettingsRoutes({
          req,
          res,
          url,
          service: contextServices.composition.providerSettingsService,
        });
      },
    }),
    apiRoute({
      id: "mcp-settings",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      path: pattern("^/settings/mcps(?:/.*)?$"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleMcpSettingsRoutes({
          req,
          res,
          url,
          service: contextServices.composition.mcpSettingsService,
        }),
    }),
    apiRoute({
      id: "execution-journals",
      methods: ["GET", "POST"],
      path: pattern(
        "^/execution-journals(?:/[^/]+/[^/]+/[^/]+(?:/resolutions)?)?$",
      ),
      handler: ({ req, res, url, credentialScope, services: contextServices }) =>
        handleExecutionJournalRoutes({
          req,
          res,
          url,
          ...whenDefined(
            contextServices.composition.executionJournalInspection,
            (service) => ({ service }),
          ),
          ...whenDefined(
            contextServices.composition.conversationJournalInspection,
            (conversations) => ({ conversations }),
          ),
          // The operator resolution write records which credential admitted
          // it, and refuses when the transport admitted nobody.
          ...whenDefined(credentialScope, (scope) => ({ credentialScope: scope })),
        }),
    }),
    apiRoute({
      id: "mcp-resources",
      methods: ["GET", "POST"],
      path: pattern(
        "^/sessions/[^/]+/mcp-resources(?:/imports)?$",
      ),
      handler: ({ req, res, url, services: contextServices }) =>
        handleMcpResourceRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.mcpResourceImportService, (service) => ({ service })),
        }),
    }),
    apiRoute({
      id: "mcp-interactions",
      methods: ["GET", "POST"],
      path: pattern(
        "^/sessions/[^/]+/mcp-interactions(?:/[^/]+/respond)?$",
      ),
      handler: ({ req, res, url, services: contextServices }) =>
        handleMcpInteractionRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.mcpInteractionService, (service) => ({ service })),
          ...whenDefined(contextServices.options.sessionStore, (sessionStore) => ({ sessionStore })),
        }),
    }),
    apiRoute({
      id: "run-collection",
      methods: ["GET", "POST"],
      path: exact("/runs"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleRunCollectionRoutes({
          req,
          res,
          url,
          options: runRoutesOptions(contextServices),
        }),
    }),
    apiRoute({
      id: "workflows",
      methods: ["GET", "POST", "PATCH", "DELETE"],
      path: pattern(
        "^(?:/workflows(?:/[^/]+)?|/create/(?:teams|turn|validate-yaml|save))$",
      ),
      handler: ({ req, res, url, services: contextServices }) =>
        handleWorkflowRoutes({
          req,
          res,
          url,
          options: {
            createJobRegistry:
              contextServices.composition.createJobRegistry,
            workflowArchitectTurnStore:
              contextServices.composition.workflowArchitectTurnStore,
            isAbortLike,
            ...whenDefined(contextServices.options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
            ...whenDefined(contextServices.options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
            ...whenDefined(contextServices.composition.agentTextStreamHub, (agentTextStreamHub) => ({ agentTextStreamHub })),
            ...whenDefined(contextServices.options.agentTextStreamWaitMs, (agentTextStreamWaitMs) => ({ agentTextStreamWaitMs })),
          },
        }),
    }),
    apiRoute({
      id: "create-support",
      methods: ["GET", "POST"],
      path: routeServices.options.repoRootPath
        ? pattern(
            "^/create/(?:jobs/[^/]+/cancel|reveal-artifact|chat-defaults)$",
          )
        : prefix("/create/"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleCreateSupportRoutes({
          req,
          res,
          url,
          options: {
            createJobRegistry:
              contextServices.composition.createJobRegistry,
            providerSettingsService:
              contextServices.composition.providerSettingsService,
            ...whenDefined(contextServices.options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
            ...whenDefined(contextServices.options.workspacePath, (workspacePath) => ({ workspacePath })),
          },
        }),
    }),
    apiRoute({
      id: "resource-architect",
      methods: ["GET", "POST"],
      path: pattern(
        "^/create/resource-architect/(?:turn|metrics|jobs(?:/[^/]+(?:/retry|/discard)?)?|plans/[^/]+/shape)$",
      ),
      handler: ({ req, res, url, services: contextServices }) =>
        handleResourceArchitectRoutes({
          req,
          res,
          url,
          options: {
            createJobRegistry:
              contextServices.composition.createJobRegistry,
            resourceArchitectStore:
              contextServices.composition.resourceArchitectStore,
            ...whenDefined(contextServices.composition.resourceLibraryService, (resourcePublisher) => ({ resourcePublisher })),
            reviewEnabled: contextServices.resourceArchitectReviewEnabled ?? true,
            ...whenDefined(contextServices.composition.conversationJournalRegistry, (conversationJournalRegistry) => ({ conversationJournalRegistry })),
            isAbortLike,
            ...whenDefined(contextServices.options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
            ...whenDefined(contextServices.options.teamFileStore, (teamFileStore) => ({ teamFileStore })),
            ...whenDefined(contextServices.options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
            ...whenDefined(contextServices.composition.mcpAgentGrantsService ?? undefined, (mcpAgentGrants) => ({ mcpAgentGrants })),
            ...whenDefined(contextServices.composition.resolveConnectionKind, (resolveConnectionKind) => ({ resolveConnectionKind })),
            ...whenDefined(contextServices.composition.agentTextStreamHub, (agentTextStreamHub) => ({ agentTextStreamHub })),
            ...whenDefined(contextServices.options.agentTextStreamWaitMs, (agentTextStreamWaitMs) => ({ agentTextStreamWaitMs })),
          },
        }),
    }),
    apiRoute({
      id: "team-builder",
      methods: ["GET", "POST", "PUT", "DELETE"],
      path: pattern(
        "^/create/team-builder/teams(?:/[^/]+(?:/agents(?:/[^/]+)?|/shape)?)?$",
      ),
      handler: ({ req, res, url, services: contextServices }) => {
        // Handlers run in turn until one claims the request, so an unset root
        // must decline rather than fail every request that reaches this one.
        // A /create/* request never gets here without it: create-support
        // answers those first.
        const repoRootPath = contextServices.options.repoRootPath;
        if (!repoRootPath) return false;
        return handleTeamBuilderRoutes({
          req,
          res,
          url,
          options: {
            repoRootPath,
            ...whenDefined(contextServices.composition.resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
            ...whenDefined(contextServices.composition.providerFailureHealth, (providerFailureHealth) => ({ providerFailureHealth })),
          },
        });
      },
    }),
    apiRoute({
      id: "team-files",
      methods: ["GET", "POST", "DELETE"],
      path: pattern(
        "^/create/team-files/[^/]+/files(?:/[^/]+)?$",
      ),
      handler: ({ req, res, url, services: contextServices }) => {
        if (!contextServices.options.teamFileStore) return false;
        return handleTeamFilesRoutes({
          req,
          res,
          url,
          options: {
            teamFileStore: contextServices.options.teamFileStore,
            ...whenDefined(contextServices.options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
          },
        });
      },
    }),
    apiRoute({
      id: "mcp-agent-grants",
      methods: ["GET", "PATCH"],
      path: pattern("^/create/agents/[^/]+/mcp-grants$"),
      handler: ({ req, res, url, services: contextServices }) => {
        const service =
          contextServices.composition.mcpAgentGrantsService;
        if (!service) return false;
        return handleMcpAgentGrantRoutes({ req, res, url, service });
      },
    }),
    apiRoute({
      id: "agents",
      methods: ["GET", "POST", "DELETE"],
      path: pattern(
        "^/create/agents(?:$|/(?:teams|health|list-skills|draft|commit|refine|save|delete|add-to-team|package/(?:add|import-preview|import|remove)|[^/]+(?:/delete-preview)?))$",
      ),
      handler: ({ req, res, url, services: contextServices }) => {
        // Handlers run in turn until one claims the request, so an unset root
        // must decline rather than fail every request that reaches this one.
        // A /create/* request never gets here without it: create-support
        // answers those first.
        const repoRootPath = contextServices.options.repoRootPath;
        if (!repoRootPath) return false;
        return handleAgentRoutes({
          req,
          res,
          url,
          options: {
            repoRootPath,
            createJobRegistry:
              contextServices.composition.createJobRegistry,
            isAbortLike,
            providerSettingsService:
              contextServices.composition.providerSettingsService,
            ...whenDefined(contextServices.composition.providerFailureHealth, (providerFailureHealth) => ({ providerFailureHealth })),
            ...whenDefined(contextServices.composition.mcpAgentGrantsService ?? undefined, (mcpAgentGrantsService) => ({ mcpAgentGrantsService })),
            ...whenDefined(contextServices.composition.resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
          },
        });
      },
    }),
    apiRoute({
      id: "create-not-found",
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      path: prefix("/create/"),
      handler: ({ res, url }) =>
        handleCreateNotFoundRoute({ res, url }),
    }),
    apiRoute({
      id: "team-metadata",
      methods: ["GET"],
      path: pattern("^/(?:api/)?team$"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleTeamMetadataRoute({
          req,
          res,
          url,
          ...whenDefined(contextServices.options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
        }),
    }),
    apiRoute({
      id: "resource-library",
      methods: ["GET", "POST", "PATCH", "DELETE"],
      path: pattern("^/resource-library(?:$|/.*$)"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleResourceLibraryRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.resourceLibraryService, (service) => ({ service })),
        }),
    }),
    apiRoute({
      id: "projects",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      path: pattern("^/projects(?:$|/.*$)"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleProjectRoutes({
          req,
          res,
          url,
          ...whenDefined(contextServices.composition.workspaceProjectService, (service) => ({ service })),
          ...whenDefined(contextServices.composition.workspaceProjectContextStore, (contextStore) => ({ contextStore })),
          ...whenDefined(contextServices.composition.workspaceProjectFileCatalogService, (catalogService) => ({ catalogService })),
          ...whenDefined(contextServices.composition.workspaceProjectMemoryService, (memoryService) => ({ memoryService })),
          ...whenDefined(contextServices.composition.workspaceProjectExportService, (exportService) => ({ exportService })),
          ...whenDefined(contextServices.composition.workspaceProjectDetailsService, (detailsService) => ({ detailsService })),
          ...whenDefined(contextServices.options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
          ...whenDefined(contextServices.composition.sharedFolderService, (sharedFolderService) => ({ sharedFolderService })),
        }),
    }),
    apiRoute({
      id: "sessions",
      // This prefix route stands in front of two SSE endpoints — the
      // agent-chat text stream and Deep Research planning — and a good many
      // plain-JSON ones. `"sse"` would claim the JSON endpoints stream and
      // `"none"` denies the two that do, so neither is accurate: hence
      // `"mixed"`. The pinned inventory in
      // `tests/fixtures/api/pre-route-table-inventory.json` still records
      // `"none"`, and is left alone because its `derivedFrom` is a provenance
      // claim about a specific commit. `tests/unit/api-route-table.test.ts`
      // carries this divergence as a reviewed, dated entry instead.
      streaming: "mixed",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      path: pattern("^/sessions(?:$|/.*$)"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleSessionRoutes({
          req,
          res,
          url,
          options: {
            onTaskCancellationRequested:
              contextServices.composition.cancelMcpWorkerTurnsForTask,
            ...whenDefined(contextServices.composition.resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
            ...whenDefined(contextServices.composition.agentDialogueService, (service) => ({ agentDialogueService: service })),
            ...whenDefined(contextServices.options.sessionStore, (sessionStore) => ({ sessionStore })),
            ...whenDefined(contextServices.composition.executionJournalRegistry, (executionJournalRegistry) => ({ executionJournalRegistry })),
            ...whenDefined(contextServices.composition.providerFailureHealth, (providerFailureHealth) => ({ providerFailureHealth })),
            ...whenDefined(contextServices.composition.conversationJournalRegistry, (conversationJournalRegistry) => ({ conversationJournalRegistry })),
            ...whenDefined(contextServices.composition.resolveConnectionKind, (resolveConnectionKind) => ({ resolveConnectionKind })),
            runStore: contextServices.options.store,
            ...whenDefined(contextServices.composition.workspaceProjectService, (workspaceProjectService) => ({ workspaceProjectService })),
            ...whenDefined(contextServices.composition.workspaceProjectContextStore, (workspaceProjectContextStore) => ({ workspaceProjectContextStore })),
            ...whenDefined(contextServices.composition.taskQueue, (taskQueue) => ({ taskQueue })),
            ...whenDefined(contextServices.composition.authoritativeTaskLauncher, (taskLauncher) => ({ taskLauncher })),
            ...whenDefined(contextServices.options.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
            ...whenDefined(contextServices.options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
            ...whenDefined(contextServices.options.repoRootPath, (repoRootPath) => ({ repoRootPath })),
            ...whenDefined(contextServices.options.workspacePath, (workspacePath) => ({ workspacePath })),
            ...whenDefined(contextServices.composition.mcpAgentToolService, (mcpAgentToolService) => ({ mcpAgentToolService })),
            ...whenDefined(contextServices.composition.sharedFolderService, (sharedFolderService) => ({ sharedFolderService })),
            ...whenDefined(contextServices.composition.agentTextStreamHub, (agentTextStreamHub) => ({ agentTextStreamHub })),
            ...whenDefined(contextServices.composition.mcpWorkflowPreflightService, (mcpWorkflowPreflightService) => ({ mcpWorkflowPreflightService })),
            ...whenDefined(contextServices.composition.mcpResourceImportService, (mcpResourceImportService) => ({ mcpResourceImportService })),
            ...whenDefined(contextServices.composition.deepResearchSettingsService, (deepResearchSettings) => ({ deepResearchSettings })),
            ...whenDefined(contextServices.options.deepResearchPlanRunner, (deepResearchPlanRunner) => ({ deepResearchPlanRunner })),
            ...whenDefined(contextServices.options.deepResearchPlanningHeartbeatMs, (deepResearchPlanningHeartbeatMs) => ({ deepResearchPlanningHeartbeatMs })),
            ...whenDefined(contextServices.options.agentTextStreamWaitMs, (agentTextStreamWaitMs) => ({ agentTextStreamWaitMs })),
          },
        }),
    }),
    apiRoute({
      id: "run-events",
      methods: ["GET"],
      path: pattern("^/runs/[^/]+/events$"),
      streaming: "sse",
      handler: ({ req, res, url, services: contextServices }) => {
        if (!/^\/runs\/[^/]+\/events$/.test(url.pathname)) return false;
        return handleRunDetailRoutes({
          req,
          res,
          url,
          options: runRoutesOptions(contextServices),
        });
      },
    }),
    apiRoute({
      id: "run-details",
      methods: ["GET"],
      path: pattern("^/runs/[^/]+(?:/.*)?$"),
      handler: ({ req, res, url, services: contextServices }) =>
        handleRunDetailRoutes({
          req,
          res,
          url,
          options: runRoutesOptions(contextServices),
        }),
    }),
  );

  return Object.freeze(routes);
}

export function createApiRouteInventory(
  routeServices: ApiRouteServices,
): readonly RouteInventoryEntry[] {
  const projected = projectRouteInventory(
    createApiRouteTable(routeServices),
  );
  const capabilityCount = projected.findIndex(
    (entry) => entry.stage === "api",
  );
  const insertionIndex =
    capabilityCount === -1 ? projected.length : capabilityCount;
  const healthEntry: RouteInventoryEntry = Object.freeze({
    order: insertionIndex,
    id: "health",
    stage: "api",
    authorization: "api",
    streaming: "none",
    methods: Object.freeze(["GET"]),
    path: Object.freeze({ kind: "exact", path: "/health" }),
  });
  return Object.freeze([
    ...projected.slice(0, insertionIndex),
    healthEntry,
    ...projected.slice(insertionIndex).map((entry) =>
      Object.freeze({
        ...entry,
        order: entry.order + 1,
      }),
    ),
  ]);
}

function addCapabilityRoute(
  routes: ApiRouteRegistration[],
  params: {
    readonly id: string;
    readonly path?: string;
    readonly available: boolean;
    readonly handler: RouteHandler<ApiRouteServices>;
  },
): void {
  if (!params.available || !params.path) return;
  const capabilityPath = params.path;
  routes.push(
    route({
      id: params.id,
      stage: "pre-auth-capability",
      authorization: "capability",
      streaming: "none",
      methods: ["POST"],
      path: exact(capabilityPath),
      handler: async (context) => {
        if (
          context.url.pathname !== capabilityPath ||
          context.url.search !== ""
        ) {
          return false;
        }
        return params.handler(context);
      },
    }),
  );
}

function toolRoutesForStage(
  services: ServerServices,
  stage: ApiRouteRegistration["stage"],
): readonly ApiRouteRegistration[] {
  return [...services.toolContributions]
    .sort(
      (left, right) =>
        (left.routeOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.routeOrder ?? Number.MAX_SAFE_INTEGER),
    )
    .flatMap((contribution) => contribution.routes)
    .filter((registration) => registration.stage === stage)
    .map((registration) =>
      route({
        ...registration,
        handler: (context) => registration.handler(context),
      }),
    );
}

function apiRoute(
  params: Omit<ApiRouteRegistration, "stage" | "authorization" | "streaming"> &
    Partial<
      Pick<
        ApiRouteRegistration,
        "authorization" | "streaming"
      >
    >,
): ApiRouteRegistration {
  return route({
    ...params,
    stage: "api",
    authorization: params.authorization ?? "api",
    streaming: params.streaming ?? "none",
  });
}

function route(
  registration: ApiRouteRegistration,
): ApiRouteRegistration {
  return Object.freeze({
    ...registration,
    methods: Object.freeze([...registration.methods]),
    path: Object.freeze({ ...registration.path }),
  });
}

function exact(path: string): RoutePathDescription {
  return { kind: "exact", path };
}

function prefix(value: string): RoutePathDescription {
  return { kind: "prefix", prefix: value };
}

function pattern(value: string): RoutePathDescription {
  return { kind: "pattern", pattern: value };
}

function runRoutesOptions(services: ApiRouteServices) {
  return {
    store: services.options.store,
    launcher: services.options.launcher,
    eventPollIntervalMs: services.eventPollIntervalMs,
    hasSessionTaskRuntime:
      services.composition.hasSessionTaskRuntime,
    ...whenDefined(services.options.workspacePath, (workspacePath) => ({ workspacePath })),
  };
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
