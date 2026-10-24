/** Create uses the selected or application-default model without adding informational model-default cards. */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

/** Frontmatter-free in the seeded project, so the Architect inherits. */
const ARCHITECT_PROMPT_MARKER = 'You are the Agent Architect'

const ARCHITECT_REPLY =
  'Tell me which responsibilities the new Agent should own.'
const UNAVAILABLE_PREFIX = 'The Agent Architect is unavailable:'

interface RecordedTurnBody {
  readonly provider?: unknown
  readonly model?: unknown
  readonly composerSelection?: unknown
}

/**
 * Record what the renderer actually posts for an Architect turn.
 *
 * Installed as an init script and applied by reloading, because the first
 * window has already navigated by the time a test can reach it. This wraps
 * `fetch` without changing the request, so the turn under observation is the
 * turn that would have gone out anyway.
 */
async function recordArchitectTurnBodies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: unknown[] = []
    ;(window as unknown as { __architectTurnBodies: unknown[] })
      .__architectTurnBodies = store
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.includes('/create/resource-architect/turn') && init?.body) {
        try {
          store.push(JSON.parse(String(init.body)))
        } catch {
          // A body this test cannot read is not a body it can make a claim
          // about; the assertions below fail on an empty list rather than on a
          // half-read one.
        }
      }
      return originalFetch(input, init)
    }
  })
  await page.reload()
}

async function readRecordedTurnBodies(page: Page): Promise<RecordedTurnBody[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __architectTurnBodies?: unknown[] })
        .__architectTurnBodies ?? [],
  ) as Promise<RecordedTurnBody[]>
}

async function openCreateAgents(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page
    .getByLabel('Resource type')
    .getByRole('tab', { name: 'Agents', exact: true })
    .click()
}

async function submitArchitectTurn(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder('Describe the Agents or Team you need…')
  await expect(composer).toBeEnabled({ timeout: 30_000 })
  await composer.fill(text)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
}

test('the Create Architect uses the app default without a model-default card', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: ARCHITECT_REPLY,
        match: (request) =>
          request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER) ?? false,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('architect-workspace')
  const projectRoot = testInfo.outputPath('architect-project')
  const userDataPath = testInfo.outputPath('architect-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...desktopEnvironment({ projectRoot, userDataPath, workspacePath }), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: 'false' },
  })

  try {
    const page = await app.firstWindow()
    // The first window is still navigating when Playwright hands it over, and
    // reloading into that leaves the frame detached. Wait for the shell.
    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible(
      { timeout: 60_000 },
    )
    await recordArchitectTurnBodies(page)
    await openCreateAgents(page)

    // The picker fills itself from Settings. Its displayed pair must run
    // while retaining default provenance.
    const picker = page.getByLabel('Agent Architect model')
    await expect(picker).toContainText(APP_DEFAULT_MODEL.name, {
      timeout: 30_000,
    })

    // Nobody clicks it.
    await submitArchitectTurn(page, 'I need an Agent that reviews contracts.')

    await expect(page.getByText(ARCHITECT_REPLY)).toBeVisible({
      timeout: 60_000,
    })

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // The actual renderer request carries the visible pair and its default origin.
    const bodies = await readRecordedTurnBodies(page)
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body.provider).toBe(FIXTURE_PROVIDER)
      expect(body.model).toBe(APP_DEFAULT_MODEL.id)
      expect(body.composerSelection).toEqual({ provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id, origin: 'default' })
    }

    // ...and the pair that was resolved is the pair that actually ran.
    const architectModels = [
      ...new Set(
        provider.requests
          .filter((request) =>
            request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER),
          )
          .map((request) => request.model ?? ''),
      ),
    ]
    expect(architectModels).toEqual([APP_DEFAULT_MODEL.id])

  } finally {
    await app.close()
    await provider.close()
  }
})

test('a failed Architect attempt shows its error without a model-default card', async ({}, testInfo) => {
  test.setTimeout(180_000)

  // Every provider call fails, so the turn reaches the unavailable path after a
  // pair has already been resolved — which is the only interesting case: a
  // failure before resolution has no pair to disclose.
  const provider = await startFakeChatCompletionsServer({
    script: [{ failStatus: 500 }],
  })

  const workspacePath = testInfo.outputPath('failure-workspace')
  const projectRoot = testInfo.outputPath('failure-project')
  const userDataPath = testInfo.outputPath('failure-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...desktopEnvironment({ projectRoot, userDataPath, workspacePath }), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: 'false' },
  })

  try {
    const page = await app.firstWindow()
    await openCreateAgents(page)
    await expect(
      page.getByLabel('Agent Architect model'),
    ).toContainText(APP_DEFAULT_MODEL.name, { timeout: 30_000 })

    await submitArchitectTurn(page, 'I need an Agent that reviews contracts.')

    await expect(page.getByText(UNAVAILABLE_PREFIX, { exact: false })).toBeVisible(
      { timeout: 60_000 },
    )

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    await app.close()
    await provider.close()
  }
})
