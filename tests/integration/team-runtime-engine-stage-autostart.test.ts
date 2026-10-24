/**
 * What the Team Runtime records when it starts a runtime-owned stage itself.
 *
 * At `session_start` the runtime resolves the stage tool of a pipeline, chain,
 * broadcast or review level, logs `runtime.stage_autostart.begin`, starts the
 * run clock, invokes the tool through the capability dispatcher, writes a
 * `runtime_autostart` row to `tool-use.jsonl`, logs `runtime.stage_autostart.end`
 * and tries to advance the level. When the invocation rejects with an agent
 * question, it writes `run.awaiting_agent_input` and records nothing else.
 * Otherwise a rejection marks the stage FAILED and writes `run.failed`, unless
 * the session is already shutting down, in which case the end event is marked
 * cancelled and no failure is recorded.
 *
 * These boot the real `team-runtime/index.ts` on a fixture Team and read the
 * assignment's logs and checkpoint. The fixture personas use `lm-studio`, and
 * the stages that run no agent never reach it. A chain member that has to run
 * uses the `claude` provider, with a fake `claude` executable first on PATH.
 *
 * The recovery prelude tests at the end cover what `startStageAutostart` does
 * to a restored level before it starts it: the stage status a recovery
 * reopens, the chain restart and its input, the levels it leaves alone, and
 * the one checkpoint it writes when it changed the level.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { HostEntryAdmission } from '../../contracts/host-entry-admission.js'
import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { ChainState, LevelState } from '../../core/types.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { buildArtifactMetadata, writeMarkdownArtifact } from '../../domains/runtime/artifacts.js'
import { readCheckpoint, writeCheckpoint } from '../../domains/runtime/checkpoint.js'
import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  FIXTURE_HOST_MODEL_ID,
  FIXTURE_HOST_PROVIDER,
  type FixtureRuntime,
  type FixtureRuntimeOptions,
  type FixtureStageType,
  type FixtureTeamPersona,
} from '../support/team-runtime-fixture-boot.js'

const COORDINATOR = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }
const LEVEL_ID = 'intake'
const TEAM_NAME = 'fixture-desk'
const INPUT_BRIEF = 'incoming-brief.md'
const AGENT_LOG_FILES = ['agent-runs.jsonl', 'provider-events.jsonl']

type RuntimeOwnedStage = Extract<FixtureStageType, 'pipeline' | 'chain' | 'broadcast' | 'review'>

const RUNTIME_OWNED_STAGES: readonly RuntimeOwnedStage[] = ['pipeline', 'chain', 'broadcast', 'review']

/** The tool each runtime-owned stage type is started with. */
const STAGE_TOOL: Record<RuntimeOwnedStage, string> = {
  pipeline: 'dispatch',
  chain: 'handoff',
  broadcast: 'broadcast',
  review: 'submit_for_review',
}

function claudeMember(name: string): FixtureTeamPersona {
  return { name, provider: 'claude', model: 'claude-haiku-4-5' }
}

function runtimeEvents(runtime: FixtureRuntime): Array<Record<string, unknown>> {
  return runtime.readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
}

function eventsNamed(runtime: FixtureRuntime, event: string): Array<Record<string, unknown>> {
  return runtimeEvents(runtime).filter((record) => record.event === event)
}

function onlyEvent(runtime: FixtureRuntime, event: string): Record<string, unknown> {
  const records = eventsNamed(runtime, event)
  assert.equal(records.length, 1, `exactly one ${event}; got ${JSON.stringify(records)}`)
  const [record] = records
  assert.ok(record)
  return record
}

/** Position of the one `event` record in the runtime-events log. */
function eventPosition(runtime: FixtureRuntime, event: string): number {
  onlyEvent(runtime, event)
  return runtimeEvents(runtime).findIndex((record) => record.event === event)
}

/** The record with its timestamp checked and removed, so the rest compares whole. */
function withoutTimestamp(record: Record<string, unknown>): Record<string, unknown> {
  const { timestamp, ...fields } = record
  assert.equal(typeof timestamp, 'string')
  return fields
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), `${filePath} holds JSON objects`)
      return Object.fromEntries(Object.entries(parsed))
    })
}

function autostartToolUseRows(runtime: FixtureRuntime): Array<Record<string, unknown>> {
  return runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.toolUse)
    .filter((row) => row.runtime_autostart === true)
}

function stageStatusInCheckpoint(runtime: FixtureRuntime): string | undefined {
  const checkpoint = readCheckpoint(runtime.assignmentPath)
  assert.ok(checkpoint, 'the run has a checkpoint')
  return checkpoint.levelStates.find((levelState) => levelState.levelId === LEVEL_ID)?.stageStatus
}

function assertNoAgentRan(runtime: FixtureRuntime): void {
  for (const logFile of AGENT_LOG_FILES) {
    assert.deepEqual(
      runtime.readAssignmentJsonl(logFile),
      [],
      `precondition: this stage tool returns without running an agent (${logFile})`,
    )
  }
}

/**
 * Check the one begin event field by field and return its tool call id.
 *
 * The id is `runtime-autostart-<uuid>-<tool>`, and every later record of the
 * same autostart carries it.
 */
function assertBegin(
  runtime: FixtureRuntime,
  stage: RuntimeOwnedStage,
): string {
  const toolName = STAGE_TOOL[stage]
  const begin = withoutTimestamp(onlyEvent(runtime, 'runtime.stage_autostart.begin'))
  const toolCallId = begin.tool_call_id
  assert.ok(typeof toolCallId === 'string', `the begin event names its call; got ${JSON.stringify(begin)}`)
  assert.match(
    toolCallId,
    new RegExp(`^runtime-autostart-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-${toolName}$`),
  )
  assert.deepEqual(begin, {
    event: 'runtime.stage_autostart.begin',
    session_id: runtime.assignmentId,
    root_session_id: runtime.assignmentId,
    level_id: LEVEL_ID,
    stage_type: stage,
    tool_name: toolName,
    tool_call_id: toolCallId,
    registered_tools: runtime.host.registered.map((tool) => tool.name),
  })
  return toolCallId
}

/** The end event's fields every outcome shares. */
function endIdentity(runtime: FixtureRuntime, stage: RuntimeOwnedStage, toolCallId: string): Record<string, unknown> {
  return {
    event: 'runtime.stage_autostart.end',
    session_id: runtime.assignmentId,
    root_session_id: runtime.assignmentId,
    level_id: LEVEL_ID,
    stage_type: stage,
    tool_name: STAGE_TOOL[stage],
    tool_call_id: toolCallId,
  }
}

function toolUseIdentity(runtime: FixtureRuntime, stage: RuntimeOwnedStage, toolCallId: string): Record<string, unknown> {
  return {
    tool_name: STAGE_TOOL[stage],
    tool_call_id: toolCallId,
    runtime_autostart: true,
    level_id: LEVEL_ID,
    stage_type: stage,
    root_session_id: runtime.assignmentId,
  }
}

