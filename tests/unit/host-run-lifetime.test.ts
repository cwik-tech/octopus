/**
 * Who decides a managed Team host may stop.
 *
 * The host process is a `pi` print-mode run, and print mode's whole lifetime is
 * the prompts it awaits: it disposes the session in the `finally` after the
 * last one (`@earendil-works/pi-coding-agent/dist/modes/print-mode.js:134`).
 * A Team run's work is not one prompt. Its opening entry is queued rather than
 * prompted, and every level after the first is entered by a further entry
 * queued while the previous turn is settling. Something has to hold that single
 * awaited prompt open across all of them, and that something needs one honest
 * answer to one question: is any admitted work left?
 *
 * These are the rules of that answer, with no Pi, no filesystem and no real
 * clock in sight. The queue is read rather than copied, because the runtime's
 * own follow-up queue is the only record of admitted work and a second copy
 * would be a second, disagreeing answer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HostRunLifetime,
  type HostRunWorkSource,
} from '../../domains/runtime/host-run-lifetime.js'

interface TestClock {
  readonly clock: { setTimeout(handler: () => void, delayMs: number): { cancel(): void } }
  /** Fire every timer armed for at or before this many ms from the start. */
  readonly advanceTo: (elapsedMs: number) => void
  readonly armedCount: () => number
}

function makeClock(): TestClock {
  let now = 0
  let nextId = 0
  const armed = new Map<number, { at: number; handler: () => void }>()
  return {
    clock: {
      setTimeout(handler, delayMs) {
        const id = nextId++
        armed.set(id, { at: now + delayMs, handler })
        return {
          cancel() {
            armed.delete(id)
          },
        }
      },
    },
    advanceTo(elapsedMs) {
      now = elapsedMs
      for (const [id, entry] of [...armed]) {
        if (entry.at <= now) {
          armed.delete(id)
          entry.handler()
        }
      }
    },
    armedCount: () => armed.size,
  }
}

interface TestWork extends HostRunWorkSource {
  pending: number
  inFlight: boolean
}

function makeWork(pending = 0, inFlight = false): TestWork {
  return {
    pending,
    inFlight,
    pendingEntryCount() {
      return this.pending
    },
    turnInFlight() {
      return this.inFlight
    },
  }
}

interface TestKeepAlive {
  readonly keepAlive: () => { release(): void }
  readonly held: () => number
}

function makeKeepAlive(): TestKeepAlive {
  let held = 0
  return {
    keepAlive: () => {
      held += 1
      return {
        release() {
          held -= 1
        },
      }
    },
    held: () => held,
  }
}

function makeLifetime(
  work: HostRunWorkSource,
  clock: TestClock,
  keepAlive: TestKeepAlive = makeKeepAlive(),
): HostRunLifetime {
  return new HostRunLifetime({
    work,
    clock: clock.clock,
    keepAlive: keepAlive.keepAlive,
    startDeadlineMs: 1_000,
  })
}

test('a host with nothing queued and nothing running may stop immediately', async () => {
  const clock = makeClock()
  const lifetime = makeLifetime(makeWork(), clock)

  lifetime.reconsider()

  assert.deepEqual(await lifetime.whenStopped(), { reason: 'no_work_remains' })
})

test('a host with an entry still queued may not stop', async () => {
  const clock = makeClock()
  const work = makeWork(1)
  const lifetime = makeLifetime(work, clock)

  lifetime.reconsider()

  assert.equal(lifetime.stopped(), null, 'a queued entry is admitted work')
})

test('a host whose turn is running may not stop, even with an empty queue', async () => {
  const clock = makeClock()
  const work = makeWork(0, true)
  const lifetime = makeLifetime(work, clock)

  lifetime.reconsider()

  assert.equal(lifetime.stopped(), null)
})

test('a host may not stop between handing an entry over and that turn starting', async () => {
  // The gap this closes is real: `ExtensionAPI.sendUserMessage` returns void
  // and starts the turn asynchronously, so for a moment the queue is empty and
  // no turn is in flight while a coordinator is about to speak.
  const clock = makeClock()
  const work = makeWork(1)
  const lifetime = makeLifetime(work, clock)

  work.pending = 0
  lifetime.entryDelivered()

  assert.equal(lifetime.stopped(), null, 'the delivered entry is still owed a turn')

  work.inFlight = true
  lifetime.turnStarted()
  assert.equal(lifetime.stopped(), null)
})

test('a delivered entry that never starts its turn stops the host, truthfully', async () => {
  // Pi accepts an entry, then rejects it asynchronously — a missing credential,
  // an unusable model — and reports it on its own error channel, which the
  // extension cannot read. Waiting forever is the one outcome that is never
  // right.
  const clock = makeClock()
  const lifetime = makeLifetime(makeWork(), clock)

  lifetime.entryDelivered()
  clock.advanceTo(1_000)

  assert.deepEqual(await lifetime.whenStopped(), { reason: 'entry_never_started' })
})

