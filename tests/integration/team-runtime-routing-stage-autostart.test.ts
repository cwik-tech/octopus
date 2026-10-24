/**
 * What the Team Runtime records when it runs a routing stage's coordinator
 * itself.
 *
 * With `TEAM_DELEGATED_AUTOSTART=1`, `session_start` on a routing level logs
 * `runtime.stage_autostart.begin`, starts the run clock, marks the coordinator
 * active, makes one durable coordinator call, writes the reply as the level's
 * routing artifact, logs `runtime.stage_autostart.end` and tries to advance the
 * level. A rejection with an agent question writes `run.awaiting_agent_input`
 * and nothing else. Any other rejection marks the stage FAILED, logs an error
 * end and writes `run.failed`, unless the session is already shutting down, in
 * which case the end is marked cancelled and no failure is recorded.
 *
 * These boot the real `team-runtime/index.ts` on a fixture Team and read the
 * assignment's logs, checkpoint, artifacts and coordinator-call receipts. The
 * coordinators use the `claude` provider, and a fake `claude` executable first
 * on PATH answers every call. The agent-question tests also set
 * `PIPELINE_MCP_WORKER_TURN_URL`, so the call goes to a loopback worker-turn
 * endpoint in this process instead; the fake `claude` is still on PATH and each
 * of those tests checks that it was never launched.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import { parseMarkdownArtifact } from '../../domains/runtime/artifacts.js'
import { readCheckpoint, writeCheckpoint } from '../../domains/runtime/checkpoint.js'
import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import { readTeamChatMessages } from '../../domains/runtime/team-chat-messages.js'
import { durableCoordinatorCallReceiptPath } from '../../team-runtime/durable-coordinator-call.js'
import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  readAssignmentJsonl,
  type FixtureHost,
  type FixtureRuntime,
  type FixtureRuntimeOptions,
} from '../support/team-runtime-fixture-boot.js'

const LEVEL_ID = 'intake'
const NEXT_LEVEL_ID = 'next'
const TEAM_NAME = 'fixture-desk'
const TOOL_NAME = 'delegated_routing_autostart'
const ROUTING_ARTIFACT = 'routing-decision.md'
const COORDINATOR = { name: 'intake-agent', provider: 'claude', model: 'claude-haiku-4-5' }
const NEXT_COORDINATOR = { name: 'next-agent', provider: 'claude', model: 'claude-haiku-4-5' }
/** The model the fake `claude` reports. Its dashboard label is `routing-reply`. */
const REPLY_MODEL = 'claude-routing-reply'
const REPLY_COST_USD = 0.25
const REPLY_BODY = '# Routing decision\n\nSend the request to the writing team with a short brief.'
const NON_CLAUDE_PROVIDERS = ['codex', 'gemini', 'openai', 'anthropic', 'lm-studio']
/** The run start time a restored checkpoint carries. Only its equality is read. */
const RESTORED_START_TIME = Date.parse('2026-01-01T00:00:00.000Z')
/**
 * How long a held launch has to connect. Past it the test fails instead of
 * waiting forever, and its cleanups close the hold server so the file can exit.
 * It is well inside every test's own timeout.
 */
const HOLD_CONNECT_DEADLINE_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.ok(isRecord(parsed), `${filePath} holds a JSON object`)
  return parsed
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

// ── Fake `claude` ────────────────────────────────────────────────────────────

interface FakeClaudeOptions {
  /** Reply text by persona name. Personas without an entry get REPLY_BODY. */
  readonly replies?: Readonly<Record<string, string>>
  /**
   * Before answering, a launch for this persona connects to `holdPort` on
   * loopback and waits for a line. Every other persona answers at once.
   */
  readonly holdPersona?: string
  readonly holdPort?: number
  /** Exit with this code and stderr instead of answering. */
  readonly failure?: { readonly code: number; readonly stderr: string }
  /** Copied into the launch record at launch, when the file exists. */
  readonly checkpointPath?: string
}

interface FakeClaudeLaunch {
  readonly persona: string
  /** The script the launch ran, from its own `process.argv[1]`. */
  readonly script: string
  /** The checkpoint as it was on disk when the launch started, or null. */
  readonly checkpoint: Record<string, unknown> | null
  /** The `--system-prompt-file` contents. */
  readonly systemPrompt: string
  /** Everything the launch read from stdin. */
  readonly userMessage: string
}

interface FakeClaude {
  readonly env: Readonly<Record<string, string>>
  readonly scriptPath: string
  launches(): FakeClaudeLaunch[]
  remove(): void
}