/** A successful end: `is_error: false` and no `cancelled` or `error` field. */
function assertSuccessfulEnd(runtime: FixtureRuntime, stage: RuntimeOwnedStage, toolCallId: string): void {
  assert.deepEqual(
    withoutTimestamp(onlyEvent(runtime, 'runtime.stage_autostart.end')),
    { ...endIdentity(runtime, stage, toolCallId), is_error: false },
  )
  assert.deepEqual(
    autostartToolUseRows(runtime).map(withoutTimestamp),
    [{ ...toolUseIdentity(runtime, stage, toolCallId), is_error: false }],
  )
  assert.ok(
    eventPosition(runtime, 'runtime.stage_autostart.begin') <
      eventPosition(runtime, 'runtime.stage_autostart.end'),
    'the begin event is written before the end event',
  )
}

/**
 * Split the end event's `error` off, check the rest, and return the error text
 * after checking that the tool-use row carries the same text.
 */
function assertErrorEnd(
  runtime: FixtureRuntime,
  stage: RuntimeOwnedStage,
  toolCallId: string,
  outcome: { readonly isError: boolean; readonly cancelled: boolean },
): string {
  const { error, ...endFields } = withoutTimestamp(onlyEvent(runtime, 'runtime.stage_autostart.end'))
  assert.ok(typeof error === 'string' && error.length > 0, `the end event carries the error; got ${JSON.stringify(error)}`)
  assert.deepEqual(endFields, {
    ...endIdentity(runtime, stage, toolCallId),
    is_error: outcome.isError,
    cancelled: outcome.cancelled,
  })
  // The row is an error row in both the failed and the cancelled case.
  assert.deepEqual(
    autostartToolUseRows(runtime).map(withoutTimestamp),
    [{ ...toolUseIdentity(runtime, stage, toolCallId), is_error: true, error }],
  )
  assert.ok(
    eventPosition(runtime, 'runtime.stage_autostart.begin') <
      eventPosition(runtime, 'runtime.stage_autostart.end'),
    'the begin event is written before the end event',
  )
  return error
}

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
  replaceInTeamConfig(
    runtime,
    'workflow:\n  entry_level: intake\n',
    'workflow:\n  entry_level: intake\n' +
      '  input_contract:\n' +
      '    artifacts:\n' +
      `      - path: ${INPUT_BRIEF}\n` +
      '        required: true\n',
  )
  fs.mkdirSync(runtime.assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(runtime.assignmentPath, INPUT_BRIEF), 'Draft the fixture answer.')
}

interface FakeClaude {
  readonly env: Readonly<Record<string, string>>
  remove(): void
}

/** A directory holding an executable `claude` with this script, put first on PATH. */
function installFakeClaude(script: string): FakeClaude {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-autostart-claude-'))
  fs.writeFileSync(path.join(binDir, 'claude'), script, { mode: 0o700 })
  return {
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    remove: () => fs.rmSync(binDir, { recursive: true, force: true }),
  }
}

async function bootWithFakeClaude(
  fake: FakeClaude,
  options: Omit<FixtureRuntimeOptions, 'startSession'>,
): Promise<FixtureRuntime> {
  return bootFixtureRuntime({
    ...options,
    env: { ...options.env, ...fake.env },
    startSession: false,
  })
}

test('a runtime-owned stage autostart whose tool returns logs begin, one successful tool-use row and end under one call id, with or without delegated autostart', {
  timeout: 120_000,
}, async (t) => {
  for (const stage of RUNTIME_OWNED_STAGES) {
    for (const delegatedAutostart of [true, false]) {
      await t.test(`${stage} stage, ${delegatedAutostart ? 'delegated' : 'not delegated'}`, async () => {
        const runtime = await bootFixtureRuntime({
          label: `engine-autostart-${stage}-${delegatedAutostart ? 'delegated' : 'plain'}`,
          team: { coordinator: COORDINATOR, stage, omitStageCoordinator: true },
          delegatedAutostart,
        })
        try {
          // With no plan and no input artifact, each stage tool returns
          // without running an agent.
          assertNoAgentRan(runtime)
          const toolCallId = assertBegin(runtime, stage)
          assertSuccessfulEnd(runtime, stage, toolCallId)
          assert.deepEqual(eventsNamed(runtime, 'run.failed'), [])
        } finally {
          await runtime.close()
        }
      })
    }
  }
})

test('a fresh runtime-owned stage autostart starts the run clock: the checkpoint it leaves has a start time above 0 and not later than the read', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'engine-autostart-run-clock',
    team: { coordinator: COORDINATOR, stage: 'pipeline', omitStageCoordinator: true },
    startSession: false,
  })
  try {
    assert.equal(readCheckpoint(runtime.assignmentPath), null, 'precondition: no checkpoint to restore a clock from')

    await runtime.startSession()

    assertNoAgentRan(runtime)
    assertSuccessfulEnd(runtime, 'pipeline', assertBegin(runtime, 'pipeline'))
    // Nothing on this path persists after the clock starts, so the checkpoint
    // written at session_start still says 0. Shutdown persists the state.
    await runtime.shutdown()
    // The checkpoint holds the clock as `startTime` alone. A restore reads
    // `startTime > 0` as `timerStarted`, so above 0 is the started clock.
    const readAt = Date.now()
    const checkpoint = readCheckpoint(runtime.assignmentPath)
    assert.ok(checkpoint, 'the run has a checkpoint')
    assert.equal(typeof checkpoint.startTime, 'number')
    assert.ok(checkpoint.startTime > 0, `the run clock started; got startTime ${checkpoint.startTime}`)
    assert.ok(
      checkpoint.startTime <= readAt,
      `the clock started no later than the read; got startTime ${checkpoint.startTime}, read at ${readAt}`,
    )
  } finally {
    await runtime.close()
  }
})

