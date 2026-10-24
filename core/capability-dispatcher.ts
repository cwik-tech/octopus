import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  canonicalizeCapabilityEffect,
  type CapabilityEffect,
} from '../contracts/capability-effect.js'
import {
  CanonicalJsonError,
  type CanonicalJsonDocument,
} from '../contracts/canonical-json.js'
import type {
  CapabilityAcceptedResult,
  CapabilityApprovalInteraction,
  CapabilityApprovalOutcome,
  CapabilityAuthorizationPhase,
  CapabilityBudgetPreflight,
  CapabilityBudgetReservation,
  CapabilityBudgetSettlement,
  CapabilityCompletionFence,
  CapabilityDispatchEvent,
  CapabilityDispatchEventType,
  CapabilityDispatchRequest,
  CapabilityDispatchResult,
  CapabilityDispatcherPorts,
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
  CapabilityPolicyDecision,
  CapabilityPreparedExecution,
  CapabilityScopeAuthority,
} from '../contracts/capability-dispatch.js'
import type {
  CapabilityDurableDispatchPort,
  CapabilityRecoveryPolicy,
} from '../contracts/durable-dispatch.js'
import {
  canonicalizeJson,
  type CanonicalJsonObject,
} from '../contracts/canonical-json.js'
import { normalizeCanonicalJsonObject } from './canonical-json-hash.js'
import { resolveCapabilityPolicy } from './capability-policy.js'
import { whenDefined } from './optional-properties.js'

interface ResolvedDispatcherPorts {
  readonly bindings: NonNullable<CapabilityDispatcherPorts['bindings']>
  readonly authority: NonNullable<CapabilityDispatcherPorts['authority']>
  readonly policy: NonNullable<CapabilityDispatcherPorts['policy']>
  readonly budget: NonNullable<CapabilityDispatcherPorts['budget']>
  readonly approval: CapabilityDispatcherPorts['approval']
  readonly evidence: NonNullable<CapabilityDispatcherPorts['evidence']>
  readonly scheduler: NonNullable<CapabilityDispatcherPorts['scheduler']>
  readonly clock: NonNullable<CapabilityDispatcherPorts['clock']>
  readonly ids: NonNullable<CapabilityDispatcherPorts['ids']>
  readonly durable: CapabilityDispatcherPorts['durable']
  readonly teardown: CapabilityDispatcherPorts['teardown']
}

interface DispatchIdentity {
  readonly dispatchId: string
  readonly scopeKey: string
  readonly invocation: CapabilityInvocationIdentity
}

type DurableIdentityResolution =
  | {
      readonly kind: 'ready'
      readonly invocation: CapabilityInvocationIdentity
    }
  | {
      readonly kind: 'conflict'
      readonly invocation: CapabilityInvocationIdentity
    }

interface LeaderInput {
  readonly request: CapabilityDispatchRequest
  readonly identity: DispatchIdentity
  readonly json: CanonicalJsonDocument
  readonly ports: ResolvedDispatcherPorts
  readonly attemptId: string
  readonly signal: AbortSignal
  /** Resolved once per dispatch; the journal is assignment-scoped. */
  readonly durable: CapabilityDurableDispatchPort | undefined
}

interface TerminalInput {
  readonly ports: ResolvedDispatcherPorts
  readonly eventBase: Omit<CapabilityDispatchEvent, 'type' | 'timestamp'>
  readonly prepared: CapabilityPreparedExecution
  readonly result: CapabilityDispatchResult
  readonly afterEffect: boolean
  readonly settlement?: SettlementDeadline
  readonly durable?: DurableDispatchSession | undefined
}

type DurableDispatchPhase =
  | 'none'
  | 'requested'
  | 'prepared'
  | 'started'
  | 'terminal'

/**
 * What became of a terminal decision that raced teardown (AC18).
 *
 * Every post-start route out of an attempt goes through this — a completion,
 * a failure, a cancellation — because each of them appends a decision and
 * only one of them may. A discriminated outcome rather than a thrown signal:
 * teardown winning is an ordinary result of the race, not an error, and the
 * caller has to report the decision that was recorded rather than infer one
 * from a failure.
 */
type DurableDecisionOutcome =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'superseded'; readonly code: string }

const TEST_CRASH_AFTER_COMMITTED_CAPABILITY_ENV =
  'PIPELINE_TEST_CRASH_AFTER_DISPATCH_COMMITTED'
const TEST_CRASH_AFTER_COMMITTED_MARKER_ENV =
  'PIPELINE_TEST_CRASH_AFTER_DISPATCH_COMMITTED_MARKER'

/**
 * Die between `capability.dispatch.committed` and `capability.dispatch.accepted`.
 *
 * That window is unreachable from outside the process: it sits between two
 * awaits inside one method, and nothing observable happens in it. Proving what
 * a restart does after a committed-but-unaccepted effect therefore needs the
 * process to die there, and the only alternative — a mock standing in for the
 * journal — would exercise the mock rather than the barrier (AC13).
 *
 * Triple-gated, following `crashAfterReceiptForTest` in `workflows/runner.ts`
 * and the worker guard in `domains/sessions/session-task-runner.ts` and adding
 * one gate they do not have: inert unless `NODE_ENV` is `test`, *and* the named
 * variable matches this dispatch's capability, *and* a marker path is
 * configured. In production and development the first gate is shut, so this
 * returns after a single `NODE_ENV` read on a path that already performs two
 * fsynced appends.
 *
 * A non-empty marker path is part of the gate, not an option. The marker is
 * what lets an observer know the process died *after* the committed append and
 * not somewhere earlier, so a crash without one would be unprovable — and this
 * exists only to be proved. With no marker path configured, the third gate is
 * shut and nothing dies.
 */
function crashAfterCommittedForTest(capabilityId: string): void {
  if (process.env['NODE_ENV'] !== 'test') return
  if (process.env[TEST_CRASH_AFTER_COMMITTED_CAPABILITY_ENV] !== capabilityId) {
    return
  }
  const markerPath = process.env[TEST_CRASH_AFTER_COMMITTED_MARKER_ENV]?.trim()
  if (!markerPath) return

  publishCrashMarker(markerPath)
  process.kill(process.pid, 'SIGKILL')
}

/**
 * Exclusive temporary write, fsync, atomic rename, then fsync the directory.
 *
 * Nothing here is caught. The contract is that the marker's directory entry is
 * durable before the process dies, so a failure to establish that must surface
 * as a visible worker failure rather than a self-kill whose marker may not
 * have survived — which would be indistinguishable from the crash landing in
 * the wrong place.
 */
function publishCrashMarker(markerPath: string): void {
  const directory = path.dirname(markerPath)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryPath = `${markerPath}.${process.pid}.tmp`
  const descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${process.pid}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporaryPath, markerPath)
  const directoryDescriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(directoryDescriptor)
  } finally {
    fs.closeSync(directoryDescriptor)
  }
}

/**
 * Tracks the durable barrier phase for one leader dispatch so terminal
 * recording knows whether the stream exists and whether the effect began.
 */
class DurableDispatchSession {
  phase: DurableDispatchPhase = 'none'
  committedRecorded = false
  /** Whether this port derives the legacy evidence view from its appends. */
  readonly derivesEvidence: boolean
  /** Only for the crash failpoint below, which targets one capability. */
  private readonly capabilityId: string
  private readonly identity: CanonicalJsonObject
  private teardownFinalization: Promise<void> | undefined
  private finalizedTeardownCode: string | undefined
  /** Published before the first decision append begins, for teardown to join. */
  private decisionInFlight: Promise<void> | undefined
  /**
   * Set when the dispatch has committed to reporting a result no durable
   * append backs. Teardown may no longer decide this attempt: doing so would
   * give it a code the caller was never told.
   */
  private decisionSettled = false

  constructor(
    private readonly port: CapabilityDurableDispatchPort,
    private readonly dispatchId: string,
    private readonly attemptId: string,
    eventBase: Omit<CapabilityDispatchEvent, 'type' | 'timestamp'>,
  ) {
    this.identity = JSON.parse(
      canonicalizeJson(eventBase),
    ) as CanonicalJsonObject
    this.capabilityId = eventBase.capabilityId
    this.derivesEvidence = port.derivesCapabilityEvidence
  }

  async recordRequested(signal: AbortSignal): Promise<void> {
    await this.port.recordRequested({
      dispatchId: this.dispatchId,
      attemptId: this.attemptId,
      identity: this.identity,
      signal,
    })
    this.phase = 'requested'
  }

  async recordApprovalRequested(
    interactionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.port.recordApprovalRequested({
      dispatchId: this.dispatchId,
      attemptId: this.attemptId,
      interactionId,
      identity: this.identity,
      signal,
    })
  }

  async recordApprovalResolved(
    interactionId: string,
    approvalOutcome: CapabilityApprovalOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    await this.port.recordApprovalResolved({
      dispatchId: this.dispatchId,
      attemptId: this.attemptId,
      interactionId,
      approvalOutcome,
      identity: this.identity,
      signal,
    })
  }

  async recordPrepared(input: {
    readonly argumentDigest: string
    readonly capabilityId: string
    readonly effect: CapabilityEffect
    readonly recoveryPolicy: CapabilityRecoveryPolicy
    readonly signal: AbortSignal
  }): Promise<void> {
    await this.port.recordPrepared({
      dispatchId: this.dispatchId,
      attemptId: this.attemptId,
      argumentDigest: input.argumentDigest,
      capabilityId: input.capabilityId,
      effect: input.effect,
      recoveryPolicy: input.recoveryPolicy,
      identity: this.identity,
      signal: input.signal,
    })
    this.phase = 'prepared'
  }

  async recordStarted(signal: AbortSignal): Promise<void> {
    await this.port.recordStarted({
      dispatchId: this.dispatchId,
      attemptId: this.attemptId,
      identity: this.identity,
      signal,
    })
    this.phase = 'started'
  }

  /**
   * Record the committed effect and its acceptance, arbitrated like every
   * other post-start decision.
   */
  recordCompletion(
    result: CapabilityDispatchResult,
    signal: AbortSignal,
  ): Promise<DurableDecisionOutcome> {
    return this.arbitrate(() => this.publishCompletion(result, signal))
  }

