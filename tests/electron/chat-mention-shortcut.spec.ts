/**
 * Cmd- or Ctrl-Enter in the Run chat's mention list picks an Agent and sends
 * nothing.
 *
 * Typing `@` moves focus into the mention list's own search box, which is
 * rendered in a popover, and the panel also listens for Cmd/Ctrl-Enter on the
 * whole document to send. Both only exist together in the real renderer, so
 * this is the desktop half of the component tests in
 * `ui/src/components/run/chat/__tests__/chat-panel-keyboard.test.tsx`.
 *
 * The provider is an OpenAI-compatible fake on a random port, registered as a
 * keyless LM Studio connection and named by the Agent's own persona, so the
 * turn never reaches a real provider.
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

const SHORTCUT_MODEL: FixtureModel = {
  id: 'fake/mention-shortcut',
  name: 'Fake Mention Shortcut',
}
/** Only the fixture Agent's system prompt carries this. */
const DELTA_MARKER = 'Delta answers the mention shortcut journey.'
const QUESTION = 'Tell me about kestrels.'
const REPLY = 'Kestrels hover over fields.'

const cleanups: Array<() => Promise<void> | void> = []
// Every step runs even when an earlier one fails, so an app that will not
// close cannot leave its provider listening. Playwright keeps the test body's
// own failure and reports these beside it.
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
 * Starts a fresh draft, opens the mention list and searches for Delta.
 *
 * The draft has words before the mention, so a keypress that wrongly sent it
 * would send a real message rather than one the composer refuses as empty.
 */
async function searchForDelta(page: Page, composer: Locator): Promise<Locator> {
  await composer.click()
  await composer.fill('')
  await composer.pressSequentially('Ask @')
  const search = page.getByRole('combobox', { name: 'Search agents to mention' })
  await expect(search).toBeFocused({ timeout: 20_000 })
  await search.fill('delta')
  const menu = page.getByRole('listbox', { name: 'Agent mentions' })
  await expect(menu.getByRole('option', { name: 'Delta', exact: true })).toBeVisible()
  return search
}

test('Cmd- and Ctrl-Enter in the mention list pick the Agent without sending, and the next send goes out once', async ({}, testInfo) => {
  test.setTimeout(120_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          request.stream && (request.systemPrompt?.includes(DELTA_MARKER) ?? false),
        deltas: ['Kestrels ', 'hover ', 'over fields.'],
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
    models: [SHORTCUT_MODEL],
    defaultModel: SHORTCUT_MODEL,
    kind: 'lm-studio',
  })
  await writeAgentPersona(paths.projectRoot, {
    name: 'delta',
    description: 'Mention shortcut journey fixture agent.',
    marker: DELTA_MARKER,
    provider: FIXTURE_PROVIDER,
    model: SHORTCUT_MODEL.id,
  })
  const store = new FileSystemSessionStore(paths.workspacePath)
  const session = await store.createSession({ title: 'Shortcut Journey' })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment(paths),
  })
  cleanups.push(() => app.close())

  const page = await app.firstWindow()
  // Every message the renderer sends for this session, in order.
  const messagePosts: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().includes(`/sessions/${session.id}/messages`)
    ) {
      messagePosts.push(request.postData() ?? '')
    }
  })

  const navigation = page.getByRole('complementary', { name: 'Primary navigation' })
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const composer = chat.getByRole('textbox')
  const menu = page.getByRole('listbox', { name: 'Agent mentions' })

  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await navigation.getByRole('button', { name: /^Shortcut Journey\b/ }).click()

  // Cmd-Enter in the search box picks the highlighted Agent.
  let search = await searchForDelta(page, composer)
  await search.press('Meta+Enter')
  await expect(composer).toHaveValue('Ask @delta ')
  await expect(menu).toHaveCount(0)

  // So does Ctrl-Enter.
  search = await searchForDelta(page, composer)
  await search.press('Control+Enter')
  await expect(composer).toHaveValue('Ask @delta ')
  await expect(menu).toHaveCount(0)

  // A normal send then goes out once, addressed to Delta.
  await composer.pressSequentially(QUESTION)
  const turn = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes(`/sessions/${session.id}/messages`),
  )
  await composer.press('Enter')
  const settled = await (await turn).response()
  expect(settled?.status()).toBe(201)
  await expect(chat.getByRole('log').getByText(REPLY, { exact: true })).toBeVisible()

  // Neither pick sent anything: the only message is the one sent on purpose.
  expect(messagePosts).toHaveLength(1)
  expect(messagePosts[0]).toContain(QUESTION)
  expect(
    provider.requests.some(
      (request) => request.systemPrompt?.includes(DELTA_MARKER) ?? false,
    ),
  ).toBe(true)
})
