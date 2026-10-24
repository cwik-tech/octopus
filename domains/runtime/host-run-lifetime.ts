/**
 * How long a managed Team host process stays alive.
 *
 * A Team host is a `pi` print-mode run, and print mode's lifetime is exactly
 * the prompts it awaits: it disposes the session in the `finally` after the
 * last one (`@earendil-works/pi-coding-agent/dist/modes/print-mode.js:134`).
 * A Team run's work does not fit that shape. Its opening entry is queued rather
 * than prompted, and each later level is entered by another entry queued while
 * the previous turn settles — so a host with one awaited prompt disposes while
 * its first coordinator is still waiting to be asked anything.
 *
 * This is the owner that holds that prompt open. It answers one question,
 * "is any admitted work left?", from the runtime's own follow-up queue rather
 * than a copy of it: a second record of admitted work would be a second answer,
 * and only one of them could be right.
 *
 * Three things count as work: an entry still queued, a turn running, and an
 * entry handed to the host whose turn has not started yet. The third exists
 * because `ExtensionAPI.sendUserMessage` returns `void` and starts the turn
 * asynchronously (`dist/core/extensions/types.d.ts:932`,
 * `dist/core/agent-session.js:1855`), so for a moment there is neither a queued
 * entry nor a running turn while a coordinator is about to speak. That same
 * `void` is why a delivery needs a deadline: a rejected preflight is reported
 * on Pi's own error channel, which an extension cannot read, so an entry that
 * will never start looks exactly like one that has not started yet. Waiting
 * forever is the one answer that is never right.
 */

/**
 * How long a delivered entry has to start its turn.
 *
 * Covers an ordinary provider preflight — a model lookup and a credential
 * check — with room to spare, and is short enough that a host whose entry was
 * rejected asynchronously still ends rather than hanging on a run nobody can
 * observe failing.
 */
export const HOST_ENTRY_START_DEADLINE_MS = 60_000

/**
 * How often the keep-alive wakes up while a host is waiting.
 *
 * It does nothing when it fires; only being referenced matters. Long enough
 * that an idle host is not busy, short enough to stay well inside Node's
 * maximum timer delay.
 */
export const HOST_KEEP_ALIVE_INTERVAL_MS = 60_000

/** A cancellable wake-up. Injected so the rules can be tested without waiting. */
export interface HostRunLifetimeClock {
  setTimeout(handler: () => void, delayMs: number): { cancel(): void }
}

/**
 * The live runtime state this owner reads.
 *
 * Read, never copied. The runtime's follow-up queue and turn claim are the
 * authoritative record of admitted work; this owner has no queue of its own.
 */
export interface HostRunWorkSource {
  /** Entries admitted and queued, not yet handed to the host. */
  pendingEntryCount(): number
  /** A host turn is running now. */
  turnInFlight(): boolean
}

export interface HostRunStop {
  readonly reason:
    /** Nothing queued, nothing running, nothing owed a turn. */
    | 'no_work_remains'
    /**
     * An entry was handed over and no turn ever started for it.
     *
     * The one outcome the host cannot diagnose from inside itself, because the
     * rejection is reported on Pi's own error channel. It is a failure, not a
     * finished run, and whoever waits on it owes the run a terminal record.
     */
    | 'entry_never_started'
    /** The run recorded its own failure; nothing more will be dispatched. */
    | 'run_failed'
    /** Cancellation or shutdown, with work still owed. */
    | 'abandoned'
    /**
     * An admitted entry was given up before it could ever be handed over.
     *
     * The other outcomes all assume the queue eventually either sends an entry
     * or empties. It can do neither if it cannot record the dispatch: nothing
     * is handed over, so no start deadline is armed, and the entry stays
     * pending, so `reconsider` refuses to stop. No later event clears that, so
     * the queue has to be able to say it has given up.
     */
    | 'entry_never_dispatched'
  /** Why, as a fixed word from the caller — never text from outside. */
  readonly detail?: string
}

/**
 * Hold the process open until released.
 *
 * A pending promise is not work, and Node ends a process with no work to do.
 * The follow-up queue's own wake-up is deliberately unreferenced
 * (`domains/runtime/follow-up.ts:58`) so that queue cannot decide a process's
 * lifetime by itself — which leaves nothing at all holding a waiting host open.
 * This is that something, and it belongs to whoever decides the lifetime.
 */
export type HostRunKeepAlive = () => { release(): void }

export interface HostRunLifetimeOptions {
  readonly work: HostRunWorkSource
  readonly clock: HostRunLifetimeClock
  readonly keepAlive: HostRunKeepAlive
  /**
   * How long a delivered entry has to start its turn before the host concludes
   * it never will. Long enough to cover an ordinary provider preflight, short
   * enough that a run which cannot proceed still ends.
   */
  readonly startDeadlineMs: number
}

export class HostRunLifetime {
  private readonly options: HostRunLifetimeOptions
  private stop: HostRunStop | null = null
  private resolveStop: ((stop: HostRunStop) => void) | null = null
  private readonly stopped_: Promise<HostRunStop>
  /**
   * Whether the entry handed to the host is still waiting to be seen starting.
   *
   * At most one, because `flushPendingFollowUps` hands over one entry at a time
   * (`domains/runtime/follow-up.ts`) — Pi refuses a second concurrent send and
   * the caller cannot see that it did. So a start corresponds to the delivery
   * that is outstanding, and clearing on a start is exact rather than a
   * generalisation over a batch.
   */
  private awaitingStart = 0
  private startDeadline: { cancel(): void } | null = null
  private held: { release(): void } | null = null
  private compacting = false

