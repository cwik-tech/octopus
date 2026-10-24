/**
 * What one call from the Team Runtime to a discussion lead does, and what the
 * discussion autostart does around those calls.
 *
 * With `TEAM_DELEGATED_AUTOSTART=1` a discussion level asks its lead for a
 * roster (`delegated_discussion_plan`) and, in a Team chat, for a decision
 * after each specialist pass (`delegated_discussion_decision`). Each of those
 * calls logs a start and an end or failure for the lead, buys the reply through
 * a durable coordinator slot, adds its cost to the run, and buys a refused reply
 * again with the reason appended to the prompt until the slot's attempt budget
 * is spent.
 *
 * The pass-loop tests cover the rest of that autostart: the roster it locks
 * and announces, the specialist passes and lead decisions it alternates, the
 * artifact and stage status it ends with, the restored states it resumes or
 * refuses, and the records its failure arm writes.
 *
 * These boot the real `team-runtime/index.ts` on a fixture Team whose lead and
 * member use the `claude` provider, and a fake `claude` executable first on
 * PATH answers every call. The question tests set
 * `PIPELINE_MCP_WORKER_TURN_URL`, so the calls go to a loopback worker-turn
 * endpoint in this process instead, and each of them checks that the fake was
 * never launched.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { DiscussionSetupProgress, DiscussionState, LevelState } from '../../core/types.js'
import { readCheckpoint, writeCheckpoint } from '../../domains/runtime/checkpoint.js'
import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import { readTeamChatMessages } from '../../domains/runtime/team-chat-messages.js'
import {
  MAX_COORDINATOR_CALL_ATTEMPTS,
  durableCoordinatorCallReceiptPath,
} from '../../team-runtime/durable-coordinator-call.js'
import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  readAssignmentJsonl,
  type FixtureHost,
  type FixtureLaterLevel,
  type FixtureRuntime,
  type FixtureTeamPersona,
} from '../support/team-runtime-fixture-boot.js'

const LEVEL_ID = 'intake'
const NEXT_LEVEL_ID = 'next'
const TEAM_NAME = 'fixture-desk'
const LEAD = { name: 'lead', provider: 'claude', model: 'claude-haiku-4-5' }
const MEMBER = { name: 'fixture-member', provider: 'claude', model: 'claude-haiku-4-5' }
const NEXT_COORDINATOR = { name: 'next-agent', provider: 'claude', model: 'claude-haiku-4-5' }
/** The model the fake reports for a lead reply. Its dashboard label is `discussion-reply`. */
const LEAD_REPLY_MODEL = 'claude-discussion-reply'
const LEAD_COST_USD = 0.25
const MEMBER_COST_USD = 0.1
const NON_FAKE_PROVIDERS = ['codex', 'gemini', 'openai', 'anthropic', 'lm-studio']
/** The lead's own model selection, as its persona file declares it. */
const LEAD_MODEL_SELECTION = {
  provider: 'claude',
  model: 'claude-haiku-4-5',
  source: 'agent',
  reason: 'explicit-agent-choice',
  caller: 'agent',
}
/** The run start time a restored checkpoint carries. */
const RESTORED_START_TIME = Date.parse('2026-01-01T00:00:00.000Z')
/** A restored activation later than any receipt this run can write. */
const FUTURE_ACTIVATION = Date.parse('2099-01-01T00:00:00.000Z')
/** A roster receipt start earlier than the restored activation. */
const EARLY_RECEIPT_START = '2026-01-02T00:00:00.000Z'

type LeadReply =
  | { readonly structured: Readonly<Record<string, unknown>> }
  | { readonly prose: string }

/** The roster rationale VALID_SELECTION gives the member. */
const SELECTED_RATIONALE = 'The review needs this member.'
const VALID_SELECTION: LeadReply = {
  structured: {
    agents: [MEMBER.name],
    rosterRationale: { [MEMBER.name]: SELECTED_RATIONALE },
  },
}
const COMPLETE_DECISION: LeadReply = {
  structured: {
    decision: 'complete',
    reason: 'The member answered.',
    message: null,
    targets: null,
    finalResponse: 'Lead synthesis.',
  },
}
/** A conversational reply with no JSON, which the runtime refuses. */
const PROSE_REPLY: LeadReply = { prose: 'Sure, I will ask the fixture member to look at it.' }
const CONTINUE_REASON = 'The review skipped the worked examples.'
const CONTINUE_MESSAGE = 'Check the worked examples against the text.'
const CONTINUE_DECISION: LeadReply = {
  structured: {
    decision: 'continue',
    reason: CONTINUE_REASON,
    message: CONTINUE_MESSAGE,
    targets: [MEMBER.name],
    finalResponse: null,
  },
}
/** The first line of the roster announcement for a one-member discussion. */
const CONVENING_ONE = 'Convening 1 of 1 Team members for this message.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.ok(isRecord(parsed), `${filePath} holds a JSON object`)
  return parsed
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function selectionInvocationId(sessionId: string): string {
  return `${sessionId}:discussion:${LEVEL_ID}:visit:0:selection`
}

function decisionInvocationId(sessionId: string, round: number, wrapUp: boolean): string {
  return `${sessionId}:discussion:${LEVEL_ID}:visit:0:decision:${round}${wrapUp ? ':wrap-up' : ''}`
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

/** A member turn's answer: a reply, or a CLI failure with this stderr. */
type MemberReply =
  | { readonly text: string }
  | { readonly failure: string }

interface FakeClaudeOptions {
  /** Replies to the roster call, by attempt. The last one repeats. */
  readonly selection?: readonly LeadReply[]
  /** Replies to the decision call, by attempt. The last one repeats. */
  readonly decision?: readonly LeadReply[]
  /** Replies to member turns, by launch. The last one repeats. */
  readonly member?: readonly MemberReply[]
  /**
   * Before answering, a launch of this kind connects to `holdPort` on loopback
   * and waits for a line. Every other launch answers at once.
   */
  readonly holdKind?: LaunchKind
  readonly holdPort?: number
}

type LaunchKind = 'selection' | 'decision' | 'member' | 'routing'

interface FakeClaudeLaunch {
  readonly kind: LaunchKind
  /** The script the launch ran, from its own `process.argv[1]`. */
  readonly script: string
  /** The `--json-schema` argument, or null. */
  readonly schema: string | null
  /** The `--system-prompt-file` contents. */
  readonly systemPrompt: string
  /** Everything the launch read from stdin. */
  readonly userMessage: string
  /** The checkpoint as it was on disk when the launch started, or null. */
  readonly checkpoint: Record<string, unknown> | null
}

interface FakeClaude {
  readonly env: Readonly<Record<string, string>>
  readonly scriptPath: string
  launches(): FakeClaudeLaunch[]
  remove(): void
}

function isLaunchKind(value: unknown): value is LaunchKind {
  return value === 'selection' || value === 'decision' || value === 'member' || value === 'routing'
}

/**
 * A `claude` executable that answers by call kind: a `# next-agent` persona is
 * a routing call, a schema naming `rosterRationale` is the roster call, any
 * other schema is the decision call, and the rest are member turns. It records
 * every launch, with the checkpoint as it was on disk at launch.
 */
function installFakeClaude(checkpointPath: string, options: FakeClaudeOptions): FakeClaude {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-call-claude-'))
  const scriptPath = path.join(binDir, 'claude')
  const launchLog = path.join(binDir, 'launches.jsonl')
  const settings = {
    launchLog,
    checkpointPath,
    selection: options.selection ?? [VALID_SELECTION],
    decision: options.decision ?? [COMPLETE_DECISION],
    member: options.member ?? [{ text: 'Member review.' }],
    leadModel: LEAD_REPLY_MODEL,
    leadCost: LEAD_COST_USD,
    memberCost: MEMBER_COST_USD,
    holdKind: options.holdKind ?? null,
    holdPort: options.holdPort ?? null,
  }
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs')
const settings = ${JSON.stringify(settings)}
const args = process.argv.slice(2)
const schemaIndex = args.indexOf('--json-schema')
const schema = schemaIndex === -1 ? null : args[schemaIndex + 1]
const promptFileIndex = args.indexOf('--system-prompt-file')
const systemPrompt = promptFileIndex === -1 ? '' : fs.readFileSync(args[promptFileIndex + 1], 'utf8')
const checkpoint = fs.existsSync(settings.checkpointPath)
  ? JSON.parse(fs.readFileSync(settings.checkpointPath, 'utf8'))
  : null
const kind = /^# next-agent$/m.test(systemPrompt)
  ? 'routing'
  : schema === null
    ? 'member'
    : schema.includes('rosterRationale') ? 'selection' : 'decision'
const earlier = fs.existsSync(settings.launchLog)
  ? fs.readFileSync(settings.launchLog, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line))
  : []
const attempt = earlier.filter((launch) => launch.kind === kind).length
function leadPayload(replies) {
  const reply = replies[Math.min(attempt, replies.length - 1)]
  return reply.structured === undefined ? { result: reply.prose } : { structured_output: reply.structured }
}
function answer() {
  const lead = kind === 'selection' || kind === 'decision'
  const memberReply = settings.member[Math.min(attempt, settings.member.length - 1)]
  if (kind === 'member' && memberReply.failure !== undefined) {
    process.stderr.write(memberReply.failure + '\\n', () => process.exit(1))
    return
  }
  const payload = kind === 'selection'
    ? leadPayload(settings.selection)
    : kind === 'decision'
      ? leadPayload(settings.decision)
      : kind === 'routing'
        ? { result: '# Routing decision\\n\\nRoute the synthesis onward.' }
        : { result: memberReply.text }
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    ...payload,
    model: lead ? settings.leadModel : 'claude-haiku-4-5',
    usage: { input_tokens: 7, output_tokens: 5 },
    total_cost_usd: lead ? settings.leadCost : kind === 'member' ? settings.memberCost : 0,
  }) + '\\n', () => process.exit(0))
}
let userMessage = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { userMessage += chunk })
process.stdin.on('end', () => {
  fs.appendFileSync(settings.launchLog, JSON.stringify({ kind, script: process.argv[1], schema, systemPrompt, userMessage, checkpoint }) + '\\n')
  if (settings.holdPort !== null && kind === settings.holdKind) {
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
          const { kind, script, schema, systemPrompt, userMessage, checkpoint } = parsed
          assert.ok(isLaunchKind(kind))
          assert.ok(typeof script === 'string' && (schema === null || typeof schema === 'string'))
          assert.ok(typeof systemPrompt === 'string' && typeof userMessage === 'string')
          assert.ok(checkpoint === null || isRecord(checkpoint))
          return { kind, script, schema, systemPrompt, userMessage, checkpoint }
        })
    },
    remove: () => fs.rmSync(binDir, { recursive: true, force: true }),
  }
}

