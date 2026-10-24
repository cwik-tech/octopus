import { youtubeDocumentRequestSchema } from '../contracts/youtube-document-request.js'
import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  serialCapabilityEffect,
  type CapabilityEffect,
} from '../contracts/capability-effect.js'
import type { BrowserManager } from '../domains/browser/browser-manager.js'
import type {
  McpBrokerRequestContext,
  McpJsonObject,
  McpNamespacedTool,
} from '../domains/mcp/mcp-runtime.js'
import { isSafePathSegment } from '../core/path-safety.js'
import { publishEngineEvent } from '../domains/runtime/runtime-events.js'
import { buildSessionRunAssignmentLocation } from '../domains/run/run-location.js'
import {
  YOUTUBE_SERVER_ID,
  YOUTUBE_TOOL_NAME,
  YOUTUBE_EXTRACTOR_AGENT_PATH,
  youtubeToolInputSchema,
  type YoutubeAction,
  type YoutubeToolInput,
  type YoutubeToolOutput,
} from '../domains/youtube/youtube-types.js'
import {
  YoutubeExtractionRuntime,
  YoutubeRuntimeError,
  type YoutubeArtifactContext,
} from '../domains/youtube/youtube-extraction.js'
import type { YoutubeSettingsService } from './youtube-settings-service.js'
import type { YoutubeVideoAnalysisPort } from '../domains/youtube/youtube-gemini-analysis.js'
import type { YoutubeManualVideo } from '../domains/youtube/youtube-manual-types.js'
import {
  YoutubeManualCoordinator,
  type YoutubeManualProgressEvent,
} from './youtube-manual-coordinator.js'
import type { YoutubeGeminiUsageLedger } from './youtube-gemini-usage-ledger.js'

export interface YoutubeToolServiceOptions {
  readonly workspacePath: string
  readonly settings: Pick<YoutubeSettingsService, 'runtimeProxy' | 'runtimeGemini' | 'snapshot'>
  readonly browserManager?: Pick<
    BrowserManager,
    'youtubeCookieHeader' | 'captureYoutubeTranscript' | 'captureYoutubeFrames'
  >
  readonly now?: () => Date
  readonly inspectManualVideo?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<YoutubeManualVideo>
  readonly youtubeAnalysis?: YoutubeVideoAnalysisPort
  readonly youtubeUsageLedger?: Pick<
    YoutubeGeminiUsageLedger,
    'rollingUsage' | 'reserve' | 'complete' | 'release'
  >
  readonly youtubeBinaries?: {
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
  /** Checked on first manual use, shared for this service's lifetime. */
  readonly resolveMediaTools?: () => Promise<YoutubeMediaTools>
}

export type YoutubeMediaTools = Pick<
  YoutubeToolServiceOptions, 'youtubeBinaries' | 'binariesUnavailableReason'
>

export type YoutubeCapabilityPolicyDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'require-approval'; readonly reason: string }

export type YoutubeCapabilityAuthorization =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny'
      readonly code: string
      readonly reason: string
      readonly output: YoutubeToolOutput
    }

export type YoutubeCapabilityLifecycleTransition =
  | { readonly kind: 'awaiting-approval' }
  | { readonly kind: 'running' }
  | {
      readonly kind: 'terminal'
      readonly status:
        | 'completed'
        | 'rejected'
        | 'cancelled'
        | 'failed'
        | 'indeterminate'
      readonly code?: string
      readonly detail?: unknown
    }

export interface YoutubePreparedCapability {
  readonly context: McpBrokerRequestContext
  readonly toolCallId: string
  readonly rawInput: McpJsonObject
  readonly input: YoutubeToolInput
  readonly assignmentPath: string
  readonly effect: CapabilityEffect
  readonly risk: 'read-only' | 'mutating' | 'unknown'
  readonly policyDecision: YoutubeCapabilityPolicyDecision
  readonly argumentNames: readonly string[]
  rawOutput?: YoutubeToolOutput
  terminalOutput?: YoutubeToolOutput
}

