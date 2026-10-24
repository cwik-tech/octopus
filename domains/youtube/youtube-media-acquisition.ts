import { whenDefined } from '../../core/optional-properties.js'
import { rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { runYoutubeProcess } from './youtube-process.js'
import { isUnknownArray } from '../../core/unknown-array.js'

const BASE_HEADROOM_BYTES = 256 * 1_024 * 1_024
const FRAME_HEADROOM_BYTES = 8 * 1_024 * 1_024
const COOKIE_EXPORT_LIFETIME_SECONDS = 24 * 60 * 60
/** RFC 6265 `cookie-name`: a token, so no tab or newline can forge a jar line. */
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
/** RFC 6265 `cookie-octet`: printable ASCII without space, `"`, `,`, `;`, `\`. */
const COOKIE_VALUE_PATTERN = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/
/**
 * The cookies that carry the account session itself. A profile that has only
 * watched YouTube while signed out still holds consent, preference and visitor
 * cookies for the same domain, so a jar alone says nothing about a sign-in.
 */
const SESSION_COOKIE_NAMES = new Set([
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PSID', '__Secure-3PSID',
])
/** Jar directories written but not yet wiped. */
const liveCookieDirectories = new Set<string>()

// A `finally` cannot run when the application quits mid-download, so the jars
// still on disk are wiped here, the way `youtube-process` reaps its orphaned
// process groups. Exit handlers cannot await, hence the synchronous removal.
process.once('exit', () => {
  for (const directory of liveCookieDirectories) {
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* nothing further is possible at exit */ }
  }
})

export function youtubeFrameHeadroomBytes(expectedFrameCount: number): number {
  return BASE_HEADROOM_BYTES + Math.max(0, expectedFrameCount) * FRAME_HEADROOM_BYTES
}

export interface YoutubeDiskPreflight {
  readonly estimatedMediaBytes: number
  readonly frameHeadroomBytes: number
  readonly requiredBytes: number
  readonly availableBytes: number
  readonly estimateSource: 'declared' | 'approximate' | 'maximum'
  readonly recheckedBeforeCommit: boolean
}

export interface YoutubeDownloadedMedia {
  readonly path: string
  readonly byteLength: number
  readonly durationSeconds: number
  readonly width: number
  readonly height: number
  readonly container?: string
  readonly sha256?: string
  /**
   * Whether the download presented the application profile's YouTube session.
   * The fact alone: no cookie name, value, header, or jar path travels with it.
   */
  /**
   * Whether the profile's account session was presented to yt-dlp. Absent on a
   * bundle downloaded before this field existed, where the truth is unknown and
   * `false` would assert an anonymous download that may never have happened.
   */
  readonly usedProfileSession?: boolean
  readonly diskPreflight: YoutubeDiskPreflight
}

export interface YoutubeMediaDownloadRequest {
  readonly ytDlpPath: string
  readonly ffmpegPath?: string
  readonly ffprobePath: string
  readonly url: string
  readonly workingDirectory: string
  readonly maximumMediaBytes: number
  readonly maximumDurationSeconds: number
  readonly expectedFrameCount?: number
  readonly diskSpaceBytes?: () => Promise<number>
  /**
   * Parent-process-only. Reads the application profile's YouTube cookie header
   * so a signed-in download can pass the bot check. The header is exported to a
   * private jar for yt-dlp and is never returned, logged, or surfaced. The read
   * may start a stopped profile, so it is given this download's cancellation.
   */
  readonly youtubeCookieHeader?: (
    options: { readonly signal?: AbortSignal },
  ) => Promise<string | undefined>
  /**
   * Receives whether the profile's sign-in was presented, before the first
   * yt-dlp call, so a download that fails can still be recorded as signed-in or
   * anonymous. It carries that fact alone and no cookie of any kind.
   */
  readonly onProfileSession?: (usedProfileSession: boolean) => void
  readonly signal?: AbortSignal
}