function launchesOf(fake: FakeClaude, kind: LaunchKind): FakeClaudeLaunch[] {
  return fake.launches().filter((launch) => launch.kind === kind)
}

/**
 * Every provider request the run logged was a launch of the fake `claude`, and
 * no other provider was asked for anything.
 */
function assertOnlyFakeClaudeAnswered(
  assignmentPath: string,
  fake: FakeClaude,
  expectedKinds: readonly LaunchKind[],
): void {
  const providerEvents = readAssignmentJsonl(assignmentPath, 'provider-events.jsonl')
  assert.deepEqual(
    providerEvents.filter((event) => typeof event.provider === 'string' && NON_FAKE_PROVIDERS.includes(event.provider)),
    [],
    'no provider other than the fake claude was asked for anything',
  )
  const launches = fake.launches()
  assert.deepEqual(launches.map((launch) => launch.kind), expectedKinds)
  for (const launch of launches) {
    assert.equal(launch.script, fake.scriptPath, 'the claude that ran is the fake one')
  }
  assert.equal(
    providerEvents.filter((event) => event.provider === 'claude' && event.event === 'request.start').length,
    launches.length,
    `every claude request the run logged is a fake launch; got ${JSON.stringify(providerEvents)}`,
  )
}

// ── Loopback hold ────────────────────────────────────────────────────────────

/**
 * How long a held launch has to connect, and how long a held session start has
 * to settle once its session is shut down. Past either the test fails instead
 * of waiting forever, and its cleanups close the hold server so the file can
 * exit. Both are well inside every test's own timeout.
 */
const HOLD_DEADLINE_MS = 20_000

interface HoldServer {
  readonly port: number
  /**
   * Resolves when the held launch connects, which means the call is running.
   * Rejects when nothing connects within HOLD_DEADLINE_MS.
   */
  readonly connected: Promise<void>
  /** Lets the held provider return its scripted answer. */
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
      reject(new Error(`the held launch did not connect within ${HOLD_DEADLINE_MS} ms`))
    }, HOLD_DEADLINE_MS)
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
      for (const socket of accepted) socket.write('answer\n')
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

/** `promise`, or a rejection naming `what` once HOLD_DEADLINE_MS has passed. */
async function withinHoldDeadline(promise: Promise<void>, what: string): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(`${what} did not happen within ${HOLD_DEADLINE_MS} ms`)), HOLD_DEADLINE_MS)
  })
  try {
    await Promise.race([promise, expired])
  } finally {
    clearTimeout(deadline)
  }
}

// ── Loopback worker turn ─────────────────────────────────────────────────────

interface WorkerTurnServer {
  readonly url: string
  /** Every request body the endpoint received, in order. */
  readonly requests: Array<Record<string, unknown>>
  close(): Promise<void>
}

/** Answers each worker-turn request with what `respond` returns for it. */
async function startWorkerTurnServer(
  respond: (body: Record<string, unknown>, earlier: readonly Record<string, unknown>[]) => unknown,
): Promise<WorkerTurnServer> {
  const requests: Array<Record<string, unknown>> = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const body = isRecord(parsed) ? parsed : {}
      const answer = respond(body, [...requests])
      requests.push(body)
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

/** Whether a worker-turn request is the lead's roster call. */
function isRosterRequest(body: Record<string, unknown>): boolean {
  return body.agentPath === `agents/${LEAD.name}` &&
    JSON.stringify(body.questionOutputSchema ?? null).includes('rosterRationale')
}

/**
 * The environment a worker turn needs. The worker-turn request refuses a
 * session id that is not a UUID, so the run's session directory is a UUID too.
 */
function workerTurnEnv(url: string, runtimeSessionId: string): Record<string, string> {
  return {
    PIPELINE_MCP_WORKER_TURN_URL: url,
    TEAM_RUNTIME_SESSION_ID: runtimeSessionId,
    TEAM_RUNTIME_WORKFLOW_ID: 'discussion-workflow',
    TEAM_RUNTIME_WORKFLOW_STEP_ID: 'discuss',
  }
}

// ── Dashboard ────────────────────────────────────────────────────────────────

interface DashboardCapture {
  /** The dashboard widget rendered now, with ANSI styling removed. */
  render(): string[]
}

const ANSI_STYLE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Record the widget the runtime puts in the host's widget area. */
function captureDashboard(host: FixtureHost): DashboardCapture {
  const context = host.extensionContext
  assert.ok(isRecord(context) && isRecord(context.ui), 'the fixture extension context has a ui')
  let widget: unknown
  context.ui.setWidget = (_key: unknown, factory: unknown) => {
    widget = factory
  }
  return {
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

const DISPLAY_NAMES = ['Lead', 'Fixture Member', 'Next Agent']

/**
 * One agent's card text, e.g. "✓ Lead [discussion-reply]  r:2 $0.50".
 *
 * Cards share a line, so the card runs from its status icon, just before the
 * name, to the status icon of the next card on the same line.
 */
function agentCard(lines: readonly string[], displayName: string): string {
  const matches = lines.filter((line) => line.includes(` ${displayName} `))
  assert.equal(matches.length, 1, `one card line for ${displayName}; got ${JSON.stringify(lines)}`)
  const [line] = matches
  assert.ok(line)
  const start = line.indexOf(` ${displayName} `) - 1
  const nextCardStarts = DISPLAY_NAMES
    .filter((name) => name !== displayName)
    .map((name) => line.indexOf(` ${name} `) - 1)
    .filter((index) => index > start)
  return line.slice(start, Math.min(line.length, ...nextCardStarts))
}

// ── Assignment reads ─────────────────────────────────────────────────────────

function eventsNamed(assignmentPath: string, event: string): Array<Record<string, unknown>> {
  return readAssignmentJsonl(assignmentPath, ASSIGNMENT_LOG.runtimeEvents)
    .filter((record) => record.event === event)
}

function onlyEvent(assignmentPath: string, event: string): Record<string, unknown> {
  const records = eventsNamed(assignmentPath, event)
  assert.equal(records.length, 1, `exactly one ${event}; got ${JSON.stringify(records)}`)
  const [record] = records
  assert.ok(record)
  return record
}

/**
 * The record with its timestamp, and its duration when it has one, checked and
 * removed, so the rest compares whole.
 */
function withoutClockFields(record: Record<string, unknown>): Record<string, unknown> {
  const { timestamp, duration_ms: durationMs, ...fields } = record
  assert.equal(typeof timestamp, 'string')
  if ('duration_ms' in record) {
    assert.ok(typeof durationMs === 'number' && Number.isFinite(durationMs), `duration_ms is a finite number; got ${String(durationMs)}`)
  }
  return fields
}

/** The lead's agent-run records, in order. */
function leadRuns(assignmentPath: string): Array<Record<string, unknown>> {
  return readAssignmentJsonl(assignmentPath, 'agent-runs.jsonl')
    .filter((record) => record.agent_name === LEAD.name)
}

/** `status` of each lead record for one call site, in order. */
function leadStatuses(assignmentPath: string, triggerTool: string): unknown[] {
  return leadRuns(assignmentPath)
    .filter((record) => record.trigger_tool === triggerTool)
    .map((record) => record.status)
}

function readReceipt(assignmentPath: string, invocationId: string): Record<string, unknown> {
  return readJsonFile(durableCoordinatorCallReceiptPath(assignmentPath, invocationId))
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

function stageStatusInCheckpoint(assignmentPath: string): string | undefined {
  const checkpoint = readCheckpoint(assignmentPath)
  assert.ok(checkpoint, 'the run has a checkpoint')
  return checkpoint.levelStates.find((levelState) => levelState.levelId === LEVEL_ID)?.stageStatus
}

/** The discussion level's state in a launch record's checkpoint. */
function levelStateAtLaunch(launch: FakeClaudeLaunch): Record<string, unknown> {
  assert.ok(launch.checkpoint, 'the launch saw a checkpoint on disk')
  const levelStates = launch.checkpoint.levelStates
  assert.ok(Array.isArray(levelStates))
  const levelState: unknown = levelStates.find((candidate: unknown) =>
    isRecord(candidate) && candidate.levelId === LEVEL_ID)
  assert.ok(isRecord(levelState))
  return levelState
}

/** The discussion state a launch record's checkpoint held for the level. */
function discussionStateAtLaunch(launch: FakeClaudeLaunch): Record<string, unknown> {
  const levelState = levelStateAtLaunch(launch)
  assert.ok(isRecord(levelState.engineState))
  assert.equal(levelState.engineState.type, STAGE_TYPE.DISCUSSION)
  const state = levelState.engineState.state
  assert.ok(isRecord(state))
  return state
}

// ── Boot ─────────────────────────────────────────────────────────────────────

interface DiscussionBoot {
  readonly runtime: FixtureRuntime
  readonly fake: FakeClaude
  readonly dashboard: DashboardCapture
  /** Where this run's assignment lives. */
  readonly assignmentPath: string
  /** The session id the runtime records, which keys every coordinator slot. */
  readonly sessionId: string
}

interface DiscussionBootOptions {
  readonly label: string
  readonly fake?: FakeClaudeOptions
  readonly env?: Readonly<Record<string, string>>
  readonly laterLevels?: readonly FixtureLaterLevel[]
  readonly faultInjection?: string
  /**
   * `TEAM_RUNTIME_SESSION_ID` when the test overrides it, which moves the
   * assignment under `sessions/<id>`.
   */
  readonly runtimeSessionId?: string
  /** The discussion's participants. Defaults to `fixture-member` alone. */
  readonly members?: readonly FixtureTeamPersona[]
  /** The text of `incoming-brief.md`. */
  readonly brief?: string
}

/**
 * Boot a Team chat whose entry level is a discussion led by `lead` with one
 * member, without starting the session. The fixture team.yaml gains an input
 * contract naming `incoming-brief.md`, which the discussion reads as its
 * request, and the brief is written. The fake `claude` goes first on PATH
 * after the boot, so `close` restores the PATH the boot saved; one cleanup
 * closes the runtime and then removes the fake.
 */
async function bootDiscussion(defer: Defer, options: DiscussionBootOptions): Promise<DiscussionBoot> {
  const runtime = await bootFixtureRuntime({
    label: options.label,
    team: {
      stage: 'discussion',
      coordinator: LEAD,
      members: options.members ?? [MEMBER],
      ...(options.laterLevels ? { laterLevels: options.laterLevels } : {}),
    },
    delegatedAutostart: true,
    ...(options.faultInjection !== undefined ? { faultInjection: options.faultInjection } : {}),
    env: { TEAM_CHAT_MODE: '1', TEAM_INPUT_ARTIFACT: 'incoming-brief.md', ...options.env },
    startSession: false,
  })
  let fake: FakeClaude | undefined
  defer(async () => {
    await runtime.close()
    fake?.remove()
  })
  const teamConfigPath = runtime.teamConfigPath
  assert.ok(teamConfigPath, 'a Team boot has a team.yaml')
  const workflow = 'workflow:\n  entry_level: intake\n'
  const teamYaml = fs.readFileSync(teamConfigPath, 'utf8')
  assert.ok(teamYaml.includes(workflow), 'the fixture team.yaml declares its workflow')
  fs.writeFileSync(
    teamConfigPath,
    teamYaml.replace(
      workflow,
      `${workflow}  input_contract:\n    artifacts:\n      - path: incoming-brief.md\n        required: true\n`,
    ),
  )
  const assignmentPath = options.runtimeSessionId === undefined
    ? runtime.assignmentPath
    : path.join(
      runtime.workspace, 'sessions', options.runtimeSessionId, 'runs', runtime.runId, 'assignments', runtime.assignmentId,
    )
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'incoming-brief.md'), options.brief ?? 'Review the teaching material.')
  const dashboard = captureDashboard(runtime.host)
  fake = installFakeClaude(getRunRuntimePaths(assignmentPath).checkpointPath, options.fake ?? {})
  Object.assign(process.env, fake.env)
  return { runtime, fake, dashboard, assignmentPath, sessionId: runtime.assignmentId }
}

/**
 * A checkpoint for a restart that finds the discussion level before its roster
 * call, with the activation time given. The run has spent nothing.
 */
function writeCheckpointBeforeRosterCall(boot: DiscussionBoot, activationStartedAtMs: number): void {
  writeCheckpoint(boot.assignmentPath, {
    sessionId: boot.sessionId,
    currentLevelIndex: 0,
    levelStates: new Map([[
      LEVEL_ID,
      {
        status: LEVEL_STATUS.ACTIVE,
        stageStatus: STAGE_LIFECYCLE_STATUS.READY,
        loopbackCount: 0,
        visitCount: 0,
        engineState: {
          type: STAGE_TYPE.DISCUSSION,
          round: 0,
          messages: [],
          outputPath: boot.assignmentPath,
          activationStartedAtMs,
        },
      },
    ]]),
    totalCost: 0,
    startTime: RESTORED_START_TIME,
    timerStarted: true,
    endTime: null,
    spawnDepth: 0,
  })
}

/** The identity fields every lead agent-run record carries. */
function leadRecordIdentity(boot: DiscussionBoot): Record<string, unknown> {
  return {
    session_id: boot.sessionId,
    root_session_id: boot.sessionId,
    assignment_path: boot.assignmentPath,
    team: TEAM_NAME,
    level_id: LEVEL_ID,
    stage_type: STAGE_TYPE.DISCUSSION,
    agent_name: LEAD.name,
    agent_type: 'agent',
    from: TEAM_NAME,
    to: LEAD.name,
    provider: LEAD.provider,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('each lead call logs a start carrying the lead\'s configured pair and model selection, then an end carrying the model its reply reported', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-call-records' })
    await boot.runtime.startSession()

    const identity = leadRecordIdentity(boot)
    const start = (triggerTool: string) => ({
      ...identity,
      event: 'start',
      trigger_tool: triggerTool,
      status: 'active',
      model: LEAD.model,
      model_selection: LEAD_MODEL_SELECTION,
    })
    const end = (triggerTool: string) => ({
      ...identity,
      event: 'end',
      trigger_tool: triggerTool,
      status: 'completed',
      model: LEAD_REPLY_MODEL,
    })
    assert.deepEqual(leadRuns(boot.assignmentPath).map(withoutClockFields), [
      start('delegated_discussion_plan'),
      end('delegated_discussion_plan'),
      start('delegated_discussion_decision'),
      end('delegated_discussion_decision'),
    ])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('a refused lead reply is bought again in the same durable slot, with the refusal reason appended to the prompt', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-call-retry',
      fake: { selection: [PROSE_REPLY, VALID_SELECTION] },
    })
    await boot.runtime.startSession()

    const { reason, ...rejected } = withoutClockFields(onlyEvent(boot.assignmentPath, 'runtime.coordinator_reply.rejected'))
    assert.ok(typeof reason === 'string')
    assert.match(reason, /^Discussion lead returned an invalid roster selection: /)
    assert.deepEqual(rejected, {
      event: 'runtime.coordinator_reply.rejected',
      session_id: boot.sessionId,
      root_session_id: boot.sessionId,
      level_id: LEVEL_ID,
      stage_type: STAGE_TYPE.DISCUSSION,
      tool_name: 'delegated_discussion_plan',
      agent_name: LEAD.name,
      provider: LEAD.provider,
      model: LEAD.model,
      attempt: 1,
      output_schema_requested: true,
    })

    const [first, second, ...more] = launchesOf(boot.fake, 'selection')
    assert.ok(first && second, 'the roster call launched twice')
    assert.deepEqual(more, [])
    assert.equal(second.systemPrompt, first.systemPrompt)
    assert.equal(second.schema, first.schema)
    assert.equal(
      second.userMessage,
      `${first.userMessage}\n\n# Runtime Validation Feedback\n` +
        `Your previous response was rejected. ${reason}\n` +
        'Return a complete replacement response that satisfies the original contract.',
    )

    // One slot, whose second attempt was accepted.
    const selectionId = selectionInvocationId(boot.sessionId)
    const decisionId = decisionInvocationId(boot.sessionId, 1, false)
    assert.deepEqual(receiptInvocationIds(boot.assignmentPath, selectionId), [decisionId, selectionId].sort())
    const receipt = readReceipt(boot.assignmentPath, selectionId)
    assert.equal(receipt.phase, 'completed')
    assert.equal(receipt.attemptNumber, 2)

    // Each attempt logs its own start, and the refused one a failure.
    assert.deepEqual(leadStatuses(boot.assignmentPath, 'delegated_discussion_plan'), ['active', 'failed', 'active', 'completed'])
    const failure = leadRuns(boot.assignmentPath).find((record) => record.event === 'fail')
    assert.ok(failure)
    assert.deepEqual(withoutClockFields(failure), {
      ...leadRecordIdentity(boot),
      event: 'fail',
      trigger_tool: 'delegated_discussion_plan',
      status: 'failed',
      model: LEAD.model,
    })
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'selection', 'member', 'decision'])
  })
})

