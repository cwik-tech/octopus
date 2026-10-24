/**
 * Steps of the `session_shutdown` route that only the source kept (inventory
 * TR-14 to TR-18, matrix A4.5), pinned by what each leaves behind.
 *
 * `team-runtime/runtime-teardown.ts` runs the steps through ports
 * `team-runtime/index.ts` builds. TR-16 and TR-18 boot the real runtime on a
 * fixture Team, run `session_shutdown` once, and read what a person or another
 * process can see afterwards. TR-15 runs the real teardown sequence directly,
 * with its abort port wired to a controller that a real HTTP request was
 * started with. No step is asserted by call order alone; each test names the
 * consequence it protects.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import * as http from 'node:http'
import * as net from 'node:net'
import test from 'node:test'

import {
  teardownOnSessionShutdown,
  type RuntimeTeardownPorts,
} from '../../team-runtime/runtime-teardown.js'
import {
  bootFixtureRuntime,
  type FixtureRuntime,
} from '../support/team-runtime-fixture-boot.js'

const COORDINATOR = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }

/** Longer than every step deadline below put together. */
const TEST_TIMEOUT_MS = 90_000
/** How long one boot, one shutdown or one close may take. */
const STEP_DEADLINE_MS = 30_000

/**
 * Variables a developer's shell may carry that change the run's identity, where
 * it records, or whether it counts as a delegated child. Every boot here
 * removes them.
 */
const IDENTITY_ENV = [
  'TEAM_SESSION_ID',
  'TEAM_ROOT_SESSION_ID',
  'TEAM_PARENT_SESSION_ID',
  'TEAM_SPAWN_DEPTH',
  'TEAM_RUNTIME_ASSIGNMENT_PATH',
  'TEAM_RUNTIME_RUN_PATH',
  'TEAM_DELEGATED_AUTOSTART',
] as const

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

/** A loopback port nothing listens on at the moment it is returned. */
async function unusedLoopbackPort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === 'string') {
    throw new Error('Could not reserve a loopback port.')
  }
  return address.port
}

/** Whether a TCP connection to the port is accepted or refused, and nothing else. */
async function connectionOutcome(port: number): Promise<'accepted' | 'refused'> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve('accepted')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolve('refused')
      else reject(error)
    })
  })
}

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

/** Every status bar line the runtime shows from now on. */
function recordStatusLines(defer: Defer, runtime: FixtureRuntime): string[] {
  const context = runtime.host.extensionContext
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

test('TR-18: session_shutdown during a coordinator turn stops the dashboard refresh, so the status bar is not redrawn after the session has ended', {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  await withCleanup(async (defer) => {
    const runtime: FixtureRuntime = await withinDeadline(
      'the boot',
      bootFixtureRuntime({
        label: 'teardown-refresh-interval',
        team: { coordinator: COORDINATOR },
        unsetEnv: [...IDENTITY_ENV],
      }),
    )
    defer(() => withinDeadline('closing the runtime', runtime.close()))

    // Only the repeating refresh runs on the test clock; everything the
    // shutdown itself waits on keeps real timers.
    t.mock.timers.enable({ apis: ['setInterval'] })
    const statusLines = recordStatusLines(defer, runtime)

    // A coordinator turn starts and has not ended: the dashboard refreshes
    // while it is active.
    await runtime.host.callHandler('agent_start', {})
    const shownBefore = statusLines.length
    t.mock.timers.tick(500)
    assert.ok(
      statusLines.length > shownBefore,
      'precondition: the dashboard refreshes the status bar while the coordinator is active',
    )

    await withinDeadline('session_shutdown', runtime.shutdown())
    const shownAtShutdown = statusLines.length

    // Long after: the turn never ended, so only teardown can have stopped it.
    t.mock.timers.tick(60_000)
    assert.deepEqual(
      statusLines.slice(shownAtShutdown),
      [],
      'a session that has ended must not keep redrawing its status bar',
    )
  })
})

test('TR-16: session_shutdown stops the Team Runtime API the session started, so its port refuses connections once the session has ended', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withCleanup(async (defer) => {
    const apiPort = await unusedLoopbackPort()
    const runtime: FixtureRuntime = await withinDeadline(
      'the boot',
      bootFixtureRuntime({
        label: 'teardown-dev-services',
        team: { coordinator: COORDINATOR },
        unsetEnv: [...IDENTITY_ENV],
        env: {
          // The managed Team Runtime API only: no UI process, no browser.
          TEAM_RUNTIME_START_SERVICES: '1',
          TEAM_RUNTIME_START_API: '1',
          TEAM_RUNTIME_START_UI: '0',
          TEAM_RUNTIME_OPEN_UI: '0',
          API_HOST: '127.0.0.1',
          API_PORT: String(apiPort),
        },
      }),
    )
    defer(() => withinDeadline('closing the runtime', runtime.close()))

    assert.equal(
      await connectionOutcome(apiPort),
      'accepted',
      'precondition: the session started the Team Runtime API on its port',
    )

    await withinDeadline('session_shutdown', runtime.shutdown())

    assert.equal(
      await connectionOutcome(apiPort),
      'refused',
      'a session that has ended must not leave its API answering on the port',
    )
  })
})

/** Every teardown port, doing nothing, except the one that aborts work in flight. */
function portsAborting(abort: () => void): RuntimeTeardownPorts {
  return {
    records: { recordIncompleteRun: () => undefined, persistState: () => undefined },
    work: { abort, clearRefreshInterval: () => undefined, clearFollowUpTimer: () => undefined },
    devServices: { stopSync: () => undefined, stop: () => Promise.resolve() },
    session: {
      stopDashboardObserver: () => undefined,
      abandonHostRun: () => undefined,
      emitCompletionOnShutdown: () => undefined,
    },
    processBindings: {
      releaseSignalRegistration: () => undefined,
      removeExitListener: () => undefined,
    },
    writers: {
      flushTextStream: () => Promise.resolve(),
      evidenceWriter: () => undefined,
      journalRegistry: () => undefined,
    },
    checkpoint: { runCompleted: () => false, delete: () => undefined },
  }
}

// What this proves: the real teardown sequence calls its abort port, and an
// HTTP request started under that controller's signal is cancelled before a
// reply sent afterwards is read. The runtime's own wiring is replaced: in
// `team-runtime/index.ts` the port aborts `ctx.shutdownController`, and that
// stage autostarts and engine contexts start provider work under that signal
// is read in source. So this pins the teardown port and real request
// cancellation, not a live provider integration.
test('TR-15: session_shutdown cancels provider work started under the runtime\'s shutdown signal, so a reply sent after the session ended is never received', async (t) => {
  const arrived: http.ServerResponse[] = []
  let requestArrived: () => void = () => undefined
  const firstRequest = new Promise<void>((resolve) => {
    requestArrived = resolve
  })
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.on('error', () => undefined)
      arrived.push(response)
      requestArrived()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no TCP address')

  const shutdown = new AbortController()
  const outcome = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST',
    body: '{}',
    signal: shutdown.signal,
  }).then(
    async (response) => ({ kind: 'answered' as const, body: await response.text() }),
    (error: unknown) => ({ kind: 'cancelled' as const, name: error instanceof Error ? error.name : String(error) }),
  )
  await firstRequest

  await teardownOnSessionShutdown(portsAborting(() => shutdown.abort()))

  // The provider answers only now, after the session ended.
  const [response] = arrived
  assert.ok(response, 'precondition: the request reached the provider')
  if (!response.destroyed) response.end('{"late":true}')

  assert.deepEqual(await outcome, { kind: 'cancelled', name: 'AbortError' })
})
