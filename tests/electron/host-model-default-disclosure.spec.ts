/** Host model events do not produce informational model-default cards in an open or reopened run. */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SessionTask } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createRunPlanService } from '../../services/run-orchestrator-service.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'
import {
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  REPLACEMENT_DEFAULT_MODEL,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const HOST_PROVIDER = FIXTURE_PROVIDER
const ADMITTED_MODEL = APP_DEFAULT_MODEL.id
/** What Settings is genuinely changed to afterwards. History must not follow. */
const LATER_DEFAULT_MODEL = REPLACEMENT_DEFAULT_MODEL.id
/**
 * The one model `deterministic-openai-server.ts` advertises at `/v1/models`.
 *
 * Named here rather than invented so the seeded Settings default, the catalog
 * the app validates it against, and the answers the run receives all describe
 * the same model.
 */
const DETERMINISTIC_MODEL = {
  id: 'gpt-5.4-mini',
  name: 'Deterministic Batch model',
} as const

interface HostEvent {
  readonly coordinator: string | null
  /**
   * Which host *process* the turn belonged to, and its turn number within that
   * process. Both are needed and neither is enough: the counter restarts at 0
   * in each process, so a recovered run's first turn and the turn it resumed
   * both arrive as turn 1 of the same run.
   */
  readonly hostInstanceId: string
  readonly coordinatorRunId: number
  readonly source: 'app-default' | 'agent'
  readonly model: string
}

/** When every event of the pre-seeded history happened. */
const SEEDED_HISTORY_TIMESTAMP = '2026-09-07T10:00:00.000Z'

/** The host process that started the run, and the one that resumed it. */
const FIRST_HOST_PROCESS = 'host-process-1111'
const RECOVERED_HOST_PROCESS = 'host-process-2222'

function engineEvent(
  runId: string,
  host: HostEvent,
  timestamp = SEEDED_HISTORY_TIMESTAMP,
): string {
  return JSON.stringify({
    schema_version: 1,
    timestamp,
    tenant_id: 'local',
    category: 'runtime',
    type: 'host.agent_start',
    run_id: runId,
    level_id: 'draft',
    stage_type: 'routing',
    payload: {
      event: 'host.agent_start',
      coordinator: host.coordinator,
      coordinator_run_id: host.coordinatorRunId,
      host_instance_id: host.hostInstanceId,
      host_provider: HOST_PROVIDER,
      host_model: host.model,
      // The record the runtime writes before it calls a provider. Its field is
      // `host_model_selection` because it describes the process rather than one
      // agent's turn.
      host_model_selection: {
        provider: HOST_PROVIDER,
        model: host.model,
        source: host.source,
        reason:
          host.source === 'app-default'
            ? 'agent-default'
            : 'explicit-agent-choice',
        caller: 'agent',
      },
    },
  })
}

/**
 * Append one host event to a run that is already going, and have it delivered.
 *
 * The timestamp is not decoration here. `FileSystemRunStore` sorts a run's
 * events by timestamp and `tailRunEvents` emits them by *position* in that
 * sorted list, from the index it has already reached. An appended event stamped
 * earlier than events already recorded sorts in behind that index and is never
 * emitted at all — the stream silently skips it and re-sends a shifted
 * neighbour instead. So the stamp is derived from the log itself: later than
 * everything in it, and never earlier than now.
 */
async function appendLiveHostEvent(
  eventsPath: string,
  runId: string,
  host: HostEvent,
): Promise<void> {
  const recorded = await fs.readFile(eventsPath, 'utf8')
  const latest = recorded
    .split('\n')
    .filter((line) => line.trim())
    .reduce((newest, line) => {
      const stamp: unknown = (JSON.parse(line) as { timestamp?: unknown })
        .timestamp
      return typeof stamp === 'string' && stamp > newest ? stamp : newest
    }, '')
  const after = Math.max(Date.now(), new Date(latest).getTime() || 0) + 1_000
  await fs.appendFile(
    eventsPath,
    `${engineEvent(runId, host, new Date(after).toISOString())}\n`,
    'utf8',
  )
}

async function seedRun(input: {
  readonly assignmentPath: string
  readonly events: readonly string[]
}): Promise<void> {
  // The record's own assignment path, not one rebuilt from ids: the layout is
  // the store's to decide, and a hand-built copy of it is a second answer that
  // can quietly stop matching.
  const logsPath = path.join(input.assignmentPath, 'logs')
  await fs.mkdir(logsPath, { recursive: true })
  await fs.writeFile(
    path.join(logsPath, 'engine-events.jsonl'),
    `${input.events.join('\n')}\n`,
  )
}

/**
 * The application default as the desktop itself reports it.
 *
 * Read through the running app's own settings API rather than from the file
 * this test wrote, so a change that the product never picked up fails here
 * instead of being assumed.
 */
async function readEffectiveDefaultModel(page: Page): Promise<string | null> {
  const response = await fetch(`${await desktopApiBaseUrl(page)}/settings/providers`)
  if (!response.ok) return null
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) return null
  const selection = (body as { defaultModel?: { model?: unknown } }).defaultModel
  return typeof selection?.model === 'string' ? selection.model : null
}

