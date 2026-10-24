/**
 * O4 — a chain Team's text grows while it is written, and is then replaced by
 * the durable record of the same answer rather than disappearing.
 *
 * A chain step now publishes a durable `team.message`, so the ephemeral preview
 * has something to be replaced by. What is not allowed is a reply that grows on
 * screen and then vanishes, leaving the user looking at the space where an
 * answer used to be. The handoff bubble that used to stand in for the missing
 * record is deliberately suppressed for a step that has one: showing both would
 * render the same answer twice.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  describeChatCompletionsRequest,
  startDeterministicOpenAiServer,
} from './support/deterministic-openai-server.js'
import { startFakeAnthropicMessagesServer } from './support/fake-anthropic-messages-server.js'
import { useDirectAnthropicLane } from './support/direct-anthropic-lane.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const STEP_OPENING = 'The first tradeoff'
const STEP_REST = ' is portability.'
const STEP_ANSWER = `${STEP_OPENING}${STEP_REST}`
const LINE_TWO_ANSWER = 'The second tradeoff is tooling.'

async function makeFixtureProject(
  outputPath: (name: string) => string,
  name: string,
) {
  const workspacePath = outputPath(`${name}-workspace`)
  const projectRootPath = outputPath(`${name}-project`)
  const userDataPath = outputPath(`${name}-user-data`)
  const piStatePath = outputPath(`${name}-pi-state`)
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
  // Team tier defaults no longer choose an agent's model. Pin the actual
  // fixture agents, as team-chat.spec.ts does, so these journeys never depend
  // on a developer's settings.
  for (const agentId of await fs.readdir(path.join(projectRootPath, 'agents'))) {
    const agentFile = path.join(projectRootPath, 'agents', agentId, `${agentId}.md`)
    const prompt = await fs.readFile(agentFile, 'utf8')
    await fs.writeFile(agentFile, `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\n${prompt}`)
  }
  return { workspacePath, projectRootPath, userDataPath, piStatePath }
}

function launchEnv(
  paths: {
    projectRootPath: string
    userDataPath: string
    workspacePath: string
    piStatePath: string
  },
  baseUrl: string,
  key: string,
) {
  return {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: '/usr/bin:/bin' }),
    NODE_ENV: 'test',
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: baseUrl,
    PI_CODING_AGENT_DIR: paths.piStatePath,
    PIPELINE_DESKTOP_PROJECT_ROOT: paths.projectRootPath,
    PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: paths.userDataPath,
    PIPELINE_DESKTOP_WORKSPACE_PATH: paths.workspacePath,
  }
}

/**
 * The status of the most recent task in this profile.
 *
 * Not filtered by team: this profile launches exactly one task, and matching
 * on a team identifier here would turn a naming mismatch into a silent
 * timeout rather than a visible assertion.
 */
async function latestTeamTaskStatus(
  page: Page,
  apiBaseUrl: string,
): Promise<string | undefined> {
  return page.evaluate(async (baseUrl) => {
    const { sessions } = (await (await fetch(`${baseUrl}/sessions`)).json()) as {
      sessions: Array<{ id: string }>
    }
    for (const session of sessions) {
      const { tasks } = (await (
        await fetch(`${baseUrl}/sessions/${session.id}/tasks`)
      ).json()) as { tasks: Array<{ status: string }> }
      if (tasks.length > 0) return tasks[tasks.length - 1]?.status
    }
    return undefined
  }, apiBaseUrl)
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const base = hash.get('pipeline-api-base-url')
    if (!base) throw new Error('The desktop window carries no API base URL.')
    return base
  })
}

