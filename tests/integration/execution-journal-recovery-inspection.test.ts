import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityAssignmentScope,
  CapabilityDispatchResult,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import type {
  CapabilityDurableDispatchPort,
  CapabilityRecoveryPolicy,
  OperatorResolutionDecision,
} from '../../contracts/durable-dispatch.js'
import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import {
  initializeExecutionJournal,
  readExecutionJournal,
  type ExecutionJournal,
} from '../../core/execution-journal.js'
import { createJournalBackedDurableDispatch } from '../../core/durable-dispatch-journal.js'
import {
  capabilityResultsDirectoryPath,
  createAssignmentCapabilityResultStore,
} from '../../services/capability-result-content-store.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { normalizeCanonicalJsonObject } from '../../core/canonical-json-hash.js'
import { buildSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { startApiServer } from '../../server/api-server.js'
import {
  ExecutionJournalInspectionService,
  type ExecutionJournalResolutionSupport,
} from '../../services/execution-journal-inspection.js'
import {
  resolveExecutionJournalOptions,
  WorkspaceExecutionJournalRegistry,
} from '../../services/workspace-execution-journal-registry.js'

const INPUT = { target: 'read-path' }

/**
 * Every port in this file resolves or replays a retained result, so every one
 * of them needs the assignment store those results live in: since Phase 3 the
 * journal names result content and never holds it, so a port without a store
 * cannot accept a result at all.
 */
function durablePortFor(
  journal: ExecutionJournal,
): ReturnType<typeof createJournalBackedDurableDispatch> {
  return createJournalBackedDurableDispatch(journal, {
    resultContentStore: createAssignmentCapabilityResultStore({
      // `<assignment>/.runtime/execution-journal` back to `<assignment>`.
      assignmentPath: path.dirname(path.dirname(journal.journalDirectoryPath)),
    }),
  })
}

function makeScopeRoot(): string {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'execution-journal-recovery-inspection-'),
  )
  const assignmentPath = path.join(workspace, 'assignments', 'run-one')
  fs.mkdirSync(assignmentPath, { recursive: true })
  return assignmentPath
}

function workspaceOf(assignmentPath: string): string {
  return path.dirname(path.dirname(assignmentPath))
}

function journalIdentity(): ExecutionJournalScopeIdentity {
  return {
    scopeKind: 'assignment',
    scopeId: 'run-one',
    tenantId: 'local',
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId: 'run-one',
  }
}

const DEFAULT_SCOPE: CapabilityAssignmentScope = {
  sessionId: 'session-one',
  runId: 'run-one',
  assignmentId: 'run-one',
}

function makeContext(
  scope: CapabilityAssignmentScope = DEFAULT_SCOPE,
): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-read-path',
    ...scope,
    agentPath: 'agents/read-path',
    authority: { kind: 'runtime-assignment', processIdentity: 'read-path' },
  }
}

function makeInvocation(): CapabilityInvocation {
  return {
    capabilityId: 'test.readpath',
    source: { kind: 'builtin', id: 'read-path', version: '1' },
    toolCallId: 'call-read-path',
    input: INPUT,
  }
}

