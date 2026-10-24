import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { VOICE_CONTROL_DIR_ENV } from '../../domains/voice-control/discovery-files.js'

/** Every CLI the app can launch as a provider, by the command it spawns. */
export const PROVIDER_CLI_COMMANDS = ['claude', 'codex', 'gemini', 'kimi', 'qwen', 'pi'] as const

/**
 * Host values the desktop needs to start, find its home and write temporary
 * files, plus the runner's headless choice. None is a provider credential,
 * endpoint or runtime route.
 */
const OPERATIONAL_VARIABLES = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'PIPELINE_DESKTOP_E2E_HEADLESS',
] as const

/**
 * The base environment for a desktop journey that runs on fixtures only.
 *
 * `inherited` is the environment of the process that launches the desktop,
 * normally the Playwright runner's own. It passes on no provider credential,
 * endpoint or runtime route from it, and the desktop cannot resolve a provider
 * CLI from its `PATH` or from the fallback directories `core/cli-path.ts`
 * adds: this keeps only the operational values above, keeps the `PATH`
 * directories that hold no provider CLI, and turns the fallback directories
 * off. A journey still chooses its own fixture keys and endpoints, on top.
 *
 * This is an environment guard, not network isolation. `HOME` is kept, and
 * whatever a journey points the app at is still reached.
 */
export function fixtureDesktopEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of OPERATIONAL_VARIABLES) {
    const value = inherited[key]
    if (value !== undefined) environment[key] = value
  }
  environment.PATH = (inherited.PATH ?? '')
    .split(path.delimiter)
    .filter((directory) => directory !== '' && !holdsProviderCli(directory))
    .join(path.delimiter)
  environment.PIPELINE_CLI_PATH_FALLBACK = '0'
  // A journey's desktop must never advertise itself to a voice layer the
  // person is running, including a journey that starts the desktop without
  // the test-run flag. A journey that needs the folder names its own on top.
  environment[VOICE_CONTROL_DIR_ENV] = path.join(
    inherited.TMPDIR ?? os.tmpdir(),
    'octopus-desktop-journeys',
    'voice-control',
  )
  return environment
}

function holdsProviderCli(directory: string): boolean {
  return PROVIDER_CLI_COMMANDS.some((command) => {
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}
