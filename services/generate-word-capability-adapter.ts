import { serialCapabilityEffect } from '../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityInvocationIdentity,
  CapabilityPreparedExecution,
  CapabilityScopeAuthority,
} from '../contracts/capability-dispatch.js'
import { toMcpJsonObject, type McpJsonObject } from '../contracts/mcp.js'
import {
  CapabilityDispatchRejection,
  type CapabilityDispatcher,
} from '../core/capability-dispatcher.js'
import {
  GENERATE_WORD_SERVER_ID,
  GENERATE_WORD_TOOL_CONTRACT_VERSION,
  type GenerateWordAction,
  type GenerateWordToolOutput,
} from '../domains/word-generation/generate-word-types.js'
import type { GenerateWordToolService } from './generate-word-tool-service.js'
import { parseGenerateWordToolInput } from './generate-word-tool-service.js'
import {
  type BuiltinCapabilityContext,
  toBuiltinCapabilityExecutionContext,
} from './builtin-capability-context.js'

export const GENERATE_WORD_CAPABILITY_ID = 'word.generate'

export type GenerateWordCapabilityService = Pick<
  GenerateWordToolService,
  'tool' | 'isEnabledForAgent' | 'execute'
>

export interface GenerateWordCapabilityDispatchInput {
  readonly context: BuiltinCapabilityContext
  readonly authority: CapabilityScopeAuthority
  readonly source: CapabilityInvocationIdentity['source']
  readonly toolCallId: string
  readonly input: McpJsonObject
  readonly initialAuthorityEvidence?: unknown
  readonly signal?: AbortSignal
}

export interface GenerateWordCapabilityDispatchInvoker {
  execute(input: GenerateWordCapabilityDispatchInput): Promise<GenerateWordToolOutput>
}