test('a turn that starts disarms the deadline the delivery armed', async () => {
  const clock = makeClock()
  const work = makeWork()
  const lifetime = makeLifetime(work, clock)

  lifetime.entryDelivered()
  assert.equal(clock.armedCount(), 1)

  work.inFlight = true
  lifetime.turnStarted()

  assert.equal(clock.armedCount(), 0, 'a started turn is no longer waiting to start')
  clock.advanceTo(10_000)
  assert.equal(lifetime.stopped(), null)
})

test('a host stops once its last turn settles with nothing else owed', async () => {
  const clock = makeClock()
  const work = makeWork(1)
  const lifetime = makeLifetime(work, clock)

  work.pending = 0
  lifetime.entryDelivered()
  work.inFlight = true
  lifetime.turnStarted()
  work.inFlight = false
  lifetime.turnSettled()

  assert.deepEqual(await lifetime.whenStopped(), { reason: 'no_work_remains' })
})

test('a turn that settles having queued the next level keeps the host alive', async () => {
  // The handover case. A's settle is where B's entry is queued, so the queue
  // this reads has to be the queue that entry went into.
  const clock = makeClock()
  const work = makeWork(1)
  const lifetime = makeLifetime(work, clock)

  work.pending = 0
  lifetime.entryDelivered()
  work.inFlight = true
  lifetime.turnStarted()

  // B's entry is queued while A settles.
  work.pending = 1
  work.inFlight = false
  lifetime.turnSettled()

  assert.equal(lifetime.stopped(), null, "B's entry is admitted work A owes")
})

test('the first answer is the one the host acts on', async () => {
  const clock = makeClock()
  const work = makeWork()
  const lifetime = makeLifetime(work, clock)

  lifetime.reconsider()
  lifetime.entryDelivered()
  clock.advanceTo(5_000)

  assert.deepEqual(
    await lifetime.whenStopped(),
    { reason: 'no_work_remains' },
    'a later deadline must not relabel a host that already stopped',
  )
})

test('cancellation stops a host that still has work owed', async () => {
  const clock = makeClock()
  const lifetime = makeLifetime(makeWork(2, true), clock)

  lifetime.abandon()

  assert.deepEqual(await lifetime.whenStopped(), { reason: 'abandoned' })
  assert.equal(clock.armedCount(), 0, 'an abandoned host arms nothing further')
})

test('a host waiting for work holds its process open, and lets go when it stops', async () => {
  // Nothing else will. The follow-up queue's wake-up is deliberately unreferenced
  // (`domains/runtime/follow-up.ts:58`) so it cannot keep a process alive on its
  // own, which leaves a host with an empty call stack and a pending promise —
  // and Node ends a process that has no work, however much it is owed.
  const clock = makeClock()
  const keepAlive = makeKeepAlive()
  const work = makeWork(1)
  const lifetime = makeLifetime(work, clock, keepAlive)

  lifetime.hold()
  assert.equal(keepAlive.held(), 1, 'a host with an entry queued must outlive its own call stack')

  work.pending = 0
  lifetime.reconsider()

  assert.deepEqual(await lifetime.whenStopped(), { reason: 'no_work_remains' })
  assert.equal(keepAlive.held(), 0, 'and must not outlive the run')
})

test('a host that has already stopped never takes hold', async () => {
  const clock = makeClock()
  const keepAlive = makeKeepAlive()
  const lifetime = makeLifetime(makeWork(), clock, keepAlive)

  lifetime.reconsider()
  lifetime.hold()

  assert.equal(keepAlive.held(), 0)
})

test('a run that has failed stops its host, even mid-turn with work owed', async () => {
  // The settle that cannot enter the next level ends the run: it discards the
  // queued entries, records the failure, and releases the turn claim. Nothing
  // after that will ever be dispatched or settled, so the owner has to be told
  // — otherwise the host waits on a run that is already over.
  const clock = makeClock()
  const keepAlive = makeKeepAlive()
  const work = makeWork(1, true)
  const lifetime = makeLifetime(work, clock, keepAlive)

  lifetime.hold()
  lifetime.entryDelivered()
  lifetime.runFailed()

  assert.deepEqual(await lifetime.whenStopped(), { reason: 'run_failed' })
  assert.equal(keepAlive.held(), 0)
  assert.equal(clock.armedCount(), 0)
})

