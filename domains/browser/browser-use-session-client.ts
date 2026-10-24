import { fetch } from 'undici'
import { z } from 'zod'

import {
  cdpEndpointAllowed,
  decimalToMicrosCeiling,
  decimalToMilliUnitsCeiling,
  DECIMAL_PATTERN,
  DEFAULT_CDP_HOST_ALLOWLIST,
} from './cloud-browser-metering.js'
import type {
  AcquisitionCloudBrowserRuntime,
  CloudBrowserSession,
  CloudMeterSource,
  CloudSessionCleanup,
  CloudSessionCleanupWarning,
  CloudSessionFailure,
  CloudSessionOutcome,
} from './cloud-browser-types.js'

/**
 * The Browser Use V4 direct-browser session lifecycle.
 *
 * The class exists to make one guarantee structural rather than a caller's
 * obligation: a created session is always stopped. The provider documents that
 * `browser.close()` and disconnecting CDP do **not** stop a managed browser —
 * only `PATCH {action:'stop'}` does — so an un-bracketed create is a resource
 * that bills until its provider timeout. `withSession` owns both ends of that
 * bracket and never hands a bare session to a caller who might forget.
 *
 * Three consequences follow, and each one is a place this was got wrong first:
 *
 * - **Neither the create nor the stop request rides the caller's signal.** Stop
 *   is the response to cancellation, so cancelling it would cancel the request
 *   that ends the spending. Create is subtler: cancelling it discards the reply
 *   carrying the session id, leaving a live session nobody can name. Both run
 *   under this client's own bounds, and cancellation is honoured *between* them.
 * - **A stop is confirmed, not assumed.** The response has to be about this
 *   session and has to say it stopped.
 * - **Confirmation and metering are separate claims.** A cost we cannot parse
 *   must not make us report a demonstrably stopped session as still billing.
 */

const DEFAULT_ENDPOINT = 'https://api.browser-use.com'
const BROWSERS_PATH = '/api/v4/browsers'
const MAX_RESPONSE_BYTES = 64 * 1_024
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_STOP_TIMEOUT_MS = 10_000
const DEFAULT_PER_CALL_BUDGET_MS = 60_000
const MIN_PROVIDER_TIMEOUT_MINUTES = 1
const MAX_PROVIDER_TIMEOUT_MINUTES = 240
const PROVIDER_DEFAULT_COUNTRY = 'us'
const UNPROXIED_COUNTRY = 'none'

/**
 * The shape a proxy country code has to have.
 *
 * The V4 reference calls the field an enum but does not publish its members, so
 * this validates the shape and leaves membership to the provider. Inventing a
 * list here would reject countries an account can actually use.
 */
const COUNTRY_CODE_PATTERN = /^[a-z]{2}$/u

/**
 * Any UUID version.
 *
 * The id is an opaque provider token that this client only puts in a URL path
 * and an operator warning, so what matters is that it is a safe fixed-shape
 * token. Pinning a version would reject a good v7 id the day one is issued.
 */
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * The same decimal shapes the conversion accepts, from one definition.
 *
 * These had drifted: the schema required a leading digit and a fractional part,
 * so `+0.5` and `.5` were rejected here before the conversion that documents
 * and tests them ever saw them — turning a perfectly good stop meter into
 * `create-last-known`.
 */
const decimalString = z.string().regex(DECIMAL_PATTERN)
/**
 * An ISO 8601 date-time, which is what the provider documents.
 *
 * `Date.parse` alone is far looser — it accepts `"March 5, 2026"` and a pile of
 * implementation-defined formats — so a field promised as ISO is checked as ISO.
 */
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u

const timestamp = z
  .string()
  .regex(ISO_TIMESTAMP_PATTERN)
  .refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp')

/**
 * The least a response must contain before cleanup can act on it.
 *
 * Kept separate from the full schema so a body that is invalid in some other
 * field still yields the id needed to stop the session it describes. A live
 * session is not less real for having arrived with a malformed cost.
 */
