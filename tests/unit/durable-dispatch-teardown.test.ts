import assert from 'node:assert/strict'
import test from 'node:test'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityDispatchResult,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import type {
  CapabilityDurableDispatchPort,
  DurableTeardownFinalizer,
  DurableTeardownRegistry,
} from '../../contracts/durable-dispatch.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'

/**
 * AC18: the handshake that lets teardown finalize a live dispatch truthfully.
 *
 * Teardown has to append an explicit `indeterminate` for a dispatch that is
 * still running at the drain deadline, for that dispatch's *exact* attempt.
 * The shell cannot do that by itself: it holds an abort controller and a
 * promise, while the dispatch id, the attempt id and the durable session all
 * live inside one dispatch. Rederiving them in the runtime would mean
 * guessing at identity the core already owns.
 *
 * So the core hands out an opaque operation instead. It registers only once
 * the durable `started` barrier is on the journal — before that there is no
 * attempt worth finalizing — and the registration carries the assignment
 * scope, which is the only identity the shell needs to keep a per-assignment
 * set.
 */

const ASSIGNMENT_RELEASE_DEADLINE_CODE = 'assignment_release_deadline_exceeded'

const CONTEXT: CapabilityExecutionContext = {
  contractVersion: 1,
  requestId: 'request-teardown',
  sessionId: 'session-teardown',
  runId: 'run-teardown',
  assignmentId: 'assignment-teardown',
  taskId: 'task-teardown',
  agentPath: 'agents/teardown',
  authority: { kind: 'runtime-assignment', processIdentity: 'teardown' },
}

function makeInvocation(): CapabilityInvocation {
  return {
    capabilityId: 'test.mutate',
    source: { kind: 'builtin', id: 'teardown', version: '1' },
    toolCallId: 'call-teardown',
    input: { target: 'counter' },
  }
}

/** Every durable append this dispatch made, in order, with its attempt. */
interface RecordedAppend {
  readonly stage: string
  readonly dispatchId: string
  readonly attemptId: string
  readonly code?: string
}

/**
 * Holds one append open, so a test can observe the exact moment it is in
 * progress and not yet durable.
 */
interface AppendBarrier {
  readonly entered: { resolve: () => void }
  readonly resume: Promise<void>
  /** When set, the append fails with this instead of being recorded. */
  readonly rejectWith?: Error
}

function makeDurablePort(
  appends: RecordedAppend[],
  barriers: {
    readonly started?: AppendBarrier
    readonly accepted?: AppendBarrier
    /** Fail this many `recordIndeterminate` calls before letting one land. */
    readonly failIndeterminateTimes?: number
    /**
     * Holds the *first* indeterminate append open. A teardown parked here is
     * published but has decided nothing, which is the only window in which a
     * completion can join a teardown that is about to fail.
     */
    readonly firstIndeterminate?: AppendBarrier
    /**
     * Holds the *second* indeterminate append open — published, but not yet
     * recorded and not yet terminal. That is the only window in which a
     * completion can reach the teardown gate while its attempt is still
     * `started`.
     */
    readonly secondIndeterminate?: AppendBarrier
    /**
     * Watches the commit append. `entered` flips the moment the completion
     * enters it — before anything is recorded — and the append is then held,
     * so a completion that got past the teardown gate is caught at the first
     * step it takes rather than after it has written a whole terminal.
     */
    readonly committed?: { entered: boolean; readonly resume: Promise<void> }
    /**
     * Whether this port derives the legacy evidence view. Ports that do have
     * their terminal evidence writes skipped entirely, so a test that needs
     * the legacy writer to run — and to fail — has to say so.
     */
    readonly derivesEvidence?: boolean
  },
): CapabilityDurableDispatchPort {
  let indeterminateFailuresLeft = barriers.failIndeterminateTimes ?? 0
  let indeterminateCalls = 0
  const record = (stage: string) =>
    async (input: {
      readonly dispatchId: string
      readonly attemptId: string
    }): Promise<void> => {
      appends.push({
        stage,
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
      })
    }
  return {
    derivesCapabilityEvidence: barriers.derivesEvidence ?? true,
    bindInvocationIdentity: async (input) => ({
      kind: 'bound',
      invocation: input.invocation,
    }),
    recover: async () => ({ kind: 'retriable' }),
    inspectOutcome: async () => ({ kind: 'not_found' }),
    projectionStatus: async () => 'current',
    // Derives nothing, so there is nothing to bring forward.
    flushProjections: async () => undefined,
    recordRequested: record('requested'),
    recordApprovalRequested: record('approval_requested'),
    recordApprovalResolved: record('approval_resolved'),
    recordPrepared: record('prepared'),
    recordStarted: async (input) => {
      // Held open, so the test can look at the registry at the exact moment
      // the started barrier is in progress but not yet durable. Inferring
      // that moment from executor entry would miss a registration that
      // happened too early — which is the ordering this test exists to pin.
      if (barriers.started) {
        barriers.started.entered.resolve()
        await barriers.started.resume
      }
      appends.push({
        stage: 'started',
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
      })
    },
    recordCommitted: async (input) => {
      if (barriers.committed) {
        barriers.committed.entered = true
        await barriers.committed.resume
      }
      appends.push({
        stage: 'committed',
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
      })
    },
    recordAccepted: async (input) => {
      // Same trick at the other end: acceptance in progress, not yet durable,
      // is the window in which teardown and a normal completion can collide.
      if (barriers.accepted) {
        barriers.accepted.entered.resolve()
        await barriers.accepted.resume
        if (barriers.accepted.rejectWith) throw barriers.accepted.rejectWith
      }
      appends.push({
        stage: 'accepted',
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
      })
    },
    recordIndeterminate: async (input) => {
      indeterminateCalls += 1
      // Held before the failure, not after it, so a test can decide when a
      // published teardown gives up rather than having it fail on entry.
      const hold = indeterminateCalls === 1
        ? barriers.firstIndeterminate
        : indeterminateCalls === 2
          ? barriers.secondIndeterminate
          : undefined
      if (hold) {
        hold.entered.resolve()
        await hold.resume
      }
      if (indeterminateFailuresLeft > 0) {
        indeterminateFailuresLeft -= 1
        // Nothing is recorded: the append failed, exactly as a transient
        // journal fault would leave it.
        throw new Error('indeterminate append failed')
      }
      appends.push({
        stage: 'indeterminate',
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
        code: input.code,
      })
    },
    recordTerminal: record('terminal'),
  }
}

