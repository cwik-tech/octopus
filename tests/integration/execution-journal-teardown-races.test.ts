import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import {
  initializeExecutionJournal,
  readExecutionJournal,
} from '../../core/execution-journal.js'
import { DURABLE_DISPATCH_STREAM_KIND } from '../../core/durable-dispatch.js'
import {
  ExecutionJournalReleasedError,
  WorkspaceExecutionJournalRegistry,
} from '../../services/workspace-execution-journal-registry.js'

/**
 * AC18: teardown must never prevent truthful finalization.
 *
 * The contract is ordered. Once an assignment's teardown begins, no further
 * dispatch is admitted for it; only then is what is already in flight
 * drained.
 *
 * What this test observes is the first half of that failing. Before the
 * barrier, `releaseAssignment` snapshotted the active dispatches and marked
 * only the binding scopes that existed at that moment, while `dispatch()`
 * refused solely on the whole runtime closing. A dispatch for a task the
 * assignment had not seen before therefore built a clean binding scope, was
 * admitted after teardown had begun, and ran its external effect — work the
 * drain snapshot knew nothing about.
 *
 * It does **not** observe that dispatch losing its journal: in this fixture
 * the late dispatch completed before closure. Whether an unaccounted dispatch
 * also loses its append depends on how the race lands, and the cases that
 * pin that down come later in this package. Admitting the work at all is the
 * defect proved here.
 *
 * The external effect is a real HTTP round trip to a counter this test owns,
 * so "the effect happened" is observed rather than inferred.
 */

const SCOPE = {
  sessionId: 'session-teardown',
  runId: 'run-teardown',
  assignmentId: 'assignment-teardown',
} as const

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'journal-teardown-')),
  )
}

/** A promise plus its resolver, so a test can gate on an event rather than time. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = () => settle()
  })
  return { promise, resolve }
}

/** An out-of-process effect: a real request whose count the test can read. */
async function startCounterServer(): Promise<{
  readonly url: string
  count(): number
  close(): Promise<void>
}> {
  let counter = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mutate') {
      counter += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ counter }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    count: () => counter,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

/**
 * One assignment, but a distinct binding scope per task.
 *
 * The binding scope key is `sessionId \0 runId \0 assignmentId \0 taskId \0
 * authority` (`core/capability-dispatcher.ts:1578`), while
 * `bindings.releaseAssignment` marks only the scopes that exist when it
 * iterates. A task whose scope has never been seen therefore starts clean
 * after release has begun — which is the assignment-level hole, as distinct
 * from a scope that was already present and correctly refused.
 */
function makeContext(
  requestId: string,
  taskId: string,
): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId,
    ...SCOPE,
    taskId,
    agentPath: 'agents/teardown',
    authority: { kind: 'runtime-assignment', processIdentity: 'teardown' },
  }
}

function makeInvocation(toolCallId: string): CapabilityInvocation {
  return {
    capabilityId: 'test.mutate',
    source: { kind: 'builtin', id: 'teardown', version: '1' },
    toolCallId,
    input: { target: 'counter' },
  }
}