test('a runtime-owned stage autostart whose tool invocation rejects marks the stage failed and writes one error row, an error end and one run.failed carrying the same stack', {
  timeout: 120_000,
}, async (t) => {
  /** Returns the error text the end event, the row and run.failed share. */
  async function assertFailedAutostart(
    runtime: FixtureRuntime,
    expectedErrorStart: string,
  ): Promise<string> {
    const toolCallId = assertBegin(runtime, 'pipeline')
    const error = assertErrorEnd(runtime, 'pipeline', toolCallId, { isError: true, cancelled: false })
    assert.ok(
      error.startsWith(expectedErrorStart),
      `the error starts with ${JSON.stringify(expectedErrorStart)}; got ${JSON.stringify(error)}`,
    )
    assert.match(error, /\n {4}at /, 'the error text is the stack, not only the message')

    assert.deepEqual(withoutTimestamp(onlyEvent(runtime, 'run.failed')), {
      event: 'run.failed',
      session_id: runtime.assignmentId,
      root_session_id: runtime.assignmentId,
      assignment_path: runtime.assignmentPath,
      team: TEAM_NAME,
      level_id: LEVEL_ID,
      stage_type: 'pipeline',
      error,
    })
    assert.ok(
      eventPosition(runtime, 'runtime.stage_autostart.end') < eventPosition(runtime, 'run.failed'),
      'run.failed is written after the end event',
    )
    // Read before shutdown: only the failure arm has persisted since the
    // stage started.
    assert.equal(stageStatusInCheckpoint(runtime), STAGE_LIFECYCLE_STATUS.FAILED)

    await runtime.shutdown()
    assert.deepEqual(eventsNamed(runtime, 'run.incomplete'), [], 'the failure is the run terminal')
    assert.deepEqual(eventsNamed(runtime, 'run.completed'), [])
    assert.equal(eventsNamed(runtime, 'run.failed').length, 1)
    return error
  }

  await t.test('the stage tool throws', async () => {
    const runtime = await bootFixtureRuntime({
      label: 'engine-autostart-tool-throws',
      team: { coordinator: COORDINATOR, stage: 'pipeline', omitStageCoordinator: true },
      startSession: false,
    })
    try {
      // The pipeline copies the workspace plan into the level's private plan
      // directory. A file where that directory belongs makes the copy throw.
      fs.mkdirSync(path.join(runtime.workspace, '.pi-tasks'), { recursive: true })
      fs.writeFileSync(path.join(runtime.workspace, '.pi-tasks', 'plan.md'), '# Plan: Fixture\n')
      const privateRuntimeDir = path.join(runtime.assignmentPath, '.runtime')
      fs.mkdirSync(runtime.assignmentPath, { recursive: true })
      fs.mkdirSync(privateRuntimeDir, { mode: 0o700 })
      fs.mkdirSync(path.join(privateRuntimeDir, 'pipeline'), { mode: 0o700 })
      const obstruction = path.join(privateRuntimeDir, 'pipeline', LEVEL_ID)
      fs.writeFileSync(obstruction, 'Not a directory.')

      await runtime.startSession()

      const error = await assertFailedAutostart(runtime, 'Error: ')
      assert.ok(
        error.split('\n')[0]?.includes(obstruction),
        `the error names the obstructed plan directory; got ${JSON.stringify(error)}`,
      )
    } finally {
      await runtime.close()
    }
  })

  await t.test('the dispatcher refuses the stage tool', async () => {
    const runtime = await bootFixtureRuntime({
      label: 'engine-autostart-budget-refused',
      team: { coordinator: COORDINATOR, stage: 'pipeline', omitStageCoordinator: true },
      env: { TEAM_BUDGET_CAP: '1', TEAM_BUDGET_POLICY: 'halt' },
      startSession: false,
    })
    try {
      // A restored run that has already spent more than its cap.
      writeCheckpoint(runtime.assignmentPath, {
        sessionId: runtime.assignmentId,
        currentLevelIndex: 0,
        levelStates: new Map([[
          LEVEL_ID,
          {
            status: LEVEL_STATUS.ACTIVE,
            stageStatus: STAGE_LIFECYCLE_STATUS.READY,
            loopbackCount: 0,
            engineState: null,
          },
        ]]),
        totalCost: 5,
        startTime: Date.now() - 60_000,
        timerStarted: true,
        endTime: null,
        spawnDepth: 0,
      })

      await runtime.startSession()

      assert.equal(onlyEvent(runtime, 'run.resumed_from_checkpoint').checkpoint_total_cost, 5)
      await assertFailedAutostart(
        runtime,
        'TeamRuntimeToolDispatchError: Team Runtime tool dispatch rejected: budget_exceeded\n',
      )
    } finally {
      await runtime.close()
    }
  })
})

test('a runtime-owned stage whose agent asks a question suspends the run: run.awaiting_agent_input, and no end event, no error row, no run.failed and no FAILED stage', {
  timeout: 60_000,
}, async () => {
  const interruption = { kind: 'awaiting_input', interactionId: 'fixture-question' }
  // The chain member is a Team, so its step launches `pi` as a child process
  // in the child assignment. The parent reads the child's question from that
  // assignment's runtime-events.jsonl once the child exits.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-autostart-pi-'))
  fs.writeFileSync(path.join(binDir, 'pi'), `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const logsDir = path.join(process.cwd(), 'logs')
fs.mkdirSync(logsDir, { recursive: true })
fs.appendFileSync(path.join(logsDir, 'runtime-events.jsonl'), JSON.stringify({
  timestamp: new Date().toISOString(),
  event: 'run.awaiting_agent_input',
  interruption: ${JSON.stringify(interruption)},
}) + '\\n')
`, { mode: 0o700 })
  try {
    const runtime = await bootFixtureRuntime({
      label: 'engine-autostart-agent-question',
      team: {
        coordinator: COORDINATOR,
        stage: 'chain',
        omitStageCoordinator: true,
        members: [{ name: 'fixture-member' }],
      },
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      startSession: false,
    })
    try {
      provideInputBrief(runtime)
      const childTeamPath = path.join(runtime.root, 'child-team')
      fs.mkdirSync(childTeamPath)
      replaceInTeamConfig(
        runtime,
        '    type: agent\n    role: Fixture team member.\n    agent_file: ./fixture-member.md\n',
        '    type: team\n    role: Fixture nested team.\n' +
          `    team_path: ${JSON.stringify(childTeamPath)}\n`,
      )
      // A team.yaml Team entry names no model, so it takes the application
      // default, and a Team whose agent has no model refuses to start. Set
      // after the boot, so `close` restores the environment variable it writes.
      setRuntimeDefaultModelState({
        status: 'available',
        provider: FIXTURE_HOST_PROVIDER,
        model: FIXTURE_HOST_MODEL_ID,
      })

      await runtime.startSession()

      assert.ok(
        runtime.readAssignmentJsonl('agent-runs.jsonl').some((record) =>
          record.event === 'end' && record.agent_name === 'fixture-member' && record.status === 'awaiting_input'),
        'precondition: the chain step ran the nested Team and it ended waiting for input',
      )
      assertBegin(runtime, 'chain')
      assert.deepEqual(withoutTimestamp(onlyEvent(runtime, 'run.awaiting_agent_input')), {
        event: 'run.awaiting_agent_input',
        session_id: runtime.assignmentId,
        root_session_id: runtime.assignmentId,
        level_id: LEVEL_ID,
        interruption,
      })
      assert.deepEqual(eventsNamed(runtime, 'runtime.stage_autostart.end'), [])
      assert.deepEqual(autostartToolUseRows(runtime), [])
      assert.deepEqual(eventsNamed(runtime, 'run.failed'), [])
      assert.notEqual(stageStatusInCheckpoint(runtime), STAGE_LIFECYCLE_STATUS.FAILED)

      await runtime.shutdown()
      assert.deepEqual(eventsNamed(runtime, 'run.failed'), [])
      assert.notEqual(stageStatusInCheckpoint(runtime), STAGE_LIFECYCLE_STATUS.FAILED)
    } finally {
      await runtime.close()
      // Forget the in-process default, so the next read comes from the
      // restored environment.
      setRuntimeDefaultModelState(undefined)
    }
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true })
  }
})

test('a session shut down while a runtime-owned stage tool runs ends the autostart as cancelled, with an error row but no run.failed and no FAILED stage', {
  timeout: 60_000,
}, async () => {
  // The fake connects here and waits. Its connection is the signal that the
  // chain step is running.
  const accepted = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    accepted.add(socket)
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const stepStarted = new Promise<void>((resolve) => server.once('connection', () => resolve()))
  const fake = installFakeClaude(`#!/usr/bin/env node
const socket = require('node:net').connect(${address.port}, '127.0.0.1')
socket.on('error', () => process.exit(1))
socket.on('close', () => process.exit(0))
`)
  const runtime = await bootWithFakeClaude(fake, {
    label: 'engine-autostart-cancelled',
    team: {
      coordinator: COORDINATOR,
      stage: 'chain',
      omitStageCoordinator: true,
      members: [claudeMember('fixture-member')],
    },
  })
  try {
    provideInputBrief(runtime)

    const sessionStarted = runtime.startSession()
    const firstToSettle = await Promise.race([
      stepStarted.then(() => 'chain step started'),
      sessionStarted.then(() => 'session_start settled'),
    ])
    assert.equal(firstToSettle, 'chain step started')
    await runtime.shutdown()
    await sessionStarted

    const toolCallId = assertBegin(runtime, 'chain')
    assertErrorEnd(runtime, 'chain', toolCallId, { isError: false, cancelled: true })
    assert.deepEqual(eventsNamed(runtime, 'run.failed'), [])
    assert.deepEqual(eventsNamed(runtime, 'run.completed'), [])
    assert.equal(onlyEvent(runtime, 'run.incomplete').reason, 'session_shutdown')
    assert.equal(stageStatusInCheckpoint(runtime), STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER)
  } finally {
    await runtime.close()
    for (const socket of accepted) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fake.remove()
  }
})