test('a chain Team reply grows, then becomes its step outcome rather than disappearing', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makeFixtureProject(
    (name) => testInfo.outputPath(name),
    'run-streaming-discard',
  )

  // Line One streams on the direct provider lane. Bare `anthropic` has no
  // native tool lane, so the Team child calls the provider itself and each
  // suffix reaches the preview as it arrives. Its endpoint is this fake, named
  // in the Agent's own provider options, with a fake key in the guarded launch.
  const anthropic = await startFakeAnthropicMessagesServer({
    turns: [{ persona: 'You are line-one', chunks: [STEP_OPENING, STEP_REST] }],
  })
  // From here every fake is owned: setup, the launch and the journey run under
  // one guard, and teardown closes whatever was started, whatever failed.
  let provider: Awaited<ReturnType<typeof startDeterministicOpenAiServer>> | undefined
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await useDirectAnthropicLane(paths.projectRootPath, 'line-one', anthropic.messagesUrl)
    // The host and Line Two stay on the OpenAI fixture. Line Two takes the
    // native tool lane, which answers once, so its turn is claimed by the
    // persona its system message carries and answered whole.
    const openAi = await startDeterministicOpenAiServer({
      resolveTurn: (body) =>
        describeChatCompletionsRequest(body).systemPrompt?.includes('You are line-two')
          ? { text: LINE_TWO_ANSWER }
          : undefined,
    })
    provider = openAi
    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...launchEnv(paths, openAi.baseUrl, 'run-streaming-discard-key'),
        ANTHROPIC_API_KEY: 'run-streaming-discard-anthropic-key',
      },
    })
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Line Team' }).click()

    const composer = page.getByRole('textbox').first()
    await composer.fill('summarize these tradeoffs')
    await composer.press('Enter')

    const chat = page.getByRole('region', { name: 'Run chat' })

    // Prove the run actually started before asking about streaming. Without
    // this the assertion below cannot tell "the Team never ran" from "the
    // Team ran and showed nothing", and only the second is the contract.
    const apiBaseUrl = await desktopApiBaseUrl(page)
    await expect
      .poll(() => latestTeamTaskStatus(page, apiBaseUrl), { timeout: 20_000 })
      .toMatch(/queued|running|done/)

    // The step's opening suffix is on screen while the rest is still being
    // written.
    const preview = chat.getByTestId('streaming-reply')
    await expect(preview.first()).toContainText(STEP_OPENING, {
      timeout: 20_000,
    })
    await expect(preview.first()).not.toContainText(STEP_REST)

    // Release the rest of the answer but hold the frames that end the turn,
    // so the finished text is on screen while its dispatch is still running.
    // Released together they reach the renderer in one paint and the grown
    // text would never be observable at all.
    anthropic.releaseHeldChunks()
    await expect(preview.first()).toContainText(STEP_ANSWER, {
      timeout: 20_000,
    })

    anthropic.releaseTerminal()
    await expect
      .poll(() => latestTeamTaskStatus(page, apiBaseUrl), { timeout: 20_000 })
      .toBe('done')

    // The preview is gone, and the answer is not: a chain step now records a
    // durable `team.message`, which is what replaces the ephemeral stream. The
    // handoff bubble is deliberately suppressed for a step that has one —
    // showing both would render the same answer twice.
    await expect(chat.getByTestId('streaming-reply')).toHaveCount(0)
    await expect(chat.getByTestId('stream-handoff')).toHaveCount(0)
    await expect(async () => {
      const durable = await durableTeamMessages(apiBaseUrl)
      expect(durable.some((text) => text.includes(STEP_ANSWER))).toBe(true)
    }).toPass({ timeout: 20_000 })

    // Line Two ran on the native tool lane, which answers once: its whole
    // answer is on screen, and the durable message has replaced its preview.
    await expect(chat.getByText(LINE_TWO_ANSWER, { exact: false })).toBeVisible()
    await expect(async () => {
      const durable = await durableTeamMessages(apiBaseUrl)
      expect(durable.some((text) => text.includes(LINE_TWO_ANSWER))).toBe(true)
    }).toPass({ timeout: 20_000 })
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  const openAiProvider = provider
  await finishWithTeardown(primaryFailure, [
    // Held responses are released first, so closing a server does not wait
    // on a response the journey never let finish.
    () => anthropic.releaseHeldChunks(),
    () => anthropic.releaseTerminal(),
    ...(launched ? [() => launched.close()] : []),
    ...(openAiProvider ? [() => openAiProvider.close()] : []),
    () => anthropic.close(),
  ])
})

/**
 * Runs every teardown step even when an earlier one fails, then rethrows the
 * journey's own failure with any teardown errors beside it, never instead of
 * it.
 */
async function finishWithTeardown(
  primaryFailure: { readonly error: unknown } | undefined,
  steps: readonly (() => unknown)[],
): Promise<void> {
  const teardownErrors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      teardownErrors.push(error)
    }
  }
  if (primaryFailure && teardownErrors.length > 0) {
    throw new AggregateError(
      [primaryFailure.error, ...teardownErrors],
      'The journey failed, and so did its teardown',
    )
  }
  if (primaryFailure) throw primaryFailure.error
  if (teardownErrors.length > 0) {
    throw new AggregateError(teardownErrors, 'The journey passed, but its teardown failed')
  }
}

/** Text of every durable `team.message` recorded across the session's runs. */
async function durableTeamMessages(apiBaseUrl: string): Promise<string[]> {
  const texts: string[] = []
  const { sessions } = (await (
    await fetch(`${apiBaseUrl}/sessions`)
  ).json()) as { sessions: Array<{ id: string }> }
  for (const session of sessions) {
    const { tasks } = (await (
      await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks`)
    ).json()) as { tasks: Array<{ runId: string }> }
    for (const task of tasks) {
      const snapshot = (await (
        await fetch(`${apiBaseUrl}/runs/${task.runId}/events?snapshot=1`)
      ).json()) as {
        events?: Array<{ type: string; payload?: { text?: string } }>
      }
      for (const event of snapshot.events ?? []) {
        if (event.type === 'team.message' && event.payload?.text) {
          texts.push(event.payload.text)
        }
      }
    }
  }
  return texts
}
