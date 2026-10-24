/**
 * Provider Error Taxonomy Tests
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ProviderError,
  classifyProviderError,
  formatProviderErrorForUser,
  isSerializedProviderError,
  parseProviderError,
  serializeProviderError,
  usageLimitResetAt,
  usageLimitResetLabel,
} from '../../domains/provider/provider-error.js'

test('ProviderError carries all fields', () => {
  const err = new ProviderError({
    provider: 'anthropic',
    message: 'rate limit',
    statusCode: 429,
    code: 'rate_limit_exceeded',
    retryable: true,
    retryAfterMs: 5000,
  })
  assert.equal(err.provider, 'anthropic')
  assert.equal(err.statusCode, 429)
  assert.equal(err.code, 'rate_limit_exceeded')
  assert.equal(err.retryable, true)
  assert.equal(err.retryAfterMs, 5000)
  assert.ok(err.message.includes("Provider 'anthropic' failed"))
  assert.ok(err instanceof Error)
  assert.ok(err instanceof ProviderError)
})

test('ProviderError does not duplicate an existing provider prefix', () => {
  const err = new ProviderError({
    provider: 'claude',
    message: "Provider 'claude' exited with code 1",
    retryable: false,
  })
  assert.equal(err.message, "Provider 'claude' exited with code 1")
})

test('Claude CLI session-limit JSON becomes concise user-facing chat text', () => {
  const payload = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 429,
    duration_ms: 924,
    result: "You've hit your session limit · resets 10:30pm (America/Detroit)",
    session_id: '9140dc75-70aa-4c6a-9549-03a2673a3894',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  })
  const error = new ProviderError({
    provider: 'claude',
    message: `Provider 'claude' exited with code 1: ${payload}`,
    retryable: false,
  })

  const parsed = parseProviderError(error)
  assert.equal(parsed.kind, 'session_limit')
  assert.equal(parsed.statusCode, 429)
  assert.equal(parsed.exitCode, 1)
  assert.equal(parsed.hasStructuredPayload, true)
  assert.equal(
    formatProviderErrorForUser(error),
    "You've hit your session limit. It resets at 10:30 PM (America/Detroit). (Status 429)",
  )
  assert.equal(formatProviderErrorForUser(error).includes('session_id'), false)
  assert.equal(formatProviderErrorForUser(error).includes('usage'), false)
})

test('provider status codes map to safe actionable messages', () => {
  const cases = [
    [401, 'Authentication failed. Reconnect the provider and try again. (Status 401)'],
    [402, 'This provider account has no remaining quota or credits. Check billing. (Status 402)'],
    [403, 'This account cannot access the requested model or resource. (Status 403)'],
    [404, 'The requested model or endpoint was not found. Check provider settings. (Status 404)'],
    [413, 'The request is too large. Remove attachments or shorten the content. (Status 413)'],
    [429, 'Too many requests. Try again shortly. (Status 429)'],
    [500, 'The provider had an internal error. Try again. (Status 500)'],
    [504, 'The provider timed out. Try again. (Status 504)'],
    [529, 'The provider is temporarily overloaded. Try again shortly. (Status 529)'],
  ] as const

  for (const [statusCode, expected] of cases) {
    const error = new ProviderError({
      provider: 'test-provider',
      message: 'raw provider diagnostic that must not reach chat',
      statusCode,
      retryable: statusCode >= 500 || statusCode === 429,
    })
    assert.equal(formatProviderErrorForUser(error), expected)
  }
})

test('provider error codes override ambiguous HTTP status categories', () => {
  const error = new ProviderError({
    provider: 'openai',
    message: 'Request rejected.',
    statusCode: 429,
    code: 'insufficient_quota',
    retryable: false,
  })
  assert.equal(
    formatProviderErrorForUser(error),
    'This provider account has no remaining quota or credits. Check billing. (Status 429)',
  )
})

test('typed service errors preserve a stalled provider diagnosis for chat', () => {
  const error = new Error('Provider CLI execution failed.')
  Object.defineProperty(error, 'code', {
    value: 'provider_stalled',
    enumerable: true,
  })

  const parsed = parseProviderError(error)
  assert.equal(parsed.code, 'provider_stalled')
  assert.equal(parsed.kind, 'timeout')
  assert.equal(
    formatProviderErrorForUser(error),
    'The provider stopped producing output and the turn was ended. Try again. (Code provider_stalled)',
  )
})

test('serialized provider errors preserve normalized broker policy', () => {
  const payload = serializeProviderError(new ProviderError({
    provider: 'connection:test',
    message: 'Quota exhausted.',
    kind: 'billing',
    statusCode: 429,
    code: 'insufficient_quota',
    retryable: false,
  }))

  assert.equal(isSerializedProviderError(payload), true)
  assert.deepEqual(payload, {
    type: 'provider_error',
    error: 'Quota exhausted.',
    provider: 'connection:test',
    kind: 'billing',
    statusCode: 429,
    code: 'insufficient_quota',
    retryable: false,
  })
  const parsed = parseProviderError(payload)
  assert.equal(parsed.kind, 'billing')
  assert.equal(parsed.statusCode, 429)
  assert.equal(parsed.code, 'insufficient_quota')
})

test('string-valued structured errors retain their actionable message', () => {
  const parsed = parseProviderError({
    type: 'turn.failed',
    error: 'Invalid API key supplied',
  })
  assert.equal(parsed.hasStructuredPayload, true)
  assert.equal(parsed.kind, 'authentication')
  assert.equal(parsed.message, 'Invalid API key supplied')
})

test('valid provider success JSON is not misclassified as a structured error', () => {
  for (const payload of [
    { type: 'result', is_error: false, result: 'hello' },
    { status: 200, message: 'ok' },
  ]) {
    const parsed = parseProviderError(JSON.stringify(payload))
    assert.equal(parsed.hasStructuredPayload, false)
    assert.equal(parsed.statusCode, undefined)
  }
})

test('statusless structured failures use their normalized kind for retry policy', () => {
  for (const kind of [
    'authentication',
    'configuration',
    'cancelled',
    'process_failed',
    'unknown',
  ] as const) {
    const result = classifyProviderError({
      provider: 'test-provider',
      kind,
      message: 'structured provider failure',
    })
    assert.equal(result.retryable, false, `${kind} should not be retryable`)
  }
})

test('only allowlisted provider codes are copied into user-facing text', () => {
  for (const code of [
    'SECRET=abc user@example.com',
    'SECRETabc123',
    'sk-proj-AbCdEf123',
    'abc:def',
  ]) {
    const formatted = formatProviderErrorForUser(new ProviderError({
      provider: 'test-provider',
      message: 'Provider failed.',
      code,
      retryable: false,
    }))
    assert.equal(formatted, 'The provider could not complete the response. Try again.')
  }

  assert.equal(
    formatProviderErrorForUser(new ProviderError({
      provider: 'test-provider',
      message: 'Rate limited.',
      code: 'rate_limit_error',
      retryable: true,
    })),
    'Too many requests. Try again shortly. (Code rate_limit_error)',
  )
})

test('session-limit reset copy accepts only a real IANA time zone', () => {
  const formatted = formatProviderErrorForUser(new ProviderError({
    provider: 'claude',
    message: "You've hit your session limit; resets 10:30pm (SECRETabc123)",
    statusCode: 429,
    retryable: false,
  }))
  assert.equal(
    formatted,
    "You've hit your session limit. It resets at 10:30 PM. (Status 429)",
  )
  assert.equal(formatted.includes('SECRET'), false)
})

test('classifyProviderError: 429 is retryable and parses Retry-After seconds', () => {
  const result = classifyProviderError({ provider: 'openai', statusCode: 429, message: 'rate limit', retryAfterHeader: '10' })
  assert.equal(result.retryable, true)
  assert.equal(result.retryAfterMs, 10000)
})

test('classifyProviderError: 429 parses Retry-After HTTP date', () => {
  const future = new Date(Date.now() + 15000)
  const result = classifyProviderError({ provider: 'openai', statusCode: 429, message: 'rate limit', retryAfterHeader: future.toUTCString() })
  assert.equal(result.retryable, true)
  assert.ok(result.retryAfterMs && result.retryAfterMs >= 14000 && result.retryAfterMs <= 16000)
})

test('classifyProviderError: permanent client failures are not retryable', () => {
  for (const statusCode of [400, 401, 402, 403, 404, 409, 413, 415, 422]) {
    const result = classifyProviderError({ provider: 'x', statusCode, message: 'nope' })
    assert.equal(result.retryable, false, `status ${statusCode} should not be retryable`)
  }
})

test('classifyProviderError: 413 is not retryable', () => {
  const result = classifyProviderError({ provider: 'x', statusCode: 413, message: 'too large' })
  assert.equal(result.retryable, false)
})

test('classifyProviderError: transient provider failures are retryable', () => {
  for (const statusCode of [408, 500, 502, 503, 504, 529]) {
    const result = classifyProviderError({ provider: 'x', statusCode, message: 'transient' })
    assert.equal(result.retryable, true, `status ${statusCode} should be retryable`)
  }
})

test('classifyProviderError: network failure (no statusCode) is retryable', () => {
  const result = classifyProviderError({ provider: 'x', message: 'fetch failed' })
  assert.equal(result.retryable, true)
})

test('classifyProviderError: context_length_exceeded code is not retryable', () => {
  const result = classifyProviderError({ provider: 'x', statusCode: 400, code: 'context_length_exceeded', message: 'too long' })
  assert.equal(result.retryable, false)
})

test('classifyProviderError: invalid_api_key code is not retryable', () => {
  const result = classifyProviderError({ provider: 'x', statusCode: 401, code: 'invalid_api_key', message: 'bad key' })
  assert.equal(result.retryable, false)
})

test('classifyProviderError: unknown 4xx is not retryable', () => {
  const result = classifyProviderError({ provider: 'x', statusCode: 418, message: 'teapot' })
  assert.equal(result.retryable, false)
})

test('classifyProviderError: unknown 5xx is retryable', () => {
  const result = classifyProviderError({ provider: 'x', statusCode: 599, message: 'unknown' })
  assert.equal(result.retryable, true)
})

/**
 * Provider usage-limit (quota) exhaustion.
 *
 * Contract: a provider that reports an exhausted plan quota states two facts a
 * user can act on — when it resets, and that credits can be bought — and both
 * must survive to the user-facing copy. Classifying it as `unknown` produces
 * "Try again", which is the one instruction that cannot work before the reset.
 * It is not retryable: retrying before the stated time consumes budget and
 * cannot succeed.
 */