test('an autostart that finishes after a later session_start changed the session ids records the ids in effect when it finishes', {
  timeout: 60_000,
}, async () => {
  // The chain step connects here and waits. It is released only after a second
  // session_start has reassigned the session ids, so the ids have changed when
  // the first autostart writes its row and end.
  const accepted: net.Socket[] = []
  const server = net.createServer((socket) => {
    accepted.push(socket)
    socket.on('error', () => {})
  })
  const firstStep = new Promise<void>((resolve) => server.once('connection', () => resolve()))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const fake = installFakeClaude(`#!/usr/bin/env node
const socket = require('node:net').connect(${address.port}, '127.0.0.1')
socket.on('error', () => process.exit(1))
socket.on('close', () => process.exit(0))
socket.on('data', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'The fixture answer.', model: 'claude-haiku-4-5', usage: { input_tokens: 5, output_tokens: 5 }, total_cost_usd: 0 }) + '\\n')
  process.exit(0)
})
`)
  const runtime = await bootWithFakeClaude(fake, {
    label: 'engine-autostart-late-ids',
    team: {
      coordinator: COORDINATOR,
      stage: 'chain',
      omitStageCoordinator: true,
      members: [claudeMember('fixture-member')],
    },
  })
  try {
    provideInputBrief(runtime)

    const firstSession = runtime.startSession()
    await firstStep
    const [firstBegin] = eventsNamed(runtime, 'runtime.stage_autostart.begin')
    assert.ok(firstBegin)
    assert.equal(firstBegin.session_id, runtime.assignmentId)
    const firstCallId = firstBegin.tool_call_id

    // The second session_start takes the new ids, finds the checkpoint was
    // written under the old ones, and returns without starting another
    // autostart. Its checkpoint.rejected event shows the ids have changed.
    process.env.TEAM_SESSION_ID = 'session-after-restart'
    process.env.TEAM_ROOT_SESSION_ID = 'root-after-restart'
    await runtime.startSession()
    const rejected = onlyEvent(runtime, 'checkpoint.rejected')
    assert.equal(rejected.session_id, 'session-after-restart')
    assert.equal(rejected.root_session_id, 'root-after-restart')

    accepted[0]?.write('go\n')
    await firstSession

    const firstEnd = eventsNamed(runtime, 'runtime.stage_autostart.end')
      .find((event) => event.tool_call_id === firstCallId)
    assert.ok(firstEnd, 'the first autostart wrote its end event')
    assert.equal(firstEnd.session_id, 'session-after-restart')
    assert.equal(firstEnd.root_session_id, 'root-after-restart')
    const firstRow = autostartToolUseRows(runtime).find((row) => row.tool_call_id === firstCallId)
    assert.ok(firstRow, 'the first autostart wrote its tool-use row')
    assert.equal(firstRow.root_session_id, 'root-after-restart')

    await runtime.shutdown()
  } finally {
    await runtime.close()
    for (const socket of accepted) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fake.remove()
  }
})

test('a chain step that halts resolves the autostart: the end says is_error false, the row is not an error, no run.failed is written and the stage is left BLOCKED', {
  timeout: 60_000,
}, async () => {
  const fake = installFakeClaude(`#!/usr/bin/env node
process.stderr.write('provider refused the chain step\\n')
process.exit(1)
`)
  const runtime = await bootWithFakeClaude(fake, {
    label: 'engine-autostart-chain-halted',
    team: {
      coordinator: COORDINATOR,
      stage: 'chain',
      omitStageCoordinator: true,
      members: [claudeMember('fixture-member')],
    },
  })
  try {
    provideInputBrief(runtime)
    // Halt on the first failed attempt instead of retrying it.
    replaceInTeamConfig(
      runtime,
      '        handoff_format: markdown\n',
      '        handoff_format: markdown\n        on_agent_failure: halt\n',
    )

    await runtime.startSession()

    const agentErrors = readJsonLines(path.join(runtime.assignmentPath, 'agent-errors.jsonl'))
    assert.ok(
      agentErrors.some((record) => record.agent_name === 'fixture-member' && record.error_type === 'halt'),
      `precondition: the chain step ran its agent and halted; got ${JSON.stringify(agentErrors)}`,
    )
    const toolCallId = assertBegin(runtime, 'chain')
    assertSuccessfulEnd(runtime, 'chain', toolCallId)
    assert.deepEqual(eventsNamed(runtime, 'run.failed'), [])

    await runtime.shutdown()
    assert.deepEqual(eventsNamed(runtime, 'run.failed'), [])
    assert.deepEqual(eventsNamed(runtime, 'run.completed'), [])
    assert.equal(onlyEvent(runtime, 'run.incomplete').reason, 'session_shutdown')
    assert.equal(stageStatusInCheckpoint(runtime), STAGE_LIFECYCLE_STATUS.BLOCKED)
  } finally {
    await runtime.close()
    fake.remove()
  }
})

