/// <reference lib="dom" />

import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import puppeteer, {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type ElementHandle,
  type HTTPRequest,
  type KeyInput,
  type Page,
} from 'puppeteer-core'

import { BrowserContentStore } from './browser-content-store.js'
import { resolveBrowserExecutablePath } from './browser-executable.js'
import { BrowserNetworkPolicy } from './browser-network-policy.js'
import { authorizeBrowserRequest } from './browser-request-authorization.js'
import { classifyBrowserPage } from './browser-page-classifier.js'
import type {
  AcquisitionBrowserRuntime,
  AcquisitionChallengeType,
  BrowserLaunchProfile,
} from '../acquisition/acquisition-types.js'
import {
  captureBrowserSnapshot,
  type CapturedBrowserSnapshot,
} from './browser-snapshot.js'
import type { BrowserAgentPolicy, BrowserTargetDescription } from './browser-policy.js'
import type { FileParserLauncher } from '../../core/file-parser-launcher.js'
import { readFileParserOutputs } from '../../core/file-parser-output.js'
import { YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX } from '../youtube/youtube-image-policy.js'
import type {
  BrowserAction,
  BrowserAttachmentView,
  BrowserContentBlockView,
  BrowserElementView,
  BrowserErrorCode,
  BrowserToolInput,
  BrowserToolOutput,
} from './browser-types.js'

const DEFAULT_PAGE_TTL_MS = 30 * 60 * 1_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OBSERVE_TEXT_BYTES = 16 * 1_024
const MAX_ACQUIRED_HTML_BYTES = 10 * 1_024 * 1_024
const MAX_DOWNLOAD_BYTES = 100 * 1_024 * 1_024

export type BrowserMode = 'headed' | 'headless'

export interface BrowserManagerOptions {
  readonly profilePath: string
  readonly executablePath?: string
  readonly mode?: BrowserMode
  /**
   * Which local Chrome build to launch. Defaults to `stock`.
   *
   * The seam exists for the Phase 1 bake-off, which has to run the same driver
   * and the same Chrome twice and change exactly one launch argument. Nothing
   * in production supplies it, so the shipped default is unchanged.
   */
  readonly launchProfile?: BrowserLaunchProfile
  readonly pageTtlMs?: number
  readonly allowHttpLocalhost?: boolean
  readonly fileParserLauncher?: FileParserLauncher
  readonly networkPolicy?: BrowserNetworkPolicy
  readonly now?: () => number
  /**
   * How a browser context is created. Defaults to the browser's own method.
   *
   * It is a seam rather than a direct call so that a test can hold a real
   * creation open and observe the moment Chrome finishes it. That is the only
   * way to reach the window where a caller withdraws while a context is being
   * built, which decides whether the context is closed or cached. Production
   * supplies nothing here.
   */
  readonly createBrowserContext?: (
    browser: Browser,
    options?: BrowserContextOptions,
  ) => Promise<BrowserContext>
}

/**
 * A proxy for one execution scope.
 *
 * Parent-process-only: never serialized, never returned, never journalled. It
 * is added at the `acquireEvidence` call site alone and must not travel on
 * `McpBrokerRequestContext`, which crosses the tool boundary and is spread into
 * the scope. `server` carries no userinfo because Chrome refuses it there and
 * answers a 407 challenge instead; the pair reaches `page.authenticate` as a
 * call argument and is stored nowhere else.
 */
export interface BrowserProxyEndpoint {
  /** `scheme://host:port`, with no userinfo. */
  readonly server: string
  readonly username: string
  readonly password: string
}

export interface BrowserExecutionScope {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId?: string
  readonly assignmentPath: string
  readonly policy: BrowserAgentPolicy
  /** Parent-process-only. See `BrowserProxyEndpoint`. */
  readonly proxy?: BrowserProxyEndpoint
}

export interface BrowserStatusSnapshot {
  readonly status: 'stopped' | 'running' | 'unavailable'
  readonly mode: BrowserMode
  readonly executablePath?: string
  readonly profilePath: string
  readonly pageCount: number
  readonly error?: string
}

export interface BrowserAcquiredEvidence {
  readonly browserRuntime?: AcquisitionBrowserRuntime
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly title?: string
  readonly httpStatus?: number
  readonly text: string
  readonly renderedHtml: string
  readonly renderedHtmlTruncated: boolean
}

export interface BrowserYoutubeTranscript {
  readonly title: string
  readonly channelName?: string
  readonly durationSeconds?: number
  readonly language: string
  readonly segments: readonly {
    readonly startMs: number
    readonly durationMs: number
    readonly text: string
  }[]
}

interface ManagedPage {
  readonly pageId: string
  readonly assignmentKey: string
  readonly page: Page
  readonly policy: BrowserAgentPolicy
  refs: Map<string, ElementHandle<Element>>
  readonly snapshotHashes: Map<string, string>
  lastSnapshotHash?: string
  lastUsedAt: number
  lastMainStatus?: number
  deniedUrl?: string
  readonly deniedNavigationListeners: Set<(url: string) => void>
}

interface ManagedAssignmentContext {
  readonly context: BrowserContext
  readonly assignmentKey: string
}

interface PendingBrowserContextCreation {
  readonly browser: Browser
  readonly promise: Promise<BrowserContext>
  readonly state: { invalidated: boolean }
}

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly retryable = false,
    readonly page?: {
      readonly url?: string
      readonly title?: string
      readonly httpStatus?: number
    },
    /** Present only when `code` is `access_challenge`. */
    readonly challengeType?: AcquisitionChallengeType,
  ) {
    super(message)
    this.name = 'BrowserRuntimeError'
  }

  /**
   * Which Chrome build met the failure.
   *
   * Stamped at the acquisition boundary rather than passed in, because the
   * errors are raised deep inside page handling where the launched browser is
   * not in scope, and a failed attempt is exactly the row a bake-off compares.
   */
  browserRuntime?: AcquisitionBrowserRuntime
}

export class BrowserManager {
  private browser: Browser | null = null
  private activeMode: BrowserMode | undefined
  private browserTransition = Promise.resolve()
  private readonly pages = new Map<string, ManagedPage>()
  private readonly assignmentContexts = new Map<string, ManagedAssignmentContext>()
  private readonly contextCreations = new Map<string, PendingBrowserContextCreation>()
  private readonly contentStore = new BrowserContentStore()
  private readonly networkPolicy: BrowserNetworkPolicy
  private readonly now: () => number
  private mode: BrowserMode
  private readonly launchProfile: BrowserLaunchProfile
  private runtimeBrowser: Browser | null = null
  private runtimeSnapshot?: AcquisitionBrowserRuntime
  private lastError?: string
  private readonly cleanupTimer: NodeJS.Timeout

  constructor(private readonly options: BrowserManagerOptions) {
    this.mode = options.mode ?? 'headed'
    this.launchProfile = options.launchProfile ?? 'stock'
    this.now = options.now ?? Date.now
    this.networkPolicy = options.networkPolicy ?? new BrowserNetworkPolicy({
      ...whenDefined(options.allowHttpLocalhost, (definedValue) => ({ allowHttpLocalhost: definedValue })),
    })
    this.cleanupTimer = setInterval(
      () => void this.cleanupExpiredPages(),
      Math.min(options.pageTtlMs ?? DEFAULT_PAGE_TTL_MS, 60_000),
    )
    this.cleanupTimer.unref()
  }