test('a compaction the provider is running is not a turn that never started', async () => {
  // Pi compacts before it starts the next turn (`dist/core/agent-session.js:861`),
  // and that compaction is itself a provider call. A slow one must not be read
  // as a delivered entry that will never run.
  const clock = makeClock()
  const lifetime = makeLifetime(makeWork(), clock)

  lifetime.entryDelivered()
  lifetime.compactionStarted()
  clock.advanceTo(10_000)

  assert.equal(lifetime.stopped(), null, 'the host is waiting on work, not on nothing')
})

test('a delivered entry still owes a turn once its compaction finishes', async () => {
  const clock = makeClock()
  const lifetime = makeLifetime(makeWork(), clock)

  lifetime.entryDelivered()
  lifetime.compactionStarted()
  clock.advanceTo(10_000)
  lifetime.compactionFinished()
  clock.advanceTo(11_000)

  assert.deepEqual(await lifetime.whenStopped(), { reason: 'entry_never_started' })
})

test('a compaction that finishes without its turn ever starting still ends the host', async () => {
  const clock = makeClock()
  const lifetime = makeLifetime(makeWork(), clock)

  lifetime.entryDelivered()
  lifetime.compactionStarted()
  lifetime.compactionFinished()
  clock.advanceTo(1_000)

  assert.deepEqual(await lifetime.whenStopped(), { reason: 'entry_never_started' })
})

test('an entry still queued behind the one in flight keeps the host alive', async () => {
  // Only one entry is ever handed over at a time, so the rest of the queue is
  // work this host still owes even while a turn is running.
  const clock = makeClock()
  const work = makeWork(2)
  const lifetime = makeLifetime(work, clock)

  work.pending = 1
  lifetime.entryDelivered()
  work.inFlight = true
  lifetime.turnStarted()

  assert.equal(clock.armedCount(), 0, 'the entry in flight has started')

  work.inFlight = false
  lifetime.turnSettled()
  assert.equal(lifetime.stopped(), null, 'the queued entry has not been given to anyone yet')
})

test('a compaction that never reports finishing does not block the next entry forever', async () => {
  // Pi emits `session_compact` only after a successful save
  // (`dist/core/agent-session.js:1677`). A compaction that is cancelled by an
  // extension (`:1623`), aborted (`:1660`) or fails (`:1711`) emits a
  // session-level `compaction_end` instead, which an extension cannot see. A
  // host that waits for the success-only event before it will arm another
  // deadline waits for something that is never coming — and holds its process
  // open on an entry that never started.
  //
  // Pi's own control flow is what bounds it: every compaction this host can see
  // happens inside a prompt, and whatever its outcome, that prompt goes on to
  // start a turn or the run goes on to settle.
  const clock = makeClock()
  const keepAlive = makeKeepAlive()
  const work = makeWork(1)
  const lifetime = makeLifetime(work, clock, keepAlive)

  lifetime.hold()
  work.pending = 0
  lifetime.entryDelivered()
  lifetime.compactionStarted()
  // Cancelled: no `compactionFinished` is coming.
  work.inFlight = true
  lifetime.turnStarted()

  // A settles having queued the next level's entry, which is then handed over.
  work.pending = 1
  work.inFlight = false
  lifetime.turnSettled()
  work.pending = 0
  lifetime.entryDelivered()

  assert.equal(
    clock.armedCount(),
    1,
    'the entry that was just handed over is owed a turn, and owed a deadline for it',
  )
  clock.advanceTo(1_000)
  assert.deepEqual(await lifetime.whenStopped(), { reason: 'entry_never_started' })
  assert.equal(keepAlive.held(), 0, 'and the host lets its process go')
})

test('a compaction that finishes normally still clears on its own event', async () => {
  const clock = makeClock()
  const lifetime = makeLifetime(makeWork(), clock)

  lifetime.entryDelivered()
  lifetime.compactionStarted()
  lifetime.compactionFinished()

  assert.equal(clock.armedCount(), 1, 'a finished compaction re-arms without needing a turn')
})

test('a dispatch that can never be recorded stops the host', () => {
  // The queue can reach a state no later event will clear: an entry it cannot
  // admit, so it is never handed over, so no start deadline is ever armed, and
  // `reconsider` refuses to stop while it is still pending. Giving up on the
  // entry has to be able to end the run, or the host waits on work that will
  // never happen.
  const work = { pendingEntryCount: () => 0, turnInFlight: () => false }
  const lifetime = new HostRunLifetime({
    work,
    clock: { setTimeout: () => ({ cancel: () => undefined }) },
    keepAlive: () => ({ release: () => undefined }),
    startDeadlineMs: 60_000,
  })
  lifetime.hold()

  lifetime.dispatchAbandoned('admission_unrecordable')

  assert.deepEqual(lifetime.stopped(), {
    reason: 'entry_never_dispatched',
    detail: 'admission_unrecordable',
  })
})