function installFakeClaude(options: FakeClaudeOptions = {}): FakeClaude {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-autostart-claude-'))
  const scriptPath = path.join(binDir, 'claude')
  const launchLog = path.join(binDir, 'launches.jsonl')
  const settings = {
    replies: options.replies ?? {},
    defaultReply: REPLY_BODY,
    model: REPLY_MODEL,
    costUsd: REPLY_COST_USD,
    holdPersona: options.holdPersona ?? null,
    holdPort: options.holdPort ?? null,
    failure: options.failure ?? null,
    checkpointPath: options.checkpointPath ?? null,
  }
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs')
const settings = ${JSON.stringify(settings)}
const args = process.argv.slice(2)
const promptFileIndex = args.indexOf('--system-prompt-file')
const systemPrompt = promptFileIndex === -1 ? '' : fs.readFileSync(args[promptFileIndex + 1], 'utf8')
const persona = (systemPrompt.match(/^# ([a-z][a-z-]*)$/m) || [])[1] || 'unknown'
const checkpoint = settings.checkpointPath && fs.existsSync(settings.checkpointPath)
  ? JSON.parse(fs.readFileSync(settings.checkpointPath, 'utf8'))
  : null
function answer() {
  if (settings.failure) {
    process.stderr.write(settings.failure.stderr + '\\n', () => process.exit(settings.failure.code))
    return
  }
  const result = Object.prototype.hasOwnProperty.call(settings.replies, persona)
    ? settings.replies[persona]
    : settings.defaultReply
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    model: settings.model,
    usage: { input_tokens: 7, output_tokens: 5 },
    total_cost_usd: settings.costUsd,
  }) + '\\n', () => process.exit(0))
}
let userMessage = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { userMessage += chunk })
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ persona, script: process.argv[1], checkpoint, systemPrompt, userMessage }) + '\\n')
  if (settings.holdPort !== null && persona === settings.holdPersona) {
    const socket = require('node:net').connect(settings.holdPort, '127.0.0.1')
    socket.on('error', () => process.exit(1))
    socket.on('close', () => process.exit(0))
    socket.on('data', () => answer())
  } else {
    answer()
  }
})
`, { mode: 0o700 })
  return {
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    scriptPath,
    launches: () => {
      if (!fs.existsSync(launchLog)) return []
      return fs
        .readFileSync(launchLog, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parsed: unknown = JSON.parse(line)
          assert.ok(isRecord(parsed), 'a launch record is a JSON object')
          const { persona, script, checkpoint, systemPrompt, userMessage } = parsed
          assert.ok(typeof persona === 'string' && typeof script === 'string')
          assert.ok(checkpoint === null || isRecord(checkpoint))
          assert.ok(typeof systemPrompt === 'string' && typeof userMessage === 'string')
          return { persona, script, checkpoint, systemPrompt, userMessage }
        })
    },
    remove: () => fs.rmSync(binDir, { recursive: true, force: true }),
  }
}

/**
 * Every provider request the run logged was a launch of the fake `claude`, and
 * no other provider was asked for anything.
 */
function assertOnlyFakeClaudeAnswered(
  assignmentPath: string,
  fake: FakeClaude,
  expectedPersonas: readonly string[],
): void {
  const providerEvents = readAssignmentJsonl(assignmentPath, 'provider-events.jsonl')
  const otherProviders = providerEvents.filter((event) =>
    typeof event.provider === 'string' && NON_CLAUDE_PROVIDERS.includes(event.provider))
  assert.deepEqual(otherProviders, [], 'no provider other than the fake claude was asked for anything')
  const launches = fake.launches()
  assert.deepEqual(launches.map((launch) => launch.persona), expectedPersonas)
  for (const launch of launches) {
    assert.equal(launch.script, fake.scriptPath, 'the claude that ran is the fake one')
  }
  const claudeStarts = providerEvents.filter((event) =>
    event.provider === 'claude' && event.event === 'request.start')
  assert.equal(
    claudeStarts.length,
    launches.length,
    `every claude request the run logged is a fake launch; got ${JSON.stringify(providerEvents)}`,
  )
}

// ── Loopback hold ────────────────────────────────────────────────────────────

interface HoldServer {
  readonly port: number
  /**
   * Resolves when the held launch connects, which means the call is running.
   * Rejects when nothing connects within HOLD_CONNECT_DEADLINE_MS.
   */
  readonly connected: Promise<void>
  /** Lets the held launch answer. */
  release(): void
  /** Ends any held launch and stops listening. Safe to call more than once. */
  close(): Promise<void>
}

async function startHoldServer(): Promise<HoldServer> {
  const accepted: net.Socket[] = []
  const server = net.createServer((socket) => {
    accepted.push(socket)
    socket.on('error', () => {})
  })
  const connected = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`the held launch did not connect within ${HOLD_CONNECT_DEADLINE_MS} ms`))
    }, HOLD_CONNECT_DEADLINE_MS)
    server.once('connection', () => {
      clearTimeout(deadline)
      resolve()
    })
    server.once('close', () => clearTimeout(deadline))
  })
  // A test that fails before it awaits the connection must not leave an
  // unhandled rejection behind; awaiting `connected` still throws.
  void connected.catch(() => {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  let closing: Promise<void> | undefined
  return {
    port: address.port,
    connected,
    release: () => {
      const [socket] = accepted
      assert.ok(socket, 'the held launch connected')
      socket.write('go\n')
    },
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of accepted) socket.destroy()
        server.close(() => resolve())
      })
      return closing
    },
  }
}

/**
 * Close the hold server, which ends any launch still held, then wait for the
 * session start that launched it. A test that failed mid-hold would otherwise
 * remove the fixture root while that call is still writing into it.
 */
async function settleHeldSession(hold: HoldServer, sessionStarted: Promise<void> | undefined): Promise<void> {
  await hold.close()
  await sessionStarted
}

// ── Loopback worker turn ─────────────────────────────────────────────────────

interface WorkerTurnServer {
  readonly url: string
  /** Every request body the endpoint received, in order. */
  readonly requests: Array<Record<string, unknown>>
  close(): Promise<void>
}

/** Answers the n-th worker-turn request with `responses[n]`. */
async function startWorkerTurnServer(responses: readonly unknown[]): Promise<WorkerTurnServer> {
  const requests: Array<Record<string, unknown>> = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const answer = responses[requests.length]
      requests.push(isRecord(body) ? body : {})
      response.setHeader('content-type', 'application/json')
      if (answer === undefined) {
        response.statusCode = 500
        response.end(JSON.stringify({ error: 'no scripted answer', code: 'execution_failed', retryable: false }))
        return
      }
      response.end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/worker-turn`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

const WORKER_TURN_USAGE = { inputTokens: 3, outputTokens: 2, totalTokens: 5 }

function workerQuestion(interactionId: string): Record<string, unknown> {
  return {
    version: 6,
    kind: 'awaiting_input',
    model: 'worker-model',
    toolCallCount: 1,
    executedToolCallCount: 1,
    availableToolCount: 1,
    usage: WORKER_TURN_USAGE,
    interruption: { kind: 'awaiting_input', interactionId },
  }
}

function workerAnswer(text: string): Record<string, unknown> {
  return {
    version: 6,
    kind: 'completed',
    text,
    model: 'worker-model',
    usage: WORKER_TURN_USAGE,
    availableToolCount: 0,
    toolCallCount: 0,
    executedToolCallCount: 0,
  }
}

/**
 * The environment a worker turn needs. The worker-turn request refuses a
 * session id that is not a UUID, so the run's session directory is a UUID too.
 */
function workerTurnEnv(url: string, runtimeSessionId: string): Record<string, string> {
  return {
    PIPELINE_MCP_WORKER_TURN_URL: url,
    TEAM_RUNTIME_SESSION_ID: runtimeSessionId,
    TEAM_RUNTIME_WORKFLOW_ID: 'routing-workflow',
    TEAM_RUNTIME_WORKFLOW_STEP_ID: 'route',
  }
}

/** The assignment the runtime resolves when `TEAM_RUNTIME_SESSION_ID` is overridden. */
function assignmentPathFor(runtime: FixtureRuntime, runtimeSessionId: string): string {
  return path.join(
    runtime.workspace, 'sessions', runtimeSessionId, 'runs', runtime.runId, 'assignments', runtime.assignmentId,
  )
}

// ── Dashboard ────────────────────────────────────────────────────────────────

interface DashboardCapture {
  /** Every status-bar text the runtime set, in order. */
  readonly statuses: string[]
  /** The dashboard widget rendered now, with ANSI styling removed. */
  render(): string[]
}

const ANSI_STYLE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Record what the runtime puts in the host's status bar and widget area. */
function captureDashboard(host: FixtureHost): DashboardCapture {
  const context = host.extensionContext
  assert.ok(isRecord(context) && isRecord(context.ui), 'the fixture extension context has a ui')
  const ui = context.ui
  const statuses: string[] = []
  let widget: unknown
  ui.setStatus = (_key: unknown, text: unknown) => {
    if (typeof text === 'string') statuses.push(text)
  }
  ui.setWidget = (_key: unknown, factory: unknown) => {
    widget = factory
  }
  return {
    statuses,
    render: () => {
      assert.ok(typeof widget === 'function', 'the runtime has set its dashboard widget')
      const component: unknown = widget(undefined, { fg: (_color: string, text: string) => text })
      assert.ok(isRecord(component) && typeof component.render === 'function')
      const lines: unknown = component.render(240)
      assert.ok(Array.isArray(lines))
      return lines.map((line) => String(line).replace(ANSI_STYLE, ''))
    },
  }
}

