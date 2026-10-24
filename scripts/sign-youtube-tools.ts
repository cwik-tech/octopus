import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Signs the staged YouTube tools and rewrites `manifest.json` from the signed
 * bytes.
 *
 * electron-builder signs every Mach-O file it finds in the bundle, so a
 * checksum taken before packaging stops matching the packaged file and the
 * runtime resolver rejects the tools. Signing here, before `manifest.json` is
 * rewritten, keeps the exact-bytes pin intact. `build.mac.signIgnore` in
 * package.json stops electron-builder from signing them a second time.
 */

const toolNames = ['yt-dlp', 'ffmpeg', 'ffprobe'] as const

export interface YoutubeToolCodesignInvocation {
  readonly filePath: string
  readonly identity: string
  readonly args: readonly string[]
}

export type YoutubeToolCodesign = (invocation: YoutubeToolCodesignInvocation) => Promise<void>

export interface YoutubeToolSigningOptions {
  readonly directory: string
  readonly environment?: NodeJS.ProcessEnv
  readonly entitlements?: string
  readonly codesign?: YoutubeToolCodesign
  readonly listCodesigningIdentities?: () => Promise<readonly string[]>
}

export interface YoutubeToolSigningResult {
  readonly status: 'signed' | 'skipped'
  readonly identity: string | null
  readonly message: string
}

interface StagedTool {
  readonly file: string
  readonly version: string
  readonly sha256: string
  readonly sourceSha256: string
}

interface StagedManifest {
  readonly binaryManifestSchemaVersion: 1
  readonly platform: string
  readonly arch: string
  readonly tools: Record<string, StagedTool>
}

interface PendingTool {
  readonly name: string
  readonly record: StagedTool
  readonly filePath: string
}

type SigningIdentity =
  | { readonly kind: 'identity'; readonly identity: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unusable'; readonly reason: string }

export async function signStagedYoutubeTools(
  options: YoutubeToolSigningOptions,
): Promise<YoutubeToolSigningResult> {
  const manifestPath = path.join(options.directory, 'manifest.json')
  const manifest = await readStagedManifest(options.directory, manifestPath)
  const resolution = await resolveSigningIdentity(options)
  if (resolution.kind === 'unusable') throw new Error(resolution.reason)
  if (resolution.kind === 'none') {
    return {
      status: 'skipped',
      identity: null,
      message: `No macOS code signing identity found, leaving ${options.directory} unsigned. `
        + 'electron-builder cannot sign the bundled tools either, so the manifest checksums stay valid.',
    }
  }
  const { identity } = resolution
  const codesign = options.codesign ?? runCodesign
  const entitlements = options.entitlements ?? await resolveEntitlementsPath()
  // Check every staged file against its pinned checksum before signing any of
  // them. Signing rewrites the checksums, so a file substituted after
  // `youtube-tools:stage` would otherwise be re-pinned and pass the later
  // `youtube-tools:verify`.
  const pending = await readStagedTools(options.directory, manifest)
  const tools: Record<string, StagedTool> = { ...manifest.tools }
  for (const tool of pending) {
    try {
      await codesign({
        filePath: tool.filePath,
        identity,
        args: codesignArguments(tool.filePath, identity, entitlements),
      })
    } catch (error: unknown) {
      throw new Error(
        `Signing ${tool.name} in ${options.directory} failed: ${describe(error)}. `
        + 'Re-run npm run youtube-tools:sign to finish signing the bundle.',
        { cause: error },
      )
    }
    tools[tool.name] = {
      file: tool.record.file,
      version: tool.record.version,
      sha256: await checksum(tool.filePath),
      sourceSha256: tool.record.sourceSha256,
    }
    // Written after each tool so the manifest always describes the bytes on
    // disk, even when a later codesign call fails.
    await writeStagedManifest(manifestPath, manifest, tools)
  }
  return {
    status: 'signed',
    identity,
    message: `Signed ${toolNames.length} YouTube tools in ${options.directory} with ${identity} `
      + 'and rewrote manifest.json from the signed bytes.',
  }
}

async function readStagedManifest(directory: string, manifestPath: string): Promise<StagedManifest> {
  try {
    return parseStagedManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new Error(`No staged YouTube tools found in ${directory}; run npm run youtube-tools:stage first.`)
    }
    throw error
  }
}

async function readStagedTools(
  directory: string,
  manifest: StagedManifest,
): Promise<readonly PendingTool[]> {
  const pending: PendingTool[] = []
  for (const name of toolNames) {
    const record = manifest.tools[name]
    if (!record) throw new Error(`Staged YouTube manifest has no ${name} entry.`)
    const filePath = path.join(directory, record.file)
    if (await checksum(filePath) !== record.sha256) {
      throw new Error(`Staged ${name} does not match the recorded checksum; re-stage before signing.`)
    }
    pending.push({ name, record, filePath })
  }
  return pending
}

async function writeStagedManifest(
  manifestPath: string,
  manifest: StagedManifest,
  tools: Record<string, StagedTool>,
): Promise<void> {
  await fs.writeFile(manifestPath, `${JSON.stringify({
    binaryManifestSchemaVersion: manifest.binaryManifestSchemaVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    tools,
  }, null, 2)}\n`)
}

