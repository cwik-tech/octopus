/**
 * The two ways a Team Runtime is torn down, pinned as they are today.
 *
 * A signal (SIGTERM, SIGINT or SIGHUP) reaches the runtime through the
 * registration `session_start` makes with `installShutdownHandlers`. That
 * route is synchronous, runs at most once per registration, and never exits
 * the process. `session_shutdown` is the host's route and is async. The two
 * share some steps and differ in others, and each keeps its own order.
 *
 * These boot the real `team-runtime/index.ts` on a fixture Team and read what
 * a route leaves: the `run.incomplete` record, the checkpoint, the terminal run
 * events, and what the host's status bar shows. No stage here calls a
 * provider: the entry level is a routing level started without delegated
 * autostart.
 *
 * A signal is raised in this process with `process.emit`. The listener
 * `installShutdownHandlers` shares is found through a registration the test
 * makes first, and every other listener on the signal is detached while it is
 * raised. The boot loads `signal-exit`, whose listener kills the process when
 * it believes it is the last one left, so it must not see the signal.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import test from 'node:test'

import { installShutdownHandlers } from '../../core/lifecycle.js'
import { readCheckpoint } from '../../domains/runtime/checkpoint.js'
import { publishEngineEvent } from '../../domains/runtime/runtime-events.js'
import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  type FixtureHost,
  type FixtureRuntime,
} from '../support/team-runtime-fixture-boot.js'

const COORDINATOR = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }
const ENTRY_LEVEL = 'intake'
const SIGNAL: NodeJS.Signals = 'SIGTERM'

/** Longer than every step deadline below put together. */
const TEST_TIMEOUT_MS = 60_000
/** How long one boot, one shutdown or one close may take. */
const STEP_DEADLINE_MS = 15_000

/**
 * Variables a developer's shell may carry that change the run's identity or
 * where it records. Every boot here removes them.
 */
const IDENTITY_ENV = [
  'TEAM_SESSION_ID',
  'TEAM_ROOT_SESSION_ID',
  'TEAM_PARENT_SESSION_ID',
  'TEAM_SPAWN_DEPTH',
  'TEAM_RUNTIME_ASSIGNMENT_PATH',
  'TEAM_RUNTIME_RUN_PATH',
] as const

// ── Cleanup and deadlines ────────────────────────────────────────────────────

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

