import { whenDefined } from "../../core/optional-properties.js"
import * as path from "node:path";

import {
  YOUTUBE_TOOL_URL_ENV,
} from "../../domains/youtube/youtube-types.js";
import { YoutubeSettingsService } from "../../services/youtube-settings-service.js";
import type { YoutubeSettingsServiceOptions } from "../../services/youtube-settings-service.js";
import { YoutubeToolService } from "../../services/youtube-tool-service.js";
import type { YoutubeToolServiceOptions } from "../../services/youtube-tool-service.js";
import {
  YOUTUBE_BUILTIN_SOURCE,
  YoutubeCapabilityDispatchGateway,
  type YoutubeCapabilityDispatchInvoker,
  type YoutubeCapabilityService,
} from "../../services/youtube-capability-adapter.js";
import { YoutubeGeminiUsageLedger } from "../../services/youtube-gemini-usage-ledger.js";
import { handleYoutubeSettingsRoutes } from "../routes/youtube-settings.js";
import { handleYoutubeToolRoute } from "../routes/youtube-tool.js";
import type { RouteRegistration } from "../routing.js";
import type {
  BuiltinAgentToolAdapter,
  ToolContribution,
  ToolDeps,
  ToolModule,
  WorkerEndpointInput,
} from "./tool-registry.js";

export const YOUTUBE_TOOL_PATH_PREFIX = "/_pipeline-youtube/";
export const YOUTUBE_TOOL_MODULE_NAME = "youtube";

export interface YoutubeToolModuleServices {
  readonly youtubeSettingsService?: YoutubeSettingsService;
  readonly youtubeToolService?: YoutubeCapabilityService;
}

export interface YoutubeToolModuleOptions {
  readonly settingsService?: YoutubeSettingsService;
  readonly settingsOptions?: YoutubeSettingsServiceOptions;
  readonly toolService?: YoutubeCapabilityService;
  readonly endpoint?: WorkerEndpointInput;
  readonly binaries?: {
    readonly ytDlpPath: string;
    readonly ffmpegPath: string;
    readonly ffprobePath: string;
    readonly ytDlpVersion?: string;
    readonly ytDlpSha256?: string;
    readonly ffmpegVersion?: string;
    readonly ffmpegSha256?: string;
    readonly ffprobeVersion?: string;
    readonly ffprobeSha256?: string;
  };
  /** Why binary resolution rejected, when the desktop host reported one. */
  readonly binariesUnavailableReason?: string;
  readonly resolveMediaTools?: YoutubeToolServiceOptions['resolveMediaTools'];
}

declare module "./tool-registry.js" {
  interface ToolModuleOptions {
    readonly [YOUTUBE_TOOL_MODULE_NAME]?: YoutubeToolModuleOptions;
  }
}

