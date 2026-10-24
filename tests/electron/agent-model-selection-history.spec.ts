/** Completed turns retain their recorded model after Settings changes. Informational model-default cards remain hidden. */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
  type FakeChatCompletionsTurn,
} from '../support/fake-chat-completions-server.js'
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

const INHERITOR_MARKER = 'MARKER-INHERITING-PERSONA'
const PINNED_MARKER = 'MARKER-PINNED-PERSONA'

/**
 * The same answer for both requests of one displayed Agent turn.
 *
 * On the native tool route a displayed turn sends a buffered tool round and
 * then the streamed, tool-free final request whose text is shown; each is
 * claimed once, by the request the turn really sends.
 */
function answeredTurn(
  match: (request: FakeChatCompletionsRequest) => boolean,
  content: string,
): FakeChatCompletionsTurn[] {
  return [
    { content, match: (request) => match(request) && !request.stream },
    { content, match: (request) => match(request) && request.stream },
  ]
}

const FIRST_ANSWER = 'Answered while the first default was in force.'
const SECOND_ANSWER = 'Answered after the default was replaced.'
const PINNED_ANSWER = 'Answered on the pinned pair.'

const SESSION_TITLE_HISTORY = 'Default Change Journey'
const SESSION_TITLE_WIRE = 'Outbound Identity Journey'

/**
 * Address one agent and send the turn.
 *
 * Typing `@` opens the mention list and moves focus to its search box, so the
 * agent is found there and picked, and the composer is checked to hold its
 * mention before the question is typed. Characters typed after `@` land in the
 * search box, not the composer, so typing the name straight after it sent a
 * bare `@` that addressed no one.
 */
async function askAgent(
  page: Page,
  agentName: string,
  displayName: string,
  question: string,
): Promise<void> {
  const composer = page.getByRole('textbox').last()
  await composer.click()
  await composer.pressSequentially('@')
  const search = page.getByRole('combobox', { name: 'Search agents to mention' })
  await expect(search).toBeFocused({ timeout: 20_000 })
  await search.fill(agentName)
  const menu = page.getByRole('listbox', { name: 'Agent mentions' })
  await menu.getByRole('option', { name: displayName, exact: true }).click()
  await expect(composer).toHaveValue(`@${agentName} `)
  await expect(menu).toHaveCount(0)
  await composer.pressSequentially(question)
  await composer.press('Enter')
}

/**
 * Open a session by its own durable title.
 *
 * Every other session in these fixtures is an untitled one the desktop opened
 * for itself, so a titled session cannot be confused with a different run.
 *
 * Scoped to the desktop's left sidebar on purpose. The Run panel renders a
 * second, permanently collapsed session list whose buttons still report a
 * bounding box; an unscoped locator can resolve to one of those and then wait
 * out its timeout because the chat workspace covers it.
 */
async function openRunSession(page: Page, title: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page
    .locator('[data-slot="workspace-sidebar"][data-side="left"]')
    .getByRole('button', { name: new RegExp(`^${title}\\b`) })
    .first()
    .click()
}

/** The transcript exactly as the desktop API serves it to the renderer. */
async function readTranscriptOverApi(
  page: Page,
  sessionTitle: string,
): Promise<string> {
  return page.evaluate(async (title) => {
    const base = new URLSearchParams(window.location.hash.slice(1)).get(
      'pipeline-api-base-url',
    )
    if (!base) throw new Error('Desktop API URL is unavailable')
    const listing = (await (await fetch(`${base}/sessions`)).json()) as {
      sessions: Array<{ id: string; title: string }>
    }
    const session = listing.sessions.find((entry) => entry.title === title)
    if (!session) throw new Error(`No session titled '${title}'`)
    return JSON.stringify(
      await (await fetch(`${base}/sessions/${session.id}/messages`)).json(),
    )
  }, sessionTitle)
}

