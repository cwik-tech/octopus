import { createHash } from 'node:crypto'

import { toMcpJsonObject, type McpJsonObject } from '../contracts/mcp.js'
import { hostAuditedParallelReadEffect } from '../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityDispatchResult,
  CapabilityInvocationIdentity,
  CapabilityPolicyDecision,
  CapabilityPreparedExecution,
  CapabilityScopeAuthority,
} from '../contracts/capability-dispatch.js'
import {
  CapabilityDispatchRejection,
  type CapabilityDispatcher,
} from '../core/capability-dispatcher.js'
import {
  type BuiltinCapabilityExecutionContextInput,
  toBuiltinCapabilityExecutionContext,
} from './builtin-capability-context.js'
import {
  SkillLoaderService,
  type LoadSkillOutput,
} from './skill-loader-service.js'

export const SKILL_LOADER_CAPABILITY_ID = 'skill.load'

export interface SkillLoaderCapabilityDispatchInput {
  readonly context: BuiltinCapabilityExecutionContextInput
  readonly authority: CapabilityScopeAuthority
  readonly source: CapabilityInvocationIdentity['source']
  readonly toolCallId: string
  readonly input: McpJsonObject
  readonly signal?: AbortSignal
}

export interface SkillLoaderCapabilityDispatchInvoker {
  execute(input: SkillLoaderCapabilityDispatchInput): Promise<LoadSkillOutput>
}

export interface SkillLoaderCapabilityService {
  isEnabledForAgent(agentPath: string): boolean
  execute(agentPath: string, input: McpJsonObject): Promise<LoadSkillOutput>
}

export function createSkillLoaderCapabilityDispatchInvoker(input: {
  readonly repoRootPath: string
  readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
}): SkillLoaderCapabilityDispatchInvoker {
  return new SkillLoaderCapabilityDispatchGateway({
    dispatcher: input.dispatcher,
    service: new SkillLoaderService({ repoRootPath: input.repoRootPath }),
  })
}

export class SkillLoaderCapabilityDispatchGateway
  implements SkillLoaderCapabilityDispatchInvoker {
  constructor(private readonly options: {
    readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
    readonly service: SkillLoaderCapabilityService
  }) {}

  async execute(input: SkillLoaderCapabilityDispatchInput): Promise<LoadSkillOutput> {
    const result = await this.options.dispatcher.dispatch({
      context: toBuiltinCapabilityExecutionContext(
        input.context,
        input.authority,
      ),
      invocation: {
        capabilityId: SKILL_LOADER_CAPABILITY_ID,
        source: input.source,
        toolCallId: input.toolCallId,
        input: input.input,
      },
      adapter: new SkillLoaderCapabilityAdapter({
        service: this.options.service,
        agentPath: input.context.agentPath,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (result.status === 'completed' && isLoadSkillOutput(result.value)) {
      return result.value
    }
    if (result.status !== 'completed' && isLoadSkillOutput(result.detail)) {
      return result.detail
    }
    return dispatchFailureOutput(result)
  }
}

interface SkillLoaderCapabilityAdapterOptions {
  readonly service: SkillLoaderCapabilityService
  readonly agentPath: string
}

export class SkillLoaderCapabilityAdapter implements CapabilityAdapter {
  readonly capabilityId = SKILL_LOADER_CAPABILITY_ID

  constructor(private readonly options: SkillLoaderCapabilityAdapterOptions) {}

  async prepare(
    input: Parameters<CapabilityAdapter['prepare']>[0],
  ): Promise<CapabilityPreparedExecution> {
    const argumentsObject = toMcpJsonObject(input.arguments)
    if (!isSkillLoaderInput(argumentsObject)) {
      throw new CapabilityDispatchRejection(
        'invalid_skill_request',
        {
          ok: false,
          code: 'invalid_skill_request',
          message: 'Skill source and SHA-256 are required.',
        } satisfies LoadSkillOutput,
      )
    }
    let terminalOutput: LoadSkillOutput | undefined
    const enabledDecision = (): CapabilityPolicyDecision =>
      this.options.service.isEnabledForAgent(
        this.options.agentPath,
      )
        ? { kind: 'allow' }
        : {
            kind: 'deny',
            code: 'skill_source_not_allowed',
            reason: 'This agent has no discoverable skill catalog.',
            detail: {
              ok: false,
              code: 'skill_source_not_allowed',
              message: 'This agent has no discoverable skill catalog.',
            },
          }
    return {
      // Host-audited parallel read — see the audit note on the tool
      // inventory effect in skill-loader-service.ts.
      effect: hostAuditedParallelReadEffect(),
      risk: 'read-only',
      argumentNames: Object.keys(argumentsObject).sort(),
      policyDecision: { kind: 'allow' },
      authorize: async () => enabledDecision(),
      execute: async () => {
        const output: unknown = await this.options.service.execute(
          this.options.agentPath,
          argumentsObject,
        )
        if (!isLoadSkillOutput(output)) {
          terminalOutput = {
            ok: false,
            code: 'internal',
            message: 'Skill loader returned an invalid result.',
          }
          throw new Error('Skill loader returned an invalid domain result.')
        }
        terminalOutput = output
        if (!output.ok) {
          throw new Error('Skill loader returned a domain failure.')
        }
        return output
      },
      acceptResult: async ({ value }) => {
        if (!isLoadSkillOutput(value)) {
          throw new Error('Skill loader returned an invalid domain result.')
        }
        return { value }
      },
      projectLifecycle: async (transition) => {
        if (
          transition.kind !== 'terminal' ||
          transition.result.status === 'completed'
        ) {
          return undefined
        }
        return terminalOutput ? { detail: terminalOutput } : undefined
      },
    }
  }
}

function dispatchFailureOutput(result: CapabilityDispatchResult): LoadSkillOutput {
  if (result.status === 'rejected') {
    return {
      ok: false,
      code: result.code,
      message: 'Skill loading was denied by capability policy.',
    }
  }
  if (result.status === 'cancelled') {
    return {
      ok: false,
      code: 'cancelled',
      message: 'Skill loading was cancelled.',
    }
  }
  return {
    ok: false,
    code: result.status === 'indeterminate' ? 'indeterminate' : 'internal',
    message: result.status === 'indeterminate'
      ? 'Skill loading outcome is indeterminate.'
      : 'Skill loading failed.',
  }
}

function isLoadSkillOutput(value: unknown): value is LoadSkillOutput {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (value.ok) {
    return typeof value.name === 'string' &&
      typeof value.source === 'string' &&
      typeof value.sha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(value.sha256) &&
      typeof value.content === 'string' &&
      createHash('sha256').update(value.content).digest('hex') === value.sha256
  }
  return typeof value.code === 'string' && typeof value.message === 'string'
}

function isSkillLoaderInput(value: McpJsonObject): boolean {
  const keys = Object.keys(value)
  return keys.length === 2 &&
    keys.every((key) => key === 'source' || key === 'sha256') &&
    typeof value.source === 'string' &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
