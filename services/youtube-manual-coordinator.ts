import { isUnknownArray } from '../core/unknown-array.js'
import { z } from 'zod/v4'
import { youtubeDocumentRequestSchema, type YoutubeDocumentRequest } from '../contracts/youtube-document-request.js'
import { whenDefined } from '../core/optional-properties.js'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { PNG } from 'pngjs'

import { writeFileAtomic } from '../core/file-mutation.js'
import {
  evaluateGeminiAdmission,
  GEMINI_PRICING_METADATA,
} from '../domains/youtube/youtube-gemini-cost.js'
import {
  YOUTUBE_ANALYSIS_PROMPT_VERSION,
  YoutubeGeminiAnalysisClient,
  YoutubeGeminiAnalysisError,
  type YoutubeVideoAnalysisPort,
} from '../domains/youtube/youtube-gemini-analysis.js'
import {
  composeYoutubeManualPlan,
  parseYoutubeManualPlan,
  parseYoutubeVideoAnalysis,
} from '../domains/youtube/youtube-manual-schema.js'
import type {
  YoutubeManualPlan,
  YoutubeManualTemplateId,
  YoutubeManualVideo,
} from '../domains/youtube/youtube-manual-types.js'
import type {
  YoutubeRuntimeGeminiConfig,
  YoutubeSettingsSnapshot,
} from '../domains/youtube/youtube-settings.js'
import type {
  YoutubeErrorCode,
  YoutubeToolOutput,
  YoutubeUserNotice,
} from '../domains/youtube/youtube-types.js'
import { YOUTUBE_MANUAL_TEMPLATES } from '../domains/youtube/manual-templates/index.js'
import {
  buildYoutubeFrameSchedule,
  deduplicateYoutubeFrames,
  selectBestYoutubeFrameCandidate,
} from '../domains/youtube/youtube-frame-selection.js'
import {
  extractYoutubeFrames,
  YOUTUBE_FRAME_EXTRACTION_MAX_WIDTH_PX,
} from '../domains/youtube/youtube-frame-extraction.js'
import {
  isYoutubeSelectedFrame,
  type YoutubeSelectedFrame,
} from '../domains/youtube/youtube-frame-types.js'
import type { YoutubeDiskPreflight, YoutubeDownloadedMedia } from '../domains/youtube/youtube-media-acquisition.js'
import { downloadYoutubeMedia, youtubeFrameHeadroomBytes } from '../domains/youtube/youtube-media-acquisition.js'
import { publishYoutubeManual } from '../domains/youtube/youtube-manual-service.js'
import { publishRuntimeArtifactWrittenEvent } from '../domains/runtime/artifacts.js'
import {
  YoutubeRuntimeError,
  type YoutubeArtifactContext,
} from '../domains/youtube/youtube-extraction.js'
import type { YoutubeGeminiUsageLedger } from './youtube-gemini-usage-ledger.js'

interface YoutubeManualSettingsPort {
  runtimeGemini(): Promise<YoutubeRuntimeGeminiConfig>
  snapshot(): Promise<Pick<
    YoutubeSettingsSnapshot,
    'geminiDailyVideoMinutesLimit' | 'geminiConfirmationThresholdMinutes'
  > & Partial<Pick<YoutubeSettingsSnapshot, 'deleteVideosAfterInfoExtraction'>>>
}

export interface YoutubeBrowserFramePort {
  captureYoutubeFrames(input: {
    readonly videoId: string
    readonly outputDirectory: string
    readonly cues: readonly {
      readonly stepId: string
      readonly timestampSeconds: number
      readonly importance: 'required' | 'supporting'
      readonly caption: string
      readonly altText: string
    }[]
    readonly signal?: AbortSignal
  }): Promise<readonly YoutubeSelectedFrame[]>
}

export type YoutubeManualProgressEvent =
  | { readonly type: 'video_download_started' }
  | {
      readonly type: 'video_downloaded'
      readonly byteLength: number
      readonly durationSeconds: number
      readonly width: number
      readonly height: number
    }
  | { readonly type: 'key_frames_extraction_started' }
  | { readonly type: 'key_frames_extracted'; readonly frameCount: number }
  | { readonly type: 'manual_publication_started' }
  | { readonly type: 'manual_markdown_written' }
  | { readonly type: 'manual_docx_written' }
  | { readonly type: 'temporary_media_cleaned' }
  | { readonly type: 'source_video_retained'; readonly path: string; readonly byteLength: number }

const manifestMutationQueues = new Map<string, Promise<void>>()

/** Longest binary-resolution reason a notice repeats; see `agentSafeReason`. */
const MAX_UNAVAILABLE_REASON_LENGTH = 160

class YoutubeManualBuildStageError extends Error {
  /**
   * Whether a failed download presented the profile's sign-in, when one was
   * attempted. Undefined when no download ran, so the manifest never claims an
   * anonymous attempt that never happened.
   */
  readonly usedProfileSession: boolean | undefined

  constructor(
    readonly stage: 'download' | 'frames',
    readonly media: YoutubeDownloadedMedia | undefined,
    options: { readonly cause: unknown; readonly usedProfileSession?: boolean },
  ) {
    super(
      stage === 'download' ? 'YouTube media download failed.' : 'YouTube frame extraction failed.',
      { cause: options.cause },
    )
    this.name = 'YoutubeManualBuildStageError'
    this.usedProfileSession = options.usedProfileSession
  }
}

/**
 * The bundled yt-dlp, ffmpeg and ffprobe never reached the service, so no
 * download was attempted. Distinct from a stage failure because the build
 * reports it as itself rather than as a failed download.
 */
class YoutubeMediaToolsUnavailableError extends Error {
  constructor(readonly unavailableReason: string | undefined) {
    super('Bundled YouTube media tools are unavailable.')
    this.name = 'YoutubeMediaToolsUnavailableError'
  }
}

/**
 * Bundle files announced as run artifacts, in build order. Individual
 * `frames/*.png` stay unannounced — there can be dozens per video and
 * `frames.json` already indexes them with hashes and timestamps.
 */
const ANNOUNCED_BUNDLE_ARTIFACTS = {
  'video-metadata.json': { artifactType: 'metadata', title: 'Video metadata' },
  'video-analysis.json': { artifactType: 'analysis', title: 'Gemini video analysis' },
  'manual-plan.json': { artifactType: 'plan', title: 'Manual plan' },
  'media.json': { artifactType: 'metadata', title: 'Downloaded media evidence' },
  'source-video.mp4': { artifactType: 'video', title: 'Downloaded source video' },
  'frames.json': { artifactType: 'metadata', title: 'Selected screenshots' },
  'manual.md': { artifactType: 'result', title: 'Screenshot-rich manual (Markdown)' },
  'manual.zip': { artifactType: 'result', title: 'Markdown manual with screenshots (ZIP)' },
  'manual.docx': { artifactType: 'result', title: 'Screenshot-rich manual (Word)' },
  'generation-manifest.json': { artifactType: 'manifest', title: 'Manual generation record' },
} as const

type AnnouncedBundleArtifact = keyof typeof ANNOUNCED_BUNDLE_ARTIFACTS

export class YoutubeManualCoordinator {
  private readonly assignmentPath: string
  private readonly analysis: YoutubeVideoAnalysisPort
  private readonly now: () => Date
  private readonly announcedArtifacts = new Set<string>()

  constructor(private readonly options: {
    readonly assignmentPath: string
    readonly settings: YoutubeManualSettingsPort
    readonly analysis?: YoutubeVideoAnalysisPort
    readonly usageLedger?: Pick<
      YoutubeGeminiUsageLedger,
      'rollingUsage' | 'reserve' | 'complete' | 'release'
    >
    readonly binaries?: {
      readonly ytDlpPath: string
      readonly ffmpegPath: string
      readonly ffprobePath: string
      readonly ytDlpVersion?: string
      readonly ytDlpSha256?: string
      readonly ffmpegVersion?: string
      readonly ffmpegSha256?: string
      readonly ffprobeVersion?: string
      readonly ffprobeSha256?: string
    }
    /** Why binary resolution rejected, when the desktop host reported one. */
    readonly binariesUnavailableReason?: string
    /**
     * Parent-process-only. Reads the application profile's YouTube cookie
     * header so the download can use the existing sign-in. It reaches the media
     * acquisition alone and never a tool output, notice, manifest, or log, and
     * is given the build's cancellation because the read may start the profile.
     */
    readonly youtubeCookieHeader?: (
      options: { readonly signal?: AbortSignal },
    ) => Promise<string | undefined>
    readonly browserFrames?: YoutubeBrowserFramePort
    readonly downloadMedia?: typeof downloadYoutubeMedia
    readonly extractFrames?: typeof extractYoutubeFrames
    readonly publishManual?: typeof publishYoutubeManual
    readonly cleanupWorkingDirectory?: (directory: string) => Promise<void>
    readonly diskSpaceBytes?: (directory: string) => Promise<number>
    readonly rssBytes?: () => number
    readonly now?: () => Date
    readonly onProgress?: (event: YoutubeManualProgressEvent) => void
    readonly artifactContext?: YoutubeArtifactContext
  }) {
    this.assignmentPath = path.resolve(options.assignmentPath)
    this.analysis = options.analysis ?? new YoutubeGeminiAnalysisClient()
    this.now = options.now ?? (() => new Date())
  }