/** What the shell is handed: an assignment, and an opaque operation. */
interface Registration {
  readonly scope: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
  }
  readonly finalizer: DurableTeardownFinalizer
}

function makeTeardownRegistry(registrations: Registration[]): {
  readonly port: DurableTeardownRegistry
  readonly live: () => Registration[]
} {
  const live = new Set<Registration>()
  return {
    port: {
      register: (input) => {
        const registration: Registration = {
          scope: input.scope,
          finalizer: input.finalizer,
        }
        registrations.push(registration)
        live.add(registration)
        return () => live.delete(registration)
      },
    },
    live: () => [...live],
  }
}

function makeDispatcher(
  durable: CapabilityDurableDispatchPort,
  teardown: DurableTeardownRegistry,
  /** Fails the legacy evidence write for the event types it names. */
  failEvidenceFor: ReadonlySet<string> = new Set(),
  /** Records every legacy evidence event, so a test can read the projection. */
  evidenceEvents: Array<{ type: string; code: string | undefined }> = [],
  /**
   * Holds the legacy evidence write for the event types it names. The dispatch
   * is still registered for teardown while this is held — its finalizer is
   * unregistered only after the terminal returns — which is the window in
   * which a late teardown can reach an attempt that has already settled.
   */
  holdEvidence?: {
    readonly types: ReadonlySet<string>
    readonly entered: { resolve: () => void }
    readonly resume: Promise<void>
  },
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
    evidence: {
      append: async (event) => {
        if (failEvidenceFor.has(event.type)) {
          throw new Error(`evidence append failed for ${event.type}`)
        }
        if (holdEvidence?.types.has(event.type)) {
          holdEvidence.entered.resolve()
          await holdEvidence.resume
        }
        evidenceEvents.push({ type: event.type, code: event.code })
      },
    },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    // Fixed, because nothing here depends on real time or real randomness and
    // an identity the test controls is one it can assert against.
    clock: { now: () => FIXED_NOW_MS },
    ids: { nextAttemptId: () => FIXED_ATTEMPT_ID },
    durable: async () => durable,
    teardown,
  })
}

const FIXED_NOW_MS = 1_772_000_000_000
const FIXED_ATTEMPT_ID = 'attempt-teardown-fixed'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = () => settle()
  })
  return { promise, resolve }
}

