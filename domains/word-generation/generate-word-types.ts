import type { McpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityRequestContext } from '../../contracts/runtime-capability-authority.js'

export const GENERATE_WORD_TOOL_NAME = 'generate_word'
export const GENERATE_WORD_SERVER_ID = 'builtin.generate-word'
export const GENERATE_WORD_TOOL_CONTRACT_VERSION = 3 as const
export const GENERATE_WORD_TOOL_URL_ENV = 'PIPELINE_GENERATE_WORD_TOOL_URL'

export type WordProfileId =
  | 'business-report'
  | 'executive-summary'
  | 'research-report'
  | 'proposal'
  | 'instruction-manual'

export interface WordGenerationProfile {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly page: {
    readonly widthDxa: number
    readonly heightDxa: number
    readonly marginDxa: number
    readonly headerFooterDxa: number
  }
  readonly typography: {
    readonly bodyFont: string
    readonly headingFont: string
    readonly codeFont: string
    readonly bodySize: number
    readonly titleSize: number
    readonly headingSizes: readonly [number, number, number, number, number, number]
    readonly inlineCodeSize: number
    readonly codeBlockSize: number
    readonly tableSize: number
    readonly footerSize: number
    readonly lineSpacing: number
    readonly paragraphAfter: number
  }
  readonly layout: {
    readonly headingBefore: readonly [number, number, number, number, number, number]
    readonly headingAfter: readonly [number, number, number, number, number, number]
    readonly titleAfter: number
    readonly tocTitleBefore: number
    readonly tocTitleAfter: number
    readonly quoteIndentLeft: number
    readonly quoteIndentRight: number
    readonly quoteBefore: number
    readonly quoteAfter: number
    readonly quoteBorderSize: number
    readonly quoteBorderSpace: number
    readonly codeBefore: number
    readonly codeAfter: number
    readonly codeLineSpacing: number
    readonly codeIndent: number
    readonly listAfter: number
    readonly listIndentPerLevel: number
    readonly listHanging: number
    readonly tableIndent: number
    readonly tableCellMargin: number
    readonly tableCellMarginVertical: number
    readonly tableParagraphAfter: number
    readonly tableLineSpacing: number
    readonly tableBorderSize: number
    readonly codeBorderSize: number
    readonly dividerBefore: number
    readonly dividerAfter: number
    readonly dividerSize: number
    readonly imageBefore: number
    readonly imageAfter: number
  }
  readonly colors: {
    readonly ink: string
    readonly heading: string
    readonly headingDark: string
    readonly muted: string
    readonly border: string
    readonly tableHeader: string
    readonly code: string
    readonly link: string
  }
  readonly tableOfContents: {
    readonly enabled: boolean
    readonly heading: string
    readonly depth: number
  }
  readonly headerText: string
  readonly image: {
    readonly maxWidthPx: number
    readonly maxHeightPx: number
  }
  readonly mermaid: {
    readonly enabled: boolean
    readonly theme: 'default' | 'neutral' | 'dark' | 'forest' | 'base'
    readonly backgroundColor: string
    readonly paddingPx: number
  }
}

export interface GenerateWordOptions {
  readonly profile?: string
  readonly profilePath?: string
  readonly title?: string
  readonly creator?: string
  readonly headerText?: string
  readonly sourceDirectory?: string
  readonly tableOfContents?: boolean
  readonly renderMermaid?: boolean
  readonly mermaidFailure?: 'error' | 'keep-code'
  readonly browserExecutablePath?: string
  readonly signal?: AbortSignal
}

export interface GenerateWordResult {
  readonly buffer: Buffer
  readonly profile: WordGenerationProfile
  readonly warnings: readonly string[]
}

export type GenerateWordAction = 'list_profiles' | 'generate'

export interface GenerateWordToolInput {
  readonly action: GenerateWordAction
  readonly inputPath?: string
  readonly markdown?: string
  readonly outputPath?: string
  readonly profile?: string
  readonly tableOfContents?: boolean
  readonly renderMermaid?: boolean
}

export interface GenerateWordToolOutput {
  readonly ok: boolean
  readonly action: GenerateWordAction
  readonly outputPath?: string
  readonly sourcePath?: string
  readonly sizeBytes?: number
  readonly digest?: string
  readonly profile?: string
  readonly profiles?: readonly {
    readonly id: string
    readonly displayName: string
    readonly description: string
  }[]
  readonly warnings?: readonly string[]
  readonly error?: {
    readonly code: 'invalid_request' | 'not_enabled' | 'not_found' | 'generation_failed' | 'cancelled' | 'internal'
    readonly message: string
    readonly retryable: boolean
  }
}

export interface GenerateWordToolRequest {
  readonly version: typeof GENERATE_WORD_TOOL_CONTRACT_VERSION
  readonly context: RuntimeCapabilityRequestContext
  readonly toolCallId: string
  readonly input: GenerateWordToolInput
}

export interface GenerateWordToolResponse {
  readonly version: typeof GENERATE_WORD_TOOL_CONTRACT_VERSION
  readonly output: GenerateWordToolOutput
}

export function generateWordToolInputSchema(): McpJsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['list_profiles', 'generate'],
      },
      inputPath: { type: 'string', maxLength: 512 },
      markdown: { type: 'string', maxLength: 10 * 1_024 * 1_024 },
      outputPath: { type: 'string', maxLength: 512 },
      profile: { type: 'string', maxLength: 128 },
      tableOfContents: { type: 'boolean' },
      renderMermaid: { type: 'boolean' },
    },
  }
}
