import type { YoutubeDocumentRequest } from '../../contracts/youtube-document-request.js'

export const YOUTUBE_MANUAL_PLAN_SCHEMA_VERSION = 1 as const
export const YOUTUBE_VIDEO_ANALYSIS_SCHEMA_VERSION = 1 as const

export type YoutubeManualTemplateId = 'quick-guide' | 'step-by-step' | 'dense-visual'
export type YoutubeVisualImportance = 'required' | 'supporting'

export interface YoutubeVisualCue {
  readonly timestampSeconds: number
  readonly importance: YoutubeVisualImportance
  readonly reason: string
  readonly caption: string
  readonly altText: string
}

export interface YoutubeVideoAnalysisStep {
  readonly id: string
  readonly title: string
  readonly explanation: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly visualCandidates: readonly YoutubeVisualCue[]
}

export interface YoutubeVideoAnalysis {
  readonly analysisSchemaVersion: typeof YOUTUBE_VIDEO_ANALYSIS_SCHEMA_VERSION
  readonly sourceRevisionFingerprint: string
  readonly model?: string
  readonly analysisPromptVersion: string
  readonly outputLanguage: string
  readonly detectedSourceLanguage?: string
  readonly generatedAt: string
  readonly summary: string
  readonly prerequisites?: readonly string[]
  readonly warnings?: readonly string[]
  readonly steps: readonly YoutubeVideoAnalysisStep[]
}

export interface YoutubeManualVideo {
  readonly videoId: string
  readonly url: string
  readonly title: string
  readonly channelName?: string
  readonly publishedAt?: string
  readonly durationSeconds: number
}

export interface YoutubeManualChapter {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly stepIds: readonly string[]
}

export interface YoutubeManualStep {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly explanation: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly visualCues: readonly YoutubeVisualCue[]
}

export interface YoutubeManualPlan {
  readonly documentRequest?: YoutubeDocumentRequest
  readonly manualPlanSchemaVersion: typeof YOUTUBE_MANUAL_PLAN_SCHEMA_VERSION
  readonly video: YoutubeManualVideo
  readonly templateId: YoutubeManualTemplateId
  readonly sourceLanguage?: string
  readonly outputLanguage: string
  readonly analysis: {
    readonly mode: 'gemini' | 'transcript'
    readonly model?: string
    readonly generatedAt: string
    readonly warnings: readonly string[]
  }
  readonly prerequisites?: readonly string[]
  readonly summary: string
  readonly chapters: readonly YoutubeManualChapter[]
  readonly steps: readonly YoutubeManualStep[]
}