test('a live dispatch is registered for teardown once its started barrier is durable', async () => {
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const startedEntered = deferred()
  const resumeStarted = deferred()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {
      started: { entered: startedEntered, resume: resumeStarted.promise },
    }),
    registry.port,
  )

  const started = deferred()
  const holdEffect = deferred()
  const adapter: CapabilityAdapter = {
    capabilityId: 'test.mutate',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'non_retryable' as const,
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        // Entered only after the durable `started` append, so registration
        // can be observed from here.
        started.resolve()
        await holdEffect.promise
        return { ok: true }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }

  // Nothing is registered before the dispatch begins.
  assert.equal(registrations.length, 0, 'no attempt exists yet')

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
    adapter,
  })

  // The started append is in progress and has not landed.
  await startedEntered.promise
  assert.equal(
    registry.live().length,
    0,
    'an attempt whose started barrier is not yet durable must not be ' +
      'registered: teardown could otherwise finalize an attempt the journal ' +
      'has no record of starting',
  )

  resumeStarted.resolve()
  await started.promise

  const startedAppend = appends.find((append) => append.stage === 'started')
  assert.ok(startedAppend, 'the started barrier must be durable by now')
  assert.equal(
    registry.live().length,
    1,
    'and the attempt must be registered for teardown exactly once',
  )
  const registration = registrations[0]
  assert.ok(registration)
  assert.deepEqual(
    registration.scope,
    {
      sessionId: CONTEXT.sessionId,
      runId: CONTEXT.runId,
      assignmentId: CONTEXT.assignmentId,
    },
    'the shell is given the assignment it needs to key its set, and nothing ' +
      'more — dispatch and attempt identity stay inside the core',
  )

  // Teardown gives up on this dispatch. Twice, because a drain that retries
  // must not be able to write two decisions.
  await registration.finalizer.finalizeIndeterminate(
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
  )
  await registration.finalizer.finalizeIndeterminate(
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
  )

  const indeterminate = appends.filter(
    (append) => append.stage === 'indeterminate',
  )
  assert.equal(
    indeterminate.length,
    1,
    `finalizing twice must append once, saw ${JSON.stringify(indeterminate)}`,
  )
  assert.equal(indeterminate[0]?.code, ASSIGNMENT_RELEASE_DEADLINE_CODE)
  assert.equal(
    indeterminate[0]?.dispatchId,
    startedAppend.dispatchId,
    'and it must be recorded for the dispatch that actually started',
  )
  assert.equal(
    indeterminate[0]?.attemptId,
    startedAppend.attemptId,
    'and for that exact attempt',
  )

  // The non-cooperative effect finishes afterwards. It settles on the decision
  // teardown already recorded, and contributes no contradicting append.
  holdEffect.resolve()
  const settled = await dispatch
  assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
  assert.equal(
    settled.status === 'indeterminate' ? settled.code : '',
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
  )
  assert.deepEqual(
    appends.filter((append) =>
      ['committed', 'accepted'].includes(append.stage),
    ),
    [],
    'a finalized attempt may not go on to claim it committed or was accepted',
  )
})

test('teardown joins a completion already in progress instead of overriding it', async () => {
  // The other side of the one-shot. A dispatch can be finishing normally at
  // the moment teardown reaches its deadline: `committed` is durable and
  // `accepted` is in flight. Appending an explicit `indeterminate` into that
  // window would contradict an acceptance that is about to land, and would
  // tell an operator to reconcile a dispatch that completed.
  //
  // So teardown joins rather than races: if the completion reaches
  // `accepted`, teardown appends nothing and the dispatch completes normally.
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const acceptedEntered = deferred()
  const resumeAccepted = deferred()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {
      accepted: { entered: acceptedEntered, resume: resumeAccepted.promise },
    }),
    registry.port,
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
    adapter: {
      capabilityId: 'test.mutate',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'test-mutating',
        argumentNames: ['target'],
        policyDecision: { kind: 'allow' },
        recoveryPolicy: 'non_retryable' as const,
        authorize: async () => ({ kind: 'allow' }),
        execute: async () => ({ ok: true }),
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })

  // The acceptance append is in progress and has not landed.
  await acceptedEntered.promise
  const registration = registrations[0]
  assert.ok(registration, 'the attempt registered when its started barrier landed')

  // Teardown gives up at exactly this moment.
  const finalizing = registration.finalizer.finalizeIndeterminate(
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
  )
  resumeAccepted.resolve()
  await finalizing

  const settled = await dispatch
  assert.equal(
    settled.status,
    'completed',
    `the completion was already durable, so it wins: ${JSON.stringify(settled)}`,
  )
  assert.deepEqual(
    appends.map((append) => append.stage),
    ['requested', 'prepared', 'started', 'committed', 'accepted'],
    'and teardown appended nothing — an indeterminate here would contradict ' +
      'the acceptance that landed',
  )
  assert.equal(
    registry.live().length,
    0,
    'a settled attempt is no longer live for teardown',
  )
})

