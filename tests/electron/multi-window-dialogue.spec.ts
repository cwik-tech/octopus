import { expect, test } from '@playwright/test'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { launchDesktop } from './support/desktop-launch.js'
import { APP_DEFAULT_MODEL, FIXTURE_PROVIDER, desktopEnvironment, seedProviderSettings, writeAgentPersona } from './support/model-selection-fixture.js'

test('J7 a dialogue started in one window appears in another view without copying its agent selection', async ({}, info) => {
  const workspacePath = info.outputPath('workspace')
  const projectRoot = info.outputPath('project')
  const userDataPath = info.outputPath('user')
  // Replace only the paid HTTP provider; dialogue admission, events and persistence remain real.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (r) => !r.stream && (r.systemPrompt?.includes('Shared dialogue alpha') ?? false), content: 'Alpha shared dialogue answer.' },
    { match: (r) => r.stream && (r.systemPrompt?.includes('Shared dialogue alpha') ?? false), content: 'Alpha shared dialogue answer.' },
    { match: (r) => !r.stream && (r.systemPrompt?.includes('Shared dialogue beta') ?? false), content: 'Beta shared dialogue answer.' },
    { match: (r) => r.stream && (r.systemPrompt?.includes('Shared dialogue beta') ?? false), content: 'Beta shared dialogue answer.' },
    { content: '[pass]' },
  ] })
  await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
  await writeAgentPersona(projectRoot, { name: 'alpha-analyst', description: 'Fixture analyst', marker: 'Shared dialogue alpha', provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id })
  await writeAgentPersona(projectRoot, { name: 'beta-builder', description: 'Fixture builder', marker: 'Shared dialogue beta', provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id })
  await writeAgentPersona(projectRoot, { name: 'general-agent', description: 'Fixture assistant', marker: 'Shared dialogue general', provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id })
  await new FileSystemSessionStore(workspacePath).createSession({ title: 'Shared dialogue' })
  const app = await launchDesktop({ userDataPath, workspacePath, env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }) })
  try {
    const first = await app.firstWindow()
    const navigation = first.getByRole('complementary', { name: 'Primary navigation', exact: true })
    await navigation.getByRole('button', { name: /^Shared dialogue\b/ }).click()
    const opened = app.waitForEvent('window')
    await first.getByRole('button', { name: 'Open in new window', exact: true }).click()
    const second = await opened
    await expect(second.getByRole('button', { name: 'Edit session title' })).toHaveText('Shared dialogue')
    await navigation.getByRole('tab', { name: 'Agents', exact: true }).click()
    await navigation.getByRole('button', { name: 'Alpha Analyst', exact: true }).click()
    await navigation.getByRole('button', { name: 'Beta Builder', exact: true }).click()
    await first.getByRole('tab', { name: 'Talk to each other', exact: true }).click()
    const chat = first.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByRole('textbox').fill('Discuss a small shared pilot.')
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(first.getByText('Alpha shared dialogue answer.', { exact: true })).toBeVisible()
    await expect(second.getByText('Alpha shared dialogue answer.', { exact: true })).toBeVisible({ timeout: 2000 })
    await expect(second.getByText('Beta shared dialogue answer.', { exact: true })).toBeVisible()
    await expect(second.getByText('They had nothing more to add.', { exact: true })).toBeVisible()
  } finally { await app.close(); await provider.close() }
})
