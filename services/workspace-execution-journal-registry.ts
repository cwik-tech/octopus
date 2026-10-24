import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type {
  CapabilityAssignmentScope,
  CapabilityExecutionContext,
} from '../contracts/capability-dispatch.js'
import type {
  CapabilityDispatchResolutionPort,
  CapabilityDurableDispatchPort,
} from '../contracts/durable-dispatch.js'
import type { ExecutionJournalScopeIdentity } from '../contracts/execution-journal.js'
import { createJournalBackedDurableDispatch } from '../core/durable-dispatch-journal.js'
import {
  EXECUTION_JOURNAL_DIRECTORY_NAME,
  initializeExecutionJournal,
  type ExecutionJournal,
  type ExecutionJournalMetrics,
} from '../core/execution-journal.js'
import {
  buildSessionRunAssignmentLocation,
  RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
} from '../core/run-assignment-location.js'
import { createAssignmentCapabilityResultStore } from './capability-result-content-store.js'

const MANIFEST_FILENAME = 'manifest.json'
const LEGACY_EVIDENCE_FILENAME = 'capability-dispatch-events.jsonl'

/**
 * How the workspace treats assignments that are not already enrolled.
 *
 * Authority is sticky per assignment (ADR §16): once an assignment's journal
 * holds canonical events it is always consulted, whatever the mode says. The
 * mode therefore governs enrollment of *new* assignments only.
 *
 * Two modes, not three (ADR A-1). `shadow` never supplied a dispatcher port and
 * never wrote a shadow stream, so inside this registry it was indistinguishable
 * from `disabled`; a mode that promises comparison and performs none reads as a
 * safety net that is not there. It survives as a deprecated *input* — see
 * `resolveExecutionJournalOptions` — not as a mode.
 */
export type ExecutionJournalMode = 'disabled' | 'authoritative'

/**
 * A journal setting the runtime cannot act on. Thrown at the configuration
 * boundary so it surfaces at startup, naming the variable and the value,
 * instead of resolving to `disabled` and reading as protection that is on.
 */
export class ExecutionJournalConfigurationError extends Error {
  constructor(
    readonly variable: string,
    readonly value: string,
    detail: string,
  ) {
    super(`${variable}=${JSON.stringify(value)} is not valid: ${detail}`)
    this.name = 'ExecutionJournalConfigurationError'
  }
}

/**
 * Values the flag still accepts but no longer documents. Retained for one
 * release with a warning: a repository search cannot inventory deployment
 * environments, launch scripts, CI definitions, or a shell profile, so
 * removing an accepted value is a user-visible configuration change that needs
 * its own release note rather than a silent behaviour flip.
 */
const DEPRECATED_JOURNAL_FLAG_VALUES: ReadonlyMap<
  string,
  { readonly mode: ExecutionJournalMode; readonly replacement: string }
> = new Map([
  ['shadow', { mode: 'disabled' as const, replacement: 'disabled' }],
  ['1', { mode: 'authoritative' as const, replacement: 'authoritative' }],
])

export interface ResolvedExecutionJournalOptions {
  readonly mode: ExecutionJournalMode
  readonly tenantId: string
  /** Human-readable notices for accepted-but-deprecated inputs. */
  readonly deprecations: readonly string[]
}

export interface WorkspaceExecutionJournalRegistryOptions {
  readonly workspacePath: string
  /**
   * Sealed immutably into every manifest this registry creates. Changing it
   * makes an existing assignment's journal fail closed with a manifest
   * conflict rather than silently starting a second authority.
   */
  readonly tenantId: string
  readonly mode: ExecutionJournalMode
  readonly clock?: () => number
  /**
   * Opens one assignment's journal. Defaults to `initializeExecutionJournal`.
   *
   * A dependency seam rather than a test hook: it is the one point where the
   * registry's lifecycle handling can be driven deterministically, because an
   * open that is aborted and *succeeds anyway* is a real state
   * (`initializeExecutionJournal` checks the signal, then performs several
   * awaited filesystem operations without checking again) that only scheduler
   * timing would otherwise produce.
   */
  readonly journalOpener?: (input: {
    readonly scopeRoot: string
    readonly identity: ExecutionJournalScopeIdentity
    readonly signal: AbortSignal
  }) => Promise<ExecutionJournal>
}