const DISPLAY_NAMES = ['Intake Agent', 'Next Agent']

/**
 * One agent's card text, e.g. "✓ Intake Agent [routing-reply]  r:1 $0.25".
 *
 * Cards share a line, so the card runs from its status icon, just before the
 * name, to the status icon of the next card on the same line.
 */
function agentCard(lines: readonly string[], displayName: string): string {
  const matches = lines.filter((line) => line.includes(` ${displayName}`))
  assert.equal(matches.length, 1, `one card line for ${displayName}; got ${JSON.stringify(lines)}`)
  const [line] = matches
  assert.ok(line)
  const start = line.indexOf(` ${displayName}`) - 1
  const nextCardStarts = DISPLAY_NAMES
    .filter((name) => name !== displayName)
    .map((name) => line.indexOf(` ${name}`) - 1)
    .filter((index) => index > start)
  return line.slice(start, Math.min(line.length, ...nextCardStarts))
}

// ── Assignment reads ─────────────────────────────────────────────────────────

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

/** Index of the first record matching `predicate` in the runtime-events log. */
function positionOf(assignmentPath: string, predicate: (record: Record<string, unknown>) => boolean): number {
  const index = runtimeEvents(assignmentPath).findIndex(predicate)
  assert.ok(index >= 0, 'the record is in the runtime-events log')
  return index
}

/** The record with its timestamp checked and removed, so the rest compares whole. */
function withoutTimestamp(record: Record<string, unknown>): Record<string, unknown> {
  const { timestamp, ...fields } = record
  assert.equal(typeof timestamp, 'string')
  return fields
}

function autostartToolUseRows(assignmentPath: string): Array<Record<string, unknown>> {
  return readAssignmentJsonl(assignmentPath, ASSIGNMENT_LOG.toolUse)
    .filter((row) => row.runtime_autostart === true)
}

function stageStatusInCheckpoint(assignmentPath: string, levelId = LEVEL_ID): string | undefined {
  const checkpoint = readCheckpoint(assignmentPath)
  assert.ok(checkpoint, 'the run has a checkpoint')
  return checkpoint.levelStates.find((levelState) => levelState.levelId === levelId)?.stageStatus
}

function beginEvent(assignmentPath: string): Record<string, unknown> {
  return onlyEvent(assignmentPath, 'runtime.stage_autostart.begin')
}

/**
 * Check the one begin event field by field and return its call id. The id is
 * `runtime-autostart-<uuid>-delegated-routing`.
 */
function assertBegin(assignmentPath: string, sessionId: string): string {
  const begin = withoutTimestamp(beginEvent(assignmentPath))
  const toolCallId = begin.tool_call_id
  assert.ok(typeof toolCallId === 'string', `the begin event names its call; got ${JSON.stringify(begin)}`)
  assert.match(
    toolCallId,
    /^runtime-autostart-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-delegated-routing$/,
  )
  assert.deepEqual(begin, {
    event: 'runtime.stage_autostart.begin',
    session_id: sessionId,
    root_session_id: sessionId,
    level_id: LEVEL_ID,
    stage_type: 'routing',
    tool_name: TOOL_NAME,
    tool_call_id: toolCallId,
  })
  return toolCallId
}

function endIdentity(sessionId: string, toolCallId: string): Record<string, unknown> {
  return {
    event: 'runtime.stage_autostart.end',
    session_id: sessionId,
    root_session_id: sessionId,
    level_id: LEVEL_ID,
    stage_type: 'routing',
    tool_name: TOOL_NAME,
    tool_call_id: toolCallId,
  }
}

/**
 * Split the one end event's `error` off, check the rest, and return the error
 * text.
 */
function assertErrorEnd(
  assignmentPath: string,
  sessionId: string,
  toolCallId: string,
  outcome: { readonly isError: boolean; readonly cancelled: boolean },
): string {
  const { error, ...endFields } = withoutTimestamp(onlyEvent(assignmentPath, 'runtime.stage_autostart.end'))
  assert.ok(typeof error === 'string' && error.length > 0, `the end event carries the error; got ${JSON.stringify(error)}`)
  assert.deepEqual(endFields, {
    ...endIdentity(sessionId, toolCallId),
    is_error: outcome.isError,
    cancelled: outcome.cancelled,
  })
  assert.ok(
    positionOf(assignmentPath, (record) => record.event === 'runtime.stage_autostart.begin') <
      positionOf(assignmentPath, (record) => record.event === 'runtime.stage_autostart.end'),
    'the begin event is written before the end event',
  )
  return error
}

/**
 * Session start took the autostart as having started the stage: it queued no
 * stage entry for the host, reported no host-readiness failure, and the input
 * handler swallows user input. An autostart that declined would leave a
 * `claude` coordinator's host in config-error mode, because `claude` is not a
 * supported host provider.
 */
async function assertStageKeptFromHost(runtime: FixtureRuntime, assignmentPath: string): Promise<void> {
  assert.deepEqual(eventsNamed(assignmentPath, 'runtime.follow_up_enqueued'), [], 'no stage entry was queued for the host')
  assert.deepEqual(eventsNamed(assignmentPath, 'runtime.config_error'), [], 'the host was not preflighted for the stage')
  assert.deepEqual(
    await runtime.host.callHandler('input', { type: 'input', text: 'Fixture request.' }),
    { action: 'handled' },
  )
}

/** Invocation ids of every coordinator-call receipt in the assignment. */
function receiptInvocationIds(assignmentPath: string, anyInvocationId: string): string[] {
  const receiptDirectory = path.dirname(durableCoordinatorCallReceiptPath(assignmentPath, anyInvocationId))
  if (!fs.existsSync(receiptDirectory)) return []
  return fs
    .readdirSync(receiptDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJsonFile(path.join(receiptDirectory, name)).invocationId)
    .filter((invocationId): invocationId is string => typeof invocationId === 'string')
    .sort()
}

function readReceipt(assignmentPath: string, invocationId: string): Record<string, unknown> {
  return readJsonFile(durableCoordinatorCallReceiptPath(assignmentPath, invocationId))
}

function routingInvocationId(sessionId: string, visit: number, levelId = LEVEL_ID): string {
  return `${sessionId}:routing:${levelId}:visit:${visit}:decision`
}

/** The fixture assignment's checkpoint path; the assignment directory is created first. */
function checkpointPathFor(assignmentPath: string): string {
  fs.mkdirSync(assignmentPath, { recursive: true })
  return getRunRuntimePaths(assignmentPath).checkpointPath
}