test('a lead decision refused on every attempt stops at the slot\'s attempt budget and fails the run with the exhaustion', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-call-exhausted',
      fake: { decision: [PROSE_REPLY] },
    })
    await boot.runtime.startSession()

    const decisionId = decisionInvocationId(boot.sessionId, 1, false)
    assert.equal(launchesOf(boot.fake, 'decision').length, MAX_COORDINATOR_CALL_ATTEMPTS)
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'runtime.coordinator_reply.rejected')
        .map((record) => [record.tool_name, record.attempt]),
      [1, 2, 3].map((attempt) => ['delegated_discussion_decision', attempt]),
    )
    const receipt = readReceipt(boot.assignmentPath, decisionId)
    assert.equal(receipt.phase, 'rejected')
    assert.equal(receipt.attemptNumber, MAX_COORDINATOR_CALL_ATTEMPTS)

    const error = onlyEvent(boot.assignmentPath, 'run.failed').error
    assert.ok(typeof error === 'string')
    assert.match(
      error,
      new RegExp(
        `^CoordinatorCallRejectionExhaustedError: Coordinator call '${escapeRegExp(decisionId)}' had 3 consecutive ` +
          'replies rejected and has no attempts left\\. Last rejection: Discussion lead returned an invalid continuation decision: ',
      ),
    )
    // The fourth attempt is refused by the slot before any launch, and still
    // logs a start and a failure.
    assert.deepEqual(
      leadStatuses(boot.assignmentPath, 'delegated_discussion_decision'),
      ['active', 'failed', 'active', 'failed', 'active', 'failed', 'active', 'failed'],
    )
    assert.equal(stageStatusInCheckpoint(boot.assignmentPath), STAGE_LIFECYCLE_STATUS.FAILED)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision', 'decision', 'decision'])
  })
})

test('every attempt at a lead call, a refused one included, advances the coordinator run id the next level is armed under', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-call-run-id',
      fake: { selection: [PROSE_REPLY, VALID_SELECTION] },
      laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR }],
    })
    await boot.runtime.startSession()

    // Two roster attempts and one decision.
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'tools.registered').map((record) => [record.level_id, record.coordinator_run_id]),
      [[LEVEL_ID, 0], [NEXT_LEVEL_ID, 3]],
    )
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'selection', 'member', 'decision', 'routing'])
  })
})

test('each lead call adds its cost to the run total on disk before the next dispatch, and the lead\'s card counts its rounds at that cost under the reply model', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-call-cost' })
    await boot.runtime.startSession()

    const [member] = launchesOf(boot.fake, 'member')
    const [decision] = launchesOf(boot.fake, 'decision')
    assert.ok(member?.checkpoint && decision?.checkpoint)
    assert.equal(member.checkpoint.totalCost, LEAD_COST_USD, 'the roster call was paid for before the member ran')
    assert.equal(decision.checkpoint.totalCost, LEAD_COST_USD + MEMBER_COST_USD)

    const card = agentCard(boot.dashboard.render(), 'Lead')
    assert.match(card, /✓/, `a lead whose calls finished is done; got ${card}`)
    assert.match(card, /r:2/, 'one round per call')
    assert.match(card, /\$0\.50/, 'the cost of both calls')
    assert.match(card, /\[discussion-reply\]/, 'the model the replies reported')
    assert.doesNotMatch(card, /ACTIVE|✗/)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('a refused reply that spends a halt budget stops the retry at the budget before a second launch, and the refused attempt stays the base of the next', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-call-budget',
      fake: { selection: [PROSE_REPLY] },
      env: { TEAM_BUDGET_CAP: String(LEAD_COST_USD), TEAM_BUDGET_POLICY: 'halt' },
    })
    await boot.runtime.startSession()

    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'runtime.coordinator_reply.rejected').map((record) => record.attempt),
      [1],
    )
    const error = onlyEvent(boot.assignmentPath, 'run.failed').error
    assert.ok(typeof error === 'string')
    assert.match(error, /^DirectAgentBudgetRefusedError: The Team budget is exhausted: \$0\.25 spent of \$0\.25\.\n/)

    // The second attempt was admitted to the slot on the run total after the
    // first reply's charge, then refused before its launch.
    const receipt = readReceipt(boot.assignmentPath, selectionInvocationId(boot.sessionId))
    assert.equal(receipt.phase, 'failed')
    assert.equal(receipt.attemptNumber, 2)
    assert.equal(receipt.baseTotalCost, LEAD_COST_USD)
    assert.equal(readCheckpoint(boot.assignmentPath)?.totalCost, LEAD_COST_USD)
    assert.deepEqual(leadStatuses(boot.assignmentPath, 'delegated_discussion_plan'), ['active', 'failed', 'active', 'failed'])
    assert.equal(stageStatusInCheckpoint(boot.assignmentPath), STAGE_LIFECYCLE_STATUS.FAILED)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection'])
  })
})

