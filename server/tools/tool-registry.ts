import type { BrowserManager } from "../../domains/browser/browser-manager.js";
import type { CapabilityDispatcher } from "../../core/capability-dispatcher.js";
import type { FileParserLauncher } from "../../core/file-parser-launcher.js";
import type { McpApprovalCoordinator } from "../../domains/mcp/mcp-approval-coordinator.js";
import type { BuiltinAgentToolAdapter } from "../../domains/mcp/builtin-agent-tool-adapter.js";
import type { ProviderSettingsService } from "../../services/provider-settings-service.js";
import type { RuntimeCapabilityAuthorityPort } from "../../contracts/runtime-capability-authority.js";
import type { RouteRegistration } from "../routing.js";
import { browserToolModule } from "./browser.js";
import { createFileToolModule } from "./create-file.js";
import { generateExcelToolModule } from "./generate-excel.js";
import { generateWordToolModule } from "./generate-word.js";
import { researchWebToolModule } from "./research-web.js";
import { skillLoaderToolModule } from "./skill-loader.js";
import { youtubeToolModule } from "./youtube.js";

export interface WorkerEndpointInput {
  readonly path?: string;
  readonly token?: string;
}

export interface WorkerEndpointContribution {
  readonly environmentVariable: string;
  readonly path: string;
}

export type {
  AssignmentScope,
  BuiltinAgentToolAdapter,
  BuiltinToolExecutionInput,
  BuiltinToolExecutionResult,
  BuiltinToolArtifact,
  BuiltinToolImage,
  BuiltinWebObservation,
} from "../../domains/mcp/builtin-agent-tool-adapter.js";

export interface ToolModuleOptions {
  readonly [moduleName: string]: unknown;
}

export interface ToolDeps {
  readonly workspacePath?: string;
  readonly repoRootPath?: string;
  readonly browserManager?: BrowserManager;
  readonly fileParserLauncher?: FileParserLauncher;
  readonly providerSettingsService?: ProviderSettingsService;
  readonly runtimeCapabilityAuthority?: RuntimeCapabilityAuthorityPort;
  readonly capabilityDispatcher?: Pick<CapabilityDispatcher, "dispatch">;
  readonly createWorkerEndpointToken?: (toolName: string) => string;
  readonly approvalCoordinator?: Pick<
    McpApprovalCoordinator,
    "requestApproval"
  >;
  readonly approvalWaitTimeoutMs?: number;
  readonly moduleOptions?: ToolModuleOptions;
  /**
   * Services already registered by earlier modules.
   *
   * For a module that has to *read* something a sibling owns, rather than
   * duplicating that sibling's construction. Registration order is the module
   * order below, so a module only ever sees the ones ahead of it, and
   * reordering them silently removes a dependency instead of failing loudly.
   *
   * Two uses are permitted today, both narrowly guarded on the accessor they
   * call rather than on the owning class:
   *
   * 1. The unified research-activity projection reads the browser tool's
   *    journal without owning it.
   * 2. The research-web module reads the Webshare runtime configuration from
   *    the YouTube settings service, which owns that credential. See
   *    `docs/adr/2026-08-28-Proxied-Direct-Acquisition-Retry.md`, which also
   *    records the alternative that was not taken — lifting a shared settings
   *    owner into composition.
   *
   * A third use needs its own decision, not a quiet addition.
   */
  readonly registeredService?: RegisteredToolServiceLookup;
}

export interface RegisteredToolServiceLookup {
  <TService>(
    name: string,
    isService: (value: unknown) => value is TService,
  ): TService | undefined;
}

export interface ToolContribution<TServices extends object = object> {
  readonly services: TServices;
  readonly routes: readonly RouteRegistration[];
  /**
   * Route precedence is independent from service construction order. This
   * preserves the existing HTTP inventory while modules retain their stable
   * registry order.
   */
  readonly routeOrder?: number;
  readonly workerEndpoint?: WorkerEndpointContribution;
  readonly agentTool?: BuiltinAgentToolAdapter;
  readonly agentToolOrder?: number;
  readonly startActions?: readonly ToolStartAction[];
}