function makeAdapter(): CapabilityAdapter {
  return {
    capabilityId: 'test.readpath',
    prepare: async () => ({
      effect: serialCapabilityEffect('read-only'),
      risk: 'test-read',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => ({ answer: 42 }),
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function makeDispatcher(durable: CapabilityDurableDispatchPort): CapabilityDispatcher {
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
    evidence: { append: async () => undefined },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: () => Date.now() },
    ids: { nextAttemptId: () => `attempt-${randomUUID()}` },
    durable: async () => durable,
  })
}

test('recovery and inspection expose the same safe result from the canonical journal after restart', async () => {
  const scopeRoot = makeScopeRoot()
  const argumentDigest = normalizeCanonicalJsonObject(INPUT).hash.value
  let dispatchId = ''
  try {
    // Run one: dispatch to completion through the durable journal.
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const durable = durablePortFor(journal)
    const dispatcher = makeDispatcher(durable)
    const result = await dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: makeAdapter(),
    })
    assert.equal(result.status, 'completed')
    dispatchId = result.dispatchId
    await journal.close()

    // Simulated restart: reopen the journal and build a fresh port.
    const reopened = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const port = durablePortFor(reopened)

    const recovery = await port.recover({ dispatchId, argumentDigest })
    const inspection = await port.inspectOutcome({ dispatchId })

    assert.equal(recovery.kind, 'retained')
    assert.equal(inspection.kind, 'outcome')
    if (recovery.kind !== 'retained' || inspection.kind !== 'outcome') return
    assert.equal(inspection.state, 'accepted')
    // Both read paths expose the same safe result, sourced from the journal.
    assert.deepEqual(inspection.result, recovery.result)
    assert.ok(inspection.result)
    assert.equal(inspection.result?.status, 'completed')
    const inspected = inspection.result
    if (inspected && inspected.status === 'completed') {
      assert.deepEqual(inspected.value, { answer: 42 })
    }
    assert.ok(inspection.lastAppliedSequence > 0)
    await reopened.close()
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

test('a dispatch retried after a pre-effect crash stays replayable', async () => {
  const scopeRoot = makeScopeRoot()
  const argumentDigest = normalizeCanonicalJsonObject(INPUT).hash.value
  try {
    // Run one: the process recorded `requested` and then died before the
    // capability prepared or started, leaving a retriable stream.
    const crashed = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const crashedPort = durablePortFor(crashed)
    const dispatchId = 'dispatch-retry-probe'
    await crashedPort.recordRequested({ dispatchId, attemptId: 'attempt-crashed' })
    await crashed.close()

    // Run two: a fresh attempt on the same dispatch identity completes.
    const retried = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const retriedPort = durablePortFor(retried)
    assert.deepEqual(await retriedPort.recover({ dispatchId, argumentDigest }), {
      kind: 'retriable',
    })
    await retriedPort.recordRequested({ dispatchId, attemptId: 'attempt-two' })
    await retriedPort.recordPrepared({
      dispatchId,
      attemptId: 'attempt-two',
      argumentDigest,
      capabilityId: 'test.readpath',
      effect: serialCapabilityEffect('read-only'),
      recoveryPolicy: 'read_only_retryable',
    })
    await retriedPort.recordStarted({ dispatchId, attemptId: 'attempt-two' })
    await retriedPort.recordCommitted({ dispatchId, attemptId: 'attempt-two' })
    await retriedPort.recordAccepted({
      dispatchId,
      attemptId: 'attempt-two',
      result: {
        status: 'completed',
        dispatchId,
        value: { answer: 42 },
        costTracked: false,
        budgetOverrun: false,
      },
    })
    await retried.close()

    // Run three: the accepted result of the retry is still reusable.
    const reopened = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const port = durablePortFor(reopened)
    const recovery = await port.recover({ dispatchId, argumentDigest })
    const inspection = await port.inspectOutcome({ dispatchId })
    assert.equal(recovery.kind, 'retained')
    assert.equal(inspection.kind, 'outcome')
    if (recovery.kind !== 'retained' || inspection.kind !== 'outcome') return
    assert.equal(inspection.state, 'accepted')
    assert.deepEqual(inspection.result, recovery.result)
    await reopened.close()
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

async function recordUnprovenAttempt(
  port: CapabilityDurableDispatchPort,
  dispatchId: string,
  recoveryPolicy: CapabilityRecoveryPolicy,
  options: { readonly commit?: boolean } = {},
): Promise<void> {
  const attemptId = 'attempt-unproven'
  await port.recordRequested({ dispatchId, attemptId })
  await port.recordPrepared({
    dispatchId,
    attemptId,
    argumentDigest: normalizeCanonicalJsonObject(INPUT).hash.value,
    capabilityId: 'test.readpath',
    effect: serialCapabilityEffect('mutating'),
    recoveryPolicy,
  })
  await port.recordStarted({ dispatchId, attemptId })
  if (options.commit) await port.recordCommitted({ dispatchId, attemptId })
}

test('the recorded adapter recovery policy decides whether an unproven effect may retry', async () => {
  const cases: ReadonlyArray<{
    readonly policy: CapabilityRecoveryPolicy
    readonly expected: string
  }> = [
    // A read-only effect can be safely repeated even when its outcome is
    // unknown, so an unproven attempt stays retriable.
    { policy: 'read_only_retryable', expected: 'retriable' },
    { policy: 'reconcilable', expected: 'reconcile' },
    { policy: 'non_retryable', expected: 'blocked' },
    // No declared policy must never be read as permission to repeat.
    { policy: 'unknown', expected: 'blocked' },
  ]
  for (const { policy, expected } of cases) {
    const scopeRoot = makeScopeRoot()
    try {
      const journal = await initializeExecutionJournal({
        scopeRoot,
        identity: journalIdentity(),
      })
      const port = durablePortFor(journal)
      await recordUnprovenAttempt(port, `dispatch-${policy}`, policy)
      const recovery = await port.recover({
        dispatchId: `dispatch-${policy}`,
        argumentDigest: normalizeCanonicalJsonObject(INPUT).hash.value,
      })
      assert.equal(recovery.kind, expected, policy)
      await journal.close()
    } finally {
      fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
    }
  }
})

/**
 * The policy is gone from the union; it is not gone from disk.
 *
 * `idempotent_with_key` promised retry against an external idempotency key
 * that never reached a dispatcher (A-13). Journals written while it was
 * declared still carry the text, and the durable recovery port has to keep
 * refusing to repeat those effects — the promise was never kept, so removing
 * it changes nothing about what may run again.
 */
test('a legacy idempotent_with_key policy still refuses retry after restart', async () => {
  // The dispatch identity the real dispatcher derives, learned from a
  // throwaway run so the seeded stream is the one a replay will find.
  const probeScope = makeScopeRoot()
  let dispatchId = ''
  try {
    const probeJournal = await initializeExecutionJournal({
      scopeRoot: probeScope,
      identity: journalIdentity(),
    })
    const probe = await makeDispatcher(
      durablePortFor(probeJournal),
    ).dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: makeAdapter(),
    })
    dispatchId = probe.dispatchId
    await probeJournal.close()
  } finally {
    fs.rmSync(workspaceOf(probeScope), { recursive: true, force: true })
  }

  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    // Written as raw journal text: the recorder's types no longer express this
    // policy, which is precisely the state an older journal is in.
    const legacy: readonly [string, string, CanonicalJsonObject][] = [
      ['requested', 'capability.dispatch.requested', { attemptId: 'a-1' }],
      [
        'prepared',
        'capability.dispatch.prepared',
        {
          attemptId: 'a-1',
          argumentDigest: normalizeCanonicalJsonObject(INPUT).hash.value,
          capabilityId: 'test.readpath',
          effectKind: 'mutating',
          effectConcurrency: 'serial',
          recoveryPolicy: 'idempotent_with_key',
        },
      ],
      ['started', 'capability.dispatch.started', { attemptId: 'a-1' }],
    ]
    let revision = 0
    for (const [stage, type, payload] of legacy) {
      const appended = await journal.append({
        eventId: `${dispatchId}:${stage}:a-1`,
        streamKind: 'capability.dispatch',
        streamId: dispatchId,
        expectedStreamRevision: revision,
        type,
        payloadSchemaVersion: 1,
        payload,
        correlationId: dispatchId,
      })
      assert.equal(appended.kind, 'appended')
      if (appended.kind !== 'appended') return
      revision = appended.event.streamRevision
    }

    // The restart. Everything above is what the older process left on disk;
    // everything below reads it back through a handle that has never seen it,
    // which is the boundary this compatibility rule actually lives on.
    await journal.close()
    const reopened = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const port = durablePortFor(reopened)
    const recovery = await port.recover({
      dispatchId,
      argumentDigest: normalizeCanonicalJsonObject(INPUT).hash.value,
    })
    assert.equal(
      recovery.kind,
      'blocked',
      'the durable recovery port refuses to repeat an unproven effect whose ' +
        'only declared permission was one the runtime never honoured',
    )

    // And the refusal reaches a real dispatch: the executor is never entered.
    const counter = { executions: 0 }
    const result = await makeDispatcher(port).dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: countingAdapter(counter),
    })
    assert.equal(result.status, 'indeterminate', JSON.stringify(result))
    assert.equal(
      result.status === 'indeterminate' ? result.code : '',
      'durable_replay_blocked',
    )
    assert.equal(counter.executions, 0, 'the effect must not run again')
    await reopened.close()
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

test('a committed but unaccepted attempt reports reconcile regardless of policy', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const port = durablePortFor(journal)
    await recordUnprovenAttempt(port, 'dispatch-committed', 'non_retryable', {
      commit: true,
    })
    const recovery = await port.recover({
      dispatchId: 'dispatch-committed',
      argumentDigest: normalizeCanonicalJsonObject(INPUT).hash.value,
    })
    assert.equal(recovery.kind, 'reconcile')
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

test('blocked and reconcilable replays surface distinct dispatch result codes', async () => {
  // The dispatch identity is derived from the context and invocation, so a
  // throwaway run in its own scope reveals the identity to seed.
  const probeScope = makeScopeRoot()
  let dispatchId = ''
  try {
    const probeJournal = await initializeExecutionJournal({
      scopeRoot: probeScope,
      identity: journalIdentity(),
    })
    const probe = await makeDispatcher(
      durablePortFor(probeJournal),
    ).dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: makeAdapter(),
    })
    dispatchId = probe.dispatchId
    await probeJournal.close()
  } finally {
    fs.rmSync(workspaceOf(probeScope), { recursive: true, force: true })
  }

  const cases: ReadonlyArray<{
    readonly commit: boolean
    readonly expected: string
  }> = [
    { commit: false, expected: 'durable_replay_blocked' },
    { commit: true, expected: 'durable_replay_reconcile_required' },
  ]
  for (const { commit, expected } of cases) {
    const scopeRoot = makeScopeRoot()
    try {
      const journal = await initializeExecutionJournal({
        scopeRoot,
        identity: journalIdentity(),
      })
      const port = durablePortFor(journal)
      await recordUnprovenAttempt(port, dispatchId, 'non_retryable', { commit })
      const result = await makeDispatcher(port).dispatch({
        context: makeContext(),
        invocation: makeInvocation(),
        adapter: makeAdapter(),
      })
      assert.equal(result.status, 'indeterminate')
      assert.equal(
        result.status === 'indeterminate' ? result.code : '',
        expected,
      )
      await journal.close()
    } finally {
      fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
    }
  }
})

test('inspection reports unsupported_version rather than guessing on an unknown payload schema', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    // Append a dispatch stream event with an unrecognized payload schema.
    // Version 2 exists, but only for a payload that carries a retained
    // result: `requested` carries none, so version 2 is not a shape this
    // build defines for it and must not be read as though it were.
    await journal.append({
      eventId: 'future-event',
      streamKind: 'capability.dispatch',
      streamId: 'dispatch-future',
      expectedStreamRevision: 0,
      type: 'capability.dispatch.requested',
      payloadSchemaVersion: 2,
      payload: { attemptId: 'attempt-future' },
      correlationId: 'dispatch-future',
    })
    const port = durablePortFor(journal)
    const inspection = await port.inspectOutcome({ dispatchId: 'dispatch-future' })
    assert.equal(inspection.kind, 'unsupported_version')
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

test('inspection of an unknown dispatch reports not_found', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const port = durablePortFor(journal)
    const inspection = await port.inspectOutcome({ dispatchId: 'dispatch-none' })
    assert.equal(inspection.kind, 'not_found')
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

test('reading a dispatch outcome never creates journal storage', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const port = durablePortFor(journal)
    const dispatchId = 'dispatch-read-only'
    // The result is retained in the assignment's content store, so the read
    // path has to resolve that store rather than a directory of its own.
    await port.recordRequested({ dispatchId, attemptId: 'attempt-one' })
    await port.recordAccepted({
      dispatchId,
      attemptId: 'attempt-one',
      result: {
        status: 'completed',
        dispatchId,
        value: { blob: 'x'.repeat(200_000) },
        costTracked: false,
        budgetOverrun: false,
      },
    })
    const contentStore = capabilityResultsDirectoryPath(scopeRoot)
    assert.equal(fs.existsSync(contentStore), true)

    // The retained content is gone; reading must report that, not re-create
    // the storage it only ever reads from.
    fs.rmSync(contentStore, { recursive: true, force: true })
    const inspection = await port.inspectOutcome({ dispatchId })
    assert.equal(inspection.kind, 'outcome')
    if (inspection.kind === 'outcome') assert.equal(inspection.result, undefined)

    // A read path must not provision storage it only ever reads from.
    assert.equal(fs.existsSync(contentStore), false)
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

test('the durable port is resolved per dispatch from the execution context', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const seen: string[] = []
    const port = durablePortFor(journal)
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
      evidence: { append: async () => undefined },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: () => Date.now() },
      ids: { nextAttemptId: () => `attempt-${randomUUID()}` },
      durable: async ({ context, signal, deadlineMs }) => {
        // The resolver receives the assignment identity, a live signal, and a
        // bounded budget, because opening a journal can wait for its lock.
        assert.ok(signal instanceof AbortSignal)
        assert.ok(deadlineMs > Date.now())
        seen.push(context.assignmentId)
        return context.assignmentId === 'run-one' ? port : undefined
      },
    })

    const journaled = await dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: makeAdapter(),
    })
    const unjournaled = await dispatcher.dispatch({
      context: { ...makeContext(), assignmentId: 'other-assignment' },
      invocation: { ...makeInvocation(), toolCallId: 'call-other' },
      adapter: makeAdapter(),
    })

    assert.equal(journaled.status, 'completed')
    assert.equal(unjournaled.status, 'completed')
    assert.deepEqual(seen, ['run-one', 'other-assignment'])
    // Only the assignment with a resolved port has a canonical stream.
    assert.equal(
      (await port.inspectOutcome({ dispatchId: journaled.dispatchId })).kind,
      'outcome',
    )
    assert.equal(
      (await port.inspectOutcome({ dispatchId: unjournaled.dispatchId })).kind,
      'not_found',
    )
    await journal.close()
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

test('an unavailable durable authority fails the dispatch closed', async () => {
  const scopeRoot = makeScopeRoot()
  try {
    let executed = 0
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
      evidence: { append: async () => undefined },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: () => Date.now() },
      ids: { nextAttemptId: () => `attempt-${randomUUID()}` },
      // Enrolled but unopenable: executing without a durability barrier is
      // forbidden (ADR §7), so the executor must never be entered.
      durable: async () => {
        throw new Error('journal unavailable')
      },
    })
    const result = await dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: {
        capabilityId: 'test.readpath',
        prepare: async () => {
          executed += 1
          return {
            effect: serialCapabilityEffect('mutating'),
            risk: 'test-mutating',
            argumentNames: ['target'],
            policyDecision: { kind: 'allow' },
            authorize: async () => ({ kind: 'allow' }),
            execute: async () => ({ answer: 42 }),
            acceptResult: async ({ value }) => ({ value }),
          }
        },
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.status === 'failed' ? result.code : '', 'durable_journal_unavailable')
    assert.equal(executed, 0, 'the executor must not be entered')
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
})