test('a recovered chain with one recorded step resumes it with action resume under delegated autostart, and gets no input without it', {
  timeout: 120_000,
}, async (t) => {
  /**
   * Two chain steps, `first` and `second`. The checkpoint says `first` has
   * answered and `second` was in flight when the previous process stopped.
   */
  async function bootRecoveredChain(label: string, fake: FakeClaude, delegatedAutostart: boolean): Promise<FixtureRuntime> {
    const runtime = await bootWithFakeClaude(fake, {
      label,
      team: {
        coordinator: COORDINATOR,
        stage: 'chain',
        omitStageCoordinator: true,
        members: [claudeMember('first'), claudeMember('second')],
      },
      delegatedAutostart,
      // Chat mode completes the run without minutes or reflections, which
      // would run agents on the lm-studio personas.
      env: { TEAM_RUNTIME_RECOVERY: '1', TEAM_CHAT_MODE: '1' },
    })
    provideInputBrief(runtime)
    writeCheckpoint(runtime.assignmentPath, {
      sessionId: runtime.assignmentId,
      currentLevelIndex: 0,
      levelStates: new Map([[
        LEVEL_ID,
        {
          status: LEVEL_STATUS.ACTIVE,
          stageStatus: STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
          loopbackCount: 0,
          engineState: {
            type: STAGE_TYPE.CHAIN,
            currentStep: 1,
            totalSteps: 2,
            outputs: [{ agent: 'first', text: 'Answer from first.' }],
          },
        },
      ]]),
      totalCost: 0,
      startTime: Date.now() - 60_000,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
    })
    return runtime
  }

  /** Records which persona each launch ran as, read from its system prompt file. */
  function recordingFakeClaude(launchLog: string): FakeClaude {
    return installFakeClaude(`#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const promptFileIndex = args.indexOf('--system-prompt-file')
const prompt = promptFileIndex === -1 ? '' : fs.readFileSync(args[promptFileIndex + 1], 'utf8')
const persona = (prompt.match(/^# (first|second)$/m) || [])[1] || 'unknown'
fs.appendFileSync(${JSON.stringify(launchLog)}, persona + '\\n')
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Answer from ' + persona + '.',
  model: 'claude-haiku-4-5',
  usage: { input_tokens: 5, output_tokens: 5 },
  total_cost_usd: 0,
}) + '\\n')
`)
  }

  function launches(launchLog: string): string[] {
    return fs.existsSync(launchLog)
      ? fs.readFileSync(launchLog, 'utf8').split('\n').filter((line) => line.length > 0)
      : []
  }

  /** The argument names the runtime's own handoff dispatch was requested with. */
  function autostartHandoffArgumentNames(runtime: FixtureRuntime): unknown {
    const requested = runtime
      .readAssignmentJsonl(ASSIGNMENT_LOG.capabilityDispatchEvents)
      .filter((event) =>
        event.type === 'capability.dispatch.requested' &&
        event.capabilityId === 'team-runtime.engine.handoff' &&
        event.sourceId === 'team-runtime:runtime-autostart')
    assert.equal(requested.length, 1, `one autostart handoff dispatch; got ${JSON.stringify(requested)}`)
    return requested[0]?.argumentNames
  }

  function chainStepFile(runtime: FixtureRuntime, step: number, agent: string): string {
    return path.join(runtime.assignmentPath, `chain-step-${step}-${agent}.md`)
  }

  await t.test('with delegated autostart the chain resumes at its second step and completes', async () => {
    const launchLog = path.join(os.tmpdir(), `engine-autostart-resume-${process.pid}-launches.txt`)
    const fake = recordingFakeClaude(launchLog)
    const runtime = await bootRecoveredChain('engine-autostart-resume-delegated', fake, true)
    try {
      await runtime.startSession()

      assert.deepEqual(launches(launchLog), ['second'], 'only the unanswered step ran')
      assert.equal(fs.existsSync(chainStepFile(runtime, 1, 'first')), false)
      assert.equal(fs.existsSync(chainStepFile(runtime, 2, 'second')), true)
      const toolCallId = assertBegin(runtime, 'chain')
      assertSuccessfulEnd(runtime, 'chain', toolCallId)

      // The shutdown flushes the dispatch evidence and emits the deferred
      // completion the advance requested.
      await runtime.shutdown()
      assert.deepEqual(autostartHandoffArgumentNames(runtime), ['action'])
      assert.equal(onlyEvent(runtime, 'run.completed').level_id, LEVEL_ID)
      assert.deepEqual(eventsNamed(runtime, 'run.failed'), [])
    } finally {
      await runtime.close()
      fake.remove()
      fs.rmSync(launchLog, { force: true })
    }
  })

  await t.test('without delegated autostart the chain gets no input and runs no step', async () => {
    const launchLog = path.join(os.tmpdir(), `engine-autostart-no-resume-${process.pid}-launches.txt`)
    const fake = recordingFakeClaude(launchLog)
    const runtime = await bootRecoveredChain('engine-autostart-resume-plain', fake, false)
    try {
      await runtime.startSession()

      assert.deepEqual(launches(launchLog), [], 'no step ran')
      assert.equal(fs.existsSync(chainStepFile(runtime, 2, 'second')), false)
      const toolCallId = assertBegin(runtime, 'chain')
      assertSuccessfulEnd(runtime, 'chain', toolCallId)

      await runtime.shutdown()
      assert.deepEqual(autostartHandoffArgumentNames(runtime), [])
      assert.deepEqual(eventsNamed(runtime, 'run.completed'), [])
      assert.deepEqual(eventsNamed(runtime, 'run.failed'), [])
    } finally {
      await runtime.close()
      fake.remove()
      fs.rmSync(launchLog, { force: true })
    }
  })
})

// ── The recovery prelude ─────────────────────────────────────────────────────
//
// Before `startStageAutostart` starts a level under TEAM_DELEGATED_AUTOSTART=1,
// it recovers the level state a checkpoint restored. Under
// TEAM_RUNTIME_RECOVERY=1 it reopens a FAILED stage to READY, reopens a running
// discussion specialist pass, and restarts an interrupted chain at its first
// unanswered step unless that step's agent recorded a BLOCKED verdict. It
// writes one checkpoint when any of that changed the level, and none
// otherwise.
//
// Most of these checkpoints carry the entry the interrupted process had
// admitted for the coordinator and not sent. `session_start` resumes that entry
// instead of admitting one, and writes no checkpoint before the stage starts.
// A pipeline with no plan writes none either, and a chain writes none before
// its resumed step launches. So the checkpoint on disk after `session_start`,
// or at a chain step's launch, is the one the interrupted process left, savedAt
// included, unless the recovery wrote one.

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type StageStatus = LevelState['stageStatus']

/** When the interrupted process wrote its checkpoint, and when its run clock started. */
const INTERRUPTED_SAVED_AT = '2026-01-01T00:00:00.000Z'
const INTERRUPTED_START_TIME = Date.parse(INTERRUPTED_SAVED_AT)

/**
 * The entry the interrupted process admitted for the coordinator and had not
 * sent, on the coordinator's own pair.
 */