export async function downloadYoutubeMedia(
  input: YoutubeMediaDownloadRequest,
): Promise<YoutubeDownloadedMedia> {
  if (!/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(input.url)) {
    throw new Error('Media acquisition requires a canonical public YouTube video URL.')
  }
  await ensureSafeDirectory(input.workingDirectory)
  // A run cancelled before the download starts reads no profile and writes no
  // jar. The read carries the same signal, because it may start a stopped
  // profile: it checks the signal before starting one and again once the
  // profile is up, so a cancellation landing mid-launch still exports no jar.
  // The launch itself takes no signal, so such a cancellation is observed when
  // the launch returns rather than while Chrome is still coming up.
  const cookies = input.signal?.aborted
    ? undefined
    : await exportYoutubeCookies(input.youtubeCookieHeader, input.signal)
  // Reported before the first yt-dlp call so a download that fails is still
  // recorded as signed-in or anonymous. The fact alone travels.
  input.onProfileSession?.(cookies?.signedIn === true)
  try {
    return await acquireYoutubeMedia(input, cookies)
  } catch (error) {
    throw withoutCookieTraces(error, cookies)
  } finally {
    // Every exit removes the jar, cancellation and failure included. A wipe
    // that cannot run must not replace the result the block already has, so it
    // reports nothing and leaves the directory to the exit handler.
    if (cookies) await removeCookieDirectory(path.dirname(cookies.path))
  }
}

async function acquireYoutubeMedia(
  input: YoutubeMediaDownloadRequest,
  cookies: YoutubeCookieExport | undefined,
): Promise<YoutubeDownloadedMedia> {
  const cookiesPath = cookies?.path
  const format = [
    'best[height<=1080][ext=mp4]',
    'bestvideo[height<=1080][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]',
    'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]',
    'bestvideo[height<=1080]+bestaudio',
    'best[height<=1080]',
  ].join('/')
  const metadataResult = await runYoutubeProcess(input.ytDlpPath, [
    '--ignore-config', '--no-playlist', '--no-update', '--no-warnings', '--no-progress',
    '--js-runtimes', `node:${process.execPath}`,
    ...cookieArguments(cookiesPath),
    '--simulate', '--print', '%(.{filesize,filesize_approx,duration,requested_formats})j', '-f', format, input.url,
  ], { ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })) })
  const metadata = parseDownloadMetadata(metadataResult.stdout)
  if (metadata.durationSeconds !== undefined && metadata.durationSeconds > input.maximumDurationSeconds) {
    throw new Error('The YouTube video exceeds the maximum duration.')
  }
  if (metadata.byteLength !== undefined && metadata.byteLength > input.maximumMediaBytes) {
    // `--max-filesize` is enforced per format, so a merged bestvideo+bestaudio
    // download can exceed the limit by up to the audio stream's size before the
    // post-download stat check rejects it. The declared metadata (including the
    // requested_formats sum) is known before any bytes move — reject here so
    // oversized downloads fail before bandwidth and disk are spent.
    throw new Error('The YouTube video exceeds the maximum media size.')
  }
  const estimatedMediaBytes = Math.min(metadata.byteLength ?? input.maximumMediaBytes, input.maximumMediaBytes)
  const estimateSource = metadata.source ?? 'maximum'
  const frameHeadroomBytes = youtubeFrameHeadroomBytes(input.expectedFrameCount ?? 50)
  const readDiskSpace = input.diskSpaceBytes ?? (() => diskSpace(input.workingDirectory))
  const initialSpace = await readDiskSpace()
  const requiredBytes = estimatedMediaBytes + frameHeadroomBytes
  if (initialSpace < requiredBytes) {
    throw new Error('There is not enough free disk space for the temporary video and screenshots.')
  }
  const mediaPath = path.join(input.workingDirectory, 'source-video.mp4')
  const downloadPath = path.join(input.workingDirectory, 'source-video.download.mp4')
  const partPath = `${downloadPath}.part`
  try {
    const downloadArgs = [
      '--ignore-config', '--no-playlist', '--no-update', '--no-warnings', '--no-progress',
      '--js-runtimes', `node:${process.execPath}`,
      '--no-part', '--socket-timeout', '30', '--retries', '2', '--fragment-retries', '2',
      '--max-filesize', String(input.maximumMediaBytes), '-f', format,
      ...cookieArguments(cookiesPath),
      ...(input.ffmpegPath ? ['--ffmpeg-location', input.ffmpegPath, '--merge-output-format', 'mp4'] : []),
      '-o', downloadPath, input.url,
    ]
    await runYoutubeDownloadWithTransientRetry({
      executable: input.ytDlpPath,
      args: downloadArgs,
      downloadPath,
      ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
    })
    const stat = await fs.lstat(downloadPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > input.maximumMediaBytes) {
      throw new Error('Downloaded YouTube media failed file validation.')
    }
    const remainingSpace = await readDiskSpace()
    if (remainingSpace < frameHeadroomBytes) {
      throw new Error('Free disk space became insufficient before the media commit.')
    }
    const probeResult = await runYoutubeProcess(input.ffprobePath, [
      '-v', 'error', '-show_entries',
      'format=duration,size,format_name:stream=codec_type,width,height',
      '-of', 'json', downloadPath,
    ], { ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })) })
    const probe = JSON.parse(probeResult.stdout) as {
      readonly format?: { readonly duration?: string; readonly size?: string; readonly format_name?: string }
      readonly streams?: readonly { readonly codec_type?: string; readonly width?: number; readonly height?: number }[]
    }
    const video = probe.streams?.find((stream) => stream.codec_type === 'video')
    const audio = probe.streams?.find((stream) => stream.codec_type === 'audio')
    const width = video?.width
    const height = video?.height
    const durationSeconds = Number(probe.format?.duration)
    const byteLength = Number(probe.format?.size)
    if (
      !video || !audio || width === undefined || height === undefined ||
      !Number.isFinite(width) || !Number.isFinite(height) ||
      !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      durationSeconds > input.maximumDurationSeconds ||
      !Number.isSafeInteger(byteLength) || byteLength !== stat.size
    ) throw new Error('Downloaded YouTube media must contain valid audio and video streams.')
    await fs.rename(downloadPath, mediaPath)
    return {
      path: mediaPath,
      byteLength,
      durationSeconds,
      width,
      height,
      ...(probe.format?.format_name ? { container: probe.format.format_name } : {}),
      usedProfileSession: cookies?.signedIn === true,
      diskPreflight: {
        estimatedMediaBytes,
        frameHeadroomBytes,
        requiredBytes,
        availableBytes: initialSpace,
        estimateSource,
        recheckedBeforeCommit: true,
      },
    }
  } catch (error) {
    await Promise.all([
      fs.rm(mediaPath, { force: true }),
      fs.rm(downloadPath, { force: true }),
      fs.rm(partPath, { force: true }),
    ])
    throw error
  }
}

