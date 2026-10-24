export interface ProviderStallDetail {
  /** Milliseconds of silence measured when the span opened or closed. */
  readonly idleMs: number
}

export interface ProviderStallWatchdogOptions {
  /** Silence past this threshold opens a stall span. */
  readonly idleMs: number
  /**
   * Silence past this threshold ends the turn. Omit to report only.
   *
   * Reporting alone leaves the run alive while its deadline drains, which is
   * the failure this watchdog was built to make visible but could not stop.
   */
  readonly abortIdleMs?: number
  readonly onStall: (detail: ProviderStallDetail) => void
  readonly onResume: (detail: ProviderStallDetail) => void
  readonly onAbort?: (detail: ProviderStallDetail) => void
}

export interface ProviderStallWatchdog {
  /** Record a protocol event; closes an open stall span. */
  observe(nowMs: number): void
  /** Evaluate the current silence; opens a stall span at most once. */
  check(nowMs: number): void
}

/**
 * Detect a provider that has gone silent mid-turn.
 *
 * A CLI provider runs its own tool loop in a subprocess and retries upstream
 * without emitting anything, so an outage or rate-limit backoff produces no
 * protocol events at all — the run stays alive while its deadline drains, and
 * the timeline shows an unexplained hole. This reports the silence as one
 * bounded span rather than one event per poll, and closes it with the measured
 * duration once the provider speaks again.
 *
 * Time is supplied by the caller so the policy is testable without timers; the
 * transport decides how often to `check`.
 */
export function createProviderStallWatchdog(
  options: ProviderStallWatchdogOptions,
): ProviderStallWatchdog {
  let lastEventAtMs: number | undefined
  let stalled = false
  let aborted = false

  return {
    observe(nowMs) {
      if (stalled && lastEventAtMs !== undefined) {
        stalled = false
        options.onResume({ idleMs: nowMs - lastEventAtMs })
      }
      aborted = false
      lastEventAtMs = nowMs
    },
    check(nowMs) {
      if (lastEventAtMs === undefined) return
      const idleMs = nowMs - lastEventAtMs
      // Abort is evaluated before the report guard: a span already reported as
      // stalled must still be able to cross the larger threshold. Both fire at
      // most once per span so repeated polls never re-kill the process.
      if (
        !aborted &&
        options.abortIdleMs !== undefined &&
        options.onAbort &&
        idleMs >= options.abortIdleMs
      ) {
        aborted = true
        if (!stalled) {
          stalled = true
          options.onStall({ idleMs })
        }
        options.onAbort({ idleMs })
        return
      }
      if (stalled) return
      if (idleMs < options.idleMs) return
      stalled = true
      options.onStall({ idleMs })
    },
  }
}