  /**
   * Record an ordinary post-start terminal, arbitrated the same way.
   *
   * Every route out of a started attempt appends a decision, not just the
   * successful one. A dispatch that fails or is cancelled after its started
   * barrier goes through here, so it meets the same gate a completion does
   * rather than writing a second decision — with a different code — onto an
   * attempt teardown is already finalizing (AC18, ADR §6).
   */
  recordDecision(
    decision:
      | { readonly kind: 'indeterminate'; readonly code: string }
      | { readonly kind: 'terminal'; readonly result: CapabilityDispatchResult },
    signal: AbortSignal | undefined,
  ): Promise<DurableDecisionOutcome> {
    return this.arbitrate(() =>
      this.publish(
        decision.kind === 'indeterminate'
          ? () => this.recordIndeterminateBestEffort(decision.code, signal)
          : () => this.recordTerminalBestEffort(decision.result, signal),
      )
    )
  }

  /**
   * The one-winner gate, read synchronously.
   *
   * Teardown wins this direction: if it has already published its
   * finalization, the caller joins that decision instead of appending a
   * terminal over it. The mirror case — an ordinary decision published first
   * — is handled in `finalizeForTeardown`, which joins *this* session's
   * published promise. Neither side awaits between reading the other's gate
   * and publishing its own, so exactly one of them can win.
   */
  private arbitrate(
    publish: () => Promise<DurableDecisionOutcome>,
  ): Promise<DurableDecisionOutcome> {
    const teardown = this.teardownFinalization
    if (teardown) {
      // A teardown whose append failed recorded nothing, so there is no
      // decision to defer to and the caller may still proceed.
      const afterTeardown = (): Promise<DurableDecisionOutcome> => {
        const code = this.finalizedTeardownCode
        if (code !== undefined) {
          return Promise.resolve({ kind: 'superseded', code })
        }
        // Re-enters the gate rather than publishing straight away. The
        // teardown this continuation was waiting on failed and cleared its
        // memo, so a retrying teardown may already have published a new one —
        // going direct to `publish` would step past a gate that now exists.
        return this.arbitrate(publish)
      }
      return teardown.then(afterTeardown, afterTeardown)
    }
    return publish()
  }

  /**
   * Publish an append on the session before it begins, so a teardown arriving
   * mid-write joins it rather than racing it. The body is deferred by a
   * microtask purely to make that ordering unconditional (AC18).
   *
   * `append` reports whether it actually landed, because publishing first is
   * not recording first: a best-effort append swallows its own failure, and a
   * decision that wrote nothing must not be reported as this attempt's.
   */
  private publish(
    append: () => Promise<boolean>,
  ): Promise<DurableDecisionOutcome> {
    const published = Promise.resolve().then(append)
    // Settled either way, and handled here: teardown joins this to know when
    // the write finished, and reads `phase` to know what it did. A derived
    // promise that could reject would be unhandled when no teardown joins.
    this.decisionInFlight = published.then(
      () => undefined,
      () => undefined,
    )
    return published.then((recorded) =>
      recorded
        ? { kind: 'recorded' as const }
        : this.decisionAfterFailedAppend()
    )
  }

  /**
   * Report what the journal ended up carrying after our own append wrote
   * nothing.
   *
   * A teardown that joined behind us was released the moment that append
   * settled, saw an attempt still unfinished, and went on to record its own
   * decision. That decision is now the only one this attempt carries, so it
   * is the one the caller and the legacy projection must report.
   */
  private async decisionAfterFailedAppend(): Promise<DurableDecisionOutcome> {
    const code = await this.settleAgainstTeardown()
    // Nothing durable from either side, and the attempt is now closed to a
    // later teardown. The caller keeps its own result, and the journal is left
    // at `started` with no terminal — which recovery reduces to indeterminate,
    // the same thing the caller was told, and what the best-effort contract
    // has always relied on.
    if (code === undefined) return { kind: 'recorded' }
    return { kind: 'superseded', code }
  }

  private publishCompletion(
    result: CapabilityDispatchResult,
    signal: AbortSignal,
  ): Promise<DurableDecisionOutcome> {
    return this.publish(async () => {
      await this.port.recordCommitted({
        dispatchId: this.dispatchId,
        attemptId: this.attemptId,
        identity: this.identity,
        signal,
      })
      this.committedRecorded = true
      crashAfterCommittedForTest(this.capabilityId)
      await this.port.recordAccepted({
        dispatchId: this.dispatchId,
        attemptId: this.attemptId,
        result,
        identity: this.identity,
        signal,
      })
      this.phase = 'terminal'
      // Reached only when both appends landed; a failure rejects instead, and
      // the call site joins any teardown decision through
      // `awaitTeardownDecision`.
      return true
    })
  }

  async recordTerminal(
    result: CapabilityDispatchResult,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.port.recordTerminal({
      dispatchId: this.dispatchId,
      attemptId: this.attemptId,
      result,
      identity: this.identity,
      ...(signal === undefined ? {} : { signal }),
    })
    this.phase = 'terminal'
  }

  /**
   * The decision teardown recorded for this attempt, once it has one.
   *
   * Read by the completion path: an attempt that teardown already finalized
   * must settle on that same decision rather than appending a terminal that
   * contradicts the journal (AC18, ADR §7).
   */
  get teardownDecision(): string | undefined {
    return this.finalizedTeardownCode
  }

  /**
   * Wait for a teardown finalization already under way, report what it
   * recorded, and close this attempt if it recorded nothing.
   *
   * `undefined` means there is no recorded teardown decision — either none
   * ran, or its append failed and therefore wrote nothing. The caller keeps
   * its own fallback in that case rather than claiming a decision the journal
   * does not carry, and that fallback is then this attempt's answer: asking
   * is also the moment the attempt closes to a later teardown, because the
   * dispatch stays registered until its terminal returns and a decision
   * appended after this would be a second, different answer.
   *
   * The join lives here so the dispatcher never has to reach for the
   * session's in-flight promise.
   */
  async awaitTeardownDecision(): Promise<string | undefined> {
    return this.settleAgainstTeardown()
  }

  /**
   * Drain any teardown under way — including a retry published from a failed
   * one's own rejection handler — and report what it recorded.
   *
   * When it recorded nothing, this attempt is marked settled in the same
   * synchronous step, so nothing can publish between the check and the close.
   */
  private async settleAgainstTeardown(): Promise<string | undefined> {
    let teardown = this.teardownFinalization
    while (teardown) {
      await teardown.catch(() => undefined)
      const recorded = this.finalizedTeardownCode
      if (recorded !== undefined) return recorded
      const next = this.teardownFinalization
      if (next === teardown) break
      teardown = next
    }
    this.decisionSettled = true
    return undefined
  }

  /**
   * Append an explicit `indeterminate` for this attempt on teardown's behalf.
   *
   * Strict, unlike `recordIndeterminateBestEffort`: teardown closes the
   * journal after this, so a swallowed failure would leave nothing recorded
   * and nothing to notice.
   *
   * Concurrent callers share the attempt already in flight, and a decision
   * that was successfully recorded is immutable — a later call returns it
   * rather than appending again or changing its code. Event-identity dedup in
   * the journal is not enough on its own for that: it holds only for an
   * identical append, so a second call carrying a *different* code would
   * raise an identity conflict rather than being ignored.
   *
   * A rejected attempt is not remembered. It is cleared so a later release
   * can retry, because the fault may be transient — the same
   * recoverable-versus-integrity distinction AC6 drew for the journal — and
   * teardown closes the journal after this, so an attempt that could never be
   * finalized would leave a stream that stops with no decision in it.
   */
  finalizeForTeardown(code: string): Promise<void> {
    if (this.teardownFinalization) return this.teardownFinalization
    // The stored promise is the *handled* one: its rejection handler clears
    // the field and rethrows, so the field is already empty by the time any
    // caller sees the failure. No retry can therefore be under way while the
    // old attempt is still stored, which is why no identity check is needed
    // here — and nothing is left floating.
    const handled = this.appendTeardownDecision(code).catch(
      (error: unknown) => {
        this.teardownFinalization = undefined
        throw error
      },
    )
    this.teardownFinalization = handled
    return handled
  }

  private async appendTeardownDecision(code: string): Promise<void> {
    // Already finished by any route — a terminal, or an earlier teardown.
    // Teardown snapshots the live attempts before it aborts, so by the time a
    // finalizer's turn arrives its attempt may have settled cooperatively;
    // appending over a stream that reached a terminal would contradict it.
    const phaseOnEntry: DurableDispatchPhase = this.phase
    if (phaseOnEntry === 'terminal') return
    // Finished by the other route: the dispatch settled on a result no append
    // backs, and has been told so. Recording a decision now would be a second
    // answer to a question already answered.
    if (this.decisionSettled) return
    // Join a decision already under way rather than racing it. Writing an
    // indeterminate into the gap between `committed` and `accepted` would
    // contradict an acceptance that is about to land, and would tell an
    // operator to reconcile a dispatch that finished.
    if (this.decisionInFlight) {
      await this.decisionInFlight.catch(() => undefined)
      // The other side won. Nothing to record, and nothing to correct.
      if (this.phase === 'terminal') return
      // Otherwise it failed or stopped short of a durable terminal, and the
      // attempt is still unfinished — so the truthful indeterminate below
      // still applies. The swallowed rejection is deliberately *not* turned
      // into a claim that this attempt reached a terminal state.
    }
    await this.port.recordIndeterminate({
      dispatchId: this.dispatchId,
      attemptId: this.attemptId,
      code,
      // Deliberately no signal. Teardown reaches its deadline by aborting
      // this dispatch, so an append that inherited the dispatch's signal
      // would reject every time — the journal checks abort on each queued
      // append. A bound for this append belongs to teardown, not to the
      // dispatch it is giving up on.
      identity: this.identity,
    })
    // Only after the append succeeded: a failed finalization leaves the
    // attempt live rather than claiming a decision that was never recorded.
    this.finalizedTeardownCode = code
    this.phase = 'terminal'
  }

