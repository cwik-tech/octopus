import { _electron as electron, expect, test as base, type Page, type TestInfo } from '@playwright/test'
import * as fs from 'node:fs/promises'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  isProviderHealthProbe,
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
  type FakeChatCompletionsServer,
  type FakeChatCompletionsTurn,
} from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const ALPHA_MARKER = 'Dialogue fixture persona alpha-analyst.'
const BETA_MARKER = 'Dialogue fixture persona beta-builder.'
const TOPIC = 'Discuss whether a small pilot would settle the pricing question.'

/** Match each paid-provider replacement by persona and request kind. */
function answeredBy(marker: string, content: string): FakeChatCompletionsTurn[] {
  const isAgent = (request: FakeChatCompletionsRequest): boolean =>
    request.systemPrompt?.includes(marker) === true
  return [
    { match: (request) => isAgent(request) && !request.stream, content },
    { match: (request) => isAgent(request) && request.stream, content },
  ]
}

async function createJourney(testInfo: TestInfo, provider: FakeChatCompletionsServer) {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRoot = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, {
      name: 'alpha-analyst',
      description: 'Examines the pricing pilot.',
      marker: ALPHA_MARKER,
    }),
    writeAgentPersona(projectRoot, {
      name: 'beta-builder',
      description: 'Challenges the pricing pilot.',
      marker: BETA_MARKER,
    }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      kind: 'lm-studio',
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Agent dialogue journey' })
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })
  return { app, provider, session, store }
}

function makeTurnGate() {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release: () => release() }
}

const test = base.extend<{
  holdFirstTurn: boolean
  failFirstTurn: boolean
  startFromChat: boolean
  firstTurnGate: ReturnType<typeof makeTurnGate>
  provider: FakeChatCompletionsServer
  journey: Awaited<ReturnType<typeof createJourney>>
}>({
  holdFirstTurn: [false, { option: true }],
  failFirstTurn: [false, { option: true }],
  startFromChat: [false, { option: true }],
  firstTurnGate: async ({}, use) => {
    const gate = makeTurnGate()
    try { await use(gate) } finally { gate.release() }
  },
  provider: async ({ holdFirstTurn, failFirstTurn, startFromChat, firstTurnGate }, use) => {
    // The real provider is paid and nondeterministic. Replace its HTTP boundary;
    // Electron, the local API, Agent execution and filesystem stores remain real.
    const provider = await startFakeChatCompletionsServer({
      script: [
        ...(startFromChat ? [
          { match: (request: FakeChatCompletionsRequest) => !request.stream && request.systemPrompt?.includes('Session chat rules:') === true,
            toolCalls: [{ id: 'start-peer-discussion', name: 'start_dialogue', arguments: { agents: ['beta-builder'], topic: TOPIC, maxTurns: 2 } }] },
          { match: (request: FakeChatCompletionsRequest) => !request.stream && request.systemPrompt?.includes('Session chat rules:') === true,
            content: 'I have started the discussion with beta-builder.' },
          { match: (request: FakeChatCompletionsRequest) => request.stream && request.systemPrompt?.includes('Session chat rules:') === true,
            content: 'I have started the discussion with beta-builder.' },
        ] : []),
        { match: (request) => request.systemPrompt?.includes(ALPHA_MARKER) === true && !request.stream,
          ...(failFirstTurn ? { failStatus: 400 } : { content: 'A small pilot can measure willingness to pay.' }) },
        // A rejected non-streaming tool round ends this turn before the streamed
        // final request. Leave no unused failure to consume the Agent's next turn.
        ...(failFirstTurn ? [] : [{ match: (request: FakeChatCompletionsRequest) => request.systemPrompt?.includes(ALPHA_MARKER) === true && request.stream,
          content: 'A small pilot can measure willingness to pay.',
          ...(holdFirstTurn ? { gate: firstTurnGate.promise } : {}) }]),
        ...answeredBy(BETA_MARKER, 'Only if the pilot includes customers who declined.'),
        ...answeredBy(ALPHA_MARKER, 'Then recruit both buyers and people who declined.'),
        ...answeredBy(BETA_MARKER, 'That gives us a comparison worth measuring.'),
        ...answeredBy(ALPHA_MARKER, '[pass]'),
        ...answeredBy(BETA_MARKER, '[pass]'),
        ...answeredBy(ALPHA_MARKER, 'Use the comparison to choose a sensible pilot price.'),
        ...answeredBy(BETA_MARKER, '[pass]'),
        ...answeredBy(ALPHA_MARKER, '[pass]'),
        { content: 'OK' },
      ],
    })
    try {
      await use(provider)
    } finally {
      await provider.close()
    }
  },
  journey: async ({ provider }, use, testInfo) => {
    // The provider fixture tears down even if filesystem or desktop setup fails.
    const journey = await createJourney(testInfo, provider)
    const stderr: Buffer[] = []
    journey.app.process().stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    try {
      await use(journey)
    } finally {
      await testInfo.attach('desktop-stderr', { body: Buffer.concat(stderr), contentType: 'text/plain' })
      await testInfo.attach('desktop-lifetime', { contentType: 'application/json', body: JSON.stringify({
        processId: journey.app.process().pid,
        exitCode: journey.app.process().exitCode,
        // The desktop API path is a capability. Retain only its origin/port.
        apiOrigins: journey.app.windows().map((page) => {
          const base = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('pipeline-api-base-url')
          return base ? new URL(base).origin : null
        }),
      }) })
      await journey.app.close()
    }
  },
})