  constructor(options: HostRunLifetimeOptions) {
    this.options = options
    this.stopped_ = new Promise<HostRunStop>((resolve) => {
      this.resolveStop = resolve
    })
  }

  /** Resolves once, with the reason the host may stop. */
  whenStopped(): Promise<HostRunStop> {
    return this.stopped_
  }

  /** The decision already made, or null while work remains. */
  stopped(): HostRunStop | null {
    return this.stop
  }

  /**
   * Keep the process alive until this owner says it may stop.
   *
   * Called by whoever is waiting on {@link whenStopped}. A host that has
   * already stopped takes nothing: there is nothing left to wait for.
   */
  hold(): void {
    if (this.stop || this.held) return
    this.held = this.options.keepAlive()
  }

  /**
   * The queue has given up on an entry it can never hand over.
   *
   * Ends the run: this is the one state nothing else can clear.
   */
  dispatchAbandoned(detail: string): void {
    this.settle({ reason: 'entry_never_dispatched', detail })
  }

  /** An entry was handed to the host and now owes a turn. */
  entryDelivered(): void {
    if (this.stop) return
    this.awaitingStart += 1
    this.armStartDeadline()
  }

  /**
   * A host turn started, which is what a delivered entry was waiting for.
   *
   * Call this after the turn is claimed, never before. It re-asks the question,
   * and the answer is read from {@link HostRunWorkSource.turnInFlight} — so a
   * claim that is not yet recorded reads as a host with nothing to do.
   */
  turnStarted(): void {
    if (this.stop) return
    // A started turn ends any compaction that was in the way of it, whatever
    // that compaction's outcome was. This is the bound: Pi only compacts inside
    // a prompt, and a cancelled, aborted or failed compaction still lets that
    // prompt go on to start its turn.
    this.compacting = false
    this.awaitingStart = 0
    this.disarmStartDeadline()
    this.reconsider()
  }

  /** A host turn finished. Anything it queued is in the queue by now. */
  turnSettled(): void {
    if (this.stop) return
    // The other end of the same bound: a compaction Pi runs between turns is
    // over by the time the run that contained it settles.
    this.compacting = false
    this.reconsider()
  }

  /** Re-ask the question after anything that could change the answer. */
  reconsider(): void {
    if (this.stop) return
    if (this.awaitingStart > 0) return
    if (this.options.work.turnInFlight()) return
    if (this.options.work.pendingEntryCount() > 0) return
    this.settle({ reason: 'no_work_remains' })
  }

  /**
   * The run recorded its own failure, so nothing more will be dispatched.
   *
   * The settle that cannot enter its destination discards the queued entries,
   * writes the failure and releases the turn claim — and then there is no later
   * settle to ask the question again. Without this the host would wait on a run
   * that is already over.
   */
  runFailed(): void {
    this.settle({ reason: 'run_failed' })
  }

  /**
   * Pi is compacting, which it does before it starts the next turn.
   *
   * Compaction is itself a provider call (`dist/core/agent-session.js:861`),
   * so a slow one delays `agent_start` for a perfectly healthy entry. The
   * deadline is held rather than lengthened: the question is whether anything
   * is happening, and during a compaction something is.
   *
   * The hold cannot depend on being told the compaction finished. Pi emits
   * `session_compact` only after a successful save (`:1677`); a cancelled
   * (`:1623`), aborted (`:1660`) or failed (`:1711`) compaction emits a
   * session-level `compaction_end` that no extension can see. So the hold is
   * released by the next turn to start or settle as well — which Pi's own
   * control flow guarantees, because it compacts only inside a prompt and that
   * prompt proceeds whatever the compaction did.
   */
  compactionStarted(): void {
    if (this.stop) return
    this.compacting = true
    this.disarmStartDeadline()
  }

  /** Compaction finished. Anything still owed a turn is owed one again. */
  compactionFinished(): void {
    if (this.stop) return
    this.compacting = false
    if (this.awaitingStart > 0) this.armStartDeadline()
  }

  /** Give up the remaining work: cancellation, or a shutdown already underway. */
  abandon(): void {
    this.settle({ reason: 'abandoned' })
  }

  private armStartDeadline(): void {
    if (this.startDeadline || this.compacting) return
    this.startDeadline = this.options.clock.setTimeout(() => {
      this.startDeadline = null
      if (this.awaitingStart === 0) return
      this.settle({ reason: 'entry_never_started' })
    }, this.options.startDeadlineMs)
  }

  private disarmStartDeadline(): void {
    this.startDeadline?.cancel()
    this.startDeadline = null
  }

  private settle(stop: HostRunStop): void {
    // First answer wins. A deadline that fires after the host has already been
    // released must not relabel why it stopped.
    if (this.stop) return
    this.stop = stop
    this.disarmStartDeadline()
    this.held?.release()
    this.held = null
    this.resolveStop?.(stop)
    this.resolveStop = null
  }
}
