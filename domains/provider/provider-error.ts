import { whenDefined } from "../../core/optional-properties.js"
import {
  PROVIDER_FAILURE_USER_MESSAGES,
  isProviderErrorKind as isSharedProviderErrorKind,
  type ProviderErrorKind,
} from '../../contracts/provider.js'
/**
 * Provider domain — error taxonomy.
 *
 * Structured provider failures stay detailed for retry policy and telemetry,
 * while user-facing surfaces receive a short, actionable message.
 */

/**
 * Re-exported so provider code keeps importing its taxonomy from one place.
 *
 * The list itself lives in `contracts/provider.ts` because the chat UI has to
 * read it too, and the UI may import only contracts. `usage_limit` is a plan or
 * account quota exhausted until a stated reset — distinct from `session_limit`
 * (a per-session cap) and from `billing` (no credits at all). The provider
 * usually states when it resets, which is the single most useful fact a user
 * can be given.
 */
export type { ProviderErrorKind } from '../../contracts/provider.js'
export { PROVIDER_ERROR_KINDS, isProviderErrorKind } from '../../contracts/provider.js'

export interface ParsedProviderError {
  readonly provider?: string
  readonly kind: ProviderErrorKind
  readonly message: string
  readonly statusCode?: number
  readonly code?: string
  readonly exitCode?: number
  readonly hasStructuredPayload: boolean
}

export interface SerializedProviderError {
  readonly type: 'provider_error'
  readonly error: string
  readonly provider: string
  readonly kind: ProviderErrorKind
  readonly statusCode?: number
  readonly code?: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
}

export class ProviderError extends Error {
  readonly provider: string
  readonly providerMessage: string
  readonly kind: ProviderErrorKind | undefined
  readonly statusCode: number | undefined
  readonly code: string | undefined
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined
  /**
   * When a usage limit ends, already resolved to an instant.
   *
   * Set when the moment was worked out somewhere this error cannot see — the
   * other side of the worker boundary, where the provider's sentence was read
   * against the clock that produced it. Carried rather than re-derived: this
   * process has a different clock and may have a different zone, and the
   * sentence states neither.
   */
  readonly resetsAt: string | undefined
  /**
   * Whether this adapter had already sent a request when it failed.
   *
   * The only place that knows. An error *category* cannot answer it: a
   * provider can fail to authenticate having already run for a while and
   * reported it at exit. `false` is a positive claim — nothing was sent — and
   * is what lets a later reader prove no effect was possible. Absent means
   * unknown, which is the answer that assumes the least.
   */
  readonly dispatched: boolean | undefined