const CODEX_USAGE_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
  'to purchase more credits or try again at Aug 19th, 2026 11:32 PM.'

test('an exhausted provider quota is classified, not dropped into unknown', () => {
  const error = new ProviderError({
    provider: 'codex',
    message: CODEX_USAGE_LIMIT,
    retryable: false,
  })
  assert.equal(parseProviderError(error).kind, 'usage_limit')
})

test('the usage-limit message states the reset time and the credit remedy', () => {
  const formatted = formatProviderErrorForUser(
    new ProviderError({
      provider: 'codex',
      message: CODEX_USAGE_LIMIT,
      retryable: false,
    }),
  )
  assert.match(formatted, /usage limit/i)
  assert.match(formatted, /Aug 19, 2026/, 'the reset date the provider stated')
  assert.match(formatted, /11:32 PM/, 'the reset time the provider stated')
  assert.match(formatted, /credits/i, 'the other remedy the provider offered')
  assert.doesNotMatch(
    formatted,
    /Try again\.$/,
    'retrying before the reset cannot succeed and must not be advised',
  )
})

test('a usage limit exposes its stated reset on its own, without the provider prose', () => {
  // The worker boundary may carry a validated reset across, never the message
  // it came from, so the reset has to be readable separately.
  assert.equal(
    usageLimitResetLabel(
      new ProviderError({
        provider: 'codex',
        message: CODEX_USAGE_LIMIT,
        retryable: false,
      }),
    ),
    'Aug 19, 2026 at 11:32 PM',
  )
  assert.equal(
    usageLimitResetLabel(
      new ProviderError({
        provider: 'codex',
        message: "You've hit your usage limit.",
        retryable: false,
      }),
    ),
    undefined,
    'no reset was stated, so none is invented',
  )
  assert.equal(
    usageLimitResetLabel(
      new ProviderError({
        provider: 'codex',
        message: 'Unknown model requested',
        retryable: false,
      }),
    ),
    undefined,
    'only a usage limit has a reset',
  )
})