export type YoutubeCapabilityPreparation =
  | { readonly kind: 'prepared'; readonly capability: YoutubePreparedCapability }
  | {
      readonly kind: 'rejected'
      readonly code: string
      readonly output: YoutubeToolOutput
    }

export class YoutubeToolService {
  readonly tool: McpNamespacedTool = {
    serverId: YOUTUBE_SERVER_ID,
    serverName: 'YouTube Extractor',
    toolName: YOUTUBE_TOOL_NAME,
    namespacedName: YOUTUBE_TOOL_NAME,
    description: [
      'Inspect YouTube videos, playlists, and channels; capture resumable transcripts;',
      'read transcript chunks; and persist agent-generated methodology artifacts.',
      'Use public TypeScript retrieval first. Use capture_authenticated only after capture',
      'reports authenticatedFallbackRequired and only with operator approval. Upcoming premieres',
      'report premierePending and must be retried after availability without authenticated capture.',
    ].join(' '),
    inputSchema: youtubeToolInputSchema(),
    annotations: { openWorldHint: true },
    risk: 'unknown',
    effect: serialCapabilityEffect('unknown'),
    requiresApproval: false,
  }

  private readonly workspacePath: string
  private mediaTools: Promise<YoutubeMediaTools> | undefined

  constructor(private readonly options: YoutubeToolServiceOptions) {
    this.workspacePath = path.resolve(options.workspacePath)
  }

  isEnabledForAgent(agentPath: string): boolean {
    return agentPath === YOUTUBE_EXTRACTOR_AGENT_PATH
  }