export class GenerateWordCapabilityDispatchGateway
  implements GenerateWordCapabilityDispatchInvoker {
  constructor(private readonly options: {
    readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
    readonly service: GenerateWordCapabilityService
  }) {}

  async execute(
    input: GenerateWordCapabilityDispatchInput,
  ): Promise<GenerateWordToolOutput> {
    const action = wordAction(input.input.action)
    const result = await this.options.dispatcher.dispatch({
      context: toBuiltinCapabilityExecutionContext(input.context, input.authority),
      invocation: {
        capabilityId: GENERATE_WORD_CAPABILITY_ID,
        source: input.source,
        toolCallId: input.toolCallId,
        input: input.input,
      },
      adapter: new GenerateWordCapabilityAdapter({
        service: this.options.service,
        context: input.context,
      }),
      ...(input.initialAuthorityEvidence === undefined
        ? {}
        : { initialAuthorityEvidence: input.initialAuthorityEvidence }),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (result.status === 'completed') {
      return readGenerateWordOutput(result.value, action) ?? wordFailure(
        action,
        'internal',
        'Generate Word capability returned an invalid result.',
      )
    }
    const projected = readGenerateWordOutput(result.detail, action)
    if (projected) return projected
    if (result.status === 'cancelled') {
      return wordFailure(action, 'cancelled', 'Generate Word was cancelled.')
    }
    return wordFailure(
      action,
      'internal',
      result.status === 'indeterminate'
        ? 'Generate Word outcome is indeterminate.'
        : 'Generate Word failed.',
    )
  }
}

class GenerateWordCapabilityAdapter implements CapabilityAdapter {
  readonly capabilityId = GENERATE_WORD_CAPABILITY_ID

  constructor(private readonly options: {
    readonly service: GenerateWordCapabilityService
    readonly context: BuiltinCapabilityContext
  }) {}

  async prepare(
    input: Parameters<CapabilityAdapter['prepare']>[0],
  ): Promise<CapabilityPreparedExecution> {
    const rawInput = toMcpJsonObject(input.arguments)
    let action: GenerateWordAction
    try {
      action = parseGenerateWordToolInput(rawInput).action
    } catch {
      throw new CapabilityDispatchRejection(
        'invalid_request',
        wordFailure(
          wordAction(rawInput.action),
          'invalid_request',
          'Generate Word request is invalid.',
        ),
      )
    }
    let terminalOutput: GenerateWordToolOutput | undefined
    const enabledDecision = () => this.options.service.isEnabledForAgent(
      this.options.context.agentPath,
    )
      ? { kind: 'allow' as const }
      : {
          kind: 'deny' as const,
          code: 'not_enabled',
          reason: 'This agent is not allowed to use Generate Word.',
          detail: wordFailure(
            action,
            'not_enabled',
            'This agent is not allowed to use Generate Word.',
          ),
        }
    return {
      effect: serialCapabilityEffect(
        action === 'list_profiles' ? 'read-only' : 'mutating',
      ),
      risk: action === 'list_profiles' ? 'read-only' : 'mutating',
      argumentNames: Object.keys(rawInput).sort(),
      policyDecision: { kind: 'allow' },
      authorize: async () => enabledDecision(),
      execute: async ({ signal }) => {
        const rawOutput: unknown = await this.options.service.execute(
          this.options.context,
          input.invocation.toolCallId,
          rawInput,
          signal,
        )
        if (!isGenerateWordOutput(rawOutput, action)) {
          terminalOutput = wordFailure(
            action,
            'internal',
            'Generate Word capability returned an invalid result.',
          )
          throw new Error('Generate Word executor returned invalid output.')
        }
        terminalOutput = rawOutput
        if (!rawOutput.ok) {
          throw new Error('Generate Word executor returned a domain failure.')
        }
        return rawOutput
      },
      acceptResult: async ({ value }) => {
        if (!isGenerateWordOutput(value, action) || !value.ok) {
          throw new Error('Generate Word result acceptance failed.')
        }
        return { value }
      },
      projectLifecycle: async (transition) =>
        transition.kind === 'terminal' &&
        transition.result.status !== 'completed' &&
        terminalOutput
          ? { detail: terminalOutput }
          : undefined,
    }
  }
}

function readGenerateWordOutput(
  value: unknown,
  expectedAction: GenerateWordAction,
): GenerateWordToolOutput | null {
  return isGenerateWordOutput(value, expectedAction) ? value : null
}

function isGenerateWordOutput(
  value: unknown,
  expectedAction: GenerateWordAction,
): value is GenerateWordToolOutput {
  if (!isRecord(value) || value.action !== expectedAction) return false
  if (value.digest !== undefined && (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest))) return false
  if (value.ok === false) {
    return isRecord(value.error) &&
      isWordErrorCode(value.error.code) &&
      typeof value.error.message === 'string' &&
      typeof value.error.retryable === 'boolean'
  }
  if (value.ok !== true) return false
  if (expectedAction === 'list_profiles') {
    return Array.isArray(value.profiles) && value.profiles.every(isWordProfile)
  }
  return isNonEmptyText(value.outputPath) &&
    isNonEmptyText(value.sourcePath) &&
    isNonNegativeInteger(value.sizeBytes) &&
    isNonEmptyText(value.profile) &&
    isStringArray(value.warnings)
}

function wordAction(value: unknown): GenerateWordAction {
  return value === 'list_profiles' ? value : 'generate'
}

function wordFailure(
  action: GenerateWordAction,
  code: NonNullable<GenerateWordToolOutput['error']>['code'],
  message: string,
): GenerateWordToolOutput {
  return {
    ok: false,
    action,
    error: { code, message, retryable: code === 'internal' },
  }
}

function isWordErrorCode(
  value: unknown,
): value is NonNullable<GenerateWordToolOutput['error']>['code'] {
  return value === 'invalid_request' ||
    value === 'not_enabled' ||
    value === 'not_found' ||
    value === 'generation_failed' ||
    value === 'cancelled' ||
    value === 'internal'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isWordProfile(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyText(value.id) &&
    isNonEmptyText(value.displayName) &&
    typeof value.description === 'string'
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export const GENERATE_WORD_BUILTIN_SOURCE = Object.freeze({
  kind: 'builtin' as const,
  id: GENERATE_WORD_SERVER_ID,
  version: String(GENERATE_WORD_TOOL_CONTRACT_VERSION),
})
