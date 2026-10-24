import type { CapabilityAssignmentScope } from '../contracts/capability-dispatch.js'
import type {
  CapabilityDispatchLifecycle,
  CapabilityDispatchLifecycleRunOutcome,
} from '../contracts/capability-dispatch-lifecycle.js'
import type {
  DurableTeardownFinalizer,
  DurableTeardownRegistry,
} from '../contracts/durable-dispatch.js'

/**
 * How long assignment release waits for its aborted operations before
 * releasing anyway. Bounded because terminal-task finalization awaits it.
 */
const DEFAULT_RELEASE_DRAIN_TIMEOUT_MS = 5_000
/** The decision recorded for an attempt teardown could not wait out. */
const ASSIGNMENT_RELEASE_DEADLINE_CODE = 'assignment_release_deadline_exceeded'
/** The same, when it is the whole lifecycle shutting down rather than one assignment. */
const SHUTDOWN_DEADLINE_CODE = 'shutdown_deadline_exceeded'
/**
 * How long lifecycle shutdown lets in-flight operations finish (AC18).
 *
 * Deliberately its own value, not an alias of the assignment-release drain.
 * Still a provisional operational default rather than a measured one: no
 * measurement stands behind 5 s. It shipped in that state with default-on
 * activation. Callers that own a wider shutdown window pass an absolute
 * deadline to close instead.
 */
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000

export interface CapabilityDispatchLifecycleOptions {
  /** Bounds the release drain; see `DEFAULT_RELEASE_DRAIN_TIMEOUT_MS`. */
  readonly releaseDrainTimeoutMs?: number
  /**
   * How long a graceful shutdown lets in-flight operations finish before it
   * aborts and finalizes them (AC18). A product option, not a test hook:
   * deployments with slower external effects legitimately need a wider
   * window. Must be a finite, non-negative number of milliseconds.
   */
  readonly shutdownDeadlineMs?: number
}