  /** @returns whether the append actually landed. */
  private async recordIndeterminateBestEffort(
    code: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    try {
      await this.port.recordIndeterminate({
        dispatchId: this.dispatchId,
        attemptId: this.attemptId,
        code,
        identity: this.identity,
        ...(signal === undefined ? {} : { signal }),
      })
      this.phase = 'terminal'
      return true
    } catch {
      // Recovery still sees started-without-terminal, which reduces to
      // indeterminate; a failed append here must not mask the primary result.
      return false
    }
  }

  /** @returns whether the append actually landed. */
  private async recordTerminalBestEffort(
    result: CapabilityDispatchResult,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    try {
      await this.recordTerminal(result, signal)
      return true
    } catch {
      // No external effect can have occurred before the started barrier; a
      // missing pre-effect terminal record stays safely retriable on replay.
      return false
    }
  }
}

interface SettlementDeadline {
  readonly signal: AbortSignal
  run<T>(operation: () => T | Promise<T>): Promise<T>
  release(): void
}

type ScheduledExecution =
  | {
      readonly kind: 'blocked'
      readonly result: CapabilityDispatchResult
    }
  | {
      readonly kind: 'executed'
      readonly value: unknown
    }

class ApprovalEvidenceWriteError extends Error {
  constructor() {
    super('Capability approval evidence could not be written.')
    this.name = 'ApprovalEvidenceWriteError'
  }
}

class ApprovalInteractionError extends Error {
  constructor() {
    super('Capability approval interaction binding was invalid.')
    this.name = 'ApprovalInteractionError'
  }
}

class SettlementDeadlineError extends Error {
  constructor() {
    super('Capability settlement deadline was exceeded.')
    this.name = 'SettlementDeadlineError'
  }
}

const DEFAULT_SETTLEMENT_WINDOW_MS = 30_000
/** Budget for resolving an assignment's durable authority, lock wait included. */
const DEFAULT_DURABLE_RESOLVE_BUDGET_MS = 5_000

export class CapabilityDispatchRejection extends Error {
  constructor(
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super('Capability invocation was rejected during preparation.')
    this.name = 'CapabilityDispatchRejection'
  }
}

export class CapabilityDispatcher {
  constructor(private readonly configuredPorts: CapabilityDispatcherPorts) {}

  async dispatch(request: CapabilityDispatchRequest): Promise<CapabilityDispatchResult> {
    const ports = resolvePorts(this.configuredPorts)
    const validEnvelope = validateDispatchEnvelope(request)
    const provisionalIdentity = validEnvelope
      ? deriveDispatchIdentity(request.context, request.invocation)
      : undefined
    if (!ports) {
      return failedResult(provisionalIdentity?.dispatchId ?? 'invalid-dispatch', 'dispatch_configuration_invalid')
    }
    if (!validEnvelope || !provisionalIdentity) {
      return failedResult('invalid-dispatch', 'dispatch_request_invalid')
    }
    if (request.adapter.capabilityId !== request.invocation.capabilityId) {
      return rejectedResult(provisionalIdentity.dispatchId, 'capability_adapter_mismatch')
    }

    const executionSignal = createExecutionSignal(
      request.signal,
      request.deadlineMs,
      ports.clock.now,
    )
    try {
      const initialAuthority = await authorizeScope(
        ports,
        request.context,
        provisionalIdentity.invocation,
        'initial',
        request.initialAuthorityEvidence,
      )
      if (initialAuthority.kind !== 'allow') {
        return decisionResult(provisionalIdentity.dispatchId, initialAuthority)
      }
      if (executionSignal.signal.aborted) {
        return cancellationResult(provisionalIdentity.dispatchId, executionSignal.signal)
      }

      let json: CanonicalJsonDocument
      try {
        json = normalizeCanonicalJsonObject(request.invocation.input)
      } catch (error) {
        if (error instanceof CanonicalJsonError) {
          return rejectedResult(provisionalIdentity.dispatchId, 'invalid_arguments')
        }
        return failedResult(provisionalIdentity.dispatchId, 'argument_validation_failed')
      }

      let durable: CapabilityDurableDispatchPort | undefined
      try {
        durable = await resolveDurablePort(
          ports,
          request.context,
          executionSignal.signal,
        )
      } catch {
        return executionSignal.signal.aborted
          ? cancellationResult(
              provisionalIdentity.dispatchId,
              executionSignal.signal,
            )
          : failedResult(
              provisionalIdentity.dispatchId,
              'durable_journal_unavailable',
            )
      }

      let durableIdentity: DurableIdentityResolution
      try {
        durableIdentity = await resolveDurableInvocationIdentity({
          durable,
          context: request.context,
          invocation: provisionalIdentity.invocation,
          argumentDigest: json.hash.value,
          signal: executionSignal.signal,
        })
      } catch {
        return executionSignal.signal.aborted
          ? cancellationResult(
              provisionalIdentity.dispatchId,
              executionSignal.signal,
            )
          : failedResult(
              provisionalIdentity.dispatchId,
              'durable_journal_unavailable',
            )
      }
      const identity = deriveDispatchIdentity(
        request.context,
        durableIdentity.invocation,
      )
      if (durableIdentity.kind === 'conflict') {
        return rejectedResult(identity.dispatchId, 'invocation_identity_conflict')
      }
      if (
        identity.invocation.toolCallId !==
        provisionalIdentity.invocation.toolCallId
      ) {
        const restoredAuthority = await authorizeScope(
          ports,
          request.context,
          identity.invocation,
          'initial',
          request.initialAuthorityEvidence,
        )
        if (restoredAuthority.kind !== 'allow') {
          return decisionResult(identity.dispatchId, restoredAuthority)
        }
      }

      const binding = ports.bindings.acquire({
        scopeKey: identity.scopeKey,
        dispatchId: identity.dispatchId,
        argumentDigest: json.hash.value,
      })
      switch (binding.kind) {
        case 'conflict':
          return rejectedResult(identity.dispatchId, binding.code)
        case 'capacity-exceeded':
          return rejectedResult(identity.dispatchId, binding.code)
        case 'retained': {
          const currentAuthority = await authorizeScope(
            ports,
            request.context,
            identity.invocation,
            'after-result',
          )
          return currentAuthority.kind === 'allow'
            ? binding.result
            : decisionResult(identity.dispatchId, currentAuthority)
        }
        case 'follower':
          return awaitFollower(
            binding.wait(executionSignal.signal),
            ports,
            request.context,
            identity,
            executionSignal.signal,
          )
        case 'leader': {
          const replayAdmission = await admitDurableReplay(
            durable,
            ports,
            request.context,
            identity,
            json.hash.value,
          )
          if (replayAdmission) {
            binding.complete(replayAdmission)
            return replayAdmission
          }
          let result: CapabilityDispatchResult
          try {
            result = await this.executeLeader({
              request,
              identity,
              json,
              ports,
              attemptId: ports.ids.nextAttemptId(),
              signal: executionSignal.signal,
              durable,
            })
          } catch {
            result = failedResult(identity.dispatchId, 'dispatch_internal_error')
          }
          binding.complete(result)
          return result
        }
      }
    } finally {
      executionSignal.release()
    }
  }

  private async executeLeader(input: LeaderInput): Promise<CapabilityDispatchResult> {
    const { request, identity, json, ports, attemptId, signal } = input
    const durablePort = input.durable
    let prepared: CapabilityPreparedExecution | undefined
    let fence: CapabilityCompletionFence | undefined
    let reservation: CapabilityBudgetReservation | undefined
    let resultAfterExecution: CapabilityDispatchResult | undefined
    let approvalSatisfied = false
    let executionBegan = false
    let unregisterTeardown: (() => void) | undefined
    let settlementAttempted = false
    let settlement: SettlementDeadline | undefined

    const getSettlement = (): SettlementDeadline => {
      if (settlement) return settlement
      const startedAt = ports.clock.now()
      const deadlineMs = request.settlementDeadlineMs ??
        startedAt + DEFAULT_SETTLEMENT_WINDOW_MS
      settlement = createSettlementDeadline(deadlineMs, ports.clock.now)
      return settlement
    }

    const settleUnknownBudget = async (): Promise<void> => {
      if (!reservation || settlementAttempted) return
      const activeReservation = reservation
      settlementAttempted = true
      try {
        await getSettlement().run(() =>
          settleBudgetSafely(ports, activeReservation, undefined),
        )
      } catch {
        // The settlement attempt was started. Its port may still observe the
        // independent abort signal or complete after the bounded wait.
      }
    }

    try {
      try {
        prepared = await request.adapter.prepare({
          context: request.context,
          invocation: identity.invocation,
          arguments: json.value,
          canonicalArguments: json.canonical,
          argumentDigest: json.hash.value,
          signal,
        })
      } catch (error) {
        if (error instanceof CapabilityDispatchRejection) {
          return rejectedResult(identity.dispatchId, error.code, error.detail)
        }
        return failedResult(identity.dispatchId, 'capability_prepare_failed')
      }
      const preparedFacts = readPreparedFacts(prepared)
      if (!preparedFacts) {
        return failedResult(identity.dispatchId, 'capability_prepare_invalid')
      }
      const eventBase = makeEventBase({
        request,
        identity,
        attemptId,
        argumentDigest: json.hash.value,
        argumentNames: preparedFacts.argumentNames,
        effect: preparedFacts.effect,
      })
      const durable = durablePort
        ? new DurableDispatchSession(
            durablePort,
            identity.dispatchId,
            attemptId,
            eventBase,
          )
        : undefined

      try {
        await appendEvent(
          ports,
          eventBase,
          'capability.dispatch.requested',
          {},
          durable?.derivesEvidence === true,
        )
      } catch {
        return this.projectTerminalSafely({
          prepared,
          result: failedResult(
            identity.dispatchId,
            'requested_evidence_write_failed',
          ),
          afterEffect: false,
        })
      }
      try {
        if (durable) await durable.recordRequested(signal)
      } catch {
        // Kept apart from the evidence write above. Both used to answer
        // `requested_evidence_write_failed`, which left a caller unable to
        // tell a durability authority it should retry from evidence logging
        // it should not — and the journal is the one that fails closed on
        // purpose (ADR §7, A-2).
        return this.projectTerminalSafely({
          prepared,
          result: failedResult(
            identity.dispatchId,
            'durable_journal_unavailable',
          ),
          afterEffect: false,
        })
      }

      const adapterInitial = await authorizePrepared(prepared, 'initial')
      let sharedPolicy: CapabilityPolicyDecision
      try {
        sharedPolicy = await ports.policy.evaluate({
          context: request.context,
          invocation: identity.invocation,
          effect: preparedFacts.effect,
          risk: preparedFacts.risk,
        })
      } catch {
        sharedPolicy = {
          kind: 'deny',
          code: 'policy_unavailable',
          reason: 'Capability policy could not be evaluated.',
        }
      }
      const policy = resolveCapabilityPolicy([
        adapterInitial,
        prepared.policyDecision,
        sharedPolicy,
      ])
      if (policy.kind === 'deny') {
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: decisionResult(identity.dispatchId, policy),
          afterEffect: false,
        })
      }