function makeAdapter(input: {
  readonly counterUrl: string
  readonly gate?: Promise<void>
  readonly entered?: () => void
}): CapabilityAdapter {
  return {
    capabilityId: 'test.mutate',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      // Pinned deliberately: `resolveBlockedByPolicy` softens a blocked
      // recovery decision using the policy sealed into the prepared event, so
      // leaving it unstated would make any recovery assertion a property of
      // the fixture rather than of the stream.
      recoveryPolicy: 'non_retryable' as const,
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        input.entered?.()
        if (input.gate) await input.gate
        const response = await fetch(`${input.counterUrl}/mutate`, {
          method: 'POST',
        })
        return (await response.json()) as unknown
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

/**
 * The decision teardown records when it gives up on a live dispatch, and the
 * decision that dispatch must then settle on. One constant for both, because
 * they are the same fact seen from two sides.
 */
const ASSIGNMENT_RELEASE_DEADLINE_CODE = 'assignment_release_deadline_exceeded'

/** One dispatch stream's journal events, with the explicit teardown decision. */
async function dispatchStream(
  assignmentPath: string,
  dispatchId: string,
): Promise<{
  readonly types: string[]
  /** The `code` on an explicit `indeterminate` event, when one was appended. */
  readonly indeterminateCode: string | undefined
}> {
  const read = await readExecutionJournal(assignmentPath)
  if (read.kind !== 'ok') {
    return { types: [`unreadable:${read.kind}`], indeterminateCode: undefined }
  }
  const stream = read.events.filter(
    (event) =>
      event.streamKind === DURABLE_DISPATCH_STREAM_KIND &&
      event.streamId === dispatchId,
  )
  const indeterminate = stream.find(
    (event) => event.type === 'capability.dispatch.indeterminate',
  )
  const code: unknown = indeterminate?.payload?.['code']
  return {
    types: stream.map((event) =>
      event.type.replace('capability.dispatch.', ''),
    ),
    indeterminateCode: typeof code === 'string' ? code : undefined,
  }
}

/** Distinct dispatch streams recorded in this assignment's journal. */
async function dispatchStreamIds(assignmentPath: string): Promise<string[]> {
  const read = await readExecutionJournal(assignmentPath)
  if (read.kind !== 'ok') return []
  return [
    ...new Set(
      read.events
        .filter((event) => event.streamKind === DURABLE_DISPATCH_STREAM_KIND)
        .map((event) => event.streamId),
    ),
  ]
}

test('a dispatch arriving after release begins is refused before it executes', {
  timeout: 30_000,
}, async (t) => {
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  const firstGate = deferred()
  const runtime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: () => null,
    runtimeAuthority: {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-teardown',
        runPath: location.runPath,
        assignmentPath: location.assignmentPath,
      }),
    },
    executionJournal: { mode: 'authoritative', tenantId: 'tenant-teardown' },
  })
  t.after(async () => {
    firstGate.resolve()
    try {
      await runtime.close()
    } finally {
      await counter.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  // A dispatch that is still executing when teardown starts.
  const inFlightEntered = deferred()
  const inFlight = runtime.dispatcher.dispatch({
    context: makeContext('request-in-flight', 'task-teardown-in-flight'),
    invocation: makeInvocation('call-in-flight'),
    adapter: makeAdapter({
      counterUrl: counter.url,
      gate: firstGate.promise,
      entered: () => inFlightEntered.resolve(),
    }),
  })
  await inFlightEntered.promise

  // Teardown begins. `releaseAssignment` runs synchronously up to its first
  // await, so by the time this call returns its promise the bindings have
  // been marked and the drain snapshot taken — which is exactly the window
  // under test.
  const release = runtime.releaseAssignment(SCOPE)

  const countBeforeLate = counter.count()
  const late = await runtime.dispatcher.dispatch({
    // A task this assignment has not dispatched for before, so its binding
    // scope did not exist when `releaseAssignment` marked the ones it found.
    context: makeContext('request-late', 'task-teardown-late'),
    invocation: makeInvocation('call-late'),
    adapter: makeAdapter({ counterUrl: counter.url }),
  })

  assert.equal(
    counter.count(),
    countBeforeLate,
    'a dispatch admitted after teardown began must not run its external ' +
      'effect: refusing it only after the effect has happened is the defect',
  )
  assert.equal(
    late.status,
    'failed',
    `the late dispatch must be refused, not executed: ${JSON.stringify(late)}`,
  )
  assert.equal(
    late.status === 'failed' ? late.code : '',
    'dispatch_assignment_released',
    'and the refusal must name the reason. `capacity_exceeded` is not it: ' +
      'that is the bindings layer refusing a scope it already knew about, ' +
      'which says nothing about an assignment whose teardown has begun',
  )

  firstGate.resolve()
  await release
  const settled = await inFlight
  assert.equal(
    settled.status,
    'completed',
    `the in-flight dispatch must still finish truthfully: ${JSON.stringify(settled)}`,
  )
  assert.equal(counter.count(), 1, 'exactly the in-flight effect happened')

  const streams = await dispatchStreamIds(location.assignmentPath)
  assert.deepEqual(
    streams,
    [settled.dispatchId],
    'the journal must hold a stream for the drained dispatch and none for ' +
      'the refused one',
  )
})

test('a dispatch still running at the drain deadline is finalized before the journal closes', {
  timeout: 30_000,
}, async (t) => {
  // AC18, second journey. A dispatch that has crossed the durable `started`
  // barrier holds the only unfinished durable record for a real external
  // effect. At the drain deadline teardown aborts it, waits a grace period,
  // and closes the journal — so nothing ever records what became of it, and
  // its own attempt to finalize arrives at a journal that is closed and
  // barred.
  //
  // The requirement is that teardown finalizes rather than truncates: an
  // explicit `indeterminate` is appended for that attempt *before* the
  // journal closes, leaving a stream an operator can act on rather than one
  // that merely stops. Fabricating a terminal is forbidden — `failed` would
  // assert no effect committed, and this effect demonstrably did.
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  const effectDone = deferred()
  const holdEffect = deferred()
  const runtime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: () => null,
    runtimeAuthority: {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-teardown',
        runPath: location.runPath,
        assignmentPath: location.assignmentPath,
      }),
    },
    executionJournal: { mode: 'authoritative', tenantId: 'tenant-teardown' },
    // Short enough to reach the deadline while the effect is still held, and
    // reached by event ordering rather than by racing a wall clock.
    releaseDrainTimeoutMs: 200,
  })
  t.after(async () => {
    holdEffect.resolve()
    try {
      await runtime.close()
    } finally {
      await counter.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  const dispatch = runtime.dispatcher.dispatch({
    context: makeContext('request-held', 'task-teardown-held'),
    invocation: makeInvocation('call-held'),
    adapter: {
      capabilityId: 'test.mutate',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'test-mutating',
        argumentNames: ['target'],
        policyDecision: { kind: 'allow' },
        recoveryPolicy: 'non_retryable' as const,
        authorize: async () => ({ kind: 'allow' }),
        execute: async () => {
          // The external effect commits, and only then does the adapter stop
          // responding — deliberately ignoring the runtime's abort, which is
          // what a real non-cooperative effect does.
          const response = await fetch(`${counter.url}/mutate`, {
            method: 'POST',
          })
          const value = (await response.json()) as unknown
          effectDone.resolve()
          await holdEffect.promise
          return value
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })

  await effectDone.promise
  assert.equal(counter.count(), 1, 'the external effect committed')

  await runtime.releaseAssignment(SCOPE)

  // Teardown has finished. Whatever it decided must already be on the journal,
  // because the journal is closed and barred from here on.
  const streams = await dispatchStreamIds(location.assignmentPath)
  assert.equal(streams.length, 1, `expected one dispatch stream, saw ${streams.length}`)
  const dispatchId = streams[0]
  assert.ok(dispatchId)
  const afterRelease = await dispatchStream(location.assignmentPath, dispatchId)

  assert.ok(
    afterRelease.types.includes('indeterminate'),
    `teardown must append an explicit indeterminate before closing; the ` +
      `stream is ${JSON.stringify(afterRelease.types)}`,
  )
  // Deliberately *not* asserted here: that the stream reduces to
  // `indeterminate`. `resolveAttemptState` already folds a stream ending at
  // `started` to `indeterminate` as its crash fallback, so that assertion
  // passes with or without this package and would be measuring the reducer
  // instead of the teardown. What is missing today is the explicit event and
  // the decision it carries.
  assert.equal(
    afterRelease.indeterminateCode,
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
    'and it must name the decision teardown actually made, not merely exist',
  )
  assert.equal(
    afterRelease.types.includes('failed'),
    false,
    'a fabricated `failed` terminal would assert that no effect committed, ' +
      'and this one demonstrably did',
  )

  // The non-cooperative effect finishes afterwards. It must settle on the same
  // decision teardown already recorded, and must not append a contradicting
  // terminal to a stream that has been finalized.
  holdEffect.resolve()
  const settled = await dispatch
  assert.equal(
    settled.status,
    'indeterminate',
    `the dispatch must settle on the recorded decision: ${JSON.stringify(settled)}`,
  )
  assert.equal(
    settled.status === 'indeterminate' ? settled.code : '',
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
    'and on the same decision the journal already carries — one fact, not ' +
      'two answers that happen to share a status',
  )

  const afterSettle = await dispatchStream(location.assignmentPath, dispatchId)
  assert.deepEqual(
    afterSettle.types,
    afterRelease.types,
    'nothing may be appended after teardown finalized the stream',
  )
})

test('a teardown append that fails leaves the journal open and the release refused', {
  timeout: 30_000,
}, async (t) => {
  // The failure half of the deadline path. Teardown appends its decision and
  // *then* closes the journal, so an append that fails must stop the release:
  // closing anyway would leave a stream that stops with nothing in it saying
  // why, which is the outcome this whole package exists to remove.
  //
  // The fault is injected through the registry's existing `journalOpener`
  // dependency seam rather than a new test-only hook, and it is transient —
  // one failed append, then the journal behaves — so the retry can be
  // observed too.
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  let failNextIndeterminate = true
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'tenant-teardown',
    mode: 'authoritative',
    journalOpener: async ({ scopeRoot, identity }) => {
      const journal = await initializeExecutionJournal({ scopeRoot, identity })
      return {
        manifest: journal.manifest,
        journalDirectoryPath: journal.journalDirectoryPath,
        append: async (input) => {
          if (
            input.type === 'capability.dispatch.indeterminate' &&
            failNextIndeterminate
          ) {
            failNextIndeterminate = false
            throw new Error('indeterminate append failed')
          }
          return journal.append(input)
        },
        scan: () => journal.scan(),
        scanStream: (streamKind, streamId) =>
          journal.scanStream(streamKind, streamId),
        getMetrics: () => journal.getMetrics(),
        isRetired: () => journal.isRetired(),
        close: () => journal.close(),
      }
    },
  })

  const holdEffect = deferred()
  const effectDone = deferred()
  const runtime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: () => null,
    runtimeAuthority: {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-teardown',
        runPath: location.runPath,
        assignmentPath: location.assignmentPath,
      }),
    },
    executionJournalRegistry: registry,
    releaseDrainTimeoutMs: 200,
  })
  t.after(async () => {
    holdEffect.resolve()
    try {
      await runtime.close()
    } finally {
      await registry.close().catch(() => undefined)
      await counter.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  const dispatch = runtime.dispatcher.dispatch({
    context: makeContext('request-fail', 'task-teardown-fail'),
    invocation: makeInvocation('call-fail'),
    adapter: {
      capabilityId: 'test.mutate',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'test-mutating',
        argumentNames: ['target'],
        policyDecision: { kind: 'allow' },
        recoveryPolicy: 'non_retryable' as const,
        authorize: async () => ({ kind: 'allow' }),
        execute: async () => {
          const response = await fetch(`${counter.url}/mutate`, {
            method: 'POST',
          })
          const value = (await response.json()) as unknown
          effectDone.resolve()
          await holdEffect.promise
          return value
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })
  await effectDone.promise

  await assert.rejects(
    runtime.releaseAssignment(SCOPE),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(
        error.message,
        /indeterminate append failed/,
        `the original failure must surface, not a substitute: ${String(error)}`,
      )
      return true
    },
    'a release that could not record its decision must not report success',
  )

  // The journal is still open and usable, because the release stopped before
  // touching it.
  const stillOpen = await registry.resolveJournalHandle({
    context: {
      contractVersion: 1,
      requestId: 'probe-open',
      ...SCOPE,
      agentPath: 'agents/teardown',
      authority: { kind: 'runtime-assignment', processIdentity: 'probe' },
    },
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
  })
  assert.ok(stillOpen, 'the journal must not have been closed or barred')

  // And the assignment stays barred to new work regardless.
  const late = await runtime.dispatcher.dispatch({
    context: makeContext('request-after-failed-release', 'task-teardown-late'),
    invocation: makeInvocation('call-after-failed-release'),
    adapter: makeAdapter({ counterUrl: counter.url }),
  })
  assert.equal(late.status, 'failed')
  assert.equal(
    late.status === 'failed' ? late.code : '',
    'dispatch_assignment_released',
    'a failed release does not un-bar the assignment',
  )

  // Retrying the release now succeeds: the fault was transient, and the
  // attempt was left live precisely so this could work.
  await runtime.releaseAssignment(SCOPE)

  const streams = await dispatchStreamIds(location.assignmentPath)
  const dispatchId = streams[0]
  assert.ok(dispatchId)
  const finalized = await dispatchStream(location.assignmentPath, dispatchId)
  assert.equal(
    finalized.indeterminateCode,
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
    `the retry recorded the decision: ${JSON.stringify(finalized.types)}`,
  )

  holdEffect.resolve()
  await dispatch
})

const SHUTDOWN_DEADLINE_CODE = 'shutdown_deadline_exceeded'

test('runtime shutdown bars new dispatch, then finalizes what is still live', {
  timeout: 30_000,
}, async (t) => {
  // AC18, Journey B. `close()` aborts every active dispatch immediately and
  // then waits for them unbounded, recording nothing: a dispatch past its
  // `started` barrier is cancelled mid-effect and its journal is closed with
  // no decision in it.
  //
  // The contract is the same shape as assignment release, one level up.
  // Beginning shutdown bars *new* dispatch at once but leaves existing work
  // alone until the deadline; at the deadline the still-live attempts are
  // finalized truthfully before the journal closes.
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  const effectDone = deferred()
  const holdEffect = deferred()
  const runtime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: () => null,
    runtimeAuthority: {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-teardown',
        runPath: location.runPath,
        assignmentPath: location.assignmentPath,
      }),
    },
    executionJournal: { mode: 'authoritative', tenantId: 'tenant-teardown' },
    // A real product option, not a test hook: how long shutdown lets
    // in-flight work finish. Short here so the deadline is reached by
    // configuration rather than by waiting out the default.
    shutdownDeadlineMs: 250,
  })
  t.after(async () => {
    holdEffect.resolve()
    await counter.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  })

  const dispatch = runtime.dispatcher.dispatch({
    context: makeContext('request-shutdown', 'task-teardown-shutdown'),
    invocation: makeInvocation('call-shutdown'),
    adapter: {
      capabilityId: 'test.mutate',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'test-mutating',
        argumentNames: ['target'],
        policyDecision: { kind: 'allow' },
        recoveryPolicy: 'non_retryable' as const,
        authorize: async () => ({ kind: 'allow' }),
        execute: async () => {
          const response = await fetch(`${counter.url}/mutate`, {
            method: 'POST',
            signal: AbortSignal.timeout(10_000),
          })
          const value = (await response.json()) as unknown
          effectDone.resolve()
          await holdEffect.promise
          return value
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })
  await effectDone.promise

  // Shutdown begins. New work is refused from this moment.
  runtime.beginShutdown()
  const late = await runtime.dispatcher.dispatch({
    context: makeContext('request-late-shutdown', 'task-teardown-late'),
    invocation: makeInvocation('call-late-shutdown'),
    adapter: makeAdapter({ counterUrl: counter.url }),
  })
  assert.equal(late.status, 'failed', JSON.stringify(late))
  assert.equal(
    counter.count(),
    1,
    'and no new external effect ran once shutdown began',
  )

  // The dispatch already running is not aborted by that: only the deadline
  // ends it, and it is finalized rather than truncated.
  await runtime.close()

  const streams = await dispatchStreamIds(location.assignmentPath)
  const dispatchId = streams[0]
  assert.ok(dispatchId)
  const finalized = await dispatchStream(location.assignmentPath, dispatchId)
  assert.equal(
    finalized.indeterminateCode,
    SHUTDOWN_DEADLINE_CODE,
    `shutdown must record its own decision: ${JSON.stringify(finalized.types)}`,
  )
  assert.equal(
    finalized.types.includes('failed'),
    false,
    'and must not fabricate a terminal that claims no effect committed',
  )

  // The adapter finishing afterwards changes nothing, and agrees with the
  // decision the journal already carries.
  holdEffect.resolve()
  const settled = await dispatch
  assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
  assert.equal(
    settled.status === 'indeterminate' ? settled.code : '',
    SHUTDOWN_DEADLINE_CODE,
  )
  assert.deepEqual(
    (await dispatchStream(location.assignmentPath, dispatchId)).types,
    finalized.types,
    'nothing may be appended after shutdown finalized the stream',
  )
})