  async status(): Promise<BrowserStatusSnapshot> {
    const executablePath = this.resolveExecutablePath()
    return {
      status: this.browser?.connected
        ? 'running'
        : executablePath
          ? 'stopped'
          : 'unavailable',
      mode: this.mode,
      ...(executablePath ? { executablePath } : {}),
      profilePath: this.options.profilePath,
      pageCount: this.pages.size,
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  setMode(mode: BrowserMode): void {
    this.mode = mode
  }

  async reconnectExistingProfile(): Promise<boolean> {
    return this.serializeBrowserTransition(async () => {
      if (this.browser?.connected) return true
      const browserWSEndpoint = await this.readExistingBrowserEndpoint()
      if (!browserWSEndpoint) return false
      try {
        this.attachBrowser(await puppeteer.connect({ browserWSEndpoint }))
        return true
      } catch {
        return false
      }
    })
  }

  async openProfile(): Promise<BrowserStatusSnapshot> {
    await this.ensureBrowser('headed')
    return this.status()
  }

  /**
   * Parent-process-only. The returned cookie header must never cross a tool boundary.
   *
   * The default read starts the profile in its configured mode when it is
   * stopped, which is what a media download and an authenticated capture both
   * need: a stopped profile holds no readable sign-in. The browser it starts
   * stays this manager's, like any other it launches, until Settings stops it
   * or the app quits. A profile that is already running is taken as it is,
   * whatever mode it is in, because `ensureBrowser` closes and relaunches one
   * whose mode differs and a cookie read must not take the operator's signed-in
   * window, or another assignment's pages, down with it. `launch: false`
   * additionally declines to start a stopped profile, and an already cancelled
   * caller declines it too, since a launch takes seconds and nothing waits for
   * the result. Either way a profile that cannot be read reads as no sign-in,
   * which every caller handles.
   */
  async youtubeCookieHeader(
    options: { readonly launch?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<string | undefined> {
    const running = this.browser?.connected ? this.browser : undefined
    const mayStart = options.launch !== false && options.signal?.aborted !== true
    const browser = running ?? (mayStart ? await this.ensureBrowser() : undefined)
    if (!browser) return undefined
    // Checked again after a start, because `ensureBrowser` takes no signal: a
    // cancellation that lands while Chrome is coming up is observed here, when
    // the launch returns, and the caller exports no cookie jar for a run that
    // is already over.
    if (options.signal?.aborted) return undefined
    const cookies = await browser.defaultBrowserContext().cookies()
    const header = cookies
      .filter((cookie) =>
        cookie.name &&
        cookie.value &&
        (cookie.domain === 'youtube.com' || cookie.domain.endsWith('.youtube.com')),
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
    return header || undefined
  }

  /**
   * Read a transcript that YouTube exposes in the signed-in watch page.
   * Approval is enforced by YoutubeToolService before this parent-only method runs.
   */
  async captureYoutubeTranscript(
    videoId: string,
    signal?: AbortSignal,
  ): Promise<BrowserYoutubeTranscript> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      throw new BrowserRuntimeError('invalid_request', 'YouTube video ID is invalid.')
    }
    if (signal?.aborted) {
      throw new BrowserRuntimeError('cancelled', 'YouTube transcript capture was cancelled.')
    }
    const browser = await this.ensureBrowser()
    const page = await browser.defaultBrowserContext().newPage()
    try {
      const response = await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT_MS,
      })
      await waitForUsablePageContent(page)
      const pageEvidence = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        text: (document.body?.innerText ?? '').slice(0, 20_000),
        elementCount: document.querySelectorAll('a, button, input, textarea, select').length,
        hasVisualContent: Boolean(document.querySelector('img, canvas, video, svg')),
      }))
      const pageProblem = classifyBrowserPage({
        ...whenDefined(response?.status(), (definedValue) => ({ httpStatus: definedValue })),
        ...pageEvidence,
        blockCount: 0,
      })
      if (pageProblem) {
        throw new BrowserRuntimeError(
          pageProblem.code,
          pageProblem.message,
          pageProblem.code === 'rate_limited',
        )
      }
      await revealYoutubeTranscript(page)
      await page.waitForFunction(
        () => document.querySelectorAll('ytd-transcript-segment-renderer').length > 0,
        { timeout: 15_000 },
      )
      const captured = await page.evaluate(() => {
        const title = (
          document.querySelector<HTMLElement>('h1 yt-formatted-string')?.innerText ||
          document.querySelector<HTMLElement>('h1')?.innerText ||
          document.title.replace(/\s*-\s*YouTube\s*$/, '')
        ).trim()
        const channelName = (
          document.querySelector<HTMLElement>('ytd-video-owner-renderer #channel-name')?.innerText ||
          document.querySelector<HTMLElement>('#owner #channel-name')?.innerText ||
          ''
        ).trim()
        const durationSeconds = document.querySelector<HTMLVideoElement>('video')?.duration
        const language = (
          document.querySelector<HTMLElement>('ytd-transcript-footer-renderer button')?.innerText ||
          'browser-default'
        ).trim()
        const entries = [...document.querySelectorAll<HTMLElement>('ytd-transcript-segment-renderer')]
          .map((entry) => ({
            timestamp: (
              entry.querySelector<HTMLElement>('.segment-timestamp')?.innerText ||
              entry.querySelector<HTMLElement>('[class*="timestamp"]')?.innerText ||
              ''
            ).trim(),
            text: (
              entry.querySelector<HTMLElement>('.segment-text')?.innerText ||
              entry.querySelector<HTMLElement>('[class*="segment-text"]')?.innerText ||
              ''
            ).trim(),
          }))
          .filter((entry) => entry.text)
        return {
          title,
          channelName,
          durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : undefined,
          language,
          entries,
        }
      })
      const starts = captured.entries.map((entry) => parseYoutubeTimestamp(entry.timestamp))
      const segments = captured.entries.map((entry, index) => {
        const startMs = starts[index] ?? 0
        const nextStart = starts[index + 1]
        return {
          startMs,
          durationMs: nextStart !== undefined ? Math.max(0, nextStart - startMs) : 0,
          text: entry.text,
        }
      })
      if (segments.length === 0) {
        throw new BrowserRuntimeError('empty_content', 'YouTube did not expose a transcript.')
      }
      return {
        title: captured.title || videoId,
        ...(captured.channelName ? { channelName: captured.channelName } : {}),
        ...(captured.durationSeconds !== undefined
          ? { durationSeconds: captured.durationSeconds }
          : {}),
        language: captured.language || 'browser-default',
        segments,
      }
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error
      if (signal?.aborted) {
        throw new BrowserRuntimeError('cancelled', 'YouTube transcript capture was cancelled.')
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BrowserRuntimeError(
          'timeout',
          'Authenticated YouTube transcript capture timed out.',
          true,
        )
      }
      if (
        error instanceof Error &&
        /target closed|session closed|browser.*disconnected|renderer/i.test(error.message)
      ) {
        throw new BrowserRuntimeError(
          'browser_unavailable',
          'The browser became unavailable during authenticated YouTube capture.',
          true,
        )
      }
      throw new BrowserRuntimeError(
        'internal',
        'Authenticated YouTube transcript capture failed before transcript availability was known.',
        true,
      )
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  async captureYoutubeFrames(input: {
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
  }): Promise<readonly {
    readonly stepId: string
    readonly requestedTimestampSeconds: number
    readonly importance: 'required' | 'supporting'
    readonly actualTimestampSeconds: number
    readonly relativePath: string
    readonly caption: string
    readonly altText: string
    readonly selectionReason: string
    readonly sha256: string
  }[]> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(input.videoId)) {
      throw new BrowserRuntimeError('invalid_request', 'YouTube video ID is invalid.')
    }
    if (input.signal?.aborted) {
      throw new BrowserRuntimeError('cancelled', 'YouTube frame capture was cancelled.')
    }
    await fs.mkdir(input.outputDirectory, { recursive: true, mode: 0o700 })
    const outputStat = await fs.lstat(input.outputDirectory)
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
      throw new BrowserRuntimeError('internal', 'YouTube frame output is unsafe.')
    }
    const browser = await this.ensureBrowser()
    try {
      return await this.captureYoutubeFramesInBrowser(browser, input)
    } catch (error) {
      if (!(error instanceof BrowserRuntimeError) || error.code !== 'browser_unavailable' || input.signal?.aborted) throw error
      const executablePath = this.resolveExecutablePath()
      if (!executablePath) throw error
      // A separate temporary profile preserves other assignments and the
      // operator's browser mode while the headed recovery attempt runs.
      const profilePath = await fs.mkdtemp(path.join(path.dirname(this.options.profilePath), 'youtube-frame-recovery-'))
      let recovery: Browser | undefined
      try {
        recovery = await puppeteer.launch({ executablePath, headless: false, userDataDir: profilePath,
          args: launchArguments('automation-controlled-disabled') })
        return await this.captureYoutubeFramesInBrowser(recovery, input, 'headed_browser_fallback')
      } catch (cause) {
        if (input.signal?.aborted) throw new BrowserRuntimeError('cancelled', 'YouTube frame capture was cancelled.')
        const failure = new BrowserRuntimeError('browser_unavailable', 'YouTube screenshots could not be captured in either the application browser or its headed recovery browser.', true)
        failure.cause = cause
        throw failure
      } finally {
        try { await recovery?.close() } finally { await fs.rm(profilePath, { recursive: true, force: true }) }
      }
    }
  }

  private async captureYoutubeFramesInBrowser(
    browser: Browser,
    input: Parameters<BrowserManager['captureYoutubeFrames']>[0],
    selectionReason = 'browser_fallback',
  ): ReturnType<BrowserManager['captureYoutubeFrames']> {
    // The primary browser keeps its application-owned profile and cookies.
    // A recovery browser owns a separate disposable profile.
    const page = await browser.defaultBrowserContext().newPage()
    try {
      await page.setViewport({
        width: YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX,
        height: 900,
        deviceScaleFactor: 1,
      })
      await page.goto(`https://www.youtube.com/watch?v=${input.videoId}`, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT_MS,
      })
      await page.waitForSelector('video', { timeout: DEFAULT_TIMEOUT_MS })
      const frames = []
      for (const [index, cue] of input.cues.entries()) {
        if (input.signal?.aborted) {
          throw new BrowserRuntimeError('cancelled', 'YouTube frame capture was cancelled.')
        }
        const actualTimestampSeconds = await page.evaluate(async (seconds) => {
          const video = document.querySelector<HTMLVideoElement>('video')
          if (!video) throw new Error('Video element is unavailable.')
          // Playback initializes YouTube's media pipeline before seeking.
          // Muting permits this in an unattended application-owned page.
          video.muted = true
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error('Video playback timed out.')), 15_000)
            video.play().then(() => { window.clearTimeout(timer); resolve() },
              (error: unknown) => { window.clearTimeout(timer); reject(error) })
          })
          const target = Math.min(Math.max(0, seconds), Number.isFinite(video.duration)
            ? Math.max(0, video.duration - 0.05)
            : seconds)
          if (Math.abs(video.currentTime - target) > 0.05) {
            await new Promise<void>((resolve, reject) => {
              const timer = window.setTimeout(() => reject(new Error('Video seek timed out.')), 15_000)
              video.addEventListener('seeked', () => {
                window.clearTimeout(timer)
                resolve()
              }, { once: true })
              const player = document.getElementById('movie_player')
              if (player && 'seekTo' in player && typeof player.seekTo === 'function') {
                Reflect.apply(player.seekTo, player, [target, true])
              } else {
                video.currentTime = target
              }
            })
          }
          video.pause()
          return video.currentTime
        }, cue.timestampSeconds)
        const videoElement = await page.$('video')
        if (!videoElement) throw new Error('Video element is unavailable.')
        await page.evaluate((maximumWidth) => {
          const video = document.querySelector<HTMLVideoElement>('video')
          if (video) {
            video.style.maxWidth = `${maximumWidth}px`
            video.style.width = `min(100%, ${maximumWidth}px)`
            video.style.height = 'auto'
          }
        }, YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX)
        const fileName = youtubeBrowserFrameFileName(index, cue.stepId)
        const outputPath = path.join(input.outputDirectory, fileName)
        await videoElement.screenshot({ path: outputPath, type: 'png' })
        const bytes = await fs.readFile(outputPath)
        frames.push({
          stepId: cue.stepId,
          requestedTimestampSeconds: cue.timestampSeconds,
          importance: cue.importance,
          actualTimestampSeconds,
          relativePath: `${path.basename(input.outputDirectory)}/${fileName}`,
          caption: cue.caption,
          altText: cue.altText,
          selectionReason,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
      return frames
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error
      if (input.signal?.aborted) {
        throw new BrowserRuntimeError('cancelled', 'YouTube frame capture was cancelled.')
      }
      throw new BrowserRuntimeError(
        'browser_unavailable',
        'The application browser could not capture YouTube screenshots.',
        true,
      )
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  async stop(): Promise<void> {
    await this.serializeBrowserTransition(() => this.stopBrowser())
  }

  private async stopBrowser(): Promise<void> {
    const browser = this.browser
    this.browser = null
    this.activeMode = undefined
    this.pages.clear()
    this.assignmentContexts.clear()
    for (const creation of this.contextCreations.values()) {
      creation.state.invalidated = true
    }
    this.contextCreations.clear()
    this.contentStore.clear()
    if (browser?.connected) await browser.close().catch(() => undefined)
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer)
    await this.stop()
  }

  async closeAssignment(
    scope: Pick<
      BrowserExecutionScope,
      'sessionId' | 'runId' | 'assignmentId' | 'activityScopeId'
    >,
  ): Promise<void> {
    const key = assignmentKey(scope)
    const closing = [...this.pages.values()]
      .filter((entry) => entry.assignmentKey === key)
      .map(async (entry) => {
        this.pages.delete(entry.pageId)
        await disposeRefs(entry.refs)
        await entry.page.close().catch(() => undefined)
      })
    await Promise.all(closing)
    // Every context this scope owns: its unproxied one, and one per proxy
    // endpoint it used. The scope reaching here carries no proxy field - it
    // arrives from `releaseAssignment` - so a proxied context that is not
    // found by prefix is orphaned until `stop()`.
    const prefix = proxiedContextKeyPrefix(key)
    const owned = (candidate: string): boolean =>
      candidate === key || candidate.startsWith(prefix)
    for (const contextKey of [...this.contextCreations.keys()]) {
      if (!owned(contextKey)) continue
      const pending = this.contextCreations.get(contextKey)
      if (!pending) continue
      pending.state.invalidated = true
      this.contextCreations.delete(contextKey)
    }
    for (const contextKey of [...this.assignmentContexts.keys()]) {
      if (!owned(contextKey)) continue
      const isolated = this.assignmentContexts.get(contextKey)
      this.assignmentContexts.delete(contextKey)
      await isolated?.context.close().catch(() => undefined)
    }
    this.contentStore.releaseAssignment(key)
  }

  async describeTarget(
    scope: BrowserExecutionScope,
    input: BrowserToolInput,
  ): Promise<BrowserTargetDescription | undefined> {
    if (!input.pageId || !input.ref) return undefined
    const managed = this.requirePage(scope, input.pageId)
    const element = managed.refs.get(input.ref)
    if (!element) return undefined
    return element.evaluate((node) => {
      if (!(node instanceof HTMLElement)) return undefined
      const element = node
      const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a')
      const form = element.closest('form')
      const type = element.getAttribute('type')
      const role = element.getAttribute('role')
      return {
        tag: element.tagName.toLowerCase(),
        ...(type ? { type: type.toLowerCase() } : {}),
        ...(role ? { role: role.toLowerCase() } : {}),
        name: accessibleName(element),
        ...(anchor?.href ? { href: anchor.href } : {}),
        ...(anchor?.hasAttribute('download') ? { download: true } : {}),
        ...(form?.method ? { formMethod: form.method.toLowerCase() } : {}),
      }

      function accessibleName(node: HTMLElement): string {
        return (
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          (node instanceof HTMLInputElement ? node.placeholder : '') ||
          node.innerText ||
          node.textContent ||
          ''
        ).trim().slice(0, 240)
      }
    })
  }

  async execute(
    scope: BrowserExecutionScope,
    input: BrowserToolInput,
    signal?: AbortSignal,
  ): Promise<BrowserToolOutput> {
    if (signal?.aborted) throw new BrowserRuntimeError('cancelled', 'Browser action was cancelled.')
    if (input.action === 'wait') return this.wait(scope, input, signal)
    if (input.action === 'read_content') return this.readContent(scope, input)
    if (input.action === 'search_content') return this.searchContent(scope, input)
    const timeoutMs = normalizeTimeout(input.timeoutMs)
    const managed = input.pageId ? this.pages.get(input.pageId) : undefined
    let removeDeniedGuard: (() => void) | undefined
    const deniedGuard = managed && managed.assignmentKey === assignmentKey(scope)
      ? new Promise<never>((_resolve, reject) => {
          const listener = (url: string) => reject(deniedNavigationError(url))
          managed.deniedNavigationListeners.add(listener)
          removeDeniedGuard = () => managed.deniedNavigationListeners.delete(listener)
        })
      : undefined
    try {
      return await withAbortAndTimeout(
        this.executeAction(scope, input, timeoutMs, signal),
        // `open` is deliberately not raced against the caller's signal. It
        // creates a browser context and a page that only it can reach, so
        // returning to the caller the moment the signal fires would leave both
        // being built behind them. It observes the signal itself and rejects
        // once its own cleanup is done, which makes that rejection the
        // completion of the whole cancelled action. Every other action owns
        // nothing the caller could not reclaim, so the race still applies.
        input.action === 'open' ? undefined : signal,
        timeoutMs,
        input.action,
        deniedGuard,
      )
    } finally {
      removeDeniedGuard?.()
    }
  }

  /**
   * Which local Chrome build this manager is running.
   *
   * It reads the already-connected browser and never starts one. Asking
   * `ensureBrowser` here would give an acquisition two launch attempts where it
   * has always had one, so a machine with no usable Chrome would pay the launch
   * failure twice for a field that only annotates the result. `undefined` is
   * therefore the honest answer whenever no browser is connected, and the read
   * itself still raises the real `browser_unavailable` failure.
   */
  private async acquisitionBrowserRuntime(): Promise<
    AcquisitionBrowserRuntime | undefined
  > {
    const browser = this.browser
    if (!browser?.connected) return undefined
    if (this.runtimeBrowser === browser && this.runtimeSnapshot) {
      return this.runtimeSnapshot
    }
    const browserVersion = await browser.version().catch(() => 'unknown')
    this.runtimeBrowser = browser
    this.runtimeSnapshot = {
      driver: 'puppeteer-core',
      driverVersion: puppeteerCoreVersion(),
      browserVersion,
      mode: this.mode,
      launchProfile: this.launchProfile,
    }
    return this.runtimeSnapshot
  }

  /** Parent-process-only read path used by the acquisition controller. */
  async acquireEvidence(
    scope: BrowserExecutionScope,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserAcquiredEvidence> {
    let pageId: string | undefined
    try {
      const opened = await this.execute(
        scope,
        { action: 'open', url, timeoutMs: DEFAULT_TIMEOUT_MS },
        signal,
      )
      pageId = opened.pageId
      if (!opened.ok || !pageId || !opened.content) {
        throw new BrowserRuntimeError(
          'empty_content',
          'Managed Chrome returned no evidence observation.',
        )
      }
      const managed = this.requirePage(scope, pageId)
      const chunks: string[] = []
      for (let index = 0; index < opened.content.chunkCount; index += 1) {
        const content = this.contentStore.read(
          managed.assignmentKey,
          opened.content.id,
          index,
        )
        if (content?.text === undefined) {
          throw new BrowserRuntimeError(
            'empty_content',
            'Managed Chrome evidence content could not be read.',
          )
        }
        chunks.push(content.text)
      }
      const renderedHtml = boundUtf8(
        await managed.page.content(),
        MAX_ACQUIRED_HTML_BYTES,
      )
      return {
        ...whenDefined(
          await this.acquisitionBrowserRuntime(),
          (runtime) => ({ browserRuntime: runtime }),
        ),
        requestedUrl: url,
        finalUrl: managed.page.url(),
        ...(opened.title ? { title: opened.title } : {}),
        ...(managed.lastMainStatus !== undefined
          ? { httpStatus: managed.lastMainStatus }
          : {}),
        text: chunks.join(''),
        renderedHtml: renderedHtml.value,
        renderedHtmlTruncated: renderedHtml.truncated,
      }
    } catch (error) {
      if (error instanceof BrowserRuntimeError) {
        // Stamped from the browser that is still connected. A failure raised
        // because Chrome never started leaves this unset, which is the truth.
        const runtime = await this.acquisitionBrowserRuntime()
        if (runtime) error.browserRuntime = runtime
      }
      throw error
    } finally {
      if (pageId) {
        await this.execute(scope, { action: 'close', pageId }).catch(() => undefined)
      }
    }
  }

  private async executeAction(
    scope: BrowserExecutionScope,
    input: BrowserToolInput,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BrowserToolOutput> {
    switch (input.action) {
      case 'open':
        return this.open(scope, requireUrl(input), timeoutMs, signal)
      case 'close': {
        const managed = this.requireInputPage(scope, input)
        this.pages.delete(managed.pageId)
        await disposeRefs(managed.refs)
        await managed.page.close()
        return success(input.action, { pageId: managed.pageId, text: 'Page closed.' })
      }
    }

    const managed = this.requireInputPage(scope, input)
    managed.lastUsedAt = this.now()
    switch (input.action) {
      case 'observe':
        return this.observe(scope, managed)
      case 'navigate':
        await this.navigate(managed, requireUrl(input), timeoutMs)
        return this.observe(scope, managed, input.action)
      case 'go_back':
        delete managed.deniedUrl
        try {
          const response = await managed.page.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
          delete managed.lastMainStatus
          if (response) managed.lastMainStatus = response.status()
        } catch (error) {
          if (managed.deniedUrl) this.throwDeniedNavigation(managed.deniedUrl)
          throw error
        }
        await this.assertCurrentUrlAllowed(managed)
        return this.observe(scope, managed, input.action)
      case 'click':
        delete managed.deniedUrl
        await this.clickRef(managed, requireRef(input))
        await settlePage(managed.page, timeoutMs)
        await this.assertCurrentUrlAllowed(managed)
        return this.observe(scope, managed, input.action)
      case 'type':
        await this.typeRef(managed, requireRef(input), input.text ?? '')
        return this.observe(scope, managed, input.action)
      case 'select':
        await this.selectRef(managed, requireRef(input), requireValue(input))
        return this.observe(scope, managed, input.action)
      case 'press':
        delete managed.deniedUrl
        await this.pressRef(managed, input.ref, requireKey(input))
        await settlePage(managed.page, timeoutMs)
        await this.assertCurrentUrlAllowed(managed)
        return this.observe(scope, managed, input.action)
      case 'scroll':
        await this.scroll(managed, input.direction ?? 'down', input.amount)
        return this.observe(scope, managed, input.action)
      case 'screenshot':
        return this.screenshot(scope, managed, input.ref)
      case 'download':
        return this.download(scope, managed, requireRef(input), timeoutMs)
      default:
        throw new BrowserRuntimeError('invalid_request', 'Browser action is invalid.')
    }
  }

  private async open(
    scope: BrowserExecutionScope,
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BrowserToolOutput> {
    await this.assertUrlAllowed(url, scope.policy)
    const browser = await this.ensureBrowser()
    const context = await this.contextForScope(browser, scope, signal)
    const page = await context.newPage()
    if (signal?.aborted) {
      // The context is clean by now, but the page was created after the caller
      // withdrew and nothing else would close it.
      await page.close().catch(() => undefined)
      throw cancelledBrowserAction()
    }
    const pageId = randomUUID()
    const managed: ManagedPage = {
      pageId,
      assignmentKey: assignmentKey(scope),
      page,
      policy: scope.policy,
      refs: new Map(),
      snapshotHashes: new Map(),
      lastUsedAt: this.now(),
      deniedNavigationListeners: new Set(),
    }
    this.pages.set(pageId, managed)
    // The caller never learns this page's id, so nothing outside this method
    // could reclaim it. Withdrawing drops it from the map at once and starts
    // closing the tab, which also ends a navigation still waiting on the
    // network; the close is kept so the action can finish it before it rejects.
    let abandoned: Promise<void> | undefined
    const abandonOnAbort = (): void => {
      this.pages.delete(pageId)
      abandoned = (async () => {
        await disposeRefs(managed.refs)
        await page.close().catch(() => undefined)
      })()
    }
    signal?.addEventListener('abort', abandonOnAbort, { once: true })
    try {
      await this.preparePage(managed, scope.proxy)
      await this.navigate(managed, url, timeoutMs)
      const observed = await this.observe(scope, managed, 'open')
      if (signal?.aborted) {
        await abandoned
        throw cancelledBrowserAction()
      }
      return observed
    } catch (error) {
      this.pages.delete(pageId)
      await abandoned
      await page.close().catch(() => undefined)
      // A page closed by the withdrawal makes the work in flight fail in its
      // own terms - a detached frame, a closed target - and that is the
      // withdrawal speaking, not the source.
      if (signal?.aborted) throw cancelledBrowserAction()
      throw error
    } finally {
      signal?.removeEventListener('abort', abandonOnAbort)
    }
  }

  private async preparePage(
    managed: ManagedPage,
    proxy?: BrowserProxyEndpoint,
  ): Promise<void> {
    await managed.page.setRequestInterception(true)
    if (proxy) {
      // Chrome cannot take proxy credentials in the context option, so it
      // answers the proxy's 407 from here. The pair arrives as a call argument
      // and is stored nowhere: not on `ManagedPage`, which the TTL sweep keeps
      // alive for up to half an hour, and not in the context cache key.
      await managed.page.authenticate({
        username: proxy.username,
        password: proxy.password,
      })
    }
    managed.page.on('request', (request) => void this.handleRequest(managed, request))
    managed.page.on('response', (response) => {
      const request = response.request()
      if (request.isNavigationRequest() && request.frame() === managed.page.mainFrame()) {
        managed.lastMainStatus = response.status()
      }
    })
    managed.page.on('popup', (popup) => {
      if (!popup) return
      // Popups never inherit an assignment implicitly. Agents may open the
      // target explicitly after observing a normal link.
      void popup.close().catch(() => undefined)
    })
    managed.page.once('close', () => {
      this.pages.delete(managed.pageId)
      void disposeRefs(managed.refs)
    })
  }

  private async handleRequest(managed: ManagedPage, request: HTTPRequest): Promise<void> {
    const url = request.url()
    // The shared rule, so managed Chrome and any other browser this
    // application drives cannot disagree about what is reachable.
    const { blocked, mainNavigation } = await authorizeBrowserRequest(
      {
        url,
        isMainNavigation:
          request.isNavigationRequest() && request.frame() === managed.page.mainFrame(),
      },
      managed.policy,
      this.networkPolicy,
    )
    if (blocked) {
      await request.abort('blockedbyclient').catch(() => undefined)
      if (mainNavigation) {
        managed.deniedUrl = request.url()
        for (const listener of managed.deniedNavigationListeners) listener(request.url())
        void managed.page.evaluate(() => window.stop()).catch(() => undefined)
      }
      return
    }
    await request.continue().catch(() => undefined)
  }

  private async navigate(managed: ManagedPage, url: string, timeoutMs: number): Promise<void> {
    await this.assertUrlAllowed(url, managed.policy)
    delete managed.deniedUrl
    try {
      const response = await managed.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      delete managed.lastMainStatus
      if (response) managed.lastMainStatus = response.status()
    } catch (error) {
      if (managed.deniedUrl) {
        throw new BrowserRuntimeError(
          'domain_denied',
          `Navigation was blocked by the agent domain policy: ${redactBrowserUrl(managed.deniedUrl)}`,
        )
      }
      throw error
    }
    await this.assertCurrentUrlAllowed(managed)
  }

  private async observe(
    scope: BrowserExecutionScope,
    managed: ManagedPage,
    action: BrowserAction = 'observe',
  ): Promise<BrowserToolOutput> {
    await this.assertCurrentUrlAllowed(managed)
    let snapshot = await captureBrowserSnapshot(
      managed.page,
      (url) => this.urlAllowed(url, managed.policy),
    )
    if (isSemanticallyEmpty(snapshot)) {
      await waitForUsablePageContent(managed.page)
      await disposeRefs(new Map(snapshot.refs))
      snapshot = await captureBrowserSnapshot(
        managed.page,
        (url) => this.urlAllowed(url, managed.policy),
      )
    }
    const fullText = formatSnapshotContent(snapshot.blocks, snapshot.text)
    const content = await this.contentStore.write({
      assignmentKey: managed.assignmentKey,
      assignmentPath: scope.assignmentPath,
      text: fullText,
    })
    const problem = classifyBrowserPage({
      ...whenDefined(managed.lastMainStatus, (definedValue) => ({ httpStatus: definedValue })),
      title: snapshot.title,
      url: snapshot.url,
      text: snapshot.text,
      elementCount: snapshot.elements.length,
      elements: snapshot.elements.map((element) => ({
        name: element.name,
        ...(element.role ? { role: element.role } : {}),
        ...(element.type ? { type: element.type } : {}),
      })),
      frames: snapshot.frames.map((frame) => ({
        title: frame.title,
        allowed: frame.allowed,
      })),
      blockCount: snapshot.blocks.length,
      hasVisualContent: snapshot.visual.recommended,
    })
    if (problem) {
      await disposeRefs(new Map(snapshot.refs))
      this.pages.delete(managed.pageId)
      await disposeRefs(managed.refs)
      await managed.page.close().catch(() => undefined)
      throw new BrowserRuntimeError(
        problem.code,
        problem.message,
        false,
        {
          url: redactBrowserUrl(snapshot.url),
          title: snapshot.title,
          ...(managed.lastMainStatus !== undefined ? { httpStatus: managed.lastMainStatus } : {}),
        },
        problem.challengeType,
      )
    }
    const hash = createHash('sha256')
      .update(`${snapshot.url}\0${snapshot.text}`)
      .digest('hex')
    const changed = managed.lastSnapshotHash === undefined || managed.lastSnapshotHash !== hash
    managed.lastSnapshotHash = hash
    managed.snapshotHashes.set(snapshot.snapshotId, hash)
    while (managed.snapshotHashes.size > 20) {
      managed.snapshotHashes.delete(managed.snapshotHashes.keys().next().value as string)
    }
    const oldRefs = managed.refs
    managed.refs = new Map(snapshot.refs)
    await disposeRefs(oldRefs)
    const bounded = boundUtf8(snapshot.text, MAX_OBSERVE_TEXT_BYTES)
    return success(action, {
      pageId: managed.pageId,
      url: redactBrowserUrl(snapshot.url),
      title: snapshot.title,
      ...(managed.lastMainStatus !== undefined
        ? { httpStatus: managed.lastMainStatus }
        : {}),
      snapshotId: snapshot.snapshotId,
      changed,
      text: bounded.value,
      content,
      elements: snapshot.elements.map((element) => ({
        ...element,
        ...(element.href ? { href: redactBrowserUrl(element.href) } : {}),
      })) as BrowserElementView[],
      blocks: snapshot.blocks.slice(0, 40).map((block) => ({
        ...block,
        text: block.text.slice(0, 500),
      })),
      frames: snapshot.frames.map((frame) => ({
        ...frame,
        url: frame.url === 'about:blank' ? frame.url : redactBrowserUrl(frame.url),
      })),
      visual: snapshot.visual,
      ...(bounded.truncated ? { truncated: true } : {}),
    })
  }

  private async clickRef(managed: ManagedPage, ref: string): Promise<void> {
    await this.requireRef(managed, ref).click()
  }

  private async typeRef(managed: ManagedPage, ref: string, text: string): Promise<void> {
    const handle = this.requireRef(managed, ref)
    const sensitive = await handle.evaluate((node) =>
      node instanceof HTMLInputElement && (
        ['password', 'hidden'].includes(node.type.toLowerCase()) ||
        node.autocomplete === 'one-time-code' ||
        node.autocomplete === 'current-password' ||
        node.autocomplete === 'new-password' ||
        node.autocomplete.startsWith('cc-')
      ),
    ).catch(() => undefined)
    if (sensitive === undefined) throw staleElement(ref)
    if (sensitive) throw new BrowserRuntimeError('sensitive_input_blocked', 'Agents cannot type into credential, payment, password, or hidden fields.')
    await handle.focus()
    await handle.evaluate((node) => {
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        node.value = ''
        node.dispatchEvent(new Event('input', { bubbles: true }))
      } else if (node instanceof HTMLElement && node.isContentEditable) {
        node.textContent = ''
        node.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await managed.page.keyboard.type(text)
  }

  private async selectRef(managed: ManagedPage, ref: string, value: string): Promise<void> {
    const selected = await this.requireRef(managed, ref).select(value).catch(() => [])
    if (selected.length === 0) throw staleElement(ref)
  }

  private async pressRef(managed: ManagedPage, ref: string | undefined, key: string): Promise<void> {
    if (ref) await this.requireRef(managed, ref).focus()
    await managed.page.keyboard.press(key as KeyInput)
  }

  private async scroll(
    managed: ManagedPage,
    direction: 'up' | 'down' | 'top' | 'bottom',
    amount?: number,
  ): Promise<void> {
    await managed.page.evaluate(({ direction, amount }) => {
      const distance = amount ?? Math.max(400, Math.floor(window.innerHeight * 0.8))
      if (direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' })
      else if (direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      else window.scrollBy({ top: direction === 'up' ? -distance : distance, behavior: 'instant' })
    }, { direction, amount })
    await abortableDelay(150)
  }

  private async screenshot(
    scope: BrowserExecutionScope,
    managed: ManagedPage,
    ref?: string,
  ): Promise<BrowserToolOutput> {
    const artifactDir = path.join(scope.assignmentPath, 'browser-artifacts')
    await fs.mkdir(artifactDir, { recursive: true })
    const name = `screenshot-${Date.now()}-${managed.pageId.slice(0, 8)}.jpg`
    const target = path.join(artifactDir, name)
    if (ref) await this.requireRef(managed, ref).screenshot({ path: target, type: 'jpeg', quality: 72 })
    else await managed.page.screenshot({ path: target, type: 'jpeg', quality: 72, fullPage: false })
    return success('screenshot', {
      pageId: managed.pageId,
      url: redactBrowserUrl(managed.page.url()),
      title: await managed.page.title(),
      attachment: await attachmentView(scope.assignmentPath, target, 'screenshot'),
    })
  }

  private async wait(
    scope: BrowserExecutionScope,
    input: BrowserToolInput,
    signal?: AbortSignal,
  ): Promise<BrowserToolOutput> {
    const managed = this.requireInputPage(scope, input)
    managed.lastUsedAt = this.now()
    const waitFor = input.waitFor ?? 'delay'
    const timeoutMs = normalizeWait(input.timeoutMs ?? input.waitMs)
    const operation = async () => {
      if (waitFor === 'delay') {
        await abortableDelay(normalizeWait(input.waitMs), signal)
        return
      }
      if (waitFor === 'network_idle') {
        await managed.page.waitForNetworkIdle({ idleTime: 500, timeout: timeoutMs })
        return
      }
      const query = waitFor === 'change' ? undefined : requireQuery(input)
      const baseline = waitFor === 'change'
        ? requireSnapshotHash(managed, input.snapshotId)
        : undefined
      await waitForPageCondition(managed.page, waitFor, query, baseline, timeoutMs, signal)
    }
    await withAbortAndTimeout(operation(), signal, timeoutMs, 'wait')
    await this.assertCurrentUrlAllowed(managed)
    return this.observe(scope, managed, 'wait')
  }

  private async download(
    scope: BrowserExecutionScope,
    managed: ManagedPage,
    ref: string,
    timeoutMs: number,
  ): Promise<BrowserToolOutput> {
    const downloadDir = path.join(scope.assignmentPath, 'browser-downloads')
    await fs.mkdir(downloadDir, { recursive: true })
    const before = new Set(await fs.readdir(downloadDir))
    const handle = this.requireRef(managed, ref)
    const href = await handle.evaluate((node) => {
      const anchor = node instanceof HTMLAnchorElement ? node : node.closest('a')
      return anchor?.href
    }).catch(() => undefined)
    if (href && !await this.urlAllowed(href, managed.policy)) {
      throw new BrowserRuntimeError('domain_denied', `Download is blocked by the agent domain policy: ${redactBrowserUrl(href)}`)
    }
    delete managed.deniedUrl
    await managed.page.bringToFront()
    const session = await managed.page.createCDPSession()
    await session.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    })
    try {
      await this.clickRef(managed, ref)
      const target = await waitForDownload(downloadDir, before, timeoutMs)
      const parsedContent = await this.parseDownloadedContent(scope, managed, downloadDir)
      return success('download', {
        pageId: managed.pageId,
        url: redactBrowserUrl(managed.page.url()),
        title: await managed.page.title(),
        attachment: await attachmentView(scope.assignmentPath, target, 'download'),
        ...(parsedContent ? { content: parsedContent } : {}),
      })
    } finally {
      await session.detach().catch(() => undefined)
    }
  }

  private readContent(scope: BrowserExecutionScope, input: BrowserToolInput): BrowserToolOutput {
    const contentId = requireContentId(input)
    const content = this.contentStore.read(
      assignmentKey(scope),
      contentId,
      input.chunkIndex ?? 0,
    )
    if (!content) {
      throw new BrowserRuntimeError('invalid_request', 'Browser content or chunk is unavailable.')
    }
    return success('read_content', { content, ...whenDefined(content.text, (definedValue) => ({ text: definedValue })) })
  }

  private searchContent(scope: BrowserExecutionScope, input: BrowserToolInput): BrowserToolOutput {
    const contentId = requireContentId(input)
    const matches = this.contentStore.search(assignmentKey(scope), contentId, requireQuery(input))
    if (!matches) throw new BrowserRuntimeError('invalid_request', 'Browser content is unavailable.')
    return success('search_content', { matches })
  }

  private requireRef(managed: ManagedPage, ref: string): ElementHandle<Element> {
    const handle = managed.refs.get(ref)
    if (!handle) throw staleElement(ref)
    return handle
  }

  private async contextForScope(
    browser: Browser,
    scope: BrowserExecutionScope,
    signal?: AbortSignal,
  ): Promise<BrowserContext> {
    if (scope.proxy) {
      // Deliberately ahead of the `restrictDomains` branch. That branch returns
      // the default context, which holds the signed-in profile and carries no
      // proxy; handing it back here would produce a silently unproxied retry,
      // which is worse than failing.
      const proxy = scope.proxy
      const scopeKey = assignmentKey(scope)
      const key = proxiedContextKey(scopeKey, proxy.server)
      await this.closeReplacedProxiedContexts(scopeKey, key)
      return this.contextForKey(browser, key, signal, {
        proxyServer: proxy.server,
        // Chrome bypasses a configured proxy for loopback addresses by
        // default, so a loopback origin would be read directly while the
        // attempt claimed to be proxied. This manager only reaches loopback
        // origins when `allowHttpLocalhost` is on, and that is exactly where
        // a silent bypass would misreport the egress.
        ...(this.options.allowHttpLocalhost === true
          ? { proxyBypassList: ['<-loopback>'] }
          : {}),
      })
    }
    if (scope.policy.restrictDomains) return browser.defaultBrowserContext()
    return this.contextForKey(browser, assignmentKey(scope), signal)
  }

  /**
   * One cached context per key, created once and joined while in flight.
   *
   * The abort checks exist because `withAbortAndTimeout` races the caller's
   * signal against the action; it rejects the caller but does not stop the
   * work already in flight. An unproxied context survives that harmlessly,
   * because `closeAssignment` reclaims it. A proxied one would not: it is
   * created per endpoint and, once the acquisition is abandoned, nothing asks
   * for it again. So a creation the caller withdrew from is closed and never
   * cached, and a waiter joined to it receives the same rejection.
   */
  private async contextForKey(
    browser: Browser,
    key: string,
    signal?: AbortSignal,
    createOptions?: BrowserContextOptions,
  ): Promise<BrowserContext> {
    const existing = this.assignmentContexts.get(key)
    if (existing) return existing.context
    const pending = this.contextCreations.get(key)
    if (pending && pending.browser === browser && !pending.state.invalidated) {
      return pending.promise
    }
    if (pending) pending.state.invalidated = true
    if (signal?.aborted) throw cancelledBrowserAction()
    const state = { invalidated: false }
    const promise = (async () => {
      try {
        const context = await this.createContext(browser, createOptions)
        if (
          state.invalidated ||
          signal?.aborted ||
          this.browser !== browser ||
          this.contextCreations.get(key)?.state !== state
        ) {
          await context.close().catch(() => undefined)
          throw signal?.aborted
            ? cancelledBrowserAction()
            : new BrowserRuntimeError(
                'browser_unavailable',
                'Browser context creation was invalidated by a lifecycle change.',
                true,
              )
        }
        this.assignmentContexts.set(key, { context, assignmentKey: key })
        return context
      } finally {
        if (this.contextCreations.get(key)?.state === state) {
          this.contextCreations.delete(key)
        }
      }
    })()
    const creation = { browser, promise, state }
    this.contextCreations.set(key, creation)
    return promise
  }

  private createContext(
    browser: Browser,
    options?: BrowserContextOptions,
  ): Promise<BrowserContext> {
    return this.options.createBrowserContext
      ? this.options.createBrowserContext(browser, options)
      : browser.createBrowserContext(options)
  }

  /**
   * Closes any proxied context this scope holds against a different endpoint.
   *
   * The cache key names the endpoint, so a host or port changed mid-assignment
   * cannot reuse a context still pointed at the old server. The replaced entry
   * is closed rather than merely dropped, or it would linger until the
   * assignment ends.
   */
  private async closeReplacedProxiedContexts(
    scopeKey: string,
    keepKey: string,
  ): Promise<void> {
    const prefix = proxiedContextKeyPrefix(scopeKey)
    for (const key of [...this.contextCreations.keys()]) {
      if (key === keepKey || !key.startsWith(prefix)) continue
      const pending = this.contextCreations.get(key)
      if (pending) {
        pending.state.invalidated = true
        this.contextCreations.delete(key)
      }
    }
    for (const key of [...this.assignmentContexts.keys()]) {
      if (key === keepKey || !key.startsWith(prefix)) continue
      const entry = this.assignmentContexts.get(key)
      this.assignmentContexts.delete(key)
      await entry?.context.close().catch(() => undefined)
    }
  }

  private async parseDownloadedContent(
    scope: BrowserExecutionScope,
    managed: ManagedPage,
    downloadDir: string,
  ) {
    if (!this.options.fileParserLauncher) return null
    try {
      await this.options.fileParserLauncher.parseDirectory(downloadDir)
      const parsedText = await readFileParserOutputs(downloadDir)
      if (!parsedText.trim()) return null
      return this.contentStore.write({
        assignmentKey: managed.assignmentKey,
        assignmentPath: scope.assignmentPath,
        text: parsedText,
      })
    } catch {
      return null
    }
  }

  private requireInputPage(scope: BrowserExecutionScope, input: BrowserToolInput): ManagedPage {
    if (!input.pageId) throw new BrowserRuntimeError('invalid_request', `${input.action} requires pageId.`)
    return this.requirePage(scope, input.pageId)
  }

  private requirePage(scope: BrowserExecutionScope, pageId: string): ManagedPage {
    const managed = this.pages.get(pageId)
    if (!managed) {
      throw new BrowserRuntimeError('page_not_found', 'Browser page is unavailable. Open or observe a current page.', true)
    }
    if (managed.assignmentKey !== assignmentKey(scope)) {
      throw new BrowserRuntimeError('page_not_found', 'Browser page is unavailable. Open or observe a current page.', true)
    }
    if (managed.page.isClosed()) {
      this.pages.delete(pageId)
      throw new BrowserRuntimeError('page_not_found', 'Browser page is unavailable. Open or observe a current page.', true)
    }
    return managed
  }

  private async assertCurrentUrlAllowed(managed: ManagedPage): Promise<void> {
    if (managed.deniedUrl) this.throwDeniedNavigation(managed.deniedUrl)
    const url = managed.page.url()
    if (url !== 'about:blank') await this.assertUrlAllowed(url, managed.policy)
  }

  private throwDeniedNavigation(url: string): never {
    throw deniedNavigationError(url)
  }

  private async assertUrlAllowed(url: string, policy: BrowserAgentPolicy): Promise<void> {
    if (!await this.urlAllowed(url, policy)) {
      throw new BrowserRuntimeError('domain_denied', `URL is blocked by the agent domain policy: ${redactBrowserUrl(url)}`)
    }
  }

  private urlAllowed(url: string, policy: BrowserAgentPolicy): Promise<boolean> {
    return this.networkPolicy.allows(url, policy)
  }

  private ensureBrowser(requestedMode: BrowserMode = this.mode): Promise<Browser> {
    return this.serializeBrowserTransition(async () => {
      if (this.browser?.connected && this.activeMode === requestedMode) {
        return this.browser
      }
      await this.stopBrowser()
      return this.launchBrowser(requestedMode)
    })
  }

  private async launchBrowser(requestedMode: BrowserMode): Promise<Browser> {
    const executablePath = this.resolveExecutablePath()
    if (!executablePath) {
      throw new BrowserRuntimeError('browser_unavailable', 'A supported Chrome installation was not found.')
    }
    await fs.mkdir(this.options.profilePath, { recursive: true })
    try {
      const browser = await puppeteer.launch({
        executablePath,
        headless: requestedMode === 'headless',
        userDataDir: this.options.profilePath,
        acceptInsecureCerts: this.options.allowHttpLocalhost === true,
        args: launchArguments(this.launchProfile),
      })
      this.attachBrowser(browser, requestedMode)
      return browser
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw new BrowserRuntimeError('browser_unavailable', 'Chrome could not be started.', true)
    }
  }

  private attachBrowser(browser: Browser, activeMode?: BrowserMode): void {
    browser.once('disconnected', () => {
      if (this.browser !== browser) return
      this.browser = null
      this.activeMode = undefined
      this.pages.clear()
      this.assignmentContexts.clear()
      for (const creation of this.contextCreations.values()) {
        creation.state.invalidated = true
      }
      this.contextCreations.clear()
    })
    this.browser = browser
    this.activeMode = activeMode
    delete this.lastError
  }

  private async serializeBrowserTransition<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    let release: (() => void) | undefined
    const previous = this.browserTransition
    this.browserTransition = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }

  private async readExistingBrowserEndpoint(): Promise<string | undefined> {
    let contents: string
    try {
      contents = await fs.readFile(
        path.join(this.options.profilePath, 'DevToolsActivePort'),
        'utf8',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const [portText, endpointPath] = contents.trim().split(/\r?\n/, 2)
    const port = Number(portText)
    if (
      !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || !endpointPath
      || !/^\/devtools\/browser\/[a-zA-Z0-9._-]+$/.test(endpointPath)
    ) {
      return undefined
    }
    return `ws://127.0.0.1:${port}${endpointPath}`
  }

  private resolveExecutablePath(): string | undefined {
    return resolveBrowserExecutablePath(this.options.executablePath)
  }

  private async cleanupExpiredPages(): Promise<void> {
    const cutoff = this.now() - (this.options.pageTtlMs ?? DEFAULT_PAGE_TTL_MS)
    const expired = [...this.pages.values()].filter((entry) => entry.lastUsedAt < cutoff)
    await Promise.all(expired.map(async (entry) => {
      this.pages.delete(entry.pageId)
      await disposeRefs(entry.refs)
      await entry.page.close().catch(() => undefined)
    }))
  }
}

export function youtubeBrowserFrameFileName(index: number, stepId: string): string {
  if (!Number.isSafeInteger(index) || index < 0 || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(stepId)) {
    throw new BrowserRuntimeError('invalid_request', 'YouTube frame step ID is invalid.')
  }
  return `browser-${String(index + 1).padStart(3, '0')}-${stepId}.png`
}

/**
 * The cache key for a scope's proxied context.
 *
 * The endpoint is part of the key so that a proxy host or port changed
 * mid-assignment cannot silently reuse a context still pointed at the old
 * server. The credentials deliberately are not: a rotated password against the
 * same endpoint should re-authenticate on the next page rather than fork a
 * context, and a key is exactly the kind of string a diagnostic prints.
 */
function proxiedContextKey(scopeKey: string, server: string): string {
  return `${proxiedContextKeyPrefix(scopeKey)}${server}`
}

function proxiedContextKeyPrefix(scopeKey: string): string {
  return `${scopeKey}\0proxied\0`
}

function cancelledBrowserAction(): BrowserRuntimeError {
  return new BrowserRuntimeError('cancelled', 'Browser action was cancelled.')
}

function assignmentKey(
  scope: Pick<
    BrowserExecutionScope,
    'sessionId' | 'runId' | 'assignmentId' | 'activityScopeId'
  >,
): string {
  return [
    scope.sessionId,
    scope.runId,
    scope.assignmentId,
    scope.activityScopeId ?? '',
  ].join('\0')
}

function success(action: BrowserAction, fields: Omit<BrowserToolOutput, 'ok' | 'action'> = {}): BrowserToolOutput {
  return { ok: true, action, ...fields }
}

function requireUrl(input: BrowserToolInput): string {
  if (!input.url?.trim()) throw new BrowserRuntimeError('invalid_request', `${input.action} requires url.`)
  return input.url.trim()
}

function requireRef(input: BrowserToolInput): string {
  if (!input.ref?.trim()) throw new BrowserRuntimeError('invalid_request', `${input.action} requires ref.`)
  return input.ref.trim()
}

function requireValue(input: BrowserToolInput): string {
  if (input.value === undefined) throw new BrowserRuntimeError('invalid_request', `${input.action} requires value.`)
  return input.value
}

function requireKey(input: BrowserToolInput): string {
  if (!input.key?.trim()) throw new BrowserRuntimeError('invalid_request', `${input.action} requires key.`)
  return input.key.trim()
}

function requireContentId(input: BrowserToolInput): string {
  if (!input.contentId?.trim()) {
    throw new BrowserRuntimeError('invalid_request', `${input.action} requires contentId.`)
  }
  return input.contentId.trim()
}

function requireQuery(input: BrowserToolInput): string {
  if (!input.query?.trim()) {
    throw new BrowserRuntimeError('invalid_request', `${input.action} requires query.`)
  }
  return input.query.trim()
}

function requireSnapshotHash(managed: ManagedPage, snapshotId: string | undefined): string {
  if (!snapshotId?.trim()) {
    throw new BrowserRuntimeError('invalid_request', 'Waiting for change requires snapshotId.')
  }
  const hash = managed.snapshotHashes.get(snapshotId.trim())
  if (!hash) throw new BrowserRuntimeError('invalid_request', 'Browser snapshot is stale or unavailable.')
  return hash
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_TIMEOUT_MS) {
    throw new BrowserRuntimeError('invalid_request', 'timeoutMs must be between 100 and 600000.')
  }
  return value
}

function normalizeWait(value: number | undefined): number {
  if (value === undefined) return 2_000
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_TIMEOUT_MS) {
    throw new BrowserRuntimeError('invalid_request', 'waitMs must be between 100 and 600000.')
  }
  return value
}

function boundUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= maxBytes) return { value, truncated: false }
  const suffix = '\n[truncated]'
  const maximumPrefixBytes = Math.max(
    0,
    maxBytes - Buffer.byteLength(suffix, 'utf8'),
  )
  let prefix = buffer.subarray(0, maximumPrefixBytes).toString('utf8')
  while (Buffer.byteLength(prefix, 'utf8') > maximumPrefixBytes) {
    prefix = prefix.slice(0, -1)
  }
  return {
    value: `${prefix}${suffix}`,
    truncated: true,
  }
}

function staleElement(ref: string): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'element_not_found',
    `Browser element ${ref} is stale or missing. Observe the page again.`,
    true,
  )
}