      let preflight: CapabilityBudgetPreflight
      try {
        preflight = await ports.budget.preflight({
          context: request.context,
          invocation: identity.invocation,
          effect: preparedFacts.effect,
          risk: preparedFacts.risk,
        })
      } catch {
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: failedResult(identity.dispatchId, 'budget_preflight_failed'),
          afterEffect: false,
        })
      }
      if (preflight.kind === 'rejected') {
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: rejectedResult(identity.dispatchId, preflight.code),
          afterEffect: false,
        })
      }

      if (policy.kind === 'require-approval') {
        try {
          await prepared.projectLifecycle?.({ kind: 'awaiting-approval' })
        } catch {
          return await this.finishTerminal({
            ports,
            eventBase,
            prepared,
            result: failedResult(
              identity.dispatchId,
              'capability_lifecycle_projection_failed',
            ),
            afterEffect: false,
          })
        }
        const approvalResult = await this.resolveApproval({
          request,
          identity,
          json,
          ports,
          eventBase,
          prepared,
          preparedFacts,
          signal,
          durable,
        })
        if (approvalResult) return approvalResult
        approvalSatisfied = true
      }

      if (signal.aborted) {
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: cancellationResult(identity.dispatchId, signal),
          afterEffect: false,
        })
      }

      if (durable) {
        try {
          await durable.recordPrepared({
            argumentDigest: json.hash.value,
            capabilityId: identity.invocation.capabilityId,
            effect: preparedFacts.effect,
            recoveryPolicy: prepared.recoveryPolicy ?? 'unknown',
            signal,
          })
        } catch {
          return await this.finishTerminal({
            ports,
            eventBase,
            prepared,
            result: failedResult(identity.dispatchId, 'prepared_evidence_write_failed'),
            afterEffect: false,
          })
        }
      }

      let rawResult: unknown
      const executable = prepared
      try {
        const scheduled = await ports.scheduler.run<ScheduledExecution>({
          scopeKey: identity.scopeKey,
          effect: preparedFacts.effect,
          signal,
          operation: async () => {
            const adapterBeforeExecute = await authorizePrepared(
              executable,
              'before-execute',
              signal,
            )
            const cancelledAfterAdapterAuthority = scheduledCancellation(
              identity.dispatchId,
              signal,
            )
            if (cancelledAfterAdapterAuthority) {
              return cancelledAfterAdapterAuthority
            }
            const scopeBeforeExecute = await authorizeScope(
              ports,
              request.context,
              identity.invocation,
              'before-execute',
            )
            const cancelledAfterScopeAuthority = scheduledCancellation(
              identity.dispatchId,
              signal,
            )
            if (cancelledAfterScopeAuthority) {
              return cancelledAfterScopeAuthority
            }
            let sharedBeforeExecute: CapabilityPolicyDecision
            try {
              sharedBeforeExecute = await ports.policy.evaluate({
                context: request.context,
                invocation: identity.invocation,
                effect: preparedFacts.effect,
                risk: preparedFacts.risk,
              })
            } catch {
              sharedBeforeExecute = {
                kind: 'deny',
                code: 'policy_unavailable',
                reason: 'Capability policy could not be reevaluated.',
              }
            }
            const cancelledAfterPolicy = scheduledCancellation(
              identity.dispatchId,
              signal,
            )
            if (cancelledAfterPolicy) return cancelledAfterPolicy
            const unresolvedBeforeExecute = resolveCapabilityPolicy([
              adapterBeforeExecute,
              scopeBeforeExecute,
              sharedBeforeExecute,
            ])
            const beforeExecute =
              unresolvedBeforeExecute.kind === 'require-approval' &&
              approvalSatisfied
                ? { kind: 'allow' as const }
                : unresolvedBeforeExecute
            if (beforeExecute.kind !== 'allow') {
              return {
                kind: 'blocked',
                result: decisionResult(identity.dispatchId, beforeExecute),
              }
            }
            if (preflight.kind === 'metered') {
              try {
                reservation = await ports.budget.reserve({
                  context: request.context,
                  invocation: identity.invocation,
                  preflight,
                  signal,
                })
              } catch {
                const cancelledDuringReservation = scheduledCancellation(
                  identity.dispatchId,
                  signal,
                )
                if (cancelledDuringReservation) {
                  return cancelledDuringReservation
                }
                return {
                  kind: 'blocked',
                  result: failedResult(
                    identity.dispatchId,
                    'budget_reservation_failed',
                  ),
                }
              }
              const cancelledAfterReservation = scheduledCancellation(
                identity.dispatchId,
                signal,
              )
              if (cancelledAfterReservation) {
                return cancelledAfterReservation
              }
            }
            try {
              await executable.projectLifecycle?.({ kind: 'running' })
            } catch {
              return {
                kind: 'blocked',
                result: failedResult(
                  identity.dispatchId,
                  'capability_lifecycle_projection_failed',
                ),
              }
            }
            const cancelledAfterLifecycle = scheduledCancellation(
              identity.dispatchId,
              signal,
            )
            if (cancelledAfterLifecycle) return cancelledAfterLifecycle
            try {
              await appendEvent(
                ports,
                eventBase,
                'capability.dispatch.started',
                {},
                durable?.derivesEvidence === true,
              )
              if (durable) {
                await durable.recordStarted(signal)
                // Offered to teardown only now: before the started barrier is
                // durable there is no attempt on the journal to finalize, and
                // finalizing one the journal never saw start would invent a
                // record rather than complete one (AC18).
                unregisterTeardown = registerForTeardown(
                  ports,
                  request.context,
                  durable,
                )
              }
            } catch {
              return {
                kind: 'blocked',
                result: failedResult(
                  identity.dispatchId,
                  'started_evidence_write_failed',
                ),
              }
            }
            const cancelledAfterStartedEvidence = scheduledCancellation(
              identity.dispatchId,
              signal,
            )
            if (cancelledAfterStartedEvidence) {
              return cancelledAfterStartedEvidence
            }
            let sharedAtExecution: CapabilityPolicyDecision
            try {
              sharedAtExecution = await ports.policy.evaluate({
                context: request.context,
                invocation: identity.invocation,
                effect: preparedFacts.effect,
                risk: preparedFacts.risk,
              })
            } catch {
              sharedAtExecution = {
                kind: 'deny',
                code: 'policy_unavailable',
                reason: 'Capability policy could not be finally reevaluated.',
              }
            }
            const cancelledAfterFinalPolicy = scheduledCancellation(
              identity.dispatchId,
              signal,
            )
            if (cancelledAfterFinalPolicy) return cancelledAfterFinalPolicy
            const scopeAtExecution = await authorizeScope(
              ports,
              request.context,
              identity.invocation,
              'before-execute',
            )
            const cancelledAfterFinalAuthority = scheduledCancellation(
              identity.dispatchId,
              signal,
            )
            if (cancelledAfterFinalAuthority) {
              return cancelledAfterFinalAuthority
            }
            const unresolvedAtExecution = resolveCapabilityPolicy([
              sharedAtExecution,
              scopeAtExecution,
            ])
            const atExecution =
              unresolvedAtExecution.kind === 'require-approval' &&
                approvalSatisfied
                ? { kind: 'allow' as const }
                : unresolvedAtExecution
            if (atExecution.kind !== 'allow') {
              return {
                kind: 'blocked',
                result: decisionResult(identity.dispatchId, atExecution),
              }
            }
            executionBegan = true
            return {
              kind: 'executed',
              value: await executable.execute({ signal }),
            }
          },
        })
        if (scheduled.kind === 'blocked') {
          // Reachable after the `started` barrier: the post-start cancellation
          // checks and the re-run authority/policy decision all block here
          // without entering the executor. The durable session must still be
          // passed, or the stream would end at `started` and recovery would
          // read a dispatch that never ran as indeterminate (ADR §6).
          return await this.finishTerminal({
            ports,
            eventBase,
            prepared,
            durable,
            result: scheduled.result,
            afterEffect: false,
          })
        }
        rawResult = scheduled.value
        // Teardown may have given up on this attempt while the executor was
        // still running, and if so the journal already carries its decision.
        // Settling on anything else — or appending `committed`/`accepted`
        // over a finalized stream — would contradict a record an operator is
        // meant to act on (AC18).
        //
        // It goes through the ordinary terminal path rather than returning
        // early, so lifecycle projection and the non-derived evidence view
        // still happen. No second durable terminal is appended: the session
        // is already `terminal`, which `recordDurableTerminal` returns on.
        const teardownCode = durable?.teardownDecision
        if (teardownCode !== undefined) {
          await settleUnknownBudget()
          return await this.finishTerminal({
            ports,
            eventBase,
            prepared,
            result: indeterminateResult(identity.dispatchId, teardownCode),
            afterEffect: true,
            settlement: getSettlement(),
            durable,
          })
        }
      } catch {
        if (executionBegan) await settleUnknownBudget()
        const failed = executionFailureResult(
          identity.dispatchId,
          preparedFacts.effect,
          executionBegan,
          signal,
        )
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: failed,
          afterEffect: executionBegan,
          ...(executionBegan ? { settlement: getSettlement() } : {}),
          durable,
        })
      }

      try {
        const activeSettlement = getSettlement()
        fence = executable.beginCompletion
          ? await activeSettlement.run(() =>
              executable.beginCompletion?.({
                signal: activeSettlement.signal,
              }),
            )
          : undefined
      } catch (error) {
        await settleUnknownBudget()
        resultAfterExecution = indeterminateResult(
          identity.dispatchId,
          error instanceof SettlementDeadlineError
            ? 'settlement_deadline_exceeded'
            : 'completion_fence_failed',
        )
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: resultAfterExecution,
          afterEffect: true,
          settlement: getSettlement(),
          durable,
        })
      }

      let scopeAfterResult: CapabilityPolicyDecision
      let adapterAfterResult: CapabilityPolicyDecision
      try {
        const activeSettlement = getSettlement()
        scopeAfterResult = await activeSettlement.run(() =>
          authorizeScope(
            ports,
            request.context,
            identity.invocation,
            'after-result',
          ),
        )
        adapterAfterResult = await activeSettlement.run(() =>
          authorizePrepared(
            executable,
            'after-result',
            activeSettlement.signal,
          ),
        )
      } catch (error) {
        await settleUnknownBudget()
        resultAfterExecution = indeterminateResult(
          identity.dispatchId,
          error instanceof SettlementDeadlineError
            ? 'settlement_deadline_exceeded'
            : 'post_result_authorization_failed',
        )
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: resultAfterExecution,
          afterEffect: true,
          settlement: getSettlement(),
          durable,
        })
      }
      const afterResult = resolveCapabilityPolicy([
        scopeAfterResult,
        adapterAfterResult,
      ])
      if (afterResult.kind !== 'allow') {
        await settleUnknownBudget()
        resultAfterExecution = decisionResult(identity.dispatchId, afterResult)
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: resultAfterExecution,
          afterEffect: true,
          settlement: getSettlement(),
          durable,
        })
      }

      let acceptedValue: unknown
      try {
        const activeSettlement = getSettlement()
        acceptedValue = await activeSettlement.run(() =>
          executable.acceptResult({
            value: rawResult,
            signal: activeSettlement.signal,
          }),
        )
      } catch (error) {
        await settleUnknownBudget()
        resultAfterExecution = indeterminateResult(
          identity.dispatchId,
          error instanceof SettlementDeadlineError
            ? 'settlement_deadline_exceeded'
            : 'result_acceptance_failed',
        )
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: resultAfterExecution,
          afterEffect: true,
          settlement: getSettlement(),
          durable,
        })
      }
      const accepted = readAcceptedResult(acceptedValue)
      if (!accepted) {
        await settleUnknownBudget()
        resultAfterExecution = indeterminateResult(
          identity.dispatchId,
          'result_acceptance_invalid',
        )
        return await this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: resultAfterExecution,
          afterEffect: true,
          settlement: getSettlement(),
          durable,
        })
      }

      let budgetSettlement: CapabilityBudgetSettlement
      if (reservation) {
        const activeReservation = reservation
        settlementAttempted = true
        try {
          budgetSettlement = await getSettlement().run(() =>
            settleBudgetSafely(
              ports,
              activeReservation,
              accepted.actualCostUsd,
            ),
          )
        } catch {
          budgetSettlement = notMeteredSettlement()
        }
      } else {
        budgetSettlement = notMeteredSettlement()
      }
      if (reservation) {
        const activeReservation = reservation
        try {
          await getSettlement().run(() =>
            ports.budget.release(activeReservation),
          )
          reservation = undefined
        } catch {
          resultAfterExecution = indeterminateResult(
            identity.dispatchId,
            'budget_release_failed',
          )
          return await this.finishTerminal({
            ports,
            eventBase,
            prepared,
            result: resultAfterExecution,
            afterEffect: true,
            settlement: getSettlement(),
            durable,
          })
        }
      }

      const actualCostUsd = resolvedActualCost(
        budgetSettlement,
        accepted.actualCostUsd,
      )
      resultAfterExecution = {
        status: 'completed',
        dispatchId: identity.dispatchId,
        value: accepted.value,
        costTracked: budgetSettlement.costTracked,
        budgetOverrun: budgetSettlement.budgetOverrun,
        ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
      }
      const completedResult = resultAfterExecution
      if (durable && durable.phase === 'started') {
        try {
          const completion = await getSettlement().run(() =>
            durable.recordCompletion(completedResult, getSettlement().signal),
          )
          if (completion.kind === 'superseded') {
            // Teardown decided this attempt while the completion was on its
            // way. The journal carries that decision, so the caller is told
            // the same thing rather than a success the stream contradicts.
            await settleUnknownBudget()
            return await this.finishTerminal({
              ports,
              eventBase,
              prepared,
              result: indeterminateResult(
                identity.dispatchId,
                completion.code,
              ),
              afterEffect: true,
              settlement: getSettlement(),
              durable,
            })
          }
        } catch {
          // The effect occurred but its acceptance is not durable. Do not
          // attempt a second terminal append; recovery treats the started
          // stream without a terminal record as indeterminate (ADR §6).
          //
          // Teardown may already have finalized this attempt while the
          // acceptance was in flight, in which case the journal carries its
          // decision and the caller must be told the same thing. Reporting
          // `durable_acceptance_write_failed` instead would be a second,
          // different answer to one question (AC18).
          const teardownCode = await durable.awaitTeardownDecision()
          resultAfterExecution = indeterminateResult(
            identity.dispatchId,
            teardownCode ?? 'durable_acceptance_write_failed',
          )
          return await this.finishTerminal({
            ports,
            eventBase,
            prepared,
            result: resultAfterExecution,
            afterEffect: true,
            settlement: getSettlement(),
            durable,
          })
        }
      }
      return await this.finishTerminal({
        ports,
        eventBase,
        prepared,
        result: completedResult,
        afterEffect: true,
        settlement: getSettlement(),
        durable,
      })
    } finally {
      // This attempt is no longer live, whichever way it left.
      unregisterTeardown?.()
      if (reservation) {
        const activeReservation = reservation
        if (executionBegan && !settlementAttempted) {
          settlementAttempted = true
          try {
            await getSettlement().run(() =>
              settleBudgetSafely(ports, activeReservation, undefined),
            )
          } catch {
            // The bounded settlement attempt was started; terminal state must
            // not be rewritten from cleanup.
          }
        }
        try {
          await getSettlement().run(() =>
            ports.budget.release(activeReservation),
          )
        } catch {
          // The primary result owns the terminal decision. A second terminal
          // event here would make evidence ambiguous.
        }
      }
      if (fence) {
        try {
          await getSettlement().run(() => fence?.release())
        } catch {
          // Completion has already crossed its terminal decision boundary.
        }
      }
      if (prepared?.release) {
        try {
          if (executionBegan) {
            await getSettlement().run(() => prepared?.release?.())
          } else {
            await prepared.release()
          }
        } catch {
          // Adapter cleanup cannot rewrite an already-recorded terminal result.
        }
      }
      settlement?.release()
    }
  }

  private async resolveApproval(input: {
    readonly request: CapabilityDispatchRequest
    readonly identity: DispatchIdentity
    readonly json: CanonicalJsonDocument
    readonly ports: ResolvedDispatcherPorts
    readonly eventBase: Omit<CapabilityDispatchEvent, 'type' | 'timestamp'>
    readonly prepared: CapabilityPreparedExecution
    readonly preparedFacts: Readonly<{
      effect: CapabilityEffect
      risk: string
      argumentNames: readonly string[]
    }>
    readonly signal: AbortSignal
    readonly durable: DurableDispatchSession | undefined
  }): Promise<CapabilityDispatchResult | undefined> {
    const {
      request,
      identity,
      json,
      ports,
      eventBase,
      prepared,
      preparedFacts,
      signal,
      durable,
    } = input
    if (!prepared.approval || !ports.approval) {
      return await this.finishTerminal({
        ports,
        eventBase,
        prepared,
        result: rejectedResult(identity.dispatchId, 'approval_unavailable'),
        afterEffect: false,
      })
    }
    let decision: unknown
    let auditedInteractionId: string | undefined
    let interactionAuditCount = 0
    try {
      decision = await ports.approval.request({
        context: request.context,
        invocation: identity.invocation,
        arguments: json.value,
        dispatchId: identity.dispatchId,
        argumentDigest: json.hash.value,
        canonicalArguments: json.canonical,
        effect: preparedFacts.effect,
        risk: preparedFacts.risk,
        description: prepared.approval,
        signal,
        onInteraction: async (interaction) => {
          if (
            !isApprovalInteraction(interaction) ||
            interactionAuditCount !== 0
          ) {
            interactionAuditCount += 1
            throw new ApprovalInteractionError()
          }
          interactionAuditCount += 1
          try {
            if (durable) {
              await durable.recordApprovalRequested(
                interaction.interactionId,
                signal,
              )
            }
            await appendEvent(
              ports,
              eventBase,
              'capability.dispatch.approval_requested',
              { interactionId: interaction.interactionId },
              durable?.derivesEvidence === true,
            )
            auditedInteractionId = interaction.interactionId
          } catch {
            throw new ApprovalEvidenceWriteError()
          }
        },
      })
    } catch (error) {
      const result =
        error instanceof ApprovalEvidenceWriteError
          ? failedResult(identity.dispatchId, 'approval_evidence_write_failed')
          : error instanceof ApprovalInteractionError
            ? failedResult(identity.dispatchId, 'approval_interaction_invalid')
            : signal.aborted
              ? cancellationResult(identity.dispatchId, signal)
              : failedResult(identity.dispatchId, 'approval_failed')
      return await this.finishTerminal({
        ports,
        eventBase,
        prepared,
        result,
        afterEffect: false,
      })
    }
    if (
      !isApprovalDecision(decision) ||
      interactionAuditCount !== 1 ||
      auditedInteractionId !== decision.interaction.interactionId
    ) {
      return await this.finishTerminal({
        ports,
        eventBase,
        prepared,
        result: failedResult(identity.dispatchId, 'approval_interaction_invalid'),
        afterEffect: false,
      })
    }
    try {
      if (durable) {
        await durable.recordApprovalResolved(
          decision.interaction.interactionId,
          decision.outcome,
          signal,
        )
      }
      await appendEvent(
        ports,
        eventBase,
        'capability.dispatch.approval_resolved',
        {
          interactionId: decision.interaction.interactionId,
          approvalOutcome: decision.outcome,
        },
        durable?.derivesEvidence === true,
      )
    } catch {
      return await this.finishTerminal({
        ports,
        eventBase,
        prepared,
        result: failedResult(identity.dispatchId, 'approval_evidence_write_failed'),
        afterEffect: false,
      })
    }
    const approvalResult = approvalOutcomeResult(
      identity.dispatchId,
      decision.outcome,
    )
    return approvalResult
      ? this.finishTerminal({
          ports,
          eventBase,
          prepared,
          result: approvalResult,
          afterEffect: false,
        })
      : undefined
  }

  /**
   * Record this attempt's terminal, and report a teardown decision that got
   * there first.
   *
   * Returns the code teardown recorded when it superseded this terminal, so
   * the caller answers with what the journal says rather than what its
   * adapter did — one attempt, one decision (AC18, ADR §7).
   */
  private async recordDurableTerminal(
    input: TerminalInput,
  ): Promise<string | undefined> {
    const durable = input.durable
    if (!durable || durable.phase === 'terminal' || durable.phase === 'none') {
      return undefined
    }
    const settlementSignal = input.settlement?.signal
    if (input.afterEffect) {
      if (input.result.status === 'completed') return undefined
      // A durable commit record already proves the effect; appending a second
      // terminal event would substitute for the unknown acceptance append
      // (ADR §6). Recovery reconciles from the committed record instead.
      if (durable.committedRecorded) return undefined
      const outcome = await durable.recordDecision(
        {
          kind: 'indeterminate',
          code: terminalResultCode(input.result),
        },
        settlementSignal,
      )
      return outcome.kind === 'superseded' ? outcome.code : undefined
    }
    const outcome = await durable.recordDecision(
      { kind: 'terminal', result: input.result },
      settlementSignal,
    )
    return outcome.kind === 'superseded' ? outcome.code : undefined
  }

  private async finishTerminal(
    terminal: TerminalInput,
  ): Promise<CapabilityDispatchResult> {
    const supersededBy = await this.recordDurableTerminal(terminal)
    // Teardown decided this attempt first. Everything downstream — the
    // terminal event, the projection, the returned result — reports that one
    // decision, so the caller is never told something the journal contradicts.
    const input: TerminalInput = supersededBy === undefined
      ? terminal
      : {
        ...terminal,
        result: indeterminateResult(terminal.result.dispatchId, supersededBy),
      }
    try {
      await runSettlementOperation(
        input.settlement,
        () => appendEvent(
          input.ports,
          input.eventBase,
          terminalEventType(input.result),
          terminalEventFields(input.result),
          input.durable?.derivesEvidence === true,
        ),
      )
    } catch (error) {
      if (
        error instanceof SettlementDeadlineError &&
        input.result.status === 'indeterminate' &&
        input.result.code === 'settlement_deadline_exceeded'
      ) {
        return input.result
      }
      // A teardown decision outranks a failed projection write. The journal is
      // the authority (ADR §9) and already carries this attempt's decision, so
      // reporting `terminal_evidence_write_failed` here would be a second,
      // different answer to one question — and the one the journal does not
      // carry.
      const evidenceFailure = supersededBy !== undefined
        ? indeterminateResult(input.result.dispatchId, supersededBy)
        : input.afterEffect
        ? indeterminateResult(
            input.result.dispatchId,
            'terminal_evidence_write_failed',
          )
        : failedResult(
            input.result.dispatchId,
            'terminal_evidence_write_failed',
          )
      return this.projectTerminalSafely({
        prepared: input.prepared,
        result: evidenceFailure,
        afterEffect: input.afterEffect,
        ...whenDefined(input.settlement, (settlement) => ({ settlement })),
      })
    }
    return this.projectRecordedTerminalSafely(
      input.prepared,
      input.result,
      input.settlement,
    )
  }

  private async projectRecordedTerminalSafely(
    prepared: CapabilityPreparedExecution,
    result: CapabilityDispatchResult,
    settlement?: SettlementDeadline,
  ): Promise<CapabilityDispatchResult> {
    if (!prepared.projectLifecycle) return result
    try {
      const projection = await runSettlementOperation(
        settlement,
        () => prepared.projectLifecycle?.({
          kind: 'terminal',
          result,
        }),
      )
      return withProjectedDetail(result, projection?.detail)
    } catch {
      return result
    }
  }

  private async projectTerminalSafely(input: {
    readonly prepared: CapabilityPreparedExecution
    readonly result: CapabilityDispatchResult
    readonly afterEffect: boolean
    readonly settlement?: SettlementDeadline
  }): Promise<CapabilityDispatchResult> {
    if (!input.prepared.projectLifecycle) return input.result
    try {
      const projection = await runSettlementOperation(
        input.settlement,
        () => input.prepared.projectLifecycle?.({
          kind: 'terminal',
          result: input.result,
        }),
      )
      return withProjectedDetail(input.result, projection?.detail)
    } catch {
      return input.afterEffect
        ? indeterminateResult(
            input.result.dispatchId,
            'capability_lifecycle_projection_failed',
          )
        : failedResult(
            input.result.dispatchId,
            'capability_lifecycle_projection_failed',
          )
    }
  }
}

