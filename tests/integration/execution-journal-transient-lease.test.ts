/**
 * A journal held for the length of one chat reply, and no longer.
 *
 * Task and workflow assignments end at a terminal transition, and
 * `releaseAssignment` closes their journal there. An agent-chat assignment has
 * no such moment: it exists for one reply. Without a scoped lease every
 * selected-agent turn would leave an open journal, its in-memory index, and a
 * file descriptor behind until the process exits.
 *
 * The lease is non-terminal on purpose: releasing the last one closes the
 * journal but must not bar the assignment, because a retry or an operator read
 * has to be able to reopen it from what is on disk.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CapabilityExecutionContext } from '../../contracts/capability-dispatch.js'
import {
  initializeExecutionJournal,
  type ExecutionJournal,
} from '../../core/execution-journal.js'
import {
  ExecutionJournalUnavailableError,
  WorkspaceExecutionJournalRegistry,
} from '../../services/workspace-execution-journal-registry.js'

const TENANT = 'tenant-transient-lease'

interface OpenerLog {
  readonly opens: readonly string[]
  readonly closes: readonly string[]
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-lease-'))
}

function makeAssignment(
  workspacePath: string,
  assignmentId = 'assignment-one',
): CapabilityExecutionContext {
  fs.mkdirSync(
    path.join(
      workspacePath,
      'sessions',
      'session-one',
      'runs',
      'run-one',
      'assignments',
      assignmentId,
    ),
    { recursive: true },
  )
  return {
    contractVersion: 1,
    requestId: `request-${assignmentId}`,
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId,
    agentPath: 'agents/probe',
    authority: { kind: 'runtime-assignment', processIdentity: 'probe' },
  }
}

function budget() {
  return {
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = () => settle()
  })
  return { promise, resolve }
}

/**
 * A registry whose opens and closes are observable.
 *
 * The seam the registry already exposes, so the lifecycle is proved from what
 * the registry does to real journals rather than from its private maps.
 */
function observedRegistry(
  workspacePath: string,
  hooks: {
    readonly beforeOpen?: (assignmentId: string) => Promise<void>
    readonly beforeClose?: (assignmentId: string) => Promise<void>
    readonly afterClose?: (assignmentId: string) => void
  } = {},
): { registry: WorkspaceExecutionJournalRegistry; log: OpenerLog } {
  const opens: string[] = []
  const closes: string[] = []
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
    journalOpener: async ({ scopeRoot, identity }) => {
      await hooks.beforeOpen?.(identity.scopeId)
      opens.push(identity.scopeId)
      const journal = await initializeExecutionJournal({ scopeRoot, identity })
      const wrapped: ExecutionJournal = {
        manifest: journal.manifest,
        journalDirectoryPath: journal.journalDirectoryPath,
        append: (input) => journal.append(input),
        scan: () => journal.scan(),
        scanStream: (streamKind, streamId) =>
          journal.scanStream(streamKind, streamId),
        getMetrics: () => journal.getMetrics(),
        isRetired: () => journal.isRetired(),
        close: async () => {
          await hooks.beforeClose?.(identity.scopeId)
          await journal.close()
          closes.push(identity.scopeId)
          hooks.afterClose?.(identity.scopeId)
        },
      }
      return wrapped
    },
  })
  return { registry, log: { opens, closes } }
}

async function appendProbe(
  journal: ExecutionJournal,
  eventId: string,
  revision: number,
): Promise<void> {
  const outcome = await journal.append({
    eventId,
    streamKind: 'agent.turn',
    streamId: 'assignment-one',
    expectedStreamRevision: revision,
    type: 'probe.event',
    payloadSchemaVersion: 1,
    payload: { eventId },
    correlationId: 'probe',
  })
  assert.equal(outcome.kind, 'appended', eventId)
}

