/** Agent model inheritance keeps the admitted model on each reply without adding model-default cards. */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  isProviderHealthProbe,
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
  type FakeChatCompletionsServer,
  type FakeChatCompletionsTurn,
} from '../support/fake-chat-completions-server.js'
import { desktopEnvironment } from './support/model-selection-fixture.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const CONNECTION_ID = '9a1c7e10-3d55-4b2f-8e64-0c9d21ab7742'
const DEFAULT_MODEL = 'fake/app-default'
const PINNED_MODEL = 'fake/pinned'
/** Phrases only each Agent's own persona carries, so its requests can be told apart. */
const INHERITOR_MARKER = 'Inheritor persona marker: runs on the application default.'
const PINNED_MARKER = 'Pinned persona marker: names its own model.'

async function seedProviderSettings(
  userDataPath: string,
  baseUrl: string,
): Promise<void> {
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(
    path.join(userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: CONNECTION_ID,
          // A keyless connection. The native tool route every Agent chat turn
          // takes accepts LM Studio without a key; it refuses a keyless
          // OpenAI-compatible connection at provider resolution.
          kind: 'lm-studio',
          name: 'Fake selection provider',
          baseUrl: `${baseUrl}/v1`,
          enabled: true,
          status: 'connected',
          models: [
            {
              id: DEFAULT_MODEL,
              name: 'Fake App Default',
              enabled: true,
              capabilities: ['chat'],
            },
            {
              id: PINNED_MODEL,
              name: 'Fake Pinned',
              enabled: true,
              capabilities: ['chat'],
            },
          ],
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      // The one deliberately selected application default.
      defaultModel: {
        provider: `connection:${CONNECTION_ID}`,
        model: DEFAULT_MODEL,
      },
    }),
    'utf8',
  )
}

