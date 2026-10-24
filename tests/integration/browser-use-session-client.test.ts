import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserUseSessionClient } from '../../domains/browser/browser-use-session-client.js'
import type { CloudSessionCleanupWarning } from '../../domains/browser/cloud-browser-types.js'
import {
  activeSession,
  SESSION_ID,
  startBrowserUseApiFixture,
  stoppedSession,
  type BrowserUseApiFixture,
} from '../support/browser-use-api-fixture.js'

/**
 * The provider session lifecycle against a loopback stand-in for the V4 API.
 *
 * It lives in the integration suite because it opens a real server and drives
 * real transport timeouts and cancellation. Nothing here needs an account, a
 * key, or a billable call; the pure rules it depends on are unit-tested in
 * `tests/unit/cloud-browser-metering.test.ts`.
 */

const API_KEY = 'bu_test_key_never_leaks'
const OTHER_SESSION_ID = '9f8e7d6c-5b4a-4321-8765-0a1b2c3d4e5f'

function clientFor(
  fixture: BrowserUseApiFixture,
  overrides: Partial<{
    perCallBudgetMs: number
    proxyCountryCode: string | null
    stopTimeoutMs: number
    requestTimeoutMs: number
    cdpHostAllowlist: readonly string[]
    onCleanupWarning: (warning: CloudSessionCleanupWarning) => void
    onCdpEndpointHost: (hostname: string) => void
  }> = {},
): BrowserUseSessionClient {
  return new BrowserUseSessionClient({
    apiKey: API_KEY,
    endpoint: fixture.url,
    perCallBudgetMs: 45_000,
    // The fixture host is named explicitly rather than inferred from the
    // endpoint: what a deployment configures must not become a production rule.
    cdpHostAllowlist: ['127.0.0.1'],
    ...overrides,
  })
}

function cdpUrlFor(fixture: BrowserUseApiFixture): string {
  return `ws://127.0.0.1:${new URL(fixture.url).port}/devtools/browser/abc`
}

function methods(fixture: BrowserUseApiFixture): string[] {
  return fixture.requests.map((request) => request.method)
}

test('a session is created with the documented body and stopped afterwards', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    const outcome = await clientFor(fixture).withSession(async (session) => session.cdpUrl)

    assert.equal(outcome.value, cdpUrlFor(fixture))
    assert.equal(outcome.failure, undefined)
    assert.equal(outcome.cleanup.stopped, true)
    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      ['POST /api/v4/browsers', `PATCH /api/v4/browsers/${SESSION_ID}`],
    )
    const [create, stop] = fixture.requests
    assert.equal(create?.headers['x-browser-use-api-key'], API_KEY)
    assert.deepEqual(JSON.parse(stop?.body ?? '{}'), { action: 'stop' })
  } finally {
    await fixture.close()
  }
})

test('the provider timeout is the smallest whole minute covering the call bound', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    for (const [budgetMs, expected] of [
      [1, 1],
      [60_000, 1],
      [60_001, 2],
      [90_000, 2],
      [1_000 * 60 * 500, 240],
    ] as const) {
      await clientFor(fixture, { perCallBudgetMs: budgetMs }).withSession(async () => undefined)
      const create = fixture.requests.filter((request) => request.method === 'POST').at(-1)
      assert.equal(JSON.parse(create?.body ?? '{}').timeout, expected, `budget ${budgetMs}ms`)
    }
  } finally {
    await fixture.close()
  }
})

test('a null proxy country disables the proxy rather than omitting the field', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    const outcome = await clientFor(fixture, { proxyCountryCode: null }).withSession(
      async () => undefined,
    )
    const create = fixture.requests.find((request) => request.method === 'POST')
    assert.equal(JSON.parse(create?.body ?? '{}').proxyCountryCode, null)
    assert.equal(outcome.runtime.proxyCountry, 'none')
  } finally {
    await fixture.close()
  }
})

