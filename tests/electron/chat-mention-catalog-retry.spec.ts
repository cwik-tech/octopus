/**
 * A Run chat whose Agent list failed to load recovers once the list can load.
 *
 * The renderer asks the desktop's loopback API for the Agent catalog. Here
 * that request fails at the renderer's own network boundary, as a dropped or
 * refused request would, and then starts succeeding. The chat must ask again
 * when it next needs the list, without being reopened. Which triggers ask
 * again is covered by the component tests in
 * `ui/src/components/run/chat/__tests__/chat-panel-keyboard.test.tsx`; this
 * journey covers the real path once.
 *
 * The provider is an OpenAI-compatible fake on a random port, registered as a
 * keyless LM Studio connection and named by the Agent's own persona, so the
 * turn never reaches a real provider.
 */
import { _electron as electron, expect, test } from '@playwright/test'
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

const RETRY_MODEL: FixtureModel = {
  id: 'fake/mention-catalog-retry',
  name: 'Fake Mention Catalog Retry',
}
/** Only the fixture Agent's system prompt carries this. */
const DELTA_MARKER = 'Delta answers the mention catalog journey.'
const QUESTION = 'Tell me about kestrels.'
const REPLY = 'Kestrels hover over fields.'
const CATALOG_OUTAGE = 'Agent catalog temporarily unavailable.'

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

/** The plain catalog request the chat's mention list makes. */
function isMentionCatalogRequest(url: URL): boolean {
  return url.pathname.endsWith('/create/agents') && url.search === ''
}

test('a chat whose Agent list failed to load asks again when the mention list next opens, and the mention works', async ({}, testInfo) => {
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
    models: [RETRY_MODEL],
    defaultModel: RETRY_MODEL,
    kind: 'lm-studio',
  })
  await writeAgentPersona(paths.projectRoot, {
    name: 'delta',
    description: 'Mention catalog journey fixture agent.',
    marker: DELTA_MARKER,
    provider: FIXTURE_PROVIDER,
    model: RETRY_MODEL.id,
  })
  const store = new FileSystemSessionStore(paths.workspacePath)
  const session = await store.createSession({ title: 'Catalog Journey' })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment(paths),
  })
  cleanups.push(() => app.close())

  // The first window is the startup page; the chat's renderer loads into it
  // later, so the route is in place before the catalog is first requested.
  // Every catalog request fails until the journey has seen the failure.
  const page = await app.firstWindow()
  let catalogOnline = false
  let refusedCatalogRequests = 0
  await page.route(
    (url) => isMentionCatalogRequest(url),
    async (route) => {
      if (catalogOnline) {
        await route.continue()
        return
      }
      refusedCatalogRequests += 1
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: CATALOG_OUTAGE }),
      })
    },
  )

  const navigation = page.getByRole('complementary', { name: 'Primary navigation' })
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const composer = chat.getByRole('textbox')
  const search = page.getByRole('combobox', { name: 'Search agents to mention' })
  const menu = page.getByRole('listbox', { name: 'Agent mentions' })

  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await navigation.getByRole('button', { name: /^Catalog Journey\b/ }).click()

  // The list cannot load: the mention list says so.
  await composer.click()
  await composer.pressSequentially('Ask @')
  await expect(search).toBeFocused({ timeout: 20_000 })
  await expect(
    page.getByText(`Could not load agents: ${CATALOG_OUTAGE}`),
  ).toBeVisible()
  expect(refusedCatalogRequests).toBeGreaterThan(0)

  // The catalog comes back. The chat is not reopened: the list is closed and
  // opened again from the composer.
  catalogOnline = true
  await search.press('Escape')
  await expect(composer).toBeFocused()
  const recovered = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return isMentionCatalogRequest(url) && response.status() === 200
  })
  await composer.fill('')
  await composer.pressSequentially('Ask @')
  await expect(search).toBeFocused({ timeout: 20_000 })
  await search.fill('delta')
  const delta = menu.getByRole('option', { name: 'Delta', exact: true })
  await expect(delta).toBeVisible()
  await recovered

  // The mention works end to end.
  await delta.click()
  await expect(composer).toHaveValue('Ask @delta ')
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
  expect(
    provider.requests.some(
      (request) => request.systemPrompt?.includes(DELTA_MARKER) ?? false,
    ),
  ).toBe(true)
})
