import { expect, test } from '@playwright/test'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { launchDesktop } from './support/desktop-launch.js'

test('J3 the session menu opens a saved chat and preserves the source draft', async ({}, info) => {
  const workspacePath = info.outputPath('workspace')
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Shared window session' })
  const other = await store.createSession({ title: 'Independent selection' })
  const app = await launchDesktop({ userDataPath: info.outputPath('user'), workspacePath })
  try {
    const first = await app.firstWindow()
    const chat = first.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByRole('textbox').fill('Keep my unsent draft')
    const navigation = first.getByRole('complementary', { name: 'Primary navigation', exact: true })
    await navigation.getByRole('button', { name: `Session actions for ${session.title}`, exact: true }).click()
    const action = first.getByRole('menuitem', { name: 'Open in new window', exact: true })
    await expect(action).toBeVisible({ timeout: 1500 })
    const opened = app.waitForEvent('window')
    await action.click()
    const second = await opened
    await expect(second.getByRole('button', { name: 'Edit session title' })).toHaveText(session.title)
    await expect(chat.getByRole('textbox')).toHaveValue('Keep my unsent draft')
    await navigation.getByRole('button', { name: new RegExp(`^${other.title}\\b`) }).click()
    await expect(first.getByRole('button', { name: 'Edit session title' })).toHaveText(other.title)
    await expect(second.getByRole('button', { name: 'Edit session title' })).toHaveText(session.title)
  } finally { await app.close() }
})