export interface ToolStartAction {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface ToolModule<TServices extends object = object> {
  readonly name: string;
  readonly optionKeys?: readonly string[];
  build(deps: ToolDeps): ToolContribution<TServices>;
}

export interface RegisteredToolContribution
  extends ToolContribution<Record<string, unknown>> {
  readonly name: string;
}

export const toolModules: readonly ToolModule[] = Object.freeze([
  youtubeToolModule,
  browserToolModule,
  researchWebToolModule,
  generateWordToolModule,
  generateExcelToolModule,
  skillLoaderToolModule,
  createFileToolModule,
]);

export function buildToolRegistry(
  deps: ToolDeps,
  modules: readonly ToolModule[] = toolModules,
): readonly RegisteredToolContribution[] {
  const moduleNames = modules.map((module) => module.name);
  assertUnique("tool module name", moduleNames);
  assertKnown(
    "tool module option",
    Object.keys(deps.moduleOptions ?? {}),
    moduleNames,
  );
  assertModuleOptions(deps.moduleOptions, modules);
  const registered: RegisteredToolContribution[] = [];
  const services = new Map<string, unknown>();

  const registeredService: RegisteredToolServiceLookup = (name, isService) => {
    const value = services.get(name);
    return isService(value) ? value : undefined;
  };

  for (const module of modules) {
    const contribution = module.build({ ...deps, registeredService });
    if (
      Object.keys(contribution.services).length === 0 &&
      contribution.routes.length === 0 &&
      !contribution.workerEndpoint &&
      !contribution.agentTool &&
      !contribution.startActions?.length
    ) {
      continue;
    }
    for (const [name, service] of Object.entries(contribution.services)) {
      if (services.has(name)) {
        throw new Error(`Duplicate tool service name: ${name}`);
      }
      services.set(name, service);
    }
    registered.push({
      name: module.name,
      services: contribution.services as Record<string, unknown>,
      routes: contribution.routes,
      ...(contribution.routeOrder !== undefined
        ? { routeOrder: contribution.routeOrder }
        : {}),
      ...(contribution.workerEndpoint
        ? { workerEndpoint: contribution.workerEndpoint }
        : {}),
      ...(contribution.agentTool ? { agentTool: contribution.agentTool } : {}),
      ...(contribution.agentToolOrder !== undefined
        ? { agentToolOrder: contribution.agentToolOrder }
        : {}),
      ...(contribution.startActions?.length
        ? { startActions: Object.freeze([...contribution.startActions]) }
        : {}),
    });
  }

  assertUnique(
    "tool route id",
    registered.flatMap((entry) => entry.routes.map((route) => route.id)),
  );
  assertUnique(
    "worker endpoint path",
    registered.flatMap((entry) =>
      entry.workerEndpoint ? [entry.workerEndpoint.path] : [],
    ),
  );
  assertUnique(
    "worker endpoint environment variable",
    registered.flatMap((entry) =>
      entry.workerEndpoint
        ? [entry.workerEndpoint.environmentVariable]
        : [],
    ),
  );
  assertUnique(
    "agent tool name",
    registered.flatMap((entry) =>
      entry.agentTool ? [entry.agentTool.name] : [],
    ),
  );
  assertUnique(
    "agent tool order",
    registered.flatMap((entry) =>
      entry.agentTool ? [String(requireAgentToolOrder(entry))] : [],
    ),
  );
  assertUnique(
    "tool start action name",
    registered.flatMap((entry) =>
      entry.startActions?.map((action) => action.name) ?? [],
    ),
  );
  return Object.freeze(registered.map((entry) => Object.freeze(entry)));
}

export function providerAgentTools(
  registered: readonly RegisteredToolContribution[],
): readonly BuiltinAgentToolAdapter[] {
  return Object.freeze(
    [...registered]
      .filter(
        (
          entry,
        ): entry is RegisteredToolContribution & {
          readonly agentTool: BuiltinAgentToolAdapter;
        } => entry.agentTool !== undefined,
      )
      .sort(
        (left, right) =>
          requireAgentToolOrder(left) - requireAgentToolOrder(right),
      )
      .map((entry) => entry.agentTool),
  );
}

function requireAgentToolOrder(
  entry: Pick<RegisteredToolContribution, "name" | "agentToolOrder">,
): number {
  const order = entry.agentToolOrder;
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0) {
    throw new Error(`Invalid agent tool order for module: ${entry.name}`);
  }
  return order;
}

function assertUnique(label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) {
      throw new Error(`Duplicate or empty ${label}: ${value || "<empty>"}`);
    }
    seen.add(value);
  }
}

function assertKnown(
  label: string,
  values: readonly string[],
  knownValues: readonly string[],
): void {
  const known = new Set(knownValues);
  for (const value of values) {
    if (!known.has(value)) {
      throw new Error(`Unknown ${label}: ${value}`);
    }
  }
}

function assertModuleOptions(
  options: ToolModuleOptions | undefined,
  modules: readonly ToolModule[],
): void {
  const modulesByName = new Map(
    modules.map((module) => [module.name, module] as const),
  );
  for (const module of modules) {
    assertUnique(
      `${module.name} tool module option key`,
      module.optionKeys ?? [],
    );
  }
  for (const [name, value] of Object.entries(options ?? {})) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new Error(`Tool module options must be an object: ${name}`);
    }
    const optionKeys = modulesByName.get(name)?.optionKeys ?? [];
    const allowed = new Set(optionKeys);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new Error(`Unknown ${name} tool module option: ${key}`);
      }
    }
  }
}