  async reusableVideo(url: string, manualRunId: string): Promise<YoutubeManualVideo | undefined> {
    const videoId = canonicalYoutubeVideoId(url)
    if (!videoId) return undefined
    const metadataPath = path.join(this.bundleDirectory(videoId, manualRunId), 'video-metadata.json')
    try {
      const value = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as YoutubeManualVideo
      if (
        value.videoId !== videoId || value.url !== `https://www.youtube.com/watch?v=${videoId}` ||
        typeof value.title !== 'string' || !value.title.trim() ||
        !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0
      ) return undefined
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Persisted YouTube video metadata is invalid.')
    }
  }

  async prepare(input: {
    readonly video: YoutubeManualVideo
    readonly templateId: YoutubeManualTemplateId
    readonly documentRequest?: YoutubeDocumentRequest
    readonly outputLanguage?: string
    readonly manualRunId?: string
    readonly geminiConfirmed?: boolean
    readonly freshAnalysis?: boolean
    readonly signal?: AbortSignal
  }): Promise<YoutubeToolOutput> {
    const runId = input.manualRunId ?? randomUUID()
    const sourceRevisionFingerprint = sourceFingerprint(input.video)
    const bundle = this.bundleDirectory(input.video.videoId, runId)
    await ensureSafeDirectory(bundle, this.assignmentPath)
    const manifestPath = path.join(bundle, 'generation-manifest.json')
    const existingManifest = await readJsonRecordIfExists(manifestPath)
    if (existingManifest) {
      assertMatchingPreparation(existingManifest, input)
      if (existingManifest.status === 'complete' || existingManifest.status === 'complete_with_warnings') {
        throw new Error('This YouTube manual run is completed and immutable. Start a new run to regenerate it.')
      }
      if (input.freshAnalysis) {
        throw new Error('Fresh YouTube analysis requires a new manual run so existing evidence is not overwritten.')
      }
      const resumed = await preparedOutputIfReusable({
        bundle,
        manifest: existingManifest,
        runId,
        relative: (filePath) => this.relative(filePath),
      })
      if (resumed && !(existingManifest.status === 'awaiting_confirmation' && input.geminiConfirmed)) {
        return resumed
      }
    }
    const defaultManifest = {
      generationManifestSchemaVersion: 1,
      manualPlanSchemaVersion: 1,
      analysisSchemaVersion: null,
      runId,
      videoId: input.video.videoId,
      templateId: input.templateId,
      ...whenDefined(input.documentRequest, (documentRequest) => ({ documentRequest })),
      status: 'preparing',
      stages: {
        metadata: 'complete',
        transcript: 'pending',
        analysis: 'pending',
        download: 'pending',
        frames: 'pending',
        markdown: 'pending',
        docx: 'pending',
        cleanup: 'pending',
      },
      notices: [] as YoutubeUserNotice[],
      analysisPromptVersion: YOUTUBE_ANALYSIS_PROMPT_VERSION,
      sourceRevisionFingerprint,
      outputLanguage: input.outputLanguage ?? 'source',
      binaries: manifestBinaries(this.options.binaries),
      resourceMeasurements: { peakRssBytes: this.rssBytes() },
      updatedAt: this.now().toISOString(),
    }
    const existingStages = existingManifest?.stages && typeof existingManifest.stages === 'object'
      ? existingManifest.stages as Record<string, string>
      : {}
    const baseManifest = existingManifest
      ? { ...defaultManifest, ...existingManifest, stages: { ...defaultManifest.stages, ...existingStages } }
      : defaultManifest
    if (!existingManifest) {
      await writeJson(path.join(bundle, 'video-metadata.json'), input.video)
      await writeJson(manifestPath, baseManifest)
      await this.emitBundleArtifact(bundle, 'video-metadata.json', 'intermediate')
    }
    const minimumDiskPreflight = await this.minimumDiskPreflight(bundle, input.templateId)
    await mergeGenerationManifest(manifestPath, {
      fields: { diskPreflight: minimumDiskPreflight },
      updatedAt: this.now().toISOString(),
    })
    const preparedBaseManifest = () => ({
      ...baseManifest,
      diskPreflight: minimumDiskPreflight,
      updatedAt: this.now().toISOString(),
    })
    if (minimumDiskPreflight.status === 'failed') {
      const notice: YoutubeUserNotice = {
        code: 'disk_space_insufficient',
        severity: 'error',
        message: 'There is not enough free disk space to create the requested screenshots.',
      }
      await mergeGenerationManifest(manifestPath, {
        status: 'failed',
        notices: [notice],
        updatedAt: this.now().toISOString(),
      })
      return {
        ok: false,
        action: 'prepare_manual',
        manualRunId: runId,
        manifestPath: this.relative(manifestPath),
        generationStatus: 'failed',
        diskPreflight: minimumDiskPreflight,
        notices: [notice],
        error: { code: 'disk_space_insufficient', message: notice.message, retryable: true },
      }
    }
    const runtime = await this.options.settings.runtimeGemini()
    if (!runtime.apiKey) {
      const notice = missingKeyNotice()
      await writeJson(manifestPath, {
        ...preparedBaseManifest(),
        status: 'awaiting_transcript_plan',
        analysisMode: 'transcript',
        diskPreflight: minimumDiskPreflight,
        notices: [notice],
      })
      return {
        ok: true,
        action: 'prepare_manual',
        manualRunId: runId,
        manifestPath: this.relative(manifestPath),
        analysisMode: 'transcript',
        diskPreflight: minimumDiskPreflight,
        notices: [notice],
      }
    }
    const settings = await this.options.settings.snapshot()
    const cachePath = this.analysisCachePath({
      video: input.video,
      model: runtime.model,
      sourceRevisionFingerprint,
      ...whenDefined(input.documentRequest, (documentRequest) => ({ documentRequest })),
      ...whenDefined(input.outputLanguage, (definedValue) => ({ outputLanguage: definedValue })),
    })
    const analysisCacheKey = path.basename(cachePath, '.json')
    const cachedAnalysis = input.freshAnalysis
      ? undefined
      : await readCachedAnalysis(cachePath, {
          model: runtime.model,
          sourceRevisionFingerprint,
          ...whenDefined(input.outputLanguage, (definedValue) => ({ outputLanguage: definedValue })),
        })
    if (cachedAnalysis) {
      const plan = composeYoutubeManualPlan({
        analysis: cachedAnalysis,
        templateId: input.templateId,
        video: input.video,
        ...whenDefined(input.documentRequest, (documentRequest) => ({ documentRequest })),
      })
      const analysisPath = path.join(bundle, 'video-analysis.json')
      const planPath = path.join(bundle, 'manual-plan.json')
      await writeJson(analysisPath, cachedAnalysis)
      await writeJson(planPath, plan)
      await this.emitBundleArtifact(bundle, 'video-analysis.json', 'intermediate')
      await this.emitBundleArtifact(bundle, 'manual-plan.json', 'intermediate')
      await writeJson(manifestPath, {
        ...preparedBaseManifest(),
        status: 'prepared',
        analysisMode: 'gemini',
        analysisCacheHit: true,
        analysisSchemaVersion: cachedAnalysis.analysisSchemaVersion,
        analysisCacheKey,
        sourceLanguage: cachedAnalysis.detectedSourceLanguage,
        outputLanguage: cachedAnalysis.outputLanguage,
        stages: { ...baseManifest.stages, analysis: 'complete' },
      })
      return {
        ok: true,
        action: 'prepare_manual',
        manualRunId: runId,
        manifestPath: this.relative(manifestPath),
        manualPlanPath: this.relative(planPath),
        analysisMode: 'gemini',
        confirmationRequired: false,
        diskPreflight: minimumDiskPreflight,
        costEstimate: { available: false },
      }
    }
    const rollingUsage = this.options.usageLedger
      ? await this.options.usageLedger.rollingUsage()
      : { totalMinutes: 0 }
    const admission = evaluateGeminiAdmission({
      durationSeconds: input.video.durationSeconds,
      rollingUsedMinutes: rollingUsage.totalMinutes,
      dailyLimitMinutes: settings.geminiDailyVideoMinutesLimit,
      confirmationThresholdMinutes: settings.geminiConfirmationThresholdMinutes,
      model: runtime.model,
      pricing: GEMINI_PRICING_METADATA,
      now: this.now(),
    })
    // An expired price list stops the estimate, not the analysis. Saying so is
    // what makes the expiry visible: without it a run reports a cost of
    // "unavailable" and nothing names the stale file that caused it.
    const pricingNotices: YoutubeUserNotice[] = admission.reasons.includes('pricing_unavailable')
      ? [{
          code: 'gemini_pricing_stale',
          severity: 'warning',
          message: 'Gemini ran without a cost estimate: the bundled price list is out of date. Refresh it to restore cost reporting.',
        }]
      : []
    if (admission.confirmationRequired && !input.geminiConfirmed) {
      const notice: YoutubeUserNotice = {
        code: 'gemini_cost_confirmation_required',
        severity: 'info',
        message: 'Gemini analysis requires confirmation. Review the approximate cost and rolling 24-hour budget before continuing.',
      }
      await writeJson(manifestPath, {
        ...preparedBaseManifest(),
        status: 'awaiting_confirmation',
        notices: [notice],
        costEstimate: admission.estimate,
      })
      return {
        ok: true,
        action: 'prepare_manual',
        manualRunId: runId,
        manifestPath: this.relative(manifestPath),
        confirmationRequired: true,
        diskPreflight: minimumDiskPreflight,
        costEstimate: admission.estimate
          ? { ...admission.estimate, available: true }
          : { available: false },
        notices: [notice],
      }
    }
    if (this.options.usageLedger) {
      const reservation = await this.options.usageLedger.reserve({
        runId,
        videoId: input.video.videoId,
        estimatedMinutes: input.video.durationSeconds / 60,
        limitMinutes: settings.geminiDailyVideoMinutesLimit,
        allowOverLimit: input.geminiConfirmed === true,
      })
      if (!reservation.accepted) {
        const notice: YoutubeUserNotice = {
          code: 'gemini_cost_confirmation_required',
          severity: 'info',
          message: 'Gemini analysis requires confirmation because concurrent usage reached the rolling 24-hour limit.',
        }
        await writeJson(manifestPath, {
          ...preparedBaseManifest(),
          status: 'awaiting_confirmation',
          notices: [notice],
          costEstimate: admission.estimate,
        })
        return {
          ok: true,
          action: 'prepare_manual',
          manualRunId: runId,
          manifestPath: this.relative(manifestPath),
          confirmationRequired: true,
          diskPreflight: minimumDiskPreflight,
          costEstimate: admission.estimate
            ? { ...admission.estimate, available: true }
            : { available: false },
          notices: [notice],
        }
      }
    }
    let providerCompleted = false
    await mergeGenerationManifest(manifestPath, {
      status: 'analyzing',
      stages: { analysis: 'in_progress' },
      updatedAt: this.now().toISOString(),
    })
    try {
      const result = await this.analysis.analyze({
        apiKey: runtime.apiKey,
        model: runtime.model,
        video: input.video,
        ...whenDefined(input.documentRequest, (documentRequest) => ({ documentRequest })),
        sourceRevisionFingerprint,
        ...whenDefined(input.outputLanguage, (definedValue) => ({ outputLanguage: definedValue })),
        generatedAt: this.now().toISOString(),
      }, input.signal)
      providerCompleted = true
      await this.options.usageLedger?.complete(runId, {
        actualMinutes: input.video.durationSeconds / 60,
        ...(result.usage?.inputTokens !== undefined
          ? { inputTokens: result.usage.inputTokens }
          : {}),
        ...(result.usage?.outputTokens !== undefined
          ? { outputTokens: result.usage.outputTokens }
          : {}),
      })
      const plan = composeYoutubeManualPlan({
        analysis: result.analysis,
        templateId: input.templateId,
        video: input.video,
        ...whenDefined(input.documentRequest, (documentRequest) => ({ documentRequest })),
      })
      const analysisPath = path.join(bundle, 'video-analysis.json')
      const planPath = path.join(bundle, 'manual-plan.json')
      await writeJson(analysisPath, result.analysis)
      await ensureSafeDirectory(path.dirname(cachePath), this.assignmentPath)
      await writeJson(cachePath, result.analysis)
      await writeJson(planPath, plan)
      await this.emitBundleArtifact(bundle, 'video-analysis.json', 'intermediate')
      await this.emitBundleArtifact(bundle, 'manual-plan.json', 'intermediate')
      await writeJson(manifestPath, {
        ...preparedBaseManifest(),
        status: 'prepared',
        analysisMode: 'gemini',
        providerRequestId: result.requestId,
        analysisSchemaVersion: result.analysis.analysisSchemaVersion,
        providerUsage: result.usage,
        providerRetryCount: result.retryCount ?? 0,
        analysisCacheKey,
        sourceLanguage: result.analysis.detectedSourceLanguage,
        outputLanguage: result.analysis.outputLanguage,
        costEstimate: admission.estimate,
        stages: { ...baseManifest.stages, analysis: 'complete' },
        ...(pricingNotices.length > 0 ? { notices: pricingNotices } : {}),
      })
      return {
        ok: true,
        action: 'prepare_manual',
        manualRunId: runId,
        manifestPath: this.relative(manifestPath),
        manualPlanPath: this.relative(planPath),
        analysisMode: 'gemini',
        confirmationRequired: false,
        diskPreflight: minimumDiskPreflight,
        costEstimate: admission.estimate
          ? { ...admission.estimate, available: true }
          : { available: false },
        ...(pricingNotices.length > 0 ? { notices: pricingNotices } : {}),
      }
    } catch (error) {
      if (!providerCompleted) await this.options.usageLedger?.release(runId)
      if (input.signal?.aborted ||
          error instanceof YoutubeGeminiAnalysisError && error.kind === 'cancelled') {
        await cancelGenerationManifestStage(manifestPath, {
          stage: 'analysis',
          cancelledAt: this.now().toISOString(),
        })
        throw error
      }
      const notice = providerFallbackNotice(error)
      await writeJson(manifestPath, {
        ...preparedBaseManifest(),
        status: 'awaiting_transcript_plan',
        analysisMode: 'transcript',
        diskPreflight: minimumDiskPreflight,
        notices: [notice],
        stages: { ...baseManifest.stages, analysis: 'failed' },
      })
      return {
        ok: true,
        action: 'prepare_manual',
        manualRunId: runId,
        manifestPath: this.relative(manifestPath),
        analysisMode: 'transcript',
        diskPreflight: minimumDiskPreflight,
        notices: [notice],
      }
    }
  }

