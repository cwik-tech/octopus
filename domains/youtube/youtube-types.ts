import type { YoutubeDocumentRequest } from '../../contracts/youtube-document-request.js'
import type { McpJsonObject } from '../../contracts/mcp.js'
import type { RuntimeCapabilityRequestContext } from '../../contracts/runtime-capability-authority.js'

export const YOUTUBE_TOOL_NAME = 'youtube_extract'
export const YOUTUBE_SERVER_ID = 'builtin.youtube'
export const YOUTUBE_TOOL_CONTRACT_VERSION = 4 as const
export const YOUTUBE_MANIFEST_VERSION = 1 as const
export const YOUTUBE_TOOL_URL_ENV = 'PIPELINE_YOUTUBE_TOOL_URL'
export const YOUTUBE_EXTRACTOR_AGENT_PATH = 'agents/youtube-extractor'

export type YoutubeAction =
  | 'inspect'
  | 'capture'
  | 'resume'
  | 'capture_authenticated'
  | 'read_transcript'
  | 'write_methodology'
  | 'write_consolidation'
  | 'prepare_manual'
  | 'write_manual_plan'
  | 'build_manual'

export type YoutubeSourceType = 'video' | 'playlist' | 'channel'
export type YoutubeCaptureMethod = 'direct' | 'webshare' | 'authenticated' | 'browser'
export type YoutubeVideoStatus =
  | 'pending'
  | 'success'
  | 'premiere_pending'
  | 'auth_required'
  | 'no_transcript'
  | 'failed'

export interface YoutubeToolInput {
  readonly action: YoutubeAction
  readonly url?: string
  readonly languages?: readonly string[]
  readonly limit?: number
  readonly all?: boolean
  readonly includeShorts?: boolean
  readonly minDurationSeconds?: number
  readonly videoId?: string
  readonly chunkIndex?: number
  readonly content?: string
  readonly fileName?: string
  readonly templateId?: 'quick-guide' | 'step-by-step' | 'dense-visual'
  readonly documentRequest?: YoutubeDocumentRequest
  readonly outputLanguage?: string
  readonly freshAnalysis?: boolean
  readonly geminiConfirmed?: boolean
  readonly manualRunId?: string
}

export interface YoutubeTranscriptSegment {
  readonly startMs: number
  readonly durationMs: number
  readonly text: string
}

export interface YoutubeTranscriptArtifact {
  readonly schemaVersion: typeof YOUTUBE_MANIFEST_VERSION
  readonly videoId: string
  readonly url: string
  readonly title: string
  readonly channelId?: string
  readonly channelName?: string
  readonly durationSeconds?: number
  readonly publishedAt?: string
  readonly language: string
  readonly languageName?: string
  readonly generated: boolean
  readonly captureMethod: YoutubeCaptureMethod
  readonly capturedAt: string
  readonly segments: readonly YoutubeTranscriptSegment[]
}

export interface YoutubeManifestVideo {
  readonly videoId: string
  readonly url: string
  readonly title?: string
  readonly durationSeconds?: number
  readonly channelName?: string
  readonly publishedAt?: string
  readonly availableAt?: string
  readonly status: YoutubeVideoStatus
  readonly attempts: number
  readonly captureMethod?: YoutubeCaptureMethod
  readonly transcriptJson?: string
  readonly transcriptMarkdown?: string
  readonly language?: string
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
}

export interface YoutubeCaptureManifest {
  readonly schemaVersion: typeof YOUTUBE_MANIFEST_VERSION
  readonly source: {
    readonly type: YoutubeSourceType
    readonly id: string
    readonly url: string
    readonly title?: string
  }
  readonly options: {
    readonly languages: readonly string[]
    readonly limit: number | 'all'
    readonly includeShorts: boolean
    readonly minDurationSeconds: number
  }
  readonly startedAt: string
  readonly updatedAt: string
  readonly videos: readonly YoutubeManifestVideo[]
}

