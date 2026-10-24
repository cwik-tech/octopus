import { _electron as electron, expect, test, type TestInfo } from '@playwright/test'
import * as path from 'node:path'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsTurn } from '../support/fake-chat-completions-server.js'
import { APP_DEFAULT_MODEL, FIXTURE_PROVIDER, desktopEnvironment, repoRoot, seedProviderSettings, writeAgentPersona } from './support/model-selection-fixture.js'

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function journey(info: TestInfo, script: readonly FakeChatCompletionsTurn[]) {
  // Paid model behavior is substituted at HTTP; tools, stores, API and renderer are real.
  const provider = await startFakeChatCompletionsServer({ script })
  const projectRoot = info.outputPath('project')
  const userDataPath = info.outputPath('user')
  const workspacePath = info.outputPath('workspace')
  await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
  await writeAgentPersona(projectRoot, { name: 'general-agent', description: 'Progress reporter', marker: 'Report your progress and answer.', tier: 'orchestration', provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id })
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Reported progress' })
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }) })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: /^Reported progress\b/ }).first().click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  await expect(chat.getByRole('button', { name: 'Edit session title', exact: true })).toHaveText('Reported progress')
  return { app, page, chat, store, session, async close() { await app.close(); await provider.close() } }
}

test('agent-reported milestones update a labeled checklist before the final answer', async ({}, info) => {
  const nextReport = gate()
  const finish = gate()
  const fixture = await journey(info, [
    { match: request => !request.stream && JSON.stringify(request.body.tools).includes('report_progress'), toolCalls: [{ id: 'report-one', name: 'report_progress', arguments: { summary: 'Updating calendar interactions', tasks: [{ id: 'calendar', label: 'Calendar interactions', status: 'active' }, { id: 'filters', label: 'Waiting filters', status: 'pending' }] } }] },
    { match: request => !request.stream, gate: nextReport.promise, toolCalls: [{ id: 'report-two', name: 'report_progress', arguments: { summary: 'Checking calendar interactions', tasks: [{ id: 'calendar', label: 'Calendar interactions', status: 'completed' }, { id: 'filters', label: 'Waiting filters', status: 'active' }] } }] },
    { match: request => !request.stream, gate: finish.promise, content: 'Calendar and filters are ready.' },
    { match: request => request.stream, gate: finish.promise, deltas: ['Calendar and filters are ready.'] },
  ])
  try {
    await fixture.chat.getByRole('textbox').fill('Plan calendar tasks')
    await fixture.chat.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(fixture.chat.getByRole('button', { name: 'Agent progress: Updating calendar interactions' })).toBeVisible({ timeout: 8000 })
    await fixture.chat.getByRole('button', { name: 'Agent progress: Updating calendar interactions' }).click()
    await expect(fixture.chat.getByText('Agent-reported tasks', { exact: true })).toBeVisible()
    await expect(fixture.chat.getByRole('list', { name: 'Agent-reported tasks' })).toContainText('Calendar interactions · In progress')
    nextReport.release()
    await expect(fixture.chat.getByRole('button', { name: 'Agent progress: Checking calendar interactions' })).toBeVisible()
    await expect(fixture.chat.getByRole('list', { name: 'Agent-reported tasks' })).toContainText('Calendar interactions · Completed')
    await fixture.page.screenshot({ path: info.outputPath('reported-checklist.png') })
    finish.release()
    await expect(fixture.chat.getByText('Calendar and filters are ready.', { exact: true })).toBeVisible()
    await expect(fixture.chat.getByRole('button', { name: /Agent progress:/ })).toHaveCount(0)
    expect((await fixture.store.listChatMessages(fixture.session.id)).filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Calendar and filters are ready.'])
  } finally { nextReport.release(); finish.release(); await fixture.close() }
})

test('Stop removes agent-reported work without publishing the held answer', async ({}, info) => {
  const finish = gate()
  const fixture = await journey(info, [
    { match: request => !request.stream && JSON.stringify(request.body.tools).includes('report_progress'), toolCalls: [{ id: 'report', name: 'report_progress', arguments: { summary: 'Checking calendar interactions' } }] },
    { gate: finish.promise, content: 'An answer that must not be saved.' },
  ])
  try {
    await fixture.chat.getByRole('textbox').fill('Plan calendar tasks')
    await fixture.chat.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(fixture.chat.getByRole('button', { name: 'Agent progress: Checking calendar interactions' })).toBeVisible({ timeout: 8000 })
    await fixture.chat.getByRole('button', { name: 'Stop generation', exact: true }).click()
    await expect(fixture.chat.getByRole('textbox')).toBeEnabled()
    await expect(fixture.chat.getByRole('button', { name: /Agent progress:/ })).toHaveCount(0)
    expect((await fixture.store.listChatMessages(fixture.session.id)).filter(message => message.role === 'assistant')).toEqual([])
  } finally { finish.release(); await fixture.close() }
})
