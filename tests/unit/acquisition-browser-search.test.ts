/**
 * Browser-backed search discovery.
 *
 * Contract: source discovery must not require a paid search API key. When no
 * Exa/Brave provider is configured the managed browser renders a search engine
 * results page and the same `ResearchSearchResult[]` is returned, so a lane
 * never has to fall back to guessing URLs from model memory.
 *
 * This file covers the pure half: rendered SERP HTML in, ranked results out.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BrowserSearchChallengeError,
  BrowserSearchProvider,
  parseBrowserSearchResults,
} from '../../domains/acquisition/acquisition-browser-search.js'

const SCOPE = {
  sessionId: 'session-one',
  runId: 'run-one',
  assignmentId: 'assignment-one',
  assignmentPath: '/tmp/assignment-one',
  policy: {} as never,
} as const

const ENGINE_URL = 'https://duckduckgo.com/html/?q=ice+cream+detroit'

test('result anchors become ranked search results', () => {
  const results = parseBrowserSearchResults({
    html: `
      <div class="result">
        <a class="result__a" href="https://example.com/best-ice-cream">Best ice cream in Detroit</a>
        <a class="result__snippet">A guide to Detroit scoop shops.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://second.example.org/shops">Detroit shops</a>
      </div>
    `,
    engineUrl: ENGINE_URL,
    maximumResults: 10,
  })

  assert.equal(results.length, 2)
  assert.equal(results[0]?.url, 'https://example.com/best-ice-cream')
  assert.equal(results[0]?.title, 'Best ice cream in Detroit')
  assert.equal(results[0]?.provider, 'browser')
  assert.ok(
    results[0]!.score > results[1]!.score,
    'earlier results outrank later ones',
  )
})

test('engine redirect wrappers resolve to the destination URL', () => {
  const results = parseBrowserSearchResults({
    html: `
      <a class="result__a"
         href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&amp;rut=abc">
        Wrapped result
      </a>
    `,
    engineUrl: ENGINE_URL,
    maximumResults: 10,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0]?.url, 'https://example.com/page?a=1')
})

test('engine chrome, duplicates and unusable links are discarded', () => {
  const results = parseBrowserSearchResults({
    html: `
      <a href="https://duckduckgo.com/settings">Settings</a>
      <a href="/html/?q=next+page">Next page</a>
      <a href="javascript:void(0)">Nope</a>
      <a href="mailto:someone@example.com">Mail</a>
      <a href="https://example.com/page">First</a>
      <a href="https://example.com/page#section">First again</a>
      <a href="https://example.com/other"></a>
    `,
    engineUrl: ENGINE_URL,
    maximumResults: 10,
  })

  assert.deepEqual(
    results.map((result) => result.url),
    ['https://example.com/page'],
    'the engine own host, relative chrome, non-http schemes, fragment ' +
      'duplicates and untitled links are all excluded',
  )
})

test('results are capped at the requested maximum', () => {
  const html = Array.from(
    { length: 12 },
    (_unused, index) =>
      `<a href="https://example.com/page-${index}">Result ${index}</a>`,
  ).join('')

  const results = parseBrowserSearchResults({
    html,
    engineUrl: ENGINE_URL,
    maximumResults: 5,
  })
  assert.equal(results.length, 5)
})

test('a results page with no usable anchors yields no results rather than throwing', () => {
  assert.deepEqual(
    parseBrowserSearchResults({
      html: '<html><body><p>No results found.</p></body></html>',
      engineUrl: ENGINE_URL,
      maximumResults: 10,
    }),
    [],
  )
})

test('a malformed href never fails the whole page', () => {
  const results = parseBrowserSearchResults({
    html: `
      <a href="ht!tp://[not a url">Broken</a>
      <a href="https://user:pass@example.com/creds">Credentialed</a>
      <a href="https://example.com/good">Good</a>
    `,
    engineUrl: ENGINE_URL,
    maximumResults: 10,
  })
  assert.deepEqual(results.map((result) => result.url), ['https://example.com/good'])
})

test('the browser provider renders a query and returns ranked results', async () => {
  const rendered: string[] = []
  const provider = new BrowserSearchProvider({
    acquireEvidence: async (_scope, url) => {
      rendered.push(url)
      return {
        requestedUrl: url,
        finalUrl: url,
        text: '',
        renderedHtml:
          '<a href="https://example.com/one">One</a>' +
          '<a href="https://example.com/two">Two</a>',
        renderedHtmlTruncated: false,
      }
    },
  }, SCOPE)

  const results = await provider.search({
    query: 'ice cream detroit',
    maximumResults: 10,
    includeDomains: [],
    excludeDomains: [],
  })

  assert.equal(provider.id, 'browser')
  assert.equal(rendered.length, 1)
  assert.match(
    rendered[0]!,
    /ice\+cream\+detroit|ice%20cream%20detroit/,
    'the query reaches the engine URL',
  )
  assert.deepEqual(
    results.map((result) => result.url),
    ['https://example.com/one', 'https://example.com/two'],
  )
})

test('include and exclude domains reach the rendered query', async () => {
  let renderedUrl = ''
  const provider = new BrowserSearchProvider({
    acquireEvidence: async (_scope, url) => {
      renderedUrl = url
      return {
        requestedUrl: url,
        finalUrl: url,
        text: '',
        renderedHtml: '',
        renderedHtmlTruncated: false,
      }
    },
  }, SCOPE)

  await provider.search({
    query: 'gelato',
    maximumResults: 5,
    includeDomains: ['example.com'],
    excludeDomains: ['spam.example'],
  })

  const query = new URL(renderedUrl).searchParams.get('q') ?? ''
  assert.match(query, /site:example\.com/, 'included domains narrow the query')
  assert.match(query, /-site:spam\.example/, 'excluded domains are negated')
})

test('a browser failure surfaces as a search failure rather than empty results', async () => {
  const provider = new BrowserSearchProvider({
    acquireEvidence: async () => {
      throw new Error('Managed Chrome is not running.')
    },
  }, SCOPE)

  await assert.rejects(
    provider.search({
      query: 'gelato',
      maximumResults: 5,
      includeDomains: [],
      excludeDomains: [],
    }),
    /Managed Chrome is not running\./,
    'an unavailable browser must not read as "the web has nothing"',
  )
})

/**
 * A search engine that answers with a bot challenge has not searched.
 *
 * Observed live: every query to the no-JavaScript endpoint returned
 * "Please complete the following challenge to confirm this search was made by
 * a human. Select all squares containing a duck". The parser found the page's
 * own "here" link and reported `resultCount: 1`, so fourteen consecutive
 * blocked searches were journalled as successes and the lane was starved of
 * evidence while believing discovery had worked. A search that cannot search
 * must fail loudly.
 */