test('a session that returns no CDP endpoint fails and is still stopped', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: null }) })
    let ran = false
    const outcome = await clientFor(fixture).withSession(async () => {
      ran = true
    })

    assert.equal(ran, false)
    assert.equal(outcome.failure?.code, 'provider_session_unusable')
    assert.equal(outcome.cleanup.stopped, true)
    assert.ok(methods(fixture).includes('PATCH'))
  } finally {
    await fixture.close()
  }
})

test('a CDP endpoint outside the configured allowlist is refused and stopped', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({
      body: activeSession({ cdpUrl: 'wss://attacker.example.com/devtools/browser/abc' }),
    })
    const outcome = await clientFor(fixture).withSession(async () => 'connected')

    assert.equal(outcome.value, undefined)
    assert.equal(outcome.failure?.code, 'provider_session_unusable')
    assert.ok(methods(fixture).includes('PATCH'))
  } finally {
    await fixture.close()
  }
})

test('a refused control endpoint still reports its hostname, and only that', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // The case worth diagnosing is the rejected one: an operator told to widen
    // the allowlist has to be told what to widen it to.
    fixture.respondToCreate({
      body: activeSession({
        cdpUrl: 'wss://cdp.unexpected-host.example/session/abc?token=super-secret',
      }),
    })
    const observed: string[] = []
    const outcome = await clientFor(fixture, {
      onCdpEndpointHost: (hostname) => observed.push(hostname),
    }).withSession(async () => 'connected')

    assert.equal(outcome.failure?.code, 'provider_session_unusable')
    assert.deepEqual(observed, ['cdp.unexpected-host.example'])
    // A hostname, not an endpoint: the path and query can carry a session token.
    assert.equal(observed.join('').includes('token'), false)
    assert.equal(observed.join('').includes('wss://'), false)
  } finally {
    await fixture.close()
  }
})

test('an observer that throws cannot fail the acquisition', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    const outcome = await clientFor(fixture, {
      onCdpEndpointHost: () => {
        throw new Error('the diagnostic channel is down')
      },
    }).withSession(async () => 'read')

    assert.equal(outcome.value, 'read')
    assert.equal(outcome.cleanup.stopped, true)
  } finally {
    await fixture.close()
  }
})

test('a malformed create payload is a typed failure rather than trusted data', async () => {
  for (const body of [
    activeSession({ status: 'exploded' }),
    activeSession({ browserCost: 'free' }),
    activeSession({ timeoutAt: 'whenever' }),
  ]) {
    const fixture = await startBrowserUseApiFixture()
    try {
      fixture.respondToCreate({ body })
      const outcome = await clientFor(fixture).withSession(async () => 'used')
      assert.equal(outcome.value, undefined)
      assert.equal(outcome.failure?.code, 'provider_response_invalid')
    } finally {
      await fixture.close()
    }
  }
})

test('an invalid create payload that still carries an id has its session stopped', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // The session is real and billing even though the body is not one we will
    // drive a browser through, so cleanup recovers the id on its own.
    fixture.respondToCreate({ body: activeSession({ browserCost: 'free' }) })
    const outcome = await clientFor(fixture).withSession(async () => 'used')

    assert.equal(outcome.failure?.code, 'provider_response_invalid')
    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      ['POST /api/v4/browsers', `PATCH /api/v4/browsers/${SESSION_ID}`],
    )
    assert.equal(outcome.cleanup.stopped, true)
  } finally {
    await fixture.close()
  }
})

test('a create payload with no recoverable id reports an indeterminate session', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ raw: '<html>gateway</html>' })
    const outcome = await clientFor(fixture, { perCallBudgetMs: 90_000 }).withSession(
      async () => 'used',
    )

    assert.equal(outcome.failure?.code, 'provider_response_invalid')
    assert.equal(outcome.cleanup.stopped, false)
    const warning = outcome.cleanup.warning
    assert.equal(warning?.kind, 'session-indeterminate')
    assert.equal(
      warning?.kind === 'session-indeterminate' ? warning.providerTimeoutMinutes : undefined,
      2,
      'the requested timeout is the only correlation an unnamed session has',
    )
    assert.equal('sessionId' in (warning ?? {}), false)
  } finally {
    await fixture.close()
  }
})

