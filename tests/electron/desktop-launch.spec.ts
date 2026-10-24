import { expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'

import { launchDesktop } from './support/desktop-launch.js'

/**
 * The shared launch helper's contract.
 *
 * While the main process is still starting, an `app.evaluate` there can fail:
 * V8 reports "Promise was collected" and Playwright shows it as "Execution
 * context was destroyed, most likely because of a navigation". Journeys
 * replace the native dialog that way as their first step, so the helper
 * returns only once startup has finished, which is when the main process
 * loads the app, with its API address, into the window.
 */
test('the launch helper hands the desktop over only once its window shows the app with its API address', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const userDataPath = testInfo.outputPath('desktop-launch-user-data')
  const workspacePath = testInfo.outputPath('desktop-launch-workspace')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))

  const app = await launchDesktop({ userDataPath, workspacePath })
  try {
    // Read at once: no waiting here, or this would test the wait, not the helper.
    const urls = app.windows().map((page) => page.url())

    expect(urls.some((url) => new URL(url).hash.includes('pipeline-api-base-url=')), `windows: ${JSON.stringify(urls)}`).toBe(true)
  } finally {
    await app.close()
  }
})