test('a lead decision made after the roster call replays an earlier durable start is timed from that start, not from the activation the run restored', {
  timeout: 90_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-call-clock' })
    // The first session completes and leaves a paid roster receipt behind.
    await boot.runtime.startSession()
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
    const selectionId = selectionInvocationId(boot.sessionId)
    const receiptPath = durableCoordinatorCallReceiptPath(boot.assignmentPath, selectionId)
    const receipt = readJsonFile(receiptPath)
    assert.equal(receipt.phase, 'completed')
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, startedAt: EARLY_RECEIPT_START }, null, 2)}\n`)
    fs.rmSync(path.join(boot.assignmentPath, 'discussion-result.md'), { force: true })

    // The restart finds the level before its roster call, activated later than
    // the receipt started.
    writeCheckpointBeforeRosterCall(boot, FUTURE_ACTIVATION)
    await boot.runtime.startSession()

    // The roster is replayed and the stage is timed from the receipt, which is
    // long past its time allowance: the lead is asked for a wrap-up at once.
    const restartLaunches = boot.fake.launches().slice(3)
    assert.deepEqual(restartLaunches.map((launch) => launch.kind), ['decision'])
    const [wrapUp] = restartLaunches
    assert.ok(wrapUp)
    const stateAtWrapUp = discussionStateAtLaunch(wrapUp)
    assert.equal(stateAtWrapUp.activationStartedAtMs, Date.parse(EARLY_RECEIPT_START))
    assert.ok(isRecord(stateAtWrapUp.continuation))
    assert.equal(stateAtWrapUp.continuation.startedAtMs, Date.parse(EARLY_RECEIPT_START))

    // The wrap-up call ran on the wrap-up allowance and was accepted.
    const wrapUpReceipt = readReceipt(boot.assignmentPath, decisionInvocationId(boot.sessionId, 0, true))
    assert.equal(wrapUpReceipt.phase, 'completed')
    assert.equal(wrapUpReceipt.attemptNumber, 1)
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'runtime.stage_autostart.end').map((record) => record.is_error),
      [false, false],
    )
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision', 'decision'])
  })
})

test('a lead that asks a question on its roster call logs an awaiting-input end, is left idle, and suspends the run', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const worker = await startWorkerTurnServer((body) =>
      isRosterRequest(body) ? workerQuestion('question-1') : undefined)
    defer(() => worker.close())
    const runtimeSessionId = randomUUID()
    const boot = await bootDiscussion(defer, {
      label: 'discussion-call-question',
      env: workerTurnEnv(worker.url, runtimeSessionId),
      runtimeSessionId,
    })
    await boot.runtime.startSession()

    const selectionId = selectionInvocationId(boot.sessionId)
    assert.equal(worker.requests.length, 1, 'the roster call went to the worker-turn endpoint once')
    const [asked] = worker.requests
    assert.ok(asked)
    assert.equal(asked.agentPath, `agents/${LEAD.name}`)
    assert.deepEqual(asked.questionContext, {
      logicalInvocationId: selectionId,
      dispatchId: selectionId,
      teamId: TEAM_NAME,
      stageId: LEVEL_ID,
    })

    const identity = leadRecordIdentity(boot)
    assert.deepEqual(leadRuns(boot.assignmentPath).map(withoutClockFields), [
      {
        ...identity,
        event: 'start',
        trigger_tool: 'delegated_discussion_plan',
        status: 'active',
        model: LEAD.model,
        model_selection: LEAD_MODEL_SELECTION,
      },
      {
        event: 'end',
        session_id: boot.sessionId,
        assignment_path: boot.assignmentPath,
        team: TEAM_NAME,
        level_id: LEVEL_ID,
        stage_type: STAGE_TYPE.DISCUSSION,
        trigger_tool: 'delegated_discussion_plan',
        agent_name: LEAD.name,
        agent_type: 'agent',
        status: 'awaiting_input',
        model: LEAD.model,
        provider: LEAD.provider,
      },
    ])
    assert.deepEqual(
      onlyEvent(boot.assignmentPath, 'run.awaiting_agent_input').interruption,
      { kind: 'awaiting_input', interactionId: 'question-1' },
    )
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'runtime.stage_autostart.end'), [])
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'runtime.coordinator_reply.rejected'), [])

    const card = agentCard(boot.dashboard.render(), 'Lead')
    assert.match(card, /^o Lead /, `a lead waiting on an answer is idle; got ${card}`)
    assert.doesNotMatch(card, /ACTIVE|✗|r:1/)
    assert.deepEqual(readAssignmentJsonl(boot.assignmentPath, 'provider-events.jsonl'), [], 'no provider ran in this process')
    assert.deepEqual(boot.fake.launches(), [], 'the fake claude was never launched')
  })
})

test('a recovering run resumes the lead\'s answered roster question in its own slot and convenes the roster it answered with', {
  timeout: 90_000,
}, async () => {
  await withCleanup(async (defer) => {
    const rosterAnswer = JSON.stringify({
      agents: [MEMBER.name],
      rosterRationale: { [MEMBER.name]: 'The answer says this member is needed.' },
    })
    const decisionAnswer = JSON.stringify({
      decision: 'complete',
      reason: 'The member answered.',
      message: null,
      targets: null,
      finalResponse: 'Lead synthesis after the answer.',
    })
    const worker = await startWorkerTurnServer((body, earlier) => {
      if (isRosterRequest(body)) {
        return earlier.some(isRosterRequest) ? workerAnswer(rosterAnswer) : workerQuestion('question-1')
      }
      if (body.agentPath === `agents/${LEAD.name}`) return workerAnswer(decisionAnswer)
      if (body.agentPath === `agents/${MEMBER.name}`) return workerAnswer('Member review after the answer.')
      return undefined
    })
    defer(() => worker.close())
    const runtimeSessionId = randomUUID()
    const boot = await bootDiscussion(defer, {
      label: 'discussion-call-answer',
      env: workerTurnEnv(worker.url, runtimeSessionId),
      runtimeSessionId,
    })
    await boot.runtime.startSession()
    assert.equal(
      onlyEvent(boot.assignmentPath, 'run.awaiting_agent_input').level_id,
      LEVEL_ID,
      'precondition: the first start suspended on the question',
    )

    process.env.TEAM_RUNTIME_RECOVERY = '1'
    await boot.runtime.startSession()

    const selectionId = selectionInvocationId(boot.sessionId)
    const answerId = `${selectionId}:answer:question-1`
    const rosterRequests = worker.requests.filter(isRosterRequest)
    assert.equal(rosterRequests.length, 2, 'the answer is one new roster turn')
    const [, resumed] = rosterRequests
    assert.ok(resumed)
    assert.deepEqual(resumed.questionContext, {
      logicalInvocationId: selectionId,
      dispatchId: selectionId,
      teamId: TEAM_NAME,
      stageId: LEVEL_ID,
    })
    assert.equal(readReceipt(boot.assignmentPath, selectionId).phase, 'completed')
    assert.equal(readReceipt(boot.assignmentPath, answerId).phase, 'completed')
    assert.ok(
      receiptInvocationIds(boot.assignmentPath, selectionId).includes(answerId),
      'the answer was bought in its own slot',
    )
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'discussion.roster.selected').map((record) => record.participants),
      [[MEMBER.name]],
    )
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'runtime.stage_autostart.end').map((record) => record.is_error),
      [false],
    )
    assert.deepEqual(readAssignmentJsonl(boot.assignmentPath, 'provider-events.jsonl'), [], 'no provider ran in this process')
    assert.deepEqual(boot.fake.launches(), [], 'the fake claude was never launched')
  })
})

test('the roster slot is bound to the stage\'s time allowance: a restart under a different max_time_minutes refuses to replay it', {
  timeout: 90_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-call-allowance' })
    // The first session completes and leaves a paid roster receipt behind.
    await boot.runtime.startSession()
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
    fs.rmSync(path.join(boot.assignmentPath, 'discussion-result.md'), { force: true })

    const teamConfigPath = boot.runtime.teamConfigPath
    assert.ok(teamConfigPath)
    const teamYaml = fs.readFileSync(teamConfigPath, 'utf8')
    assert.ok(teamYaml.includes('          max_time_minutes: 6\n'), 'the fixture discussion allows six minutes')
    fs.writeFileSync(teamConfigPath, teamYaml.replace('          max_time_minutes: 6\n', '          max_time_minutes: 7\n'))
    writeCheckpointBeforeRosterCall(boot, RESTORED_START_TIME)
    await boot.runtime.startSession()

    const error = onlyEvent(boot.assignmentPath, 'run.failed').error
    assert.ok(typeof error === 'string')
    assert.match(error, /^Error: Coordinator call request changed for an existing durable slot\.\n/)
    assert.equal(readReceipt(boot.assignmentPath, selectionInvocationId(boot.sessionId)).phase, 'completed')
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('a session shut down during the lead\'s roster call cancels the call, leaves its slot indeterminate, and ends the autostart as cancelled without a failure', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const hold = await startHoldServer()
    defer(() => hold.close())
    const boot = await bootDiscussion(defer, {
      label: 'discussion-call-cancelled',
      fake: { holdKind: 'selection', holdPort: hold.port },
    })
    let sessionStarted: Promise<void> | undefined
    defer(() => settleHeldSession(hold, sessionStarted))
    sessionStarted = boot.runtime.startSession()
    await hold.connected
    await boot.runtime.shutdown()
    // The shutdown alone has to end the held call; the hold is never released.
    await withinHoldDeadline(sessionStarted, 'the session start settling after its shutdown')

    const { error, ...end } = withoutClockFields(onlyEvent(boot.assignmentPath, 'runtime.stage_autostart.end'))
    assert.ok(typeof error === 'string' && error.length > 0)
    assert.equal(end.is_error, false)
    assert.equal(end.cancelled, true)
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assert.equal(onlyEvent(boot.assignmentPath, 'run.incomplete').reason, 'session_shutdown')
    // Nothing says whether the cancelled call was answered, so the slot keeps
    // its started receipt.
    assert.equal(readReceipt(boot.assignmentPath, selectionInvocationId(boot.sessionId)).phase, 'started')
    assert.deepEqual(leadStatuses(boot.assignmentPath, 'delegated_discussion_plan'), ['active', 'failed'])
    assert.notEqual(stageStatusInCheckpoint(boot.assignmentPath), STAGE_LIFECYCLE_STATUS.FAILED)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection'])
  })
})

// ── Pass loop ────────────────────────────────────────────────────────────────

/** The reply a restored checkpoint holds for the member's first pass. */
const RESTORED_MEMBER_REVIEW = 'Restored member review.'
/** A completion whose reply carries its own frontmatter above the synthesis. */
const FRONTMATTER_COMPLETION = '---\nstatus: draft\n---\n\nLead synthesis body.'
/** A completion whose reply is frontmatter and nothing else. */
const EMPTY_BODY_COMPLETION = '---\nstatus: draft\n---'

function completeWith(finalResponse: string): LeadReply {
  return {
    structured: {
      decision: 'complete',
      reason: 'The member answered.',
      message: null,
      targets: null,
      finalResponse,
    },
  }
}

/**
 * The discussion level's begin event's tool call id. The set_roster and
 * create_brief calls, the error row, the end event and the roster notices are
 * named from it.
 */
function autostartToolCallId(assignmentPath: string): string {
  const begins = eventsNamed(assignmentPath, 'runtime.stage_autostart.begin')
    .filter((record) => record.level_id === LEVEL_ID)
  assert.equal(begins.length, 1, `one begin event for the discussion level; got ${JSON.stringify(begins)}`)
  const toolCallId = begins[0]?.tool_call_id
  assert.ok(typeof toolCallId === 'string')
  assert.match(toolCallId, /^runtime-autostart-[0-9a-f-]{36}-delegated-discussion$/)
  return toolCallId
}

/** The discussion autostart's tool-use rows, in order, with their timestamps checked and removed. */
function autostartToolUseRows(assignmentPath: string): Array<Record<string, unknown>> {
  return readAssignmentJsonl(assignmentPath, ASSIGNMENT_LOG.toolUse)
    .filter((row) => row.delegated_discussion_autostart === true)
    .map(withoutClockFields)
}

/** The fields every tool-use row of the discussion autostart carries. */
function autostartRowFields(boot: DiscussionBoot): Record<string, unknown> {
  return {
    runtime_autostart: true,
    delegated_discussion_autostart: true,
    level_id: LEVEL_ID,
    stage_type: STAGE_TYPE.DISCUSSION,
    root_session_id: boot.sessionId,
  }
}

/** The rows a roster selection and its announcement write. */
function setupRows(boot: DiscussionBoot, toolCallId: string): Array<Record<string, unknown>> {
  return [
    { tool_name: 'set_roster', tool_call_id: `${toolCallId}:set-roster`, is_error: false, ...autostartRowFields(boot) },
    { tool_name: 'create_brief', tool_call_id: `${toolCallId}:create-brief`, is_error: false, ...autostartRowFields(boot) },
  ]
}

/** The row for attempt 1 of a Team chat specialist pass. */
function passRow(boot: DiscussionBoot, pass: number): Record<string, unknown> {
  return {
    tool_name: 'converse',
    tool_call_id: `discussion-pass:${LEVEL_ID}:${pass}:attempt:1`,
    is_error: false,
    pass,
    attempt: 1,
    ...autostartRowFields(boot),
  }
}

/** Each Team chat message as speaker, kind, dispatch and text, in order. */
function chatMessages(assignmentPath: string): Array<Record<string, string>> {
  return readTeamChatMessages(assignmentPath).map((message) => ({
    agent_name: message.agent_name,
    message_type: message.message_type,
    dispatch_id: message.dispatch_id,
    text: message.text,
  }))
}

/** The dispatch id of the member's accepted reply in a pass. */
function memberDispatchId(boot: DiscussionBoot, pass: number): string {
  return `${boot.sessionId}:discussion:${LEVEL_ID}:visit:0:round:${pass}:${MEMBER.name}#1#${MEMBER.name}`
}