test('an oversized create response is refused instead of being parsed', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ raw: `{"padding":"${'x'.repeat(200_000)}"}` })
    const outcome = await clientFor(fixture).withSession(async () => 'used')

    assert.equal(outcome.failure?.code, 'provider_response_invalid')
    assert.equal(outcome.cleanup.warning?.kind, 'session-indeterminate')
  } finally {
    await fixture.close()
  }
})

test('provider-reported costs are recorded as integer micros, never estimated', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    fixture.respondToStop({
      body: stoppedSession({ browserCost: '0.0234', proxyCost: '1.5', proxyUsedMb: '2.5' }),
    })

    const outcome = await clientFor(fixture).withSession(async () => undefined)

    assert.equal(outcome.runtime.browserCostMicros, 23_400)
    assert.equal(outcome.runtime.proxyCostMicros, 1_500_000)
    // Thousandths of the provider's own unit: no decimal-vs-binary MB guess.
    assert.equal(outcome.runtime.proxyUsedMilliMb, 2_500)
    assert.equal(outcome.runtime.sessionStatus, 'stopped')
    assert.equal(outcome.runtime.meterSource, 'stop-confirmed')
    assert.equal(outcome.runtime.provider, 'browser-use')
  } finally {
    await fixture.close()
  }
})

test('every decimal form the provider may emit survives the schema', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    // A leading plus and a bare fractional part are valid decimal text. The
    // schema used to reject them before the conversion that supports them ever
    // ran, quietly downgrading a confirmed meter to a last-known one.
    fixture.respondToStop({
      body: stoppedSession({ browserCost: '+0.5', proxyCost: '.25', proxyUsedMb: '0' }),
    })

    const outcome = await clientFor(fixture).withSession(async () => undefined)

    assert.equal(outcome.runtime.meterSource, 'stop-confirmed')
    assert.equal(outcome.runtime.browserCostMicros, 500_000)
    assert.equal(outcome.runtime.proxyCostMicros, 250_000)
  } finally {
    await fixture.close()
  }
})

test('a failing run still stops the session and reports the failure', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    const outcome = await clientFor(fixture).withSession(async () => {
      throw new Error('navigation exploded')
    })

    assert.equal(outcome.failure?.code, 'provider_session_failed')
    assert.equal(outcome.cleanup.stopped, true)
    assert.ok(methods(fixture).includes('PATCH'))
  } finally {
    await fixture.close()
  }
})

test('an abort before creation issues no provider request at all', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    const controller = new AbortController()
    controller.abort()
    const outcome = await clientFor(fixture).withSession(async () => 'used', controller.signal)

    assert.equal(outcome.failure?.code, 'cancelled')
    assert.deepEqual(fixture.requests, [])
    assert.equal(outcome.cleanup.stopped, true)
  } finally {
    await fixture.close()
  }
})

test('an abort while creation is in flight still captures the id and stops it', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // The create request must not be cancelled by the caller's signal. If it
    // were, the reply carrying the session id would be discarded and a live,
    // billing session would be left with nobody able to name it.
    fixture.respondToCreate({
      body: activeSession({ cdpUrl: cdpUrlFor(fixture) }),
      delayMs: 250,
    })
    const controller = new AbortController()
    let ran = false
    const running = clientFor(fixture).withSession(async () => {
      ran = true
      return 'used'
    }, controller.signal)
    // Aborts the instant the server holds the create request, so the withdrawal
    // is guaranteed to land while the reply carrying the id is still in flight.
    void fixture.createRequestReceived.then(() => controller.abort())

    const outcome = await running

    assert.equal(ran, false, 'a withdrawn caller must not start a paid read')
    assert.equal(outcome.failure?.code, 'cancelled')
    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      ['POST /api/v4/browsers', `PATCH /api/v4/browsers/${SESSION_ID}`],
    )
    assert.equal(outcome.cleanup.stopped, true)
    assert.deepEqual(fixture.abortedRequests, [])
  } finally {
    await fixture.close()
  }
})

