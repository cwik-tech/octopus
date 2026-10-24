/**
 * A coordinator handover, and who each turn belongs to.
 *
 * Level A and level B declare different coordinators with different explicit
 * pairs. Whoever moves the runtime from A to B owes B the same three acts in
 * the same order before B is asked to do anything: put the host on B's pair,
 * arm B's stage tools, then send B its opening prompt. None of it may happen
 * while a turn still owns the host loop.
 *
 * Three transition journeys, because a level advance reaches the runtime three
 * different ways, a fourth journey for what shutdown owes, and three more for
 * `/team-reset`, which lands on a level the same way and owes it the same
 * three acts — while additionally having to take apart what the level it is
 * leaving already had queued.
 *
 *   1. **Mid-turn command.** A command runs while the host is streaming, so A
 *      still owns the loop. Everything B is owed waits for `agent_settled` —
 *      the first moment Pi has no retry, compaction or queued continuation left
 *      to run
 *      (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:744-756`).
 *      Until then A's records must keep naming A, on A's pair, although
 *      `currentLevelIndex` has already moved. This journey also runs an
 *      automatic retry inside the same outer turn, because Pi emits a fresh
 *      `agent_start`/`agent_end` pair for each one and none of them is a new
 *      coordinator run.
 *
 *   2. **Idle command.** Pi runs a registered command "immediately, even
 *      during streaming" (`agent-session.js:785`, executed by
 *      `_tryExecuteExtensionCommand` at `:924`). That includes when nothing is
 *      streaming at all, which is what a person typing `/team-advance` at an
 *      idle prompt does. There is no turn to settle, so nothing arrives later
 *      to prepare B and the transition itself has to.
 *
 *   3. **Idle gate.** A gate is satisfied and `tool_execution_end` — the
 *      registered handler that evaluates the active level's gates — advances
 *      the level with no turn in flight. Nothing here is stubbed: the real
 *      `checkGate` decides the condition against a real artifact on disk, so
 *      this journey covers the gate-evaluated `tryAdvanceLevel`/`advanceLevel`
 *      path rather than omitting it.
 *
 *   4. **Teardown.** The observer that renders the dashboard lives in a
 *      module-global subscriber set, so a runtime that has shut down must stop
 *      being reachable from it. Otherwise a later engine event renders into a
 *      finished run's pane and re-arms its refresh interval.
 *
 *   5. **Reset.** `/team-reset` sends the run back to its workflow entry level,
 *      which is a transition backwards. Idle, it owes the entry level the same
 *      switch, arm and send. Mid-turn it owes the same deferral, plus one thing
 *      no advance has to do: discard the stage entry the level it is leaving
 *      already has queued, and the timer that would deliver it. A preparation
 *      that fails must send nothing and claim nothing.
 *
 * Journeys 1 and 2 advance through the registered `team-advance` command
 * (`team-runtime/commands.ts:93`), a real public surface acting on the
 * extension's own `ctx` that bypasses the gate by design. Journey 3 supplies
 * the gate-evaluated path. `tests/integration/routing-table-integration.test.ts`
 * covers the routing table's own loop in more shapes; its I-13 and I-14 cases
 * carry the same owner-versus-no-owner distinction, as characterization built
 * on module stubs rather than as this file's acceptance evidence.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { TERMINAL_GATE } from '../../core/types.js'
import { publishEngineEvent } from '../../domains/runtime/runtime-events.js'
import { TEAM_RUNTIME_MODULE_PATH } from '../support/team-runtime-fixture-boot.js'

const repoRoot = process.cwd()

/**
 * The real timer functions, captured when this file loads.
 *
 * Journeys install the mock clock and tick it by hand, so a deadline built on
 * the global `setTimeout` at that point would never fire.
 */
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

const A_LEVEL = 'discuss'
const B_LEVEL = 'review'
const A_COORDINATOR = 'lead'
const B_COORDINATOR = 'auditor'
const A_MODEL = 'claude-haiku-4-5'
const B_MODEL = 'claude-sonnet-4-6'
const HOST_PROVIDER = 'anthropic-api'
/**
 * What the agent files declare, which is not what the host registry calls it.
 *
 * `normalizeHostProvider` maps the declared name onto the host provider, so a
 * message about the *desired* pair names this one while a message about the
 * *selected* pair names `HOST_PROVIDER`.
 */
const DECLARED_PROVIDER = 'anthropic'
/** A's configured output in the gated fixture, and the gate's condition. */
const GATE_ARTIFACT = 'handoff-ready.md'

/** The part of a governed tool's registration these journeys use. */
interface RegisteredTool {
  readonly name: string
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    extensionContext: unknown,
  ): Promise<unknown>
}

interface SentFollowUp {
  readonly message: string
  readonly whileCoordinatorActive: boolean
}

/** A host switch the journey has paused, and the handle that lets it finish. */
interface ModelSwitchHold {
  /** Resolves once the runtime has asked Pi to switch and is waiting on it. */
  readonly reached: Promise<void>
  /** Let the switch finish. Safe to call more than once. */
  release(): void
}

/**
 * One ordered record of everything a transition did, so order is assertable.
 *
 * Three acts, and the order between them is the requirement: put the host on
 * the level's pair, arm that level's stage tools, then send its opening prompt.
 */
type Operation = 'armTools' | `setModel:${string}/${string}` | `followUp:${string}`

function writeAgent(filePath: string, name: string, model: string): void {
  fs.writeFileSync(
    filePath,
    `---
name: ${name}
description: ${name} persona.
provider: ${DECLARED_PROVIDER}
model: ${model}
thinking: low
---

You are ${name}.
`,
  )
}
/**
 * Which gate the fixture declares out of level A.
 *
 * `handover` moves the run to B. `terminal` ends the workflow instead: the
 * runtime's own name for that destination is `done` (`core/types.ts:394`), and
 * a gate naming it takes the completion path rather than the advance path
 * (`team-runtime/level-lifecycle.ts:749`).
 */
type GateShape = 'none' | 'handover' | 'terminal'