/** The dispatch id of the lead's decision after a pass. */
function leadDecisionDispatchId(pass: number): string {
  return `lead-decision:${LEVEL_ID}:visit:0:round:${pass}`
}

/** The message announcing a one-member roster with this rationale. */
function rosterAnnouncement(rationale: string): Record<string, string> {
  return {
    agent_name: LEAD.name,
    message_type: 'framing',
    dispatch_id: `roster-announcement:${LEVEL_ID}:visit:0`,
    text: `${CONVENING_ONE}\n\n- **${MEMBER.name}** — ${rationale}`,
  }
}

/** The index of the first runtime event `matches` accepts. */
function eventPosition(
  assignmentPath: string,
  matches: (record: Record<string, unknown>) => boolean,
): number {
  const position = readAssignmentJsonl(assignmentPath, ASSIGNMENT_LOG.runtimeEvents).findIndex(matches)
  assert.notEqual(position, -1, 'the event was recorded')
  return position
}

/**
 * The failure arm's records: the error row, then the end event, then the run
 * failure, all carrying one error text, and the stage FAILED on disk. Returns
 * the error text.
 */
function assertAutostartFailed(boot: DiscussionBoot, toolCallId: string): string {
  const { error, ...end } = withoutClockFields(onlyEvent(boot.assignmentPath, 'runtime.stage_autostart.end'))
  assert.deepEqual(end, {
    event: 'runtime.stage_autostart.end',
    session_id: boot.sessionId,
    root_session_id: boot.sessionId,
    level_id: LEVEL_ID,
    stage_type: STAGE_TYPE.DISCUSSION,
    tool_name: 'delegated_discussion_autostart',
    tool_call_id: toolCallId,
    is_error: true,
    cancelled: false,
  })
  assert.ok(typeof error === 'string')
  assert.match(error, /\n {4}at /, 'the error text is the stack, not only the message')
  assert.deepEqual(autostartToolUseRows(boot.assignmentPath).at(-1), {
    tool_name: 'delegated_discussion_autostart',
    tool_call_id: toolCallId,
    is_error: true,
    error,
    ...autostartRowFields(boot),
  })
  assert.equal(onlyEvent(boot.assignmentPath, 'run.failed').error, error)
  assert.ok(
    eventPosition(boot.assignmentPath, (record) => record.event === 'runtime.stage_autostart.end') <
      eventPosition(boot.assignmentPath, (record) => record.event === 'run.failed'),
    'run.failed is written after the end event',
  )
  assert.equal(stageStatusInCheckpoint(boot.assignmentPath), STAGE_LIFECYCLE_STATUS.FAILED)
  return error
}

/** A discussion state for a restored checkpoint: nothing run yet, plus `fields`. */
function restoredDiscussion(boot: DiscussionBoot, fields: Partial<DiscussionState>): DiscussionState {
  return {
    type: STAGE_TYPE.DISCUSSION,
    round: 0,
    messages: [],
    outputPath: boot.assignmentPath,
    ...fields,
  }
}

/**
 * A checkpoint for a restart that finds the discussion level at `stageStatus`
 * with `engineState`. The run clock started at RESTORED_START_TIME and the run
 * has spent nothing.
 */
function writeRestoredDiscussion(
  boot: DiscussionBoot,
  stageStatus: LevelState['stageStatus'],
  engineState: DiscussionState,
): void {
  writeCheckpoint(boot.assignmentPath, {
    sessionId: boot.sessionId,
    currentLevelIndex: 0,
    levelStates: new Map([[
      LEVEL_ID,
      { status: LEVEL_STATUS.ACTIVE, stageStatus, loopbackCount: 0, visitCount: 0, engineState },
    ]]),
    totalCost: 0,
    startTime: RESTORED_START_TIME,
    timerStarted: true,
    endTime: null,
    spawnDepth: 0,
  })
}

/** The accepted selection a restored checkpoint holds for a locked roster. */
function restoredSetup(agents: readonly string[], rationale: string): DiscussionSetupProgress {
  return {
    phase: 'awaiting_roster_announcement',
    agents: [...agents],
    rosterRationale: Object.fromEntries(agents.map((agent) => [agent, rationale])),
  }
}

test('a Team chat discussion alternates specialist passes with lead decisions and records each in order', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-order',
      fake: {
        decision: [CONTINUE_DECISION, COMPLETE_DECISION],
        member: [{ text: 'First member review.' }, { text: 'Second member review.' }],
      },
    })
    await boot.runtime.startSession()

    const toolCallId = autostartToolCallId(boot.assignmentPath)
    assert.deepEqual(autostartToolUseRows(boot.assignmentPath), [
      ...setupRows(boot, toolCallId),
      passRow(boot, 1),
      passRow(boot, 2),
    ])
    assert.deepEqual(chatMessages(boot.assignmentPath), [
      rosterAnnouncement(SELECTED_RATIONALE),
      { agent_name: MEMBER.name, message_type: 'position', dispatch_id: memberDispatchId(boot, 1), text: 'First member review.' },
      {
        agent_name: LEAD.name,
        message_type: 'framing',
        dispatch_id: leadDecisionDispatchId(1),
        text: `${CONTINUE_REASON}\n\n${CONTINUE_MESSAGE}`,
      },
      { agent_name: MEMBER.name, message_type: 'position', dispatch_id: memberDispatchId(boot, 2), text: 'Second member review.' },
      { agent_name: LEAD.name, message_type: 'synthesis', dispatch_id: leadDecisionDispatchId(2), text: 'Lead synthesis.' },
    ])
    // The second pass is the lead's assignment.
    const [firstPass, secondPass] = launchesOf(boot.fake, 'member')
    assert.ok(firstPass && secondPass)
    assert.equal(firstPass.userMessage.includes(CONTINUE_MESSAGE), false)
    assert.equal(secondPass.userMessage.includes(CONTINUE_MESSAGE), true)
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'runtime.stage_autostart.end').map((record) => record.is_error),
      [false],
    )
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision', 'member', 'decision'])
  })
})