/** `promise`, or a rejection that names `step` once the step deadline passes. */
async function withinDeadline<T>(step: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${step} did not finish within ${STEP_DEADLINE_MS} ms`)),
      STEP_DEADLINE_MS,
    )
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Boot the fixture Team and start its session. `close` runs `session_shutdown`. */
async function bootStartedRuntime(defer: Defer, label: string): Promise<FixtureRuntime> {
  const runtime = await withinDeadline(
    'the boot',
    bootFixtureRuntime({
      label,
      team: { coordinator: COORDINATOR },
      unsetEnv: [...IDENTITY_ENV],
    }),
  )
  defer(() => withinDeadline('closing the runtime', runtime.close()))
  return runtime
}

// ── Records ──────────────────────────────────────────────────────────────────

function runtimeEvents(runtime: FixtureRuntime): Array<Record<string, unknown>> {
  return runtime.readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
}

function eventsNamed(runtime: FixtureRuntime, event: string): Array<Record<string, unknown>> {
  return runtimeEvents(runtime).filter((record) => record.event === event)
}

// ── Signals ──────────────────────────────────────────────────────────────────

function isSignalListener(value: unknown): value is NodeJS.SignalsListener {
  return typeof value === 'function'
}

function signalListeners(): NodeJS.SignalsListener[] {
  return process.rawListeners(SIGNAL).filter(isSignalListener)
}

/**
 * Raise `SIGNAL` in this process with only `shared` listening, then put every
 * listener the signal had back, in its original order.
 */
function raiseThrough(shared: NodeJS.SignalsListener): void {
  const original = signalListeners()
  assert.ok(original.includes(shared), 'the shared shutdown listener is still installed')
  for (const listener of original) process.removeListener(SIGNAL, listener)
  process.on(SIGNAL, shared)
  try {
    process.emit(SIGNAL, SIGNAL)
  } finally {
    process.removeListener(SIGNAL, shared)
    for (const listener of original) process.on(SIGNAL, listener)
  }
}

// ── The host's status bar ────────────────────────────────────────────────────

interface StatusBar {
  setStatus: (...args: unknown[]) => unknown
}

function isStatusBar(value: unknown): value is StatusBar {
  return (
    typeof value === 'object' &&
    value !== null &&
    'setStatus' in value &&
    typeof value.setStatus === 'function'
  )
}

/**
 * Every status line the runtime shows through the fixture host from now on,
 * in order. The host's own `setStatus` still runs, and is put back by `defer`.
 */
function recordStatusLines(defer: Defer, host: FixtureHost): string[] {
  const context = host.extensionContext
  const ui = typeof context === 'object' && context !== null && 'ui' in context ? context.ui : undefined
  assert.ok(isStatusBar(ui), 'the fixture host has a status bar')
  const shown: string[] = []
  const original = ui.setStatus
  ui.setStatus = (...args: unknown[]) => {
    shown.push(String(args[1]))
    return original(...args)
  }
  defer(() => {
    ui.setStatus = original
  })
  return shown
}

/**
 * An engine event of a category the dashboard observer renders for. It carries
 * no `run_id`, so the observer cannot drop it as another run's.
 */
function publishArtifactWritten(runtime: FixtureRuntime, artifact: string): void {
  publishEngineEvent(runtime.assignmentPath, {
    timestamp: new Date().toISOString(),
    category: 'artifact',
    type: 'artifact.written',
    payload: { path: artifact },
  })
}

// ── The signal route ─────────────────────────────────────────────────────────

test('a shutdown signal records the run as incomplete and checkpoints it, emits no terminal run event, and does nothing on a second signal', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withCleanup(async (defer) => {
    // The test's own registration, made before the boot, so the one listener
    // `installShutdownHandlers` shares is the one this call adds. The runtime's
    // registration joins it. Disposed last, after the runtime has given its
    // own back.
    const before = signalListeners()
    let witnessNotified = false
    const witness = installShutdownHandlers({
      onShutdown: () => {
        witnessNotified = true
      },
    })
    defer(() => witness.dispose())
    const added = signalListeners().filter((listener) => !before.includes(listener))
    assert.equal(added.length, 1, 'precondition: installShutdownHandlers added one listener for the signal')
    const [shared] = added
    assert.ok(shared)

    const runtime = await bootStartedRuntime(defer, 'signal-route')
    const { checkpointPath } = getRunRuntimePaths(runtime.assignmentPath)
    assert.ok(fs.existsSync(checkpointPath), 'precondition: session_start checkpointed the run')
    assert.deepEqual(eventsNamed(runtime, 'run.incomplete'), [], 'precondition: the run has not been recorded as incomplete')
    // Removed, so a checkpoint after the signal can only be the signal's write.
    fs.rmSync(checkpointPath)

    raiseThrough(shared)

    assert.equal(witnessNotified, true, 'precondition: the raised signal reached the shared listener')
    const incomplete = eventsNamed(runtime, 'run.incomplete')
    assert.equal(incomplete.length, 1, `one run.incomplete; got ${JSON.stringify(incomplete)}`)
    assert.equal(incomplete[0]?.reason, 'signal_shutdown')
    assert.equal(incomplete[0]?.session_id, runtime.assignmentId)
    assert.equal(incomplete[0]?.level_id, ENTRY_LEVEL)
    const checkpoint = readCheckpoint(runtime.assignmentPath)
    assert.ok(checkpoint, 'the signal checkpointed the run')
    assert.equal(checkpoint.sessionId, runtime.assignmentId)
    assert.equal(checkpoint.currentLevelIndex, 0)
    assert.deepEqual(eventsNamed(runtime, 'run.completed'), [], 'the signal emitted no completion')
    assert.deepEqual(eventsNamed(runtime, 'run.failed'), [], 'the signal emitted no failure')

    // The route runs once per registration. A second signal would write the
    // checkpoint again if it ran, so it is removed first.
    fs.rmSync(checkpointPath)
    const recordedBeforeSecondSignal = runtimeEvents(runtime)

    raiseThrough(shared)

    assert.equal(fs.existsSync(checkpointPath), false, 'a second signal wrote no checkpoint')
    assert.deepEqual(runtimeEvents(runtime), recordedBeforeSecondSignal, 'a second signal recorded nothing')
  })
})

// ── The session route ────────────────────────────────────────────────────────

test('session_shutdown stops the dashboard observer before its first await', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootStartedRuntime(defer, 'session-route-observer')
    const statusLines = recordStatusLines(defer, runtime.host)

    publishArtifactWritten(runtime, 'before-shutdown.md')
    const shownWhileLive = statusLines.length
    assert.ok(shownWhileLive > 0, 'precondition: an engine event renders the status bar of a live runtime')

    // The fixture calls the handler at once, and an async handler runs up to
    // its first await before this call returns. An event published now
    // arrives while the handler waits there.
    const shuttingDown = runtime.shutdown()
    let shownDuringShutdown: number
    try {
      publishArtifactWritten(runtime, 'during-shutdown.md')
      shownDuringShutdown = statusLines.length
    } finally {
      await withinDeadline('session_shutdown', shuttingDown)
    }

    assert.equal(
      shownDuringShutdown,
      shownWhileLive,
      `an engine event during shutdown must not render; the status bar showed ${JSON.stringify(statusLines.slice(shownWhileLive))}`,
    )
  })
})

test('session_shutdown records a run that has not completed as incomplete and keeps its checkpoint', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await bootStartedRuntime(defer, 'session-route-checkpoint')
    const { checkpointPath } = getRunRuntimePaths(runtime.assignmentPath)
    assert.ok(fs.existsSync(checkpointPath), 'precondition: session_start checkpointed the run')
    // Removed, so the checkpoint after shutdown can only be the shutdown's own
    // write, which it then keeps because the run has not completed.
    fs.rmSync(checkpointPath)

    await withinDeadline('session_shutdown', runtime.shutdown())

    const incomplete = eventsNamed(runtime, 'run.incomplete')
    assert.equal(incomplete.length, 1, `one run.incomplete; got ${JSON.stringify(incomplete)}`)
    assert.equal(incomplete[0]?.reason, 'session_shutdown')
    assert.ok(fs.existsSync(checkpointPath), 'a run that has not completed keeps its checkpoint through session_shutdown')
    const checkpoint = readCheckpoint(runtime.assignmentPath)
    assert.ok(checkpoint, 'the kept checkpoint can be read')
    assert.equal(checkpoint.sessionId, runtime.assignmentId)
    assert.deepEqual(eventsNamed(runtime, 'run.completed'), [], 'shutdown emitted no completion for a run that has not completed')
  })
})
