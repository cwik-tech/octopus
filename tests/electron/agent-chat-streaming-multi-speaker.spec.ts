/**
 * O2 — one bubble per speaker, each closing independently.
 *
 * Two selected agents answer the same turn. Their replies are separate bubbles
 * that grow and settle on their own, and the second speaker keeps streaming
 * after the first has finished.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROVIDER_FAILURE_USER_MESSAGES } from '../../contracts/provider.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { logConversationMessage } from '../../domains/runtime/logger.js'
import type { ResearchWebActivityView } from '../../services/research-web-tool-service.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const CONNECTION_ID = '11111111-2222-3333-4444-555555555555'
const MODEL_ID = 'fake/streaming'
const PROVIDER_NAME = `connection:${CONNECTION_ID}`

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
          // Keyless, so not `openai-compatible`: the native tool route every
          // Agent now takes refuses that kind without a key.
          kind: 'lm-studio',
          name: 'Fake streaming provider',
          baseUrl: `${baseUrl}/v1`,
          enabled: true,
          status: 'connected',
          models: [
            { id: MODEL_ID, name: 'Fake Streaming', enabled: true, capabilities: ['chat'] },
          ],
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      defaultModel: { provider: PROVIDER_NAME, model: MODEL_ID },
    }),
    'utf8',
  )
}

async function createAgent(projectRoot: string, name: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `description: Streaming multi-speaker E2E ${name}.`,
      'tier: execution',
      `provider: ${PROVIDER_NAME}`,
      `model: ${MODEL_ID}`,
      'thinking: low',
      'tools: none',
      '---',
      '',
      `# ${name}`,
      '',
      'Answer briefly.',
      '',
    ].join('\n'),
    'utf8',
  )
}

test('each selected agent gets its own bubble, closing independently', async ({}, testInfo) => {
  test.setTimeout(120_000)

  // Speakers run in order, so one gate per delta covers both replies: the
  // first two suffixes belong to the first speaker, the last two to the second.
  const releases: Array<() => void> = []
  const deltaGates = [0, 1, 2, 3].map(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      }),
  )
  // One scripted turn per speaker. Speakers run in order, so the first script
  // entry answers the first speaker and the second answers the second — which
  // is only true because the fixture scripts per request rather than replaying
  // one delta array for every call.
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          request.stream && (request.systemPrompt ?? '').includes('alpha-analyst'),
        deltas: ['Kestrel ', 'Marlin'],
        deltaGates: [deltaGates[0]!, deltaGates[1]!],
      },
      {
        match: (request) =>
          request.stream && (request.systemPrompt ?? '').includes('beta-builder'),
        deltas: ['Quokka ', 'Tapir'],
        deltaGates: [deltaGates[2]!, deltaGates[3]!],
      },
      // Anything else (a tool-loop probe, a title request) answers instantly.
      { content: 'ok' },
    ],
  })
  const releaseAll = () => {
    for (const release of releases) release()
  }

  const workspacePath = testInfo.outputPath('multi-workspace')
  const projectRoot = testInfo.outputPath('multi-project')
  const userDataPath = testInfo.outputPath('multi-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(path.join(projectRoot, 'agents'), { recursive: true }),
    seedProviderSettings(userDataPath, provider.url),
  ])
  await Promise.all([
    createAgent(projectRoot, 'alpha-analyst'),
    createAgent(projectRoot, 'beta-builder'),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Duet Journey' })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: /^Duet Journey\b/ }).first().click()

    const showInspector = page.getByRole('button', { name: 'Show inspector' })
    if (await showInspector.isVisible()) await showInspector.click()

    // The picker stays open between selections, so it is opened once and both
    // agents are chosen inside it. Agents are listed by display name.
    await page.getByRole('button', { name: 'Search Agents' }).click()
    const search = page.getByRole('searchbox', { name: 'Search Agents' })
    for (const [id, label] of [
      ['alpha-analyst', /^Alpha Analyst/i],
      ['beta-builder', /^Beta Builder/i],
    ] as const) {
      await search.fill(id)
      await page.getByRole('button', { name: label }).first().click()
    }
    await page.keyboard.press('Escape')

    const composer = page.getByPlaceholder(/Send a message to the selected agents/i)
    await composer.fill('Both of you answer')
    await page.getByRole('button', { name: 'Send message' }).click()

    const log = page.getByRole('region', { name: 'Run chat' }).getByRole('log')

    // First speaker streams.
    releases[0]?.()
    await expect(log.getByText(/Kestrel/)).toBeVisible({ timeout: 40_000 })
    await expect(log.getByText(/Quokka/)).toHaveCount(0)
    releases[1]?.()
    await expect(log.getByText(/Kestrel Marlin/)).toBeVisible({ timeout: 40_000 })

    // Second speaker streams into its own bubble while the first is finished.
    releases[2]?.()
    await expect(log.getByText(/Quokka/)).toBeVisible({ timeout: 40_000 })
    await expect(log.getByText(/Kestrel Marlin/)).toBeVisible()
    releases[3]?.()
    await expect(log.getByText(/Quokka Tapir/)).toBeVisible({ timeout: 40_000 })

    // Two distinct replies are persisted, one per speaker.
    await expect
      .poll(
        async () => {
          const messages = await sessionStore.listChatMessages(session.id)
          return messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.speaker?.id)
            .sort()
        },
        { timeout: 40_000 },
      )
      .toEqual(['alpha-analyst', 'beta-builder'])
  } finally {
    releaseAll()
    await app.close()
    await provider.close()
  }
})

test('a failing speaker does not stop the speakers around it', async ({}, testInfo) => {
  test.setTimeout(120_000)

  // Success, failure, success — the shape that proves one speaker's error is
  // contained rather than ending the turn. A speaker's answer is its streamed
  // final request; its buffered first round falls through to `ok`, which is
  // never shown. The failing speaker fails on its first request.
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          request.stream && (request.systemPrompt ?? '').includes('alpha-analyst'),
        content: 'Kestrel answered',
      },
      {
        match: (request) => (request.systemPrompt ?? '').includes('beta-builder'),
        failStatus: 502,
      },
      {
        match: (request) =>
          request.stream && (request.systemPrompt ?? '').includes('gamma-guide'),
        content: 'Tapir answered',
      },
      { content: 'ok' },
    ],
  })

  const workspacePath = testInfo.outputPath('fail-workspace')
  const projectRoot = testInfo.outputPath('fail-project')
  const userDataPath = testInfo.outputPath('fail-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(path.join(projectRoot, 'agents'), { recursive: true }),
    seedProviderSettings(userDataPath, provider.url),
  ])
  await Promise.all([
    createAgent(projectRoot, 'alpha-analyst'),
    createAgent(projectRoot, 'beta-builder'),
    createAgent(projectRoot, 'gamma-guide'),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Trio Journey' })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: /^Trio Journey\b/ }).first().click()

    const showInspector = page.getByRole('button', { name: 'Show inspector' })
    if (await showInspector.isVisible()) await showInspector.click()

    await page.getByRole('button', { name: 'Search Agents' }).click()
    const search = page.getByRole('searchbox', { name: 'Search Agents' })
    for (const [id, label] of [
      ['alpha-analyst', /^Alpha Analyst/i],
      ['beta-builder', /^Beta Builder/i],
      ['gamma-guide', /^Gamma Guide/i],
    ] as const) {
      await search.fill(id)
      await page.getByRole('button', { name: label }).first().click()
    }
    await page.keyboard.press('Escape')

    const composer = page.getByPlaceholder(/Send a message to the selected agents/i)
    await composer.fill('All three answer')
    await page.getByRole('button', { name: 'Send message' }).click()

    const log = page.getByRole('region', { name: 'Run chat' }).getByRole('log')

    // The speaker after the failure still answers, so the failure was contained.
    await expect(log.getByText(/Tapir answered/)).toBeVisible({ timeout: 60_000 })
    await expect(log.getByText(/Kestrel answered/)).toBeVisible()

    // The persisted turn records all three, with the failure reported as text
    // rather than a missing reply.
    await expect
      .poll(
        async () => {
          const messages = await sessionStore.listChatMessages(session.id)
          return messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.speaker?.id)
        },
        { timeout: 60_000 },
      )
      .toEqual(['alpha-analyst', 'beta-builder', 'gamma-guide'])

    // Exact pairs, not merely "something was written": a failure that silently
    // inherited a neighbour's answer would pass a non-empty check.
    const persisted = await sessionStore.listChatMessages(session.id)
    const pairs = persisted
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.speaker?.id, message.text] as const)
    expect(pairs[0]?.[0]).toBe('alpha-analyst')
    expect(pairs[0]?.[1]).toBe('Kestrel answered')
    expect(pairs[2]?.[0]).toBe('gamma-guide')
    expect(pairs[2]?.[1]).toBe('Tapir answered')

    const beta = pairs[1]
    expect(beta?.[0]).toBe('beta-builder')
    const betaText = beta?.[1] ?? ''
    expect(betaText).not.toBe('')
    expect(betaText).not.toBe('Kestrel answered')
    expect(betaText).not.toBe('Tapir answered')
    // The failure is reported to the user as its own text, not borrowed. On
    // the native tool route a bare 502 carries no recognized error, so it is
    // the sanitized message for an unknown failure.
    expect(betaText).toBe(PROVIDER_FAILURE_USER_MESSAGES.unknown)
  } finally {
    await app.close()
    await provider.close()
  }
})

test('an agent follow-up shows progress after completed scheduled research and keeps its identity through the reply', async ({}, testInfo) => {
  let releaseFirstText = () => {}
  let releaseAnswer = () => {}
  const firstText = new Promise<void>((resolve) => { releaseFirstText = resolve })
  const answer = new Promise<void>((resolve) => { releaseAnswer = resolve })
  // Replace only the paid provider's HTTP boundary. The desktop, turn service,
  // saved research history, agent selection and event stream remain real.
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) => request.stream && (request.systemPrompt ?? '').includes('alpha-analyst'),
        deltas: ['The news deserves ', 'closer scrutiny.'],
        deltaGates: [firstText, answer],
      },
      { content: 'ok' },
    ],
  })
  const workspacePath = testInfo.outputPath('workspace')
  const projectRoot = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    createAgent(projectRoot, 'alpha-analyst'),
    seedProviderSettings(userDataPath, provider.url),
  ])
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({
    title: 'Completed scheduled research',
    origin: { kind: 'scheduled', scheduleId: 'sch_00000000-0000-4000-8000-000000000001' },
  })
  const task = await store.createTaskRecord(session.id, {
    workflowId: 'scheduled-agent-web-researcher-0123456789ab',
    brief: 'Research the news.',
  })
  if (!task?.assignmentPath) throw new Error('The completed research needs an assignment')
  logConversationMessage(task.assignmentPath, {
    from: 'Web Researcher', to: 'all', round: 1,
    timestamp: '2026-09-09T12:00:01.000Z', type: 'position',
    message: 'The research report is ready for discussion.',
  }, task.runId, { sessionId: 'research-history', stageType: 'discussion', team: 'research-team' })
  await store.updateTaskRecord(session.id, task.id, {
    status: 'done', completedAt: '2026-09-09T12:00:02.000Z',
  })
  const research: ResearchWebActivityView = {
    activityId: 'old-research', sessionId: session.id, runId: task.runId,
    assignmentId: 'old-assignment', activityScopeId: 'old-scope',
    agentPath: 'agents/web-researcher', toolCallId: 'old-call',
    action: 'search', state: 'completed', resultCount: 6, attempts: [],
    createdAt: '2026-09-09T12:00:00.000Z', updatedAt: '2026-09-09T12:00:01.000Z',
  }
  await fs.writeFile(path.join(workspacePath, 'sessions', session.id, 'research-acquisition.json'), JSON.stringify([research]))
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(), NODE_ENV: 'test', PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Use dark mode', exact: true }).click()
    await page.getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: /^Completed scheduled research/ }).click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    await expect(chat.getByText('The research report is ready for discussion.', { exact: true })).toBeVisible()
    await expect(chat.getByRole('button', { name: /^Research activity:/ })).toBeVisible()
    await page.locator('aside[aria-label="Context sidebar"]')
      .getByRole('button', { name: /^Alpha Analyst/ }).click()
    await chat.getByRole('textbox').fill('What do you think about that news?')
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()

    const progress = chat.getByRole('status', { name: /alpha.analyst is responding/i })
    await expect(progress).toBeVisible()
    await expect(progress).toContainText('Preparing a response')
    await expect(chat.getByRole('textbox')).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('agent-pending.png'), animations: 'disabled' })

    releaseFirstText()
    const preview = chat.getByTestId('streaming-reply')
    await expect(preview).toContainText('The news deserves')
    await expect(progress).toHaveCount(0)
    await expect(preview.getByLabel('Model: fake/streaming', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('agent-streaming.png'), animations: 'disabled' })

    releaseAnswer()
    await expect(chat.getByRole('textbox')).toBeEnabled()
    await expect(preview).toHaveCount(0)
    await expect(chat.getByText('The news deserves closer scrutiny.', { exact: true })).toBeVisible()
    await expect(chat.getByLabel('Model: fake/streaming', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: /^Completed scheduled research/ }).click()
    await expect(chat.getByText('The news deserves closer scrutiny.', { exact: true })).toBeVisible()
    await expect(chat.getByLabel('Model: fake/streaming', { exact: true })).toBeVisible()
    await expect(chat.getByRole('status', { name: /alpha.analyst is responding/i })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('agent-complete.png'), animations: 'disabled' })
  } finally {
    releaseFirstText()
    releaseAnswer()
    await app.close()
    await provider.close()
  }
})