function formatSnapshotContent(
  blocks: readonly BrowserContentBlockView[],
  renderedText: string,
): string {
  const structured = blocks.map((block) => {
    switch (block.type) {
      case 'heading': return `${'#'.repeat(Math.max(1, Math.min(block.level ?? 2, 6)))} ${block.text}`
      case 'list_item': return `- ${block.text}`
      case 'quote': return block.text.split('\n').map((line) => `> ${line}`).join('\n')
      case 'code': return `\`\`\`\n${block.text}\n\`\`\``
      case 'table': return block.text
      default: return block.text
    }
  }).join('\n\n')
  if (!structured) return renderedText
  return `${structured}\n\n--- Rendered page text ---\n\n${renderedText}`
}

function isSemanticallyEmpty(snapshot: CapturedBrowserSnapshot): boolean {
  return (
    !snapshot.text.trim() &&
    snapshot.elements.length === 0 &&
    snapshot.blocks.length === 0 &&
    !snapshot.visual.recommended
  )
}

async function waitForUsablePageContent(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const text = document.body?.innerText?.trim() ?? ''
    return text.length > 0 || Boolean(document.querySelector(
      'a[href], button, input, textarea, select, img, canvas, video, svg',
    ))
  }, { timeout: 1_500 }).catch(() => undefined)
}

