import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ExecutionJournalError,
  type ExecutionJournalScopeIdentity,
} from '../../contracts/execution-journal.js'
import {
  initializeExecutionJournal,
  type JournalWriteTarget,
} from '../../core/execution-journal.js'
import {
  acquireProcessFileLock,
  createCrossProcessFileLockRecord,
  crossProcessFileLockAdapter,
  ProcessFileLockError,
} from '../../core/cross-process-file-lock.js'

/**
 * AC6, inner contracts: which faults mean the journal is *damaged*, and which
 * mean only that this handle is finished (ADR A-2).
 *
 * Today the guarded commit treats every error identically — it increments the
 * corruption counter and refuses every later append — so an `ENOSPC`, a failed
 * `fsync`, or a manifest that was momentarily unreadable ends the assignment's
 * durable history exactly as a broken hash chain does. The distinction these
 * tests draw is the one an operator acts on: corruption needs repair, and
 * everything else needs a retry.
 *
 * The commit fault is injected through the journal's own write target, because
 * `chmod` cannot express a short write, a failed barrier, or a specific errno,
 * and a fault injected further out would exercise the harness rather than the
 * commit path.
 */

const IDENTITY: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'fault-classification',
  tenantId: 'tenant-test',
  sessionId: 'session-fault',
  runId: 'run-fault',
  assignmentId: 'assignment-fault',
}

function makeScopeRoot(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'execution-journal-fault-')),
  )
}

function observation(
  eventId: string,
  expectedStreamRevision: number,
): Parameters<
  Awaited<ReturnType<typeof initializeExecutionJournal>>['append']
>[0] {
  return {
    eventId,
    streamKind: 'test.stream',
    streamId: 'stream-one',
    expectedStreamRevision,
    type: 'test.observation',
    payloadSchemaVersion: 1,
    payload: { eventId },
    correlationId: 'corr-fault-classification',
  }
}

/**
 * A write target that fails once, then behaves.
 *
 * `tornWrite` is the case the plan names: a real prefix reaches the file and
 * then the write stops making progress, so the journal is left with an
 * unterminated final line. Returning zero without writing anything would leave
 * the file untouched and would prove nothing about torn-tail recovery.
 */
function failingWriteTarget(fault: {
  readonly on: 'write' | 'sync'
  readonly raise: () => Error
  readonly tornWrite?: boolean
}): (target: JournalWriteTarget) => JournalWriteTarget {
  let commits = 0
  let fired = false
  // Armed from the second commit, so the pre-fault append lands first and the
  // fault has some existing history to be recovered against.
  return (target) => {
    commits += 1
    const armed = commits >= 2
    return {
      write: async (buffer, offset, length) => {
        if (fault.on === 'write' && armed && !fired) {
          fired = true
          if (fault.tornWrite !== true) throw fault.raise()
          // Land a genuine prefix — half the record — then stop.
          const prefix = Math.max(1, Math.floor(length / 2))
          await target.write(buffer, offset, prefix)
          return { bytesWritten: 0 }
        }
        return target.write(buffer, offset, length)
      },
      sync: async () => {
        if (fault.on === 'sync' && armed && !fired) {
          fired = true
          throw fault.raise()
        }
        await target.sync()
      },
    }
  }
}

function errnoError(code: string): Error {
  const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
  error.code = code
  return error
}

/**
 * A recoverable commit fault must not be reported as corruption, and must not
 * move the counter an operator watches for damage.
 */
