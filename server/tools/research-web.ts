import * as path from "node:path";

import { whenDefined } from "../../core/optional-properties.js";
import {
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
  RESEARCH_WEB_TOOL_URL_ENV,
} from "../../domains/acquisition/acquisition-types.js";
import type { WebshareProxyPort } from "../../domains/acquisition/acquisition-proxy.js";
import type {
  BrowserActivityRecord,
  ResearchWebActivityRecord,
} from "../../domains/acquisition/research-activity-projection.js";
import { resolveWebshareProxy } from "../../domains/proxy/webshare-proxy.js";
import type { CloudSessionCleanupWarning } from "../../domains/browser/cloud-browser-types.js";
import { logProcessWarning } from "../../domains/runtime/logger.js";
import type { WebshareRuntimeConfig } from "../../domains/proxy/webshare-settings.js";
import type { AcquisitionProviderId } from "../../domains/acquisition/acquisition-providers.js";
import type { ProviderSettingsSnapshot } from "../../domains/provider/provider-settings.js";
import type { ProviderSecretCodec } from "../../services/provider-settings-service.js";
import { AcquisitionSettingsService } from "../../services/acquisition-settings-service.js";
import { BrowserFaviconService } from "../../services/browser-favicon-service.js";
import {
  isResearchActivitySource,
  ResearchActivityProjectionService,
  type ResearchActivitySourcePort,
} from "../../services/research-activity-projection-service.js";
import {
  ResearchWebCapabilityDispatchGateway,
  type ResearchWebCapabilityDispatchInvoker,
} from "../../services/research-web-capability-adapter.js";
import { ResearchWebToolService } from "../../services/research-web-tool-service.js";
import { handleAcquisitionSettingsRoutes } from "../routes/acquisition-settings.js";
import { handleResearchActivityRoutes } from "../routes/research-activity.js";
import { handleResearchWebToolRoute } from "../routes/research-web-tool.js";
import type { RouteRegistration } from "../routing.js";
import type {
  BuiltinAgentToolAdapter,
  ToolContribution,
  ToolDeps,
  ToolModule,
  WorkerEndpointInput,
} from "./tool-registry.js";

export const RESEARCH_WEB_TOOL_MODULE_NAME = "research-web";

/**
 * The acquisition settings options every owner of that service must apply.
 *
 * A named function rather than an object literal at each construction site.
 * The desktop builds this service itself and injects it, so options applied
 * only inside this module are options the real application does not have — and
 * the one that matters here is the channel that reports a cloud session which
 * may still be billing.
 */
export function acquisitionSettingsCloudOptions(options: {
  readonly allowHttpLocalhost: boolean;
  readonly log?: (scope: string, message: string) => void;
}): {
  readonly allowHttpLocalhost: boolean;
  readonly onCloudCleanupWarning: (warning: CloudSessionCleanupWarning) => void;
} {
  return {
    allowHttpLocalhost: options.allowHttpLocalhost,
    onCloudCleanupWarning: (warning) =>
      reportCloudCleanupWarning(warning, options.log ?? logProcessWarning),
  };
}

/**
 * The acquisition settings service exactly as the desktop builds it.
 *
 * The construction lives here, in an importable function, rather than inline in
 * `electron/main.ts`. Options applied at an untestable call site are options
 * nothing can prove are applied — and the one at stake reports a cloud session
 * that may still be billing.
 */
export function createDesktopAcquisitionSettingsService(options: {
  readonly storagePath: string;
  readonly secretCodec?: ProviderSecretCodec;
  readonly providerSettings?: { snapshot(): Promise<ProviderSettingsSnapshot> };
  readonly providerEndpoints?: Partial<Record<AcquisitionProviderId, string>>;
  readonly isTestRun: boolean;
  readonly log?: (scope: string, message: string) => void;
  /** Defaults to the real process environment. Injected by tests. */
  readonly environment?: NodeJS.ProcessEnv;
}): AcquisitionSettingsService {
  return new AcquisitionSettingsService({
    storagePath: options.storagePath,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.secretCodec ? { secretCodec: options.secretCodec } : {}),
    ...(options.providerSettings
      ? { providerSettings: options.providerSettings }
      : {}),
    ...(options.providerEndpoints
      ? { providerEndpoints: options.providerEndpoints }
      : {}),
    ...acquisitionSettingsCloudOptions({
      allowHttpLocalhost: options.isTestRun,
      ...(options.log ? { log: options.log } : {}),
    }),
  });
}

