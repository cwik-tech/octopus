import { expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { launchDesktop } from './support/desktop-launch.js'

test('Run searches sessions, Teams and Agents from the left sidebar and keeps the selected chat target', async ({}, testInfo) => {
  const userDataPath = testInfo.outputPath('user-data')
  const workspacePath = testInfo.outputPath('workspace')
  const projectRoot = testInfo.outputPath('project')
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.cp(path.resolve('tests/fixtures/team-chat-e2e'), projectRoot, { recursive: true })
  const store = new FileSystemSessionStore(workspacePath)
  await store.createSession({ title: 'Board notes' })
  await store.createSession({ title: 'Other notes' })
  const app = await launchDesktop({ userDataPath, workspacePath, env: { PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot } })
  try {
    const page = await app.firstWindow()
    const left = page.getByRole('complementary', { name: 'Primary navigation' })
    const tabs = left.getByRole('tablist', { name: 'Run navigation' })
    await expect(tabs.getByRole('tab', { name: 'Sessions', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('aside[aria-label="Context sidebar"]')).toHaveAttribute('aria-hidden', 'true')
    await expect(page.getByRole('button', { name: 'Show inspector', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hide inspector', exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('run-sessions-default.png') })
    await left.getByRole('button', { name: 'Search Run sidebar' }).click()
    const search = left.getByRole('searchbox', { name: 'Search Run sidebar' })
    await search.fill('board')
    await expect(left.getByRole('button', { name: /^Board notes/ })).toBeVisible()
    await expect(left.getByRole('button', { name: /^Other notes/ })).toHaveCount(0)
    await left.getByRole('button', { name: /^Board notes/ }).click()

    await tabs.getByRole('tab', { name: 'Teams', exact: true }).click()
    await expect(search).toHaveValue('board')
    const board = left.getByRole('radio', { name: /^Board Team/ })
    await expect(board).toBeVisible()
    await expect(left.getByRole('radio', { name: /^Line Team/ })).toHaveCount(0)
    await board.click()
    await expect(board).toBeChecked()
    await tabs.getByRole('tab', { name: 'Sessions', exact: true }).click()
    await tabs.getByRole('tab', { name: 'Teams', exact: true }).click()
    await expect(board).toBeChecked()

    await tabs.getByRole('tab', { name: 'Agents', exact: true }).click()
    await search.fill('beta')
    const beta = left.getByRole('list', { name: 'Available agents' }).getByRole('button', { name: /^Spec Beta/ })
    await expect(beta).toBeVisible()
    await expect(left.getByRole('button', { name: /^Spec Alpha/ })).toHaveCount(0)
    await beta.click()
    await expect(left.getByRole('list', { name: 'Selected agents' }).getByRole('button', { name: /^Spec Beta/ })).toBeVisible()
    await tabs.getByRole('tab', { name: 'Sessions', exact: true }).click()
    await expect(search).toHaveValue('beta')
    await left.getByRole('button', { name: 'Clear search' }).click()
    await expect(left.getByRole('button', { name: /^Other notes/ })).toBeVisible()
    await tabs.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(left.getByRole('list', { name: 'Selected agents' }).getByRole('button', { name: /^Spec Beta/ })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('run-left-sidebar.png') })
  } finally {
    await app.close()
  }
})

test('Create opens on Teams and lets the user switch to Agents', async ({}, testInfo) => {
  const userDataPath = testInfo.outputPath('user-data')
  const workspacePath = testInfo.outputPath('workspace')
  await fs.mkdir(userDataPath, { recursive: true })
  const app = await launchDesktop({ userDataPath, workspacePath })
  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Create', exact: true }).click()
    const tabs = page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('tablist', { name: 'Resource type' })
    await expect(tabs.getByRole('tab').nth(0)).toHaveText('Teams')
    await expect(tabs.getByRole('tab').nth(1)).toHaveText('Agents')
    await expect(tabs.getByRole('tab', { name: 'Teams', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: testInfo.outputPath('create-teams-default.png') })
    await tabs.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(tabs.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: testInfo.outputPath('create-agents.png') })
  } finally {
    await app.close()
  }
})
