import type { McpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityRequestContext } from '../../contracts/runtime-capability-authority.js'

export const GENERATE_EXCEL_TOOL_NAME = 'generate_excel'
export const GENERATE_EXCEL_SERVER_ID = 'builtin.generate-excel'
export const GENERATE_EXCEL_TOOL_CONTRACT_VERSION = 2 as const
export const GENERATE_EXCEL_TOOL_URL_ENV = 'PIPELINE_GENERATE_EXCEL_TOOL_URL'
export const EXCEL_TEMPLATES_DIRECTORY = 'domains/excel-generation/templates'

export type ExcelProfileId =
  | 'business-workbook'
  | 'financial-model'
  | 'plain-data'

export interface ExcelGenerationProfile {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly fonts: {
    readonly body: string
    readonly bodySize: number
    readonly headerSize: number
    readonly titleSize: number
    readonly noteSize: number
  }
  readonly colors: {
    readonly ink: string
    readonly title: string
    readonly headerText: string
    readonly headerFill: string
    readonly zebraFill: string
    readonly note: string
    readonly border: string
  }
  readonly table: {
    readonly zebraStripes: boolean
    readonly autoFilter: boolean
    readonly freezeHeaderRow: boolean
    readonly minColumnWidth: number
    readonly maxColumnWidth: number
    readonly columnPadding: number
  }
  readonly numberFormats: {
    readonly integer: string
    readonly decimal: string
    readonly currency: string
    readonly percent: string
    readonly date: string
  }
  readonly sheet: {
    readonly includeTitleRow: boolean
  }
}

export interface GenerateExcelOptions {
  readonly profile?: string
  readonly profilePath?: string
  readonly title?: string
  readonly creator?: string
  readonly signal?: AbortSignal
}

export interface GenerateExcelResult {
  readonly buffer: Buffer
  readonly profile: ExcelGenerationProfile
  readonly warnings: readonly string[]
  readonly sheetNames: readonly string[]
}

export type ExcelTemplateValueType =
  | 'string'
  | 'number'
  | 'percent'
  | 'date'
  | 'boolean'

export interface ExcelTemplateCellInput {
  readonly type: ExcelTemplateValueType
  readonly required?: boolean
  readonly description?: string
  /** Workbook-level defined name that resolves to the target cell. */
  readonly range?: string
  /** Sheet name plus A1 address; the alternative to `range`. */
  readonly sheet?: string
  readonly cell?: string
}

export interface ExcelTemplateTableColumn {
  readonly key: string
  readonly type: ExcelTemplateValueType
  readonly description?: string
}

export interface ExcelTemplateTableInput {
  readonly description?: string
  readonly sheet: string
  readonly startCell: string
  readonly columns: readonly ExcelTemplateTableColumn[]
  /** Size of the writable region; extra data rows are dropped with a warning
   *  and unused rows inside the region are cleared of stale values. */
  readonly maxRows?: number
}

export interface ExcelTemplateManifest {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly templateFile: string
  readonly inputs: {
    readonly cells?: Readonly<Record<string, ExcelTemplateCellInput>>
    readonly tables?: Readonly<Record<string, ExcelTemplateTableInput>>
  }
}

export interface LoadedExcelTemplate {
  readonly manifest: ExcelTemplateManifest
  readonly templatePath: string
}

export type ExcelTemplateCellValue = string | number | boolean

export interface ExcelTemplateData {
  readonly cells?: Readonly<Record<string, ExcelTemplateCellValue>>
  readonly tables?: Readonly<
    Record<string, readonly Readonly<Record<string, ExcelTemplateCellValue>>[]>
  >
}

export interface FillExcelTemplateResult {
  readonly buffer: Buffer
  readonly warnings: readonly string[]
}

export type GenerateExcelAction =
  | 'list_profiles'
  | 'list_templates'
  | 'generate'
  | 'fill_template'

export interface GenerateExcelToolInput {
  readonly action: GenerateExcelAction
  /** `.md` source for generate, `.json` template data for fill_template. */
  readonly inputPath?: string
  readonly outputPath?: string
  readonly profile?: string
  readonly template?: string
}

export interface GenerateExcelTemplateSummary {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly cells: readonly {
    readonly name: string
    readonly type: ExcelTemplateValueType
    readonly required: boolean
    readonly description?: string
  }[]
  readonly tables: readonly {
    readonly name: string
    readonly columns: readonly ExcelTemplateTableColumn[]
    readonly maxRows?: number
    readonly description?: string
  }[]
}

export interface GenerateExcelToolOutput {
  readonly ok: boolean
  readonly action: GenerateExcelAction
  readonly outputPath?: string
  readonly sizeBytes?: number
  readonly digest?: string
  readonly profile?: string
  readonly template?: string
  readonly sheetNames?: readonly string[]
  readonly profiles?: readonly {
    readonly id: string
    readonly displayName: string
    readonly description: string
  }[]
  readonly templates?: readonly GenerateExcelTemplateSummary[]
  readonly warnings?: readonly string[]
  readonly error?: {
    readonly code: 'invalid_request' | 'not_enabled' | 'not_found' | 'generation_failed' | 'cancelled' | 'internal'
    readonly message: string
    readonly retryable: boolean
  }
}

export interface GenerateExcelToolRequest {
  readonly version: typeof GENERATE_EXCEL_TOOL_CONTRACT_VERSION
  readonly context: RuntimeCapabilityRequestContext
  readonly toolCallId: string
  readonly input: GenerateExcelToolInput
}

export interface GenerateExcelToolResponse {
  readonly version: typeof GENERATE_EXCEL_TOOL_CONTRACT_VERSION
  readonly output: GenerateExcelToolOutput
}

export function generateExcelToolInputSchema(): McpJsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['list_profiles', 'list_templates', 'generate', 'fill_template'],
      },
      inputPath: { type: 'string', maxLength: 512 },
      outputPath: { type: 'string', maxLength: 512 },
      profile: { type: 'string', maxLength: 128 },
      template: { type: 'string', maxLength: 128 },
    },
  }
}