const recoverableSchema = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
})

/**
 * The timeout, read separately and allowed to be missing.
 *
 * Deliberately not part of `recoverableSchema`: a `timeoutAt` that is present
 * and malformed must not cost us the id beside it. The id is the only field
 * stopping needs, and a real, billing session would otherwise be left
 * unstoppable because a field nothing stops with was wrong.
 */
const recoverableTimeoutSchema = z.object({ timeoutAt: timestamp })

/** Enough to decide whether a stop actually happened. */
const stopConfirmationSchema = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
  status: z.enum(['active', 'stopped']),
})

/** Enough to record what a session cost. */
const meterSchema = z.object({
  status: z.enum(['active', 'stopped']),
  proxyUsedMb: decimalString,
  proxyCost: decimalString,
  browserCost: decimalString,
})

const sessionSchema = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
  status: z.enum(['active', 'stopped']),
  cdpUrl: z.string().nullish(),
  startedAt: timestamp,
  timeoutAt: timestamp,
  finishedAt: timestamp.nullish(),
  proxyUsedMb: decimalString,
  proxyCost: decimalString,
  browserCost: decimalString,
})

type ProviderSession = z.infer<typeof sessionSchema>

/** A session this client can stop, whether or not it can drive it. */
interface StoppableSession {
  readonly id: string
  /** Absent when the create response carried no readable one. */
  readonly timeoutAt?: string
}

type CreateResult =
  /** Valid and complete: the session can be driven. */
  | { readonly kind: 'created'; readonly session: ProviderSession }
  /**
   * A session exists and can be stopped, but its body is not one we will drive.
   */
  | {
      readonly kind: 'unusable'
      readonly session: StoppableSession
      readonly failure: CloudSessionFailure
    }
  /** No session was created. Nothing to stop. */
  | { readonly kind: 'refused'; readonly failure: CloudSessionFailure }
  /** A session may exist and cannot be named. */
  | { readonly kind: 'indeterminate'; readonly failure: CloudSessionFailure }

type BodyRead =
  | { readonly kind: 'body'; readonly text: string }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'unreadable' }

export interface BrowserUseSessionClientOptions {
  readonly apiKey: string
  /** Defaults to the public API. Overridden by tests and by self-hosting. */
  readonly endpoint?: string
  /**
   * The exit country to request, or `null` to disable the provider proxy.
   *
   * `undefined` is not the same as `null`: the provider defaults to `us`, so
   * this client sends an explicit value rather than letting the recorded
   * runtime disagree with what the provider actually did.
   */
  readonly proxyCountryCode?: string | null
  /** The longest one acquisition may take. Sets the provider-side timeout. */
  readonly perCallBudgetMs?: number
  readonly requestTimeoutMs?: number
  readonly stopTimeoutMs?: number
  /** Hosts a CDP endpoint may live on. See `DEFAULT_CDP_HOST_ALLOWLIST`. */
  readonly cdpHostAllowlist?: readonly string[]
  readonly onCleanupWarning?: (warning: CloudSessionCleanupWarning) => void
  /**
   * The **hostname** of the control endpoint the provider returned.
   *
   * Called before the allowlist decides, because the case worth diagnosing is
   * precisely the one where the endpoint is rejected: an operator told to widen
   * the allowlist needs to know what to widen it to. Only the hostname is
   * passed — never the full endpoint, its path, or its query, which can carry a
   * session token.
   */
  readonly onCdpEndpointHost?: (hostname: string) => void
}

export class BrowserUseSessionClient {
  private readonly endpoint: string
  private readonly cdpHostAllowlist: readonly string[]