const INTERRUPTED_ADMISSION: HostEntryAdmission = {
  levelId: LEVEL_ID,
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

/** The chain step that was in flight: step 2, run by `second`. */
const IN_FLIGHT_STEP_FILE = 'chain-step-2-second.md'

function interruptedLevel(stageStatus: StageStatus, engineState: LevelState['engineState']): LevelState {
  return { status: LEVEL_STATUS.ACTIVE, stageStatus, loopbackCount: 0, visitCount: 0, engineState }
}

/** Two chain steps: `first` answered, `second` in flight when the process stopped. */
function chainWithFirstStepAnswered(): ChainState {
  return {
    type: STAGE_TYPE.CHAIN,
    currentStep: 1,
    totalSteps: 2,
    outputs: [{ agent: 'first', text: 'Answer from first.' }],
  }
}

function checkpointPath(runtime: FixtureRuntime): string {
  return getRunRuntimePaths(runtime.assignmentPath).checkpointPath
}

function checkpointText(runtime: FixtureRuntime): string {
  return fs.readFileSync(checkpointPath(runtime), 'utf8')
}

function checkpointFields(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  assert.ok(isRecord(parsed), 'a checkpoint is a JSON object')
  return parsed
}

/**
 * Write the checkpoint an interrupted process left, holding `levelState` for
 * the entry level when one is given, and return its text. Its savedAt is
 * INTERRUPTED_SAVED_AT. With `admittedEntry` it also holds
 * INTERRUPTED_ADMISSION.
 */
function writeInterruptedCheckpoint(
  runtime: FixtureRuntime,
  levelState: LevelState | undefined,
  options: { readonly admittedEntry: boolean },
): string {
  writeCheckpoint(runtime.assignmentPath, {
    sessionId: runtime.assignmentId,
    currentLevelIndex: 0,
    levelStates: new Map<string, LevelState>(levelState ? [[LEVEL_ID, levelState]] : []),
    totalCost: 0,
    startTime: INTERRUPTED_START_TIME,
    timerStarted: true,
    endTime: null,
    spawnDepth: 0,
    rootSessionId: runtime.assignmentId,
    ...(options.admittedEntry ? { hostEntryAdmission: INTERRUPTED_ADMISSION } : {}),
  })
  const text = `${JSON.stringify({ ...checkpointFields(checkpointText(runtime)), savedAt: INTERRUPTED_SAVED_AT }, null, 2)}\n`
  fs.writeFileSync(checkpointPath(runtime), text)
  return text
}

/**
 * `text` is a checkpoint written after the interrupted one, and differs from
 * `written` only in its savedAt and the entry level's stage status.
 */
function assertRewrittenWithStageStatus(text: string, written: string, stageStatus: StageStatus): void {
  const { savedAt, ...fields } = checkpointFields(text)
  const { savedAt: writtenSavedAt, ...writtenFields } = checkpointFields(written)
  assert.equal(writtenSavedAt, INTERRUPTED_SAVED_AT)
  assert.ok(typeof savedAt === 'string' && Number.isFinite(Date.parse(savedAt)), `savedAt is a timestamp; got ${String(savedAt)}`)
  assert.notEqual(savedAt, INTERRUPTED_SAVED_AT, 'the recovery wrote a checkpoint of its own')
  const writtenLevelStates = writtenFields.levelStates
  assert.ok(Array.isArray(writtenLevelStates))
  assert.deepEqual(fields, {
    ...writtenFields,
    levelStates: writtenLevelStates.map((entry: unknown) =>
      isRecord(entry) && entry.levelId === LEVEL_ID ? { ...entry, stageStatus } : entry),
  })
}

function assertStartupDidNotFail(runtime: FixtureRuntime): void {
  assert.deepEqual(eventsNamed(runtime, 'runtime.host_start_failed'), [])
}

/**
 * The argument names of each dispatch of `capabilityId` the runtime's own
 * autostart requested. The log is complete once the session has shut down.
 */
function autostartDispatchArguments(runtime: FixtureRuntime, capabilityId: string): unknown[] {
  return runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.capabilityDispatchEvents)
    .filter((event) =>
      event.type === 'capability.dispatch.requested' &&
      event.capabilityId === capabilityId &&
      event.sourceId === 'team-runtime:runtime-autostart')
    .map((event) => event.argumentNames)
}

interface ChainStepLaunch {
  readonly persona: string
  /** The script that ran, from its own `process.argv[1]`. */
  readonly script: string
  /** The checkpoint text on disk when the step launched, or null. */
  readonly checkpoint: string | null
}

interface LaunchRecordingClaude {
  readonly env: Readonly<Record<string, string>>
  readonly scriptPath: string
  launches(): ChainStepLaunch[]
  remove(): void
}

/**
 * A `claude` that answers every chain step and records, for each launch, the
 * persona it ran as, the script that ran and the checkpoint text on disk.
 */