/** A checkpoint for a run that is still on the routing level, as a restart finds it. */
function writeRestoredRoutingCheckpoint(
  runtime: FixtureRuntime,
  overrides: { readonly startTime: number; readonly visitCount?: number; readonly totalCost?: number },
): void {
  writeCheckpoint(runtime.assignmentPath, {
    sessionId: runtime.assignmentId,
    currentLevelIndex: 0,
    levelStates: new Map([[
      LEVEL_ID,
      {
        status: LEVEL_STATUS.ACTIVE,
        stageStatus: STAGE_LIFECYCLE_STATUS.READY,
        loopbackCount: 0,
        visitCount: overrides.visitCount ?? 0,
        engineState: null,
      },
    ]]),
    totalCost: overrides.totalCost ?? 0,
    startTime: overrides.startTime,
    timerStarted: overrides.startTime > 0,
    endTime: null,
    spawnDepth: 0,
  })
}

async function bootRouting(
  fake: FakeClaude,
  options: Omit<FixtureRuntimeOptions, 'startSession' | 'team' | 'delegatedAutostart'> & {
    readonly team?: FixtureRuntimeOptions['team']
  },
): Promise<FixtureRuntime> {
  return bootFixtureRuntime({
    ...options,
    team: options.team ?? { coordinator: COORDINATOR },
    delegatedAutostart: true,
    env: { ...options.env, ...fake.env },
    startSession: false,
  })
}

/**
 * A routing boot whose fake `claude` copies the run's checkpoint into its launch
 * record, which is what the checkpoint looked like when the coordinator was
 * called.
 */
async function bootRoutingRecordingCheckpoint(
  defer: Defer,
  label: string,
  fakeOptions: Omit<FakeClaudeOptions, 'checkpointPath'> = {},
): Promise<{ readonly runtime: FixtureRuntime; readonly fake: FakeClaude }> {
  const runtime = await bootFixtureRuntime({
    label,
    team: { coordinator: COORDINATOR },
    delegatedAutostart: true,
    startSession: false,
  })
  let fake: FakeClaude | undefined
  // One cleanup, so the runtime closes before the fake is removed.
  defer(async () => {
    await runtime.close()
    fake?.remove()
  })
  fake = installFakeClaude({ ...fakeOptions, checkpointPath: checkpointPathFor(runtime.assignmentPath) })
  // Set after the boot, so `close` restores the PATH the boot saved.
  Object.assign(process.env, fake.env)
  return { runtime, fake }
}

function replaceInTeamConfig(runtime: FixtureRuntime, from: string, to: string): void {
  const teamConfigPath = runtime.teamConfigPath
  assert.ok(teamConfigPath, 'a Team boot has a team.yaml')
  const text = fs.readFileSync(teamConfigPath, 'utf8')
  assert.ok(text.includes(from), `the fixture team.yaml contains ${JSON.stringify(from)}`)
  fs.writeFileSync(teamConfigPath, text.replace(from, to))
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('a delegated routing autostart logs one begin and one successful end under one call id, writes no runtime-autostart tool-use row, and keeps the stage from the host', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const fake = installFakeClaude()
    defer(() => fake.remove())
    const runtime = await bootRouting(fake, { label: 'routing-autostart-events' })
    defer(() => runtime.close())
    await runtime.startSession()

    const toolCallId = assertBegin(runtime.assignmentPath, runtime.assignmentId)
    assert.deepEqual(
      withoutTimestamp(onlyEvent(runtime.assignmentPath, 'runtime.stage_autostart.end')),
      {
        ...endIdentity(runtime.assignmentId, toolCallId),
        output_artifact: ROUTING_ARTIFACT,
        is_error: false,
      },
    )
    assert.ok(
      positionOf(runtime.assignmentPath, (record) => record.event === 'runtime.stage_autostart.begin') <
        positionOf(runtime.assignmentPath, (record) => record.event === 'runtime.stage_autostart.end'),
      'the begin event is written before the end event',
    )
    assert.deepEqual(autostartToolUseRows(runtime.assignmentPath), [], 'routing autostart writes no tool-use row')
    assert.deepEqual(eventsNamed(runtime.assignmentPath, 'run.failed'), [])
    await assertStageKeptFromHost(runtime, runtime.assignmentPath)
    assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
  })
})

test('the coordinator is asked with its persona prompt followed by the routing plan, and with the delegated request as its message', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const fake = installFakeClaude()
    defer(() => fake.remove())
    const runtime = await bootRouting(fake, {
      label: 'routing-prompt',
      env: { TEAM_INPUT_ARTIFACT: 'incoming-brief.md' },
    })
    defer(() => runtime.close())
    fs.mkdirSync(runtime.assignmentPath, { recursive: true })
    fs.writeFileSync(
      path.join(runtime.assignmentPath, 'incoming-brief.md'),
      'USER: Draft a dedication for my grandparents.\n\nASSISTANT: Which tone should it take?',
    )

    await runtime.startSession()

    const [launch] = fake.launches()
    assert.ok(launch, 'the coordinator was called')
    const personaHeading = launch.systemPrompt.indexOf(`# ${COORDINATOR.name}`)
    const planOpening = launch.systemPrompt.indexOf(
      'You produce a routing and clarification artifact for an already-started workflow step.',
    )
    assert.ok(personaHeading >= 0, 'the system prompt carries the coordinator persona')
    assert.ok(planOpening > personaHeading, 'the routing plan follows the persona prompt')
    assert.match(launch.systemPrompt, /Do not ask the user questions, call tools, spawn teams, or wait for approval\./)
    assert.match(launch.userMessage, /^# Delegated request\n\nDraft a dedication for my grandparents\.\n/)
    assert.doesNotMatch(launch.userMessage, /Which tone should it take\?/)
    assert.match(launch.userMessage, /# Available specialist teams\n\n- None registered\n/)
    assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
  })
})

test('a routing autostart starts the run clock before the coordinator call only when the clock has not started', {
  timeout: 120_000,
}, async (t) => {
  await t.test('a fresh run has a started clock on disk when the coordinator is called', async () => {
    await withCleanup(async (defer) => {
      const { runtime, fake } = await bootRoutingRecordingCheckpoint(defer, 'routing-clock-fresh')
      assert.equal(readCheckpoint(runtime.assignmentPath), null, 'precondition: no checkpoint to restore a clock from')

      await runtime.startSession()

      const [launch] = fake.launches()
      assert.ok(launch?.checkpoint, 'the coordinator was called with a checkpoint on disk')
      // The launch record holds the checkpoint as persisted when the call
      // started. Session start set the clock to 0, and the runtime reads a
      // start time above 0 as a started clock. The run completes during this
      // session start and deletes its checkpoint, so no later copy exists.
      const startTime = launch.checkpoint.startTime
      assert.ok(typeof startTime === 'number' && startTime > 0, `the clock had started when the coordinator was called; got ${String(startTime)}`)
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })

  await t.test('a restored run keeps the start time it restored', async () => {
    await withCleanup(async (defer) => {
      const { runtime, fake } = await bootRoutingRecordingCheckpoint(defer, 'routing-clock-restored')
      writeRestoredRoutingCheckpoint(runtime, { startTime: RESTORED_START_TIME })

      await runtime.startSession()

      assert.equal(onlyEvent(runtime.assignmentPath, 'run.resumed_from_checkpoint').checkpoint_level_index, 0)
      const [launch] = fake.launches()
      assert.ok(launch?.checkpoint, 'the coordinator was called with a checkpoint on disk')
      assert.equal(launch.checkpoint.startTime, RESTORED_START_TIME, 'the started clock was not restarted')
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })
})

test('the coordinator call is recorded under <session>:routing:<level>:visit:<visit>:decision', {
  timeout: 120_000,
}, async (t) => {
  await t.test('a first visit is visit 0', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude()
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, { label: 'routing-invocation-fresh' })
      defer(() => runtime.close())
      await runtime.startSession()

      const invocationId = routingInvocationId(runtime.assignmentId, 0)
      assert.deepEqual(receiptInvocationIds(runtime.assignmentPath, invocationId), [invocationId])
      assert.equal(readReceipt(runtime.assignmentPath, invocationId).phase, 'completed')
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })

  await t.test('a restored level carries its recorded visit count', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude()
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, { label: 'routing-invocation-visit' })
      defer(() => runtime.close())
      writeRestoredRoutingCheckpoint(runtime, { startTime: RESTORED_START_TIME, visitCount: 3 })

      await runtime.startSession()

      const invocationId = routingInvocationId(runtime.assignmentId, 3)
      assert.deepEqual(receiptInvocationIds(runtime.assignmentPath, invocationId), [invocationId])
      assert.equal(readReceipt(runtime.assignmentPath, invocationId).phase, 'completed')
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })
})