async function awaitFollower(
  resultPromise: Promise<CapabilityDispatchResult>,
  ports: ResolvedDispatcherPorts,
  context: CapabilityExecutionContext,
  identity: DispatchIdentity,
  signal: AbortSignal,
): Promise<CapabilityDispatchResult> {
  let result: CapabilityDispatchResult
  try {
    result = await resultPromise
  } catch {
    return cancellationResult(identity.dispatchId, signal)
  }
  const authority = await authorizeScope(
    ports,
    context,
    identity.invocation,
    'after-result',
  )
  return authority.kind === 'allow'
    ? result
    : decisionResult(identity.dispatchId, authority)
}

/**
 * Resolve the assignment's durable authority for this dispatch, bounded by an
 * explicit budget because opening a journal can wait for its per-scope lock.
 * `CapabilityDispatchRequest.settlementDeadlineMs` is optional, so the budget
 * is this dispatcher's own default rather than a forwarded request deadline.
 */
async function resolveDurablePort(
  ports: ResolvedDispatcherPorts,
  context: CapabilityExecutionContext,
  signal: AbortSignal,
): Promise<CapabilityDurableDispatchPort | undefined> {
  const resolve = ports.durable
  if (!resolve) return undefined
  return resolve({
    context,
    signal,
    deadlineMs: ports.clock.now() + DEFAULT_DURABLE_RESOLVE_BUDGET_MS,
  })
}

