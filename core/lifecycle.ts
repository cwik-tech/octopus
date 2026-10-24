/**
 * Lifecycle — B2 foundation module
 *
 * Graceful shutdown helpers: SIGTERM/SIGINT handler registration and
 * coordinated abort with state persistence.
 * Zero imports from other project files.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShutdownHandlerOptions {
  /** Called exactly once when SIGTERM, SIGINT or SIGHUP is received. */
  onShutdown: () => void
}

/** A live shutdown registration, and the only way to end one. */
export interface ShutdownRegistration {
  /**
   * Stop calling this registration's `onShutdown`.
   *
   * Idempotent, and safe to call after a signal has already run it. The last
   * disposal releases the process listeners entirely.
   */
  dispose(): void
}

// ─── Module-level registry ────────────────────────────────────────────────────

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

/**
 * Every live registration, in the order it was made.
 *
 * A set rather than a single captured callback. The process outlives any one
 * session: a host loads an extension, shuts it down, and loads another. A
 * first-caller-wins guard bounds the listener count but binds the process to
 * the first session forever — later sessions get no signal handling at all, and
 * a signal reaches a runtime that finished long ago.
 */
const liveRegistrations = new Set<() => void>()

let signalListener: (() => void) | null = null

function ensureSignalListener(): void {
  if (signalListener) return
  // One listener per signal for the whole process, however many registrations
  // are live. Iterated over a copy, because a shutdown callback may dispose its
  // own registration.
  const listener = (): void => {
    for (const notify of [...liveRegistrations]) notify()
  }
  signalListener = listener
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, listener)
}

function releaseSignalListenerIfIdle(): void {
  if (!signalListener || liveRegistrations.size > 0) return
  for (const signal of SHUTDOWN_SIGNALS) process.off(signal, signalListener)
  signalListener = null
}

// ─── installShutdownHandlers ──────────────────────────────────────────────────

/**
 * Call `options.onShutdown` once when this process is asked to stop.
 *
 * Two guarantees, and they are separate. `onShutdown` runs at most once however
 * many signals arrive — several can land together, as Ctrl+C does in some
 * terminals. And the process listeners are shared: registering repeatedly does
 * not accumulate them, and disposing every registration gives them back.
 *
 * @returns the registration, which the caller must dispose when its session
 *   ends. Holding one past that leaves a signal bound to a finished runtime.
 */
export function installShutdownHandlers(
  options: ShutdownHandlerOptions,
): ShutdownRegistration {
  let cleanedUp = false

  const notify = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    options.onShutdown()
  }

  liveRegistrations.add(notify)
  ensureSignalListener()

  return {
    dispose(): void {
      liveRegistrations.delete(notify)
      releaseSignalListenerIfIdle()
    },
  }
}

// ─── gracefulShutdown ─────────────────────────────────────────────────────────

/**
 * Initiates graceful shutdown:
 *   1. Aborts `controller` — signals all linked subprocesses via the abort chain
 *   2. Calls `persistFn` synchronously — persists current pipeline state
 *   3. Arms a safety-net timer that calls `process.exit(1)` after `gracePeriodMs`
 *      in case async cleanup hangs
 *
 * The safety-net timer is unreffed so a normally-completing process can exit
 * without being held alive by the timer.
 */
export function gracefulShutdown(
  controller: AbortController,
  persistFn: () => void,
  gracePeriodMs = 5000,
): void {
  controller.abort()
  persistFn()
  const timer: ReturnType<typeof setTimeout> = setTimeout(
    () => process.exit(1),
    gracePeriodMs,
  )
  // Allow the process to exit normally without waiting for the safety-net timer
  timer.unref()
}

// ─── Shutdown abort reason ────────────────────────────────────────────────────

/**
 * The abort reason given to work stopped because the application is shutting
 * down.
 *
 * A shutdown aborts work the same way a user's Stop does. Work that records how
 * it ended tells the two apart by this reason, so quitting the app is never
 * saved as a cancellation the user asked for. It is still an `AbortError`, so
 * code that only asks "was this aborted?" answers as before.
 */
export const APPLICATION_SHUTDOWN_ABORT_REASON: DOMException = new DOMException(
  'The application is shutting down.',
  'AbortError',
)

/** Whether this signal was aborted by the application shutting down. */
export function isApplicationShutdownAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === APPLICATION_SHUTDOWN_ABORT_REASON
}
