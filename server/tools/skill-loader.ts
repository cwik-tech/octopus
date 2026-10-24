import { SkillLoaderService } from '../../services/skill-loader-service.js'
import {
  SkillLoaderCapabilityDispatchGateway,
  type SkillLoaderCapabilityDispatchInvoker,
} from '../../services/skill-loader-capability-adapter.js'
import type {
  BuiltinAgentToolAdapter,
  ToolContribution,
  ToolModule,
} from './tool-registry.js'

export interface SkillLoaderToolModuleServices {
  readonly skillLoaderService?: SkillLoaderToolModuleService
}

export interface SkillLoaderToolModuleService
  extends Pick<
    SkillLoaderService,
    'tool' | 'isEnabledForAgent' | 'execute'
  > {}

export interface SkillLoaderToolModuleOptions {
  readonly toolService?: SkillLoaderToolModuleService
  readonly dispatchInvoker?: SkillLoaderCapabilityDispatchInvoker
}

declare module './tool-registry.js' {
  interface ToolModuleOptions {
    readonly 'skill-loader'?: SkillLoaderToolModuleOptions
  }
}

export const skillLoaderToolModule: ToolModule<SkillLoaderToolModuleServices> = {
  name: 'skill-loader',
  optionKeys: ['toolService', 'dispatchInvoker'],
  build(deps): ToolContribution<SkillLoaderToolModuleServices> {
    const dispatcher = deps.capabilityDispatcher;
    const service = deps.moduleOptions?.['skill-loader']?.toolService ??
      (deps.repoRootPath
        ? new SkillLoaderService({ repoRootPath: deps.repoRootPath })
        : undefined)
    const dispatchInvoker =
      deps.moduleOptions?.['skill-loader']?.dispatchInvoker ??
      (service && deps.capabilityDispatcher
        ? new SkillLoaderCapabilityDispatchGateway({
            dispatcher: deps.capabilityDispatcher,
            service,
          })
        : undefined)
    return {
      services: {
        ...(service ? { skillLoaderService: service } : {}),
      },
      routes: [],
      ...(service && dispatchInvoker
        ? {
            agentTool: {
              ...agentToolAdapter(service, dispatchInvoker),
              ...(dispatcher ? {
                forResourceRoot: (repoRootPath: string) => {
                  const projectedService = new SkillLoaderService({ repoRootPath });
                  return agentToolAdapter(projectedService, new SkillLoaderCapabilityDispatchGateway({
                    dispatcher,
                    service: projectedService,
                  }));
                },
              } : {}),
            },
            agentToolOrder: 5,
          }
        : {}),
    }
  },
}

function agentToolAdapter(
  service: SkillLoaderToolModuleService,
  invoker: SkillLoaderCapabilityDispatchInvoker,
): BuiltinAgentToolAdapter {
  return {
    name: service.tool.namespacedName,
    tool: service.tool,
    isEnabledForAgent: (agentPath) => service.isEnabledForAgent(agentPath),
    execute: async ({ context, toolCallId, input, signal }) => {
      const output = await invoker.execute({
        context,
        authority: { kind: 'mcp-lease', leaseId: context.leaseId },
        source: { kind: 'builtin', id: 'pipeline-skills', version: '1' },
        toolCallId,
        input,
        ...(signal ? { signal } : {}),
      })
      return {
        output,
        content: JSON.stringify(output),
        isError: !output.ok,
      }
    },
  }
}