const CHALLENGE_PAGE = `
<html><body>
  <a href="/html/">DuckDuckGo</a>
  <div>
    Unfortunately, bots use DuckDuckGo too. Please complete the following
    challenge to confirm this search was made by a human.
    Select all squares containing a duck:
  </div>
  <a href="https://duckduckgo.com/">here</a>
</body></html>
`

test('a bot challenge is reported as a challenge, never as results', () => {
  assert.throws(
    () => parseBrowserSearchResults({
      html: CHALLENGE_PAGE,
      engineUrl: 'https://html.duckduckgo.com/html/?q=ice+cream+detroit',
      maximumResults: 10,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserSearchChallengeError)
      return true
    },
    'a challenge page must never be mistaken for an exhausted web',
  )
})

test('the engine own domain is filtered across subdomains', () => {
  // The results page is served from html.duckduckgo.com while its own links
  // point at duckduckgo.com. An exact hostname comparison let the engine's
  // homepage through as though it were a discovered source.
  const results = parseBrowserSearchResults({
    html: '<a href="https://duckduckgo.com/">here</a>' +
      '<a href="https://duckduckgo.com/settings">Settings</a>' +
      '<a href="https://example.com/real">A real result</a>',
    engineUrl: 'https://html.duckduckgo.com/html/?q=ice+cream+detroit',
    maximumResults: 10,
  })
  assert.deepEqual(results.map((result) => result.url), ['https://example.com/real'])
})

test('a genuinely empty results page is not treated as a challenge', () => {
  assert.deepEqual(
    parseBrowserSearchResults({
      html: '<html><body><p>No results found for that query.</p></body></html>',
      engineUrl: 'https://html.duckduckgo.com/html/?q=zzzz',
      maximumResults: 10,
    }),
    [],
    'no results is a real answer; a challenge is not',
  )
})

test('challenge wording alongside real results is not a challenge', () => {
  // A query about CAPTCHAs returns pages whose text mentions them. Only a page
  // that yielded no usable result at all can be a block.
  const results = parseBrowserSearchResults({
    html: '<a href="https://example.com/a">How to verify you are human</a>' +
      '<a href="https://example.com/b">Select all squares containing a duck explained</a>',
    engineUrl: 'https://html.duckduckgo.com/html/?q=captcha',
    maximumResults: 10,
  })
  assert.equal(results.length, 2, 'real results prove the search was served')
})


/**
 * The two conditions this file already covered separately, now crossed.
 *
 * `parseBrowserSearchResults` is handed `rendered.finalUrl`, which is the URL
 * *after* the engine's redirect. DuckDuckGo serves `duckduckgo.com/html/` from
 * `html.duckduckgo.com` and wraps its outbound links on `duckduckgo.com`, so in
 * production the anchor host and the engine host never match exactly — and an
 * exact comparison skips the unwrap, after which the engine-domain filter
 * discards the wrapper as chrome. Every result is dropped.
 */
const WRAPPED_SERP_HTML =
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freal&amp;rut=abc">A real result</a>' +
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsecond.example.org%2Fshops&amp;rut=def">Another result</a>'

test('wrapped result links are unwrapped when the engine redirected to another subdomain', () => {
  const results = parseBrowserSearchResults({
    html: WRAPPED_SERP_HTML,
    engineUrl: 'https://html.duckduckgo.com/html/?q=ice+cream+detroit',
    maximumResults: 10,
  })
  assert.deepEqual(
    results.map((result) => result.url),
    ['https://example.com/real', 'https://second.example.org/shops'],
  )
})

test('the browser provider survives an engine redirect to another subdomain', async () => {
  const provider = new BrowserSearchProvider({
    acquireEvidence: async (_scope, url) => ({
      requestedUrl: url,
      // What `managed.page.url()` reports after DuckDuckGo redirects. The
      // existing provider tests echo the requested URL back, which is the one
      // shape production never produces.
      finalUrl: 'https://html.duckduckgo.com/html/?q=ice+cream+detroit',
      text: '',
      renderedHtml: WRAPPED_SERP_HTML,
      renderedHtmlTruncated: false,
    }),
  }, SCOPE)

  const results = await provider.search({
    query: 'ice cream detroit',
    maximumResults: 10,
    includeDomains: [],
    excludeDomains: [],
  })

  assert.deepEqual(
    results.map((result) => result.url),
    ['https://example.com/real', 'https://second.example.org/shops'],
  )
})
