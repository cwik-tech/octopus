/**
 * O3 — a discussion Team's text grows while it is being written, then the
 * saved message takes its place.
 *
 * This is the whole-path journey for Run → Teams: the model's suffixes leave a
 * detached run child, cross two process hops into the parent, reach the
 * renderer, and are then replaced by the durable `discussion.message` that the
 * run actually recorded. Growth on its own is not the contract — an
 * implementation whose preview grew and then vanished would pass that and
 * leave the user with nothing.
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

/** Split so the first suffix can be seen alone, before the rest is released. */
const BETA_OPENING = 'Electron ships faster'
const BETA_REST = ' but Tauri ships smaller.'
const BETA_ANSWER = `${BETA_OPENING}${BETA_REST}`
const ZETA_ANSWER = 'Delivery risk is comparable.'

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

async function desktopApiBaseUrl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const base = hash.get('pipeline-api-base-url')
    if (!base) throw new Error('The desktop window carries no API base URL.')
    return base
  })
}

test('a discussion Team reply grows while it is written, then the saved message replaces it', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const paths = await makeFixtureProject(
    (name) => testInfo.outputPath(name),
    'run-streaming-discussion',
  )

  // Spec Beta streams on the direct provider lane. Bare `anthropic` has no
  // native tool lane, so the Team child calls the provider itself and each
  // suffix reaches the preview as it arrives. Its endpoint is this fake, named
  // in the Agent's own provider options, with a fake key in the guarded
  // launch. Its whole response is withheld until the journey has seen it
  // dispatched, then staged suffix by suffix.
  const anthropic = await startFakeAnthropicMessagesServer({
    turns: [{ persona: 'You are spec-beta', chunks: [BETA_OPENING, BETA_REST], blocked: true }],
  })
  // From here every fake is owned: setup, the launch and the journey run under
  // one guard, and teardown closes whatever was started, whatever failed.
  let provider: Awaited<ReturnType<typeof startDeterministicOpenAiServer>> | undefined
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await useDirectAnthropicLane(paths.projectRootPath, 'spec-beta', anthropic.messagesUrl)
    // The host, the lead and Spec Zeta stay on the OpenAI fixture. Spec Zeta
    // takes the native tool lane, which answers once; it is held with Spec
    // Beta and claimed by the persona its system message carries. The lead's
    // roster and decision requests fall through to the matchers, which name
    // what the lead is asked.
    const openAi = await startDeterministicOpenAiServer({
      blockRequestsMatching: ['You are spec-zeta'],
      resolveTurn: (body) =>
        describeChatCompletionsRequest(body).systemPrompt?.includes('You are spec-zeta')
          ? { text: ZETA_ANSWER }
          : undefined,
      matchers: [
        {
          match: 'Select the participants before any specialist runs.',
          text: JSON.stringify({
            agents: ['spec-beta', 'spec-zeta'],
            rosterRationale: {
              'spec-beta': 'Relevant desktop architecture perspective.',
              'spec-zeta': 'Relevant delivery-risk perspective.',
            },
          }),
        },
        {
          match: 'Completed specialist passes: 1',
          text: JSON.stringify({
            decision: 'complete',
            reason: 'The selected specialists resolved the runtime comparison.',
            finalResponse: 'Lead synthesis: choose the runtime that fits the delivery constraints.',
          }),
        },
      ],
    })
    provider = openAi
    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...launchEnv(paths, openAi.baseUrl, 'run-streaming-discussion-key'),
        ANTHROPIC_API_KEY: 'run-streaming-discussion-anthropic-key',
      },
    })
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: 'Board Team' }).click()

    const composer = page.getByRole('textbox').first()
    await composer.fill('which desktop runtime should we pick?')
    await composer.press('Enter')
    await expect(composer).toBeDisabled({ timeout: 20_000 })

    const chat = page.getByRole('region', { name: 'Run chat' })

    // Prove the run reached the point where a named specialist is dispatched
    // before asking about streaming. Without this the assertion below cannot
    // tell "the Team never got that far" from "it did and showed nothing".
    await expect(
      chat.getByRole('status', { name: 'Spec Beta is thinking' }),
    ).toBeVisible({ timeout: 20_000 })

    anthropic.releaseBlockedResponses()
    openAi.releaseBlockedResponses()

    // The opening suffix is on screen while the rest of the answer is still
    // being written. This is the part that cannot happen without the whole
    // cross-process path working.
    const preview = chat.getByTestId('streaming-reply')
    await expect(preview.first()).toContainText(BETA_OPENING, {
      timeout: 20_000,
    })
    await expect(preview.first()).not.toContainText(BETA_REST)

    // Release the rest of the answer but hold the frames that end the turn,
    // so the grown text is observable before the saved message takes over.
    anthropic.releaseHeldChunks()

    // ...and the answer keeps growing in the same bubble rather than being
    // replaced by a second one.
    await expect(preview.first()).toContainText(BETA_ANSWER, {
      timeout: 20_000,
    })

    anthropic.releaseTerminal()

    // Once the turn is over the preview is gone and what remains is the
    // message the run actually recorded, attributed to its speaker.
    await expect(chat.getByTestId('streaming-reply')).toHaveCount(0, {
      timeout: 20_000,
    })
    await expect(chat.getByText('Spec Beta', { exact: true })).toHaveCount(1)
    await expect(chat.getByText(BETA_ANSWER, { exact: false })).toBeVisible()

    // The text on screen is the durable one, not a preview that happened to
    // survive: it is readable back from the run's own events.
    const apiBaseUrl = await desktopApiBaseUrl(page)
    await expect(async () => {
      const { sessions } = (await (
        await fetch(`${apiBaseUrl}/sessions`)
      ).json()) as { sessions: Array<{ id: string }> }
      const durable: string[] = []
      for (const session of sessions) {
        const { tasks } = (await (
          await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks`)
        ).json()) as { tasks: Array<{ runId: string }> }
        for (const task of tasks) {
          const snapshot = (await (
            await fetch(`${apiBaseUrl}/runs/${task.runId}/events?snapshot=1`)
          ).json()) as { events?: Array<{ type: string; payload?: { text?: string } }> }
          for (const event of snapshot.events ?? []) {
            // Direct Team chat publishes contributions through the durable
            // `team.message` boundary; the legacy discussion event is
            // suppressed there so the same answer is not recorded twice.
            if (event.type === 'team.message' && event.payload?.text) {
              durable.push(event.payload.text)
            }
          }
        }
      }
      expect(durable.some((text) => text.includes(BETA_ANSWER))).toBe(true)
      // Spec Zeta ran on the native tool lane, which answers once: its whole
      // answer is stored as the durable message that replaced its preview.
      expect(durable.some((text) => text.includes(ZETA_ANSWER))).toBe(true)
    }).toPass({ timeout: 20_000 })
    await expect(chat.getByText(ZETA_ANSWER, { exact: false })).toBeVisible()
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  const openAiProvider = provider
  await finishWithTeardown(primaryFailure, [
    // Held and blocked responses are released first, so closing a server
    // does not wait on a response the journey never let finish.
    () => anthropic.releaseBlockedResponses(),
    () => anthropic.releaseHeldChunks(),
    () => anthropic.releaseTerminal(),
    ...(openAiProvider ? [() => openAiProvider.releaseBlockedResponses()] : []),
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