  constructor(params: {
    provider: string
    message: string
    kind?: ProviderErrorKind
    statusCode?: number
    code?: string
    retryable: boolean
    retryAfterMs?: number
    resetsAt?: string
    dispatched?: boolean
  }) {
    const providerPrefix = `Provider '${params.provider}'`
    super(params.message.startsWith(providerPrefix)
      ? params.message
      : `${providerPrefix} failed: ${params.message}`)
    this.name = 'ProviderError'
    this.provider = params.provider
    this.providerMessage = params.message
    this.kind = params.kind
    this.statusCode = params.statusCode
    this.code = params.code
    this.retryable = params.retryable
    this.dispatched = params.dispatched
    this.retryAfterMs = params.retryAfterMs
    this.resetsAt = params.resetsAt
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Normalize API bodies, CLI JSON output, and thrown errors into one shape.
 * Raw provider payloads are intentionally not returned to UI callers.
 */
export function parseProviderError(error: unknown): ParsedProviderError {
  const providerError = error instanceof ProviderError ? error : undefined
  const errorRecord = asRecord(error)
  const directCode = typeof errorRecord?.code === 'string'
    ? errorRecord.code
    : undefined
  const sourceMessage = providerError?.providerMessage ?? errorMessage(error)
  const payload =
    parseStructuredPayload(error) ?? parseStructuredPayload(sourceMessage)
  const statusCode =
    providerError?.statusCode ?? payload?.statusCode ?? statusFromText(sourceMessage)
  const code = providerError?.code ?? directCode ?? payload?.code
  const message = payload?.message ?? stripProviderPrefix(sourceMessage)
  const exitCode = exitCodeFromText(sourceMessage)
  const kind =
    providerError?.kind ?? payload?.kind ??
    classifyUserFacingKind({ message, ...whenDefined(statusCode, (definedValue) => ({ statusCode: definedValue })), ...whenDefined(code, (definedValue) => ({ code: definedValue })), ...whenDefined(exitCode, (definedValue) => ({ exitCode: definedValue })) })

  return {
    ...(providerError?.provider ? { provider: providerError.provider } : {}),
    kind,
    message,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(code ? { code } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    hasStructuredPayload: payload !== null,
  }
}

export function serializeProviderError(
  error: ProviderError,
): SerializedProviderError {
  const parsed = parseProviderError(error)
  return {
    type: 'provider_error',
    error: parsed.message,
    provider: error.provider,
    kind: parsed.kind,
    retryable: error.retryable,
    ...(parsed.statusCode !== undefined
      ? { statusCode: parsed.statusCode }
      : {}),
    ...(parsed.code ? { code: parsed.code } : {}),
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  }
}

export function isSerializedProviderError(
  value: unknown,
): value is SerializedProviderError {
  const record = asRecord(value)
  if (!record || record.type !== 'provider_error') return false
  return typeof record.error === 'string' &&
    typeof record.provider === 'string' &&
    providerErrorKind(record.kind) !== undefined &&
    typeof record.retryable === 'boolean' &&
    (record.statusCode === undefined ||
      (typeof record.statusCode === 'number' &&
        validStatusCode(record.statusCode) !== undefined)) &&
    (record.code === undefined || typeof record.code === 'string') &&
    (record.retryAfterMs === undefined ||
      (typeof record.retryAfterMs === 'number' &&
        Number.isFinite(record.retryAfterMs) && record.retryAfterMs >= 0))
}

/**
 * Produce safe chat/UI copy while retaining the most useful status reference.
 */
export function formatProviderErrorForUser(error: unknown): string {
  const parsed = parseProviderError(error)
  const message = parsed.code === 'provider_stalled'
    ? 'The provider stopped producing output and the turn was ended. Try again.'
    : parsed.kind === 'session_limit'
    ? formatSessionLimit(parsed.message)
    : parsed.kind === 'usage_limit'
      ? formatUsageLimit(parsed.message)
      : USER_MESSAGES[parsed.kind]
  return appendErrorReference(message, parsed)
}

const USER_MESSAGES = PROVIDER_FAILURE_USER_MESSAGES

const KIND_BY_CODE: Readonly<Record<string, ProviderErrorKind>> = {
  authentication_error: 'authentication',
  unauthenticated: 'authentication',
  unauthorized: 'authentication',
  invalid_api_key: 'authentication',
  permission_error: 'permission',
  permission_denied: 'permission',
  forbidden: 'permission',
  billing_error: 'billing',
  insufficient_balance: 'billing',
  insufficient_quota: 'billing',
  payment_required: 'billing',
  not_found: 'not_found',
  not_found_error: 'not_found',
  model_not_found: 'not_found',
  context_length: 'context_limit',
  context_length_exceeded: 'context_limit',
  prompt_too_long: 'context_limit',
  invalid_argument: 'invalid_request',
  invalid_request: 'invalid_request',
  invalid_request_error: 'invalid_request',
  failed_precondition: 'invalid_request',
  unprocessable_entity: 'invalid_request',
  validation_error: 'invalid_request',
  request_too_large: 'request_too_large',
  payload_too_large: 'request_too_large',
  rate_limit_error: 'rate_limit',
  rate_limit_exceeded: 'rate_limit',
  resource_exhausted: 'rate_limit',
  timeout_error: 'timeout',
  deadline_exceeded: 'timeout',
  provider_stalled: 'timeout',
  overloaded_error: 'overloaded',
  provider_overloaded: 'overloaded',
  unavailable: 'unavailable',
  provider_unavailable: 'unavailable',
  bad_gateway: 'unavailable',
  api_error: 'server_error',
  internal: 'server_error',
  internal_error: 'server_error',
  server_error: 'server_error',
  cancelled: 'cancelled',
  canceled: 'cancelled',
}

interface StructuredProviderPayload {
  readonly message?: string
  readonly kind?: ProviderErrorKind
  readonly statusCode?: number
  readonly code?: string
}

function parseStructuredPayload(value: unknown): StructuredProviderPayload | null {
  if (value instanceof Error) return null
  if (Array.isArray(value)) {
    for (const entry of [...value].reverse()) {
      const parsed = parseStructuredPayload(entry)
      if (parsed) return parsed
    }
    return null
  }
  const record = asRecord(value)
  if (record) return parseStructuredRecord(record)
  if (typeof value !== 'string') return null
  return parseStructuredText(value)
}

function parseStructuredText(value: string): StructuredProviderPayload | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const candidates = [...trimmed.split(/\r?\n/).reverse(), trimmed]
  for (const candidate of candidates) {
    const parsed = parseJson(candidate)
    if (parsed !== null) {
      const structured = parseStructuredPayload(parsed)
      if (structured) return structured
      continue
    }
    const truncated = parseTruncatedJsonFields(candidate)
    if (truncated) return truncated
  }
  return null
}

function parseStructuredRecord(
  record: Record<string, unknown>,
): StructuredProviderPayload | null {
  const nestedError = asRecord(record.error)
  const directError = typeof record.error === 'string' ? record.error : undefined
  const explicitKind = providerErrorKind(record.kind)
  const statusCode = firstStatusCode(
    record.api_error_status,
    record.status,
    record.status_code,
    record.statusCode,
    nestedError?.status,
    nestedError?.status_code,
    nestedError?.statusCode,
    typeof nestedError?.code === 'number' ? nestedError.code : undefined,
    typeof record.code === 'number' ? record.code : undefined,
  )
  const isError =
    record.is_error === true ||
    record.type === 'error' ||
    nestedError !== null ||
    directError !== undefined ||
    explicitKind !== undefined ||
    (statusCode !== undefined && statusCode >= 400)
  if (!isError) return null

  const message = firstString(
    record.is_error === true ? record.result : undefined,
    nestedError?.message,
    directError,
    record.message,
    record.detail,
  )
  const code = firstString(
    nestedError?.code,
    nestedError?.type,
    record.error_type,
    record.provider_code,
    typeof record.code === 'string' ? record.code : undefined,
    typeof record.status === 'string' ? record.status : undefined,
  )
  return {
    ...(message ? { message } : {}),
    ...(explicitKind ? { kind: explicitKind } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(code ? { code } : {}),
  }
}

function parseTruncatedJsonFields(value: string): StructuredProviderPayload | null {
  const statusCode = statusFromText(value)
  const message =
    jsonStringField(value, 'result') ??
    jsonStringField(value, 'message') ??
    jsonStringField(value, 'error')
  const code =
    jsonStringField(value, 'error_type') ??
    jsonStringField(value, 'provider_code') ??
    jsonStringField(value, 'code')
  const hasErrorMarker =
    /"is_error"\s*:\s*true\b/i.test(value) ||
    /"type"\s*:\s*"error"/i.test(value) ||
    /"error"\s*:/i.test(value) ||
    (statusCode !== undefined && statusCode >= 400)
  if (!hasErrorMarker) return null
  if (statusCode === undefined && !message && !code) return null
  return {
    ...(message ? { message } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(code ? { code } : {}),
  }
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown
  } catch {
    const firstBrace = value.indexOf('{')
    const lastBrace = value.lastIndexOf('}')
    if (firstBrace < 0 || lastBrace <= firstBrace) return null
    try {
      return JSON.parse(value.slice(firstBrace, lastBrace + 1)) as unknown
    } catch {
      return null
    }
  }
}

function classifyUserFacingKind(input: {
  message: string
  statusCode?: number
  code?: string
  exitCode?: number
}): ProviderErrorKind {
  const message = input.message.toLowerCase()
  // Checked before the usage-limit needles so a per-session cap keeps its own
  // kind and its own copy.
  if (message.includes('session limit')) return 'session_limit'
  if (hasAny(message, [
    'usage limit',
    'usage cap',
    'quota exceeded',
    'exceeded your quota',
    'hit your limit',
    'weekly limit',
    'monthly limit',
  ])) {
    return 'usage_limit'
  }
  if (hasAny(message, ['insufficient quota', 'billing', 'no credits', 'insufficient balance', 'monthly usage limit', 'period usage limit'])) {
    return 'billing'
  }
  if (hasAny(message, ['context length', 'context window', 'prompt is too long', 'too many tokens'])) {
    return 'context_limit'
  }
  const codeKind = input.code ? KIND_BY_CODE[normalizeCode(input.code)] : undefined
  if (codeKind) return codeKind
  return kindFromStatus(input.statusCode) ?? kindFromMessage(message) ??
    (input.exitCode !== undefined ? 'process_failed' : 'unknown')
}

function kindFromStatus(statusCode: number | undefined): ProviderErrorKind | undefined {
  if (statusCode === 400 || statusCode === 409 || statusCode === 415 || statusCode === 422) return 'invalid_request'
  if (statusCode === 401) return 'authentication'
  if (statusCode === 402) return 'billing'
  if (statusCode === 403) return 'permission'
  if (statusCode === 404) return 'not_found'
  if (statusCode === 408 || statusCode === 504) return 'timeout'
  if (statusCode === 413) return 'request_too_large'
  if (statusCode === 429) return 'rate_limit'
  if (statusCode === 499) return 'cancelled'
  if (statusCode === 502) return 'unavailable'
  if (statusCode === 503 || statusCode === 529) return 'overloaded'
  if (statusCode !== undefined && statusCode >= 500) return 'server_error'
  return undefined
}

function kindFromMessage(message: string): ProviderErrorKind | undefined {
  if (hasAny(message, ['cancelled', 'canceled', 'aborted', 'terminated by signal'])) return 'cancelled'
  if (hasAny(message, ['timed out', 'timeout', 'deadline exceeded'])) return 'timeout'
  if (hasAny(message, ['overloaded', 'too busy'])) return 'overloaded'
  if (hasAny(message, ['fetch failed', 'network error', 'connection refused', 'unavailable'])) return 'unavailable'
  if (hasAny(message, ['requires an api key', 'requires api key', 'not configured', 'revalidate it in settings'])) return 'configuration'
  if (hasAny(message, ['unauthorized', 'authentication failed', 'invalid api key'])) return 'authentication'
  if (hasAny(message, ['rate limit', 'too many requests'])) return 'rate_limit'
  return undefined
}

function formatSessionLimit(message: string): string {
  const reset = message.match(
    /\bresets?(?:\s+at)?\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)(?:\s*\(([^)]*)\))?/i,
  )
  if (!reset) return USER_MESSAGES.session_limit
  const hour = Number(reset[1])
  const minute = reset[2] === undefined ? undefined : Number(reset[2])
  if (hour < 1 || hour > 12 || (minute !== undefined && minute > 59)) {
    return USER_MESSAGES.session_limit
  }
  const normalizedReset = `${hour}${minute === undefined ? '' : `:${String(minute).padStart(2, '0')}`} ${reset[3]?.toUpperCase()}`
  const timeZone = safeIanaTimeZone(reset[4])
  return `You've hit your session limit. It resets at ${normalizedReset}${timeZone ? ` (${timeZone})` : ''}.`
}

const RESET_MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * Render an exhausted quota with the reset the provider actually stated.
 *
 * Mirrors `formatSessionLimit`: the reset is parsed out of free provider prose,
 * range-validated, and echoed; anything unparseable degrades to static copy
 * rather than emitting a half-formed date. The provider's URL is deliberately
 * not echoed — this function produces safe copy, and a raw provider string can
 * carry account identifiers.
 */
function formatUsageLimit(message: string): string {
  const offersCredits = /purchase more credits|buy more credits|add credits|upgrade/i
    .test(message)
  const base = "You've hit your provider usage limit."
  const creditNote = offersCredits
    ? ' You can also add credits in your provider account to continue now.'
    : ''
  const reset = readUsageLimitReset(message)
  if (reset.kind === 'absent') {
    return offersCredits
      ? `${base} Add credits in your provider account to continue.`
      : USER_MESSAGES.usage_limit
  }
  if (reset.kind === 'unreadable') {
    return `${base} Try again after it resets.${creditNote}`
  }
  return `${base} It resets on ${reset.when}.${creditNote}`
}

/**
 * When an exhausted quota resets, as the provider stated it.
 *
 * Rebuilt from the parsed date and clock rather than echoed, so what leaves
 * here is never the provider's own prose. That is what lets the worker
 * boundary carry the reset where the message itself may not go.
 */
export function usageLimitResetLabel(error: unknown): string | undefined {
  const parsed = parseProviderError(error)
  if (parsed.kind !== 'usage_limit') return undefined
  const reset = readUsageLimitReset(parsed.message)
  return reset.kind === 'stated' ? reset.when : undefined
}

/**
 * When a usage limit stops being true, as a moment rather than a sentence.
 *
 * The companion to `usageLimitResetLabel`, and deliberately not the same
 * function. A label may be approximate and still do its job; an instant that
 * is wrong either clears a real limit early or holds a dead one forever, so
 * this refuses anything it cannot read exactly.
 *
 * `readAt` is injected because the provider states a wall-clock time in the
 * user's own zone and frequently omits the year or the date altogether, so the
 * answer depends on when the message was read. Read it once, when the failure
 * happens, and store the result: re-deriving it during a replay would resolve
 * the same ambiguity against a "now" that means something else.
 */
export function usageLimitResetAt(
  error: unknown,
  readAt: Date,
): string | undefined {
  const parsed = parseProviderError(error)
  if (parsed.kind !== 'usage_limit') return undefined

  // An instant somebody already resolved outranks the sentence: it was worked
  // out where the clock and the zone were the provider's own.
  if (error instanceof ProviderError && error.resetsAt !== undefined) {
    const carried = new Date(error.resetsAt)
    if (
      Number.isFinite(carried.getTime()) &&
      carried.toISOString() === error.resetsAt
    ) {
      return error.resetsAt
    }
  }

  const dated = RESET_WITH_DATE.exec(parsed.message)
  if (dated) return datedResetAt(dated, readAt)

  const timeOnly = RESET_TIME_ONLY.exec(parsed.message)
  return timeOnly ? nextOccurrenceAt(timeOnly, readAt) : undefined
}

/**
 * A reset the provider dated, resolved against the year it may not have said.
 *
 * A stated year is taken literally, including one already past — that is a
 * limit which has since reset, which is a useful thing to know rather than an
 * error. Without one, the year closest to the reading wins, which is what
 * makes a December message read on New Year's Day land where it was meant.
 */
function datedResetAt(match: RegExpExecArray, readAt: Date): string | undefined {
  const month = RESET_MONTHS[(match[1] ?? '').slice(0, 3).toLowerCase()]
  const day = Number(match[2])
  const clock = readClock(match[4], match[5], match[6])
  if (month === undefined || !Number.isInteger(day) || !clock) return undefined

  const zone = readStatedZone(match[7])
  if (zone === 'unsupported') return undefined

  const statedYear = match[3] === undefined ? undefined : Number(match[3])
  const year = statedYear ?? nearestYear({ readAt, month, day, clock })
  // One candidate, chosen before it is checked. Searching for the nearest
  // *valid* year instead would answer a refused wall clock with the same date
  // a year earlier — a reset already in the past, which clears the very limit
  // it was meant to describe.
  return calendarDate(year, month, day, clock, zone)?.toISOString()
}

/**
 * The year a date without one meant, decided on a clock that never refuses.
 *
 * Compared in UTC, which has no transitions: the point is to pick the year the
 * provider intended, and a comparison that could itself be rejected would put
 * that decision back inside the validation it is meant to precede.
 */
function nearestYear(input: {
  readonly readAt: Date
  readonly month: number
  readonly day: number
  readonly clock: { readonly hour: number; readonly minute: number }
}): number {
  const { readAt, month, day, clock } = input
  const here = readAt.getFullYear()
  let nearest = here
  let shortest = Number.POSITIVE_INFINITY
  for (const year of [here - 1, here, here + 1]) {
    const distance = Math.abs(
      Date.UTC(year, month, day, clock.hour, clock.minute) - readAt.getTime(),
    )
    if (distance < shortest) {
      shortest = distance
      nearest = year
    }
  }
  return nearest
}

/**
 * A reset stated as a bare clock time: the next time that clock comes round.
 *
 * Codex states this form, and it is the only reading available — a time that
 * has already passed today has to mean tomorrow, or the limit would expire the
 * instant it was recorded.
 */
function nextOccurrenceAt(
  match: RegExpExecArray,
  readAt: Date,
): string | undefined {
  const clock = readClock(match[1], match[2], match[3])
  const zone = readStatedZone(match[4])
  if (!clock || zone === 'unsupported') return undefined

  // Which day it is happens before whether that day's clock exists. Comparing
  // the two wall clocks answers it without building an instant, so a clock the
  // calendar skips or repeats is refused on the day it was meant for rather
  // than silently answered with the next one.
  const readMinutes =
    zone === 'utc'
      ? readAt.getUTCHours() * 60 + readAt.getUTCMinutes()
      : readAt.getHours() * 60 + readAt.getMinutes()
  const statedMinutes = clock.hour * 60 + clock.minute
  const dayOffset = statedMinutes > readMinutes ? 0 : 1

  // Noon, purely to read a date back: midnight is itself a wall clock some
  // zones skip, and this step is not the one deciding whether a clock exists.
  const civil =
    zone === 'utc'
      ? new Date(
          Date.UTC(
            readAt.getUTCFullYear(),
            readAt.getUTCMonth(),
            readAt.getUTCDate() + dayOffset,
            12,
          ),
        )
      : new Date(
          readAt.getFullYear(),
          readAt.getMonth(),
          readAt.getDate() + dayOffset,
          12,
        )
  return (zone === 'utc'
    ? calendarDate(
        civil.getUTCFullYear(),
        civil.getUTCMonth(),
        civil.getUTCDate(),
        clock,
        zone,
      )
    : calendarDate(
        civil.getFullYear(),
        civil.getMonth(),
        civil.getDate(),
        clock,
        zone,
      )
  )?.toISOString()
}

/**
 * Which clock a stated reset is on.
 *
 * Absent is the ordinary case and means the user's own zone: the provider is
 * describing that user's account back to them. A stated zone is only honoured
 * when it needs no table to resolve — anything else is refused rather than
 * read as local, because reading `1:00 AM PST` on a machine in Berlin is not
 * an approximation of that moment, it is a different one nine hours away.
 *
 * A token that is not in capitals is not a zone claim at all; it is the next
 * word of an ordinary sentence, and the reset before it still stands.
 */
function readStatedZone(
  suffix: string | undefined,
): 'local' | 'utc' | 'unsupported' {
  if (suffix === undefined) return 'local'
  const parenthesised = suffix.startsWith('(')
  const token = suffix.replace(/[()\s]/g, '')
  if (/^(?:UTC|GMT|Z)$/i.test(token)) return 'utc'
  // A zone claim is refused whole. Reading the letters of `UTC+02:00` and
  // discarding the offset is not a partial answer, it is a different moment.
  const statesAnOffset = /[+-][0-9]/.test(token)
  const looksLikeAZone =
    parenthesised || statesAnOffset || /^[A-Z]{2,5}$/.test(token)
  return looksLikeAZone ? 'unsupported' : 'local'
}

/**
 * A moment only if the calendar and the clock both have one.
 *
 * February 30th is not a reset a day later; a Date constructor rolls it into
 * March rather than say so, which is why the date is read back rather than
 * trusted.
 *
 * Local time has two more ways to not exist. The hour a zone springs forward
 * through never happens, and a Date built from it lands an hour later without
 * complaint — so the clock is read back too. The hour a zone falls back
 * through happens twice, and nothing in the provider's sentence says which,
 * so it is refused: choosing the earlier one would expire a live limit an hour
 * early, and choosing by coin-flip is worse than saying nothing.
 */
function calendarDate(
  year: number,
  month: number,
  day: number,
  clock: { readonly hour: number; readonly minute: number },
  zone: 'local' | 'utc',
): Date | undefined {
  if (zone === 'utc') {
    const utc = new Date(Date.UTC(year, month, day, clock.hour, clock.minute))
    return utc.getUTCFullYear() === year &&
      utc.getUTCMonth() === month &&
      utc.getUTCDate() === day
      ? utc
      : undefined
  }

  const candidate = new Date(year, month, day, clock.hour, clock.minute)
  const exists =
    candidate.getFullYear() === year &&
    candidate.getMonth() === month &&
    candidate.getDate() === day &&
    candidate.getHours() === clock.hour &&
    candidate.getMinutes() === clock.minute
  if (!exists) return undefined

  const anHourLater = new Date(candidate.getTime() + 60 * 60 * 1000)
  const repeats =
    anHourLater.getHours() === clock.hour &&
    anHourLater.getMinutes() === clock.minute
  return repeats ? undefined : candidate
}

/** A 12-hour clock as hours past midnight, or nothing if it is not one. */
function readClock(
  rawHour: string | undefined,
  rawMinute: string | undefined,
  meridiem: string | undefined,
): { readonly hour: number; readonly minute: number } | undefined {
  const hour = Number(rawHour)
  const minute = Number(rawMinute)
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return undefined
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined
  const afternoon = (meridiem ?? '').toLowerCase() === 'pm'
  const onTwelve = hour === 12
  return {
    hour: afternoon ? (onTwelve ? 12 : hour + 12) : onTwelve ? 0 : hour,
    minute,
  }
}

type UsageLimitReset =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'stated'; readonly when: string }

