/**
 * The `session_shutdown` step that abandons the host run lifetime (inventory
 * TR-14, matrix A4.5), pinned through the real teardown sequence.
 *
 * `teardownOnSessionShutdown` (`team-runtime/runtime-teardown.ts`) runs each
 * step through a port. This test runs the real sequence with the
 * `abandonHostRun` port wired to a real `HostRunLifetime`, which releases a
 * print-mode host when it stops. The other ports do nothing. The lifetime's
 * clock is driven by hand, so nothing waits on time.
 *
 * The provider-abort step (TR-15) runs over real HTTP, so it lives in
 * `tests/integration/team-runtime-session-teardown-steps.test.ts`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { HostRunLifetime } from '../../domains/runtime/host-run-lifetime.js'
import {
  teardownOnSessionShutdown,
  type RuntimeTeardownPorts,
} from '../../team-runtime/runtime-teardown.js'

/** Every port, doing nothing, except the host run lifetime's. */
function inertPorts(abandonHostRun: () => void): RuntimeTeardownPorts {
  return {
    records: { recordIncompleteRun: () => undefined, persistState: () => undefined },
    work: {
      abort: () => undefined,
      clearRefreshInterval: () => undefined,
      clearFollowUpTimer: () => undefined,
    },
    devServices: { stopSync: () => undefined, stop: () => Promise.resolve() },
    session: {
      stopDashboardObserver: () => undefined,
      abandonHostRun,
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

/** A clock whose wake-ups run only when the test says so. */
function handDrivenClock(): {
  readonly clock: { setTimeout(handler: () => void, delayMs: number): { cancel(): void } }
  /** Runs every wake-up still armed, as if its delay had passed. */
  fireAll(): void
  armed(): number
} {
  const timers = new Set<() => void>()
  return {
    clock: {
      setTimeout(handler) {
        timers.add(handler)
        return { cancel: () => timers.delete(handler) }
      },
    },
    fireAll() {
      for (const handler of [...timers]) {
        timers.delete(handler)
        handler()
      }
    },
    armed: () => timers.size,
  }
}

test('TR-14: session_shutdown releases a host that is waiting on a delivered entry, as abandoned, and leaves no start deadline to report the run as never started later', async () => {
  const time = handDrivenClock()
  let holds = 0
  const lifetime = new HostRunLifetime({
    work: { pendingEntryCount: () => 0, turnInFlight: () => false },
    clock: time.clock,
    keepAlive: () => {
      holds += 1
      return { release: () => { holds -= 1 } }
    },
    startDeadlineMs: 60_000,
  })
  // Pi's awaited prompt holds the host open, and the opening entry has been
  // handed over and owes a turn that has not started.
  lifetime.hold()
  lifetime.entryDelivered()
  assert.equal(holds, 1, 'precondition: the host is held open')
  assert.equal(time.armed(), 1, 'precondition: the entry\'s start deadline is armed')

  await teardownOnSessionShutdown(inertPorts(() => lifetime.abandon()))

  assert.deepEqual(lifetime.stopped(), { reason: 'abandoned' }, 'the host is released because the session ended')
  assert.equal(holds, 0, 'the host is no longer held open')
  assert.equal(time.armed(), 0, 'no start deadline outlives the session')
  time.fireAll()
  assert.deepEqual(
    lifetime.stopped(),
    { reason: 'abandoned' },
    'nothing later relabels the stop as an entry that never started',
  )
})
