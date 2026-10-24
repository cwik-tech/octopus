import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const repoRoot = process.cwd()
const markdown = '# Harness engineering sources\n\n- [Example](https://example.com/guide)\n'

test('the General Agent delivers a Markdown file that remains downloadable after reload', async ({}, testInfo) => {
  test.setTimeout(60_000)
  // The paid, nondeterministic model is replaced at its HTTP boundary. The
  // desktop, tool discovery, dispatcher, filesystem and downloads are real.
  const provider = await startOpenAiToolLoopFixture(repoRoot, 'openai-tool-loop-server.mjs', {
    env: {
      PROVIDER_FANOUT_SCRIPT: JSON.stringify({
        calls: [{ id: 'create-sources', name: 'create_file', arguments: {
          filename: 'harness-engineering-sources.md', content: markdown,
        } }],
        finalText: 'Created harness-engineering-sources.md.',
      }),
    },
  })
  const userDataPath = testInfo.outputPath('user-data')
  const workspacePath = testInfo.outputPath('workspace')
  const projectRoot = testInfo.outputPath('project')
  const agentDirectory = path.join(projectRoot, 'agents/general-agent')
  await fs.mkdir(agentDirectory, { recursive: true })
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.mkdir(workspacePath, { recursive: true })
  const persona = await fs.readFile(path.join(repoRoot, 'agents/general-agent/general-agent.md'), 'utf8')
  await fs.writeFile(path.join(agentDirectory, 'general-agent.md'), persona
    .replace(/^provider:.*$/m, 'provider: connection:files-fixture')
    .replace(/^model:.*$/m, 'model: fixture/fanout'))
  await fs.writeFile(path.join(userDataPath, 'provider-settings.json'), JSON.stringify({
    version: 1,
    connections: [{
      id: 'files-fixture', kind: 'lm-studio', name: 'Files fixture',
      baseUrl: `${provider.url}/v1`, enabled: true, status: 'connected',
      models: [{ id: 'fixture/fanout', name: 'Files fixture', enabled: true, capabilities: ['chat'] }],
    }],
    cliEnabled: { codex: false, claude: false, 'kimi-cli': false },
    cliModelEnabled: {},
    defaultModel: { provider: 'connection:files-fixture', model: 'fixture/fanout' },
  }))
  const app = await electron.launch({
    args: ['.', '--disable-gpu', '--no-sandbox'], cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: '1', PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Create', exact: true }).click()
    // A build with Workflows enabled, as every desktop E2E build is, opens
    // Create on its Workflows tab.
    await page.getByLabel('Resource type').getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.locator('[data-slot="workspace-sidebar"][data-side="left"]')
      .getByRole('button', { name: /^General Agent/ }).click()
    await page.getByRole('tab', { name: 'Tools', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Toggle Generate Word' })).toBeChecked()
    await expect(page.getByRole('switch', { name: 'Toggle Generate Excel' })).toBeChecked()

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    await chat.getByRole('textbox').fill('Create an md file that lists these harness engineering sources.')
    const response = page.waitForResponse((candidate) =>
      candidate.request().method() === 'POST' && candidate.url().includes('/messages'))
    await chat.getByRole('button', { name: 'Send message' }).click()
    expect((await response).status()).toBe(201)
    await expect(chat.getByText('harness-engineering-sources.md', { exact: true })).toBeVisible()
    const sessionTitle = await chat.getByRole('button', { name: 'Edit session title' }).innerText()

    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.locator('[data-slot="workspace-sidebar"][data-side="left"]')
      .getByRole('button', { name: new RegExp(`^${sessionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click()
    await chat.getByRole('button', { name: 'Open full view', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Harness engineering sources', exact: true })).toBeVisible()
    const link = page.getByRole('link', { name: 'Download harness-engineering-sources.md' })
    const href = await link.getAttribute('href')
    expect(href).toBeTruthy()
    const downloaded = await page.evaluate(async (url) => {
      if (!url) throw new Error('Missing download URL')
      const result = await fetch(url)
      return { status: result.status, text: await result.text() }
    }, href)
    expect(downloaded).toEqual({ status: 200, text: markdown })
    await page.screenshot({ path: testInfo.outputPath('markdown-delivery.png') })
  } finally {
    await app.close()
    await provider.close()
  }
})