async function revealYoutubeTranscript(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await page.evaluate(() => {
      const visible = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      const label = (element: HTMLElement): string => (
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.innerText ||
        element.textContent ||
        ''
      ).trim().toLocaleLowerCase()
      const candidates = [...document.querySelectorAll<HTMLElement>(
        'button, tp-yt-paper-button, ytd-menu-service-item-renderer, yt-button-shape',
      )].filter(visible)
      const transcriptSectionButton = document.querySelector<HTMLElement>(
        'ytd-video-description-transcript-section-renderer button, ' +
        'ytd-video-description-transcript-section-renderer tp-yt-paper-button',
      )
      if (transcriptSectionButton && visible(transcriptSectionButton)) {
        transcriptSectionButton.click()
        return 'transcript'
      }
      const transcript = candidates.find((element) => {
        const text = label(element)
        return text === 'show transcript' || text === 'transcript' || text.includes('show transcript')
      })
      if (transcript) {
        transcript.click()
        return 'transcript'
      }
      const expand = document.querySelector<HTMLElement>(
        '#description-inline-expander #expand, ytd-text-inline-expander #expand, tp-yt-paper-button#expand',
      )
      if (expand && visible(expand)) {
        expand.click()
        return 'expand'
      }
      const more = candidates.find((element) => {
        const text = label(element)
        return text === 'more actions' || text === 'more' || text.includes('more actions')
      })
      if (more) {
        more.click()
        return 'more'
      }
      return 'none'
    })
    if (result === 'transcript') return
    await abortableDelay(result === 'none' ? 750 : 400)
  }
}

