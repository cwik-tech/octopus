/**
 * What the Team Runtime does with the checkpoint it finds at `session_start`.
 *
 * `startSession` reads a checkpoint only when `TEAM_RUNTIME_RECOVERY` is "1",
 * the run has a scoped assignment location, or Pi restored a persisted runtime
 * session id, and only when `hasCheckpoint` accepts the file. A checkpoint of
 * this session is adopted: its header first, then its admission and level
 * states, which can throw, then each discussion's clock is shifted by the time
 * a question waited for a person, then the level states and the admission are
 * committed and `run.resumed_from_checkpoint` is logged. From the read until the
 * whole record is committed, the process writes no checkpoint. A checkpoint of
 * another session is rejected with `checkpoint.rejected`; a scoped assignment
 * then stops with a notice, and a direct session carries on.
 *
 * These boot the real `team-runtime/index.ts` on a fixture Team and read what
 * it leaves: the assignment's logs, the checkpoint on disk and its `savedAt`,
 * the host's notifications, the entries it appends to the Pi session, and what
 * the run does next. No stage here calls a provider: routing and discussion
 * levels are started without delegated autostart, the delegated pipeline has
 * no plan, and the one chain step that runs launches a fake `pi` that records
 * a question and exits.
 *
 * A direct session has no managed capability authority, so its start fails
 * later, when the level's tools are registered. The direct-session tests read
 * what the start did before that: the checkpoint decision, the session start
 * records, and the checkpoint shutdown saves.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { format } from 'node:util'

import {
  readHostEntryAdmission,
  type HostEntryAdmission,
} from '../../contracts/host-entry-admission.js'
import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { DiscussionState, LevelState, RuntimeState } from '../../core/types.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { writeCheckpoint } from '../../domains/runtime/checkpoint.js'
import {
  ensureRunPrivateRuntimeDirectory,
  getRunRuntimePaths,
} from '../../domains/runtime/runtime-paths.js'
import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  FIXTURE_HOST_MODEL_ID,
  FIXTURE_HOST_PROVIDER,
  readAssignmentJsonl,
  type FixtureRuntime,
  type FixtureRuntimeOptions,
  type FixtureTeamOptions,
} from '../support/team-runtime-fixture-boot.js'

const COORDINATOR = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }
const NEXT_COORDINATOR = { name: 'next-lead' }
const ENTRY_LEVEL_ID = 'intake'
const NEXT_LEVEL_ID = 'next'
const TEAM_NAME = 'fixture-desk'
const AGENT_LOG_FILES = ['agent-runs.jsonl', 'provider-events.jsonl']

/** When the interrupted process wrote its checkpoint, and when its run clock started. */
const SAVED_AT = '2026-01-01T00:00:00.000Z'
const START_TIME = Date.parse(SAVED_AT)
const CHECKPOINT_ROOT = 'root-from-checkpoint'
const CHECKPOINT_PARENT = 'parent-from-checkpoint'
const CHECKPOINT_COST = 7
const CHECKPOINT_SPAWN_DEPTH = 2

/** Ids the environment offers, so an adopted header is told apart from them. */
const ENV_ROOT = 'root-from-env'
const ENV_PARENT = 'parent-from-env'

/**
 * Variables a developer's shell may carry that change the ids or depth a boot
 * starts from. Every boot here removes them unless it sets them itself.
 */
const IDENTITY_ENV = [
  'TEAM_SESSION_ID',
  'TEAM_ROOT_SESSION_ID',
  'TEAM_PARENT_SESSION_ID',
  'TEAM_SPAWN_DEPTH',
  'TEAM_RUNTIME_ASSIGNMENT_PATH',
  'TEAM_RUNTIME_RUN_PATH',
] as const

/** The scope variables the fixture sets. Without them the session is direct. */
const ASSIGNMENT_SCOPE_ENV = [
  'TEAM_RUNTIME_SESSION_ID',
  'TEAM_RUNTIME_RUN_ID',
  'TEAM_RUNTIME_ASSIGNMENT_ID',
  'TEAM_RUNTIME_TASK_ID',
  'TEAM_RUNTIME_PROCESS_IDENTITY',
] as const

const TWO_ROUTING_LEVELS: Omit<FixtureTeamOptions, 'teamRoot' | 'workspacePath'> = {
  coordinator: COORDINATOR,
  laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR }],
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/** Registers a cleanup. Cleanups run last first. */
type Defer = (cleanup: () => unknown) => void

/**
 * Runs `body`, then every cleanup it registered, last first, whether `body`
 * finished, failed an assertion, or failed part way through its setup. Every
 * cleanup runs; the first error, from `body` or a cleanup, is rethrown.
 */
async function withCleanup(body: (defer: Defer) => Promise<void>): Promise<void> {
  const cleanups: Array<() => unknown> = []
  let failure: { readonly error: unknown } | undefined
  try {
    await body((cleanup) => {
      cleanups.push(cleanup)
    })
  } catch (error) {
    failure = { error }
  }
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure) throw failure.error
}

/**
 * How long a start that waits on a child process may take. Past it the test
 * fails instead of waiting for its own timeout.
 */
const CHILD_DEADLINE_MS = 30_000

/** `work`, or a rejection naming `label` when it has not settled within `ms`. */
async function withinDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let deadline: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(deadline)
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runtimeEvents(assignmentPath: string): Array<Record<string, unknown>> {
  return readAssignmentJsonl(assignmentPath, ASSIGNMENT_LOG.runtimeEvents)
}

function eventsNamed(assignmentPath: string, event: string): Array<Record<string, unknown>> {
  return runtimeEvents(assignmentPath).filter((record) => record.event === event)
}

function onlyEvent(assignmentPath: string, event: string): Record<string, unknown> {
  const records = eventsNamed(assignmentPath, event)
  assert.equal(records.length, 1, `exactly one ${event}; got ${JSON.stringify(records)}`)
  const [record] = records
  assert.ok(record)
  return record
}

function hostEventsNamed(assignmentPath: string, event: string): Array<Record<string, unknown>> {
  return readAssignmentJsonl(assignmentPath, ASSIGNMENT_LOG.hostEvents)
    .filter((record) => record.event === event)
}