export class CapabilityDispatchLifecycleCoordinator
  implements CapabilityDispatchLifecycle
{
  private readonly activeOperations = new Map<
    AbortController,
    {
      readonly promise: Promise<unknown>
      readonly scope: CapabilityAssignmentScope
    }
  >()
  private closing = false
  /**
   * Assignments whose teardown has begun (AC18).
   *
   * The bindings layer already refuses a *scope* it has marked, but a binding
   * scope is keyed by task and authority as well as by assignment, and
   * `bindings.releaseAssignment` can only mark the scopes that exist when it
   * runs. A dispatch for a task this assignment has not seen before therefore
   * creates a clean scope and is admitted — new work accepted for an
   * assignment whose teardown has already begun, and unaccounted for by a
   * drain snapshot that was taken before it arrived. Whether it then loses
   * its journal depends on how the race lands; what is wrong is admitting it
   * at all.
   *
   * The barrier is per assignment and is never lifted: release is terminal,
   * and an assignment that has been torn down does not come back. This
   * reverses an earlier behaviour in which a released assignment could be
   * dispatched again once its retained bindings had been evicted.
   */
  private readonly releasedAssignments = new Set<string>()
  /**
   * Live durable attempts per assignment, as the core registers them (AC18).
   *
   * The coordinator keeps the set; the core keeps the identity. Each entry is
   * an opaque operation bound to one attempt, so teardown can finalize exactly
   * the attempts that are still running without knowing what they are.
   */
  private readonly liveAttempts = new Map<
    string,
    Set<DurableTeardownFinalizer>
  >()
  private closePromise: Promise<void> | undefined
  private readonly releaseDrainTimeoutMs: number
  private readonly releaseDrainGraceMs: number
  /**
   * How long already-aborted operations get to record what became of them
   * before the caller closes its writers (AC18). Not a second drain.
   */
  private readonly shutdownAbortSettlementGraceMs: number
  private readonly shutdownDeadlineMs: number
  readonly teardown: DurableTeardownRegistry

  constructor(options: CapabilityDispatchLifecycleOptions = {}) {
    this.releaseDrainTimeoutMs =
      options.releaseDrainTimeoutMs ?? DEFAULT_RELEASE_DRAIN_TIMEOUT_MS
    this.releaseDrainGraceMs = Math.max(
      1,
      Math.floor(this.releaseDrainTimeoutMs / 5),
    )
    this.shutdownDeadlineMs = validateShutdownDeadlineMs(
      options.shutdownDeadlineMs,
    )
    // Not a drain: nothing is still being *allowed* to run by this point.
    // It bounds how long already-aborted operations get to record what became
    // of them. Scaled to the shutdown window rather than the release drain,
    // so a shutdown configured for 250 ms does not then wait a second.
    this.shutdownAbortSettlementGraceMs = Math.max(
      1,
      Math.floor(this.shutdownDeadlineMs / 5),
    )
    this.teardown = {
      register: ({ scope, finalizer }) => {
        const key = assignmentBarrierKey(scope)
        const live =
          this.liveAttempts.get(key) ?? new Set<DurableTeardownFinalizer>()
        live.add(finalizer)
        this.liveAttempts.set(key, live)
        return () => {
          const current = this.liveAttempts.get(key)
          if (!current) return
          current.delete(finalizer)
          // An assignment with nothing live keeps no entry, so this map
          // does not grow with every assignment the process has ever seen.
          if (current.size === 0) this.liveAttempts.delete(key)
        }
      },
    }
  }

  /**
   * Admit one operation atomically.
   *
   * The global shutdown bar and the released-assignment bar are checked
   * synchronously, the controller and the tracked promise are registered
   * synchronously, and only then does the callback begin — in a queued
   * promise turn, never before registration. A drain snapshot taken at any
   * point after admission therefore sees the operation, and an operation is
   * never running untracked.
   */
  run<T>(input: {
    readonly scope: CapabilityAssignmentScope
    readonly operation: (signal: AbortSignal) => Promise<T>
  }): Promise<CapabilityDispatchLifecycleRunOutcome<T>> {
    if (this.closing) {
      return Promise.resolve({
        kind: 'refused',
        code: 'lifecycle_shutting_down',
      })
    }
    // Refused ahead of admission so an operation for a released assignment
    // never runs an external effect it could not then record.
    if (this.releasedAssignments.has(assignmentBarrierKey(input.scope))) {
      return Promise.resolve({
        kind: 'refused',
        code: 'assignment_released',
      })
    }
    const controller = new AbortController()
    const tracked = Promise.resolve().then(() =>
      input.operation(controller.signal),
    )
    const settled = tracked.finally(() => {
      this.activeOperations.delete(controller)
    })
    this.activeOperations.set(controller, {
      promise: settled,
      scope: input.scope,
    })
    return settled.then((result) => ({ kind: 'ran', result }))
  }

  /**
   * Refuse new operations, without disturbing work already running (AC18).
   *
   * Idempotent, and never the thing that ends an operation: only the deadline
   * in `close` does that.
   */
  beginShutdown(): void {
    this.closing = true
  }

  /**
   * Drain until the deadline, finalize what is left, then return.
   *
   * `deadlineMs` is an *absolute* clock deadline, so a caller that has
   * already spent part of one shutdown window passes what remains of it
   * rather than starting a fresh one — two windows in series would be a
   * shutdown twice as long as anybody configured.
   *
   * A failed finalization rejects and leaves the coordinator open: the
   * journals must not close over a decision that was never recorded. The
   * rejection is not memoized, so a caller can retry after a transient fault.
   */
  close(options?: { readonly deadlineMs?: number }): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.beginShutdown()
    const deadlineMs = validateAbsoluteDeadlineMs(
      options?.deadlineMs,
      Date.now() + this.shutdownDeadlineMs,
    )
    // The stored promise is the handled one: its rejection handler clears the
    // memo and rethrows, so the memo is already empty by the time any caller
    // sees the failure and nothing is left floating. A finalization that
    // failed on a transient fault must be retryable, and the journals are
    // still open precisely so that it can be.
    const handled = this.runShutdown(deadlineMs).catch((error: unknown) => {
      this.closePromise = undefined
      throw error
    })
    this.closePromise = handled
    return handled
  }

  /**
   * Bar the assignment, drain its in-flight operations, and finalize whatever
   * survives both. Call only from verified assignment teardown, after the
   * caller has barred new dispatches at its own layer; the bar here is the
   * coordinator's own and is never lifted. Evidence and journal release stay
   * with the caller, after this returns.
   */
  async releaseAssignment(scope: CapabilityAssignmentScope): Promise<void> {
    // Synchronous, before the first await, so no operation can slip in
    // between the bar and the drain snapshot below.
    this.releasedAssignments.add(assignmentBarrierKey(scope))
    // Operations already executing for this assignment still need their
    // evidence and journal. Tearing those down underneath a running effect
    // turns a completed operation into an unproven one, so drain first.
    //
    // The drain is bounded because terminal-task finalization awaits it: an
    // operation parked on an approval that never arrives would otherwise hang
    // task completion outright.
    //
    // Cancellation is the fallback, not the opening move. Aborting an
    // operation whose effect is mid-flight turns a successful external
    // operation into an unproven one, so a settling operation is given its
    // time first and only a stuck one is cancelled.
    const draining = [...this.activeOperations.entries()].filter(([, entry]) =>
      isSameAssignment(entry.scope, scope),
    )
    const settled = Promise.allSettled(draining.map(([, entry]) => entry.promise))
    const timedOut = Symbol('drain-timeout')
    const outcome = await Promise.race([
      settled,
      delay(this.releaseDrainTimeoutMs).then(() => timedOut),
    ])
    if (outcome === timedOut) {
      for (const [controller] of draining) {
        controller.abort(
          new DOMException('Assignment is being released.', 'AbortError'),
        )
      }
      await Promise.race([settled, delay(this.releaseDrainGraceMs)])
      // Anything still registered survived both the drain and the grace, so
      // it will not finish on its own. Record an explicit decision for each
      // before the journal goes: closing on a timer would leave a stream that
      // merely stops, when what an operator needs is one that says what
      // happened (AC18).
      //
      // A rejection here propagates: the journal stays open and unreleased
      // rather than closing over a decision that was never recorded.
      await this.finalizeUnsettledAttempts(scope)
    }
  }

  private async runShutdown(deadlineMs: number): Promise<void> {
    // Work already running is given until the deadline. Aborting first — what
    // this used to do — turns an effect that was about to finish into an
    // unproven one, which is the same mistake assignment release avoids.
    const settled = Promise.allSettled(
      [...this.activeOperations.values()].map((entry) => entry.promise),
    )
    const timedOut = Symbol('shutdown-deadline')
    const deadline = cancellableDeadline(deadlineMs)
    let outcome: unknown
    try {
      outcome = await Promise.race([
        settled,
        deadline.reached.then(() => timedOut),
      ])
    } finally {
      // Nothing stale is left armed when the drain wins.
      deadline.cancel()
    }
    if (outcome === timedOut) {
      // Snapshotted across every assignment *before* the abort, and before
      // the first append is awaited. Looking each key up as we go would let a
      // cooperative attempt unwind on the abort and unregister while an
      // earlier finalizer is still awaiting — escaping the shutdown decision
      // precisely because it reacted correctly.
      const unsettled = [...this.liveAttempts.values()].flatMap((live) => [
        ...live,
      ])
      for (const controller of this.activeOperations.keys()) {
        controller.abort(
          new DOMException('Capability runtime is closing.', 'AbortError'),
        )
      }
      // Finalization starts immediately: no fresh *drain* is opened after the
      // deadline, because that would make a configured shutdown quietly
      // longer than it says.
      //
      // The rule is settled *or* decided, not decided regardless. An attempt
      // that reaches a durable terminal after the abort — a cooperative
      // adapter whose result was already known — keeps that terminal;
      // `finalizeForTeardown` returns without appending over it. Only an
      // attempt that is still genuinely unsettled receives the shutdown
      // decision. Both cases are resolved before anything closes.
      //
      // Sequential, because each is a journal append that would otherwise
      // contend for the same per-assignment lock. A rejection here propagates
      // and the journal stays open.
      for (const finalizer of unsettled) {
        await finalizer.finalizeIndeterminate(SHUTDOWN_DEADLINE_CODE)
      }
      // The journal is not the only authority an operation answers to. One
      // that cooperates with the abort settles `cancelled` and writes that
      // terminal to the capability evidence stream, and it is still unwinding
      // when the finalization above finishes — so the caller must not close
      // its writers the moment finalization returns: that would report an
      // unproven outcome for work that demonstrably stopped. The same defect
      // as closing a journal early, one authority down, and it bites hardest
      // where there is no durable authority at all.
      //
      // Not a second drain: these operations have already been aborted and
      // are only recording what became of them. The bound is what keeps a
      // stubborn one — an adapter that ignores its signal — from holding
      // settlement open indefinitely; it loses its evidence write when the
      // grace expires, exactly as it does under assignment release.
      await Promise.race([settled, delay(this.shutdownAbortSettlementGraceMs)])
    }
  }

  /**
   * Record an explicit decision for every attempt of this assignment that is
   * still live, then let the caller release the journal.
   *
   * Sequential rather than `Promise.all`: the set is mutated as attempts
   * unregister themselves, and each finalization is a journal append that
   * would otherwise contend with the others for the same per-assignment lock.
   * A snapshot is taken first for the same reason.
   */
  private async finalizeUnsettledAttempts(
    scope: CapabilityAssignmentScope,
  ): Promise<void> {
    await this.finalizeLiveAttempts(
      assignmentBarrierKey(scope),
      ASSIGNMENT_RELEASE_DEADLINE_CODE,
    )
  }

  private async finalizeLiveAttempts(
    key: string,
    code: string,
  ): Promise<void> {
    const live = this.liveAttempts.get(key)
    if (!live) return
    for (const finalizer of [...live]) {
      await finalizer.finalizeIndeterminate(code)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never hold the process open for a timeout nobody is waiting on.
    timer.unref?.()
  })
}