async function assertRecoverableCommitFault(input: {
  readonly scopeRoot: string
  readonly interceptor?: (target: JournalWriteTarget) => JournalWriteTarget
  /**
   * How much of the history survives the fault. This differs by fault and
   * must not be shared: a torn record is truncated, a record whose barrier
   * failed is already complete on disk and stays authoritative if it
   * validates, and a fault raised before any bytes leave leaves only what was
   * there before.
   */
  readonly survivingEvents: readonly string[]
  /** Set up the fault when it is not a write-target one. */
  readonly induce?: (journalDirectory: string) => void
  /** Clear the fault before the reopen. */
  readonly clear?: (journalDirectory: string) => void
}): Promise<void> {
  const { scopeRoot } = input
  let journalDirectory = ''
  const journal = await initializeExecutionJournal({
    scopeRoot,
    identity: IDENTITY,
    ...(input.interceptor === undefined
      ? {}
      : { writeInterceptorForTest: input.interceptor }),
  })
  try {
    journalDirectory = journal.journalDirectoryPath
    const first = await journal.append(observation('event-one', 0))
    assert.equal(first.kind, 'appended', 'the pre-fault append must land')
    input.induce?.(journalDirectory)

    const corruptionBefore = journal.getMetrics().corruptionCount
    await assert.rejects(
      journal.append(observation('event-two', 1)),
      (error: unknown) => {
        // The journal's boundary is typed: a raw `ENOSPC` from Node, or a
        // permission error from a validator, must not cross it unwrapped —
        // callers classify on the journal's own code.
        assert.ok(
          error instanceof ExecutionJournalError,
          `the fault must surface as a journal error: ${String(error)}`,
        )
        assert.equal(
          error.code,
          'retired',
          'a recoverable fault retires the handle; it does not corrupt the journal',
        )
        assert.ok(
          error.cause instanceof Error,
          'and the underlying errno or path failure must survive as the cause',
        )
        return true
      },
    )
    assert.equal(
      journal.getMetrics().corruptionCount,
      corruptionBefore,
      'and must not move the counter that means the journal needs repair',
    )

    // This handle is finished either way: `prepareBatchEntry` advanced the
    // in-memory index before the write, and `resyncIndexLocked` only catches
    // up when the file *grew*, so appending again through this object would
    // chain from a record that never reached disk. It must refuse — but not
    // as corruption, which would tell a caller to repair an intact journal.
    await assert.rejects(
      journal.append(observation('event-after-fault', 1)),
      (error: unknown) => {
        assert.ok(
          error instanceof ExecutionJournalError,
          `the retired handle must refuse with a journal error: ${String(error)}`,
        )
        assert.equal(
          error.code,
          'retired',
          'and must keep saying it is retired, not that the journal is damaged',
        )
        return true
      },
    )
  } finally {
    await journal.close()
  }

  input.clear?.(journalDirectory)

  // The durable history is intact, so a fresh handle carries on from it.
  const reopened = await initializeExecutionJournal({
    scopeRoot,
    identity: IDENTITY,
  })
  try {
    const scan = await reopened.scan()
    assert.deepEqual(
      scan.events.map((event) => event.eventId),
      [...input.survivingEvents],
      'the surviving history must be exactly what this fault leaves behind',
    )
    const resumed = await reopened.append(
      observation('event-three', input.survivingEvents.length),
    )
    assert.equal(
      resumed.kind,
      'appended',
      'and a fresh handle must be able to append again',
    )
  } finally {
    await reopened.close()
  }
}

test('a partial write is recoverable, not corruption', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))
  await assertRecoverableCommitFault({
    scopeRoot,
    interceptor: failingWriteTarget({
      on: 'write',
      tornWrite: true,
      raise: () => new Error('unused'),
    }),
    // The torn record was never acknowledged, so truncating it loses nothing.
    survivingEvents: ['event-one'],
  })
})

test('a failed durability barrier is recoverable, not corruption', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))
  await assertRecoverableCommitFault({
    scopeRoot,
    interceptor: failingWriteTarget({ on: 'sync', raise: () => errnoError('EIO') }),
    // The record reached the file before the barrier failed. It was never
    // acknowledged to the caller, but it validates, so a reopen keeps it —
    // discarding a complete record would lose durable history, not a tail.
    survivingEvents: ['event-one', 'event-two'],
  })
})

test('ENOSPC and EIO from the write path are recoverable, not corruption', async (t) => {
  for (const code of ['ENOSPC', 'EIO'] as const) {
    const scopeRoot = makeScopeRoot()
    t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))
    await assertRecoverableCommitFault({
      scopeRoot,
      interceptor: failingWriteTarget({ on: 'write', raise: () => errnoError(code) }),
      // Raised before any bytes leave, so the file is untouched.
      survivingEvents: ['event-one'],
    })
  }
})