const RESET_WITH_DATE =
  /\b(?:try again|resets?)\s+(?:at|on)?\s*([A-Za-z]{3,9})\.?\s+([0-9]{1,2})(?:st|nd|rd|th)?,?\s*([0-9]{4})?\s*,?\s*(?:at\s+)?([0-9]{1,2}):([0-9]{2})\s*(am|pm)(?:\s*(\(?[A-Za-z]{1,5}(?:\s*[+-][0-9]{1,2}(?::[0-9]{2})?)?\)?|\(?[+-][0-9]{1,2}(?::[0-9]{2})?\)?))?/i

/** The same statement with the date left out, which Codex also emits. */
const RESET_TIME_ONLY =
  /\b(?:try again|resets?)\s+(?:at|on)\s+([0-9]{1,2}):([0-9]{2})\s*(am|pm)(?:\s*(\(?[A-Za-z]{1,5}(?:\s*[+-][0-9]{1,2}(?::[0-9]{2})?)?\)?|\(?[+-][0-9]{1,2}(?::[0-9]{2})?\)?))?/i

function readUsageLimitReset(message: string): UsageLimitReset {
  const reset = RESET_WITH_DATE.exec(message)
  if (!reset) return { kind: 'absent' }
  const month = RESET_MONTHS[(reset[1] ?? '').slice(0, 3).toLowerCase()]
  const day = Number(reset[2])
  const year = reset[3] === undefined ? undefined : Number(reset[3])
  const hour = Number(reset[4])
  const minute = Number(reset[5])
  if (
    month === undefined ||
    !Number.isInteger(day) || day < 1 || day > 31 ||
    !Number.isInteger(hour) || hour < 1 || hour > 12 ||
    !Number.isInteger(minute) || minute > 59
  ) {
    return { kind: 'unreadable' }
  }
  const date = new Date(Date.UTC(year ?? 2000, month, day))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const clock = `${hour}:${String(minute).padStart(2, '0')} ${(reset[6] ?? '').toUpperCase()}`
  return {
    kind: 'stated',
    when: year === undefined ? `${date} at ${clock}` : `${date}, ${year} at ${clock}`,
  }
}

