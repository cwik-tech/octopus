import { revealOnOtherDisplay } from './reveal-on-other-display.js'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fixtureDesktopEnvironment } from '../../support/desktop-journey-environment.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export interface DesktopLaunchOptions {
  readonly userDataPath: string
  readonly workspacePath: string
  /** Set on top of the fixture environment, such as a journey's project root or a fixture key. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Launches the built desktop on fixtures only, from the repository or from
 * `PIPELINE_DESKTOP_EXECUTABLE`, and returns it once it has finished starting.
 *
 * `electron.launch` returns as soon as the main process is told it is ready,
 * which is when the app's startup begins. An `app.evaluate` sent during that
 * startup can fail: V8 drops the call's result ("Promise was collected"), and
 * Playwright reports it as "Execution context was destroyed, most likely
 * because of a navigation". The main process loads the app, with its API
 * address in the URL hash, as the last step of startup, so this waits for that.
 */
export async function launchDesktop(options: DesktopLaunchOptions): Promise<ElectronApplication> {
  const app = await launchUnstarted(options)
  try {
    const window = await app.firstWindow()
    await window.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  } catch (error) {
    await app.close().catch((closeError: unknown) => {
      throw new AggregateError([error, closeError], 'The desktop did not finish starting, and closing it failed')
    })
    throw error
  }
  if (process.env.PIPELINE_DESKTOP_E2E_OTHER_DISPLAY === '1') {
    console.info(await revealOnOtherDisplay(app) ? 'Visible check: placed on another display without taking focus.' : 'Visible check unavailable: no alternate display; windows remain hidden.')
  }
  return app
}

function launchUnstarted(options: DesktopLaunchOptions): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  return electron.launch({
    args: executablePath ? ['--disable-gpu', '--no-sandbox'] : ['.', '--disable-gpu', '--no-sandbox'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_USER_DATA: options.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: options.workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      ...options.env,
    },
  })
}