  private async resolveMediaTools(signal?: AbortSignal): Promise<YoutubeMediaTools> {
    signal?.throwIfAborted()
    this.mediaTools ??= this.options.resolveMediaTools?.() ?? Promise.resolve(this.options)
    if (!signal) return this.mediaTools
    // A caller may stop waiting, but must not cancel the shared checks needed by
    // another manual request. Each executable probe has its own bounded timeout.
    const pending = this.mediaTools
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException(
        'YouTube media initialization was cancelled.', 'AbortError',
      ))
      signal.addEventListener('abort', onAbort, { once: true })
      // Both outcomes settle the caller and remove its listener.
      void pending.then(
        (tools) => {
          signal.removeEventListener('abort', onAbort)
          resolve(tools)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  async prepareCapability(
    context: McpBrokerRequestContext,
    toolCallId: string,
    rawInput: McpJsonObject,
  ): Promise<YoutubeCapabilityPreparation> {
    let input: YoutubeToolInput
    try {
      input = parseYoutubeToolInput(rawInput)
    } catch (error) {
      return {
        kind: 'rejected',
        code: 'invalid_request',
        output: failure(
          fallbackAction(rawInput.action),
          'invalid_request',
          error instanceof Error ? error.message : 'YouTube extractor input is invalid.',
        ),
      }
    }
    if (!this.isEnabledForAgent(context.agentPath)) {
      return {
        kind: 'rejected',
        code: 'invalid_request',
        output: failure(
          input.action,
          'invalid_request',
          'This agent cannot use the YouTube extractor.',
        ),
      }
    }
    const assignmentPath = await this.resolveAssignmentPath(context)
    if (!assignmentPath) {
      return {
        kind: 'rejected',
        code: 'invalid_request',
        output: failure(
          input.action,
          'invalid_request',
          'YouTube assignment scope is unavailable.',
        ),
      }
    }
    const isReadOnly = input.action === 'inspect' || input.action === 'read_transcript'
    return {
      kind: 'prepared',
      capability: {
        context,
        toolCallId,
        rawInput,
        input,
        assignmentPath,
        effect: serialCapabilityEffect(isReadOnly ? 'read-only' : 'mutating'),
        risk: input.action === 'capture_authenticated'
          ? 'unknown'
          : isReadOnly
            ? 'read-only'
            : 'mutating',
        policyDecision: input.action === 'capture_authenticated'
          ? {
              kind: 'require-approval',
              reason: 'Authenticated YouTube capture requires operator approval.',
            }
          : { kind: 'allow' },
        argumentNames: Object.keys(rawInput).sort(),
      },
    }
  }

  async authorizeCapability(
    capability: YoutubePreparedCapability,
    phase: 'initial' | 'before-execute' | 'after-result',
  ): Promise<YoutubeCapabilityAuthorization> {
    if (phase !== 'before-execute') return { kind: 'allow' }
    const assignmentPath = await this.resolveAssignmentPath(capability.context)
    if (
      this.isEnabledForAgent(capability.context.agentPath) &&
      assignmentPath === capability.assignmentPath
    ) {
      return { kind: 'allow' }
    }
    const output = failure(
      capability.input.action,
      'invalid_request',
      'YouTube assignment scope is unavailable.',
    )
    capability.terminalOutput = output
    return {
      kind: 'deny',
      code: 'invalid_request',
      reason: 'YouTube assignment scope is unavailable.',
      output,
    }
  }

  projectCapabilityLifecycle(
    capability: YoutubePreparedCapability,
    transition: YoutubeCapabilityLifecycleTransition,
  ): { readonly detail?: YoutubeToolOutput } | undefined {
    if (transition.kind !== 'terminal' || transition.status === 'completed') {
      return undefined
    }
    const output = capability.terminalOutput ??
      terminalYoutubeFailure(capability.input.action, transition)
    capability.terminalOutput = output
    return { detail: output }
  }

  async executeCapability(
    capability: YoutubePreparedCapability,
    signal?: AbortSignal,
  ): Promise<YoutubeToolOutput> {
    const { assignmentPath, context, input } = capability
    const runtime = new YoutubeExtractionRuntime({
      assignmentPath,
      settings: this.options.settings,
      ...whenDefined(this.options.browserManager, (definedValue) => ({ browserManager: definedValue })),
      ...whenDefined(this.options.now, (definedValue) => ({ now: definedValue })),
      artifactContext: resolveArtifactContext(context),
    })
    try {
      const needsMediaTools = input.action === 'prepare_manual' ||
        input.action === 'write_manual_plan' || input.action === 'build_manual'
      const mediaTools = needsMediaTools
        ? await this.resolveMediaTools(signal)
        : this.options
      const browserManager = this.options.browserManager
      const manualCoordinator = new YoutubeManualCoordinator({
        assignmentPath,
        settings: this.options.settings,
        ...(this.options.youtubeAnalysis ? { analysis: this.options.youtubeAnalysis } : {}),
        ...(this.options.youtubeUsageLedger ? { usageLedger: this.options.youtubeUsageLedger } : {}),
        ...(browserManager ? { browserFrames: browserManager } : {}),
        // Parent-process-only, like `openAuthenticatedSession`. The header stays
        // inside the media acquisition, which exports it to a private cookie file
        // for yt-dlp and removes that file before returning.
        //
        // `launch: true` lets that read start the managed profile in its
        // configured mode. Refusing the start only looked cheaper: a download
        // that goes out anonymous meets YouTube's bot check, and the screenshot
        // fallback then starts the very same profile seconds later to salvage the
        // build. So the start was never avoided, only deferred past the one call
        // that needed the sign-in. A start that fails, or a profile with no
        // YouTube sign-in, still reads as no sign-in, and the download runs
        // without cookies exactly as it did before.
        //
        // `capture_authenticated` needs operator approval for this same profile;
        // a manual build does not, deliberately. The build already drives the
        // signed-in profile for its screenshot fallback, and the header it
        // exports reaches only the bundled yt-dlp, never the agent. Those two are
        // the profile's only readers — this download and that approved capture,
        // which reaches `youtubeCookieHeader` through the extraction runtime.
        // `prepare_manual`, `capture`, `resume`, `read_transcript` and the
        // methodology actions hold no reader and cannot start the browser.
        ...(browserManager
          ? {
              youtubeCookieHeader: (options) =>
                browserManager.youtubeCookieHeader({ launch: true, ...options }),
            }
          : {}),
        ...(mediaTools.youtubeBinaries ? { binaries: mediaTools.youtubeBinaries } : {}),
        ...(mediaTools.binariesUnavailableReason
          ? { binariesUnavailableReason: mediaTools.binariesUnavailableReason }
          : {}),
        ...whenDefined(this.options.now, (definedValue) => ({ now: definedValue })),
        artifactContext: resolveArtifactContext(context),
        onProgress: (event) => {
          publishYoutubeManualProgressEvent({
            assignmentPath,
            context,
            event,
            occurredAt: (this.options.now ?? (() => new Date()))().toISOString(),
          })
        },
      })
      switch (input.action) {
        case 'inspect': return this.captureCapabilityOutput(
          capability,
          await runtime.inspect(input, signal),
        )
        case 'capture':
        case 'resume': return this.captureCapabilityOutput(
          capability,
          await runtime.capture(input, signal),
        )
        case 'capture_authenticated': return this.captureCapabilityOutput(
          capability,
          await runtime.captureAuthenticated(input, signal),
        )
        case 'read_transcript': return this.captureCapabilityOutput(
          capability,
          await runtime.readTranscript(input),
        )
        case 'write_methodology': return this.captureCapabilityOutput(
          capability,
          await runtime.writeMethodology(input),
        )
        case 'write_consolidation': return this.captureCapabilityOutput(
          capability,
          await runtime.writeConsolidation(input),
        )
        case 'prepare_manual': {
          if (!input.url) throw new YoutubeRuntimeError(
            'invalid_request',
            'YouTube manual preparation requires a video URL.',
          )
          const reusableVideo = input.manualRunId
            ? await manualCoordinator.reusableVideo(input.url, input.manualRunId)
            : undefined
          const video = reusableVideo ?? (this.options.inspectManualVideo
            ? await this.options.inspectManualVideo(input.url, signal)
            : await inspectSingleManualVideo(runtime, input.url, signal))
          const output = await manualCoordinator.prepare({
            video,
            templateId: input.templateId ?? 'step-by-step',
            ...whenDefined(input.documentRequest, (documentRequest) => ({ documentRequest })),
            ...(input.outputLanguage ? { outputLanguage: input.outputLanguage } : {}),
            ...(input.manualRunId ? { manualRunId: input.manualRunId } : {}),
            ...(input.geminiConfirmed !== undefined
              ? { geminiConfirmed: input.geminiConfirmed }
              : {}),
            ...(input.freshAnalysis !== undefined
              ? { freshAnalysis: input.freshAnalysis }
              : {}),
            ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
          })
          publishYoutubeManualFallbackEvent({
            assignmentPath,
            context,
            output,
            occurredAt: (this.options.now ?? (() => new Date()))().toISOString(),
          })
          return this.captureCapabilityOutput(capability, output)
        }
        case 'write_manual_plan': {
          if (!input.videoId || !input.manualRunId || !input.content) {
            throw new YoutubeRuntimeError(
              'invalid_request',
              'Writing a YouTube manual plan requires videoId, manualRunId, and content.',
            )
          }
          return this.captureCapabilityOutput(capability, await manualCoordinator.writeManualPlan({
            videoId: input.videoId,
            manualRunId: input.manualRunId,
            content: input.content,
          }))
        }
        case 'build_manual': {
          if (!input.videoId || !input.manualRunId) {
            throw new YoutubeRuntimeError(
              'invalid_request',
              'Building a YouTube manual requires videoId and manualRunId.',
            )
          }
          return this.captureCapabilityOutput(capability, await manualCoordinator.build({
            videoId: input.videoId,
            manualRunId: input.manualRunId,
            ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
          }))
        }
      }
    } catch (error) {
      if (capability.terminalOutput) throw error
      capability.terminalOutput = signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
        ? failure(input.action, 'cancelled', 'YouTube extraction was cancelled.')
        : error instanceof YoutubeRuntimeError
          ? failure(input.action, error.code, error.message, error.retryable)
          : failure(
              input.action,
              'internal',
              safeRuntimeMessage(input.action, error),
              input.action === 'capture' || input.action === 'resume',
            )
      throw error
    }
  }

  async acceptCapabilityResult(
    capability: YoutubePreparedCapability,
    value: unknown,
  ): Promise<YoutubeToolOutput> {
    if (!capability.rawOutput || value !== capability.rawOutput) {
      capability.terminalOutput = failure(
        capability.input.action,
        'internal',
        'YouTube capability returned an invalid result.',
      )
      throw new Error('YouTube capability result binding is invalid.')
    }
    return capability.rawOutput
  }

  private captureCapabilityOutput(
    capability: YoutubePreparedCapability,
    output: YoutubeToolOutput,
  ): YoutubeToolOutput {
    if (!output.ok) {
      capability.terminalOutput = output
      throw new Error('YouTube capability returned a domain failure.')
    }
    capability.rawOutput = output
    return output
  }

  private async resolveAssignmentPath(
    context: McpBrokerRequestContext,
  ): Promise<string | null> {
    const location = buildSessionRunAssignmentLocation(this.workspacePath, context)
    if (!location) return null
    return canonicalAssignmentDirectory(
      this.workspacePath,
      location.relativeAssignmentPath,
    )
  }
}

function publishYoutubeManualFallbackEvent(input: {
  readonly assignmentPath: string
  readonly context: McpBrokerRequestContext
  readonly output: YoutubeToolOutput
  readonly occurredAt: string
}): void {
  if (input.output.analysisMode !== 'transcript') return
  const notice = input.output.notices?.find((candidate) =>
    candidate.code.startsWith('gemini_'))
  if (!notice) return
  publishEngineEvent(input.assignmentPath, {
    timestamp: input.occurredAt,
    category: 'tool',
    type: 'youtube.manual.analysis_fallback',
    run_id: input.context.assignmentId,
    root_run_id: input.context.runId,
    assignment_path: input.assignmentPath,
    team: 'youtube-extraction',
    level_id: 'extract',
    stage_type: 'chain',
    payload: {
      action: 'prepare_manual',
      error_code: notice.code,
      analysis_mode: 'transcript',
      ...(input.output.manualRunId ? { manual_run_id: input.output.manualRunId } : {}),
      emitter_name: 'youtube-tool-service',
    },
  })
}

function publishYoutubeManualProgressEvent(input: {
  readonly assignmentPath: string
  readonly context: McpBrokerRequestContext
  readonly event: YoutubeManualProgressEvent
  readonly occurredAt: string
}): void {
  publishEngineEvent(input.assignmentPath, {
    timestamp: input.occurredAt,
    category: 'tool',
    type: `youtube.manual.${input.event.type}`,
    run_id: input.context.assignmentId,
    root_run_id: input.context.runId,
    assignment_path: input.assignmentPath,
    team: 'youtube-extraction',
    level_id: 'extract',
    stage_type: 'chain',
    payload: {
      action: 'build_manual',
      ...(input.event.type === 'video_downloaded'
        ? {
            byte_length: input.event.byteLength,
            duration_seconds: input.event.durationSeconds,
            width: input.event.width,
            height: input.event.height,
          }
        : input.event.type === 'key_frames_extracted'
          ? { frame_count: input.event.frameCount }
          : {}),
      emitter_name: 'youtube-tool-service',
    },
  })
}

async function inspectSingleManualVideo(
  runtime: YoutubeExtractionRuntime,
  url: string,
  signal?: AbortSignal,
): Promise<YoutubeManualVideo> {
  const inspected = await runtime.inspect({ action: 'inspect', url, limit: 2 }, signal)
  const video = inspected.videos?.[0]
  if (inspected.source?.type !== 'video' || inspected.videos?.length !== 1 || !video) {
    throw new YoutubeRuntimeError(
      'invalid_request',
      'Manual preparation accepts one video. Inspect a channel or playlist first, then prepare each returned video URL.',
    )
  }
  if (!video.title || !video.durationSeconds) {
    throw new YoutubeRuntimeError('source_unavailable', 'YouTube video metadata is incomplete.', true)
  }
  return {
    videoId: video.videoId,
    url: video.url,
    title: video.title,
    durationSeconds: video.durationSeconds,
    ...(video.channelName ? { channelName: video.channelName } : {}),
    ...(video.publishedAt ? { publishedAt: video.publishedAt } : {}),
  }
}

async function canonicalAssignmentDirectory(
  workspacePath: string,
  relativeAssignmentPath: string,
): Promise<string | null> {
  try {
    if (path.isAbsolute(relativeAssignmentPath) || relativeAssignmentPath.includes('\0')) {
      return null
    }
    const segments = relativeAssignmentPath.split('/')
    if (segments.some((segment) => !isSafePathSegment(segment))) return null
    const root = await fs.realpath(workspacePath)
    const rootStat = await fs.lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null
    let current = root
    for (const segment of segments) {
      current = path.join(current, segment)
      const stat = await fs.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    }
    return current
  } catch {
    return null
  }
}

export function parseYoutubeToolInput(value: unknown): YoutubeToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  const allowed = new Set([
    'action', 'url', 'languages', 'limit', 'all', 'includeShorts',
    'minDurationSeconds', 'videoId', 'chunkIndex', 'content', 'fileName',
    'templateId', 'documentRequest', 'outputLanguage', 'freshAnalysis', 'geminiConfirmed', 'manualRunId',
  ])
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid()
  const action = safeAction(input.action)
  const documentRequest = input.documentRequest === undefined ? undefined : youtubeDocumentRequestSchema.safeParse(input.documentRequest)
  if ((action === 'prepare_manual' && !documentRequest) || (documentRequest && !documentRequest.success)) invalid()
  if (
    input.url !== undefined && typeof input.url !== 'string' ||
    input.languages !== undefined && (
      !Array.isArray(input.languages) ||
      input.languages.length > 10 ||
      input.languages.some((language) => typeof language !== 'string')
    ) ||
    input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 500) ||
    input.all !== undefined && typeof input.all !== 'boolean' ||
    input.includeShorts !== undefined && typeof input.includeShorts !== 'boolean' ||
    input.minDurationSeconds !== undefined && (!Number.isSafeInteger(input.minDurationSeconds) || Number(input.minDurationSeconds) < 0 || Number(input.minDurationSeconds) > 86_400) ||
    input.videoId !== undefined && typeof input.videoId !== 'string' ||
    input.chunkIndex !== undefined && (!Number.isSafeInteger(input.chunkIndex) || Number(input.chunkIndex) < 0) ||
    input.content !== undefined && (typeof input.content !== 'string' || input.content.length > 250_000) ||
    input.fileName !== undefined && (typeof input.fileName !== 'string' || input.fileName.length > 180) ||
    input.templateId !== undefined &&
      input.templateId !== 'quick-guide' &&
      input.templateId !== 'step-by-step' &&
      input.templateId !== 'dense-visual' ||
    input.outputLanguage !== undefined && (
      typeof input.outputLanguage !== 'string' ||
      input.outputLanguage.length > 64 ||
      !isLanguageTag(input.outputLanguage)
    ) ||
    input.freshAnalysis !== undefined && typeof input.freshAnalysis !== 'boolean' ||
    input.geminiConfirmed !== undefined && typeof input.geminiConfirmed !== 'boolean' ||
    input.manualRunId !== undefined && (
      typeof input.manualRunId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.manualRunId)
    )
  ) invalid()
  return {
    action,
    ...(documentRequest?.success ? { documentRequest: documentRequest.data } : {}),
    ...(typeof input.url === 'string' ? { url: input.url } : {}),
    ...(Array.isArray(input.languages) ? { languages: input.languages as string[] } : {}),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    ...(typeof input.all === 'boolean' ? { all: input.all } : {}),
    ...(typeof input.includeShorts === 'boolean' ? { includeShorts: input.includeShorts } : {}),
    ...(typeof input.minDurationSeconds === 'number'
      ? { minDurationSeconds: input.minDurationSeconds }
      : {}),
    ...(typeof input.videoId === 'string' ? { videoId: input.videoId } : {}),
    ...(typeof input.chunkIndex === 'number' ? { chunkIndex: input.chunkIndex } : {}),
    ...(typeof input.content === 'string' ? { content: input.content } : {}),
    ...(typeof input.fileName === 'string' ? { fileName: input.fileName } : {}),
    ...(typeof input.templateId === 'string'
      ? { ...whenDefined(input.templateId as YoutubeToolInput['templateId'], (templateId) => ({ templateId })) }
      : {}),
    ...(typeof input.outputLanguage === 'string' ? { outputLanguage: input.outputLanguage } : {}),
    ...(typeof input.freshAnalysis === 'boolean' ? { freshAnalysis: input.freshAnalysis } : {}),
    ...(typeof input.geminiConfirmed === 'boolean' ? { geminiConfirmed: input.geminiConfirmed } : {}),
    ...(typeof input.manualRunId === 'string' ? { manualRunId: input.manualRunId } : {}),
  }
}

