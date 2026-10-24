/**
 * Whether the Browser Use live smoke check may run, and under what alarm.
 *
 * A pure decision, separated from the check itself so the thing that decides
 * whether to spend money is testable without spending any. Every refusal is a
 * reason a person can read, because "skipped" with no explanation is how a live
 * check quietly stops running and nobody notices.
 *
 * Two independent switches are required. An enable flag alone is too easy to
 * leave set; a threshold alone says nothing about intent. Both must be present,
 * and the threshold must be a positive amount somebody chose.
 *
 * **The threshold is an alarm, not a cap.** Provider cost is only known once a
 * session has been stopped, so nothing here can prevent a bill — it can only
 * refuse to start, and afterwards say plainly whether what was spent exceeded
 * what the operator expected.
 */

export const LIVE_ENABLE_ENV = 'PIPELINE_LIVE_BROWSER_USE'
export const LIVE_THRESHOLD_ENV = 'PIPELINE_LIVE_BROWSER_USE_ALARM_MICROS'
export const LIVE_KEY_ENV = 'BROWSER_USE_API_KEY'

/**
 * The largest value this harness will accept.
 *
 * A validation bound on the input, not a statement about what a session costs.
 */
const MAXIMUM_THRESHOLD_MICROS = 100_000_000

export type BrowserUseLiveGate =
  | { readonly kind: 'skip'; readonly reason: string }
  | {
      readonly kind: 'run'
      readonly apiKey: string
      /** The amount above which the run is reported as unexpectedly expensive. */
      readonly alarmMicros: number
    }

export function browserUseLiveGate(
  environment: NodeJS.ProcessEnv,
): BrowserUseLiveGate {
  if (environment[LIVE_ENABLE_ENV] !== '1') {
    return {
      kind: 'skip',
      reason: `${LIVE_ENABLE_ENV} is not 1; this check bills a real provider.`,
    }
  }

  const rawThreshold = environment[LIVE_THRESHOLD_ENV]?.trim()
  if (!rawThreshold) {
    return {
      kind: 'skip',
      reason:
        `${LIVE_THRESHOLD_ENV} must name the USD micros above which this run is ` +
        'reported as unexpectedly expensive.',
    }
  }
  if (!/^\d+$/u.test(rawThreshold)) {
    return {
      kind: 'skip',
      reason: `${LIVE_THRESHOLD_ENV} must be a whole number of USD micros.`,
    }
  }
  const alarmMicros = Number(rawThreshold)
  if (alarmMicros <= 0 || alarmMicros > MAXIMUM_THRESHOLD_MICROS) {
    return {
      kind: 'skip',
      reason:
        `${LIVE_THRESHOLD_ENV} must be from 1 through ${MAXIMUM_THRESHOLD_MICROS} USD micros.`,
    }
  }

  const apiKey = environment[LIVE_KEY_ENV]?.trim()
  if (!apiKey) {
    return { kind: 'skip', reason: `${LIVE_KEY_ENV} is not set.` }
  }

  return { kind: 'run', apiKey, alarmMicros }
}

/**
 * What became of the provider session, reported from the cleanup itself.
 *
 * Deliberately only what the cleanup shows. Richer-sounding values were tried
 * and withdrawn: "never created" cannot be inferred from a missing meter,
 * because a create whose body was unreadable can still yield an id, stop
 * cleanly, and leave the meter unavailable. Whether a page was read and where
 * the figures came from are reported separately, as the separate facts they are.
 */
export type BrowserUseLiveSessionOutcome =
  /** The provider confirmed this session stopped. */
  | 'stopped'
  /** A named session was not confirmed stopped, and may still be billing. */
  | 'not-stopped'
  /** A session may exist and cannot be named. */
  | 'indeterminate'

export function describeLiveSessionOutcome(input: {
  readonly stopped: boolean
  readonly warningKind?: 'session-not-stopped' | 'session-indeterminate'
}): BrowserUseLiveSessionOutcome {
  if (input.stopped) return 'stopped'
  return input.warningKind === 'session-not-stopped' ? 'not-stopped' : 'indeterminate'
}

export function hasObservedBrowserResearch(input: {
  readonly localActivities: readonly {
    readonly action: string
    readonly state: string
    readonly agentPath: string
  }[]
  readonly cloudAttempts: readonly {
    readonly method: string
    readonly outcome: string
  }[]
}): boolean {
  return (
    input.localActivities.some(
      (activity) =>
        activity.agentPath === 'agents/web-researcher' &&
        activity.state === 'completed' &&
        ['open', 'observe', 'read_content'].includes(activity.action),
    ) ||
    input.cloudAttempts.some(
      (attempt) =>
        attempt.method === 'cloud-browser' && attempt.outcome === 'usable',
    )
  )
}

/**
 * What the live check reports, with nothing in it that must not be written down.
 *
 * No key, no endpoint, no session id, no page content — only what the run cost,
 * whether it read anything, and what became of its session.
 */
export interface BrowserUseLiveResult {
  readonly sessionOutcome: BrowserUseLiveSessionOutcome
  readonly connected: boolean
  readonly meterSource: string
  readonly browserCostMicros: number
  readonly proxyCostMicros: number
  /** False when the provider-reported cost exceeded the operator's alarm. */
  readonly withinAlarm: boolean
  readonly proxyCountry: string
  /** Present only when the run could not complete. */
  readonly failure?: string
}
