import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import test from 'node:test'

import { loadDotEnv } from '../../core/env-loader.js'
import { BrowserNetworkPolicy } from '../../domains/browser/browser-network-policy.js'
import { BrowserUseSessionClient } from '../../domains/browser/browser-use-session-client.js'
import { CloudBrowserAcquirer } from '../../domains/browser/cloud-browser-acquirer.js'
import { parseCloudBrowserEnvironment } from '../../domains/browser/cloud-browser-environment.js'
import { browserUseLiveGate } from '../support/browser-use-live-gate.js'

/**
 * Every URL a research run failed on, replayed once through the real provider.
 *
 * **This costs money**, once per URL in the cohort. It refuses to run unless
 * `PIPELINE_LIVE_BROWSER_USE=1` and a positive
 * `PIPELINE_LIVE_BROWSER_USE_ALARM_MICROS` are both set with a key present —
 * the same two switches the smoke check uses, decided by the same pure function
 * in `tests/unit/browser-use-live-gate.test.ts`. An enable flag alone is too
 * easy to leave set; the threshold says what the operator expected to spend.
 *
 * The cohort is a third switch: `PIPELINE_BROWSER_USE_REPLAY_URLS_PATH` names a
 * JSON file holding the URLs to replay. Nothing runs unless somebody points at
 * one, because the URLs that defeated a run are a local artifact of that run and
 * belong to whoever captured them. A path that is set but unreadable fails
 * rather than skips: the operator asked for that cohort, and replaying nothing
 * would look like a pass.
 *
 * What it settles that the smoke check cannot: whether URLs a real research run
 * could not acquire are recoverable through the cloud browser, at what cost,
 * and whether every session it opens is released. A leaked session keeps billing
 * after the run is over.
 */

const URLS_PATH_ENV = 'PIPELINE_BROWSER_USE_REPLAY_URLS_PATH'

test('Browser Use replays every URL from the previously failed research run', {
  timeout: 20 * 60_000,
}, async (t) => {
  // The repository's own loader, so copying `.env.example` to `.env` is enough.
  loadDotEnv()

  const gate = browserUseLiveGate(process.env)
  if (gate.kind === 'skip') {
    t.skip(gate.reason)
    return
  }

  const urlsPath = process.env[URLS_PATH_ENV]?.trim()
  if (!urlsPath) {
    t.skip(`${URLS_PATH_ENV} must name a JSON file holding the URLs to replay.`)
    return
  }

  const cohort = readCohort(urlsPath)
  const runtime = parseCloudBrowserEnvironment(process.env)
  const acquirer = new CloudBrowserAcquirer({
    sessionClient: new BrowserUseSessionClient({
      apiKey: gate.apiKey,
      perCallBudgetMs: 60_000,
      cdpHostAllowlist: runtime.cdpHostAllowlist,
      ...(runtime.proxyCountryCode === undefined
        ? {}
        : { proxyCountryCode: runtime.proxyCountryCode }),
    }),
    networkPolicy: new BrowserNetworkPolicy({}),
    navigationTimeoutMs: 30_000,
    settleMs: 2_000,
  })

  let totalCostMicros = 0
  let evidenceCount = 0
  for (const url of cohort) {
    const result = await acquirer.acquire(url, {
      enabled: true,
      restrictDomains: false,
      domains: [],
    })
    totalCostMicros += result.runtime.browserCostMicros + result.runtime.proxyCostMicros
    if (result.evidence) evidenceCount += 1
    process.stderr.write(`${JSON.stringify({
      url,
      evidence: result.evidence !== undefined,
      stopped: result.cleanup.stopped,
      meterSource: result.runtime.meterSource,
      costMicros: result.runtime.browserCostMicros + result.runtime.proxyCostMicros,
      ...(result.failure ? { failure: result.failure.code } : {}),
    })}\n`)
    assert.equal(result.cleanup.stopped, true, `${url}: Browser Use session was not stopped`)
  }

  assert.ok(evidenceCount > 0, 'Browser Use returned no evidence for the entire cohort')
  assert.ok(
    totalCostMicros <= gate.alarmMicros,
    `Browser Use replay cost ${totalCostMicros} micros exceeded alarm ${gate.alarmMicros}`,
  )
  process.stderr.write(`${JSON.stringify({
    urls: cohort.length,
    evidenceCount,
    totalCostMicros,
  })}\n`)
})

/**
 * The URLs to replay, or a failure that names the path it could not use.
 *
 * The path is in the message every time, because the operator who set the
 * variable is the only person who can tell a typo from a deleted file.
 */
function readCohort(urlsPath: string): readonly string[] {
  let content: string
  try {
    content = fs.readFileSync(urlsPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${URLS_PATH_ENV} names ${urlsPath}, which could not be read: ${message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${URLS_PATH_ENV} names ${urlsPath}, which is not valid JSON: ${message}`)
  }

  if (!isStringArray(parsed)) {
    throw new Error(`${URLS_PATH_ENV} names ${urlsPath}, which is not a JSON array of URL strings.`)
  }
  return parsed
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
