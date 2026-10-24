import type { ResearchSearchResult } from './acquisition-types.js'
import { canonicalizeSourceUrl } from './acquisition-url.js'

/**
 * Provider identity stamped on results discovered through the managed browser,
 * so downstream provenance can tell an API-provider result from a rendered one.
 */
export const BROWSER_SEARCH_PROVIDER_ID = 'browser' as const

/** Query parameters search engines use to wrap an outbound result link. */
const REDIRECT_PARAMETERS = ['uddg', 'url'] as const

/**
 * Phrases a search engine uses when it serves a bot challenge instead of
 * results. Matched only against a page that produced no usable result, so a
 * query *about* captchas cannot be mistaken for being blocked by one.
 */
const CHALLENGE_PATTERNS: readonly RegExp[] = [
  /confirm (?:this|your) search was made by a human/i,
  /complete the following challenge/i,
  /select all (?:squares|images|tiles)/i,
  /verify (?:that )?you(?:'re| are)(?: a)? human/i,
  /are you a robot/i,
  /(?:detected )?unusual traffic/i,
  /enable javascript and cookies to continue/i,
  /\bcaptcha\b/i,
]

/** Raised when the engine served a challenge rather than performing a search. */
export class BrowserSearchChallengeError extends Error {
  constructor(readonly engineUrl: string) {
    super(
      'The search engine served a bot challenge instead of results, so no ' +
        'discovery was performed.',
    )
    this.name = 'BrowserSearchChallengeError'
  }
}

const ANCHOR_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
const HREF_PATTERN = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const TAG_PATTERN = /<[^>]*>/g

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
  ['&nbsp;', ' '],
])

function decodeEntities(value: string): string {
  return value.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity) => {
    const named = ENTITIES.get(entity.toLowerCase())
    if (named !== undefined) return named
    const numeric = /^&#(x)?([0-9a-f]+);$/i.exec(entity)
    const digits = numeric?.[2]
    if (!numeric || digits === undefined) return entity
    const codePoint = Number.parseInt(digits, numeric[1] ? 16 : 10)
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
  })
}

/**
 * Whether two hosts belong to the same site.
 *
 * A results page served from `html.duckduckgo.com` links to `duckduckgo.com`,
 * so an exact hostname comparison let the engine's own pages through as
 * discovered sources. Comparing the last two labels is a deliberate
 * approximation — it can over-match under a multi-part public suffix, which
 * only ever drops a link near the engine's own domain and never admits one.
 */
function sharesRegistrableDomain(a: string, b: string): boolean {
  if (a === b) return true
  const tail = (host: string) => host.toLowerCase().split('.').slice(-2).join('.')
  return tail(a) === tail(b)
}

