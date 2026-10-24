import { _electron as electron, expect, test, type Page, type TestInfo } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentQuestionViewsSchema } from '../../contracts/agent-questions.js'
import { observeQuestionTaskOutcome } from './support/agent-question-evidence.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function setup(testInfo: TestInfo, repeatQuestion = false, nested = false) {
  const workspace = testInfo.outputPath('workspace')
  const project = testInfo.outputPath('project')
  const profile = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }), fs.mkdir(profile, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests/fixtures/team-chat-e2e'), project, { recursive: true }),
  ])
  await Promise.all(['line-one', 'line-two'].map((id) => fs.writeFile(path.join(project, 'agents', id, `${id}.md`),
    `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\nYou are ${id}. Ask only for required missing information.\n`)))
  if (nested) {
    const teamPath = path.join(project, 'teams/line-team/team.yaml')
    const original = (await fs.readFile(teamPath, 'utf8')).replace('path: ../../workspace', `path: ${workspace}`)
    const inner = original.replace('name: line-team', 'name: inner-poets')
      .replace(/  - name: line-two[\s\S]*?(?=\nlevels:)/, '')
      .replace('        - line-two\n', '')
      .replace('    agent_file: ../../agents/line-one/line-one.md', '    agent_file: ../../agents/line-one/line-one.md\n    produces:\n      - path: line-result.md')
    await fs.mkdir(path.join(project, 'teams/inner-poets'), { recursive: true })
    await fs.writeFile(path.join(project, 'teams/inner-poets/team.yaml'), inner)
    await fs.writeFile(teamPath, original.replace(/  - name: line-one[\s\S]*?(?=  - name: line-two)/,
      '  - name: inner-poets\n    type: team\n    role: Write the dedication\n    team_path: ../inner-poets\n    host_provider: openai\n    host_model: gpt-5.4-mini\n    input_artifact: incoming-brief.md\n    output_artifact: line-result.md\n').replace('        - line-one\n', '        - inner-poets\n'))
  }
  const writerRequests: string[] = []
  const editorRequests: string[] = []
  // The paid, nondeterministic provider alone is replaced at its HTTP boundary.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    if (body.includes('You are line-one')) {
      writerRequests.push(body)
      if (body.includes('Marta') && !repeatQuestion) return { text: 'A complete dedication for Marta.' }
      return { toolName: 'request_human_input', arguments: {
        progress: 'I need the recipient.', questions: [{ question: 'Who is it for?', reason: 'A named dedication requires the recipient.' }],
      } }
    }
    if (body.includes('You are line-two')) {
      editorRequests.push(body)
      return { text: 'The final dedication is for Marta.' }
    }
    return undefined
  } })
  if (nested) await fs.writeFile(path.join(profile, 'provider-settings.json'), JSON.stringify({
    version: 1, connections: [{ id: '11111111-2222-4333-8444-555555555555', kind: 'openai-compatible', name: 'Nested fixture',
      baseUrl: provider.baseUrl, enabled: true, status: 'connected', models: [{ id: 'gpt-5.4-mini', name: 'Fixture', enabled: true, capabilities: ['chat'] }] }],
    cliEnabled: {}, cliModelEnabled: {}, defaultModel: { provider: 'connection:11111111-2222-4333-8444-555555555555', model: 'gpt-5.4-mini' },
  }))
  const launch = () => electron.launch({ args: ['.'], cwd: repoRoot, env: {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }), NODE_ENV: 'test', OPENAI_API_KEY: 'agent-question-fixture', OPENAI_BASE_URL: provider.baseUrl,
    PI_CODING_AGENT_DIR: testInfo.outputPath('pi-state'),
    PIPELINE_DESKTOP_PROJECT_ROOT: project, PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: profile, PIPELINE_DESKTOP_WORKSPACE_PATH: workspace,
  } })
  return { workspace, launch, provider, writerRequests, editorRequests }
}