/**
 * Reports a cloud session that could not be confirmed stopped.
 *
 * Exported because the settings service is often **injected** rather than built
 * here — the desktop constructs its own — and a warning channel installed only
 * on the copy this module happens to create is a channel the real application
 * does not have. One formatting, used by every owner.
 *
 * The session keeps billing until its provider timeout, so this is an operator
 * signal and goes through the repository's process-diagnostic boundary rather
 * than a bare console call.
 */
export function reportCloudCleanupWarning(
  warning: CloudSessionCleanupWarning,
  log: (scope: string, message: string) => void = logProcessWarning,
): void {
  const detail =
    warning.kind === "session-not-stopped"
      ? `session ${warning.sessionId} was not confirmed stopped (${warning.failure})` +
        (warning.timeoutAt ? `; it self-stops at ${warning.timeoutAt}` : "")
      : `a session may have been created and cannot be named (${warning.failure})`;
  log(
    "research-web/cloud-browser",
    `${warning.provider}: ${detail}. It stops on its own within ` +
      `${warning.providerTimeoutMinutes} minute(s); check the provider console ` +
      `if it needs stopping sooner.`,
  );
}
export const RESEARCH_WEB_TOOL_PATH_PREFIX = "/_pipeline-research-web/";

export interface ResearchWebToolModuleServices {
  readonly acquisitionSettingsService: AcquisitionSettingsService;
  readonly researchWebToolService?: ResearchWebToolModuleService;
  /**
   * The renderer's single view of research activity.
   *
   * Owned here rather than by the browser module because this module is built
   * second, so it is the first point at which both journals exist.
   */
  readonly researchActivityProjection: ResearchActivityProjectionService;
}

export interface ResearchWebToolModuleService
  extends Pick<
    ResearchWebToolService,
    | "tool"
    | "isEnabledForAgent"
    | "execute"
    | "releaseAssignment"
    // Read by the unified research-activity projection, which is the renderer's
    // only view of this journal.
    | "listSession"
  > {}

export interface ResearchWebToolModuleOptions {
  readonly settingsService?: AcquisitionSettingsService;
  readonly toolService?: ResearchWebToolModuleService;
  readonly dispatchInvoker?: ResearchWebCapabilityDispatchInvoker;
  readonly settingsStoragePath?: string;
  readonly endpoint?: WorkerEndpointInput;
  /**
   * Let site-icon fetches reach a loopback origin over plain http.
   *
   * Off unless a caller asks for it, matching the browser module's own
   * allowance. Only a test harness serving its own fixture site turns it on.
   */
  readonly allowLoopbackSiteIcons?: boolean;
}

declare module "./tool-registry.js" {
  interface ToolModuleOptions {
    readonly [RESEARCH_WEB_TOOL_MODULE_NAME]?: ResearchWebToolModuleOptions;
  }
}

