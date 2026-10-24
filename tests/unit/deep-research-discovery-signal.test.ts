/**
 * The one authoritative discovery signal for a Deep Research run.
 *
 * Contract: a run has a discovery path when *any* recorded path returned
 * something — an Exa or Brave search, the managed-browser search fallback, a
 * managed-browser page render, or a Browser Use cloud render. When none did,
 * the signal names why by the codes the journals actually recorded, so no
 * report can describe a runtime fault, an exhausted budget, or an empty web as
 * a missing credential.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeDeepResearchDiscoveryFailure,
  describeDeepResearchDiscoveryRemediation,
  isDeepResearchBrowserDiscoveryMethod,
  isWebSearchResultsUrl,
  summarizeDeepResearchDiscovery,
} from '../../domains/deep-research/deep-research-discovery-signal.js'

const BING_RESULTS = 'https://www.bing.com/search?q=downtown+Detroit+sushi'
const DUCKDUCKGO_RESULTS = 'https://html.duckduckgo.com/html?q=sushi'

test('a search that returned results proves the path that answered it', () => {
  const signal = summarizeDeepResearchDiscovery({
    searches: [
      { succeeded: false, failureCode: 'internal' },
      { succeeded: true, providers: ['brave'] },
    ],
    browserObservations: [],
  })

  assert.equal(signal.succeeded, true)
  assert.deepEqual(signal.successfulPaths, ['brave'])
  assert.equal(signal.searchAttempts, 2)
})

test('an Exa search proves discovery just as a Brave search does', () => {
  const signal = summarizeDeepResearchDiscovery({
    searches: [{ succeeded: true, providers: ['exa'] }],
    browserObservations: [],
  })

  assert.equal(signal.succeeded, true)
  assert.deepEqual(signal.successfulPaths, ['exa'])
})

test('a managed-browser search-results page is a discovery path when every search failed', () => {
  // The failed session's shape: the search action could not read acquisition
  // settings, while the worker's own managed browser rendered search-result
  // pages and reached real sources through them.
  const signal = summarizeDeepResearchDiscovery({
    searches: Array.from({ length: 5 }, () => ({
      succeeded: false,
      failureCode: 'internal',
    })),
    browserObservations: [
      { method: 'managed-browser', requestedUrl: BING_RESULTS },
      { method: 'managed-browser', requestedUrl: DUCKDUCKGO_RESULTS },
    ],
  })

  assert.equal(signal.succeeded, true)
  assert.deepEqual(signal.successfulPaths, ['managed-browser'])
  assert.equal(signal.searchAttempts, 5)
})

test('a Browser Use cloud search-results page is a discovery path', () => {
  const signal = summarizeDeepResearchDiscovery({
    searches: [{ succeeded: false, failureCode: 'not_configured' }],
    browserObservations: [
      { method: 'cloud-browser', requestedUrl: 'https://duckduckgo.com/?q=sushi' },
    ],
  })

  assert.equal(signal.succeeded, true)
  assert.deepEqual(signal.successfulPaths, ['cloud-browser'])
})

test('a direct HTTP fetch or a parsed document is not a discovery path', () => {
  // Neither can find a URL. Counting them would let a lane that guessed URLs
  // from model memory suppress a genuine capability blocker.
  assert.equal(isDeepResearchBrowserDiscoveryMethod('direct-http'), false)
  assert.equal(isDeepResearchBrowserDiscoveryMethod('document-parser'), false)
  assert.equal(isDeepResearchBrowserDiscoveryMethod('managed-reader'), false)
  assert.equal(isDeepResearchBrowserDiscoveryMethod('managed-browser'), true)
  assert.equal(isDeepResearchBrowserDiscoveryMethod('cloud-browser'), true)

  const signal = summarizeDeepResearchDiscovery({
    searches: [{ succeeded: false, failureCode: 'not_configured' }],
    browserObservations: [
      { method: 'direct-http', requestedUrl: BING_RESULTS },
      { method: 'document-parser', requestedUrl: BING_RESULTS },
    ],
  })
  assert.equal(signal.succeeded, false)
  assert.deepEqual(signal.successfulPaths, [])
})

test('a guessed source URL opened in a browser is acquisition, not discovery', () => {
  // A lane that produced a restaurant URL from model memory and opened it in
  // the managed or cloud browser found nothing: it fetched a page it already
  // named. Counting that would let the very runs this blocker exists for
  // suppress it, so only a rendered search-results page counts.
  const signal = summarizeDeepResearchDiscovery({
    searches: [{ succeeded: false, failureCode: 'internal' }],
    browserObservations: [
      { method: 'managed-browser', requestedUrl: 'https://example.com/menu' },
      { method: 'cloud-browser', requestedUrl: 'https://www.marurestaurant.com/' },
      { method: 'managed-browser', requestedUrl: 'https://www.google.com/sorry/index' },
    ],
  })

  assert.equal(signal.succeeded, false)
  assert.deepEqual(signal.successfulPaths, [])
})

test('a search-results URL is recognised by its engine and results path alone', () => {
  // The journal canonicalises away the query string, so recognition cannot
  // depend on it.
  assert.equal(isWebSearchResultsUrl('https://www.bing.com/search'), true)
  assert.equal(isWebSearchResultsUrl(BING_RESULTS), true)
  assert.equal(isWebSearchResultsUrl(DUCKDUCKGO_RESULTS), true)
  assert.equal(isWebSearchResultsUrl('https://duckduckgo.com/?q=sushi'), true)

  assert.equal(isWebSearchResultsUrl('https://example.com/menu'), false)
  assert.equal(isWebSearchResultsUrl('https://www.google.com/sorry/index'), false)
  assert.equal(
    isWebSearchResultsUrl('https://intranet.example.com/search?q=sushi'),
    false,
    'any site may serve /search; only a known engine proves discovery',
  )
  assert.equal(
    isWebSearchResultsUrl('https://www.marurestaurant.com/search'),
    false,
  )
  assert.equal(
    isWebSearchResultsUrl('https://pages.google.com/search?q=sushi'),
    false,
    'a subdomain somebody else controls does not inherit the engine trust',
  )
  assert.equal(
    isWebSearchResultsUrl('https://duckduckgo.com/'),
    false,
    'the engine home page is not a results page',
  )
  assert.equal(isWebSearchResultsUrl('not a url'), false)
})

test('with no path at all the signal reports the codes the journal recorded', () => {
  const signal = summarizeDeepResearchDiscovery({
    searches: [
      { succeeded: false, failureCode: 'internal' },
      { succeeded: false, failureCode: 'internal' },
      { succeeded: false, failureCode: 'no_results' },
    ],
    browserObservations: [],
  })

  assert.equal(signal.succeeded, false)
  assert.deepEqual(signal.failureCodes, [
    { code: 'internal', count: 2 },
    { code: 'no_results', count: 1 },
  ])
})

test('the failure sentence names the recorded cause instead of a missing credential', () => {
  const runtimeFault = describeDeepResearchDiscoveryFailure([
    { code: 'internal', count: 5 },
  ])
  assert.match(runtimeFault, /`internal`/)
  assert.doesNotMatch(
    runtimeFault,
    /not_configured/,
    'an internal runtime fault is not an unconfigured provider',
  )

  const emptyWeb = describeDeepResearchDiscoveryFailure([
    { code: 'no_results', count: 3 },
  ])
  assert.match(emptyWeb, /`no_results`/)
  assert.doesNotMatch(emptyWeb, /not_configured/)

  const unconfigured = describeDeepResearchDiscoveryFailure([
    { code: 'not_configured', count: 2 },
  ])
  assert.match(unconfigured, /`not_configured`/)
})

test('the exhausted-budget cause covers both budgets that return the code', () => {
  // `budget_exhausted` is journalled for a spent search-call budget and for a
  // spent paid Browser Use budget on a lane with no free path left. One code
  // reaches one sentence, so the sentence has to be true of both — naming only
  // the search-call budget tells an operator whose paid rung ran out to look
  // at a counter that never moved.
  const spent = describeDeepResearchDiscoveryFailure([
    { code: 'budget_exhausted', count: 2 },
  ])

  assert.match(spent, /`budget_exhausted`/)
  assert.match(spent, /search-call budget/u)
  assert.match(spent, /Browser Use/u)
})

test('with no recorded code the remediation names no empty failure list', () => {
  // A run whose searches never reached the journal has no recorded code, so
  // the sentence must not ask the operator to clear an empty `()`. The managed
  // browser is still the action, because it is the default discovery path and
  // needs no credential.
  const remediation = describeDeepResearchDiscoveryRemediation([])

  assert.doesNotMatch(
    remediation,
    /\(\s*\)/,
    'no recorded code means no parenthesised list to render',
  )
  assert.match(remediation, /managed browser/)
})

test('a blank results endpoint the lane asked for is not a discovery', () => {
  // `https://www.bing.com/search` with no term is the engine's empty form. The
  // journal preserves the query on `requestedUrl`, so when a requested URL was
  // recorded it must carry a search term.
  assert.equal(
    isWebSearchResultsUrl('https://www.bing.com/search', {
      requireSearchTerm: true,
    }),
    false,
  )
  assert.equal(
    isWebSearchResultsUrl(BING_RESULTS, { requireSearchTerm: true }),
    true,
  )

  assert.equal(
    summarizeDeepResearchDiscovery({
      searches: [{ succeeded: false, failureCode: 'internal' }],
      browserObservations: [
        { method: 'managed-browser', requestedUrl: 'https://www.bing.com/search' },
      ],
    }).succeeded,
    false,
  )
})

test('a canonicalised results URL still counts when no requested URL was recorded', () => {
  // Canonicalisation drops the query, so a journal entry that kept only the
  // canonical form cannot be asked for a term it never stored.
  assert.equal(
    summarizeDeepResearchDiscovery({
      searches: [{ succeeded: false, failureCode: 'internal' }],
      browserObservations: [
        { method: 'managed-browser', canonicalUrl: 'https://www.bing.com/search' },
      ],
    }).succeeded,
    true,
  )
})