test('a usage limit without a stated reset degrades to safe copy', () => {
  const formatted = formatProviderErrorForUser(
    new ProviderError({
      provider: 'codex',
      message: "You've hit your usage limit.",
      retryable: false,
    }),
  )
  assert.match(formatted, /usage limit/i)
  assert.doesNotMatch(formatted, /NaN|undefined|Invalid/i)
})

test('a usage limit never steals the session-limit case', () => {
  assert.equal(
    parseProviderError(
      new ProviderError({
        provider: 'claude',
        message: "You've hit your session limit; resets 10:30pm",
        retryable: false,
      }),
    ).kind,
    'session_limit',
  )
})

test('an exhausted quota is not retryable', () => {
  assert.equal(
    classifyProviderError({ provider: 'codex', message: CODEX_USAGE_LIMIT }).retryable,
    false,
    'retrying before the stated reset burns budget and cannot succeed',
  )
})

/**
 * The reset as a moment, not as a sentence.
 *
 * `usageLimitResetLabel` answers "what do I show a person"; this answers "when
 * does this stop being true", which is what lets a health badge expire on its
 * own instead of standing until someone deletes a file. They are kept apart
 * because they fail differently: a label may be approximate and still useful,
 * while an instant that is wrong silently clears a real limit or holds a dead
 * one forever.
 *
 * The clock is injected because the provider states a wall-clock time in the
 * user's own zone and often omits the year, so the answer depends on when the
 * message was read. It is read once, at failure time, and stored — never
 * re-derived during a replay, when "now" means something else entirely.
 */