test('the first specialist pass of a Team chat starts from a checkpoint holding the announced roster and the running pass, without the accepted selection', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-chat-setup' })
    await boot.runtime.startSession()

    const [firstPass] = launchesOf(boot.fake, 'member')
    assert.ok(firstPass)
    const state = discussionStateAtLaunch(firstPass)
    const activation = state.activationStartedAtMs
    assert.ok(typeof activation === 'number' && Number.isFinite(activation))
    assert.equal('setup' in state, false, 'the accepted selection is gone once the roster is announced')
    assert.deepEqual(state.approvedRoster, [MEMBER.name])
    assert.equal(state.rosterAnnounced, true)
    assert.deepEqual(state.continuation, {
      phase: 'running_specialist_pass',
      startedAtMs: activation,
      passNumber: 1,
      attemptNumber: 1,
      targets: [MEMBER.name],
      completedTargets: [],
      successfulTargets: [],
    })
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('the lead\'s completion is written as the stage artifact under the runtime\'s metadata, and the stage completes before the next level starts', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-completion',
      fake: { decision: [completeWith(FRONTMATTER_COMPLETION)] },
      laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR }],
    })
    await boot.runtime.startSession()

    const artifact = fs.readFileSync(path.join(boot.assignmentPath, 'discussion-result.md'), 'utf8')
    const createdAt = /^created_at: "([^"]+)"$/m.exec(artifact)?.[1]
    assert.ok(createdAt !== undefined && Number.isFinite(Date.parse(createdAt)), `created_at is a date; got ${artifact}`)
    assert.equal(artifact, [
      '---',
      'artifact_type: "result"',
      'artifact_role: "final"',
      'schema_version: 1',
      `created_at: "${createdAt}"`,
      'filename: "discussion-result.md"',
      'path: "discussion-result.md"',
      `session_id: "${boot.sessionId}"`,
      `root_session_id: "${boot.sessionId}"`,
      `team: "${TEAM_NAME}"`,
      `agent: "${LEAD.name}"`,
      `level: "${LEVEL_ID}"`,
      'stage_type: "discussion"',
      'status: "complete"',
      '---',
      'Lead synthesis body.',
      '',
    ].join('\n'))

    // The next level's coordinator ran after the discussion completed and the
    // run moved on.
    const [routing] = launchesOf(boot.fake, 'routing')
    assert.ok(routing?.checkpoint)
    assert.equal(routing.checkpoint.currentLevelIndex, 1)
    assert.equal(levelStateAtLaunch(routing).stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'runtime.stage_autostart.end')
        .filter((record) => record.level_id === LEVEL_ID)
        .map((record) => record.is_error),
      [false],
    )
    assert.ok(
      eventPosition(boot.assignmentPath, (record) =>
        record.event === 'runtime.stage_autostart.end' && record.level_id === LEVEL_ID) <
        eventPosition(boot.assignmentPath, (record) =>
          record.event === 'tools.registered' && record.level_id === NEXT_LEVEL_ID),
      'the discussion ends before the next level registers its tools',
    )
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision', 'routing'])
  })
})

test('a lead completion with no body is published as the synthesis, then fails the run without writing the artifact', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-empty-completion',
      fake: { decision: [completeWith(EMPTY_BODY_COMPLETION)] },
    })
    await boot.runtime.startSession()

    const error = assertAutostartFailed(boot, autostartToolCallId(boot.assignmentPath))
    assert.match(error, /^Error: Discussion lead completion cannot publish an empty artifact\.\n/)
    assert.equal(fs.existsSync(path.join(boot.assignmentPath, 'discussion-result.md')), false, 'no artifact')
    assert.deepEqual(chatMessages(boot.assignmentPath).at(-1), {
      agent_name: LEAD.name,
      message_type: 'synthesis',
      dispatch_id: leadDecisionDispatchId(1),
      text: EMPTY_BODY_COMPLETION,
    })
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('a failed follow-up preserves earlier replies and completes with a marked partial synthesis', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    // Paid, non-deterministic provider calls are replaced at the CLI boundary.
    const boot = await bootDiscussion(defer, {
      label: 'discussion-partial-follow-up',
      fake: {
        decision: [CONTINUE_DECISION, COMPLETE_DECISION],
        member: [{ text: 'Accepted first-pass evidence.' }, { failure: 'fixture participant timed out' }],
      },
    })
    await boot.runtime.startSession()

    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    const synthesis = chatMessages(boot.assignmentPath).at(-1)
    assert.equal(synthesis?.message_type, 'synthesis')
    assert.equal(synthesis?.text, 'Partial Team answer: fixture-member did not complete its contribution.\n\nLead synthesis.')
    assert.match(fs.readFileSync(path.join(boot.assignmentPath, 'discussion-result.md'), 'utf8'), /Partial Team answer: fixture-member/)
    const decision = launchesOf(boot.fake, 'decision').at(-1)
    assert.ok(decision)
    assert.match(decision.userMessage, /Accepted first-pass evidence/)
    assert.match(decision.systemPrompt, /must complete now/)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision', 'member', 'decision'])
  })
})

test('a first-pass failure completes a partial answer before the pass floor once other participants provide evidence', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const missing = { ...MEMBER, name: 'missing-member' }
    const boot = await bootDiscussion(defer, {
      label: 'discussion-partial-first-pass', members: [MEMBER, missing],
      fake: {
        selection: [{ structured: { agents: [MEMBER.name, missing.name], rosterRationale: { [MEMBER.name]: 'Provide evidence.', [missing.name]: 'Challenge it.' } } }],
        member: [{ text: 'Available evidence.' }, { failure: 'fixture participant timed out' }],
      },
    })
    const configPath = boot.runtime.teamConfigPath
    assert.ok(configPath)
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('min_rounds: 1', 'min_rounds: 2'))
    await boot.runtime.startSession()

    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assert.equal(chatMessages(boot.assignmentPath).at(-1)?.text, 'Partial Team answer: missing-member did not complete its contribution.\n\nLead synthesis.')
    assert.equal(launchesOf(boot.fake, 'member').length, 2)
    assert.match(launchesOf(boot.fake, 'decision')[0]?.systemPrompt ?? '', /must complete now/)
  })
})

test('a restored partial completion preserves its notice and evidence without buying another provider turn', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-partial-recovery' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.RUNNING, restoredDiscussion(boot, {
      round: 2, approvedRoster: [MEMBER.name], rosterAnnounced: true,
      messages: [
        { from: MEMBER.name, target: MEMBER.name, to: 'all', round: 1, timestamp: new Date(RESTORED_START_TIME).toISOString(), type: 'position', message: 'Accepted evidence.', dispatchId: memberDispatchId(boot, 1) },
        { from: MEMBER.name, target: MEMBER.name, to: 'all', round: 2, timestamp: new Date(RESTORED_START_TIME).toISOString(), type: 'error', message: 'Contribution failed.' },
      ],
      continuation: { phase: 'publishing_completion', startedAtMs: RESTORED_START_TIME, reason: 'Missing contribution.', finalResponse: 'Saved partial synthesis.' },
    }))
    await boot.runtime.startSession()

    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assert.equal(chatMessages(boot.assignmentPath).at(-1)?.text, 'Partial Team answer: fixture-member did not complete its contribution.\n\nSaved partial synthesis.')
    assert.match(fs.readFileSync(path.join(boot.assignmentPath, 'discussion-result.md'), 'utf8'), /Partial Team answer: fixture-member/)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, [])
  })
})

test('a recovered failed follow-up synthesizes earlier evidence and names the unsuccessful target', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-failed-pass-recovery' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER, restoredDiscussion(boot, {
      round: 2, approvedRoster: [MEMBER.name], rosterAnnounced: true,
      messages: [{ from: MEMBER.name, target: MEMBER.name, to: 'all', round: 1, timestamp: new Date(RESTORED_START_TIME).toISOString(), type: 'position', message: 'Accepted evidence.', dispatchId: memberDispatchId(boot, 1) }],
      continuation: { phase: 'running_specialist_pass', startedAtMs: RESTORED_START_TIME, passNumber: 2, attemptNumber: 1, assignment: { targets: [MEMBER.name], message: CONTINUE_MESSAGE }, targets: [MEMBER.name], completedTargets: [MEMBER.name], successfulTargets: [] },
    }))
    await boot.runtime.startSession()

    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assert.equal(chatMessages(boot.assignmentPath).at(-1)?.text, 'Partial Team answer: fixture-member did not complete its contribution.\n\nLead synthesis.')
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['decision'])
  })
})

test('a specialist pass that ends blocked fails the stage, and the error row and end event are written before the run fails', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-blocked-pass',
      fake: { member: [{ failure: 'fixture member refused the turn' }] },
    })
    await boot.runtime.startSession()

    const toolCallId = autostartToolCallId(boot.assignmentPath)
    const error = assertAutostartFailed(boot, toolCallId)
    assert.match(error, /^Error: Discussion specialist pass 1 ended with stage status 'blocked'\.\n/)
    assert.deepEqual(autostartToolUseRows(boot.assignmentPath).slice(0, -1), [
      ...setupRows(boot, toolCallId),
      passRow(boot, 1),
    ])
    assert.deepEqual(chatMessages(boot.assignmentPath), [rosterAnnouncement(SELECTED_RATIONALE)])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member'])
  })
})

test('a session shut down during a specialist pass ends the autostart as cancelled without failing the stage, and still writes the error row', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const hold = await startHoldServer()
    defer(() => hold.close())
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-cancelled-pass',
      fake: { holdKind: 'member', holdPort: hold.port },
    })
    let sessionStarted: Promise<void> | undefined
    defer(() => settleHeldSession(hold, sessionStarted))
    sessionStarted = boot.runtime.startSession()
    await hold.connected
    await boot.runtime.shutdown()
    // The shutdown alone has to end the held pass; the hold is never released.
    await withinHoldDeadline(sessionStarted, 'the session start settling after its shutdown')

    const toolCallId = autostartToolCallId(boot.assignmentPath)
    const { error, ...end } = withoutClockFields(onlyEvent(boot.assignmentPath, 'runtime.stage_autostart.end'))
    assert.deepEqual(end, {
      event: 'runtime.stage_autostart.end',
      session_id: boot.sessionId,
      root_session_id: boot.sessionId,
      level_id: LEVEL_ID,
      stage_type: STAGE_TYPE.DISCUSSION,
      tool_name: 'delegated_discussion_autostart',
      tool_call_id: toolCallId,
      is_error: false,
      cancelled: true,
    })
    assert.ok(typeof error === 'string' && error.length > 0)
    assert.deepEqual(autostartToolUseRows(boot.assignmentPath).at(-1), {
      tool_name: 'delegated_discussion_autostart',
      tool_call_id: toolCallId,
      is_error: true,
      error,
      ...autostartRowFields(boot),
    })
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assert.equal(onlyEvent(boot.assignmentPath, 'run.incomplete').reason, 'session_shutdown')
    assert.notEqual(stageStatusInCheckpoint(boot.assignmentPath), STAGE_LIFECYCLE_STATUS.FAILED)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member'])
  })
})

