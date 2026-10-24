/** Create keeps durable model-selection diagnostics across reloads and rejected proposals without displaying model-default cards. */
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

const ARCHITECT_PROMPT_MARKER = 'You are the Agent Architect'
/** Ends a conversational reply to make the server run the proposal operation. */
const PROPOSAL_REQUEST_MARKER = '[[proposal-requested]]'
/** Seeded into every desktop project root, so a plan naming it collides. */
const EXISTING_LIBRARY_AGENT = 'architect-critic'

const RESTORED_REPLY = 'Tell me what the new Agent should be responsible for.'

interface TurnExchange {
  readonly status: number
  readonly jobId: string
  readonly operation: string
}

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
 * Record the status and body of every Architect turn the renderer performs.
 *
 * Wraps `fetch` without altering the request, so the turn under observation is
 * the turn that would have happened anyway. Applied by reloading, because the
 * first window has already navigated by the time a test can reach it.
 */
async function recordArchitectExchanges(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: unknown[] = []
    ;(window as unknown as { __architectExchanges: unknown[] })
      .__architectExchanges = store
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const response = await originalFetch(input, init)
      if (url.includes('/create/resource-architect/turn')) {
        // The identity the turn was performed under. Everything this journey
        // asserts is bound to it, so a note belonging to a different turn can
        // never satisfy a claim about this one.
        let jobId = ''
        let operation = ''
        try {
          const body = init?.body
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : {}
          jobId = typeof body.jobId === 'string' ? body.jobId : ''
          operation = typeof body.operation === 'string' ? body.operation : ''
        } catch {
          // Left empty, which fails the identity assertions rather than
          // silently matching whatever note happens to be on screen.
        }
        store.push({ status: response.status, jobId, operation })
      }
      return response
    }
  })
  await page.reload()
}

async function readArchitectExchanges(page: Page): Promise<TurnExchange[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __architectExchanges?: unknown[] })
        .__architectExchanges ?? [],
  ) as Promise<TurnExchange[]>
}

/** Supporting witness only: what the server recorded, not what was shown. */
async function readArchitectMetrics(page: Page): Promise<ArchitectMetric[]> {
  return page.evaluate(async () => {
    const base = new URLSearchParams(window.location.hash.slice(1)).get(
      'pipeline-api-base-url',
    )
    if (!base) throw new Error('Desktop API URL is unavailable')
    const response = await fetch(`${base}/create/resource-architect/metrics`)
    const payload = (await response.json()) as { metrics: unknown[] }
    return payload.metrics
  }) as Promise<ArchitectMetric[]>
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

async function readyWindow(page: Page): Promise<void> {
  await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible({
    timeout: 60_000,
  })
}

test('a restored Create session retains model diagnostics without default-use cards', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: RESTORED_REPLY,
        match: (request) =>
          request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER) ?? false,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('restore-workspace')
  const projectRoot = testInfo.outputPath('restore-project')
  const userDataPath = testInfo.outputPath('restore-user-data')
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
    await readyWindow(page)
    await recordArchitectExchanges(page)
    await openCreateAgents(page)
    await submitArchitectTurn(page, 'I need an Agent that reviews contracts.')

    await expect(page.getByText(RESTORED_REPLY)).toBeVisible({ timeout: 60_000 })

    // The identity this journey is about, captured before the reload clears it.
    //
    // Polled rather than read once: the Architect streams its reply, so the
    // text above is on screen while the turn's own POST is still in flight,
    // and a single read would find no exchange to name.
    await expect
      .poll(
        async () =>
          (await readArchitectExchanges(page)).map(
            (exchange) => exchange.operation,
          ),
        { timeout: 60_000 },
      )
      .toContain('conversation')
    const exchanges = await readArchitectExchanges(page)
    const conversation = exchanges.find(
      (exchange) => exchange.operation === 'conversation',
    )
    expect(conversation).toBeDefined()
    if (!conversation) throw new Error('no conversation turn was performed')
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // Reopening retains diagnostics even though informational cards are hidden.
    await page.reload()
    await openCreateAgents(page)

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // Bind the durable selection to the exact operation that ran.
    const metrics = await readArchitectMetrics(page)
    const conversationMetric = metrics.find(
      (metric) => metric.jobId === conversation.jobId,
    )
    expect(conversationMetric?.selection).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'composer-default',
      caller: 'authoring',
    })
  } finally {
    await app.close()
    await provider.close()
  }
})

test('a rejected Create operation retains model diagnostics without default-use cards', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const rejectedPlan = JSON.stringify({
    operation: 'proposal',
    message: 'Here is the plan.',
    outcome: {
      id: 'rejected-plan',
      kind: 'standalone_agents',
      // Already in the seeded library, so the server rejects this plan during
      // materialization — after the model has already run and been paid for.
      agents: [
        {
          name: EXISTING_LIBRARY_AGENT,
          role: 'Duplicate of a library Agent',
          tier: 'specialist',
          summary: 'Duplicates an Agent the library already has.',
          description: 'Collides with an Agent that already exists.',
          rationale: 'Chosen to force a post-model rejection.',
        },
      ],
    },
    warnings: [],
  })

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        // Ends with the marker, so the server runs the proposal operation next.
        content: `Ready to propose.\n${PROPOSAL_REQUEST_MARKER}`,
        match: (request) =>
          request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER) ?? false,
      },
      {
        content: rejectedPlan,
        match: (request) =>
          request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER) ?? false,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('rejected-workspace')
  const projectRoot = testInfo.outputPath('rejected-project')
  const userDataPath = testInfo.outputPath('rejected-user-data')
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
    await readyWindow(page)
    await recordArchitectExchanges(page)
    await openCreateAgents(page)
    await submitArchitectTurn(page, 'Propose the Agents I need.')

    // Both turns are identified by what the renderer actually performed, so
    // every claim below names the turn it is about. A bare count of two would
    // be satisfied by two successful conversation notices, which is the same
    // false green this file already caught once.
    await expect
      .poll(
        async () =>
          (await readArchitectExchanges(page)).map(
            (exchange) => exchange.operation,
          ),
        { timeout: 90_000 },
      )
      .toContain('proposal')
    const exchanges = await readArchitectExchanges(page)
    const conversation = exchanges.find(
      (exchange) => exchange.operation === 'conversation',
    )
    const proposal = exchanges.find(
      (exchange) => exchange.operation === 'proposal',
    )
    expect(conversation).toBeDefined()
    expect(proposal).toBeDefined()
    if (!conversation || !proposal) {
      throw new Error('the journey did not perform both turns')
    }
    expect(conversation.jobId).not.toBe(proposal.jobId)

    // The rejection is an HTTP failure of the Create operation, asserted first
    // so a failure below cannot be mistaken for the plan never being rejected.
    expect(proposal.status).toBe(409)

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // Reopening keeps cards hidden for both operations.
    await page.reload()
    await openCreateAgents(page)
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // The rejected turn still retains its own model-selection record.
    const metrics = await readArchitectMetrics(page)
    const rejectedMetric = metrics.find(
      (metric) => metric.jobId === proposal.jobId,
    )
    expect(rejectedMetric?.status).toBe('failed')
    expect(rejectedMetric?.selection).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'composer-default',
      caller: 'authoring',
    })
  } finally {
    await app.close()
    await provider.close()
  }
})