interface YoutubeCookieExport {
  readonly path: string
  readonly values: readonly string[]
  /** Whether the exported jar carries the profile's account session. */
  readonly signedIn: boolean
}

function cookieArguments(cookiesPath: string | undefined): readonly string[] {
  return cookiesPath ? ['--cookies', cookiesPath] : []
}

/**
 * Write the profile's YouTube cookies as a Netscape jar for yt-dlp.
 *
 * Parent-process-only, and deliberately outside the run bundle: the jar holds
 * the signed-in session, so it lives in a private temporary directory the
 * caller removes on every exit and never in an artifact path. The header the
 * browser returns carries no attributes, so every line declares the profile's
 * own host-wide `.youtube.com` scope. A profile that cannot be read is the same
 * as one with no sign-in, and the download proceeds without cookies.
 *
 * A jar that cannot be written is treated the same way, and its own failure
 * never leaves this function: the fs error names the jar, and a partial file
 * holding real session cookies must not outlive the attempt.
 *
 * Every readable cookie is exported, since consent and preference cookies also
 * belong to the request, but only an account cookie among them makes the export
 * a sign-in. That is the one fact the caller reports.
 */
async function exportYoutubeCookies(
  readHeader?: (options: { readonly signal?: AbortSignal }) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<YoutubeCookieExport | undefined> {
  const header = await readHeader?.({
    ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
  }).catch(() => undefined)
  const expiresAt = Math.floor(Date.now() / 1_000) + COOKIE_EXPORT_LIFETIME_SECONDS
  const cookies = (header ?? '').split(';').flatMap((pair) => {
    const separator = pair.indexOf('=')
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    return separator > 0 && COOKIE_NAME_PATTERN.test(name) && COOKIE_VALUE_PATTERN.test(value)
      ? [{ name, value }]
      : []
  })
  if (cookies.length === 0) return undefined
  const directory = await fs
    .mkdtemp(path.join(os.tmpdir(), 'youtube-cookies-'))
    .catch(() => undefined)
  if (!directory) return undefined
  liveCookieDirectories.add(directory)
  const cookiesPath = path.join(directory, 'cookies.txt')
  try {
    await fs.writeFile(cookiesPath, [
      '# Netscape HTTP Cookie File',
      ...cookies.map((cookie) =>
        `.youtube.com\tTRUE\t/\tTRUE\t${expiresAt}\t${cookie.name}\t${cookie.value}`),
      '',
    ].join('\n'), { mode: 0o600 })
  } catch {
    await removeCookieDirectory(directory)
    return undefined
  }
  return {
    path: cookiesPath,
    values: cookies.map((cookie) => cookie.value),
    signedIn: cookies.some((cookie) => SESSION_COOKIE_NAMES.has(cookie.name)),
  }
}

/** Wipes a jar directory, keeping it tracked when the wipe could not run. */
async function removeCookieDirectory(directory: string): Promise<void> {
  const removed = await fs
    .rm(directory, { recursive: true, force: true })
    .then(() => true, () => false)
  if (removed) liveCookieDirectories.delete(directory)
}

/**
 * yt-dlp can name the jar it failed to read, and a verbose run can echo what it
 * loaded. Neither may leave this function, so both are removed from the error
 * the caller sees. Short values are left alone: they are not session secrets
 * and replacing them would mangle unrelated text.
 */
function withoutCookieTraces(error: unknown, cookies: YoutubeCookieExport | undefined): unknown {
  if (!cookies || !(error instanceof Error)) return error
  const traces = [cookies.path, ...cookies.values.filter((value) => value.length >= 8)]
  const message = traces.reduce(
    (current, trace) => current.split(trace).join('[redacted]'),
    error.message,
  )
  if (message === error.message) return error
  const redacted = new Error(message)
  redacted.name = error.name
  return redacted
}

async function runYoutubeDownloadWithTransientRetry(input: {
  readonly executable: string
  readonly args: readonly string[]
  readonly downloadPath: string
  readonly signal?: AbortSignal
}): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await runYoutubeProcess(input.executable, input.args, { ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })) })
      return
    } catch (error) {
      if (
        attempt === 2 ||
        input.signal?.aborted ||
        !(error instanceof Error) ||
        !/HTTP Error 403: Forbidden/i.test(error.message)
      ) throw error
      await removeYoutubeDownloadAttemptFiles(input.downloadPath)
    }
  }
}

