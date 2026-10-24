/**
 * A managed Team run has to outlive the turn that starts it.
 *
 * This is the one journey the extension-callback tests cannot reach. Those call
 * registered handlers directly, so "B's entry was sent" is the end of the
 * story. In the real product launch it is not: whether A ever speaks, and
 * whether B ever finishes, is decided by Pi's own loop after our handler
 * returns.
 *
 * What the installed Pi 0.84.1 actually does, read from its source:
 *
 *   - `resolveAppMode` picks print mode whenever stdin or stdout is not a TTY
 *     (`dist/main.js:83`), and the managed Team launch passes `stdio: 'ignore'`
 *     (`domains/run/run-launcher.ts:157`).
 *   - Print mode's whole lifetime is the prompts it awaits: `initialMessage`,
 *     then each of `messages`, then `finally { await disposeRuntime() }`
 *     (`dist/modes/print-mode.js:105`, `:107`, `:134`). The managed launch
 *     passes no prompt at all (`run-launcher.ts:145`), so the try block ends
 *     immediately after `rebindSession`.
 *   - `bindExtensions` awaits `session_start` (`dist/core/agent-session.js:1761`),
 *     so the runtime's startup runs to completion first — and its only output is
 *     a stage entry queued 25ms out (`team-runtime/index.ts:3697`,
 *     `domains/runtime/follow-up.ts:69`) on an `unref()`'d timer
 *     (`follow-up.ts:58`) that cannot hold the event loop open.
 *   - `_emitAgentSettled` sets `_isAgentRunActive = false` *before* awaiting the
 *     `agent_settled` handlers (`dist/core/agent-session.js:328`), so a
 *     follow-up sent from settlement takes the non-streaming path and starts a
 *     detached `_runAgentPrompt` (`:919`) that print mode is not awaiting.
 *   - `ExtensionAPI.sendUserMessage` returns `void` and its rejection goes to
 *     Pi's error channel (`dist/core/extensions/types.d.ts:932`,
 *     `dist/core/agent-session.js:1855`), so the runtime never learns whether a
 *     dispatched entry was accepted, started, or finished.
 *
 * So the queue is not the problem and the logs are not the proof. This journey
 * holds the product to the only evidence that counts: two coordinators, each on
 * its own admitted pair, each producing its own artifact, with the run's
 * terminal success written after B has finished rather than before B began.
 *
 * The boundary is `DesktopRunLauncher.startRun`, unchanged. Its injectable
 * spawn is used only to observe and forward the real command, arguments,
 * environment, detached flag and ignored stdio, and to keep a handle on the
 * child so the test can wait for it and reap it. No Pi is stubbed, no prompt is
 * injected, and no network is reached: both coordinators are served by a
 * loopback HTTP server declared through a `models.json` in a throwaway agent
 * directory.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  DesktopRunLauncher,
  type RuntimeEnvironmentSource,
} from '../../domains/run/desktop-run-launcher.js'
import {
  toDetachedProcess,
  type SpawnDetachedProcess,
} from '../../domains/run/run-launcher.js'
import { reconcileWorkspaceTenantPin } from '../../services/execution-journal-tenant-pin.js'
import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import { readHostEntryAdmission } from '../../contracts/host-entry-admission.js'

const repoRoot = process.cwd()

const A_LEVEL = 'draft'
const B_LEVEL = 'review'
const A_COORDINATOR = 'lead'
const B_COORDINATOR = 'auditor'
const A_ARTIFACT = 'handoff-ready.md'
const B_ARTIFACT = 'reviewed.md'
const A_CONTENT = 'A_COMPLETE'
const B_CONTENT = 'B_COMPLETE'
const B_FINAL_TEXT = 'B_FINISHED'

/**
 * `lm-studio`, pointed at this test's own server.
 *
 * The provider has to satisfy three separate checks and this is the only one
 * that satisfies all of them without a credential: the agent-file check accepts
 * it as a known provider, `validateHostProviderReadiness` lists it as a
 * supported host (`domains/provider/provider-preflight.ts:228`), and its
 * readiness is credential-free. `models.json` then decides where it points, so
 * every request lands on loopback.
 */
const PROVIDER = 'lm-studio'
const A_MODEL = 'loopback-a'
const B_MODEL = 'loopback-b'
/**
 * The application default a *recovering* process is given.
 *
 * Real, offered by the same `models.json`, and runnable — so a resumed entry
 * that re-resolved its pair would succeed on this one rather than fail for an
 * unrelated reason. The assertion is then about which model spoke, not about
 * whether anything spoke at all.
 */
const RECOVERY_DEFAULT_MODEL = 'loopback-c'

/** Credentials that must never reach the child; a run here is loopback-only. */
const PROVIDER_CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
] as const

// ── The scripted coordinator provider ────────────────────────────────────────

interface ProviderRound {
  readonly model: string
  readonly toolResultIds: readonly string[]
}

interface ScriptedTurn {
  /** The model this round must arrive on, so a wrong pair fails here. */
  readonly model: string
  /** The tool call this round must be answering, or null for an opening turn. */
  readonly answering: string | null
  readonly reply:
    | { readonly kind: 'tool'; readonly id: string; readonly artifact: string; readonly content: string }
    | { readonly kind: 'text'; readonly text: string }
  /** Read before the reply is written, so it observes a genuine barrier. */
  readonly observe?: () => void
}

interface CoordinatorProvider {
  readonly baseUrl: string
  readonly rounds: () => ProviderRound[]
  readonly violations: () => string[]
  readonly close: () => Promise<void>
}

function sse(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`
}

function messageStart(model: string): string {
  return sse('message_start', {
    message: {
      id: `msg_${model}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
}

function textTurn(model: string, text: string): string {
  return [
    messageStart(model),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', {}),
  ].join('')
}

/** One `write` call, streamed the way the Messages API streams a tool use. */
function writeToolTurn(
  model: string,
  toolCallId: string,
  artifact: string,
  content: string,
): string {
  const input = JSON.stringify({ path: artifact, content })
  return [
    messageStart(model),
    sse('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: toolCallId, name: 'write', input: {} },
    }),
    sse('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: input },
    }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', {
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', {}),
  ].join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The tool calls this request is answering, by id.
 *
 * Read from the last user message only. A substring search over the whole
 * accumulated history would still match A's first round once B is running, so
 * it could not tell an opening turn from a continuation.
 */
function readAnsweredToolCallIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return []
  const last = body.messages[body.messages.length - 1]
  if (!isRecord(last) || !Array.isArray(last.content)) return []
  const ids: string[] = []
  for (const part of last.content) {
    if (!isRecord(part) || part.type !== 'tool_result') continue
    const id = part.tool_use_id
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

function readRequestedModel(body: unknown): string {
  if (!isRecord(body) || typeof body.model !== 'string') return '<no model>'
  return body.model
}

async function startCoordinatorProvider(
  script: readonly ScriptedTurn[],
): Promise<CoordinatorProvider> {
  const rounds: ProviderRound[] = []
  const violations: string[] = []

  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    request.on('end', () => {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        violations.push(`round ${rounds.length + 1}: body was not JSON`)
      }
      const model = readRequestedModel(parsed)
      const toolResultIds = readAnsweredToolCallIds(parsed)
      const index = rounds.length
      rounds.push({ model, toolResultIds })

      const expected = script[index]
      if (!expected) {
        violations.push(
          `round ${index + 1}: unscripted request on ${model}; the run asked for more turns than the journey has`,
        )
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('unscripted round')
        return
      }
      if (model !== expected.model) {
        violations.push(
          `round ${index + 1}: expected model ${expected.model}, got ${model}`,
        )
      }
      const answering = expected.answering
      if (answering === null) {
        if (toolResultIds.length > 0) {
          violations.push(
            `round ${index + 1}: expected an opening turn, got results for ${toolResultIds.join(',')}`,
          )
        }
      } else if (!toolResultIds.includes(answering)) {
        violations.push(
          `round ${index + 1}: expected the result of ${answering}, got [${toolResultIds.join(',')}]`,
        )
      }

      expected.observe?.()

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      response.end(
        expected.reply.kind === 'tool'
          ? writeToolTurn(
              expected.model,
              expected.reply.id,
              expected.reply.artifact,
              expected.reply.content,
            )
          : textTurn(expected.model, expected.reply.text),
      )
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(
    address && typeof address === 'object',
    'the coordinator provider must have a port',
  )

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    rounds: () => [...rounds],
    violations: () => [...violations],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// ── The fixture on disk ──────────────────────────────────────────────────────

function writePersona(filePath: string, name: string, model: string): void {
  fs.writeFileSync(
    filePath,
    `---
name: ${name}
description: ${name} persona.
provider: ${PROVIDER}
model: ${model}
thinking: low
---

You are ${name}.
`,
  )
}

/**
 * Two routing levels, each gated on the artifact its own coordinator writes.
 *
 * Routing rather than discussion: a discussion level cannot become ready
 * without an approved roster (`team-runtime/level-lifecycle.ts:247`), while a
 * routing level is ready exactly when its declared output exists (`:220`). Each
 * persona lists `write`, which is what registers the governed Pi `write`
 * (`team-runtime/index.ts:1505`) bound to the assignment directory.
 */
function writeTeam(
  teamRoot: string,
  bModel: string = B_MODEL,
  /**
   * What the reviewer's terminal gate asks for.
   *
   * Normally the artifact the level itself declares, so readiness and the gate
   * coincide. A journey that needs the gate to *fail* while the level is ready
   * points it at a different file: a routing level is only ready for its gate
   * once its declared output exists (`team-runtime/level-lifecycle.ts:786`), so
   * a gate on the same file can never be evaluated and found wanting.
   */
  reviewGateArtifact: string = B_ARTIFACT,
): void {
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  writePersona(path.join(teamRoot, 'agents', 'lead.md'), A_COORDINATOR, A_MODEL)
  writePersona(path.join(teamRoot, 'agents', 'auditor.md'), B_COORDINATOR, bModel)
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: print-handover-team
  description: Two routing levels whose coordinators hand over inside one run.

workspace:
  path: workspace
  watch: false

agents:
  - name: ${A_COORDINATOR}
    type: agent
    role: Coordinates the draft.
    tier: orchestration
    tools:
      - write
    produces:
      - path: ${A_ARTIFACT}
    agent_file: ./agents/lead.md
  - name: ${B_COORDINATOR}
    type: agent
    role: Coordinates the review.
    tier: orchestration
    tools:
      - write
    produces:
      - path: ${B_ARTIFACT}
${reviewGateArtifact === B_ARTIFACT ? '' : `      - path: ${reviewGateArtifact}\n`}    agent_file: ./agents/auditor.md

levels:
  - id: ${A_LEVEL}
    name: Draft
    order: 0
    stage:
      type: routing
      coordinator: ${A_COORDINATOR}
      config:
        output:
          format: ${A_ARTIFACT}
          user_review: false
  - id: ${B_LEVEL}
    name: Review
    order: 1
    stage:
      type: routing
      coordinator: ${B_COORDINATOR}
      config:
        output:
          format: ${B_ARTIFACT}
          user_review: false

gates:
  - from: ${A_LEVEL}
    to: ${B_LEVEL}
    condition:
      type: artifact_exists
      artifact: ${A_ARTIFACT}
  - from: ${B_LEVEL}
    to: done
    condition:
      type: artifact_exists
      artifact: ${reviewGateArtifact}

workflow:
  entry_level: ${A_LEVEL}
`,
  )
}

/**
 * The agent directory the launch copies from.
 *
 * `isolatePiAgentDirectory` reads `getAgentDir()` — this process's
 * `PI_CODING_AGENT_DIR` — and copies its credentials, models and settings into
 * a private directory for the child (`domains/run/pi-agent-isolation.ts`). So
 * this is what the child ends up with, one copy removed.
 */
function writeSourceAgentDirectory(agentDir: string, baseUrl: string): void {
  fs.mkdirSync(agentDir, { recursive: true })
  const model = (id: string): Record<string, unknown> => ({
    id,
    name: id,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
  })
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          [PROVIDER]: {
            baseUrl,
            api: 'anthropic-messages',
            // Not credential-shaped, and never sent anywhere but loopback. The
            // adapter wants some key present; this says plainly it is not one.
            apiKey: 'loopback-no-credential',
            models: [
              model(A_MODEL),
              model(B_MODEL),
              model(RECOVERY_DEFAULT_MODEL),
            ],
          },
        },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: PROVIDER, defaultModel: A_MODEL }),
  )
  fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}', { mode: 0o600 })
}

// ── Durable evidence ─────────────────────────────────────────────────────────

interface RuntimeEvent {
  readonly event: string
  readonly [key: string]: unknown
}

function readEvents(assignmentPath: string, file: string): RuntimeEvent[] {
  const filePath = path.join(assignmentPath, 'logs', file)
  if (!fs.existsSync(filePath)) return []
  const events: RuntimeEvent[] = []
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const parsed: unknown = JSON.parse(line)
    if (isRecord(parsed) && typeof parsed.event === 'string') {
      events.push({ ...parsed, event: parsed.event })
    }
  }
  return events
}

/**
 * The run's own record of every level it left, and why.
 *
 * A checkpoint would be the obvious place to read the run's position from, but
 * a run that finishes deletes its checkpoint, so the only durable record of a
 * completed handover is this log.
 */
function readTransitions(assignmentPath: string): Array<Record<string, unknown>> {
  const filePath = path.join(assignmentPath, 'logs', 'level-transitions.jsonl')
  if (!fs.existsSync(filePath)) return []
  const transitions: Array<Record<string, unknown>> = []
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const parsed: unknown = JSON.parse(line)
    if (isRecord(parsed)) transitions.push(parsed)
  }
  return transitions
}

/** An artifact's content, or a word that is not content, for a clear message. */
function readArtifact(assignmentPath: string, artifact: string): string {
  const filePath = path.join(assignmentPath, artifact)
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '<absent>'
}

/** What a coordinator was actually run on, as the run recorded it at dispatch. */
function coordinatorRuns(
  assignmentPath: string,
): Array<{ agent: string; provider: string; model: string }> {
  return readEvents(assignmentPath, 'agent-runs.jsonl')
    .filter((event) => event.event === 'start')
    .map((event) => ({
      agent: String(event.agent_name),
      provider: String(event.provider),
      model: String(event.model),
    }))
}

/**
 * A second coordinator that names no model of its own.
 *
 * Which is the point: an Agent in app-default mode takes the one deliberately
 * saved application default, and that default reaches the host process through
 * its environment. So the pair this coordinator runs on is a property of the
 * launch, and two launches can legitimately disagree about it — which is
 * exactly the disagreement a resumed entry must not silently take.
 */
function writeAppDefaultPersona(filePath: string, name: string): void {
  fs.writeFileSync(
    filePath,
    `---
name: ${name}
description: ${name} persona.
thinking: low
---

You are ${name}.
`,
  )
}

/** The two-level team, with the reviewer inheriting the application default. */
function writeAppDefaultReviewerTeam(
  teamRoot: string,
  reviewGateArtifact: string = B_ARTIFACT,
): void {
  writeTeam(teamRoot, B_MODEL, reviewGateArtifact)
  writeAppDefaultPersona(
    path.join(teamRoot, 'agents', 'auditor.md'),
    B_COORDINATOR,
  )
}

/** The application default, in the shape the launcher hands to a child. */
function appDefaultEnvironment(model: string): Record<string, string> {
  return {
    PIPELINE_DEFAULT_MODEL_SELECTION: Buffer.from(
      JSON.stringify({ status: 'available', provider: PROVIDER, model }),
      'utf8',
    ).toString('base64'),
  }
}

/** The admission the run left behind, read the way the runtime reads it. */
function readAdmission(assignmentPath: string): unknown {
  const { checkpointPath } = getRunRuntimePaths(assignmentPath)
  if (!fs.existsSync(checkpointPath)) return undefined
  const parsed: unknown = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
  if (!isRecord(parsed)) return undefined
  return parsed.hostEntryAdmission
}

// ── The journey ──────────────────────────────────────────────────────────────

interface ManagedHostRun {
  readonly assignmentPath: string
  readonly exitCode: number | null
  readonly exitSignal: string | null
  readonly rounds: ProviderRound[]
  readonly violations: string[]
  /** Every named runtime and host event, in order, for a failure message. */
  readonly diagnosis: string
}

/**
 * Start one managed Team host through the real desktop launcher and wait for it.
 *
 * Everything the product does is left alone. The injected spawn forwards the
 * command, arguments, environment, detached flag and ignored stdio verbatim; it
 * exists only so the test can hold the child, wait for it, and reap it on every
 * path. The launch composes `process.env`, so the hermetic child environment is
 * arranged on this process and restored before returning — including
 * `PI_CODING_AGENT_DIR`, which the isolation reads through `getAgentDir()`
 * before any request or provider environment is applied
 * (`domains/run/run-launcher.ts:136`).
 */
interface ManagedTeamFixture {
  readonly fixtureRoot: string
  readonly teamRoot: string
  readonly workspace: string
  readonly sourceAgentDirectory: string
  readonly assignmentPath: string
  readonly sessionId: string
  readonly dispose: () => void
}

/**
 * The workspace, team and agent directory one run — or several — will use.
 *
 * Separated from the launch so a journey can start a second host against the
 * same assignment. That is what a recovery is: the same directories, the same
 * session identity, a different process.
 */
async function createManagedTeamFixture(options: {
  readonly fixturePrefix: string
  readonly sessionId: string
  readonly writeFixture: (paths: {
    readonly teamRoot: string
    readonly sourceAgentDirectory: string
  }) => void
}): Promise<ManagedTeamFixture> {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), options.fixturePrefix)),
  )
  const teamRoot = path.join(fixtureRoot, 'team')
  const workspace = path.join(fixtureRoot, 'workspace')
  const sourceAgentDirectory = path.join(fixtureRoot, 'source-agent-dir')
  const { sessionId } = options
  const assignmentPath = path.join(
    workspace,
    'sessions',
    sessionId,
    'runs',
    `run-${sessionId}`,
    'assignments',
    `assignment-${sessionId}`,
  )

  // Created and canonicalised before the pin, so the pin lands in a directory
  // that exists rather than creating a second one beside it.
  fs.mkdirSync(assignmentPath, { recursive: true })
  await reconcileWorkspaceTenantPin({
    workspacePath: workspace,
    tenantId: 'local',
    mode: 'authoritative',
  })
  options.writeFixture({ teamRoot, sourceAgentDirectory })

  return {
    fixtureRoot,
    teamRoot,
    workspace,
    sourceAgentDirectory,
    assignmentPath,
    sessionId,
    dispose: () => fs.rmSync(fixtureRoot, { recursive: true, force: true }),
  }
}

/**
 * Start one managed Team host through the real desktop launcher and wait for it.
 *
 * Everything the product does is left alone. The injected spawn forwards the
 * command, arguments, environment, detached flag and ignored stdio verbatim; it
 * exists only so the test can hold the child, wait for it, and reap it on every
 * path. The launch composes `process.env`, so the hermetic child environment is
 * arranged on this process and restored before returning — including
 * `PI_CODING_AGENT_DIR`, which the isolation reads through `getAgentDir()`
 * before any request or provider environment is applied
 * (`domains/run/run-launcher.ts:136`).
 */
async function launchManagedTeamHost(options: {
  readonly fixture: ManagedTeamFixture
  readonly rounds: () => ProviderRound[]
  readonly violations: () => string[]
  /** Reaches the child verbatim: `DesktopRunLauncher` spreads it over its own. */
  readonly extraEnv?: Record<string, string>
  readonly watchdogMs?: number
}): Promise<ManagedHostRun> {
  const { fixture } = options
  const { assignmentPath, sessionId, teamRoot, workspace } = fixture

  const restoreEnvironment = new Map<string, string | undefined>()
  const setEnvironment = (name: string, value: string | undefined): void => {
    if (!restoreEnvironment.has(name)) restoreEnvironment.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const restore = (): void => {
    for (const [name, value] of restoreEnvironment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    restoreEnvironment.clear()
  }
  setEnvironment('PI_CODING_AGENT_DIR', fixture.sourceAgentDirectory)
  setEnvironment(
    'TEAM_RUNTIME_EXTENSION_ENTRY',
    path.join(repoRoot, 'team-runtime', 'index.ts'),
  )
  setEnvironment('TEAM_DELEGATED_AUTOSTART', undefined)
  setEnvironment('TEAM_CHAT_MODE', undefined)
  for (const name of PROVIDER_CREDENTIAL_VARIABLES) setEnvironment(name, undefined)

  let child: ChildProcess | undefined
  let closed: Promise<unknown> | undefined
  let watchdog: NodeJS.Timeout | undefined

  const abandon = (): void => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    restore()
  }

  try {
    /** Forwards the real launch verbatim and keeps a handle on its child. */
    const spawnProcess: SpawnDetachedProcess = (command, args, spawnOptions) => {
      child = spawn(command, [...args], spawnOptions)
      // Registered before the child is handed back, so a fast child cannot end
      // before anyone is listening.
      closed = once(child, 'close')
      return toDetachedProcess(child)
    }
    const providerSettings: RuntimeEnvironmentSource = {
      async runtimeEnvironment(): Promise<NodeJS.ProcessEnv> {
        return {}
      },
    }

    const launcher = new DesktopRunLauncher(repoRoot, providerSettings, spawnProcess)
    const launched = await launcher.startRun({
      cwd: assignmentPath,
      env: {
        TEAM_CONFIG_PATH: path.join(teamRoot, 'team.yaml'),
        TEAM_WORKSPACE_PATH: workspace,
        TEAM_RUNTIME_SESSION_ID: sessionId,
        TEAM_RUNTIME_RUN_ID: `run-${sessionId}`,
        TEAM_RUNTIME_ASSIGNMENT_ID: `assignment-${sessionId}`,
        // Governed tools refuse to register without a capability authority
        // (`team-runtime/runtime-capability-context.ts:39`), and a level that
        // cannot arm its stage never gets as far as a handover.
        TEAM_RUNTIME_TASK_ID: `task-${sessionId}`,
        TEAM_RUNTIME_PROCESS_IDENTITY: `process-${sessionId}`,
        TEAM_SESSION_ID: `assignment-${sessionId}`,
        TEAM_ROOT_SESSION_ID: sessionId,
        TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser/index.ts'),
        // Exact paths, so PATH cannot choose another Pi or another Node.
        TEAM_RUNTIME_PI_CLI_PATH: path.join(
          repoRoot,
          'node_modules',
          '@earendil-works',
          'pi-coding-agent',
          'dist',
          'cli.js',
        ),
        TEAM_RUNTIME_PI_NODE_PATH: process.execPath,
        ...options.extraEnv,
      },
    })
    assert.equal(launched.launched, true, 'the desktop launch must start a child')
    assert.ok(child, 'the launch must have started a child')
    assert.ok(closed, 'the launch must expose the child it started')

    // The launcher unrefs a detached child, which is right for a run and wrong
    // for a test waiting on it.
    child.ref()
    const observedChild = child
    watchdog = setTimeout(() => {
      try {
        observedChild.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, options.watchdogMs ?? 25_000)
    const [exitCode, exitSignal] = (await closed) as [number | null, string | null]
    clearTimeout(watchdog)
    watchdog = undefined
    // Restored as soon as the child is gone, so an assertion failure below
    // cannot leave this process holding the fixture's environment.
    restore()

    const runtimeEvents = readEvents(assignmentPath, 'runtime-events.jsonl')
    const hostEvents = readEvents(assignmentPath, 'host-events.jsonl')
    return {
      assignmentPath,
      exitCode,
      exitSignal,
      rounds: options.rounds(),
      violations: options.violations(),
      diagnosis:
        `exit ${exitCode}/${exitSignal}; ` +
        `provider rounds ${JSON.stringify(options.rounds())}; ` +
        `runtime ${runtimeEvents.map((event) => event.event).join(',')}; ` +
        `host ${hostEvents.map((event) => event.event).join(',')}`,
    }
  } catch (error) {
    abandon()
    throw error
  }
}

async function runManagedTeamHost(options: {
  readonly fixturePrefix: string
  readonly sessionId: string
  readonly providerBaseUrl: string
  readonly rounds: () => ProviderRound[]
  readonly violations: () => string[]
  /** Written to disk before the launch, given the fixture's own directories. */
  readonly writeFixture: (paths: {
    readonly teamRoot: string
    readonly sourceAgentDirectory: string
  }) => void
  /** Somewhere for the caller to record what it saw while the run was live. */
  readonly onAssignmentPath?: (assignmentPath: string) => void
  readonly extraEnv?: Record<string, string>
  readonly watchdogMs?: number
}): Promise<{ run: ManagedHostRun; dispose: () => void }> {
  const fixture = await createManagedTeamFixture({
    fixturePrefix: options.fixturePrefix,
    sessionId: options.sessionId,
    writeFixture: options.writeFixture,
  })
  options.onAssignmentPath?.(fixture.assignmentPath)
  try {
    const run = await launchManagedTeamHost({
      fixture,
      rounds: options.rounds,
      violations: options.violations,
      ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv }),
      ...(options.watchdogMs === undefined ? {} : { watchdogMs: options.watchdogMs }),
    })
    return { run, dispose: fixture.dispose }
  } catch (error) {
    fixture.dispose()
    throw error
  }
}

test(
  'a managed Team run reaches its second coordinator on its own model and finishes its work before the run succeeds',
  { timeout: 60_000, skip: process.platform === 'win32' },
  async () => {
    /**
     * What the run had recorded when B's last provider round arrived.
     *
     * B is unfinished at that moment: its artifact is not written and its final
     * response has not been consumed. A terminal success already on disk would
     * mean the run called itself done while its last coordinator was still
     * speaking.
     */
    let completedBeforeBFinished: string[] = []
    let observedAssignmentPath = ''

    const provider = await startCoordinatorProvider([
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
      {
        model: A_MODEL,
        answering: 'toolu_a1',
        reply: { kind: 'text', text: 'A_FINISHED' },
      },
      {
        model: B_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_b1', artifact: B_ARTIFACT, content: B_CONTENT },
      },
      {
        model: B_MODEL,
        answering: 'toolu_b1',
        reply: { kind: 'text', text: B_FINAL_TEXT },
        observe: () => {
          completedBeforeBFinished = readEvents(
            observedAssignmentPath,
            'runtime-events.jsonl',
          )
            .filter((event) => event.event === 'run.completed')
            .map((event) => String(event.event))
        },
      },
    ])

    let started: Awaited<ReturnType<typeof runManagedTeamHost>> | undefined
    try {
      started = await runManagedTeamHost({
        fixturePrefix: 'print-handover-',
        sessionId: 'print-handover',
        providerBaseUrl: provider.baseUrl,
        rounds: provider.rounds,
        violations: provider.violations,
        onAssignmentPath: (assignmentPath) => {
          observedAssignmentPath = assignmentPath
        },
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeTeam(teamRoot)
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
      })
      const { run } = started
      const { assignmentPath, rounds, diagnosis } = run
      const runtimeEvents = readEvents(assignmentPath, 'runtime-events.jsonl')

      // ── A: the run must actually start before a handover can be judged ────
      assert.ok(
        rounds.length >= 1,
        `the run must reach its first coordinator at all; ${diagnosis}`,
      )
      assert.equal(
        rounds[0]?.model,
        A_MODEL,
        `the first coordinator must speak on its own admitted model; ${diagnosis}`,
      )
      assert.equal(
        readArtifact(assignmentPath, A_ARTIFACT),
        A_CONTENT,
        `the first coordinator's governed write must land in the assignment; ${diagnosis}`,
      )
      assert.deepEqual(
        coordinatorRuns(assignmentPath)[0],
        { agent: A_COORDINATOR, provider: PROVIDER, model: A_MODEL },
        `the first turn must be recorded against its own coordinator and pair; ${diagnosis}`,
      )

      // ── A → B: the handover must be recorded and durable ──────────────────
      // The terminal gate ends the run rather than opening a level, so it is
      // recorded as the run's completion below, not as a transition.
      assert.deepEqual(
        readTransitions(assignmentPath).map((entry) => ({
          move: `${entry.from}->${entry.to}`,
          gate: entry.gate_type,
        })),
        [{ move: `${A_LEVEL}->${B_LEVEL}`, gate: 'artifact_exists' }],
        `the handover must be recorded, and through the gate A satisfied; ${diagnosis}`,
      )

      // ── B: the handover must be taken, on B's own pair, to completion ─────
      assert.equal(
        rounds[2]?.model,
        B_MODEL,
        `the second coordinator must take its turn on its own admitted model; ${diagnosis}`,
      )
      assert.equal(
        readArtifact(assignmentPath, B_ARTIFACT),
        B_CONTENT,
        `the second coordinator's own artifact must exist; ${diagnosis}`,
      )
      assert.deepEqual(
        coordinatorRuns(assignmentPath)[1],
        { agent: B_COORDINATOR, provider: PROVIDER, model: B_MODEL },
        `the second turn must be recorded against the second coordinator and its own pair; ${diagnosis}`,
      )
      assert.equal(
        rounds.length,
        4,
        `each coordinator takes exactly one tool round and one closing round; ${diagnosis}`,
      )
      assert.deepEqual(
        run.violations,
        [],
        `every provider round must match its scripted model and tool result; ${diagnosis}`,
      )

      // ── Terminal state: success after B, not before ───────────────────────
      assert.deepEqual(
        completedBeforeBFinished,
        [],
        `the run must not record success while its last coordinator is still speaking; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.completed').length,
        1,
        `the run must record exactly one terminal success; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.incomplete').length,
        0,
        `a run that finished both levels must not also record itself incomplete; ${diagnosis}`,
      )

      // ── One logical entry per level, however many provider rounds it took ─
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.event === 'runtime.follow_up_dispatched')
          .map((event) => event.target_level_id),
        [A_LEVEL, B_LEVEL],
        `each level is entered exactly once, in order; ${diagnosis}`,
      )
    } finally {
      started?.dispose()
      await provider.close()
    }
  },
)