async function resolveDurableInvocationIdentity(input: {
  readonly durable: CapabilityDurableDispatchPort | undefined
  readonly context: CapabilityExecutionContext
  readonly invocation: CapabilityInvocationIdentity
  readonly argumentDigest: string
  readonly signal: AbortSignal
}): Promise<DurableIdentityResolution> {
  const operationId = deriveDurableInvocationOperationId(
    input.context,
    input.invocation,
  )
  if (!input.durable || !operationId) {
    return { kind: 'ready', invocation: input.invocation }
  }
  const binding = await input.durable.bindInvocationIdentity({
    operationId,
    invocation: input.invocation,
    argumentDigest: input.argumentDigest,
    signal: input.signal,
  })
  return binding.kind === 'bound'
    ? { kind: 'ready', invocation: binding.invocation }
    : { kind: 'conflict', invocation: binding.invocation }
}

/**
 * Provider call order is stable when a turn-scoped assignment is recovered;
 * provider tool-call IDs are not. The operation key deliberately excludes the
 * live request, lease, process identity, and tool-call id so a replacement
 * process addresses the first journal binding for the same logical call.
 */
function deriveDurableInvocationOperationId(
  context: CapabilityExecutionContext,
  invocation: CapabilityInvocationIdentity,
): string | undefined {
  const ordinal = context.providerCallOrdinal
  if (ordinal === undefined) return undefined
  const hash = createHash('sha256')
    .update('provider-turn-operation-v1')
    .update('\0')
    .update(context.sessionId)
    .update('\0')
    .update(context.runId)
    .update('\0')
    .update(context.assignmentId)
    .update('\0')
    .update(context.taskId ?? '')
    .update('\0')
    .update(context.agentPath)
    .update('\0')
    .update(context.agentId ?? '')
    .update('\0')
    .update(context.activityScopeId ?? '')
    .update('\0')
    .update(context.workflowId ?? '')
    .update('\0')
    .update(context.workflowStepId ?? '')
    .update('\0')
    .update(invocation.source.kind)
    .update('\0')
    .update(invocation.source.id)
    .update('\0')
    .update(invocation.source.version ?? '')
    .update('\0')
    .update(invocation.capabilityId)
    .update('\0')
    .update(String(ordinal))
    .digest('hex')
  return `invocation-${hash}`
}

async function admitDurableReplay(
  durable: CapabilityDurableDispatchPort | undefined,
  ports: ResolvedDispatcherPorts,
  context: CapabilityExecutionContext,
  identity: DispatchIdentity,
  argumentDigest: string,
): Promise<CapabilityDispatchResult | undefined> {
  if (!durable) return undefined
  let recovery: Awaited<ReturnType<CapabilityDurableDispatchPort['recover']>>
  try {
    recovery = await durable.recover({
      dispatchId: identity.dispatchId,
      argumentDigest,
    })
  } catch {
    return failedResult(identity.dispatchId, 'durable_recovery_failed')
  }
  switch (recovery.kind) {
    case 'unknown':
    case 'retriable':
      return undefined
    case 'retained': {
      const authority = await authorizeScope(
        ports,
        context,
        identity.invocation,
        'after-result',
      )
      return authority.kind === 'allow'
        ? recovery.result
        : decisionResult(identity.dispatchId, authority)
    }
    case 'terminal':
      return recovery.result
    case 'conflict':
      return rejectedResult(identity.dispatchId, 'invocation_identity_conflict')
    case 'reconcile':
      // A committed-but-unaccepted effect needs reconciliation, which is a
      // different operator action from an outcome that cannot be proven.
      return indeterminateResult(
        identity.dispatchId,
        'durable_replay_reconcile_required',
      )
    case 'blocked':
      return indeterminateResult(identity.dispatchId, 'durable_replay_blocked')
  }
}

