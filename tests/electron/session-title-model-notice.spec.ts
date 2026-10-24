/**
 * Session naming still uses the application default, without inserting model
 * diagnostics into the conversation, including after reopening it.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { UNTITLED_SESSION_TITLE } from '../../domains/sessions/session-title.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  ANALYST_MODEL,
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  REPLACEMENT_DEFAULT_MODEL,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const REVIEWER_MARKER = 'PERSONA-MARKER-title-notice-reviewer'
/** A phrase only the title helper's own system prompt carries. */
const TITLE_PROMPT_MARKER = 'session title that summarizes'
const ANSWER = 'The supply agreement has been reviewed.'
const GENERATED_TITLE = 'Reviewing The Supply Agreement Draft'

async function askAgent(page: Page, agentName: string, question: string): Promise<void> {
  const composer = page.getByRole('textbox').last()
  await composer.click()
  await composer.pressSequentially('@')
  // The mention list opens with focus in its own search box, so the Agent is
  // searched and picked there (agent-mentions.spec.ts), not typed after the @.
  await expect(page.getByRole('listbox', { name: 'Agent mentions' })).toBeVisible({
    timeout: 20_000,
  })
  const search = page.getByRole('combobox', { name: 'Search agents to mention' })
  await search.fill(agentName)
  await search.press('Enter')
  await expect(composer).toHaveValue(`@${agentName} `)
  await composer.pressSequentially(question)
  await composer.press('Enter')
}

async function openRunSession(page: Page, title: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page
    .locator('[data-slot="workspace-sidebar"][data-side="left"]')
    .getByRole('button', { name: new RegExp(`^${title}\\b`) })
    .first()
    .click()
}

test('session naming adds no model-default notice, including after reopening', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      // Claimed by who is asking, never by what they asked for. The model is
      // the behaviour under test, so a caller that named the wrong one still
      // gets its normal answer and the mistake shows up as a wrong model rather
      // than as an unclaimed request or a timeout.
      // One reply is two requests: the tool round, then the streamed final
      // one (agent-model-selection.spec.ts, `answeredBy`).
      {
        content: ANSWER,
        match: (request) => (request.systemPrompt?.includes(REVIEWER_MARKER) ?? false) && !request.stream,
      },
      {
        content: ANSWER,
        match: (request) => (request.systemPrompt?.includes(REVIEWER_MARKER) ?? false) && request.stream,
      },
      {
        content: GENERATED_TITLE,
        match: (request) => request.systemPrompt?.includes(TITLE_PROMPT_MARKER) ?? false,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('title-notice-workspace')
  const projectRoot = testInfo.outputPath('title-notice-project')
  const userDataPath = testInfo.outputPath('title-notice-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    // An Agent with its own pair, so its reply is a choice rather than
    // inheritance — the only default use on this turn is the title's.
    writeAgentPersona(projectRoot, {
      name: 'reviewer',
      description: 'Reviews contracts on its own pair.',
      marker: REVIEWER_MARKER,
      provider: FIXTURE_PROVIDER,
      model: ANALYST_MODEL.id,
    }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      // Keyless LM Studio: the native tool route refuses a keyless
      // OpenAI-compatible connection.
      kind: 'lm-studio',
    }),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  // Untitled, so this turn is actually eligible to name it.
  await sessionStore.createSession({ title: UNTITLED_SESSION_TITLE })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await openRunSession(page, UNTITLED_SESSION_TITLE)

    await askAgent(page, 'reviewer', 'Review the attached supply agreement.')

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByRole('log').getByText(ANSWER)).toBeVisible({ timeout: 60_000 })

    await expect(chat.getByText(GENERATED_TITLE, { exact: true })).toBeVisible({ timeout: 60_000 })
    const notices = page.getByRole('note', { name: 'Model selection' })
    await expect(notices).toHaveCount(0)

    // What each caller actually asked for, read from the provider's own record
    // rather than inferred from which scripted answer it received.
    const modelsFor = (marker: string): (string | undefined)[] =>
      provider.requests
        .filter((request) => request.systemPrompt?.includes(marker))
        .map((request) => request.model)
    // Both of the reply's requests, the tool round and the streamed one.
    expect(modelsFor(REVIEWER_MARKER)).toEqual([ANALYST_MODEL.id, ANALYST_MODEL.id])
    expect(modelsFor(TITLE_PROMPT_MARKER)).toEqual([APP_DEFAULT_MODEL.id])

    const rendered = testInfo.outputPath('title-notice.png')
    await chat.screenshot({ path: rendered })
    await testInfo.attach('chat-without-model-notice', { path: rendered, contentType: 'image/png' })

    // ── The one application default changes ────────────────────────────────
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
    const defaultPicker = page.getByRole('button', { name: 'Default model', exact: true })
    await expect(defaultPicker).toContainText(APP_DEFAULT_MODEL.name)
    await defaultPicker.click()
    await page
      .getByRole('option')
      .filter({ hasText: REPLACEMENT_DEFAULT_MODEL.name })
      .first()
      .click()
    await expect(defaultPicker).toContainText(REPLACEMENT_DEFAULT_MODEL.name)
    const close = page.getByRole('button', { name: 'Close', exact: true })
    await close.click()
    await expect(close).toBeHidden()

    // ── Reopened. The record is what happened, not what Settings says now ──
    await page.reload()
    await openRunSession(page, GENERATED_TITLE)
    await expect(chat.getByRole('log').getByText(ANSWER)).toBeVisible()
    const reopened = page.getByRole('note', { name: 'Model selection' })
    await expect(reopened).toHaveCount(0)
  } finally {
    await app.close()
    await provider.close()
  }
})