test(
  'a managed Team run whose next level cannot be entered fails and ends, rather than waiting',
  { timeout: 60_000, skip: process.platform === 'win32' },
  async () => {
    // The failure this run is built to produce is the one that used to strand a
    // host: the settle that hands over cannot put the host on B's pair, so it
    // discards the queued entry, records the failure and releases the turn —
    // and no later settle is coming to notice the host has nothing left to wait
    // for. B's persona names a model the run's own `models.json` does not offer,
    // which is refused at exactly that moment and not before: startup only
    // checks the level it starts on.
    const provider = await startCoordinatorProvider([
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
      {
        model: A_MODEL,
        answering: 'toolu_a1',
        reply: { kind: 'text', text: 'A_FINISHED' },
      },
    ])

    let started: Awaited<ReturnType<typeof runManagedTeamHost>> | undefined
    try {
      started = await runManagedTeamHost({
        fixturePrefix: 'print-handover-blocked-',
        sessionId: 'print-handover-blocked',
        providerBaseUrl: provider.baseUrl,
        rounds: provider.rounds,
        violations: provider.violations,
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeTeam(teamRoot, 'loopback-not-offered')
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
      })
      const { run } = started
      const { assignmentPath, rounds, diagnosis } = run
      const runtimeEvents = readEvents(assignmentPath, 'runtime-events.jsonl')

      // The run has to get far enough for the handover to be the thing that
      // fails, or this proves nothing about the handover.
      assert.equal(
        readArtifact(assignmentPath, A_ARTIFACT),
        A_CONTENT,
        `the first coordinator must finish its own work first; ${diagnosis}`,
      )
      assert.deepEqual(
        readTransitions(assignmentPath).map((entry) => `${entry.from}->${entry.to}`),
        [`${A_LEVEL}->${B_LEVEL}`],
        `the run must reach the handover it then cannot complete; ${diagnosis}`,
      )

      // The claim: it ends, and it ends saying the run failed.
      assert.notEqual(
        run.exitSignal,
        'SIGKILL',
        `a host that cannot enter its next level must end on its own, not be killed; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.failed').length,
        1,
        `the run must record exactly one terminal failure; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.completed').length,
        0,
        `a run that could not enter its next level did not succeed; ${diagnosis}`,
      )
      assert.equal(
        rounds.length,
        2,
        `the second coordinator must never be given a turn; ${diagnosis}`,
      )
      assert.equal(
        readArtifact(assignmentPath, B_ARTIFACT),
        '<absent>',
        `no work may be done for a level the host could not enter; ${diagnosis}`,
      )
    } finally {
      started?.dispose()
      await provider.close()
    }
  },
)