test.describe('a typed dialogue request in ordinary chat', () => {
  test.use({ startFromChat: true, holdFirstTurn: true })

  test('asking an Agent to discuss with a peer acquires dialogue controls and replies in the already-open chat', async ({ journey, firstTurnGate }) => {
    const page = await journey.app.firstWindow()
    await openSession(page, journey.session.id)
    const sidebar = await openAgents(page)
    await sidebar.getByRole('button', { name: 'Alpha Analyst', exact: true }).click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByRole('textbox').fill('Discuss pricing with beta-builder.')
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()

    await expect(chat.getByRole('log').getByText('I have started the discussion with beta-builder.', { exact: true })).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Pause dialogue', exact: true })).toBeEnabled()
    await expect(chat.getByRole('button', { name: 'Stop dialogue', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
    await expect(sidebar.getByRole('tab', { name: 'Talk to each other', exact: true })).toHaveAttribute('aria-selected', 'true')
    firstTurnGate.release()

    await expect(chat.getByRole('log').getByText('A small pilot can measure willingness to pay.', { exact: true })).toBeVisible()
    await expect(chat.getByRole('log').getByText('Only if the pilot includes customers who declined.', { exact: true })).toBeVisible()
    await expect(chat.getByText('Reached the 2-turn limit.', { exact: true })).toBeVisible()
    expect((await journey.store.listChatMessages(journey.session.id)).map((message) => message.text)).toEqual([
      'Discuss pricing with beta-builder.', TOPIC, 'I have started the discussion with beta-builder.',
      'A small pilot can measure willingness to pay.', 'Only if the pilot includes customers who declined.',
    ])
  })
})

async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  const opened = page.waitForResponse((response) =>
    response.request().method() === 'GET' &&
    new URL(response.url()).pathname.endsWith(`/sessions/${sessionId}`),
  )
  await page.getByRole('complementary', { name: 'Primary navigation', exact: true })
    .getByRole('button', { name: /^Agent dialogue journey\b/ }).click()
  expect((await opened).ok()).toBe(true)
}

async function openAgents(page: Page) {
  const sidebar = page.getByRole('complementary', { name: 'Primary navigation', exact: true })
  await sidebar.getByRole('tablist', { name: 'Run navigation', exact: true })
    .getByRole('tab', { name: 'Agents', exact: true }).click()
  return sidebar
}

async function selectParticipants(page: Page): Promise<void> {
  const sidebar = await openAgents(page)
  await sidebar.getByRole('button', { name: 'Alpha Analyst', exact: true }).click()
  await sidebar.getByRole('button', { name: 'Beta Builder', exact: true }).click()
  await expect(sidebar.getByRole('list', { name: 'Selected agents', exact: true }))
    .toContainText('Alpha Analyst')
  await expect(sidebar.getByRole('list', { name: 'Selected agents', exact: true }))
    .toContainText('Beta Builder')
}

test('Talk to each other alternates saved replies and ends when both Agents pass', async ({ journey }) => {
  const page = await journey.app.firstWindow()
  await openSession(page, journey.session.id)
  await selectParticipants(page)
  const dialogueMode = page.getByRole('tab', { name: 'Talk to each other', exact: true })
  await expect(dialogueMode).toBeVisible()
  await dialogueMode.click()

  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  await chat.getByRole('textbox').fill(TOPIC)
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()

  await expect(chat.getByText('They had nothing more to add.', { exact: true }))
    .toBeVisible()
  await expect(chat.getByRole('log').getByText('A small pilot can measure willingness to pay.', { exact: true }))
    .toBeVisible()
  await expect(chat.getByRole('log').getByText('Only if the pilot includes customers who declined.', { exact: true }))
    .toBeVisible()
  await expect(chat.getByRole('log').getByText('Then recruit both buyers and people who declined.', { exact: true }))
    .toBeVisible()
  await expect(chat.getByRole('log').getByText('That gives us a comparison worth measuring.', { exact: true }))
    .toBeVisible()
  await expect(chat.getByText('[pass]', { exact: true })).toHaveCount(0)

  const messages = await journey.store.listChatMessages(journey.session.id)
  expect(messages.filter((message) => message.role === 'user').map((message) => message.text))
    .toEqual([TOPIC])
  expect(messages.filter((message) => message.role === 'assistant').map((message) => [message.speaker?.id, message.text]))
    .toEqual([
      ['alpha-analyst', 'A small pilot can measure willingness to pay.'],
      ['beta-builder', 'Only if the pilot includes customers who declined.'],
      ['alpha-analyst', 'Then recruit both buyers and people who declined.'],
      ['beta-builder', 'That gives us a comparison worth measuring.'],
    ])
  await expect(chat.getByRole('textbox')).toBeEnabled()
})

test('multiple selected Agents default to Discussion mode and reply once after Send', async ({ journey }) => {
  const page = await journey.app.firstWindow()
  await openSession(page, journey.session.id)
  const workRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === 'POST' && (pathname.endsWith(`/sessions/${journey.session.id}/dialogues`) || pathname.endsWith(`/sessions/${journey.session.id}/messages`))) {
      workRequests.push(pathname.endsWith(`/sessions/${journey.session.id}/dialogues`) ? 'dialogue' : 'messages')
    }
  })
  await selectParticipants(page)
  const discussionMode = page.getByRole('tab', { name: 'Discussion mode', exact: true })
  await expect(discussionMode).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Talk to each other', exact: true }).click()
  await discussionMode.click()
  expect(workRequests).toEqual([])
  expect(journey.provider.requests.filter((request) => !isProviderHealthProbe(request)))
    .toHaveLength(0)
  expect(await journey.store.listChatMessages(journey.session.id)).toEqual([])

  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const completed = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith(`/sessions/${journey.session.id}/messages`),
  )
  await chat.getByRole('textbox').fill(TOPIC)
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  expect((await completed).ok()).toBe(true)
  expect(workRequests).toEqual(['messages'])
  await expect(chat.getByText('A small pilot can measure willingness to pay.', { exact: true }))
    .toBeVisible()
  await expect(chat.getByText('Only if the pilot includes customers who declined.', { exact: true }))
    .toBeVisible()
  await expect(chat.getByRole('textbox')).toBeEnabled()

  const messages = await journey.store.listChatMessages(journey.session.id)
  expect(messages.filter((message) => message.role === 'assistant').map((message) => [message.speaker?.id, message.text]))
    .toEqual([
      ['alpha-analyst', 'A small pilot can measure willingness to pay.'],
      ['beta-builder', 'Only if the pilot includes customers who declined.'],
    ])
  await expect(chat.getByText('They had nothing more to add.', { exact: true })).toHaveCount(0)
  expect(journey.provider.requests.filter((request) => request.stream && !isProviderHealthProbe(request)))
    .toHaveLength(2)
})


