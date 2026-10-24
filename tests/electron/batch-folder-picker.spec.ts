import {
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchDesktop } from './support/desktop-launch.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('desktop Batch form selects and persists an external folder through the sandboxed preload', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('batch-picker-user-data')
  const workspacePath = testInfo.outputPath('batch-picker-workspace')
  const externalPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-batch-picker-'))
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  const app = await launchDesktop({ userDataPath, workspacePath })
  try {
    await fs.access(path.join(repoRoot, 'dist-electron', 'electron', 'preload.cjs'))
    await replaceDirectoryDialog(app, externalPath)
    const page = await app.firstWindow()
    await page.getByRole('button', { name: /Schedule & Batches/ }).click()
    await page.getByRole('tab', { name: 'Batches', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Batches', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New Batch', exact: true }).click()
    await page.getByRole('button', { name: 'Help: file extensions' }).hover()
    await expect(page.getByText(/Choose which files become Batch items/)).toBeVisible()
    await page.getByRole('button', { name: 'Help: rerun policy' }).hover()
    await expect(page.getByText(/Controls which files are processed when you run this Batch again/)).toBeVisible()
    await page.getByRole('button', { name: 'Choose folder' }).click()
    await expect(page.getByLabel('Folder')).toHaveValue(await fs.realpath(externalPath))

    await expect.poll(async () => {
      const payload = JSON.parse(await fs.readFile(
        path.join(userDataPath, 'batch-folder-grants.json'),
        'utf8',
      )) as { grants?: string[] }
      return payload.grants
    }).toEqual([await fs.realpath(externalPath)])
  } finally {
    await app.close()
    await fs.rm(externalPath, { recursive: true, force: true })
  }
})

test('desktop Batch folder capability is unavailable to iframes and rejects non-owner windows', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('batch-picker-rejection-user-data')
  const workspacePath = testInfo.outputPath('batch-picker-rejection-workspace')
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  const app = await launchDesktop({ userDataPath, workspacePath })
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    const ownerPage = await app.firstWindow()
    await ownerPage.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
    const iframeHasCapability = await ownerPage.evaluate(async () => {
      const iframe = document.createElement('iframe')
      const loaded = new Promise<void>((resolve) => {
        iframe.addEventListener('load', () => resolve(), { once: true })
      })
      iframe.srcdoc = '<p>untrusted frame</p>'
      document.body.append(iframe)
      await loaded
      const childWindow = iframe.contentWindow as (Window & {
        pipeline?: { selectBatchFolder(): Promise<unknown> }
      }) | null
      return typeof childWindow?.pipeline?.selectBatchFolder === 'function'
    })
    expect(iframeHasCapability).toBe(false)

    await app.evaluate(async ({ BrowserWindow }, input) => {
      const owner = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL() === input.ownerUrl,
      )
      if (!owner) throw new Error('Owner window is unavailable.')
      const secondary = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: input.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      await secondary.loadURL(input.ownerUrl)
    }, {
      ownerUrl: ownerPage.url(),
      preloadPath: path.join(repoRoot, 'dist-electron', 'electron', 'preload.cjs'),
    })
    await expect.poll(() => app.windows().length).toBe(2)
    const secondaryPage = app.windows()[1]!
    const rejection = await secondaryPage.evaluate(async () => {
      const bridge = (window as Window & {
        pipeline?: { selectBatchFolder(): Promise<unknown> }
      }).pipeline
      if (!bridge) return 'missing bridge'
      try {
        await bridge.selectBatchFolder()
        return 'accepted'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    expect(rejection).toMatch(/trusted main frame/i)
    await secondaryPage.close()
  } finally {
    await app.close()
  }
})

test('desktop picker grants and API revocations share one durable mutation chain', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('batch-picker-concurrency-user-data')
  const workspacePath = testInfo.outputPath('batch-picker-concurrency-workspace')
  const externalPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-batch-picker-concurrency-'))
  await Promise.all([userDataPath, workspacePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  const app = await launchDesktop({ userDataPath, workspacePath })
  try {
    await replaceDirectoryDialog(app, externalPath)
    const page = await app.firstWindow()
    await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
    const outcomes = await page.evaluate(async (selectedPath) => {
      const bridge = (window as Window & {
        pipeline?: { selectBatchFolder(): Promise<{ path: string } | null> }
      }).pipeline
      if (!bridge) throw new Error('Batch picker bridge is unavailable.')
      const apiBaseUrl = new URLSearchParams(window.location.hash.slice(1))
        .get('pipeline-api-base-url')
      if (!apiBaseUrl) throw new Error('Desktop API URL is unavailable.')
      const operations: Promise<unknown>[] = []
      for (let index = 0; index < 6; index += 1) {
        operations.push(bridge.selectBatchFolder())
        operations.push(fetch(`${apiBaseUrl}/settings/batch-folder-grants`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: selectedPath }),
        }).then((response) => response.status))
      }
      return Promise.all(operations)
    }, externalPath)
    assertPickerMutationOutcomes(outcomes, await fs.realpath(externalPath))

    const durable = JSON.parse(await fs.readFile(
      path.join(userDataPath, 'batch-folder-grants.json'),
      'utf8',
    )) as { schemaVersion?: number; grants?: string[] }
    expect(durable.schemaVersion).toBe(1)
    expect(new Set(durable.grants).size).toBe(durable.grants?.length ?? 0)
  } finally {
    await app.close()
    await fs.rm(externalPath, { recursive: true, force: true })
  }
})

function assertPickerMutationOutcomes(outcomes: unknown[], canonicalPath: string): void {
  for (let index = 0; index < outcomes.length; index += 2) {
    expect(outcomes[index]).toEqual({ path: canonicalPath })
    expect([204, 404]).toContain(outcomes[index + 1])
  }
}

async function replaceDirectoryDialog(app: ElectronApplication, selectedPath: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] })
  }, selectedPath)
}