test('the routing artifact holds the reply body without the reply frontmatter, under runtime metadata that names a parent session only when one is set', {
  timeout: 120_000,
}, async (t) => {
  const reply = `---\nstatus: draft\ntitle: Reply title\n---\n\n${REPLY_BODY}\n\n`

  function expectedMetadata(runtime: FixtureRuntime): Record<string, string> {
    return {
      artifact_type: 'result',
      artifact_role: 'final',
      schema_version: '1',
      filename: ROUTING_ARTIFACT,
      path: ROUTING_ARTIFACT,
      session_id: runtime.assignmentId,
      root_session_id: runtime.assignmentId,
      team: TEAM_NAME,
      agent: COORDINATOR.name,
      level: LEVEL_ID,
      stage_type: 'routing',
      status: 'completed',
      title: 'Routing decision',
    }
  }

  function readRoutingArtifact(runtime: FixtureRuntime): { metadata: Record<string, string>; body: string } {
    const artifactPath = path.join(runtime.assignmentPath, ROUTING_ARTIFACT)
    assert.ok(fs.existsSync(artifactPath), 'the routing artifact is written into the assignment')
    const parsed = parseMarkdownArtifact(fs.readFileSync(artifactPath, 'utf8'))
    assert.equal(parsed.hasFrontmatter, true)
    const { created_at: createdAt, ...metadata } = parsed.metadata
    assert.ok(typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)), 'created_at is a timestamp')
    return { metadata, body: parsed.body }
  }

  await t.test('without a parent session', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude({ replies: { [COORDINATOR.name]: reply } })
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, { label: 'routing-artifact-root' })
      defer(() => runtime.close())
      await runtime.startSession()

      const artifact = readRoutingArtifact(runtime)
      assert.deepEqual(artifact.metadata, expectedMetadata(runtime))
      assert.equal(artifact.body, `${REPLY_BODY}\n`)
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })

  await t.test('with a parent session', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude({ replies: { [COORDINATOR.name]: reply } })
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, {
        label: 'routing-artifact-child',
        env: { TEAM_PARENT_SESSION_ID: 'parent-session-fixture' },
      })
      defer(() => runtime.close())
      await runtime.startSession()

      const artifact = readRoutingArtifact(runtime)
      assert.deepEqual(artifact.metadata, {
        ...expectedMetadata(runtime),
        parent_session_id: 'parent-session-fixture',
      })
      assert.equal(artifact.body, `${REPLY_BODY}\n`)
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })
})

test('a team chat run publishes the routing decision as one team chat message, and any other run publishes none', {
  timeout: 120_000,
}, async (t) => {
  await t.test('TEAM_CHAT_MODE=1', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude()
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, { label: 'routing-chat-on', env: { TEAM_CHAT_MODE: '1' } })
      defer(() => runtime.close())
      await runtime.startSession()

      const messages = readTeamChatMessages(runtime.assignmentPath)
      assert.equal(messages.length, 1, `one team chat message; got ${JSON.stringify(messages)}`)
      const [message] = messages
      assert.ok(message)
      assert.equal(message.agent_name, COORDINATOR.name)
      assert.equal(message.dispatch_id, routingInvocationId(runtime.assignmentId, 0))
      assert.equal(message.run_id, runtime.assignmentId)
      assert.equal(message.stage_id, LEVEL_ID)
      assert.equal(message.message_type, 'position')
      assert.equal(message.text, REPLY_BODY)
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })

  await t.test('TEAM_CHAT_MODE unset', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude()
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, { label: 'routing-chat-off' })
      defer(() => runtime.close())
      await runtime.startSession()

      assert.ok(fs.existsSync(path.join(runtime.assignmentPath, ROUTING_ARTIFACT)), 'precondition: the routing decision was written')
      assert.deepEqual(readTeamChatMessages(runtime.assignmentPath), [])
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })
})

test('the level advances only after the end event: the next level is armed and autostarted after it', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const fake = installFakeClaude()
    defer(() => fake.remove())
    const runtime = await bootRouting(fake, {
      label: 'routing-advance',
      team: { coordinator: COORDINATOR, laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR }] },
    })
    defer(() => runtime.close())
    await runtime.startSession()

    const intakeEnd = positionOf(runtime.assignmentPath, (record) =>
      record.event === 'runtime.stage_autostart.end' && record.level_id === LEVEL_ID)
    const nextRegistration = positionOf(runtime.assignmentPath, (record) =>
      record.event === 'tools.registered' && record.level_id === NEXT_LEVEL_ID)
    const nextBegin = positionOf(runtime.assignmentPath, (record) =>
      record.event === 'runtime.stage_autostart.begin' && record.level_id === NEXT_LEVEL_ID)
    assert.ok(intakeEnd < nextRegistration, 'the next level is armed after the intake end event')
    assert.ok(nextRegistration < nextBegin, 'the next level starts after it is armed')
    const intakeEndRecord = runtimeEvents(runtime.assignmentPath)[intakeEnd]
    assert.equal(intakeEndRecord?.is_error, false)
    assert.ok(fs.existsSync(path.join(runtime.assignmentPath, `${NEXT_LEVEL_ID}-result.md`)), 'the next level wrote its own decision')
    assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name, NEXT_COORDINATOR.name])
  })
})