function anchorText(inner: string): string {
  return decodeEntities(inner.replace(TAG_PATTERN, ' '))
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Resolve one anchor href to the destination it actually points at.
 *
 * Engines wrap outbound links in their own redirector, so the visible href is
 * the engine's, not the source's. Unwrapping happens before the engine-host
 * filter, or every wrapped result would be discarded as engine chrome.
 */
function resolveDestination(
  href: string,
  engineUrl: URL,
): URL | undefined {
  let resolved: URL
  try {
    resolved = new URL(decodeEntities(href), engineUrl)
  } catch {
    return undefined
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
    return undefined
  }
  // Registrable domain, not exact host: the engine redirects the results page to
  // a sibling subdomain while wrapping its outbound links on the parent, so an
  // exact comparison skips the unwrap and the filter below then discards the
  // wrapper as chrome. This must stay symmetric with `sharesRegistrableDomain`
  // at the call site, or every wrapped result is dropped.
  if (!sharesRegistrableDomain(resolved.hostname, engineUrl.hostname)) return resolved
  for (const parameter of REDIRECT_PARAMETERS) {
    const target = resolved.searchParams.get(parameter)
    if (!target) continue
    try {
      const unwrapped = new URL(target)
      if (unwrapped.protocol === 'https:' || unwrapped.protocol === 'http:') {
        return unwrapped
      }
    } catch {
      // Not a URL-valued parameter; fall through to the engine-host filter.
    }
  }
  return resolved
}

/**
 * Extract ranked search results from a rendered search engine results page.
 *
 * Deliberately structural rather than engine-specific: it harvests anchors and
 * discards what cannot be a result — the engine's own pages, non-HTTP schemes,
 * untitled links, and repeats of a URL already taken. Per-engine CSS selectors
 * would read more precisely and break on the engine's next redesign, with no
 * signal that discovery had silently stopped working.
 *
 * A single malformed href never fails the page: an engine that emits one bad
 * link would otherwise take out an entire lane's discovery.
 */
export function parseBrowserSearchResults(input: {
  readonly html: string
  readonly engineUrl: string
  readonly maximumResults: number
}): readonly ResearchSearchResult[] {
  let engineUrl: URL
  try {
    engineUrl = new URL(input.engineUrl)
  } catch {
    return []
  }
  const maximumResults = Math.max(0, Math.floor(input.maximumResults))
  const results: ResearchSearchResult[] = []
  const seen = new Set<string>()

  for (const match of input.html.matchAll(ANCHOR_PATTERN)) {
    if (results.length >= maximumResults) break
    const href = HREF_PATTERN.exec(match[1] ?? '')
    const rawHref = href?.[1] ?? href?.[2] ?? href?.[3]
    if (!rawHref) continue
    const title = anchorText(match[2] ?? '')
    if (!title) continue
    const destination = resolveDestination(rawHref, engineUrl)
    if (!destination) continue
    if (sharesRegistrableDomain(destination.hostname, engineUrl.hostname)) continue
    let canonicalUrl: string
    try {
      canonicalUrl = canonicalizeSourceUrl(destination.toString())
    } catch {
      // Credentialed, non-HTTP, or otherwise unusable as a source URL.
      continue
    }
    if (seen.has(canonicalUrl)) continue
    seen.add(canonicalUrl)
    results.push({
      title,
      url: canonicalUrl,
      canonicalUrl,
      provider: BROWSER_SEARCH_PROVIDER_ID,
      // Rank order is the only quality signal a rendered page carries, so the
      // score is the reciprocal rank rather than a fabricated relevance value.
      score: 1 / (results.length + 1),
    })
  }
  // A page that yielded nothing is either an honest empty result set or a
  // block. Only the latter carries challenge wording, and requiring zero
  // results first means a page *about* captchas can never be misread as one.
  if (results.length === 0 && CHALLENGE_PATTERNS.some((p) => p.test(input.html))) {
    throw new BrowserSearchChallengeError(input.engineUrl)
  }
  return results
}

/**
 * The slice of the managed browser this provider needs.
 *
 * Declared structurally rather than importing `BrowserManager` so the search
 * fallback does not drag the whole browser runtime into the acquisition domain,
 * and so it can be exercised without launching Chrome.
 */
export interface BrowserSearchRenderer {
  acquireEvidence(
    scope: BrowserSearchScope,
    url: string,
    signal?: AbortSignal,
  ): Promise<{ readonly renderedHtml: string; readonly finalUrl: string }>
}

export interface BrowserSearchScope {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId?: string
  readonly assignmentPath: string
  readonly policy: unknown
}

/**
 * Default results endpoint: the no-JavaScript HTML rendering, which returns
 * plain result anchors instead of a script-built page.
 */
export const DEFAULT_BROWSER_SEARCH_ENDPOINT = 'https://duckduckgo.com/html/'

function buildQuery(input: {
  readonly query: string
  readonly includeDomains: readonly string[]
  readonly excludeDomains: readonly string[]
}): string {
  const terms = [input.query.trim()]
  for (const domain of input.includeDomains) terms.push(`site:${domain}`)
  for (const domain of input.excludeDomains) terms.push(`-site:${domain}`)
  return terms.filter(Boolean).join(' ')
}

/**
 * Source discovery through the managed browser.
 *
 * This is the fallback that makes a search API key optional rather than
 * required: without it, a lane whose `search` calls fail has no discovery path
 * left and reaches for URLs it can only have invented. It renders a results
 * page through the same browser already used for evidence acquisition, so it
 * inherits that path's policy, profile and network posture.
 *
 * A render failure rejects rather than returning an empty list. An unavailable
 * browser and a query with genuinely no results are different facts, and
 * collapsing them would let a broken browser read as an exhausted web.
 */
export class BrowserSearchProvider {
  readonly id = BROWSER_SEARCH_PROVIDER_ID

  constructor(
    private readonly renderer: BrowserSearchRenderer,
    private readonly scope: BrowserSearchScope,
    private readonly endpoint: string = DEFAULT_BROWSER_SEARCH_ENDPOINT,
  ) {}

  async search(
    input: {
      readonly query: string
      readonly maximumResults: number
      readonly includeDomains: readonly string[]
      readonly excludeDomains: readonly string[]
    },
    signal?: AbortSignal,
  ): Promise<readonly ResearchSearchResult[]> {
    const engineUrl = new URL(this.endpoint)
    engineUrl.searchParams.set('q', buildQuery(input))
    const target = engineUrl.toString()
    const rendered = await this.renderer.acquireEvidence(
      this.scope,
      target,
      signal,
    )
    return parseBrowserSearchResults({
      html: rendered.renderedHtml,
      engineUrl: rendered.finalUrl || target,
      maximumResults: input.maximumResults,
    })
  }
}