/** The moment the message was read, for every ambiguous case below. */
const READ_AT = new Date(2026, 7, 19, 15, 0, 0)

/**
 * The module under test, found from the repository root rather than from this
 * file.
 *
 * The suite runs both from source and from a compiled copy under a build
 * directory, and only one of those sits two levels below the source tree. The
 * child process below has to import the same module either way.
 */
const PROVIDER_ERROR_MODULE = path.join(
  repositoryRoot(),
  'domains/provider/provider-error.ts',
)

function repositoryRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory
    directory = path.dirname(directory)
  }
  return process.cwd()
}

function codexLimit(message: string): ProviderError {
  return new ProviderError({ provider: 'codex', message, retryable: false })
}

test('a fully stated reset becomes the instant it names', () => {
  assert.equal(
    usageLimitResetAt(codexLimit(CODEX_USAGE_LIMIT), READ_AT),
    new Date(2026, 7, 19, 23, 32, 0).toISOString(),
  )
})

test("this build's own rendered sentence reads back to the same instant", () => {
  // The worker boundary rebuilds the message from a validated reset, so the
  // sentence a child turn sees is not the provider's prose. It still has to
  // yield the same moment when it is read on the other side.
  assert.equal(
    usageLimitResetAt(
      codexLimit(
        "You've hit your provider usage limit. It resets on Sep 14, 2026 at 9:45 PM.",
      ),
      READ_AT,
    ),
    new Date(2026, 8, 14, 21, 45, 0).toISOString(),
  )
})

test('a reset stated as a bare time means its next occurrence', () => {
  // Seen on this machine: Codex states the clock time and omits the date
  // entirely. The next time that clock comes round is the only reading of it.
  assert.equal(
    usageLimitResetAt(
      codexLimit(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
          'to purchase more credits or try again at 11:32 PM.',
      ),
      READ_AT,
    ),
    new Date(2026, 7, 19, 23, 32, 0).toISOString(),
  )
})

test('a bare time already past today means tomorrow', () => {
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at 9:00 AM."),
      new Date(2026, 7, 19, 15, 0, 0),
    ),
    new Date(2026, 7, 20, 9, 0, 0).toISOString(),
  )
})

test('a bare time crossing midnight lands on the next day, and the next year', () => {
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at 12:30 AM."),
      new Date(2026, 11, 31, 23, 0, 0),
    ),
    new Date(2027, 0, 1, 0, 30, 0).toISOString(),
  )
})

test('a date with no year takes the year that sits closest to the reading', () => {
  // Stated on the last day of a year and read on the first of the next, the
  // year the provider meant is the one it did not say.
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at Jan 2 at 9:00 AM."),
      new Date(2026, 11, 31, 23, 0, 0),
    ),
    new Date(2027, 0, 2, 9, 0, 0).toISOString(),
  )
})

test('a date that is not on the calendar states nothing', () => {
  // February 30th is not a reset an hour later or a month later; it is a
  // message this build does not understand, and guessing one would expire a
  // real limit at an invented moment.
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at Feb 30, 2026 9:00 AM."),
      READ_AT,
    ),
    undefined,
  )
})

test('a message that states no reset states no instant', () => {
  assert.equal(
    usageLimitResetAt(codexLimit("You've hit your usage limit."), READ_AT),
    undefined,
  )
})

