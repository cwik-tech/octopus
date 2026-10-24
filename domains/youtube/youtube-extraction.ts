import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'

import { Innertube, Log } from 'youtubei.js'

import {
  BrowserRuntimeError,
  type BrowserManager,
  type BrowserYoutubeTranscript,
} from '../browser/browser-manager.js'
import { publishRuntimeArtifactWrittenEvent } from '../runtime/artifacts.js'
import { withFileMutationLock, writeFileAtomic } from '../../core/file-mutation.js'
import { isPathInside, resolveRelativePathInside } from '../../core/path-safety.js'
import type { YoutubeRuntimeProxyConfig } from './youtube-settings.js'
import {
  YOUTUBE_MANIFEST_VERSION,
  type YoutubeCaptureManifest,
  type YoutubeCaptureMethod,
  type YoutubeManifestVideo,
  type YoutubeSourceType,
  type YoutubeToolInput,
  type YoutubeToolOutput,
  type YoutubeTranscriptArtifact,
  type YoutubeTranscriptSegment,
} from './youtube-types.js'
import {
  resolveWebshareProxy,
  type ResolvedWebshareProxy,
} from '../proxy/webshare-proxy.js'
import { createCookieFetch } from './youtube-network.js'
import { isUnknownArray } from '../../core/unknown-array.js'

const DEFAULT_BULK_LIMIT = 10
const MAX_ALL_ITEMS = 10_000
const TRANSCRIPT_CHUNK_CHARS = 20_000
const MANIFEST_RELATIVE_PATH = 'output/youtube-manifest.json'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

Log.setLevel(Log.Level.NONE)

interface ResolvedYoutubeSource {
  readonly type: YoutubeSourceType
  readonly id: string
  readonly url: string
  readonly title?: string
}

interface CandidateVideo {
  readonly videoId: string
  readonly url: string
  readonly title?: string
  readonly durationSeconds?: number
  readonly channelName?: string
  readonly publishedAt?: string
  readonly availableAt?: string
  readonly isShort?: boolean
}

export interface CaptureOptions {
  readonly languages: readonly string[]
  readonly limit: number | 'all'
  readonly includeShorts: boolean
  readonly minDurationSeconds: number
}

interface YoutubeNetworkSession {
  readonly youtube: Innertube
  readonly fetch: typeof globalThis.fetch
  readonly method: YoutubeCaptureMethod
  readonly close: () => Promise<void>
}

interface CaptionTrack {
  readonly base_url: string
  readonly language_code: string
  readonly kind?: 'asr' | 'frc'
  readonly is_translatable: boolean
  readonly name?: { readonly text?: string }
}

export type YoutubeCaptureFailureKind =
  | 'no_transcript'
  | 'premiere_pending'
  | 'auth_required'
  | 'retrieval'

export interface YoutubePlayabilityInput {
  readonly status?: string
  readonly isUpcoming?: boolean
  readonly startTimestamp?: Date | null
}

export type YoutubePlayabilityDisposition =
  | { readonly kind: 'playable' }
  | { readonly kind: 'auth_required' }
  | { readonly kind: 'premiere_pending'; readonly availableAt?: string }

export function classifyYoutubePlayability(
  input: YoutubePlayabilityInput,
): YoutubePlayabilityDisposition {
  if (input.isUpcoming === true) {
    const availableAt = input.startTimestamp instanceof Date &&
      Number.isFinite(input.startTimestamp.getTime())
      ? input.startTimestamp.toISOString()
      : undefined
    return {
      kind: 'premiere_pending',
      ...(availableAt ? { availableAt } : {}),
    }
  }
  return input.status === undefined || input.status === 'OK'
    ? { kind: 'playable' }
    : { kind: 'auth_required' }
}

class YoutubeCaptureError extends Error {
  constructor(
    readonly kind: YoutubeCaptureFailureKind,
    message: string,
    readonly availableAt?: string,
  ) {
    super(message)
    this.name = 'YoutubeCaptureError'
  }
}

export class YoutubeRuntimeError extends Error {
  constructor(
    readonly code: NonNullable<YoutubeToolOutput['error']>['code'],
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'YoutubeRuntimeError'
  }
}

export interface YoutubeRuntimeProxyPort {
  runtimeProxy(): Promise<YoutubeRuntimeProxyConfig>
}

export interface YoutubeExtractionRuntimeOptions {
  readonly assignmentPath: string
  readonly settings: YoutubeRuntimeProxyPort
  readonly browserManager?: Pick<BrowserManager, 'youtubeCookieHeader' | 'captureYoutubeTranscript'>
  readonly now?: () => Date
  readonly requestTimeoutMs?: number
  readonly artifactContext?: YoutubeArtifactContext
}

/**
 * Provenance carried through to `artifact.written` events so per-video
 * transcripts, methodology files, and the consolidated playbook surface in
 * the run delivery alongside the extraction report.
 */
export interface YoutubeArtifactContext {
  readonly sessionId: string
  readonly rootSessionId: string
  readonly parentSessionId?: string
  readonly team?: string
  readonly level?: string
  readonly stageType?: string
}

interface ProxySessionState {
  readonly proxy?: ResolvedWebshareProxy
  readonly session?: YoutubeNetworkSession
}

interface PublicCandidateCaptureOptions {
  readonly direct: YoutubeNetworkSession
  readonly candidate: CandidateVideo
  readonly languages: readonly string[]
  readonly previous?: YoutubeManifestVideo
  readonly proxyState: ProxySessionState
  readonly signal?: AbortSignal
}

interface AuthenticatedCandidateCaptureOptions {
  readonly video: YoutubeManifestVideo
  readonly languages: readonly string[]
  readonly authenticated?: YoutubeNetworkSession
  readonly browserManager: NonNullable<YoutubeExtractionRuntimeOptions['browserManager']>
  readonly signal?: AbortSignal
}

export class YoutubeExtractionRuntime {
  private readonly assignmentPath: string
  private readonly now: () => Date
  private readonly requestTimeoutMs: number
  private manifestArtifactPending = false