/**
 * Durable execution-journal enrollment for new assignments (Phase 8 cutover).
 *
 * `PIPELINE_DURABLE_JOURNAL` selects the mode and **defaults to
 * `authoritative`** (ADR A-14), so a new assignment enrols unless the flag
 * explicitly says `disabled`. Authority is sticky in the other direction too:
 * an assignment whose journal already holds canonical events stays
 * journal-authoritative whatever this returns (ADR §16), which is why
 * `disabled` turns enrolment off for new assignments and never unwinds one.
 *
 * The tenant is sealed immutably into every manifest this creates, so it comes
 * from the same environment variable the runtime stamps onto engine events.
 * Changing it makes an existing assignment fail closed with a manifest
 * conflict.
 *
 * Lives beside the registry rather than in the composition root because the
 * task-worker process resolves the same flag without going through it.
 */
export function resolveExecutionJournalOptions(): ResolvedExecutionJournalOptions {
  const deprecations: string[] = []
  const requested = process.env.PIPELINE_DURABLE_JOURNAL
  let mode: ExecutionJournalMode

  if (requested === undefined || requested === '') {
    // Unset and empty both mean "flag removed", which is not a typo — and
    // since A-14 that is the supported configuration rather than the opt-out.
    // Turning the journal off is now something a deployment states, because a
    // durability guarantee nobody remembered to switch on is not one.
    mode = 'authoritative'
  } else if (requested === 'disabled' || requested === 'authoritative') {
    mode = requested
  } else {
    const deprecated = DEPRECATED_JOURNAL_FLAG_VALUES.get(requested)
    if (!deprecated) {
      throw new ExecutionJournalConfigurationError(
        'PIPELINE_DURABLE_JOURNAL',
        requested,
        "expected 'disabled' or 'authoritative'. Enrollment is irreversible, " +
          'so an unrecognised value fails startup rather than falling through ' +
          'to the default: a misspelt attempt to turn the journal off would ' +
          'otherwise enrol the workspace, which cannot be undone.',
      )
    }
    mode = deprecated.mode
    deprecations.push(
      `PIPELINE_DURABLE_JOURNAL=${requested} is deprecated and will be removed; ` +
        `use '${deprecated.replacement}'.`,
    )
  }

  return { mode, tenantId: resolveJournalTenantId(), deprecations }
}

/**
 * The tenant sealed immutably into every manifest this workspace creates.
 *
 * The boundary is narrow on purpose. It rejects what a manifest would reject
 * anyway, plus two things that are silently lossy rather than invalid: a
 * whitespace-only value, and padding that would be sealed into a manifest and
 * then never match the value an operator retypes. It does not invent a
 * character set — the tenants already in use cannot be inventoried from here.
 */
function resolveJournalTenantId(): string {
  return validateJournalTenantId(process.env.TEAM_TENANT_ID)
}

/**
 * The tenant boundary as a pure function of its input.
 *
 * Exported so callers that hold a tenant from somewhere other than the
 * environment — an operator's `--tenant` argument, for one — apply the same
 * rule rather than a copy of it, and without having to mutate `process.env` to
 * reach it. That mutation raced whenever two things ran concurrently.
 */
export function validateJournalTenantId(raw: string | undefined): string {
  if (raw === undefined || raw === '') return DEFAULT_JOURNAL_TENANT_ID

  if (raw.trim() === '') {
    throw new ExecutionJournalConfigurationError(
      'TEAM_TENANT_ID',
      raw,
      'a whitespace-only tenant is sealed into every journal manifest and can ' +
        'never be matched again. Unset the variable to use ' +
        `'${DEFAULT_JOURNAL_TENANT_ID}'.`,
    )
  }
  if (raw !== raw.trim()) {
    throw new ExecutionJournalConfigurationError(
      'TEAM_TENANT_ID',
      raw,
      'leading or trailing whitespace would be sealed into every journal ' +
        'manifest and would not match the same value retyped without it.',
    )
  }
  if (raw.length > MAX_JOURNAL_TENANT_LENGTH || /[\0-\x1f\x7f]/.test(raw)) {
    throw new ExecutionJournalConfigurationError(
      'TEAM_TENANT_ID',
      raw,
      'the journal manifest rejects control characters and values longer than ' +
        `${MAX_JOURNAL_TENANT_LENGTH} characters, so this could never be sealed.`,
    )
  }
  return raw
}

/** The tenant an unset `TEAM_TENANT_ID` resolves to. */
export const DEFAULT_JOURNAL_TENANT_ID = 'local'

