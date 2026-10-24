import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { toMcpJsonObject } from '../contracts/mcp.js'
import type { CapabilityScopeAuthority } from '../contracts/capability-dispatch.js'
import type { SkillLoaderCapabilityDispatchInvoker } from '../services/skill-loader-capability-adapter.js'
import type { BuiltinCapabilityExecutionContextInput } from '../services/builtin-capability-context.js'

export const STANDALONE_SKILL_LOADER_TOOL_NAME = 'mcp__pipeline_skills__load_skill'

export interface StandaloneSkillLoaderToolOptions {
  readonly dispatchInvoker: SkillLoaderCapabilityDispatchInvoker
  readonly getInvocationContext: () => {
    readonly context: BuiltinCapabilityExecutionContextInput
    readonly authority: CapabilityScopeAuthority
  }
}

export function createStandaloneSkillLoaderTool(
  options: StandaloneSkillLoaderToolOptions,
) {
  return defineTool({
    name: STANDALONE_SKILL_LOADER_TOOL_NAME,
    label: 'Load Skill',
    description: 'Load one discovered agent skill after verifying its exact source hash.',
    promptSnippet: 'Load skill instructions from the active agent catalog when they apply.',
    parameters: Type.Object({
      source: Type.String(),
      sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const invocationContext = options.getInvocationContext()
      const output = await options.dispatchInvoker.execute({
        context: invocationContext.context,
        authority: invocationContext.authority,
        source: {
          kind: 'pi-host',
          id: 'team-runtime:standalone-skill-loader',
          version: '1',
        },
        toolCallId,
        input: toMcpJsonObject(params),
        ...(signal ? { signal } : {}),
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        details: output,
      }
    },
  })
}