function installLaunchRecordingClaude(checkpointFile: string): LaunchRecordingClaude {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-prelude-claude-'))
  const scriptPath = path.join(binDir, 'claude')
  const launchLog = path.join(binDir, 'launches.jsonl')
  const settings = { launchLog, checkpointFile }
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs')
const settings = ${JSON.stringify(settings)}
const args = process.argv.slice(2)
const promptFileIndex = args.indexOf('--system-prompt-file')
const prompt = promptFileIndex === -1 ? '' : fs.readFileSync(args[promptFileIndex + 1], 'utf8')
const persona = (prompt.match(/^# (first|second)$/m) || [])[1] || 'unknown'
const checkpoint = fs.existsSync(settings.checkpointFile) ? fs.readFileSync(settings.checkpointFile, 'utf8') : null
fs.appendFileSync(settings.launchLog, JSON.stringify({ persona, script: process.argv[1], checkpoint }) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Answer from ' + persona + '.',
  model: 'claude-haiku-4-5',
  usage: { input_tokens: 5, output_tokens: 5 },
  total_cost_usd: 0,
}) + '\\n')
`, { mode: 0o700 })
  return {
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    scriptPath,
    launches: () => readJsonLines(launchLog).map((record) => {
      const { persona, script, checkpoint } = record
      assert.ok(typeof persona === 'string' && typeof script === 'string')
      assert.ok(checkpoint === null || typeof checkpoint === 'string')
      return { persona, script, checkpoint }
    }),
    remove: () => fs.rmSync(binDir, { recursive: true, force: true }),
  }
}

/**
 * Every provider request the run logged was a launch of this fake `claude`,
 * the launches ran as `personas` in order, and no other provider was asked for
 * anything.
 */
function assertOnlyFakeClaudeRan(
  runtime: FixtureRuntime,
  fake: LaunchRecordingClaude,
  personas: readonly string[],
): void {
  const providerEvents = runtime.readAssignmentJsonl('provider-events.jsonl')
  assert.deepEqual(
    providerEvents.filter((event) => event.provider !== 'claude'),
    [],
    'no provider other than the fake claude was asked for anything',
  )
  const launches = fake.launches()
  assert.deepEqual(launches.map((launch) => launch.persona), personas)
  for (const launch of launches) {
    assert.equal(launch.script, fake.scriptPath, 'the claude that ran is the fake one')
  }
  assert.equal(
    providerEvents.filter((event) => event.event === 'request.start').length,
    launches.length,
    `every claude request the run logged is a fake launch; got ${JSON.stringify(providerEvents)}`,
  )
}

/** The one launch of the fake, and the checkpoint text it found on disk. */
function onlyLaunchCheckpoint(fake: LaunchRecordingClaude): string {
  const [launch, ...others] = fake.launches()
  assert.ok(launch, 'one step launched')
  assert.deepEqual(others, [])
  assert.ok(launch.checkpoint !== null, 'the step launched with a checkpoint on disk')
  return launch.checkpoint
}

interface InterruptedPipeline {
  readonly runtime: FixtureRuntime
  /** The checkpoint text the interrupted process left. */
  readonly written: string
}

/**
 * Boot a pipeline level led by the fixture coordinator, restored from the
 * checkpoint an interrupted process left, without starting the session. With
 * no plan its stage tool runs no agent and writes no checkpoint.
 */
async function bootInterruptedPipeline(defer: Defer, options: {
  readonly label: string
  readonly levelState: LevelState | undefined
  readonly delegatedAutostart: boolean
  readonly recovery: boolean
  readonly admittedEntry: boolean
}): Promise<InterruptedPipeline> {
  const runtime = await bootFixtureRuntime({
    label: options.label,
    team: { coordinator: COORDINATOR, stage: 'pipeline' },
    delegatedAutostart: options.delegatedAutostart,
    env: options.recovery ? { TEAM_RUNTIME_RECOVERY: '1' } : {},
    startSession: false,
  })
  defer(() => runtime.close())
  const written = writeInterruptedCheckpoint(runtime, options.levelState, { admittedEntry: options.admittedEntry })
  return { runtime, written }
}

interface InterruptedChain {
  readonly runtime: FixtureRuntime
  readonly fake: LaunchRecordingClaude
  /** The checkpoint text the interrupted process left. */
  readonly written: string
}

/**
 * Boot a delegated chain of `first` then `second`, led by the fixture
 * coordinator and restored from the checkpoint an interrupted process left,
 * without starting the session. The fake `claude` goes first on PATH after the
 * boot, so `close` restores the PATH the boot saved. Chat mode completes the
 * run without minutes or reflections, which would run agents on the lm-studio
 * coordinator.
 */
async function bootInterruptedChain(defer: Defer, options: {
  readonly label: string
  readonly levelState: LevelState
  readonly recovery: boolean
}): Promise<InterruptedChain> {
  const runtime = await bootFixtureRuntime({
    label: options.label,
    team: {
      coordinator: COORDINATOR,
      stage: 'chain',
      members: [claudeMember('first'), claudeMember('second')],
    },
    delegatedAutostart: true,
    env: { TEAM_CHAT_MODE: '1', ...(options.recovery ? { TEAM_RUNTIME_RECOVERY: '1' } : {}) },
    startSession: false,
  })
  defer(() => runtime.close())
  provideInputBrief(runtime)
  const fake = installLaunchRecordingClaude(checkpointPath(runtime))
  defer(() => fake.remove())
  Object.assign(process.env, fake.env)
  const written = writeInterruptedCheckpoint(runtime, options.levelState, { admittedEntry: true })
  return { runtime, fake, written }
}

/** The in-flight step's file, as the chain writes it when the agent answers BLOCKED. */
function recordBlockedVerdictForInFlightStep(runtime: FixtureRuntime): void {
  const filePath = path.join(runtime.assignmentPath, IN_FLIGHT_STEP_FILE)
  writeMarkdownArtifact(
    filePath,
    'Blocked: the brief does not say which answer to draft.',
    buildArtifactMetadata({
      filePath,
      rootDir: runtime.assignmentPath,
      artifactType: 'handoff',
      stageType: 'chain',
      agent: 'second',
      status: 'blocked',
      step: 2,
      role: 'chain-step',
    }),
  )
}

/** Every stage status but FAILED, the one a recovery reopens. */
const STATUSES_A_RECOVERY_KEEPS: readonly StageStatus[] = [
  STAGE_LIFECYCLE_STATUS.NOT_STARTED,
  STAGE_LIFECYCLE_STATUS.READY,
  STAGE_LIFECYCLE_STATUS.RUNNING,
  STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
  STAGE_LIFECYCLE_STATUS.WAITING_ON_VALIDATOR,
  STAGE_LIFECYCLE_STATUS.REVISING,
  STAGE_LIFECYCLE_STATUS.BLOCKED,
  STAGE_LIFECYCLE_STATUS.COMPLETED,
]

test('a delegated stage restored at any status but FAILED keeps it, with or without TEAM_RUNTIME_RECOVERY, and the checkpoint the interrupted process left is not rewritten', {
  timeout: 120_000,
}, async (t) => {
  for (const stageStatus of STATUSES_A_RECOVERY_KEEPS) {
    for (const recovery of [true, false]) {
      await t.test(`${stageStatus}, ${recovery ? 'recovering' : 'not recovering'}`, async () => {
        await withCleanup(async (defer) => {
          const { runtime, written } = await bootInterruptedPipeline(defer, {
            label: `recovery-prelude-keeps-${stageStatus}-${recovery ? 'recovering' : 'plain'}`,
            levelState: interruptedLevel(stageStatus, null),
            delegatedAutostart: true,
            recovery,
            admittedEntry: true,
          })

          await runtime.startSession()

          assertNoAgentRan(runtime)
          onlyEvent(runtime, 'runtime.stage_autostart.begin')
          assert.equal(checkpointText(runtime), written)
        })
      })
    }
  }
})

test('a delegated stage restored FAILED stays FAILED without TEAM_RUNTIME_RECOVERY, and the checkpoint the interrupted process left is not rewritten', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, written } = await bootInterruptedPipeline(defer, {
      label: 'recovery-prelude-failed-plain',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.FAILED, null),
      delegatedAutostart: true,
      recovery: false,
      admittedEntry: true,
    })

    await runtime.startSession()

    assertNoAgentRan(runtime)
    onlyEvent(runtime, 'runtime.stage_autostart.begin')
    assert.equal(checkpointText(runtime), written)
  })
})

test('a recovery reopens a delegated stage restored FAILED to READY and writes one checkpoint holding that change and nothing else', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, written } = await bootInterruptedPipeline(defer, {
      label: 'recovery-prelude-failed-recovering',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.FAILED, null),
      delegatedAutostart: true,
      recovery: true,
      admittedEntry: true,
    })

    await runtime.startSession()

    assertNoAgentRan(runtime)
    onlyEvent(runtime, 'runtime.stage_autostart.begin')
    assertRewrittenWithStageStatus(checkpointText(runtime), written, STAGE_LIFECYCLE_STATUS.READY)
  })
})

test('a recovery leaves a level without delegated autostart as the checkpoint had it: a FAILED pipeline stays FAILED and the checkpoint is not rewritten', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, written } = await bootInterruptedPipeline(defer, {
      label: 'recovery-prelude-pipeline-not-delegated',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.FAILED, null),
      delegatedAutostart: false,
      recovery: true,
      admittedEntry: true,
    })

    await runtime.startSession()

    assertNoAgentRan(runtime)
    // The runtime starts a pipeline without delegated autostart too.
    onlyEvent(runtime, 'runtime.stage_autostart.begin')
    assert.equal(checkpointText(runtime), written)
    await runtime.shutdown()
    assert.equal(stageStatusInCheckpoint(runtime), STAGE_LIFECYCLE_STATUS.FAILED)
  })
})

test('a recovery leaves a discussion without delegated autostart as the checkpoint had it: the stage stays FAILED and its running specialist pass is not reopened', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootFixtureRuntime({
      label: 'recovery-prelude-discussion-not-delegated',
      team: { coordinator: COORDINATOR, stage: 'discussion' },
      env: { TEAM_RUNTIME_RECOVERY: '1' },
      startSession: false,
    })
    defer(() => runtime.close())
    // The member answered without success while the pass was running. A
    // recovery that reopened the pass would take it out of completedTargets.
    const written = writeInterruptedCheckpoint(runtime, interruptedLevel(STAGE_LIFECYCLE_STATUS.FAILED, {
      type: STAGE_TYPE.DISCUSSION,
      round: 1,
      messages: [],
      outputPath: runtime.assignmentPath,
      activationStartedAtMs: INTERRUPTED_START_TIME,
      approvedRoster: ['fixture-member'],
      rosterAnnounced: true,
      continuation: {
        phase: 'running_specialist_pass',
        startedAtMs: INTERRUPTED_START_TIME,
        passNumber: 1,
        attemptNumber: 1,
        targets: ['fixture-member'],
        completedTargets: ['fixture-member'],
        successfulTargets: [],
      },
    }), { admittedEntry: false })
    const writtenLevelStates = checkpointFields(written).levelStates

    await runtime.startSession()

    assert.equal(
      onlyEvent(runtime, 'runtime.stage_autostart.skipped').reason,
      'stage_not_autostartable',
      'precondition: the stage autostart ran and declined the discussion',
    )
    assertNoAgentRan(runtime)
    assert.deepEqual(checkpointFields(checkpointText(runtime)).levelStates, writtenLevelStates)
    await runtime.shutdown()
    assert.deepEqual(
      checkpointFields(checkpointText(runtime)).levelStates,
      writtenLevelStates,
      'shutdown saves the level as the checkpoint had it',
    )
  })
})

test('a recovery of a checkpoint holding no state for the entry level recovers nothing and still begins the stage', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime } = await bootInterruptedPipeline(defer, {
      label: 'recovery-prelude-no-level-state',
      levelState: undefined,
      delegatedAutostart: true,
      recovery: true,
      admittedEntry: false,
    })

    await runtime.startSession()

    assertStartupDidNotFail(runtime)
    assertNoAgentRan(runtime)
    onlyEvent(runtime, 'runtime.stage_autostart.begin')
  })
})

test('a recovery does not restart a level whose stage is no longer a chain, although its checkpoint holds a BLOCKED chain state', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, written } = await bootInterruptedPipeline(defer, {
      label: 'recovery-prelude-chain-state-on-pipeline',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.BLOCKED, chainWithFirstStepAnswered()),
      delegatedAutostart: true,
      recovery: true,
      admittedEntry: true,
    })

    await runtime.startSession()

    assertStartupDidNotFail(runtime)
    assertNoAgentRan(runtime)
    onlyEvent(runtime, 'runtime.stage_autostart.begin')
    assert.equal(checkpointText(runtime), written)
  })
})

test('a recovering chain left BLOCKED by its in-flight step, with no verdict from that step\'s agent, is reopened to READY in one checkpoint and resumes that step', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, fake, written } = await bootInterruptedChain(defer, {
      label: 'recovery-prelude-chain-blocked',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.BLOCKED, chainWithFirstStepAnswered()),
      recovery: true,
    })

    await runtime.startSession()

    assertOnlyFakeClaudeRan(runtime, fake, ['second'])
    assertRewrittenWithStageStatus(onlyLaunchCheckpoint(fake), written, STAGE_LIFECYCLE_STATUS.READY)
    await runtime.shutdown()
    assert.deepEqual(autostartDispatchArguments(runtime, 'team-runtime.engine.handoff'), [['action']])
    assert.equal(onlyEvent(runtime, 'run.completed').level_id, LEVEL_ID)
  })
})

test('a recovering chain whose in-flight step recorded its agent\'s BLOCKED verdict stays BLOCKED, gets no input, runs no step and leaves the checkpoint as it was', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, fake, written } = await bootInterruptedChain(defer, {
      label: 'recovery-prelude-chain-verdict',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.BLOCKED, chainWithFirstStepAnswered()),
      recovery: true,
    })
    recordBlockedVerdictForInFlightStep(runtime)

    await runtime.startSession()

    assertStartupDidNotFail(runtime)
    assertOnlyFakeClaudeRan(runtime, fake, [])
    assert.equal(checkpointText(runtime), written)
    await runtime.shutdown()
    assert.deepEqual(autostartDispatchArguments(runtime, 'team-runtime.engine.handoff'), [[]])
    assert.equal(stageStatusInCheckpoint(runtime), STAGE_LIFECYCLE_STATUS.BLOCKED)
    assert.deepEqual(eventsNamed(runtime, 'run.completed'), [])
  })
})

test('a recovering chain restored FAILED is reopened to READY first and restarts from READY: its unanswered step resumes from one checkpoint saying READY', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, fake, written } = await bootInterruptedChain(defer, {
      label: 'recovery-prelude-chain-failed',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.FAILED, chainWithFirstStepAnswered()),
      recovery: true,
    })

    await runtime.startSession()

    assertOnlyFakeClaudeRan(runtime, fake, ['second'])
    assertRewrittenWithStageStatus(onlyLaunchCheckpoint(fake), written, STAGE_LIFECYCLE_STATUS.READY)
    await runtime.shutdown()
    assert.deepEqual(autostartDispatchArguments(runtime, 'team-runtime.engine.handoff'), [['action']])
    assert.equal(onlyEvent(runtime, 'run.completed').level_id, LEVEL_ID)
  })
})

test('a recovering chain whose stage needs no reopening resumes its unanswered step from the checkpoint the interrupted process left, unchanged', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, fake, written } = await bootInterruptedChain(defer, {
      label: 'recovery-prelude-chain-unchanged',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER, chainWithFirstStepAnswered()),
      recovery: true,
    })

    await runtime.startSession()

    assertOnlyFakeClaudeRan(runtime, fake, ['second'])
    assert.equal(onlyLaunchCheckpoint(fake), written)
    await runtime.shutdown()
    assert.deepEqual(autostartDispatchArguments(runtime, 'team-runtime.engine.handoff'), [['action']])
  })
})

test('a recovering chain level whose checkpoint holds no chain state yet starts the chain from its first step with no input', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, fake } = await bootInterruptedChain(defer, {
      label: 'recovery-prelude-chain-no-state',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.READY, null),
      recovery: true,
    })

    await runtime.startSession()

    assertStartupDidNotFail(runtime)
    assertOnlyFakeClaudeRan(runtime, fake, ['first', 'second'])
    await runtime.shutdown()
    assert.deepEqual(autostartDispatchArguments(runtime, 'team-runtime.engine.handoff'), [[]])
    assert.equal(onlyEvent(runtime, 'run.completed').level_id, LEVEL_ID)
  })
})

test('a recovering chain reads its in-flight step file after reopening a FAILED stage and before writing a checkpoint: an unreadable file fails the start, the checkpoint stays as written, and shutdown saves READY', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, fake, written } = await bootInterruptedChain(defer, {
      label: 'recovery-prelude-chain-unreadable-step',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.FAILED, chainWithFirstStepAnswered()),
      recovery: true,
    })
    // A directory where the step file belongs: it exists, and reading it throws.
    fs.mkdirSync(path.join(runtime.assignmentPath, IN_FLIGHT_STEP_FILE))

    await runtime.startSession()

    const startFailure = onlyEvent(runtime, 'runtime.host_start_failed')
    assert.ok(typeof startFailure.error === 'string')
    // The error code is stable across platforms; its message text is not.
    assert.match(startFailure.error, /^Error: EISDIR\b/)
    assert.deepEqual(eventsNamed(runtime, 'runtime.stage_autostart.begin'), [])
    assertOnlyFakeClaudeRan(runtime, fake, [])
    assert.equal(checkpointText(runtime), written, 'nothing was written before the read failed')
    await runtime.shutdown()
    assertRewrittenWithStageStatus(checkpointText(runtime), written, STAGE_LIFECYCLE_STATUS.READY)
  })
})

test('a chain restored without TEAM_RUNTIME_RECOVERY never reads its in-flight step file: an unreadable one does not stop the autostart', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, fake, written } = await bootInterruptedChain(defer, {
      label: 'recovery-prelude-chain-unread-step',
      levelState: interruptedLevel(STAGE_LIFECYCLE_STATUS.BLOCKED, chainWithFirstStepAnswered()),
      recovery: false,
    })
    fs.mkdirSync(path.join(runtime.assignmentPath, IN_FLIGHT_STEP_FILE))

    await runtime.startSession()

    assertStartupDidNotFail(runtime)
    assertSuccessfulEnd(runtime, 'chain', assertBegin(runtime, 'chain'))
    assertOnlyFakeClaudeRan(runtime, fake, [])
    assert.equal(checkpointText(runtime), written)
    await runtime.shutdown()
    assert.deepEqual(autostartDispatchArguments(runtime, 'team-runtime.engine.handoff'), [[]])
  })
})