test('a stop that answers about another session is not treated as confirmation', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    fixture.respondToStop({ body: stoppedSession({ id: OTHER_SESSION_ID }) })

    const outcome = await clientFor(fixture).withSession(async () => 'read')

    assert.equal(outcome.cleanup.stopped, false)
    assert.equal(outcome.cleanup.warning?.kind, 'session-not-stopped')
    assert.equal(
      outcome.cleanup.warning?.kind === 'session-not-stopped'
        ? outcome.cleanup.warning.failure
        : undefined,
      'stop_unconfirmed',
    )
  } finally {
    await fixture.close()
  }
})

test('a stop that reports the session still active is not confirmation either', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    fixture.respondToStop({ body: activeSession() })

    const outcome = await clientFor(fixture).withSession(async () => 'read')

    assert.equal(outcome.cleanup.stopped, false)
    assert.equal(
      outcome.cleanup.warning?.kind === 'session-not-stopped'
        ? outcome.cleanup.warning.failure
        : undefined,
      'stop_unconfirmed',
    )
  } finally {
    await fixture.close()
  }
})

test('a confirmed stop with an unreadable meter is still a stopped session', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({
      body: activeSession({ cdpUrl: cdpUrlFor(fixture), browserCost: '0.25' }),
    })
    // Confirmation and metering are separate claims. A cost we cannot read must
    // not make us report a session as still billing when it demonstrably stopped.
    fixture.respondToStop({ body: stoppedSession({ browserCost: 'gratis' }) })

    const outcome = await clientFor(fixture).withSession(async () => 'read')

    assert.equal(outcome.cleanup.stopped, true)
    assert.equal(outcome.cleanup.warning, undefined)
    assert.equal(outcome.runtime.meterSource, 'create-last-known')
    assert.equal(outcome.runtime.browserCostMicros, 250_000)
    // The provider confirmed the session stopped. An unreadable cost is a gap
    // in the meter, not a reason to keep reporting the session as running.
    assert.equal(outcome.runtime.sessionStatus, 'stopped')
  } finally {
    await fixture.close()
  }
})

test('an unconfirmed stop keeps the last figures the provider gave us', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({
      body: activeSession({ cdpUrl: cdpUrlFor(fixture), browserCost: '0.5', proxyCost: '0.125' }),
    })
    fixture.respondToStop({ status: 500, body: { error: 'provider on fire' } })
    const warnings: CloudSessionCleanupWarning[] = []

    const outcome = await clientFor(fixture, {
      onCleanupWarning: (warning) => warnings.push(warning),
    }).withSession(async () => 'read')

    assert.equal(outcome.value, 'read')
    assert.equal(outcome.cleanup.stopped, false)
    // Zeroing these would report a session that spent money as having spent none.
    assert.equal(outcome.runtime.browserCostMicros, 500_000)
    assert.equal(outcome.runtime.proxyCostMicros, 125_000)
    assert.equal(outcome.runtime.meterSource, 'create-last-known')
    assert.equal(outcome.runtime.sessionStatus, 'active')

    const warning = outcome.cleanup.warning
    assert.equal(warning?.kind, 'session-not-stopped')
    assert.equal(warning?.kind === 'session-not-stopped' ? warning.sessionId : '', SESSION_ID)
    assert.equal(
      warning?.kind === 'session-not-stopped' ? warning.timeoutAt : '',
      '2026-08-30T10:01:00.000Z',
    )
    assert.deepEqual(warnings, [warning])

    const serialized = JSON.stringify({ outcome, warnings })
    assert.equal(serialized.includes(API_KEY), false)
    assert.equal(serialized.includes(fixture.url), false)
  } finally {
    await fixture.close()
  }
})