  constructor(private readonly options: YoutubeExtractionRuntimeOptions) {
    this.assignmentPath = path.resolve(options.assignmentPath)
    this.now = options.now ?? (() => new Date())
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async inspect(input: YoutubeToolInput, signal?: AbortSignal): Promise<YoutubeToolOutput> {
    const captureOptions = parseCaptureOptions(input)
    const sourceUrl = canonicalYoutubeUrl(requireUrl(input)).toString()
    const session = await createYoutubeSession(
      'direct',
      globalThis.fetch,
      undefined,
      signal,
      this.requestTimeoutMs,
    )
    try {
      const source = await resolveSource(session.youtube, sourceUrl)
      let videos = await enumerateVideos(session.youtube, source, captureOptions, signal)
      if (source.type === 'video' && videos[0]) {
        const info = await session.youtube.getBasicInfo(videos[0].videoId, { client: 'ANDROID' })
        videos = [enrichVideoCandidateFromBasicInfo(videos[0], info)]
      }
      return {
        ok: true,
        action: 'inspect',
        source,
        itemCount: videos.length,
        videos: videos.map(({ videoId, url, title, durationSeconds, channelName, publishedAt }) => ({
          videoId,
          url,
          ...(title ? { title } : {}),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(channelName ? { channelName } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          status: 'pending' as const,
        })),
      }
    } catch (error) {
      if (isCancellation(error, signal)) throw cancelled()
      if (error instanceof YoutubeRuntimeError) throw error
      throw new YoutubeRuntimeError(
        'source_unavailable',
        'The YouTube source could not be inspected.',
        true,
      )
    } finally {
      await session.close()
    }
  }

  async capture(input: YoutubeToolInput, signal?: AbortSignal): Promise<YoutubeToolOutput> {
    return withFileMutationLock(this.containedPath(MANIFEST_RELATIVE_PATH), () =>
      this.captureUnlocked(input, signal))
  }

  private async captureUnlocked(
    input: YoutubeToolInput,
    signal?: AbortSignal,
  ): Promise<YoutubeToolOutput> {
    const requestedOptions = parseCaptureOptions(input)
    const resumeManifest = input.action === 'resume'
      ? await this.readManifest('No resumable YouTube manifest is available.')
      : undefined
    if (resumeManifest && shouldWaitForPremieres(resumeManifest, this.now())) {
      await this.persistPremiereBlockedReport(resumeManifest)
      return captureSummary(input.action, resumeManifest)
    }
    if (resumeManifest?.videos.every((video) => video.status === 'success')) {
      return captureSummary(input.action, resumeManifest)
    }
    const sourceUrl = resumeManifest
      ? undefined
      : canonicalYoutubeUrl(requireUrl(input)).toString()
    const direct = await createYoutubeSession(
      'direct',
      globalThis.fetch,
      undefined,
      signal,
      this.requestTimeoutMs,
    )
    let proxyState: ProxySessionState = {}
    try {
      const captureOptions = resumeManifest?.options ?? requestedOptions
      let source: ResolvedYoutubeSource
      let existing: YoutubeCaptureManifest | undefined
      let candidates: CandidateVideo[]
      try {
        if (resumeManifest) {
          source = resumeManifest.source
        } else if (sourceUrl !== undefined) {
          source = await resolveSource(direct.youtube, sourceUrl)
        } else {
          throw new Error('A new YouTube capture has no source URL to resolve.')
        }
        existing = resumeManifest ??
          await this.readCompatibleManifest(source, captureOptions)
        candidates = existing
          ? existing.videos.map(candidateFromManifest)
          : await enumerateVideos(direct.youtube, source, captureOptions, signal)
      } catch (error) {
        if (isCancellation(error, signal)) throw cancelled()
        if (error instanceof YoutubeRuntimeError) throw error
        throw new YoutubeRuntimeError(
          'source_unavailable',
          'The YouTube source could not be resolved or enumerated.',
          true,
        )
      }
      let manifest = existing ?? newManifest(source, captureOptions, candidates, this.now())
      await this.persistManifest(manifest)

      for (const candidate of candidates) {
        if (signal?.aborted) throw cancelled()
        const previous = manifest.videos.find((video) => video.videoId === candidate.videoId)
        if (previous?.status === 'success' || previous?.status === 'no_transcript') continue
        const captured = await this.capturePublicCandidate({
          direct,
          candidate,
          languages: captureOptions.languages,
          ...whenDefined(previous, (definedValue) => ({ previous: definedValue })),
          proxyState,
          ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
        })
        proxyState = captured.proxyState
        manifest = replaceManifestVideo(manifest, captured.result, this.now())
        await this.persistManifest(manifest)
      }
      if (allVideosAwaitPremiere(manifest)) {
        await this.persistPremiereBlockedReport(manifest)
      }
      return captureSummary(input.action, manifest)
    } finally {
      this.flushManifestArtifact()
      await Promise.allSettled([
        direct.close(),
        proxyState.session?.close() ?? Promise.resolve(),
        proxyState.proxy?.close() ?? Promise.resolve(),
      ])
    }
  }

  private async capturePublicCandidate(
    options: PublicCandidateCaptureOptions,
  ): Promise<{ readonly result: YoutubeManifestVideo; readonly proxyState: ProxySessionState }> {
    let transcript: YoutubeTranscriptArtifact
    try {
      transcript = await captureVideo(
        options.direct,
        options.candidate,
        options.languages,
        this.now(),
        options.signal,
      )
    } catch (error) {
      if (isCancellation(error, options.signal)) throw cancelled()
      const failure = captureFailureKind(error)
      if (failure === 'no_transcript') {
        return {
          result: unavailableTranscript(options.candidate, options.previous),
          proxyState: options.proxyState,
        }
      }
      if (failure === 'premiere_pending') {
        return {
          result: premierePending(
            options.candidate,
            options.previous,
            captureAvailableAt(error),
          ),
          proxyState: options.proxyState,
        }
      }
      return this.captureCandidateWithProxy(options, failure)
    }
    return {
      result: await this.persistTranscript(transcript, options.previous),
      proxyState: options.proxyState,
    }
  }

  private async captureCandidateWithProxy(
    options: PublicCandidateCaptureOptions,
    directFailure: YoutubeCaptureFailureKind | undefined,
  ): Promise<{ readonly result: YoutubeManifestVideo; readonly proxyState: ProxySessionState }> {
    let proxyState = options.proxyState
    let transcript: YoutubeTranscriptArtifact
    try {
      const runtimeProxy = await this.options.settings.runtimeProxy()
      if (!runtimeProxy.proxyEnabled) {
        return {
          result: directWithoutProxyResult(options.candidate, options.previous, directFailure),
          proxyState,
        }
      }
      proxyState = await this.openProxySession(runtimeProxy, proxyState, options.signal)
      if (!proxyState.session) throw new Error('Webshare proxy session did not open.')
      transcript = await captureVideo(
        proxyState.session,
        options.candidate,
        options.languages,
        this.now(),
        options.signal,
      )
    } catch (error) {
      if (isCancellation(error, options.signal)) throw cancelled()
      return {
        result: proxyFailureResult(options.candidate, options.previous, error),
        proxyState,
      }
    }
    return {
      result: await this.persistTranscript(transcript, options.previous),
      proxyState,
    }
  }

  private async openProxySession(
    config: YoutubeRuntimeProxyConfig,
    current: ProxySessionState,
    signal?: AbortSignal,
  ): Promise<ProxySessionState> {
    if (current.session) return current
    const proxy = await resolveWebshareProxy(config, signal)
    if (!proxy) throw new Error('Webshare proxy is unavailable.')
    try {
      const session = await createYoutubeSession(
        'webshare',
        proxy.fetch,
        undefined,
        signal,
        this.requestTimeoutMs,
      )
      return { proxy, session }
    } catch (error) {
      await proxy.close().catch(() => undefined)
      throw error
    }
  }

  async captureAuthenticated(
    _input: YoutubeToolInput,
    signal?: AbortSignal,
  ): Promise<YoutubeToolOutput> {
    if (!this.options.browserManager) {
      return failure('capture_authenticated', 'browser_unavailable', 'Authenticated browser capture is unavailable.')
    }
    const browserManager = this.options.browserManager
    return withFileMutationLock(this.containedPath(MANIFEST_RELATIVE_PATH), () =>
      this.captureAuthenticatedUnlocked(browserManager, signal))
  }

  private async captureAuthenticatedUnlocked(
    browserManager: NonNullable<YoutubeExtractionRuntimeOptions['browserManager']>,
    signal?: AbortSignal,
  ): Promise<YoutubeToolOutput> {
    let manifest = await this.readManifest('Authenticated capture requires an existing YouTube manifest.')
    const authenticated = await this.openAuthenticatedSession(browserManager, signal)
    try {
      for (const video of manifest.videos) {
        if (signal?.aborted) throw cancelled()
        if (video.status !== 'auth_required') continue
        const result = await this.captureAuthenticatedCandidate({
          video,
          languages: manifest.options.languages,
          ...whenDefined(authenticated, (definedValue) => ({ authenticated: definedValue })),
          browserManager,
          ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
        })
        manifest = replaceManifestVideo(manifest, result, this.now())
        await this.persistManifest(manifest)
      }
      return captureSummary('capture_authenticated', manifest)
    } finally {
      this.flushManifestArtifact()
      await authenticated?.close().catch(() => undefined)
    }
  }

  private async openAuthenticatedSession(
    browserManager: NonNullable<YoutubeExtractionRuntimeOptions['browserManager']>,
    signal?: AbortSignal,
  ): Promise<YoutubeNetworkSession | undefined> {
    const cookie = await browserManager.youtubeCookieHeader()
    if (!cookie) return undefined
    try {
      return await createYoutubeSession(
        'authenticated',
        globalThis.fetch,
        cookie,
        signal,
        this.requestTimeoutMs,
      )
    } catch (error) {
      if (isCancellation(error, signal)) throw cancelled()
      return undefined
    }
  }

  private async captureAuthenticatedCandidate(
    options: AuthenticatedCandidateCaptureOptions,
  ): Promise<YoutubeManifestVideo> {
    let transcript = await this.tryAuthenticatedTranscript(options)
    if (!transcript) {
      try {
        transcript = await this.captureBrowserTranscript(options)
      } catch (error) {
        if (isCancellation(error, options.signal)) throw cancelled()
        return browserFailureResult(options.video, error)
      }
    }
    return this.persistTranscript(transcript, options.video)
  }

  private async tryAuthenticatedTranscript(
    options: AuthenticatedCandidateCaptureOptions,
  ): Promise<YoutubeTranscriptArtifact | undefined> {
    if (!options.authenticated) return undefined
    try {
      return await captureVideo(
        options.authenticated,
        candidateFromManifest(options.video),
        options.languages,
        this.now(),
        options.signal,
      )
    } catch (error) {
      if (isCancellation(error, options.signal)) throw cancelled()
      return undefined
    }
  }

  private async captureBrowserTranscript(
    options: AuthenticatedCandidateCaptureOptions,
  ): Promise<YoutubeTranscriptArtifact> {
    const transcript = await options.browserManager.captureYoutubeTranscript(
      options.video.videoId,
      options.signal,
    )
    return browserTranscriptArtifact(options.video, transcript, this.now())
  }

  async readTranscript(input: YoutubeToolInput): Promise<YoutubeToolOutput> {
    const videoId = requireVideoId(input.videoId)
    let text: string
    try {
      const target = await this.existingContainedFile(`output/transcripts/${videoId}.md`)
      text = await fs.readFile(target, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return failure('read_transcript', 'transcript_unavailable', 'Transcript artifact is unavailable.')
      }
      throw error
    }
    const chunks = chunkText(text, TRANSCRIPT_CHUNK_CHARS)
    const chunkIndex = input.chunkIndex ?? 0
    const chunk = chunks[chunkIndex]
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunk === undefined) {
      return failure('read_transcript', 'invalid_request', 'Transcript chunk index is invalid.')
    }
    return {
      ok: true,
      action: 'read_transcript',
      chunk: { videoId, chunkIndex, chunkCount: chunks.length, text: chunk },
    }
  }

  async writeMethodology(input: YoutubeToolInput): Promise<YoutubeToolOutput> {
    const videoId = requireVideoId(input.videoId)
    const content = requireContent(input)
    const relativePath = `output/methods/${videoId}.md`
    await this.writeText(relativePath, content)
    this.emitArtifactWritten(
      relativePath,
      'result',
      'intermediate',
      `Source method: ${videoId}`,
    )
    return { ok: true, action: 'write_methodology', artifactPath: relativePath }
  }

  async writeConsolidation(input: YoutubeToolInput): Promise<YoutubeToolOutput> {
    const content = requireContent(input)
    const baseName = safeMarkdownName(input.fileName ?? 'generalized-methodology.md')
    const relativePath = `output/generalized-methodology/${baseName}`
    await this.writeText(relativePath, content)
    this.emitArtifactWritten(
      relativePath,
      'report',
      'final',
      'Consolidated methodology playbook',
    )
    return { ok: true, action: 'write_consolidation', artifactPath: relativePath }
  }

  private async persistTranscript(
    transcript: YoutubeTranscriptArtifact,
    previous?: YoutubeManifestVideo,
  ): Promise<YoutubeManifestVideo> {
    const jsonPath = `output/transcripts/${transcript.videoId}.json`
    const markdownPath = `output/transcripts/${transcript.videoId}.md`
    await this.writeText(jsonPath, `${JSON.stringify(transcript, null, 2)}\n`)
    await this.writeText(markdownPath, transcriptMarkdown(transcript))
    this.emitArtifactWritten(
      markdownPath,
      'result',
      'intermediate',
      `Transcript: ${transcript.title}`,
    )
    return {
      videoId: transcript.videoId,
      url: transcript.url,
      title: transcript.title,
      ...(transcript.durationSeconds !== undefined
        ? { durationSeconds: transcript.durationSeconds }
        : {}),
      status: 'success',
      attempts: (previous?.attempts ?? 0) + 1,
      captureMethod: transcript.captureMethod,
      transcriptJson: jsonPath,
      transcriptMarkdown: markdownPath,
      language: transcript.language,
    }
  }

  private async readCompatibleManifest(
    source: ResolvedYoutubeSource,
    options: CaptureOptions,
  ): Promise<YoutubeCaptureManifest | undefined> {
    try {
      const manifest = await this.readManifest()
      return manifest.source.id === source.id &&
        manifest.source.type === source.type &&
        JSON.stringify(manifest.options) === JSON.stringify(options)
        ? manifest
        : undefined
    } catch (error) {
      if (error instanceof YoutubeRuntimeError) throw error
      return undefined
    }
  }

  private async readManifest(missingMessage?: string): Promise<YoutubeCaptureManifest> {
    try {
      const target = await this.existingContainedFile(MANIFEST_RELATIVE_PATH)
      let parsed: unknown
      try {
        parsed = JSON.parse(await fs.readFile(target, 'utf8'))
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new YoutubeRuntimeError('invalid_request', 'YouTube manifest is invalid.')
        }
        throw error
      }
      return parseManifest(parsed)
    } catch (error) {
      if (missingMessage && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new YoutubeRuntimeError('invalid_request', missingMessage)
      }
      throw error
    }
  }