/** The `session_start` rows `logSessionStart` writes to `conversation.jsonl`. */
function sessionStartRows(assignmentPath: string): Array<Record<string, unknown>> {
  return readAssignmentJsonl(assignmentPath, 'conversation.jsonl')
    .filter((row) => row.session_start === '1')
}

/** The record with its timestamp checked and removed, so the rest compares whole. */
function withoutTimestamp(record: Record<string, unknown>): Record<string, unknown> {
  const { timestamp, ...fields } = record
  assert.equal(typeof timestamp, 'string')
  return fields
}

function assertNoAgentRan(assignmentPath: string): void {
  for (const logFile of AGENT_LOG_FILES) {
    assert.deepEqual(
      readAssignmentJsonl(assignmentPath, logFile),
      [],
      `no agent or provider ran (${logFile})`,
    )
  }
}

/** The data of the last `team-runtime` entry the runtime appended to the Pi session. */
function lastSessionEntry(runtime: FixtureRuntime): Record<string, unknown> {
  const entries = runtime.host.appendedEntries.filter((entry) => entry.customType === 'team-runtime')
  const last = entries.at(-1)
  assert.ok(last, 'the runtime appended a team-runtime session entry')
  assert.ok(isRecord(last.data), 'the session entry holds an object')
  return last.data
}

/**
 * Every line the runtime writes through `console[method]` while the test runs,
 * formatted as the console would print it. Each call is still passed on.
 */
function captureConsole(t: TestContext, method: 'warn' | 'error'): string[] {
  const lines: string[] = []
  const original = console[method].bind(console)
  t.mock.method(console, method, (...args: unknown[]) => {
    lines.push(format(...args))
    original(...args)
  })
  return lines
}

function resumeSummaries(warnings: readonly string[]): string[] {
  return warnings.filter((line) => line.startsWith('[team-runtime] Resuming session '))
}

// ── Checkpoints ──────────────────────────────────────────────────────────────

function checkpointPath(assignmentPath: string): string {
  return getRunRuntimePaths(assignmentPath).checkpointPath
}

function checkpointText(assignmentPath: string): string {
  return fs.readFileSync(checkpointPath(assignmentPath), 'utf8')
}

function checkpointFields(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  assert.ok(isRecord(parsed), 'a checkpoint is a JSON object')
  return parsed
}

function levelStateInCheckpoint(fields: Record<string, unknown>, levelId: string): Record<string, unknown> {
  const levelStates = fields.levelStates
  assert.ok(Array.isArray(levelStates), 'the checkpoint carries level states')
  const found: unknown = levelStates.find((entry: unknown) => isRecord(entry) && entry.levelId === levelId)
  assert.ok(isRecord(found), `the checkpoint carries level ${levelId}`)
  return found
}

function levelState(
  status: LevelState['status'],
  stageStatus: LevelState['stageStatus'],
  engineState: LevelState['engineState'] = null,
): LevelState {
  return { status, stageStatus, loopbackCount: 0, visitCount: 0, engineState }
}

/**
 * The state an interrupted run saved on the second of two levels, with the
 * first finished: cost 7, run clock started at START_TIME, spawn depth 2, and
 * the checkpoint's own root and parent session ids.
 */
function runSavedOnNextLevel(sessionId: string): RuntimeState {
  return {
    sessionId,
    currentLevelIndex: 1,
    levelStates: new Map<string, LevelState>([
      [ENTRY_LEVEL_ID, levelState(LEVEL_STATUS.COMPLETED, STAGE_LIFECYCLE_STATUS.COMPLETED)],
      [NEXT_LEVEL_ID, levelState(LEVEL_STATUS.ACTIVE, STAGE_LIFECYCLE_STATUS.READY)],
    ]),
    totalCost: CHECKPOINT_COST,
    startTime: START_TIME,
    timerStarted: true,
    endTime: null,
    spawnDepth: CHECKPOINT_SPAWN_DEPTH,
    rootSessionId: CHECKPOINT_ROOT,
    parentSessionId: CHECKPOINT_PARENT,
  }
}

/**
 * Write `state` as the checkpoint an interrupted process left at
 * `assignmentPath`, with its savedAt set to `savedAt` and `patch` applied to
 * the written JSON, and return the text.
 */
function writeSavedCheckpoint(
  assignmentPath: string,
  state: RuntimeState,
  options: {
    readonly savedAt?: string
    readonly patch?: (fields: Record<string, unknown>) => void
  } = {},
): string {
  writeCheckpoint(assignmentPath, state)
  const fields = checkpointFields(checkpointText(assignmentPath))
  fields.savedAt = options.savedAt ?? SAVED_AT
  options.patch?.(fields)
  const text = `${JSON.stringify(fields, null, 2)}\n`
  fs.writeFileSync(checkpointPath(assignmentPath), text)
  return text
}

// ── Boots ────────────────────────────────────────────────────────────────────

function replaceInTeamConfig(runtime: FixtureRuntime, from: string, to: string): void {
  const teamConfigPath = runtime.teamConfigPath
  assert.ok(teamConfigPath, 'a Team boot has a team.yaml')
  const text = fs.readFileSync(teamConfigPath, 'utf8')
  assert.ok(text.includes(from), `the fixture team.yaml contains ${JSON.stringify(from)}`)
  fs.writeFileSync(teamConfigPath, text.replace(from, to))
}

/**
 * Declare `incoming-brief.md` as the Team's input artifact and write it into
 * the assignment, so a chain has content to start from.
 */
function provideInputBrief(runtime: FixtureRuntime): void {
  const brief = 'incoming-brief.md'
  replaceInTeamConfig(
    runtime,
    'workflow:\n  entry_level: intake\n',
    'workflow:\n  entry_level: intake\n' +
      '  input_contract:\n' +
      '    artifacts:\n' +
      `      - path: ${brief}\n` +
      '        required: true\n',
  )
  fs.mkdirSync(runtime.assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(runtime.assignmentPath, brief), 'Draft the fixture answer.')
}

/**
 * Boot a fixture Team as an MCP-scoped assignment without starting the session.
 * Its session id is the fixture's assignment id.
 */
