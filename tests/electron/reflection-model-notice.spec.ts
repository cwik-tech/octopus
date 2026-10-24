/**
 * What a person is told about the model that wrote an Agent's experience entry.
 *
 * When a level completes, each participating Agent is spawned once more to
 * reflect on the session. That runs on the Agent's own pair — its own when it
 * names one, the application default when it does not — and nothing said so:
 * the dispatch never received the assignment it belonged to, so the run kept no
 * telemetry for it and no account of which model did the writing.
 *
 * The integration tests beside this prove what is recorded and when. They
 * cannot prove any of it reaches a screen, and the reader that shows it is the
 * process timeline rather than a discussion roster — this is an ordinary
 * workflow run, which is what most runs are.
 *
 * Two things only this can establish:
 *
 *  - the notice is on screen **before** the reflecting model has answered; and
 *  - after the application default is changed in Settings, reopening the same
 *    session still reports the pair the reflection actually used.
 *
 * ── What the fixture has to be, and why ─────────────────────────────────────
 * A *workflow* target, because a team-chat task runs with
 * `executionMode: 'team-chat'` and the runtime deliberately skips reflections
 * in that mode (`level-lifecycle.ts:389`).
 *
 * A *broadcast* level, because `buildReflectionContext` builds history for
 * discussion and broadcast stages only — a chain or routing level completes
 * with nothing for a participant to reflect on. Broadcast also needs no
 * coordinator and is runtime-autostartable, so the round is deterministic.
 *
 * And a *non-LLM* gate (`artifact_exists`), so nothing but the two turns this
 * test owns reaches a provider.
 *
 * This asserts truthful disclosure only. `runExperienceReflections` returns
 * `Promise<void>`; it neither hands back the model's text nor appends it to the
 * scratch pad itself, so nothing here claims either — and nothing was changed
 * to make such a claim true.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createRunPlanService } from '../../services/run-orchestrator-service.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'
import {
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  REPLACEMENT_DEFAULT_MODEL,
  desktopEnvironment,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const SESSION_TITLE = 'Reflection Disclosure E2E'
const GOAL = 'Gather one insight about warehouse automation.'

/**
 * The heading only a reflection's user message carries.
 *
 * Taken from the prompt `experience-reflections.ts:94` actually builds, so this
 * identifies the reflection positively rather than by elimination — the
 * broadcast turn runs on the same pair and reaches the same endpoint.
 */
const REFLECTION_PROMPT_MARKER = '# Session Reflection'

const BROADCAST_ANSWER = 'Phased rollout across three depots looks cheapest.'
const REFLECTION_ANSWER = '- **What worked:** naming the constraint early.'

/** Whether this request is a reflection's own. */
function reflectionRequest(request: {
  readonly systemPrompt?: string | undefined
  readonly userMessage?: string | undefined
}): boolean {
  return (
    (request.systemPrompt?.includes(REFLECTION_PROMPT_MARKER) ?? false) ||
    (request.userMessage?.includes(REFLECTION_PROMPT_MARKER) ?? false)
  )
}

/**
 * Where the desktop's own HTTP API is listening, as the window was told.
 *
 * The renderer is loaded from `file://`, so it has no origin a relative URL
 * could resolve against; the loopback base is handed to it in the URL hash.
 */
async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get(
      'pipeline-api-base-url',
    ),
  )
  if (!baseUrl) throw new Error('the desktop API base URL is unavailable')
  return baseUrl
}

/** The application default as the desktop itself reports it. */
async function readEffectiveDefaultModel(apiBaseUrl: string): Promise<string | null> {
  const response = await fetch(`${apiBaseUrl}/settings/providers`)
  if (!response.ok) return null
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) return null
  const selection = (body as { defaultModel?: { model?: unknown } }).defaultModel
  return typeof selection?.model === 'string' ? selection.model : null
}

