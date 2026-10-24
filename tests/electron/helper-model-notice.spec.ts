/** Meeting minutes use and record the application default without displaying a model-default card. */
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
  desktopEnvironment,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const USER_MESSAGE = 'Please write up the warehouse automation proposal.'

/**
 * A phrase only the minutes helper's own system prompt carries.
 *
 * Taken from the template the helper actually loads
 * (`examples/minutes-template.md`), not from what the notice is called: the
 * words "Meeting Minutes" appear in the rendered output, never in the request.
 */
const MINUTES_PROMPT_MARKER = 'You are a professional meeting minutes writer'
/** A phrase only the session-title helper's own system prompt carries. */
const SESSION_TITLE_PROMPT_MARKER = 'session title that summarizes'

/** The name this session is created with, and the one it keeps. */
const SESSION_TITLE = 'Helper Disclosure E2E'
const GENERATED_SESSION_TITLE = 'Reviewing The Warehouse Automation Brief'
const MINUTES_BODY = '## Decisions\n\n- The proposal was written up.'

interface LaunchedSession {
  readonly id: string
  readonly title: string
}

/**
 * This journey's own session, read by the id it was created with.
 *
 * Identity first, name second: the title is renamed by the session-title helper
 * while the run is going, so a reader that found the session by name would be
 * racing that rename. The id never moves.
 *
 * Deliberately not "the one session in the workspace". A desktop launch leaves
 * a session of its own beside the seeded one, so a reader keyed on there being
 * exactly one answers `null` forever — which is a reader that cannot identify
 * anything rather than one being careful.
 */
async function seededSessionRecord(
  workspacePath: string,
  sessionId: string,
): Promise<LaunchedSession | null> {
  const raw = await fs
    .readFile(path.join(workspacePath, 'sessions', sessionId, 'session.json'), 'utf8')
    .catch(() => '')
  if (raw === '') return null
  const metadata: unknown = JSON.parse(raw)
  if (typeof metadata !== 'object' || metadata === null) return null
  const id = Reflect.get(metadata, 'id')
  const title = Reflect.get(metadata, 'title')
  // The record has to agree with the directory it was read from. A session
  // whose own file names a different id is not this session.
  if (typeof id !== 'string' || id !== sessionId) return null
  return { id, title: typeof title === 'string' ? title : '' }
}

/**
 * The minutes account this run recorded, from its own assignment journal.
 *
 * Read from disk rather than from the page, so what follows is that the screen
 * shows what was stored — not that two renderings of one guess agree.
 */
async function recordedMinutesSelection(
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
          path.join(assignmentsRoot, assignment.name, 'logs', 'runtime-events.jsonl'),
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
        if (Reflect.get(entry, 'helper') !== 'minutes') continue
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

test('a run records its minutes model without cards before the model answers', async ({}, testInfo) => {
  test.setTimeout(360_000)

  // Hold the minutes answer while checking its record and the open chat.
  // Answering immediately would only show that the record arrives
  // eventually; the rule is that it exists before the model is used,
  // and a held response is what makes that observable rather than a race.
  let releaseMinutes = (): void => {}
  const minutesHeld = new Promise<void>((resolve) => {
    releaseMinutes = resolve
  })
  const appDefaultProvider = await startFakeChatCompletionsServer({
    script: [
      {
        content: MINUTES_BODY,
        gate: minutesHeld,
        match: (request) =>
          request.systemPrompt?.includes(MINUTES_PROMPT_MARKER) ?? false,
      },
      {
        // Four words or more: a shorter answer is refused as a title, and this
        // journey needs the session reopenable by the name it was given.
        content: GENERATED_SESSION_TITLE,
        match: (request) =>
          request.systemPrompt?.includes(SESSION_TITLE_PROMPT_MARKER) ?? false,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })
  const runtimeProvider = await startDeterministicOpenAiServer()

  const userDataPath = testInfo.outputPath('helper-notice-user-data')
  const workspacePath = testInfo.outputPath('helper-notice-workspace')
  const projectRoot = testInfo.outputPath('helper-notice-project')
  const piStatePath = testInfo.outputPath('helper-notice-pi-state')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'delegation-job-title-e2e'),
      projectRoot,
      { recursive: true },
    ),
    seedProviderSettings({
      userDataPath,
      baseUrl: appDefaultProvider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])

  // The session and its plan are made through the product's own services, not
  // hand-written: `Begin workflow` is offered only for a workflow a person
  // chose, and starting through that button rather than through the HTTP API is
  // what makes the renderer open the run's event stream at launch. Driving the
  // Workflows picker instead would make this a test about run planning.
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const seededSession = await sessionStore.createSession({
    title: SESSION_TITLE,
  })
  const plan = await createRunPlanService({
    sessionId: seededSession.id,
    sessionStore,
    repoRootPath: projectRoot,
    workflowsRegistryPath: path.join(projectRoot, 'workflows', 'registry.yaml'),
    goal: USER_MESSAGE,
    workflowId: 'helper-notes',
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
      OPENAI_API_KEY: 'helper-notice-key',
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

    // ── What the wire says the minutes are running on ──────────────────────
    // Stated as the set of distinct ids, so a helper asked twice still has to
    // have used one pair throughout.
    await expect
      .poll(
        () => [
          ...new Set(
            appDefaultProvider.requests
              .filter((request) =>
                request.systemPrompt?.includes(MINUTES_PROMPT_MARKER) ?? false,
              )
              .map((request) => request.model ?? ''),
          ),
        ],
        { timeout: 180_000 },
      )
      .toEqual([APP_DEFAULT_MODEL.id])

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    const rendered = testInfo.outputPath('helper-minutes-notice.png')
    await page.screenshot({ path: rendered })
    await testInfo.attach('helper-minutes-notice', {
      path: rendered,
      contentType: 'image/png',
    })

    // Released only now, so the notice above was on screen before this model
    // had answered anything.
    releaseMinutes()

    // ── Reopened. Renderer state is discarded; the record is not ───────────
    //
    // Waited for on the record itself rather than on the session file, which
    // has existed since this test created it. What is still in flight is the
    // run's own account of the model, and that is what the next assertion is
    // about.
    await expect
      .poll(
        () => recordedMinutesSelection(workspacePath, seededSession.id),
        { timeout: 120_000 },
      )
      .not.toBeNull()
    // Stated whole and independently: nobody picked a model for a run's own
    // minutes, so this can only have come from the one application default.
    expect(
      await recordedMinutesSelection(workspacePath, seededSession.id),
    ).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'agent-default',
      caller: 'minutes',
    })

    // Reopened as the exact session this run belongs to, by the id the plan was
    // created for — not by whichever row matched a name.
    const session = await seededSessionRecord(workspacePath, seededSession.id)
    if (session === null) {
      throw new Error(`the seeded session ${seededSession.id} could not be read back`)
    }

    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .locator('[data-slot="workspace-sidebar"][data-side="left"]')
      .getByRole('button', { name: new RegExp(`^${session.title}\\b`) })
      .click()

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    // On the failing path too: a held answer left held means the desktop shuts
    // down with a request still open, turning one readable assertion failure
    // into a teardown hang.
    releaseMinutes()
    await app.close()
    await runtimeProvider.close()
    await appDefaultProvider.close()
  }
})
