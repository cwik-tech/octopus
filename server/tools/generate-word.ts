import { whenDefined } from "../../core/optional-properties.js"
import {
  GENERATE_WORD_TOOL_URL_ENV,
  type GenerateWordToolOutput,
} from "../../domains/word-generation/generate-word-types.js";
import { GenerateWordToolService } from "../../services/generate-word-tool-service.js";
import {
  GENERATE_WORD_BUILTIN_SOURCE,
  GenerateWordCapabilityDispatchGateway,
  type GenerateWordCapabilityDispatchInvoker,
  type GenerateWordCapabilityService,
} from "../../services/generate-word-capability-adapter.js";
import { handleGenerateWordToolRoute } from "../routes/generate-word-tool.js";
import type { RouteRegistration } from "../routing.js";
import type {
  BuiltinAgentToolAdapter,
  BuiltinToolArtifact,
  ToolContribution,
  ToolDeps,
  ToolModule,
  WorkerEndpointInput,
} from "./tool-registry.js";

export const GENERATE_WORD_TOOL_PATH_PREFIX = "/_pipeline-generate-word/";

export interface GenerateWordToolModuleServices {
  readonly generateWordToolService?: GenerateWordCapabilityService;
}

export interface GenerateWordToolModuleOptions {
  readonly toolService?: GenerateWordCapabilityService;
  readonly browserExecutablePath?: string;
  readonly endpoint?: WorkerEndpointInput;
}

declare module "./tool-registry.js" {
  interface ToolModuleOptions {
    readonly "generate-word"?: GenerateWordToolModuleOptions;
  }
}

export const generateWordToolModule: ToolModule<GenerateWordToolModuleServices> = {
  name: "generate-word",
  optionKeys: [
    "toolService",
    "browserExecutablePath",
    "endpoint",
  ],
  build(deps): ToolContribution<GenerateWordToolModuleServices> {
    const options = deps.moduleOptions?.["generate-word"];
    const generateWordToolService =
      options?.toolService ??
      (deps.workspacePath && deps.repoRootPath
        ? new GenerateWordToolService({
            workspacePath: deps.workspacePath,
            repoRootPath: deps.repoRootPath,
            ...whenDefined(options?.browserExecutablePath, (definedValue) => ({ browserExecutablePath: definedValue })),
          })
        : undefined);
    const capabilityPath = resolveEndpointPath(
      options?.endpoint ??
        (deps.createWorkerEndpointToken
          ? { token: deps.createWorkerEndpointToken("generate-word") }
          : undefined),
    );
    const dispatchInvoker =
      generateWordToolService && deps.capabilityDispatcher
        ? new GenerateWordCapabilityDispatchGateway({
            dispatcher: deps.capabilityDispatcher,
            service: generateWordToolService,
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
        ...(generateWordToolService ? { generateWordToolService } : {}),
      },
      routeOrder: 3,
      agentToolOrder: 3,
      routes,
      ...(dispatchInvoker && deps.runtimeCapabilityAuthority && capabilityPath
        ? {
            workerEndpoint: {
              environmentVariable: GENERATE_WORD_TOOL_URL_ENV,
              path: capabilityPath,
            },
          }
        : {}),
      ...(generateWordToolService && dispatchInvoker
        ? { agentTool: agentToolAdapter(generateWordToolService, dispatchInvoker) }
        : {}),
    };
  },
};

function capabilityRoute(
  capabilityPath: string,
  invoker: GenerateWordCapabilityDispatchInvoker,
  authority: NonNullable<ToolDeps['runtimeCapabilityAuthority']>,
): RouteRegistration {
  return {
    id: "generate-word-tool-capability",
    stage: "pre-auth-capability",
    authorization: "capability",
    streaming: "none",
    methods: ["POST"],
    path: { kind: "exact", path: capabilityPath },
    handler: async ({ req, res, url }) => {
      if (url.pathname !== capabilityPath || url.search) return false;
      await handleGenerateWordToolRoute({ req, res, invoker, authority });
      return true;
    },
  };
}

function agentToolAdapter(
  service: GenerateWordCapabilityService,
  invoker: GenerateWordCapabilityDispatchInvoker,
): BuiltinAgentToolAdapter {
  return {
    name: service.tool.namespacedName,
    tool: service.tool,
    isEnabledForAgent: (agentPath) => service.isEnabledForAgent(agentPath),
    execute: async ({ context, toolCallId, input, signal }) => {
      const output = await invoker.execute({
        context,
        authority: { kind: "mcp-lease", leaseId: context.leaseId },
        source: GENERATE_WORD_BUILTIN_SOURCE,
        toolCallId,
        input,
        ...(signal ? { signal } : {}),
      });
      return {
        output,
        content: JSON.stringify(output),
        isError: !output.ok,
        ...whenDefined(generateWordArtifacts(output), (artifacts) => ({ artifacts })),
      };
    },
  };
}

function generateWordArtifacts(
  output: GenerateWordToolOutput,
): readonly BuiltinToolArtifact[] | undefined {
  if (
    !output.ok ||
    output.action !== "generate" ||
    !output.outputPath ||
    !output.sourcePath
  ) {
    return undefined;
  }
  return [
    {
      path: output.outputPath,
      title: `${pathBasename(output.outputPath)} - Word document`,
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      role: "final",
      ...whenDefined(output.digest, (digest) => ({ digest })),
    },
    {
      path: output.sourcePath,
      title: `${pathBasename(output.sourcePath)} - Markdown source`,
      mediaType: "text/markdown",
      role: "secondary",
    },
  ];
}

function pathBasename(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? value;
}

function resolveEndpointPath(input: WorkerEndpointInput | undefined): string | undefined {
  if (!input) return undefined;
  if (input.path && input.token) {
    throw new Error("Generate Word endpoint accepts either path or token, not both");
  }
  const value = input.path ??
    (input.token
      ? `${GENERATE_WORD_TOOL_PATH_PREFIX}${input.token}`
      : undefined);
  if (
    !value ||
    !value.startsWith(GENERATE_WORD_TOOL_PATH_PREFIX) ||
    value.length === GENERATE_WORD_TOOL_PATH_PREFIX.length ||
    value.slice(GENERATE_WORD_TOOL_PATH_PREFIX.length).includes("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("Generate Word endpoint path is invalid");
  }
  return value;
}
