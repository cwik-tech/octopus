/** Delegated job naming retains its recorded model without displaying a model-default card. */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSpawnTeamTool } from '../../engines/spawn-tools.js'
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'
import {
  APP_DEFAULT_MODEL,
  FIXTURE_CONNECTION_ID,
  FIXTURE_PROVIDER,
  desktopEnvironment,
  seedProviderSettings,
} from './support/model-selection-fixture.js'

initProviders()

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const TEAM_LABEL = 'Routing Desk'
const CHILD_TEAM = 'drafting-team'

/** A phrase only the job-title helper's own system prompt carries. */
const JOB_TITLE_PROMPT_MARKER = 'Output a 2-6 word Title-Case headline'
/** A phrase only the session-title helper's own system prompt carries. */
const SESSION_TITLE_PROMPT_MARKER = 'session title that summarizes'
/**
 * What this journey asks the Team for.
 *
 * Also the fragment the routing turn is held by, because it is the one string
 * this test can point to in the request: the launch writes it into the brief
 * (`incoming-brief.md`), which is what the routing coordinator is then asked
 * about. Holding on the Team's own wording instead would tie the hold to
 * prompt text this journey does not own.
 */
const USER_MESSAGE = 'Please look at the warehouse automation proposal.'
/** What the router's own request carries: the first line of its persona. */
const ROUTER_MARKER = 'You are router'

const GENERATED_JOB_TITLE = 'Warehouse Automation Rollout'
const GENERATED_SESSION_TITLE = 'Reviewing The Warehouse Automation Brief'
const DELEGATED_BRIEF =
  'Review the warehouse automation proposal and recommend rollout priorities.'

/** The tool interface needs an extension context; no engine tool reads it. */
const UNUSED_EXTENSION_CONTEXT: ExtensionToolContext = Object.create(null)

interface OpenRun {
  readonly sessionId: string
  readonly runId: string
  /** The routing Team's own assignment inside that run. */
  readonly assignmentId: string
  readonly assignmentPath: string
}

/**
 * The routing Team's live assignment inside the run this launch started.
 *
 * A run's own assignment is named after the run; a Team it starts gets one of
 * its own. Returns `null` until that second assignment exists, so it can be
 * polled, and refuses to guess when more than one candidate is present.
 */
async function openRun(workspacePath: string): Promise<OpenRun | null> {
  const sessionsRoot = path.join(workspacePath, 'sessions')
  const sessions = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  for (const session of sessions) {
    if (!session.isDirectory() || session.name.startsWith('.')) continue
    const runsRoot = path.join(sessionsRoot, session.name, 'runs')
    const runs = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => [])
    for (const run of runs) {
      if (!run.isDirectory()) continue
      const assignmentsRoot = path.join(runsRoot, run.name, 'assignments')
      const assignments = await fs
        .readdir(assignmentsRoot, { withFileTypes: true })
        .catch(() => [])
      const foreign = assignments.filter(
        (entry) => entry.isDirectory() && entry.name !== run.name,
      )
      if (foreign.length !== 1) continue
      const assignmentId = foreign[0]?.name
      if (assignmentId === undefined) continue
      const assignmentPath = path.join(assignmentsRoot, assignmentId)
      // Existence only. That the routing turn is still running is observed
      // at the provider, where its request is being held (see the journey).
      return {
        sessionId: session.name,
        runId: run.name,
        assignmentId,
        assignmentPath,
      }
    }
  }
  return null
}

interface NamingRecord {
  readonly delegationId: string
  readonly selection: Record<string, unknown>
}

/** What the delegation durably recorded as having named its job. */
async function recordedNaming(assignmentPath: string): Promise<NamingRecord | null> {
  const raw = await fs
    .readFile(path.join(assignmentPath, 'logs', 'delegations.jsonl'), 'utf8')
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
    if (Reflect.get(entry, 'event') !== 'delegation.job_title_selected') continue
    const delegationId = Reflect.get(entry, 'delegation_id')
    const selection = Reflect.get(entry, 'model_selection')
    if (typeof delegationId !== 'string') continue
    if (typeof selection !== 'object' || selection === null) continue
    const record: Record<string, unknown> = {}
    for (const key of ['provider', 'model', 'source', 'reason', 'caller']) {
      record[key] = Reflect.get(selection, key)
    }
    return { delegationId, selection: record }
  }
  return null
}

/** The name this exact session goes by, so it can be reopened as itself. */
async function persistedSessionTitle(
  workspacePath: string,
  sessionId: string,
): Promise<string> {
  const raw = await fs.readFile(
    path.join(workspacePath, 'sessions', sessionId, 'session.json'),
    'utf8',
  )
  const metadata: unknown = JSON.parse(raw)
  if (typeof metadata !== 'object' || metadata === null) {
    throw new Error('the session record is not an object')
  }
  const title = Reflect.get(metadata, 'title')
  if (typeof title !== 'string' || title === '') {
    throw new Error('the session record carries no title')
  }
  return title
}