test('teardown records its decision when the joined completion fails to accept', async () => {
  // The other half of the join. Teardown waits for a completion that is
  // already under way — but that completion does not always win. If its
  // acceptance append fails, the attempt has a durable `committed` and no
  // terminal, and nothing has recorded what teardown decided.
  //
  // Two code paths now want to answer for the same attempt: the dispatcher's
  // own catch around `recordCompletion`, which reports
  // `durable_acceptance_write_failed`, and the teardown finalizer, which
  // reports the deadline it hit. They must not produce different answers —
  // teardown asked first, and its decision is the one already headed for the
  // journal an operator will read.
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const acceptedEntered = deferred()
  const resumeAccepted = deferred()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {
      accepted: {
        entered: acceptedEntered,
        resume: resumeAccepted.promise,
        rejectWith: new Error('acceptance append failed'),
      },
    }),
    registry.port,
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
    adapter: {
      capabilityId: 'test.mutate',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'test-mutating',
        argumentNames: ['target'],
        policyDecision: { kind: 'allow' },
        recoveryPolicy: 'non_retryable' as const,
        authorize: async () => ({ kind: 'allow' }),
        execute: async () => ({ ok: true }),
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })

  await acceptedEntered.promise
  const registration = registrations[0]
  assert.ok(registration)

  // Teardown gives up while the acceptance is still in flight, then that
  // acceptance fails.
  const finalizing = registration.finalizer.finalizeIndeterminate(
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
  )
  resumeAccepted.resolve()
  await finalizing

  const settled = await dispatch

  assert.deepEqual(
    appends.map((append) => append.stage),
    ['requested', 'prepared', 'started', 'committed', 'indeterminate'],
    'the acceptance never landed, so the attempt is finished by teardown',
  )
  const indeterminate = appends.filter(
    (append) => append.stage === 'indeterminate',
  )
  assert.equal(indeterminate.length, 1, 'and exactly once')
  assert.equal(
    indeterminate[0]?.code,
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
    'carrying the decision teardown made',
  )

  assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
  assert.equal(
    settled.status === 'indeterminate' ? settled.code : '',
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
    'the caller is told what the journal says. `durable_acceptance_write_failed` ' +
      'would be a second, different answer to the same question',
  )
  assert.equal(
    registry.live().length,
    0,
    'a settled attempt is no longer live for teardown',
  )
})

/**
 * Characterization, not a Red.
 *
 * The worry this answers is whether teardown's join can hang: it waits on a
 * completion that might never settle, so an unbounded wait would hold the
 * drain open past its deadline.
 *
 * It cannot, and the reason is a contract the real port already keeps.
 * `recordCompletion` is handed the settlement-owned signal, and the journal
 * checks abort on every queued append at commit time
 * (`core/execution-journal.ts:1003`), rejecting that entry rather than
 * waiting. So a completion that outlives its settlement bound *fails*; it
 * does not stall. The port here is abort-aware in the same way, and the join
 * completes.
 *
 * Manufacturing a Red from a port that ignores abort and then writes
 * `accepted` afterwards would be inventing a durable authority that does not
 * exist, and racing against it in core would risk contradictory late writes
 * rather than prevent them.
 */
test('teardown’s join settles when an abort-aware completion hits its settlement bound', async () => {
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const acceptedEntered = deferred()
  const dispatcher = makeDispatcher(
    {
      ...makeDurablePort(appends, {}),
      recordAccepted: async (input) => {
        acceptedEntered.resolve()
        // Exactly what the journal does with a queued append whose signal is
        // aborted: it rejects. It never resolves late, and never writes
        // `accepted` after the bound has passed.
        await new Promise<never>((_resolve, reject) => {
          const signal = input.signal
          if (!signal) return
          if (signal.aborted) {
            reject(new Error('append aborted'))
            return
          }
          signal.addEventListener(
            'abort',
            () => reject(new Error('append aborted')),
            { once: true },
          )
        })
      },
    },
    registry.port,
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
    // Already due against the fixed clock, so the deadline's timer is a
    // zero-delay macrotask. `run` starts the completion in a microtask, so
    // `recordAccepted` is reliably entered before that timer fires — the
    // ordering is by task class, not by elapsed time.
    settlementDeadlineMs: FIXED_NOW_MS,
    adapter: {
      capabilityId: 'test.mutate',
      prepare: async () => ({
        effect: serialCapabilityEffect('mutating'),
        risk: 'test-mutating',
        argumentNames: ['target'],
        policyDecision: { kind: 'allow' },
        recoveryPolicy: 'non_retryable' as const,
        authorize: async () => ({ kind: 'allow' }),
        execute: async () => ({ ok: true }),
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })

  await acceptedEntered.promise
  const registration = registrations[0]
  assert.ok(registration)

  // The join returns rather than hanging, because the completion it joined
  // failed at its bound.
  await registration.finalizer.finalizeIndeterminate(
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
  )

  const settled = await dispatch
  assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
  assert.equal(
    appends.some((append) => append.stage === 'accepted'),
    false,
    'and no acceptance was written after the bound',
  )
})

test('a teardown append that fails can be retried, and records once when it lands', async () => {
  // AC6 established that a recoverable journal fault retires a handle rather
  // than ending the assignment. The teardown finalizer has to hold the same
  // line: a strict append that fails must leave the attempt live and
  // undecided, so a later release can try again. Remembering the failure
  // forever would turn one transient fault into an attempt that can never be
  // finalized — and teardown closes the journal after this, so "never" means
  // a stream that stops with no decision in it.
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const started = deferred()
  const holdEffect = deferred()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, { failIndeterminateTimes: 1 }),
    registry.port,
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
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
          started.resolve()
          await holdEffect.promise
          return { ok: true }
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })
  await started.promise
  const registration = registrations[0]
  assert.ok(registration)

  // First release: the append fails.
  await assert.rejects(
    registration.finalizer.finalizeIndeterminate(
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
    ),
    'the strict append must surface its failure to whoever is tearing down',
  )
  assert.equal(
    appends.some((append) => append.stage === 'indeterminate'),
    false,
    'nothing was recorded, so nothing may be claimed',
  )
  assert.equal(
    registry.live().length,
    1,
    'and the attempt is still live: it has not been decided',
  )

  // A later release tries again, and this time it lands.
  await registration.finalizer.finalizeIndeterminate(
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
  )
  const indeterminate = appends.filter(
    (append) => append.stage === 'indeterminate',
  )
  assert.equal(indeterminate.length, 1, 'recorded exactly once')
  assert.equal(indeterminate[0]?.code, ASSIGNMENT_RELEASE_DEADLINE_CODE)

  holdEffect.resolve()
  const settled = await dispatch
  assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
  assert.equal(
    settled.status === 'indeterminate' ? settled.code : '',
    ASSIGNMENT_RELEASE_DEADLINE_CODE,
    'and the dispatch reports the decision that was actually recorded',
  )
})

