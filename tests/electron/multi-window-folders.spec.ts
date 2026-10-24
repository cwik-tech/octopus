import * as path from 'node:path'
import type {} from '../../ui/src/types/pipeline-electron.js'
import { expect, test } from '@playwright/test'
import { launchDesktop } from './support/desktop-launch.js'

test('J2 both app windows can open folder dialogs and an unknown frame is refused', async ({}, info) => {
  const app = await launchDesktop({ userDataPath: info.outputPath('user'), workspacePath: info.outputPath('workspace') })
  try {
    const first = await app.firstWindow()
    await first.getByRole('button', { name: 'New chat', exact: true }).click({ button: 'right' })
    const opened = app.waitForEvent('window')
    await first.getByRole('menuitem', { name: 'New chat in new window', exact: true }).click()
    const second = await opened
    await expect(second.getByRole('button', { name: 'New chat', exact: true })).toBeVisible()
    // Native OS folder selection is unavailable to Playwright; replace only the dialog boundary.
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
    for (const page of [first, second]) {
      expect(await page.evaluate(async () => {
        const bridge = window.pipeline
        if (!bridge) throw new Error('Missing preload bridge')
        return { shared: await bridge.selectSharedFolder(), batch: await bridge.selectBatchFolder() }
      })).toEqual({ shared: null, batch: null })
    }
    const foreignOpened = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }, { url, preload }) => {
      const foreign = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await foreign.loadURL(url)
    }, { url: first.url(), preload: path.join(process.cwd(), 'dist-electron/electron/preload.cjs') })
    const foreign = await foreignOpened
    await foreign.waitForURL(first.url())
    const rejected = await foreign.evaluate(async () => {
      try { await window.pipeline?.openWindow?.({ kind: 'new-chat' }); return 'accepted' }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    })
    expect(rejected).toMatch(/trusted main frame/)
    expect(app.windows()).toHaveLength(3)
    await foreign.close()
  } finally { await app.close() }
})