test('a shrunken journal is corruption and stays refused', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))

  const journal = await initializeExecutionJournal({ scopeRoot, identity: IDENTITY })
  try {
    assert.equal((await journal.append(observation('event-one', 0))).kind, 'appended')

    // Damage: the file is now shorter than the length the journal validated.
    const journalFile = path.join(
      journal.journalDirectoryPath,
      'journal.jsonl',
    )
    fs.truncateSync(journalFile, 2)

    const corruptionBefore = journal.getMetrics().corruptionCount
    await assert.rejects(
      journal.append(observation('event-two', 1)),
      (error: unknown) =>
        error instanceof ExecutionJournalError && error.code === 'corrupt',
      'a journal that shrank below its validated length is damaged',
    )
    assert.ok(
      journal.getMetrics().corruptionCount > corruptionBefore,
      'and must move the counter that means it needs repair',
    )

    // Damage is permanent for this handle: repair is explicit, never implicit.
    await assert.rejects(
      journal.append(observation('event-three', 1)),
      (error: unknown) =>
        error instanceof ExecutionJournalError && error.code === 'corrupt',
      'a damaged journal must keep refusing',
    )
  } finally {
    await journal.close()
  }
})

test('a manifest that cannot be read is recoverable, not corruption', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))

  const journal = await initializeExecutionJournal({ scopeRoot, identity: IDENTITY })
  const manifestPath = path.join(journal.journalDirectoryPath, 'manifest.json')
  const manifest = fs.readFileSync(manifestPath)
  try {
    assert.equal((await journal.append(observation('event-one', 0))).kind, 'appended')

    // The environment row of the table: the manifest is momentarily gone.
    // Nothing about the journal's identity has been shown to have changed.
    fs.rmSync(manifestPath)

    const corruptionBefore = journal.getMetrics().corruptionCount
    await assert.rejects(
      journal.append(observation('event-two', 1)),
      (error: unknown) => {
        assert.ok(
          error instanceof ExecutionJournalError,
          `the fault must surface as a journal error: ${String(error)}`,
        )
        assert.equal(
          error.code,
          'retired',
          'a missing manifest is an environment fault, not damage',
        )
        assert.ok(
          error.cause instanceof Error,
          'and the underlying failure must survive as the cause',
        )
        return true
      },
    )
    assert.equal(
      journal.getMetrics().corruptionCount,
      corruptionBefore,
      'and must not be counted as damage',
    )
  } finally {
    await journal.close()
  }

  fs.writeFileSync(manifestPath, manifest, { mode: 0o600 })
  const reopened = await initializeExecutionJournal({ scopeRoot, identity: IDENTITY })
  try {
    assert.equal(
      (await reopened.append(observation('event-three', 1))).kind,
      'appended',
      'once the manifest is back, a fresh handle must carry on',
    )
  } finally {
    await reopened.close()
  }
})

/**
 * The plan's fifth inner case: the environment row of the classification
 * table, reached through the permission checks the journal actually performs.
 *
 * `chmod 0666` is the honest induction for it. Both checks refuse a
 * world-writable file — `validateEnvironmentLocked` for the manifest,
 * `resyncIndexLocked` for the journal — and a mode an operator can restore is
 * the clearest example of a fault that is not damage.
 */
test('a world-writable manifest is an environment fault, not corruption', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))
  await assertRecoverableCommitFault({
    scopeRoot,
    induce: (directory) =>
      fs.chmodSync(path.join(directory, 'manifest.json'), 0o666),
    clear: (directory) =>
      fs.chmodSync(path.join(directory, 'manifest.json'), 0o600),
    // Refused before the commit writes anything.
    survivingEvents: ['event-one'],
  })
})

test('a world-writable journal file is an environment fault, not corruption', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))
  await assertRecoverableCommitFault({
    scopeRoot,
    induce: (directory) =>
      fs.chmodSync(path.join(directory, 'journal.jsonl'), 0o666),
    clear: (directory) =>
      fs.chmodSync(path.join(directory, 'journal.jsonl'), 0o600),
    survivingEvents: ['event-one'],
  })
})

/**
 * The append lock is the journal's own boundary, so its failures must arrive
 * as the journal's own error type. Only `timeout` is translated today, so an
 * `in_use` or `corrupt` lock escapes as a `ProcessFileLockError` — a foreign
 * type whose code means nothing to a caller deciding whether to retry, and
 * which after this package also decides whether the handle survives.
 */