/**
 * The exit matrix. Registration happens once the started barrier is durable,
 * and every path out from there must remove it — otherwise teardown holds a
 * finalizer for an attempt that already ended, and would append a decision
 * over a stream that has one.
 *
 * Normal success and acceptance failure are covered by the tests above. These
 * add the two remaining post-start exits that reach the executor: it throws,
 * and it is cancelled. Paths that end *before* the started barrier need no
 * case, because nothing is registered until that barrier lands — which the
 * first test pins directly.
 */
test('a completion waiting on a failed teardown yields to the published retry', async () => {
  // The rejected-teardown continuation is its own gate hazard. A completion
  // that joined a teardown which then failed must not walk straight into
  // appending: the failure cleared teardown's memo, so a retrying teardown
  // may already have published a new attempt. The continuation therefore
  // re-enters the gate rather than publishing directly.
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const started = deferred()
  const holdEffect = deferred()
  const acceptEntered = deferred()
  const firstEntered = deferred()
  const releaseFirst = deferred()
  const secondEntered = deferred()
  const releaseSecond = deferred()
  const releaseCommitted = deferred()
  // Flipped by the fake port the instant a commit append is entered. A
  // completion that skipped the gate is caught here, before it has written
  // anything, rather than by inspecting the wreckage afterwards.
  const committed = { entered: false, resume: releaseCommitted.promise }
  const dispatcher = makeDispatcher(
    // Both teardown appends are held: the first so a completion can join it
    // before it fails, the second so the completion's continuation meets a
    // live gate on an attempt that is still `started`.
    makeDurablePort(appends, {
      failIndeterminateTimes: 1,
      firstIndeterminate: {
        entered: firstEntered,
        resume: releaseFirst.promise,
      },
      secondIndeterminate: {
        entered: secondEntered,
        resume: releaseSecond.promise,
      },
      committed,
    }),
    registry.port,
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
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
          started.resolve()
          await holdEffect.promise
          return { ok: true }
        },
        acceptResult: async ({ value }) => {
          // The last collaborator the dispatch touches before it reaches the
          // teardown gate. Everything between here and that gate is plain
          // promise work with no timer and no I/O, so one macrotask turn
          // after this necessarily drains it.
          acceptEntered.resolve()
          return { value }
        },
      }),
    },
  })
  try {
    await started.promise
    const registration = registrations[0]
    assert.ok(registration)

    // A teardown is published and parked on its append: decided nothing yet,
    // and about to fail.
    let retry: Promise<void> | undefined
    const failing = registration.finalizer
      .finalizeIndeterminate(ASSIGNMENT_RELEASE_DEADLINE_CODE)
      .catch(() => {
        // Attached before the completion joins, so it runs first: by the time
        // the completion's continuation sees the failure, a fresh teardown is
        // already published. That is the interleaving the guard exists for.
        retry = registration.finalizer.finalizeIndeterminate(
          ASSIGNMENT_RELEASE_DEADLINE_CODE,
        )
      })
    await firstEntered.promise

    // Released while that first teardown is still pending, so the completion
    // joins *it* rather than whatever replaces it.
    holdEffect.resolve()
    await acceptEntered.promise
    await new Promise((settle) => setImmediate(settle))
    await new Promise((settle) => setImmediate(settle))
    assert.equal(
      committed.entered,
      false,
      'the completion must be waiting on the published teardown, not writing',
    )

    // Now let that teardown fail. Its rejection handler publishes the retry
    // synchronously, and only then does the completion's continuation run.
    releaseFirst.resolve()
    await failing
    assert.ok(retry, 'the first attempt must have failed and been retried')
    await secondEntered.promise
    await new Promise((settle) => setImmediate(settle))
    await new Promise((settle) => setImmediate(settle))

    // The load-bearing observation. The continuation found no recorded
    // decision — the failed append wrote nothing — so it went back through
    // the gate and is now waiting on the retry. A continuation that published
    // straight away instead would have entered the commit append by now.
    assert.equal(
      committed.entered,
      false,
      'a continuation that publishes directly steps past the gate the retry ' +
        'has already re-established',
    )

    releaseSecond.resolve()
    await retry

    const settled = await dispatch
    const stages = appends.map((append) => append.stage)

    assert.equal(
      stages.filter((stage) => stage === 'indeterminate').length,
      1,
      `the retry records the decision exactly once: ${JSON.stringify(stages)}`,
    )
    assert.deepEqual(
      stages.filter((stage) => ['committed', 'accepted'].includes(stage)),
      [],
      `and the completion yields to it rather than appending a terminal over ` +
        `it: ${JSON.stringify(stages)}`,
    )
    assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
    assert.equal(
      settled.status === 'indeterminate' ? settled.code : '',
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
      'and the caller is told what the journal says',
    )
  } finally {
    // Every hold is released whichever way the test leaves, so a failing run
    // reports its assertion instead of hanging on a barrier nobody opened.
    holdEffect.resolve()
    releaseFirst.resolve()
    releaseSecond.resolve()
    releaseCommitted.resolve()
  }
})

