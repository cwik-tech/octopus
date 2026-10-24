import { expect, test } from '@playwright/test'
import { launchDesktop } from './support/desktop-launch.js'

test('J1 New chat in new window opens a separate empty draft and preserves the source', async ({}, info) => {
  const app = await launchDesktop({ userDataPath: info.outputPath('user'), workspacePath: info.outputPath('workspace') })
  try {
    const first = await app.firstWindow()
    await first.getByRole('button', { name: 'New chat', exact: true }).click({ button: 'right' })
    const action = first.getByRole('menuitem', { name: 'New chat in new window', exact: true })
    await expect(action).toBeVisible({ timeout: 1500 })
    const opened = app.waitForEvent('window')
    await action.click()
    const second = await opened
    await expect(second.getByRole('button', { name: 'New chat', exact: true })).toBeVisible()
    await expect(second.getByRole('region', { name: 'Run chat', exact: true })).toBeVisible()
    await expect(first.getByRole('region', { name: 'Run chat', exact: true })).toBeVisible()
    expect(app.windows()).toHaveLength(2)
    const source = await app.browserWindow(first)
    const destination = await app.browserWindow(second)
    const sourceBounds = await source.evaluate((window) => window.getBounds())
    const destinationBounds = await destination.evaluate((window) => window.getBounds())
    expect(destinationBounds.width).toBe(sourceBounds.width)
    expect(destinationBounds.x).toBeGreaterThanOrEqual(sourceBounds.x)
  } finally { await app.close() }
})