/** Matches the journal manifest's own identifier bound. */
const MAX_JOURNAL_TENANT_LENGTH = 512

/**
 * The registry for this workspace. Always returns one (ADR §16).
 *
 * It used to return `undefined` for a disabled flag, and that was the whole of
 * the sticky-authority hole in the task worker: with no registry, the workflow
 * runner short-circuited *before any enrollment check*, built its store with no
 * recorder, and silently returned an already-enrolled assignment to the
 * snapshot-first authority.
 *
 * The mode governs enrollment of *new* assignments, which `resolveJournal`
 * decides per assignment — not whether a registry exists. That is what the
 * parent process has always done; this makes the worker match it.
 */
export function createWorkspaceExecutionJournalRegistry(
  workspacePath: string,
  resolved?: ResolvedExecutionJournalOptions,
): WorkspaceExecutionJournalRegistry {
  // Callers that went through `startWorkspaceExecutionJournal` pass what it
  // resolved, so the tenant a registry seals is the one the workspace pin
  // approved rather than whatever this process's environment happens to hold.
  const options = resolved ?? resolveExecutionJournalOptions()
  return new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: options.tenantId,
    mode: options.mode,
  })
}

export class ExecutionJournalReleasedError extends Error {
  constructor(assignmentId: string) {
    super(
      `Execution journal for assignment '${assignmentId}' was released; it cannot be reopened.`,
    )
    this.name = 'ExecutionJournalReleasedError'
  }
}

export class ExecutionJournalUnavailableError extends Error {
  constructor(assignmentId: string, options?: { readonly cause?: unknown }) {
    super(
      `Execution journal for assignment '${assignmentId}' is unavailable.`,
      options,
    )
    this.name = 'ExecutionJournalUnavailableError'
  }
}

interface OpenJournal {
  readonly journal: ExecutionJournal
  readonly port: CapabilityDurableDispatchPort & CapabilityDispatchResolutionPort
}

/**
 * One in-flight journal open, shared by every dispatch that asks for the same
 * assignment while it is running.
 *
 * The budget belongs to the open, not to whichever caller started it. It is
 * abandoned only when every live waiter has given up, and it runs until the
 * latest deadline any live waiter supplied. Binding it to the first caller
 * instead let one cancelled tool call fail the rest of a parallel turn, and
 * let a caller with a tight budget time out one that had a generous one.
 */
