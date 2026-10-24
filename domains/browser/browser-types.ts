import type { McpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityRequestContext } from '../../contracts/runtime-capability-authority.js'
import type { SourceObservationReceiptView } from '../acquisition/acquisition-types.js'

/**
 * Browser activity entries retained per session.
 *
 * The journal is a window, not a history: at this cap the oldest entries are
 * dropped. A reader that asserts something never happened must check whether
 * the window is full first.
 */
export const MAX_BROWSER_ACTIVITY_PER_SESSION = 300

export const BROWSER_TOOL_NAME = 'browser'
export const BROWSER_SERVER_ID = 'builtin.browser'
export const BROWSER_TOOL_CONTRACT_VERSION = 3 as const
export const BROWSER_TOOL_URL_ENV = 'PIPELINE_BROWSER_TOOL_URL'

export type BrowserAction =
  | 'open'
  | 'observe'
  | 'navigate'
  | 'go_back'
  | 'click'
  | 'type'
  | 'select'
  | 'press'
  | 'scroll'
  | 'wait'
  | 'read_content'
  | 'search_content'
  | 'screenshot'
  | 'download'
  | 'close'

export function browserApprovalToolName(action: BrowserAction): string {
  return `mcp__builtin-browser__${action}`
}

export interface BrowserToolInput {
  readonly action: BrowserAction
  readonly pageId?: string
  readonly url?: string
  readonly ref?: string
  readonly text?: string
  readonly value?: string
  readonly key?: string
  readonly direction?: 'up' | 'down' | 'top' | 'bottom'
  readonly amount?: number
  readonly waitFor?: 'delay' | 'text' | 'url' | 'element' | 'change' | 'network_idle'
  readonly query?: string
  readonly snapshotId?: string
  readonly contentId?: string
  readonly chunkIndex?: number
  readonly waitMs?: number
  readonly timeoutMs?: number
}

export interface BrowserElementView {
  readonly ref: string
  readonly tag: string
  readonly role?: string
  readonly name: string
  readonly type?: string
  readonly href?: string
  readonly frameId?: string
  readonly disabled?: boolean
  readonly checked?: boolean
  readonly selected?: boolean
  readonly expanded?: boolean
}

export type BrowserContentBlockType =
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'table'
  | 'quote'
  | 'code'

export interface BrowserContentBlockView {
  readonly id: string
  readonly frameId: string
  readonly type: BrowserContentBlockType
  readonly text: string
  readonly level?: number
}

export interface BrowserFrameView {
  readonly frameId: string
  readonly url: string
  readonly title: string
  readonly allowed: boolean
}

export interface BrowserContentView {
  readonly id: string
  readonly sizeBytes: number
  readonly chunkCount: number
  readonly currentChunk?: number
  readonly text?: string
}

export interface BrowserContentMatchView {
  readonly chunkIndex: number
  readonly snippet: string
}

export interface BrowserVisualFallbackView {
  readonly recommended: boolean
  readonly reasons: readonly string[]
  readonly screenshotSupported: boolean
}

export interface BrowserAttachmentView {
  readonly id: string
  readonly kind: 'screenshot' | 'download'
  readonly name: string
  readonly relativePath: string
  readonly mimeType: string
  readonly sizeBytes: number
}

export interface BrowserToolOutput {
  readonly ok: boolean
  readonly action: BrowserAction
  readonly pageId?: string
  readonly url?: string
  readonly title?: string
  readonly httpStatus?: number
  readonly snapshotId?: string
  readonly changed?: boolean
  readonly text?: string
  readonly elements?: readonly BrowserElementView[]
  readonly blocks?: readonly BrowserContentBlockView[]
  readonly frames?: readonly BrowserFrameView[]
  readonly content?: BrowserContentView
  readonly matches?: readonly BrowserContentMatchView[]
  readonly visual?: BrowserVisualFallbackView
  readonly attachment?: BrowserAttachmentView
  readonly observationReceipt?: SourceObservationReceiptView
  readonly truncated?: boolean
  readonly error?: {
    readonly code: BrowserErrorCode
    readonly message: string
    readonly retryable: boolean
  }
}

export type BrowserErrorCode =
  | 'invalid_request'
  | 'browser_unavailable'
  | 'domain_denied'
  | 'access_challenge'
  | 'access_denied'
  | 'rate_limited'
  | 'not_found'
  | 'empty_content'
  | 'source_blocked'
  | 'page_not_found'
  | 'element_not_found'
  | 'sensitive_input_blocked'
  | 'approval_denied'
  | 'approval_expired'
  | 'download_too_large'
  | 'timeout'
  | 'cancelled'
  | 'internal'

export interface BrowserToolRequest {
  readonly version: typeof BROWSER_TOOL_CONTRACT_VERSION
  readonly context: RuntimeCapabilityRequestContext
  readonly toolCallId: string
  readonly input: BrowserToolInput
}

export interface BrowserToolResponse {
  readonly version: typeof BROWSER_TOOL_CONTRACT_VERSION
  readonly output: BrowserToolOutput
}

export function browserToolInputSchema(): McpJsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'open', 'observe', 'navigate', 'go_back', 'click', 'type',
          'select', 'press', 'scroll', 'wait', 'read_content', 'search_content',
          'screenshot', 'download', 'close',
        ],
      },
      pageId: { type: 'string' },
      url: { type: 'string' },
      ref: { type: 'string' },
      text: { type: 'string' },
      value: { type: 'string' },
      key: { type: 'string' },
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
      amount: { type: 'integer', minimum: 1, maximum: 10000 },
      waitFor: {
        type: 'string',
        enum: ['delay', 'text', 'url', 'element', 'change', 'network_idle'],
      },
      query: { type: 'string' },
      snapshotId: { type: 'string' },
      contentId: { type: 'string' },
      chunkIndex: { type: 'integer', minimum: 0 },
      waitMs: { type: 'integer', minimum: 100, maximum: 600000 },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 },
    },
  }
}
