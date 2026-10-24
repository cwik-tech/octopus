/** Workflow Architect turns retain model-selection records while chat keeps informational model-default cards hidden. */
import assert from 'node:assert/strict'

import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  REPLACEMENT_DEFAULT_MODEL,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

/**
 * A phrase only this persona's prompt carries, so its turn is claimed by what
 * it is rather than by arrival order.
 */
const ARCHITECT_PROMPT_MARKER = 'Offline Workflow Architect fixture persona'

/** The Architect answers with one JSON object; this is its visible reply. */
const ARCHITECT_REPLY = 'Tell me what the workflow should produce.'
const ARCHITECT_TURN = JSON.stringify({
  message: ARCHITECT_REPLY,
  workflow: null,
})

const FIRST_TURN_TEXT = 'I need a workflow that drafts a report.'
const FOLLOW_UP_TEXT = 'Add a review step.'

/**
 * A Workflow Architect that names no pair, written before the app starts.
 *
 * `electron/project-root.ts` copies library files with `COPYFILE_EXCL`, so a
 * file that is already there is left alone — which is the only safe moment to
 * do this. Written afterwards, the repository persona's explicit `codex` pair
 * would be live during startup, and this offline journey could reach for a
 * real CLI provider.
 */
async function seedInheritingArchitect(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', 'workflow-architect')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'workflow-architect.md'),
    [
      '---',
      // No provider and no model: this Architect inherits, which is the case
      // the journey is about.
      'thinking: low',
      '---',
      '',
      `# ${ARCHITECT_PROMPT_MARKER}`,
      '',
      'Answer with one JSON object containing a `message` field.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function openCreateWorkflows(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page
    .getByLabel('Resource type')
    .getByRole('tab', { name: 'Workflows', exact: true })
    .click()
}

async function submitArchitectTurn(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder(
    'Describe the workflow you want to build...',
  )
  await expect(composer).toBeEnabled({ timeout: 30_000 })
  await composer.fill(text)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
}

/** A named bound, so a fixture fault fails rather than hanging teardown. */
const FIXTURE_DEADLINE_MS = 60_000

function withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${what}`)),
        FIXTURE_DEADLINE_MS,
      )
    }),
    // Cleared on settlement: a pending timer keeps the run alive after the
    // thing it was watching has already finished.
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Match a desktop API endpoint, origin and all.
 *
 * The renderer's base is not the server root: it carries a per-run token path
 * (`ui/src/lib/utils/desktop.ts`, `server/api-server.ts`), so a matcher written
 * against `/create/turn` matches nothing and the route silently never applies —
 * which is exactly how an interception can look like a passing test.
 */
async function apiPathMatcher(
  page: Page,
  endpoint: string,
): Promise<(url: URL) => boolean> {
  const base = new URL(await desktopApiBaseUrl(page))
  const expected = `${base.pathname.replace(/\/$/, '')}${endpoint}`
  return (url: URL) => url.origin === base.origin && url.pathname === expected
}

/** Where the desktop's own API is listening, as the window was told. */
async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get(
      'pipeline-api-base-url',
    ),
  )
  if (!baseUrl) throw new Error('the desktop API base URL is unavailable')
  return baseUrl
}

/**
 * Record what the renderer posts for an Architect turn.
 *
 * Wraps `fetch` without changing the request, so the turn under observation is
 * the one that would have gone out anyway.
 */
async function recordedTurnJobIds(page: Page): Promise<string[]> {
  const bodies = (await page.evaluate(
    () =>
      (window as unknown as { __workflowTurnBodies?: unknown[] })
        .__workflowTurnBodies ?? [],
  )) as { jobId?: unknown }[]
  return bodies
    .map((body) => body.jobId)
    .filter((id): id is string => typeof id === 'string')
}

function assertJobId(value: string | undefined, described: string): void {
  expect(value, `${described} posted a job id the notice can be scoped to`)
    .toMatch(/^[0-9a-f-]{36}$/)
}

async function recordArchitectTurnBodies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: unknown[] = []
    ;(window as unknown as { __workflowTurnBodies: unknown[] })
      .__workflowTurnBodies = store
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.includes('/create/turn') && init?.body) {
        try {
          store.push(JSON.parse(String(init.body)))
        } catch {
          // A body this test cannot read is not one it can make a claim about.
        }
      }
      return originalFetch(input, init)
    }
  })
  await page.reload()
}

test('the Workflow Architect uses its default without cards before answering or after reopening', async ({}, testInfo) => {
  test.setTimeout(240_000)

  let releaseArchitect: (() => void) | undefined
  const architectGate = new Promise<void>((resolve) => {
    releaseArchitect = resolve
  })
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: ARCHITECT_TURN,
        // Held before the first delta *and* before the terminal chunk. `gate`
        // alone waits after the deltas have streamed
        // (`fake-chat-completions-server.ts:164-170`), so output would already
        // have reached the screen and "before any output" could not be proved.
        deltaGates: [architectGate],
        gate: architectGate,
        match: (request) =>
          request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER) ?? false,
      },
      { content: ARCHITECT_TURN },
    ],
  })

  const workspacePath = testInfo.outputPath('workflow-architect-workspace')
  const projectRoot = testInfo.outputPath('workflow-architect-project')
  const userDataPath = testInfo.outputPath('workflow-architect-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])

  await seedInheritingArchitect(projectRoot)

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible(
      { timeout: 60_000 },
    )
    await recordArchitectTurnBodies(page)
    await openCreateWorkflows(page)

    await submitArchitectTurn(page, FIRST_TURN_TEXT)

    // The turn really reached the provider and is being held there. Without
    // this, a fixture that never connected would look exactly like a product
    // that never disclosed.
    await expect
      .poll(
        () =>
          provider.requests.filter((request) =>
            request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER),
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1)

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
    await expect(
      page.getByText(ARCHITECT_REPLY),
      'the provider is still held while cards are checked',
    ).toHaveCount(0)

    releaseArchitect?.()
    await expect(page.getByText(ARCHITECT_REPLY)).toBeVisible({
      timeout: 60_000,
    })

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
    const firstJobId = (await recordedTurnJobIds(page))[0]
    assertJobId(firstJobId, 'the first turn')

    // ── The notice is never something the model is told ──────────────────
    // Asked in the same visit, while the transcript still holds the first
    // exchange: a reload would clear it, and an empty transcript cannot show
    // contamination of one.
    await submitArchitectTurn(page, FOLLOW_UP_TEXT)
    // Waited for by what the request *contains*, not by a count: a count says
    // the renderer sent something, and the last request is not necessarily the
    // one this test means.
    await expect
      .poll(
        () =>
          provider.requests.filter((request) =>
            JSON.stringify(request.body).includes(FOLLOW_UP_TEXT),
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1)
    // And for that turn to *finish*. A posted-request count says only that the
    // renderer started one; the reply on screen and an enabled composer say the
    // job is done, so nothing below races an in-flight turn.
    await expect(page.getByText(ARCHITECT_REPLY)).toHaveCount(2, {
      timeout: 60_000,
    })
    await expect(
      page.getByPlaceholder('Describe the workflow you want to build...'),
    ).toBeEnabled({ timeout: 60_000 })
    // Captured before the reload: the recorder lives in the page, so reloading
    // empties it.
    const secondJobId = (await recordedTurnJobIds(page))[1]
    assertJobId(secondJobId, 'the follow-up turn')
    const followUp = provider.requests.find((request) =>
      JSON.stringify(request.body).includes(FOLLOW_UP_TEXT),
    )
    assert.ok(followUp, 'the follow-up reached the provider')
    const outbound = JSON.stringify(followUp.body)
    expect(
      outbound.includes(ARCHITECT_REPLY),
      'the control: the real reply is in the context this turn was sent with',
    ).toBe(true)
    expect(
      outbound.includes('using the app default'),
      'the status note never becomes model input',
    ).toBe(false)

    // ── Settings genuinely moves on, through the product's own API ───────
    const baseUrl = await desktopApiBaseUrl(page)
    // The endpoint takes the pair directly (`settings-requests.ts:47`), not
    // wrapped in a `defaultModel` object.
    const changed = await page.evaluate(
      async ([url, body]) => {
        const response = await fetch(`${url}/settings/default-model`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body,
        })
        return response.status
      },
      [
        baseUrl,
        JSON.stringify({
          provider: FIXTURE_PROVIDER,
          model: REPLACEMENT_DEFAULT_MODEL.id,
        }),
      ] as const,
    )
    expect(changed, 'the default was changed through the real settings API').toBe(
      200,
    )

    // Proved through the product's own read before anything is claimed about
    // history: if the default had not moved, the rest proves nothing.
    await expect
      .poll(
        async () =>
          page.evaluate(async (url) => {
            const response = await fetch(`${url}/settings/providers`)
            const payload: unknown = await response.json()
            const selection = (payload as { defaultModel?: { model?: unknown } })
              .defaultModel
            return typeof selection?.model === 'string' ? selection.model : null
          }, baseUrl),
        { timeout: 30_000 },
      )
      .toBe(REPLACEMENT_DEFAULT_MODEL.id)

    // ── Reopened, the finished turn still names the pair that ran ────────
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible(
      { timeout: 60_000 },
    )
    await openCreateWorkflows(page)

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

  } finally {
    releaseArchitect?.()
    await app.close()
    await provider.close()
  }
})

test('a turn whose preview never arrives keeps model-default cards hidden', async ({}, testInfo) => {
  // The stream is a preview and can be missed — and the client returns
  // normally on an exhausted reconnect or a 404, so "the subscription ended"
  // is not the same as "it delivered". Meanwhile the provider is still held,
  // so the turn really is running: a person is waiting, with the durable
  // `running` record already written and nothing on screen to explain it.
  //
  // The stream is denied at the network, not replaced in the app. Its request
  // never reaches the server; everything else is the real product.
  test.setTimeout(240_000)

  let releaseArchitect: (() => void) | undefined
  const architectGate = new Promise<void>((resolve) => {
    releaseArchitect = resolve
  })
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: ARCHITECT_TURN,
        deltaGates: [architectGate],
        gate: architectGate,
        match: (request) =>
          request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER) ?? false,
      },
      { content: ARCHITECT_TURN },
    ],
  })

  const workspacePath = testInfo.outputPath('no-stream-workspace')
  const projectRoot = testInfo.outputPath('no-stream-project')
  const userDataPath = testInfo.outputPath('no-stream-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])
  await seedInheritingArchitect(projectRoot)

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible(
      { timeout: 60_000 },
    )
    // The precondition: history is genuinely empty before the turn, taken from
    // the real endpoint. Without this the mount read could land *after* the
    // selection was persisted and supply the notice by an unintended path.
    let emptyHistorySeen = false
    await page.route(
      await apiPathMatcher(page, '/create/workflow-architect/turns'),
      async (route) => {
        const response = await route.fetch()
        const body = await response.text()
        if (!emptyHistorySeen) {
          emptyHistorySeen = (JSON.parse(body) as { turns?: unknown[] }).turns
            ?.length === 0
        }
        await route.fulfill({ response, body })
      },
    )
    // Only the subscription. The POST that runs the turn is untouched.
    let deniedSubscriptions = 0
    const turnMatcher = await apiPathMatcher(page, '/create/turn')
    await page.route(
      (url) => turnMatcher(url) && url.searchParams.has('channelId'),
      async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue()
          return
        }
        deniedSubscriptions += 1
        await route.abort()
      },
    )
    await openCreateWorkflows(page)
    await expect
      .poll(() => emptyHistorySeen, { timeout: 60_000 })
      .toBe(true)
    await submitArchitectTurn(page, FIRST_TURN_TEXT)

    // The interception really matched. Without this the case could silently
    // exercise a perfectly normal live stream.
    await expect
      .poll(() => deniedSubscriptions, { timeout: 60_000 })
      .toBeGreaterThan(0)

    // The turn reached the provider and is being held there.
    await expect
      .poll(
        () =>
          provider.requests.filter((request) =>
            request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER),
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1)

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
    await expect(
      page.getByText(ARCHITECT_REPLY),
      'still before any output',
    ).toHaveCount(0)
  } finally {
    releaseArchitect?.()
    await app.close()
    await provider.close()
  }
})

test('a late history answer does not introduce model-default cards', async ({}, testInfo) => {
  // Two readers ask for history: the panel on arrival, and every turn as it
  // settles. Their answers can arrive in either order, and an older list
  // applied last erases what the newer one carried — a turn whose preview was
  // missed would then have no account at all.
  //
  // The first response is delayed rather than altered, so what lands late is a
  // real answer that was simply true earlier.
  test.setTimeout(240_000)

  const provider = await startFakeChatCompletionsServer({
    script: [{ content: ARCHITECT_TURN }],
  })
  const workspacePath = testInfo.outputPath('late-history-workspace')
  const projectRoot = testInfo.outputPath('late-history-project')
  const userDataPath = testInfo.outputPath('late-history-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])
  await seedInheritingArchitect(projectRoot)

  // Declared before the try that owns cleanup: a `finally` reaching for a
  // binding scoped inside it throws, which would mask the real failure and
  // leave the desktop running.
  //
  // The first history answer is fetched for real, held, and delivered unchanged
  // after a later one. What lands late is a true answer from before the turn —
  // an empty list — not one altered to look like it.
  let releaseFirstSnapshot: (() => void) | undefined
  const firstSnapshotHeld = new Promise<void>((resolve) => {
    releaseFirstSnapshot = resolve
  })
  let firstSnapshotCaptured: (() => void) | undefined
  const firstSnapshotReady = new Promise<void>((resolve) => {
    firstSnapshotCaptured = resolve
  })
  let firstSnapshotBody: string | undefined
  let staleAnswerDelivered = false
  let served = 0

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible(
      { timeout: 60_000 },
    )
    // Deny the preview so this journey exercises only the history response.
    let deniedSubscriptions = 0
    const turnMatcher = await apiPathMatcher(page, '/create/turn')
    await page.route(
      (url) => turnMatcher(url) && url.searchParams.has('channelId'),
      async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue()
          return
        }
        deniedSubscriptions += 1
        await route.abort()
      },
    )

    await page.route(
      await apiPathMatcher(page, '/create/workflow-architect/turns'),
      async (route) => {
        // Claimed before the first await. Reading a mutable counter afterwards
        // can attach the gate to whichever concurrent request happens to be in
        // this handler by then.
        const ordinal = ++served
        const response = await route.fetch()
        const body = await response.text()
        if (ordinal === 1) {
          firstSnapshotBody = body
          firstSnapshotCaptured?.()
          await firstSnapshotHeld
        }
        await route.fulfill({ response, body })
        if (ordinal === 1) staleAnswerDelivered = true
      },
    )

    await openCreateWorkflows(page)
    // The snapshot that predates the turn has been taken, and is being held.
    await withDeadline(firstSnapshotReady, 'the first history snapshot')
    expect(
      JSON.parse(firstSnapshotBody ?? '{}'),
      'the held answer is the real one from before the turn',
    ).toEqual({ turns: [] })
    await submitArchitectTurn(page, FIRST_TURN_TEXT)
    await expect(page.getByText(ARCHITECT_REPLY)).toBeVisible({
      timeout: 60_000,
    })
    await expect
      .poll(() => deniedSubscriptions, { timeout: 60_000 })
      .toBeGreaterThan(0)

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
    await expect
      .poll(() => served, { timeout: 60_000 })
      .toBeGreaterThan(1)

    // Deliver the older response before checking that cards stay hidden.
    releaseFirstSnapshot?.()
    await expect
      .poll(() => staleAnswerDelivered, { timeout: 30_000 })
      .toBe(true)
    // One render after the response the panel just applied.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    )
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    // Released here too: a failure above must not leave the handler awaiting a
    // promise nobody will settle.
    releaseFirstSnapshot?.()
    await app.close()
    await provider.close()
  }
})

/**
 * Every renderer fetch, as it starts and as it settles.
 *
 * Starts and settlements are recorded separately because the question is about
 * a moment: a request begun before a view closed may still be in transit after
 * it, and a request begun after it is the defect. Counting only completions
 * would miss the first; counting only network events would attribute the
 * second to the wrong side of the click.
 *
 * A pass-through wrapper, not a replacement: every request goes out exactly as
 * it would have.
 */
async function installTurnRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: { url: string; phase: 'start' | 'settled' }[] = []
    ;(window as unknown as { __fetchEvents: typeof events }).__fetchEvents =
      events
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      events.push({ url, phase: 'start' })
      try {
        return await originalFetch(input, init)
      } finally {
        events.push({ url, phase: 'settled' })
      }
    }
  })
  await page.reload()
}

async function fetchEvents(
  page: Page,
): Promise<{ url: string; phase: 'start' | 'settled' }[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __fetchEvents?: unknown[] }).__fetchEvents ?? [],
  ) as Promise<{ url: string; phase: 'start' | 'settled' }[]>
}

function countStarts(
  events: readonly { url: string; phase: string }[],
  match: (url: string) => boolean,
): number {
  return events.filter(
    (event) => event.phase === 'start' && match(event.url),
  ).length
}

test('closing the view stops its reads, and leaves the turn running', async ({}, testInfo) => {
  // The recovery keeps reading and listening while a turn is silent. When the
  // panel goes away that has to stop — a view nobody is looking at should open
  // no further work — and it has to stop *without* cancelling the turn, which
  // belongs to the server.
  //
  // Made deterministic rather than raced: the stream answers 404 so the client
  // settles at once instead of spending its delayed reconnects, and the
  // recovery's history read is held open across the click, so the view closes
  // while a recovery is provably mid-flight with attempts still to spend.
  test.setTimeout(240_000)

  let releaseArchitect: (() => void) | undefined
  const architectGate = new Promise<void>((resolve) => {
    releaseArchitect = resolve
  })
  let releaseRecoveryRead: (() => void) | undefined
  const heldRecoveryRead = new Promise<void>((resolve) => {
    releaseRecoveryRead = resolve
  })
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: ARCHITECT_TURN,
        deltaGates: [architectGate],
        gate: architectGate,
        match: (request) =>
          request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER) ?? false,
      },
      { content: ARCHITECT_TURN },
    ],
  })

  const workspacePath = testInfo.outputPath('lifetime-workspace')
  const projectRoot = testInfo.outputPath('lifetime-project')
  const userDataPath = testInfo.outputPath('lifetime-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])
  await seedInheritingArchitect(projectRoot)

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('tab', { name: 'Run', exact: true })).toBeVisible(
      { timeout: 60_000 },
    )
    await installTurnRecorder(page)

    const turnMatcher = await apiPathMatcher(page, '/create/turn')
    const historyMatcher = await apiPathMatcher(
      page,
      '/create/workflow-architect/turns',
    )
    const isStreamUrl = (url: string): boolean => {
      const parsed = new URL(url)
      return turnMatcher(parsed) && parsed.searchParams.has('channelId')
    }
    const isHistoryUrl = (url: string): boolean => historyMatcher(new URL(url))

    // 404 rather than a transport abort: the client treats it as a settled
    // answer instead of retrying on a delay, so the recovery is reached at a
    // moment this test controls.
    await page.route(
      (url) => turnMatcher(url) && url.searchParams.has('channelId'),
      async (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              status: 404,
              contentType: 'application/json',
              body: '{}',
            })
          : route.continue(),
    )

    let served = 0
    let firstHistoryBody: string | undefined
    let recoveryReadReached: (() => void) | undefined
    const recoveryReadStarted = new Promise<void>((resolve) => {
      recoveryReadReached = resolve
    })
    await page.route(historyMatcher, async (route) => {
      const ordinal = ++served
      const response = await route.fetch()
      const body = await response.text()
      if (ordinal === 1) firstHistoryBody = body
      if (ordinal === 2) {
        recoveryReadReached?.()
        await heldRecoveryRead
      }
      await route.fulfill({ response, body })
    })

    await openCreateWorkflows(page)
    // The arrival read has settled, and history really is empty.
    await expect
      .poll(
        async () =>
          (await fetchEvents(page)).filter(
            (event) => event.phase === 'settled' && isHistoryUrl(event.url),
          ).length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0)
    expect(JSON.parse(firstHistoryBody ?? '{}')).toEqual({ turns: [] })

    await submitArchitectTurn(page, FIRST_TURN_TEXT)
    await expect
      .poll(
        () =>
          provider.requests.filter((request) =>
            request.systemPrompt?.includes(ARCHITECT_PROMPT_MARKER),
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1)

    // The stream was refused and the recovery is now waiting on its held read,
    // with attempts still to spend.
    await withDeadline(recoveryReadStarted, 'the recovery history read')
    const before = await fetchEvents(page)
    const streamStartsBefore = countStarts(before, isStreamUrl)
    const historyStartsBefore = countStarts(before, isHistoryUrl)
    expect(streamStartsBefore, 'the stream was listened to').toBeGreaterThan(0)

    // The view closes while that read is in flight.
    await page
      .getByLabel('Resource type')
      .getByRole('tab', { name: 'Agents', exact: true })
      .click()
    await expect(
      page.getByPlaceholder('Describe the workflow you want to build...'),
    ).toHaveCount(0)

    // The held answer lands into a panel that is gone.
    releaseRecoveryRead?.()
    await expect
      .poll(
        async () =>
          (await fetchEvents(page)).filter(
            (event) => event.phase === 'settled' && isHistoryUrl(event.url),
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(2)
    // Drain the renderer's pending promise work, so anything the settlement
    // scheduled has run before the counts are read.
    for (let turn = 0; turn < 3; turn += 1) {
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => setTimeout(() => resolve(null), 0))
          }),
      )
    }

    const after = await fetchEvents(page)
    expect(
      countStarts(after, isStreamUrl),
      'a closed view opens no further subscriptions',
    ).toBe(streamStartsBefore)
    expect(
      countStarts(after, isHistoryUrl),
      'a closed view starts no further history reads',
    ).toBe(historyStartsBefore)

    // And the turn was never cancelled: nothing asked, and it finishes.
    expect(
      after.filter((event) => event.url.includes('/cancel')),
      'closing a view does not cancel the work',
    ).toEqual([])
    releaseArchitect?.()
    await expect
      .poll(
        async () =>
          (await fetchEvents(page)).filter(
            (event) =>
              event.phase === 'settled' &&
              turnMatcher(new URL(event.url)) &&
              !new URL(event.url).searchParams.has('channelId'),
          ).length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0)
  } finally {
    releaseRecoveryRead?.()
    releaseArchitect?.()
    await app.close()
    await provider.close()
  }
})