async function removeYoutubeDownloadAttemptFiles(downloadPath: string): Promise<void> {
  const directory = path.dirname(downloadPath)
  const extension = path.extname(downloadPath)
  const baseName = path.basename(downloadPath)
  const fragmentPrefix = `${path.basename(downloadPath, extension)}.f`
  const entries = await fs.readdir(directory)
  await Promise.all(entries
    .filter((entry) =>
      entry === baseName ||
      entry === `${baseName}.part` ||
      (entry.startsWith(fragmentPrefix) && (entry.endsWith(extension) || entry.endsWith(`${extension}.part`))),
    )
    .map((entry) => fs.rm(path.join(directory, entry), { force: true })))
}

function parseDownloadMetadata(text: string): {
  readonly byteLength?: number
  readonly durationSeconds?: number
  readonly source?: 'declared' | 'approximate'
} {
  let value: Record<string, unknown>
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    value = parsed as Record<string, unknown>
  } catch {
    throw new Error('The yt-dlp metadata response was invalid.')
  }
  const declared = Number(value.filesize)
  const approximate = Number(value.filesize_approx)
  const requestedFormats: readonly unknown[] = isUnknownArray(value.requested_formats)
    ? value.requested_formats
    : []
  let requestedBytes = 0
  let requestedBytesSource: 'declared' | 'approximate' = 'declared'
  for (const format of requestedFormats) {
    if (!format || typeof format !== 'object' || Array.isArray(format)) continue
    const formatDeclared = 'filesize' in format ? Number(format.filesize) : Number.NaN
    const formatApproximate = 'filesize_approx' in format
      ? Number(format.filesize_approx)
      : Number.NaN
    if (Number.isSafeInteger(formatDeclared) && formatDeclared > 0) {
      requestedBytes += formatDeclared
    } else if (Number.isSafeInteger(formatApproximate) && formatApproximate > 0) {
      requestedBytes += formatApproximate
      requestedBytesSource = 'approximate'
    }
  }
  const duration = Number(value.duration)
  return {
    ...(Number.isSafeInteger(declared) && declared > 0
      ? { byteLength: declared, source: 'declared' as const }
      : Number.isSafeInteger(approximate) && approximate > 0
        ? { byteLength: approximate, source: 'approximate' as const }
        : Number.isSafeInteger(requestedBytes) && requestedBytes > 0
          ? { byteLength: requestedBytes, source: requestedBytesSource }
        : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('YouTube media output must be a safe real directory.')
  }
}

async function diskSpace(directory: string): Promise<number> {
  const stat = await fs.statfs(directory)
  const availableBytes = Number(stat.bavail) * Number(stat.bsize)
  if (!Number.isFinite(availableBytes)) throw new Error('Free disk space is unavailable.')
  return availableBytes
}
