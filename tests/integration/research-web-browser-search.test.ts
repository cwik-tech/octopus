/**
 * Search discovery falls back to the managed browser.
 *
 * Contract: a research lane must be able to discover sources without a paid
 * search API key. When no Exa/Brave provider is configured, `research_web`
 * renders the query through the managed browser already used for evidence
 * acquisition and returns ordinary search results. `not_configured` is
 * reserved for the case where no discovery path exists at all — no API
 * provider *and* no browser — because that is the only state an operator has
 * to act on. Without this, a keyless run has no discovery path left and the
 * lane reaches for URLs it can only have invented.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import type { AcquisitionSettingsUpdate } from '../../domains/acquisition/acquisition-settings.js'
import {
  isAcquisitionAttempt,
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
} from '../../domains/acquisition/acquisition-types.js'
import type { CloudAcquisitionResult } from '../../domains/browser/cloud-browser-acquirer.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import {
  AcquisitionSettingsService,
  type AcquisitionSettingsServiceOptions,
} from '../../services/acquisition-settings-service.js'
import { ResearchWebCapabilityDispatchGateway } from '../../services/research-web-capability-adapter.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

const RESULTS_HTML = [
  '<a href="https://example.com/scoop-shops">Detroit scoop shops</a>',
  '<a href="https://second.example.org/guide">A Detroit ice cream guide</a>',
].join('')

test('a keyless search discovers sources through the managed browser', async (context) => {
  const rendered: string[] = []
  const fixture = await createFixture(context, {
    update: settingsUpdate({ exaEnabled: false }),
    renderer: {
      acquireEvidence: async (_scope, url) => {
        rendered.push(url)
        return { renderedHtml: RESULTS_HTML, finalUrl: url }
      },
    },
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-browser-search',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, true, JSON.stringify(output))
  assert.deepEqual(
    output.results?.map((result) => result.url),
    ['https://example.com/scoop-shops', 'https://second.example.org/guide'],
  )
  assert.equal(rendered.length, 1, 'the query was rendered once')

  const activities = await fixture.service.listSession(
    fixture.requestContext.sessionId,
  )
  const search = activities.find((activity) => activity.action === 'search')
  assert.equal(search?.state, 'completed')
  assert.equal(search?.resultCount, 2)
})

test('configured search-provider outages fall back to the managed browser', async (context) => {
  const provider = await startUnavailableSearchProviders()
  context.after(() => provider.close())
  const rendered: string[] = []
  const fixture = await createFixture(context, {
    update: settingsUpdate({ exaEnabled: true, braveEnabled: true }),
    environment: {
      EXA_API_KEY: 'test-exa-key',
      BRAVE_SEARCH_API_KEY: 'test-brave-key',
    },
    providerEndpoints: {
      exa: `${provider.origin}/exa`,
      brave: `${provider.origin}/brave`,
    },
    renderer: {
      acquireEvidence: async (_scope, url) => {
        rendered.push(url)
        return { renderedHtml: RESULTS_HTML, finalUrl: url }
      },
    },
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-provider-outages',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, true, JSON.stringify(output))
  assert.deepEqual(provider.requestPaths, ['/exa', '/brave'])
  assert.equal(rendered.length, 1, 'managed browser search was attempted once')
  assert.deepEqual(
    output.results?.map((result) => result.provider),
    ['browser', 'browser'],
  )
})

test('search stays unconfigured only when no discovery path exists at all', async (context) => {
  const fixture = await createFixture(context, {
    update: settingsUpdate({ exaEnabled: false }),
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-no-discovery',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'not_configured')
  assert.match(
    output.error?.message ?? '',
    /browser/i,
    'the operator is told the browser path is also unavailable',
  )
})

test('a browser search consumes the lane search budget', async (context) => {
  const fixture = await createFixture(context, {
    update: settingsUpdate({ exaEnabled: false, maximumSearchCalls: 1 }),
    renderer: {
      acquireEvidence: async (_scope, url) => ({
        renderedHtml: RESULTS_HTML,
        finalUrl: url,
      }),
    },
  })

  const first = await fixture.service.execute(
    fixture.requestContext,
    'call-budget-1',
    { action: 'search', query: 'first query' },
  )
  const second = await fixture.service.execute(
    fixture.requestContext,
    'call-budget-2',
    { action: 'search', query: 'second query' },
  )

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.error?.code, 'budget_exhausted')
})

test('an unavailable browser reports a search failure, never an empty result set', async (context) => {
  const fixture = await createFixture(context, {
    update: settingsUpdate({ exaEnabled: false }),
    renderer: {
      acquireEvidence: async () => {
        throw new Error('Managed Chrome is not running.')
      },
    },
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-browser-down',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, false, 'a broken browser must not read as no results')
  assert.notEqual(
    output.results?.length,
    0,
    'an empty success would let the lane conclude the web has nothing',
  )
})

test('an unavailable managed-browser search falls back to Browser Use', async (context) => {
  const cloudCalls: string[] = []
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumCloudBrowserCalls: 1,
    }),
    renderer: {
      acquireEvidence: async () => {
        throw new Error('Managed Chrome search failed before results rendered.')
      },
    },
    cloud: {
      async acquire(url): Promise<CloudAcquisitionResult> {
        cloudCalls.push(url)
        return {
          evidence: {
            requestedUrl: url,
            finalUrl: url,
            text: 'Rendered search results',
            renderedHtml: RESULTS_HTML,
            renderedHtmlTruncated: false,
          },
          runtime: {
            provider: 'browser-use',
            proxyCountry: 'none',
            browserCostMicros: 334,
            proxyCostMicros: 0,
            proxyUsedMilliMb: 0,
            sessionStatus: 'stopped',
            meterSource: 'stop-confirmed',
          },
          cleanup: { stopped: true },
        }
      },
    },
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-cloud-browser-search',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, true, JSON.stringify(output))
  assert.equal(cloudCalls.length, 1, 'Browser Use search was attempted once')
  assert.deepEqual(
    output.results?.map((result) => result.url),
    ['https://example.com/scoop-shops', 'https://second.example.org/guide'],
  )
  assert.equal(output.attempts?.at(-1)?.method, 'cloud-browser')
  assert.equal(
    output.attempts?.at(-1)?.cloudBrowserRuntime?.sessionStatus,
    'stopped',
  )
})

test('Browser Use search moves to a second engine after a challenge', async (context) => {
  const cloudCalls: string[] = []
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumCloudBrowserCalls: 2,
    }),
    renderer: {
      acquireEvidence: async () => {
        throw new Error('Managed Chrome search failed before results rendered.')
      },
    },
    cloud: {
      async acquire(url): Promise<CloudAcquisitionResult> {
        cloudCalls.push(url)
        const challenged = new URL(url).hostname.includes('duckduckgo.com')
        return {
          evidence: {
            requestedUrl: url,
            finalUrl: url,
            text: challenged
              ? 'Please complete the following challenge to confirm this search was made by a human.'
              : 'Rendered search results',
            renderedHtml: challenged
              ? '<div>Please complete the following challenge to confirm this search was made by a human.</div>'
              : RESULTS_HTML,
            renderedHtmlTruncated: false,
          },
          runtime: {
            provider: 'browser-use',
            proxyCountry: 'none',
            browserCostMicros: 334,
            proxyCostMicros: 0,
            proxyUsedMilliMb: 0,
            sessionStatus: 'stopped',
            meterSource: 'stop-confirmed',
          },
          cleanup: { stopped: true },
        }
      },
    },
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-cloud-browser-search-failover',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, true, JSON.stringify(output))
  assert.equal(cloudCalls.length, 2, 'each search engine uses one bounded session')
  assert.match(cloudCalls[0] ?? '', /duckduckgo\.com/u)
  assert.match(cloudCalls[1] ?? '', /search\.brave\.com/u)
  assert.deepEqual(
    output.attempts?.map((attempt) => attempt.outcome),
    ['challenge', 'usable'],
  )
  assert.deepEqual(
    output.results?.map((result) => result.provider),
    ['browser-use', 'browser-use'],
  )
})

test('a bot challenge is journalled as a failed search, not a successful one', async (context) => {
  const fixture = await createFixture(context, {
    update: settingsUpdate({ exaEnabled: false }),
    renderer: {
      acquireEvidence: async (_scope, url) => ({
        renderedHtml:
          '<a href="/html/">DuckDuckGo</a>' +
          '<div>Please complete the following challenge to confirm this ' +
          'search was made by a human. Select all squares containing a duck:</div>' +
          '<a href="https://duckduckgo.com/">here</a>',
        finalUrl: url,
      }),
    },
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-challenged',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, false, 'a challenge is not a search result')
  assert.equal(output.error?.code, 'access_challenge')
  assert.equal(
    output.results?.length,
    undefined,
    "the engine's own links must never be presented as discovered sources",
  )

  const activities = await fixture.service.listSession(
    fixture.requestContext.sessionId,
  )
  const search = activities.find((activity) => activity.action === 'search')
  assert.equal(
    search?.state,
    'failed',
    'a blocked search journalled as completed makes evidence starvation invisible',
  )
})

test('an unlimited cloud spend threshold keeps malformed settings out of the reported challenge', async (context) => {
  // Zero permits the cloud rung. Its malformed configuration must still not
  // replace the browser challenge that actually blocked discovery.
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumCloudBrowserCalls: 1,
      maximumCloudBrowserCostMicros: 0,
    }),
    environment: { BROWSER_USE_PROXY_COUNTRY: 'United Kingdom' },
    renderer: {
      acquireEvidence: async (_scope, url) => ({
        renderedHtml:
          '<a href="/html/">DuckDuckGo</a>' +
          '<div>Please complete the following challenge to confirm this ' +
          'search was made by a human. Select all squares containing a duck:</div>' +
          '<a href="https://duckduckgo.com/">here</a>',
        finalUrl: url,
      }),
    },
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-challenge-exhausted-cloud',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, false, JSON.stringify(output))
  assert.equal(
    output.error?.code,
    'access_challenge',
    'the lane hit a verification wall, not a settings fault',
  )
  assert.doesNotMatch(
    output.error?.message ?? '',
    /proxy country/iu,
    'the cloud settings fault must not replace the browser challenge',
  )
})

test('a funded cloud rung with malformed settings reports the wall, and journals the fault', async (context) => {
  // The ordinary state: a lane with paid budget left and one mistyped runtime
  // variable. Resolving the provider is what fails, so unless the failure is
  // caught the lane reports a retryable `internal` settings error and the
  // verification wall that actually stopped discovery is never seen. The
  // setting is still an operator's to fix, so it is journalled on the search
  // activity rather than dropped.
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumCloudBrowserCalls: 1,
      maximumCloudBrowserCostMicros: 10_000,
    }),
    environment: { BROWSER_USE_PROXY_COUNTRY: 'United Kingdom' },
    renderer: {
      acquireEvidence: async (_scope, url) => ({
        renderedHtml:
          '<a href="/html/">DuckDuckGo</a>' +
          '<div>Please complete the following challenge to confirm this ' +
          'search was made by a human. Select all squares containing a duck:</div>' +
          '<a href="https://duckduckgo.com/">here</a>',
        finalUrl: url,
      }),
    },
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-challenge-funded-cloud',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.ok, false, JSON.stringify(output))
  assert.equal(
    output.error?.code,
    'access_challenge',
    'the lane hit a verification wall, not a settings fault',
  )
  assert.doesNotMatch(
    output.error?.message ?? '',
    /proxy country/iu,
    'an unusable paid rung must not replace the cause the lane actually met',
  )
  const activities = await fixture.service.listSession(
    fixture.requestContext.sessionId,
  )
  const search = activities.find((activity) => activity.action === 'search')
  assert.match(
    search?.cloudBrowserSettingsFault ?? '',
    /proxy country/iu,
    'a settings fault nobody can see is its own defect: the journal records why the rung could not run',
  )
  for (const attempt of output.attempts ?? []) {
    assert.ok(
      isAcquisitionAttempt(attempt),
      `a fault that opened no session is no attempt: ${JSON.stringify(attempt)}`,
    )
  }
})

test('a spent paid rung with no free path reports the budget, not a missing credential', async (context) => {
  // Browser Use is enabled and keyed and it is the lane's only discovery path.
  // Once its call budget is spent there is nothing left to exercise, and
  // reporting that as `not_configured` sends the operator to buy a search API
  // key for a lane whose real blocker is the paid budget it already spent.
  const cloudCalls: string[] = []
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumSearchCalls: 2,
      maximumCloudBrowserCalls: 1,
    }),
    cloud: {
      async acquire(url): Promise<CloudAcquisitionResult> {
        cloudCalls.push(url)
        return {
          evidence: {
            requestedUrl: url,
            finalUrl: url,
            text: 'Rendered search results',
            renderedHtml: RESULTS_HTML,
            renderedHtmlTruncated: false,
          },
          runtime: {
            provider: 'browser-use',
            proxyCountry: 'none',
            browserCostMicros: 334,
            proxyCostMicros: 0,
            proxyUsedMilliMb: 0,
            sessionStatus: 'stopped',
            meterSource: 'stop-confirmed',
          },
          cleanup: { stopped: true },
        }
      },
    },
  })

  const outputs = []
  for (let call = 0; call < 5; call += 1) {
    outputs.push(
      await fixture.service.execute(
        fixture.requestContext,
        `call-cloud-spent-${call}`,
        { action: 'search', query: `ice cream query ${call}` },
      ),
    )
  }

  assert.deepEqual(
    outputs.map((output) => (output.ok ? 'ok' : output.error?.code)),
    ['ok', 'budget_exhausted', 'budget_exhausted', 'budget_exhausted', 'budget_exhausted'],
    JSON.stringify(outputs.map((output) => output.error?.message)),
  )
  assert.equal(cloudCalls.length, 1, 'the spent rung is never re-entered')
  assert.doesNotMatch(
    outputs[1]?.error?.message ?? '',
    /Browser Use is (?:not|un)available|neither the managed browser nor Browser Use/iu,
    'Browser Use is enabled and keyed; only its budget ran out',
  )
})

test('a cloud-only lane with unreadable settings names the fault and stops retrying', async (context) => {
  // Browser Use is enabled, keyed and funded, so it is the lane's only
  // discovery path — and one mistyped runtime variable makes it unbuildable.
  // A call that reached that rung exercised it, so it spends its place in the
  // search budget and the lane converges. Reporting `not_configured` instead
  // sends the operator to buy a search API key for a settings typo the runtime
  // already holds, and returns the search budget so the lane retries forever.
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumSearchCalls: 2,
      maximumCloudBrowserCalls: 4,
    }),
    environment: { BROWSER_USE_PROXY_COUNTRY: 'United Kingdom' },
  })

  const outputs = []
  for (let call = 0; call < 6; call += 1) {
    outputs.push(
      await fixture.service.execute(
        fixture.requestContext,
        `call-settings-fault-${call}`,
        { action: 'search', query: `ice cream query ${call}` },
      ),
    )
  }

  assert.deepEqual(
    outputs.map((output) => (output.ok ? 'ok' : output.error?.code)),
    [
      'internal',
      'internal',
      'budget_exhausted',
      'budget_exhausted',
      'budget_exhausted',
      'budget_exhausted',
    ],
    JSON.stringify(outputs.map((output) => output.error?.message)),
  )
  assert.match(
    outputs[0]?.error?.message ?? '',
    /proxy country/iu,
    'the setting the operator has to fix is named',
  )
  assert.doesNotMatch(
    outputs[0]?.error?.message ?? '',
    /neither the managed browser nor Browser Use is available/iu,
    'Browser Use is enabled and keyed; only its settings are unreadable',
  )
  const activities = await fixture.service.listSession(
    fixture.requestContext.sessionId,
  )
  const firstCall = activities.find(
    (activity) => activity.toolCallId === 'call-settings-fault-0',
  )
  assert.match(
    firstCall?.cloudBrowserSettingsFault ?? '',
    /proxy country/iu,
    'the first call journals the fault that made its only rung unusable',
  )
})

test('a cloud-only settings fault reaches a caller through the capability boundary', async (context) => {
  // The named settings reason is this path's whole deliverable, and it only
  // helps if a caller receives it. The governed boundary validates every
  // element of `attempts` with the shared domain guard and refuses the entire
  // output when one element fails, so an attempt the guard rejects deletes the
  // failure it was attached to.
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumSearchCalls: 2,
      maximumCloudBrowserCalls: 4,
    }),
    environment: { BROWSER_USE_PROXY_COUNTRY: 'United Kingdom' },
  })

  const output = await createDispatchGateway(fixture.service).execute({
    context: fixture.requestContext,
    authority: { kind: 'mcp-lease', leaseId: fixture.requestContext.leaseId },
    source: {
      kind: 'builtin',
      id: RESEARCH_WEB_SERVER_ID,
      version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
    },
    toolCallId: 'call-governed-settings-fault',
    input: { action: 'search', query: 'ice cream downtown detroit' },
  })

  assert.equal(output.ok, false, JSON.stringify(output))
  assert.match(
    output.error?.message ?? '',
    /proxy country/iu,
    'a caller past the boundary is told which setting to fix',
  )
  for (const attempt of output.attempts ?? []) {
    assert.ok(
      isAcquisitionAttempt(attempt),
      `the boundary refuses the whole output over one rejected attempt: ${JSON.stringify(attempt)}`,
    )
  }
})

test('a spent cloud cost budget is not reported as a spent call budget', async (context) => {
  // Three different verdicts close the paid rung, and this early return names
  // one of them for all three. Here two of the four paid calls are still
  // unspent and the cost ceiling is what stopped the lane, so naming the call
  // budget sends the operator to raise a limit that never moved.
  const cloudCalls: string[] = []
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumSearchCalls: 3,
      maximumCloudBrowserCalls: 4,
      maximumCloudBrowserCostMicros: 300,
    }),
    cloud: {
      async acquire(url): Promise<CloudAcquisitionResult> {
        cloudCalls.push(url)
        return {
          evidence: {
            requestedUrl: url,
            finalUrl: url,
            text: 'Rendered search results',
            renderedHtml: RESULTS_HTML,
            renderedHtmlTruncated: false,
          },
          runtime: {
            provider: 'browser-use',
            proxyCountry: 'none',
            browserCostMicros: 334,
            proxyCostMicros: 0,
            proxyUsedMilliMb: 0,
            sessionStatus: 'stopped',
            meterSource: 'stop-confirmed',
          },
          cleanup: { stopped: true },
        }
      },
    },
  })

  const first = await fixture.service.execute(
    fixture.requestContext,
    'call-cloud-cost-1',
    { action: 'search', query: 'ice cream downtown detroit' },
  )
  const second = await fixture.service.execute(
    fixture.requestContext,
    'call-cloud-cost-2',
    { action: 'search', query: 'ice cream midtown detroit' },
  )

  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(cloudCalls.length, 1, 'one paid session of four was spent')
  assert.equal(second.error?.code, 'budget_exhausted', JSON.stringify(second))
  assert.doesNotMatch(
    second.error?.message ?? '',
    /call budget/iu,
    'the call budget still has three of its four calls left',
  )
  assert.match(
    second.error?.message ?? '',
    /cost budget/iu,
    'the counter that actually stopped the lane is the one an operator is sent at',
  )
})

test('a paid rung that was never enabled is not reported as one that stopped working', async (context) => {
  // A non-zero cloud call budget is not an enabled provider, and nothing
  // couples the two settings, so this is an ordinary static misconfiguration.
  // The lane is admitted on the budget, finds no provider to build, and must
  // not tell the operator that a rung it never had stopped working: a cause
  // that names a state change nobody made is the misattribution this whole
  // path exists to remove.
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: false,
      maximumCloudBrowserCalls: 4,
      maximumCloudBrowserCostMicros: 10_000,
    }),
  })

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-unenabled-rung',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.error?.code, 'not_configured', JSON.stringify(output))
  assert.doesNotMatch(
    output.error?.message ?? '',
    /could no longer run|no longer there|between the two/iu,
    'the very first search of a lane cannot have watched a rung stop working',
  )
  assert.match(
    output.error?.message ?? '',
    /neither the managed browser nor Browser Use is available/u,
    'what both routes to this failure know is that nothing was available to run',
  )
})

test('a session whose bill never came back is named as its own closure', async (context) => {
  // The third verdict `outOfCloudBudget` can return. Neither budget moved past
  // its ceiling: one session came back without a confirmed meter, and an
  // unknown bill is not a zero bill. Naming either budget here sends the
  // operator to raise a limit that is still intact.
  const cloudCalls: string[] = []
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumSearchCalls: 3,
      maximumCloudBrowserCalls: 4,
      maximumCloudBrowserCostMicros: 10_000,
    }),
    cloud: {
      async acquire(url): Promise<CloudAcquisitionResult> {
        cloudCalls.push(url)
        return {
          runtime: {
            provider: 'browser-use',
            proxyCountry: 'none',
            browserCostMicros: 0,
            proxyCostMicros: 0,
            proxyUsedMilliMb: 0,
            sessionStatus: 'unknown',
            meterSource: 'unavailable',
          },
          cleanup: { stopped: false },
        }
      },
    },
  })

  const first = await fixture.service.execute(
    fixture.requestContext,
    'call-unmetered-1',
    { action: 'search', query: 'ice cream downtown detroit' },
  )
  const second = await fixture.service.execute(
    fixture.requestContext,
    'call-unmetered-2',
    { action: 'search', query: 'ice cream midtown detroit' },
  )

  assert.equal(first.ok, false, JSON.stringify(first))
  assert.ok(cloudCalls.length > 0, 'the paid rung ran at least once')
  assert.equal(second.error?.code, 'budget_exhausted', JSON.stringify(second))
  assert.doesNotMatch(
    second.error?.message ?? '',
    /budget for this research lane is exhausted/u,
    'neither budget reached its ceiling',
  )
  assert.match(
    second.error?.message ?? '',
    /without a confirmed bill/u,
    'the unconfirmed meter is what closed the rung, so it is what the lane names',
  )
})

test('an unlimited cloud spend threshold still resolves the cloud provider', async (context) => {
  // Zero means unlimited spend, so an enabled provider is resolved.
  const fixture = await createFixture(context, {
    update: settingsUpdate({
      exaEnabled: false,
      browserUseEnabled: true,
      maximumCloudBrowserCalls: 1,
      maximumCloudBrowserCostMicros: 0,
    }),
    environment: { BROWSER_USE_PROXY_COUNTRY: 'United Kingdom' },
    renderer: {
      acquireEvidence: async (_scope, url) => ({
        renderedHtml:
          '<a href="/html/">DuckDuckGo</a>' +
          '<div>Please complete the following challenge to confirm this ' +
          'search was made by a human. Select all squares containing a duck:</div>' +
          '<a href="https://duckduckgo.com/">here</a>',
        finalUrl: url,
      }),
    },
  })
  let cloudSettingsReads = 0
  const resolveCloudBrowser = fixture.settings.cloudBrowser.bind(fixture.settings)
  fixture.settings.cloudBrowser = async () => {
    cloudSettingsReads += 1
    return resolveCloudBrowser()
  }

  const output = await fixture.service.execute(
    fixture.requestContext,
    'call-closed-rung-settings',
    { action: 'search', query: 'ice cream downtown detroit' },
  )

  assert.equal(output.error?.code, 'access_challenge', JSON.stringify(output))
  assert.equal(
    cloudSettingsReads,
    1,
    'a zero spend threshold must not prevent resolving the enabled provider',
  )
})

interface RendererStub {
  acquireEvidence(
    scope: unknown,
    url: string,
    signal?: AbortSignal,
  ): Promise<{ readonly renderedHtml: string; readonly finalUrl: string }>
}

async function createFixture(
  context: { after(callback: () => Promise<unknown> | unknown): unknown },
  options: {
    readonly update: AcquisitionSettingsUpdate
    readonly renderer?: RendererStub
    readonly cloud?: {
      acquire(
        url: string,
        policy: unknown,
        signal?: AbortSignal,
      ): Promise<CloudAcquisitionResult>
    }
    readonly environment?: NodeJS.ProcessEnv
    readonly providerEndpoints?: AcquisitionSettingsServiceOptions['providerEndpoints']
  },
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'research-browser-search-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const agentPath = 'agents/researcher'
  await fs.mkdir(path.join(repoRootPath, agentPath), { recursive: true })
  await fs.writeFile(
    path.join(repoRootPath, agentPath, 'researcher.md'),
    ['---', 'name: researcher', 'tools: read, research_web', '---', '', '# Researcher', ''].join('\n'),
  )
  const requestContext = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-browser-search',
    leaseId: 'lease-browser-search',
    sessionId: 'session-browser-search',
    runId: 'run-browser-search',
    assignmentId: 'assignment-browser-search',
    activityScopeId: 'lane-browser-search',
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, requestContext)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  const settings = new AcquisitionSettingsService({
    storagePath: path.join(root, 'settings.json'),
    environment: options.environment ?? {},
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    ...(options.providerEndpoints
      ? { providerEndpoints: options.providerEndpoints }
      : {}),
  })
  await settings.update(options.update)
  return {
    requestContext,
    settings,
    service: new ResearchWebToolService({
      workspacePath,
      repoRootPath,
      settings,
      allowHttpLocalhost: true,
      ...(options.renderer ? { browserSearchRenderer: options.renderer } : {}),
      ...(options.cloud ? { cloudAcquirer: options.cloud } : {}),
    }),
  }
}

/**
 * The service behind the governed dispatcher every production caller goes
 * through. Authority, policy, and budget are permissive here: what is under
 * test is the output validation the boundary applies on the way back.
 */
