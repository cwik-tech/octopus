/**
 * A streaming reply survives a switch to another session and back.
 *
 * Characterization ahead of moving the chat send path out of `ChatPanel`. The
 * desktop app remounts the chat for every session it shows, so the reply that
 * is still streaming belongs to a panel that is gone by the time it settles.
 * This journey pins what the user sees through that: where the reply lands,
 * what the other session shows meanwhile, and where focus and scroll are at
 * each step.
 *
 * The provider is an OpenAI-compatible fake on a random port, registered as a
 * connection in the profile and named by the Agent's own persona, so the turn
 * never reaches a real provider.
 */
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
  type FixtureModel,
} from './support/model-selection-fixture.js'

const STREAM_MODEL: FixtureModel = {
  id: 'fake/switch-streaming',
  name: 'Fake Switch Streaming',
}
/** Only the fixture Agent's system prompt carries this. */
const DELTA_MARKER = 'Delta answers the session switch journey.'
const QUESTION = 'Tell me about kestrels.'
const REPLY = 'Kestrels hover over fields.'
const BRAVO_DRAFT = 'Draft for Bravo'

const cleanups: Array<() => Promise<void> | void> = []
// Every step runs even when an earlier one fails, so an app that will not
// close cannot leave its provider listening or its gates held. Playwright
// keeps the test body's own failure and reports these beside it.
test.afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} teardown step(s) failed`)
  }
})

/**
 * Address the fixture Agent from the composer.
 *
 * Typing `@` opens the mention list and moves focus to its search box, so the
 * Agent is found there and picked, and the composer is checked to hold its
 * mention before the question is typed.
 */
async function addressDelta(page: Page, composer: Locator): Promise<void> {
  await composer.click()
  await composer.pressSequentially('@')
  const search = page.getByRole('combobox', { name: 'Search agents to mention' })
  await expect(search).toBeFocused({ timeout: 20_000 })
  await search.fill('delta')
  const menu = page.getByRole('listbox', { name: 'Agent mentions' })
  await menu.getByRole('option', { name: 'Delta', exact: true }).click()
  await expect(composer).toHaveValue('@delta ')
  await expect(menu).toHaveCount(0)
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

type SeededMessage = Parameters<FileSystemSessionStore['appendChatMessage']>[1]

/** Enough earlier conversation that the transcript has to scroll. */
function earlierLines(title: string, count: number): SeededMessage[] {
  return Array.from({ length: count }, (_, index): SeededMessage => ({
    id: `${title.toLowerCase()}-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `${title} line ${index}. ${'Earlier discussion that fills the conversation. '.repeat(3)}`,
    createdAt: new Date(Date.UTC(2026, 8, 20, 12, 0, index)).toISOString(),
  }))
}

test('a reply streaming in one session lands there after a switch away and back, leaving the other session as it was', async ({}, testInfo) => {
  test.setTimeout(120_000)

  // The first suffix streams on its own; the rest and the terminal chunk wait
  // until the user is on the other session.
  const firstDelta = gate()
  const rest = gate()
  cleanups.push(() => {
    firstDelta.release()
    rest.release()
  })
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          request.stream && (request.systemPrompt?.includes(DELTA_MARKER) ?? false),
        deltas: ['Kestrels ', 'hover ', 'over fields.'],
        deltaGates: [firstDelta.promise, rest.promise, rest.promise],
        gate: rest.promise,
      },
      { content: 'Ready.' },
    ],
  })
  cleanups.push(() => provider.close())

  const paths = {
    projectRoot: testInfo.outputPath('project'),
    userDataPath: testInfo.outputPath('user-data'),
    workspacePath: testInfo.outputPath('workspace'),
  }
  await fs.mkdir(paths.workspacePath, { recursive: true })
  await seedProviderSettings({
    userDataPath: paths.userDataPath,
    baseUrl: provider.url,
    models: [STREAM_MODEL],
    defaultModel: STREAM_MODEL,
    kind: 'lm-studio',
  })
  await writeAgentPersona(paths.projectRoot, {
    name: 'delta',
    description: 'Session switch journey fixture agent.',
    marker: DELTA_MARKER,
    provider: FIXTURE_PROVIDER,
    model: STREAM_MODEL.id,
  })
  const store = new FileSystemSessionStore(paths.workspacePath)
  const alpha = await store.createSession({ title: 'Alpha Journey' })
  for (const line of earlierLines('Alpha', 12)) {
    await store.appendChatMessage(alpha.id, line)
  }
  const bravo = await store.createSession({ title: 'Bravo Journey' })
  for (const line of earlierLines('Bravo', 24)) {
    await store.appendChatMessage(bravo.id, line)
  }

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment(paths),
  })
  cleanups.push(() => app.close())

  const page = await app.firstWindow()
  const navigation = page.getByRole('complementary', { name: 'Primary navigation' })
  const alphaSession = navigation.getByRole('button', { name: /^Alpha Journey\b/ })
  const bravoSession = navigation.getByRole('button', { name: /^Bravo Journey\b/ })
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const log = chat.getByRole('log')
  const composer = chat.getByRole('textbox')
  const preview = log.getByTestId('streaming-reply')
  const stop = chat.getByRole('button', { name: 'Stop generation', exact: true })

  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await alphaSession.click()
  await expect(log.getByText(/^Alpha line 11\./)).toBeVisible()

  // Alpha: ask the Agent, and watch the first words stream in at the bottom.
  await addressDelta(page, composer)
  await composer.pressSequentially(QUESTION)
  const alphaTurn = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes(`/sessions/${alpha.id}/messages`),
  )
  await composer.press('Enter')
  firstDelta.release()
  await expect(preview).toContainText('Kestrels')
  await expect(preview).toBeInViewport()
  await expect(composer).toBeDisabled()
  await expect(stop).toBeVisible()

  // Sending collapsed the session list; the user reopens it and picks Bravo.
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await bravoSession.click()
  await expect(bravoSession).toBeFocused()
  const bravoLatest = log.getByText(/^Bravo line 23\./)
  await expect(bravoLatest).toBeInViewport()
  await expect(log.getByText(/Kestrels/)).toHaveCount(0)
  await expect(preview).toHaveCount(0)
  // Bravo is waiting on nothing: its composer is open and offers no Stop.
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveValue('')
  await expect(stop).toHaveCount(0)

  await composer.click()
  await composer.pressSequentially(BRAVO_DRAFT)
  await expect(composer).toBeFocused()

  // Alpha's reply finishes while Bravo is on screen. Its request is still the
  // one Alpha sent: leaving Alpha did not end it.
  rest.release()
  const alphaSettled = await (await alphaTurn).response()
  expect(alphaSettled?.status()).toBe(201)

  // Bravo is untouched: same draft, same focus, still at its latest line, and
  // nothing of Alpha's turn.
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue(BRAVO_DRAFT)
  await expect(bravoLatest).toBeInViewport()
  await expect(log.getByText(/Kestrels/)).toHaveCount(0)
  await expect(log.getByText(QUESTION)).toHaveCount(0)

  // Back on Alpha, the reply is there once, at the bottom of the conversation.
  await alphaSession.click()
  await expect(alphaSession).toBeFocused()
  const reply = log.getByText(REPLY, { exact: true })
  await expect(reply).toBeVisible()
  await expect(reply).toBeInViewport()
  await expect(reply).toHaveCount(1)
  await expect(log.getByText(QUESTION)).toHaveCount(1)
  await expect(preview).toHaveCount(0)
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveValue('')

  // The turn went to the fixture Agent on the fixture connection.
  expect(
    provider.requests.some(
      (request) => request.systemPrompt?.includes(DELTA_MARKER) ?? false,
    ),
  ).toBe(true)
})

