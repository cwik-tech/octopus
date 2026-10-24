/**
 * What a person is told about the model that decided a gate.
 *
 * A validation gate dispatches a named Agent to judge whether a level's work
 * passes. That Agent runs on its own pair or on the one application default —
 * and when it inherits, nothing said so: the dispatch never received the
 * assignment it belonged to, so the run recorded no telemetry and no account of
 * which model made one of the more consequential decisions in it.
 *
 * The integration tests beside this prove what is recorded and when. They
 * cannot prove any of it reaches a screen, and the reader that shows it is the
 * process timeline rather than a discussion roster — this is an ordinary chain
 * workflow, which is what most runs are.
 *
 * Two things this journey establishes that nothing else can:
 *
 *  - the notice is on screen **before** the validator's model has answered,
 *    which is what "recorded before the send" means to a person; and
 *  - after the application default is changed in Settings, reopening the same
 *    session still reports the pair the gate actually used. History is a record
 *    of what happened, not a re-reading of what Settings says now.
 *
 * The validator's answer and every other reply come from different endpoints on
 * purpose, so no other turn can satisfy the assertion the validator has to.
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

const SESSION_TITLE = 'Gate Disclosure E2E'
const GOAL = 'Write up the warehouse automation proposal for review.'

/**
 * A phrase only the validation gate's own request carries.
 *
 * Taken from the prompt `gate-checker.ts` actually builds. The writer runs on a
 * different provider entirely, so nothing else can claim this turn.
 */
const VALIDATION_PROMPT_MARKER =
  "determine if the level's work meets quality standards"

/**
 * Whether this request is the validation gate's own.
 *
 * The marker lives in the user message rather than the system prompt, and the
 * writer runs on a different provider entirely, so nothing else can match it.
 */
function validationRequest(request: {
  readonly systemPrompt?: string | undefined
  readonly userMessage?: string | undefined
}): boolean {
  return (
    (request.systemPrompt?.includes(VALIDATION_PROMPT_MARKER) ?? false) ||
    (request.userMessage?.includes(VALIDATION_PROMPT_MARKER) ?? false)
  )
}

/** The validator's own dispatch record, from the run's own journal. */
async function recordedValidatorSelection(
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
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
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        let entry: unknown
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof entry !== 'object' || entry === null) continue
        if (Reflect.get(entry, 'agent_name') !== 'reviewer') continue
        const selection = Reflect.get(entry, 'model_selection')
        if (typeof selection !== 'object' || selection === null) continue
        const record: Record<string, unknown> = {}
        for (const key of ['provider', 'model', 'source', 'reason', 'caller']) {
          record[key] = Reflect.get(selection, key)
        }
        return record
      }
    }
  }
  return null
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

/**
 * Bring the run's own pane into view and select it.
 *
 * Two separate things, both needed. The pane can be collapsed behind a toggle —
 * a collapsed pane is still in the DOM but inside a hidden container, so every
 * role query misses it and the failure reads as "the product never rendered
 * this" rather than "nobody was looking at it". And the run target starts on
 * Agents, while the process timeline lives in the Workflows pane.
 */
async function showWorkflowPane(page: Page): Promise<void> {
  for (const label of ['Show sidebar', 'Show inspector']) {
    const toggle = page.getByRole('button', { name: label })
    if (await toggle.isVisible().catch(() => false)) await toggle.click()
  }
  const workflowsTab = page.getByRole('tab', { name: 'Workflows', exact: true })
  await expect(workflowsTab).toBeVisible({ timeout: 60_000 })
  await workflowsTab.click()
  // The timeline lives inside the run's activity pane. Waited for by name, so a
  // pane that never opened fails here — where the reason is obvious — rather
  // than later as a notice that appears not to have been rendered.
  await expect(
    page.getByRole('region', { name: 'Run activity' }),
  ).toBeVisible({ timeout: 60_000 })
}

function validatorNotice(page: Page) {
  // The process timeline is what a person reads for a chain run; there is no
  // discussion roster here. Located by what it says about this one Agent.
  //
  // The default-use marker leads the line. This table renders each row as a
  // truncated single line with the whole string in a tooltip, so a marker
  // placed after the agent and the verb would be clipped away — the screen
  // would show a dispatch and say nothing about the model that decided the
  // gate.
  return page
    .getByRole('region', { name: 'Process timeline' })
    .getByText(/App default · Reviewer started on/i)
}

/**
 * Reads the exact pair off the row, the way a person does.
 *
 * The provider and model sit past the truncation point, and the table puts the
 * whole string in a tooltip for exactly that reason. Asserting the row's DOM
 * text would pass on a string nobody can read; this hovers and asserts the
 * popup a reader actually sees.
 *
 * Located by the popup's own slot rather than a `tooltip` role: the Base UI
 * popup this table uses renders a plain `div` with `data-slot`, and
 * `process-timeline-table.test.tsx` finds it the same way. Filtered by this
 * row's own text as well as the pair, so a popup belonging to another dispatch
 * on the same pair cannot stand in for it.
 */
async function validatorTooltip(page: Page, pair: string) {
  const row = validatorNotice(page)
  const tooltip = page
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: /Reviewer started on/i })
    .filter({ hasText: pair })
  // The row first, then one hover. No retry loop: the assertion below already
  // waits for the popup, and re-hovering would hide a real failure to open.
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await expect(tooltip).toBeVisible({ timeout: 30_000 })
  return tooltip
}