test('the dashboard shows the coordinator active during its call, then done with one round, the call cost and the reply model', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    // The next level's call is held open. The advance into it has already set
    // the dashboard widget, and the widget renders the live metrics.
    const hold = await startHoldServer()
    defer(() => hold.close())
    const fake = installFakeClaude({ holdPersona: NEXT_COORDINATOR.name, holdPort: hold.port })
    defer(() => fake.remove())
    const runtime = await bootRouting(fake, {
      label: 'routing-metrics',
      team: { coordinator: COORDINATOR, laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR }] },
    })
    defer(() => runtime.close())
    const dashboard = captureDashboard(runtime.host)
    let sessionStarted: Promise<void> | undefined
    defer(() => settleHeldSession(hold, sessionStarted))
    sessionStarted = runtime.startSession()
    await hold.connected

    const during = dashboard.render()
    const nextDuring = agentCard(during, 'Next Agent')
    assert.match(nextDuring, /ACTIVE/, `the coordinator in its call is active; got ${nextDuring}`)
    assert.match(nextDuring, /\[haiku-4-5\]/, 'before its reply the card names the persona model')
    const intakeDone = agentCard(during, 'Intake Agent')
    assert.doesNotMatch(intakeDone, /ACTIVE/)
    assert.match(intakeDone, /✓/, `a coordinator whose call finished is done; got ${intakeDone}`)
    assert.match(intakeDone, /r:1/, 'one round')
    assert.match(intakeDone, /\$0\.25/, 'the call cost')
    assert.match(intakeDone, /\[routing-reply\]/, 'the model the reply reported')

    hold.release()
    await sessionStarted

    const nextDone = agentCard(dashboard.render(), 'Next Agent')
    assert.doesNotMatch(nextDone, /ACTIVE/)
    assert.match(nextDone, /✓/)
    assert.match(nextDone, /r:1/)
    assert.match(nextDone, /\$0\.25/)
    assert.match(nextDone, /\[routing-reply\]/)
    assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name, NEXT_COORDINATOR.name])
  })
})

test('a routing autostart whose coordinator call fails marks the stage failed, logs an error end, then one run.failed with the same error, and keeps the stage from the host', {
  timeout: 120_000,
}, async (t) => {
  async function assertFailedAutostart(
    runtime: FixtureRuntime,
    dashboard: DashboardCapture,
    expectedError: RegExp,
  ): Promise<void> {
    const toolCallId = assertBegin(runtime.assignmentPath, runtime.assignmentId)
    const error = assertErrorEnd(runtime.assignmentPath, runtime.assignmentId, toolCallId, { isError: true, cancelled: false })
    assert.match(error, expectedError)
    assert.match(error, /\n {4}at /, 'the error text is the stack, not only the message')

    assert.deepEqual(withoutTimestamp(onlyEvent(runtime.assignmentPath, 'run.failed')), {
      event: 'run.failed',
      session_id: runtime.assignmentId,
      root_session_id: runtime.assignmentId,
      assignment_path: runtime.assignmentPath,
      team: TEAM_NAME,
      level_id: LEVEL_ID,
      stage_type: 'routing',
      error,
    })
    assert.ok(
      positionOf(runtime.assignmentPath, (record) => record.event === 'runtime.stage_autostart.end') <
        positionOf(runtime.assignmentPath, (record) => record.event === 'run.failed'),
      'run.failed is written after the end event',
    )
    // Read before shutdown: only the failure arm has persisted since the call
    // started.
    assert.equal(stageStatusInCheckpoint(runtime.assignmentPath), STAGE_LIFECYCLE_STATUS.FAILED)
    assert.equal(fs.existsSync(path.join(runtime.assignmentPath, ROUTING_ARTIFACT)), false, 'no routing artifact')
    assert.deepEqual(autostartToolUseRows(runtime.assignmentPath), [])

    const card = agentCard(dashboard.render(), 'Intake Agent')
    assert.match(card, /✗1/, `the coordinator card counts one failure; got ${card}`)
    assert.doesNotMatch(card, /ACTIVE/)
    assert.match(dashboard.statuses.at(-1) ?? '', /1 error/)

    // The failure arm reports the stage as started.
    await assertStageKeptFromHost(runtime, runtime.assignmentPath)

    await runtime.shutdown()
    assert.deepEqual(eventsNamed(runtime.assignmentPath, 'run.incomplete'), [], 'the failure is the run terminal')
    assert.deepEqual(eventsNamed(runtime.assignmentPath, 'run.completed'), [])
    assert.equal(eventsNamed(runtime.assignmentPath, 'run.failed').length, 1)
  }

  await t.test('the coordinator reply has an empty body', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude({ replies: { [COORDINATOR.name]: '---\nstatus: draft\n---\n' } })
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, { label: 'routing-failure-empty' })
      defer(() => runtime.close())
      const dashboard = captureDashboard(runtime.host)
      await runtime.startSession()

      await assertFailedAutostart(runtime, dashboard, /Delegated routing coordinator returned an empty artifact\./)
      const invocationId = routingInvocationId(runtime.assignmentId, 0)
      assert.equal(readReceipt(runtime.assignmentPath, invocationId).phase, 'rejected')
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })

  await t.test('the coordinator CLI fails', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude({ failure: { code: 1, stderr: 'fixture coordinator refused the call' } })
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, { label: 'routing-failure-cli' })
      defer(() => runtime.close())
      const dashboard = captureDashboard(runtime.host)
      await runtime.startSession()

      await assertFailedAutostart(runtime, dashboard, /fixture coordinator refused the call/)
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
    })
  })

  await t.test('the Team budget refuses the call before the coordinator is reached', async () => {
    await withCleanup(async (defer) => {
      const fake = installFakeClaude()
      defer(() => fake.remove())
      const runtime = await bootRouting(fake, {
        label: 'routing-failure-budget',
        env: { TEAM_BUDGET_CAP: '1', TEAM_BUDGET_POLICY: 'halt' },
      })
      defer(() => runtime.close())
      const dashboard = captureDashboard(runtime.host)
      // A restored run that has already spent more than its cap.
      writeRestoredRoutingCheckpoint(runtime, { startTime: RESTORED_START_TIME, totalCost: 5 })

      await runtime.startSession()

      await assertFailedAutostart(runtime, dashboard, /^DirectAgentBudgetRefusedError: The Team budget is exhausted/)
      assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [])
    })
  })
})

test('a coordinator reply that takes the run past a halt budget cap is written as the decision, then fails the stage with the budget error', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const fake = installFakeClaude()
    defer(() => fake.remove())
    const runtime = await bootRouting(fake, {
      label: 'routing-budget-overrun',
      env: { TEAM_BUDGET_CAP: '0.2', TEAM_BUDGET_POLICY: 'halt' },
    })
    defer(() => runtime.close())
    const dashboard = captureDashboard(runtime.host)
    await runtime.startSession()

    const toolCallId = assertBegin(runtime.assignmentPath, runtime.assignmentId)
    const error = assertErrorEnd(runtime.assignmentPath, runtime.assignmentId, toolCallId, { isError: true, cancelled: false })
    assert.match(error, /^BudgetExceededError: Budget exceeded: \$0\.25 >= \$0\.20 \(policy: halt\)\n/)
    assert.equal(onlyEvent(runtime.assignmentPath, 'run.failed').error, error)
    assert.equal(stageStatusInCheckpoint(runtime.assignmentPath), STAGE_LIFECYCLE_STATUS.FAILED)
    const checkpoint = readCheckpoint(runtime.assignmentPath)
    assert.equal(checkpoint?.totalCost, REPLY_COST_USD, 'the call cost is in the run total')

    // The decision was written before the cap was checked.
    const artifact = parseMarkdownArtifact(fs.readFileSync(path.join(runtime.assignmentPath, ROUTING_ARTIFACT), 'utf8'))
    assert.equal(artifact.body, `${REPLY_BODY}\n`)

    // The coordinator is counted as failed, not done: no round, and the card
    // still names the persona model.
    const card = agentCard(dashboard.render(), 'Intake Agent')
    assert.match(card, /✗1/, `the coordinator card counts one failure; got ${card}`)
    assert.doesNotMatch(card, /r:1/)
    assert.match(card, /\[haiku-4-5\]/)
    assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
  })
})