/** The reflection's own dispatch record, from the run's own journal. */
async function recordedReflection(
  workspacePath: string,
  sessionId: string,
): Promise<{
  agentName: unknown
  sessionId: unknown
  assignmentPath: unknown
  selection: Record<string, unknown>
} | null> {
  const runsRoot = path.join(workspacePath, 'sessions', sessionId, 'runs')
  const runs = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => [])
  for (const run of runs) {
    if (!run.isDirectory()) continue
    const assignmentsRoot = path.join(runsRoot, run.name, 'assignments')
    const assignments = await fs
      .readdir(assignmentsRoot, { withFileTypes: true })
      .catch(() => [])
    for (const assignment of assignments) {
      if (!assignment.isDirectory()) continue
      const raw = await fs
        .readFile(
          path.join(assignmentsRoot, assignment.name, 'logs', 'agent-runs.jsonl'),
          'utf8',
        )
        .catch(() => '')
      const entries = raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      // Selected by what the record says it is, not by position. This Agent
      // runs twice on the same pair — its broadcast turn and then its
      // reflection — so an index would report whichever happened to come first
      // and call it the reflection.
      const reflections = entries.filter(
        (entry) =>
          entry.event === 'start' &&
          entry.agent_name === 'scout' &&
          entry.trigger_tool === 'experience_reflection',
      )
      if (reflections.length === 0) continue
      // One level, one participant, one reflection. More than one would mean
      // this fixture no longer describes what the assertions below claim.
      if (reflections.length !== 1) {
        throw new Error(`expected one reflection, saw ${reflections.length}`)
      }
      // And the ordinary turn is there too, so this really is the second of
      // two dispatches rather than the only one.
      const ordinary = entries.filter(
        (entry) =>
          entry.event === 'start' &&
          entry.agent_name === 'scout' &&
          entry.trigger_tool !== 'experience_reflection',
      )
      if (ordinary.length !== 1) {
        throw new Error(`expected one broadcast turn, saw ${ordinary.length}`)
      }
      const reflection = reflections[0]
      if (!reflection) continue
      const selection = Reflect.get(reflection, 'model_selection')
      if (typeof selection !== 'object' || selection === null) continue
      const record: Record<string, unknown> = {}
      for (const key of ['provider', 'model', 'source', 'reason', 'caller']) {
        record[key] = Reflect.get(selection, key)
      }
      return {
        agentName: reflection.agent_name,
        sessionId: reflection.session_id,
        assignmentPath: reflection.assignment_path,
        selection: record,
      }
    }
  }
  return null
}

/**
 * Bring the run's own pane back into view and select it.
 *
 * Called *after* the task has started, deliberately.
 * `use-run-workspace-controller.ts:112-117` collapses both sidebars on first
 * session activity — behaviour `app.test.tsx` specifies on purpose — so a pane
 * opened before the launch is closed again by it, and every role query then
 * misses a notice that really was rendered.
 */
async function showWorkflowPane(page: Page): Promise<void> {
  for (const label of ['Show sidebar', 'Show inspector']) {
    const toggle = page.getByRole('button', { name: label })
    if (await toggle.isVisible().catch(() => false)) await toggle.click()
  }
  const workflowsTab = page.getByRole('tab', { name: 'Workflows', exact: true })
  await expect(workflowsTab).toBeVisible({ timeout: 60_000 })
  await workflowsTab.click()
  await expect(
    page.getByRole('region', { name: 'Run activity' }),
  ).toBeVisible({ timeout: 60_000 })
}

/**
 * The reflection's own row, not the Agent's ordinary turn.
 *
 * Scout runs twice on the same pair this level, so "Scout started on the app
 * default …" matches both. The reflection says what it was.
 *
 * The default-use marker leads the line deliberately. This table renders each
 * row as a truncated single line with the whole string in a tooltip, and an
 * earlier version of this notice put the marker after the agent and the verb —
 * the screenshots then read "scout started a session reflec…", showing a
 * dispatch and saying nothing about the model that ran it. Leading with it is
 * what a person can read at a glance; the exact pair stays in the row and is
 * legible in full on hover. Ordinary truncation is otherwise untouched.
 */
function reflectionNotice(page: Page) {
  return page
    .getByRole('region', { name: 'Process timeline' })
    .getByText(/App default · scout started a session reflection/i)
}

/**
 * Reads the exact pair off the row, the way a person does.
 *
 * The marker leads the line so default use is legible at a glance, but the
 * provider and model are past the truncation point — the table puts the whole
 * string in a tooltip for exactly that reason. So this hovers the row and
 * asserts the tooltip a reader would actually see, rather than settling for
 * text that exists only in the DOM.
 */
async function tooltipTextFor(
  page: Page,
  row: ReturnType<typeof reflectionNotice>,
  pair: string,
) {
  // Located by the popup's own slot rather than a `tooltip` role: the Base UI
  // popup this table uses renders a plain `div` with `data-slot`, and
  // `process-timeline-table.test.tsx` finds it the same way.
  //
  // Scoped to *this* row's text as well as the pair. Scout's ordinary turn runs
  // on the same pair on purpose, so a popup matching the pair alone could be
  // that one — which would prove the wrong dispatch's disclosure.
  const tooltip = page
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: /started a session reflection/i })
    .filter({ hasText: pair })
  // The row first, then one hover. No retry loop: the ordinary assertion below
  // already waits for the popup, and re-hovering would hide a real failure to
  // open rather than diagnose it.
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await expect(tooltip).toBeVisible({ timeout: 30_000 })
  return tooltip
}

/** Scout's ordinary broadcast turn, which must stay distinguishable from it. */
function ordinaryTurnNotice(page: Page) {
  return page
    .getByRole('region', { name: 'Process timeline' })
    .getByText(/App default · scout started on /i)
}