/**
 * Where the desktop's own HTTP API is listening, as the window was told.
 *
 * The renderer is loaded from `file://`, so it has no origin a relative URL
 * could resolve against; the loopback base is handed to it in the URL hash
 * instead (`electron/main.ts` `rendererHash`). Read here and fetched from the
 * test process, the way `agent-model-default-recovery.spec.ts` does.
 */
async function desktopApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get(
      'pipeline-api-base-url',
    ),
  )
  if (!baseUrl) throw new Error('the desktop API base URL is unavailable')
  return baseUrl
}

async function openRun(page: Page, title: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page
    .getByRole('button', { name: new RegExp(`^${title}\\b`) })
    .first()
    .click()
  await showWorkflowPane(page)
}

/**
 * Bring the run's own pane back into view.
 *
 * Needed more than once: starting a workflow puts the chat in front, and the
 * pane the run reports itself in can be collapsed behind the inspector toggle
 * by then. A collapsed pane is still in the DOM but inside a `display: none`
 * container, so every role query misses it and the failure reads as "the
 * product never rendered this" rather than "nobody was looking at it".
 */
async function showWorkflowPane(page: Page): Promise<void> {
  const showInspector = page.getByRole('button', { name: 'Show inspector' })
  if (await showInspector.isVisible()) await showInspector.click()
  // The run's own pane is the sidebar's Workflows pane (`run-panel.tsx` passes
  // `RightPane` as `workflowPane`).
  await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
}

test.setTimeout(180_000)

