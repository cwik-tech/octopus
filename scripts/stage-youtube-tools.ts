import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { YT_DLP_VERSION_PROBE_TIMEOUT_MS } from '../domains/youtube/youtube-binary-resolver.js'

const execFileAsync = promisify(execFile)

const platform = process.env.YOUTUBE_TOOLS_TARGET_PLATFORM ?? process.platform
const arch = process.env.YOUTUBE_TOOLS_TARGET_ARCH ?? process.arch
const outputRoot = path.resolve(
  process.env.YOUTUBE_TOOLS_OUTPUT_ROOT ?? path.join('build', 'youtube-tools'),
)
const inputs = [
  source('yt-dlp', process.env.YOUTUBE_YT_DLP_BINARY, process.env.YOUTUBE_YT_DLP_SHA256),
  source('ffmpeg', process.env.YOUTUBE_FFMPEG_BINARY, process.env.YOUTUBE_FFMPEG_SHA256),
  source('ffprobe', process.env.YOUTUBE_FFPROBE_BINARY, process.env.YOUTUBE_FFPROBE_SHA256),
] as const
const target = path.join(outputRoot, `${platform}-${arch}`)

await fs.mkdir(target, { recursive: true, mode: 0o700 })
const existing = await fs.readdir(target)
if (existing.length > 0) throw new Error(`YouTube tool target is not empty: ${target}`)

const tools: Record<string, { file: string; version: string; sha256: string }> = {}
for (const input of inputs) {
  const stat = await fs.lstat(input.path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${input.name} source is unsafe.`)
  const bytes = await fs.readFile(input.path)
  if (
    input.name === 'yt-dlp' &&
    process.env.YOUTUBE_TOOLS_ALLOW_SCRIPT_FIXTURES !== '1' &&
    !isStandaloneExecutable(bytes, platform)
  ) {
    throw new Error('The yt-dlp source must be a standalone executable, not an interpreter-dependent wrapper.')
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== input.sha256) throw new Error(`${input.name} source checksum does not match.`)
  const file = platform === 'win32' ? `${input.name}.exe` : input.name
  const targetPath = path.join(target, file)
  await fs.copyFile(input.path, targetPath)
  if (platform !== 'win32') await fs.chmod(targetPath, 0o755)
  const args = input.name === 'yt-dlp' ? ['--version'] : ['-version']
  const result = await execFileAsync(targetPath, args, {
    timeout: input.name === 'yt-dlp' ? YT_DLP_VERSION_PROBE_TIMEOUT_MS : 10_000,
    maxBuffer: 64 * 1_024,
  })
  const version = firstVersion(result.stdout)
  tools[input.name] = { file, version, sha256 }
}

await fs.writeFile(path.join(target, 'manifest.json'), `${JSON.stringify({
  binaryManifestSchemaVersion: 1,
  platform,
  arch,
  tools,
}, null, 2)}\n`, { mode: 0o600 })

function source(name: string, filePath: string | undefined, sha256: string | undefined) {
  if (!filePath || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Pinned ${name} binary path and SHA-256 are required.`)
  }
  return { name, path: path.resolve(filePath), sha256 }
}

function firstVersion(output: string): string {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) throw new Error('YouTube tool version output is empty.')
  const match = firstLine.match(/\d+(?:\.\d+)+(?:[-+._A-Za-z0-9]*)?/)
  return match?.[0] ?? firstLine.slice(0, 128)
}

function isStandaloneExecutable(bytes: Buffer, targetPlatform: string): boolean {
  if (targetPlatform === 'win32') return bytes[0] === 0x4d && bytes[1] === 0x5a
  if (targetPlatform === 'linux') {
    return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
  }
  if (targetPlatform === 'darwin') {
    const magic = bytes.subarray(0, 4).toString('hex')
    return ['cafebabe', 'bebafeca', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe'].includes(magic)
  }
  return false
}