test('only a usage limit has a reset instant', () => {
  assert.equal(
    usageLimitResetAt(codexLimit('Unknown model requested'), READ_AT),
    undefined,
  )
})

/**
 * A stated zone, and a wall clock that does not exist.
 *
 * Everything above resolves a bare wall-clock time against the machine's own
 * zone, which is right because the provider is describing the user's account
 * to the user. Two cases break that assumption, and both used to be answered
 * with a confidently wrong instant rather than with nothing.
 */

test('a reset stated in UTC is that instant, whatever zone the machine is in', () => {
  // Ignoring the zone and reading the clock locally is not an approximation,
  // it is a different moment — five hours out in New York, eleven in Sydney.
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at Sep 20, 2026 1:00 AM UTC."),
      READ_AT,
    ),
    '2026-09-20T01:00:00.000Z',
  )
})

test('a reset stated in a zone this build cannot resolve states nothing', () => {
  // Rejecting loses a reset and falls back to the allowance reading. Guessing
  // expires a live limit hours early, which is the failure this whole change
  // exists to stop.
  for (const zone of ['PST', 'CEST', 'IST']) {
    assert.equal(
      usageLimitResetAt(
        codexLimit(`You've hit your usage limit. Try again at Sep 20, 2026 1:00 AM ${zone}.`),
        READ_AT,
      ),
      undefined,
      `'${zone}' is a zone this build does not resolve`,
    )
  }
})

test('a wall clock the local calendar skips states nothing', (t) => {
  // The hour a zone springs forward through never happens. A Date built from
  // it silently lands an hour later, so the check has to read the clock back.
  const detroit = withTimeZone('America/Detroit')
  if (!detroit) return t.skip('the host has no America/Detroit zone data')

  assert.equal(
    detroit.resetAt("You've hit your usage limit. Try again at Mar 8, 2026 2:30 AM."),
    undefined,
  )
})

test('a wall clock the local calendar repeats states nothing', (t) => {
  // The hour a zone falls back through happens twice, and nothing in the
  // message says which one. Picking one would expire a limit an hour early.
  const detroit = withTimeZone('America/Detroit')
  if (!detroit) return t.skip('the host has no America/Detroit zone data')

  assert.equal(
    detroit.resetAt("You've hit your usage limit. Try again at Nov 1, 2026 1:30 AM."),
    undefined,
  )
})

test('an ordinary wall clock still resolves in a zone with transitions', (t) => {
  const detroit = withTimeZone('America/Detroit')
  if (!detroit) return t.skip('the host has no America/Detroit zone data')

  assert.equal(
    detroit.resetAt("You've hit your usage limit. Try again at Mar 8, 2026 4:30 AM."),
    '2026-03-08T08:30:00.000Z',
  )
})

/**
 * The parser in a chosen zone, since `TZ` is read once when the process starts.
 *
 * A child process is the only honest way to pin it: setting `process.env.TZ`
 * in-process leaves Node's already-built zone cache in place, so the test
 * would pass by reading the runner's zone under a different name.
 */
function withTimeZone(
  timeZone: string,
): { resetAt(message: string, readAt?: Date): string | undefined } | undefined {
  if (!fs.existsSync(PROVIDER_ERROR_MODULE)) return undefined
  const probe = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(new Date(2026, 2, 8, 4, 30).toISOString())'],
    { env: { ...process.env, TZ: timeZone }, encoding: 'utf8' },
  )
  if (probe.status !== 0 || probe.stdout !== '2026-03-08T08:30:00.000Z') {
    return undefined
  }
  return {
    resetAt(message: string, readAt: Date = READ_AT) {
      const run = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          `import { ProviderError, usageLimitResetAt } from ${JSON.stringify(PROVIDER_ERROR_MODULE)}
           const answer = usageLimitResetAt(
             new ProviderError({ provider: 'codex', message: process.argv[1], retryable: false }),
             new Date(Number(process.argv[2])),
           )
           process.stdout.write(answer ?? '')`,
          message,
          String(readAt.getTime()),
        ],
        { env: { ...process.env, TZ: timeZone }, encoding: 'utf8' },
      )
      assert.equal(run.status, 0, run.stderr)
      return run.stdout === '' ? undefined : run.stdout
    },
  }
}

