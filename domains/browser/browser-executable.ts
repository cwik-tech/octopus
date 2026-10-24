import { existsSync } from 'node:fs'
import * as path from 'node:path'

/**
 * Resolve the locally installed Chromium executable shared by browser-backed
 * capabilities. An explicit path always takes precedence over platform defaults.
 */
export function resolveBrowserExecutablePath(
  configuredPath?: string,
): string | undefined {
  const configured =
    configuredPath?.trim() ||
    process.env.PIPELINE_BROWSER_EXECUTABLE_PATH?.trim()
  const candidates = configured
    ? [configured]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            path.join(
              process.env.PROGRAMFILES ?? '',
              'Google/Chrome/Application/chrome.exe',
            ),
            path.join(
              process.env['PROGRAMFILES(X86)'] ?? '',
              'Google/Chrome/Application/chrome.exe',
            ),
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ]
  return candidates.find((candidate) => Boolean(candidate) && existsSync(candidate))
}