async function bootScoped(
  defer: Defer,
  options: Omit<FixtureRuntimeOptions, 'startSession' | 'unsetEnv'>,
): Promise<FixtureRuntime> {
  const runtime = await bootFixtureRuntime({
    ...options,
    unsetEnv: [...IDENTITY_ENV].filter((key) => !(key in (options.env ?? {}))),
    startSession: false,
  })
  defer(() => runtime.close())
  return runtime
}

interface DirectRuntime {
  readonly runtime: FixtureRuntime
  /** `<workspace>/assignments/<session id>`, where a direct session keeps its run. */
  readonly assignmentPath: string
}

/**
 * Boot a fixture Team as a direct session, with no assignment scope, without
 * starting the session. `sessionId` is its TEAM_SESSION_ID; with none, Pi's
 * persisted session entries name the session.
 */
async function bootDirect(defer: Defer, options: {
  readonly label: string
  readonly sessionId: string
  readonly teamSessionId: boolean
  readonly recovery: boolean
  readonly sessionEntries?: readonly unknown[]
}): Promise<DirectRuntime> {
  const env: Record<string, string> = {
    ...(options.teamSessionId ? { TEAM_SESSION_ID: options.sessionId } : {}),
    ...(options.recovery ? { TEAM_RUNTIME_RECOVERY: '1' } : {}),
  }
  const runtime = await bootFixtureRuntime({
    label: options.label,
    team: TWO_ROUTING_LEVELS,
    env,
    unsetEnv: [...ASSIGNMENT_SCOPE_ENV, ...IDENTITY_ENV.filter((key) => !(key in env))],
    ...(options.sessionEntries ? { sessionEntries: options.sessionEntries } : {}),
    startSession: false,
  })
  defer(() => runtime.close())
  return {
    runtime,
    assignmentPath: path.join(runtime.workspace, 'assignments', options.sessionId),
  }
}

// ── Which sessions read a checkpoint ─────────────────────────────────────────

test('a direct session with no recovery flag and no persisted session id does not read the checkpoint at its path: its run stays at the entry level and shutdown saves its own checkpoint', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const sessionId = 'direct-no-recovery'
    const { runtime, assignmentPath } = await bootDirect(defer, {
      label: 'adoption-direct-no-recovery',
      sessionId,
      teamSessionId: true,
      recovery: false,
    })
    writeSavedCheckpoint(assignmentPath, runSavedOnNextLevel(sessionId))

    await runtime.startSession()

    assert.deepEqual(eventsNamed(assignmentPath, 'run.resumed_from_checkpoint'), [])
    assert.deepEqual(eventsNamed(assignmentPath, 'checkpoint.rejected'), [])
    assert.equal(hostEventsNamed(assignmentPath, 'host.session_start').length, 1, 'the start went on past the checkpoint')
    assert.equal(sessionStartRows(assignmentPath)[0]?.root_session_id, sessionId)
    await runtime.shutdown()
    const saved = checkpointFields(checkpointText(assignmentPath))
    assert.equal(saved.sessionId, sessionId)
    assert.equal(saved.currentLevelIndex, 0, 'the run starts at the entry level')
    assert.equal(saved.totalCost, 0)
    assert.equal(saved.rootSessionId, sessionId)
    assert.equal('parentSessionId' in saved, false)
    assert.equal(saved.spawnDepth, 0)
    assert.equal(onlyEvent(assignmentPath, 'run.incomplete').level_id, ENTRY_LEVEL_ID)
    assertNoAgentRan(assignmentPath)
  })
})

test('a direct session under TEAM_RUNTIME_RECOVERY adopts the checkpoint of its own session at its path', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const sessionId = 'direct-recovering'
    const { runtime, assignmentPath } = await bootDirect(defer, {
      label: 'adoption-direct-recovering',
      sessionId,
      teamSessionId: true,
      recovery: true,
    })
    writeSavedCheckpoint(assignmentPath, runSavedOnNextLevel(sessionId))

    await runtime.startSession()

    assert.deepEqual(withoutTimestamp(onlyEvent(assignmentPath, 'run.resumed_from_checkpoint')), {
      event: 'run.resumed_from_checkpoint',
      session_id: sessionId,
      root_session_id: CHECKPOINT_ROOT,
      checkpoint_level_index: 1,
      checkpoint_total_cost: CHECKPOINT_COST,
    })
    await runtime.shutdown()
    const saved = checkpointFields(checkpointText(assignmentPath))
    assert.equal(saved.currentLevelIndex, 1)
    assert.equal(saved.totalCost, CHECKPOINT_COST)
    assert.equal(onlyEvent(assignmentPath, 'run.incomplete').level_id, NEXT_LEVEL_ID)
    assertNoAgentRan(assignmentPath)
  })
})

test('a direct session named by a persisted Pi session entry adopts the checkpoint of that session, which wins over the entry\'s own position', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const sessionId = 'direct-persisted'
    const { runtime, assignmentPath } = await bootDirect(defer, {
      label: 'adoption-direct-persisted',
      sessionId,
      teamSessionId: false,
      recovery: false,
      // What the previous process appended to the Pi session: the same run, at
      // the entry level with nothing spent.
      sessionEntries: [{
        type: 'custom',
        customType: 'team-runtime',
        data: {
          sessionId,
          currentLevelIndex: 0,
          totalCost: 0,
          startTime: 0,
          timerStarted: false,
          endTime: null,
          levelStates: {},
        },
      }],
    })
    writeSavedCheckpoint(assignmentPath, runSavedOnNextLevel(sessionId))

    await runtime.startSession()

    assert.deepEqual(withoutTimestamp(onlyEvent(assignmentPath, 'run.resumed_from_checkpoint')), {
      event: 'run.resumed_from_checkpoint',
      session_id: sessionId,
      root_session_id: CHECKPOINT_ROOT,
      checkpoint_level_index: 1,
      checkpoint_total_cost: CHECKPOINT_COST,
    })
    await runtime.shutdown()
    const saved = checkpointFields(checkpointText(assignmentPath))
    assert.equal(saved.sessionId, sessionId)
    assert.equal(saved.currentLevelIndex, 1, 'the checkpoint, not the session entry, places the run')
    assert.equal(saved.totalCost, CHECKPOINT_COST)
    assert.equal(saved.startTime, START_TIME)
    assert.equal(onlyEvent(assignmentPath, 'run.incomplete').level_id, NEXT_LEVEL_ID)
    assertNoAgentRan(assignmentPath)
  })
})

