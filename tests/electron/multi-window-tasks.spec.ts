import { expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { launchDesktop } from './support/desktop-launch.js'
import { APP_DEFAULT_MODEL, FIXTURE_PROVIDER, desktopEnvironment, seedProviderSettings, writeAgentPersona } from './support/model-selection-fixture.js'

test('J6 an already-open idle view discovers a new Team task and its workflow replies', async ({}, info) => {
  const workspacePath = info.outputPath('workspace')
  const projectRoot = info.outputPath('project')
  const userDataPath = info.outputPath('user')
  await fs.cp(path.join(process.cwd(), 'tests/fixtures/team-chat-e2e'), projectRoot, { recursive: true })
  const names = ['board-lead', 'spec-alpha', 'spec-beta', 'spec-gamma', 'spec-delta', 'spec-epsilon', 'spec-zeta', 'spec-eta', 'general-agent']
  for (const name of names) await writeAgentPersona(projectRoot, { name, description: 'Shared Team fixture', marker: `You are ${name}`, provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id })
  // Only the paid provider HTTP service is replaced; the task, worker and event streams are real.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (r) => r.systemPrompt?.includes('Select the participants before any specialist runs.') ?? false,
      content: JSON.stringify({ agents: ['spec-beta', 'spec-zeta'], rosterRationale: { 'spec-beta': 'Review options', 'spec-zeta': 'Review risks' } }) },
    { match: (r) => r.systemPrompt?.includes('You are spec-beta') ?? false, content: 'Beta contributed to the shared task.' },
    { match: (r) => r.systemPrompt?.includes('You are spec-zeta') ?? false, content: 'Zeta contributed to the shared task.' },
    { match: (r) => r.userMessage?.includes('Completed specialist passes: 1') ?? false,
      content: JSON.stringify({ decision: 'complete', reason: 'Both specialists answered.', finalResponse: 'The shared Team task is complete.' }) },
    { content: 'The shared Team task is complete.' },
  ] })
  await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
  await new FileSystemSessionStore(workspacePath).createSession({ title: 'Shared Team task' })
  const app = await launchDesktop({ userDataPath, workspacePath, env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }) })
  try {
    const first = await app.firstWindow()
    await first.getByRole('complementary', { name: 'Primary navigation', exact: true }).getByRole('button', { name: /^Shared Team task\b/ }).click()
    const opened = app.waitForEvent('window')
    await first.getByRole('button', { name: 'Open in new window', exact: true }).click()
    const second = await opened
    await expect(second.getByRole('button', { name: 'Edit session title' })).toHaveText('Shared Team task')
    await first.getByRole('tab', { name: 'Teams', exact: true }).click()
    await first.getByRole('radio', { name: 'Board Team' }).click()
    const chat = first.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByRole('textbox').fill('Please have the board review the options.')
    await chat.getByRole('textbox').press('Enter')
    await expect(first.getByText('The shared Team task is complete.', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await expect(second.getByText('The shared Team task is complete.', { exact: true }).first()).toBeVisible({ timeout: 2000 })
  } finally {
    await app.close(); await provider.close()
  }
})