test('a delegated job records its naming model without cards, live and after reopening', async ({}, testInfo) => {
  test.setTimeout(360_000)

  // Two owned endpoints, because two different consumers are involved and
  // keeping them apart is what makes the assertion mean something. The Team's
  // own agents run on their configured `openai` pair through the coding agent;
  // the naming helper owns no Agent and runs on the application default, which
  // is a configured connection. A single endpoint would leave "the naming ran
  // on the app default" unprovable from the wire.
  const appDefaultProvider = await startFakeChatCompletionsServer({
    script: [
      {
        content: GENERATED_JOB_TITLE,
        match: (request) =>
          request.systemPrompt?.includes(JOB_TITLE_PROMPT_MARKER) ?? false,
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

  // The routing turn is held, which is what keeps the run open while the
  // delegation is recorded — so the account lands in a live assignment rather
  // than a finished one, and the notice has to arrive through the subscription
  // rather than through a later read. Held by what the request asks for, not by
  // its position: the run issues other turns whose order around it is not fixed.
  const runtimeProvider = await startDeterministicOpenAiServer({
    blockRequestsMatching: [USER_MESSAGE],
  })

  const userDataPath = testInfo.outputPath('delegation-title-user-data')
  const workspacePath = testInfo.outputPath('delegation-title-workspace')
  const projectRoot = testInfo.outputPath('delegation-title-project')
  const piStatePath = testInfo.outputPath('delegation-title-pi-state')
  const absentCliPath = testInfo.outputPath('no-such-runtime-cli')
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

  // The same application default the desktop was seeded with, so the helper
  // driven from this process resolves the pair the product would have.
  const previousDefault = getRuntimeDefaultModelState()
  const previousCliPath = process.env.TEAM_RUNTIME_PI_CLI_PATH
  setConfiguredProviderConnections([
    {
      id: FIXTURE_CONNECTION_ID,
      kind: 'openai-compatible',
      name: 'Fake selection provider',
      baseUrl: `${appDefaultProvider.url}/v1`,
      apiKey: 'delegation-job-title-key',
    },
  ])
  setRuntimeDefaultModelState({
    status: 'available',
    provider: FIXTURE_PROVIDER,
    model: APP_DEFAULT_MODEL.id,
  })

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
      OPENAI_API_KEY: 'delegation-job-title-key',
      OPENAI_BASE_URL: runtimeProvider.baseUrl,
      PI_CODING_AGENT_DIR: piStatePath,
    },
  })

  try {
    const page = await app.firstWindow({ timeout: 45_000 })
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: TEAM_LABEL }).click()

    // The precondition for a *live* claim, observed rather than assumed.
    // `snapshot=1` is the one-shot history read; the request without it is the
    // run's live event stream, and its arrival is the proof one is open.
    const streamOpened = page.waitForResponse(
      (response) =>
        /\/runs\/[^/]+\/events/.test(response.url()) &&
        !response.url().includes('snapshot=1'),
      { timeout: 120_000 },
    )

    const composer = page.getByRole('textbox').first()
    await composer.fill(USER_MESSAGE)
    await composer.press('Enter')

    expect(
      (await streamOpened).status(),
      'the run must have a live event stream before anything is appended to it',
    ).toBe(200)

    // ── The run, still open, with the routing Team's turn held ─────────────
    // Open is observed where it is real: the router's own request has reached
    // the provider and is being held there. On the native tool lane the child
    // writes no provider events for this turn, and the request carries that
    // lane's 30 s deadline, which stays as it is: everything up to the release
    // below has to happen promptly.
    await runtimeProvider.waitForBlockedRequest(ROUTER_MARKER)
    await expect.poll(() => openRun(workspacePath), { timeout: 20_000 }).not.toBeNull()
    const run = await openRun(workspacePath)
    if (run === null) throw new Error('the launch started no routing assignment')

    // ── The real writer, against that run's own assignment ────────────────
    const tool = createSpawnTeamTool({
      teamName: 'routing-desk',
      teamConfig: {
        team: { name: 'routing-desk', description: 'test', version: '0.1.0' },
        workspace: { path: path.join(run.assignmentPath, 'workspace'), watch: false },
        agents: [
          {
            name: CHILD_TEAM,
            type: 'team',
            role: 'Child drafting team',
            tier: 'strategic',
            agent_file: './unused.md',
            color: 141,
            team_path: path.join(projectRoot, 'teams', CHILD_TEAM),
          },
        ],
        levels: [],
        gates: [],
        composition: {
          spawn_limits: { maxDepth: 3, maxConcurrent: 1, maxTotalBudgetUsd: 50 },
        },
      },
      teamRegistry: new Map([[
        CHILD_TEAM,
        {
          name: CHILD_TEAM,
          type: 'team' as const,
          team_path: path.join(projectRoot, 'teams', CHILD_TEAM),
          input_artifact: 'incoming-brief.md',
          output_artifact: 'draft-result.md',
        },
      ]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      // Only a routing stage names the job it hands over.
      stageType: 'routing',
      outputPath: run.assignmentPath,
      state: {
        // The routing Team's own identity, and the root it belongs to. This is
        // what decides whether the account reaches this conversation at all:
        // the store keeps a foreign assignment's events only where they name
        // this run as their root.
        sessionId: run.assignmentId,
        rootSessionId: run.runId,
        parentSessionId: run.runId,
        currentLevelIndex: 0,
        levelStates: new Map(),
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
      },
      activeSpawnCountRef: { count: 0 },
    })

    // The child is left to the ordinary boundary rather than replaced, and made
    // to fail before it can start: this path does not exist, so the launcher
    // refuses. Without it the runner falls back to the repository extension and
    // inherits the ambient environment, spawning a child nobody asked for.
    // Naming happens before any of that, which is the point.
    //
    // Scoped to this call and restored straight after, because it belongs to
    // the fixture's own child and to nothing else. The desktop resolves its
    // bundled CLI at boot and would not have used it either way, but an
    // override left standing across the journey would read as a claim about
    // the product's launch that this test is not making.
    process.env.TEAM_RUNTIME_PI_CLI_PATH = absentCliPath
    // The refusal is the expected outcome and is asserted rather than
    // swallowed: a delegation that failed for some other reason would
    // otherwise look exactly like this one.
    const spawnFailure = await tool
      .execute(
        'call-1',
        { team: CHILD_TEAM, brief: DELEGATED_BRIEF },
        undefined,
        undefined,
        UNUSED_EXTENSION_CONTEXT,
      )
      .then(() => null, (error: unknown) => error)
      .finally(() => {
        if (previousCliPath === undefined) delete process.env.TEAM_RUNTIME_PI_CLI_PATH
        else process.env.TEAM_RUNTIME_PI_CLI_PATH = previousCliPath
      })
    expect(
      spawnFailure instanceof Error ? spawnFailure.message : String(spawnFailure),
    ).toBe(`Bundled Pi CLI is missing: ${absentCliPath}`)

    // ── What was recorded, before anything is asserted about the page ──────
    const naming = await recordedNaming(run.assignmentPath)
    if (naming === null) throw new Error('the delegation recorded no naming')
    // Stated whole and independently: nobody picked a model for a job title, so
    // this can only have come from the one application default.
    expect(naming.selection).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'agent-default',
      caller: 'title',
    })
    expect(naming.delegationId).toContain(CHILD_TEAM)

    // And what the wire says it actually ran on. Awaited rather than read
    // straight through: the account is written *before* the request goes out,
    // so the record existing does not yet mean the request has arrived.
    const jobTitleModelsAsked = () => [
      ...new Set(
        appDefaultProvider.requests
          .filter((request) =>
            request.systemPrompt?.includes(JOB_TITLE_PROMPT_MARKER) ?? false,
          )
          .map((request) => request.model ?? ''),
      ),
    ]
    await expect
      .poll(jobTitleModelsAsked, { timeout: 60_000 })
      .toEqual([APP_DEFAULT_MODEL.id])

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    const rendered = testInfo.outputPath('delegation-job-title-notice.png')
    await page.screenshot({ path: rendered })
    await testInfo.attach('delegation-job-title-notice', {
      path: rendered,
      contentType: 'image/png',
    })

    // The turn is still held now, with the notice already on screen. Checked
    // here and not only before the write: a turn that ended or failed while the
    // page was rendering would leave the same notice visible and turn this into
    // a claim about a finished run.
    expect(
      runtimeProvider.isHoldingRequest(ROUTER_MARKER),
      'the routing turn must still be open while the notice is on screen',
    ).toBe(true)

    // ── Reopened. Renderer state is discarded; the record is not ───────────
    // Released only now, so the run finishes and the session settles under the
    // name it will be reopened by.
    runtimeProvider.releaseBlockedResponses()
    await expect
      .poll(() => persistedSessionTitle(workspacePath, run.sessionId).catch(() => ''), {
        timeout: 120_000,
      })
      .toBe(GENERATED_SESSION_TITLE)

    // Reopened by the exact session this launch recorded, read from its own
    // metadata. Clicking whichever row matched a name would be a different
    // session's notice on a bad day.
    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .locator('[data-slot="workspace-sidebar"][data-side="left"]')
      .getByRole('button', {
        name: new RegExp(
          `^${GENERATED_SESSION_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      })
      .click()

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    if (previousCliPath === undefined) delete process.env.TEAM_RUNTIME_PI_CLI_PATH
    else process.env.TEAM_RUNTIME_PI_CLI_PATH = previousCliPath
    setRuntimeDefaultModelState(previousDefault)
    setConfiguredProviderConnections([])
    // Before the window closes, and on the failing path too: a held turn left
    // held means the desktop shuts down with a request still open, which turns
    // one readable assertion failure into a teardown hang.
    runtimeProvider.releaseBlockedResponses()
    await app.close()
    await runtimeProvider.close()
    await appDefaultProvider.close()
  }
})
