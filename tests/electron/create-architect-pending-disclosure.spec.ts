/** Pending Create turns record their model before dispatch and survive reopening without model-default cards. */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

const ARCHITECT_PROMPT_MARKER = 'You are the Agent Architect'
const PENDING_REPLY = 'This answer is released only after the assertions run.'

interface PendingExchange {
  readonly jobId: string
  readonly operation: string
  /** `null` while the POST is still in flight. */
  readonly status: number | null
}

/** Where the owning operation actually persists its turn records. */
const TURN_METRICS_RELATIVE_PATH = path.join(
  'resource-architect-telemetry',
  'turns.json',
)

interface ArchitectMetric {
  readonly jobId: string
  readonly status: string
  readonly selection?: {
    readonly provider: string
    readonly model: string
    readonly source: string
    readonly reason: string
    readonly caller: string
  }
}

/**
 * Record each Architect turn *as it is sent*, not as it returns.
 *
 * This is what makes a pending turn addressable at all. The entry is pushed
 * before the request is awaited and its status is filled in afterwards, so a
 * test can name the operation that is currently running and prove the POST has
 * not completed while it asserts against it.
 *
 * Only the POST counts. The Architect's live preview stream is a GET on the
 * very same path and stays open for the whole turn, so recording every request
 * to that URL would leave a permanently pending entry with no job id — and a
 * test looking for "the request still in flight" would happily select it.
 */
async function recordPendingExchanges(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: { jobId: string; operation: string; status: number | null }[] =
      []
    ;(window as unknown as { __pendingExchanges: unknown[] }).__pendingExchanges =
      store
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (
        !url.includes('/create/resource-architect/turn') ||
        method !== 'POST' ||
        !init?.body
      ) {
        return originalFetch(input, init)
      }
      let jobId = ''
      let operation = ''
      try {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        jobId = typeof body.jobId === 'string' ? body.jobId : ''
        operation = typeof body.operation === 'string' ? body.operation : ''
      } catch {
        // Left empty, which fails the identity assertions rather than
        // silently matching whatever happens to be on screen.
      }
      if (!jobId || !operation) return originalFetch(input, init)
      const entry = { jobId, operation, status: null as number | null }
      store.push(entry)
      const response = await originalFetch(input, init)
      entry.status = response.status
      return response
    }
  })
  await page.reload()
}

async function readPendingExchanges(page: Page): Promise<PendingExchange[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __pendingExchanges?: unknown[] })
        .__pendingExchanges ?? [],
  ) as Promise<PendingExchange[]>
}

/**
 * The owning operation's turn records, read from its own file.
 *
 * Deliberately not the metrics endpoint. That endpoint answers from the store
 * the running process holds in memory, so it would report a record that exists
 * only for as long as this process does — which is the opposite of what
 * "durable while the turn is still running" has to mean. Reading the file is
 * what a fresh store, or a restarted app, would see.
 */
async function readPersistedMetrics(
  workspacePath: string,
): Promise<ArchitectMetric[]> {
  try {
    const raw = await fs.readFile(
      path.join(workspacePath, TURN_METRICS_RELATIVE_PATH),
      'utf8',
    )
    const parsed = JSON.parse(raw) as { metrics?: unknown }
    return Array.isArray(parsed.metrics)
      ? (parsed.metrics as ArchitectMetric[])
      : []
  } catch {
    // No file yet is a legitimate answer: it means nothing has been recorded.
    return []
  }
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

/**
 * Drive Create to the moment the provider is held, and return the turn that is
 * still running.
 *
 * The returned exchange is asserted to be genuinely pending — its POST has not
 * completed and no token has reached the screen — so every claim made against
 * it afterwards is a claim about a turn in flight.
 */
async function heldTurn(
  page: Page,
  provider: HeldFixture,
): Promise<{ jobId: string; operation: string }> {
  await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await recordPendingExchanges(page)
  await openCreateAgents(page)
  await submitArchitectTurn(page, 'I need an Agent that reviews contracts.')

  // The provider has to have been *reached*, not merely aimed at. That the
  // POST started says nothing about whether a model is being waited on, so a
  // claim about "while the provider runs" anchored on the POST alone could
  // pass or fail for reasons that have nothing to do with this requirement.
  await expect
    .poll(() => provider.architectRequestCount(), { timeout: 60_000 })
    .toBeGreaterThan(0)

  const pending = (await readPendingExchanges(page)).find(
    (exchange) =>
      exchange.status === null &&
      exchange.operation === 'conversation' &&
      exchange.jobId !== '',
  )
  expect(pending).toBeDefined()
  if (!pending) throw new Error('no Architect conversation POST is in flight')

  // The preconditions the requirement is about: the provider is still held, so
  // nothing it will say has arrived, and the turn has not returned.
  await expect(page.getByText(PENDING_REPLY)).toHaveCount(0)
  expect(pending.status).toBeNull()
  return { jobId: pending.jobId, operation: pending.operation }
}

interface HeldFixture {
  release: () => void
  close: () => Promise<void>
  url: string
  /** How many Architect requests the provider has actually received. */
  architectRequestCount: () => number
}

async function startHeldProvider(): Promise<HeldFixture> {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: PENDING_REPLY,
        // Both, deliberately: `deltaGates[0]` holds the first token of a
        // streamed answer, and `gate` holds a non-streaming one, which never
        // consults `deltaGates` at all.
        deltaGates: [gate],
        gate,
        match: (request) =>
          request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER) ?? false,
      },
      // Ungated, so anything else the desktop asks for cannot deadlock the app.
      { content: 'Unclaimed fixture answer.' },
    ],
  })
  return {
    release,
    close: provider.close,
    url: provider.url,
    architectRequestCount: () =>
      provider.requests.filter((request) =>
        request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER),
      ).length,
  }
}

