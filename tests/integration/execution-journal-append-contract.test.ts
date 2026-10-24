import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ExecutionJournalError,
  type ExecutionJournalScopeIdentity,
} from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import {
  acquireProcessFileLock,
  createCrossProcessFileLockRecord,
  crossProcessFileLockAdapter,
} from '../../core/cross-process-file-lock.js'

const TEST_IDENTITY: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'append-contract',
  tenantId: 'tenant-test',
  sessionId: 'session-append-contract',
  runId: 'run-append-contract',
  assignmentId: 'assignment-append-contract',
}

function makeScopeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execution-journal-append-'))
}

function observation(
  eventId: string,
  expectedStreamRevision: number,
  causationEventId?: string,
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
    correlationId: 'corr-append-contract',
    ...(causationEventId === undefined ? {} : { causationEventId }),
  }
}

test('causation may only reference an event the journal already holds', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const first = await journal.append(observation('event-one', 0))
      assert.equal(first.kind, 'appended')

      // A backward reference is the ordering the reader enforces.
      const second = await journal.append(
        observation('event-two', 1, 'event-one'),
      )
      assert.equal(second.kind, 'appended')

      // A reference the journal cannot resolve would become a forward
      // reference the moment that identity is appended, and the reader
      // rejects forward references as corruption. Refuse it at the door.
      await assert.rejects(
        journal.append(observation('event-three', 2, 'event-four')),
        (error: unknown) =>
          error instanceof ExecutionJournalError &&
          error.code === 'append_invalid',
      )
    } finally {
      await journal.close()
    }

    // Whatever the writer accepted must still be readable after a restart.
    const reopened = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const scan = await reopened.scan()
    assert.equal(scan.eventCount, 2)
    await reopened.close()
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * Opening a journal waits for the per-scope lock. Without cancellation a
 * caller that gives up leaves initialization running in the background, where
 * it can still take the lock and provision a journal nobody owns.
 */
test('an aborted open stops promptly and takes no lock', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    // Provision the journal once so the lock path exists, then hold the lock.
    const first = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const lockPath = path.join(first.journalDirectoryPath, 'journal.lock')
    await first.close()

    const holder = await acquireProcessFileLock({
      lockPath,
      record: createCrossProcessFileLockRecord(),
      adapter: crossProcessFileLockAdapter,
      timeoutMs: 1_000,
    })
    try {
      const controller = new AbortController()
      const startedAt = Date.now()
      const pending = initializeExecutionJournal({
        scopeRoot,
        identity: TEST_IDENTITY,
        signal: controller.signal,
        lockTimeoutMs: 30_000,
      })
      setTimeout(() => controller.abort(), 50)
      await assert.rejects(pending, (error: unknown) => error instanceof Error)
      // Promptly, rather than after the lock timeout.
      assert.ok(
        Date.now() - startedAt < 5_000,
        'aborted open must not wait out the lock timeout',
      )
    } finally {
      await holder.release()
    }

    // The scope is still usable afterwards: the abandoned attempt left nothing
    // behind that a later open would mistake for a valid journal.
    const reopened = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    assert.equal((await reopened.scan()).eventCount, 0)
    await reopened.close()
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})