test('a scoped assignment does not read a checkpoint file that hasCheckpoint rejects, and replaces it with its own', {
  timeout: 60_000,
}, async (t) => {
  const unreadable: ReadonlyArray<{ readonly name: string; readonly text: (sessionId: string) => string }> = [
    { name: 'a file that is not JSON', text: () => '{ not json\n' },
    {
      name: 'a version 1 record with no session id',
      text: () => `${JSON.stringify({ version: 1, savedAt: SAVED_AT, currentLevelIndex: 1, totalCost: CHECKPOINT_COST, startTime: START_TIME, levelStates: [], spawnDepth: 0 }, null, 2)}\n`,
    },
  ]
  for (const file of unreadable) {
    await t.test(file.name, async (t) => {
      await withCleanup(async (defer) => {
        const runtime = await bootScoped(defer, {
          label: `adoption-no-checkpoint-${unreadable.indexOf(file)}`,
          team: TWO_ROUTING_LEVELS,
        })
        const warnings = captureConsole(t, 'warn')
        const assignmentPath = runtime.assignmentPath
        fs.mkdirSync(assignmentPath, { recursive: true })
        ensureRunPrivateRuntimeDirectory(assignmentPath)
        const written = file.text(runtime.assignmentId)
        fs.writeFileSync(checkpointPath(assignmentPath), written)

        await runtime.startSession()

        assert.deepEqual(eventsNamed(assignmentPath, 'run.resumed_from_checkpoint'), [])
        assert.deepEqual(eventsNamed(assignmentPath, 'checkpoint.rejected'), [])
        assert.deepEqual(eventsNamed(assignmentPath, 'runtime.host_start_failed'), [])
        assert.deepEqual(resumeSummaries(warnings), [])
        assert.equal(hostEventsNamed(assignmentPath, 'host.session_start').length, 1, 'the session starts')
        await runtime.shutdown()
        const text = checkpointText(assignmentPath)
        assert.notEqual(text, written)
        const saved = checkpointFields(text)
        assert.equal(saved.sessionId, runtime.assignmentId)
        assert.equal(saved.currentLevelIndex, 0)
        assertNoAgentRan(assignmentPath)
      })
    })
  }
})

// ── A checkpoint that cannot be adopted whole ────────────────────────────────

/** Ways a checkpoint of this session can throw part way through adoption. */
const THROWING_CHECKPOINTS: ReadonlyArray<{
  readonly name: string
  readonly patch: (fields: Record<string, unknown>) => void
  /** Checks the start of `runtime.host_start_failed`'s error text. */
  readonly assertError: (error: string) => void
  /** The run clock the process holds after the throw. */
  readonly clock: { readonly startTime: number; readonly timerStarted: boolean }
}> = [
  {
    name: 'the run clock',
    // The agent-question clock refuses a negative pause time.
    patch: (fields) => {
      fields.questionPausedAt = -5
    },
    assertError: (error) => {
      assert.match(error, /^ZodError: /)
      assert.match(error, /"too_small"/)
      assert.match(error, /"questionPausedAt"/)
    },
    // The clock is read after the ids, the level index and the cost, and
    // before `timerStarted`, so neither is taken from the checkpoint.
    clock: { startTime: 0, timerStarted: false },
  },
  {
    name: 'the level states',
    // The level-state restore refuses a discussion with a negative activation
    // start. The level is a routing level; the restore does not check that.
    patch: (fields) => {
      const next = levelStateInCheckpoint(fields, NEXT_LEVEL_ID)
      next.engineState = {
        type: 'discussion',
        state: {
          round: 0,
          messages: [],
          outputPath: 'out.md',
          approvedRoster: [],
          rosterAnnounced: true,
          activationStartedAtMs: -1,
        },
      }
    },
    assertError: (error) => {
      assert.ok(
        error.startsWith('Error: Discussion checkpoint has an invalid activation start timestamp.\n'),
        `the level-state restore's own message; got ${JSON.stringify(error)}`,
      )
    },
    clock: { startTime: START_TIME, timerStarted: true },
  },
]

test('a checkpoint of this session that throws part way through adoption fails the start, and no later persist rewrites it', {
  timeout: 60_000,
}, async (t) => {
  for (const variant of THROWING_CHECKPOINTS) {
    await t.test(`it throws on ${variant.name}`, async () => {
      await withCleanup(async (defer) => {
        const runtime = await bootScoped(defer, {
          label: `adoption-refused-${THROWING_CHECKPOINTS.indexOf(variant)}`,
          team: TWO_ROUTING_LEVELS,
        })
        const assignmentPath = runtime.assignmentPath
        const written = writeSavedCheckpoint(assignmentPath, runSavedOnNextLevel(runtime.assignmentId), {
          patch: variant.patch,
        })

        await runtime.startSession()

        const failure = onlyEvent(assignmentPath, 'runtime.host_start_failed')
        assert.ok(typeof failure.error === 'string')
        variant.assertError(failure.error)
        assert.deepEqual(eventsNamed(assignmentPath, 'run.resumed_from_checkpoint'), [])
        assert.deepEqual(hostEventsNamed(assignmentPath, 'host.session_start'), [], 'the start stopped at the checkpoint')
        assert.equal(checkpointText(assignmentPath), written)
        await runtime.shutdown()
        assert.equal(checkpointText(assignmentPath), written, 'shutdown did not write over the checkpoint it could not adopt')
        assertNoAgentRan(assignmentPath)
      })
    })
  }
})