test('host model records add no cards before or after the default changes', async ({}, testInfo) => {
  const workspacePath = testInfo.outputPath('host-disclosure-workspace')
  const userDataPath = testInfo.outputPath('host-disclosure-user-data')
  const projectRootPath = testInfo.outputPath('host-disclosure-project')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
      projectRootPath,
      { recursive: true },
    ),
  ])

  const provider = await startFakeChatCompletionsServer({ script: [] })
  await seedProviderSettings({
    userDataPath,
    baseUrl: provider.url,
    defaultModel: APP_DEFAULT_MODEL,
  })

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Host disclosure E2E' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'packaged-workflow-smoke',
    brief: 'Draft the brief.',
  })
  if (!task) throw new Error('the run fixture was not created')
  await sessionStore.updateTaskRecord(session.id, task.id, {
    status: 'blocked',
    completedAt: '2026-09-07T10:05:00.000Z',
    error: 'Stopped after the draft.',
  })

  const runId = task.runId
  const assignmentPath = task.assignmentPath
  if (!runId || !assignmentPath) throw new Error('the task record has no run')
  await seedRun({
    assignmentPath,
    events: [
      // One host attempt on the application default, seen three times — a
      // reload replays history, and one attempt is still one attempt.
      engineEvent(runId, {
        coordinator: 'auditor',
        hostInstanceId: FIRST_HOST_PROCESS,
        coordinatorRunId: 1,
        source: 'app-default',
        model: ADMITTED_MODEL,
      }),
      engineEvent(runId, {
        coordinator: 'auditor',
        hostInstanceId: FIRST_HOST_PROCESS,
        coordinatorRunId: 1,
        source: 'app-default',
        model: ADMITTED_MODEL,
      }),
      // A second attempt whose coordinator named its own pair. Identical model,
      // deliberately: an explicit choice is a choice, not a fallback.
      engineEvent(runId, {
        coordinator: 'lead',
        hostInstanceId: FIRST_HOST_PROCESS,
        coordinatorRunId: 2,
        source: 'agent',
        model: ADMITTED_MODEL,
      }),
      // And a host attempt with no coordinator at all — the case that produces
      // no agent record, and therefore has no other disclosure.
      engineEvent(runId, {
        coordinator: null,
        hostInstanceId: FIRST_HOST_PROCESS,
        coordinatorRunId: 3,
        source: 'app-default',
        model: ADMITTED_MODEL,
      }),
    ],
  })

  const launch = async () =>
    electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...fixtureDesktopEnvironment(),
        NODE_ENV: 'test',
        PIPELINE_DESKTOP_E2E: '1',
        PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
        PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
        PIPELINE_DESKTOP_USER_DATA: userDataPath,
        PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      },
    })

  let app = await launch()
  try {
    const page = await app.firstWindow()
    await openRun(page, 'Host disclosure E2E')

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    await app.close()
  }

  // Settings genuinely moves on: the same file Settings → AI Providers writes
  // and `ProviderSettingsService` reads (`electron/main.ts` constructs it over
  // `userData/provider-settings.json`). An earlier version of this test wrote a
  // filename nothing reads, so its history claim proved nothing at all.
  await seedProviderSettings({
    userDataPath,
    baseUrl: provider.url,
    defaultModel: REPLACEMENT_DEFAULT_MODEL,
  })

  app = await launch()
  try {
    const page = await app.firstWindow()

    // Proved through the product's own read before anything is claimed about
    // history: if the default had not actually changed, the rest of this test
    // would be comparing history against a default that never moved.
    await expect
      .poll(
        async () =>
          JSON.parse(
            await fs.readFile(
              path.join(userDataPath, 'provider-settings.json'),
              'utf8',
            ),
          ).defaultModel?.model,
        { timeout: 20_000 },
      )
      .toBe(LATER_DEFAULT_MODEL)
    await expect
      .poll(() => readEffectiveDefaultModel(page), { timeout: 30_000 })
      .toBe(LATER_DEFAULT_MODEL)

    await openRun(page, 'Host disclosure E2E')

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    await app.close()
    await provider.close()
  }
})

/**
 * Live host events keep informational cards hidden while the run is open.
 *
 * This launches a real workflow through the button a person would press, so the
 * run has a genuine owner and the renderer opens its event stream as part of
 * starting it. The provider then holds its answers, which keeps the run in
 * `running` — the state that both keeps the stream connected and renders the
 * progress view the notice lives in. A human-input pause would do the first but
 * not the second: that state swaps the whole pane for the feedback form.
 *
 * The two host attempts appended into the live stream are indistinguishable
 * except by process: same coordinator, same pair, and turn 1 in both, because
 * the turn counter restarts in every host process while the run keeps its
 * identity. That is what a crash and a resume look like, and an attempt list
 * keyed on the run and the turn number would report the second as a repeat.
 */