test('every completed turn keeps the pair it ran on after the application default changes', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      // Claimed by the model the request actually carries, so each scripted
      // answer belongs to the turn that ran under that default. Ordering alone
      // could not make that claim: one reply can produce several requests.
      ...answeredTurn(
        (request) =>
          request.model === APP_DEFAULT_MODEL.id &&
          (request.systemPrompt?.includes(INHERITOR_MARKER) ?? false),
        FIRST_ANSWER,
      ),
      ...answeredTurn(
        (request) =>
          request.model === REPLACEMENT_DEFAULT_MODEL.id &&
          (request.systemPrompt?.includes(INHERITOR_MARKER) ?? false),
        SECOND_ANSWER,
      ),
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('history-workspace')
  const projectRoot = testInfo.outputPath('history-project')
  const userDataPath = testInfo.outputPath('history-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, {
      name: 'inheritor',
      description: 'Runs on the application default.',
      marker: INHERITOR_MARKER,
    }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      // Keyless, so LM Studio: the native tool route every Agent chat turn
      // takes refuses a keyless OpenAI-compatible connection.
      kind: 'lm-studio',
    }),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  await sessionStore.createSession({ title: SESSION_TITLE_HISTORY })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await openRunSession(page, SESSION_TITLE_HISTORY)

    // ── Turn one, under the original application default ───────────────────
    await askAgent(page, 'inheritor', 'Inheritor', 'What did you run on?')

    const chat = page.getByRole('region', { name: 'Run chat' })
    const log = chat.getByRole('log')
    await expect(log.getByText(FIRST_ANSWER)).toBeVisible({ timeout: 60_000 })
    // Reply text alone can still be mid-stream. This label is rendered from
    // the turn's stored admitted selection and has no live-frame source, so it
    // is the witness that the turn completed and was persisted.
    await expect(chat.getByLabel(`Model: ${APP_DEFAULT_MODEL.id}`)).toHaveCount(
      1,
      { timeout: 60_000 },
    )

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // ── The user changes the one application default in Settings ───────────
    await page.getByLabel('Settings').click()
    await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
    const defaultPicker = page.getByLabel('Default model')
    await expect(defaultPicker).toContainText(APP_DEFAULT_MODEL.name)
    await defaultPicker.click()
    await page.getByText(REPLACEMENT_DEFAULT_MODEL.name, { exact: true }).click()
    // Read back from the control the user just operated. A settings write that
    // silently failed would make every later assertion vacuously true.
    await expect(defaultPicker).toContainText(REPLACEMENT_DEFAULT_MODEL.name)
    await page.getByRole('button', { name: 'Close' }).click()

    // ── Turn two, under the replacement default ────────────────────────────
    // Settings is a dialog over the workspace, so closing it leaves the same
    // session open; reselecting it here would test the sidebar, not history.
    await askAgent(page, 'inheritor', 'Inheritor', 'And what did you run on now?')
    await expect(log.getByText(SECOND_ANSWER)).toBeVisible({ timeout: 60_000 })
    // Same witness for the second turn, and it has to be the *replacement*
    // pair: the two-notice claims below are about a finished, persisted turn,
    // not about text that is still arriving.
    await expect(
      chat.getByLabel(`Model: ${REPLACEMENT_DEFAULT_MODEL.id}`),
    ).toHaveCount(1, { timeout: 60_000 })

    // The wire is the independent witness that the two turns really did run on
    // two different pairs, before anything is claimed about the screen.
    // Each turn is its tool round and then its streamed final request.
    const inheritorModels = provider.requests
      .filter((request) => request.systemPrompt?.includes(INHERITOR_MARKER))
      .map((request) => [request.model, request.stream])
    expect(inheritorModels).toEqual([
      [APP_DEFAULT_MODEL.id, false],
      [APP_DEFAULT_MODEL.id, true],
      [REPLACEMENT_DEFAULT_MODEL.id, false],
      [REPLACEMENT_DEFAULT_MODEL.id, true],
    ])

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // ── Reopened from disk, which is where history has to hold ─────────────
    await page.reload()
    await openRunSession(page, SESSION_TITLE_HISTORY)

    const reloadedLog = page
      .getByRole('region', { name: 'Run chat' })
      .getByRole('log')
    await expect(reloadedLog.getByText(FIRST_ANSWER)).toBeVisible({
      timeout: 60_000,
    })
    await expect(reloadedLog.getByText(SECOND_ANSWER)).toBeVisible()

    // Narrows a failure below to one of two very different faults: a stored
    // record that was rewritten, or a correct record the renderer never shows.
    // Both are failures of the same requirement, and the difference decides
    // where the fix belongs.
    const transcript = await readTranscriptOverApi(page, SESSION_TITLE_HISTORY)
    expect(transcript).toContain(APP_DEFAULT_MODEL.id)
    expect(transcript).toContain(REPLACEMENT_DEFAULT_MODEL.id)

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // The same fact, said the other way the transcript says it: each past reply
    // is labelled with the model it ran on. Two replies from one Agent carry
    // two different labels, because the Agent's current setting is not what a
    // finished reply is described by.
    await expect(chat.getByLabel(`Model: ${APP_DEFAULT_MODEL.id}`)).toHaveCount(1)
    await expect(
      chat.getByLabel(`Model: ${REPLACEMENT_DEFAULT_MODEL.id}`),
    ).toHaveCount(1)
  } finally {
    await app.close()
    await provider.close()
  }
})