test('a stop that never answers times out and is reported as a cleanup warning', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    fixture.respondToStop({ delayMs: 5_000 })

    const outcome = await clientFor(fixture, { stopTimeoutMs: 150 }).withSession(
      async () => 'read',
    )

    assert.equal(outcome.cleanup.stopped, false)
    assert.equal(
      outcome.cleanup.warning?.kind === 'session-not-stopped'
        ? outcome.cleanup.warning.failure
        : undefined,
      'stop_timed_out',
    )
  } finally {
    await fixture.close()
  }
})

test('an oversized stop response cannot confirm a stop', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    fixture.respondToStop({ raw: `{"padding":"${'x'.repeat(200_000)}"}` })

    const outcome = await clientFor(fixture).withSession(async () => 'read')

    assert.equal(outcome.cleanup.stopped, false)
    assert.equal(outcome.cleanup.warning?.kind, 'session-not-stopped')
  } finally {
    await fixture.close()
  }
})

test('a cleanup listener that throws cannot destroy the outcome', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })
    fixture.respondToStop({ status: 500 })

    const outcome = await clientFor(fixture, {
      onCleanupWarning: () => {
        throw new Error('the operator channel is down')
      },
    }).withSession(async () => 'read')

    assert.equal(outcome.value, 'read')
    assert.equal(outcome.cleanup.stopped, false)
    assert.equal(outcome.cleanup.warning?.kind, 'session-not-stopped')
  } finally {
    await fixture.close()
  }
})

test('a session the provider reports as already stopped is never driven or re-stopped', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // A stopped session has no browser behind it. Connecting to whatever the
    // endpoint still points at would be driving something we cannot account
    // for, and asking the provider to stop what it just called stopped invites
    // a rejection that would be reported as a session still billing.
    fixture.respondToCreate({
      body: stoppedSession({ cdpUrl: cdpUrlFor(fixture), browserCost: '0.75' }),
    })
    let ran = false
    const outcome = await clientFor(fixture).withSession(async () => {
      ran = true
    })

    assert.equal(ran, false)
    assert.equal(outcome.failure?.code, 'provider_session_unusable')
    assert.deepEqual(
      fixture.requests.map((request) => request.method),
      ['POST'],
      'nothing needs stopping, so nothing is asked to stop',
    )
    assert.equal(outcome.cleanup.stopped, true)
    assert.equal(outcome.cleanup.warning, undefined)
    assert.equal(outcome.runtime.sessionStatus, 'stopped')
    assert.equal(outcome.runtime.browserCostMicros, 750_000)
  } finally {
    await fixture.close()
  }
})

test('a session whose timeout is unreadable is still stopped by its id', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // The id is the only field cleanup actually needs. Requiring a valid
    // timeout alongside it would leave a real, billing session unstoppable
    // because a field nobody uses for stopping was malformed.
    fixture.respondToCreate({ body: activeSession({ timeoutAt: 'whenever' }) })

    const outcome = await clientFor(fixture).withSession(async () => 'used')

    assert.equal(outcome.failure?.code, 'provider_response_invalid')
    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      ['POST /api/v4/browsers', `PATCH /api/v4/browsers/${SESSION_ID}`],
    )
    assert.equal(outcome.cleanup.stopped, true)
  } finally {
    await fixture.close()
  }
})

test('an unstoppable session with no readable timeout reports what is known', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ timeoutAt: 'whenever' }) })
    fixture.respondToStop({ status: 500 })

    const outcome = await clientFor(fixture, { perCallBudgetMs: 90_000 }).withSession(
      async () => 'used',
    )

    const warning = outcome.cleanup.warning
    assert.equal(warning?.kind, 'session-not-stopped')
    assert.equal(warning?.kind === 'session-not-stopped' ? warning.sessionId : '', SESSION_ID)
    // No absolute timestamp is invented; the requested bound is what is known.
    assert.equal(
      warning?.kind === 'session-not-stopped' ? warning.timeoutAt : 'set',
      undefined,
    )
    assert.equal(
      warning?.kind === 'session-not-stopped' ? warning.providerTimeoutMinutes : 0,
      2,
    )
  } finally {
    await fixture.close()
  }
})

