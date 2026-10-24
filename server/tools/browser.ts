import { whenDefined } from "../../core/optional-properties.js"
import * as path from "node:path";

import type { BrowserManager } from "../../domains/browser/browser-manager.js";
import {
  BROWSER_SERVER_ID,
  BROWSER_TOOL_CONTRACT_VERSION,
  BROWSER_TOOL_URL_ENV,
} from "../../domains/browser/browser-types.js";
import {
  BrowserCapabilityDispatchGateway,
  type BrowserCapabilityDispatchInvoker,
} from "../../services/browser-capability-adapter.js";
import { BrowserFaviconService } from "../../services/browser-favicon-service.js";
import { BrowserSettingsService } from "../../services/browser-settings-service.js";
import { BrowserToolService } from "../../services/browser-tool-service.js";
import { handleBrowserRoutes } from "../routes/browser-settings.js";
import { handleBrowserToolRoute } from "../routes/browser-tool.js";
import type { RouteRegistration } from "../routing.js";
import type {
  BuiltinAgentToolAdapter,
  ToolContribution,
  ToolDeps,
  ToolModule,
  WorkerEndpointInput,
} from "./tool-registry.js";

export const BROWSER_TOOL_PATH_PREFIX = "/_pipeline-browser/";

export interface BrowserToolModuleServices {
  readonly browserSettingsService?: BrowserSettingsService;
  readonly browserToolService?: BrowserToolModuleService;
  readonly browserManager?: BrowserManager;
}

export type BrowserToolModuleService = Pick<
  BrowserToolService,
  | "tool"
  | "isEnabledForAgent"
  | "listSession"
  | "readAttachment"
  | "readToolAttachment"
>

export interface BrowserToolModuleOptions {
  readonly settingsService?: BrowserSettingsService;
  readonly toolService?: BrowserToolModuleService;
  readonly dispatchInvoker?: BrowserCapabilityDispatchInvoker;
  readonly settingsStoragePath?: string;
  readonly endpoint?: WorkerEndpointInput;
  /**
   * Let site-icon fetches reach a loopback origin over plain http.
   *
   * Off unless a caller asks for it, so the allowance is a deliberate wiring
   * decision a reader can see rather than an ambient property of the process.
   * Only a test harness serving its own fixture site should turn it on.
   */
  readonly allowLoopbackSiteIcons?: boolean;
}

declare module "./tool-registry.js" {
  interface ToolModuleOptions {
    readonly browser?: BrowserToolModuleOptions;
  }
}

export const browserToolModule: ToolModule<BrowserToolModuleServices> = {
  name: "browser",
  optionKeys: [
    "settingsService",
    "toolService",
    "dispatchInvoker",
    "settingsStoragePath",
    "endpoint",
    "allowLoopbackSiteIcons",
  ],
  build(deps): ToolContribution<BrowserToolModuleServices> {
    const options = deps.moduleOptions?.browser;
    const manager = deps.browserManager;
    const browserToolService =
      options?.toolService ??
      (manager && deps.workspacePath && deps.repoRootPath
        ? new BrowserToolService({
            workspacePath: deps.workspacePath,
            repoRootPath: deps.repoRootPath,
            manager,
          })
        : undefined);
    const browserSettingsService =
      options?.settingsService ??
      (manager && deps.workspacePath
        ? new BrowserSettingsService(
            manager,
            options?.settingsStoragePath ??
              path.join(
                path.dirname(deps.workspacePath),
                "browser-settings.json",
              ),
          )
        : undefined);
    const dispatchInvoker =
      options?.dispatchInvoker ??
      (browserToolService instanceof BrowserToolService &&
      deps.capabilityDispatcher
        ? new BrowserCapabilityDispatchGateway({
            dispatcher: deps.capabilityDispatcher,
            service: browserToolService,
          })
        : undefined);
    // Site icons are fetched only for origins this session actually visited,
    // so the authorized set comes straight from recorded browser activity.
    const browserFaviconService = browserToolService
      ? new BrowserFaviconService({
          listSessionUrls: async (sessionId) =>
            (await browserToolService.listSession(sessionId))
              .map((activity) => activity.url)
              .filter((url): url is string => typeof url === "string"),
          allowHttpLocalhost: options?.allowLoopbackSiteIcons === true,
        })
      : undefined;
    const capabilityPath = resolveEndpointPath(
      options?.endpoint ??
        (deps.createWorkerEndpointToken
          ? { token: deps.createWorkerEndpointToken("browser") }
          : undefined),
    );
    const routes: RouteRegistration[] = [];

    routes.push({
      id: "browser-settings-and-activity",
      stage: "api",
      authorization: "api",
      streaming: "none",
      methods: ["GET", "PUT", "POST"],
      path: {
        kind: "pattern",
        pattern:
          "^(?:/settings/browser(?:/(?:open-profile|stop))?|/sessions/[^/]+/browser-activity(?:/favicon|/[^/]+/attachment)?)$",
      },
      handler: ({ req, res, url }) =>
        handleBrowserRoutes({
          req,
          res,
          url,
          ...whenDefined(browserSettingsService, (definedValue) => ({ settings: definedValue })),
          ...whenDefined(browserToolService, (definedValue) => ({ tools: definedValue })),
          ...whenDefined(browserFaviconService, (definedValue) => ({ favicons: definedValue })),
        }),
    });
    if (
      browserToolService &&
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
        ...(manager ? { browserManager: manager } : {}),
        ...(browserSettingsService ? { browserSettingsService } : {}),
        ...(browserToolService ? { browserToolService } : {}),
      },
      routeOrder: 0,
      agentToolOrder: 0,
      routes,
      ...(browserToolService &&
          dispatchInvoker &&
          deps.runtimeCapabilityAuthority &&
          capabilityPath
        ? {
            workerEndpoint: {
              environmentVariable: BROWSER_TOOL_URL_ENV,
              path: capabilityPath,
            },
          }
        : {}),
      ...(browserToolService && dispatchInvoker
        ? { agentTool: agentToolAdapter(browserToolService, dispatchInvoker) }
        : {}),
      ...(browserSettingsService
        ? {
            startActions: [{
              name: "browser-settings-hydration",
              run: () => browserSettingsService.hydrateRuntime(),
            }],
          }
        : {}),
    };
  },
};