test('the model id sent to the provider is exactly the one selected', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      ...answeredTurn(
        (request) => request.systemPrompt?.includes(PINNED_MARKER) ?? false,
        PINNED_ANSWER,
      ),
      ...answeredTurn(
        (request) => request.systemPrompt?.includes(INHERITOR_MARKER) ?? false,
        FIRST_ANSWER,
      ),
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('wire-workspace')
  const projectRoot = testInfo.outputPath('wire-project')
  const userDataPath = testInfo.outputPath('wire-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, {
      name: 'pinned',
      description: 'Names its own pair.',
      marker: PINNED_MARKER,
      provider: FIXTURE_PROVIDER,
      model: ANALYST_MODEL.id,
    }),
    writeAgentPersona(projectRoot, {
      name: 'inheritor',
      description: 'Runs on the application default.',
      marker: INHERITOR_MARKER,
    }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      // Keyless, so LM Studio: the native tool route every Agent chat turn
      // takes refuses a keyless OpenAI-compatible connection.
      kind: 'lm-studio',
    }),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  await sessionStore.createSession({ title: SESSION_TITLE_WIRE })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await openRunSession(page, SESSION_TITLE_WIRE)

    const log = page.getByRole('region', { name: 'Run chat' }).getByRole('log')

    await askAgent(page, 'pinned', 'Pinned', 'Which model are you?')
    await expect(log.getByText(PINNED_ANSWER)).toBeVisible({ timeout: 60_000 })

    await askAgent(page, 'inheritor', 'Inheritor', 'Which model are you?')
    await expect(log.getByText(FIRST_ANSWER)).toBeVisible({ timeout: 60_000 })

    // Each request is attributed by the persona that produced it, so neither
    // claim below depends on arrival order.
    const pinnedModels = provider.requests
      .filter((request) => request.systemPrompt?.includes(PINNED_MARKER))
      .map((request) => request.model)
    const inheritorModels = provider.requests
      .filter((request) => request.systemPrompt?.includes(INHERITOR_MARKER))
      .map((request) => request.model)

    // Exact equality, not containment: an id that was prefixed, suffixed,
    // case-folded, or swapped for a catalog alias would still "contain" the
    // right substring under several plausible remappings.
    // One turn each: its tool round and its streamed final request.
    expect(pinnedModels).toEqual([ANALYST_MODEL.id, ANALYST_MODEL.id])
    expect(inheritorModels).toEqual([APP_DEFAULT_MODEL.id, APP_DEFAULT_MODEL.id])

    // Nothing a person *reads* is what gets sent. A catalog display name, the
    // provider id, and the legacy "let the provider choose" sentinel are the
    // three shapes a remapping bug would most plausibly put on the wire.
    const sentModels = provider.requests.map((request) => request.model)
    expect(sentModels).not.toContain(ANALYST_MODEL.name)
    expect(sentModels).not.toContain(APP_DEFAULT_MODEL.name)
    expect(sentModels).not.toContain('default')
    expect(sentModels).not.toContain(FIXTURE_PROVIDER)
    // The pinned Agent is deliberately not on the application default, so a run
    // that had quietly fallen back to the default would be visible here.
    expect(sentModels).not.toContain(REPLACEMENT_DEFAULT_MODEL.id)
  } finally {
    await app.close()
    await provider.close()
  }
})
