/**
 * A finished Team discussion is history, not a standing instruction.
 *
 * Reopening a session whose Team run has ended shows that discussion again,
 * and the user's next message may be addressed to somebody else entirely. The
 * restored transcript must keep showing what happened without capturing the
 * mention that follows it.
 *
 * A companion to `team-chat.spec.ts` rather than another branch inside it: the
 * setup that matters here is the reload, and burying it inside a Team roster
 * journey would hide which part of the state is under test.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'
import {
  APP_DEFAULT_MODEL,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const LINE_ONE_ANSWER =
  'Line one recommends a phased rollout of the assembly retooling.'
const LINE_TWO_ANSWER =
  'Line two confirms the phased rollout and adds a supplier contingency.'
const RESEARCHER_ANSWER =
  'WEB-RESEARCHER-REPLY: the supplier contingency is the larger open risk.'

test('a finished Team discussion does not capture the next mention', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const workspacePath = testInfo.outputPath('team-history-workspace')
  const projectRootPath = testInfo.outputPath('team-history-project')
  const userDataPath = testInfo.outputPath('team-history-user-data')
  const piStatePath = testInfo.outputPath('team-history-pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'team-chat-e2e'),
      projectRootPath,
      { recursive: true },
    ),
  ])
  // The Agent addressed after the run. Written before launch so desktop
  // seeding keeps it: the shipped persona names a provider this test has no
  // server for, and the seed copies only files the project root lacks.
  await fs.mkdir(path.join(projectRootPath, 'agents', 'web-researcher'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(projectRootPath, 'agents', 'web-researcher', 'web-researcher.md'),
    [
      '---',
      'name: web-researcher',
      'description: Deterministic web-researcher dispatch fixture.',
      'tier: strategic',
      'provider: openai',
      'model: gpt-5.4-mini',
      'thinking: low',
      '---',
      '',
      '# web-researcher',
      '',
      'You are web-researcher in a deterministic E2E fixture. Answer in one sentence.',
      '',
    ].join('\n'),
    'utf8',
  )

  // Content-matched so each answer belongs to a named speaker regardless of
  // how many probe and coordinator requests surround the dispatches.
  const provider = await startDeterministicOpenAiServer({
    matchers: [
      { match: 'You are line-one', text: LINE_ONE_ANSWER },
      { match: 'You are line-two', text: LINE_TWO_ANSWER },
      { match: 'You are web-researcher', text: RESEARCHER_ANSWER },
    ],
  })
  // An application default, written the way Settings writes it. Neither Team
  // member names a pair of its own — the only one in `line-team/team.yaml` sits
  // in the retired `models.execution` block, which nothing obeys any more — so
  // without this there is nothing for them to run on and nothing for the
  // composer to offer. An API key in the environment is not a chosen default.
  await seedProviderSettings({
    userDataPath,
    baseUrl: provider.baseUrl.replace(/\/v1$/, ''),
    defaultModel: APP_DEFAULT_MODEL,
    kind: 'lm-studio',
  })
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'team-history-key',
      OPENAI_BASE_URL: provider.baseUrl,
      PI_CODING_AGENT_DIR: piStatePath,
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()

    // Arrange: run a Team to completion, so the session owns a terminal Team
    // task and a discussion worth restoring.
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Line Team' }).click()
    const composer = page.getByRole('textbox').first()
    await composer.fill('summarize these tradeoffs')
    await composer.press('Enter')
    await expect
      .poll(() => latestTeamChatTaskStatus(page, 'line-team'), {
        timeout: 120_000,
      })
      .toBe('done')

    // Reopen it. Reloading opens a fresh session by design, so the session
    // that ran is renamed and reselected by its own id rather than by a title
    // two runs could share.
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const sessionId = await teamChatSessionId(page, 'line-team')
    const restoredTitle = `Team history ${sessionId.slice(0, 8)}`
    const renamed = await fetch(`${apiBaseUrl}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: restoredTitle }),
    })
    expect(renamed.ok).toBe(true)

    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: restoredTitle, exact: true }).click()

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByText(LINE_ONE_ANSWER)).toBeVisible({
      timeout: 60_000,
    })
    await expect(chat.getByText(LINE_TWO_ANSWER)).toBeVisible()
    const tasksBefore = await teamChatTaskCount(apiBaseUrl, sessionId)

    // Act: address one Agent by mention. Nothing was selected after the
    // reload, so the only Team on screen is the one the transcript remembers.
    const restoredComposer = page.getByRole('textbox').first()
    await restoredComposer.click()
    await restoredComposer.pressSequentially('@web-researcher')
    await restoredComposer.press('Enter')
    await restoredComposer.pressSequentially(' what is the biggest risk?')
    const messageResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/sessions/${sessionId}/messages`),
      { timeout: 60_000 },
    )
    await page.keyboard.press('Enter')

    // Assert: the mention was resolved globally and that Agent answered. No
    // second Team task started, and the discussion is still on screen.
    const dispatched = (await (await messageResponse).json()) as {
      dispatch?: { kind?: string }
    }
    expect(dispatched.dispatch?.kind).toBe('agents')

    await expect
      .poll(
        async () => {
          const messages = await readTranscript(apiBaseUrl, sessionId)
          return messages.at(-1)?.speaker?.name ?? null
        },
        { timeout: 60_000 },
      )
      .toBe('web-researcher')
    expect(await teamChatTaskCount(apiBaseUrl, sessionId)).toBe(tasksBefore)
    await expect(chat.getByText(LINE_ONE_ANSWER)).toBeVisible()
  } finally {
    await app.close()
    await provider.close()
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

async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
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

async function teamChatTaskCount(
  apiBaseUrl: string,
  sessionId: string,
): Promise<number> {
  const response = await fetch(
    `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/tasks`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as {
    tasks: Array<{ targetKind?: string }>
  }
  return payload.tasks.filter((task) => task.targetKind === 'team-chat').length
}

/** The session that owns this team's newest Team-chat task. */
async function teamChatSessionId(page: Page, teamId: string): Promise<string> {
  const apiBaseUrl = await desktopApiBaseUrl(page)
  const { sessions } = (await (
    await fetch(`${apiBaseUrl}/sessions`)
  ).json()) as { sessions: Array<{ id: string }> }
  const owning = await Promise.all(
    sessions.map(async (session) => {
      const { tasks } = (await (
        await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks`)
      ).json()) as {
        tasks: Array<{ createdAt: string; targetKind?: string; teamId?: string }>
      }
      return tasks
        .filter((task) => task.targetKind === 'team-chat' && task.teamId === teamId)
        .map((task) => ({ createdAt: task.createdAt, sessionId: session.id }))
    }),
  )
  const newest = owning
    .flat()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)
  if (!newest) throw new Error(`No Team-chat task found for team '${teamId}'`)
  return newest.sessionId
}

async function latestTeamChatTaskStatus(
  page: Page,
  teamId: string,
): Promise<string | null> {
  const apiBaseUrl = await desktopApiBaseUrl(page)
  const { sessions } = (await (
    await fetch(`${apiBaseUrl}/sessions`)
  ).json()) as { sessions: Array<{ id: string }> }
  const taskLists = await Promise.all(
    sessions.map(async (session) => {
      const response = await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks`)
      return (await response.json()) as {
        tasks: Array<{
          createdAt: string
          status: string
          targetKind?: string
          teamId?: string
        }>
      }
    }),
  )
  return taskLists
    .flatMap((payload) => payload.tasks)
    .filter((task) => task.targetKind === 'team-chat' && task.teamId === teamId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.status ?? null
}