function parseYoutubeTimestamp(value: string): number {
  const parts = value.trim().split(':').map((part) => Number(part))
  const [first, second, third] = parts
  if (
    first === undefined ||
    second === undefined ||
    parts.length > 3 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) return 0
  const seconds = third === undefined
    ? first * 60 + second
    : first * 3600 + second * 60 + third
  return Math.round(seconds * 1_000)
}

async function disposeRefs(refs: ReadonlyMap<string, ElementHandle<Element>>): Promise<void> {
  await Promise.all([...refs.values()].map((handle) => handle.dispose().catch(() => undefined)))
  if (refs instanceof Map) refs.clear()
}

async function waitForPageCondition(
  page: Page,
  waitFor: NonNullable<BrowserToolInput['waitFor']>,
  query: string | undefined,
  baseline: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new BrowserRuntimeError('cancelled', 'Browser action was cancelled.')
    if (waitFor === 'url' && page.url().includes(query ?? '')) return
    if (waitFor === 'change' && await pageStateHash(page) !== baseline) return
    if (waitFor === 'text' || waitFor === 'element') {
      for (const frame of page.frames()) {
        const found = await frame.evaluate(({ kind, needle }) => {
          const roots: Array<Document | ShadowRoot> = [document]
          const elements: HTMLElement[] = []
          for (let root = roots.shift(); root; root = roots.shift()) {
            for (const element of root.querySelectorAll<HTMLElement>('*')) {
              elements.push(element)
              if (element.shadowRoot) roots.push(element.shadowRoot)
            }
          }
          const normalized = needle.toLocaleLowerCase()
          if (kind === 'text') {
            const bodyText = document.body?.innerText.toLocaleLowerCase() ?? ''
            return bodyText.includes(normalized) ||
              elements.some((element) => element.shadowRoot?.textContent?.toLocaleLowerCase().includes(normalized))
          }
          return elements.some((element) => {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return false
            const name = (
              element.getAttribute('aria-label') ||
              element.getAttribute('title') ||
              (element instanceof HTMLInputElement ? element.placeholder : '') ||
              element.innerText ||
              element.textContent ||
              ''
            ).toLocaleLowerCase()
            return name.includes(normalized)
          })
        }, { kind: waitFor, needle: query ?? '' }).catch(() => false)
        if (found) return
      }
    }
    await abortableDelay(250, signal)
  }
  throw new BrowserRuntimeError('timeout', `Browser wait for ${waitFor} timed out.`, true)
}