test('a session shut down during the coordinator call ends the autostart as cancelled and records no failure', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const hold = await startHoldServer()
    defer(() => hold.close())
    const { runtime, fake } = await bootRoutingRecordingCheckpoint(defer, 'routing-cancelled', {
      holdPersona: COORDINATOR.name,
      holdPort: hold.port,
    })
    const dashboard = captureDashboard(runtime.host)
    let sessionStarted: Promise<void> | undefined
    defer(() => settleHeldSession(hold, sessionStarted))
    sessionStarted = runtime.startSession()
    await hold.connected
    await runtime.shutdown()
    await sessionStarted

    const toolCallId = assertBegin(runtime.assignmentPath, runtime.assignmentId)
    assertErrorEnd(runtime.assignmentPath, runtime.assignmentId, toolCallId, { isError: false, cancelled: true })
    assert.deepEqual(eventsNamed(runtime.assignmentPath, 'run.failed'), [])
    assert.deepEqual(eventsNamed(runtime.assignmentPath, 'run.completed'), [])
    assert.equal(onlyEvent(runtime.assignmentPath, 'run.incomplete').reason, 'session_shutdown')

    // The stage is left as it was when the call started.
    const [launch] = fake.launches()
    assert.ok(launch?.checkpoint, 'the coordinator was called with a checkpoint on disk')
    const levelStates = launch.checkpoint.levelStates
    assert.ok(Array.isArray(levelStates))
    const stageAtCall: unknown = levelStates
      .filter(isRecord)
      .find((levelState) => levelState.levelId === LEVEL_ID)?.stageStatus
    assert.equal(typeof stageAtCall, 'string')
    assert.notEqual(stageAtCall, STAGE_LIFECYCLE_STATUS.FAILED)
    assert.equal(stageStatusInCheckpoint(runtime.assignmentPath), stageAtCall)

    // No failure is counted, and the coordinator is not marked done or failed.
    const card = agentCard(dashboard.render(), 'Intake Agent')
    assert.doesNotMatch(card, /✗1/)
    assert.match(card, /ACTIVE/, `a cancelled call leaves the coordinator as it was during the call; got ${card}`)
    // The cancelled arm reports the stage as started.
    await assertStageKeptFromHost(runtime, runtime.assignmentPath)
    assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
  })
})

test('a coordinator that asks a question suspends the run: run.awaiting_agent_input, and no end event, no artifact, no run.failed and no run.incomplete', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const worker = await startWorkerTurnServer([workerQuestion('question-1')])
    defer(() => worker.close())
    const runtimeSessionId = randomUUID()
    const fake = installFakeClaude()
    defer(() => fake.remove())
    const runtime = await bootRouting(fake, {
      label: 'routing-question',
      env: workerTurnEnv(worker.url, runtimeSessionId),
    })
    defer(() => runtime.close())
    const assignmentPath = assignmentPathFor(runtime, runtimeSessionId)
    await runtime.startSession()

    assert.equal(worker.requests.length, 1, 'the coordinator call went to the worker-turn endpoint once')
    // A coordinator that can ask managed questions is asked with a question
    // context and the managed-question plan.
    const invocationId = routingInvocationId(runtime.assignmentId, 0)
    const [asked] = worker.requests
    assert.ok(asked)
    assert.deepEqual(asked.questionContext, {
      logicalInvocationId: invocationId,
      dispatchId: invocationId,
      teamId: TEAM_NAME,
      stageId: LEVEL_ID,
    })
    assert.ok(typeof asked.systemPrompt === 'string')
    assert.match(asked.systemPrompt, /Use the managed question tool only for necessary missing facts\./)
    assertBegin(assignmentPath, runtime.assignmentId)
    assert.deepEqual(withoutTimestamp(onlyEvent(assignmentPath, 'run.awaiting_agent_input')), {
      event: 'run.awaiting_agent_input',
      session_id: runtime.assignmentId,
      root_session_id: runtime.assignmentId,
      level_id: LEVEL_ID,
      interruption: { kind: 'awaiting_input', interactionId: 'question-1' },
    })
    assert.deepEqual(eventsNamed(assignmentPath, 'runtime.stage_autostart.end'), [])
    assert.deepEqual(eventsNamed(assignmentPath, 'run.failed'), [])
    assert.equal(fs.existsSync(path.join(assignmentPath, ROUTING_ARTIFACT)), false)
    const checkpoint = readCheckpoint(assignmentPath)
    assert.ok(checkpoint)
    assert.equal(typeof checkpoint.questionPausedAt, 'number', 'the question pause is persisted')
    assert.notEqual(stageStatusInCheckpoint(assignmentPath), STAGE_LIFECYCLE_STATUS.FAILED)
    // A suspension reports the stage as started.
    await assertStageKeptFromHost(runtime, assignmentPath)

    await runtime.shutdown()
    assert.deepEqual(eventsNamed(assignmentPath, 'run.incomplete'), [], 'a run waiting for an answer is not incomplete')
    assert.deepEqual(eventsNamed(assignmentPath, 'run.failed'), [])
    assert.deepEqual(eventsNamed(assignmentPath, 'run.completed'), [])
    assert.deepEqual(readAssignmentJsonl(assignmentPath, 'provider-events.jsonl'), [], 'no provider ran in this process')
    assert.deepEqual(fake.launches(), [], 'the fake claude was never launched')
  })
})