async function ask(page: Page) {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('tab', { name: 'Teams', exact: true }).click()
  await page.getByRole('radio', { name: /^Line Team\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const listRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
  // Teardown should preserve the original failed assertion.
  void listRequest.catch(() => undefined)
  await chat.getByRole('textbox').first().fill('Write a named dedication. Ask for the required recipient name.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(chat.getByRole('region', { name: 'Line One needs your input', exact: true })).toBeVisible({ timeout: 15_000 })
  const response = await page.request.get((await listRequest).url())
  expect(response.status()).toBe(200)
  const question = agentQuestionViewsSchema.parse(await response.json())[0]
  if (!question) throw new Error('The visible question has no durable identity.')
  await expect(chat.getByRole('textbox', { name: 'Send a message...', exact: true })).toBeEnabled()
  return { question, url: response.url() }
}

async function createReopeningDesktop(testInfo: TestInfo) {
  const fixture = await setup(testInfo)
  let app = await fixture.launch()
  return {
    ...fixture, app,
    async reopen() { await app.close(); app = await fixture.launch(); return app },
    async close() { try { await app.close() } finally { await fixture.provider.close() } },
  }
}

const restartTest = test.extend<{ desktop: Awaited<ReturnType<typeof createReopeningDesktop>> }>({
  // Playwright gives an explicitly timed fixture its own setup/teardown slot.
  // Keep app lifecycle work outside the journey's unchanged 30-second budget.
  desktop: [async ({}, use, testInfo) => {
    const desktop = await createReopeningDesktop(testInfo)
    try {
      await (await desktop.app.firstWindow()).getByRole('tab', { name: 'Run', exact: true }).waitFor({ state: 'visible' })
      await use(desktop)
    } finally { await desktop.close() }
  }, { timeout: 30_000 }],
})

restartTest('reopening the app restores the pending draft and continues the same agent', async ({ desktop }) => {
  const page = await desktop.app.firstWindow()
  const { question } = await ask(page)
  await page.getByRole('region', { name: 'Line One needs your input', exact: true }).getByRole('textbox').fill('Marta')
  const reopened = await (await desktop.reopen()).firstWindow()
  await reopened.getByRole('tab', { name: 'Run', exact: true }).click()
  await reopened.getByRole('listitem').first().getByRole('button').first().click()
  const card = reopened.getByRole('region', { name: 'Line One needs your input', exact: true })
  await expect(card.getByRole('textbox')).toHaveValue('Marta')
  expect(desktop.writerRequests).toHaveLength(1)
  const completion = observeQuestionTaskOutcome(desktop.workspace, question, 15_000)
  void completion.catch(() => undefined)
  await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
  await expect(reopened.getByText('The final dedication is for Marta.', { exact: true })).toBeVisible()
  expect((await completion).status).toBe('done')
  expect(desktop.writerRequests).toHaveLength(2)
  expect(desktop.editorRequests).toHaveLength(1)
})

test('cancelling from a waiting card makes late answers unable to resume its agent', async ({}, testInfo) => {
  const fixture = await setup(testInfo)
  const app = await fixture.launch()
  try {
    const page = await app.firstWindow()
    const { question, url } = await ask(page)
    const card = page.getByRole('region', { name: 'Line One needs your input', exact: true })
    const completion = observeQuestionTaskOutcome(fixture.workspace, question, 15_000)
    void completion.catch(() => undefined)
    await card.getByRole('button', { name: 'Cancel run', exact: true }).click()
    expect((await completion).status).toBe('cancelled')
    await expect(card.getByRole('textbox')).toHaveCount(0)
    await expect(card.getByRole('status')).toContainText(/cancel/i)
    const lateAnswer = await page.request.post(`${url}/${question.interactionId}/submit`, { data: {
      taskId: question.taskId, sessionId: question.sessionId, interactionId: question.interactionId,
      expectedInteractionRevision: question.revision, expectedRequestDigest: question.requestDigest,
      submissionId: randomUUID(), answers: Object.fromEntries(question.questionIds.map((id) => [id, 'Marta'])),
    } })
    expect(lateAnswer.status()).toBe(409)
    expect(fixture.writerRequests).toHaveLength(1)
    expect(fixture.editorRequests).toHaveLength(0)
  } finally { await app.close(); await fixture.provider.close() }
})

test('a repeated blocking question ends the run without another card or provider retry', async ({}, testInfo) => {
  const fixture = await setup(testInfo, true)
  const app = await fixture.launch()
  try {
    const page = await app.firstWindow()
    const { question } = await ask(page)
    const card = page.getByRole('region', { name: 'Line One needs your input', exact: true })
    const completion = observeQuestionTaskOutcome(fixture.workspace, question, 15_000)
    void completion.catch(() => undefined)
    await card.getByRole('textbox').fill('Marta')
    await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
    const outcome = await completion
    expect(outcome.status, outcome.error).toBe('blocked')
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('textbox')).toHaveCount(0)
    expect(fixture.writerRequests).toHaveLength(2)
    expect(fixture.editorRequests).toHaveLength(0)
  } finally { await app.close(); await fixture.provider.close() }
})

test('a nested team question resumes its original child before the parent continues', async ({}, testInfo) => {
  const fixture = await setup(testInfo, false, true)
  const app = await fixture.launch()
  try {
    const page = await app.firstWindow()
    const { question } = await ask(page)
    const card = page.getByRole('region', { name: 'Line One needs your input', exact: true })
    expect(fixture.writerRequests).toHaveLength(1)
    expect(fixture.editorRequests).toHaveLength(0)
    const completion = observeQuestionTaskOutcome(fixture.workspace, question, 20_000)
    void completion.catch(() => undefined)
    await card.getByRole('textbox').fill('Marta')
    await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
    await expect(page.getByText('The final dedication is for Marta.', { exact: true })).toBeVisible({ timeout: 20_000 })
    expect((await completion).status).toBe('done')
    expect(fixture.writerRequests).toHaveLength(2)
    expect(fixture.editorRequests).toHaveLength(1)
    await expect(card).toHaveCount(1)
  } finally { await app.close(); await fixture.provider.close() }
})
