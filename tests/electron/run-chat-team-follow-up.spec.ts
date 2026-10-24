/**
 * A follow-up to a Team keeps the conversation on screen.
 *
 * A Team's replies are not chat lines: the transcript rebuilds them from each
 * run's events. Sending a second message to the same Team used to clear every
 * run and read the whole session back, so the first answers vanished and came
 * back before the new run showed any work. A user watching the chat could not
 * tell what was happening.
 *
 * A companion to `run-chat-team-history-mention.spec.ts`, which covers a
 * follow-up addressed to somebody else. This one stays with the Team.
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

test("a follow-up to the same Team never takes the first run's answers off screen", async ({}, testInfo) => {
  test.setTimeout(240_000)
  const workspacePath = testInfo.outputPath('team-follow-up-workspace')
  const projectRootPath = testInfo.outputPath('team-follow-up-project')
  const userDataPath = testInfo.outputPath('team-follow-up-user-data')
  const piStatePath = testInfo.outputPath('team-follow-up-pi-state')
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

  // Content-matched so each answer belongs to a named speaker regardless of
  // how many probe requests surround the dispatches.
  const provider = await startDeterministicOpenAiServer({
    matchers: [
      { match: 'You are line-one', text: LINE_ONE_ANSWER },
      { match: 'You are line-two', text: LINE_TWO_ANSWER },
    ],
  })
  // The Team's members name no pair of their own, so they run on the
  // application default, written the way Settings writes it.
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
      OPENAI_API_KEY: 'team-follow-up-key',
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

    // Arrange: one finished Team run, its answers on screen.
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Line Team' }).click()
    const composer = page.getByRole('textbox').first()
    await composer.fill('summarize these tradeoffs')
    await composer.press('Enter')

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByText(LINE_TWO_ANSWER)).toBeVisible({
      timeout: 120_000,
    })
    await expect(chat.getByText(LINE_ONE_ANSWER)).toBeVisible()
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const sessionId = await teamChatSessionId(apiBaseUrl, 'line-team')
    await expect
      .poll(() => teamChatTaskStatuses(apiBaseUrl, sessionId), {
        timeout: 60_000,
      })
      .toEqual(['done'])

    // Every change to the page from here on is checked. A transient empty
    // transcript lasts only until the session has been read back, too short
    // for a later assertion to see, so the page records it as it happens.
    await watchForAnswerLeavingScreen(page, LINE_ONE_ANSWER)
    // The watcher must see the answer the user sees, or it reports nothing.
    expect(await answerLeftScreen(page)).toBe(false)

    // Act: a second message to the same Team, still selected.
    await composer.fill('now weigh the supplier contingency')
    await composer.press('Enter')

    // Assert: a second Team run happened in this session and answered beside
    // the first, and the first run's answer never left the screen meanwhile.
    await expect
      .poll(() => teamChatTaskStatuses(apiBaseUrl, sessionId), {
        timeout: 120_000,
      })
      .toEqual(['done', 'done'])
    await expect(chat.getByText(LINE_TWO_ANSWER)).toHaveCount(2, {
      timeout: 60_000,
    })
    expect(await answerLeftScreen(page)).toBe(false)
  } finally {
    await app.close()
    await provider.close()
  }
})

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

interface AnswerWatch {
  __answerLeftScreen?: boolean
}

/**
 * Records, on every DOM mutation, whether the Run chat still contains `answer`.
 *
 * Observes the whole document, not the chat region: a remounted chat replaces
 * the region element itself, and an observer on the old one would go quiet
 * exactly when it matters.
 */
async function watchForAnswerLeavingScreen(page: Page, answer: string): Promise<void> {
  await page.evaluate((expected) => {
    const watch: AnswerWatch = window as AnswerWatch
    watch.__answerLeftScreen = false
    const check = () => {
      // A <section> with a label: its region role is implicit, so the
      // label is the only attribute to select it by.
      const region = document.querySelector('[aria-label="Run chat"]')
      if (!region?.textContent?.includes(expected)) watch.__answerLeftScreen = true
    }
    check()
    new MutationObserver(check).observe(document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    })
  }, answer)
}

async function answerLeftScreen(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as AnswerWatch).__answerLeftScreen)
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function teamChatTaskStatuses(
  apiBaseUrl: string,
  sessionId: string,
): Promise<string[]> {
  const response = await fetch(
    `${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/tasks`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as {
    tasks: Array<{ status: string; targetKind?: string }>
  }
  return payload.tasks
    .filter((task) => task.targetKind === 'team-chat')
    .map((task) => task.status)
}

/** The session that owns this team's newest Team-chat task. */
async function teamChatSessionId(apiBaseUrl: string, teamId: string): Promise<string> {
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