/* ── AC11a — operator resolution for an indeterminate dispatch ───────────── */

/**
 * A wedged dispatch has no resolution path, and "it disappeared from the
 * unresolved list" is not a contract. What matters is what the **next dispatch
 * on that `dispatchId`** does, so every test here records a resolution and then
 * dispatches for real against the same assignment journal.
 *
 * The seeded dispatch is deliberately `non_retryable` and `mutating`: that is
 * the case the adapter's own policy cannot resolve, so anything the next
 * dispatch does differently came from the operator's decision and nothing else.
 */

const OPERATOR_SCOPE: CapabilityAssignmentScope = {
  sessionId: 'session-operator',
  runId: 'run-operator',
  assignmentId: 'assignment-operator',
}

/** A workspace laid out the way the operator surface walks it. */
function makeOperatorWorkspace(t: TestContext): string {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'journal-operator-resolution-')),
  )
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }))
  fs.mkdirSync(operatorAssignmentPath(workspacePath), { recursive: true })
  return workspacePath
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function operatorAssignmentPath(workspacePath: string): string {
  const location = buildSessionRunAssignmentLocation(workspacePath, OPERATOR_SCOPE)
  assert.ok(location)
  return location.assignmentPath
}

/**
 * A registry over the operator workspace, resolved the way the server resolves
 * its own, so a journal this seeds and one the server opens agree on the
 * tenant sealed into the manifest.
 */