test(
  'a managed Team run interrupted with its next coordinator queued resumes it once, on the pair it was admitted with',
  { timeout: 120_000, skip: process.platform === 'win32' },
  async () => {
    // The reviewer names no model of its own, so its pair is the application
    // default the *launch* supplies. The first process is given `loopback-b`
    // and the second `loopback-c` — both real, both runnable — so a resumed
    // entry that re-resolved its pair would proceed happily on the wrong one.
    // That is the whole point: after a crash, "resolve it again" and "resume it"
    // are different answers, and only one of them is what the run admitted.
    const provider = await startCoordinatorProvider([
      // Process 1: the first coordinator's only round. Its `write` satisfies
      // the gate, the handover is recorded, and the cut lands before its reply.
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
      // Process 2: the resumed reviewer, on the pair process 1 admitted.
      {
        model: B_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_b1', artifact: B_ARTIFACT, content: B_CONTENT },
      },
      {
        model: B_MODEL,
        answering: 'toolu_b1',
        reply: { kind: 'text', text: B_FINAL_TEXT },
      },
    ])

    let fixture: ManagedTeamFixture | undefined
    try {
      fixture = await createManagedTeamFixture({
        fixturePrefix: 'print-handover-pending-cut-',
        sessionId: 'print-handover-pending-cut',
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeAppDefaultReviewerTeam(teamRoot)
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
      })
      const { assignmentPath } = fixture

      // ── The cut: the handover is durable, its entry has not been sent ─────
      const interrupted = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: {
          ...appDefaultEnvironment(B_MODEL),
          TEAM_RUNTIME_FAULT_INJECT: `crash_after_host_admission_pending:${B_LEVEL}`,
        },
      })

      assert.equal(
        interrupted.exitSignal,
        'SIGKILL',
        `the first process must be cut, not allowed to finish; ${interrupted.diagnosis}`,
      )
      assert.deepEqual(
        readTransitions(assignmentPath).map((entry) => `${entry.from}->${entry.to}`),
        [`${A_LEVEL}->${B_LEVEL}`],
        `the handover must have reached the disk before the cut; ${interrupted.diagnosis}`,
      )
      assert.deepEqual(
        readHostEntryAdmission(readAdmission(assignmentPath)),
        {
          kind: 'admission',
          admission: {
            levelId: B_LEVEL,
            visit: 0,
            state: 'pending',
            selection: {
              provider: PROVIDER,
              model: B_MODEL,
              source: 'app-default',
              reason: 'agent-default',
              caller: 'agent',
            },
          },
        },
        `the interrupted run must have recorded the entry it owed, and the pair it owed it on; ${interrupted.diagnosis}`,
      )

      // ── The recovery: a second process, a different application default ───
      const resumed = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: appDefaultEnvironment(RECOVERY_DEFAULT_MODEL),
      })
      const { diagnosis } = resumed
      const runtimeEvents = readEvents(assignmentPath, 'runtime-events.jsonl')

      assert.deepEqual(
        resumed.violations,
        [],
        `every provider round must match its scripted model and tool result; ${diagnosis}`,
      )
      assert.equal(
        resumed.rounds.length,
        3,
        `the resumed run must take the reviewer's two rounds and no others; ${diagnosis}`,
      )
      assert.equal(
        resumed.rounds[1]?.model,
        B_MODEL,
        `the resumed coordinator must speak on the pair it was admitted with, not the current default; ${diagnosis}`,
      )
      assert.equal(
        resumed.rounds.filter((round) => round.model === RECOVERY_DEFAULT_MODEL).length,
        0,
        `no round may run on the application default this process happens to have been given; ${diagnosis}`,
      )
      assert.equal(
        resumed.rounds.filter((round) => round.model === A_MODEL).length,
        1,
        `the first coordinator must not be run again; its single round belongs to the interrupted process; ${diagnosis}`,
      )
      assert.equal(
        readArtifact(assignmentPath, A_ARTIFACT),
        A_CONTENT,
        `the first coordinator's completed work must survive the interruption untouched; ${diagnosis}`,
      )
      assert.equal(
        readArtifact(assignmentPath, B_ARTIFACT),
        B_CONTENT,
        `the resumed coordinator must finish its own work; ${diagnosis}`,
      )
      // The record has to agree with what happened. A resumed turn whose
      // history named the application default this process was given would be
      // describing a model the run never used — the exact confusion between
      // "what Settings says now" and "what this attempt ran on" that the whole
      // selection contract exists to remove.
      assert.deepEqual(
        coordinatorRuns(assignmentPath),
        [
          { agent: A_COORDINATOR, provider: PROVIDER, model: A_MODEL },
          { agent: B_COORDINATOR, provider: PROVIDER, model: B_MODEL },
        ],
        `each coordinator's turn must be recorded against the pair it actually ran on; ${diagnosis}`,
      )
      assert.deepEqual(
        readEvents(assignmentPath, 'agent-runs.jsonl')
          .filter((event) => event.event === 'start')
          .map((event) => event.model_selection),
        [
          {
            provider: PROVIDER,
            model: A_MODEL,
            source: 'agent',
            reason: 'explicit-agent-choice',
            caller: 'agent',
          },
          {
            provider: PROVIDER,
            model: B_MODEL,
            source: 'app-default',
            reason: 'agent-default',
            caller: 'agent',
          },
        ],
        `the resumed turn's recorded provenance must name the pair it was admitted with, not the default this process was given; ${diagnosis}`,
      )
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.event === 'runtime.follow_up_dispatched')
          .map((event) => event.target_level_id),
        [A_LEVEL, B_LEVEL],
        `each level must be entered exactly once across both processes; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.completed').length,
        1,
        `the resumed run must record exactly one terminal success; ${diagnosis}`,
      )

      // ── Two processes, two identities ─────────────────────────────────────
      //
      // The host's turn counter restarts at 0 in every process, and a recovered
      // run deliberately keeps its session id — so the turn before the cut and
      // the first turn after it are both "turn 1 of this run". Anything that
      // reads these records to say what happened needs a value that tells the
      // two processes apart, or it merges them and reports one coordinator
      // where two ran.
      const hostStarts = readEvents(assignmentPath, 'host-events.jsonl').filter(
        (event) => event.event === 'host.agent_start',
      )
      assert.ok(
        hostStarts.length >= 2,
        `both processes must have started a host turn; ${diagnosis}`,
      )
      assert.equal(
        hostStarts.filter(
          (event) =>
            typeof event.host_instance_id === 'string' &&
            event.host_instance_id.length > 0,
        ).length,
        hostStarts.length,
        `every host turn must record which process it belonged to; ${diagnosis}`,
      )
      assert.equal(
        new Set(hostStarts.map((event) => event.host_instance_id)).size,
        2,
        `the interrupted process and the one that resumed it must be distinguishable; ${diagnosis}`,
      )
      // And a process does not change identity between its own turns: the
      // interrupted one ran only the first coordinator, the recovered one only
      // the second.
      assert.deepEqual(
        [
          ...new Set(
            hostStarts
              .filter((event) => event.coordinator === A_COORDINATOR)
              .map((event) => event.host_instance_id),
          ),
        ].length,
        1,
        `one process's turns must share one identity; ${diagnosis}`,
      )
    } finally {
      fixture?.dispose()
      await provider.close()
    }
  },
)

