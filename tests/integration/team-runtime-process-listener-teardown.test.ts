/**
 * What a Team runtime owes the process it runs in.
 *
 * A Pi host process outlives any one run. Sessions start and shut down inside
 * it, and each one loads this extension again. Anything the extension binds to
 * `process` and never releases therefore accumulates for the life of the host:
 * first as a `MaxListenersExceededWarning`, then as callbacks holding finished
 * runtimes alive, and finally as signal handling that belongs to a run that
 * ended long ago.
 *
 * Listener counts are the contract here, not the warning. The warning is a
 * threshold effect at ten and says nothing about the eleventh run; the counts
 * say exactly what is retained after each shutdown. The warning is captured
 * alongside as supporting evidence.
 *
 * Pre-existing listeners are never touched. Every assertion is a delta against
 * a baseline taken before the first runtime is created, so a listener the test
 * runner or another module installed is neither counted nor removed.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()

/**
 * Enough runs to cross Node's default limit of ten and keep going.
 *
 * The eleventh is the point: a bound that only holds up to the warning
 * threshold is not a bound.
 */
const RUN_COUNT = 12

/** Every process event this extension is known to bind. */
const WATCHED_EVENTS = [
  'exit',
  'unhandledRejection',
  'uncaughtException',
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
] as const

type WatchedEvent = (typeof WATCHED_EVENTS)[number]
type ListenerCounts = Record<WatchedEvent, number>

function listenerCounts(): ListenerCounts {
  const counts = {} as ListenerCounts
  for (const event of WATCHED_EVENTS) {
    counts[event] = process.listenerCount(event)
  }
  return counts
}

function deltaFrom(baseline: ListenerCounts): ListenerCounts {
  const now = listenerCounts()
  const delta = {} as ListenerCounts
  for (const event of WATCHED_EVENTS) {
    delta[event] = now[event] - baseline[event]
  }
  return delta
}

function writeSingleLevelTeam(teamRoot: string): void {
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  fs.writeFileSync(
    path.join(teamRoot, 'agents', 'lead.md'),
    `---
name: lead
description: lead persona.
provider: anthropic
model: claude-haiku-4-5
thinking: low
---

You are lead.
`,
  )
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: listener-teardown-team
  description: One level, so session start is as small as it can be.

workspace:
  path: workspace
  watch: false

agents:
  - name: lead
    type: agent
    role: Coordinates the discussion.
    tier: orchestration
    tools: []
    agent_file: ./agents/lead.md

levels:
  - id: only
    name: Only
    order: 0
    stage:
      type: discussion
      coordinator: lead
      participants: []
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 1
        output:
          format: result.md
          user_review: false

gates: []

workflow:
  entry_level: only
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
`,
  )
}

interface RunHandle {
  start(): Promise<void>
  shutdown(): Promise<void>
  cleanup(): void
}

/**
 * Load the extension the way Pi loads it, once, and hand back its lifecycle.
 *
 * Nothing is stubbed out of the extension itself: the default export is called
 * with a Pi-shaped API, and `session_start` and `session_shutdown` are the real
 * registered handlers.
 */
async function createRun(index: number): Promise<RunHandle> {
  const sessionId = `listener-run-${index}`
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${sessionId}-`))
  const teamRoot = path.join(fixtureRoot, 'team')
  const workspace = path.join(fixtureRoot, 'workspace')
  writeSingleLevelTeam(teamRoot)

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
  const hostModel = { provider: 'anthropic-api', id: 'claude-haiku-4-5' }

  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerMarkdownTransformer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => 'medium',
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  }

  const extensionContext = {
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
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
    modelRegistry: {
      getAvailable: () => [hostModel],
      getAll: () => [hostModel],
    },
    model: hostModel,
    scopedModels: [],
    isIdle: () => true,
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

  async function call(name: string): Promise<void> {
    const handler = handlers.get(name)
    assert.ok(handler, `the extension must register ${name}`)
    await (handler as (...a: unknown[]) => Promise<void>)({}, extensionContext)
  }

  return {
    start: () => call('session_start'),
    shutdown: () => call('session_shutdown'),
    cleanup() {
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key]
      }
      Object.assign(process.env, previousEnv)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
  }
}