function writeTwoLevelTeam(teamRoot: string, gates: GateShape = 'none'): void {
  const gated = gates !== 'none'
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  writeAgent(path.join(teamRoot, 'agents', 'lead.md'), A_COORDINATOR, A_MODEL)
  writeAgent(path.join(teamRoot, 'agents', 'auditor.md'), B_COORDINATOR, B_MODEL)
  writeAgent(path.join(teamRoot, 'agents', 'specialist.md'), 'specialist', A_MODEL)
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: host-handover-team
  description: Two levels whose coordinators name different pairs.

workspace:
  path: workspace
  watch: false

agents:
  - name: ${A_COORDINATOR}
    type: agent
    role: Coordinates the discussion.
    tier: orchestration
    tools: []
    agent_file: ./agents/lead.md${gated ? `
    produces:
      - path: ${GATE_ARTIFACT}` : ''}
  - name: ${B_COORDINATOR}
    type: agent
    role: Coordinates the review.
    tier: orchestration
    tools: []
    agent_file: ./agents/auditor.md
  - name: specialist
    type: agent
    role: Reviews the material.
    tier: strategic
    tools: []
    agent_file: ./agents/specialist.md

levels:
  - id: ${A_LEVEL}
    name: Discuss
    order: 0
    stage:${gated ? `
      type: routing
      coordinator: ${A_COORDINATOR}
      participants:
        - specialist
      config:
        output:
          format: ${GATE_ARTIFACT}
          user_review: false` : `
      type: discussion
      coordinator: ${A_COORDINATOR}
      participants:
        - specialist
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        output:
          format: result.md
          user_review: false`}
  - id: ${B_LEVEL}
    name: Review
    order: 1
    stage:
      type: discussion
      coordinator: ${B_COORDINATOR}
      participants:
        - specialist
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        output:
          format: reviewed.md
          user_review: false

gates:${gated ? `
  - from: ${A_LEVEL}
    to: ${gates === 'terminal' ? TERMINAL_GATE : B_LEVEL}
    condition:
      type: artifact_exists
      artifact: ${GATE_ARTIFACT}` : ' []'}

workflow:
  entry_level: ${A_LEVEL}
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
`,
  )
}

interface Harness {
  readonly sentFollowUps: SentFollowUp[]
  readonly modelSwitches: Array<{ provider: string; id: string }>
  readonly armedTools: string[]
  readonly operations: Operation[]
  /** Everything the runtime told the user, in order. */
  readonly notifications: Array<{ message: string; level: string }>
  readonly hostModel: () => { provider: string; id: string }
  /** Where the run's artifacts and logs live, so a gate can be satisfied. */
  readonly assignmentPath: string
  /**
   * Resolves when startup's own stage entry has been delivered.
   *
   * Session start enqueues the entry level's stage entry on a 25ms delay, and
   * `schedulePendingFollowUps` keeps one timer at a time
   * (`domains/runtime/follow-up.ts:53`). A journey that installed a mock clock
   * while that real timer was still outstanding would leave the queue parked on
   * a timer the mock clock cannot fire, and every later entry behind it. So the
   * journeys wait for the event, not for a duration.
   */
  whenStartupEntrySent(): Promise<void>
  /** How many times the runtime has rendered into this run's pane. */
  readonly renderCount: () => number
  /** Run the registered `session_shutdown` handler, leaving the fixture intact. */
  shutdown(): Promise<void>
  setCoordinatorActive(active: boolean): void
  /**
   * Make Pi refuse the next host switch, the way Pi itself refuses one.
   *
   * `pi.setModel` returns false when the model is not in the host's configured
   * set, and it returns false *before* switching, so the host stays where it
   * was (`team-runtime/index.ts:4407-4415`). Refusing here rather than emptying
   * the model registry keeps the refusal at the same boundary a real one
   * arrives at.
   */
  refuseNextModelSwitch(): void
  /**
   * Make Pi's next host switch wait until the journey releases it.
   *
   * `pi.setModel` is async and the settle awaits it, so a real switch leaves a
   * window in which the runtime's own timers can fire. Nothing is switched or
   * recorded until `release`. Releasing also resolves `reached`, so a journey
   * that fails before the switch leaves neither promise outstanding.
   */
  holdNextModelSwitch(): ModelSwitchHold
  /**
   * Make the next tool registration throw, the way a failing arming would.
   *
   * The other half of a destination that cannot be prepared: the host switch
   * succeeds and the stage still cannot be armed. The message is a sentinel the
   * journey then looks for everywhere, because a caught error's text comes from
   * outside this process and must not be stored or shown.
   */
  throwOnNextToolRegistration(message: string): void
  /**
   * Take a model out of Pi's host model registry, and leave it out.
   *
   * The third way a destination pair can be unavailable, and the one that never
   * reaches `setModel`: the model is simply not in the host's configured set,
   * so selection fails first. Not one-shot, because a deregistered provider or
   * a changed setting does not come back on its own.
   */
  removeFromModelRegistry(modelId: string): void
  /** Invoke a registered lifecycle handler with the harness's own context. */
  call(name: string, event?: unknown): Promise<unknown>
  runCommand(name: string, args?: unknown): Promise<void>
  /**
   * Invoke a governed tool the runtime registered, the way Pi does.
   *
   * The capability policy runs inside this wrapper. Driving `tool_call` only
   * exercises the lifecycle handler beside it, so a policy denial — and the
   * record it writes — cannot be reached any other way from outside.
   */
  invokeRegisteredTool(
    name: string,
    toolCallId: string,
    params: unknown,
  ): Promise<unknown>
  readLog(name: string): Array<Record<string, unknown>>
  /**
   * The crash-recovery checkpoint as it stands on disk.
   *
   * The durable half of a transition. A command that moved only the in-memory
   * index would look identical from the follow-ups it sent, and would then be
   * undone by the next recovery.
   */
  readCheckpoint(): {
    currentLevelIndex: number
    levelStates: Array<{ levelId: string; status: string; stageStatus: string }>
  }
  /** Every durable log this run wrote, concatenated, for a leak scan. */
  readAllLogText(): string
  close(): Promise<void>
}

/**
 * Boot the real extension against Pi's public registration surface.
 *
 * Nothing here is an internal seam: handlers arrive through `pi.on`, commands
 * through `pi.registerCommand`, tool arming is observed through
 * `pi.registerTool`, and follow-ups through `pi.sendUserMessage`. The test
 * drives the same entry points Pi drives.
 */
async function startRuntime(
  sessionId: string,
  gates: GateShape = 'none',
  options: {
    /**
     * Have `pi.getAllTools` list every registered tool with the runtime's own
     * module as its source, as Pi does. Off by default, which makes the bypass
     * detector refuse every `tool_call` on a registered tool as shadowed; an
     * unregistered tool is still refused as ungoverned.
     */
    readonly hostListsRegisteredTools?: boolean
  } = {},
): Promise<Harness> {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `host-${sessionId}-`))
  const teamRoot = path.join(fixtureRoot, 'team')
  const workspace = path.join(fixtureRoot, 'workspace')
  writeTwoLevelTeam(teamRoot, gates)

  const assignmentPath = path.join(
    workspace,
    'sessions',
    sessionId,
    'runs',
    `run-${sessionId}`,
    'assignments',
    `assignment-${sessionId}`,
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'incoming-brief.md'), 'Review this.')

  const previousEnv = { ...process.env }
  process.env.TEAM_CONFIG_PATH = path.join(teamRoot, 'team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = sessionId
  process.env.TEAM_RUNTIME_RUN_ID = `run-${sessionId}`
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = `assignment-${sessionId}`
  process.env.TEAM_RUNTIME_TASK_ID = `task-${sessionId}`
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = `process-${sessionId}`
  process.env.TEAM_SESSION_ID = `assignment-${sessionId}`
  process.env.TEAM_ROOT_SESSION_ID = sessionId
  process.env.TEAM_INPUT_ARTIFACT = 'incoming-brief.md'
  process.env.TEAM_OUTPUT_ARTIFACT = 'unused-result.md'
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.TEAM_DELEGATED_AUTOSTART
  delete process.env.TEAM_CHAT_MODE

  const handlers = new Map<string, (...args: never[]) => unknown>()
  const commands = new Map<string, (...args: never[]) => unknown>()
  const sentFollowUps: SentFollowUp[] = []
  const modelSwitches: Array<{ provider: string; id: string }> = []
  const armedTools: string[] = []
  const registeredTools = new Map<string, RegisteredTool>()
  const operations: Operation[] = []
  const notifications: Array<{ message: string; level: string }> = []
  let refuseNextSwitch = false
  let heldSwitch: { readonly announce: () => void; readonly released: Promise<void> } | null = null
  let registrationFailure: string | null = null
  let coordinatorActive = false
  const absentModelIds = new Set<string>()
  const hostModelRegistry = (): Array<{ provider: string; id: string }> =>
    [
      { provider: HOST_PROVIDER, id: A_MODEL },
      { provider: HOST_PROVIDER, id: B_MODEL },
    ].filter((model) => !absentModelIds.has(model.id))
  let hostModel = { provider: HOST_PROVIDER, id: A_MODEL }
  let announceStartupEntry: (() => void) | undefined
  const startupEntrySent = new Promise<void>((resolve) => {
    announceStartupEntry = resolve
  })

  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, spec: { handler: (...args: never[]) => unknown }) =>
      commands.set(name, spec.handler),
    // Each contiguous burst of registrations is one arming of a level's stage
    // tools, so the ordered list stays about acts rather than tools.
    registerTool: (tool: RegisteredTool) => {
      // Before anything is recorded: a registration that throws armed nothing.
      if (registrationFailure !== null) {
        const failure = registrationFailure
        registrationFailure = null
        throw new Error(failure)
      }
      armedTools.push(tool.name)
      // Retained so a journey can invoke the wrapper the runtime actually
      // registered, rather than only the lifecycle handlers around it.
      registeredTools.set(tool.name, tool)
      if (operations.at(-1) !== 'armTools') operations.push('armTools')
    },
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerMarkdownTransformer: () => {},
    sendMessage: () => {},
    sendUserMessage: (message: string) => {
      sentFollowUps.push({ message, whileCoordinatorActive: coordinatorActive })
      // A stage entry names the level it opens, so the ordered record names it
      // too: one run can hold entries for more than one level.
      const level = /from level '([^']+)'/.exec(message)?.[1] ?? 'unknown'
      operations.push(`followUp:${level}`)
      // Only A's own entry ends the wait. An unrelated runtime notice arriving
      // first would otherwise release it while the real startup timer is still
      // outstanding, which is the state the wait exists to rule out.
      if (level === A_LEVEL) {
        announceStartupEntry?.()
        announceStartupEntry = undefined
      }
    },
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    getActiveTools: () => [],
    getAllTools: () =>
      options.hostListsRegisteredTools === true
        ? [...registeredTools.values()].map((tool) => ({
            ...tool,
            sourceInfo: { path: TEAM_RUNTIME_MODULE_PATH },
          }))
        : [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async (model: { provider: string; id: string }) => {
      // Refused before switching, so the host is left on the pair it was on
      // and no operation is recorded — there was no act to record.
      if (refuseNextSwitch) {
        refuseNextSwitch = false
        return false
      }
      // Paused before anything is recorded: until the journey releases it, the
      // host is still on the pair it was on and no switch has happened.
      const hold = heldSwitch
      if (hold) {
        heldSwitch = null
        hold.announce()
        await hold.released
      }
      modelSwitches.push({ provider: model.provider, id: model.id })
      hostModel = { provider: model.provider, id: model.id }
      operations.push(`setModel:${model.provider}/${model.id}`)
      return true
    },
    getThinkingLevel: () => 'medium',
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  }

  let renders = 0
  let shutDown = false
  const extensionContext = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level })
      },
      setStatus: () => {},
      setWidget: () => {
        renders += 1
      },
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
    },
    mode: 'headless',
    hasUI: false,
    cwd: repoRoot,
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => 'pi-session',
      getSessionFile: () => undefined,
    },
    // Both, because `getAvailableHostModels` prefers `getAvailable` and falls
    // back to `getAll` (`domains/provider/host-model.ts:32-47`); a model hidden
    // from only one of them would still be found through the other.
    modelRegistry: {
      getAvailable: () => hostModelRegistry(),
      getAll: () => hostModelRegistry(),
    },
    get model() {
      return hostModel
    },
    scopedModels: [],
    isIdle: () => !coordinatorActive,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => '',
  }

  const { default: teamRuntimeExtension } = await import('../../team-runtime/index.js')
  teamRuntimeExtension(pi as never)

  // Pi shuts a session down once, so the harness does too: a journey that shuts
  // down explicitly must not have `close` run the lifecycle a second time.
  async function shutDownOnce(): Promise<void> {
    if (shutDown) return
    shutDown = true
    const handler = handlers.get('session_shutdown')
    assert.ok(handler, 'the extension must register session_shutdown')
    await (handler as (...a: unknown[]) => Promise<void>)({}, extensionContext)
  }

  return {
    sentFollowUps,
    modelSwitches,
    armedTools,
    operations,
    notifications,
    hostModel: () => hostModel,
    assignmentPath,
    renderCount: () => renders,
    shutdown: shutDownOnce,
    whenStartupEntrySent: () =>
      Promise.race([
        startupEntrySent,
        // The runtime unrefs its own follow-up timer
        // (`domains/runtime/follow-up.ts:58`), so an outstanding wait does not
        // by itself keep Node alive and the test would be cancelled with the
        // event loop already resolved. This watchdog is referenced, bounds the
        // wait, and says what was missing rather than timing out blankly. It is
        // cleared the moment A's entry arrives.
        new Promise<never>((_resolve, reject) => {
          const watchdog = setTimeout(() => {
            reject(
              new Error(
                `startup never delivered a stage entry for '${A_LEVEL}'; saw ${JSON.stringify(operations)}`,
              ),
            )
          }, 15_000)
          void startupEntrySent.then(() => clearTimeout(watchdog))
        }),
      ]),
    setCoordinatorActive(active: boolean) {
      coordinatorActive = active
    },
    refuseNextModelSwitch() {
      refuseNextSwitch = true
    },
    holdNextModelSwitch() {
      let announce: (() => void) | undefined
      const reached = new Promise<void>((resolve) => {
        announce = resolve
      })
      let finishSwitch: (() => void) | undefined
      const released = new Promise<void>((resolve) => {
        finishSwitch = resolve
      })
      const hold = { announce: () => announce?.(), released }
      heldSwitch = hold
      return {
        reached,
        release() {
          if (heldSwitch === hold) heldSwitch = null
          finishSwitch?.()
          announce?.()
        },
      }
    },
    throwOnNextToolRegistration(message: string) {
      registrationFailure = message
    },
    removeFromModelRegistry(modelId: string) {
      absentModelIds.add(modelId)
    },
    async call(name: string, event: unknown = {}) {
      const handler = handlers.get(name)
      assert.ok(handler, `the extension must register ${name}`)
      return (handler as (...a: unknown[]) => unknown)(event, extensionContext)
    },
    async invokeRegisteredTool(name: string, toolCallId: string, params: unknown) {
      const tool = registeredTools.get(name)
      assert.ok(tool, `the runtime must have registered the ${name} tool`)
      return tool.execute(toolCallId, params, undefined, undefined, extensionContext)
    },
    async runCommand(name: string, args: unknown = {}) {
      const handler = commands.get(name)
      assert.ok(handler, `the extension must register the ${name} command`)
      await (handler as (...a: unknown[]) => Promise<void>)(args, extensionContext)
    },
    readLog(name: string) {
      const logPath = path.join(assignmentPath, 'logs', name)
      if (!fs.existsSync(logPath)) return []
      return fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    },
    readAllLogText() {
      const logsDirectory = path.join(assignmentPath, 'logs')
      if (!fs.existsSync(logsDirectory)) return ''
      return fs
        .readdirSync(logsDirectory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'),
        )
        .join('\n')
    },
    readCheckpoint() {
      const checkpointPath = path.join(assignmentPath, '.runtime', 'checkpoint.json')
      assert.ok(
        fs.existsSync(checkpointPath),
        'the runtime must have written a crash-recovery checkpoint',
      )
      return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as {
        currentLevelIndex: number
        levelStates: Array<{ levelId: string; status: string; stageStatus: string }>
      }
    },
    // The runtime owns a refresh interval and a pending-follow-up timeout, and
    // only its own `session_shutdown` clears them
    // (`team-runtime/index.ts:3857`). A failed assertion must not leave them
    // holding the process open.
    async close() {
      let shutdownFailure: unknown
      try {
        await shutDownOnce()
      } catch (error) {
        shutdownFailure = error
      }
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key]
      }
      Object.assign(process.env, previousEnv)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
      // Restoration first, then the truth: a shutdown that failed to release
      // the runtime's timers is a result, not something to swallow.
      if (shutdownFailure !== undefined) throw shutdownFailure
    },
  }
}

/**
 * The journeys run as awaited subtests of one parent.
 *
 * Each boots the real extension against `process.env` and restores it on the
 * way out. The installed Node 22 runner was observed running this file's
 * top-level tests sequentially, so awaiting each subtest is a guarantee rather
 * than a repair: it makes "the environment is restored before the next journey
 * starts" a property of this file instead of a property of the runner.
 */
test('a level advance prepares the level it moves to', {
  timeout: 120_000,
}, async (t) => {
  await t.test('a mid-turn handover keeps each turn on its own coordinator and pair', async (t) => {
    const runtime = await startRuntime('session-handover')
    try {
      // Real clocks through startup: mocking them earlier freezes the work
      // session_start awaits and the run never begins.
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()

      // ── A's turn begins ────────────────────────────────────────────────────
      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')
      // `tool.execution_start` is the one durable record that carries the *live*
      // `ctx.coordinatorRunId` and `ctx.levelAdvancedCoordinatorRunId`. The host
      // lifecycle records carry the turn's captured copy, which is stable by
      // construction and so cannot show the counter drifting under the fence.
      await runtime.call(
        'tool_execution_start',
        { toolName: 'set_roster', toolCallId: 'tool-a-1' },
        )
      // A's run identity, taken from A's own start record. Everything this turn
      // produces has to keep naming it, however far the level index moves.
      const hostTurnStart = runtime
        .readLog('host-events.jsonl')
        .filter((event) => event.event === 'host.agent_start')
        .at(-1)
      assert.ok(hostTurnStart, "A's turn must be recorded as it begins")
      const hostTurnRunId = hostTurnStart.coordinator_run_id
      assert.equal(typeof hostTurnRunId, 'number', 'and must carry a run identity')
      // The host already boots on A's pair, so the correct startup behaviour is
      // to leave it alone: `applyHostModelPreference` records
      // `host.model_selection.already_selected` and returns without switching
      // (`applyHostModelPreference`).
      assert.deepEqual(
        runtime.modelSwitches,
        [],
        "startup must not switch a host that is already on A's pair",
      )
      assert.deepEqual(
        runtime.hostModel(),
        { provider: HOST_PROVIDER, id: A_MODEL },
        "the host must be running on A's pair for A's turn",
      )
      const armedForA = runtime.armedTools.length
      assert.ok(armedForA > 0, "A's own stage tools must be registered at startup")

      // ── The handover happens mid-turn ──────────────────────────────────────
      // Mocked only from here: the 25ms stage-entry delay is advanced by the
      // clock rather than waited on. `runAll` would also fire the runtime's own
      // repeating timers, so the test ticks exactly the delay it makes eligible.
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      await runtime.runCommand('team-advance')
      t.mock.timers.tick(50)
      await Promise.resolve()

      // (1) B's entry must wait: Pi is still running A's turn.
      assert.deepEqual(
        runtime.sentFollowUps.filter((entry) => entry.whileCoordinatorActive),
        [],
        "B's stage entry must not be delivered while A's turn is still active",
      )
      // Nor may B's stage be armed. A is still the coordinator on the loop, so
      // registering B's tools now would put them in front of A, on A's pair.
      assert.equal(
        runtime.armedTools.length,
        armedForA,
        "B's stage tools must not be armed while A still owns the outer turn",
      )

      // ── A uses a tool, after the advance and inside its own turn ──────────
      // The work belongs to A: A chose it, A is running, and A's pair is what
      // the host is on. `currentLevelIndex` already says B, so every record
      // that reads it instead of the turn credits one coordinator's tool call
      // to another, on a level that has not started.
      const toolCallId = 'tool-after-advance'
      await runtime.call('tool_call', { toolName: 'set_roster', toolCallId })
      await runtime.call('tool_execution_start', { toolName: 'set_roster', toolCallId })
      await runtime.call('tool_execution_end', {
        toolName: 'set_roster',
        toolCallId,
        isError: false,
      })

      const runtimeEventsForCall = runtime
        .readLog('runtime-events.jsonl')
        .filter((event) => event.tool_call_id === toolCallId)
      assert.deepEqual(
        runtimeEventsForCall.map((event) => event.event).sort(),
        ['tool.call_observed', 'tool.execution_end', 'tool.execution_start'],
        'the call must be observed at all three points',
      )
      for (const event of runtimeEventsForCall) {
        assert.equal(
          event.coordinator,
          A_COORDINATOR,
          `${String(event.event)} must name the coordinator that made the call`,
        )
        assert.equal(
          event.level_id,
          A_LEVEL,
          `${String(event.event)} must name the level the call was made in`,
        )
        assert.equal(
          event.coordinator_run_id,
          hostTurnRunId,
          `${String(event.event)} must name the run that made the call`,
        )
      }

      const hostToolCall = runtime
        .readLog('host-events.jsonl')
        .filter((event) => event.event === 'host.tool_call')
        .at(-1)
      assert.ok(hostToolCall, "A's tool call must be recorded as a host event")
      assert.equal(hostToolCall.coordinator, A_COORDINATOR)
      assert.equal(hostToolCall.level_id, A_LEVEL)
      assert.equal(
        hostToolCall.host_model,
        A_MODEL,
        "the call ran on A's pair, because nothing has switched the host yet",
      )
      assert.equal(hostToolCall.coordinator_run_id, hostTurnRunId)

      const toolUse = runtime
        .readLog('tool-use.jsonl')
        .filter((event) => event.tool_call_id === toolCallId)
        .at(-1)
      assert.ok(toolUse, "A's tool call must be recorded in the tool-use log")
      assert.equal(toolUse.agent_name, A_COORDINATOR)
      assert.equal(toolUse.level_id, A_LEVEL)

      // Ownership is observability, not permission. The policy state stays
      // live: B is where the runtime is going, and the record says so even
      // while every attribution beside it names A.
      const observed = runtimeEventsForCall.find(
        (event) => event.event === 'tool.call_observed',
      )
      assert.ok(observed)
      assert.equal(
        observed.pending_stage_entry_level_id,
        B_LEVEL,
        'B must still be the destination the transition is holding',
      )
      // `team-advance` skips the gate and so never arms the post-advance fence;
      // only `advanceLevel` does (`team-runtime/level-lifecycle.ts:361`, `:580`).
      // That the gate arms it to the advancing run is covered by I-13 in
      // tests/integration/routing-table-integration.test.ts.
      assert.equal(
        observed.level_advanced_coordinator_run_id,
        null,
        'a gate-skipping advance must not claim to have fenced anything',
      )


      // ── A ends. Pi stays active until the turn settles. ────────────────────
      await runtime.call('agent_end')
      t.mock.timers.tick(50)
      await Promise.resolve()
      assert.deepEqual(
        runtime.sentFollowUps.filter((entry) => entry.whileCoordinatorActive),
        [],
        "B's stage entry must not be delivered between A's end and the settle",
      )
      assert.equal(
        runtime.armedTools.length,
        armedForA,
        "B's stage tools must stay unarmed between A's end and the settle",
      )

      // ── An automatic retry, inside the same outer turn ─────────────────────
      // Pi emits a fresh `agent_start`/`agent_end` pair for every automatic retry
      // and queued continuation before it settles. None of those pairs is a new
      // coordinator run, and none belongs to B: the level index has moved, the
      // turn has not.
      await runtime.call('agent_start')
      await runtime.call(
        'tool_execution_start',
        { toolName: 'set_roster', toolCallId: 'tool-a-2' },
        )
      t.mock.timers.tick(50)
      await runtime.call('agent_end')
      t.mock.timers.tick(50)
      await Promise.resolve()

      assert.equal(
        runtime.armedTools.length,
        armedForA,
        "a retry inside A's turn must not arm B's stage",
      )
      assert.deepEqual(
        runtime.sentFollowUps.filter((entry) => entry.whileCoordinatorActive),
        [],
        "a retry must not release B's stage entry",
      )

      // One outer turn is one coordinator run. The post-advance fence is an
      // equality test between the run that advanced and the run asking for a tool
      // (`team-runtime/capability-tool-policy.ts:89-92`), so a retry that
      // renumbered the run would break that equality and reopen the previous
      // level's engine tools inside the very turn whose advance closed them.
      const hostTurnEvents = runtime
        .readLog('host-events.jsonl')
        .filter(
          (event) =>
            event.event === 'host.agent_start' || event.event === 'host.agent_end',
        )
      assert.equal(
        hostTurnEvents.length,
        4,
        'both the first pass and the retry must be recorded as host lifecycle events',
      )
      const runIds = new Set(hostTurnEvents.map((event) => event.coordinator_run_id))
      assert.equal(
        runIds.size,
        1,
        `one outer turn is one coordinator run; saw ${JSON.stringify([...runIds])}`,
      )
      // `live_coordinator_run_id`, not the attributed one: the attributed id is
      // the turn's captured copy and is stable by construction, so it could not
      // show the live counter drifting underneath the fence.
      const liveRunIds = runtime
        .readLog('runtime-events.jsonl')
        .filter((event) => event.event === 'tool.execution_start')
        .map((event) => event.live_coordinator_run_id)
      assert.equal(
        liveRunIds.length,
        3,
        'every tool record must be written: before the advance, after it, and after the retry',
      )
      assert.deepEqual(
        [...new Set(liveRunIds)],
        [...runIds],
        `the run a tool is admitted under must stay the turn's own run; saw ${JSON.stringify(liveRunIds)}`,
      )
      for (const event of hostTurnEvents) {
        assert.equal(
          event.coordinator,
          A_COORDINATOR,
          `every record inside A's turn must name A; ${String(event.event)} named ${String(event.coordinator)}`,
        )
      }

      // (2) A's end still identifies A, on A's pair — in both records.
      const aHostEnd = runtime
        .readLog('host-events.jsonl')
        .filter((event) => event.event === 'host.agent_end')
        .at(-1)
      assert.ok(aHostEnd, 'the end of A must be recorded as a host lifecycle event')
      assert.equal(aHostEnd.coordinator, A_COORDINATOR, "A's end must still name A")
      assert.equal(aHostEnd.host_model, A_MODEL, "A's end must still name A's model")

      const aAgentEnd = runtime
        .readLog('agent-runs.jsonl')
        .filter((event) => event.event === 'end' || event.event === 'complete')
        .at(-1)
      assert.ok(aAgentEnd, "A's end must be recorded in the agent-run log")
      assert.equal(aAgentEnd.agent_name, A_COORDINATOR, "A's agent-run end must name A")

      // ── The turn settles, and only then does B take over ───────────────────
      runtime.setCoordinatorActive(false)
      await runtime.call('agent_settled')
      t.mock.timers.tick(50)
      await Promise.resolve()

      assertBWasPreparedThenSent(runtime, armedForA)
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

  await t.test('a settle keeps the turn claimed while the host switches, so a wake-up mid-switch sends nothing', async (t) => {
    const runtime = await startRuntime('session-held-switch')
    let hold: ModelSwitchHold | undefined
    let settling: Promise<unknown> | undefined
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()
      const armedForA = runtime.armedTools.length
      assert.ok(armedForA > 0, "A's own stage tools must be registered at startup")

      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')

      // The advance queues B's entry behind the 25ms stage-entry delay, and the
      // clock stays short of it until the settle is under way. B's wake-up is
      // therefore still outstanding when the settle starts switching the host,
      // which is the timer the held claim exists to turn away.
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      await runtime.runCommand('team-advance')
      await runtime.call('agent_end')
      runtime.setCoordinatorActive(false)

      const operationsBeforeSettle = runtime.operations.length
      const sentBeforeSettle = runtime.sentFollowUps.length
      const turnDeferrals = (): number =>
        runtime
          .readLog('runtime-events.jsonl')
          .filter(
            (event) =>
              event.event === 'runtime.follow_up_dispatch_deferred' &&
              event.reason === 'outer_turn_in_flight',
          ).length
      const deferralsBeforeSettle = turnDeferrals()

      // ── The settle asks for B's pair, and Pi has not finished switching ────
      hold = runtime.holdNextModelSwitch()
      settling = runtime.call('agent_settled')
      await withinRealDeadline(hold.reached, "the settle to ask Pi for B's pair")

      t.mock.timers.tick(50)
      assert.deepEqual(
        runtime.operations.slice(operationsBeforeSettle),
        [],
        'nothing may be switched, armed or sent while the host is still being switched',
      )
      assert.equal(
        runtime.sentFollowUps.length,
        sentBeforeSettle,
        "B's entry must not go out on the pair the switch is replacing",
      )
      assert.equal(
        runtime.armedTools.length,
        armedForA,
        "B's stage tools must not be armed before the host is on B's pair",
      )
      assert.equal(
        turnDeferrals() - deferralsBeforeSettle,
        1,
        "B's wake-up must have fired mid-switch and found the settling turn still claimed",
      )

      // ── The switch finishes; the settle arms B, releases, and sends ───────
      hold.release()
      await withinRealDeadline(settling, 'the settle to finish once the switch is released')
      t.mock.timers.tick(50)

      assert.deepEqual(
        runtime.operations.slice(operationsBeforeSettle),
        [`setModel:${HOST_PROVIDER}/${B_MODEL}`, 'armTools', `followUp:${B_LEVEL}`],
        "B's entry must go out once, after the switch to B's pair and the arming",
      )
      assertBWasPreparedThenSent(runtime, armedForA)
    } finally {
      // Released whatever happened above, so a failed assertion cannot leave
      // the settle parked on a switch or shut the runtime down underneath it.
      hold?.release()
      try {
        if (settling) {
          await withinRealDeadline(settling, 'the held settle to finish')
        }
      } finally {
        t.mock.timers.reset()
        await runtime.close()
      }
    }
  })

  await t.test('an idle level advance prepares B before it sends B anything', async (t) => {
    const runtime = await startRuntime('session-idle')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()

      // No `agent_start`: journey 2 in the header. Nothing is streaming, so no
      // `agent_settled` is coming and whatever prepares B has to be the advance.
      const armedForA = runtime.armedTools.length
      assert.ok(armedForA > 0, "A's own stage tools must be registered at startup")
      assert.deepEqual(
        runtime.modelSwitches,
        [],
        'nothing may have switched the host before the advance',
      )

      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      await runtime.runCommand('team-advance')
      t.mock.timers.tick(50)
      await Promise.resolve()

      assertBWasPreparedThenSent(runtime, armedForA)
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

  await t.test('a runtime that has shut down stops listening', async () => {
      const runtime = await startRuntime('session-teardown')
      try {
        await runtime.call('session_start')
        await runtime.whenStartupEntrySent()
        runtime.setCoordinatorActive(true)
        // An agent left ACTIVE is the state that matters: the refresh interval's
        // only exit condition is "no agent is active", so a turn that never ends
        // leaves it running until something else stops it.
        await runtime.call('agent_start')
        assert.ok(runtime.renderCount() > 0, 'precondition: the runtime renders while active')

        await runtime.shutdown()
        const rendersAfterShutdown = runtime.renderCount()

        // `installDashboardObserver` subscribes into a module-global set
        // (`domains/runtime/runtime-events.ts:19-22`) and every artifact write
        // publishes into it. A subscriber that outlives its runtime keeps
        // rendering through a `ctx` and a UI pane that are both finished, and
        // re-arms the refresh interval it was just told to drop.
        // No `run_id`: the observer drops events belonging to another run
        // (`team-runtime/runtime-observers.ts:8`), and an event this test filtered
        // out by accident would prove nothing. Without one, every live subscriber
        // is reached — which is the whole question.
        publishEngineEvent(runtime.assignmentPath, {
          timestamp: new Date().toISOString(),
          category: 'artifact',
          type: 'artifact.written',
          payload: { path: 'late-result.md' },
        })

        assert.equal(
          runtime.renderCount(),
          rendersAfterShutdown,
          'an engine event after shutdown must not reach a finished runtime',
        )
      } finally {
        await runtime.close()
      }
  })

  await t.test('a tool A is refused mid-turn is recorded against A', async () => {
    // Its own runtime, and real clocks throughout. This journey drives a real
    // governed dispatch, which opens the durable journal and does its own
    // timed file I/O; keeping it on real clocks keeps that I/O independent of
    // the timer-controlled handover journey above, which advances a mocked
    // clock to observe the deferred stage entry. Nothing here installs mock
    // timers, so nothing here has to reason about their interaction.
    const runtime = await startRuntime('session-denied')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()

      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')

      // The advance moves the level to B synchronously while A still owns the
      // turn, which is the state the attribution has to survive.
      await runtime.runCommand('team-advance')

      // Through the wrapper the runtime registered, because the capability
      // policy runs inside it. The first call is admitted and records the level
      // tool as used; the second asks for the same tool in the same turn and is
      // refused as a duplicate
      // (`team-runtime/capability-tool-policy.ts:133-142`).
      const admittedCallId = 'roster-admitted'
      const deniedCallId = 'roster-denied'
      const rosterArguments = { agents: ['specialist'] }
      await runtime.invokeRegisteredTool('set_roster', admittedCallId, rosterArguments)
      await assert.rejects(
        runtime.invokeRegisteredTool('set_roster', deniedCallId, rosterArguments),
        'a second use of the same level tool in one turn must be refused',
      )

      const deniedRecords = runtime
        .readLog('tool-use.jsonl')
        .filter((event) => event.tool_call_id === deniedCallId)
      assert.ok(
        deniedRecords.length > 0,
        'the refusal must be recorded in the tool-use log',
      )
      for (const record of deniedRecords) {
        // The rejection alone proves only that something refused the call —
        // an argument-schema failure in `adapter.prepare` would reject it too,
        // before the policy ever ran. Naming the branch is what makes this a
        // proof about attribution on the duplicate-tool refusal.
        assert.equal(
          record.policy_code,
          'duplicate_level_tool',
          'the refusal under test is the duplicate level-tool one, not some earlier rejection',
        )
        // A asked, so A is who was refused. The refusal is an observation about
        // the turn that made the call, whatever the level index now says.
        assert.equal(
          record.agent_name,
          A_COORDINATOR,
          'a blocked call is still a call the running turn made',
        )
        assert.equal(
          record.level_id,
          A_LEVEL,
          'and it was made in the level that turn belongs to',
        )
        // Beside it, unchanged: where the runtime stands is what the policy was
        // reasoning about when it said no.
        assert.equal(
          record.current_level,
          B_LEVEL,
          'while the level the runtime has moved to is recorded as it is',
        )
      }
    } finally {
      await runtime.close()
    }
  })

  await t.test('a tool_call on a level tool leaves its one use this turn to the call that runs', async () => {
    // Pi runs `tool_call` before it executes each tool. The one-use-per-turn
    // level-tool budget belongs to the capability policy inside the registered
    // wrapper; a hook that spent it would have the policy refuse the very call
    // Pi was about to run.
    const runtime = await startRuntime('session-observed-budget', 'none', {
      hostListsRegisteredTools: true,
    })
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()

      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')

      const firstCallId = 'roster-observed-then-run'
      const secondCallId = 'roster-second-use'
      const rosterArguments = { agents: ['specialist'] }

      assert.equal(
        await runtime.call('tool_call', { toolName: 'set_roster', toolCallId: firstCallId }),
        undefined,
        'the hook must let a registered level tool through',
      )
      await assert.doesNotReject(
        runtime.invokeRegisteredTool('set_roster', firstCallId, rosterArguments),
        'the call the hook observed must still be admitted by the policy',
      )

      // The second use is not the hook's to refuse either; the policy refuses
      // it when it runs.
      assert.equal(
        await runtime.call('tool_call', { toolName: 'set_roster', toolCallId: secondCallId }),
        undefined,
        'the hook must not refuse a second use of the level tool',
      )
      await assert.rejects(
        runtime.invokeRegisteredTool('set_roster', secondCallId, rosterArguments),
        'a second use of the same level tool in one turn must be refused',
      )

      const policyCodesFor = (toolCallId: string): unknown[] =>
        runtime
          .readLog('tool-use.jsonl')
          .filter((record) => record.tool_call_id === toolCallId)
          .map((record) => record.policy_code)
      assert.deepEqual(policyCodesFor(firstCallId), [])
      assert.deepEqual(policyCodesFor(secondCallId), ['duplicate_level_tool'])
    } finally {
      await runtime.close()
    }
  })

  await t.test('a call Pi routes to a tool this run does not govern is refused with a code, not a bare reason', async () => {
    // The runtime's other refusal gate. The bypass detector runs on Pi's
    // `tool_call`, before any dispatch, and blocks a call whose tool is not one
    // this runtime registered (`team-runtime/capability-bypass-detector.ts`).
    // It writes the same `tool.execution_failed` record the policy gate writes,
    // so without a code beside it the timeline reads the record through the
    // failure arm and shows "failed using tool" with the reason thrown away.
    const runtime = await startRuntime('session-bypass')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()

      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')

      const toolCallId = 'bypass-ungoverned-call'
      const blocked = await runtime.call('tool_call', {
        toolName: 'extension_bypass',
        toolCallId,
      })

      // Pi is still owed its block, unchanged: the code travels beside the
      // result, not instead of it.
      assert.deepEqual(blocked, {
        block: true,
        terminate: true,
        reason: "Tool 'extension_bypass' has no Team Runtime capability registration.",
      })

      const records = runtime
        .readLog('tool-use.jsonl')
        .filter((event) => event.tool_call_id === toolCallId)
      assert.ok(records.length > 0, 'the refusal must be recorded in the tool-use log')
      for (const record of records) {
        assert.equal(record.blocked_capability_bypass, true)
        assert.equal(
          record.policy_code,
          'ungoverned_tool_call',
          'a refusal a reader can be shown needs the code that selects its sentence',
        )
        // The engineer's half stays where it was, beside the code rather than
        // in place of it.
        assert.equal(
          record.reason,
          "Tool 'extension_bypass' has no Team Runtime capability registration.",
        )
        assert.equal(record.agent_name, A_COORDINATOR)
        assert.equal(record.level_id, A_LEVEL)
      }
    } finally {
      await runtime.close()
    }
  })

  await t.test('a stage tool the run has moved away from is refused as unregistered', async () => {
    // What makes `unknown_team_runtime_capability` a live refusal rather than
    // an unreachable branch.
    //
    // `registerLevelTools` clears the capability registrations and refills them
    // from the level being armed (`team-runtime/index.ts:1218`), and a level
    // registers only its own stage's tools (`:1325-1399`). Arming happens while
    // a run is going: from an advance (`team-runtime/level-lifecycle.ts:650`)
    // and from `/team-advance` and `/team-reset`, which Pi runs immediately,
    // streaming or idle (`team-runtime/commands.ts:183`, `:262`). The tool
    // objects themselves are never withdrawn from Pi — only deactivated
    // (`team-runtime/index.ts:1642`) — so a call can still reach the wrapper
    // the previous stage registered, and the dispatcher re-evaluates this
    // policy again before it executes (`core/capability-dispatcher.ts:1222`).
    //
    // Here: A is a routing stage with no engine tools of its own, B is a
    // discussion stage that registers `set_roster`. The run enters B, a reset
    // takes it back to A, and B's tool is asked for afterwards.
    const runtime = await startRuntime('session-stale-stage-tool', 'handover')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()

      await runtime.runCommand('team-advance')
      assert.ok(
        runtime.armedTools.includes('set_roster'),
        "precondition: B's discussion stage is what registers set_roster",
      )

      await runtime.runCommand('team-reset')

      const toolCallId = 'stale-stage-tool-call'
      await assert.rejects(
        runtime.invokeRegisteredTool('set_roster', toolCallId, {
          agents: ['specialist'],
        }),
        "a stage tool must not run once the run has left the stage that offered it",
      )

      const records = runtime
        .readLog('tool-use.jsonl')
        .filter((event) => event.tool_call_id === toolCallId)
      assert.ok(records.length > 0, 'the refusal must be recorded in the tool-use log')
      for (const record of records) {
        assert.equal(record.blocked_by_capability_policy, true)
        assert.equal(
          record.policy_code,
          'unknown_team_runtime_capability',
          'the refusal under test is the unregistered-capability one, not a later gate',
        )
      }
    } finally {
      await runtime.close()
    }
  })

  await t.test('a gate-driven advance with no turn in flight prepares B before it sends B anything', async (t) => {
    const runtime = await startRuntime('session-gate', 'handover')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()
      const armedForA = runtime.armedTools.length
      assert.ok(armedForA > 0, "A's own stage tools must be registered at startup")

      // Satisfy the gate on disk and let the real gate checker read it. Nothing
      // is stubbed: `tool_execution_end` is the registered handler that evaluates
      // the level's gates (`team-runtime/index.ts:3935`), and the condition is
      // decided by the production gate checker against this file.
      fs.writeFileSync(
        path.join(runtime.assignmentPath, GATE_ARTIFACT),
        'ready for review',
      )

      // No turn is open, so this is the automatic path in its idle shape: the
      // gate passes, the level moves, and no `agent_settled` will follow to
      // prepare B.
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      await runtime.call('tool_execution_end', {
        toolName: 'set_roster',
        toolCallId: 'tool-gate-1',
        isError: false,
      })
      t.mock.timers.tick(50)
      await Promise.resolve()

      assertBWasPreparedThenSent(runtime, armedForA)
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

  await t.test('an idle reset puts the host back on A before it re-enters A', async (t) => {
    const runtime = await startRuntime('session-reset-idle')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()
      const armedForA = runtime.armedTools.length

      // The run has to genuinely be in B first. Resetting from a level it never
      // entered would leave the host already on A's pair, and then a command
      // that did nothing at all would pass.
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      await runtime.runCommand('team-advance')
      t.mock.timers.tick(50)
      await Promise.resolve()
      assertBWasPreparedThenSent(runtime, armedForA)
      assert.deepEqual(
        runtime.hostModel(),
        { provider: HOST_PROVIDER, id: B_MODEL },
        "precondition: the host is on B's pair, which is what the reset has to undo",
      )

      const operationsBeforeReset = runtime.operations.length
      const armedForB = runtime.armedTools.length
      const disclosuresBeforeReset = countDisclosuresOfA(runtime)
      await runtime.runCommand('team-reset')
      t.mock.timers.tick(50)
      await Promise.resolve()

      assertAWasReEnteredThenSent(
        runtime,
        operationsBeforeReset,
        armedForB,
        disclosuresBeforeReset,
      )
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

  await t.test('a mid-turn reset discards B and re-enters A only once A settles', async (t) => {
    const runtime = await startRuntime('session-reset-midturn')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()
      const armedForA = runtime.armedTools.length

      // ── A's turn begins, then the workflow advances underneath it ─────────
      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')

      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      await runtime.runCommand('team-advance')
      // Deliberately no tick: B's stage entry is queued behind a 25ms timer
      // (`domains/runtime/follow-up.ts:69`) and that timer is still armed. This
      // is the state a reset has to take apart — the entry and the wake-up that
      // would deliver it.
      const queuedForB = runtime
        .readLog('runtime-events.jsonl')
        .filter(
          (event) =>
            event.event === 'runtime.follow_up_enqueued' &&
            event.target_level_id === B_LEVEL,
        )
      assert.equal(
        queuedForB.length,
        1,
        "precondition: B's stage entry is queued and undelivered",
      )

      // ── The reset arrives while A is still running ────────────────────────
      const operationsBeforeReset = runtime.operations.length
      await runtime.runCommand('team-reset')
      // Long enough for any wake-up the reset failed to cancel to fire.
      t.mock.timers.tick(500)
      await Promise.resolve()

      assert.deepEqual(
        runtime.operations.slice(operationsBeforeReset),
        [],
        "a reset may not switch, arm or send while A's turn still owns the host",
      )
      assert.deepEqual(
        runtime.hostModel(),
        { provider: HOST_PROVIDER, id: A_MODEL },
        "A's turn keeps the pair it started on",
      )
      // B's queued entry is gone, and the run says so rather than dropping it
      // silently: a stage entry that vanished without a record is
      // indistinguishable from one that was never written.
      const discardedB = runtime
        .readLog('runtime-events.jsonl')
        .filter(
          (event) =>
            event.event === 'runtime.follow_up_discarded' &&
            event.target_level_id === B_LEVEL,
        )
      assert.equal(
        discardedB.length,
        1,
        "the reset must discard B's queued stage entry and record that it did",
      )
      // The durable half. Deferring the host work does not defer the reset: a
      // crash between here and the settle must recover at A, not at B.
      assertDurableStateIsBackAtA(runtime)

      // ── A's model call ends, but the turn has not settled ─────────────────
      // The real order Pi emits. `agent_end` flushes the follow-up queue
      // (`team-runtime/index.ts:3859`), so it is a live dispatch boundary and
      // the gap after it is where a regression would surface. Settling without
      // ending would skip that flush entirely and hide it.
      await runtime.call('agent_end')
      t.mock.timers.tick(50)
      await Promise.resolve()

      // The reset set every agent's metrics back to idle and `agent_end` marks
      // the coordinator done, so the claim A's turn holds is the only thing
      // still deferring delivery. If the reset had released it, A's entry would
      // go out here — in the window where Pi may still retry or compact.
      assert.deepEqual(
        runtime.operations.slice(operationsBeforeReset),
        [],
        "nothing may happen between A's end and A's settle",
      )

      // ── A settles, and only then is A re-entered ──────────────────────────
      runtime.setCoordinatorActive(false)
      await runtime.call('agent_settled')
      t.mock.timers.tick(50)
      await Promise.resolve()

      // Two acts, in order, and no switch: the host never left A's pair, so
      // re-entering A must arm A's stage and send its entry, nothing else.
      assert.deepEqual(
        runtime.operations.slice(operationsBeforeReset),
        ['armTools', `followUp:${A_LEVEL}`],
        "settling must arm A and then send A's entry, and do nothing else",
      )
      assert.ok(
        runtime.armedTools.length > armedForA,
        "re-entering A must arm A's stage again",
      )
      assert.equal(
        runtime.sentFollowUps.filter((entry) => entry.whileCoordinatorActive)
          .length,
        0,
        'nothing may have been delivered while A was still running',
      )
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

  await t.test('a reset whose host switch is refused sends nothing and claims nothing', async (t) => {
    const runtime = await startRuntime('session-reset-refused')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()
      const armedForA = runtime.armedTools.length

      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      await runtime.runCommand('team-advance')
      t.mock.timers.tick(50)
      await Promise.resolve()
      assertBWasPreparedThenSent(runtime, armedForA)

      const operationsBeforeReset = runtime.operations.length
      const saidBeforeReset = runtime.notifications.length
      runtime.refuseNextModelSwitch()
      await runtime.runCommand('team-reset')
      t.mock.timers.tick(50)
      await Promise.resolve()

      // Nothing at all, not merely nothing sent. Arming A's tools while the
      // host is still on B's pair is the ordering bug itself, and a refused
      // switch is exactly when it would show.
      assert.deepEqual(
        runtime.operations.slice(operationsBeforeReset),
        [],
        'a reset whose host switch was refused must not switch, arm or send',
      )
      assert.deepEqual(
        runtime.hostModel(),
        { provider: HOST_PROVIDER, id: B_MODEL },
        'a refusal leaves the host on the pair it was already on',
      )
      const said = runtime.notifications.slice(saidBeforeReset)
      assert.equal(
        said.filter((entry) => /reset to entry level/i.test(entry.message)).length,
        0,
        `a reset that could not prepare A must not report that it completed; saw ${JSON.stringify(said)}`,
      )
      const blocked = runtime
        .readLog('host-events.jsonl')
        .filter((event) => event.event === 'host.model_selection.blocked')
      assert.equal(blocked.length, 1, 'the refusal must be recorded once')
      assert.equal(
        blocked.at(-1)?.reason,
        'host_refused_model',
        'and recorded as the refusal it was',
      )
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

  await t.test('a terminal gate reports completion only once the whole turn has settled', async (t) => {
    const runtime = await startRuntime('session-terminal', 'terminal')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()

      // ── A's turn begins, and satisfies the terminal gate inside it ────────
      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')

      // The real gate checker reads a real artifact, and `tool_execution_end`
      // is the registered handler that evaluates the level's gates. Nothing is
      // stubbed: this is the production path that requests completion
      // (`team-runtime/level-lifecycle.ts:406`).
      fs.writeFileSync(
        path.join(runtime.assignmentPath, GATE_ARTIFACT),
        'the work is done',
      )
      await runtime.call('tool_execution_end', {
        toolName: 'set_roster',
        toolCallId: 'tool-terminal-1',
        isError: false,
      })
      assertCompletionCount(
        runtime,
        0,
        'requesting completion inside a turn must not publish it',
      )

      // ── The model call ends — but the outer turn has not ─────────────────
      // Pi may still retry, compact, or run a queued continuation after this.
      // A completion durable here is a claim about a turn that is still going.
      await runtime.call('agent_end')
      assertCompletionCount(
        runtime,
        0,
        'the end of one model call is not the end of the turn',
      )

      // Pi's automatic continuation: a fresh start/end pair inside the same
      // outer turn, exactly as journey 1 exercises for retries. Still no claim
      // may be published, and the run must still be the same outer turn.
      await runtime.call('agent_start')
      await runtime.call('agent_end')
      assertCompletionCount(
        runtime,
        0,
        'a continuation inside the same outer turn must not publish it either',
      )

      // ── The turn settles, and only now is the run over ────────────────────
      runtime.setCoordinatorActive(false)
      await runtime.call('agent_settled')
      assertCompletionCount(runtime, 1, 'settling publishes the completion, once')
      const completion = runtime
        .readLog('runtime-events.jsonl')
        .filter((event) => event.event === 'run.completed')
        .at(-1)
      assert.equal(
        completion?.level_id,
        A_LEVEL,
        'and names the level whose terminal gate passed',
      )
      assert.equal(
        runtime
          .readLog('runtime-events.jsonl')
          .filter((event) => event.event === 'run.failed').length,
        0,
        'a successful run reports no failure',
      )

      // ── Nothing may publish it a second time ─────────────────────────────
      await runtime.call('agent_settled')
      assertCompletionCount(runtime, 1, 'a second settle must not publish it again')
      await runtime.shutdown()
      assertCompletionCount(runtime, 1, 'and neither may shutdown')
      assert.equal(
        runtime
          .readLog('runtime-events.jsonl')
          .filter((event) => event.event === 'run.incomplete').length,
        0,
        'a completed run is not also an incomplete one',
      )
    } finally {
      await runtime.close()
    }
  })

  await t.test('a terminal gate whose turn still owed a follow-up completes only after that follow-up has had its turn', async (t) => {
    const runtime = await startRuntime('session-terminal-owed', 'terminal')
    try {
      await runtime.call('session_start')
      await runtime.whenStartupEntrySent()
      const deliveredAtStartup = runtime.sentFollowUps.length

      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')

      fs.writeFileSync(
        path.join(runtime.assignmentPath, GATE_ARTIFACT),
        'the work is done',
      )

      // One event, two consequences, both from the real handler: an engine tool
      // failed, so it queues the failure notice
      // (`team-runtime/index.ts:4140-4152`), and the terminal gate now passes,
      // so the same handler goes on to request completion. `spawn_team` is the
      // routing stage's own engine tool, so the event is coherent with the
      // level the fixture declares.
      await runtime.call('tool_execution_end', {
        toolName: 'spawn_team',
        toolCallId: 'tool-terminal-failed',
        isError: true,
      })
      const queuedNotices = runtime
        .readLog('runtime-events.jsonl')
        .filter(
          (event) =>
            event.event === 'runtime.follow_up_enqueued' &&
            event.follow_up_kind === 'runtime_notice',
        )
      assert.equal(
        queuedNotices.length,
        1,
        'setup: the failed engine tool must have queued its notice',
      )
      assert.equal(
        runtime.sentFollowUps.length,
        deliveredAtStartup,
        'setup: and it must not be delivered while the turn is still running',
      )
      assertCompletionCount(
        runtime,
        0,
        'requesting completion inside a turn must not publish it',
      )

      await runtime.call('agent_end')
      assert.equal(
        runtime.sentFollowUps.length,
        deliveredAtStartup,
        'setup: the notice is still owed at the end of the model call',
      )
      assertCompletionCount(runtime, 0, 'and the run has still not finished')

      // ── The settle hands that notice to the host ─────────────────────────
      // Which is starting work, not finishing it. The queue is empty afterwards
      // only because the entry left it for Pi, and Pi will open another turn
      // for it — so an empty queue here is not an idle run.
      runtime.setCoordinatorActive(false)
      await runtime.call('agent_settled')
      assert.equal(
        runtime.sentFollowUps.length,
        deliveredAtStartup + 1,
        'the settle must actually deliver the notice, or this proves nothing',
      )
      assertCompletionCount(
        runtime,
        0,
        'a settle that just handed the host more work has not finished the run',
      )

      // ── The turn that notice caused, and only then the ending ────────────
      runtime.setCoordinatorActive(true)
      await runtime.call('agent_start')
      await runtime.call('agent_end')
      runtime.setCoordinatorActive(false)
      await runtime.call('agent_settled')
      assertCompletionCount(
        runtime,
        1,
        'the run completes once the work it owed has been done',
      )

      await runtime.call('agent_settled')
      assertCompletionCount(runtime, 1, 'a duplicate settle must not publish it again')
      await runtime.shutdown()
      assertCompletionCount(runtime, 1, 'and neither may shutdown')
    } finally {
      await runtime.close()
    }
  })

  await t.test('a settle whose destination pair is refused fails the run once, and stays failed', async (t) => {
    const runtime = await startRuntime('session-settle-refused')
    try {
      const handover = await driveHandoverToSettle(runtime, t)

      // ── The settle arrives, and B's pair is refused ───────────────────────
      runtime.refuseNextModelSwitch()
      // Resolving is the requirement, not an incidental. Pi's ExtensionRunner
      // catches a rejected handler, so a settle that threw would look handled
      // while leaving the runtime holding a claim nothing releases.
      await runtime.call('agent_settled')
      t.mock.timers.tick(500)
      await Promise.resolve()

      assert.deepEqual(
        runtime.operations.slice(handover.operationsBeforeSettle),
        [],
        'a refused destination must switch nothing, arm nothing and send nothing',
      )
      assertRunFailedOnceForB(runtime, EXPECTED_FAILURE_REASONS.host)
      await assertBlockedAndToldOnce(
        runtime,
        handover.saidBeforeSettle,
        EXPECTED_FAILURE_REASONS.host,
      )
      // B's queued entry and its wake-up are gone, so nothing can still open a
      // level the run failed to enter.
      assert.equal(
        runtime
          .readLog('runtime-events.jsonl')
          .filter(
            (event) =>
              event.event === 'runtime.follow_up_discarded' &&
              event.target_level_id === B_LEVEL,
          ).length,
        1,
        "the settle must discard B's queued stage entry",
      )

      await assertFailureIsTerminal(runtime, t, EXPECTED_FAILURE_REASONS.host)
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

  await t.test('a settle whose destination model is missing from the registry fails once, and stays failed', async (t) => {
    const runtime = await startRuntime('session-settle-absent')
    try {
      const handover = await driveHandoverToSettle(runtime, t)

      // The third shape of an unavailable pair, and the only one that never
      // reaches `setModel`: selection fails first, so the host is never asked
      // to switch (`team-runtime/index.ts:4405-4415`).
      runtime.removeFromModelRegistry(B_MODEL)
      await runtime.call('agent_settled')
      t.mock.timers.tick(500)
      await Promise.resolve()

      assert.deepEqual(
        runtime.operations.slice(handover.operationsBeforeSettle),
        [],
        'a destination that is not in the registry must not be switched to, armed, or sent',
      )
      assert.deepEqual(
        runtime.hostModel(),
        { provider: HOST_PROVIDER, id: A_MODEL },
        'and the host stays on the pair the settling turn ran on',
      )
      assertRunFailedOnceForB(runtime, EXPECTED_FAILURE_REASONS.registry)
      await assertBlockedAndToldOnce(
        runtime,
        handover.saidBeforeSettle,
        EXPECTED_FAILURE_REASONS.registry,
      )
      // The specific diagnosis survives being routed through the one
      // notification boundary: which model, on which provider, and what else
      // was available.
      const said = runtime.notifications.at(-1)?.message ?? ''
      assert.ok(
        said.includes(`Configured host model '${B_MODEL}'`) &&
          said.includes(`on provider '${DECLARED_PROVIDER}'`) &&
          said.includes(`Available: ${HOST_PROVIDER}:${A_MODEL}`),
        `the missing-registry message must keep naming what it named; saw ${said}`,
      )

      await assertFailureIsTerminal(runtime, t, EXPECTED_FAILURE_REASONS.registry)
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

  await t.test('a settle whose destination arming throws fails safely and repeats nothing it caught', async (t) => {
    const runtime = await startRuntime('session-settle-throw')
    try {
      const handover = await driveHandoverToSettle(runtime, t)

      // ── The switch succeeds; arming B is what fails ───────────────────────
      runtime.throwOnNextToolRegistration(REGISTRATION_SENTINEL)
      await runtime.call('agent_settled')
      t.mock.timers.tick(500)
      await Promise.resolve()

      assert.deepEqual(
        runtime.operations.slice(handover.operationsBeforeSettle),
        [`setModel:${HOST_PROVIDER}/${B_MODEL}`],
        'the switch happened and nothing after it did',
      )
      assertRunFailedOnceForB(runtime, EXPECTED_FAILURE_REASONS.arming)
      await assertBlockedAndToldOnce(
        runtime,
        handover.saidBeforeSettle,
        EXPECTED_FAILURE_REASONS.arming,
      )

      // The caught text came from outside this process. It is not read, not
      // stored and not shown — so it must be findable nowhere.
      assert.equal(
        runtime.readAllLogText().includes(REGISTRATION_SENTINEL),
        false,
        'no durable log may carry the caught text',
      )
      assert.equal(
        runtime.notifications.some((entry) =>
          entry.message.includes(REGISTRATION_SENTINEL),
        ),
        false,
        'no notification may carry the caught text',
      )
      const failure = runtime
        .readLog('runtime-events.jsonl')
        .filter((event) => event.event === 'run.failed')
        .at(-1)
      assert.equal(
        String(failure?.error).includes(REGISTRATION_SENTINEL),
        false,
        'and the recorded failure must not quote it either',
      )

      await assertFailureIsTerminal(runtime, t, EXPECTED_FAILURE_REASONS.arming)
    } finally {
      t.mock.timers.reset()
      await runtime.close()
    }
  })

})

/** The sentinel a failing registration throws; never a credential shape. */
const REGISTRATION_SENTINEL = 'SENTINEL-CAUGHT-TEXT-MUST-NOT-ESCAPE'

/**
 * The closed set of reasons a settle failure may name.
 *
 * `durable` is what the run records, the same sentence for a given failure
 * whatever produced it. `notified` is what the user is told, which on the
 * refusal path is the host check's own more specific account — it already knows
 * the switch was refused, and reporting `host_pair_unavailable` over it would
 * lose that. Both are fixed strings from closed sets; neither is caught text.
 */
const EXPECTED_FAILURE_REASONS = {
  host: { durable: 'host_pair_unavailable', notified: 'host_refused_model' },
  registry: {
    durable: 'host_pair_unavailable',
    notified: "was not found in Pi's host model registry",
  },
  arming: { durable: 'stage_arming_failed', notified: 'stage_arming_failed' },
} as const

/**
 * Run A's turn up to the moment it settles, having advanced to B mid-turn.
 *
 * The shared prefix of both failure journeys: B is the destination, its entry
 * is queued and undelivered, and `agent_end` has already run — so the settle is
 * the only thing left that can prepare B.
 */
async function driveHandoverToSettle(
  runtime: Harness,
  t: TestContext,
): Promise<{ operationsBeforeSettle: number; saidBeforeSettle: number }> {
  await runtime.call('session_start')
  await runtime.whenStartupEntrySent()

  runtime.setCoordinatorActive(true)
  await runtime.call('agent_start')

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  await runtime.runCommand('team-advance')
  t.mock.timers.tick(50)
  await Promise.resolve()

  await runtime.call('agent_end')
  t.mock.timers.tick(50)
  await Promise.resolve()

  runtime.setCoordinatorActive(false)
  return {
    operationsBeforeSettle: runtime.operations.length,
    saidBeforeSettle: runtime.notifications.length,
  }
}

/**
 * Wait for something the runtime owes, and fail rather than hang if it never
 * arrives.
 *
 * On the real clock, because the journeys that need it have the mock clock
 * installed. Ten seconds is well inside the parent test's timeout, so a missing
 * event fails with this message instead of a cancelled test.
 */
async function withinRealDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = realSetTimeout(() => {
          reject(new Error(`timed out waiting for ${what}`))
        }, 10_000)
      }),
    ])
  } finally {
    if (timer !== undefined) realClearTimeout(timer)
  }
}

/** How many times this run has durably reported completing. */
function assertCompletionCount(
  runtime: Harness,
  expected: number,
  message: string,
): void {
  assert.equal(
    runtime
      .readLog('runtime-events.jsonl')
      .filter((event) => event.event === 'run.completed').length,
    expected,
    message,
  )
}

/**
 * Nothing after a settle failure may undo it.
 *
 * Three ways the run could still speak, and none of them may. Settling again
 * would retry the switch on a claim that should be gone. Running another whole
 * turn would find a queued entry or a level still marked pending, and enter the
 * level the run just failed on. Shutdown runs the safety net that publishes a
 * queued success and the writer that records an unfinished run.
 */
async function assertFailureIsTerminal(
  runtime: Harness,
  t: TestContext,
  reason: (typeof EXPECTED_FAILURE_REASONS)[keyof typeof EXPECTED_FAILURE_REASONS],
): Promise<void> {
  const operationsAfterFailure = runtime.operations.length
  const saidAfterFailure = runtime.notifications.length

  await runtime.call('agent_settled')
  t.mock.timers.tick(500)
  await Promise.resolve()
  assert.deepEqual(
    runtime.operations.slice(operationsAfterFailure),
    [],
    'a second settle must not retry the switch, arm tools, or dispatch B',
  )
  assert.deepEqual(
    runtime.notifications.slice(saidAfterFailure),
    [],
    'and must not tell the user again',
  )
  assertRunFailedOnceForB(runtime, reason)

  await runtime.call('agent_start')
  await runtime.call('agent_end')
  await runtime.call('agent_settled')
  t.mock.timers.tick(500)
  await Promise.resolve()
  assert.deepEqual(
    runtime.operations.slice(operationsAfterFailure),
    [],
    'a later turn must arm nothing and dispatch nothing for the failed level',
  )

  await runtime.shutdown()
  assertRunFailedOnceForB(runtime, reason)
  assert.equal(
    runtime
      .readLog('runtime-events.jsonl')
      .filter((event) => event.event === 'run.incomplete').length,
    0,
    'a run that already reported failure must not also report incompleteness',
  )
  assert.deepEqual(
    runtime.notifications.slice(saidAfterFailure),
    [],
    'and shutting down must not tell the user anything new',
  )
}

/**
 * The run is told once, and the next prompt is turned away.
 *
 * The whole notification delta, not a matching subset: two accounts of one
 * failure is the defect, and a filtered count cannot see the second. And
 * "execution is blocked" has to be true rather than said — `input` admits a
 * prompt whenever `ctx.configErrors` is empty (`team-runtime/index.ts:3696`),
 * so a failure that leaves it empty keeps spending host requests on a level
 * nothing could enter.
 */
async function assertBlockedAndToldOnce(
  runtime: Harness,
  saidBefore: number,
  reason: (typeof EXPECTED_FAILURE_REASONS)[keyof typeof EXPECTED_FAILURE_REASONS],
): Promise<void> {
  const said = runtime.notifications.slice(saidBefore)
  assert.equal(
    said.length,
    1,
    `one failure must produce one notification; saw ${JSON.stringify(said)}`,
  )
  assert.equal(said[0]?.level, 'error', 'and it must be reported as an error')
  assert.ok(
    said[0]?.message.includes(reason.notified),
    `and it must name why; saw ${String(said[0]?.message)}`,
  )
  assert.deepEqual(
    await runtime.call('input'),
    { action: 'handled' },
    'a blocked run must turn the next prompt away, not spend a host request on it',
  )
}

/** Exactly one terminal failure, named for B, and never a completion. */
function assertRunFailedOnceForB(
  runtime: Harness,
  reason: (typeof EXPECTED_FAILURE_REASONS)[keyof typeof EXPECTED_FAILURE_REASONS],
): void {
  const events = runtime.readLog('runtime-events.jsonl')
  const failures = events.filter((event) => event.event === 'run.failed')
  assert.equal(failures.length, 1, 'the run must fail exactly once')
  assert.equal(
    failures[0]?.level_id,
    B_LEVEL,
    'and the failure belongs to the level that could not be entered',
  )
  assert.equal(
    failures[0]?.error,
    `Level '${B_LEVEL}' could not be entered: ${reason.durable}. Team execution is blocked.`,
    'with the stable message for this reason and no other text',
  )
  assert.equal(
    events.filter((event) => event.event === 'run.completed').length,
    0,
    'a failed run must never also report completion',
  )
}

/**
 * A was put back on its own pair, given its own tools, and only then re-entered.
 *
 * The mirror of `assertBWasPreparedThenSent`: a reset is a transition like any
 * other, so it owes the level it lands on the same three acts in the same
 * order.
 */
function assertAWasReEnteredThenSent(
  runtime: Harness,
  operationsBeforeReset: number,
  armedBeforeReset: number,
  disclosuresBeforeReset: number,
): void {
  // The whole transition, not a subset of it. Positional checks would still
  // hold if A were armed before the switch and again after it, or armed in two
  // separate acts — and either of those is the ordering bug this journey is
  // here to rule out. The harness collapses one contiguous burst of
  // registrations into a single `armTools`, so a second entry means a second
  // act.
  assert.deepEqual(
    runtime.operations.slice(operationsBeforeReset),
    [
      `setModel:${HOST_PROVIDER}/${A_MODEL}`,
      'armTools',
      `followUp:${A_LEVEL}`,
    ],
    'a reset owes A exactly one switch, then one arming, then one entry',
  )
  assert.ok(
    runtime.armedTools.length > armedBeforeReset,
    "A's stage tools must be armed again before A is asked to use them",
  )
  assert.deepEqual(
    runtime.hostModel(),
    { provider: HOST_PROVIDER, id: A_MODEL },
    "the host must end the reset on A's pair",
  )

  // Re-entering A is disclosed the same way entering B is, and once. Counted
  // as a change rather than a total: startup entered A too, and that earlier
  // disclosure is correct and must not stand in for this one.
  assert.equal(
    countDisclosuresOfA(runtime) - disclosuresBeforeReset,
    1,
    `re-entering ${A_LEVEL} must be disclosed exactly once`,
  )
  assert.equal(
    runtime.notifications.filter((entry) =>
      /reset to entry level/i.test(entry.message),
    ).length,
    1,
    'a completed reset must say so exactly once',
  )
  assertDurableStateIsBackAtA(runtime)
}

/** How many times the run has disclosed entering A on A's own model. */
function countDisclosuresOfA(runtime: Harness): number {
  return runtime
    .readLog('host-events.jsonl')
    .filter(
      (event) =>
        event.event === 'host.model_selection.resolved' &&
        event.level_id === A_LEVEL &&
        event.resolved_host_model === A_MODEL,
    ).length
}

/** The run's own record agrees: it is at the entry level, with B undone. */
function assertDurableStateIsBackAtA(runtime: Harness): void {
  const checkpoint = runtime.readCheckpoint()
  assert.equal(
    checkpoint.currentLevelIndex,
    0,
    'the checkpoint must put the run back at the workflow entry level',
  )
  const byLevel = new Map(
    checkpoint.levelStates.map((state) => [state.levelId, state]),
  )
  assert.equal(byLevel.get(A_LEVEL)?.status, 'active', 'A is active again')
  assert.equal(byLevel.get(A_LEVEL)?.stageStatus, 'ready', 'and its stage is ready')
  assert.equal(byLevel.get(B_LEVEL)?.status, 'pending', 'B is pending again')
  assert.equal(
    byLevel.get(B_LEVEL)?.stageStatus,
    'not_started',
    'and B is recorded as never started',
  )
}

/**
 * B was put on its own pair, given its own tools, and only then asked to work.
 *
 * The same three acts in the same order, whichever transition produced them —
 * that is the whole point of routing both through one boundary.
 */
function assertBWasPreparedThenSent(runtime: Harness, armedForA: number): void {
  // The transition first. A fixture that never advanced would otherwise fail on
  // the missing switch and read like the defect under test.
  const bEntries = runtime.sentFollowUps.filter((entry) =>
    entry.message.includes(`'${B_LEVEL}'`),
  )
  assert.equal(
    bEntries.length,
    1,
    `exactly one B stage entry must be sent; saw ${JSON.stringify(runtime.operations)}`,
  )
  assert.deepEqual(
    runtime.modelSwitches,
    [{ provider: HOST_PROVIDER, id: B_MODEL }],
    "B's model switch must be the run's one switch",
  )
  assert.ok(
    runtime.armedTools.length > armedForA,
    "B's stage tools must be armed before B is asked to use them",
  )

  // Entering B is disclosed exactly once, whichever transition got there.
  // Filtered by B's own level and model so startup's record for A — and its
  // `already_selected` record — cannot stand in for it.
  const resolvedForB = runtime
    .readLog('host-events.jsonl')
    .filter(
      (event) =>
        event.event === 'host.model_selection.resolved' &&
        event.level_id === B_LEVEL &&
        event.resolved_host_model === B_MODEL,
    )
  assert.equal(
    resolvedForB.length,
    1,
    `entering ${B_LEVEL} must be disclosed exactly once; saw ${resolvedForB.length}`,
  )

  const operations = runtime.operations
  const switchedToB = operations.indexOf(`setModel:${HOST_PROVIDER}/${B_MODEL}`)
  const sentBEntry = operations.indexOf(`followUp:${B_LEVEL}`)
  assert.notEqual(switchedToB, -1, "B's switch must appear in the transition's operations")
  assert.notEqual(sentBEntry, -1, "B's stage entry must appear in the transition's operations")
  // The arming that belongs to B is the last one before B's entry goes out;
  // earlier ones armed A at startup.
  const armedForB = operations.lastIndexOf('armTools', sentBEntry)
  assert.notEqual(armedForB, -1, "B's tools must be armed before its entry is sent")
  assert.ok(
    switchedToB < armedForB && armedForB < sentBEntry,
    `a transition must switch B, then arm B's tools, then send B's entry; saw ${JSON.stringify(operations)}`,
  )
}