function appendErrorReference(message: string, error: ParsedProviderError): string {
  if (error.statusCode !== undefined) return `${message} (Status ${error.statusCode})`
  const code = safeUserFacingCode(error.code)
  if (code) return `${message} (Code ${code})`
  if (error.exitCode !== undefined) return `${message} (Exit ${error.exitCode})`
  return message
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function stripProviderPrefix(message: string): string {
  let result = message.trim()
  while (/^Provider '[^']+' failed:\s*/i.test(result)) {
    result = result.replace(/^Provider '[^']+' failed:\s*/i, '')
  }
  return result
}

function statusFromText(value: string): number | undefined {
  const match = value.match(
    /(?:api_error_status|status(?:_code|Code)?)["']?\s*[:=]?\s*(\d{3})\b/i,
  )
  const statusCode = match ? validStatusCode(Number(match[1])) : undefined
  return statusCode !== undefined && statusCode >= 400 ? statusCode : undefined
}

function exitCodeFromText(value: string): number | undefined {
  const match = value.match(/\bexited with code\s+(\d+)\b/i)
  return match ? Number(match[1]) : undefined
}

function jsonStringField(value: string, field: string): string | undefined {
  const pattern = new RegExp(`"${field}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'i')
  const match = value.match(pattern)
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(match[1]) as string
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstStatusCode(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'number') continue
    const statusCode = validStatusCode(value)
    if (statusCode !== undefined) return statusCode
  }
  return undefined
}

function validStatusCode(value: number): number | undefined {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * A provider-supplied error code, only if it is actually a code.
 *
 * A provider chooses this string, and the runtime keeps it in durable
 * diagnostics, so an unbounded one is a channel for prose, an echoed prompt,
 * or a credential. Anything that is not a short identifier is dropped: the
 * status, the normalized kind, and the retry policy still answer the
 * operator's question without it.
 */
export function boundedProviderCode(code: string | undefined): string | undefined {
  const value = code?.trim()
  return value && PROVIDER_CODE_PATTERN.test(value) ? value : undefined
}

const PROVIDER_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

function safeUserFacingCode(code: string | undefined): string | undefined {
  const value = code?.trim()
  if (!value || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) return undefined
  return Object.prototype.hasOwnProperty.call(KIND_BY_CODE, normalizeCode(value))
    ? value
    : undefined
}

function providerErrorKind(value: unknown): ProviderErrorKind | undefined {
  return isSharedProviderErrorKind(value) ? value : undefined
}

function safeIanaTimeZone(value: string | undefined): string | undefined {
  const timeZone = value?.trim()
  // IANA names are short slash-delimited identifiers; reject free-form provider text first.
  if (!timeZone || timeZone.length > 64 ||
      !/^[a-z0-9._+-]+(?:\/[a-z0-9._+-]+)*$/i.test(timeZone)) {
    return undefined
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return timeZone
  } catch {
    return undefined
  }
}

function hasAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle))
}

/**
 * Classify an HTTP status code and optional provider error code into retry guidance.
 */
export function classifyProviderError(params: {
  provider: string
  statusCode?: number
  code?: string
  kind?: ProviderErrorKind
  message: string
  retryAfterHeader?: string | null
}): { retryable: boolean; retryAfterMs?: number } {
  const { statusCode, code, retryAfterHeader } = params
  const kind = params.kind ?? classifyUserFacingKind({
    message: params.message,
    ...whenDefined(statusCode, (definedValue) => ({ statusCode: definedValue })),
    ...whenDefined(code, (definedValue) => ({ code: definedValue })),
  })

  if (NON_RETRYABLE_KINDS.has(kind) || (params.kind !== undefined && kind === 'unknown')) {
    return { retryable: false }
  }

  if (RETRYABLE_KINDS.has(kind)) {
    return {
      retryable: true,
      ...whenDefined(kind === 'rate_limit'
        ? parseRetryAfter(retryAfterHeader)
        : undefined, (retryAfterMs) => ({ retryAfterMs })),
    }
  }

  if ([400, 401, 402, 403, 404, 409, 413, 415, 422].includes(statusCode ?? 0)) {
    return { retryable: false }
  }

  if (code) {
    const kind = KIND_BY_CODE[normalizeCode(code)]
    if (['authentication', 'permission', 'billing', 'not_found', 'context_limit', 'invalid_request', 'request_too_large'].includes(kind ?? '')) {
      return { retryable: false }
    }
  }

  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(retryAfterHeader)
    return {
      retryable: true,
      ...whenDefined(retryAfterMs, (presentRetryAfterMs) => ({
        retryAfterMs: presentRetryAfterMs,
      })),
    }
  }

  if (
    statusCode === undefined ||
    statusCode === 408 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    statusCode === 529
  ) {
    return { retryable: true }
  }

  if (statusCode >= 400 && statusCode < 500) return { retryable: false }
  return { retryable: true }
}

const NON_RETRYABLE_KINDS = new Set<ProviderErrorKind>([
  'session_limit',
  // Retrying before the stated reset consumes the run's budget and cannot
  // succeed, so this must never reach an automatic retry path.
  'usage_limit',
  'authentication',
  'permission',
  'billing',
  'not_found',
  'context_limit',
  'invalid_request',
  'request_too_large',
  'cancelled',
  'configuration',
  'process_failed',
])

const RETRYABLE_KINDS = new Set<ProviderErrorKind>([
  'rate_limit',
  'timeout',
  'overloaded',
  'unavailable',
  'server_error',
])

function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined
  const seconds = Number.parseInt(header, 10)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isFinite(date)) return undefined
  const delta = date - Date.now()
  return delta > 0 ? delta : undefined
}