test('a timestamp that parses but is not ISO is refused', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // `Date.parse` accepts plenty that is not an ISO date-time, and the plan
    // and the field's own comment both promise ISO.
    fixture.respondToCreate({ body: activeSession({ timeoutAt: 'March 5, 2026' }) })
    const outcome = await clientFor(fixture).withSession(async () => 'used')

    assert.equal(outcome.failure?.code, 'provider_response_invalid')
  } finally {
    await fixture.close()
  }
})

test('a nonsense timeout budget cannot become a nonsense provider request', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ body: activeSession({ cdpUrl: cdpUrlFor(fixture) }) })

    // NaN would serialize the provider timeout as null and negative values
    // would raise a RangeError inside the timer, which the catch would then
    // report as a possibly-billing indeterminate session.
    for (const budget of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      await clientFor(fixture, { perCallBudgetMs: budget }).withSession(async () => undefined)
      const create = fixture.requests.filter((request) => request.method === 'POST').at(-1)
      const sent = JSON.parse(create?.body ?? '{}').timeout
      assert.equal(Number.isSafeInteger(sent) && sent >= 1 && sent <= 240, true, String(budget))
    }
  } finally {
    await fixture.close()
  }
})

test('a country code that is not a country code is refused before any request', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    const outcome = await clientFor(fixture, {
      proxyCountryCode: 'not-a-country',
    }).withSession(async () => 'used')

    assert.equal(outcome.failure?.code, 'provider_request_invalid')
    assert.deepEqual(fixture.requests, [])
  } finally {
    await fixture.close()
  }
})

test('a server error after create is indeterminate, not proof of no session', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // A 5xx can arrive after the provider has already committed a session.
    // Reporting that as "nothing was created" hides a billable orphan behind a
    // confident `stopped: true`.
    fixture.respondToCreate({ status: 503, body: { error: 'upstream unavailable' } })
    const outcome = await clientFor(fixture, { perCallBudgetMs: 90_000 }).withSession(
      async () => 'used',
    )

    assert.equal(outcome.failure?.code, 'provider_unavailable')
    assert.equal(outcome.cleanup.stopped, false)
    assert.equal(outcome.cleanup.warning?.kind, 'session-indeterminate')
  } finally {
    await fixture.close()
  }
})

test('a server error that still names a session has that session stopped', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // Some failures answer with the session they did make. That id is the only
    // thing that can stop it, so it is used whatever the status said.
    fixture.respondToCreate({ status: 500, body: activeSession() })
    const outcome = await clientFor(fixture).withSession(async () => 'used')

    assert.deepEqual(
      fixture.requests.map((request) => `${request.method} ${request.path}`),
      ['POST /api/v4/browsers', `PATCH /api/v4/browsers/${SESSION_ID}`],
    )
    assert.equal(outcome.cleanup.stopped, true)
  } finally {
    await fixture.close()
  }
})

test('a refusal the provider is certain about creates nothing to stop', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    // A 401 is the provider declining before it made anything. Warning about a
    // possible orphan here would cry wolf on every bad key.
    fixture.respondToCreate({ status: 401, body: { error: 'bad key' } })
    const outcome = await clientFor(fixture).withSession(async () => 'used')

    assert.equal(outcome.cleanup.stopped, true)
    assert.equal(outcome.cleanup.warning, undefined)
    assert.deepEqual(methods(fixture), ['POST'])
  } finally {
    await fixture.close()
  }
})

test('the api key never appears in a provider error message', async () => {
  const fixture = await startBrowserUseApiFixture()
  try {
    fixture.respondToCreate({ status: 401, body: { error: 'bad key' } })
    const outcome = await clientFor(fixture).withSession(async () => 'used')

    assert.equal(outcome.failure?.code, 'provider_unavailable')
    assert.equal(JSON.stringify(outcome).includes(API_KEY), false)
    assert.deepEqual(
      methods(fixture).filter((method) => method === 'PATCH'),
      [],
      'a create the provider refused made no session, so nothing needs stopping',
    )
  } finally {
    await fixture.close()
  }
})
