import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { replaceRequiredText } from '../support/config-rewrite.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'
import { APP_DEFAULT_MODEL, seedProviderSettings } from './support/model-selection-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('scheduled research unlocks chat and all sidebar controls on completion and reload', async ({}, testInfo) => {
  const userDataPath = testInfo.outputPath('user-data')
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const piStatePath = testInfo.outputPath('pi-state')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/packaged-workflow-smoke'), projectRootPath, { recursive: true }),
  ])
  // One real worker is enough for this journey; a second process only adds
  // unrelated startup time to observing the scheduled delivery.
  const workflowPath = path.join(projectRootPath, 'workflows/templates/packaged-smoke.yaml')
  await fs.writeFile(
    workflowPath,
    replaceRequiredText({
      file: workflowPath,
      pattern: 'from_step: finalize',
      replacement: 'from_step: write',
      source: replaceRequiredText({
        file: workflowPath,
        pattern: /\n    - id: finalize[\s\S]*?\n  output:/,
        replacement: '\n  output:',
        source: await fs.readFile(workflowPath, 'utf8'),
      }),
    }),
  )
  // The paid provider is replaced at its HTTP boundary; scheduling, workers,
  // events, session storage and the file:// renderer use the real desktop stack.
  const provider = await startDeterministicOpenAiServer({
    blockRequestsMatching: ['packaged runtime smoke worker'],
    matchers: [{ match: 'packaged runtime smoke worker', text: '# Research complete\n\nThe scheduled report is ready.' }],
  })
  // The packaged-smoke worker names no model, and a Team's retired defaults no
  // longer choose one, so the scheduled run needs an application default. It
  // is written the way Settings writes it, on a keyless LM Studio connection to
  // the same server: the native tool route refuses a keyless OpenAI-compatible
  // one. A failed seed closes the server, reporting any close error beside it.
  await seedProviderSettings({
    userDataPath,
    baseUrl: provider.baseUrl.replace(/\/v1$/, ''),
    defaultModel: APP_DEFAULT_MODEL,
    kind: 'lm-studio',
  }).catch(async (error: unknown) => {
    await provider.close().catch((closeError: unknown) => {
      throw new AggregateError([error, closeError], 'Seeding failed, and so did closing its provider')
    })
    throw error
  })
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'scheduled-chat-test-key',
      OPENAI_BASE_URL: provider.baseUrl,
      PI_CODING_AGENT_DIR: piStatePath,
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible()
    const apiBaseUrl = await page.evaluate(() =>
      new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'),
    )
    if (!apiBaseUrl) throw new Error('Desktop API URL is missing')
    const scheduleResponse = await fetch(`${apiBaseUrl}/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Scheduled chat acceptance',
        kind: 'workflow',
        target: 'packaged-smoke',
        prompt: 'Prepare a concise report about Polish news for a general reader. Summarize the main developments and their implications in a Markdown delivery using the supplied research fixture.',
        cron: '0 9 * * *',
        timezone: 'UTC',
        scheduleLabel: 'Daily at 09:00 UTC',
        overlap: 'skip',
        notifyOnFailure: false,
        enabled: false,
      }),
      signal: AbortSignal.timeout(5_000),
    })
    expect(scheduleResponse.status).toBe(201)
    const schedule = z.object({ id: z.string() }).parse(await scheduleResponse.json())
    const fireResponse = await fetch(`${apiBaseUrl}/schedules/${schedule.id}/run-now`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
    expect(fireResponse.status).toBe(202)
    const fire = z.object({ sessionId: z.string(), taskId: z.string() }).parse(await fireResponse.json())
    const renameResponse = await fetch(`${apiBaseUrl}/sessions/${fire.sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Research in progress' }),
      signal: AbortSignal.timeout(5_000),
    })
    expect(renameResponse.status).toBe(200)

    await page.reload()
    const sidebar = page.locator('aside[aria-label="Context sidebar"]')
    const navigation = page.getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('tablist', { name: 'Run navigation' })
    const scheduledSessionButton = page.getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: /^Research in progress/ })
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await scheduledSessionButton.click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    const runNotice = chat.getByRole('status').filter({ hasText: /scheduled research/i })
    await expect(chat.getByRole('textbox')).toBeDisabled()
    await expect(runNotice).toContainText('Please wait')
    await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    await expect(chat.getByRole('button', { name: 'Run chat model', exact: true })).toBeDisabled()
    await expect(chat.getByRole('button', { name: 'Add files or MCP resources', exact: true })).toBeDisabled()
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await expect(navigation.getByRole('tab', { name: 'Teams', exact: true })).toBeDisabled()
    await expect(navigation.getByRole('tab', { name: 'Agents', exact: true })).toBeDisabled()
    await expect(navigation.getByRole('tab', { name: 'Sessions', exact: true })).toBeEnabled()
    await page.keyboard.press('ControlOrMeta+.')
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await expect(sidebar).not.toBeVisible()
    await expect(runNotice).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('scheduled-running.png') })

    await page.reload()
    await scheduledSessionButton.click()
    await expect(chat.getByRole('textbox')).toBeDisabled()
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')

    provider.releaseBlockedResponses()
    await expect(chat.getByRole('textbox')).toBeEnabled()
    await expect(runNotice).toHaveCount(0)
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await page.keyboard.press('ControlOrMeta+.')
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await navigation.getByRole('tab', { name: 'Teams', exact: true }).click()
    await expect(navigation.getByRole('tab', { name: 'Teams', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(navigation.getByRole('tab', { name: 'Agents', exact: true })).toBeEnabled()
    await expect(navigation.getByRole('tab', { name: 'Workflows', exact: true })).toBeEnabled()
    const previewResize = page.getByRole('button', { name: 'Resize artifact sheet', exact: true })
    await expect(previewResize).toHaveCount(0)
    const delivery = chat.locator(`#workflow-delivery-${fire.taskId}`)
    await delivery.getByRole('button', { name: 'Open full view', exact: true }).click()
    await expect(previewResize).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Research complete', exact: true })).toBeVisible()
    await expect(page.getByText('The scheduled report is ready.', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('scheduled-delivery.png') })
    await page.keyboard.press('Escape')
    await expect(previewResize).toHaveCount(0)
    await expect(chat.getByRole('textbox')).toBeEnabled()
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await page.reload()
    await scheduledSessionButton.click()
    await expect(chat.getByRole('textbox')).toBeEnabled()
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await expect(navigation.getByRole('tab', { name: 'Teams', exact: true })).toBeEnabled()
  } finally {
    provider.releaseBlockedResponses()
    await app.close()
    await provider.close()
  }
})