export const researchWebToolModule: ToolModule<ResearchWebToolModuleServices> = {
  name: RESEARCH_WEB_TOOL_MODULE_NAME,
  optionKeys: [
    "settingsService",
    "toolService",
    "dispatchInvoker",
    "settingsStoragePath",
    "endpoint",
    "allowLoopbackSiteIcons",
  ],
  build(deps): ToolContribution<ResearchWebToolModuleServices> {
    const options = deps.moduleOptions?.[RESEARCH_WEB_TOOL_MODULE_NAME];
    const acquisitionSettingsService =
      options?.settingsService ??
      new AcquisitionSettingsService({
        ...(options?.settingsStoragePath
          ? { storagePath: options.settingsStoragePath }
          : deps.workspacePath
            ? {
                storagePath: path.join(
                  deps.workspacePath,
                  ".settings",
                  "research-acquisition.json",
                ),
              }
            : {}),
        ...(deps.providerSettingsService
          ? { providerSettings: deps.providerSettingsService }
          : {}),
        ...acquisitionSettingsCloudOptions({
          allowHttpLocalhost: process.env.NODE_ENV === "test",
        }),
      });
    // The Webshare credential is owned by the YouTube settings service, which
    // is registered ahead of this module. Reading it here rather than
    // constructing a second owner keeps one credential with one lifetime; the
    // module-order dependency is recorded in
    // docs/adr/2026-08-28-Proxied-Direct-Acquisition-Retry.md.
    const webshareProxy = webshareProxyPort(
      deps.registeredService?.<WebshareRuntimeSource>(
        "youtubeSettingsService",
        isWebshareRuntimeSource,
      ),
    );
    const researchWebToolService =
      options?.toolService ??
      (deps.workspacePath && deps.repoRootPath
        ? new ResearchWebToolService({
            workspacePath: deps.workspacePath,
            repoRootPath: deps.repoRootPath,
            settings: acquisitionSettingsService,
            ...(deps.browserManager
              ? { browserManager: deps.browserManager }
              : {}),
            ...(deps.fileParserLauncher
              ? { fileParserLauncher: deps.fileParserLauncher }
              : {}),
            allowHttpLocalhost: process.env.NODE_ENV === "test",
            ...(webshareProxy ? { webshareProxy } : {}),
          })
        : undefined);
    const dispatchInvoker = options?.dispatchInvoker ??
      (researchWebToolService && deps.capabilityDispatcher
        ? new ResearchWebCapabilityDispatchGateway({
            dispatcher: deps.capabilityDispatcher,
            service: researchWebToolService,
          })
        : undefined);
    const capabilityPath = resolveEndpointPath(
      options?.endpoint ??
        (deps.createWorkerEndpointToken
          ? {
              token: deps.createWorkerEndpointToken(
                RESEARCH_WEB_TOOL_MODULE_NAME,
              ),
            }
          : undefined),
    );
    // Both journals stay independently owned; only the shape the renderer needs
    // is unified, and an absent tool is simply an empty half. The browser
    // journal is read through the registry because that module is built first
    // and this is the earliest point at which both services exist.
    const browserSource = deps.registeredService?.<
      ResearchActivitySourcePort<BrowserActivityRecord>
    >("browserToolService", isResearchActivitySource);
    const researchWebSource: ResearchActivitySourcePort<
      ResearchWebActivityRecord
    > | undefined = researchWebToolService;
    const researchActivityProjection = new ResearchActivityProjectionService({
      ...whenDefined(browserSource, (browser) => ({ browser })),
      ...whenDefined(researchWebSource, (researchWeb) => ({ researchWeb })),
    });
    const researchActivityFavicons = new BrowserFaviconService({
      listSessionUrls: (sessionId) =>
        researchActivityProjection.listVisitedUrls(sessionId),
      allowHttpLocalhost: options?.allowLoopbackSiteIcons === true,
    });
    const routes: RouteRegistration[] = [{
      id: "research-acquisition-settings",
      stage: "api",
      authorization: "api",
      streaming: "none",
      methods: ["GET", "PATCH", "POST"],
      path: {
        kind: "pattern",
        pattern: "^/settings/research-acquisition(?:/validate)?$",
      },
      handler: ({ req, res, url }) =>
        handleAcquisitionSettingsRoutes({
          req,
          res,
          url,
          service: acquisitionSettingsService,
        }),
    }, {
      id: "research-activity",
      stage: "api",
      authorization: "api",
      streaming: "none",
      methods: ["GET"],
      path: {
        kind: "pattern",
        pattern: "^/sessions/[^/]+/research-activity(?:/favicon)?$",
      },
      handler: ({ req, res, url }) =>
        handleResearchActivityRoutes({
          req,
          res,
          url,
          activities: researchActivityProjection,
          favicons: researchActivityFavicons,
        }),
    }];
    if (dispatchInvoker && deps.runtimeCapabilityAuthority && capabilityPath) {
      routes.push(capabilityRoute(
        capabilityPath,
        dispatchInvoker,
        deps.runtimeCapabilityAuthority,
      ));
    }

    return {
      services: {
        acquisitionSettingsService,
        researchActivityProjection,
        ...(researchWebToolService ? { researchWebToolService } : {}),
      },
      routeOrder: 1,
      agentToolOrder: 1,
      routes,
      ...(dispatchInvoker && deps.runtimeCapabilityAuthority && capabilityPath
        ? {
            workerEndpoint: {
              environmentVariable: RESEARCH_WEB_TOOL_URL_ENV,
              path: capabilityPath,
            },
          }
        : {}),
      ...(researchWebToolService && dispatchInvoker
        ? { agentTool: agentToolAdapter(researchWebToolService, dispatchInvoker) }
        : {}),
    };
  },
};