async function pageStateHash(page: Page): Promise<string> {
  const state = await page.evaluate(() => `${location.href}\0${document.body?.innerText ?? ''}`)
  return createHash('sha256').update(state).digest('hex')
}

async function settlePage(page: Page, timeoutMs: number, strict = false): Promise<void> {
  try {
    await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.min(timeoutMs, 5_000) })
  } catch (error) {
    if (strict) throw error
  }
}

async function waitForDownload(downloadDir: string, before: ReadonlySet<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const names = await fs.readdir(downloadDir)
    for (const name of names) {
      if (before.has(name)) continue
      const target = path.join(downloadDir, name)
      const stat = await fs.stat(target).catch(() => null)
      if (stat && stat.size > MAX_DOWNLOAD_BYTES) {
        await fs.rm(target, { force: true }).catch(() => undefined)
        throw new BrowserRuntimeError('download_too_large', 'Browser download exceeded 100 MB.')
      }
      if (!name.endsWith('.crdownload') && stat?.isFile()) return target
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new BrowserRuntimeError('timeout', 'Browser download did not finish before the timeout.', true)
}

async function attachmentView(
  assignmentPath: string,
  target: string,
  kind: BrowserAttachmentView['kind'],
): Promise<BrowserAttachmentView> {
  const stat = await fs.stat(target)
  return {
    id: randomUUID(),
    kind,
    name: path.basename(target),
    relativePath: path.relative(assignmentPath, target).split(path.sep).join('/'),
    mimeType: mimeTypeForName(target),
    sizeBytes: stat.size,
  }
}

function mimeTypeForName(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.pdf': return 'application/pdf'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.json': return 'application/json'
    case '.csv': return 'text/csv'
    case '.txt': return 'text/plain'
    case '.html': return 'text/html'
    default: return 'application/octet-stream'
  }
}