  /**
   * Commit the manifest without announcing it. The manifest is rewritten after
   * every candidate so an interrupted capture stays resumable; announcing each
   * revision would claim the same file was produced once per video.
   */
  private async persistManifest(manifest: YoutubeCaptureManifest): Promise<void> {
    await this.writeText(MANIFEST_RELATIVE_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
    this.manifestArtifactPending = true
  }

  /**
   * Announce the manifest once per capture action, after the last revision is
   * on disk. Runs from a `finally` so an interrupted capture still reports the
   * partial manifest it left behind.
   */
  private flushManifestArtifact(): void {
    if (!this.manifestArtifactPending) return
    this.manifestArtifactPending = false
    this.emitArtifactWritten(
      MANIFEST_RELATIVE_PATH,
      'result',
      'intermediate',
      'YouTube capture manifest',
    )
  }

  private async writeText(relativePath: string, content: string): Promise<void> {
    const target = await this.prepareContainedFile(relativePath)
    await writeFileAtomic(target, content)
  }

  private async persistPremiereBlockedReport(manifest: YoutubeCaptureManifest): Promise<void> {
    const relativePath = 'extraction-report.md'
    await this.writeText(relativePath, premiereBlockedReport(manifest))
    this.emitArtifactWritten(
      relativePath,
      'report',
      'final',
      'YouTube premiere availability',
    )
  }

  /**
   * Publish an `artifact.written` event for a runtime-owned YouTube artifact
   * so the file appears in the run delivery. Silent when no artifact context
   * was supplied (e.g. ad-hoc service tests). Rethrows wrapped errors so
   * callers never replace a successful write with an event-publishing failure.
   */
  private emitArtifactWritten(
    relativePath: string,
    artifactType: string,
    artifactRole: 'input' | 'intermediate' | 'final' | 'wrapper',
    title?: string,
  ): void {
    const context = this.options.artifactContext
    if (!context) return
    try {
      const outputDir = fsSync.realpathSync(this.assignmentPath)
      publishRuntimeArtifactWrittenEvent({
        outputDir,
        relativePath,
        artifactType,
        artifactRole,
        createdAt: this.now().toISOString(),
        sessionId: context.sessionId,
        rootSessionId: context.rootSessionId,
        ...whenDefined(context.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
        ...whenDefined(context.team, (definedValue) => ({ team: definedValue })),
        ...whenDefined(context.level, (definedValue) => ({ level: definedValue })),
        ...whenDefined(context.stageType, (definedValue) => ({ stageType: definedValue })),
        ...whenDefined(title, (definedValue) => ({ title: definedValue })),
      })
    } catch (error) {
      // The artifact file is already committed and the run's own event log
      // remains the source of truth — but an unannounced artifact is invisible
      // in the run view, so the reason has to reach the log.
      console.warn(
        `[youtube-extraction] artifact '${relativePath}' was not announced:`,
        error,
      )
    }
  }

  private containedPath(relativePath: string): string {
    const target = resolveRelativePathInside(this.assignmentPath, relativePath)
    if (!target) throw artifactPathError()
    return target
  }

  private async existingContainedFile(relativePath: string): Promise<string> {
    this.containedPath(relativePath)
    const root = await this.secureAssignmentRoot()
    const segments = relativePath.split('/')
    let current = root
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment)
      const stat = await fs.lstat(current)
      const final = index === segments.length - 1
      if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) {
        throw artifactPathError()
      }
      const realCurrent = await fs.realpath(current)
      if (!isPathInside(root, realCurrent)) throw artifactPathError()
    }
    return current
  }

  private async prepareContainedFile(relativePath: string): Promise<string> {
    this.containedPath(relativePath)
    const root = await this.secureAssignmentRoot()
    const segments = relativePath.split('/')
    const fileName = segments.pop()
    if (!fileName) throw artifactPathError()
    let current = root
    for (const segment of segments) {
      current = path.join(current, segment)
      await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      const stat = await fs.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw artifactPathError()
      const realCurrent = await fs.realpath(current)
      if (!isPathInside(root, realCurrent)) throw artifactPathError()
    }
    const target = path.join(current, fileName)
    try {
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink()) throw artifactPathError()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return target
  }

  private async secureAssignmentRoot(): Promise<string> {
    const stat = await fs.lstat(this.assignmentPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw artifactPathError()
    return fs.realpath(this.assignmentPath)
  }
}