test('a run says which model decided its gate, before that model answers and after the default moves', async ({}, testInfo) => {
  test.setTimeout(360_000)

  // The validator's answer is held until its notice is on screen. Answering
  // immediately would only show the disclosure arrives eventually; the rule is
  // that the account exists before the model is used.
  let releaseValidator = (): void => {}
  const validatorHeld = new Promise<void>((resolve) => {
    releaseValidator = resolve
  })
  // The application default's endpoint, and nothing else. The validator names
  // no pair of its own, so this is the only thing it can run on — and the
  // writer runs elsewhere, so no other turn can answer in its place.
  const appDefaultProvider = await startFakeChatCompletionsServer({
    script: [
      {
        content: 'PASS',
        gate: validatorHeld,
        // An OR, not `??`. The system prompt exists and does not contain the
        // marker, so `??` never looked at the user message — which is where
        // `gate-checker.ts` actually puts it. With that bug the validator was
        // never held and took the generic answer instead.
        match: (request) => validationRequest(request),
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })
  // Every other turn in the run, on its own route.
  const runtimeProvider = await startDeterministicOpenAiServer()

  const userDataPath = testInfo.outputPath('gate-notice-user-data')
  const workspacePath = testInfo.outputPath('gate-notice-workspace')
  const projectRoot = testInfo.outputPath('gate-notice-project')
  const piStatePath = testInfo.outputPath('gate-notice-pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'gate-disclosure-e2e'),
      projectRoot,
      { recursive: true },
    ),
    seedProviderSettings({
      userDataPath,
      baseUrl: appDefaultProvider.url,
      defaultModel: APP_DEFAULT_MODEL,
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
    workflowId: 'gate-check',
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
      OPENAI_API_KEY: 'gate-notice-key',
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

    // ── The gate's own request reached the application default ─────────────
    await expect
      .poll(
        () => [
          ...new Set(
            appDefaultProvider.requests
              .filter(validationRequest)
              .map((request) => request.model ?? ''),
          ),
        ],
        { timeout: 180_000 },
      )
      .toEqual([APP_DEFAULT_MODEL.id])

    // ── On screen, while that model is still thinking ──────────────────────
    //
    // The pane is opened here rather than before the launch. Starting a run
    // collapses both sidebars on first session activity
    // (`use-run-workspace-controller.ts:112-117`, triggered by
    // `run-panel.tsx:267-268` and specified by `app.test.tsx:315-332`), so a
    // pane opened earlier is closed again by the very launch this journey is
    // about — and every role query then misses a notice that really was
    // rendered. The auto-collapse itself is left alone.
    await showWorkflowPane(page)

    await expect(validatorNotice(page)).toHaveCount(1, { timeout: 120_000 })
    await expect(validatorNotice(page)).toBeVisible()
    const pair = `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`
    const liveTooltip = await validatorTooltip(page, pair)
    await expect(liveTooltip).toContainText(pair)

    const rendered = testInfo.outputPath('gate-validator-notice.png')
    await validatorNotice(page).screenshot({ path: rendered })
    await testInfo.attach('gate-validator-notice', {
      path: rendered,
      contentType: 'image/png',
    })
    // The row alone is truncated, so a reader inspecting this evidence would
    // see the marker and not the pair. Captured from the popup a person opens.
    const renderedPair = testInfo.outputPath('gate-validator-pair.png')
    await liveTooltip.screenshot({ path: renderedPair })
    await testInfo.attach('gate-validator-pair', {
      path: renderedPair,
      contentType: 'image/png',
    })

    // Released only now, so the notice above was on screen before this model
    // had answered anything.
    releaseValidator()

    // ── The record, by the exact session this plan was created for ─────────
    // The id is the one this test created, used directly. Rediscovering it by
    // enumerating sessions and insisting on exactly one is what broke a sibling
    // journey: the desktop legitimately leaves an extra untitled session
    // around, and counting would fail on that rather than on anything here.
    await expect
      .poll(
        () => recordedValidatorSelection(workspacePath, seededSession.id),
        { timeout: 120_000 },
      )
      .not.toBeNull()

    expect(await recordedValidatorSelection(workspacePath, seededSession.id)).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    })

    // ── The default moves, and history does not ────────────────────────────
    // Settings is rewritten to a different model, then the app is reloaded so
    // it reads the new one. The gate already happened, and what it ran on is a
    // fact about the past.
    // Changed the way Settings changes it, through the running application's
    // own endpoint. Rewriting the file on disk would not do: the settings
    // service answers from cached state once loaded, so the backend would go on
    // using A and this assertion would prove nothing about a moved default.
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
    // And read back from the application, not from what this test just sent.
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

    await expect(validatorNotice(page)).toHaveCount(1, { timeout: 180_000 })
    await expect(validatorNotice(page)).toBeVisible()
    const reopenedTooltip = await validatorTooltip(page, pair)
    await expect(reopenedTooltip).toContainText(pair)
    // And never the model Settings names now.
    await expect(
      page.getByRole('region', { name: 'Process timeline' }),
    ).not.toContainText(REPLACEMENT_DEFAULT_MODEL.id)
  } finally {
    // On the failing path too: a held answer left held means the desktop shuts
    // down with a request still open.
    releaseValidator()
    await app.close()
    await runtimeProvider.close()
    await appDefaultProvider.close()
  }
})
