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
  GENERATE_EXCEL_SERVER_ID,
  GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
  type GenerateExcelAction,
  type GenerateExcelToolOutput,
} from '../domains/excel-generation/generate-excel-types.js'
import type { GenerateExcelToolService } from './generate-excel-tool-service.js'
import { parseGenerateExcelToolInput } from './generate-excel-tool-service.js'
import {
  type BuiltinCapabilityContext,
  toBuiltinCapabilityExecutionContext,
} from './builtin-capability-context.js'

export const GENERATE_EXCEL_CAPABILITY_ID = 'excel.generate'

export type GenerateExcelCapabilityService = Pick<
  GenerateExcelToolService,
  'tool' | 'isEnabledForAgent' | 'execute'
>

export interface GenerateExcelCapabilityDispatchInput {
  readonly context: BuiltinCapabilityContext
  readonly authority: CapabilityScopeAuthority
  readonly source: CapabilityInvocationIdentity['source']
  readonly toolCallId: string
  readonly input: McpJsonObject
  readonly initialAuthorityEvidence?: unknown
  readonly signal?: AbortSignal
}

export interface GenerateExcelCapabilityDispatchInvoker {
  execute(input: GenerateExcelCapabilityDispatchInput): Promise<GenerateExcelToolOutput>
}

export class GenerateExcelCapabilityDispatchGateway
  implements GenerateExcelCapabilityDispatchInvoker {
  constructor(private readonly options: {
    readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
    readonly service: GenerateExcelCapabilityService
  }) {}

  async execute(
    input: GenerateExcelCapabilityDispatchInput,
  ): Promise<GenerateExcelToolOutput> {
    const action = excelAction(input.input.action)
    const result = await this.options.dispatcher.dispatch({
      context: toBuiltinCapabilityExecutionContext(input.context, input.authority),
      invocation: {
        capabilityId: GENERATE_EXCEL_CAPABILITY_ID,
        source: input.source,
        toolCallId: input.toolCallId,
        input: input.input,
      },
      adapter: new GenerateExcelCapabilityAdapter({
        service: this.options.service,
        context: input.context,
      }),
      ...(input.initialAuthorityEvidence === undefined
        ? {}
        : { initialAuthorityEvidence: input.initialAuthorityEvidence }),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (result.status === 'completed') {
      return readGenerateExcelOutput(result.value, action) ?? excelFailure(
        action,
        'internal',
        'Generate Excel capability returned an invalid result.',
      )
    }
    const projected = readGenerateExcelOutput(result.detail, action)
    if (projected) return projected
    if (result.status === 'cancelled') {
      return excelFailure(action, 'cancelled', 'Generate Excel was cancelled.')
    }
    return excelFailure(
      action,
      'internal',
      result.status === 'indeterminate'
        ? 'Generate Excel outcome is indeterminate.'
        : 'Generate Excel failed.',
    )
  }
}

class GenerateExcelCapabilityAdapter implements CapabilityAdapter {
  readonly capabilityId = GENERATE_EXCEL_CAPABILITY_ID

  constructor(private readonly options: {
    readonly service: GenerateExcelCapabilityService
    readonly context: BuiltinCapabilityContext
  }) {}

  async prepare(
    input: Parameters<CapabilityAdapter['prepare']>[0],
  ): Promise<CapabilityPreparedExecution> {
    const rawInput = toMcpJsonObject(input.arguments)
    let action: GenerateExcelAction
    try {
      action = parseGenerateExcelToolInput(rawInput).action
    } catch {
      throw new CapabilityDispatchRejection(
        'invalid_request',
        excelFailure(
          excelAction(rawInput.action),
          'invalid_request',
          'Generate Excel request is invalid.',
        ),
      )
    }
    let terminalOutput: GenerateExcelToolOutput | undefined
    const enabledDecision = () => this.options.service.isEnabledForAgent(
      this.options.context.agentPath,
    )
      ? { kind: 'allow' as const }
      : {
          kind: 'deny' as const,
          code: 'not_enabled',
          reason: 'This agent is not allowed to use Generate Excel.',
          detail: excelFailure(
            action,
            'not_enabled',
            'This agent is not allowed to use Generate Excel.',
          ),
        }
    return {
      effect: serialCapabilityEffect(
        action === 'list_profiles' || action === 'list_templates'
          ? 'read-only'
          : 'mutating',
      ),
      risk: action === 'list_profiles' || action === 'list_templates'
        ? 'read-only'
        : 'mutating',
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
        if (!isGenerateExcelOutput(rawOutput, action)) {
          terminalOutput = excelFailure(
            action,
            'internal',
            'Generate Excel capability returned an invalid result.',
          )
          throw new Error('Generate Excel executor returned invalid output.')
        }
        terminalOutput = rawOutput
        if (!rawOutput.ok) {
          throw new Error('Generate Excel executor returned a domain failure.')
        }
        return rawOutput
      },
      acceptResult: async ({ value }) => {
        if (!isGenerateExcelOutput(value, action) || !value.ok) {
          throw new Error('Generate Excel result acceptance failed.')
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

function readGenerateExcelOutput(
  value: unknown,
  expectedAction: GenerateExcelAction,
): GenerateExcelToolOutput | null {
  return isGenerateExcelOutput(value, expectedAction) ? value : null
}

function isGenerateExcelOutput(
  value: unknown,
  expectedAction: GenerateExcelAction,
): value is GenerateExcelToolOutput {
  if (!isRecord(value) || value.action !== expectedAction) return false
  if (value.digest !== undefined && (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest))) return false
  if (value.ok === false) {
    return isRecord(value.error) &&
      isExcelErrorCode(value.error.code) &&
      typeof value.error.message === 'string' &&
      typeof value.error.retryable === 'boolean'
  }
  if (value.ok !== true) return false
  switch (expectedAction) {
    case 'list_profiles':
      return Array.isArray(value.profiles) &&
        value.profiles.every(isExcelProfile)
    case 'list_templates':
      return Array.isArray(value.templates) &&
        value.templates.every(isExcelTemplate) &&
        isStringArray(value.warnings)
    case 'generate':
      return isNonEmptyText(value.outputPath) &&
        isNonNegativeInteger(value.sizeBytes) &&
        isNonEmptyText(value.profile) &&
        isStringArray(value.sheetNames) &&
        isStringArray(value.warnings)
    case 'fill_template':
      return isNonEmptyText(value.outputPath) &&
        isNonNegativeInteger(value.sizeBytes) &&
        isNonEmptyText(value.template) &&
        isStringArray(value.warnings)
  }
}

function excelAction(value: unknown): GenerateExcelAction {
  if (
    value === 'list_profiles' ||
    value === 'list_templates' ||
    value === 'fill_template'
  ) return value
  return 'generate'
}

function excelFailure(
  action: GenerateExcelAction,
  code: NonNullable<GenerateExcelToolOutput['error']>['code'],
  message: string,
): GenerateExcelToolOutput {
  return {
    ok: false,
    action,
    error: { code, message, retryable: code === 'internal' },
  }
}

function isExcelErrorCode(
  value: unknown,
): value is NonNullable<GenerateExcelToolOutput['error']>['code'] {
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

function isExcelProfile(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyText(value.id) &&
    isNonEmptyText(value.displayName) &&
    typeof value.description === 'string'
}

function isExcelTemplate(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyText(value.id) &&
    isNonEmptyText(value.displayName) &&
    typeof value.description === 'string' &&
    Array.isArray(value.cells) &&
    value.cells.every(isExcelTemplateCell) &&
    Array.isArray(value.tables) &&
    value.tables.every(isExcelTemplateTable)
}

function isExcelTemplateCell(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyText(value.name) &&
    isExcelValueType(value.type) &&
    typeof value.required === 'boolean' &&
    (value.description === undefined || typeof value.description === 'string')
}

function isExcelTemplateTable(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyText(value.name) &&
    Array.isArray(value.columns) &&
    value.columns.every(isExcelTemplateColumn) &&
    (value.maxRows === undefined || isNonNegativeInteger(value.maxRows)) &&
    (value.description === undefined || typeof value.description === 'string')
}

function isExcelTemplateColumn(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyText(value.key) &&
    isExcelValueType(value.type) &&
    (value.description === undefined || typeof value.description === 'string')
}

function isExcelValueType(value: unknown): boolean {
  return value === 'string' ||
    value === 'number' ||
    value === 'percent' ||
    value === 'date' ||
    value === 'boolean'
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

export const GENERATE_EXCEL_BUILTIN_SOURCE = Object.freeze({
  kind: 'builtin' as const,
  id: GENERATE_EXCEL_SERVER_ID,
  version: String(GENERATE_EXCEL_TOOL_CONTRACT_VERSION),
})