test.describe('controlling a dialogue while an Agent writes', () => {
  test.use({ holdFirstTurn: true })

  test('Stop discards the unfinished reply and leaves the saved topic readable', async ({ journey }) => {
    const page = await journey.app.firstWindow()
    await openSession(page, journey.session.id)
    await selectParticipants(page)
    await page.getByRole('tab', { name: 'Talk to each other', exact: true }).click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByRole('textbox').fill(TOPIC)
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(chat.getByText('A small pilot can measure willingness to pay.', { exact: true })).toBeVisible()
    await expect(chat.getByRole('textbox')).toBeEnabled()

    await expect(chat.getByRole('button', { name: 'Stop dialogue', exact: true })).toBeVisible()
    await chat.getByRole('button', { name: 'Stop dialogue', exact: true }).click()

    await expect(chat.getByText('Stopped.', { exact: true })).toBeVisible()
    await expect(chat.getByText('A small pilot can measure willingness to pay.', { exact: true })).toHaveCount(0)
    expect((await journey.store.listChatMessages(journey.session.id)).map((message) => [message.role, message.text]))
      .toEqual([['user', TOPIC]])
    await expect(chat.getByRole('textbox')).toBeEnabled()
  })

  test('a typed interjection is saved while the current Agent finishes and the next Agent answers it', async ({ journey, firstTurnGate }) => {
    const page = await journey.app.firstWindow()
    await openSession(page, journey.session.id)
    await selectParticipants(page)
    await page.getByRole('tab', { name: 'Talk to each other', exact: true }).click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByRole('textbox').fill(TOPIC)
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(chat.getByText('A small pilot can measure willingness to pay.', { exact: true })).toBeVisible()
    const interjection = 'Compare buyers with people who declined.'

    await chat.getByRole('textbox').fill(interjection)
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()

    await expect(chat.getByRole('log').getByText(interjection, { exact: true })).toBeVisible()
    await expect(chat.getByRole('textbox')).toHaveValue('')
    expect((await journey.store.listChatMessages(journey.session.id)).filter((message) => message.role === 'assistant'))
      .toEqual([])
    firstTurnGate.release()
    await expect(chat.getByText('They had nothing more to add.', { exact: true })).toBeVisible()
    await expect(chat.getByRole('log').getByText('Only if the pilot includes customers who declined.', { exact: true })).toBeVisible()
    const betaRequest = journey.provider.requests.find((request) => request.stream && request.systemPrompt?.includes(BETA_MARKER))
    expect(JSON.stringify(betaRequest?.body)).toContain(interjection)
    expect((await journey.store.listChatMessages(journey.session.id)).filter((message) => message.role === 'user').map((message) => message.text))
      .toEqual([TOPIC, interjection])
  })
})