async function createYoutubeSession(
  method: YoutubeCaptureMethod,
  sourceFetch: typeof globalThis.fetch = globalThis.fetch,
  cookie?: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<YoutubeNetworkSession> {
  const scopedFetch = createCookieFetch(
    createDeadlineFetch(sourceFetch, signal, timeoutMs),
    cookie,
  )
  try {
    const youtube = await Innertube.create({
      retrieve_player: false,
      enable_session_cache: false,
      generate_session_locally: true,
      fetch: scopedFetch,
      ...(cookie ? { cookie } : {}),
    })
    return { youtube, fetch: scopedFetch, method, close: async () => undefined }
  } catch (error) {
    if (isCancellation(error, signal)) throw cancelled()
    throw new YoutubeRuntimeError(
      method === 'webshare' ? 'proxy_unavailable' : 'source_unavailable',
      method === 'webshare'
        ? 'Webshare could not establish a YouTube session.'
        : 'YouTube could not establish a network session.',
      true,
    )
  }
}

export function createDeadlineFetch(
  baseFetch: typeof globalThis.fetch,
  operationSignal?: AbortSignal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): typeof globalThis.fetch {
  return async (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (operationSignal) signals.push(operationSignal)
    if (init?.signal) signals.push(init.signal)
    if (input instanceof Request) signals.push(input.signal)
    return baseFetch(input, {
      ...init,
      signal: AbortSignal.any(signals),
    })
  }
}

async function resolveSource(youtube: Innertube, rawUrl: string): Promise<ResolvedYoutubeSource> {
  const url = canonicalYoutubeUrl(rawUrl)
  const endpoint = await youtube.resolveURL(url.toString())
  const payload = endpoint.payload as Record<string, unknown>
  const pageType = endpoint.metadata.page_type
  if (typeof payload.videoId === 'string') {
    return { type: 'video', id: requireVideoId(payload.videoId), url: url.toString() }
  }
  const browseId = typeof payload.browseId === 'string' ? payload.browseId : ''
  if (pageType === 'WEB_PAGE_TYPE_PLAYLIST' || browseId.startsWith('VL')) {
    const id = browseId.startsWith('VL') ? browseId.slice(2) : url.searchParams.get('list') ?? ''
    if (!id) {
      throw new YoutubeRuntimeError('invalid_request', 'YouTube playlist ID is unavailable.')
    }
    return { type: 'playlist', id, url: url.toString() }
  }
  if (pageType === 'WEB_PAGE_TYPE_CHANNEL' && browseId) {
    return { type: 'channel', id: browseId, url: url.toString() }
  }
  throw new YoutubeRuntimeError(
    'invalid_request',
    'Only YouTube videos, playlists, and channels are supported.',
  )
}

async function enumerateVideos(
  youtube: Innertube,
  source: ResolvedYoutubeSource,
  options: CaptureOptions,
  signal?: AbortSignal,
): Promise<CandidateVideo[]> {
  if (source.type === 'video') {
    return [{ videoId: requireVideoId(source.id), url: canonicalVideoUrl(source.id) }]
  }
  const wanted = options.limit === 'all' ? MAX_ALL_ITEMS : options.limit
  const videos: CandidateVideo[] = []
  const seen = new Set<string>()
  const append = (nodes: readonly unknown[]) => {
    for (const node of nodes) {
      const video = candidateFromNode(node)
      if (!video || seen.has(video.videoId)) continue
      if (!options.includeShorts && video.isShort) continue
      if (video.durationSeconds !== undefined && video.durationSeconds < options.minDurationSeconds) continue
      seen.add(video.videoId)
      videos.push(video)
      if (videos.length >= wanted) break
    }
  }
  if (source.type === 'playlist') {
    let feed = await youtube.getPlaylist(source.id)
    while (videos.length < wanted) {
      if (signal?.aborted) throw cancelled()
      append(feed.items)
      if (videos.length >= wanted || !feed.has_continuation) break
      feed = await feed.getContinuation()
    }
    return videos
  }
  const channel = await youtube.getChannel(source.id)
  let feed = await channel.getVideos()
  while (videos.length < wanted) {
    if (signal?.aborted) throw cancelled()
    append(feed.videos)
    if (videos.length >= wanted || !feed.has_continuation) break
    feed = await feed.getContinuation() as typeof feed
  }
  if (options.includeShorts && videos.length < wanted && channel.has_shorts) {
    let shorts = await channel.getShorts()
    while (videos.length < wanted) {
      append(shorts.videos)
      if (videos.length >= wanted || !shorts.has_continuation) break
      shorts = await shorts.getContinuation() as typeof shorts
    }
  }
  return videos
}

async function captureVideo(
  session: YoutubeNetworkSession,
  candidate: CandidateVideo,
  languages: readonly string[],
  now: Date,
  signal?: AbortSignal,
): Promise<YoutubeTranscriptArtifact> {
  let info: Awaited<ReturnType<Innertube['getBasicInfo']>>
  try {
    info = await session.youtube.getBasicInfo(candidate.videoId, { client: 'ANDROID' })
  } catch (error) {
    if (isCancellation(error, signal)) throw cancelled()
    throw new YoutubeCaptureError('retrieval', 'YouTube video information could not be retrieved.')
  }
  const basic = info.basic_info
  const disposition = classifyYoutubePlayability({
    ...whenDefined(info.playability_status?.status, (definedValue) => ({ status: definedValue })),
    ...whenDefined(basic.is_upcoming, (definedValue) => ({ isUpcoming: definedValue })),
    startTimestamp: basic.start_timestamp,
  })
  if (disposition.kind === 'premiere_pending') {
    throw new YoutubeCaptureError(
      'premiere_pending',
      'This premiere is scheduled but not yet available.',
      disposition.availableAt,
    )
  }
  if (disposition.kind === 'auth_required') {
    throw new YoutubeCaptureError('auth_required', 'Video is not publicly playable.')
  }
  const tracks = (info.captions?.caption_tracks ?? []) as CaptionTrack[]
  const track = selectCaptionTrack(tracks, languages)
  if (!track) throw new YoutubeCaptureError('no_transcript', 'Transcript is unavailable.')
  const captionUrl = new URL(track.base_url)
  captionUrl.searchParams.set('fmt', 'json3')
  let response: Response
  try {
    response = await session.fetch(captionUrl, { redirect: 'error', ...whenDefined(signal, (definedValue) => ({ signal: definedValue })) })
  } catch (error) {
    if (isCancellation(error, signal)) throw cancelled()
    throw new YoutubeCaptureError('retrieval', 'Transcript request failed.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new YoutubeCaptureError('retrieval', 'Transcript request failed.')
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    if (isCancellation(error, signal)) throw cancelled()
    throw new YoutubeCaptureError('retrieval', 'Transcript response was invalid.')
  }
  const segments = parseJson3Transcript(payload)
  if (segments.length === 0) {
    throw new YoutubeCaptureError('no_transcript', 'Transcript is empty.')
  }
  const publishedAt = await resolvePublishedAt(session, info.page, candidate.videoId, signal)
  const channelName = basic.channel?.name || basic.author
  return {
    schemaVersion: YOUTUBE_MANIFEST_VERSION,
    videoId: candidate.videoId,
    url: canonicalVideoUrl(candidate.videoId),
    title: basic.title?.trim() || candidate.title || candidate.videoId,
    ...(basic.channel_id ? { channelId: basic.channel_id } : {}),
    ...whenDefined(channelName, (presentChannelName) => ({
      channelName: presentChannelName,
    })),
    ...(basic.duration !== undefined ? { durationSeconds: basic.duration } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    language: track.language_code,
    ...(track.name?.text ? { languageName: track.name.text } : {}),
    generated: track.kind === 'asr',
    captureMethod: session.method,
    capturedAt: now.toISOString(),
    segments,
  }
}

async function resolvePublishedAt(
  session: YoutubeNetworkSession,
  pages: readonly unknown[],
  videoId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const initial = publishedAtFromPages(pages)
  if (initial) return initial
  try {
    const metadata = await session.youtube.getBasicInfo(videoId, { client: 'WEB' })
    return publishedAtFromPages(metadata.page)
  } catch (error) {
    if (isCancellation(error, signal)) throw cancelled()
    return undefined
  }
}

export function publishedAtFromPages(pages: readonly unknown[]): string | undefined {
  for (const page of pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) continue
    const microformat = (page as Record<string, unknown>).microformat
    if (!microformat || typeof microformat !== 'object' || Array.isArray(microformat)) continue
    const record = microformat as Record<string, unknown>
    const publishedAt = stringValue(record.publish_date) || stringValue(record.upload_date)
    if (publishedAt) return publishedAt
  }
  return undefined
}

export function selectCaptionTrack(
  tracks: readonly CaptionTrack[],
  languages: readonly string[],
): CaptionTrack | undefined {
  const ranked = [...tracks].sort(
    (left, right) => Number(left.kind === 'asr') - Number(right.kind === 'asr'),
  )
  for (const wanted of [...languages, 'en']) {
    const normalized = wanted.toLowerCase()
    const matching = ranked.filter((track) => {
      const language = track.language_code.toLowerCase()
      return language === normalized ||
        language.split('-')[0] === normalized.split('-')[0]
    })
    if (matching.length > 0) return matching[0]
  }
  return ranked[0]
}

export function parseJson3Transcript(value: unknown): YoutubeTranscriptSegment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const events = (value as { events?: unknown }).events
  if (!Array.isArray(events)) return []
  const segments: YoutubeTranscriptSegment[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const record = event as Record<string, unknown>
    const pieces = isUnknownArray(record.segs) ? record.segs : []
    const text = pieces.map((piece) => {
      if (!piece || typeof piece !== 'object' || Array.isArray(piece)) return ''
      return typeof (piece as Record<string, unknown>).utf8 === 'string'
        ? String((piece as Record<string, unknown>).utf8)
        : ''
    }).join('').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const startMs = Number(record.tStartMs)
    const durationMs = Number(record.dDurationMs)
    if (!Number.isFinite(startMs) || startMs < 0) continue
    segments.push({
      startMs: Math.round(startMs),
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0,
      text,
    })
  }
  return segments
}

function candidateFromNode(value: unknown): CandidateVideo | undefined {
  if (!isRecord(value)) return undefined
  const node = value
  const videoId = stringValue(node.content_id) || stringValue(node.video_id) || stringValue(node.id) ||
    stringValue(readNestedValue(node, 'endpoint', 'payload', 'videoId')) ||
    stringValue(readNestedValue(node, 'renderer_context', 'command_context', 'on_tap', 'payload', 'videoId'))
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return undefined
  const title = textValue(readNestedValue(node, 'metadata', 'title')) || textValue(node.title)
  const durationSeconds = numberValue(readNestedValue(node, 'duration', 'seconds')) ?? durationFromAccessibility(
    stringValue(readNestedValue(node, 'renderer_context', 'accessibility_context', 'label')),
  )
  const contentType = stringValue(node.content_type)
  return {
    videoId,
    url: canonicalVideoUrl(videoId),
    ...(title ? { title } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(contentType ? { isShort: contentType === 'SHORT' } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readNestedValue(record: Record<string, unknown>, ...keys: readonly string[]): unknown {
  let value: unknown = record
  for (const key of keys) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return value
}

function newManifest(
  source: ResolvedYoutubeSource,
  options: CaptureOptions,
  videos: readonly CandidateVideo[],
  now: Date,
): YoutubeCaptureManifest {
  const timestamp = now.toISOString()
  return {
    schemaVersion: YOUTUBE_MANIFEST_VERSION,
    source,
    options,
    startedAt: timestamp,
    updatedAt: timestamp,
    videos: videos.map((video) => ({ ...video, status: 'pending', attempts: 0 })),
  }
}

export function replaceManifestVideo(
  manifest: YoutubeCaptureManifest,
  replacement: YoutubeManifestVideo,
  now: Date,
): YoutubeCaptureManifest {
  return {
    ...manifest,
    source: manifest.source.type === 'video' &&
      manifest.source.id === replacement.videoId &&
      replacement.title
      ? { ...manifest.source, title: replacement.title }
      : manifest.source,
    updatedAt: now.toISOString(),
    videos: manifest.videos.map((video) =>
      video.videoId === replacement.videoId ? replacement : video),
  }
}

function captureSummary(
  action: YoutubeToolInput['action'],
  manifest: YoutubeCaptureManifest,
): YoutubeToolOutput {
  const completed = manifest.videos.filter((video) => video.status === 'success').length
  const authenticatedFallbackRequired = manifest.videos.filter((video) => video.status === 'auth_required').length
  const premierePendingCount = manifest.videos.filter((video) => video.status === 'premiere_pending').length
  const failed = manifest.videos.filter((video) => video.status === 'failed').length
  const unavailable = manifest.videos.filter((video) => video.status === 'no_transcript').length
  const pending = manifest.videos.filter((video) => video.status === 'pending').length
  const premiereError: YoutubeToolOutput['error'] =
    premierePendingCount === manifest.videos.length && premierePendingCount > 0
      ? {
          code: 'premiere_pending',
          message: 'Every selected video is an upcoming premiere. Run the workflow again after availability.',
          retryable: true,
        }
      : undefined
  return {
    ok: completed > 0 || manifest.videos.length === 0,
    action,
    source: manifest.source,
    manifestPath: MANIFEST_RELATIVE_PATH,
    itemCount: manifest.videos.length,
    completed,
    failed,
    unavailable,
    pending,
    authenticatedFallbackRequired,
    premierePending: premierePendingCount,
    videos: manifest.videos.map(({
      videoId,
      url,
      title,
      durationSeconds,
      channelName,
      publishedAt,
      availableAt,
      status,
      captureMethod,
      transcriptJson,
      transcriptMarkdown,
      language,
    }) => ({
      videoId,
      url,
      ...whenDefined(title, (presentTitle) => ({ title: presentTitle })),
      ...whenDefined(durationSeconds, (presentDurationSeconds) => ({ durationSeconds: presentDurationSeconds })),
      ...whenDefined(channelName, (presentChannelName) => ({ channelName: presentChannelName })),
      ...whenDefined(publishedAt, (presentPublishedAt) => ({ publishedAt: presentPublishedAt })),
      ...whenDefined(availableAt, (presentAvailableAt) => ({ availableAt: presentAvailableAt })),
      status,
      ...whenDefined(captureMethod, (presentCaptureMethod) => ({ captureMethod: presentCaptureMethod })),
      ...whenDefined(transcriptJson, (presentTranscriptJson) => ({ transcriptJson: presentTranscriptJson })),
      ...whenDefined(transcriptMarkdown, (presentTranscriptMarkdown) => ({ transcriptMarkdown: presentTranscriptMarkdown })),
      ...whenDefined(language, (presentLanguage) => ({ language: presentLanguage })),
    })),
    ...(premiereError ? { error: premiereError } : {}),
  }
}

function transcriptMarkdown(transcript: YoutubeTranscriptArtifact): string {
  const lines = [
    `# ${transcript.title}`,
    '',
    `- Video: ${transcript.url}`,
    `- Video ID: ${transcript.videoId}`,
    ...(transcript.channelName ? [`- Channel: ${transcript.channelName}`] : []),
    `- Language: ${transcript.languageName ?? transcript.language}`,
    `- Generated captions: ${transcript.generated ? 'yes' : 'no'}`,
    `- Capture method: ${transcript.captureMethod}`,
    `- Captured: ${transcript.capturedAt}`,
    '',
    '## Transcript',
    '',
  ]
  for (const segment of transcript.segments) {
    const seconds = Math.floor(segment.startMs / 1_000)
    lines.push(`[${formatTimestamp(segment.startMs)}](${transcript.url}&t=${seconds}s) ${segment.text}`, '')
  }
  return `${lines.join('\n').trim()}\n`
}

export function parseCaptureOptions(input: YoutubeToolInput): CaptureOptions {
  const languages = [...new Set((input.languages ?? ['en']).map((value) => value.trim()).filter(Boolean))]
  if (languages.length === 0 || languages.length > 10) {
    throw new YoutubeRuntimeError('invalid_request', 'One to ten transcript languages are required.')
  }
  if (languages.some((language) => !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language))) {
    throw new YoutubeRuntimeError('invalid_request', 'Transcript language codes are invalid.')
  }
  const limit = input.all === true ? 'all' : input.limit ?? DEFAULT_BULK_LIMIT
  if (limit !== 'all' && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
    throw new YoutubeRuntimeError('invalid_request', 'YouTube item limit must be between 1 and 500.')
  }
  const minDurationSeconds = input.minDurationSeconds ?? 0
  if (!Number.isSafeInteger(minDurationSeconds) || minDurationSeconds < 0 || minDurationSeconds > 86_400) {
    throw new YoutubeRuntimeError('invalid_request', 'Minimum duration must be between 0 and 86400 seconds.')
  }
  return {
    languages,
    limit,
    includeShorts: input.includeShorts === true,
    minDurationSeconds,
  }
}

function parseManifest(value: unknown): YoutubeCaptureManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new YoutubeRuntimeError('invalid_request', 'YouTube manifest is invalid.')
  }
  const manifest = value as YoutubeCaptureManifest
  if (
    manifest.schemaVersion !== YOUTUBE_MANIFEST_VERSION ||
    !manifest.source ||
    !['video', 'playlist', 'channel'].includes(manifest.source.type) ||
    !manifest.options ||
    !isUnknownArray(manifest.options.languages) ||
    !isUnknownArray(manifest.videos) ||
    manifest.videos.some((video) =>
      !/^[A-Za-z0-9_-]{11}$/.test(video.videoId) ||
      !['pending', 'success', 'premiere_pending', 'auth_required', 'no_transcript', 'failed'].includes(video.status) ||
      (video.availableAt !== undefined && !isIsoTimestamp(video.availableAt)) ||
      !Number.isSafeInteger(video.attempts) ||
      video.attempts < 0)
  ) throw new YoutubeRuntimeError('invalid_request', 'YouTube manifest is invalid.')
  return manifest
}

export function canonicalYoutubeUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new YoutubeRuntimeError('invalid_request', 'YouTube URL is invalid.')
  }
  const host = url.hostname.toLowerCase()
  if (![
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
  ].includes(host)) {
    throw new YoutubeRuntimeError('invalid_request', 'Only YouTube URLs are supported.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new YoutubeRuntimeError('invalid_request', 'YouTube URL protocol is invalid.')
  }
  url.protocol = 'https:'
  url.username = ''
  url.password = ''
  url.hash = ''
  return url
}

function canonicalVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

export function enrichVideoCandidateFromBasicInfo(
  candidate: CandidateVideo,
  info: {
    readonly basic_info?: {
      readonly title?: string | undefined
      readonly author?: string | undefined
      readonly channel?: { readonly name?: string | undefined } | null | undefined
      readonly duration?: number | undefined
    }
    readonly page?: readonly unknown[] | undefined
  },
): CandidateVideo {
  const basic = info.basic_info
  const title = basic?.title?.trim() || candidate.title
  const channelName = basic?.channel?.name?.trim() || basic?.author?.trim()
  const publishedAt = publishedAtFromPages(info.page ?? [])
  return {
    ...candidate,
    ...(title ? { title } : {}),
    ...(channelName ? { channelName } : {}),
    ...(basic?.duration !== undefined ? { durationSeconds: basic.duration } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  }
}

function candidateFromManifest(video: YoutubeManifestVideo): CandidateVideo {
  return {
    videoId: video.videoId,
    url: video.url,
    ...(video.title ? { title: video.title } : {}),
    ...(video.durationSeconds !== undefined ? { durationSeconds: video.durationSeconds } : {}),
    ...(video.channelName ? { channelName: video.channelName } : {}),
    ...(video.publishedAt ? { publishedAt: video.publishedAt } : {}),
    ...(video.availableAt ? { availableAt: video.availableAt } : {}),
  }
}

function captureAvailableAt(error: unknown): string | undefined {
  return error instanceof YoutubeCaptureError ? error.availableAt : undefined
}

function captureFailureKind(error: unknown): YoutubeCaptureFailureKind | undefined {
  return error instanceof YoutubeCaptureError ? error.kind : undefined
}

export function proxyFallbackDisposition(
  failure: YoutubeCaptureFailureKind | undefined,
): 'no_transcript' | 'premiere_pending' | 'auth_required' | 'proxy_failed' {
  if (failure === 'no_transcript') return 'no_transcript'
  if (failure === 'premiere_pending') return 'premiere_pending'
  if (failure === 'auth_required') return 'auth_required'
  return 'proxy_failed'
}

function directWithoutProxyResult(
  candidate: CandidateVideo,
  previous: YoutubeManifestVideo | undefined,
  failure: YoutubeCaptureFailureKind | undefined,
): YoutubeManifestVideo {
  return failure === 'auth_required'
    ? authenticationRequired(candidate, previous)
    : failedCapture(
        candidate,
        previous,
        'source_unavailable',
        'Public transcript retrieval failed and no proxy fallback is configured.',
        true,
      )
}

function proxyFailureResult(
  candidate: CandidateVideo,
  previous: YoutubeManifestVideo | undefined,
  error: unknown,
): YoutubeManifestVideo {
  const disposition = proxyFallbackDisposition(captureFailureKind(error))
  if (disposition === 'no_transcript') return unavailableTranscript(candidate, previous)
  if (disposition === 'premiere_pending') {
    return premierePending(candidate, previous, captureAvailableAt(error))
  }
  if (disposition === 'auth_required') return authenticationRequired(candidate, previous)
  return failedCapture(
    candidate,
    previous,
    'proxy_unavailable',
    'Webshare fallback failed. Check the proxy configuration or retry later.',
    true,
  )
}

export function browserFallbackDisposition(
  error: unknown,
): 'no_transcript' | 'browser_failed' {
  return error instanceof BrowserRuntimeError && error.code === 'empty_content'
    ? 'no_transcript'
    : 'browser_failed'
}

function browserFailureResult(
  video: YoutubeManifestVideo,
  error: unknown,
): YoutubeManifestVideo {
  const candidate = candidateFromManifest(video)
  if (browserFallbackDisposition(error) === 'no_transcript') {
    return unavailableTranscript(candidate, video)
  }
  return failedCapture(
    candidate,
    video,
    error instanceof BrowserRuntimeError ? error.code : 'browser_unavailable',
    error instanceof BrowserRuntimeError
      ? error.message
      : 'Authenticated browser capture failed before transcript availability was known.',
    error instanceof BrowserRuntimeError ? error.retryable : true,
  )
}

function browserTranscriptArtifact(
  video: YoutubeManifestVideo,
  transcript: BrowserYoutubeTranscript,
  now: Date,
): YoutubeTranscriptArtifact {
  return {
    schemaVersion: YOUTUBE_MANIFEST_VERSION,
    videoId: video.videoId,
    url: video.url,
    title: transcript.title || video.title || video.videoId,
    ...(transcript.channelName ? { channelName: transcript.channelName } : {}),
    ...(transcript.durationSeconds !== undefined
      ? { durationSeconds: transcript.durationSeconds }
      : {}),
    language: transcript.language,
    generated: false,
    captureMethod: 'browser',
    capturedAt: now.toISOString(),
    segments: transcript.segments,
  }
}

function unavailableTranscript(
  candidate: CandidateVideo,
  previous?: YoutubeManifestVideo,
): YoutubeManifestVideo {
  return {
    ...candidate,
    status: 'no_transcript',
    attempts: (previous?.attempts ?? 0) + 1,
    error: {
      code: 'transcript_unavailable',
      message: 'YouTube does not expose captions for this video.',
      retryable: false,
    },
  }
}

function authenticationRequired(
  candidate: CandidateVideo,
  previous?: YoutubeManifestVideo,
): YoutubeManifestVideo {
  return {
    ...candidate,
    status: 'auth_required',
    attempts: (previous?.attempts ?? 0) + 1,
    error: {
      code: 'authentication_required',
      message: 'Public transcript retrieval failed; authenticated capture is available.',
      retryable: false,
    },
  }
}

function premierePending(
  candidate: CandidateVideo,
  previous: YoutubeManifestVideo | undefined,
  availableAt: string | undefined,
): YoutubeManifestVideo {
  return {
    ...candidate,
    ...(availableAt ? { availableAt } : {}),
    status: 'premiere_pending',
    attempts: (previous?.attempts ?? 0) + 1,
    error: {
      code: 'premiere_pending',
      message: 'This premiere is scheduled but not yet available.',
      retryable: true,
    },
  }
}

function allVideosAwaitPremiere(manifest: YoutubeCaptureManifest): boolean {
  return manifest.videos.length > 0 &&
    manifest.videos.every((video) => video.status === 'premiere_pending')
}

export function shouldWaitForPremieres(
  manifest: YoutubeCaptureManifest,
  now: Date,
): boolean {
  return allVideosAwaitPremiere(manifest) && manifest.videos.every((video) =>
    video.availableAt !== undefined && Date.parse(video.availableAt) > now.getTime())
}

function premiereBlockedReport(manifest: YoutubeCaptureManifest): string {
  const lines = [
    '# YouTube Source Not Yet Available',
    '',
    '**Status:** BLOCKED',
    '',
    '## Upcoming premieres',
    '',
  ]
  for (const video of manifest.videos) {
    const title = video.title?.trim() || video.videoId
    const availability = video.availableAt ?? 'scheduled time unavailable'
    lines.push(`- [${title}](${video.url}) — available at ${availability}`)
  }
  lines.push(
    '',
    '## Required action',
    '',
    'Run this workflow again after YouTube makes the video available and publishes captions.',
    '',
  )
  return lines.join('\n')
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

function failedCapture(
  candidate: CandidateVideo,
  previous: YoutubeManifestVideo | undefined,
  code: string,
  message: string,
  retryable: boolean,
): YoutubeManifestVideo {
  return {
    ...candidate,
    status: 'failed',
    attempts: (previous?.attempts ?? 0) + 1,
    error: { code, message, retryable },
  }
}

function requireUrl(input: YoutubeToolInput): string {
  if (!input.url?.trim()) {
    throw new YoutubeRuntimeError('invalid_request', `${input.action} requires a YouTube URL.`)
  }
  return input.url.trim()
}

export function requireVideoId(value: string | undefined): string {
  const videoId = value?.trim() ?? ''
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new YoutubeRuntimeError('invalid_request', 'YouTube video ID is invalid.')
  }
  return videoId
}

function requireContent(input: YoutubeToolInput): string {
  const content = input.content?.trim()
  if (!content) {
    throw new YoutubeRuntimeError('invalid_request', `${input.action} requires Markdown content.`)
  }
  if (Buffer.byteLength(content, 'utf8') > 250_000) {
    throw new YoutubeRuntimeError('invalid_request', 'Methodology artifact exceeds 250 KB.')
  }
  return `${content}\n`
}

export function safeMarkdownName(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
  return `${normalized || 'generalized-methodology'}.md`
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  return typeof record.text === 'string' ? record.text.trim() : ''
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function durationFromAccessibility(value: string): number | undefined {
  const match = value.match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\s|$)/)
  if (!match) return undefined
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function chunkText(value: string, chunkSize: number): string[] {
  if (!value) return ['']
  const chunks: string[] = []
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    chunks.push(value.slice(offset, offset + chunkSize))
  }
  return chunks
}

function cancelled(): Error {
  const error = new Error('YouTube extraction was cancelled.')
  error.name = 'AbortError'
  return error
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError'),
  )
}

function artifactPathError(): YoutubeRuntimeError {
  return new YoutubeRuntimeError(
    'internal',
    'YouTube artifact path failed security validation.',
  )
}

function failure(
  action: YoutubeToolInput['action'],
  code: NonNullable<YoutubeToolOutput['error']>['code'],
  message: string,
  retryable = false,
): YoutubeToolOutput {
  return { ok: false, action, error: { code, message, retryable } }
}