test('a checkpoint of this session that throws part way through adoption leaves its ids, level index and cost adopted: the failure, the incomplete run and the Pi session entry carry them', {
  timeout: 60_000,
}, async (t) => {
  for (const variant of THROWING_CHECKPOINTS) {
    await t.test(`it throws on ${variant.name}`, async (t) => {
      await withCleanup(async (defer) => {
        const runtime = await bootScoped(defer, {
          label: `adoption-refused-header-${THROWING_CHECKPOINTS.indexOf(variant)}`,
          team: TWO_ROUTING_LEVELS,
          env: { TEAM_ROOT_SESSION_ID: ENV_ROOT, TEAM_PARENT_SESSION_ID: ENV_PARENT },
        })
        const warnings = captureConsole(t, 'warn')
        const assignmentPath = runtime.assignmentPath
        writeSavedCheckpoint(assignmentPath, runSavedOnNextLevel(runtime.assignmentId), { patch: variant.patch })

        await runtime.startSession()

        // The summary is printed before anything is taken from the checkpoint.
        const [summary, ...moreSummaries] = resumeSummaries(warnings)
        assert.deepEqual(moreSummaries, [])
        assert.ok(summary, 'the resume summary was printed')
        assert.match(summary, /\n {2}Checkpoint saved: 2026-01-01T00:00:00\.000Z$/)
        assert.equal(onlyEvent(assignmentPath, 'runtime.host_start_failed').root_session_id, CHECKPOINT_ROOT)
        await runtime.shutdown()
        assert.deepEqual(withoutTimestamp(onlyEvent(assignmentPath, 'run.incomplete')), {
          event: 'run.incomplete',
          session_id: runtime.assignmentId,
          root_session_id: CHECKPOINT_ROOT,
          parent_session_id: CHECKPOINT_PARENT,
          assignment_path: assignmentPath,
          team: TEAM_NAME,
          level_id: NEXT_LEVEL_ID,
          stage_type: 'routing',
          reason: 'session_shutdown',
        })
        const entry = lastSessionEntry(runtime)
        assert.equal(entry.sessionId, runtime.assignmentId)
        assert.equal(entry.rootSessionId, CHECKPOINT_ROOT)
        assert.equal(entry.parentSessionId, CHECKPOINT_PARENT)
        assert.equal(entry.currentLevelIndex, 1)
        assert.equal(entry.totalCost, CHECKPOINT_COST)
        assert.equal(entry.startTime, variant.clock.startTime)
        assert.equal(entry.timerStarted, variant.clock.timerStarted)
        assert.equal(entry.endTime, null)
        assertNoAgentRan(assignmentPath)
      })
    })
  }
})

test('a checkpoint whose host entry admission cannot be read is still adopted whole, and only the admission is refused: the start is blocked and the checkpoint is kept as written', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'adoption-unreadable-admission',
      team: TWO_ROUTING_LEVELS,
    })
    const assignmentPath = runtime.assignmentPath
    const written = writeSavedCheckpoint(assignmentPath, runSavedOnNextLevel(runtime.assignmentId), {
      // A state this build does not know.
      patch: (fields) => {
        fields.hostEntryAdmission = { levelId: NEXT_LEVEL_ID, visit: 0, state: 'handed_over' }
      },
    })

    await runtime.startSession()

    assert.deepEqual(eventsNamed(assignmentPath, 'runtime.host_start_failed'), [])
    assert.deepEqual(withoutTimestamp(onlyEvent(assignmentPath, 'run.resumed_from_checkpoint')), {
      event: 'run.resumed_from_checkpoint',
      session_id: runtime.assignmentId,
      root_session_id: CHECKPOINT_ROOT,
      checkpoint_level_index: 1,
      checkpoint_total_cost: CHECKPOINT_COST,
    })
    assert.equal(hostEventsNamed(assignmentPath, 'host.entry_admission.unreadable').length, 1)
    assert.ok(
      runtime.host.notifications.some((notification) =>
        notification.level === 'error' &&
        notification.message.includes("This run's saved host entry could not be read, so it cannot be resumed safely.")),
      `the refusal is shown; got ${JSON.stringify(runtime.host.notifications)}`,
    )
    assert.deepEqual(runtime.host.registered, [], 'no level was armed')
    assert.equal(checkpointText(assignmentPath), written)
    await runtime.shutdown()
    assert.equal(checkpointText(assignmentPath), written, 'the refused record is kept as written')
    assertNoAgentRan(assignmentPath)
  })
})

// ── A checkpoint adopted whole ───────────────────────────────────────────────

test('an adopted checkpoint places the run with its own ids, level, cost, clock and spawn depth, over the ids the environment offers', {
  timeout: 60_000,
}, async (t) => {
  for (const parent of ['present', 'absent'] as const) {
    await t.test(`the checkpoint's parent session id is ${parent}`, async () => {
      await withCleanup(async (defer) => {
        const runtime = await bootScoped(defer, {
          label: `adoption-header-parent-${parent}`,
          team: TWO_ROUTING_LEVELS,
          env: { TEAM_ROOT_SESSION_ID: ENV_ROOT, TEAM_PARENT_SESSION_ID: ENV_PARENT },
        })
        const assignmentPath = runtime.assignmentPath
        const saved = runSavedOnNextLevel(runtime.assignmentId)
        if (parent === 'absent') delete saved.parentSessionId
        writeSavedCheckpoint(assignmentPath, saved)

        await runtime.startSession()

        assert.deepEqual(eventsNamed(assignmentPath, 'runtime.host_start_failed'), [])
        assert.equal(onlyEvent(assignmentPath, 'run.resumed_from_checkpoint').root_session_id, CHECKPOINT_ROOT)
        const [sessionStart, ...moreStarts] = sessionStartRows(assignmentPath)
        assert.deepEqual(moreStarts, [])
        assert.equal(sessionStart?.root_session_id, CHECKPOINT_ROOT)
        await runtime.shutdown()
        const rewritten = checkpointFields(checkpointText(assignmentPath))
        assert.notEqual(rewritten.savedAt, SAVED_AT)
        assert.equal(rewritten.sessionId, runtime.assignmentId)
        assert.equal(rewritten.rootSessionId, CHECKPOINT_ROOT)
        if (parent === 'present') assert.equal(rewritten.parentSessionId, CHECKPOINT_PARENT)
        else assert.equal('parentSessionId' in rewritten, false, 'the parent the environment offered is dropped')
        assert.equal(rewritten.currentLevelIndex, 1)
        assert.equal(rewritten.totalCost, CHECKPOINT_COST)
        assert.equal(rewritten.startTime, START_TIME)
        assert.equal('questionPausedAt' in rewritten, false)
        assert.equal(rewritten.spawnDepth, CHECKPOINT_SPAWN_DEPTH)
        assert.equal(onlyEvent(assignmentPath, 'run.incomplete').level_id, NEXT_LEVEL_ID)
        assertNoAgentRan(assignmentPath)
      })
    })
  }
})