  async writeManualPlan(input: {
    readonly videoId: string
    readonly manualRunId: string
    readonly content: string
  }): Promise<YoutubeToolOutput> {
    let parsedContent: unknown
    try {
      parsedContent = JSON.parse(input.content)
    } catch {
      throw new YoutubeRuntimeError(
        'invalid_request',
        'The transcript-derived YouTube manual plan is not valid JSON.',
      )
    }
    let plan: YoutubeManualPlan
    try {
      plan = parseYoutubeManualPlan(parsedContent)
    } catch (error) {
      throw new YoutubeRuntimeError(
        'invalid_request',
        error instanceof Error ? error.message : 'YouTube manual plan is invalid.',
      )
    }
    if (plan.video.videoId !== input.videoId) {
      throw new YoutubeRuntimeError(
        'invalid_request',
        'YouTube manual plan is invalid: video.videoId must match the videoId of this call.',
      )
    }
    if (plan.analysis.mode !== 'transcript') {
      throw new YoutubeRuntimeError(
        'invalid_request',
        'YouTube manual plan is invalid: analysis.mode must be "transcript".',
      )
    }
    const bundle = this.bundleDirectory(input.videoId, input.manualRunId)
    const planPath = path.join(bundle, 'manual-plan.json')
    assertMatchingDocumentRequest(await readJsonRecord(path.join(bundle, 'generation-manifest.json')), plan.documentRequest)
    await writeJson(planPath, plan)
    await this.emitBundleArtifact(bundle, 'manual-plan.json', 'intermediate')
    await mergeGenerationManifest(path.join(
      bundle,
      'generation-manifest.json',
    ), {
      status: 'prepared',
      analysisMode: 'transcript',
      stages: { transcript: 'complete', analysis: 'complete' },
      fields: {
        manualPlanSchemaVersion: plan.manualPlanSchemaVersion,
        sourceLanguage: plan.sourceLanguage ?? 'unknown',
        outputLanguage: plan.outputLanguage,
      },
      updatedAt: this.now().toISOString(),
    })
    return {
      ok: true,
      action: 'write_manual_plan',
      manualRunId: input.manualRunId,
      manualPlanPath: this.relative(planPath),
      analysisMode: 'transcript',
    }
  }