export const youtubeToolModule: ToolModule<YoutubeToolModuleServices> = {
  name: YOUTUBE_TOOL_MODULE_NAME,
  optionKeys: [
    "settingsService",
    "settingsOptions",
    "toolService",
    "endpoint",
    "binaries",
    "binariesUnavailableReason",
    "resolveMediaTools",
  ],
  build(deps): ToolContribution<YoutubeToolModuleServices> {
    const options = deps.moduleOptions?.[YOUTUBE_TOOL_MODULE_NAME];
    const youtubeSettingsService =
      options?.settingsService ??
      new YoutubeSettingsService({
        ...options?.settingsOptions,
        ...whenDefined(options?.settingsOptions?.storagePath ??
          (deps.workspacePath
            ? path.join(
                deps.workspacePath,
                ".settings",
                "youtube-settings.json",
              )
            : undefined), (definedValue) => ({ storagePath: definedValue })),
      });
    const youtubeToolService =
      options?.toolService ??
      (deps.workspacePath && youtubeSettingsService
        ? new YoutubeToolService({
            workspacePath: deps.workspacePath,
            settings: youtubeSettingsService,
            youtubeUsageLedger: new YoutubeGeminiUsageLedger({
              storagePath: path.join(
                deps.workspacePath,
                ".settings",
                "youtube-gemini-usage.json",
              ),
            }),
            ...whenDefined(deps.browserManager, (definedValue) => ({ browserManager: definedValue })),
            ...(options?.binaries ? { youtubeBinaries: options.binaries } : {}),
            ...(options?.binariesUnavailableReason
              ? { binariesUnavailableReason: options.binariesUnavailableReason }
              : {}),
            ...whenDefined(options?.resolveMediaTools, (resolveMediaTools) => ({ resolveMediaTools })),
          })
        : undefined);
    const capabilityPath = resolveEndpointPath(
      options?.endpoint ??
        (deps.createWorkerEndpointToken
          ? { token: deps.createWorkerEndpointToken("youtube") }
          : undefined),
    );
    const dispatchInvoker =
      youtubeToolService && deps.capabilityDispatcher
        ? new YoutubeCapabilityDispatchGateway({
            dispatcher: deps.capabilityDispatcher,
            service: youtubeToolService,
          })
        : undefined;
    const routes: RouteRegistration[] = [];

    routes.push({
      id: "youtube-settings",
      stage: "api",
      authorization: "api",
      streaming: "none",
      methods: ["GET", "PATCH", "POST"],
      path: {
        kind: "pattern",
        pattern: "^/settings/youtube(?:/validate|/gemini/(?:validate|models))?$",
      },
      handler: ({ req, res, url }) =>
        handleYoutubeSettingsRoutes({
          req,
          res,
          url,
          service: youtubeSettingsService,
        }),
    });
    if (
      dispatchInvoker &&
      deps.runtimeCapabilityAuthority &&
      capabilityPath
    ) {
      routes.push(capabilityRoute(
        capabilityPath,
        dispatchInvoker,
        deps.runtimeCapabilityAuthority,
      ));
    }

    return {
      services: {
        youtubeSettingsService,
        ...(youtubeToolService ? { youtubeToolService } : {}),
      },
      routeOrder: 2,
      agentToolOrder: 2,
      routes,
      ...(dispatchInvoker && deps.runtimeCapabilityAuthority && capabilityPath
        ? {
            workerEndpoint: {
              environmentVariable: YOUTUBE_TOOL_URL_ENV,
              path: capabilityPath,
            },
          }
        : {}),
      ...(youtubeToolService && dispatchInvoker
        ? { agentTool: agentToolAdapter(youtubeToolService, dispatchInvoker) }
        : {}),
    };
  },
};

function capabilityRoute(
  capabilityPath: string,
  invoker: YoutubeCapabilityDispatchInvoker,
  authority: NonNullable<ToolDeps['runtimeCapabilityAuthority']>,
): RouteRegistration {
  return {
    id: "youtube-tool-capability",
    stage: "pre-auth-capability",
    authorization: "capability",
    streaming: "none",
    methods: ["POST"],
    path: { kind: "exact", path: capabilityPath },
    handler: async ({ req, res, url }) => {
      if (url.pathname !== capabilityPath || url.search) return false;
      await handleYoutubeToolRoute({ req, res, invoker, authority });
      return true;
    },
  };
}

function agentToolAdapter(
  service: YoutubeCapabilityService,
  invoker: YoutubeCapabilityDispatchInvoker,
): BuiltinAgentToolAdapter {
  return {
    name: service.tool.namespacedName,
    tool: service.tool,
    isEnabledForAgent: (agentPath) => service.isEnabledForAgent(agentPath),
    execute: async ({ context, toolCallId, input, signal }) => {
      const output = await invoker.execute({
        context,
        authority: { kind: "mcp-lease", leaseId: context.leaseId },
        source: YOUTUBE_BUILTIN_SOURCE,
        toolCallId,
        input,
        ...(signal ? { signal } : {}),
      });
      return {
        output,
        content: JSON.stringify(output),
        isError: !output.ok,
      };
    },
  };
}

function resolveEndpointPath(input: WorkerEndpointInput | undefined): string | undefined {
  if (!input) return undefined;
  if (input.path && input.token) {
    throw new Error("YouTube endpoint accepts either path or token, not both");
  }
  const value = input.path ??
    (input.token ? `${YOUTUBE_TOOL_PATH_PREFIX}${input.token}` : undefined);
  if (
    !value ||
    !value.startsWith(YOUTUBE_TOOL_PATH_PREFIX) ||
    value.length === YOUTUBE_TOOL_PATH_PREFIX.length ||
    value.slice(YOUTUBE_TOOL_PATH_PREFIX.length).includes("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("YouTube endpoint path is invalid");
  }
  return value;
}