test('an adopted checkpoint that names no root session roots the run at its own session id, not at the root the environment offers', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'adoption-header-no-root',
      team: TWO_ROUTING_LEVELS,
      env: { TEAM_ROOT_SESSION_ID: ENV_ROOT },
    })
    const assignmentPath = runtime.assignmentPath
    const saved = runSavedOnNextLevel(runtime.assignmentId)
    delete saved.rootSessionId
    const written = writeSavedCheckpoint(assignmentPath, saved)
    assert.equal('rootSessionId' in checkpointFields(written), false, 'precondition: the checkpoint names no root')

    await runtime.startSession()

    assert.deepEqual(eventsNamed(assignmentPath, 'runtime.host_start_failed'), [])
    assert.equal(onlyEvent(assignmentPath, 'run.resumed_from_checkpoint').root_session_id, runtime.assignmentId)
    const [sessionStart, ...moreStarts] = sessionStartRows(assignmentPath)
    assert.deepEqual(moreStarts, [])
    assert.equal(sessionStart?.root_session_id, runtime.assignmentId)
    await runtime.shutdown()
    const rewritten = checkpointFields(checkpointText(assignmentPath))
    assert.notEqual(rewritten.savedAt, SAVED_AT)
    assert.equal(rewritten.rootSessionId, runtime.assignmentId)
    assertNoAgentRan(assignmentPath)
  })
})

test('an adopted checkpoint saved while a question waited for a person resumes the run clock and every discussion clock by the same positive span', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'adoption-discussion-clock',
      team: {
        coordinator: COORDINATOR,
        stage: 'discussion',
        laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR, stage: 'discussion' }],
      },
    })
    const assignmentPath = runtime.assignmentPath
    const entryDiscussion: DiscussionState = {
      type: STAGE_TYPE.DISCUSSION,
      round: 1,
      messages: [],
      outputPath: assignmentPath,
      activationStartedAtMs: START_TIME + 1_000,
      approvedRoster: ['fixture-member'],
      rosterAnnounced: true,
      continuation: { phase: 'awaiting_lead_decision', startedAtMs: START_TIME + 2_000 },
    }
    const laterDiscussion: DiscussionState = {
      type: STAGE_TYPE.DISCUSSION,
      round: 0,
      messages: [],
      outputPath: assignmentPath,
      activationStartedAtMs: START_TIME + 3_000,
    }
    writeSavedCheckpoint(assignmentPath, {
      sessionId: runtime.assignmentId,
      currentLevelIndex: 0,
      levelStates: new Map<string, LevelState>([
        [ENTRY_LEVEL_ID, levelState(LEVEL_STATUS.ACTIVE, STAGE_LIFECYCLE_STATUS.READY, entryDiscussion)],
        [NEXT_LEVEL_ID, levelState(LEVEL_STATUS.PENDING, STAGE_LIFECYCLE_STATUS.NOT_STARTED, laterDiscussion)],
      ]),
      totalCost: 0,
      startTime: START_TIME,
      // The question was asked ten seconds into the run.
      questionPausedAt: START_TIME + 10_000,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: runtime.assignmentId,
    })

    await runtime.startSession()

    assert.deepEqual(eventsNamed(assignmentPath, 'runtime.host_start_failed'), [])
    onlyEvent(assignmentPath, 'run.resumed_from_checkpoint')
    await runtime.shutdown()
    const rewritten = checkpointFields(checkpointText(assignmentPath))
    assert.equal('questionPausedAt' in rewritten, false, 'the pause is over')
    const resumedStart = rewritten.startTime
    assert.ok(typeof resumedStart === 'number')
    const waited = resumedStart - START_TIME
    assert.ok(Number.isFinite(waited) && waited > 0, `the run clock moved forward; got ${waited}`)

    const entry = levelStateInCheckpoint(rewritten, ENTRY_LEVEL_ID).engineState
    assert.ok(isRecord(entry) && isRecord(entry.state))
    assert.equal(entry.state.activationStartedAtMs, START_TIME + 1_000 + waited)
    assert.deepEqual(entry.state.continuation, {
      phase: 'awaiting_lead_decision',
      startedAtMs: START_TIME + 2_000 + waited,
    })
    const later = levelStateInCheckpoint(rewritten, NEXT_LEVEL_ID).engineState
    assert.ok(isRecord(later) && isRecord(later.state))
    assert.equal(later.state.activationStartedAtMs, START_TIME + 3_000 + waited)
    assertNoAgentRan(assignmentPath)
  })
})