function safeAction(value: unknown): YoutubeAction {
  if (
    value === 'inspect' ||
    value === 'capture' ||
    value === 'resume' ||
    value === 'capture_authenticated' ||
    value === 'read_transcript' ||
    value === 'write_methodology' ||
    value === 'write_consolidation' ||
    value === 'prepare_manual' ||
    value === 'write_manual_plan' ||
    value === 'build_manual'
  ) return value
  throw new Error('YouTube extractor action is invalid.')
}

function fallbackAction(value: unknown): YoutubeAction {
  try {
    return safeAction(value)
  } catch {
    return 'inspect'
  }
}

function invalid(): never {
  throw new Error('YouTube extractor input is invalid.')
}

function isLanguageTag(value: string): boolean {
  try {
    return new Intl.Locale(value).toString().length > 0
  } catch {
    return false
  }
}

function safeRuntimeMessage(action: YoutubeAction, error: unknown): string {
  if (action === 'read_transcript') return 'Transcript artifact is unavailable.'
  if (action === 'write_methodology' || action === 'write_consolidation') {
    return error instanceof Error ? error.message : 'Methodology artifact could not be written.'
  }
  return 'YouTube extraction failed. No credential or cookie details were retained.'
}

function approvalFailure(
  action: YoutubeAction,
  outcome: 'denied' | 'cancelled' | 'expired',
): YoutubeToolOutput {
  return failure(
    action,
    outcome === 'expired' ? 'approval_expired' : 'approval_denied',
    outcome === 'expired'
      ? 'Authenticated YouTube capture approval expired.'
      : 'Authenticated YouTube capture was not approved.',
  )
}