async function launchDesktop(
  outputPath: (name: string) => string,
  name: string,
  providerUrl: string,
) {
  const workspacePath = outputPath(`${name}-workspace`)
  const projectRoot = outputPath(`${name}-project`)
  const userDataPath = outputPath(`${name}-user-data`)
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedProviderSettings({
      userDataPath,
      baseUrl: providerUrl,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...desktopEnvironment({ projectRoot, userDataPath, workspacePath }), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: 'false' },
  })
  return { app, workspacePath }
}

test('a pending Create turn shows no model-default card', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startHeldProvider()
  const { app } = await launchDesktop(
    (name) => testInfo.outputPath(name),
    'held-visible',
    provider.url,
  )

  try {
    const page = await app.firstWindow()
    const turn = await heldTurn(page, provider)

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // Still pending as the claim above was made, so it cannot have been
    // satisfied by a turn that quietly finished mid-assertion.
    const stillPending = (await readPendingExchanges(page)).find(
      (exchange) => exchange.jobId === turn.jobId,
    )
    expect(stillPending?.status).toBeNull()
  } finally {
    provider.release()
    await app.close()
    await provider.close()
  }
})

test('the pending turn has already recorded which model it is using', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startHeldProvider()
  const { app, workspacePath } = await launchDesktop(
    (name) => testInfo.outputPath(name),
    'held-durable',
    provider.url,
  )

  try {
    const page = await app.firstWindow()
    const turn = await heldTurn(page, provider)

    // The requirement: a turn that has decided its pair has recorded it before
    // it runs, so a crash between the decision and the answer cannot leave a
    // model that was used with nothing to say it was. Read from the file the
    // operation owns, so this is durability and not process memory.
    const metrics = await readPersistedMetrics(workspacePath)
    const pendingMetric = metrics.find(
      (metric) => metric.jobId === turn.jobId,
    )
    expect(pendingMetric).toBeDefined()
    // Recorded as still running, not as a finished turn. A record that reached
    // disk only once the turn settled would satisfy an existence check while
    // proving nothing about the window this journey is about.
    expect(pendingMetric?.status).toBe('running')
    expect(pendingMetric?.selection).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'composer-default',
      caller: 'authoring',
    })

    const stillPending = (await readPendingExchanges(page)).find(
      (exchange) => exchange.jobId === turn.jobId,
    )
    expect(stillPending?.status).toBeNull()
  } finally {
    provider.release()
    await app.close()
    await provider.close()
  }
})

test('reopening Create keeps the pending turn running without a model-default card', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startHeldProvider()
  const { app, workspacePath } = await launchDesktop(
    (name) => testInfo.outputPath(name),
    'held-reload',
    provider.url,
  )

  try {
    const page = await app.firstWindow()
    const turn = await heldTurn(page, provider)

    // Reloading abandons the in-flight request, so nothing the renderer was
    // holding survives. The provider is still held, so the turn has still
    // produced no answer: anything on screen now can only have come from what
    // the operation recorded before it called the model.
    await page.reload()
    await openCreateAgents(page)

    await expect(page.getByText(PENDING_REPLY)).toHaveCount(0)
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // Hidden cards alone cannot prove that reloading has not killed the
    // turn. Two halves are needed, and neither works alone: a job that had
    // already finished would satisfy the after-check on its own, and a record
    // merely *bearing* the id — pending or cancelled — would satisfy a bare
    // existence poll. So: not terminal before the release, successfully
    // completed after it, under the same id.
    const terminalStatuses = new Set(['completed', 'cancelled', 'failed'])
    const beforeRelease = (await readPersistedMetrics(workspacePath)).filter(
      (metric) => metric.jobId === turn.jobId,
    )
    expect(
      beforeRelease.filter((metric) => terminalStatuses.has(metric.status)),
    ).toEqual([])

    provider.release()
    await expect
      .poll(
        async () =>
          (await readPersistedMetrics(workspacePath))
            .filter((metric) => metric.jobId === turn.jobId)
            .map((metric) => metric.status),
        { timeout: 60_000 },
      )
      .toContain('completed')
  } finally {
    provider.release()
    await app.close()
    await provider.close()
  }
})