test('a first pass the user addressed to one member convenes only that member of the locked roster', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const addressed = 'member-2'
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-addressed',
      members: [MEMBER, { name: addressed, provider: 'claude', model: 'claude-haiku-4-5' }],
      fake: {
        selection: [{
          structured: {
            agents: [MEMBER.name, addressed],
            rosterRationale: { [MEMBER.name]: SELECTED_RATIONALE, [addressed]: 'The examples need this member.' },
          },
        }],
      },
    })
    const routingPath = path.join(boot.assignmentPath, 'human-input-routing.json')
    fs.writeFileSync(routingPath, JSON.stringify({
      interactionId: 'interaction-addressed',
      source: 'workflow-feedback',
      messages: [{ id: 'message-addressed', text: 'Please check the worked examples.', recipients: [addressed] }],
    }))
    process.env.TEAM_HUMAN_INPUT_ROUTING_FILE = routingPath
    await boot.runtime.startSession()

    const [firstPass, ...laterPasses] = launchesOf(boot.fake, 'member')
    assert.ok(firstPass)
    assert.deepEqual(laterPasses, [])
    assert.match(firstPass.systemPrompt, new RegExp(`^# ${addressed}$`, 'm'))
    const state = discussionStateAtLaunch(firstPass)
    assert.deepEqual(state.approvedRoster, [MEMBER.name, addressed])
    assert.ok(isRecord(state.continuation))
    assert.equal(state.continuation.phase, 'running_specialist_pass')
    assert.deepEqual(state.continuation.targets, [addressed])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('a first pass leaves out a locked roster member whose agent the runtime did not load', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const unloaded = 'member-2'
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-unloaded',
      members: [MEMBER, { name: unloaded, provider: 'claude', model: 'claude-haiku-4-5', loadable: false }],
      fake: {
        selection: [{
          structured: {
            agents: [MEMBER.name, unloaded],
            rosterRationale: { [MEMBER.name]: SELECTED_RATIONALE, [unloaded]: 'The examples need this member.' },
          },
        }],
      },
    })
    await boot.runtime.startSession()

    const [firstPass] = launchesOf(boot.fake, 'member')
    assert.ok(firstPass)
    const state = discussionStateAtLaunch(firstPass)
    assert.deepEqual(state.approvedRoster, [MEMBER.name, unloaded])
    assert.ok(isRecord(state.continuation))
    assert.deepEqual(state.continuation.targets, [MEMBER.name])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('a restored Team chat discussion with a completed pass and no continuation asks the lead for its decision before any further pass', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-legacy-round' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.RUNNING, restoredDiscussion(boot, {
      round: 1,
      approvedRoster: [MEMBER.name],
      rosterAnnounced: true,
      messages: [{
        from: MEMBER.name,
        target: MEMBER.name,
        to: 'all',
        round: 1,
        timestamp: new Date(RESTORED_START_TIME).toISOString(),
        type: 'position',
        message: RESTORED_MEMBER_REVIEW,
        dispatchId: memberDispatchId(boot, 1),
      }],
    }))
    await boot.runtime.startSession()

    assert.deepEqual(
      boot.fake.launches().map((launch) => launch.kind),
      ['decision'],
      'the lead decided before any specialist pass',
    )
    const [decision] = launchesOf(boot.fake, 'decision')
    assert.ok(decision)
    const state = discussionStateAtLaunch(decision)
    assert.ok(typeof state.activationStartedAtMs === 'number')
    assert.deepEqual(state.continuation, { phase: 'awaiting_lead_decision', startedAtMs: state.activationStartedAtMs })
    assert.equal(decision.userMessage.includes(`[Pass 1] ${MEMBER.name}: ${RESTORED_MEMBER_REVIEW}`), true)
    const decisionId = decisionInvocationId(boot.sessionId, 1, false)
    assert.deepEqual(receiptInvocationIds(boot.assignmentPath, decisionId), [decisionId])
    assert.equal(readReceipt(boot.assignmentPath, decisionId).phase, 'completed')
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['decision'])
  })
})

test('a restored specialist pass whose every target answered without success fails the run below its quorum instead of asking the lead', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-quorum' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER, restoredDiscussion(boot, {
      round: 1,
      activationStartedAtMs: RESTORED_START_TIME,
      approvedRoster: [MEMBER.name],
      rosterAnnounced: true,
      continuation: {
        phase: 'running_specialist_pass',
        startedAtMs: RESTORED_START_TIME,
        passNumber: 1,
        attemptNumber: 1,
        targets: [MEMBER.name],
        completedTargets: [MEMBER.name],
        successfulTargets: [],
      },
    }))
    await boot.runtime.startSession()

    const error = assertAutostartFailed(boot, autostartToolCallId(boot.assignmentPath))
    assert.match(
      error,
      /^Error: Recovered discussion pass 1 has only 0 successful participant responses, but 1 were required\.\n/,
    )
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, [])
  })
})

test('a restored accepted completion on a failed stage publishes and writes its synthesis, then fails the run because a failed stage cannot complete', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const restoredSynthesis = 'Restored lead synthesis.'
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-failed-completion' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.FAILED, restoredDiscussion(boot, {
      round: 1,
      activationStartedAtMs: RESTORED_START_TIME,
      approvedRoster: [MEMBER.name],
      rosterAnnounced: true,
      continuation: {
        phase: 'publishing_completion',
        startedAtMs: RESTORED_START_TIME,
        reason: 'The member answered.',
        finalResponse: restoredSynthesis,
      },
    }))
    await boot.runtime.startSession()

    const error = assertAutostartFailed(boot, autostartToolCallId(boot.assignmentPath))
    assert.match(error, /^Error: Discussion cannot complete from stage status 'failed'\.\n/)
    assert.deepEqual(chatMessages(boot.assignmentPath), [{
      agent_name: LEAD.name,
      message_type: 'synthesis',
      dispatch_id: leadDecisionDispatchId(1),
      text: restoredSynthesis,
    }])
    const artifact = fs.readFileSync(path.join(boot.assignmentPath, 'discussion-result.md'), 'utf8')
    assert.equal(artifact.endsWith(`\nstatus: "complete"\n---\n${restoredSynthesis}\n`), true, `got ${artifact}`)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, [])
  })
})

test('a restored locked roster without its accepted selection fails the run before any call', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-no-setup' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.READY, restoredDiscussion(boot, {
      approvedRoster: [MEMBER.name],
    }))
    await boot.runtime.startSession()

    const error = assertAutostartFailed(boot, autostartToolCallId(boot.assignmentPath))
    assert.match(
      error,
      /^Error: Discussion recovery found a locked roster without its accepted selection rationale\.\n/,
    )
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, [])
  })
})

test('a restored locked roster whose accepted selection names other agents fails the run before any call', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-setup-mismatch' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.READY, restoredDiscussion(boot, {
      approvedRoster: [MEMBER.name],
      setup: restoredSetup(['retired-member'], 'Chosen before the roster was locked.'),
    }))
    await boot.runtime.startSession()

    const error = assertAutostartFailed(boot, autostartToolCallId(boot.assignmentPath))
    assert.match(
      error,
      /^Error: Discussion recovery found a setup selection that differs from the locked roster\.\n/,
    )
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, [])
  })
})

test('a restored locked roster with its accepted selection is announced with that selection\'s rationale, without a second roster call', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const restoredRationale = 'Chosen before the restart.'
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-setup-resume' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.READY, restoredDiscussion(boot, {
      approvedRoster: [MEMBER.name],
      setup: restoredSetup([MEMBER.name], restoredRationale),
    }))
    await boot.runtime.startSession()

    const toolCallId = autostartToolCallId(boot.assignmentPath)
    assert.deepEqual(autostartToolUseRows(boot.assignmentPath), [
      { tool_name: 'create_brief', tool_call_id: `${toolCallId}:create-brief`, is_error: false, ...autostartRowFields(boot) },
      passRow(boot, 1),
    ])
    assert.deepEqual(chatMessages(boot.assignmentPath)[0], rosterAnnouncement(restoredRationale))
    const selectionId = selectionInvocationId(boot.sessionId)
    assert.equal(receiptInvocationIds(boot.assignmentPath, selectionId).includes(selectionId), false, 'no roster slot was bought')
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['member', 'decision'])
  })
})

test('a follow-up roster addition past the cap is refused, recorded and told to the chat, and the standing roster runs', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const standing = [MEMBER.name, 'member-2', 'member-3', 'member-4', 'member-5']
    const addition = 'member-6'
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-roster-cap',
      members: [...standing, addition].map((name) => ({ name, provider: 'claude', model: 'claude-haiku-4-5' })),
      brief: [
        '# Task Brief',
        '',
        `Workflow: \`team-chat-${TEAM_NAME}\``,
        '',
        '## User Brief',
        '',
        '# Current user message',
        '',
        'please also check the code samples',
        '',
        '# Conversation continuity',
        '',
        `Previous responders: ${MEMBER.name}`,
        `Standing roster: ${standing.join(', ')}`,
      ].join('\n'),
      fake: {
        selection: [{
          structured: { agents: [addition], rosterRationale: { [addition]: 'The code samples need this member.' } },
        }],
      },
    })
    await boot.runtime.startSession()

    const toolCallId = autostartToolCallId(boot.assignmentPath)
    assert.deepEqual(withoutClockFields(onlyEvent(boot.assignmentPath, 'runtime.discussion.roster.addition_refused')), {
      event: 'runtime.discussion.roster.addition_refused',
      session_id: boot.sessionId,
      root_session_id: boot.sessionId,
      level_id: LEVEL_ID,
      stage_type: STAGE_TYPE.DISCUSSION,
      tool_name: 'delegated_discussion_plan',
      agent_name: LEAD.name,
      limit: 5,
      standing_roster: standing,
      refused_additions: [addition],
    })
    assert.deepEqual(chatMessages(boot.assignmentPath)[0], {
      agent_name: LEAD.name,
      message_type: 'framing',
      dispatch_id: `${toolCallId}-roster-addition-refused`,
      text:
        `This conversation already has the maximum of 5 specialists (${standing.join(', ')}), ` +
        `so I could not add ${addition} for this message. Start a new chat with this Team if you need them.`,
    })
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'discussion.roster.selected').map((record) => record.participants),
      [standing],
    )
    assertOnlyFakeClaudeAnswered(
      boot.assignmentPath,
      boot.fake,
      ['selection', ...standing.map((): LaunchKind => 'member'), 'decision'],
    )
  })
})

