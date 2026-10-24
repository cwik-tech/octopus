import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// The standalone executable unpacks its Python runtime before reporting a
// version. Cold unpacking can exceed 30 seconds under filesystem load.
export const YT_DLP_VERSION_PROBE_TIMEOUT_MS = 60_000

interface BinaryRecord {
  readonly file: string
  readonly version: string
  readonly sha256: string
}

interface BinaryManifest {
  readonly binaryManifestSchemaVersion: 1
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly tools: {
    readonly 'yt-dlp': BinaryRecord
    readonly ffmpeg: BinaryRecord
    readonly ffprobe: BinaryRecord
  }
}

export interface ResolvedYoutubeBinary extends BinaryRecord {
  readonly path: string
}

export interface ResolvedYoutubeBinaries {
  readonly source: 'packaged' | 'development'
  readonly ytDlp: ResolvedYoutubeBinary
  readonly ffmpeg: ResolvedYoutubeBinary
  readonly ffprobe: ResolvedYoutubeBinary
}

export async function resolveYoutubeBinaries(options: {
  readonly isPackaged?: boolean
  readonly resourcesPath?: string
  readonly developmentDirectory?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}): Promise<ResolvedYoutubeBinaries> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const source = options.isPackaged ? 'packaged' : 'development'
  const root = options.isPackaged
    ? options.resourcesPath && path.join(options.resourcesPath, 'youtube-tools')
    : options.developmentDirectory
  if (!root) throw new Error('Bundled YouTube tools are unavailable.')
  const directory = path.join(root, `${platform}-${arch}`)
  const manifest = parseManifest(JSON.parse(
    await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
  ), platform, arch)
  const [ytDlp, ffmpeg, ffprobe] = await Promise.all([
    verifyBinary(directory, manifest.tools['yt-dlp'], 'yt-dlp'),
    verifyBinary(directory, manifest.tools.ffmpeg, 'ffmpeg'),
    verifyBinary(directory, manifest.tools.ffprobe, 'ffprobe'),
  ])
  await verifyFfmpegFilters(ffmpeg.path)
  return { source, ytDlp, ffmpeg, ffprobe }
}

async function verifyFfmpegFilters(ffmpegPath: string): Promise<void> {
  const result = await execFileAsync(ffmpegPath, ['-hide_banner', '-filters'], {
    timeout: 10_000,
    maxBuffer: 4 * 1_024 * 1_024,
    windowsHide: true,
    env: { LANG: 'C', LC_ALL: 'C' },
  })
  for (const filter of ['signalstats', 'blurdetect']) {
    if (!new RegExp(`\\b${filter}\\b`).test(result.stdout)) {
      throw new Error(`Bundled FFmpeg does not expose required filter ${filter}.`)
    }
  }
}

async function verifyBinary(
  directory: string,
  record: BinaryRecord,
  tool: 'yt-dlp' | 'ffmpeg' | 'ffprobe',
): Promise<ResolvedYoutubeBinary> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(record.file)) {
    throw new Error(`Bundled ${tool} filename is invalid.`)
  }
  const filePath = path.join(directory, record.file)
  const stat = await fs.lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Bundled ${tool} is not a safe executable file.`)
  }
  const checksum = createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
  if (checksum !== record.sha256) throw new Error(`Bundled ${tool} checksum does not match.`)
  const args = tool === 'yt-dlp' ? ['--version'] : ['-version']
  const result = await execFileAsync(filePath, args, {
    timeout: tool === 'yt-dlp' ? YT_DLP_VERSION_PROBE_TIMEOUT_MS : 10_000,
    maxBuffer: 64 * 1_024,
    windowsHide: true,
    env: { LANG: 'C', LC_ALL: 'C' },
  })
  if (!result.stdout.includes(record.version)) {
    throw new Error(`Bundled ${tool} version does not match.`)
  }
  return { ...record, path: filePath }
}

function parseManifest(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
): BinaryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidManifest()
  const manifest = value as Record<string, unknown>
  if (
    manifest.binaryManifestSchemaVersion !== 1 ||
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    !manifest.tools || typeof manifest.tools !== 'object' || Array.isArray(manifest.tools)
  ) invalidManifest()
  const tools = manifest.tools as Record<string, unknown>
  for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    const record = tools[name]
    if (!record || typeof record !== 'object' || Array.isArray(record)) invalidManifest()
    const fields = record as Record<string, unknown>
    if (
      typeof fields.file !== 'string' ||
      typeof fields.version !== 'string' || !fields.version.trim() ||
      typeof fields.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fields.sha256)
    ) invalidManifest()
  }
  return value as BinaryManifest
}

function invalidManifest(): never {
  throw new Error('Bundled YouTube binary manifest is invalid.')
}