function capabilityRoute(
  capabilityPath: string,
  invoker: BrowserCapabilityDispatchInvoker,
  authority: NonNullable<ToolDeps["runtimeCapabilityAuthority"]>,
): RouteRegistration {
  return {
    id: "browser-tool-capability",
    stage: "pre-auth-capability",
    authorization: "capability",
    streaming: "none",
    methods: ["POST"],
    path: { kind: "exact", path: capabilityPath },
    handler: async ({ req, res, url }) => {
      if (url.pathname !== capabilityPath || url.search) return false;
      await handleBrowserToolRoute({
        req,
        res,
        invoker,
        authority,
      });
      return true;
    },
  };
}

function agentToolAdapter(
  service: BrowserToolModuleService,
  invoker: BrowserCapabilityDispatchInvoker,
): BuiltinAgentToolAdapter {
  return {
    name: service.tool.namespacedName,
    tool: service.tool,
    isEnabledForAgent: (agentPath) => service.isEnabledForAgent(agentPath),
    execute: async ({ context, toolCallId, input, signal }) => {
      const output = await invoker.execute({
        context,
        authority: { kind: "mcp-lease", leaseId: context.leaseId },
        source: {
          kind: "builtin",
          id: BROWSER_SERVER_ID,
          version: String(BROWSER_TOOL_CONTRACT_VERSION),
        },
        toolCallId,
        input,
        ...(signal ? { signal } : {}),
      });
      const screenshot = output.attachment
        ? await service.readToolAttachment(context, output.attachment)
        : null;
      return {
        output,
        content: JSON.stringify(output),
        isError: !output.ok,
        ...(screenshot
          ? {
              images: [{
                data: screenshot.data.toString("base64"),
                mimeType: screenshot.mimeType,
              }],
            }
          : {}),
        ...(output.ok && output.url && output.text?.trim()
          ? {
              webObservation: {
                url: output.url,
                ...(output.title ? { title: output.title } : {}),
                text: output.text,
              },
            }
          : {}),
      };
    },
    releaseAssignment: (scope) => invoker.releaseAssignment(scope),
  };
}

function resolveEndpointPath(input: WorkerEndpointInput | undefined): string | undefined {
  if (!input) return undefined;
  if (input.path && input.token) {
    throw new Error("Browser endpoint accepts either path or token, not both");
  }
  const value = input.path ??
    (input.token ? `${BROWSER_TOOL_PATH_PREFIX}${input.token}` : undefined);
  if (
    !value ||
    !value.startsWith(BROWSER_TOOL_PATH_PREFIX) ||
    value.length === BROWSER_TOOL_PATH_PREFIX.length ||
    value.slice(BROWSER_TOOL_PATH_PREFIX.length).includes("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("Browser endpoint path is invalid");
  }
  return value;
}