  async build(input: {
    readonly videoId: string
    readonly manualRunId: string
    readonly signal?: AbortSignal
  }): Promise<YoutubeToolOutput> {
    const bundle = this.bundleDirectory(input.videoId, input.manualRunId)
    const manifestPath = path.join(bundle, 'generation-manifest.json')
    const planPath = path.join(bundle, 'manual-plan.json')
    const plan = parseYoutubeManualPlan(JSON.parse(await readManualPlanContent(planPath)))
    const existingManifest = await readJsonRecord(manifestPath)
    assertMatchingDocumentRequest(existingManifest, plan.documentRequest)
    const deleteVideosAfterInfoExtraction = typeof existingManifest.deleteVideosAfterInfoExtraction === 'boolean'
      ? existingManifest.deleteVideosAfterInfoExtraction
      : (await this.options.settings.snapshot()).deleteVideosAfterInfoExtraction ?? false
    if (existingManifest.deleteVideosAfterInfoExtraction === undefined) {
      await mergeGenerationManifest(manifestPath, {
        fields: { deleteVideosAfterInfoExtraction },
        updatedAt: this.now().toISOString(),
      })
    }
    let peakRssBytes = Math.max(manifestPeakRssBytes(existingManifest), this.rssBytes())
    const observePeakRssBytes = () => {
      peakRssBytes = Math.max(peakRssBytes, this.rssBytes())
      return peakRssBytes
    }
    if (existingManifest.status === 'complete' || existingManifest.status === 'complete_with_warnings') {
      await verifyCompletedOutputs(bundle, existingManifest)
      return await this.completedOutput(plan, input.manualRunId, bundle, true)
    }
    if (input.signal?.aborted) {
      await cancelGenerationManifestStage(manifestPath, {
        stage: 'download',
        cancelledAt: this.now().toISOString(),
      })
      throw abortError()
    }
    const notices = manifestNotices(existingManifest)
    let frames = await readReusableFrames(bundle, existingManifest)
    let diskPreflight: YoutubeDiskPreflight | undefined
    let sourceMediaSha256: string | undefined
    if (!frames) {
      this.emitProgress({ type: 'video_download_started' })
      await mergeGenerationManifest(manifestPath, {
        stages: { download: 'in_progress' },
        updatedAt: this.now().toISOString(),
      })
      try {
        const extracted = await this.extractDownloadedFrames(
          plan,
          bundle,
          input.signal,
          async (media) => {
            diskPreflight = media.diskPreflight
            sourceMediaSha256 = media.sha256
            await mergeGenerationManifest(manifestPath, {
              stages: { download: 'complete', frames: 'in_progress' },
              fields: {
                diskPreflight: { status: 'complete', ...media.diskPreflight },
                sourceMedia: {
                  sha256: media.sha256 ?? 'unavailable',
                  byteLength: media.byteLength,
                  durationSeconds: media.durationSeconds,
                  width: media.width,
                  height: media.height,
                  container: media.container ?? 'unknown',
                  // The fact that the profile's sign-in was used, so an operator
                  // can tell an anonymous download from a signed-in one without
                  // reading cookies. Nothing about the cookies themselves. A
                  // resumed legacy bundle records no fact rather than a false
                  // one, so the key is absent when the truth is unknown.
                  ...whenDefined(media.usedProfileSession, (usedProfileSession) => ({
                    usedProfileSession,
                  })),
                },
              },
              updatedAt: this.now().toISOString(),
            })
          },
        )
        frames = extracted.frames
        diskPreflight = extracted.media.diskPreflight
        await mergeGenerationManifest(manifestPath, {
          stages: { download: 'complete', frames: 'complete' },
          fields: { diskPreflight: { status: 'complete', ...diskPreflight } },
          updatedAt: this.now().toISOString(),
        })
      } catch (error) {
        if (input.signal?.aborted) {
          const interruptedStage = error instanceof YoutubeManualBuildStageError
            ? error.stage
            : await readReusableMedia(bundle) ? 'frames' : 'download'
          await cancelGenerationManifestStage(manifestPath, {
            stage: interruptedStage,
            cancelledAt: this.now().toISOString(),
          })
          throw error
        }
        if (!this.options.browserFrames) throw error
        const failureStage = error instanceof YoutubeManualBuildStageError ? error.stage : 'download'
        const toolsUnavailable = error instanceof YoutubeMediaToolsUnavailableError ? error : undefined
        diskPreflight = error instanceof YoutubeManualBuildStageError
          ? error.media?.diskPreflight
          : undefined
        // A download that failed is the run an operator most needs this for: it
        // says whether the bot check was met with the profile's sign-in or
        // without it. Only the download stage writes it, since a frame failure
        // already recorded the whole of `sourceMedia`.
        const attemptedProfileSession = error instanceof YoutubeManualBuildStageError
          && failureStage === 'download'
          ? error.usedProfileSession
          : undefined
        notices.push(toolsUnavailable
          ? mediaToolsUnavailableNotice(toolsUnavailable.unavailableReason)
          : failureStage === 'frames' ? {
            code: 'frame_extraction_failed',
            severity: 'warning',
            message: 'Local frame extraction failed. Screenshots were captured from the application browser instead.',
          } : {
            code: 'media_download_fallback',
            severity: 'warning',
            message: 'The video download failed. Screenshots were captured from the application browser instead.',
          })
        await mergeGenerationManifest(manifestPath, {
          stages: {
            download: toolsUnavailable
              ? 'skipped'
              : failureStage === 'download' ? 'failed' : 'complete',
            frames: 'in_progress',
          },
          notices,
          // No download was attempted without the tools, so no preflight ran
          // and the manifest must not claim one failed.
          ...(toolsUnavailable ? {} : {
            fields: {
              diskPreflight: diskPreflight
                ? { status: 'complete', ...diskPreflight }
                : { status: 'failed' },
              ...whenDefined(attemptedProfileSession, (usedProfileSession) => ({
                sourceMedia: { usedProfileSession },
              })),
            },
          }),
          updatedAt: this.now().toISOString(),
        })
        try {
          frames = [...await this.options.browserFrames.captureYoutubeFrames({
            videoId: plan.video.videoId,
            outputDirectory: path.join(bundle, 'frames'),
            cues: plan.steps.flatMap((step) => step.visualCues.map((cue) => ({
              stepId: step.id,
              timestampSeconds: cue.timestampSeconds,
              importance: cue.importance,
              caption: cue.caption,
              altText: cue.altText,
            }))),
            ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
          })]
        } catch (browserError) {
          if (input.signal?.aborted) {
            await cancelGenerationManifestStage(manifestPath, {
              stage: 'frames',
              cancelledAt: this.now().toISOString(),
            })
            throw browserError
          }
          const fallbackError = browserFallbackError(browserError)
          await mergeGenerationManifest(manifestPath, {
            status: 'failed',
            stages: { frames: 'failed' },
            // Only a browser error states its reason in vocabulary safe to
            // keep; any other failure could carry a path or subprocess output
            // into the bundle, so the manifest records the stage alone.
            ...(fallbackError ? { notices: [browserCaptureFailedNotice(fallbackError.message)] } : {}),
            updatedAt: this.now().toISOString(),
          })
          throw fallbackError ?? browserError
        }
        await mergeGenerationManifest(manifestPath, {
          stages: { frames: 'complete' },
          updatedAt: this.now().toISOString(),
        })
      }
      frames = deduplicateYoutubeFrames(await normalizeSelectedFrames(bundle, frames))
      await writeJson(path.join(bundle, 'frames.json'), frames)
      await this.emitBundleArtifact(bundle, 'frames.json', 'intermediate')
      await mergeGenerationManifest(manifestPath, {
        fields: {
          frames: frames.map((frame) => ({
            path: frame.relativePath,
            captureMethod: frame.selectionReason === 'browser_fallback' ? 'browser' : 'ffmpeg',
            requestedTimestampSeconds: frame.requestedTimestampSeconds,
            actualTimestampSeconds: frame.actualTimestampSeconds,
            sha256: frame.sha256,
            visualHash: frame.visualHash,
            stepId: frame.stepId,
            importance: frame.importance ?? 'required',
            ...(sourceMediaSha256 ? { sourceMediaSha256 } : {}),
          })),
          resourceMeasurements: { peakRssBytes: observePeakRssBytes() },
        },
        updatedAt: this.now().toISOString(),
      })
      this.emitProgress({ type: 'key_frames_extracted', frameCount: frames.length })
    }
    if (plan.documentRequest) {
      try {
        frames = await this.reviewCapturedScreenshots(bundle, plan, frames, input.signal)
        await writeJson(path.join(bundle, 'frames.json'), frames)
      } catch (error) {
        await mergeGenerationManifest(manifestPath, { status: input.signal?.aborted ? 'cancelled' : 'failed', stages: { screenshot_review: input.signal?.aborted ? 'cancelled' : 'failed' }, updatedAt: this.now().toISOString() })
        throw error
      }
    }
    const publicationManifest = await readJsonRecord(manifestPath)
    const reusePublication = await reusablePublishedOutputs(bundle, publicationManifest)
    if (!reusePublication) {
      this.emitProgress({ type: 'manual_publication_started' })
      await mergeGenerationManifest(manifestPath, {
        status: 'publishing',
        stages: publicationStages(plan, 'in_progress'),
        updatedAt: this.now().toISOString(),
      })
      try {
        await (this.options.publishManual ?? publishYoutubeManual)({
          bundleDirectory: bundle,
          plan,
          frames,
          ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
        })
      } catch (error) {
        if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          await mergeGenerationManifest(manifestPath, {
            status: 'cancelled',
            stages: { ...publicationStages(plan, 'cancelled'), cleanup: 'cancelled' },
            cancelledAt: this.now().toISOString(),
            updatedAt: this.now().toISOString(),
          })
        } else {
          await mergeGenerationManifest(manifestPath, {
            status: 'failed',
            stages: publicationStages(plan, 'failed'),
            updatedAt: this.now().toISOString(),
          })
        }
        throw error
      }
      if (requestedFormats(plan).includes('markdown')) this.emitProgress({ type: 'manual_markdown_written' })
      if (requestedFormats(plan).includes('docx')) this.emitProgress({ type: 'manual_docx_written' })
      await mergeGenerationManifest(manifestPath, {
        stages: publicationStages(plan, 'complete'),
        fields: {
          outputs: await outputRecords(bundle, plan),
          resourceMeasurements: { peakRssBytes: observePeakRssBytes() },
        },
        updatedAt: this.now().toISOString(),
      })
    }
    if (input.signal?.aborted) {
      await cancelGenerationManifestStage(manifestPath, {
        stage: 'cleanup',
        cancelledAt: this.now().toISOString(),
      })
      throw abortError()
    }
    let sourceVideoRetained = false
    try {
      const retainedVideo = deleteVideosAfterInfoExtraction
        ? undefined
        : await retainDownloadedVideo(bundle)
      if (retainedVideo) {
        sourceVideoRetained = true
        await mergeGenerationManifest(manifestPath, {
          fields: { sourceVideoPath: path.basename(retainedVideo.path) },
          updatedAt: this.now().toISOString(),
        })
        await this.emitBundleArtifact(bundle, 'source-video.mp4', 'final')
        this.emitProgress({
          type: 'source_video_retained',
          path: this.relative(retainedVideo.path),
          byteLength: retainedVideo.byteLength,
        })
      }
      await (this.options.cleanupWorkingDirectory ?? (async (directory) => {
        await fs.rm(directory, { recursive: true, force: true })
      }))(path.join(bundle, 'working'))
      if (deleteVideosAfterInfoExtraction) await recordDeletedDownloadedVideo(bundle)
    } catch (error) {
      if (input.signal?.aborted) {
        await cancelGenerationManifestStage(manifestPath, {
          stage: 'cleanup',
          cancelledAt: this.now().toISOString(),
        })
        throw error
      }
      notices.push({
        code: 'cleanup_warning',
        severity: 'warning',
        message: 'The manual was published, but some temporary media could not be removed.',
      })
      await mergeGenerationManifest(manifestPath, {
        status: 'complete_with_warnings',
        stages: { cleanup: 'warning' },
        notices,
        updatedAt: this.now().toISOString(),
      })
      return await this.completedOutput(plan, input.manualRunId, bundle, false, notices)
    }
    await mergeGenerationManifest(manifestPath, {
      status: 'complete',
      stages: { cleanup: 'complete' },
      fields: { outputs: await outputRecords(bundle, plan) },
      updatedAt: this.now().toISOString(),
    })
    if (!sourceVideoRetained) this.emitProgress({ type: 'temporary_media_cleaned' })
    return await this.completedOutput(plan, input.manualRunId, bundle, false, notices)
  }

  private async extractDownloadedFrames(
    plan: YoutubeManualPlan,
    bundle: string,
    signal?: AbortSignal,
    onMediaReady?: (media: YoutubeDownloadedMedia) => Promise<void>,
  ): Promise<{ readonly frames: YoutubeSelectedFrame[]; readonly media: YoutubeDownloadedMedia }> {
    if (!this.options.binaries) {
      throw new YoutubeMediaToolsUnavailableError(this.options.binariesUnavailableReason)
    }
    let media = await readReusableMedia(bundle)
    if (!media) {
      // Known before yt-dlp runs, so a download that fails still reports which
      // of the two it was to the manifest.
      let usedProfileSession: boolean | undefined
      try {
        media = await (this.options.downloadMedia ?? downloadYoutubeMedia)({
          ...this.options.binaries,
          url: plan.video.url,
          workingDirectory: path.join(bundle, 'working', 'media'),
          maximumMediaBytes: 4 * 1_024 * 1_024 * 1_024,
          maximumDurationSeconds: 86_400,
          expectedFrameCount: plan.steps.reduce((count, step) => count + step.visualCues.length, 0),
          ...whenDefined(this.options.youtubeCookieHeader, (definedValue) => ({
            youtubeCookieHeader: definedValue,
          })),
          onProfileSession: (used) => { usedProfileSession = used },
          ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
        })
      } catch (error) {
        throw new YoutubeManualBuildStageError('download', undefined, {
          cause: error,
          ...whenDefined(usedProfileSession, (used) => ({ usedProfileSession: used })),
        })
      }
      media = { ...media, sha256: await hashFileSha256(media.path) }
      await writeJson(path.join(bundle, 'media.json'), {
        ...media,
        path: path.relative(bundle, media.path).split(path.sep).join('/'),
      })
      await this.emitBundleArtifact(bundle, 'media.json', 'intermediate')
    }
    await onMediaReady?.(media)
    this.emitProgress({
      type: 'video_downloaded',
      byteLength: media.byteLength,
      durationSeconds: media.durationSeconds,
      width: media.width,
      height: media.height,
    })
    const template = YOUTUBE_MANUAL_TEMPLATES[plan.templateId]
    const schedule = buildYoutubeFrameSchedule({
      durationSeconds: plan.video.durationSeconds,
      maximumFrames: template.maximumFrames,
      ...(template.supportingIntervalSeconds
        ? { denseIntervalSeconds: template.supportingIntervalSeconds }
        : {}),
      steps: plan.steps,
    })
    let extracted
    try {
      this.emitProgress({ type: 'key_frames_extraction_started' })
      extracted = await (this.options.extractFrames ?? extractYoutubeFrames)({
        ffmpegPath: this.options.binaries.ffmpegPath,
        mediaPath: media.path,
        outputDirectory: path.join(bundle, 'frames'),
        maximumWidthPx: YOUTUBE_FRAME_EXTRACTION_MAX_WIDTH_PX,
        candidates: schedule,
        ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
      })
    } catch (error) {
      throw new YoutubeManualBuildStageError('frames', media, { cause: error })
    }
    const frames: YoutubeSelectedFrame[] = []
    for (const step of plan.steps) {
      for (const cue of step.visualCues) {
        const candidates = extracted.filter((frame) =>
          frame.stepId === step.id &&
          Math.abs(frame.requestedTimestampSeconds - cue.timestampSeconds) < 0.001)
        const selected = selectBestYoutubeFrameCandidate(cue.timestampSeconds, candidates)
        if (!selected && cue.importance === 'required') {
          throw new Error(`Required screenshot is unavailable for step '${step.id}'.`)
        }
        if (!selected) continue
        frames.push({
          stepId: step.id,
          importance: cue.importance,
          requestedTimestampSeconds: cue.timestampSeconds,
          actualTimestampSeconds: selected.actualTimestampSeconds,
          relativePath: selected.relativePath,
          caption: cue.caption,
          altText: cue.altText,
          selectionReason: selected.selectionReason,
          sha256: selected.sha256,
          meanLuma: selected.meanLuma,
          lumaRange: selected.lumaRange,
          blurScore: selected.blurScore,
        })
      }
    }
    return { frames, media }
  }

  private bundleDirectory(videoId: string, runId: string): string {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
      throw new Error('YouTube manual identity is invalid.')
    }
    return path.join(this.assignmentPath, 'output', 'manuals', videoId, runId)
  }

  private async minimumDiskPreflight(
    bundle: string,
    templateId: YoutubeManualTemplateId,
  ): Promise<NonNullable<YoutubeToolOutput['diskPreflight']>> {
    const requiredBytes = youtubeFrameHeadroomBytes(YOUTUBE_MANUAL_TEMPLATES[templateId].maximumFrames)
    try {
      const availableBytes = this.options.diskSpaceBytes
        ? await this.options.diskSpaceBytes(bundle)
        : await freeDiskSpace(bundle)
      return {
        status: availableBytes < requiredBytes ? 'failed' : 'partial',
        availableBytes,
        requiredBytes,
      }
    } catch {
      return { status: 'partial', requiredBytes }
    }
  }

  private relative(filePath: string): string {
    return path.relative(this.assignmentPath, filePath).split(path.sep).join('/')
  }

  private rssBytes(): number {
    return this.options.rssBytes?.() ?? process.memoryUsage().rss
  }

  private emitProgress(event: YoutubeManualProgressEvent): void {
    try {
      this.options.onProgress?.(event)
    } catch (error) {
      // Timeline publication must not invalidate completed media evidence, but
      // a silent failure here is indistinguishable from work that never ran.
      console.warn(
        `[youtube-manual] progress event '${event.type}' was not published:`,
        error,
      )
    }
  }

  /**
   * Announce a committed bundle file as a run artifact so it appears on the
   * Process Timeline and can be opened from the run view. The run UI is
   * event-sourced, so a file that is never announced is a file no reader can
   * reach.
   *
   * Each path is announced at most once per coordinator: the generation
   * manifest is rewritten on every stage transition, and cache reuse can
   * rewrite an analysis that was already reported. Silent when no artifact
   * context was supplied (ad-hoc service tests). Never rethrows — the file is
   * already committed and the run's own event log stays the source of truth.
   */
  private async emitBundleArtifact(
    bundle: string,
    name: AnnouncedBundleArtifact,
    artifactRole: 'intermediate' | 'final',
  ): Promise<void> {
    const context = this.options.artifactContext
    if (!context) return
    const relativePath = this.relative(path.join(bundle, name))
    if (this.announcedArtifacts.has(relativePath)) return
    this.announcedArtifacts.add(relativePath)
    const descriptor = ANNOUNCED_BUNDLE_ARTIFACTS[name]
    try {
      publishRuntimeArtifactWrittenEvent({
        outputDir: await fs.realpath(this.assignmentPath),
        relativePath,
        artifactType: descriptor.artifactType,
        artifactRole,
        createdAt: this.now().toISOString(),
        sessionId: context.sessionId,
        rootSessionId: context.rootSessionId,
        ...(context.parentSessionId ? { parentSessionId: context.parentSessionId } : {}),
        ...(context.team ? { team: context.team } : {}),
        ...(context.level ? { level: context.level } : {}),
        ...(context.stageType ? { stageType: context.stageType } : {}),
        title: descriptor.title,
      })
    } catch (error) {
      // The bundle file is committed and a missing timeline row must never fail
      // a completed manual — but an unannounced artifact is invisible in the
      // run view, so the reason has to reach the log.
      console.warn(
        `[youtube-manual] artifact '${relativePath}' was not announced:`,
        error,
      )
    }
  }

  private async reviewCapturedScreenshots(bundle: string, plan: YoutubeManualPlan, frames: readonly YoutubeSelectedFrame[], signal?: AbortSignal): Promise<YoutubeSelectedFrame[]> {
    const reviewPath = path.join(bundle, 'screenshot-review.json')
    const previous = await readJsonRecordIfExists(reviewPath)
    const cachedReview = screenshotReviewCacheSchema.safeParse(previous)
    if (cachedReview.success) {
      const captions = cachedReview.data.captions
      const reusable = captions.length === frames.length && frames.every((frame, index) => {
        const entry = captions[index]
        return entry?.sha256 === frame.sha256 && entry.relativePath === frame.relativePath
      })
      if (reusable) return frames.map((frame, index) => {
        const entry = captions[index]
        if (!entry) throw new Error('Screenshot review entry is missing.')
        return { ...frame, caption: entry.caption, altText: entry.altText }
      })
    }
    const runtime = await this.options.settings.runtimeGemini()
    if (!runtime.apiKey || !this.analysis.reviewScreenshots) {
      const neutral = frames.map((frame) => ({ ...frame, caption: `Video frame at ${frame.actualTimestampSeconds}s (visual description not verified)`, altText: `Captured video frame at ${frame.actualTimestampSeconds} seconds; visual description unavailable` }))
      await writeJson(reviewPath, { status: 'unavailable', captions: neutral.map(({ relativePath, sha256, caption, altText }) => ({ relativePath, sha256, caption, altText })) })
      return neutral
    }
    const reviewed: YoutubeSelectedFrame[] = []
    let inputTokens = 0
    let outputTokens = 0
    // Bound both concurrency and inline image payloads. Each batch is one
    // stateless image-only request; source video is not billed a second time.
    for (let offset = 0; offset < frames.length; offset += 5) {
      signal?.throwIfAborted()
      const batch = frames.slice(offset, offset + 5)
      const screenshots = []
      for (const [index, frame] of batch.entries()) {
        const filePath = path.join(bundle, frame.relativePath)
        const resolved = await fs.realpath(filePath)
        if (!resolved.startsWith(`${await fs.realpath(bundle)}${path.sep}`)) throw new Error('Screenshot review path escapes its bundle.')
        const stat = await fs.stat(resolved)
        if (stat.size > 2 * 1024 * 1024 || await hashFileSha256(resolved) !== frame.sha256) throw new Error('Screenshot review image is oversized or changed.')
        screenshots.push({ index, data: (await fs.readFile(resolved)).toString('base64'), proposedCaption: frame.caption, sectionContext: plan.steps.find((step) => step.id === frame.stepId)?.explanation ?? '', timestampSeconds: frame.actualTimestampSeconds })
      }
      const result = await this.analysis.reviewScreenshots({ apiKey: runtime.apiKey, model: runtime.model, outputLanguage: plan.outputLanguage, screenshots }, signal)
      inputTokens += result.usage?.inputTokens ?? 0
      outputTokens += result.usage?.outputTokens ?? 0
      for (const [index, frame] of batch.entries()) {
        const caption = result.captions.find((entry) => entry.index === index)
        if (!caption) throw new Error('Screenshot review omitted a captured image.')
        reviewed.push({ ...frame, caption: caption.caption, altText: caption.altText })
      }
    }
    await writeJson(reviewPath, { status: 'pixel_reviewed', model: runtime.model, usage: { inputTokens, outputTokens }, captions: reviewed.map(({ relativePath, sha256, caption, altText }) => ({ relativePath, sha256, caption, altText })) })
    return reviewed
  }

  private async completedOutput(
    plan: YoutubeManualPlan,
    manualRunId: string,
    bundle: string,
    reused: boolean,
    notices: readonly YoutubeUserNotice[] = [],
  ): Promise<YoutubeToolOutput> {
    const markdownPath = path.join(bundle, 'manual.md')
    const docxPath = path.join(bundle, 'manual.docx')
    const manifest = await readJsonRecord(path.join(bundle, 'generation-manifest.json'))
    const manifestFrameCount = Array.isArray(manifest.frames) ? manifest.frames.length : 0
    const providerUsage = manifest.providerUsage && typeof manifest.providerUsage === 'object'
      ? manifest.providerUsage as YoutubeToolOutput['providerUsage']
      : undefined
    const costEstimate = manifest.costEstimate && typeof manifest.costEstimate === 'object'
      ? manifest.costEstimate as NonNullable<YoutubeToolOutput['costEstimate']>
      : undefined
    const diskPreflight = manifest.diskPreflight && typeof manifest.diskPreflight === 'object'
      ? manifest.diskPreflight as NonNullable<YoutubeToolOutput['diskPreflight']>
      : undefined
    const sourceVideoPath = typeof manifest.sourceVideoPath === 'string'
      ? this.relative(path.join(bundle, manifest.sourceVideoPath))
      : undefined
    // The single terminal funnel for every completed build — fresh, reused, and
    // cleanup-warning — so the deliverables and the generation record are
    // announced exactly once, after the manifest reaches its final status.
    const formats = requestedFormats(plan)
    if (formats.includes('markdown')) await this.emitBundleArtifact(bundle, 'manual.md', plan.documentRequest ? 'final' : 'intermediate')
    if (formats.includes('docx')) await this.emitBundleArtifact(bundle, 'manual.docx', 'final')
    if (plan.documentRequest && formats.includes('markdown')) await this.emitBundleArtifact(bundle, 'manual.zip', 'intermediate')
    await this.emitBundleArtifact(bundle, 'generation-manifest.json', 'intermediate')
    return {
      ok: true,
      action: 'build_manual',
      manualRunId,
      manualPlanPath: this.relative(path.join(bundle, 'manual-plan.json')),
      ...(formats.includes('markdown') ? { manualMarkdownPath: this.relative(markdownPath) } : {}),
      ...(formats.includes('docx') ? { manualDocxPath: this.relative(docxPath) } : {}),
      ...(plan.documentRequest && formats.includes('markdown') ? { manualZipPath: this.relative(path.join(bundle, 'manual.zip')) } : {}),
      manualBundlePath: this.relative(bundle),
      ...(sourceVideoPath ? { sourceVideoPath } : {}),
      previewPath: this.relative(formats.includes('markdown') ? markdownPath : docxPath),
      frameCount: manifestFrameCount,
      analysisMode: plan.analysis.mode,
      generationStatus: String(manifest.status ?? 'complete'),
      ...(providerUsage ? { providerUsage } : {}),
      ...(costEstimate ? { costEstimate: { ...costEstimate, available: true } } : {}),
      ...(diskPreflight ? { diskPreflight } : {}),
      reused,
      ...(notices.length > 0 ? { notices } : {}),
    }
  }

  private analysisCachePath(input: {
    readonly video: YoutubeManualVideo
    readonly model: string
    readonly sourceRevisionFingerprint: string
    readonly documentRequest?: YoutubeDocumentRequest
    readonly outputLanguage?: string
  }): string {
    const cacheKey = createHash('sha256').update(JSON.stringify({
      videoId: input.video.videoId,
      sourceRevisionFingerprint: input.sourceRevisionFingerprint,
      analysisPromptVersion: YOUTUBE_ANALYSIS_PROMPT_VERSION,
      outputLanguage: input.outputLanguage ?? 'source',
      model: input.model,
      documentRequest: input.documentRequest ?? null,
    })).digest('hex')
    return path.join(this.assignmentPath, 'output', 'manuals', '.analysis-cache', `${cacheKey}.json`)
  }
}