function operatorRegistry(workspacePath: string): WorkspaceExecutionJournalRegistry {
  return new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: resolveExecutionJournalOptions().tenantId,
    // The flag only decides whether a *new* assignment may enroll; an
    // assignment that already holds a journal resolves either way.
    mode: 'authoritative',
  })
}

async function withOperatorPort<T>(
  workspacePath: string,
  use: (port: CapabilityDurableDispatchPort) => Promise<T>,
): Promise<T> {
  const registry = operatorRegistry(workspacePath)
  try {
    const port = await registry.resolve({
      context: makeContext(OPERATOR_SCOPE),
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
    assert.ok(port, 'the operator assignment must resolve a durable port')
    return await use(port)
  } finally {
    await registry.close()
  }
}

/** The dispatch identity the real dispatcher derives for the operator scope. */
async function probeOperatorDispatchId(): Promise<string> {
  const scopeRoot = makeScopeRoot()
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: journalIdentity(),
    })
    const probe = await makeDispatcher(
      durablePortFor(journal),
    ).dispatch({
      context: makeContext(OPERATOR_SCOPE),
      invocation: makeInvocation(),
      adapter: makeAdapter(),
    })
    await journal.close()
    return probe.dispatchId
  } finally {
    fs.rmSync(workspaceOf(scopeRoot), { recursive: true, force: true })
  }
}