/**
 * Zone suffixes the provider might actually write, and the ones it might not.
 *
 * The suffix has to be read in full or refused in full. Reading part of it —
 * the letters of `UTC+02:00`, or nothing at all from `(UTC)` — produces a
 * confident answer hours away from the stated one, which is worse than having
 * no answer.
 */

test('a parenthesised UTC suffix is read, not skipped', () => {
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at Sep 20, 2026 1:00 AM (UTC)."),
      READ_AT,
    ),
    '2026-09-20T01:00:00.000Z',
  )
})

test('a lower-case utc suffix is a zone, not the next word of a sentence', () => {
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at Sep 20, 2026 1:00 AM utc."),
      READ_AT,
    ),
    '2026-09-20T01:00:00.000Z',
  )
})

test('an offset from UTC is refused rather than read as UTC', () => {
  // Taking the letters and dropping the offset lands two hours away from the
  // moment the provider named.
  for (const suffix of ['UTC+02:00', 'GMT-05:00', '+02:00', '(UTC+02:00)']) {
    assert.equal(
      usageLimitResetAt(
        codexLimit(`You've hit your usage limit. Try again at Sep 20, 2026 1:00 AM ${suffix}.`),
        READ_AT,
      ),
      undefined,
      `'${suffix}' states an offset this build does not resolve`,
    )
  }
})

test('a parenthesised regional zone is refused like a bare one', () => {
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at Sep 20, 2026 1:00 AM (PST)."),
      READ_AT,
    ),
    undefined,
  )
})

test('a bare time stated in UTC resolves on the UTC clock', () => {
  assert.equal(
    usageLimitResetAt(
      codexLimit("You've hit your usage limit. Try again at 11:32 PM UTC."),
      new Date('2026-08-19T15:00:00.000Z'),
    ),
    '2026-08-19T23:32:00.000Z',
  )
})

test('an ordinary word after the time is not mistaken for a zone', () => {
  // The sentence continues. Refusing here would throw away a reset that was
  // stated perfectly clearly.
  assert.equal(
    usageLimitResetAt(
      codexLimit(
        "You've hit your usage limit. It resets on Sep 14, 2026 at 9:45 PM and you can add credits.",
      ),
      READ_AT,
    ),
    new Date(2026, 8, 14, 21, 45, 0).toISOString(),
  )
})

/**
 * A transition read on the day it happens.
 *
 * The earlier cases are read in August, where every wall clock exists exactly
 * once. Refusing such a clock must not quietly select a different day or year
 * instead — an answer a day late is wrong, and an answer a year early expires
 * a live limit the moment it is recorded.
 */

test('a bare time inside a skipped hour is refused, not moved to tomorrow', (t) => {
  const detroit = withTimeZone('America/Detroit')
  if (!detroit) return t.skip('the host has no America/Detroit zone data')

  assert.equal(
    detroit.resetAt(
      "You've hit your usage limit. Try again at 2:30 AM.",
      new Date('2026-03-08T05:30:00.000Z'),
    ),
    undefined,
  )
})

test('a bare time inside a repeated hour is refused, not moved to tomorrow', (t) => {
  const detroit = withTimeZone('America/Detroit')
  if (!detroit) return t.skip('the host has no America/Detroit zone data')

  assert.equal(
    detroit.resetAt(
      "You've hit your usage limit. Try again at 1:30 AM.",
      new Date('2026-11-01T04:30:00.000Z'),
    ),
    undefined,
  )
})

test('a dated time inside a repeated hour is refused, not moved to last year', (t) => {
  // The worst of the three. Falling back a year produces a reset already in
  // the past, which clears the very limit it was meant to describe.
  const detroit = withTimeZone('America/Detroit')
  if (!detroit) return t.skip('the host has no America/Detroit zone data')

  assert.equal(
    detroit.resetAt(
      "You've hit your usage limit. Try again at Nov 1 1:30 AM.",
      new Date('2026-11-01T04:30:00.000Z'),
    ),
    undefined,
  )
})

test('an undated time on a transition day still resolves when the clock exists', (t) => {
  const detroit = withTimeZone('America/Detroit')
  if (!detroit) return t.skip('the host has no America/Detroit zone data')

  assert.equal(
    detroit.resetAt(
      "You've hit your usage limit. Try again at 4:30 AM.",
      new Date('2026-03-08T05:30:00.000Z'),
    ),
    '2026-03-08T08:30:00.000Z',
  )
})