/** The one accessor this module needs from the Webshare credential owner. */
interface WebshareRuntimeSource {
  runtimeProxy(): Promise<WebshareRuntimeConfig>;
}

/**
 * Narrow on the accessor, not on the owning class.
 *
 * The lookup must not match any service that merely happens to be registered
 * under this name, so it checks for the exact shape this module calls.
 */
function isWebshareRuntimeSource(value: unknown): value is WebshareRuntimeSource {
  if (typeof value !== "object" || value === null) return false;
  if (!("runtimeProxy" in value)) return false;
  return typeof value.runtimeProxy === "function";
}

/**
 * Reads the configuration afresh on every acquisition, so enabling or
 * disabling the proxy takes effect without a restart. An absent source means
 * no port, which acquisition treats exactly like a disabled proxy.
 */
function webshareProxyPort(
  source: WebshareRuntimeSource | undefined,
): WebshareProxyPort | undefined {
  if (!source) return undefined;
  return {
    open: async (signal) => {
      const resolved = await resolveWebshareProxy(
        await source.runtimeProxy(),
        signal,
      );
      if (!resolved) return undefined;
      // The session is the seam acquisition sees. It carries the dispatcher for
      // the direct rung and the browser-shaped endpoint for the managed-browser
      // retry, both derived by the resolver so they cannot disagree.
      return {
        dispatcher: resolved.dispatcher,
        browserEndpoint: resolved.browserEndpoint,
        close: resolved.close,
      };
    },
  };
}

function capabilityRoute(
  capabilityPath: string,
  invoker: ResearchWebCapabilityDispatchInvoker,
  authority: NonNullable<ToolDeps['runtimeCapabilityAuthority']>,
): RouteRegistration {
  return {
    id: "research-web-tool-capability",
    stage: "pre-auth-capability",
    authorization: "capability",
    streaming: "none",
    methods: ["POST"],
    path: { kind: "exact", path: capabilityPath },
    handler: async ({ req, res, url }) => {
      if (url.pathname !== capabilityPath || url.search) return false;
      await handleResearchWebToolRoute({ req, res, invoker, authority });
      return true;
    },
  };
}

function agentToolAdapter(
  service: ResearchWebToolModuleService,
  invoker: ResearchWebCapabilityDispatchInvoker,
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
          id: RESEARCH_WEB_SERVER_ID,
          version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
        },
        toolCallId,
        input,
        ...(signal ? { signal } : {}),
      });
      return {
        output,
        content: JSON.stringify(output),
        isError: !output.ok,
        ...(output.ok &&
        output.action === "acquire" &&
        output.canonicalUrl &&
        output.text?.trim()
          ? {
              webObservation: {
                url: output.canonicalUrl,
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

function resolveEndpointPath(
  input: WorkerEndpointInput | undefined,
): string | undefined {
  if (!input) return undefined;
  if (input.path && input.token) {
    throw new Error(
      "Research Web endpoint accepts either path or token, not both",
    );
  }
  const value = input.path ??
    (input.token
      ? `${RESEARCH_WEB_TOOL_PATH_PREFIX}${input.token}`
      : undefined);
  if (
    !value ||
    !value.startsWith(RESEARCH_WEB_TOOL_PATH_PREFIX) ||
    value.length === RESEARCH_WEB_TOOL_PATH_PREFIX.length ||
    value.slice(RESEARCH_WEB_TOOL_PATH_PREFIX.length).includes("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("Research Web endpoint path is invalid");
  }
  return value;
}