test('shutdown resolves every live attempt before journal closure', {
  timeout: 30_000,
}, async (t) => {
  // Two live attempts on different assignments, resolved differently and both
  // truthfully — the contract is settled *or* decided, not decided regardless.
  //
  // The stubborn one is still holding its effect when the deadline arrives
  // and ignores the abort, so nothing can say what became of it: it receives
  // the explicit `shutdown_deadline_exceeded` decision, and its returned
  // result joins that same decision rather than merely sharing its status.
  //
  // The cooperative one unwinds on the abort, but its completion had not been
  // published when teardown began — so teardown wins that race and it carries
  // the same decision. The rule is symmetric and decided by which side
  // published first: a completion already under way is joined and allowed to
  // win, and a teardown already under way is joined and allowed to win. What
  // is never allowed is both, which would leave a stream contradicting itself.
  //
  // Both are resolved before the journal closes, which is why the finalizers
  // are snapshotted across every assignment before the abort: an attempt that
  // is still genuinely unsettled must not be skipped because a neighbouring
  // one unregistered while an earlier append was in flight.
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  const stubborn = { ...SCOPE, assignmentId: 'assignment-stubborn' }
  const cooperative = { ...SCOPE, assignmentId: 'assignment-cooperative' }
  const locations = new Map(
    [stubborn, cooperative].map((scope) => {
      const location = buildSessionRunAssignmentLocation(workspacePath, scope)
      assert.ok(location)
      fs.mkdirSync(location.assignmentPath, { recursive: true })
      return [scope.assignmentId, location]
    }),
  )

  const holdEffect = deferred()
  const runtime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: () => null,
    runtimeAuthority: {
      authorize: async (claims) => {
        const location = locations.get(claims.assignmentId)
        assert.ok(location)
        return {
          taskId: claims.taskId,
          workflowId: claims.workflowId ?? 'workflow-teardown',
          runPath: location.runPath,
          assignmentPath: location.assignmentPath,
        }
      },
    },
    executionJournal: { mode: 'authoritative', tenantId: 'tenant-teardown' },
    shutdownDeadlineMs: 250,
  })
  t.after(async () => {
    holdEffect.resolve()
    await counter.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  })

  const start = (
    scope: typeof stubborn,
    entered: { resolve: () => void },
    cooperate: boolean,
  ) =>
    runtime.dispatcher.dispatch({
      context: {
        contractVersion: 1,
        requestId: `request-${scope.assignmentId}`,
        ...scope,
        taskId: `task-${scope.assignmentId}`,
        agentPath: 'agents/teardown',
        authority: { kind: 'runtime-assignment', processIdentity: 'teardown' },
      },
      invocation: makeInvocation(`call-${scope.assignmentId}`),
      adapter: {
        capabilityId: 'test.mutate',
        prepare: async () => ({
          effect: serialCapabilityEffect('mutating'),
          risk: 'test-mutating',
          argumentNames: ['target'],
          policyDecision: { kind: 'allow' },
          recoveryPolicy: 'non_retryable' as const,
          authorize: async () => ({ kind: 'allow' }),
          execute: async ({ signal }) => {
            const response = await fetch(`${counter.url}/mutate`, {
              method: 'POST',
              signal: AbortSignal.timeout(10_000),
            })
            const value = (await response.json()) as unknown
            entered.resolve()
            if (cooperate) {
              // Unwinds the moment shutdown aborts it.
              await new Promise<void>((resolve) => {
                if (signal.aborted) return resolve()
                signal.addEventListener('abort', () => resolve(), {
                  once: true,
                })
              })
              return value
            }
            await holdEffect.promise
            return value
          },
          acceptResult: async ({ value }) => ({ value }),
        }),
      },
    })

  // Started in this order on purpose. Shutdown snapshots the live attempts in
  // registration order and finalizes them one at a time, and only the first
  // finalizer publishes its gate in the same job as the abort — every later
  // one runs after a journal append has already yielded. The cooperative
  // attempt unwinds the instant it is aborted, so if it were finalized second
  // its completion could publish during the first append and win the race.
  // Registering it first is what makes "teardown had already begun" true
  // rather than merely likely.
  const stubbornEntered = deferred()
  const cooperativeEntered = deferred()
  const cooperativeDispatch = start(cooperative, cooperativeEntered, true)
  await cooperativeEntered.promise
  const stubbornDispatch = start(stubborn, stubbornEntered, false)
  await stubbornEntered.promise

  await runtime.close()

  const streamFor = async (scope: typeof stubborn) => {
    const location = locations.get(scope.assignmentId)
    assert.ok(location)
    const streams = await dispatchStreamIds(location.assignmentPath)
    const dispatchId = streams[0]
    assert.ok(dispatchId, `${scope.assignmentId} must hold a dispatch stream`)
    return dispatchStream(location.assignmentPath, dispatchId)
  }

  // The one still holding its effect is finalized where it stands.
  const stubbornStream = await streamFor(stubborn)
  assert.equal(
    stubbornStream.indeterminateCode,
    SHUTDOWN_DEADLINE_CODE,
    `the unsettled attempt must carry the shutdown decision: ${JSON.stringify(stubbornStream.types)}`,
  )

  // The cooperative one unwinds on the abort, but its completion had not been
  // published when teardown began, so teardown wins that race and it carries
  // the same decision. What must never appear is both: an `indeterminate`
  // with a `committed`/`accepted` appended over it would leave a stream whose
  // own two halves disagree.
  const cooperativeStream = await streamFor(cooperative)
  assert.equal(
    cooperativeStream.indeterminateCode,
    SHUTDOWN_DEADLINE_CODE,
    `teardown had already begun, so it decides: ${JSON.stringify(cooperativeStream.types)}`,
  )
  assert.deepEqual(
    cooperativeStream.types.filter((type) =>
      ['committed', 'accepted'].includes(type),
    ),
    [],
    `and nothing may be appended over that decision: ${JSON.stringify(cooperativeStream.types)}`,
  )

  // Both callers are told what the journal says, not what their adapter did.
  holdEffect.resolve()
  for (const settled of [await stubbornDispatch, await cooperativeDispatch]) {
    assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
    assert.equal(
      settled.status === 'indeterminate' ? settled.code : '',
      SHUTDOWN_DEADLINE_CODE,
      'the returned result joins the decision the journal recorded',
    )
  }
})

