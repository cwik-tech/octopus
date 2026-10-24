import { expect, test } from '@playwright/test'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { launchDesktop } from './support/desktop-launch.js'
import { APP_DEFAULT_MODEL, FIXTURE_PROVIDER, desktopEnvironment, seedProviderSettings, writeAgentPersona } from './support/model-selection-fixture.js'

test('J4 the header opens the first saved chat during its reply while drafts cannot be opened', async ({}, info) => {
  const workspacePath = info.outputPath('workspace')
  const projectRoot = info.outputPath('project')
  const userDataPath = info.outputPath('user')
  let release = () => {}
  const finish = new Promise<void>((resolve) => { release = resolve })
  // Only the paid HTTP provider is replaced; first-save, admission and text delivery remain real.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (request) => request.stream && (request.systemPrompt?.includes('Header window fixture.') ?? false),
      deltas: ['Header opening', ' header final'], deltaGates: [Promise.resolve(), finish], gate: finish },
    { content: 'Header shared chat' },
  ] })
  try {
    await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
    await writeAgentPersona(projectRoot, { name: 'general-agent', description: 'Fixture assistant', marker: 'Header window fixture.', tier: 'orchestration', provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id })
    const app = await launchDesktop({ userDataPath, workspacePath, env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }) })
    try {
      const first = await app.firstWindow()
      const action = first.getByRole('button', { name: 'Open in new window', exact: true })
      await expect(action).toBeVisible()
      await expect(action).toBeDisabled()
      const source = first.getByRole('region', { name: 'Run chat', exact: true })
      await source.getByRole('textbox').fill('Save this first header question.')
      await source.getByRole('textbox').press('Enter')
      await expect(source).toContainText('Header opening')
      await expect(action).toBeEnabled()
      const opened = app.waitForEvent('window')
      await action.click()
      const second = await opened
      const destination = second.getByRole('region', { name: 'Run chat', exact: true })
      await expect(destination.getByText('Save this first header question.', { exact: true })).toBeVisible()
      await expect(destination).toContainText('Header opening')
      release()
      await expect(source.getByText('Header opening header final', { exact: true })).toBeVisible()
      await expect(destination.getByText('Header opening header final', { exact: true })).toBeVisible()
    } finally { release(); await app.close() }
  } finally { release(); await provider.close() }
})
