import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRunPlanService } from '../../services/run-orchestrator-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

// The model the deterministic server advertises, offered through a provider
// connection so the composer's model catalog contains it.
const FIXTURE_CONNECTION_ID = 'unified-agent-dispatch-fixture'
const FIXTURE_MODEL_ID = 'gpt-5.4-mini'

/**
 * One conversation, two addressees.
 *
 * This is the journey the whole change exists for: the user never picks a
 * conversation mode, only a target. Proving it needs the real renderer against
 * the real loopback API, because the thing under test is precisely that one
 * composer and one transcript survive switching who answers.
 */
test('Run Chat answers an untargeted turn, then the selected Agent, in one transcript', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('unified-agent-user-data')
  const workspacePath = testInfo.outputPath('unified-agent-workspace')
  const projectRoot = testInfo.outputPath('unified-agent-project')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ])
  await writeFixtureAgent(projectRoot, 'analyst')
  // The shipped front door names a CLI provider, and desktop seeding copies
  // only files the project root does not already have — so the fixture has to
  // be written before launch to be the one that answers. It names the fixture
  // connection: a persona model the catalog does not list was answered by the
  // Codex CLI on the developer's own account instead.
  await writeFixtureAgent(projectRoot, 'general-agent', {
    tier: 'orchestration',
    provider: `connection:${FIXTURE_CONNECTION_ID}`,
    model: FIXTURE_MODEL_ID,
  })

  // Each answer is matched on its own persona. Title and probe requests reach
  // the same server, so an ordered script handed the analyst a fallback reply.
  const generalAgentReply =
    'GENERAL-AGENT-REPLY: a market overview is a written summary.'
  const analystReply = 'ANALYST-REPLY: the market is consolidating.'
  const deterministicOpenAi = await startDeterministicOpenAiServer({
    matchers: [
      {
        match: 'Create a 4 to 6 word session title',
        text: 'Unified Agent Dispatch Transcript',
      },
      { match: 'Fixture persona: general-agent.', text: generalAgentReply },
      { match: 'Fixture persona: analyst.', text: analystReply },
    ],
  })
  await writeFixtureConnection(userDataPath, deterministicOpenAi.baseUrl)
  let app: ElectronApplication | undefined
  try {
    app = await launchDesktop({
      userDataPath,
      workspacePath,
      projectRoot,
      openAiBaseUrl: deterministicOpenAi.baseUrl,
    })
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    const apiBaseUrl = await rendererApiBaseUrl(page)

    // Act: an untargeted turn. Nobody has been selected, so the General Agent
    // answers in the same conversation.
    await sendComposerMessage(page, 'I want a market overview')
    await expect
      .poll(
        async () => {
          const sessionId = await onlySessionIdOrNull(apiBaseUrl)
          if (!sessionId) return 0
          return (await readTranscript(apiBaseUrl, sessionId)).length
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(2)

    const sessionId = await onlySessionId(apiBaseUrl)
    const afterFrontDoor = await readTranscript(apiBaseUrl, sessionId)
    expect(afterFrontDoor.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(afterFrontDoor.at(-1)?.speaker?.name).toBe('General Agent')
    expect(afterFrontDoor.at(-1)?.text).toContain(generalAgentReply)

    // Act: address one Agent by mention and speak again, without leaving the
    // conversation or switching any mode.
    const composer = page.getByRole('textbox').last()
    await composer.click()
    await composer.pressSequentially('@analyst')
    const menu = page.getByRole('listbox', { name: 'Agent mentions' })
    await expect(menu).toBeVisible({ timeout: 15_000 })
    await composer.press('Enter')
    await composer.pressSequentially(' Your read?')
    await page.keyboard.press('Enter')

    await expect
      .poll(async () => (await readTranscript(apiBaseUrl, sessionId)).length, {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(4)

    // Assert: that exact Agent replied, and both turns share one transcript.
    const transcript = await readTranscript(apiBaseUrl, sessionId)
    expect(transcript.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(transcript.at(-1)?.speaker?.name).toBe('analyst')

    expect(transcript.at(-1)?.text).toContain(analystReply)

    // Both identities are on screen in one conversation: the General Agent
    // answered the untargeted turn and the named Agent answered the targeted
    // one. That is the whole point of removing the mode switch.
    const conversation = page.getByRole('region', { name: 'Run chat' })
    await expect(
      conversation.getByText('General Agent', { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      conversation.getByText(/analyst/i).first(),
    ).toBeVisible({ timeout: 30_000 })

    // The generic AI Assistant identity is gone: an untargeted reply is the
    // General Agent's, and a targeted one carries the Agent's own name.
    await expect(page.getByText('AI Assistant', { exact: true })).toHaveCount(0)
  } finally {
    await app?.close().catch(() => undefined)
    await deterministicOpenAi.close().catch(() => undefined)
  }
})

/**
 * The same rule, inside the Deep Research workspace.
 *
 * A center workspace is a way of working, not a second dispatch authority. The
 * user selects an Agent in the sidebar the workspace is still showing, so the
 * turn they send from the planning composer has to reach that Agent — exactly
 * as it does from the ordinary composer above. Proving it needs the real
 * renderer: the defect is that one branch of the workspace switch rendered the
 * composer without the target the user had already chosen.
 */
test('Deep Research planning sends the turn to the Agent selected in the sidebar', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('deep-research-agent-user-data')
  const workspacePath = testInfo.outputPath('deep-research-agent-workspace')
  const projectRoot = testInfo.outputPath('deep-research-agent-project')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ])
  // Written before launch so desktop seeding keeps it: the seed copies only
  // files the project root does not already have, and the shipped persona
  // names a provider this test has no server for.
  await writeFixtureAgent(projectRoot, 'web-researcher')

  const deterministicOpenAi = await startDeterministicOpenAiServer({
    script: [{ text: 'WEB-RESEARCHER-REPLY: the launch evidence holds.' }],
  })
  let app: ElectronApplication | undefined
  try {
    app = await launchDesktop({
      userDataPath,
      workspacePath,
      projectRoot,
      openAiBaseUrl: deterministicOpenAi.baseUrl,
    })
    const page = await app.firstWindow()
    const apiBaseUrl = await rendererApiBaseUrl(page)

    // Arrange: a Deep Research workspace the user themselves selected, with
    // intake still unfinished so the workspace mounts without starting plan
    // generation. Only the composer's routing is under test here.
    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({
      title: 'Deep Research agent routing',
    })
    await createRunPlanService({
      sessionId: session.id,
      sessionStore,
      repoRootPath: projectRoot,
      workflowsRegistryPath: path.join(projectRoot, 'workflows', 'registry.yaml'),
      goal: 'Research the evidence behind a bounded launch decision.',
      workflowId: 'deep-research-report',
      selectionSource: 'user',
    })

    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .getByRole('button', { name: /^Deep Research agent routing\b/ })
      .first()
      .click()
    await expect(page.getByTestId('deep-research-workspace')).toBeVisible({
      timeout: 30_000,
    })

    // Act: pick the Agent in the sidebar that the workspace still shows, then
    // speak once through the planning composer.
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    const agentRow = page.getByRole('button', {
      name: 'Web Researcher',
      exact: true,
    })
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const messageResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/sessions/${session.id}/messages`),
      { timeout: 60_000 },
    )
    await sendComposerMessage(page, 'What does the evidence say so far?')

    // Assert: the server dispatched to Agents, and the persisted reply carries
    // that Agent's own name rather than the Run Coordinator's.
    const dispatched = (await (await messageResponse).json()) as {
      dispatch?: { kind?: string }
    }
    expect(dispatched.dispatch?.kind).toBe('agents')

    await expect
      .poll(async () => (await readTranscript(apiBaseUrl, session.id)).length, {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(2)
    const transcript = await readTranscript(apiBaseUrl, session.id)
    expect(
      transcript.filter((message) => message.role === 'user').map((m) => m.text),
    ).toEqual(['What does the evidence say so far?'])
    expect(transcript.at(-1)?.speaker?.name).toBe('web-researcher')
  } finally {
    await app?.close().catch(() => undefined)
    await deterministicOpenAi.close().catch(() => undefined)
  }
})

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

interface TranscriptMessage {
  readonly role: string
  readonly text: string
  readonly speaker?: { readonly name?: string }
}

async function sendComposerMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByRole('textbox').last()
  await composer.click()
  await composer.fill(text)
  await page.keyboard.press('Enter')
}

async function rendererApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const hash = await page.evaluate(() => window.location.hash.slice(1))
  const value = new URLSearchParams(hash).get('pipeline-api-base-url')
  if (!value) throw new Error('Desktop renderer did not expose its API base URL.')
  return value
}

/**
 * The conversation, once it exists.
 *
 * `null` until then rather than a throw: the desktop opens on a draft and
 * persists it with the first turn, so a poll that starts before the send lands
 * has to be able to say "not yet" without aborting itself.
 */
async function onlySessionIdOrNull(apiBaseUrl: string): Promise<string | null> {
  const response = await fetch(`${apiBaseUrl}/sessions`)
  expect(response.status).toBe(200)
  const payload = (await response.json()) as {
    sessions: Array<{ id: string; updatedAt?: string }>
  }
  return payload.sessions[0]?.id ?? null
}

async function onlySessionId(apiBaseUrl: string): Promise<string> {
  const sessionId = await onlySessionIdOrNull(apiBaseUrl)
  if (!sessionId) throw new Error('The desktop created no session.')
  return sessionId
}

async function readTranscript(
  apiBaseUrl: string,
  sessionId: string,
): Promise<TranscriptMessage[]> {
  const response = await fetch(
    `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { messages: TranscriptMessage[] }
  return payload.messages
}

async function writeFixtureAgent(
  projectRoot: string,
  name: string,
  selection: { tier: string; provider: string; model: string } = {
    tier: 'strategic',
    provider: 'openai',
    model: 'fixture/unified-dispatch',
  },
): Promise<void> {
  const directory = path.join(projectRoot, 'agents', name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `description: Deterministic ${name} dispatch fixture.`,
      `tier: ${selection.tier}`,
      `provider: ${selection.provider}`,
      `model: ${selection.model}`,
      'thinking: low',
      // The front door is the runtime's, not a Run target, exactly as the
      // shipped persona declares it.
      ...(name === 'general-agent' ? ['system: true'] : []),
      '---',
      '',
      `# ${name}`,
      '',
      'Answer the question in one sentence.',
      // Names the persona inside its own prompt, which is what the fixture
      // server matches on.
      `Fixture persona: ${name}.`,
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * The fixture connection, stored as the user's default before launch.
 *
 * The composer sends its default model on every turn, and that selection wins
 * for the General Agent, so the default has to be the fixture as well.
 */
async function writeFixtureConnection(
  userDataPath: string,
  baseUrl: string,
): Promise<void> {
  await fs.writeFile(
    path.join(userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: FIXTURE_CONNECTION_ID,
          // Keyless LM Studio: the native tool route every Agent chat turn
          // takes refuses a keyless OpenAI-compatible connection.
          kind: 'lm-studio',
          name: 'Unified dispatch fixture',
          baseUrl,
          enabled: true,
          status: 'connected',
          models: [
            {
              id: FIXTURE_MODEL_ID,
              name: 'Unified Dispatch Fixture',
              enabled: true,
              capabilities: ['chat'],
            },
          ],
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      defaultModel: {
        provider: `connection:${FIXTURE_CONNECTION_ID}`,
        model: FIXTURE_MODEL_ID,
      },
    }),
    'utf8',
  )
}

async function launchDesktop(options: {
  readonly userDataPath: string
  readonly workspacePath: string
  readonly projectRoot: string
  readonly openAiBaseUrl: string
}): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  return electron.launch({
    args: executablePath
      ? ['--disable-gpu', '--no-sandbox']
      : ['.', '--disable-gpu', '--no-sandbox'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      OPENAI_API_KEY: 'unified-dispatch-test-key',
      OPENAI_BASE_URL: options.openAiBaseUrl,
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: options.projectRoot,
      PIPELINE_DESKTOP_USER_DATA: options.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: options.workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  })
}