test(
  'a managed Team run interrupted after its next coordinator was handed over does not give it a second turn',
  { timeout: 120_000, skip: process.platform === 'win32' },
  async () => {
    // The cut here lands one moment later, and that moment changes the answer.
    // The entry has been handed to the host, and `sendUserMessage` returns
    // `void` with its refusal on Pi's own error channel — so nothing durable
    // can say whether a turn started, called tools, published messages or
    // charged a model. The recorded state is `dispatching`, and a `dispatching`
    // entry reduces to indeterminate: the run stays interrupted rather than
    // being replayed, failed, or reported complete.
    //
    // The provider is scripted with the first coordinator's two rounds and
    // nothing else, so any request the second process makes is an unscripted
    // round and is recorded as a violation.
    const provider = await startCoordinatorProvider([
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
      {
        model: A_MODEL,
        answering: 'toolu_a1',
        reply: { kind: 'text', text: 'A_FINISHED' },
      },
    ])

    let fixture: ManagedTeamFixture | undefined
    try {
      fixture = await createManagedTeamFixture({
        fixturePrefix: 'print-handover-ambiguous-cut-',
        sessionId: 'print-handover-ambiguous-cut',
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeAppDefaultReviewerTeam(teamRoot)
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
      })
      const { assignmentPath } = fixture

      const interrupted = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: {
          ...appDefaultEnvironment(B_MODEL),
          TEAM_RUNTIME_FAULT_INJECT: `crash_after_host_admission_dispatch:${B_LEVEL}`,
        },
      })

      assert.equal(
        interrupted.exitSignal,
        'SIGKILL',
        `the first process must be cut after the handover was sent; ${interrupted.diagnosis}`,
      )
      assert.deepEqual(
        readHostEntryAdmission(readAdmission(assignmentPath)),
        {
          kind: 'admission',
          admission: {
            levelId: B_LEVEL,
            visit: 0,
            state: 'dispatching',
            selection: {
              provider: PROVIDER,
              model: B_MODEL,
              source: 'app-default',
              reason: 'agent-default',
              caller: 'agent',
            },
          },
        },
        `the cut must leave the entry recorded as handed over; ${interrupted.diagnosis}`,
      )

      const roundsBeforeRecovery = provider.rounds().length
      const recovered = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: appDefaultEnvironment(B_MODEL),
      })
      const { diagnosis } = recovered
      const runtimeEvents = readEvents(assignmentPath, 'runtime-events.jsonl')
      const hostEvents = readEvents(assignmentPath, 'host-events.jsonl')

      assert.equal(
        recovered.rounds.length,
        roundsBeforeRecovery,
        `a run whose entry may already have taken a turn must make no provider request at all; ${diagnosis}`,
      )
      assert.deepEqual(
        recovered.violations,
        [],
        `no unscripted round may reach the provider; ${diagnosis}`,
      )
      assert.equal(
        readArtifact(assignmentPath, B_ARTIFACT),
        '<absent>',
        `no work may be done for an entry whose outcome cannot be established; ${diagnosis}`,
      )
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.event === 'runtime.follow_up_dispatched')
          .map((event) => event.target_level_id),
        [A_LEVEL, B_LEVEL],
        `the recovered process must dispatch nothing; the two entries are the interrupted run's; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.completed').length,
        0,
        `a run that could not establish what its entry did did not succeed; ${diagnosis}`,
      )
      assert.equal(
        hostEvents.filter(
          (event) => event.event === 'host.entry_admission.indeterminate',
        ).length,
        1,
        `the recovered process must say, durably, which entry it refused to repeat; ${diagnosis}`,
      )
      assert.notEqual(
        recovered.exitSignal,
        'SIGKILL',
        `the recovered host must end on its own rather than be killed by the watchdog; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.incomplete').length,
        1,
        `the run must be left interrupted, which is what it is; ${diagnosis}`,
      )
    } finally {
      fixture?.dispose()
      await provider.close()
    }
  },
)