function terminalYoutubeFailure(
  action: YoutubeAction,
  transition: Extract<
    YoutubeCapabilityLifecycleTransition,
    { readonly kind: 'terminal' }
  >,
): YoutubeToolOutput {
  if (transition.status === 'cancelled') {
    if (
      transition.code === 'approval_cancelled' ||
      transition.code === 'approval_interrupted'
    ) {
      return approvalFailure(action, 'cancelled')
    }
    return failure(action, 'cancelled', 'YouTube extraction was cancelled.')
  }
  if (transition.status === 'rejected') {
    if (transition.code === 'approval_expired') {
      return approvalFailure(action, 'expired')
    }
    if (transition.code === 'approval_denied') {
      return approvalFailure(action, 'denied')
    }
  }
  return failure(
    action,
    'internal',
    transition.status === 'indeterminate'
      ? 'YouTube extraction outcome is indeterminate.'
      : 'YouTube extraction failed. No credential or cookie details were retained.',
    action === 'capture' || action === 'resume',
  )
}

function failure(
  action: YoutubeAction,
  code: NonNullable<YoutubeToolOutput['error']>['code'],
  message: string,
  retryable = false,
): YoutubeToolOutput {
  return { ok: false, action, error: { code, message, retryable } }
}

/**
 * Map the MCP broker request context onto the artifact-event provenance the
 * runtime emits for each captured transcript and methodology artifact. The
 * YouTube extractor runs inside a single agent run, so the agent's `runId`
 * is also the root run.
 */
function resolveArtifactContext(
  context: McpBrokerRequestContext,
): YoutubeArtifactContext {
  return {
    sessionId: context.assignmentId,
    rootSessionId: context.runId,
    team: 'youtube-extraction',
    level: 'extract',
    stageType: 'chain',
  }
}