/** An agent that names no pair, so it inherits the application default. */
async function writeInheritingAgent(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', 'inheritor')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'inheritor.md'),
    [
      '---',
      'name: inheritor',
      'description: Runs on the application default.',
      'tier: strategic',
      'thinking: low',
      '---',
      '',
      '# inheritor',
      '',
      INHERITOR_MARKER,
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/** An agent that names its own pair, deliberately not the application default. */
async function writePinnedAgent(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', 'pinned')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'pinned.md'),
    [
      '---',
      'name: pinned',
      'description: Names its own model.',
      'tier: strategic',
      `provider: connection:${CONNECTION_ID}`,
      `model: ${PINNED_MODEL}`,
      'thinking: low',
      '---',
      '',
      '# pinned',
      '',
      PINNED_MARKER,
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * Open a session by its own durable title.
 *
 * Scoped to the desktop's left sidebar. The Run panel mounts a second session
 * list that is permanently collapsed (`sidebarOpen={false}`); its buttons still
 * report a bounding box, so an unscoped locator can resolve to one of those and
 * then time out because the chat workspace covers it.
 */
async function openRunSession(page: Page, title: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page
    .locator('[data-slot="workspace-sidebar"][data-side="left"]')
    .getByRole('button', { name: new RegExp(`^${title}\\b`) })
    .first()
    .click()
}

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
 * One Agent turn's answers, claimed only by that Agent's own requests.
 *
 * A displayed Agent turn is two requests on the native tool route: a buffered
 * tool round and then the streamed, tool-free final request whose text is
 * shown. Both carry the persona, so a request from any other Agent, the
 * General Agent included, claims neither and gets no scripted answer.
 */
function answeredBy(
  marker: string,
  content: string,
  hold?: Promise<void>,
): FakeChatCompletionsTurn[] {
  const isAgent = (request: FakeChatCompletionsRequest): boolean =>
    request.systemPrompt?.includes(marker) ?? false
  return [
    { match: (request) => isAgent(request) && !request.stream, content, ...(hold ? { gate: hold } : {}) },
    { match: (request) => isAgent(request) && request.stream, content, ...(hold ? { gate: hold, deltaGates: [hold] } : {}) },
  ]
}

/** Every request the turn sent, leaving out only the app's own health probes. */
function turnRequests(provider: FakeChatCompletionsServer): FakeChatCompletionsRequest[] {
  return provider.requests.filter((request) => !isProviderHealthProbe(request))
}

/**
 * The model selections the server admitted for the session's turns, as stored
 * with each user message before any provider call and served by the desktop
 * API. This is the durable record of which pair a turn ran on and why.
 */
async function admittedSelectionsOverApi(
  page: Page,
  sessionId: string,
): Promise<unknown[]> {
  return page.evaluate(async (id) => {
    const base = new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url')
    if (!base) throw new Error('Desktop API URL is unavailable')
    const response = await fetch(`${base}/sessions/${encodeURIComponent(id)}/messages`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Reading session ${id} messages answered HTTP ${response.status}`)
    const body: unknown = await response.json()
    const messages = typeof body === 'object' && body !== null && 'messages' in body && Array.isArray(body.messages)
      ? body.messages
      : []
    return messages.flatMap((message: unknown) => {
      if (typeof message !== 'object' || message === null || !('turnRequest' in message)) return []
      const request = message.turnRequest
      if (typeof request !== 'object' || request === null || !('admittedSelections' in request)) return []
      const selections = request.admittedSelections
      return typeof selections === 'object' && selections !== null ? Object.values(selections) : []
    })
  }, sessionId)
}

test('an inheriting Agent keeps its reply model without default-use cards before or after reopening', async ({}, testInfo) => {
  test.setTimeout(120_000)

  let releaseAnswer: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseAnswer = resolve
  })
  const provider = await startFakeChatCompletionsServer({
    // `deltaGates[0]` is what actually holds the first token: the fixture
    // awaits it *before* writing delta 0, whereas the plain `gate` is awaited
    // only after every delta has already gone out. With `gate` alone the
    // "before the first token" claim below would have been satisfied by the
    // test simply being quicker than the stream, not by the answer being held.
    // `gate` is kept as well so a non-streaming request — which never consults
    // `deltaGates` — is held too.
    script: answeredBy(INHERITOR_MARKER, 'Considered and answered.', gate),
  })

  const workspacePath = testInfo.outputPath('selection-workspace')
  const projectRoot = testInfo.outputPath('selection-project')
  const userDataPath = testInfo.outputPath('selection-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeInheritingAgent(projectRoot),
    seedProviderSettings(userDataPath, provider.url),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Selection Journey' })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await openRunSession(page, 'Selection Journey')

    await askAgent(page, 'inheritor', 'Inheritor', 'Say something')

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
    await expect(
      page.getByRole('region', { name: 'Run chat' })
        .getByRole('log')
        .getByText('Considered and answered.'),
    ).toHaveCount(0)

    releaseAnswer()

    const chat = page.getByRole('region', { name: 'Run chat' })
    const log = chat.getByRole('log')
    await expect(log.getByText('Considered and answered.')).toBeVisible({
      timeout: 30_000,
    })
    // Still disclosed after the reply lands — and read from the durable record
    // this time. The reply's own model label is derived from the turn's stored
    // admitted selection and has no live-frame source at all, so unlike the
    // notice above it cannot be satisfied by the frame published before the
    // provider answered.
    await expect(chat.getByLabel(`Model: ${DEFAULT_MODEL}`)).toHaveCount(1, {
      timeout: 30_000,
    })
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // Who answered, on what, and why. Every request of the turn carried the
    // inheritor's own persona and the application default, as the tool round
    // and then the streamed final request; and the server admitted that pair
    // for this turn from the application default. A General Agent reply could
    // satisfy none of these.
    expect(turnRequests(provider).map((request) => [
      request.systemPrompt?.includes(INHERITOR_MARKER) ?? false,
      request.model,
      request.stream,
    ])).toEqual([[true, DEFAULT_MODEL, false], [true, DEFAULT_MODEL, true]])
    expect(await admittedSelectionsOverApi(page, session.id)).toEqual([
      expect.objectContaining({ provider: `connection:${CONNECTION_ID}`, model: DEFAULT_MODEL, source: 'app-default' }),
    ])

    // Reopened from the transcript on disk, which is where history has to say
    // what the turn ran on. Reloaded rather than tab-switched, so nothing the
    // renderer was still holding in memory can answer for the record.
    await page.reload()
    await openRunSession(page, 'Selection Journey')
    await expect(log.getByText('Considered and answered.')).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
    await expect(chat.getByLabel(`Model: ${DEFAULT_MODEL}`)).toHaveCount(1)
  } finally {
    releaseAnswer()
    await app.close()
    await provider.close()
  }
})

test('an Agent that names its own model gets no default-use notice', async ({}, testInfo) => {
  test.setTimeout(120_000)

  const provider = await startFakeChatCompletionsServer({
    script: answeredBy(PINNED_MARKER, 'Pinned and answered.'),
  })

  const workspacePath = testInfo.outputPath('pinned-workspace')
  const projectRoot = testInfo.outputPath('pinned-project')
  const userDataPath = testInfo.outputPath('pinned-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writePinnedAgent(projectRoot),
    seedProviderSettings(userDataPath, provider.url),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Pinned Journey' })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await openRunSession(page, 'Pinned Journey')

    await askAgent(page, 'pinned', 'Pinned', 'Say something')

    const chat = page.getByRole('region', { name: 'Run chat' })
    const log = chat.getByRole('log')
    await expect(log.getByText('Pinned and answered.')).toBeVisible({
      timeout: 60_000,
    })
    // The reply is labelled with the pair it ran on, from the stored record.
    await expect(chat.getByLabel(`Model: ${PINNED_MODEL}`)).toHaveCount(1, {
      timeout: 30_000,
    })
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // Who answered, on what, and why: the pinned Agent's own persona on its
    // own model for both requests of the turn, admitted from the Agent's
    // setting, not from the application default.
    expect(turnRequests(provider).map((request) => [
      request.systemPrompt?.includes(PINNED_MARKER) ?? false,
      request.model,
      request.stream,
    ])).toEqual([[true, PINNED_MODEL, false], [true, PINNED_MODEL, true]])
    expect(await admittedSelectionsOverApi(page, session.id)).toEqual([
      expect.objectContaining({ provider: `connection:${CONNECTION_ID}`, model: PINNED_MODEL, source: 'agent' }),
    ])
  } finally {
    await app.close()
    await provider.close()
  }
})