export interface YoutubeToolOutput {
  readonly ok: boolean
  readonly action: YoutubeAction
  readonly source?: YoutubeCaptureManifest['source']
  readonly manifestPath?: string
  readonly artifactPath?: string
  readonly itemCount?: number
  readonly completed?: number
  readonly failed?: number
  readonly unavailable?: number
  readonly pending?: number
  readonly authenticatedFallbackRequired?: number
  readonly premierePending?: number
  readonly videos?: readonly Pick<
    YoutubeManifestVideo,
    | 'videoId'
    | 'url'
    | 'title'
    | 'durationSeconds'
    | 'channelName'
    | 'publishedAt'
    | 'availableAt'
    | 'status'
    | 'captureMethod'
    | 'transcriptJson'
    | 'transcriptMarkdown'
    | 'language'
  >[]
  readonly chunk?: {
    readonly videoId: string
    readonly chunkIndex: number
    readonly chunkCount: number
    readonly text: string
  }
  readonly manualRunId?: string
  readonly manualPlanPath?: string
  readonly manualMarkdownPath?: string
  readonly manualZipPath?: string
  readonly manualDocxPath?: string
  readonly manualBundlePath?: string
  readonly sourceVideoPath?: string
  readonly previewPath?: string
  readonly frameCount?: number
  readonly reused?: boolean
  readonly generationStatus?: string
  readonly diskPreflight?: {
    readonly status: 'partial' | 'complete' | 'failed'
    readonly availableBytes?: number
    readonly requiredBytes?: number
  }
  readonly providerUsage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
  }
  readonly analysisMode?: 'gemini' | 'transcript'
  readonly confirmationRequired?: boolean
  readonly costEstimate?: {
    readonly available: boolean
    readonly currency?: 'USD'
    readonly estimatedCost?: number
    readonly estimatedInputTokens?: number
    readonly estimatedOutputTokens?: number
  }
  readonly notices?: readonly YoutubeUserNotice[]
  readonly error?: {
    readonly code: YoutubeErrorCode
    readonly message: string
    readonly retryable: boolean
  }
}

export type YoutubeErrorCode =
  | 'invalid_request'
  | 'source_unavailable'
  | 'proxy_unavailable'
  | 'authentication_required'
  | 'premiere_pending'
  | 'approval_denied'
  | 'approval_expired'
  | 'browser_unavailable'
  | 'transcript_unavailable'
  | 'cancelled'
  | 'disk_space_insufficient'
  | 'internal'

export interface YoutubeUserNotice {
  readonly code:
    | 'gemini_key_missing'
    | 'gemini_auth_failed'
    | 'gemini_rate_limited'
    | 'gemini_invalid_response'
    | 'gemini_unavailable'
    | 'gemini_pricing_stale'
    | 'gemini_cost_confirmation_required'
    | 'disk_space_insufficient'
    | 'media_download_failed'
    | 'media_download_fallback'
    | 'media_tools_unavailable'
    | 'frame_extraction_failed'
    | 'browser_capture_failed'
    | 'video_unavailable'
    | 'run_cancelled'
    | 'cleanup_warning'
  readonly severity: 'info' | 'warning' | 'error'
  readonly message: string
}

export interface YoutubeToolRequest {
  readonly version: typeof YOUTUBE_TOOL_CONTRACT_VERSION
  readonly context: RuntimeCapabilityRequestContext
  readonly toolCallId: string
  readonly input: YoutubeToolInput
}

export interface YoutubeToolResponse {
  readonly version: typeof YOUTUBE_TOOL_CONTRACT_VERSION
  readonly output: YoutubeToolOutput
}

export function youtubeApprovalToolName(): string {
  return 'mcp__builtin-youtube__capture_authenticated'
}

export function youtubeToolInputSchema(): McpJsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'inspect', 'capture', 'resume', 'capture_authenticated',
          'read_transcript', 'write_methodology', 'write_consolidation',
          'prepare_manual', 'write_manual_plan', 'build_manual',
        ],
      },
      url: { type: 'string' },
      languages: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string' },
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      all: { type: 'boolean' },
      includeShorts: { type: 'boolean' },
      minDurationSeconds: { type: 'integer', minimum: 0, maximum: 86400 },
      videoId: { type: 'string' },
      chunkIndex: { type: 'integer', minimum: 0 },
      content: { type: 'string', maxLength: 250000 },
      fileName: { type: 'string', maxLength: 180 },
      templateId: {
        type: 'string',
        enum: ['quick-guide', 'step-by-step', 'dense-visual'],
      },
      documentRequest: { type: 'object', additionalProperties: false, required: ['formats', 'purpose', 'instructions'], properties: { formats: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['markdown', 'docx'] } }, purpose: { type: 'string', enum: ['instructions', 'takeaways'] }, instructions: { type: 'string', minLength: 1, maxLength: 8000 } } },
      outputLanguage: { type: 'string', maxLength: 64 },
      freshAnalysis: { type: 'boolean' },
      geminiConfirmed: { type: 'boolean' },
      manualRunId: { type: 'string', maxLength: 128 },
    },
  }
}