async function resolveSigningIdentity(
  options: YoutubeToolSigningOptions,
): Promise<SigningIdentity> {
  const environment = options.environment ?? process.env
  const configured = nonEmpty(environment.YOUTUBE_TOOLS_SIGN_IDENTITY) ?? nonEmpty(environment.CSC_NAME)
  if (configured) return { kind: 'identity', identity: configured }
  const identities = await (options.listCodesigningIdentities ?? listCodesigningIdentities)()
  // One certificate can appear once per keychain in the search list.
  const developerIds = [...new Set(
    identities.filter((entry) => entry.startsWith('Developer ID Application')),
  )]
  const only = developerIds[0]
  if (developerIds.length === 1 && only) return { kind: 'identity', identity: only }
  if (developerIds.length > 1) {
    return {
      kind: 'unusable',
      reason: `Found ${developerIds.length} Developer ID Application identities; `
        + 'set YOUTUBE_TOOLS_SIGN_IDENTITY to choose the one electron-builder will use.',
    }
  }
  if (nonEmpty(environment.CSC_LINK)) {
    // electron-builder imports CSC_LINK into a temporary keychain that
    // `security find-identity` never searches. Skipping here would leave the
    // tools unsigned inside an app electron-builder does sign, and signIgnore
    // keeps electron-builder away from them.
    return {
      kind: 'unusable',
      reason: 'CSC_LINK is set but no code signing identity is visible to this process; '
        + 'set YOUTUBE_TOOLS_SIGN_IDENTITY to the certificate electron-builder will use.',
    }
  }
  return { kind: 'none' }
}

async function listCodesigningIdentities(): Promise<readonly string[]> {
  try {
    const result = await execFileAsync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      timeout: 30_000,
      maxBuffer: 256 * 1_024,
    })
    return [...result.stdout.matchAll(/^\s*\d+\)\s+[0-9A-F]+\s+"([^"]+)"/gm)]
      .flatMap((match) => (match[1] ? [match[1]] : []))
  } catch {
    return []
  }
}

function codesignArguments(
  filePath: string,
  identity: string,
  entitlements: string,
): readonly string[] {
  return [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '--entitlements', entitlements,
    '--sign', identity,
    filePath,
  ]
}

const runCodesign: YoutubeToolCodesign = async (invocation) => {
  await execFileAsync('/usr/bin/codesign', [...invocation.args], {
    timeout: 300_000,
    maxBuffer: 1_024 * 1_024,
  })
}

async function resolveEntitlementsPath(): Promise<string> {
  // electron-builder hands every nested Mach-O file the same entitlements, see
  // getOptionsForFile in node_modules/app-builder-lib/out/mac/MacTargetHelper.js.
  // Hardened runtime without them enables library validation, which stops the
  // PyInstaller yt-dlp build from loading the modules it extracts at runtime.
  const candidates = [
    path.resolve('build', 'entitlements.mac.plist'),
    path.resolve('node_modules', 'app-builder-lib', 'templates', 'entitlements.mac.plist'),
  ]
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }
  throw new Error(`No macOS entitlements file found; expected ${candidates.join(' or ')}.`)
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile()
  } catch {
    return false
  }
}

async function checksum(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

function parseStagedManifest(value: unknown): StagedManifest {
  if (!isRecord(value) || !isRecord(value.tools)) invalidManifest()
  const { binaryManifestSchemaVersion, platform, arch } = value
  if (
    binaryManifestSchemaVersion !== 1 ||
    typeof platform !== 'string' ||
    typeof arch !== 'string'
  ) invalidManifest()
  const tools: Record<string, StagedTool> = {}
  for (const [name, record] of Object.entries(value.tools)) {
    if (
      !isRecord(record) ||
      typeof record.file !== 'string' ||
      typeof record.version !== 'string' ||
      typeof record.sha256 !== 'string'
    ) invalidManifest()
    // The runtime resolver holds the same filename to this shape, see
    // verifyBinary in domains/youtube/youtube-binary-resolver.ts.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(record.file)) {
      throw new Error(`Staged YouTube manifest has an invalid ${name} filename.`)
    }
    tools[name] = {
      file: record.file,
      version: record.version,
      sha256: record.sha256,
      // A freshly staged manifest pins the upstream bytes in sha256; signing
      // moves that value here so the pin stays traceable to YOUTUBE_*_SHA256.
      sourceSha256: typeof record.sourceSha256 === 'string' ? record.sourceSha256 : record.sha256,
    }
  }
  return { binaryManifestSchemaVersion: 1, platform, arch, tools }
}

function invalidManifest(): never {
  throw new Error('Staged YouTube binary manifest is invalid.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function stagedDirectory(environment: NodeJS.ProcessEnv): string {
  const platform = environment.YOUTUBE_TOOLS_TARGET_PLATFORM ?? process.platform
  const arch = environment.YOUTUBE_TOOLS_TARGET_ARCH ?? process.arch
  const outputRoot = path.resolve(
    environment.YOUTUBE_TOOLS_OUTPUT_ROOT ?? path.join('build', 'youtube-tools'),
  )
  return path.join(outputRoot, `${platform}-${arch}`)
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return Boolean(entry && pathToFileURL(path.resolve(entry)).href === moduleUrl)
}

if (isMainModule(import.meta.url)) {
  const result = await signStagedYoutubeTools({ directory: stagedDirectory(process.env) })
  process.stdout.write(`${result.message}\n`)
}