test('a restarted run replays a stored question unless it is recovering; a recovering run with managed questions resumes it in its own slot', {
  timeout: 120_000,
}, async (t) => {
  const answerText = '# Routing decision\n\nThe dedication is for the grandparents; route to the writing team.'

  /** Boot, suspend on a question, then run session_start again under `restartEnv`. */
  async function restartAfterQuestion(defer: Defer, label: string, restartEnv: Record<string, string>) {
    const worker = await startWorkerTurnServer([workerQuestion('question-1'), workerAnswer(answerText)])
    defer(() => worker.close())
    const runtimeSessionId = randomUUID()
    const fake = installFakeClaude()
    defer(() => fake.remove())
    const runtime = await bootRouting(fake, { label, env: workerTurnEnv(worker.url, runtimeSessionId) })
    defer(() => runtime.close())
    const assignmentPath = assignmentPathFor(runtime, runtimeSessionId)
    await runtime.startSession()
    assert.equal(onlyEvent(assignmentPath, 'run.awaiting_agent_input').level_id, LEVEL_ID, 'precondition: the first start suspended')
    Object.assign(process.env, restartEnv)
    await runtime.startSession()
    return { worker, fake, runtime, assignmentPath }
  }

  await t.test('TEAM_RUNTIME_RECOVERY=1 resumes the answer under <invocation>:answer:<interaction>', async () => {
    await withCleanup(async (defer) => {
      const { worker, fake, runtime, assignmentPath } = await restartAfterQuestion(defer, 'routing-question-recovered', {
        TEAM_RUNTIME_RECOVERY: '1',
      })
      const invocationId = routingInvocationId(runtime.assignmentId, 0)
      const answerInvocationId = `${invocationId}:answer:question-1`
      assert.equal(worker.requests.length, 2, 'the answer is one new turn')
      const [, resumed] = worker.requests
      assert.ok(resumed && isRecord(resumed.questionContext))
      assert.equal(resumed.questionContext.logicalInvocationId, invocationId)
      assert.equal(resumed.questionContext.dispatchId, invocationId)
      assert.deepEqual(receiptInvocationIds(assignmentPath, invocationId), [invocationId, answerInvocationId].sort())
      assert.equal(readReceipt(assignmentPath, answerInvocationId).phase, 'completed')

      const ends = eventsNamed(assignmentPath, 'runtime.stage_autostart.end')
      assert.equal(ends.length, 1)
      assert.equal(ends[0]?.is_error, false)
      const artifact = parseMarkdownArtifact(fs.readFileSync(path.join(assignmentPath, ROUTING_ARTIFACT), 'utf8'))
      assert.equal(artifact.body, `${answerText}\n`)
      assert.deepEqual(readAssignmentJsonl(assignmentPath, 'provider-events.jsonl'), [], 'no provider ran in this process')
      assert.deepEqual(fake.launches(), [], 'the fake claude was never launched')
    })
  })

  await t.test('without TEAM_RUNTIME_RECOVERY the stored question suspends the run again', async () => {
    await withCleanup(async (defer) => {
      const { worker, fake, runtime, assignmentPath } = await restartAfterQuestion(defer, 'routing-question-replayed', {})
      const invocationId = routingInvocationId(runtime.assignmentId, 0)
      assert.equal(worker.requests.length, 1, 'no new turn was bought')
      assert.deepEqual(receiptInvocationIds(assignmentPath, invocationId), [invocationId])
      const suspensions = eventsNamed(assignmentPath, 'run.awaiting_agent_input')
      assert.equal(suspensions.length, 2)
      assert.deepEqual(suspensions[1]?.interruption, { kind: 'awaiting_input', interactionId: 'question-1' })
      assert.deepEqual(eventsNamed(assignmentPath, 'runtime.stage_autostart.end'), [])
      assert.equal(fs.existsSync(path.join(assignmentPath, ROUTING_ARTIFACT)), false)
      assert.deepEqual(readAssignmentJsonl(assignmentPath, 'provider-events.jsonl'), [], 'no provider ran in this process')
      assert.deepEqual(fake.launches(), [], 'the fake claude was never launched')
    })
  })
})

test('an output artifact outside the assignment is refused before the begin event, without calling the coordinator', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const fake = installFakeClaude()
    defer(() => fake.remove())
    // The entry level is not the terminal level, so its own configured output,
    // `<path>/<format>`, is the artifact the routing plan writes.
    const runtime = await bootRouting(fake, {
      label: 'routing-outside-output',
      team: { coordinator: COORDINATOR, laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR }] },
    })
    defer(() => runtime.close())
    replaceInTeamConfig(
      runtime,
      `          format: ${ROUTING_ARTIFACT}\n`,
      `          format: ${ROUTING_ARTIFACT}\n          path: ..\n`,
    )

    await runtime.startSession()

    const failure = onlyEvent(runtime.assignmentPath, 'runtime.host_start_failed')
    assert.ok(typeof failure.error === 'string')
    assert.match(
      failure.error,
      /^Error: Delegated routing output must stay inside the assignment: \.\.\/routing-decision\.md\n/,
    )
    assert.deepEqual(eventsNamed(runtime.assignmentPath, 'runtime.stage_autostart.begin'), [])
    assert.deepEqual(eventsNamed(runtime.assignmentPath, 'runtime.stage_autostart.end'), [])
    assert.equal(fs.existsSync(path.join(path.dirname(runtime.assignmentPath), ROUTING_ARTIFACT)), false)
    assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [])
  })
})

test('an autostart that finishes after a later session_start changed the session ids records the ids in effect when it finishes', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const hold = await startHoldServer()
    defer(() => hold.close())
    const fake = installFakeClaude({ holdPersona: COORDINATOR.name, holdPort: hold.port })
    defer(() => fake.remove())
    const runtime = await bootRouting(fake, { label: 'routing-late-ids' })
    defer(() => runtime.close())
    let firstSession: Promise<void> | undefined
    defer(() => settleHeldSession(hold, firstSession))
    firstSession = runtime.startSession()
    await hold.connected
    const begin = beginEvent(runtime.assignmentPath)
    assert.equal(begin.session_id, runtime.assignmentId)
    const firstCallId = begin.tool_call_id

    // The second session_start takes the new ids, finds the checkpoint was
    // written under the old ones, and returns without starting another
    // autostart.
    process.env.TEAM_SESSION_ID = 'session-after-restart'
    process.env.TEAM_ROOT_SESSION_ID = 'root-after-restart'
    process.env.TEAM_PARENT_SESSION_ID = 'parent-after-restart'
    await runtime.startSession()
    const rejected = onlyEvent(runtime.assignmentPath, 'checkpoint.rejected')
    assert.equal(rejected.session_id, 'session-after-restart')

    hold.release()
    await firstSession

    const end = eventsNamed(runtime.assignmentPath, 'runtime.stage_autostart.end')
      .find((event) => event.tool_call_id === firstCallId)
    assert.ok(end, 'the first autostart wrote its end event')
    assert.equal(end.session_id, 'session-after-restart')
    assert.equal(end.root_session_id, 'root-after-restart')
    assert.equal(end.is_error, false)

    const artifact = parseMarkdownArtifact(fs.readFileSync(path.join(runtime.assignmentPath, ROUTING_ARTIFACT), 'utf8'))
    assert.equal(artifact.metadata.session_id, 'session-after-restart')
    assert.equal(artifact.metadata.root_session_id, 'root-after-restart')
    assert.equal(artifact.metadata.parent_session_id, 'parent-after-restart')

    // The call itself was keyed before it started, under the first ids.
    const invocationId = routingInvocationId(runtime.assignmentId, 0)
    assert.deepEqual(receiptInvocationIds(runtime.assignmentPath, invocationId), [invocationId])
    assertOnlyFakeClaudeAnswered(runtime.assignmentPath, fake, [COORDINATOR.name])
  })
})