test.describe('pausing a dialogue', () => {
  test.use({ holdFirstTurn: true })

  test('Pause lets the current reply finish and Resume continues with the next Agent', async ({ journey, firstTurnGate }) => {
    const page = await journey.app.firstWindow()
    await openSession(page, journey.session.id)
    await selectParticipants(page)
    await page.getByRole('tab', { name: 'Talk to each other', exact: true }).click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByRole('textbox').fill(TOPIC)
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(chat.getByText('A small pilot can measure willingness to pay.', { exact: true })).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Pause dialogue', exact: true })).toBeVisible()

    await chat.getByRole('button', { name: 'Pause dialogue', exact: true }).click()

    await expect(chat.getByRole('button', { name: 'Resume dialogue', exact: true })).toBeVisible()
    const saved = page.waitForResponse((response) => response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith(`/sessions/${journey.session.id}/messages`))
    firstTurnGate.release()
    expect((await saved).ok()).toBe(true)
    expect((await journey.store.listChatMessages(journey.session.id)).filter((message) => message.role === 'assistant').map((message) => message.speaker?.id))
      .toEqual(['alpha-analyst'])
    expect(journey.provider.requests.filter((request) => request.stream && !isProviderHealthProbe(request))).toHaveLength(1)
    await expect(chat.getByRole('textbox')).toBeEnabled()
    await chat.getByRole('button', { name: 'Resume dialogue', exact: true }).click()

    await expect(chat.getByText('They had nothing more to add.', { exact: true })).toBeVisible()
    expect((await journey.store.listChatMessages(journey.session.id)).filter((message) => message.role === 'assistant').map((message) => message.speaker?.id))
      .toEqual(['alpha-analyst', 'beta-builder', 'alpha-analyst', 'beta-builder'])
  })
})