test('a post-start failure yields to a teardown decision already published', async () => {
  // The gate has to cover every post-start terminal, not just the successful
  // one. A dispatch that fails after its started barrier records its own
  // `indeterminate` through the ordinary terminal path — and if teardown's
  // append is in flight at that moment, that path would write a second
  // decision, with a different code, onto the same attempt. One attempt, one
  // decision: whichever side published first wins, and the other joins it.
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const started = deferred()
  const holdEffect = deferred()
  const firstEntered = deferred()
  const releaseFirst = deferred()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {
      firstIndeterminate: {
        entered: firstEntered,
        resume: releaseFirst.promise,
      },
    }),
    registry.port,
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
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
          started.resolve()
          await holdEffect.promise
          throw new Error('the effect failed')
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })
  try {
    await started.promise
    const registration = registrations[0]
    assert.ok(registration)

    // Teardown is published and parked on its append, having decided nothing
    // yet.
    const finalizing = registration.finalizer.finalizeIndeterminate(
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
    )
    await firstEntered.promise

    // The executor fails while that append is still in flight, which is the
    // whole window: the attempt is still `started`, so a terminal path that
    // does not consult the gate sees nothing stopping it.
    holdEffect.resolve()
    await new Promise((settle) => setImmediate(settle))
    await new Promise((settle) => setImmediate(settle))

    releaseFirst.resolve()
    await finalizing
    const settled = await dispatch

    const decisions = appends.filter((append) =>
      append.stage === 'indeterminate'
    )
    assert.equal(
      decisions.length,
      1,
      `one attempt carries one decision: ${JSON.stringify(appends.map((append) => append.stage))}`,
    )
    assert.equal(
      decisions[0]?.code,
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
      'and it is the one teardown published first',
    )
    assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
    assert.equal(
      settled.status === 'indeterminate' ? settled.code : '',
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
      'the caller is told what the journal says, not what its adapter did',
    )
  } finally {
    holdEffect.resolve()
    releaseFirst.resolve()
  }
})