/** A blocked dispatch: started, no outcome, and a policy that cannot retry. */
async function seedWedgedDispatch(
  workspacePath: string,
  dispatchId: string,
  options: { readonly commit?: boolean } = {},
): Promise<void> {
  await withOperatorPort(workspacePath, (port) =>
    recordUnprovenAttempt(port, dispatchId, 'non_retryable', options),
  )
}

function countingAdapter(counter: { executions: number }): CapabilityAdapter {
  return {
    capabilityId: 'test.readpath',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        counter.executions += 1
        return { answer: 42 }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

/** What the next dispatch on the resolved identity actually does. */
async function nextOperatorDispatch(
  workspacePath: string,
  adapter: CapabilityAdapter,
): Promise<CapabilityDispatchResult> {
  return withOperatorPort(workspacePath, (port) =>
    makeDispatcher(port).dispatch({
      context: makeContext(OPERATOR_SCOPE),
      invocation: makeInvocation(),
      adapter,
    }),
  )
}

function operatorService(
  workspacePath: string,
  ports: ExecutionJournalResolutionSupport['ports'],
  clock?: () => number,
  processInstanceId = 'instance-operator-test',
): ExecutionJournalInspectionService {
  return new ExecutionJournalInspectionService({
    workspacePath,
    authority: {
      authorize: async ({ action, credentialScope }) =>
        action !== 'resolve' || credentialScope === 'full',
    },
    resolution: {
      ports,
      principal: ({ credentialScope }) => ({
        credentialScope,
        tenantId: 'tenant-operator-test',
        processInstanceId,
      }),
      ...(clock === undefined ? {} : { clock }),
    },
  })
}

/**
 * The assignment's journal opened directly, with the identity the registry
 * seals, so a test can wrap the handle before the port is built.
 */
async function openOperatorJournal(
  workspacePath: string,
): Promise<ExecutionJournal> {
  return initializeExecutionJournal({
    scopeRoot: operatorAssignmentPath(workspacePath),
    identity: {
      scopeKind: 'assignment',
      scopeId: OPERATOR_SCOPE.assignmentId,
      tenantId: resolveExecutionJournalOptions().tenantId,
      sessionId: OPERATOR_SCOPE.sessionId,
      runId: OPERATOR_SCOPE.runId,
      assignmentId: OPERATOR_SCOPE.assignmentId,
    },
  })
}

/**
 * A journal handle whose append of one event type never reaches disk.
 *
 * A real EIO cannot be produced on demand, and the fault is injected at the
 * journal's own append boundary rather than inside it — what survives on disk
 * is the same either way, which is the whole point of the test, and the reopen
 * that follows is a real one.
 */
function journalFailingOnAppend(
  journal: ExecutionJournal,
  failingType: string,
): ExecutionJournal {
  return {
    manifest: journal.manifest,
    journalDirectoryPath: journal.journalDirectoryPath,
    append: async (input) => {
      if (input.type === failingType) {
        const error: NodeJS.ErrnoException = new Error(
          `simulated I/O failure writing ${failingType}`,
        )
        error.code = 'EIO'
        throw error
      }
      return journal.append(input)
    },
    scan: () => journal.scan(),
    scanStream: (streamKind, streamId) =>
      journal.scanStream(streamKind, streamId),
    close: () => journal.close(),
    getMetrics: () => journal.getMetrics(),
    isRetired: () => journal.isRetired(),
  }
}

test('an abandon resolution recorded over the authenticated transport ends the dispatch for good', async (t) => {
  const workspacePath = makeOperatorWorkspace(t)
  const dispatchId = await probeOperatorDispatchId()
  await seedWedgedDispatch(workspacePath, dispatchId)

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    workspacePath,
    apiToken: 'operator-resolution-token',
  })
  let serverClosed = false
  const closeServer = async (): Promise<void> => {
    if (serverClosed) return
    serverClosed = true
    await server.close()
  }
  t.after(closeServer)

  const response = await fetch(
    `${server.url}/execution-journals/${OPERATOR_SCOPE.sessionId}/${OPERATOR_SCOPE.runId}/${OPERATOR_SCOPE.assignmentId}/resolutions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatchId,
        decision: 'abandon',
        reason: 'the effect was confirmed unrecoverable by hand',
      }),
    },
  )
  assert.equal(response.status, 200, await response.text())

  // The server owns the journal while it runs; one assignment has one
  // authority (ADR §1), so the next dispatch happens after it lets go.
  await closeServer()

  const counter = { executions: 0 }
  const result = await nextOperatorDispatch(workspacePath, countingAdapter(counter))
  assert.equal(result.status, 'cancelled', JSON.stringify(result))
  assert.equal(
    result.status === 'cancelled' ? result.code : '',
    'durable_operator_abandoned',
  )
  assert.equal(
    counter.executions,
    0,
    'an abandoned dispatch must never execute again',
  )
})

test('a not_committed resolution lets the next dispatch execute normally', async (t) => {
  const workspacePath = makeOperatorWorkspace(t)
  const dispatchId = await probeOperatorDispatchId()
  await seedWedgedDispatch(workspacePath, dispatchId)

  const registry = operatorRegistry(workspacePath)
  const outcome = await operatorService(workspacePath, registry).resolveDispatch({
    scope: OPERATOR_SCOPE,
    dispatchId,
    decision: 'not_committed',
    reason: 'reconciliation found no effect at the provider',
    credentialScope: 'full',
  })
  await registry.close()
  assert.equal(outcome.kind, 'recorded', JSON.stringify(outcome))

  const counter = { executions: 0 }
  const result = await nextOperatorDispatch(workspacePath, countingAdapter(counter))
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(
    counter.executions,
    1,
    'the operator authorized a retry, so the effect runs once more',
  )
})

test('a committed resolution returns the supplied result and never re-executes', async (t) => {
  const workspacePath = makeOperatorWorkspace(t)
  const dispatchId = await probeOperatorDispatchId()
  await seedWedgedDispatch(workspacePath, dispatchId)

  const registry = operatorRegistry(workspacePath)
  const outcome = await operatorService(workspacePath, registry).resolveDispatch({
    scope: OPERATOR_SCOPE,
    dispatchId,
    decision: 'committed',
    reason: 'the provider receipt confirms the effect committed',
    credentialScope: 'full',
    result: { kind: 'inline', value: { answer: 7, source: 'provider-console' } },
  })
  await registry.close()
  assert.equal(outcome.kind, 'recorded', JSON.stringify(outcome))

  const counter = { executions: 0 }
  const result = await nextOperatorDispatch(workspacePath, countingAdapter(counter))
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.deepEqual(
    result.status === 'completed' ? result.value : undefined,
    { answer: 7, source: 'provider-console' },
    'the retained result is the one the operator supplied, not a fresh execution',
  )
  assert.equal(
    counter.executions,
    0,
    'a committed effect must never be repeated',
  )
})

test('a committed resolution carrying an unusable receipt is refused and changes nothing', async (t) => {
  const workspacePath = makeOperatorWorkspace(t)
  const dispatchId = await probeOperatorDispatchId()
  await seedWedgedDispatch(workspacePath, dispatchId)

  const registry = operatorRegistry(workspacePath)
  const outcome = await operatorService(workspacePath, registry).resolveDispatch({
    scope: OPERATOR_SCOPE,
    dispatchId,
    decision: 'committed',
    reason: 'a receipt that names a file this journal does not hold',
    credentialScope: 'full',
    result: {
      kind: 'receipt',
      receipt: {
        relativePath: 'results/../escape.json',
        contentSha256: 'not-a-digest',
        byteLength: -1,
        mediaType: 'text/plain',
        resultSchemaVersion: 99,
      },
    },
  })
  await registry.close()
  assert.equal(
    outcome.kind,
    'invalid_result',
    'an operator may not smuggle an arbitrary value into the journal',
  )

  const counter = { executions: 0 }
  const result = await nextOperatorDispatch(workspacePath, countingAdapter(counter))
  assert.equal(result.status, 'indeterminate', JSON.stringify(result))
  assert.equal(
    result.status === 'indeterminate' ? result.code : '',
    'durable_replay_blocked',
    'a refused resolution leaves the dispatch exactly as blocked as it was',
  )
  assert.equal(counter.executions, 0)
})

test('the resolution write needs an authenticated credential and takes its principal from the server', async (t) => {
  const workspacePath = makeOperatorWorkspace(t)
  const dispatchId = await probeOperatorDispatchId()
  await seedWedgedDispatch(workspacePath, dispatchId)

  const body = JSON.stringify({
    dispatchId,
    decision: 'abandon',
    reason: 'resolution attempted from the local operator surface',
    // A field in request JSON that claims an identity is worse than a
    // constant, because it reads as provenance while carrying none.
    principal: {
      credentialScope: 'forged-scope',
      tenantId: 'forged-tenant',
      processInstanceId: 'forged-instance',
    },
  })
  const post = (url: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  const resolutionPath = `/execution-journals/${OPERATOR_SCOPE.sessionId}/${OPERATOR_SCOPE.runId}/${OPERATOR_SCOPE.assignmentId}/resolutions`

  // A server with no API token never authenticates anyone, so no credential
  // scope reaches the authority and the write path must stay shut.
  const tokenless = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    workspacePath,
  })
  try {
    const refused = await post(`${tokenless.url}${resolutionPath}`)
    assert.equal(
      refused.status,
      403,
      'an unauthenticated server must not expose a write path that changes replay decisions',
    )
  } finally {
    await tokenless.close()
  }

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    workspacePath,
    apiToken: 'operator-principal-token',
  })
  try {
    const accepted = await post(`${server.url}${resolutionPath}`)
    assert.equal(accepted.status, 200, await accepted.text())
  } finally {
    await server.close()
  }

  const read = await readExecutionJournal(operatorAssignmentPath(workspacePath))
  assert.equal(read.kind, 'ok')
  if (read.kind !== 'ok') return
  const resolution = read.events.find((event) =>
    event.type.startsWith('capability.dispatch.resolved.'),
  )
  assert.ok(resolution, 'the resolution must be a durable fact in the stream')
  const principal = resolution.payload['principal']
  if (!isJsonRecord(principal)) {
    assert.fail('the resolution must name the principal that recorded it')
  }
  assert.equal(
    principal['credentialScope'],
    'full',
    'the recorded credential scope is the one the transport resolved',
  )
  assert.equal(principal['tenantId'], resolveExecutionJournalOptions().tenantId)
  assert.equal(
    JSON.stringify(resolution.payload).includes('forged-'),
    false,
    'nothing the caller claimed about itself may reach the journal',
  )
})

/**
 * Two operators reaching the same wedged dispatch at once.
 *
 * Each reads the same state, decides against it, and appends. Nothing about
 * "read, then reduce, then append" is atomic, so a decision can be written
 * against a state that stopped being true while it was being made — and the
 * two decisions here contradict each other, so the second one lands on a state
 * that forbids it. That leaves a stream the reducer cannot read at all, which
 * is worse than the wedge both operators were trying to clear.
 */
test('two conflicting resolutions racing on one dispatch leave exactly one recorded', async (t) => {
  const workspacePath = makeOperatorWorkspace(t)
  const dispatchId = await probeOperatorDispatchId()
  await seedWedgedDispatch(workspacePath, dispatchId)

  const registry = operatorRegistry(workspacePath)
  const service = operatorService(workspacePath, registry)
  const resolve = (decision: OperatorResolutionDecision, reason: string) =>
    service.resolveDispatch({
      scope: OPERATOR_SCOPE,
      dispatchId,
      decision,
      reason,
      credentialScope: 'full',
    })

  const [fromRetryOperator, fromAbandonOperator] = await Promise.all([
    resolve('not_committed', 'reconciliation found no effect at the provider'),
    resolve('abandon', 'the effect must not proceed, committed or not'),
  ])
  await registry.close()

  const outcomes = [fromRetryOperator, fromAbandonOperator]
  assert.equal(
    outcomes.filter((outcome) => outcome.kind === 'recorded').length,
    1,
    `exactly one decision may govern the dispatch: ${JSON.stringify(outcomes)}`,
  )
  const loser = outcomes.find((outcome) => outcome.kind !== 'recorded')
  assert.ok(loser)
  assert.ok(
    loser.kind === 'not_resolvable' || loser.kind === 'conflict',
    `the losing operator is told so, rather than reported as recorded: ${loser.kind}`,
  )

  // And the winner governs. A wedged stream would reach neither branch.
  const counter = { executions: 0 }
  const result = await nextOperatorDispatch(workspacePath, countingAdapter(counter))
  if (fromRetryOperator.kind === 'recorded') {
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(counter.executions, 1, 'the authorized retry runs the effect once')
  } else {
    assert.equal(result.status, 'cancelled', JSON.stringify(result))
    assert.equal(
      result.status === 'cancelled' ? result.code : '',
      'durable_operator_abandoned',
    )
    assert.equal(counter.executions, 0, 'an abandoned dispatch never executes')
  }
})

/**
 * A committed resolution is two durable facts, and a process can die between
 * them.
 *
 * The decision is recorded first and the acceptance that carries the result
 * second. Lose the second and the dispatch reads as `committed` — still
 * awaiting reconciliation — which is honest, but it has to be *finishable*.
 * A retry must complete the acceptance rather than restate the decision: the
 * decision is already a durable fact, and rewriting it would replace the
 * provenance of the operator who actually made it.
 */
test('a committed resolution interrupted between its two appends is finished by a retry', async (t) => {
  const workspacePath = makeOperatorWorkspace(t)
  const dispatchId = await probeOperatorDispatchId()
  await seedWedgedDispatch(workspacePath, dispatchId)

  const decision = {
    scope: OPERATOR_SCOPE,
    dispatchId,
    decision: 'committed' as const,
    reason: 'the provider console confirms the effect committed',
    credentialScope: 'full' as const,
    result: { kind: 'inline' as const, value: { answer: 7, source: 'console' } },
  }

  const interrupted = await openOperatorJournal(workspacePath)
  await assert.rejects(
    operatorService(
      workspacePath,
      {
        resolveResolutionPort: async () =>
          durablePortFor(
            journalFailingOnAppend(interrupted, 'capability.dispatch.accepted'),
          ),
      },
      () => 1_000,
    ).resolveDispatch(decision),
    'the acceptance write fails, so the first attempt cannot report success',
  )
  await interrupted.close()

  // A restart: a fresh handle over the same durable history.
  const reopened = await openOperatorJournal(workspacePath)
  const retried = await operatorService(
    workspacePath,
    { resolveResolutionPort: async () => durablePortFor(reopened) },
    () => 2_000,
  ).resolveDispatch(decision)
  await reopened.close()

  assert.equal(retried.kind, 'recorded', JSON.stringify(retried))
  assert.equal(
    retried.kind === 'recorded' ? retried.state : '',
    'accepted',
    'the retry finishes the acceptance the interrupted attempt could not write',
  )

  const counter = { executions: 0 }
  const result = await nextOperatorDispatch(workspacePath, countingAdapter(counter))
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.deepEqual(
    result.status === 'completed' ? result.value : undefined,
    { answer: 7, source: 'console' },
  )
  assert.equal(counter.executions, 0, 'a committed effect is never repeated')

  const read = await readExecutionJournal(operatorAssignmentPath(workspacePath))
  assert.equal(read.kind, 'ok')
  if (read.kind !== 'ok') return
  const recorded = read.events.filter(
    (event) => event.type === 'capability.dispatch.resolved.committed',
  )
  assert.equal(recorded.length, 1, 'the decision is recorded once, not twice')
  assert.equal(
    recorded[0]?.payload['recordedAtMs'],
    1_000,
    'a retry finishes the decision rather than restating it, so the recorded ' +
      'provenance stays that of the attempt that made it',
  )
})

/**
 * Finishing someone else's decision must not mean supplying its result.
 *
 * A `committed` resolution asserts that a specific effect committed and hands
 * over what it produced. If the acceptance is lost and a later caller can pass
 * a different result to the retry, the first operator's principal, reason and
 * time end up attesting to a value they never saw — the strongest claim in the
 * journal, made about evidence its author never supplied. The decision has to
 * carry its own result durably, and the resume has to read it from there.
 */
test('a retry cannot substitute a different result for the one the decision recorded', async (t) => {
  const workspacePath = makeOperatorWorkspace(t)
  const dispatchId = await probeOperatorDispatchId()
  await seedWedgedDispatch(workspacePath, dispatchId)

  const decision = {
    scope: OPERATOR_SCOPE,
    dispatchId,
    decision: 'committed' as const,
    credentialScope: 'full' as const,
  }

  const interrupted = await openOperatorJournal(workspacePath)
  await assert.rejects(
    operatorService(
      workspacePath,
      {
        resolveResolutionPort: async () =>
          durablePortFor(
            journalFailingOnAppend(interrupted, 'capability.dispatch.accepted'),
          ),
      },
      () => 1_000,
      'first-process',
    ).resolveDispatch({
      ...decision,
      reason: 'first evidence: the provider console shows the effect committed',
      result: { kind: 'inline', value: { answer: 'A' } },
    }),
  )
  await interrupted.close()

  // A second operator, on a restarted process, retries with their own value.
  const reopened = await openOperatorJournal(workspacePath)
  const secondOperator = operatorService(
    workspacePath,
    { resolveResolutionPort: async () => durablePortFor(reopened) },
    () => 2_000,
    'second-process',
  )
  const substituted = await secondOperator.resolveDispatch({
    ...decision,
    reason: 'second evidence: a different reading of the same effect',
    result: { kind: 'inline', value: { answer: 'B' } },
  })
  assert.notEqual(
    substituted.kind,
    'recorded',
    `a replacement result must not be reported as recorded: ${JSON.stringify(substituted)}`,
  )
  assert.equal(substituted.kind, 'invalid_result', JSON.stringify(substituted))

  // The decision is still finishable — from what it recorded, not from what
  // any later caller offers, so the retry need not supply a result at all.
  const resumed = await secondOperator.resolveDispatch({
    ...decision,
    reason: 'second operator finishing the first operator’s decision',
  })
  await reopened.close()
  assert.equal(resumed.kind, 'recorded', JSON.stringify(resumed))
  assert.equal(resumed.kind === 'recorded' ? resumed.state : '', 'accepted')

  // Completing the acceptance does not stop the check applying. A third
  // caller arriving after the dispatch has settled must not be told their
  // value was recorded either, and nothing they send may reach the journal.
  const settled = await readExecutionJournal(operatorAssignmentPath(workspacePath))
  assert.equal(settled.kind, 'ok')
  if (settled.kind !== 'ok') return
  const beforeLateRetry = JSON.stringify(settled.events)

  const afterAcceptance = await openOperatorJournal(workspacePath)
  const lateSubstitution = await operatorService(
    workspacePath,
    {
      resolveResolutionPort: async () =>
        durablePortFor(afterAcceptance),
    },
    () => 3_000,
    'third-process',
  ).resolveDispatch({
    ...decision,
    reason: 'third evidence, arriving after the decision was already accepted',
    result: { kind: 'inline', value: { answer: 'B' } },
  })
  await afterAcceptance.close()
  assert.equal(
    lateSubstitution.kind,
    'invalid_result',
    `a settled decision still refuses a replacement result: ${JSON.stringify(lateSubstitution)}`,
  )

  const unchanged = await readExecutionJournal(operatorAssignmentPath(workspacePath))
  assert.equal(unchanged.kind, 'ok')
  if (unchanged.kind !== 'ok') return
  assert.equal(
    JSON.stringify(unchanged.events),
    beforeLateRetry,
    'a refused retry writes nothing at all',
  )

  const counter = { executions: 0 }
  const result = await nextOperatorDispatch(workspacePath, countingAdapter(counter))
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.deepEqual(
    result.status === 'completed' ? result.value : undefined,
    { answer: 'A' },
    'the retained result is the one the recorded decision carried',
  )
  assert.equal(counter.executions, 0)

  const read = await readExecutionJournal(operatorAssignmentPath(workspacePath))
  assert.equal(read.kind, 'ok')
  if (read.kind !== 'ok') return
  const recorded = read.events.filter(
    (event) => event.type === 'capability.dispatch.resolved.committed',
  )
  assert.equal(recorded.length, 1)
  const payload = recorded[0]?.payload
  assert.ok(payload)
  assert.equal(payload['recordedAtMs'], 1_000)
  assert.match(
    typeof payload['reason'] === 'string' ? payload['reason'] : '',
    /^first evidence/,
    'the decision keeps the reason its author gave',
  )
  const principal = payload['principal']
  if (!isJsonRecord(principal)) {
    assert.fail('the resolution must name the principal that recorded it')
  }
  assert.equal(
    principal['processInstanceId'],
    'first-process',
    'and the principal of the process that made it',
  )
  assert.equal(
    JSON.stringify(payload).includes('"B"'),
    false,
    'no later value reaches the decision that attests to it',
  )
})