test('concurrent leases share one journal and only the last release closes it', async () => {
  const workspacePath = makeWorkspace()
  const { registry, log } = observedRegistry(workspacePath)
  try {
    const context = makeAssignment(workspacePath)
    const first = await registry.acquireJournalHandle({ context, ...budget() })
    const second = await registry.acquireJournalHandle({ context, ...budget() })
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.journal, second.journal, 'one assignment, one journal')
    assert.deepEqual(log.opens, ['assignment-one'])

    await first.release()
    assert.deepEqual(
      log.closes,
      [],
      'a lease still held keeps the journal open',
    )
    // Idempotent: a second release of the same lease is not a second release.
    await first.release()
    assert.deepEqual(log.closes, [])

    await second.release()
    assert.deepEqual(log.closes, ['assignment-one'])
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an acquisition during a close waits for it and reopens from durable state', async () => {
  const workspacePath = makeWorkspace()
  const closeStarted = deferred()
  const finishClose = deferred()
  const { registry, log } = observedRegistry(workspacePath, {
    beforeClose: async () => {
      closeStarted.resolve()
      await finishClose.promise
    },
  })
  try {
    const context = makeAssignment(workspacePath)
    const lease = await registry.acquireJournalHandle({ context, ...budget() })
    assert.ok(lease)
    await appendProbe(lease.journal, 'probe-one', 0)

    const closing = lease.release()
    await closeStarted.promise
    let acquisitionSettled = false
    const acquiring = registry.acquireJournalHandle({
      context,
      ...budget(),
    }).finally(() => {
      acquisitionSettled = true
    })
    await Promise.resolve()
    assert.equal(acquisitionSettled, false, 'the close still owns this assignment')

    finishClose.resolve()
    await closing
    const reopened = await acquiring
    assert.ok(reopened, 'a released assignment is reopenable, not barred')
    assert.notEqual(reopened.journal, lease.journal, 'a fresh handle')
    assert.deepEqual(log.opens, ['assignment-one', 'assignment-one'])

    // Reopened from disk: the durable history is intact and the stream
    // revision continues where the first handle left it.
    const stream = await reopened.journal.scanStream(
      'agent.turn',
      'assignment-one',
    )
    assert.equal(stream.events.length, 1)
    await appendProbe(reopened.journal, 'probe-two', 1)
    await reopened.release()
    assert.deepEqual(log.closes, ['assignment-one', 'assignment-one'])
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an acquisition racing the final release never receives a closing journal', async () => {
  const workspacePath = makeWorkspace()
  const { registry } = observedRegistry(workspacePath)
  try {
    const context = makeAssignment(workspacePath)
    const first = await registry.acquireJournalHandle({ context, ...budget() })
    assert.ok(first)

    // Start the borrower before releasing the current last lease. Reserving the
    // new lease and deciding whether the old one may close must be one atomic
    // registry transition.
    const acquiring = registry.acquireJournalHandle({ context, ...budget() })
    const releasing = first.release()
    const second = await acquiring
    assert.ok(second)
    await releasing

    await appendProbe(second.journal, 'probe-after-race', 0)
    await second.release()
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a failed transient close keeps waiting acquisitions and dispatch resolution fail-closed', async () => {
  const workspacePath = makeWorkspace()
  const closeStarted = deferred()
  const finishClose = deferred()
  let failThisClose = true
  const { registry, log } = observedRegistry(workspacePath, {
    beforeClose: async () => {
      closeStarted.resolve()
      await finishClose.promise
    },
    afterClose: () => {
      if (!failThisClose) return
      failThisClose = false
      throw new Error('transient journal close failed')
    },
  })
  try {
    const context = makeAssignment(workspacePath)
    const lease = await registry.acquireJournalHandle({ context, ...budget() })
    assert.ok(lease)

    const releasing = lease.release()
    await closeStarted.promise
    const acquiring = registry.acquireJournalHandle({ context, ...budget() })
    const resolving = registry.resolve({ context, ...budget() })
    const unavailableBecauseCloseFailed = (error: unknown): boolean => {
      assert.ok(error instanceof ExecutionJournalUnavailableError)
      assert.ok(error.cause instanceof Error)
      assert.match(error.cause.message, /transient journal close failed/)
      return true
    }
    const releaseFailure = assert.rejects(
      releasing,
      /transient journal close failed/,
    )
    const acquisitionFailure = assert.rejects(
      acquiring,
      unavailableBecauseCloseFailed,
    )
    const resolutionFailure = assert.rejects(
      resolving,
      unavailableBecauseCloseFailed,
    )
    finishClose.resolve()

    await Promise.all([releaseFailure, acquisitionFailure, resolutionFailure])
    assert.deepEqual(log.opens, ['assignment-one'])

    // A rejected close cannot prove that its handle is gone. Keep the
    // assignment unavailable instead of risking two authorities; a process
    // restart is the recovery boundary.
    await assert.rejects(
      registry.acquireJournalHandle({ context, ...budget() }),
      unavailableBecauseCloseFailed,
    )
    assert.deepEqual(log.opens, ['assignment-one'])
    await assert.rejects(registry.close(), /transient journal close failed/)
  } finally {
    finishClose.resolve()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('registry shutdown waits for a transient close already in progress', async () => {
  const workspacePath = makeWorkspace()
  const closeStarted = deferred()
  const finishClose = deferred()
  const { registry } = observedRegistry(workspacePath, {
    beforeClose: async () => {
      closeStarted.resolve()
      await finishClose.promise
    },
  })
  try {
    const context = makeAssignment(workspacePath)
    const lease = await registry.acquireJournalHandle({ context, ...budget() })
    assert.ok(lease)

    const releasing = lease.release()
    await closeStarted.promise
    let shutdownSettled = false
    const shutdown = registry.close().finally(() => {
      shutdownSettled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(shutdownSettled, false, 'shutdown must join the transient close')

    finishClose.resolve()
    await Promise.all([releasing, shutdown])
  } finally {
    finishClose.resolve()
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a terminal release still bars the assignment, and a lease cannot reopen it', async () => {
  const workspacePath = makeWorkspace()
  const { registry } = observedRegistry(workspacePath)
  try {
    const context = makeAssignment(workspacePath)
    const lease = await registry.acquireJournalHandle({ context, ...budget() })
    assert.ok(lease)
    await lease.release()

    await registry.releaseAssignment(context)

    await assert.rejects(
      registry.acquireJournalHandle({ context, ...budget() }),
      /released|unavailable/i,
      'terminal release is permanent; a transient lease must not undo it',
    )
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a lease released while another assignment is open closes only its own', async () => {
  const workspacePath = makeWorkspace()
  const { registry, log } = observedRegistry(workspacePath)
  try {
    const one = makeAssignment(workspacePath, 'assignment-one')
    const two = makeAssignment(workspacePath, 'assignment-two')
    const leaseOne = await registry.acquireJournalHandle({
      context: one,
      ...budget(),
    })
    const leaseTwo = await registry.acquireJournalHandle({
      context: two,
      ...budget(),
    })
    assert.ok(leaseOne)
    assert.ok(leaseTwo)

    await leaseOne.release()
    assert.deepEqual(log.closes, ['assignment-one'])

    // The other assignment is untouched and still usable.
    assert.ok(await leaseTwo.journal.scan())
    await leaseTwo.release()
    assert.deepEqual(log.closes, ['assignment-one', 'assignment-two'])
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
