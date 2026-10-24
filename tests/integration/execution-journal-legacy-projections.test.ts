import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityApprovalPort,
  CapabilityDispatchEvent,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import type { CapabilityDurableDispatchPort } from '../../contracts/durable-dispatch.js'
import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import {
  initializeExecutionJournal,
  type ExecutionJournal,
} from '../../core/execution-journal.js'
import {
  createJournalBackedDurableDispatch,
  DURABLE_DISPATCH_STREAM_KIND,
} from '../../core/durable-dispatch-journal.js'
import { rebuildCapabilityEvidenceProjection } from '../../core/capability-dispatch-projection.js'
import { createAssignmentCapabilityResultStore } from '../../services/capability-result-content-store.js'
import { WORKFLOW_STATE_STREAM_KIND } from '../../workflows/workflow-journal.js'

const TEST_IDENTITY: ExecutionJournalScopeIdentity = {
  scopeKind: 'assignment',
  scopeId: 'assignment-scope-projections',
  tenantId: 'tenant-test',
  sessionId: 'session-projections',
  runId: 'run-projections',
  assignmentId: 'assignment-projections',
}

test('one canonical journal append derives the legacy capability evidence view', async () => {
  const scopeRoot = makeScopeRoot()
  const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    let legacyAuthoritativeWrites = 0
    const dispatcher = makeDispatcher(journal, evidencePath, () => {
      legacyAuthoritativeWrites += 1
    })
    try {
      const result = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation(),
        adapter: makeAdapter(),
      })
      assert.equal(result.status, 'completed')

      // The canonical append path never invoked the independent legacy writer.
      assert.equal(legacyAuthoritativeWrites, 0)

      const projected = readEvidence(evidencePath)
      const types = projected.map((event) => event.type)
      assert.deepEqual(types, [
        'capability.dispatch.requested',
        'capability.dispatch.started',
        'capability.dispatch.completed',
      ])
      for (const event of projected) {
        assert.equal(event.dispatchId, projected[0]?.dispatchId)
        assert.equal(event.capabilityId, 'test.project')
        assert.equal(event.argumentDigest.length, 64)
        assert.equal(event.sessionId, 'session-projections')
        assert.equal(event.runId, 'run-projections')
        assert.equal(event.assignmentId, 'assignment-projections')
      }
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('rebuilding the projection from the journal reproduces the same view', async () => {
  const scopeRoot = makeScopeRoot()
  const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const dispatcher = makeDispatcher(journal, evidencePath, () => undefined)
    try {
      const result = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation(),
        adapter: makeAdapter(),
      })
      assert.equal(result.status, 'completed')
      const before = fs.readFileSync(evidencePath, 'utf8')
      fs.rmSync(evidencePath)

      await rebuildCapabilityEvidenceProjection(journal, evidencePath)

      assert.equal(fs.readFileSync(evidencePath, 'utf8'), before)
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('approval evidence is journal-derived and survives projection rebuild', async () => {
  const scopeRoot = makeScopeRoot()
  const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    let legacyAuthoritativeWrites = 0
    const approval: CapabilityApprovalPort = {
      request: async (input) => {
        const interaction = {
          interactionId: 'projection-approval',
          reused: false,
        }
        await input.onInteraction(interaction)
        return { outcome: 'approved', interaction }
      },
    }
    const dispatcher = makeDispatcher(
      journal,
      evidencePath,
      () => {
        legacyAuthoritativeWrites += 1
      },
      undefined,
      approval,
    )
    try {
      const result = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-projection-approval'),
        adapter: makeApprovalAdapter(),
      })
      assert.equal(result.status, 'completed')
      assert.equal(
        legacyAuthoritativeWrites,
        0,
        'approval facts must not bypass the journal projection writer',
      )
      assert.deepEqual(
        readEvidence(evidencePath).map((event) => event.type),
        [
          'capability.dispatch.requested',
          'capability.dispatch.approval_requested',
          'capability.dispatch.approval_resolved',
          'capability.dispatch.started',
          'capability.dispatch.completed',
        ],
      )
      const before = fs.readFileSync(evidencePath, 'utf8')
      fs.rmSync(evidencePath)

      await rebuildCapabilityEvidenceProjection(journal, evidencePath)

      assert.equal(fs.readFileSync(evidencePath, 'utf8'), before)
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * Deliberate contract reversal (AC8, N31).
 *
 * This test previously appended a non-dispatch event and asserted the evidence
 * projection then read `lagging`. That was the defect, encoded as the
 * expectation. The evidence view derives from `capability.dispatch` events
 * only — every other stream projects to nothing — but both classifiers
 * compared the watermark against the *journal-wide* last sequence.
 *
 * One journal per assignment holds workflow state as well (ADR §1), so after
 * the first workflow transition is appended the watermark can never again
 * equal the journal's last sequence. Every enrolled assignment that runs a
 * workflow therefore reported `lagging` permanently, which destroys the one
 * signal an operator has for telling a stalled derive from ordinary traffic.
 *
 * The comparand is the maximum sequence among dispatch-stream events.
 */
test('lag is measured against dispatch events, not the whole journal', async () => {
  const scopeRoot = makeScopeRoot()
  const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const dispatcher = makeDispatcher(journal, evidencePath, () => undefined)
    try {
      await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation(),
        adapter: makeAdapter(),
      })
      const durable = durablePortFor(journal, {
        capabilityEvidenceProjectionPath: evidencePath,
      })
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
      )

      // A workflow transition on the same journal. The evidence view derives
      // nothing from it, so it cannot leave that view behind.
      await journal.append({
        eventId: 'projection-workflow-event',
        streamKind: WORKFLOW_STATE_STREAM_KIND,
        streamId: 'workflow-projection-lag',
        expectedStreamRevision: 0,
        type: 'workflow.state.published',
        payloadSchemaVersion: 1,
        payload: { index: 1 },
        correlationId: 'corr-projection-lag',
      })
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
        'an event this view does not derive from must not report it behind',
      )

      // And the signal still works: a dispatch event appended behind the
      // port's back is one this view *should* have derived.
      await journal.append({
        eventId: 'projection-unprojected-dispatch',
        streamKind: DURABLE_DISPATCH_STREAM_KIND,
        streamId: 'dispatch-unprojected',
        expectedStreamRevision: 0,
        type: 'capability.dispatch.requested',
        payloadSchemaVersion: 1,
        payload: {
          identity: {
            type: 'capability.dispatch.requested',
            dispatchId: 'dispatch-unprojected',
          },
        },
        correlationId: 'corr-projection-unprojected',
      })
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'lagging',
        'a dispatch event this view has not applied must still report lag',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('a projection that cannot be written is reported as lag, not silently dropped', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    // The projection's parent path is a regular file, so every derive fails.
    const blockedParent = path.join(scopeRoot, 'blocked')
    fs.writeFileSync(blockedParent, 'not a directory', { mode: 0o600 })
    const evidencePath = path.join(blockedParent, 'capability-dispatch-events.jsonl')
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const durable = durablePortFor(journal, {
      capabilityEvidenceProjectionPath: evidencePath,
    })
    try {
      // The canonical append still succeeds; only the derived view fails.
      await durable.recordRequested({
        dispatchId: 'dispatch-projection-failure',
        attemptId: 'attempt-one',
        identity: { type: 'capability.dispatch.requested' },
      })
      // Deliberate contract reversal (AC8): this used to read
      // `rebuild-required`, which tells an operator to republish a view that
      // will repair itself. The fault is transient and the watermark never
      // moved, so the view is behind and recoverable — which is what the name
      // of this test said all along.
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'lagging',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * AC8: a failed projection batch is retried and reported, never lost.
 *
 * The fault is the projection's parent path being a regular file, so every
 * derive fails with `ENOTDIR`. That is deliberate: `chmod 0444` on the target
 * does nothing when the test process runs as root, which some CI containers
 * do, and `AGENTS.md` forbids papering over that with a conditional skip. A
 * regular file where a directory must be fails for everyone, and it clears by
 * replacing the file with the directory.
 *
 * The journal's own `writeInterceptorForTest` seam cannot serve here: it wraps
 * the canonical write target, so it would fail the append itself — the one
 * thing this contract says must keep succeeding.
 */
test('a projection that failed catches up from the journal, exactly once', async () => {
  const scopeRoot = makeScopeRoot()
  const logsDirectory = path.join(scopeRoot, 'logs')
  const evidencePath = path.join(logsDirectory, 'capability-dispatch-events.jsonl')
  try {
    // Blocked before anything derives: `logs` is a file, not a directory.
    fs.writeFileSync(logsDirectory, 'not a directory', { mode: 0o600 })
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    // One port for every dispatch, as the registry hands out per assignment.
    const durable = durablePortFor(journal, {
      capabilityEvidenceProjectionPath: evidencePath,
    })
    const dispatcher = makeDispatcher(
      journal,
      evidencePath,
      () => undefined,
      durable,
    )
    try {
      // Two dispatches while the view cannot be written. The canonical append
      // is the authority and has already returned, so a projection failure
      // must not turn a durably executed capability into a failed dispatch.
      for (const attempt of [1, 2]) {
        const result = await dispatcher.dispatch({
          context: makeContext(),
          invocation: makeInvocation(`call-projection-${attempt}`),
          adapter: makeAdapter(),
        })
        assert.equal(
          result.status,
          'completed',
          `dispatch ${attempt} must succeed while the projection is failing`,
        )
      }
      // `lagging`, not `rebuild-required`. The fault is transient and the
      // watermark did not move, so this view is recoverable by reading
      // forward from it. `rebuild-required` is reserved for drift that
      // catch-up cannot fix — a reducer version change, or a view whose
      // history is gone — and telling an operator to rebuild a view that will
      // repair itself is the wrong instruction.
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'lagging',
        'a transient write fault leaves the view behind, not unrecoverable',
      )

      // The fault clears.
      fs.rmSync(logsDirectory)
      fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 })

      const third = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-projection-3'),
        adapter: makeAdapter(),
      })
      assert.equal(third.status, 'completed')

      // Every canonical dispatch event, once. The two lost batches are not
      // in any buffer any more — they are recovered from the journal.
      const projected = readEvidence(evidencePath)
      const identities = projected.map(
        (event) => `${event.dispatchId}:${event.type}`,
      )
      assert.equal(
        new Set(identities).size,
        identities.length,
        `no line may appear twice: ${JSON.stringify(identities)}`,
      )
      assert.equal(
        identities.length,
        9,
        'three dispatches, three legacy lines each, none lost: ' +
          JSON.stringify(identities),
      )
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
        'and once caught up, the view reports itself current',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * AC8: a view that was current once must still catch up when it later falls
 * behind.
 *
 * The dangerous shape is a fault that arrives *after* a success, because that
 * is when a port believes its view is complete. Catch-up runs once and is
 * remembered, so a batch that fails afterwards leaves a gap nothing goes back
 * for, and the next batch that succeeds advances the watermark over it.
 *
 * The fault here is the evidence file being replaced by a directory: `open`
 * for append then fails with `EISDIR` for any user, unlike `chmod`, and unlike
 * blocking the parent it leaves the metadata — and this test's saved copy of
 * the history — intact, so the recovery being measured is of the missing batch
 * rather than of everything.
 */
test('a view that fell behind after being current still catches up', async () => {
  const scopeRoot = makeScopeRoot()
  const logsDirectory = path.join(scopeRoot, 'logs')
  const evidencePath = path.join(logsDirectory, 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const durable = durablePortFor(journal, {
      capabilityEvidenceProjectionPath: evidencePath,
    })
    const dispatcher = makeDispatcher(
      journal,
      evidencePath,
      () => undefined,
      durable,
    )
    try {
      const first = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-late-1'),
        adapter: makeAdapter(),
      })
      assert.equal(first.status, 'completed')
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
        'the view starts complete, which is what makes the next part matter',
      )
      const historyBeforeFault = fs.readFileSync(evidencePath, 'utf8')

      // The view becomes unwritable. Its metadata is untouched, so the
      // watermark still records the first batch as applied.
      fs.rmSync(evidencePath)
      fs.mkdirSync(evidencePath, { recursive: true, mode: 0o700 })

      const second = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-late-2'),
        adapter: makeAdapter(),
      })
      assert.equal(
        second.status,
        'completed',
        'a projection fault still must not fail the dispatch',
      )
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'lagging',
        'and the view says it is behind',
      )

      // The fault clears and the history is back exactly as it was.
      fs.rmSync(evidencePath, { recursive: true })
      fs.writeFileSync(evidencePath, historyBeforeFault, { mode: 0o600 })

      const third = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-late-3'),
        adapter: makeAdapter(),
      })
      assert.equal(third.status, 'completed')

      const identities = readEvidence(evidencePath).map(
        (event) => `${event.dispatchId}:${event.type}`,
      )
      assert.equal(
        new Set(identities).size,
        identities.length,
        `no line may appear twice: ${JSON.stringify(identities)}`,
      )
      assert.equal(
        identities.length,
        9,
        'the batch lost after the view was current is recovered too: ' +
          JSON.stringify(identities),
      )
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * AC8: a batch that succeeds must not step over one that did not.
 *
 * The watermark is the durable record of what the view is missing, and it only
 * ever moves forward. So an ordinary batch applied while an earlier one is
 * still unrecovered would advance it past that gap, and the lost lines become
 * unreachable — catch-up reads forward from the watermark and would find
 * nothing to do.
 *
 * The two failures have to be independent to see this, so the journal's
 * `scan` is what fails here while the view itself is writable again. Catch-up
 * needs the scan; the hot batch does not.
 */