test(
  'a managed Team run whose saved host entry cannot be read refuses to start it, and leaves that record intact',
  { timeout: 120_000, skip: process.platform === 'win32' },
  async () => {
    // Failing closed is only worth anything if it lasts. A process that refuses
    // to act on a record it cannot read must also not overwrite it — otherwise
    // the refusal survives exactly one restart, and the run it was protecting
    // is resumed blindly by the next one.
    const provider = await startCoordinatorProvider([
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
    ])

    let fixture: ManagedTeamFixture | undefined
    try {
      fixture = await createManagedTeamFixture({
        fixturePrefix: 'print-handover-unreadable-',
        sessionId: 'print-handover-unreadable',
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeAppDefaultReviewerTeam(teamRoot)
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
      })
      const { assignmentPath } = fixture

      const interrupted = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: {
          ...appDefaultEnvironment(B_MODEL),
          TEAM_RUNTIME_FAULT_INJECT: `crash_after_host_admission_pending:${B_LEVEL}`,
        },
      })
      assert.equal(
        interrupted.exitSignal,
        'SIGKILL',
        `the first process must be cut with its next entry recorded; ${interrupted.diagnosis}`,
      )

      // A record written by something this build does not understand. It comes
      // off disk untrusted, which is the whole reason the reader distinguishes
      // "cannot be read" from "was never written".
      const { checkpointPath } = getRunRuntimePaths(assignmentPath)
      const saved: Record<string, unknown> = JSON.parse(
        fs.readFileSync(checkpointPath, 'utf8'),
      )
      const corrupt = { levelId: B_LEVEL, visit: 0, state: 'handed_over' }
      saved.hostEntryAdmission = corrupt
      fs.writeFileSync(checkpointPath, `${JSON.stringify(saved, null, 2)}\n`)

      const roundsBeforeRestart = provider.rounds().length
      const refused = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: appDefaultEnvironment(B_MODEL),
      })
      const { diagnosis } = refused
      const hostEvents = readEvents(assignmentPath, 'host-events.jsonl')

      assert.equal(
        refused.rounds.length,
        roundsBeforeRestart,
        `a run that cannot read what it was about to do must make no provider request; ${diagnosis}`,
      )
      assert.equal(
        hostEvents.filter(
          (event) => event.event === 'host.entry_admission.unreadable',
        ).length,
        1,
        `the refusal must be recorded durably; ${diagnosis}`,
      )
      assert.deepEqual(
        readAdmission(assignmentPath),
        corrupt,
        `the refusing process must not overwrite the record it refused on, or the refusal lasts one restart; ${diagnosis}`,
      )
      assert.notEqual(
        refused.exitSignal,
        'SIGKILL',
        `the refusing host must end on its own rather than be killed by the watchdog; ${diagnosis}`,
      )
      assert.equal(
        readArtifact(assignmentPath, B_ARTIFACT),
        '<absent>',
        `no work may be done for a run that could not read its own saved entry; ${diagnosis}`,
      )
    } finally {
      fixture?.dispose()
      await provider.close()
    }
  },
)

