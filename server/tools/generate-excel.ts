import { whenDefined } from '../../core/optional-properties.js'
import {
  GENERATE_EXCEL_TOOL_URL_ENV,
} from "../../domains/excel-generation/generate-excel-types.js";
import { GenerateExcelToolService } from "../../services/generate-excel-tool-service.js";
import {
  GENERATE_EXCEL_BUILTIN_SOURCE,
  GenerateExcelCapabilityDispatchGateway,
  type GenerateExcelCapabilityDispatchInvoker,
  type GenerateExcelCapabilityService,
} from "../../services/generate-excel-capability-adapter.js";
import { handleGenerateExcelToolRoute } from "../routes/generate-excel-tool.js";
import type { RouteRegistration } from "../routing.js";
import type {
  BuiltinAgentToolAdapter,
  ToolContribution,
  ToolDeps,
  ToolModule,
  WorkerEndpointInput,
} from "./tool-registry.js";

export const GENERATE_EXCEL_TOOL_PATH_PREFIX = "/_pipeline-generate-excel/";

export interface GenerateExcelToolModuleServices {
  readonly generateExcelToolService?: GenerateExcelCapabilityService;
}

export interface GenerateExcelToolModuleOptions {
  readonly toolService?: GenerateExcelCapabilityService;
  readonly endpoint?: WorkerEndpointInput;
}

declare module "./tool-registry.js" {
  interface ToolModuleOptions {
    readonly "generate-excel"?: GenerateExcelToolModuleOptions;
  }
}

export const generateExcelToolModule: ToolModule<GenerateExcelToolModuleServices> = {
  name: "generate-excel",
  optionKeys: ["toolService", "endpoint"],
  build(deps): ToolContribution<GenerateExcelToolModuleServices> {
    const options = deps.moduleOptions?.["generate-excel"];
    const generateExcelToolService =
      options?.toolService ??
      (deps.workspacePath && deps.repoRootPath
        ? new GenerateExcelToolService({
            workspacePath: deps.workspacePath,
            repoRootPath: deps.repoRootPath,
          })
        : undefined);
    const capabilityPath = resolveEndpointPath(
      options?.endpoint ??
        (deps.createWorkerEndpointToken
          ? { token: deps.createWorkerEndpointToken("generate-excel") }
          : undefined),
    );
    const dispatchInvoker =
      generateExcelToolService && deps.capabilityDispatcher
        ? new GenerateExcelCapabilityDispatchGateway({
            dispatcher: deps.capabilityDispatcher,
            service: generateExcelToolService,
          })
        : undefined;
    const routes =
      dispatchInvoker && deps.runtimeCapabilityAuthority && capabilityPath
        ? [capabilityRoute(
            capabilityPath,
            dispatchInvoker,
            deps.runtimeCapabilityAuthority,
          )]
        : [];
    return {
      services: {
        ...(generateExcelToolService ? { generateExcelToolService } : {}),
      },
      routeOrder: 4,
      agentToolOrder: 4,
      routes,
      ...(dispatchInvoker && deps.runtimeCapabilityAuthority && capabilityPath
        ? {
            workerEndpoint: {
              environmentVariable: GENERATE_EXCEL_TOOL_URL_ENV,
              path: capabilityPath,
            },
          }
        : {}),
      ...(generateExcelToolService && dispatchInvoker
        ? { agentTool: agentToolAdapter(generateExcelToolService, dispatchInvoker) }
        : {}),
    };
  },
};

function capabilityRoute(
  capabilityPath: string,
  invoker: GenerateExcelCapabilityDispatchInvoker,
  authority: NonNullable<ToolDeps['runtimeCapabilityAuthority']>,
): RouteRegistration {
  return {
    id: "generate-excel-tool-capability",
    stage: "pre-auth-capability",
    authorization: "capability",
    streaming: "none",
    methods: ["POST"],
    path: { kind: "exact", path: capabilityPath },
    handler: async ({ req, res, url }) => {
      if (url.pathname !== capabilityPath || url.search) return false;
      await handleGenerateExcelToolRoute({ req, res, invoker, authority });
      return true;
    },
  };
}

function agentToolAdapter(
  service: GenerateExcelCapabilityService,
  invoker: GenerateExcelCapabilityDispatchInvoker,
): BuiltinAgentToolAdapter {
  return {
    name: service.tool.namespacedName,
    tool: service.tool,
    isEnabledForAgent: (agentPath) => service.isEnabledForAgent(agentPath),
    execute: async ({ context, toolCallId, input, signal }) => {
      const output = await invoker.execute({
        context,
        authority: { kind: "mcp-lease", leaseId: context.leaseId },
        source: GENERATE_EXCEL_BUILTIN_SOURCE,
        toolCallId,
        input,
        ...(signal ? { signal } : {}),
      });
      return {
        output,
        content: JSON.stringify(output),
        isError: !output.ok,
        ...(output.ok && output.outputPath && (output.action === 'generate' || output.action === 'fill_template') ? { artifacts: [{ path: output.outputPath, title: output.outputPath.split('/').at(-1) ?? output.outputPath, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', role: 'final', ...whenDefined(output.digest, (digest) => ({ digest })) }] } : {}),
      };
    },
  };
}

function resolveEndpointPath(input: WorkerEndpointInput | undefined): string | undefined {
  if (!input) return undefined;
  if (input.path && input.token) {
    throw new Error("Generate Excel endpoint accepts either path or token, not both");
  }
  const value = input.path ??
    (input.token
      ? `${GENERATE_EXCEL_TOOL_PATH_PREFIX}${input.token}`
      : undefined);
  if (
    !value ||
    !value.startsWith(GENERATE_EXCEL_TOOL_PATH_PREFIX) ||
    value.length === GENERATE_EXCEL_TOOL_PATH_PREFIX.length ||
    value.slice(GENERATE_EXCEL_TOOL_PATH_PREFIX.length).includes("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("Generate Excel endpoint path is invalid");
  }
  return value;
}
