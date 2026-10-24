/**
 * The contracts a cloud browser rung adds to acquisition.
 *
 * They are separate from `AcquisitionBrowserRuntime` on purpose. That shape
 * describes a Chrome this process launched — a driver, a driver version, and
 * one of two local launch profiles — and none of those words are true of a
 * browser someone else runs. Recording a remote session in it would corrupt the
 * exact field the Phase 1 launch-profile bake-off compares.
 */

/** Providers this repository knows how to reach. Deliberately one. */
export type CloudBrowserProvider = 'browser-use'

/**
 * Where the numbers in a runtime record came from.
 *
 * A cost the provider confirmed at stop and a cost last seen on the create
 * response are different claims, and a spend threshold that cannot tell them
 * apart would treat a stale zero as a confirmed zero.
 */
export type CloudMeterSource =
  /** The stop response was valid and its meter was used. */
  | 'stop-confirmed'
  /** Stop did not confirm; these are the last figures the provider gave us. */
  | 'create-last-known'
  /** No usable figures were ever obtained. */
  | 'unavailable'

/**
 * What a cloud attempt cost and what became of its session.
 *
 * Non-secret by construction, and guarded exact-key for the same reason
 * `AcquisitionBrowserRuntime` is: the guarded object is the one that is kept, so
 * a guard that ignored unknown keys would let an endpoint, a key, or a slice of
 * page data ride into a receipt on an otherwise valid object.
 *
 * Every cost is **provider-reported**, parsed from the decimal strings the API
 * returns. Nothing multiplies elapsed time by a configured rate: that would be a
 * local estimate wearing a measurement's name.
 */
export interface AcquisitionCloudBrowserRuntime {
  readonly provider: CloudBrowserProvider
  /** The requested exit country, or `none` when the session ran unproxied. */
  readonly proxyCountry: string
  /** USD micros, from `browserCost`. */
  readonly browserCostMicros: number
  /** USD micros, from `proxyCost`. */
  readonly proxyCostMicros: number
  /**
   * Thousandths of the provider's own `proxyUsedMb` unit.
   *
   * Deliberately not converted to kilobytes: the provider does not document
   * whether its megabyte is decimal or binary, and a factor-of-1024 guess baked
   * into a stored field is a silent 2.4% error nobody would ever look for.
   */
  readonly proxyUsedMilliMb: number
  /** The provider's terminal status, or `unknown` when stop did not confirm. */
  readonly sessionStatus: 'stopped' | 'active' | 'unknown'
  readonly meterSource: CloudMeterSource
}

const CLOUD_BROWSER_RUNTIME_KEYS: readonly string[] = [
  'provider',
  'proxyCountry',
  'browserCostMicros',
  'proxyCostMicros',
  'proxyUsedMilliMb',
  'sessionStatus',
  'meterSource',
]

export function isAcquisitionCloudBrowserRuntime(
  value: unknown,
): value is AcquisitionCloudBrowserRuntime {
  if (!isExactRecord(value, CLOUD_BROWSER_RUNTIME_KEYS)) return false
  return (
    value.provider === 'browser-use' &&
    isRecordedProxyCountry(value.proxyCountry) &&
    isCountedInteger(value.browserCostMicros) &&
    isCountedInteger(value.proxyCostMicros) &&
    isCountedInteger(value.proxyUsedMilliMb) &&
    (value.sessionStatus === 'stopped' ||
      value.sessionStatus === 'active' ||
      value.sessionStatus === 'unknown') &&
    (value.meterSource === 'stop-confirmed' ||
      value.meterSource === 'create-last-known' ||
      value.meterSource === 'unavailable')
  )
}

/**
 * Why a session could not be confirmed stopped.
 *
 * An operator signal, not receipt telemetry. A session that was not stopped
 * keeps billing until its provider timeout, so the response has to be something
 * a person can act on.
 *
 * The two shapes are genuinely different situations and must not be collapsed.
 * When a create response came back we hold an id and can name the session in the
 * provider console. When it never came back there is no id to give, and claiming
 * one would be a fabrication; the only correlation available is that a session
 * may have been created around this moment and will self-stop after the timeout
 * we requested.
 */
export type CloudSessionCleanupWarning =
  | {
      readonly kind: 'session-not-stopped'
      readonly provider: CloudBrowserProvider
      readonly sessionId: string
      /**
       * When the provider stops the session on its own.
       *
       * Absent when the create response did not carry a readable one. No
       * absolute time is invented in that case; `providerTimeoutMinutes` is the
       * bound that is actually known.
       */
      readonly timeoutAt?: string
      /** The timeout requested at create, which bounds any session created. */
      readonly providerTimeoutMinutes: number
      readonly failure:
        | 'stop_rejected'
        | 'stop_timed_out'
        | 'stop_unreachable'
        /** Stop answered about a different session, or did not report it stopped. */
        | 'stop_unconfirmed'
    }
  | {
      readonly kind: 'session-indeterminate'
      readonly provider: CloudBrowserProvider
      /** The timeout requested at create, which bounds any session that exists. */
      readonly providerTimeoutMinutes: number
      readonly failure: 'create_response_lost'
    }

export interface CloudSessionCleanup {
  readonly stopped: boolean
  /** Present only when `stopped` is false. */
  readonly warning?: CloudSessionCleanupWarning
}

export type CloudSessionFailureCode =
  /** The caller withdrew. */
  | 'cancelled'
  /** The agent domain policy refused the URL before any session existed. */
  | 'policy_denied'
  /** This process was configured in a way the provider could not honour. */
  | 'provider_request_invalid'
  /** The provider could not be reached, or refused the request. */
  | 'provider_unavailable'
  /** The provider answered with something this client will not trust. */
  | 'provider_response_invalid'
  /** A session existed but was unusable, so nothing was read through it. */
  | 'provider_session_unusable'
  /** The work done through the session failed. */
  | 'provider_session_failed'

export interface CloudSessionFailure {
  readonly code: CloudSessionFailureCode
  readonly message: string
}

/**
 * The result of one bracketed provider session.
 *
 * `runtime` and `cleanup` are always present, including on failure, because
 * what a failed attempt cost and whether its session was closed are exactly the
 * facts a failure has to report.
 */
export interface CloudSessionOutcome<T> {
  readonly value?: T
  readonly failure?: CloudSessionFailure
  readonly runtime: AcquisitionCloudBrowserRuntime
  readonly cleanup: CloudSessionCleanup
}

/** The live session handed to the work that runs inside the bracket. */
export interface CloudBrowserSession {
  readonly id: string
  readonly cdpUrl: string
  readonly timeoutAt: string
}

/**
 * The only exit values production writes.
 *
 * This field lands in persisted telemetry documented as non-secret by
 * construction, and a guard that took any non-empty string would let an
 * arbitrary one ride in on an otherwise valid object.
 */
function isRecordedProxyCountry(value: unknown): boolean {
  return value === 'none' || (typeof value === 'string' && /^[a-z]{2}$/u.test(value))
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) return false
  const present = Object.keys(value)
  return (
    present.length === keys.length && present.every((key) => keys.includes(key))
  )
}

function isCountedInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