test('a batch does not advance the watermark past one still unrecovered', async () => {
  const scopeRoot = makeScopeRoot()
  const logsDirectory = path.join(scopeRoot, 'logs')
  const evidencePath = path.join(logsDirectory, 'capability-dispatch-events.jsonl')
  try {
    fs.writeFileSync(logsDirectory, 'not a directory', { mode: 0o600 })
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    let scanFails = false
    // A plain delegate, not a prototype clone: cloning a live journal would
    // let writes land on the copy while reads fell through to the original.
    const scanGated: typeof journal = {
      ...journal,
      journalDirectoryPath: journal.journalDirectoryPath,
      append: (input) => journal.append(input),
      scan: async () => {
        if (scanFails) throw new Error('journal scan unavailable')
        return journal.scan()
      },
      scanStream: (streamKind, streamId) =>
        journal.scanStream(streamKind, streamId),
      close: () => journal.close(),
      getMetrics: () => journal.getMetrics(),
      isRetired: () => journal.isRetired(),
    }
    const durable = durablePortFor(scanGated, {
      capabilityEvidenceProjectionPath: evidencePath,
    })
    const dispatcher = makeDispatcher(
      journal,
      evidencePath,
      () => undefined,
      durable,
    )
    try {
      // First batch is lost: the view cannot be written at all.
      const first = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-gap-1'),
        adapter: makeAdapter(),
      })
      assert.equal(first.status, 'completed')

      // The view becomes writable, but the journal cannot be read, so the
      // lost batch cannot be recovered yet.
      fs.rmSync(logsDirectory)
      fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 })
      scanFails = true

      const second = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-gap-2'),
        adapter: makeAdapter(),
      })
      assert.equal(second.status, 'completed')

      // Reading works again, so the gap is recoverable — unless the second
      // batch already moved the watermark past it.
      scanFails = false
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
      )
      const identities = readEvidence(evidencePath).map(
        (event) => `${event.dispatchId}:${event.type}`,
      )
      assert.equal(
        new Set(identities).size,
        identities.length,
        `no line may appear twice: ${JSON.stringify(identities)}`,
      )
      assert.equal(
        identities.length,
        6,
        'both dispatches are recovered, so neither batch was stepped over: ' +
          JSON.stringify(identities),
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * AC8, through the real permission path.
 *
 * `chmod 0444` on the view is the fault an operator actually meets, so one
 * case exercises it end to end rather than only the constructed ones. It is
 * not the deterministic proof and must not be read as one: a process running
 * as root — which some CI containers do — appends to a read-only file
 * regardless, and the derive simply succeeds.
 *
 * So this asserts the invariant that holds under both outcomes: the dispatch
 * succeeds either way, and once the mode is restored the view holds every
 * canonical event exactly once. `AGENTS.md` forbids a conditional skip, and
 * an assertion that only holds for non-root would be one. The deterministic
 * evidence lives in the `ENOTDIR` and `EISDIR` journeys above.
 */
test('a read-only evidence view still ends with every event exactly once', async () => {
  const scopeRoot = makeScopeRoot()
  const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const durable = durablePortFor(journal, {
      capabilityEvidenceProjectionPath: evidencePath,
    })
    const dispatcher = makeDispatcher(
      journal,
      evidencePath,
      () => undefined,
      durable,
    )
    try {
      const first = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-chmod-1'),
        adapter: makeAdapter(),
      })
      assert.equal(first.status, 'completed')

      fs.chmodSync(evidencePath, 0o444)
      const second = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-chmod-2'),
        adapter: makeAdapter(),
      })
      assert.equal(
        second.status,
        'completed',
        'whether or not the write was refused, the dispatch is durable',
      )

      fs.chmodSync(evidencePath, 0o600)
      const third = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-chmod-3'),
        adapter: makeAdapter(),
      })
      assert.equal(third.status, 'completed')

      const identities = readEvidence(evidencePath).map(
        (event) => `${event.dispatchId}:${event.type}`,
      )
      assert.equal(
        new Set(identities).size,
        identities.length,
        `no line may appear twice: ${JSON.stringify(identities)}`,
      )
      assert.equal(
        identities.length,
        9,
        'every canonical event reaches the view: ' + JSON.stringify(identities),
      )
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
      )
    } finally {
      fs.chmodSync(evidencePath, 0o600)
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * AC8: an unrecoverable view is not retried on every read.
 *
 * Catch-up costs a full journal scan, because `ExecutionJournal` has no range
 * read. That is affordable once per port — which is what "on open" means when
 * a new process brings a new port — and not affordable per status call. Drift
 * catch-up cannot repair does not become repairable by scanning again, so
 * rescanning for it is pure cost on a read path.
 */
test('a view needing a rebuild is not rescanned on every status call', async () => {
  const scopeRoot = makeScopeRoot()
  const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      // A view whose reducer has moved on: catch-up cannot fix that, and
      // must not keep trying.
      const metadataPath = path.join(
        journal.journalDirectoryPath,
        'projections',
        'capability-evidence.json',
      )
      fs.mkdirSync(path.dirname(metadataPath), { recursive: true })
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify({
          schemaVersion: 1,
          projectionId: 'capability-evidence',
          reducerVersion: 999,
          lastAppliedSequence: 0,
          updatedAt: new Date(0).toISOString(),
          appliedLineCount: 0,
        })}\n`,
        'utf8',
      )

      const counted = countingJournal(journal)
      const durable = durablePortFor(counted.journal, {
        capabilityEvidenceProjectionPath: evidencePath,
      })
      await durable.recordRequested({
        dispatchId: 'dispatch-drift',
        attemptId: 'attempt-one',
        identity: {
          type: 'capability.dispatch.requested',
          dispatchId: 'dispatch-drift',
        },
      })

      for (let call = 0; call < 3; call += 1) {
        assert.equal(
          await durable.projectionStatus('capability-evidence'),
          'rebuild-required',
          'reducer drift is not something catch-up can repair',
        )
      }
      assert.equal(
        counted.scans(),
        1,
        'the journal is scanned once, not once per read of the status',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * AC8 (N2): concurrent flushes are serialised.
 *
 * The queue field was declared and awaited but never assigned, so two callers
 * both saw a resolved promise and both ran the body — the second returning
 * while the first was still applying, and reporting a view current that was
 * not. Scans are the observable: catch-up runs once per port, so one pair of
 * concurrent flushes must produce exactly one scan. Two means both bodies ran
 * against the same unguarded state.
 */
test('two concurrent flushes do not both run the catch-up', async () => {
  const scopeRoot = makeScopeRoot()
  const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    try {
      const counted = countingJournal(journal)
      const durable = durablePortFor(counted.journal, {
        capabilityEvidenceProjectionPath: evidencePath,
      })
      await durable.recordRequested({
        dispatchId: 'dispatch-serial',
        attemptId: 'attempt-one',
        identity: {
          type: 'capability.dispatch.requested',
          dispatchId: 'dispatch-serial',
        },
      })

      // The first flush parks inside its catch-up, so the second arrives
      // while it is genuinely still running.
      const release = deferred()
      counted.hold(release.promise)
      const first = durable.flushProjections()
      const second = durable.flushProjections()
      await new Promise((settle) => setImmediate(settle))
      release.resolve()
      await Promise.all([first, second])

      assert.equal(
        counted.scans(),
        1,
        'the second caller joined the first rather than starting its own',
      )
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * AC20: the canonical projection is as hardened as the writer it replaces.
 *
 * Agents hold write access to the run workspace, so a symlink planted at the
 * evidence file — or a `logs/` that is itself a symlink — is reachable rather
 * than theoretical. The writer this projection replaced refuses both, opening
 * with `O_NOFOLLOW` and cross-checking the opened handle against `lstat` by
 * device and inode. The projection has to refuse them too, or moving the write
 * onto the journal quietly removed a control.
 *
 * The whole access path matters, not just the append. Catch-up reads the
 * target before writing it — `fs.stat` for the deleted-view check and
 * `fs.readFile` for the deduplication — and both follow symlinks, so a
 * redirected file would be read as well as written.
 *
 * And the dispatch must still succeed. The journal is the authority; refusing
 * to derive a view must not turn a durably executed capability into a failure.
 */
test('the projection refuses a symlinked evidence file and leaves it untouched', async () => {
  const scopeRoot = makeScopeRoot()
  // A separate root, so "outside" means outside the workspace rather than
  // merely outside `logs/`. A sibling under `scopeRoot` would prove the
  // narrower thing while reading as though it proved this one.
  const elsewhere = makeScopeRoot()
  const logsDirectory = path.join(scopeRoot, 'logs')
  const evidencePath = path.join(logsDirectory, 'capability-dispatch-events.jsonl')
  const outsideTarget = path.join(elsewhere, 'outside-events.jsonl')
  try {
    fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(outsideTarget, 'sentinel\n', { mode: 0o600 })
    fs.symlinkSync(outsideTarget, evidencePath, 'file')

    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const durable = durablePortFor(journal, {
      capabilityEvidenceProjectionPath: evidencePath,
    })
    const dispatcher = makeDispatcher(
      journal,
      evidencePath,
      () => undefined,
      durable,
    )
    try {
      const settled = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-symlinked-file'),
        adapter: makeAdapter(),
      })
      assert.equal(
        settled.status,
        'completed',
        'the journal is the authority; a refused projection is not a failed ' +
          'dispatch',
      )

      assert.equal(
        fs.readFileSync(outsideTarget, 'utf8'),
        'sentinel\n',
        'nothing may be written through the symlink, and the file it points ' +
          'at is outside the workspace entirely',
      )
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'lagging',
        'and the view reports itself behind rather than current',
      )
      // The canonical record is complete regardless of the view.
      const stream = await journal.scan()
      assert.ok(
        stream.events.some(
          (event) => event.type === 'capability.dispatch.accepted',
        ),
        'the dispatch is durably recorded on the journal',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('the projection refuses a symlinked logs directory and writes nothing outside', async () => {
  const scopeRoot = makeScopeRoot()
  // Again a separate root: the claim is about leaving the workspace.
  const elsewhere = makeScopeRoot()
  const logsDirectory = path.join(scopeRoot, 'logs')
  const outsideLogs = path.join(elsewhere, 'outside-logs')
  const evidencePath = path.join(logsDirectory, 'capability-dispatch-events.jsonl')
  try {
    fs.mkdirSync(outsideLogs, { recursive: true, mode: 0o700 })
    fs.symlinkSync(
      outsideLogs,
      logsDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const durable = durablePortFor(journal, {
      capabilityEvidenceProjectionPath: evidencePath,
    })
    const dispatcher = makeDispatcher(
      journal,
      evidencePath,
      () => undefined,
      durable,
    )
    try {
      const settled = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation('call-symlinked-logs'),
        adapter: makeAdapter(),
      })
      assert.equal(settled.status, 'completed')

      assert.equal(
        fs.readdirSync(outsideLogs).length,
        0,
        'a redirected logs directory must receive nothing, and it is outside ' +
          'the workspace entirely',
      )
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'lagging',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('a durable port that derives no evidence projection keeps the legacy writer', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const legacyTypes: string[] = []
    // No capabilityEvidenceProjectionPath: nothing derives the legacy view,
    // so suppressing the legacy writer would drop the evidence entirely.
    const dispatcher = new CapabilityDispatcher({
      bindings: new CapabilityInvocationBindings({
        maxActivePerScope: 4,
        maxRetainedPerScope: 32,
      }),
      authority: { authorize: async () => ({ kind: 'allow' }) },
      policy: { evaluate: async () => ({ kind: 'allow' }) },
      budget: {
        preflight: async () => ({ kind: 'not-metered' }),
        reserve: async () => ({ reservationId: 'unused' }),
        settle: async () => ({ costTracked: false, budgetOverrun: false }),
        release: async () => undefined,
      },
      evidence: {
        append: async (event) => {
          legacyTypes.push(event.type)
        },
      },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: () => Date.now() },
      ids: { nextAttemptId: () => `attempt-${randomUUID()}` },
      durable: async () => durablePortFor(journal),
    })
    try {
      const result = await dispatcher.dispatch({
        context: makeContext(),
        invocation: makeInvocation(),
        adapter: makeAdapter(),
      })
      assert.equal(result.status, 'completed')
      assert.ok(legacyTypes.includes('capability.dispatch.requested'))
      assert.ok(legacyTypes.includes('capability.dispatch.started'))
      assert.ok(legacyTypes.includes('capability.dispatch.completed'))
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})

/**
 * Every port in this file dispatches completed results, so every one of them
 * needs the assignment store those results are retained in: since Phase 3 the
 * journal names result content and never holds it, so a port without a store
 * cannot accept a result at all.
 */
function durablePortFor(
  journal: ExecutionJournal,
  options: { readonly capabilityEvidenceProjectionPath?: string } = {},
): ReturnType<typeof createJournalBackedDurableDispatch> {
  return createJournalBackedDurableDispatch(journal, {
    ...options,
    resultContentStore: createAssignmentCapabilityResultStore({
      // `<assignment>/.runtime/execution-journal` back to `<assignment>`.
      assignmentPath: path.dirname(path.dirname(journal.journalDirectoryPath)),
    }),
  })
}

function makeScopeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execution-journal-projections-'))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = () => settle()
  })
  return { promise, resolve }
}

type OpenJournal = Awaited<ReturnType<typeof initializeExecutionJournal>>

/**
 * The same journal, with its scans counted and optionally held.
 *
 * A plain delegate, not a prototype clone: cloning a live journal would let
 * writes land on the copy while reads fell through to the original. Scans are
 * the observable because catch-up costs one — `ExecutionJournal` has no range
 * read — so counting them is how "once per port" and "serialised" are checked.
 */
function countingJournal(journal: OpenJournal): {
  readonly journal: OpenJournal
  scans(): number
  hold(gate: Promise<void>): void
} {
  let scans = 0
  let gate: Promise<void> | undefined
  return {
    journal: {
      ...journal,
      journalDirectoryPath: journal.journalDirectoryPath,
      append: (input) => journal.append(input),
      scan: async () => {
        scans += 1
        if (gate) await gate
        return journal.scan()
      },
      scanStream: (streamKind, streamId) =>
        journal.scanStream(streamKind, streamId),
      close: () => journal.close(),
      getMetrics: () => journal.getMetrics(),
      isRetired: () => journal.isRetired(),
    },
    scans: () => scans,
    hold: (held) => {
      gate = held
    },
  }
}

/**
 * `durable` may be given an existing port. The registry caches one port per
 * assignment and hands the same instance to every dispatch, so a fixture that
 * built a fresh one per resolve would give each dispatch its own catch-up
 * state — and would pass while the production lifecycle failed.
 */
function makeDispatcher(
  journal: Awaited<ReturnType<typeof initializeExecutionJournal>>,
  evidencePath: string,
  onLegacyAuthoritativeWrite: () => void,
  sharedPort?: CapabilityDurableDispatchPort,
  approval?: CapabilityApprovalPort,
): CapabilityDispatcher {
  return new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: 4,
      maxRetainedPerScope: 32,
    }),
    authority: { authorize: async () => ({ kind: 'allow' }) },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'unused' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    ...(approval ? { approval } : {}),
    evidence: {
      append: async () => {
        onLegacyAuthoritativeWrite()
      },
    },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: () => Date.now() },
    ids: { nextAttemptId: () => `attempt-${randomUUID()}` },
    durable: async () =>
      sharedPort ??
      durablePortFor(journal, {
        capabilityEvidenceProjectionPath: evidencePath,
      }),
  })
}

function makeApprovalAdapter(): CapabilityAdapter {
  return {
    capabilityId: 'test.project',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: {
        kind: 'require-approval',
        reason: 'Projection approval coverage.',
      },
      approval: {
        serverId: 'projection-test',
        namespacedToolName: 'test.project',
        title: 'Projection test approval',
        description: 'Approve the projection test capability.',
      },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => ({ projected: true }),
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function makeAdapter(): CapabilityAdapter {
  return {
    capabilityId: 'test.project',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => ({ projected: true }),
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function makeContext(): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-projections',
    sessionId: 'session-projections',
    runId: 'run-projections',
    assignmentId: 'assignment-projections',
    agentPath: 'agents/projections',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: 'projection-worker',
    },
  }
}

/**
 * `toolCallId` identifies the invocation, so repeating it is a *retry* of the
 * same dispatch: the bindings replay the retained first result instead of
 * executing again, and nothing new reaches the journal. A test that means
 * "three dispatches" has to say so.
 */
function makeInvocation(toolCallId = 'call-projections'): CapabilityInvocation {
  return {
    capabilityId: 'test.project',
    source: { kind: 'builtin', id: 'projections', version: '1' },
    toolCallId,
    input: { target: 'projection-view' },
  }
}

function readEvidence(evidencePath: string): CapabilityDispatchEvent[] {
  return fs
    .readFileSync(evidencePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CapabilityDispatchEvent)
}

test('concurrent appends project every event exactly once', async () => {
  const scopeRoot = makeScopeRoot()
  const evidencePath = path.join(scopeRoot, 'logs', 'capability-dispatch-events.jsonl')
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: TEST_IDENTITY,
    })
    const durable = durablePortFor(journal, {
      capabilityEvidenceProjectionPath: evidencePath,
    })
    try {
      const total = 50
      await Promise.all(
        Array.from({ length: total }, (_unused, index) =>
          durable.recordRequested({
            dispatchId: `dispatch-${index}`,
            attemptId: 'attempt-one',
            identity: {
              type: 'capability.dispatch.requested',
              dispatchId: `dispatch-${index}`,
            },
          }),
        ),
      )

      // Derives are deferred off the append path, so the view is judged after
      // the port settles them. `projectionStatus` is that settle point; these
      // 50 appends are all non-terminal, so nothing else would flush them.
      assert.equal(
        await durable.projectionStatus('capability-evidence'),
        'current',
      )

      // The derived view is read-modify-write; without serialisation the
      // concurrent derives overwrite each other and the loss is silent. That
      // loss is still what this asserts — deferral changes when the derive
      // runs, not whether every event survives it.
      const projected = readEvidence(evidencePath)
      assert.equal(projected.length, total)
      assert.equal(
        new Set(projected.map((event) => event.dispatchId)).size,
        total,
        'every dispatch must appear exactly once',
      )
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true })
  }
})