async function withAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  action: BrowserAction,
  extraGuard?: Promise<never>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  let abortHandler: (() => void) | undefined
  const guards: Promise<never>[] = [new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new BrowserRuntimeError('timeout', `Browser ${action} action timed out.`, true)), timeoutMs)
  })]
  if (signal) {
    guards.push(new Promise((_, reject) => {
      const handler = () => reject(new BrowserRuntimeError('cancelled', 'Browser action was cancelled.'))
      abortHandler = handler
      signal.addEventListener('abort', handler, { once: true })
    }))
  }
  if (extraGuard) guards.push(extraGuard)
  try {
    return await Promise.race([promise, ...guards])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

function deniedNavigationError(url: string): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'domain_denied',
    `Navigation was blocked by the agent domain policy: ${redactBrowserUrl(url)}`,
  )
}

function redactBrowserUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '[invalid URL]'
  }
}

async function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new BrowserRuntimeError('cancelled', 'Browser action was cancelled.')
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new BrowserRuntimeError('cancelled', 'Browser action was cancelled.'))
    }
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    timer = setTimeout(finish, durationMs)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * The launch arguments each compared profile uses.
 *
 * `automation-controlled-disabled` differs from `stock` by exactly one flag, so
 * a difference in the bake-off cannot come from anything else. It is never the
 * production default.
 *
 * Exported so the opt-in bake-off harness launches the profiles this manager
 * would launch. A second copy of the flag list in a test would let the two
 * drift, and a comparison between drifted builds measures the drift.
 */