/**
 * A deadline that can be stood down.
 *
 * `delay` alone leaves a timer armed when the drain wins the race, which on
 * a short-lived process is harmless and on a long-lived one is litter.
 */
function cancellableDeadline(deadlineMs: number): {
  readonly reached: Promise<void>
  cancel(): void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  const reached = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), Math.max(0, deadlineMs - Date.now()))
  })
  return {
    reached,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * `close` takes an *absolute* deadline from callers that own a wider shutdown
 * window, so it is public input and validated as such — the constructor's
 * duration check does not cover a `NaN` or `Infinity` arriving here.
 */
function validateAbsoluteDeadlineMs(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) {
    throw new Error(
      `close deadlineMs must be a finite absolute timestamp; received ${String(value)}.`,
    )
  }
  return value
}

/**
 * A shutdown window has to be a real duration. A negative or non-finite one
 * would make the deadline meaningless in a way that only shows up during an
 * actual shutdown, which is the worst moment to discover it.
 */
function validateShutdownDeadlineMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SHUTDOWN_DEADLINE_MS
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `shutdownDeadlineMs must be a finite, non-negative number of milliseconds; received ${String(value)}.`,
    )
  }
  return value
}

/**
 * The assignment barrier's key.
 *
 * Encoded rather than joined on a delimiter, because the barrier is checked
 * on the *request* side before anything has validated that context: the
 * refusal happens ahead of the bindings and of the core validator, which is
 * the whole point of it. A joined key would let two different assignments
 * collide if a segment could contain the delimiter, and nothing has yet
 * established that it cannot. `JSON.stringify` of the ordered parts is
 * unambiguous for arbitrary strings, so the precheck is safe on unvalidated
 * input; `releaseAssignment` separately validates its own scope through the
 * bindings before marking.
 */
