import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { loadDotEnv } from '../../core/env-loader.js'
import { BrowserNetworkPolicy } from '../../domains/browser/browser-network-policy.js'
import { BrowserUseSessionClient } from '../../domains/browser/browser-use-session-client.js'
import { CloudBrowserAcquirer } from '../../domains/browser/cloud-browser-acquirer.js'
import { parseCloudBrowserEnvironment } from '../../domains/browser/cloud-browser-environment.js'
import {
  browserUseLiveGate,
  describeLiveSessionOutcome,
  type BrowserUseLiveResult,
} from '../support/browser-use-live-gate.js'

/**
 * One real Browser Use session: created, driven, and released.
 *
 * **This costs money.** It is excluded from every ordinary suite — the runner
 * collects only `tests/unit` and `tests/integration` — and refuses to run
 * unless `PIPELINE_LIVE_BROWSER_USE=1` and a positive
 * `PIPELINE_LIVE_BROWSER_USE_ALARM_MICROS` are both set with a key present. The
 * decision is a pure function, tested in
 * `tests/unit/browser-use-live-gate.test.ts`.
 *
 * It drives the real `CloudBrowserAcquirer` against a stable public page, so a
 * pass means the provider was created, **connected to over CDP**, read from,
 * and stopped. Parsing a URL out of the session would prove none of that.
 *
 * What it settles that nothing offline can: whether the V4 shapes this client
 * validates are the shapes the live API returns, and **which host a real
 * `cdpUrl` lives on** — the default allowlist is an unverified guess, and this
 * is where it stops being one.
 *
 * What it deliberately is not: a cohort measurement of recovery.
 */

// A page that exists to be fetched, is tiny, and does not mind being read.
const PROBE_URL = 'https://example.com/'
const PER_CALL_BUDGET_MS = 60_000

test('one bounded Browser Use session is created, driven and released', {
  timeout: 180_000,
}, async (t) => {
  // The repository's own loader, so copying `.env.example` to `.env` is enough.
  loadDotEnv()

  const gate = browserUseLiveGate(process.env)
  if (gate.kind === 'skip') {
    t.skip(gate.reason)
    return
  }

  const runtime = parseCloudBrowserEnvironment(process.env)
  const warnings: string[] = []
  let warningKind: 'session-not-stopped' | 'session-indeterminate' | undefined
  // Recorded before the allowlist decides, so the run that is *rejected* for an
  // unexpected host still says which host to allow.
  let observedCdpHost = ''

  const acquirer = new CloudBrowserAcquirer({
    sessionClient: new BrowserUseSessionClient({
      apiKey: gate.apiKey,
      perCallBudgetMs: PER_CALL_BUDGET_MS,
      cdpHostAllowlist: runtime.cdpHostAllowlist,
      ...(runtime.proxyCountryCode === undefined
        ? {}
        : { proxyCountryCode: runtime.proxyCountryCode }),
      onCleanupWarning: (warning) => {
        warnings.push(warning.failure)
        warningKind = warning.kind
      },
      onCdpEndpointHost: (hostname) => {
        observedCdpHost = hostname
      },
    }),
    networkPolicy: new BrowserNetworkPolicy({}),
    navigationTimeoutMs: 30_000,
    settleMs: 2_000,
  })

  const result = await acquirer.acquire(PROBE_URL, {
    enabled: true,
    restrictDomains: false,
    domains: [],
  })

  const spent = result.runtime.browserCostMicros + result.runtime.proxyCostMicros
  const report: BrowserUseLiveResult = {
    sessionOutcome: describeLiveSessionOutcome({
      stopped: result.cleanup.stopped,
      ...(warningKind ? { warningKind } : {}),
    }),
    connected: result.evidence !== undefined,
    meterSource: result.runtime.meterSource,
    browserCostMicros: result.runtime.browserCostMicros,
    proxyCostMicros: result.runtime.proxyCostMicros,
    withinAlarm: spent <= gate.alarmMicros,
    proxyCountry: result.runtime.proxyCountry,
    ...(result.failure ? { failure: result.failure.code } : {}),
  }

  // Written outside the repository. It carries no key, no endpoint, no session
  // id and no page text — only what the run cost and what became of it.
  const artifact = path.join(
    os.tmpdir(),
    `browser-use-live-${Date.now()}.json`,
  )
  fs.writeFileSync(
    artifact,
    `${JSON.stringify({ ...report, observedCdpHost, cleanupWarnings: warnings }, null, 2)}\n`,
    'utf8',
  )
  console.log('[browser-use-live] result written to', artifact)
  console.log('[browser-use-live]', JSON.stringify(report))
  console.log('[browser-use-live] observed cdp host:', observedCdpHost || '(none)')

  // Three things this check exists to establish. Everything else is reported.
  assert.equal(
    report.connected,
    true,
    `the provider session produced no evidence (${report.failure ?? 'no failure recorded'})`,
  )
  assert.equal(
    report.sessionOutcome,
    'stopped',
    `the session was left ${report.sessionOutcome}; anything unstopped keeps billing`,
  )
  // An alarm, not a cap: the money is already spent by the time this is known.
  assert.equal(
    report.withinAlarm,
    true,
    `the run cost ${spent} USD micros, above the ${gate.alarmMicros} expected`,
  )
})