test('an ordinary decision whose append failed reports the teardown that landed', async () => {
  // The mirror of the teardown-first races, and the one the best-effort path
  // hides. An ordinary post-start terminal publishes first, so teardown joins
  // it and waits. That append then *fails* — and because it is best-effort the
  // failure is swallowed, so the attempt is still unfinished and teardown
  // correctly goes on to record its own decision. The journal therefore ends
  // up carrying teardown's code while the caller was told the ordinary one.
  //
  // Publishing first is not the same as recording first. Only the side whose
  // append actually landed may be reported.
  const appends: RecordedAppend[] = []
  const evidenceEvents: Array<{ type: string; code: string | undefined }> = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const started = deferred()
  const holdEffect = deferred()
  const firstEntered = deferred()
  const releaseFirst = deferred()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {
      // The port does not derive the legacy view, so the terminal projection
      // is actually written and can be read back below.
      derivesEvidence: false,
      // Held so teardown can publish behind it, then failed: the ordinary
      // decision wrote nothing.
      firstIndeterminate: {
        entered: firstEntered,
        resume: releaseFirst.promise,
      },
      failIndeterminateTimes: 1,
    }),
    registry.port,
    new Set(),
    evidenceEvents,
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
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
          started.resolve()
          await holdEffect.promise
          throw new Error('the effect failed')
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })
  try {
    await started.promise
    const registration = registrations[0]
    assert.ok(registration)

    // The ordinary terminal path publishes and parks on its append.
    holdEffect.resolve()
    await firstEntered.promise

    // Teardown arrives behind it and joins rather than racing.
    const finalizing = registration.finalizer.finalizeIndeterminate(
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
    )
    await new Promise((settle) => setImmediate(settle))

    // The ordinary append fails, writing nothing, so teardown proceeds.
    releaseFirst.resolve()
    await finalizing
    const settled = await dispatch

    const decisions = appends.filter((append) =>
      append.stage === 'indeterminate'
    )
    assert.equal(
      decisions.length,
      1,
      `exactly one decision landed: ${JSON.stringify(appends.map((append) => append.stage))}`,
    )
    assert.equal(
      decisions[0]?.code,
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
      'and it is teardown’s, because the ordinary append wrote nothing',
    )
    assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
    assert.equal(
      settled.status === 'indeterminate' ? settled.code : '',
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
      'the caller is told the decision the journal carries',
    )
    assert.deepEqual(
      evidenceEvents
        .filter((event) => event.type.startsWith('capability.dispatch.'))
        .filter((event) =>
          ['capability.dispatch.indeterminate', 'capability.dispatch.failed']
            .includes(event.type)
        )
        .map((event) => event.code),
      [ASSIGNMENT_RELEASE_DEADLINE_CODE],
      'and so is the legacy projection, which must not contradict it',
    )
  } finally {
    holdEffect.resolve()
    releaseFirst.resolve()
  }
})

test('a teardown arriving after the attempt settled adds no second answer', async () => {
  // The other half of the same hazard. The ordinary durable append fails with
  // no teardown yet, so nothing durable is recorded and the caller keeps its
  // own indeterminate. The dispatch is still registered while its terminal
  // projection is being written — the finalizer is unregistered only after
  // the terminal returns — so a teardown can still arrive here and find an
  // attempt whose phase never reached `terminal`.
  //
  // Appending then would give this attempt a second, different code, which
  // the caller and the projection have already been told nothing about. So
  // the ordinary path closes the attempt to a later teardown at the moment it
  // commits to reporting its own result: one question, one answer. The
  // journal is left at `started` with no terminal, which recovery reduces to
  // indeterminate — the same thing the caller was told.
  const appends: RecordedAppend[] = []
  const evidenceEvents: Array<{ type: string; code: string | undefined }> = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const started = deferred()
  const evidenceEntered = deferred()
  const releaseEvidence = deferred()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {
      derivesEvidence: false,
      // The ordinary decision's append fails outright, writing nothing.
      failIndeterminateTimes: 1,
    }),
    registry.port,
    new Set(),
    evidenceEvents,
    {
      types: new Set(['capability.dispatch.indeterminate']),
      entered: evidenceEntered,
      resume: releaseEvidence.promise,
    },
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
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
          started.resolve()
          throw new Error('the effect failed')
        },
      acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })
  try {
    await started.promise
    const registration = registrations[0]
    assert.ok(registration)

    // The attempt has settled on its own result and is writing the projection.
    await evidenceEntered.promise

    // Teardown arrives now, into that window.
    await registration.finalizer.finalizeIndeterminate(
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
    )
    assert.deepEqual(
      appends.filter((append) => append.stage === 'indeterminate'),
      [],
      `a settled attempt must not acquire a decision the caller was never ` +
        `given: ${JSON.stringify(appends.map((append) => append.stage))}`,
    )

    releaseEvidence.resolve()
    const settled = await dispatch

    assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
    assert.equal(
      settled.status === 'indeterminate' ? settled.code : '',
      'capability_execution_indeterminate',
      'the caller keeps the result it settled on',
    )
    assert.deepEqual(
      evidenceEvents
        .filter((event) => event.type === 'capability.dispatch.indeterminate')
        .map((event) => event.code),
      ['capability_execution_indeterminate'],
      'and the projection says the same thing',
    )
  } finally {
    releaseEvidence.resolve()
  }
})