test('a corrupt lock record surfaces as a journal error, not a foreign one', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))

  const journal = await initializeExecutionJournal({ scopeRoot, identity: IDENTITY })
  try {
    assert.equal((await journal.append(observation('event-one', 0))).kind, 'appended')
    fs.writeFileSync(
      path.join(journal.journalDirectoryPath, 'journal.lock'),
      'not a lock record',
      { mode: 0o600 },
    )

    await assert.rejects(
      journal.append(observation('event-two', 1)),
      (error: unknown) => {
        assert.ok(
          error instanceof ExecutionJournalError,
          `the lock's failure must be translated, not rethrown: ${String(error)}`,
        )
        assert.equal(
          error.code,
          'corrupt',
          'an unreadable lock record is damage to durable state, so a reopen ' +
            'would meet it again',
        )
        assert.ok(
          error.cause instanceof ProcessFileLockError,
          'and the original failure must survive as the cause',
        )
        return true
      },
    )
  } finally {
    await journal.close()
  }
})

test('a lock held by a live process surfaces as a journal error, not a foreign one', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))

  // A zero timeout is what makes the lock report `in_use` rather than waiting
  // it out, and it is a public option rather than a test-only seam.
  const journal = await initializeExecutionJournal({
    scopeRoot,
    identity: IDENTITY,
    lockTimeoutMs: 0,
  })
  try {
    assert.equal((await journal.append(observation('event-one', 0))).kind, 'appended')

    const held = await acquireProcessFileLock({
      lockPath: path.join(journal.journalDirectoryPath, 'journal.lock'),
      record: createCrossProcessFileLockRecord(),
      adapter: crossProcessFileLockAdapter,
      timeoutMs: 1_000,
      waitDescription: 'held by the test',
    })
    try {
      await assert.rejects(
        journal.append(observation('event-two', 1)),
        (error: unknown) => {
          assert.ok(
            error instanceof ExecutionJournalError,
            `the lock's failure must be translated, not rethrown: ${String(error)}`,
          )
          assert.equal(
            error.code,
            'lock_timeout',
            'a lock held by someone else is a transient contention failure, ' +
              'and it reuses the public code that already means exactly that',
          )
          assert.ok(
            error.cause instanceof ProcessFileLockError,
            'and the original failure must survive as the cause',
          )
          return true
        },
      )
    } finally {
      await held.release()
    }
  } finally {
    await journal.close()
  }
})

/**
 * The two failure kinds need two counters, not one that stops moving.
 *
 * `corruptionCount` used to increment for every commit failure, including
 * `ENOSPC` and permission faults, which made it useless as an integrity
 * alarm. Classifying the faults fixed the false positives but left transient
 * retirement invisible — and an operator watching for a workspace that keeps
 * retiring handles has nothing to watch.
 */
test('a retirement is counted apart from corruption, and counted once', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))

  const journal = await initializeExecutionJournal({
    scopeRoot,
    identity: IDENTITY,
    writeInterceptorForTest: failingWriteTarget({
      on: 'write',
      raise: () => errnoError('ENOSPC'),
    }),
  })
  try {
    assert.equal((await journal.append(observation('event-one', 0))).kind, 'appended')
    assert.equal(
      journal.getMetrics().retiredHandleCount,
      0,
      'nothing has been retired yet',
    )

    await assert.rejects(journal.append(observation('event-two', 1)))
    assert.equal(
      journal.getMetrics().retiredHandleCount,
      1,
      'the transition to retired is the countable event',
    )
    assert.equal(
      journal.getMetrics().corruptionCount,
      0,
      'and it is not counted as damage',
    )

    // Later refusals are the same retirement, not new ones. Counting them
    // would turn one fault into a rate that grows with how often a caller
    // retries.
    await assert.rejects(journal.append(observation('event-three', 1)))
    await assert.rejects(journal.append(observation('event-four', 1)))
    assert.equal(
      journal.getMetrics().retiredHandleCount,
      1,
      'a retired handle refusing again is not a second retirement',
    )
  } finally {
    await journal.close()
  }
})

test('an integrity fault counts as corruption, never as a retirement', async (t) => {
  const scopeRoot = makeScopeRoot()
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }))

  const journal = await initializeExecutionJournal({ scopeRoot, identity: IDENTITY })
  try {
    assert.equal((await journal.append(observation('event-one', 0))).kind, 'appended')
    fs.truncateSync(path.join(journal.journalDirectoryPath, 'journal.jsonl'), 2)

    await assert.rejects(journal.append(observation('event-two', 1)))
    assert.equal(
      journal.getMetrics().corruptionCount,
      1,
      'damage moves the counter that means the journal needs repair',
    )
    assert.equal(
      journal.getMetrics().retiredHandleCount,
      0,
      'and must not also read as a recoverable retirement',
    )
  } finally {
    await journal.close()
  }
})