test('a run says which model wrote a reflection, before it answers and after the default moves', async ({}, testInfo) => {
  test.setTimeout(360_000)

  // Only the reflection's answer is held. The broadcast turn ahead of it
  // answers immediately, so the level can complete and reach the reflection at
  // all — and holding the reflection is what makes "the notice was on screen
  // before this model answered" observable rather than a race.
  let releaseReflection = (): void => {}
  const reflectionHeld = new Promise<void>((resolve) => {
    releaseReflection = resolve
  })
  const appDefaultProvider = await startFakeChatCompletionsServer({
    script: [
      {
        content: REFLECTION_ANSWER,
        gate: reflectionHeld,
        match: (request) => reflectionRequest(request),
      },
      { content: BROADCAST_ANSWER },
    ],
  })
  // Every other turn in the run, on its own route, so nothing else can be
  // mistaken for the reflection.
  const runtimeProvider = await startDeterministicOpenAiServer()

  const userDataPath = testInfo.outputPath('reflection-notice-user-data')
  const workspacePath = testInfo.outputPath('reflection-notice-workspace')
  const projectRoot = testInfo.outputPath('reflection-notice-project')
  const piStatePath = testInfo.outputPath('reflection-notice-pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'reflection-disclosure-e2e'),
      projectRoot,
      { recursive: true },
    ),
    // Keyless LM Studio: the stage's worker runs on this default, and the
    // native tool route refuses a keyless OpenAI-compatible connection.
    seedProviderSettings({
      userDataPath,
      baseUrl: appDefaultProvider.url,
      defaultModel: APP_DEFAULT_MODEL,
      kind: 'lm-studio',
    }),
  ])

  // The session and its plan are made through the product's own services:
  // `Begin workflow` is offered only for a workflow a person chose, and
  // starting through that button is what makes the renderer open the run's
  // event stream at launch.
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const seededSession = await sessionStore.createSession({ title: SESSION_TITLE })
  const plan = await createRunPlanService({
    sessionId: seededSession.id,
    sessionStore,
    repoRootPath: projectRoot,
    workflowsRegistryPath: path.join(projectRoot, 'workflows', 'registry.yaml'),
    goal: GOAL,
    workflowId: 'reflection-check',
    selectionSource: 'user',
  })
  expect(plan.status).toBe('ready')

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      // A PATH narrowed to /usr/bin:/bin, given to the guard so it is still
      // filtered: no provider CLI on this machine can be resolved and run.
      // Staying offline comes from the provider URLs below, not from this.
      ...desktopEnvironment(
        { projectRoot, userDataPath, workspacePath },
        { ...process.env, PATH: '/usr/bin:/bin' },
      ),
      OPENAI_API_KEY: 'reflection-notice-key',
      OPENAI_BASE_URL: runtimeProvider.baseUrl,
      PI_CODING_AGENT_DIR: piStatePath,
    },
  })

  try {
    const page = await app.firstWindow({ timeout: 45_000 })
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .getByRole('button', { name: new RegExp(`^${SESSION_TITLE}\\b`) })
      .first()
      .click()

    const beginButton = page
      .getByRole('region', { name: 'Run chat' })
      .getByTestId('workflow-launch-confirmation')
      .getByRole('button', { name: 'Begin workflow' })
    await expect(beginButton).toBeEnabled({ timeout: 120_000 })
    await beginButton.click()

    // ── The reflection's own request reached the application default ───────
    await expect
      .poll(
        () => [
          ...new Set(
            appDefaultProvider.requests
              .filter(reflectionRequest)
              .map((request) => request.model ?? ''),
          ),
        ],
        { timeout: 180_000 },
      )
      .toEqual([APP_DEFAULT_MODEL.id])

    // ── The record, by the exact session this plan was created for ─────────
    // Read before anything is asserted about the page, so what follows is that
    // the screen shows what was stored.
    await expect
      .poll(() => recordedReflection(workspacePath, seededSession.id), {
        timeout: 120_000,
      })
      .not.toBeNull()
    const recorded = await recordedReflection(workspacePath, seededSession.id)
    if (recorded === null) throw new Error('the run recorded no reflection')
    expect(recorded.agentName).toBe('scout')
    // Owned by a real runtime session and a real assignment on disk, so this is
    // the run's own record rather than something a test could have written.
    expect(typeof recorded.sessionId).toBe('string')
    expect(String(recorded.assignmentPath).startsWith(workspacePath)).toBe(true)
    expect(recorded.selection).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    })

    // ── What the person running it sees, while that model is still thinking ─
    // The pane is opened only now: the launch collapsed it.
    await showWorkflowPane(page)
    // Both: exactly one such row exists, and it is actually on screen. A count
    // alone would be satisfied by a row rendered inside a collapsed pane.
    await expect(reflectionNotice(page)).toHaveCount(1, { timeout: 120_000 })
    await expect(reflectionNotice(page)).toBeVisible()
    await expect(reflectionNotice(page)).toContainText(
      `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`,
    )
    // And the Agent's ordinary turn is its own row, named for what it was.
    // Both ran on the same pair, so a reader that could not tell them apart
    // would disclose a model without disclosing what it did.
    await expect(ordinaryTurnNotice(page)).toHaveCount(1)

    const rendered = testInfo.outputPath('reflection-notice.png')
    await reflectionNotice(page).screenshot({ path: rendered })
    await testInfo.attach('reflection-notice', {
      path: rendered,
      contentType: 'image/png',
    })

    // The exact pair, read the way a person reads it: past the truncation, in
    // the tooltip the table provides.
    const pair = `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`
    const liveTooltip = await tooltipTextFor(page, reflectionNotice(page), pair)
    await expect(liveTooltip).toContainText(
      `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`,
    )
    const liveTooltipShot = testInfo.outputPath('reflection-tooltip.png')
    await liveTooltip.screenshot({ path: liveTooltipShot })
    await testInfo.attach('reflection-tooltip', {
      path: liveTooltipShot,
      contentType: 'image/png',
    })

    // Released only now, so the notice above was on screen before this model
    // had answered anything.
    releaseReflection()
    // The run finishes before anything moves. Its completion row is added to
    // this timeline above the reflection row; added after the reopen, it
    // shifts the hovered row from under the pointer and closes its tooltip.
    await expect(
      page.getByRole('region', { name: 'Process timeline' }).getByText(/Workflow run completed/),
    ).toBeVisible({ timeout: 60_000 })

    // ── The default moves, and history does not ────────────────────────────
    // Changed the way Settings changes it, through the running application's
    // own endpoint. Rewriting the file on disk would not do: the settings
    // service answers from cached state once loaded.
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const updated = await fetch(`${apiBaseUrl}/settings/default-model`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: FIXTURE_PROVIDER,
        model: REPLACEMENT_DEFAULT_MODEL.id,
      }),
    })
    expect(updated.ok, `default-model PATCH failed: ${updated.status}`).toBe(true)
    await expect
      .poll(() => readEffectiveDefaultModel(apiBaseUrl), { timeout: 60_000 })
      .toBe(REPLACEMENT_DEFAULT_MODEL.id)

    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .locator('[data-slot="workspace-sidebar"][data-side="left"]')
      .getByRole('button', { name: new RegExp(`^${SESSION_TITLE}\\b`) })
      .click()
    await showWorkflowPane(page)

    await expect(reflectionNotice(page)).toHaveCount(1, { timeout: 180_000 })
    await expect(reflectionNotice(page)).toBeVisible()
    await expect(reflectionNotice(page)).toContainText(
      `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`,
    )
    // And never the model Settings names now.
    await expect(
      page.getByRole('region', { name: 'Process timeline' }),
    ).not.toContainText(REPLACEMENT_DEFAULT_MODEL.id)

    // The same reading after the reopen: the pair a person can actually see,
    // still the one the reflection used rather than the one Settings names now.
    const reopenedTooltip = await tooltipTextFor(page, reflectionNotice(page), pair)
    await expect(reopenedTooltip).toContainText(
      `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`,
    )
    await expect(reopenedTooltip).not.toContainText(REPLACEMENT_DEFAULT_MODEL.id)
    const reopenedTooltipShot = testInfo.outputPath('reflection-tooltip-reopened.png')
    await reopenedTooltip.screenshot({ path: reopenedTooltipShot })
    await testInfo.attach('reflection-tooltip-reopened', {
      path: reopenedTooltipShot,
      contentType: 'image/png',
    })

    // The row itself, so the attachment shows what was asserted rather than the
    // whole pane around it.
    const reopened = testInfo.outputPath('reflection-notice-reopened.png')
    await reflectionNotice(page).screenshot({ path: reopened })
    const reopenedRegion = testInfo.outputPath('reflection-timeline-reopened.png')
    await page
      .getByRole('region', { name: 'Process timeline' })
      .screenshot({ path: reopenedRegion })
    await testInfo.attach('reflection-timeline-reopened', {
      path: reopenedRegion,
      contentType: 'image/png',
    })
    await testInfo.attach('reflection-notice-reopened', {
      path: reopened,
      contentType: 'image/png',
    })
  } finally {
    // On the failing path too: a held answer left held means the desktop shuts
    // down with a request still open.
    releaseReflection()
    await app.close()
    await runtimeProvider.close()
    await appDefaultProvider.close()
  }
})
