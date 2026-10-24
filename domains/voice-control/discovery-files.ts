/**
 * The voice-control discovery folder (docs/feature-voice-control-mcp.md, D1).
 *
 * Each participant drops one small file here naming its own MCP server. The
 * folder belongs to neither app, so the apps stay separate: neither imports
 * the other's code or reads the other's data folder.
 *
 *   <dir>/apps/<appId>.json    written by each app, read by the voice layer
 *   <dir>/voice.json           written by the voice layer, read by each app
 *   <dir>/voice/<appId>.json   the voice layer's grant for one enrolled app
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  voiceControlAppGrantSchema,
  voiceControlDescriptorSchema,
  type VoiceControlDescriptor,
} from '../../contracts/voice-control.js'

export const VOICE_CONTROL_DIR_ENV = 'OCTOPUS_VOICE_CONTROL_DIR'

export function defaultVoiceControlDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[VOICE_CONTROL_DIR_ENV]
  if (override && override.trim() !== '') return path.resolve(override)
  const home = os.homedir()
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'voice-control')
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'voice-control')
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'voice-control')
}

export function appDescriptorPath(dir: string, appId: string): string {
  return path.join(dir, 'apps', `${appId}.json`)
}

/**
 * Writes this app's descriptor with mode 0600, because it holds a bearer
 * token. The bytes go to a private temporary file first and are renamed into
 * place, so a reader never sees half a file or a moment of wider permissions.
 */
export async function writeAppDescriptor(
  dir: string,
  descriptor: VoiceControlDescriptor,
): Promise<string> {
  const parsed = voiceControlDescriptorSchema.parse(descriptor)
  const appsDir = path.join(dir, 'apps')
  await fs.mkdir(appsDir, { recursive: true, mode: 0o700 })
  await fs.chmod(appsDir, 0o700)
  const target = appDescriptorPath(dir, parsed.appId)
  const temporary = path.join(appsDir, `.${parsed.appId}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
  return target
}

/**
 * Deletes this app's descriptor, but only while it is still this process's
 * own. A second copy of the app that started later owns the file now, and
 * removing it would hide that copy from the voice layer.
 */
export async function removeAppDescriptor(
  dir: string,
  appId: string,
  pid: number,
): Promise<void> {
  const target = appDescriptorPath(dir, appId)
  let current: unknown
  try {
    current = JSON.parse(await fs.readFile(target, 'utf8'))
  } catch (error) {
    if (isMissingFile(error)) return
    // Unreadable or not JSON: not a file another live process could be using.
    await fs.rm(target, { force: true })
    return
  }
  const parsed = voiceControlDescriptorSchema.safeParse(current)
  if (parsed.success && parsed.data.pid !== pid) return
  await fs.rm(target, { force: true })
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export interface VoiceLayerEndpoint {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly pid: number
}

/**
 * Where the voice layer is and the credential it issued this app, or null when
 * either file is missing or malformed, the URL is not loopback, or the process
 * that wrote it has ended. No grant means the voice layer has not enrolled this
 * app, so the app does not connect.
 */
export async function readVoiceLayerEndpoint(
  dir: string,
  appId: string,
  isProcessAlive: (pid: number) => boolean = processIsAlive,
): Promise<VoiceLayerEndpoint | null> {
  const descriptor = voiceControlDescriptorSchema.safeParse(
    await readJsonFile(path.join(dir, 'voice.json')),
  )
  if (!descriptor.success || descriptor.data.role !== 'voice') return null
  if (!isProcessAlive(descriptor.data.pid)) return null
  const grant = voiceControlAppGrantSchema.safeParse(
    await readJsonFile(path.join(dir, 'voice', `${appId}.json`)),
  )
  if (!grant.success || grant.data.appId !== appId) return null
  return {
    url: descriptor.data.mcp.url,
    headers: { ...grant.data.headers },
    pid: descriptor.data.pid,
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}
