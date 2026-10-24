import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { developmentElectronLaunchOptions } from '../../services/development/development-electron-bundle.js'
import { seedDesktopProjectRoot } from '../../electron/project-root.js'
import { agentQuestionViewsSchema } from '../../contracts/agent-questions.js'
import { observeQuestionTaskOutcome, readQuestionProviderEvidence } from './support/agent-question-evidence.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const settingsSchema = z.object({
  version: z.number(),
  connections: z.array(z.object({
    id: z.string(), kind: z.string(), enabled: z.boolean(), status: z.string(),
    encryptedApiKey: z.string().optional(),
    models: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() }).passthrough()),
  }).passthrough()),
}).passthrough()

test.use({ trace: 'on' })

const liveJourneys = [
  { name: 'a live chain agent asks for a name and finishes before the editor runs', mode: 'chain', team: /^Dedication Chain\b/, asker: 'Dedication Writer', next: 'Editor', final: 'Editor' },
  { name: 'a live discussion participant resumes after a human answer and the lead completes the discussion', mode: 'discussion', team: /^Dedication Discussion\b/, asker: 'Brief Interviewer', next: 'Poet', final: 'Discussion Lead' },
] as const

for (const journey of liveJourneys) {
test(journey.name, async ({}, testInfo) => {
  const startedAt = performance.now()
  const capability = `agent-questions-${journey.mode}-electron`
  const providerKind = z.enum(['openrouter', 'claude', 'codex']).parse(process.env.PIPELINE_LIVE_QUESTIONS_PROVIDER ?? 'openrouter')
  let selectedProvider: string = providerKind
  let selectedModel = process.env.PIPELINE_LIVE_QUESTIONS_MODEL ?? (providerKind === 'claude' ? 'sonnet' : 'gpt-5.6-luna')
  let profile: unknown
  if (providerKind === 'openrouter') {
    const sourcePath = process.env.PIPELINE_LIVE_OPENROUTER_SETTINGS_PATH ?? path.join(os.homedir(), 'Library/Application Support/pipeline-template/provider-settings.json')
    const settings = settingsSchema.parse(JSON.parse(await fs.readFile(sourcePath, 'utf8')))
    const connection = settings.connections.find((entry) => entry.kind === 'openrouter' && entry.enabled && entry.status === 'connected' && entry.encryptedApiKey)
    const model = connection?.models.find((entry) => entry.enabled && entry.id === (process.env.PIPELINE_LIVE_OPENROUTER_MODEL ?? 'google/gemini-3.6-flash'))
    if (!connection || !model) {
      const required = (process.env.PIPELINE_LIVE_REQUIRE ?? '').split(',')
      if (required.includes('all') || required.includes(capability)) throw new Error(`Required live capability ${capability} has no configured provider/model.`)
      test.skip(true, 'An enabled OpenRouter model is required for this opt-in live example.')
      return
    }
    selectedProvider = `connection:${connection.id}`
    selectedModel = model.id
    profile = { version: settings.version, connections: [connection], cliEnabled: {}, cliModelEnabled: {}, defaultModel: { provider: selectedProvider, model: selectedModel } }
  } else {
    // The real installed CLI uses its existing subscription authentication.
    // Only application settings and task data live in this isolated profile.
    profile = { version: 3, connections: [], cliEnabled: { [providerKind]: true }, cliModelEnabled: { [providerKind]: { [selectedModel]: true } }, defaultModel: { provider: selectedProvider, model: selectedModel } }
  }
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  await fs.mkdir(workspacePath, { recursive: true })
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.cp(path.join(repoRoot, 'tests/fixtures/agent-questions-live'), projectRootPath, { recursive: true })
  // Prepare the real catalog before launch so copying it does not consume a
  // renderer action's startup deadline. Existing fixture files stay unchanged.
  await seedDesktopProjectRoot({ appRootPath: repoRoot, projectRootPath })
  // Copy encrypted credentials into an isolated profile; never decode or print them.
  await fs.writeFile(path.join(userDataPath, 'provider-settings.json'), JSON.stringify(profile), { mode: 0o600 })
  const launch = await developmentElectronLaunchOptions(repoRoot)
  const app = await electron.launch({
    args: launch.executablePath ? [launch.electronCliPath] : ['.'], cwd: repoRoot,
    ...(launch.executablePath ? { executablePath: launch.executablePath } : {}),
    env: {
      ...process.env, NODE_ENV: 'test', PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath, PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath, PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  try {
    // The participant rail is intentionally hidden below the desktop breakpoint.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1800, height: 1100 })
    })
    const page = await app.firstWindow()
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: journey.team }).click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    const questionsRequest = page.waitForRequest((request) => request.url().endsWith('/agent-questions'))
    // Preserve the visible assertion if cleanup rejects this unconsumed wait.
    void questionsRequest.catch(() => undefined)
    await chat.getByRole('textbox').first().fill("Write a four-line dedication poem. The recipient's name is required; ask me for it before writing and do not invent it.")
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath(`${journey.mode}-submitted.png`), fullPage: true })
    const card = chat.getByRole('region', { name: `${journey.asker} needs your input`, exact: true })
    await expect(card).toBeVisible({ timeout: 120_000 })
    await expect(chat.getByText(journey.next, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Team participants' })).toContainText('Waiting for your answer')
    await expect(chat.getByRole('status', { name: `${journey.asker} is thinking`, exact: true })).toHaveCount(0)
    await chat.getByRole('button', { name: 'Go to pending question', exact: true }).click()
    await expect(card.getByRole('textbox')).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath(`${journey.mode}-waiting.png`), fullPage: true })
    await expect(card.getByRole('textbox')).toHaveCount(1)
    const savedQuestion = agentQuestionViewsSchema.parse(await (await page.request.get((await questionsRequest).url())).json())[0]
    if (!savedQuestion) throw new Error('The visible card has no saved question.')
    const completion = observeQuestionTaskOutcome(workspacePath, savedQuestion, 120_000)
    await card.getByRole('textbox').fill('Marta')
    await card.getByRole('button', { name: 'Submit and continue', exact: true }).click()
    await expect(chat.getByText(journey.next, { exact: true })).toBeVisible({ timeout: 120_000 })
    const nextResponse = chat.locator('section').filter({ has: page.getByText(journey.next, { exact: true }) }).last()
    await expect(nextResponse).toContainText('Marta', { timeout: 120_000 })
    await expect(card.getByRole('textbox')).toHaveCount(0)
    await expect(card.getByText('Marta', { exact: true })).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`${journey.mode}-answered.png`), fullPage: true })
    const terminalTask = await completion
    expect(terminalTask.status, terminalTask.error).toBe('done')
    const finalResponse = chat.locator('section').filter({ has: page.getByText(journey.final, { exact: true }) }).last()
    await expect(finalResponse).toContainText('Marta')
    await expect(chat.getByRole('textbox').first()).toBeEnabled({ timeout: 10_000 })
    await finalResponse.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`${journey.mode}-completed.png`), fullPage: true })
    const evidence = await readQuestionProviderEvidence(workspacePath, { ...savedQuestion, runId: terminalTask.runId })
    const askingTurns = evidence.agents.filter((event) => event.event === 'end' && event.agent_name === savedQuestion.agentId)
    expect(askingTurns.map((event) => event.status)).toEqual(['awaiting_input', 'completed'])
    expect(askingTurns.map((event) => event.provider)).toEqual([selectedProvider, selectedProvider])
    expect(askingTurns.map((event) => event.model)).toEqual([selectedModel, selectedModel])
    const askingStarts = evidence.agents.filter((event) => event.event === 'start' && event.agent_name === savedQuestion.agentId)
    expect(askingStarts).toHaveLength(2)
    expect(askingStarts[0]?.logical_invocation_id).toBeTruthy()
    expect(askingStarts[1]?.logical_invocation_id).toBe(askingStarts[0]?.logical_invocation_id)
    expect(askingTurns[0]?.dispatch_id).toBe(savedQuestion.dispatchId)
    expect(askingTurns[1]?.dispatch_id).not.toBe(savedQuestion.dispatchId)
    const record = {
      capability, provider: providerKind, model: selectedModel, completedAt: new Date().toISOString(),
      sessionId: savedQuestion.sessionId, taskId: savedQuestion.taskId, interactionId: savedQuestion.interactionId,
      agentId: savedQuestion.agentId, dispatchId: savedQuestion.dispatchId, status: terminalTask.status,
      durationMs: Math.round(performance.now() - startedAt), ...evidence,
    }
    await fs.writeFile(testInfo.outputPath('live-result.json'), JSON.stringify(record, null, 2))
    await testInfo.attach('live-provider', { contentType: 'application/json', body: JSON.stringify(record) })
  } finally {
    const page = await app.firstWindow()
    await fs.writeFile(testInfo.outputPath('last-visible-state.txt'), await page.locator('body').innerText())
    await app.context().tracing.stop({ path: testInfo.outputPath('electron-trace.zip') })
    await app.close()
  }
})
}
