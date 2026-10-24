import { _electron as electron, expect, test, type TestInfo } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'

const repositoryRoot = process.cwd()

async function launchStartupFixture(testInfo: TestInfo, holdWorkspace: boolean) {
  // Real local executables replace the bundled media tools because their macOS
  // launch time is nondeterministic. The HTTP response controls when they finish.
  let mediaProbeRequests = 0
  const gate = http.createServer((_request, response) => {
    mediaProbeRequests += 1
    if (holdWorkspace) response.end('fixture-version')
  })
  gate.requestTimeout = 20_000
  await new Promise<void>((resolve) => gate.listen(0, '127.0.0.1', resolve))
  const address = gate.address()
  if (!address || typeof address === 'string') throw new Error('Startup gate has no port')

  const appRoot = testInfo.outputPath('app')
  await fs.mkdir(appRoot, { recursive: true })
  for (const entry of ['node_modules', 'dist-electron', 'file-parser', 'public', 'ui']) {
    await fs.symlink(path.join(repositoryRoot, entry), path.join(appRoot, entry), 'dir')
  }
  await fs.cp(path.join(repositoryRoot, 'tests/fixtures/packaged-workflow-smoke'), appRoot, { recursive: true })
  const binaryDirectory = path.join(appRoot, 'build/youtube-tools', `${process.platform}-${process.arch}`)
  await fs.mkdir(binaryDirectory, { recursive: true })
  const tools: Record<string, { file: string; version: string; sha256: string }> = {}
  for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    const source = name === 'yt-dlp'
      ? `#!/bin/sh\nexec /usr/bin/curl --silent --show-error --max-time 20 http://127.0.0.1:${address.port}/probe\n`
      : '#!/bin/sh\necho "fixture-version signalstats blurdetect"\n'
    await fs.writeFile(path.join(binaryDirectory, name), source, { mode: 0o700 })
    tools[name] = { file: name, version: 'fixture-version', sha256: createHash('sha256').update(source).digest('hex') }
  }
  await fs.writeFile(path.join(binaryDirectory, 'manifest.json'), JSON.stringify({
    binaryManifestSchemaVersion: 1, platform: process.platform, arch: process.arch, tools,
  }))

  const userDataPath = testInfo.outputPath('user-data')
  await fs.mkdir(userDataPath, { recursive: true })
  const grantsPath = path.join(userDataPath, 'batch-folder-grants.json')
  if (holdWorkspace) await promisify(execFile)('/usr/bin/mkfifo', [grantsPath], { timeout: 2_000 })

  const app = await electron.launch({
    args: ['.'], cwd: repositoryRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      VITE_DEV_SERVER_URL: '',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_REPO_ROOT: appRoot,
      PIPELINE_DESKTOP_PROJECT_ROOT: appRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PI_CODING_AGENT_DIR: testInfo.outputPath('pi-state'),
    },
  })
  // Opening a real FIFO waits for the desktop's settings reader, with no sleep
  // or production delay switch. Leave the read pending until the test writes.
  const workspaceWriter = holdWorkspace ? await fs.open(grantsPath, 'w') : undefined
  return {
    app,
    mediaProbeRequests: () => mediaProbeRequests,
    releaseWorkspace: async () => {
      await workspaceWriter?.writeFile('{"schemaVersion":1,"grants":[]}')
      await workspaceWriter?.close()
    },
    close: async () => {
      gate.closeAllConnections()
      await workspaceWriter?.close()
      await app.close()
      await new Promise<void>((resolve, reject) => gate.close((error) => error ? reject(error) : resolve()))
    },
  }
}

test('shows a compact loading window and expands it when the app is ready', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'This journey exercises macOS startup with a local FIFO.')
  const fixture = await launchStartupFixture(testInfo, true)
  const { app } = fixture
  try {
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    const page = await app.firstWindow()
    await expect(page.getByRole('status')).toHaveText('Getting things ready…')
    await expect(page.getByRole('img', { name: 'Octopus' })).toBeVisible()
    const window = await app.browserWindow(page)
    expect(await window.evaluate((current) => current.isVisible())).toBe(process.env.PIPELINE_DESKTOP_E2E_HEADLESS !== '1')
    const startupBounds = await window.evaluate((current) => current.getBounds())
    expect(startupBounds.width).toBeLessThanOrEqual(640)
    expect(startupBounds.height).toBeLessThanOrEqual(480)
    expect(startupBounds.width).toBeGreaterThan(startupBounds.height)
    expect(await window.evaluate((current) => current.isResizable())).toBe(false)
    // Runs in the page, where `globalThis` is the page's window. The name
    // `window` here would type as the Electron window handle declared above.
    expect(await page.evaluate(() => ({
      width: document.body.scrollWidth <= globalThis.innerWidth,
      height: document.body.scrollHeight <= globalThis.innerHeight,
    }))).toEqual({ width: true, height: true })
    await page.screenshot({ path: testInfo.outputPath('startup.png') })

    await fixture.releaseWorkspace()

    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    const appBounds = await window.evaluate((current) => current.getBounds())
    expect(appBounds.width).toBeGreaterThanOrEqual(1100)
    expect(appBounds.height).toBeGreaterThanOrEqual(720)
    expect(await window.evaluate((current) => current.isResizable())).toBe(true)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('the welcome octopus swims while waiting and respects reduced motion', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'This journey holds macOS startup with a local FIFO.')
  const fixture = await launchStartupFixture(testInfo, true)
  try {
    const page = await fixture.app.firstWindow()
    await page.clock.install()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.reload()
    const artwork = page.getByRole('img', { name: 'Octopus', exact: true })
    const animation = artwork.locator('canvas')
    await expect(animation).toBeVisible()
    await page.clock.runFor(100)
    const initialFrame = await animation.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())

    await page.clock.runFor(300)

    expect(await animation.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(initialFrame)
    await page.screenshot({ path: testInfo.outputPath('startup-swimming.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(animation).toBeHidden()
    await expect(artwork.locator('img')).toBeVisible()
    expect(await artwork.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(animation).toBeVisible()
  } finally {
    await fixture.releaseWorkspace()
    await fixture.close()
  }
})


test('opens the app without starting the YouTube media tools', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'This journey exercises the macOS media tool startup.')
  const fixture = await launchStartupFixture(testInfo, false)
  try {
    const page = await fixture.app.firstWindow()
    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
    expect(fixture.mediaProbeRequests()).toBe(0)
  } finally {
    await fixture.close()
  }
})
