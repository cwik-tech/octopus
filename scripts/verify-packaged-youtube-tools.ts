import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { resolveYoutubeBinaries } from '../domains/youtube/youtube-binary-resolver.js'

const execFileAsync = promisify(execFile)

/**
 * Packaging gate: resolve the bundled tools the way the packaged app does.
 *
 * `youtube-tools:verify` checks the staged copies before electron-builder runs,
 * so it cannot see a bundle whose files were rewritten during packaging. This
 * check reads the finished app, which is where a broken checksum pin shows up.
 *
 * It also checks the signatures, because `build.mac.signIgnore` keeps
 * electron-builder away from the bundled tools whether or not
 * `youtube-tools:sign` found an identity of its own. A signed app holding
 * unsigned tools fails notarization, and checksums alone cannot see that.
 *
 * Usage: npm run youtube-tools:verify-packaged -- [path to Octopus.app]
 */

export interface PackagedSignature {
  readonly signed: boolean
  readonly teamIdentifier: string | null
  readonly hardenedRuntime: boolean
}

export type PackagedSignatureInspector = (filePath: string) => Promise<PackagedSignature>

export interface PackagedYoutubeToolsOptions {
  readonly appPath: string
  readonly environment?: NodeJS.ProcessEnv
  readonly inspectSignature?: PackagedSignatureInspector
}

const supportedPlatforms: readonly NodeJS.Platform[] = ['darwin', 'linux', 'win32']

export async function verifyPackagedYoutubeTools(
  options: PackagedYoutubeToolsOptions,
): Promise<string> {
  const environment = options.environment ?? process.env
  const resourcesPath = path.join(options.appPath, 'Contents', 'Resources')
  const resolved = await resolveYoutubeBinaries({
    isPackaged: true,
    resourcesPath,
    platform: targetPlatform(environment),
    arch: environment.YOUTUBE_TOOLS_TARGET_ARCH ?? process.arch,
  })
  const inspect = options.inspectSignature ?? inspectSignature
  const app = await inspect(options.appPath)
  // An ad-hoc or unsigned app means electron-builder had no identity either, so
  // the tools are expected to keep the signatures they were staged with.
  if (app.teamIdentifier !== null) {
    for (const [name, binary] of [
      ['yt-dlp', resolved.ytDlp],
      ['ffmpeg', resolved.ffmpeg],
      ['ffprobe', resolved.ffprobe],
    ] as const) {
      await verifyToolSignature(name, binary.path, app.teamIdentifier, inspect)
    }
  }
  return `Verified packaged YouTube tools in ${options.appPath}: `
    + `${resolved.ytDlp.version}, ${resolved.ffmpeg.version}, ${resolved.ffprobe.version}`
}

async function verifyToolSignature(
  name: string,
  filePath: string,
  appTeamIdentifier: string,
  inspect: PackagedSignatureInspector,
): Promise<void> {
  const signature = await inspect(filePath)
  if (!signature.signed) {
    throw new Error(`Packaged ${name} is not code signed, but the app is signed by team ${appTeamIdentifier}.`)
  }
  if (signature.teamIdentifier !== appTeamIdentifier) {
    throw new Error(
      `Packaged ${name} is signed by team ${signature.teamIdentifier ?? 'none'}, not the app team ${appTeamIdentifier}.`,
    )
  }
  if (!signature.hardenedRuntime) {
    throw new Error(`Packaged ${name} is not signed with the hardened runtime.`)
  }
}

const inspectSignature: PackagedSignatureInspector = async (filePath) => {
  const displayed = await codesignOutput(['--display', '--verbose=2', filePath])
  if (displayed === null) return { signed: false, teamIdentifier: null, hardenedRuntime: false }
  if (await codesignOutput(['--verify', '--strict', filePath]) === null) {
    throw new Error(`Code signature on ${filePath} is not valid.`)
  }
  const team = /^TeamIdentifier=(.+)$/m.exec(displayed)?.[1]?.trim()
  const flags = /\bflags=0x[0-9a-f]+\(([^)]*)\)/.exec(displayed)?.[1] ?? ''
  return {
    signed: true,
    teamIdentifier: team && team !== 'not set' ? team : null,
    hardenedRuntime: flags.split(',').some((flag) => flag.trim() === 'runtime'),
  }
}

async function codesignOutput(args: readonly string[]): Promise<string | null> {
  try {
    // codesign writes its report to stderr.
    const result = await execFileAsync('/usr/bin/codesign', [...args], {
      timeout: 60_000,
      maxBuffer: 1_024 * 1_024,
    })
    return `${result.stdout}${result.stderr}`
  } catch {
    return null
  }
}

function targetPlatform(environment: NodeJS.ProcessEnv): NodeJS.Platform {
  const requested = environment.YOUTUBE_TOOLS_TARGET_PLATFORM?.trim()
  if (!requested) return process.platform
  const match = supportedPlatforms.find((candidate) => candidate === requested)
  if (!match) {
    throw new Error(`YOUTUBE_TOOLS_TARGET_PLATFORM must be one of ${supportedPlatforms.join(', ')}.`)
  }
  return match
}

async function resolvePackagedAppPath(): Promise<string> {
  const requested = process.argv[2] ?? process.env.PIPELINE_PACKAGED_APP
  if (requested?.trim()) return path.resolve(requested.trim())
  const armPath = path.resolve('release', 'mac-arm64', 'Octopus.app')
  if (await isDirectory(armPath)) return armPath
  const universalPath = path.resolve('release', 'mac', 'Octopus.app')
  if (await isDirectory(universalPath)) return universalPath
  return armPath
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return Boolean(entry && pathToFileURL(path.resolve(entry)).href === moduleUrl)
}

if (isMainModule(import.meta.url)) {
  const appPath = await resolvePackagedAppPath()
  try {
    process.stdout.write(`${await verifyPackagedYoutubeTools({ appPath })}\n`)
  } catch (error: unknown) {
    process.stderr.write(
      `Packaged YouTube tools are unusable in ${appPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