function assignmentBarrierKey(scope: CapabilityAssignmentScope): string {
  return JSON.stringify([scope.sessionId, scope.runId, scope.assignmentId])
}

function isSameAssignment(
  left: CapabilityAssignmentScope,
  right: CapabilityAssignmentScope,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.assignmentId === right.assignmentId
  )
}

/**
 * The explicit pass-through participant for constructions intentionally
 * outside shared lifecycle coordination.
 *
 * It preserves execution behavior — the operation runs without lifecycle
 * gating, nothing is tracked, and shutdown/release are no-ops — while making
 * the unmanaged seam searchable: every construction site that opts out of
 * coordination names this participant, so a grep for it finds each one.
 */
const unmanagedLifecycleSignal = new AbortController().signal

export const UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE: CapabilityDispatchLifecycle = {
  run<T>(input: {
    readonly scope: CapabilityAssignmentScope
    readonly operation: (signal: AbortSignal) => Promise<T>
  }): Promise<CapabilityDispatchLifecycleRunOutcome<T>> {
    return Promise.resolve()
      .then(() => input.operation(unmanagedLifecycleSignal))
      .then((result): CapabilityDispatchLifecycleRunOutcome<T> => ({
        kind: 'ran',
        result,
      }))
  },
  teardown: {
    register: () => () => undefined,
  },
  beginShutdown: () => undefined,
  close: () => Promise.resolve(),
  releaseAssignment: () => Promise.resolve(),
}