  constructor(private readonly options: BrowserUseSessionClientOptions) {
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/u, '')
    this.cdpHostAllowlist = options.cdpHostAllowlist ?? DEFAULT_CDP_HOST_ALLOWLIST
  }

  /**
   * Checks that the credential can read the provider's browser collection.
   *
   * A GET proves authentication without creating a session. The response body
   * is bounded and drained, but its contents are deliberately ignored because
   * no list field is needed to answer the credential question.
   */
  async validateCredential(): Promise<void> {
    let response: Awaited<ReturnType<typeof fetch>>
    try {
      response = await fetch(
        `${this.endpoint}${BROWSERS_PATH}?pageSize=1&pageNumber=1`,
        {
          method: 'GET',
          signal: AbortSignal.timeout(
            positiveMs(this.options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
          ),
          headers: this.headers(),
        },
      )
    } catch (cause) {
      throw new Error('Browser Use could not be reached for credential validation.', {
        cause,
      })
    }
    const read = await readBounded(response)
    if (!response.ok) {
      throw new Error(
        `Browser Use rejected the credential with HTTP ${response.status}.`,
      )
    }
    if (read.kind !== 'body') {
      throw new Error('Browser Use returned an unreadable credential response.')
    }
  }

  /**
   * Runs `run` against a freshly created provider session and always stops it.
   *
   * Never throws for a provider or run failure: the outcome carries the typed
   * failure alongside the metering and cleanup facts, because what an attempt
   * cost and whether its session closed are what a failure has to report.
   */
  async withSession<T>(
    run: (session: CloudBrowserSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<CloudSessionOutcome<T>> {
    const proxyCountry = this.proxyCountry()

    const misconfigured = this.invalidConfiguration()
    if (misconfigured) {
      return {
        failure: misconfigured,
        runtime: emptyRuntime(proxyCountry),
        cleanup: { stopped: true },
      }
    }

    // Withdrawn before we spent anything. Issuing the create call here would
    // bill for a session the caller has already stopped waiting for.
    if (signal?.aborted) {
      return {
        failure: cancelled(),
        runtime: emptyRuntime(proxyCountry),
        cleanup: { stopped: true },
      }
    }

    const created = await this.createSession()
    if (created.kind === 'refused') {
      return {
        failure: created.failure,
        runtime: emptyRuntime(proxyCountry),
        cleanup: { stopped: true },
      }
    }
    if (created.kind === 'indeterminate') {
      return {
        failure: created.failure,
        runtime: emptyRuntime(proxyCountry),
        cleanup: this.warn({
          kind: 'session-indeterminate',
          provider: 'browser-use',
          providerTimeoutMinutes: this.providerTimeoutMinutes(),
          failure: 'create_response_lost',
        }),
      }
    }

    const lastKnown =
      created.kind === 'created' ? meterFrom(created.session, proxyCountry, 'create-last-known') : undefined

    let value: T | undefined
    let failure: CloudSessionFailure | undefined

    if (created.kind === 'created' && created.session.status !== 'active') {
      // Already finished. There is no browser behind it whatever the endpoint
      // field still says, and asking the provider to stop what it just called
      // stopped invites a rejection this client would then report as a session
      // that may still be billing.
      return {
        failure: {
          code: 'provider_session_unusable',
          message: 'The cloud browser session was not active.',
        },
        runtime:
          meterFrom(created.session, proxyCountry, 'create-last-known') ??
          emptyRuntime(proxyCountry),
        cleanup: { stopped: true },
      }
    }

    if (created.kind === 'unusable') {
      failure = created.failure
    } else if (signal?.aborted) {
      // The caller withdrew while create was in flight. The session is real, so
      // it is stopped below; it is simply never driven.
      failure = cancelled()
    } else {
      const usable = this.usableCdpUrl(created.session)
      if (!usable) {
        failure = {
          code: 'provider_session_unusable',
          message: 'The cloud browser session exposed no usable control endpoint.',
        }
      } else {
        try {
          value = await run({
            id: created.session.id,
            cdpUrl: usable,
            timeoutAt: created.session.timeoutAt,
          })
        } catch (error) {
          failure = signal?.aborted
            ? cancelled()
            : {
                code: 'provider_session_failed',
                message: `The cloud browser read failed: ${redact(error)}`,
              }
        }
      }
    }

    // Outside every guard above and never given the caller's signal. This is
    // the call that stops the meter.
    const stopped = await this.stopSession(created.session, proxyCountry, lastKnown)

    return {
      ...(value === undefined ? {} : { value }),
      ...(failure ? { failure } : {}),
      runtime: stopped.runtime,
      cleanup: stopped.cleanup,
    }
  }

  private proxyCountry(): string {
    const configured = this.options.proxyCountryCode
    if (configured === null) return UNPROXIED_COUNTRY
    return configured ?? PROVIDER_DEFAULT_COUNTRY
  }

  /**
   * The provider-side timeout, in whole minutes.
   *
   * Kept as small as the per-call budget allows, because it is the only thing
   * that stops a session whose stop request never lands.
   */
  private providerTimeoutMinutes(): number {
    const budget = positiveMs(
      this.options.perCallBudgetMs,
      DEFAULT_PER_CALL_BUDGET_MS,
    )
    return Math.min(
      MAX_PROVIDER_TIMEOUT_MINUTES,
      Math.max(MIN_PROVIDER_TIMEOUT_MINUTES, Math.ceil(budget / 60_000)),
    )
  }

  /**
   * Rejects a configuration the provider could not honour.
   *
   * Checked before the first request, because the failure mode otherwise is a
   * `timeout: null` in the request body or a `RangeError` from a timer, and the
   * catch around create would report that local mistake as a possibly-billing
   * session of unknown fate.
   */
  private invalidConfiguration(): CloudSessionFailure | undefined {
    const country = this.options.proxyCountryCode
    if (
      country !== null &&
      country !== undefined &&
      !COUNTRY_CODE_PATTERN.test(country)
    ) {
      return {
        code: 'provider_request_invalid',
        message: 'The configured cloud browser proxy country is not a country code.',
      }
    }
    return undefined
  }

  private usableCdpUrl(session: ProviderSession): string | undefined {
    if (!session.cdpUrl) return undefined
    this.observeCdpHost(session.cdpUrl)
    return cdpEndpointAllowed(session.cdpUrl, this.cdpHostAllowlist)
      ? session.cdpUrl
      : undefined
  }

  /** Reports the endpoint's hostname, and nothing else about it. */
  private observeCdpHost(cdpUrl: string): void {
    const observer = this.options.onCdpEndpointHost
    if (!observer) return
    let hostname = ''
    try {
      hostname = new URL(cdpUrl).hostname
    } catch {
      hostname = ''
    }
    try {
      observer(hostname)
    } catch {
      // An observer is a diagnostic. It does not get to fail the acquisition.
    }
  }

  /**
   * Creates a session under this client's own request bound.
   *
   * Deliberately takes no caller signal: a cancelled create throws away the
   * reply carrying the session id, and a session whose id we never learned is
   * one nobody can stop. Cancellation is honoured by the caller of this method,
   * after the id is safely in hand.
   */
  private async createSession(): Promise<CreateResult> {
    try {
      const response = await fetch(`${this.endpoint}${BROWSERS_PATH}`, {
        method: 'POST',
        signal: AbortSignal.timeout(
          positiveMs(this.options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
        ),
        headers: this.headers(),
        body: JSON.stringify({
          proxyCountryCode:
            this.options.proxyCountryCode === null
              ? null
              : this.options.proxyCountryCode ?? PROVIDER_DEFAULT_COUNTRY,
          timeout: this.providerTimeoutMinutes(),
        }),
      })
      const read = await readBounded(response)
      const text = read.kind === 'body' ? read.text : ''
      if (!response.ok) {
        const failure: CloudSessionFailure = {
          code: 'provider_unavailable',
          message: `The cloud browser provider returned HTTP ${response.status}.`,
        }
        // Some failures still name the session they made, and that id is the
        // only thing that can stop it.
        const named = parseWith(recoverableSchema, text)
        if (named) {
          const recoveredTimeout = parseWith(recoverableTimeoutSchema, text)
          return {
            kind: 'unusable',
            session: {
              id: named.id,
              ...(recoveredTimeout ? { timeoutAt: recoveredTimeout.timeoutAt } : {}),
            },
            failure,
          }
        }
        // A 4xx is the provider declining before it made anything; warning about
        // an orphan there would cry wolf on every bad key. A 5xx can arrive
        // *after* a session was committed, so "nothing was created" is not a
        // fact this end knows — and stating it would hide a billing orphan.
        return response.status >= 500
          ? { kind: 'indeterminate', failure }
          : { kind: 'refused', failure }
      }
      const session = parseWith(sessionSchema, text)
      if (session) return { kind: 'created', session }

      const invalid: CloudSessionFailure = {
        code: 'provider_response_invalid',
        message:
          read.kind === 'oversized'
            ? 'The cloud browser provider returned an oversized session response.'
            : 'The cloud browser provider returned an unusable session response.',
      }
      const recoverable = parseWith(recoverableSchema, text)
      if (!recoverable) return { kind: 'indeterminate', failure: invalid }
      const recoveredTimeout = parseWith(recoverableTimeoutSchema, text)
      return {
        kind: 'unusable',
        session: {
          id: recoverable.id,
          ...(recoveredTimeout ? { timeoutAt: recoveredTimeout.timeoutAt } : {}),
        },
        failure: invalid,
      }
    } catch (error) {
      // The request left this process. Whether it created a session is exactly
      // what we do not know, so we say so rather than assume.
      return {
        kind: 'indeterminate',
        failure: {
          code: 'provider_unavailable',
          message: `The cloud browser provider could not be reached: ${redact(error)}`,
        },
      }
    }
  }

  private async stopSession(
    session: StoppableSession,
    proxyCountry: string,
    lastKnown: AcquisitionCloudBrowserRuntime | undefined,
  ): Promise<{
    readonly runtime: AcquisitionCloudBrowserRuntime
    readonly cleanup: CloudSessionCleanup
  }> {
    const fallback = lastKnown ?? emptyRuntime(proxyCountry)
    try {
      const response = await fetch(
        `${this.endpoint}${BROWSERS_PATH}/${encodeURIComponent(session.id)}`,
        {
          method: 'PATCH',
          // The client's own bound. Never the caller's signal.
          signal: AbortSignal.timeout(
            positiveMs(this.options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS),
          ),
          headers: this.headers(),
          body: JSON.stringify({ action: 'stop' }),
        },
      )
      const read = await readBounded(response)
      if (!response.ok || read.kind !== 'body') {
        return { runtime: fallback, cleanup: this.notStopped(session, 'stop_rejected') }
      }

      const confirmation = parseWith(stopConfirmationSchema, read.text)
      const confirmed =
        confirmation !== undefined &&
        confirmation.id === session.id &&
        confirmation.status === 'stopped'
      if (!confirmed) {
        return { runtime: fallback, cleanup: this.notStopped(session, 'stop_unconfirmed') }
      }

      // Metering is a separate claim from confirmation. An unreadable cost does
      // not un-stop a session the provider just told us it stopped, so the
      // status follows the confirmation while the figures fall back to the last
      // ones the provider gave us.
      const meter = parseWith(meterSchema, read.text)
      const measured = meter
        ? meterFrom(meter, proxyCountry, 'stop-confirmed')
        : undefined
      const runtime = measured ?? { ...fallback, sessionStatus: 'stopped' as const }
      return { runtime, cleanup: { stopped: true } }
    } catch (error) {
      return {
        runtime: fallback,
        cleanup: this.notStopped(
          session,
          isTimeout(error) ? 'stop_timed_out' : 'stop_unreachable',
        ),
      }
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-browser-use-api-key': this.options.apiKey,
    }
  }

  private notStopped(
    session: StoppableSession,
    failure: Extract<
      CloudSessionCleanupWarning,
      { kind: 'session-not-stopped' }
    >['failure'],
  ): CloudSessionCleanup {
    return this.warn({
      kind: 'session-not-stopped',
      provider: 'browser-use',
      sessionId: session.id,
      ...(session.timeoutAt === undefined ? {} : { timeoutAt: session.timeoutAt }),
      providerTimeoutMinutes: this.providerTimeoutMinutes(),
      failure,
    })
  }

  private warn(warning: CloudSessionCleanupWarning): CloudSessionCleanup {
    try {
      this.options.onCleanupWarning?.(warning)
    } catch {
      // A broken operator channel is not a reason to lose the acquisition, nor
      // to lose the record that a session may still be billing.
    }
    return { stopped: false, warning }
  }
}

/**
 * A duration this process can actually use.
 *
 * `NaN`, a negative number, and `Infinity` all reach the API as something the
 * timer or the request body cannot represent, so they fall back to the default
 * rather than travelling any further.
 */
function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function cancelled(): CloudSessionFailure {
  return { code: 'cancelled', message: 'Cloud browser acquisition was cancelled.' }
}

function emptyRuntime(proxyCountry: string): AcquisitionCloudBrowserRuntime {
  return {
    provider: 'browser-use',
    proxyCountry,
    browserCostMicros: 0,
    proxyCostMicros: 0,
    proxyUsedMilliMb: 0,
    sessionStatus: 'unknown',
    meterSource: 'unavailable',
  }
}

function meterFrom(
  meter: z.infer<typeof meterSchema>,
  proxyCountry: string,
  meterSource: CloudMeterSource,
): AcquisitionCloudBrowserRuntime | undefined {
  const browserCostMicros = decimalToMicrosCeiling(meter.browserCost)
  const proxyCostMicros = decimalToMicrosCeiling(meter.proxyCost)
  const proxyUsedMilliMb = decimalToMilliUnitsCeiling(meter.proxyUsedMb)
  if (
    browserCostMicros === undefined ||
    proxyCostMicros === undefined ||
    proxyUsedMilliMb === undefined
  ) {
    return undefined
  }
  return {
    provider: 'browser-use',
    proxyCountry,
    browserCostMicros,
    proxyCostMicros,
    proxyUsedMilliMb,
    sessionStatus: meter.status,
    meterSource,
  }
}

function parseWith<T extends z.ZodTypeAny>(
  schema: T,
  text: string,
): z.infer<T> | undefined {
  if (!text) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = schema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

async function readBounded(
  response: Awaited<ReturnType<typeof fetch>>,
): Promise<BodyRead> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    return { kind: 'oversized' }
  }
  if (!response.body) return { kind: 'unreadable' }
  // undici types the body as ReadableStream<any>; a fetch body yields bytes.
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        return { kind: 'oversized' }
      }
      chunks.push(Buffer.from(result.value))
    }
  } catch {
    return { kind: 'unreadable' }
  } finally {
    reader.releaseLock()
  }
  return { kind: 'body', text: Buffer.concat(chunks, bytes).toString('utf8') }
}

function isTimeout(error: unknown): boolean {
  if (errorName(error) === 'TimeoutError') return true
  return errorName(causeOf(error)) === 'TimeoutError'
}

/** The `name` of a thrown value, when it has a string one. */
function errorName(value: unknown): string {
  if (!isPlainRecord(value)) return ''
  const name = value.name
  return typeof name === 'string' ? name : ''
}

/** The `cause` of a thrown value, when it carries one. */
function causeOf(value: unknown): unknown {
  return isPlainRecord(value) ? value.cause : undefined
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Provider and runtime error text, reduced to its class.
 *
 * Provider errors can quote the request, which carries the endpoint and could
 * carry the key. Only the error's name crosses into a failure message.
 */
function redact(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error'
  return 'Error'
}