test(
  'a managed Team run interrupted during a level\'s second turn does not replay that level',
  { timeout: 120_000, skip: process.platform === 'win32' },
  async () => {
    // A level is not finished when its opening turn settles. Here the reviewer
    // writes the wrong file, so its completion gate is not satisfied and the
    // runtime hands the host a second entry for the same level. That second
    // turn calls tools and a provider exactly like the first — and the cut
    // lands while it is outstanding.
    //
    // Before the durable record covered follow-up turns, the checkpoint at that
    // moment said the level had settled, so a restart re-entered it: a replayed
    // coordinator, on a pair resolved afresh from the new process's settings.
    // The reviewer's own declared output, which makes its level ready for its
    // gate — and a gate that asks for something else, so the gate is evaluated
    // and fails. That is what makes the runtime hand the host a second entry.
    const GATE_ARTIFACT = 'final-approval.md'
    const provider = await startCoordinatorProvider([
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
      {
        model: A_MODEL,
        answering: 'toolu_a1',
        reply: { kind: 'text', text: 'A_FINISHED' },
      },
      {
        model: B_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_b1', artifact: B_ARTIFACT, content: B_CONTENT },
      },
      {
        model: B_MODEL,
        answering: 'toolu_b1',
        reply: { kind: 'text', text: 'B_DONE_BUT_GATE_UNSATISFIED' },
      },
    ])

    let fixture: ManagedTeamFixture | undefined
    try {
      fixture = await createManagedTeamFixture({
        fixturePrefix: 'print-handover-second-turn-',
        sessionId: 'print-handover-second-turn',
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeAppDefaultReviewerTeam(teamRoot, GATE_ARTIFACT)
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
      })
      const { assignmentPath } = fixture

      const interrupted = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: {
          ...appDefaultEnvironment(B_MODEL),
          TEAM_RUNTIME_FAULT_INJECT: `crash_after_host_notice_dispatch:${B_LEVEL}`,
        },
      })

      assert.equal(
        interrupted.exitSignal,
        'SIGKILL',
        `the first process must be cut during the second turn; ${interrupted.diagnosis}`,
      )
      assert.equal(
        readEvents(assignmentPath, 'runtime-events.jsonl').filter(
          (event) =>
            event.event === 'runtime.follow_up_dispatched' &&
            event.follow_up_kind === 'runtime_notice',
        ).length,
        1,
        `the run must have started a second turn on the reviewer's level; ${interrupted.diagnosis}`,
      )
      assert.deepEqual(
        readHostEntryAdmission(readAdmission(assignmentPath)),
        {
          kind: 'admission',
          admission: {
            levelId: B_LEVEL,
            visit: 0,
            state: 'dispatching',
            selection: {
              provider: PROVIDER,
              model: B_MODEL,
              source: 'app-default',
              reason: 'agent-default',
              caller: 'agent',
            },
          },
        },
        `a level with an outstanding second turn must be recorded as having one; ${interrupted.diagnosis}`,
      )

      const roundsBeforeRestart = provider.rounds().length
      const recovered = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: appDefaultEnvironment(RECOVERY_DEFAULT_MODEL),
      })
      const { diagnosis } = recovered
      const runtimeEvents = readEvents(assignmentPath, 'runtime-events.jsonl')
      const hostEvents = readEvents(assignmentPath, 'host-events.jsonl')

      assert.equal(
        recovered.rounds.length,
        roundsBeforeRestart,
        `a level whose second turn may already have run must not be re-entered; ${diagnosis}`,
      )
      assert.equal(
        recovered.rounds.filter((round) => round.model === RECOVERY_DEFAULT_MODEL).length,
        0,
        `and certainly not on a pair resolved from the new process's settings; ${diagnosis}`,
      )
      assert.deepEqual(
        recovered.violations,
        [],
        `no unscripted round may reach the provider; ${diagnosis}`,
      )
      assert.equal(
        hostEvents.filter(
          (event) => event.event === 'host.entry_admission.indeterminate',
        ).length,
        1,
        `the recovered process must say which outstanding turn it refused to repeat; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.completed').length,
        0,
        `a run whose second turn cannot be accounted for did not succeed; ${diagnosis}`,
      )
      assert.notEqual(
        recovered.exitSignal,
        'SIGKILL',
        `the recovered host must end on its own; ${diagnosis}`,
      )
    } finally {
      fixture?.dispose()
      await provider.close()
    }
  },
)

test(
  'a managed Team run whose level list changed under it refuses, and never dispatches the level now at its saved position',
  { timeout: 120_000, skip: process.platform === 'win32' },
  async () => {
    // The saved position is an index. Insert a level ahead of the interrupted
    // one and the same index denotes something else — so a restart that reads
    // "the run is somewhere else" as "the interrupted level finished" forgets a
    // record it should have kept and dispatches a level in place of the one
    // that was actually owed a turn.
    //
    // The inserted level's coordinator is given its own model, so if the run
    // ever entered it the provider would see a round on that model and say so.
    const INSERTED_LEVEL = 'triage'
    const INSERTED_COORDINATOR = 'triager'
    const INSERTED_ARTIFACT = 'triage-note.md'
    const INSERTED_MODEL = RECOVERY_DEFAULT_MODEL

    const provider = await startCoordinatorProvider([
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
    ])

    let fixture: ManagedTeamFixture | undefined
    try {
      fixture = await createManagedTeamFixture({
        fixturePrefix: 'print-handover-reordered-',
        sessionId: 'print-handover-reordered',
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeAppDefaultReviewerTeam(teamRoot)
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
      })
      const { assignmentPath, teamRoot } = fixture

      // Cut with the reviewer's entry admitted and not yet sent.
      const interrupted = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: {
          ...appDefaultEnvironment(B_MODEL),
          TEAM_RUNTIME_FAULT_INJECT: `crash_after_host_admission_pending:${B_LEVEL}`,
        },
      })
      assert.equal(
        interrupted.exitSignal,
        'SIGKILL',
        `the first process must be cut with the reviewer's entry admitted; ${interrupted.diagnosis}`,
      )
      const savedAdmission = readAdmission(assignmentPath)
      assert.deepEqual(
        readHostEntryAdmission(savedAdmission),
        {
          kind: 'admission',
          admission: {
            levelId: B_LEVEL,
            visit: 0,
            state: 'pending',
            selection: {
              provider: PROVIDER,
              model: B_MODEL,
              source: 'app-default',
              reason: 'agent-default',
              caller: 'agent',
            },
          },
        },
        `the interrupted run must have recorded the entry it owed; ${interrupted.diagnosis}`,
      )

      // Now somebody inserts a level between the two. The saved index still
      // says 1, which is no longer the reviewer.
      writePersona(
        path.join(teamRoot, 'agents', 'triager.md'),
        INSERTED_COORDINATOR,
        INSERTED_MODEL,
      )
      const teamYamlPath = path.join(teamRoot, 'team.yaml')
      const original = fs.readFileSync(teamYamlPath, 'utf8')
      const withInserted = original
        .replace(
          `  - id: ${B_LEVEL}`,
          `  - id: ${INSERTED_LEVEL}
    name: Triage
    order: 1
    stage:
      type: routing
      coordinator: ${INSERTED_COORDINATOR}
      config:
        output:
          format: ${INSERTED_ARTIFACT}
          user_review: false
  - id: ${B_LEVEL}`,
        )
        .replace(
          `  - name: ${B_COORDINATOR}`,
          `  - name: ${INSERTED_COORDINATOR}
    type: agent
    role: Triages the draft.
    tools:
      - write
    produces:
      - path: ${INSERTED_ARTIFACT}
    agent_file: ./agents/triager.md
  - name: ${B_COORDINATOR}`,
        )
        .replace(
          `  - from: ${A_LEVEL}\n    to: ${B_LEVEL}`,
          `  - from: ${A_LEVEL}\n    to: ${INSERTED_LEVEL}`,
        )
        .replace(
          `gates:`,
          `gates:
  - from: ${INSERTED_LEVEL}
    to: ${B_LEVEL}
    condition:
      type: artifact_exists
      artifact: ${INSERTED_ARTIFACT}`,
        )
      assert.notEqual(withInserted, original, 'the level list must actually change')
      fs.writeFileSync(teamYamlPath, withInserted)

      const roundsBeforeRestart = provider.rounds().length
      const restarted = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: appDefaultEnvironment(B_MODEL),
      })
      const { diagnosis } = restarted
      const hostEvents = readEvents(assignmentPath, 'host-events.jsonl')

      assert.equal(
        restarted.rounds.length,
        roundsBeforeRestart,
        `a run whose saved position no longer names its interrupted level must dispatch nothing; ${diagnosis}`,
      )
      assert.equal(
        restarted.rounds.filter((round) => round.model === INSERTED_MODEL).length,
        0,
        `and above all must not run the level that has taken its saved position; ${diagnosis}`,
      )
      assert.equal(
        readArtifact(assignmentPath, INSERTED_ARTIFACT),
        '<absent>',
        `no work may be done for the inserted level; ${diagnosis}`,
      )
      assert.equal(
        hostEvents.filter(
          (event) => event.event === 'host.entry_admission.changed_definition',
        ).length,
        1,
        `the run must say that its definition no longer matches its saved entry; ${diagnosis}`,
      )
      assert.deepEqual(
        readAdmission(assignmentPath),
        savedAdmission,
        `the record of the interrupted entry must survive untouched; ${diagnosis}`,
      )
      assert.notEqual(
        restarted.exitSignal,
        'SIGKILL',
        `the refusing host must end on its own; ${diagnosis}`,
      )
    } finally {
      fixture?.dispose()
      await provider.close()
    }
  },
)