function canonicalYoutubeVideoId(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.pathname !== '/watch') return undefined
    const videoId = url.searchParams.get('v')
    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : undefined
  } catch {
    return undefined
  }
}

function sourceFingerprint(video: YoutubeManualVideo): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    videoId: video.videoId,
    durationSeconds: video.durationSeconds,
    publishedAt: video.publishedAt ?? null,
  })).digest('hex')}`
}

function missingKeyNotice(): YoutubeUserNotice {
  return {
    code: 'gemini_key_missing',
    severity: 'warning',
    message: 'Gemini video analysis is not configured. Add a Google AI Studio API key in Settings -> Research & Acquisition -> YouTube video analysis. Continuing with transcript-based analysis.',
  }
}

function providerFallbackNotice(error: unknown): YoutubeUserNotice {
  if (error instanceof YoutubeGeminiAnalysisError) {
    if (error.kind === 'authentication') return {
      code: 'gemini_auth_failed', severity: 'warning',
      message: 'Gemini authentication failed. Check the Google AI Studio key in Settings. Continuing with transcript-based analysis.',
    }
    if (error.kind === 'rate_limited') return {
      code: 'gemini_rate_limited', severity: 'warning',
      message: 'Gemini is rate-limited. Continuing with transcript-based analysis.',
    }
    if (error.kind === 'invalid_response') return {
      code: 'gemini_invalid_response', severity: 'warning',
      message: 'Gemini returned an invalid video analysis. Continuing with transcript-based analysis.',
    }
  }
  return {
    code: 'gemini_unavailable', severity: 'warning',
    message: 'Gemini is temporarily unavailable. Continuing with transcript-based analysis.',
  }
}

function mediaToolsUnavailableNotice(reason: string | undefined): YoutubeUserNotice {
  const safeReason = agentSafeReason(reason)
  return {
    code: 'media_tools_unavailable',
    severity: 'warning',
    message: [
      'The bundled video tools are unavailable, so the video was not downloaded.',
      ...(safeReason ? [safeReason] : []),
      'Screenshots will be captured from the application browser instead.',
    ].join(' '),
  }
}

/**
 * The binary resolver names most failures in a curated sentence, but its `fs`
 * and `execFile` rejections reach the same field carrying the install path and
 * raw subprocess output. A notice is read back to the user, so it takes a
 * reason only when it reads like one of the curated sentences: a single short
 * line naming no path. The desktop host logs the whole message either way.
 */
function agentSafeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim()
  if (!trimmed || trimmed.length > MAX_UNAVAILABLE_REASON_LENGTH) return undefined
  return /[\n\r/\\]/.test(trimmed) ? undefined : trimmed
}

function browserCaptureFailedNotice(reason: string): YoutubeUserNotice {
  return {
    code: 'browser_capture_failed',
    severity: 'error',
    message: `The application browser could not capture the screenshots. ${reason}`,
  }
}

/**
 * Restate a browser frame-capture failure in the tool's own error vocabulary,
 * keeping the browser's reason. `BrowserRuntimeError` is matched structurally
 * so the manual coordinator's only browser dependency stays the frame port.
 */
function browserFallbackError(error: unknown): YoutubeRuntimeError | undefined {
  if (!(error instanceof Error) || error.name !== 'BrowserRuntimeError') return undefined
  const code = 'code' in error && typeof error.code === 'string'
    ? BROWSER_FALLBACK_ERROR_CODES[error.code] ?? 'browser_unavailable'
    : 'browser_unavailable'
  const retryable = 'retryable' in error && typeof error.retryable === 'boolean'
    ? error.retryable
    : false
  const fallbackError = new YoutubeRuntimeError(code, error.message, retryable)
  // `YoutubeRuntimeError` takes no options bag, so the browser error is
  // attached afterwards; logs then keep its stack and its page fields.
  fallbackError.cause = error
  return fallbackError
}

/** Browser error codes the YouTube tool names the same way; the rest report the browser as unavailable. */
const BROWSER_FALLBACK_ERROR_CODES: Readonly<Record<string, YoutubeErrorCode>> = {
  approval_denied: 'approval_denied',
  approval_expired: 'approval_expired',
  browser_unavailable: 'browser_unavailable',
  cancelled: 'cancelled',
  internal: 'internal',
  invalid_request: 'invalid_request',
}

async function readManualPlanContent(planPath: string): Promise<string> {
  try {
    return await fs.readFile(planPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new YoutubeRuntimeError(
        'invalid_request',
        'This YouTube manual run has no manual-plan.json. Call write_manual_plan with the plan for this videoId and manualRunId, then build the manual again.',
      )
    }
    throw error
  }
}

async function ensureSafeDirectory(directory: string, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root)
  const resolvedDirectory = path.resolve(directory)
  const relative = path.relative(resolvedRoot, resolvedDirectory)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('YouTube manual output must be a safe real directory.')
  }
  const rootStat = await fs.lstat(resolvedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('YouTube manual output must be a safe real directory.')
  }
  let current = resolvedRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('YouTube manual output must be a safe real directory.')
    }
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('YouTube generation manifest is invalid.')
  }
  return value as Record<string, unknown>
}

async function readJsonRecordIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await readJsonRecord(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function assertMatchingPreparation(
  manifest: Record<string, unknown>,
  input: {
    readonly video: YoutubeManualVideo
    readonly templateId: YoutubeManualTemplateId
    readonly documentRequest?: YoutubeDocumentRequest
    readonly outputLanguage?: string
  },
): void {
  assertMatchingDocumentRequest(manifest, input.documentRequest)
  if (
    manifest.videoId !== input.video.videoId ||
    manifest.templateId !== input.templateId ||
    manifest.outputLanguage !== (input.outputLanguage ?? 'source')
  ) {
    throw new Error('The manual run belongs to different YouTube preparation inputs. Start a new run.')
  }
}

async function preparedOutputIfReusable(input: {
  readonly bundle: string
  readonly manifest: Record<string, unknown>
  readonly runId: string
  readonly relative: (filePath: string) => string
}): Promise<YoutubeToolOutput | undefined> {
  const status = input.manifest.status
  const notices = Array.isArray(input.manifest.notices)
    ? input.manifest.notices as YoutubeUserNotice[]
    : undefined
  const costEstimate = input.manifest.costEstimate && typeof input.manifest.costEstimate === 'object'
    ? input.manifest.costEstimate as NonNullable<YoutubeToolOutput['costEstimate']>
    : undefined
  const diskPreflight = input.manifest.diskPreflight && typeof input.manifest.diskPreflight === 'object'
    ? input.manifest.diskPreflight as NonNullable<YoutubeToolOutput['diskPreflight']>
    : undefined
  if (status === 'prepared') {
    const planPath = path.join(input.bundle, 'manual-plan.json')
    parseYoutubeManualPlan(JSON.parse(await fs.readFile(planPath, 'utf8')))
    return {
      ok: true,
      action: 'prepare_manual',
      manualRunId: input.runId,
      manifestPath: input.relative(path.join(input.bundle, 'generation-manifest.json')),
      manualPlanPath: input.relative(planPath),
      analysisMode: input.manifest.analysisMode === 'transcript' ? 'transcript' : 'gemini',
      confirmationRequired: false,
      ...(costEstimate ? { costEstimate: { ...costEstimate, available: true } } : {}),
      ...(diskPreflight ? { diskPreflight } : {}),
      ...(notices?.length ? { notices } : {}),
      reused: true,
    }
  }
  if (status === 'awaiting_transcript_plan') {
    return {
      ok: true,
      action: 'prepare_manual',
      manualRunId: input.runId,
      manifestPath: input.relative(path.join(input.bundle, 'generation-manifest.json')),
      analysisMode: 'transcript',
      ...(diskPreflight ? { diskPreflight } : {}),
      ...(notices?.length ? { notices } : {}),
      reused: true,
    }
  }
  if (status === 'awaiting_confirmation') {
    return {
      ok: true,
      action: 'prepare_manual',
      manualRunId: input.runId,
      manifestPath: input.relative(path.join(input.bundle, 'generation-manifest.json')),
      confirmationRequired: true,
      ...(diskPreflight ? { diskPreflight } : {}),
      ...(costEstimate ? { costEstimate: { ...costEstimate, available: true } } : {}),
      ...(notices?.length ? { notices } : {}),
      reused: true,
    }
  }
  return undefined
}

function manifestBinaries(binaries: {
  readonly ytDlpPath: string
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly ytDlpVersion?: string
  readonly ytDlpSha256?: string
  readonly ffmpegVersion?: string
  readonly ffmpegSha256?: string
  readonly ffprobeVersion?: string
  readonly ffprobeSha256?: string
} | undefined): readonly Record<string, unknown>[] {
  if (!binaries) return []
  const rows: readonly (readonly [string, string, string | undefined, string | undefined])[] = [
    ['yt-dlp', binaries.ytDlpPath, binaries.ytDlpVersion, binaries.ytDlpSha256],
    ['ffmpeg', binaries.ffmpegPath, binaries.ffmpegVersion, binaries.ffmpegSha256],
    ['ffprobe', binaries.ffprobePath, binaries.ffprobeVersion, binaries.ffprobeSha256],
  ]
  return rows.map(([name, filePath, version, sha256]) => ({
    name,
    fileName: path.basename(filePath),
    version: version ?? 'unavailable',
    sha256: sha256 ?? 'unavailable',
  }))
}

async function outputRecords(bundle: string, plan: YoutubeManualPlan): Promise<readonly {
  readonly path: string
  readonly byteLength: number
  readonly sha256: string
}[]> {
  const records = []
  const paths = [
    ...requestedFormats(plan).map((format) => format === 'markdown' ? 'manual.md' : 'manual.docx'),
    ...(plan.documentRequest && requestedFormats(plan).includes('markdown') ? ['manual.zip'] : []),
    'manual-plan.json', 'video-metadata.json', 'frames.json',
  ]
  for (const optionalPath of ['video-analysis.json', 'screenshot-review.json', 'media.json', 'source-video.mp4']) {
    try {
      const stat = await fs.lstat(path.join(bundle, optionalPath))
      if (stat.isFile() && !stat.isSymbolicLink()) paths.push(optionalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const relativePath of paths) {
    const filePath = path.join(bundle, relativePath)
    const stat = await fs.stat(filePath)
    records.push({
      path: relativePath,
      byteLength: stat.size,
      sha256: await hashFileSha256(filePath),
    })
  }
  return records
}

async function verifyCompletedOutputs(
  bundle: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const request = manifest.documentRequest === undefined ? undefined : youtubeDocumentRequestSchema.parse(manifest.documentRequest)
  const required = ['manual-plan.json', 'video-metadata.json', 'frames.json', ...(request?.formats ?? ['markdown', 'docx']).map((format) => format === 'markdown' ? 'manual.md' : 'manual.docx'), ...(request?.formats.includes('markdown') ? ['manual.zip'] : [])]
  const outputs = isUnknownArray(manifest.outputs) ? manifest.outputs : []
  if (required.some((file) => !outputs.some((entry) => entry && typeof entry === 'object' && Reflect.get(entry, 'path') === file))) {
    throw new Error('Completed artifact verification failed: output records are missing.')
  }
  for (const item of outputs) {
    if (!item || typeof item !== 'object') {
      throw new Error('Completed artifact verification failed: output record is invalid.')
    }
    const record = item as { path?: unknown; byteLength?: unknown; sha256?: unknown }
    if (
      typeof record.path !== 'string' || path.isAbsolute(record.path) || record.path.includes('\0') ||
      !Number.isSafeInteger(record.byteLength) ||
      typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
    ) throw new Error('Completed artifact verification failed: output record is invalid.')
    const filePath = path.resolve(bundle, record.path)
    if (!filePath.startsWith(`${path.resolve(bundle)}${path.sep}`)) {
      throw new Error('Completed artifact verification failed: output path is invalid.')
    }
    const stat = await fs.lstat(filePath).catch(() => undefined)
    if (
      !stat?.isFile() || stat.isSymbolicLink() || stat.size !== record.byteLength ||
      await hashFileSha256(filePath) !== record.sha256
    ) throw new Error('Completed artifact verification failed: output content changed.')
  }
}

async function reusablePublishedOutputs(
  bundle: string,
  manifest: Record<string, unknown>,
): Promise<boolean> {
  const stages = manifest.stages
  if (
    !stages || typeof stages !== 'object' ||
    !['complete', 'not_requested'].includes(String(Reflect.get(stages, 'markdown'))) ||
    !['complete', 'not_requested'].includes(String(Reflect.get(stages, 'docx')))
  ) return false
  try {
    await verifyCompletedOutputs(bundle, manifest)
    return true
  } catch {
    return false
  }
}

async function normalizeSelectedFrames(
  bundle: string,
  frames: readonly YoutubeSelectedFrame[],
): Promise<YoutubeSelectedFrame[]> {
  const normalized: YoutubeSelectedFrame[] = []
  for (const frame of frames) {
    const filePath = path.resolve(bundle, frame.relativePath)
    if (!filePath.startsWith(`${bundle}${path.sep}`)) {
      throw new Error('YouTube screenshot path is invalid.')
    }
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('YouTube screenshot path is invalid.')
    }
    const bytes = await fs.readFile(filePath)
    const visualHash = pngAverageHash(bytes)
    normalized.push({
      ...frame,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(visualHash ? { visualHash } : {}),
    })
  }
  return normalized
}

function pngAverageHash(bytes: Buffer): string | undefined {
  try {
    const image = PNG.sync.read(bytes)
    if (image.width < 1 || image.height < 1) return undefined
    const values: number[] = []
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / 8))
        const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / 8))
        const offset = (sourceY * image.width + sourceX) * 4
        values.push(
          image.data.readUInt8(offset) * 0.299 +
          image.data.readUInt8(offset + 1) * 0.587 +
          image.data.readUInt8(offset + 2) * 0.114,
        )
      }
    }
    const average = values.reduce((sum, value) => sum + value, 0) / values.length
    let hash = ''
    for (let index = 0; index < values.length; index += 4) {
      let nibble = 0
      for (const [bit, value] of values.slice(index, index + 4).entries()) {
        if (value >= average) nibble |= 1 << (3 - bit)
      }
      hash += nibble.toString(16)
    }
    return hash
  } catch {
    return undefined
  }
}

async function readReusableMedia(bundle: string): Promise<YoutubeDownloadedMedia | undefined> {
  try {
    const record = JSON.parse(await fs.readFile(path.join(bundle, 'media.json'), 'utf8')) as
      Omit<YoutubeDownloadedMedia, 'path'> & { readonly path: string; readonly sha256: string }
    if (path.isAbsolute(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256)) return undefined
    const mediaPath = path.resolve(bundle, record.path)
    if (!mediaPath.startsWith(`${path.resolve(bundle)}${path.sep}`)) return undefined
    const stat = await fs.lstat(mediaPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.byteLength) return undefined
    if (await hashFileSha256(mediaPath) !== record.sha256) return undefined
    // A bundle downloaded before this field existed carries no session fact. It
    // stays absent rather than becoming `false`, which would claim an anonymous
    // download the bundle never recorded.
    return {
      ...record,
      ...(typeof record.usedProfileSession === 'boolean'
        ? { usedProfileSession: record.usedProfileSession }
        : {}),
      path: mediaPath,
    }
  } catch {
    return undefined
  }
}

async function retainDownloadedVideo(
  bundle: string,
): Promise<{ readonly path: string; readonly byteLength: number } | undefined> {
  const media = await readReusableMedia(bundle)
  if (!media) return undefined
  const retainedPath = path.join(bundle, 'source-video.mp4')
  if (path.resolve(media.path) !== path.resolve(retainedPath)) {
    await fs.rename(media.path, retainedPath)
  }
  await writeJson(path.join(bundle, 'media.json'), {
    ...media,
    path: 'source-video.mp4',
    retention: 'retained',
  })
  return { path: retainedPath, byteLength: media.byteLength }
}

async function recordDeletedDownloadedVideo(bundle: string): Promise<void> {
  const mediaPath = path.join(bundle, 'media.json')
  const record = await readJsonRecordIfExists(mediaPath)
  if (!record) return
  const { path: _removedPath, ...metadata } = record
  await writeJson(mediaPath, {
    ...metadata,
    path: null,
    retention: 'deleted',
  })
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

function manifestPeakRssBytes(manifest: Record<string, unknown>): number {
  const measurements = manifest.resourceMeasurements
  if (!measurements || typeof measurements !== 'object') return 0
  const value = (measurements as Record<string, unknown>).peakRssBytes
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

async function freeDiskSpace(directory: string): Promise<number> {
  const stat = await fs.statfs(directory)
  const availableBytes = Number(stat.bavail) * Number(stat.bsize)
  if (!Number.isFinite(availableBytes)) throw new Error('Free disk space is unavailable.')
  return availableBytes
}

async function readReusableFrames(
  bundle: string,
  manifest: Record<string, unknown>,
): Promise<YoutubeSelectedFrame[] | undefined> {
  const stages = manifest.stages
  if (!stages || typeof stages !== 'object' || (stages as Record<string, unknown>).frames !== 'complete') {
    return undefined
  }
  try {
    const stored: unknown = JSON.parse(await fs.readFile(path.join(bundle, 'frames.json'), 'utf8'))
    if (!Array.isArray(stored)) return undefined
    // One unreadable frame means the set is not the one that was captured, so
    // none of it is reused and the frames are captured again.
    const storedFrames = stored.filter(isYoutubeSelectedFrame)
    if (storedFrames.length !== stored.length) return undefined
    const normalized = await normalizeSelectedFrames(bundle, storedFrames)
    if (normalized.some((frame, index) => frame.sha256 !== storedFrames[index]?.sha256)) return undefined
    return normalized
  } catch {
    return undefined
  }
}

export async function cancelGenerationManifestStage(filePath: string, update: {
  readonly stage: string
  readonly cancelledAt: string
}): Promise<void> {
  await mergeGenerationManifest(filePath, {
    status: 'cancelled',
    stages: { [update.stage]: 'cancelled', cleanup: 'cancelled' },
    cancelledAt: update.cancelledAt,
    updatedAt: update.cancelledAt,
  })
}

export async function mergeGenerationManifest(
  filePath: string,
  update: {
    readonly status?: string
    readonly analysisMode?: string
    readonly stages?: Record<string, string>
    readonly notices?: readonly YoutubeUserNotice[]
    readonly cancelledAt?: string
    readonly fields?: Record<string, unknown>
    readonly updatedAt: string
  },
): Promise<void> {
  const queueKey = path.resolve(filePath)
  const previous = manifestMutationQueues.get(queueKey) ?? Promise.resolve()
  const running = previous.then(async () => {
  const manifest = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
    stages?: Record<string, string>
    notices?: readonly YoutubeUserNotice[]
  } & Record<string, unknown>
  await writeJson(filePath, {
    ...manifest,
    ...(update.status ? { status: update.status } : {}),
    ...(update.analysisMode ? { analysisMode: update.analysisMode } : {}),
    ...(update.cancelledAt ? { cancelledAt: update.cancelledAt } : {}),
    ...update.fields,
    stages: { ...manifest.stages, ...update.stages },
    notices: update.notices
      ? mergeNotices(manifest.notices ?? [], update.notices)
      : manifest.notices ?? [],
    updatedAt: update.updatedAt,
  })
  })
  const settled = running.then(() => undefined, () => undefined)
  manifestMutationQueues.set(queueKey, settled)
  try {
    await running
  } finally {
    if (manifestMutationQueues.get(queueKey) === settled) {
      manifestMutationQueues.delete(queueKey)
    }
  }
}

function manifestNotices(manifest: Record<string, unknown>): YoutubeUserNotice[] {
  return Array.isArray(manifest.notices)
    ? (manifest.notices as YoutubeUserNotice[]).filter((notice) =>
        notice.code === 'media_download_failed' ||
        notice.code === 'media_download_fallback' ||
        notice.code === 'media_tools_unavailable' ||
        notice.code === 'frame_extraction_failed' ||
        notice.code === 'cleanup_warning')
    : []
}

function mergeNotices(
  existing: readonly YoutubeUserNotice[],
  updates: readonly YoutubeUserNotice[],
): YoutubeUserNotice[] {
  const notices = new Map(existing.map((notice) => [notice.code, notice]))
  for (const notice of updates) notices.set(notice.code, notice)
  return [...notices.values()]
}

function abortError(): Error {
  const error = new Error('YouTube manual generation was cancelled.')
  error.name = 'AbortError'
  return error
}

async function readCachedAnalysis(
  filePath: string,
  expected: {
    readonly model: string
    readonly sourceRevisionFingerprint: string
    readonly outputLanguage?: string
  },
) {
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
    const analysis = parseYoutubeVideoAnalysis(JSON.parse(await fs.readFile(filePath, 'utf8')))
    if (
      analysis.model !== expected.model ||
      analysis.sourceRevisionFingerprint !== expected.sourceRevisionFingerprint ||
      analysis.analysisPromptVersion !== YOUTUBE_ANALYSIS_PROMPT_VERSION ||
      expected.outputLanguage !== undefined && analysis.outputLanguage !== expected.outputLanguage
    ) return undefined
    return analysis
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}

function assertMatchingDocumentRequest(manifest: Record<string, unknown>, request: YoutubeDocumentRequest | undefined): void {
  const saved = manifest.documentRequest === undefined ? undefined : youtubeDocumentRequestSchema.parse(manifest.documentRequest)
  if (JSON.stringify(saved) !== JSON.stringify(request)) {
    throw new Error('The document request differs from the saved YouTube run. Start a new run.')
  }
}

function requestedFormats(plan: YoutubeManualPlan): readonly ('markdown' | 'docx')[] {
  return plan.documentRequest?.formats ?? ['markdown', 'docx']
}

function publicationStages(plan: YoutubeManualPlan, state: string): Record<string, string> {
  const formats = requestedFormats(plan)
  return { markdown: formats.includes('markdown') ? state : 'not_requested', docx: formats.includes('docx') ? state : 'not_requested' }
}

const screenshotReviewCacheSchema = z.object({ status: z.literal('pixel_reviewed'), captions: z.array(z.object({ relativePath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), caption: z.string().min(1), altText: z.string().min(1) })) })