test('Keep going creates a new dialogue and reopening keeps both dialogues readable without starting work', async ({ journey }) => {
  const page = await journey.app.firstWindow()
  await openSession(page, journey.session.id)
  await selectParticipants(page)
  await page.getByRole('tab', { name: 'Talk to each other', exact: true }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  const startPaths: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(`/sessions/${journey.session.id}/dialogues`)) startPaths.push(request.url())
  })
  const firstStarted = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith(`/sessions/${journey.session.id}/dialogues`))
  await chat.getByRole('textbox').fill(TOPIC)
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  const firstPayload: unknown = await (await firstStarted).json()
  const first = agentDialogueRecordSchema.parse(firstPayload)
  await expect(chat.getByText('They had nothing more to add.', { exact: true })).toBeVisible()
  await expect(chat.getByRole('button', { name: 'Keep going', exact: true })).toBeVisible()
  const nextStarted = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith(`/sessions/${journey.session.id}/dialogues`))

  await chat.getByRole('button', { name: 'Keep going', exact: true }).click()

  const nextPayload: unknown = await (await nextStarted).json()
  const next = agentDialogueRecordSchema.parse(nextPayload)
  expect(next.sessionId).toBe(journey.session.id)
  expect(next.dialogueId).not.toBe(first.dialogueId)
  expect(next.continues).toBe(first.dialogueId)
  await expect(chat.getByRole('log').getByText('Use the comparison to choose a sensible pilot price.', { exact: true })).toBeVisible()
  await expect(chat.getByText('They had nothing more to add.', { exact: true })).toBeVisible()
  await page.reload()
  await openSession(page, journey.session.id)

  const reloadedChat = page.getByRole('region', { name: 'Run chat', exact: true })
  await expect(reloadedChat.getByRole('log').getByText('A small pilot can measure willingness to pay.', { exact: true })).toBeVisible()
  await expect(reloadedChat.getByRole('log').getByText('Only if the pilot includes customers who declined.', { exact: true })).toBeVisible()
  await expect(reloadedChat.getByRole('log').getByText('Then recruit both buyers and people who declined.', { exact: true })).toBeVisible()
  await expect(reloadedChat.getByRole('log').getByText('That gives us a comparison worth measuring.', { exact: true })).toBeVisible()
  await expect(reloadedChat.getByRole('log').getByText('Use the comparison to choose a sensible pilot price.', { exact: true })).toBeVisible()
  await expect(reloadedChat.getByRole('button', { name: 'Keep going', exact: true })).toBeVisible()
  expect(startPaths).toHaveLength(2)
})

test.describe('a failed dialogue speaker', () => {
  test.use({ failFirstTurn: true })

  test('a failed Agent is shown as a status while the next Agent replies normally', async ({ journey }) => {
    const page = await journey.app.firstWindow()
    await openSession(page, journey.session.id)
    await selectParticipants(page)
    await page.getByRole('tab', { name: 'Talk to each other', exact: true }).click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByRole('textbox').fill(TOPIC)
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()

    await expect(chat.getByRole('status').filter({ hasText: 'Alpha Analyst could not reply.' })).toBeVisible()
    await expect(chat.getByRole('log').getByText('Only if the pilot includes customers who declined.', { exact: true })).toBeVisible()
    await expect(chat.getByText('They had nothing more to add.', { exact: true })).toBeVisible()
    expect((await journey.store.listChatMessages(journey.session.id)).filter((message) => message.role === 'assistant').map((message) => message.text))
      .toEqual(['Only if the pilot includes customers who declined.', 'Then recruit both buyers and people who declined.', 'That gives us a comparison worth measuring.'])
  })
})