async function authorizeScope(
  ports: ResolvedDispatcherPorts,
  context: CapabilityExecutionContext,
  invocation: CapabilityInvocationIdentity,
  phase: CapabilityAuthorizationPhase,
  evidence?: unknown,
): Promise<CapabilityPolicyDecision> {
  try {
    const decision = await ports.authority.authorize({
      context,
      invocation,
      phase,
      ...(evidence === undefined ? {} : { evidence }),
    })
    const resolved = resolveCapabilityPolicy([decision])
    return resolved.kind === 'require-approval'
      ? {
          kind: 'deny',
          code: 'authority_decision_invalid',
          reason: 'Scope authority cannot defer its decision to approval.',
        }
      : resolved
  } catch {
    return {
      kind: 'deny',
      code: 'authority_unavailable',
      reason: 'Capability scope authority could not be verified.',
    }
  }
}

async function authorizePrepared(
  prepared: CapabilityPreparedExecution,
  phase: CapabilityAuthorizationPhase,
  signal?: AbortSignal,
): Promise<CapabilityPolicyDecision> {
  try {
    return resolveCapabilityPolicy([
      await prepared.authorize({
        phase,
        ...(signal ? { signal } : {}),
      }),
    ])
  } catch {
    return {
      kind: 'deny',
      code: 'capability_authorization_failed',
      reason: 'Capability-specific authority could not be verified.',
    }
  }
}

function readPreparedFacts(
  prepared: CapabilityPreparedExecution,
): Readonly<{
  effect: CapabilityEffect
  risk: string
  argumentNames: readonly string[]
}> | null {
  if (!prepared || typeof prepared !== 'object') return null
  if (!isSafeText(prepared.risk) || !isArgumentNames(prepared.argumentNames)) {
    return null
  }
  return {
    effect: canonicalizeCapabilityEffect(prepared.effect),
    risk: prepared.risk,
    argumentNames: [...prepared.argumentNames],
  }
}

function deriveDispatchIdentity(
  context: CapabilityExecutionContext,
  invocation: CapabilityInvocationIdentity,
): DispatchIdentity {
  const identity: CapabilityInvocationIdentity = {
    capabilityId: invocation.capabilityId,
    source: { ...invocation.source },
    toolCallId: invocation.toolCallId,
  }
  const hash = createHash('sha256')
    .update(context.sessionId)
    .update('\0')
    .update(context.runId)
    .update('\0')
    .update(context.assignmentId)
    .update('\0')
    .update(context.taskId ?? '')
    .update('\0')
    .update(context.agentPath)
    .update('\0')
    .update(context.agentId ?? '')
    .update('\0')
    .update(context.activityScopeId ?? '')
    .update('\0')
    .update(context.workflowId ?? '')
    .update('\0')
    .update(context.workflowStepId ?? '')
    .update('\0')
    .update(invocation.source.kind)
    .update('\0')
    .update(invocation.source.id)
    .update('\0')
    .update(invocation.source.version ?? '')
    .update('\0')
    .update(invocation.capabilityId)
    .update('\0')
    .update(invocation.toolCallId)
    .digest('hex')
  return {
    dispatchId: `dispatch-${hash}`,
    scopeKey: scopeKey(context),
    invocation: identity,
  }
}

function scopeKey(context: CapabilityExecutionContext): string {
  return [
    context.sessionId,
    context.runId,
    context.assignmentId,
    context.taskId ?? '',
    authorityScopePart(context.authority),
  ].join('\0')
}

function authorityScopePart(authority: CapabilityScopeAuthority): string {
  switch (authority.kind) {
    case 'mcp-lease':
      return `mcp:${authority.leaseId}`
    case 'runtime-assignment':
      return `runtime:${authority.processIdentity}`
    case 'parent-capability':
      return `parent:${authority.endpointId}:${authority.processIdentity}`
  }
}

function makeEventBase(input: {
  readonly request: CapabilityDispatchRequest
  readonly identity: DispatchIdentity
  readonly attemptId: string
  readonly argumentDigest: string
  readonly argumentNames: readonly string[]
  readonly effect: CapabilityEffect
}): Omit<CapabilityDispatchEvent, 'type' | 'timestamp'> {
  return {
    contractVersion: 1,
    dispatchId: input.identity.dispatchId,
    attemptId: input.attemptId,
    requestId: input.request.context.requestId,
    sessionId: input.request.context.sessionId,
    runId: input.request.context.runId,
    assignmentId: input.request.context.assignmentId,
    ...(input.request.context.taskId
      ? { taskId: input.request.context.taskId }
      : {}),
    agentPath: input.request.context.agentPath,
    ...(input.request.context.agentId
      ? { agentId: input.request.context.agentId }
      : {}),
    ...(input.request.context.activityScopeId
      ? { activityScopeId: input.request.context.activityScopeId }
      : {}),
    ...(input.request.context.workflowId
      ? { workflowId: input.request.context.workflowId }
      : {}),
    ...(input.request.context.workflowStepId
      ? { workflowStepId: input.request.context.workflowStepId }
      : {}),
    authorityKind: input.request.context.authority.kind,
    capabilityId: input.identity.invocation.capabilityId,
    sourceKind: input.identity.invocation.source.kind,
    sourceId: input.identity.invocation.source.id,
    ...(input.identity.invocation.source.version
      ? { sourceVersion: input.identity.invocation.source.version }
      : {}),
    argumentDigest: input.argumentDigest,
    argumentNames: input.argumentNames,
    effect: input.effect,
  }
}

async function appendEvent(
  ports: ResolvedDispatcherPorts,
  base: Omit<CapabilityDispatchEvent, 'type' | 'timestamp'>,
  type: CapabilityDispatchEventType,
  fields: Partial<
    Pick<
      CapabilityDispatchEvent,
      | 'code'
      | 'interactionId'
      | 'approvalOutcome'
      | 'costTracked'
      | 'budgetOverrun'
      | 'actualCostUsd'
    >
  > = {},
  /** Only true when a durable port derives this view from canonical appends. */
  derivesEvidence = false,
): Promise<void> {
  // When a durable journal derives the legacy evidence view, these facts are
  // canonical journal records and that view is a projection (ADR §9); no
  // independent authoritative write may happen here. A port that derives
  // nothing keeps the legacy writer, or the evidence would simply be lost.
  if (derivesEvidence && JOURNALED_LEGACY_EVIDENCE_TYPES.has(type)) return
  const now = ports.clock.now()
  if (!Number.isFinite(now)) throw new Error('Capability dispatch clock is invalid.')
  await ports.evidence.append({
    ...base,
    type,
    timestamp: new Date(now).toISOString(),
    ...fields,
  })
}

const JOURNALED_LEGACY_EVIDENCE_TYPES: ReadonlySet<CapabilityDispatchEventType> =
  new Set([
    'capability.dispatch.requested',
    'capability.dispatch.approval_requested',
    'capability.dispatch.approval_resolved',
    'capability.dispatch.started',
    'capability.dispatch.completed',
    'capability.dispatch.rejected',
    'capability.dispatch.cancelled',
    'capability.dispatch.failed',
    'capability.dispatch.indeterminate',
  ])

function terminalEventType(
  result: CapabilityDispatchResult,
): CapabilityDispatchEventType {
  return `capability.dispatch.${result.status}`
}

function terminalEventFields(
  result: CapabilityDispatchResult,
): Partial<
  Pick<
    CapabilityDispatchEvent,
    'code' | 'costTracked' | 'budgetOverrun' | 'actualCostUsd'
  >
> {
  return result.status === 'completed'
    ? {
        costTracked: result.costTracked,
        budgetOverrun: result.budgetOverrun,
        ...(result.actualCostUsd === undefined
          ? {}
          : { actualCostUsd: result.actualCostUsd }),
      }
    : { code: result.code }
}

function decisionResult(
  dispatchId: string,
  decision: CapabilityPolicyDecision,
): CapabilityDispatchResult {
  switch (decision.kind) {
    case 'allow':
      return failedResult(dispatchId, 'decision_result_invalid')
    case 'require-approval':
      return rejectedResult(dispatchId, 'approval_required')
    case 'deny':
      return rejectedResult(dispatchId, decision.code, decision.detail)
  }
}

function approvalOutcomeResult(
  dispatchId: string,
  outcome: CapabilityApprovalOutcome,
): CapabilityDispatchResult | undefined {
  switch (outcome) {
    case 'approved':
      return undefined
    case 'denied':
      return rejectedResult(dispatchId, 'approval_denied')
    case 'expired':
      return rejectedResult(dispatchId, 'approval_expired')
    case 'cancelled':
      return {
        status: 'cancelled',
        dispatchId,
        code: 'approval_cancelled',
      }
    case 'interrupted':
      return {
        status: 'cancelled',
        dispatchId,
        code: 'approval_interrupted',
      }
  }
}

function executionFailureResult(
  dispatchId: string,
  effect: CapabilityEffect,
  executionBegan: boolean,
  signal: AbortSignal,
): CapabilityDispatchResult {
  if (!executionBegan) return cancellationResult(dispatchId, signal)
  if (signal.aborted && effect.kind === 'read-only') {
    return cancellationResult(dispatchId, signal)
  }
  return effect.kind === 'read-only'
    ? failedResult(dispatchId, 'capability_execution_failed')
    : indeterminateResult(dispatchId, 'capability_execution_indeterminate')
}

function cancellationResult(
  dispatchId: string,
  signal: AbortSignal,
): CapabilityDispatchResult {
  return {
    status: 'cancelled',
    dispatchId,
    code: isTimeoutReason(signal.reason) ? 'deadline_exceeded' : 'caller_cancelled',
  }
}

function scheduledCancellation(
  dispatchId: string,
  signal: AbortSignal,
): Extract<ScheduledExecution, { readonly kind: 'blocked' }> | undefined {
  return signal.aborted
    ? {
        kind: 'blocked',
        result: cancellationResult(dispatchId, signal),
      }
    : undefined
}

function withProjectedDetail(
  result: CapabilityDispatchResult,
  detail: unknown,
): CapabilityDispatchResult {
  if (detail === undefined || result.status === 'completed') return result
  return { ...result, detail }
}

function rejectedResult(
  dispatchId: string,
  code: string,
  detail?: unknown,
): CapabilityDispatchResult {
  return {
    status: 'rejected',
    dispatchId,
    code,
    ...(detail === undefined ? {} : { detail }),
  }
}