test('a terminal task with no assignmentId still releases and bars its journal', {
  timeout: 30_000,
}, async (t) => {
  // AC18, fourth journey, driven through the production wiring rather than a
  // stand-in: the real `FileSystemSessionStore` terminal subscription, the
  // real `CapabilityDispatchRuntime` release, and the real registry.
  //
  // `assignmentId` is optional on a task record, and a task without one is
  // not a task without an assignment: the worker is launched with
  // `task.assignmentId ?? task.runId` (`services/task-service.ts`), so a
  // journal exists under `runId`. Terminal finalization returned before
  // building the scope when `assignmentId` was absent, so the listener never
  // fired: that journal stayed open, its index stayed in memory, and nothing
  // surfaced it — the task looked finished.
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Run-scoped release' })
  const task = await store.createTaskRecord(session.id, {
    workflowId: 'wf-teardown',
    brief: 'Exercise release for a task with no assignment id.',
  })
  assert.ok(task)

  // Cleared through the ordinary patch path, the same way production clears a
  // field, rather than by writing a record behind the store's back.
  const cleared = await store.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    { status: 'running', assignmentId: undefined },
  )
  assert.ok(cleared, 'the fixture transition must be accepted')
  assert.equal(
    (await store.getTaskRecord(session.id, task.id))?.assignmentId,
    undefined,
    'the record under test must genuinely carry no assignment id',
  )

  // The scope the worker's journal is opened under: the run id, standing in
  // for the absent assignment id.
  const scope = {
    sessionId: session.id,
    runId: task.runId,
    assignmentId: task.runId,
  } as const
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  // Injected, so it outlives the runtime and can be asked afterwards whether
  // the assignment was actually released.
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'tenant-teardown',
    mode: 'authoritative',
  })
  const runtime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: () => null,
    runtimeAuthority: {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-teardown',
        runPath: location.runPath,
        assignmentPath: location.assignmentPath,
      }),
    },
    executionJournalRegistry: registry,
    // The production subscription, bound to the real store.
    assignmentLifecycle: {
      subscribeTaskTerminal: store.subscribeTaskTerminal.bind(store),
    },
  })
  t.after(async () => {
    try {
      await runtime.close()
    } finally {
      await registry.close().catch(() => undefined)
      await counter.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  // One dispatch, so a journal genuinely exists for this scope.
  const settled = await runtime.dispatcher.dispatch({
    context: {
      contractVersion: 1,
      requestId: 'request-run-scoped',
      ...scope,
      taskId: task.id,
      agentPath: 'agents/teardown',
      authority: { kind: 'runtime-assignment', processIdentity: 'teardown' },
    },
    invocation: makeInvocation('call-run-scoped'),
    adapter: makeAdapter({ counterUrl: counter.url }),
  })
  assert.equal(
    settled.status,
    'completed',
    `the dispatch must run so a journal exists: ${JSON.stringify(settled)}`,
  )
  assert.equal(counter.count(), 1, 'and its external effect happened')
  assert.deepEqual(
    await dispatchStreamIds(location.assignmentPath),
    [settled.dispatchId],
    'the journal holds this dispatch, under the run-scoped assignment',
  )

  // The task reaches a terminal state. Finalization awaits its listeners, so
  // the release has run by the time this resolves — no polling, no sleep.
  await store.compareAndSetTaskRecord(session.id, task.id, ['running'], {
    status: 'failed',
    error: 'Expected terminal fixture.',
  })

  // The observable cleanup: the assignment is released, so the registry
  // refuses to hand out its journal again. A journal that merely stopped
  // being used would still resolve here.
  await assert.rejects(
    registry.resolve({
      context: {
        contractVersion: 1,
        requestId: 'request-after-terminal',
        ...scope,
        taskId: task.id,
        agentPath: 'agents/teardown',
        authority: { kind: 'runtime-assignment', processIdentity: 'teardown' },
      },
      signal: AbortSignal.timeout(5_000),
      deadlineMs: Date.now() + 5_000,
    }),
    ExecutionJournalReleasedError,
    'a terminal task must close its journal and bar it from reopening, ' +
      'whether or not the record carried an assignment id',
  )
})