class JournalOpenAttempt {
  private readonly budget = new AbortController()
  private readonly cleanups: Array<() => void> = []
  private liveWaiters = 0
  private deadlineMs = Number.NEGATIVE_INFINITY
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly clock: () => number) {}

  get signal(): AbortSignal {
    return this.budget.signal
  }

  /**
   * True once the shared budget has been given up — every waiter left, or the
   * latest deadline passed. An `AbortController` cannot be un-aborted, so no
   * later caller can revive this attempt's budget.
   *
   * It does *not* follow that the attempt can only reject: the open may have
   * passed its last abort check already and still resolve a live journal.
   * That is why detaching an abandoned attempt has to clean up after it
   * rather than simply drop it.
   */
  isAbandoned(): boolean {
    return this.budget.signal.aborted
  }

  join(input: {
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }): void {
    // An already-abandoned caller neither extends the budget nor keeps it
    // alive; it simply awaits whatever the open produces.
    if (this.disposed || input.signal.aborted) return

    this.liveWaiters += 1
    const onAbort = (): void => {
      this.liveWaiters -= 1
      if (this.liveWaiters <= 0) this.budget.abort(input.signal.reason)
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
    this.cleanups.push(() =>
      input.signal.removeEventListener('abort', onAbort),
    )

    if (input.deadlineMs > this.deadlineMs) {
      this.deadlineMs = input.deadlineMs
      this.rearmTimer()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  private rearmTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    const remainingMs = Math.max(0, this.deadlineMs - this.clock())
    this.timer = setTimeout(() => this.budget.abort(), remainingMs)
  }
}

/**
 * A journal borrowed for bounded work, and the way to give it back.
 *
 * `release` is idempotent and non-terminal: it may close the journal, but it
 * never bars the assignment from being opened again.
 */
export interface JournalHandleLease {
  readonly journal: ExecutionJournal
  release(): Promise<void>
}

/**
 * Owns one execution journal per assignment for a workspace (ADR §1).
 *
 * Mirrors `WorkspaceCapabilityEvidenceWriter`'s per-assignment cache and path
 * canonicalisation, and additionally constructs the journal's manifest
 * identity, which the evidence writer never needs.
 */
export class WorkspaceExecutionJournalRegistry {
  private readonly workspacePath: string
  private readonly tenantId: string
  private readonly mode: ExecutionJournalMode
  private readonly open = new Map<string, Promise<OpenJournal | undefined>>()
  /** Coordinates the waiters sharing one in-flight open per assignment. */
  private readonly attempts = new Map<string, JournalOpenAttempt>()
  private readonly clock: () => number
  private readonly journalOpener: NonNullable<
    WorkspaceExecutionJournalRegistryOptions['journalOpener']
  >
  /**
   * Cleanups for opens detached from an abandoned attempt, per assignment.
   *
   * Keyed rather than global because both lifecycle methods have to drain
   * them and they own different scopes: `releaseAssignment` finalizes one
   * assignment and must not wait on another's, while `close()` owns whatever
   * is left. A fire-and-forget promise would outlive both and leave the
   * lifecycle unverifiable.
   */
  private readonly detachedCleanups = new Map<string, Set<Promise<void>>>()
  /**
   * The drain in flight for an assignment, if any.
   *
   * Every lifecycle caller joins it rather than starting a second, and it
   * stays discoverable until the work settles — otherwise the first drainer
   * would take the registry's only record of the cleanup and a concurrent
   * `close()` would report a shutdown that has not happened.
   */
  private readonly drainsInFlight = new Map<string, Promise<void>>()
  private readonly released = new Set<string>()
  /**
   * Live transient leases per assignment; see `acquireJournalHandle`.
   *
   * A count rather than a flag: several parts of one chat turn — the recorder,
   * a reconciliation, an operator read — can hold the same journal at once,
   * and it may close only when the last of them lets go.
   */
  private readonly leases = new Map<string, number>()
  /**
   * The transient close barrier for an assignment, if any.
   *
   * An acquisition arriving while the last lease is closing must wait for it
   * and then reopen from disk. Without this the two would race and the
   * assignment could briefly hold two journals, which is exactly the split
   * authority one-journal-per-assignment exists to prevent (ADR §1). A failed
   * close remains here as a rejected barrier: reopening would be unsafe when
   * the registry cannot prove the previous handle is gone.
   */
  private readonly leaseClosures = new Map<string, Promise<void>>()
  private closed = false

  constructor(options: WorkspaceExecutionJournalRegistryOptions) {
    this.workspacePath = options.workspacePath
    this.tenantId = options.tenantId
    this.mode = options.mode
    this.clock = options.clock ?? (() => Date.now())
    this.journalOpener = options.journalOpener ?? initializeExecutionJournal
  }

  /**
   * Resolve this assignment's durable authority.
   *
   * `undefined` means the assignment has no durable authority and the dispatch
   * proceeds unchanged. A throw means the authority is enrolled but
   * unavailable, which must fail the dispatch closed rather than execute
   * without a durability barrier (ADR §7).
   */
  async resolve(input: {
    readonly context: CapabilityExecutionContext
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }): Promise<CapabilityDurableDispatchPort | undefined> {
    const { context, ...budget } = input
    return this.resolvePort({ scope: context, ...budget })
  }

  /**
   * The same assignment's journal, reached by an operator resolution that has
   * a scope and no execution context.
   *
   * Deliberately the same cache, the same in-flight open, and the same
   * `released`/`closed` bars as dispatch. A second opener would not honour
   * them, so an operator write could reopen an assignment this registry has
   * already barred (D4) — which is exactly the silent reopen ADR §16 forbids.
   */
  async resolveResolutionPort(input: {
    readonly scope: CapabilityAssignmentScope
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }): Promise<CapabilityDispatchResolutionPort | undefined> {
    return this.resolvePort(input)
  }

  /**
   * This process's counters for an assignment it already holds open, and
   * nothing at all otherwise.
   *
   * Never opens a journal. The operator report is a read path, and the
   * counters are per-handle and in-memory, so opening one to read them would
   * report the numbers of the open that just happened rather than the numbers
   * of the work that has been going on.
   */
  async peekMetrics(
    scope: CapabilityAssignmentScope,
  ): Promise<ExecutionJournalMetrics | undefined> {
    const opened = this.open.get(assignmentKey(scope))
    if (!opened) return undefined
    const settled = await opened.then(
      (value) => value,
      () => undefined,
    )
    return settled?.journal.getMetrics()
  }

  private async resolvePort(input: {
    readonly scope: CapabilityAssignmentScope
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }): Promise<OpenJournal['port'] | undefined> {
    const { scope } = input
    if (this.clock() >= input.deadlineMs) {
      throw new ExecutionJournalUnavailableError(scope.assignmentId)
    }
    const key = assignmentKey(scope)
    // `undefined` means "no durable authority, proceed on the legacy path", so
    // a closed registry must throw instead: executing without a barrier is
    // forbidden once an assignment may be enrolled (ADR §7).
    if (this.closed) {
      throw new ExecutionJournalUnavailableError(scope.assignmentId)
    }
    if (this.released.has(key)) {
      throw new ExecutionJournalReleasedError(scope.assignmentId)
    }

    // A transient lease close owns this assignment until both projection
    // catch-up and handle shutdown finish. Every resolution path must join
    // that barrier: dispatch resolution is just as capable of reopening the
    // assignment as another lease acquisition. A rejected barrier stays
    // authoritative because the old handle may still be live.
    const closing = this.leaseClosures.get(key)
    if (closing) {
      try {
        await closing
      } catch (cause) {
        throw new ExecutionJournalUnavailableError(scope.assignmentId, {
          cause,
        })
      }
      return this.resolvePort(input)
    }

    const existing = this.open.get(key)
    if (existing) {
      const attempt = this.attempts.get(key)
      if (attempt?.isAbandoned() === true) {
        // The waiters that started this open have all gone and its budget is
        // aborted, so joining it would make a healthy caller inherit a
        // cancellation that happened before it arrived. The refcount covers
        // waiters leaving *while* others remain, not the attempt already
        // being abandoned when someone new turns up.
        //
        // The detached open may still reject *or* succeed, so it is handed to
        // a cleanup rather than dropped.
        if (this.open.get(key) === existing) this.open.delete(key)
        if (this.attempts.get(key) === attempt) this.attempts.delete(key)
        this.discardAbandonedOpen(key, existing)
        return this.resolvePort(input)
      }
      // Joining an in-flight open contributes this caller's own signal and
      // deadline to it, so the shared budget reflects every live waiter rather
      // than whoever happened to arrive first.
      attempt?.join(input)
      const settled = await existing
      if (settled?.journal.isRetired() !== true) return settled?.port
      // A handle retired by a recoverable fault must not be handed out again:
      // its in-memory index has advanced past what reached disk (ADR A-2).
      // Dropping the cache entry is the whole recovery — the reopen below
      // rescans from disk and derives a correct index. Deliberately *not*
      // `releaseAssignment`, which bars the assignment permanently and would
      // brick it a different way.
      if (this.open.get(key) === existing) this.open.delete(key)
      await settled.journal.close().catch(() => undefined)
      return this.resolvePort(input)
    }

    // Seeded before the first await so concurrent dispatches on one assignment
    // share a single initialization instead of racing several.
    const attempt = new JournalOpenAttempt(this.clock)
    this.attempts.set(key, attempt)
    attempt.join(input)
    const opening = this.resolveJournalWithinDeadline(scope, attempt).finally(
      () => {
        attempt.dispose()
        if (this.attempts.get(key) === attempt) this.attempts.delete(key)
      },
    )
    this.open.set(key, opening)
    // Neither a failed open nor an unenrolled assignment may poison the cache.
    void opening.catch(() => undefined).then((settled) => {
      if (settled === undefined && this.open.get(key) === opening) {
        this.open.delete(key)
      }
    })
    return (await opening)?.port
  }

  /**
   * The assignment's journal itself, for stores that record onto the same
   * stream the dispatcher uses (ADR §1: one journal per assignment, one lock).
   * Shares the cached open, so a workflow recorder and a dispatch port for one
   * assignment can never end up on two journals.
   *
   * Holds the journal open until the assignment reaches its terminal
   * `releaseAssignment`, which is right for a task or a workflow and wrong for
   * an assignment that has no terminal transition. Those use
   * `acquireJournalHandle` instead.
   */
  async resolveJournalHandle(input: {
    readonly context: CapabilityExecutionContext
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }): Promise<ExecutionJournal | undefined> {
    await this.resolve(input)
    const key = assignmentKey(input.context)
    const opened = this.open.get(key)
    return opened ? (await opened)?.journal : undefined
  }

  /**
   * The same journal, borrowed for a bounded piece of work.
   *
   * An agent-chat assignment lives for one reply and never reaches the
   * terminal transition `releaseAssignment` is built for, so without this every
   * selected-agent turn would leave an open journal, its in-memory index, and a
   * file descriptor behind until the process exited.
   *
   * `release` is idempotent, and only the last live lease closes anything. The
   * close is *not* terminal: the cache entry is dropped and the handle closed,
   * but the assignment is never added to `released`, because a retry, a
   * reconciliation, or an operator read still has to be able to reopen it from
   * durable state. `releaseAssignment` keeps its own, permanent meaning.
   *
   * `undefined` means the assignment has no durable authority, exactly as it
   * does for `resolveJournalHandle`.
   */
  async acquireJournalHandle(input: {
    readonly context: CapabilityExecutionContext
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }): Promise<JournalHandleLease | undefined> {
    const key = assignmentKey(input.context)
    // A close in flight owns the cache entry until it finishes. Joining it
    // first is what makes the reopen read durable state rather than race a
    // half-closed handle.
    const closing = this.leaseClosures.get(key)
    if (closing) {
      try {
        await closing
      } catch (cause) {
        throw new ExecutionJournalUnavailableError(
          input.context.assignmentId,
          { cause },
        )
      }
    }

    if (this.closed) {
      throw new ExecutionJournalUnavailableError(input.context.assignmentId)
    }
    if (this.released.has(key)) {
      throw new ExecutionJournalReleasedError(input.context.assignmentId)
    }

    // Reserve the lease before resolving the journal. There must be no await
    // between observing a free close barrier and incrementing this count, or
    // the final release can start closing the handle selected below.
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1)

    let journal: ExecutionJournal | undefined
    try {
      journal = await this.resolveJournalHandle(input)
    } catch (error) {
      this.cancelLeaseReservation(key)
      throw error
    }
    if (!journal) {
      this.cancelLeaseReservation(key)
      return undefined
    }

    let releasedThisLease = false
    return {
      journal,
      release: async () => {
        if (releasedThisLease) return
        releasedThisLease = true
        await this.releaseLease(key)
      },
    }
  }

  private cancelLeaseReservation(key: string): void {
    const remaining = (this.leases.get(key) ?? 1) - 1
    if (remaining > 0) {
      this.leases.set(key, remaining)
      return
    }
    this.leases.delete(key)
  }

  /**
   * Drop one lease, and close the journal when it was the last.
   *
   * Deliberately narrow: it removes the exact cache entry it closed, so a
   * reopen that has already replaced it is left alone.
   */
  private async releaseLease(key: string): Promise<void> {
    const remaining = (this.leases.get(key) ?? 1) - 1
    if (remaining > 0) {
      this.leases.set(key, remaining)
      return
    }
    this.leases.delete(key)
    const opening = this.open.get(key)
    if (!opening) return
    const closing = this.closeLeasedJournal(key, opening)
    this.leaseClosures.set(key, closing)
    await closing
    // Deliberately reached only on success. A rejected close stays in the map
    // and makes later resolution fail closed until the process restarts.
    if (this.leaseClosures.get(key) === closing) {
      this.leaseClosures.delete(key)
    }
  }

  private async closeLeasedJournal(
    key: string,
    opening: Promise<OpenJournal | undefined>,
  ): Promise<void> {
    // Only the entry this close owns. A concurrent reopen may already have
    // replaced it, and closing that one would shut a journal somebody holds.
    if (this.open.get(key) === opening) this.open.delete(key)
    const settled = await opening.then(
      (value) => value,
      () => undefined,
    )
    if (!settled) return

    // Closing the handle is mandatory even when projection catch-up fails.
    // Otherwise the failed barrier would be removed while a live, untracked
    // handle still owned the assignment and a later retry could open another.
    let projectionFailed = false
    let projectionFailure: unknown
    try {
      await settled.port.flushProjections()
    } catch (error) {
      projectionFailed = true
      projectionFailure = error
    }
    try {
      await settled.journal.close()
    } catch (closeFailure) {
      if (projectionFailed) {
        throw new AggregateError(
          [projectionFailure, closeFailure],
          'Execution journal projection flush and close both failed',
          { cause: projectionFailure },
        )
      }
      throw closeFailure
    }
    if (projectionFailed) throw projectionFailure
  }

  private async resolveJournalWithinDeadline(
    scope: CapabilityAssignmentScope,
    attempt: JournalOpenAttempt,
  ): Promise<OpenJournal | undefined> {
    return this.resolveJournal(scope, { signal: attempt.signal })
  }

  private async resolveJournal(
    scope: CapabilityAssignmentScope,
    input: { readonly signal: AbortSignal },
  ): Promise<OpenJournal | undefined> {
    const location = buildSessionRunAssignmentLocation(this.workspacePath, scope)
    if (!location) {
      throw new ExecutionJournalUnavailableError(scope.assignmentId)
    }
    // Enrollment is sticky: an assignment whose journal already exists is
    // resolved whatever the mode says. The mode only decides whether a new
    // assignment may enroll.
    const enrollment = await readEnrollmentState(location.assignmentPath)
    if (enrollment === 'indeterminate') {
      throw new ExecutionJournalUnavailableError(scope.assignmentId)
    }
    if (enrollment === 'absent' && this.mode !== 'authoritative') {
      return undefined
    }
    return this.openJournal(scope, location.assignmentPath, input)
  }

  /**
   * Close one assignment's journal after its dispatches are barred, and bar
   * any later resolution so a terminal assignment cannot silently reopen.
   */
  async releaseAssignment(scope: CapabilityAssignmentScope): Promise<void> {
    const key = assignmentKey(scope)
    this.released.add(key)
    const transientClose = this.leaseClosures.get(key)
    if (transientClose) await transientClose
    const opening = this.open.get(key)
    this.open.delete(key)
    if (opening) {
      // Drain an in-flight open rather than abandoning it mid-initialization.
      const settled = await opening.then(
        (value) => value,
        () => undefined,
      )
      // Before the journal closes: catch-up reads from it, and a released
      // assignment has no later reader to recover its view (AC8).
      await settled?.port.flushProjections()
      await settled?.journal.close()
    }
    // The cached open is not the only journal this assignment can still
    // produce: an open detached from an abandoned attempt may be behind its
    // own gate and about to succeed. Releasing before that is drained would
    // let terminal finalization finish with a live journal still on its way.
    await this.drainDetachedCleanups(key)
  }

  async close(): Promise<void> {
    this.closed = true
    // The closed flag now bars every resolution, so per-assignment release
    // markers no longer carry information worth retaining.
    this.released.clear()
    const pending = [...this.open.values()]
    this.open.clear()
    const transientClosures = [...this.leaseClosures.values()]
    // Both maps, because a release already draining a key has not removed it
    // from `detachedCleanups` yet and may have the only in-flight record.
    const detachedKeys = new Set([
      ...this.detachedCleanups.keys(),
      ...this.drainsInFlight.keys(),
    ])
    await Promise.all([
      ...transientClosures,
      ...pending.map(async (opening) => {
        const settled = await opening.then(
          (value) => value,
          () => undefined,
        )
        // Same ordering as release: runtime shutdown reaches this path, not
        // that one, so the guarantee has to be wired into both (AC8).
        await settled?.port.flushProjections()
        await settled?.journal.close()
      }),
      // Joining any drain already under way rather than starting a second.
      ...[...detachedKeys].map((key) => this.drainDetachedCleanups(key)),
    ])
    this.leases.clear()
    this.leaseClosures.clear()
  }

  /**
   * Close whatever a detached attempt eventually produces.
   *
   * An aborted open does not only reject. `initializeExecutionJournal` checks
   * the signal and then performs several awaited filesystem operations
   * without checking again, so an abort landing in that window still resolves
   * a live journal. Dropping the promise would leak that handle and, for as
   * long as it lived, give the assignment two authorities (ADR §1).
   *
   * It touches no cache or attempt entry, so the replacement that took its
   * place is unaffected by whatever this finds. A failed *open* leaves
   * nothing to close and is swallowed; a failed *close* is kept and surfaces
   * through whichever lifecycle method drains this assignment, which is how
   * this registry already treats the difference between the two.
   */
  private discardAbandonedOpen(
    key: string,
    opening: Promise<OpenJournal | undefined>,
  ): void {
    const cleanup = (async () => {
      const settled = await opening.then(
        (value) => value,
        () => undefined,
      )
      if (settled) await settled.journal.close()
    })()
    const forKey = this.detachedCleanups.get(key) ?? new Set<Promise<void>>()
    forKey.add(cleanup)
    this.detachedCleanups.set(key, forKey)
    void cleanup.then(
      () => {
        this.forgetCleanup(key, cleanup)
      },
      // A failed cleanup stays registered, so whichever lifecycle method
      // drains this assignment reports it rather than completing while a
      // journal is still open.
      () => undefined,
    )
  }

  private forgetCleanup(key: string, cleanup: Promise<void>): void {
    const forKey = this.detachedCleanups.get(key)
    if (!forKey) return
    forKey.delete(cleanup)
    if (forKey.size === 0) this.detachedCleanups.delete(key)
  }

  /**
   * Await the detached cleanups for one assignment.
   *
   * The work runs once and every caller joins it. Nothing is removed until it
   * settles, so a lifecycle method that arrives mid-drain can still find it:
   * truthful completion matters more than reporting a failure exactly once,
   * and a release and a close that overlap may legitimately both surface the
   * same failed journal close.
   *
   * A drain that fails stays discoverable on purpose. Clearing it would let
   * the next lifecycle caller complete as though the journal had closed.
   */
  private async drainDetachedCleanups(key: string): Promise<void> {
    const inFlight = this.drainsInFlight.get(key)
    if (inFlight) {
      await inFlight
      return
    }
    const forKey = this.detachedCleanups.get(key)
    if (!forKey || forKey.size === 0) return

    const drain = Promise.all([...forKey]).then(() => undefined)
    this.drainsInFlight.set(key, drain)
    await drain
    if (this.drainsInFlight.get(key) === drain) {
      this.drainsInFlight.delete(key)
      this.detachedCleanups.delete(key)
    }
  }

  private async openJournal(
    scope: CapabilityAssignmentScope,
    assignmentPath: string,
    input: { readonly signal: AbortSignal },
  ): Promise<OpenJournal> {
    let journal: ExecutionJournal
    try {
      const open = {
        scopeRoot: assignmentPath,
        identity: this.identityFor(scope),
        signal: input.signal,
      }
      journal = await this.journalOpener(open)
    } catch (error) {
      throw new ExecutionJournalUnavailableError(scope.assignmentId, {
        cause: error,
      })
    }
    const port = createJournalBackedDurableDispatch(journal, {
      // The legacy evidence view is assignment-scoped, so it maps 1:1 onto
      // this journal and becomes a derived projection (ADR §9).
      capabilityEvidenceProjectionPath: path.join(
        assignmentPath,
        'logs',
        LEGACY_EVIDENCE_FILENAME,
      ),
      // Exact capability results belong to the assignment, not to its journal
      // (`docs/adr/2026-08-26-Execution-Journal-Content-Separation.md`). The
      // registry is the one place that knows the assignment's own root, so it
      // is the one place that decides where those bytes live.
      resultContentStore: createAssignmentCapabilityResultStore({
        assignmentPath,
      }),
    })
    return { journal, port }
  }

  private identityFor(
    scope: CapabilityAssignmentScope,
  ): ExecutionJournalScopeIdentity {
    return {
      scopeKind: 'assignment',
      scopeId: scope.assignmentId,
      tenantId: this.tenantId,
      sessionId: scope.sessionId,
      runId: scope.runId,
      assignmentId: scope.assignmentId,
    }
  }
}

/**
 * Enrollment is tri-state on purpose. Only a definitively absent marker means
 * "not enrolled"; anything unreadable, or present but not a regular file,
 * leaves enrollment unknown. Treating unknown as unenrolled would return a
 * possibly-enrolled assignment to the legacy authority (ADR §16).
 */
type EnrollmentState = 'enrolled' | 'absent' | 'indeterminate'

async function readEnrollmentState(
  assignmentPath: string,
): Promise<EnrollmentState> {
  const manifestPath = path.join(
    assignmentPath,
    RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
    EXECUTION_JOURNAL_DIRECTORY_NAME,
    MANIFEST_FILENAME,
  )
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(manifestPath)
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return 'absent'
    }
    return 'indeterminate'
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return 'indeterminate'
  return 'enrolled'
}

function assignmentKey(scope: CapabilityAssignmentScope): string {
  return [scope.sessionId, scope.runId, scope.assignmentId].join('\0')
}