test('a teardown after a failed acceptance adds no second answer either', async () => {
  // The mirror of the settled-attempt cutoff, on the strict completion path.
  // `recordCommitted` lands and `recordAccepted` fails, so the dispatch asks
  // whether teardown decided this attempt, is told no, and settles on
  // `durable_acceptance_write_failed`. The durable terminal is then skipped
  // deliberately — a commit record already proves the effect, and appending a
  // second terminal would substitute for the acceptance whose outcome is
  // unknown (ADR §6).
  //
  // That leaves the attempt at `started`/`committed` with the dispatch still
  // registered while its projection is written, so a teardown arriving here
  // could give it a different code than the one the caller already has.
  // Asking whether teardown decided is therefore also the moment the attempt
  // closes to a later one.
  const appends: RecordedAppend[] = []
  const evidenceEvents: Array<{ type: string; code: string | undefined }> = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const started = deferred()
  const acceptEntered = deferred()
  const acceptResume = deferred()
  const evidenceEntered = deferred()
  const releaseEvidence = deferred()
  acceptResume.resolve()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {
      derivesEvidence: false,
      accepted: {
        entered: acceptEntered,
        resume: acceptResume.promise,
        rejectWith: new Error('acceptance append failed'),
      },
    }),
    registry.port,
    new Set(),
    evidenceEvents,
    {
      types: new Set(['capability.dispatch.indeterminate']),
      entered: evidenceEntered,
      resume: releaseEvidence.promise,
    },
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
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
          started.resolve()
          return { ok: true }
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })
  try {
    await started.promise

    // The acceptance has failed and the dispatch is writing its projection.
    await evidenceEntered.promise
    const registration = registrations[0]
    assert.ok(registration)

    await registration.finalizer.finalizeIndeterminate(
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
    )
    assert.deepEqual(
      appends.filter((append) => append.stage === 'indeterminate'),
      [],
      `an attempt that already answered must not acquire a second decision: ` +
        `${JSON.stringify(appends.map((append) => append.stage))}`,
    )

    releaseEvidence.resolve()
    const settled = await dispatch

    assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
    assert.equal(
      settled.status === 'indeterminate' ? settled.code : '',
      'durable_acceptance_write_failed',
      'the caller keeps the answer it was given',
    )
    assert.deepEqual(
      evidenceEvents
        .filter((event) => event.type === 'capability.dispatch.indeterminate')
        .map((event) => event.code),
      ['durable_acceptance_write_failed'],
      'and the projection says the same thing',
    )
  } finally {
    releaseEvidence.resolve()
  }
})

test('a failed evidence write does not overwrite the teardown decision', async () => {
  // The legacy evidence stream is a projection; the journal is the authority
  // (ADR §9). When teardown has already decided this attempt and the legacy
  // terminal write then fails, answering `terminal_evidence_write_failed`
  // would be a second, different answer to one question — and the one the
  // journal does not carry.
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const started = deferred()
  const holdEffect = deferred()
  const firstEntered = deferred()
  const releaseFirst = deferred()
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {
      // A port that derives the legacy view has its terminal evidence write
      // skipped, so this one deliberately does not derive it.
      derivesEvidence: false,
      firstIndeterminate: {
        entered: firstEntered,
        resume: releaseFirst.promise,
      },
    }),
    registry.port,
    new Set(['capability.dispatch.indeterminate']),
  )

  const dispatch: Promise<CapabilityDispatchResult> = dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
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
          started.resolve()
          await holdEffect.promise
          throw new Error('the effect failed')
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })
  try {
    await started.promise
    const registration = registrations[0]
    assert.ok(registration)

    const finalizing = registration.finalizer.finalizeIndeterminate(
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
    )
    await firstEntered.promise

    holdEffect.resolve()
    await new Promise((settle) => setImmediate(settle))
    await new Promise((settle) => setImmediate(settle))

    releaseFirst.resolve()
    await finalizing
    const settled = await dispatch

    assert.equal(settled.status, 'indeterminate', JSON.stringify(settled))
    assert.equal(
      settled.status === 'indeterminate' ? settled.code : '',
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
      'the journal decided this attempt; a failed projection write does not ' +
        'get to replace that decision with one of its own',
    )
  } finally {
    holdEffect.resolve()
    releaseFirst.resolve()
  }
})

test('an executor failure after the started barrier leaves nothing registered', async () => {
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {}),
    registry.port,
  )

  const settled = await dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
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
          throw new Error('the effect failed')
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })

  assert.notEqual(settled.status, 'completed', JSON.stringify(settled))
  assert.equal(registrations.length, 1, 'it did register when it started')
  assert.equal(
    registry.live().length,
    0,
    'and unregistered on the way out, however it left',
  )
})

test('a cancellation after the started barrier leaves nothing registered', async () => {
  const appends: RecordedAppend[] = []
  const registrations: Registration[] = []
  const registry = makeTeardownRegistry(registrations)
  const dispatcher = makeDispatcher(
    makeDurablePort(appends, {}),
    registry.port,
  )

  const cancelling = new AbortController()
  const entered = deferred()
  const settled = await dispatcher.dispatch({
    context: CONTEXT,
    invocation: makeInvocation(),
    signal: cancelling.signal,
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
          entered.resolve()
          cancelling.abort()
          throw signal.reason ?? new Error('cancelled')
        },
        acceptResult: async ({ value }) => ({ value }),
      }),
    },
  })

  await entered.promise
  assert.notEqual(settled.status, 'completed', JSON.stringify(settled))
  assert.equal(registrations.length, 1, 'it did register when it started')
  assert.equal(
    registry.live().length,
    0,
    'and a cancelled attempt is not left live for teardown',
  )
})