test(
  'a managed Team run that cannot read its saved state leaves that state alone, and refuses again on the next start',
  { timeout: 180_000, skip: process.platform === 'win32' },
  async () => {
    // A checkpoint is restored field by field, and one of those fields is
    // validated hard enough to throw. The admission is parsed after it — so a
    // throw anywhere earlier means the process never learns it had one, and
    // nothing stops it writing its own boot state over the record on the way
    // out. The refusal then lasts exactly one restart, and the one after that
    // replays whatever the lost record was protecting.
    const provider = await startCoordinatorProvider([
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
      {
        model: A_MODEL,
        answering: 'toolu_a1',
        reply: { kind: 'text', text: 'A_FINISHED' },
      },
    ])

    let fixture: ManagedTeamFixture | undefined
    try {
      fixture = await createManagedTeamFixture({
        fixturePrefix: 'print-handover-unreadable-state-',
        sessionId: 'print-handover-unreadable-state',
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeAppDefaultReviewerTeam(teamRoot)
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
      })
      const { assignmentPath } = fixture

      const interrupted = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: {
          ...appDefaultEnvironment(B_MODEL),
          TEAM_RUNTIME_FAULT_INJECT: `crash_after_host_admission_dispatch:${B_LEVEL}`,
        },
      })
      assert.equal(
        interrupted.exitSignal,
        'SIGKILL',
        `the first process must be cut with the reviewer's entry handed over; ${interrupted.diagnosis}`,
      )
      // The provider answers an unscripted round with HTTP 500, and Pi retries
      // it with backoff, so a gap in the script shows up as a slow first launch.
      // The watchdog can then cut it before the handover, and the test fails
      // later, at the admission check, for a reason that hides the gap.
      // Checking here names the gap directly.
      assert.deepEqual(
        interrupted.violations,
        [],
        `no unscripted round may reach the provider during the first launch; ${interrupted.diagnosis}`,
      )

      // A nested field the level-state restore validates and rejects, planted
      // beside a perfectly good admission. The admission is parsed after that
      // restore, so this process never gets as far as reading it.
      const { checkpointPath } = getRunRuntimePaths(assignmentPath)
      const saved: Record<string, unknown> = JSON.parse(
        fs.readFileSync(checkpointPath, 'utf8'),
      )
      const levelStates = saved.levelStates
      assert.ok(Array.isArray(levelStates), 'the checkpoint must carry level states')
      const reviewState = levelStates.find(
        (entry: unknown) => isRecord(entry) && entry.levelId === B_LEVEL,
      )
      assert.ok(isRecord(reviewState), 'the reviewer level must be checkpointed')
      reviewState.engineState = {
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
      fs.writeFileSync(checkpointPath, `${JSON.stringify(saved, null, 2)}\n`)
      const plantedAdmission = readAdmission(assignmentPath)
      assert.deepEqual(
        readHostEntryAdmission(plantedAdmission),
        {
          kind: 'admission',
          admission: {
            levelId: B_LEVEL,
            visit: 0,
            state: 'dispatching',
            selection: {
              provider: PROVIDER,
              model: B_MODEL,
              source: 'app-default',
              reason: 'agent-default',
              caller: 'agent',
            },
          },
        },
        'the admission planted beside the bad field must still be a good one',
      )

      const roundsBeforeRestart = provider.rounds().length
      const refused = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: appDefaultEnvironment(B_MODEL),
      })

      assert.equal(
        refused.rounds.length,
        roundsBeforeRestart,
        `a run that could not read its saved state must dispatch nothing; ${refused.diagnosis}`,
      )
      assert.deepEqual(
        readAdmission(assignmentPath),
        plantedAdmission,
        `a run that refused to start must not write its own state over the record it could not read; ${refused.diagnosis}`,
      )

      // And the refusal has to hold, which is the whole point of not
      // overwriting: a second restart finds the same record and refuses again.
      const secondRefusal = await launchManagedTeamHost({
        fixture,
        rounds: provider.rounds,
        violations: provider.violations,
        extraEnv: appDefaultEnvironment(RECOVERY_DEFAULT_MODEL),
      })

      assert.equal(
        secondRefusal.rounds.length,
        roundsBeforeRestart,
        `the refusal must survive into the next start, not last exactly one; ${secondRefusal.diagnosis}`,
      )
      assert.equal(
        readEvents(assignmentPath, 'runtime-events.jsonl').filter(
          (event) => event.event === 'run.completed',
        ).length,
        0,
        `no run here succeeded; ${secondRefusal.diagnosis}`,
      )
    } finally {
      fixture?.dispose()
      await provider.close()
    }
  },
)

test(
  'a managed Team run whose settlement cannot be saved ends rather than holding its host open',
  { timeout: 120_000, skip: process.platform === 'win32' },
  async () => {
    // Settling a turn writes. If that write fails, the run has lost only its
    // bookkeeping — but the turn claim and the process lifetime are in memory,
    // and a throw that escapes the settle handler releases neither. The host
    // then holds its prompt open on a turn that has already ended, for ever.
    //
    // The reviewer's gate is unsatisfied, so its first turn settles without
    // handing over: the plain settle, which is where the write happens.
    const GATE_ARTIFACT = 'final-approval.md'
    const provider = await startCoordinatorProvider([
      {
        model: A_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_a1', artifact: A_ARTIFACT, content: A_CONTENT },
      },
      {
        model: A_MODEL,
        answering: 'toolu_a1',
        reply: { kind: 'text', text: 'A_FINISHED' },
      },
      {
        model: B_MODEL,
        answering: null,
        reply: { kind: 'tool', id: 'toolu_b1', artifact: B_ARTIFACT, content: B_CONTENT },
      },
      {
        model: B_MODEL,
        answering: 'toolu_b1',
        reply: { kind: 'text', text: 'B_DONE_BUT_GATE_UNSATISFIED' },
      },
    ])

    let started: Awaited<ReturnType<typeof runManagedTeamHost>> | undefined
    try {
      started = await runManagedTeamHost({
        fixturePrefix: 'print-handover-settle-write-fail-',
        sessionId: 'print-handover-settle-write-fail',
        providerBaseUrl: provider.baseUrl,
        rounds: provider.rounds,
        violations: provider.violations,
        writeFixture: ({ teamRoot, sourceAgentDirectory }) => {
          writeAppDefaultReviewerTeam(teamRoot, GATE_ARTIFACT)
          writeSourceAgentDirectory(sourceAgentDirectory, provider.baseUrl)
        },
        extraEnv: {
          ...appDefaultEnvironment(B_MODEL),
          TEAM_RUNTIME_FAULT_INJECT: `fail_persist_on_settle:${B_LEVEL}`,
        },
      })
      const { run } = started
      const { assignmentPath, diagnosis } = run
      const runtimeEvents = readEvents(assignmentPath, 'runtime-events.jsonl')

      assert.notEqual(
        run.exitSignal,
        'SIGKILL',
        `a host whose settlement could not be saved must end on its own, not be killed by the watchdog; ${diagnosis}`,
      )
      assert.equal(
        runtimeEvents.filter((event) => event.event === 'run.completed').length,
        0,
        `a run that could not record its own settlement did not succeed; ${diagnosis}`,
      )
      assert.equal(
        run.rounds.length,
        4,
        `no further work may be dispatched after the failed settlement; ${diagnosis}`,
      )
      assert.deepEqual(
        run.violations,
        [],
        `no unscripted round may reach the provider; ${diagnosis}`,
      )
    } finally {
      started?.dispose()
      await provider.close()
    }
  },
)