test('a later session_start that adopts a checkpoint with no question pause drops the pause an earlier session in the process recorded', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    // The chain member is a Team, so its step launches `pi` as a child process
    // in the child assignment. This `pi` records a question there and exits,
    // and the parent reads it from that assignment's runtime-events.jsonl.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-question-pi-'))
    defer(() => fs.rmSync(binDir, { recursive: true, force: true }))
    fs.writeFileSync(path.join(binDir, 'pi'), `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const logsDir = path.join(process.cwd(), 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: new Date().toISOString(),
  event: 'run.awaiting_agent_input',
  interruption: { kind: 'awaiting_input', interactionId: 'fixture-question' },
}) + '\\n')
`, { mode: 0o700 })
    // Registered before the boot, so it runs after `close` has restored the
    // environment the default model writes into.
    defer(() => setRuntimeDefaultModelState(undefined))
    const runtime = await bootScoped(defer, {
      label: 'adoption-question-pause-dropped',
      team: {
        coordinator: COORDINATOR,
        stage: 'chain',
        omitStageCoordinator: true,
        members: [{ name: 'fixture-member' }],
        laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR }],
      },
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    })
    const assignmentPath = runtime.assignmentPath
    provideInputBrief(runtime)
    const childTeamPath = path.join(runtime.root, 'child-team')
    fs.mkdirSync(childTeamPath)
    replaceInTeamConfig(
      runtime,
      '    type: agent\n    role: Fixture team member.\n    agent_file: ./fixture-member.md\n',
      '    type: team\n    role: Fixture nested team.\n' +
        `    team_path: ${JSON.stringify(childTeamPath)}\n`,
    )
    // A Team roster entry names no model, so it takes the application default.
    setRuntimeDefaultModelState({
      status: 'available',
      provider: FIXTURE_HOST_PROVIDER,
      model: FIXTURE_HOST_MODEL_ID,
    })
    // This start waits on the `pi` child the chain step launches.
    await withinDeadline(runtime.startSession(), CHILD_DEADLINE_MS, 'the first start, which launches the fake pi')
    assert.equal(onlyEvent(assignmentPath, 'run.awaiting_agent_input').level_id, ENTRY_LEVEL_ID, 'precondition: the first start suspended on the question')
    assert.equal(
      typeof checkpointFields(checkpointText(assignmentPath)).questionPausedAt,
      'number',
      'precondition: the first start saved the pause',
    )

    // The run as saved once the question was answered: on the next level, with
    // no pause.
    const answered = writeSavedCheckpoint(assignmentPath, {
      sessionId: runtime.assignmentId,
      currentLevelIndex: 1,
      levelStates: new Map<string, LevelState>([
        [ENTRY_LEVEL_ID, levelState(LEVEL_STATUS.COMPLETED, STAGE_LIFECYCLE_STATUS.COMPLETED)],
        [NEXT_LEVEL_ID, levelState(LEVEL_STATUS.ACTIVE, STAGE_LIFECYCLE_STATUS.READY)],
      ]),
      totalCost: 0,
      startTime: START_TIME,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: runtime.assignmentId,
    })
    assert.equal('questionPausedAt' in checkpointFields(answered), false)

    await runtime.startSession()

    onlyEvent(assignmentPath, 'run.resumed_from_checkpoint')
    assert.equal(eventsNamed(assignmentPath, 'run.awaiting_agent_input').length, 1, 'the second start asked nothing')
    await runtime.shutdown()
    const saved = checkpointFields(checkpointText(assignmentPath))
    assert.notEqual(saved.savedAt, SAVED_AT, 'the second session wrote a checkpoint of its own')
    assert.equal(saved.currentLevelIndex, 1)
    assert.equal(saved.startTime, START_TIME)
    assert.equal('questionPausedAt' in saved, false, 'the earlier session\'s pause is not saved again')
    assert.deepEqual(
      readAssignmentJsonl(assignmentPath, 'provider-events.jsonl'),
      [],
      'no provider was asked for anything',
    )
  })
})

/** The entry an interrupted process admitted for the intake coordinator and had not sent. */
const PENDING_INTAKE_ADMISSION: HostEntryAdmission = {
  levelId: ENTRY_LEVEL_ID,
  visit: 0,
  state: 'pending',
  selection: {
    provider: FIXTURE_HOST_PROVIDER,
    model: FIXTURE_HOST_MODEL_ID,
    source: 'agent',
    reason: 'explicit-agent-choice',
    caller: 'agent',
  },
}

test('a later session_start whose checkpoint holds no admission drops the admission an earlier session in the process adopted, and admits the entry afresh', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    // A delegated pipeline with no plan starts itself and queues no host entry,
    // so between the two starts nothing changes the adopted admission.
    const runtime = await bootScoped(defer, {
      label: 'adoption-admission-dropped',
      team: { coordinator: COORDINATOR, stage: 'pipeline' },
      delegatedAutostart: true,
    })
    const assignmentPath = runtime.assignmentPath
    const savedRun = (): RuntimeState => ({
      sessionId: runtime.assignmentId,
      currentLevelIndex: 0,
      levelStates: new Map<string, LevelState>([
        [ENTRY_LEVEL_ID, levelState(LEVEL_STATUS.ACTIVE, STAGE_LIFECYCLE_STATUS.READY)],
      ]),
      totalCost: 0,
      startTime: START_TIME,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: runtime.assignmentId,
    })
    const withAdmission = writeSavedCheckpoint(assignmentPath, { ...savedRun(), hostEntryAdmission: PENDING_INTAKE_ADMISSION })
    await runtime.startSession()
    assert.equal(checkpointText(assignmentPath), withAdmission, 'precondition: the first start resumed the pending entry and wrote nothing')

    const secondSavedAt = '2026-01-02T00:00:00.000Z'
    const withoutAdmission = writeSavedCheckpoint(assignmentPath, savedRun(), { savedAt: secondSavedAt })
    assert.equal('hostEntryAdmission' in checkpointFields(withoutAdmission), false)

    await runtime.startSession()

    assert.equal(eventsNamed(assignmentPath, 'run.resumed_from_checkpoint').length, 2)
    const rewritten = checkpointFields(checkpointText(assignmentPath))
    assert.notEqual(rewritten.savedAt, secondSavedAt, 'the second start wrote a checkpoint of its own')
    const reading = readHostEntryAdmission(rewritten.hostEntryAdmission)
    assert.equal(reading.kind, 'admission')
    assert.ok(reading.kind === 'admission')
    assert.equal(reading.admission.levelId, ENTRY_LEVEL_ID)
    assert.equal(reading.admission.visit, 0)
    assert.equal(reading.admission.state, 'pending')
    assertNoAgentRan(assignmentPath)
  })
})

// ── A checkpoint of another session ──────────────────────────────────────────

const FOREIGN_SESSION = 'foreign-session'

function foreignRun(): RuntimeState {
  return { ...runSavedOnNextLevel(FOREIGN_SESSION), rootSessionId: 'foreign-root' }
}