test('a roster refused on every attempt starts the discussion on the default roster, recorded and told to the chat before the announcement', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-roster-degraded',
      fake: { selection: [PROSE_REPLY] },
    })
    await boot.runtime.startSession()

    const toolCallId = autostartToolCallId(boot.assignmentPath)
    const { reason, ...degraded } = withoutClockFields(onlyEvent(boot.assignmentPath, 'runtime.discussion.roster.degraded'))
    assert.ok(typeof reason === 'string')
    assert.match(reason, /^Discussion lead returned an invalid roster selection: /)
    assert.deepEqual(degraded, {
      event: 'runtime.discussion.roster.degraded',
      session_id: boot.sessionId,
      root_session_id: boot.sessionId,
      level_id: LEVEL_ID,
      stage_type: STAGE_TYPE.DISCUSSION,
      tool_name: 'delegated_discussion_plan',
      agent_name: LEAD.name,
      attempts: 3,
      roster: [MEMBER.name],
    })
    const [notice, announcement] = chatMessages(boot.assignmentPath)
    assert.deepEqual(notice, {
      agent_name: LEAD.name,
      message_type: 'framing',
      dispatch_id: `${toolCallId}-roster-degraded`,
      text:
        `I did not choose this roster. My roster reply was rejected 3 times (${reason}), ` +
        `so the runtime started the discussion with a default roster: ${MEMBER.name}.`,
    })
    assert.equal(announcement?.dispatch_id, `roster-announcement:${LEVEL_ID}:visit:0`)
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assertOnlyFakeClaudeAnswered(
      boot.assignmentPath,
      boot.fake,
      ['selection', 'selection', 'selection', 'member', 'decision'],
    )
  })
})

test('a discussion outside Team chat runs one pass under a fixed id, keeps its accepted selection until that pass ends, and writes no chat messages', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, {
      label: 'discussion-loop-non-chat',
      env: { TEAM_CHAT_MODE: '0' },
      laterLevels: [{ id: NEXT_LEVEL_ID, coordinator: NEXT_COORDINATOR }],
    })
    await boot.runtime.startSession()

    const toolCallId = autostartToolCallId(boot.assignmentPath)
    assert.deepEqual(autostartToolUseRows(boot.assignmentPath), [
      ...setupRows(boot, toolCallId),
      { tool_name: 'converse', tool_call_id: `discussion-pass:${LEVEL_ID}:1`, is_error: false, pass: 1, ...autostartRowFields(boot) },
    ])
    // The one pass runs the stage's configured rounds itself.
    const memberLaunches = launchesOf(boot.fake, 'member')
    assert.equal(memberLaunches.length, 2)
    for (const launch of memberLaunches) {
      const state = discussionStateAtLaunch(launch)
      assert.deepEqual(state.setup, restoredSetup([MEMBER.name], SELECTED_RATIONALE))
      assert.equal('continuation' in state, false)
      assert.equal('rosterAnnounced' in state, false)
    }
    const [routing] = launchesOf(boot.fake, 'routing')
    assert.ok(routing)
    assert.equal(levelStateAtLaunch(routing).stageStatus, STAGE_LIFECYCLE_STATUS.COMPLETED)
    assert.equal('setup' in discussionStateAtLaunch(routing), false, 'the accepted selection is dropped after the pass')
    assert.deepEqual(readTeamChatMessages(boot.assignmentPath), [])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'member', 'routing'])
  })
})

test('the discussion autostart starts the run clock when the run has none', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-clock-start' })
    await boot.runtime.startSession()

    const [selection] = launchesOf(boot.fake, 'selection')
    const [member] = launchesOf(boot.fake, 'member')
    assert.ok(selection?.checkpoint && member?.checkpoint)
    assert.equal(selection.checkpoint.startTime, 0, 'precondition: the run clock had not started before the autostart')
    const startTime = member.checkpoint.startTime
    assert.ok(typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0, `got ${String(startTime)}`)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('the discussion autostart keeps the run clock a restored run had started', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-loop-clock-kept' })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.READY, restoredDiscussion(boot, {}))
    await boot.runtime.startSession()

    const [member] = launchesOf(boot.fake, 'member')
    assert.ok(member?.checkpoint)
    assert.equal(member.checkpoint.startTime, RESTORED_START_TIME)
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('in a Team chat, a lead completion marks the stage completed, which ends the response without checking the level\'s terminal gate', {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const boot = await bootDiscussion(defer, { label: 'discussion-completion-gate-unchecked' })
    // The terminal gate waits for an artifact nobody writes. A gate artifact
    // has to be declared by an agent, so the member declares one it never
    // writes. Checking this gate would refuse the level.
    const teamConfigPath = boot.runtime.teamConfigPath
    assert.ok(teamConfigPath, 'a Team boot has a team.yaml')
    const teamYaml = fs.readFileSync(teamConfigPath, 'utf8')
    const gateCondition = '    condition:\n      type: artifact_exists\n      artifact: discussion-result.md\n'
    assert.ok(teamYaml.includes(gateCondition), 'the fixture gate waits for the discussion artifact')
    const memberEntry = `  - name: ${MEMBER.name}\n    type: agent\n    role: Fixture team member.\n    agent_file: ./${MEMBER.name}.md\n    experience_enabled: false\n`
    assert.ok(teamYaml.includes(memberEntry), 'the fixture team.yaml lists the member')
    fs.writeFileSync(
      teamConfigPath,
      teamYaml
        .replace(gateCondition, '    condition:\n      type: artifact_exists\n      artifact: never-written.md\n')
        .replace(memberEntry, `${memberEntry}    produces:\n      - path: never-written.md\n`),
    )

    await boot.runtime.startSession()

    assert.ok(fs.existsSync(path.join(boot.assignmentPath, 'discussion-result.md')), 'the lead\'s completion was written')
    assert.equal(fs.existsSync(path.join(boot.assignmentPath, 'never-written.md')), false)
    // The completion path deletes the checkpoint of a run it completes.
    assert.equal(readCheckpoint(boot.assignmentPath), null, 'the completed run removed its checkpoint')
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'runtime.follow_up_enqueued'), [], 'no refused-gate notice was queued')
    assert.ok(
      boot.runtime.host.notifications.some((notice) => notice.message === 'Team chat response complete.'),
      `the response ended; notices: ${JSON.stringify(boot.runtime.host.notifications)}`,
    )
    assert.deepEqual(
      eventsNamed(boot.assignmentPath, 'runtime.stage_autostart.end').map((record) => record.is_error),
      [false],
    )
    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['selection', 'member', 'decision'])
  })
})

test('only a recovery reopens a restored specialist pass whose member answered without success: the member is asked again from a checkpoint that no longer counts it complete', {
  timeout: 120_000,
}, async (t) => {
  /** A pass restored mid-run: the member finished, without success. */
  function restoredPassWithFailedMember(boot: DiscussionBoot): DiscussionState {
    return restoredDiscussion(boot, {
      round: 1,
      activationStartedAtMs: RESTORED_START_TIME,
      approvedRoster: [MEMBER.name],
      rosterAnnounced: true,
      continuation: {
        phase: 'running_specialist_pass',
        startedAtMs: RESTORED_START_TIME,
        passNumber: 1,
        attemptNumber: 1,
        targets: [MEMBER.name],
        completedTargets: [MEMBER.name],
        successfulTargets: [],
      },
    })
  }

  await t.test('TEAM_RUNTIME_RECOVERY=1', async () => {
    await withCleanup(async (defer) => {
      const boot = await bootDiscussion(defer, {
        label: 'discussion-reopen-recovery',
        env: { TEAM_RUNTIME_RECOVERY: '1' },
      })
      writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER, restoredPassWithFailedMember(boot))

      await boot.runtime.startSession()

      const [member] = launchesOf(boot.fake, 'member')
      assert.ok(member, 'the member was asked again')
      const continuation = discussionStateAtLaunch(member).continuation
      assert.ok(isRecord(continuation))
      assert.equal(continuation.phase, 'running_specialist_pass')
      assert.deepEqual(continuation.targets, [MEMBER.name])
      assert.deepEqual(continuation.completedTargets, [], 'the checkpoint no longer counts the member complete')
      assert.deepEqual(continuation.successfulTargets, [])
      assert.deepEqual(
        eventsNamed(boot.assignmentPath, 'runtime.stage_autostart.end').map((record) => record.is_error),
        [false],
      )
      assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [])
      assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['member', 'decision'])
    })
  })

  await t.test('without TEAM_RUNTIME_RECOVERY', async () => {
    await withCleanup(async (defer) => {
      const boot = await bootDiscussion(defer, { label: 'discussion-reopen-no-recovery' })
      writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER, restoredPassWithFailedMember(boot))

      await boot.runtime.startSession()

      const checkpoint = readCheckpoint(boot.assignmentPath)
      assert.ok(checkpoint, 'the run has a checkpoint')
      const engineState = checkpoint.levelStates.find((levelState) => levelState.levelId === LEVEL_ID)?.engineState
      assert.ok(engineState?.type === STAGE_TYPE.DISCUSSION)
      const continuation = engineState.state.continuation
      assert.ok(continuation?.phase === 'running_specialist_pass')
      assert.deepEqual(continuation.completedTargets, [MEMBER.name], 'the persisted pass still counts the member complete')
      const error = assertAutostartFailed(boot, autostartToolCallId(boot.assignmentPath))
      assert.match(
        error,
        /^Error: Recovered discussion pass 1 has only 0 successful participant responses, but 1 were required\.\n/,
      )
      assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, [])
    })
  })
})


test('a lead can finish synthesis after the remaining work budget passes its original deadline', {
  timeout: 60_000,
}, async (t) => {
  await withCleanup(async (defer) => {
    // Paid, nondeterministic provider replaced at its real CLI boundary.
    const hold = await startHoldServer()
    defer(() => hold.close())
    const boot = await bootDiscussion(defer, {
      label: 'discussion-lead-wrap-up-floor',
      fake: { holdKind: 'decision', holdPort: hold.port },
    })
    writeRestoredDiscussion(boot, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER, restoredDiscussion(boot, {
      round: 1,
      approvedRoster: [MEMBER.name],
      rosterAnnounced: true,
      messages: [{ round: 1, from: MEMBER.name, to: LEAD.name, type: 'position', message: RESTORED_MEMBER_REVIEW, timestamp: new Date(RESTORED_START_TIME).toISOString() }],
      continuation: { phase: 'awaiting_lead_decision', startedAtMs: RESTORED_START_TIME },
    }))
    let sessionStarted: Promise<void> | undefined
    defer(() => settleHeldSession(hold, sessionStarted))
    // Reproduce the observed 50,820 ms remainder without waiting or using a
    // wall-clock-dependent fixture. Only the provider's delay is advanced.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: RESTORED_START_TIME + 309_180 })
    defer(() => t.mock.timers.reset())
    sessionStarted = boot.runtime.startSession()
    await hold.connected
    t.mock.timers.tick(60_000)
    hold.release()
    await sessionStarted

    assert.deepEqual(eventsNamed(boot.assignmentPath, 'run.failed'), [], 'finishing the answer has its own bounded allowance')
    assert.match(fs.readFileSync(path.join(boot.assignmentPath, 'discussion-result.md'), 'utf8'), /Lead synthesis\./)
    assert.equal(chatMessages(boot.assignmentPath).at(-1)?.message_type, 'synthesis')
    assertOnlyFakeClaudeAnswered(boot.assignmentPath, boot.fake, ['decision'])
  })
})
