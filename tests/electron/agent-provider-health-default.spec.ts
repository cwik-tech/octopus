import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  desktopEnvironment,
  FIXTURE_PROVIDER,
  repoRoot,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

test('the reviewer sidebar and model selector agree when the agent inherits the app default', async ({}, testInfo) => {
  // Replace the paid, nondeterministic provider only at its HTTP boundary.
  const provider = await startFakeChatCompletionsServer({ script: [{ content: 'OK' }] })
  try {
    const projectRoot = testInfo.outputPath('project')
    const userDataPath = testInfo.outputPath('user-data')
    const workspacePath = testInfo.outputPath('workspace')
    const agentName = 'reviewer-of-agent-architect'
    const agentDirectory = path.join(projectRoot, 'agents', agentName)
    const model = { id: 'fixture/claude-opus', name: 'Claude Opus' }
    await fs.mkdir(agentDirectory, { recursive: true })
    await fs.mkdir(workspacePath, { recursive: true })
    // Keep the library limited to this reviewer. Reuse the real desktop build
    // without copying or health-checking the user's other agents.
    for (const entry of ['node_modules', 'dist-electron', 'file-parser', 'public', 'ui']) {
      await fs.symlink(path.join(repoRoot, entry), path.join(projectRoot, entry), 'dir')
    }
    await fs.copyFile(
      path.join(repoRoot, 'agents', agentName, `${agentName}.md`),
      path.join(agentDirectory, `${agentName}.md`),
    )
    await seedProviderSettings({ userDataPath, baseUrl: provider.url, models: [model], defaultModel: model })

    const app = await electron.launch({
      args: ['.'], cwd: repoRoot,
      env: {
        ...desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
        PIPELINE_DESKTOP_REPO_ROOT: projectRoot,
        PI_CODING_AGENT_DIR: testInfo.outputPath('pi-state'),
        VITE_DEV_SERVER_URL: '',
      },
    })
    try {
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1600, height: 1000 })
      const [sidebarHealth] = await Promise.all([
        page.waitForResponse((response) =>
          response.url().endsWith('/create/agents/health') &&
          (response.request().postData()?.includes('"agentNames"') ?? false) &&
          (response.request().postData()?.includes(agentName) ?? false),
        ),
        (async () => {
          await page.getByRole('tab', { name: 'Create', exact: true }).click()
          await page.getByLabel('Resource type')
            .getByRole('tab', { name: 'Agents', exact: true }).click()
        })(),
      ])
      const sidebar = page.locator('[data-slot="workspace-sidebar"][data-side="left"]')
      const reviewer = sidebar.getByRole('button', { name: /^Reviewer Of Agent Architect/ })
      await reviewer.click()
      const selector = page.getByRole('button', { name: 'Agent model', exact: true })
      await expect(selector).toContainText('Claude Opus')
      await expect(selector).toContainText('Default')
      await expect(selector.getByRole('img', { name: 'Provider available', exact: true })).toBeVisible()
      const healthResponse: unknown = await sidebarHealth.json()
      expect(healthResponse).toMatchObject({
        health: expect.arrayContaining([
          expect.objectContaining({ agentName, provider: FIXTURE_PROVIDER, model: model.id, status: 'ok', diagnostics: [] }),
        ]),
      })
      await expect(reviewer).toHaveAccessibleName('Reviewer Of Agent Architect')
      await expect(reviewer.getByRole('img', { name: /Agent (status unknown|warning|issue)/ })).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('reviewer-default-health.png') })
    } finally {
      await app.close()
    }
  } finally {
    await provider.close()
  }
})