function failedResult(
  dispatchId: string,
  code: string,
  detail?: unknown,
): CapabilityDispatchResult {
  return {
    status: 'failed',
    dispatchId,
    code,
    ...(detail === undefined ? {} : { detail }),
  }
}

function indeterminateResult(
  dispatchId: string,
  code: string,
  detail?: unknown,
): CapabilityDispatchResult {
  return {
    status: 'indeterminate',
    dispatchId,
    code,
    ...(detail === undefined ? {} : { detail }),
  }
}

function terminalResultCode(result: CapabilityDispatchResult): string {
  return result.status === 'completed' ? 'completed' : result.code
}

function notMeteredSettlement(): CapabilityBudgetSettlement {
  return { costTracked: false, budgetOverrun: false }
}

async function settleBudgetSafely(
  ports: ResolvedDispatcherPorts,
  reservation: CapabilityBudgetReservation,
  actualCostUsd: number | undefined,
): Promise<CapabilityBudgetSettlement> {
  if (
    actualCostUsd !== undefined &&
    (!Number.isFinite(actualCostUsd) || actualCostUsd < 0)
  ) {
    return { costTracked: false, budgetOverrun: false }
  }
  try {
    const settlement: unknown = await ports.budget.settle({
      reservation,
      ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
    })
    const resolved = readBudgetSettlement(settlement)
    if (resolved) return resolved
    await markBudgetSettlementUncertainSafely(
      ports,
      reservation,
      'settlement_result_invalid',
    )
    return {
      costTracked: false,
      budgetOverrun: false,
    }
  } catch {
    await markBudgetSettlementUncertainSafely(
      ports,
      reservation,
      'settlement_failed',
    )
    return { costTracked: false, budgetOverrun: false }
  }
}

async function markBudgetSettlementUncertainSafely(
  ports: ResolvedDispatcherPorts,
  reservation: CapabilityBudgetReservation,
  reason: 'settlement_failed' | 'settlement_result_invalid',
): Promise<void> {
  try {
    await ports.budget.markSettlementUncertain?.({ reservation, reason })
  } catch {
    // The completed effect remains returnable with costTracked:false. A hard
    // budget port owns fail-closed persistence of this uncertainty signal.
  }
}

function readAcceptedResult(value: unknown): CapabilityAcceptedResult | null {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'value')) {
    return null
  }
  return {
    value: value.value,
    ...(isFiniteNonNegativeNumber(value.actualCostUsd)
      ? { actualCostUsd: value.actualCostUsd }
      : {}),
  }
}

function readBudgetSettlement(value: unknown): CapabilityBudgetSettlement | null {
  if (
    !isRecord(value) ||
    typeof value.costTracked !== 'boolean' ||
    typeof value.budgetOverrun !== 'boolean'
  ) {
    return null
  }
  return {
    costTracked: value.costTracked,
    budgetOverrun: value.budgetOverrun,
    ...(isFiniteNonNegativeNumber(value.actualCostUsd)
      ? { actualCostUsd: value.actualCostUsd }
      : {}),
  }
}

function resolvedActualCost(
  settlement: CapabilityBudgetSettlement,
  acceptedActualCostUsd: number | undefined,
): number | undefined {
  if (!settlement.costTracked) return undefined
  return settlement.actualCostUsd ?? acceptedActualCostUsd
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Offer one live attempt to whoever owns this assignment's teardown.
 *
 * The finalizer is a closure over *this* session, so the registry never
 * learns a dispatch or attempt id and cannot finalize an attempt other than
 * the one it was handed. The scope is passed because that is the only
 * identity the shell needs — enough to keep a per-assignment set.
 */
function registerForTeardown(
  ports: ResolvedDispatcherPorts,
  context: CapabilityExecutionContext,
  durable: DurableDispatchSession,
): (() => void) | undefined {
  const registry = ports.teardown
  if (!registry) return undefined
  return registry.register({
    scope: {
      sessionId: context.sessionId,
      runId: context.runId,
      assignmentId: context.assignmentId,
    },
    finalizer: {
      finalizeIndeterminate: (code) => durable.finalizeForTeardown(code),
    },
  })
}

function resolvePorts(
  ports: CapabilityDispatcherPorts,
): ResolvedDispatcherPorts | null {
  if (
    !ports.bindings ||
    !ports.authority ||
    !ports.policy ||
    !ports.budget ||
    !ports.evidence ||
    !ports.scheduler ||
    !ports.clock ||
    !ports.ids
  ) {
    return null
  }
  return {
    bindings: ports.bindings,
    authority: ports.authority,
    policy: ports.policy,
    budget: ports.budget,
    approval: ports.approval,
    evidence: ports.evidence,
    scheduler: ports.scheduler,
    clock: ports.clock,
    ids: ports.ids,
    durable: ports.durable,
    teardown: ports.teardown,
  }
}

function validateDispatchEnvelope(request: CapabilityDispatchRequest): boolean {
  return Boolean(
    request &&
      isExecutionContext(request.context) &&
      isInvocation(request.invocation) &&
      request.adapter &&
      isIdentifier(request.adapter.capabilityId) &&
      typeof request.adapter.prepare === 'function' &&
      (request.signal === undefined || isAbortSignal(request.signal)) &&
      (request.deadlineMs === undefined || Number.isFinite(request.deadlineMs)) &&
      (request.settlementDeadlineMs === undefined ||
        Number.isFinite(request.settlementDeadlineMs)),
  )
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal
}

function isExecutionContext(value: unknown): value is CapabilityExecutionContext {
  if (!isRecord(value) || value.contractVersion !== 1) return false
  return isIdentifier(value.requestId) &&
    isIdentifier(value.sessionId) &&
    isIdentifier(value.runId) &&
    isIdentifier(value.assignmentId) &&
    isOptionalIdentifier(value.taskId) &&
    isSafeText(value.agentPath) &&
    isScopeAuthority(value.authority) &&
    isOptionalIdentifier(value.workflowId) &&
    isOptionalIdentifier(value.workflowStepId) &&
    isOptionalIdentifier(value.agentId) &&
    isOptionalSafeText(value.agentDisplayName) &&
    isOptionalIdentifier(value.activityScopeId)
}

function isScopeAuthority(value: unknown): value is CapabilityScopeAuthority {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'mcp-lease':
      return hasExactKeys(value, ['kind', 'leaseId']) && isIdentifier(value.leaseId)
    case 'runtime-assignment':
      return hasExactKeys(value, ['kind', 'processIdentity']) && isIdentifier(value.processIdentity)
    case 'parent-capability':
      return hasExactKeys(value, ['endpointId', 'kind', 'processIdentity']) &&
        isIdentifier(value.endpointId) &&
        isIdentifier(value.processIdentity)
    default:
      return false
  }
}

function isInvocation(value: unknown): value is CapabilityDispatchRequest['invocation'] {
  if (!isRecord(value) || !isRecord(value.source)) return false
  return isIdentifier(value.capabilityId) &&
    isIdentifier(value.toolCallId) &&
    (value.source.kind === 'builtin' ||
      value.source.kind === 'mcp' ||
      value.source.kind === 'pi-host' ||
      value.source.kind === 'engine') &&
    isIdentifier(value.source.id) &&
    isOptionalIdentifier(value.source.version)
}

function createExecutionSignal(
  callerSignal: AbortSignal | undefined,
  deadlineMs: number | undefined,
  now: () => number,
): { readonly signal: AbortSignal; release(): void } {
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) controller.abort(callerSignal.reason)
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

  let timeout: ReturnType<typeof setTimeout> | undefined
  if (deadlineMs !== undefined && Number.isFinite(deadlineMs)) {
    const delay = Math.max(0, deadlineMs - now())
    timeout = setTimeout(
      () => controller.abort(new DOMException('Capability deadline exceeded.', 'TimeoutError')),
      delay,
    )
  }
  return {
    signal: controller.signal,
    release: () => {
      callerSignal?.removeEventListener('abort', onCallerAbort)
      if (timeout) clearTimeout(timeout)
    },
  }
}

function createSettlementDeadline(
  deadlineMs: number,
  now: () => number,
): SettlementDeadline {
  const controller = new AbortController()
  let rejectDeadline: ((error: SettlementDeadlineError) => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const timeout = setTimeout(() => {
    const error = new SettlementDeadlineError()
    controller.abort(error)
    rejectDeadline?.(error)
  }, Math.max(0, deadlineMs - now()))
  return {
    signal: controller.signal,
    run: async <T>(operation: () => T | Promise<T>): Promise<T> => {
      const running = Promise.resolve().then(operation)
      return Promise.race([running, deadline])
    },
    release: () => clearTimeout(timeout),
  }
}

function runSettlementOperation<T>(
  settlement: SettlementDeadline | undefined,
  operation: () => T | Promise<T>,
): Promise<T> {
  return settlement
    ? settlement.run(operation)
    : Promise.resolve().then(operation)
}

function isApprovalOutcome(value: unknown): value is CapabilityApprovalOutcome {
  return value === 'approved' ||
    value === 'denied' ||
    value === 'expired' ||
    value === 'cancelled' ||
    value === 'interrupted'
}

function isApprovalInteraction(
  value: unknown,
): value is CapabilityApprovalInteraction {
  return isRecord(value) &&
    isIdentifier(value.interactionId) &&
    typeof value.reused === 'boolean'
}

function isApprovalDecision(value: unknown): value is {
  readonly outcome: CapabilityApprovalOutcome
  readonly interaction: CapabilityApprovalInteraction
} {
  return isRecord(value) &&
    isApprovalOutcome(value.outcome) &&
    isApprovalInteraction(value.interaction)
}

function isArgumentNames(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isIdentifier)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) return false
  const actual = ownKeys.filter(isString).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0-\x1f\x7f]/.test(value)
}

function isSafeText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !value.includes('\0')
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isIdentifier(value)
}

function isOptionalSafeText(value: unknown): value is string | undefined {
  return value === undefined || isSafeText(value)
}

function isTimeoutReason(value: unknown): boolean {
  return value instanceof Error && value.name === 'TimeoutError'
}

function isString(value: string | symbol): value is string {
  return typeof value === 'string'
}