test('many Team runtimes in one process do not accumulate process listeners', {
  timeout: 300_000,
}, async () => {
  const warnings: string[] = []
  const recordWarning = (warning: Error): void => {
    warnings.push(warning.name)
  }
  process.on('warning', recordWarning)

  // Every run's snapshots, collected first and judged afterwards. Asserting
  // inside the loop would stop at the first run, so the accumulation this test
  // exists to measure — and the warning threshold at ten — would never be
  // reached on the code that has the defect.
  const live: ListenerCounts[] = []
  const settled: ListenerCounts[] = []

  try {
    // One warm-up run first, and the baseline taken after it. Loading this
    // extension's module graph installs listeners that belong to the process
    // rather than to a run — `signal-exit` and `tmp` from the dependency tree,
    // and the POSIX process-group reaper at
    // `domains/youtube/youtube-process.ts:9` — and they are installed once,
    // lazily, on first use. Measuring from a steady state after one full cycle
    // excludes all of them without touching them, and makes every later delta
    // mean exactly one thing: what this run added and did not give back.
    // Cleanup nests inside its own `finally`, so a shutdown that rejects still
    // restores the environment and removes the fixture. And it happens per run
    // rather than in a batch at the end: each run captures the environment as
    // it finds it, so deferred restores would reinstate whatever the
    // second-to-last run had left behind.
    const warmUp = await createRun(-1)
    try {
      try {
        await warmUp.start()
      } finally {
        await warmUp.shutdown()
      }
    } finally {
      warmUp.cleanup()
    }
    const baseline = listenerCounts()

    for (let index = 0; index < RUN_COUNT; index++) {
      const run = await createRun(index)
      try {
        try {
          await run.start()
          live.push(deltaFrom(baseline))
        } finally {
          // A started runtime is shut down whatever happens next, or its
          // listeners would outlive this test and score the runs after it.
          await run.shutdown()
          settled.push(deltaFrom(baseline))
        }
      } finally {
        run.cleanup()
      }
    }
  } finally {
    process.off('warning', recordWarning)
  }

  for (let index = 0; index < RUN_COUNT; index++) {
    const whileLive = live[index]
    const afterShutdown = settled[index]
    assert.ok(whileLive && afterShutdown, `run ${index} must have been measured`)

    // While the run is live its signal handling must be reachable — one shared
    // registration, not one per run, and not none.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      assert.equal(
        whileLive[signal],
        1,
        `run ${index}: a started runtime must be reachable by ${signal}, exactly once; saw ${JSON.stringify(whileLive)}`,
      )
      assert.equal(
        afterShutdown[signal],
        0,
        `run ${index}: shutting down must release its ${signal} handling; saw ${JSON.stringify(afterShutdown)}`,
      )
    }
    assert.equal(
      afterShutdown.exit,
      0,
      `run ${index}: shutting down must release every exit listener it added; saw ${JSON.stringify(afterShutdown)}`,
    )
    // The error boundaries are identical for every runtime, so one is enough
    // for the whole process — already installed by the warm-up, and never
    // per-run work again.
    assert.equal(
      afterShutdown.unhandledRejection,
      0,
      `run ${index}: global error boundaries must be installed once for the process; saw ${JSON.stringify(afterShutdown)}`,
    )
    assert.equal(
      afterShutdown.uncaughtException,
      0,
      `run ${index}: global error boundaries must be installed once for the process; saw ${JSON.stringify(afterShutdown)}`,
    )
  }

  assert.deepEqual(
    warnings.filter((name) => name === 'MaxListenersExceededWarning'),
    [],
    `${RUN_COUNT} runs must not trip Node's listener warning`,
  )
})