test('host attempts that start while a run is open add no model-default cards', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const workspacePath = testInfo.outputPath('live-disclosure-workspace')
  const projectRootPath = testInfo.outputPath('live-disclosure-project')
  const userDataPath = testInfo.outputPath('live-disclosure-user-data')
  const piStatePath = testInfo.outputPath('live-disclosure-pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
      projectRootPath,
      { recursive: true },
    ),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({
    title: 'Live host disclosure E2E',
  })
  // Begin is offered only for a workflow the person chose, so the seeded plan
  // has to record that it was one. Starting through that button rather than
  // through the HTTP API is what makes the renderer open the stream at launch.
  const plan = await createRunPlanService({
    sessionId: session.id,
    sessionStore,
    repoRootPath: projectRootPath,
    workflowsRegistryPath: path.join(
      projectRootPath,
      'workflows',
      'registry.yaml',
    ),
    goal: 'Return the deterministic packaged workflow smoke result.',
    workflowId: 'packaged-smoke',
    selectionSource: 'user',
  })
  expect(plan.status).toBe('ready')

  // Every answer is held. The run therefore starts, claims its worker, and
  // stays running for as long as this test needs it to — a state to make an
  // assertion in rather than a race against the run finishing.
  const provider = await startDeterministicOpenAiServer({
    blockResponsesStartingAt: 1,
  })
  // The workflow has to be able to run at all. Its worker persona names no
  // pair, and there is no Team-tier fallback any more by design, so without a
  // deliberate application default the run stops at "no model selected" before
  // it starts. The default points at this journey's own loopback server and
  // names the model that server's catalog advertises, so the Settings entry,
  // the catalog it is validated against, and the answers all agree.
  await seedProviderSettings({
    userDataPath,
    baseUrl: provider.baseUrl.replace(/\/v1$/, ''),
    models: [DETERMINISTIC_MODEL],
    defaultModel: DETERMINISTIC_MODEL,
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'live-disclosure-electron-key',
      OPENAI_BASE_URL: provider.baseUrl,
      PIPELINE_DESKTOP_E2E: '1',
      PI_CODING_AGENT_DIR: piStatePath,
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  let apiBaseUrl: string | null = null
  try {
    const page = await app.firstWindow()
    apiBaseUrl = await desktopApiBaseUrl(page)
    await openRun(page, 'Live host disclosure E2E')

    const beginButton = page
      .getByRole('region', { name: 'Run chat' })
      .getByTestId('workflow-launch-confirmation')
      .getByRole('button', { name: 'Begin workflow' })
    await expect(beginButton).toBeEnabled({ timeout: 30_000 })

    // The precondition, observed rather than assumed. `snapshot=1` is the
    // one-shot history read; the request without it is the run's live event
    // stream, and its arrival is the proof that one is open.
    const streamOpened = page.waitForResponse(
      (response) =>
        /\/runs\/[^/]+\/events/.test(response.url()) &&
        !response.url().includes('snapshot=1'),
      { timeout: 60_000 },
    )
    await beginButton.click()
    expect(
      (await streamOpened).status(),
      'the run must have a live event stream before anything is appended to it',
    ).toBe(200)

    const listed: unknown = await (
      await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks`)
    ).json()
    const task = Array.isArray((listed as { tasks?: unknown }).tasks)
      ? ((listed as { tasks: SessionTask[] }).tasks.at(-1) ?? null)
      : null
    if (!task?.runId || !task.assignmentPath) {
      throw new Error(`no launched task to observe: ${JSON.stringify(listed)}`)
    }
    // Running, and held there. Reported with any error attached, so a run that
    // stops for its own reasons says why instead of only failing a comparison.
    await expect
      .poll(
        async () => {
          const record: unknown = await (
            await fetch(
              `${apiBaseUrl}/sessions/${session.id}/tasks/${task.id}`,
            )
          ).json()
          if (typeof record !== 'object' || record === null) return 'unreadable'
          const { status, error } = record as {
            status?: unknown
            error?: unknown
          }
          return error ? `${String(status)}: ${String(error)}` : String(status)
        },
        { timeout: 120_000 },
      )
      .toBe('running')

    // Launching put the chat in front. Look at the run again before asserting
    // anything about what it shows.
    await showWorkflowPane(page)
    const eventsPath = path.join(
      task.assignmentPath,
      'logs',
      'engine-events.jsonl',
    )

    // A host turn starts. Nobody reloads anything.
    await appendLiveHostEvent(eventsPath, task.runId, {
      coordinator: 'auditor',
      hostInstanceId: FIRST_HOST_PROCESS,
      coordinatorRunId: 1,
      source: 'app-default',
      model: ADMITTED_MODEL,
    })
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    // A second host process picks the run up: same coordinator, same pair, and
    // turn 1 again. Neither attempt should add an informational card.
    await appendLiveHostEvent(eventsPath, task.runId, {
      coordinator: 'auditor',
      hostInstanceId: RECOVERED_HOST_PROCESS,
      coordinatorRunId: 1,
      source: 'app-default',
      model: ADMITTED_MODEL,
    })
    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    // Let the held answers go before shutting down, so the worker exits on its
    // own terms rather than being torn down mid-request.
    provider.releaseBlockedResponses()
    await app.close()
    await provider.close()
  }
})
