/**
 * Timeout Manager — B2 foundation module
 *
 * Provides AbortSignal composition and a typed timeout error.
 * Zero imports from other project files.
 */

/**
 * Upper bound on one provider HTTP request, streamed body included.
 *
 * A streaming response is not finished when the headers arrive, so a signal
 * that only covered connection setup would leave a stalled body running
 * forever. Composed with the caller's own signal at every call site, so a
 * cancelled turn and an unresponsive endpoint both end the request.
 */
export const PROVIDER_HTTP_REQUEST_TIMEOUT_MS = 10 * 60 * 1000

// ─── combineAbortSignals ─────────────────────────────────────────────────────

/**
 * Combines multiple AbortSignals into a single AbortSignal.
 *
 * Aborting ANY input signal aborts the combined signal.
 * Undefined signals are silently skipped.
 * Already-aborted signals cause the combined signal to abort immediately.
 *
 * Uses `AbortSignal.any()` on Node 20+, otherwise falls back to manual
 * event-listener wiring with full listener cleanup.
 */
export function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const validSignals = signals.filter((s): s is AbortSignal => s !== undefined);

  if (validSignals.length === 0) {
    // Nothing to combine — return a signal that never aborts
    return new AbortController().signal;
  }

  return AbortSignal.any(validSignals);
}

// ─── TimeoutError ─────────────────────────────────────────────────────────────

/**
 * Thrown when a per-agent subprocess timeout fires.
 * `dispatchWithFailurePolicy()` receives this as an error and applies
 * the configured failure policy (retry / fallback / halt).
 */
export class TimeoutError extends Error {
  readonly agentName: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;

  constructor(agentName: string, timeoutMs: number, elapsedMs: number) {
    super(
      `Agent "${agentName}" timed out after ${elapsedMs}ms (limit: ${timeoutMs}ms)`,
    );
    this.name = "TimeoutError";
    this.agentName = agentName;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
    // Fix prototype chain for instanceof checks across module boundaries
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