test('a reply that settles after the user has come back to its session appears there without reopening it', async ({}, testInfo) => {
  test.setTimeout(120_000)

  // Everything after the first suffix waits until the user is back on Alpha.
  const firstDelta = gate()
  const rest = gate()
  cleanups.push(() => {
    firstDelta.release()
    rest.release()
  })
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          request.stream && (request.systemPrompt?.includes(DELTA_MARKER) ?? false),
        deltas: ['Kestrels ', 'hover ', 'over fields.'],
        deltaGates: [firstDelta.promise, rest.promise, rest.promise],
        gate: rest.promise,
      },
      { content: 'Ready.' },
    ],
  })
  cleanups.push(() => provider.close())

  const paths = {
    projectRoot: testInfo.outputPath('project'),
    userDataPath: testInfo.outputPath('user-data'),
    workspacePath: testInfo.outputPath('workspace'),
  }
  await fs.mkdir(paths.workspacePath, { recursive: true })
  await seedProviderSettings({
    userDataPath: paths.userDataPath,
    baseUrl: provider.url,
    models: [STREAM_MODEL],
    defaultModel: STREAM_MODEL,
    kind: 'lm-studio',
  })
  await writeAgentPersona(paths.projectRoot, {
    name: 'delta',
    description: 'Session switch journey fixture agent.',
    marker: DELTA_MARKER,
    provider: FIXTURE_PROVIDER,
    model: STREAM_MODEL.id,
  })
  const store = new FileSystemSessionStore(paths.workspacePath)
  const alpha = await store.createSession({ title: 'Alpha Journey' })
  for (const line of earlierLines('Alpha', 4)) {
    await store.appendChatMessage(alpha.id, line)
  }
  const bravo = await store.createSession({ title: 'Bravo Journey' })
  for (const line of earlierLines('Bravo', 4)) {
    await store.appendChatMessage(bravo.id, line)
  }

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment(paths),
  })
  cleanups.push(() => app.close())

  const page = await app.firstWindow()
  const navigation = page.getByRole('complementary', { name: 'Primary navigation' })
  const alphaSession = navigation.getByRole('button', { name: /^Alpha Journey\b/ })
  const bravoSession = navigation.getByRole('button', { name: /^Bravo Journey\b/ })
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const log = chat.getByRole('log')
  const composer = chat.getByRole('textbox')
  const preview = log.getByTestId('streaming-reply')

  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await alphaSession.click()
  await expect(log.getByText(/^Alpha line 3\./)).toBeVisible()

  await addressDelta(page, composer)
  await composer.pressSequentially(QUESTION)
  const alphaTurn = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes(`/sessions/${alpha.id}/messages`),
  )
  await composer.press('Enter')
  firstDelta.release()
  await expect(preview).toContainText('Kestrels')

  // Away to Bravo and back to Alpha while Alpha's reply is still being written.
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await bravoSession.click()
  await expect(log.getByText(/^Bravo line 3\./)).toBeVisible()
  await alphaSession.click()
  await expect(alphaSession).toBeFocused()
  await expect(log.getByText(/^Alpha line 3\./)).toBeVisible()

  // The reply finishes while Alpha is on screen again.
  rest.release()
  const alphaSettled = await (await alphaTurn).response()
  expect(alphaSettled?.status()).toBe(201)

  // It appears in Alpha without the user reopening the session, once.
  const reply = log.getByText(REPLY, { exact: true })
  await expect(reply).toBeVisible()
  await expect(reply).toHaveCount(1)
  await expect(log.getByText(QUESTION)).toHaveCount(1)
  await expect(log.getByText(/^Bravo line/)).toHaveCount(0)
  expect(
    provider.requests.some(
      (request) => request.systemPrompt?.includes(DELTA_MARKER) ?? false,
    ),
  ).toBe(true)
})