export function launchArguments(profile: BrowserLaunchProfile): string[] {
  const stock = ['--no-first-run', '--no-default-browser-check']
  return profile === 'automation-controlled-disabled'
    ? [...stock, '--disable-blink-features=AutomationControlled']
    : stock
}

let cachedPuppeteerCoreVersion: string | undefined

/**
 * The installed driver version, read from the package that is actually loaded.
 *
 * The manifest stays `unknown` and is checked rather than asserted: it is a file
 * on disk that this repository does not write, so a shape claim about it would
 * be a guess that a malformed install turns into a runtime surprise.
 */
function puppeteerCoreVersion(): string {
  if (cachedPuppeteerCoreVersion) return cachedPuppeteerCoreVersion
  cachedPuppeteerCoreVersion = 'unknown'
  try {
    const manifest: unknown = createRequire(import.meta.url)(
      'puppeteer-core/package.json',
    )
    if (
      manifest !== null &&
      typeof manifest === 'object' &&
      'version' in manifest &&
      typeof manifest.version === 'string' &&
      manifest.version.length > 0
    ) {
      cachedPuppeteerCoreVersion = manifest.version
    }
  } catch {
    // A driver that cannot describe itself is reported as `unknown` rather than
    // failing the read it was only annotating.
  }
  return cachedPuppeteerCoreVersion
}