test('a scoped assignment that finds another session\'s checkpoint logs checkpoint.rejected, tells the user, and starts nothing; shutdown then saves its own checkpoint over it', {
  timeout: 60_000,
}, async (t) => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'adoption-foreign-scoped',
      team: TWO_ROUTING_LEVELS,
    })
    const warnings = captureConsole(t, 'warn')
    const errors = captureConsole(t, 'error')
    const assignmentPath = runtime.assignmentPath
    const written = writeSavedCheckpoint(assignmentPath, foreignRun())
    const message = `Checkpoint session '${FOREIGN_SESSION}' does not match assignment '${runtime.assignmentId}'.`

    await runtime.startSession()

    assert.deepEqual(runtimeEvents(assignmentPath).map(withoutTimestamp), [{
      event: 'checkpoint.rejected',
      session_id: runtime.assignmentId,
      root_session_id: runtime.assignmentId,
      checkpoint_session_id: FOREIGN_SESSION,
      reason: 'session_identity_mismatch',
    }])
    assert.deepEqual(runtime.host.notifications, [{ message, level: 'error' }])
    assert.deepEqual(errors, [`[team-runtime] ${message}`])
    assert.deepEqual(resumeSummaries(warnings), [])
    // It returned before the session start was logged and before any level was armed.
    assert.deepEqual(sessionStartRows(assignmentPath), [])
    assert.deepEqual(readAssignmentJsonl(assignmentPath, ASSIGNMENT_LOG.hostEvents), [])
    assert.deepEqual(runtime.host.registered, [])
    assert.equal(checkpointText(assignmentPath), written)

    await runtime.shutdown()

    const saved = checkpointFields(checkpointText(assignmentPath))
    assert.notEqual(saved.savedAt, SAVED_AT)
    assert.equal(saved.sessionId, runtime.assignmentId)
    assert.equal(saved.currentLevelIndex, 0)
    assertNoAgentRan(assignmentPath)
  })
})

test('a direct session that finds another session\'s checkpoint logs checkpoint.rejected and goes on with its own session start, and shutdown saves its own checkpoint over it', {
  timeout: 60_000,
}, async (t) => {
  await withCleanup(async (defer) => {
    const sessionId = 'direct-foreign'
    const { runtime, assignmentPath } = await bootDirect(defer, {
      label: 'adoption-foreign-direct',
      sessionId,
      teamSessionId: true,
      recovery: true,
    })
    const errors = captureConsole(t, 'error')
    writeSavedCheckpoint(assignmentPath, foreignRun())

    await runtime.startSession()

    const events = runtimeEvents(assignmentPath)
    assert.deepEqual(withoutTimestamp(events[0] ?? {}), {
      event: 'checkpoint.rejected',
      session_id: sessionId,
      root_session_id: sessionId,
      checkpoint_session_id: FOREIGN_SESSION,
      reason: 'session_identity_mismatch',
    }, 'the rejection is the session\'s first runtime event')
    assert.equal(eventsNamed(assignmentPath, 'checkpoint.rejected').length, 1)
    assert.deepEqual(eventsNamed(assignmentPath, 'run.resumed_from_checkpoint'), [])
    assert.deepEqual(
      runtime.host.notifications.filter((notification) => notification.message.includes('does not match assignment')),
      [],
    )
    assert.deepEqual(errors.filter((line) => line.includes('does not match assignment')), [])
    // It went on with its own session start.
    assert.equal(sessionStartRows(assignmentPath)[0]?.root_session_id, sessionId)
    assert.equal(hostEventsNamed(assignmentPath, 'host.session_start').length, 1)

    await runtime.shutdown()

    const saved = checkpointFields(checkpointText(assignmentPath))
    assert.notEqual(saved.savedAt, SAVED_AT)
    assert.equal(saved.sessionId, sessionId)
    assert.equal(saved.rootSessionId, sessionId)
    assert.equal(saved.currentLevelIndex, 0)
    assert.equal(onlyEvent(assignmentPath, 'run.incomplete').level_id, ENTRY_LEVEL_ID)
    assertNoAgentRan(assignmentPath)
  })
})

test('a checkpoint of this session whose resume summary cannot be formatted fails the start before anything is taken from it, and is left as written', {
  timeout: 60_000,
}, async (t) => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, {
      label: 'adoption-summary-refused',
      team: TWO_ROUTING_LEVELS,
      env: { TEAM_ROOT_SESSION_ID: ENV_ROOT, TEAM_PARENT_SESSION_ID: ENV_PARENT },
    })
    const warnings = captureConsole(t, 'warn')
    const assignmentPath = runtime.assignmentPath
    // A cost the resume summary cannot print, so the summary throws.
    const written = writeSavedCheckpoint(assignmentPath, runSavedOnNextLevel(runtime.assignmentId), {
      patch: (fields) => {
        fields.totalCost = String(CHECKPOINT_COST)
      },
    })

    await assert.doesNotReject(runtime.startSession(), 'the start fails inside the runtime and is reported there')

    assert.deepEqual(resumeSummaries(warnings), [], 'no resume summary was printed')
    assert.equal(
      onlyEvent(assignmentPath, 'runtime.host_start_failed').root_session_id,
      ENV_ROOT,
      'nothing was taken from the checkpoint before the summary failed',
    )
    assert.deepEqual(eventsNamed(assignmentPath, 'run.resumed_from_checkpoint'), [])
    await runtime.shutdown()
    assert.equal(checkpointText(assignmentPath), written, 'the refused checkpoint was not rewritten')
    assertNoAgentRan(assignmentPath)
  })
})

test('a checkpoint of this session with an unknown field nested thousands deep is adopted whole', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootScoped(defer, { label: 'adoption-deep-field', team: TWO_ROUTING_LEVELS })
    const assignmentPath = runtime.assignmentPath
    let deep: Record<string, unknown> = {}
    for (let depth = 0; depth < 3_000; depth += 1) deep = { nested: deep }
    writeSavedCheckpoint(assignmentPath, runSavedOnNextLevel(runtime.assignmentId), {
      patch: (fields) => {
        levelStateInCheckpoint(fields, NEXT_LEVEL_ID).notes = deep
      },
    })

    await runtime.startSession()

    assert.deepEqual(eventsNamed(assignmentPath, 'runtime.host_start_failed'), [], 'the start did not fail')
    assert.deepEqual(withoutTimestamp(onlyEvent(assignmentPath, 'run.resumed_from_checkpoint')), {
      event: 'run.resumed_from_checkpoint',
      session_id: runtime.assignmentId,
      root_session_id: CHECKPOINT_ROOT,
      checkpoint_level_index: 1,
      checkpoint_total_cost: CHECKPOINT_COST,
    })
    await runtime.shutdown()
  })
})