function createDispatchGateway(
  service: ResearchWebToolService,
): ResearchWebCapabilityDispatchGateway {
  let attempt = 0
  return new ResearchWebCapabilityDispatchGateway({
    service,
    dispatcher: new CapabilityDispatcher({
      bindings: new CapabilityInvocationBindings({
        maxActivePerScope: 4,
        maxRetainedPerScope: 16,
      }),
      authority: { authorize: async () => ({ kind: 'allow' }) },
      policy: { evaluate: async () => ({ kind: 'allow' }) },
      budget: {
        preflight: async () => ({ kind: 'not-metered' }),
        reserve: async () => ({ reservationId: 'unexpected-reservation' }),
        settle: async () => ({ costTracked: false, budgetOverrun: false }),
        release: async () => undefined,
      },
      evidence: { append: async () => undefined },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: Date.now },
      ids: {
        nextAttemptId: () => {
          attempt += 1
          return `browser-search-attempt-${attempt}`
        },
      },
    }),
  })
}

function settingsUpdate(options: {
  readonly exaEnabled?: boolean
  readonly braveEnabled?: boolean
  readonly browserUseEnabled?: boolean
  readonly maximumSearchCalls?: number
  readonly maximumCloudBrowserCalls?: number
  readonly maximumCloudBrowserCostMicros?: number
}): AcquisitionSettingsUpdate {
  return {
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: options.exaEnabled ?? false },
      brave: { enabled: options.braveEnabled ?? false },
      firecrawl: { enabled: false },
      'browser-use': {
        enabled: options.browserUseEnabled ?? false,
        ...(options.browserUseEnabled ? { apiKey: 'bu_key' } : {}),
      },
    },
    budgets: {
      maximumSearchCalls: options.maximumSearchCalls ?? 4,
      maximumBrowserFallbacks: 2,
      maximumManagedReaderCalls: 1,
      maximumModelExtractions: 1,
      maximumCloudBrowserCalls: options.maximumCloudBrowserCalls ?? 0,
      maximumCloudBrowserCostMicros:
        options.maximumCloudBrowserCostMicros ??
          ((options.maximumCloudBrowserCalls ?? 0) > 0 ? 10_000 : 0),
    },
    extractionModel: null,
  }
}

async function startUnavailableSearchProviders(): Promise<{
  readonly origin: string
  readonly requestPaths: string[]
  close(): Promise<void>
}> {
  const requestPaths: string[] = []
  const server = http.createServer((request, response) => {
    requestPaths.push(new URL(request.url ?? '/', 'http://localhost').pathname)
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'provider unavailable' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requestPaths,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    }),
  }
}
