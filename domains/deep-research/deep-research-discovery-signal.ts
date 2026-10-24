/**
 * Deep Research — the one authoritative discovery signal.
 *
 * "Did this run have a way to find and reach sources?" used to be answered
 * separately in three places, each from whatever it happened to be looking at.
 * The blocker read only the `research.web` search action, so a run whose
 * searches failed while its managed browser rendered result pages and reached
 * real sources was reported as having no discovery path at all — and its
 * accepted evidence was thrown away.
 *
 * This module is that answer, computed once from durable journal facts. It is
 * pure: callers in the shell read the journals and hand it what they found.
 */

/**
 * How one discovery attempt reached the web, by the identifier the journals
 * record. Search results carry the provider that ranked them (`exa`, `brave`,
 * or `browser` for the managed-browser fallback); page observations carry the
 * acquisition method that fetched them.
 */
export type DeepResearchDiscoveryPath = string

/** One recorded `research.web` search call. */
export interface DeepResearchSearchAttempt {
  /** True only when the call completed *and* returned at least one result. */
  readonly succeeded: boolean
  /** Providers credited with the results, when the journal recorded them. */
  readonly providers?: readonly string[]
  /** The recorded reason a failing call produced nothing. */
  readonly failureCode?: string
}

export interface DeepResearchDiscoverySignal {
  /** Recorded search calls, successful or not. */
  readonly searchAttempts: number
  /** True once any path — search or browser — returned something. */
  readonly succeeded: boolean
  readonly successfulPaths: readonly DeepResearchDiscoveryPath[]
  /** Why the failing searches produced nothing, by recorded code. */
  readonly failureCodes: ReadonlyArray<{
    readonly code: string
    readonly count: number
  }>
}

/**
 * Acquisition methods a *search-results page* can be read through.
 *
 * `direct-http`, `managed-reader` and `document-parser` are deliberately
 * absent: they fetch a document, they do not render an engine's result page.
 *
 * The method alone proves nothing. Opening a page is discovery only when the
 * page is a search-results page — see `isWebSearchResultsUrl`.
 */
export const DEEP_RESEARCH_BROWSER_DISCOVERY_METHODS = [
  'managed-browser',
  'managed-browser-proxied',
  'cloud-browser',
] as const

/** Whether a recorded observation method proves a browser reached the web. */
export function isDeepResearchBrowserDiscoveryMethod(method: string): boolean {
  return (DEEP_RESEARCH_BROWSER_DISCOVERY_METHODS as readonly string[])
    .includes(method)
}

/** A search that completed without naming a provider still proves discovery. */
const UNNAMED_SEARCH_PATH = 'search'

/** One page this run successfully read, as the journals recorded it. */
export interface DeepResearchBrowserObservation {
  /** The acquisition method that produced the page. */
  readonly method: string
  /**
   * The URL the lane asked for. It keeps the query string, so when it is
   * present the search term it carries is the evidence — a bare results
   * endpoint means the lane opened an empty form, not a search.
   */
  readonly requestedUrl?: string
  /** The canonicalised URL. Canonicalisation drops the query string. */
  readonly canonicalUrl?: string
}

/**
 * Fold every recorded discovery attempt into one verdict.
 *
 * A single success anywhere settles it: the run had a way to reach the web, so
 * whatever else went wrong is not capability absence. Only when nothing
 * succeeded do the recorded failure codes matter, and then they are reported
 * as they were journalled rather than collapsed into one assumed cause.
 */
export function summarizeDeepResearchDiscovery(input: {
  readonly searches: readonly DeepResearchSearchAttempt[]
  readonly browserObservations: readonly DeepResearchBrowserObservation[]
}): DeepResearchDiscoverySignal {
  const successfulPaths = new Set<DeepResearchDiscoveryPath>()
  const failureCodes = new Map<string, number>()
  for (const search of input.searches) {
    if (search.succeeded) {
      const providers = search.providers?.filter((provider) => provider.length > 0)
      if (providers && providers.length > 0) {
        for (const provider of providers) successfulPaths.add(provider)
      } else {
        successfulPaths.add(UNNAMED_SEARCH_PATH)
      }
      continue
    }
    const code = search.failureCode ?? 'unknown'
    failureCodes.set(code, (failureCodes.get(code) ?? 0) + 1)
  }
  for (const observation of input.browserObservations) {
    if (!isDeepResearchBrowserDiscoveryMethod(observation.method)) continue
    const url = observation.requestedUrl ?? observation.canonicalUrl
    if (!url) continue
    // Only the requested URL can be asked for a search term; the canonical
    // form never stored one.
    if (
      !isWebSearchResultsUrl(url, {
        requireSearchTerm: observation.requestedUrl !== undefined,
      })
    ) {
      continue
    }
    successfulPaths.add(observation.method)
  }
  return {
    searchAttempts: input.searches.length,
    succeeded: successfulPaths.size > 0,
    successfulPaths: [...successfulPaths].sort(),
    failureCodes: [...failureCodes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => left.code.localeCompare(right.code)),
  }
}

/**
 * Exact hosts whose results pages prove a lane could *find* sources.
 *
 * This is a trust allowlist guarding a fail-closed blocker, so it holds only
 * hosts this repository actually reaches: `duckduckgo.com/html/` is the managed
 * browser's own search endpoint (`DEFAULT_BROWSER_SEARCH_ENDPOINT`), and the
 * observed failed session recorded workers rendering Bing, DuckDuckGo and
 * Google results pages. Exact hosts, not registrable domains: a subdomain
 * somebody else controls must not inherit an engine's trust.
 *
 * An engine outside this list is a false negative, which only preserves the
 * existing blocking behaviour. A false positive would suppress a real blocker.
 */
const SEARCH_ENGINE_HOSTS = new Set([
  'duckduckgo.com',
  'www.duckduckgo.com',
  'html.duckduckgo.com',
  'bing.com',
  'www.bing.com',
  'google.com',
  'www.google.com',
])

/** Paths an engine serves web results from. */
const SEARCH_RESULTS_PATHS = new Set([
  '/search',
  '/html',
  '/web',
  '/sp/search',
  '/do/search',
])

/** Query parameters engines carry the searched terms in. */
const SEARCH_QUERY_PARAMETERS = ['q', 'query', 'p', 'text', 'k'] as const

/**
 * Whether a URL is a web-search results page.
 *
 * This is the line between discovery and acquisition. A lane that produced a
 * source URL from model memory and opened it reached the web but found
 * nothing; only an engine's results page shows it could find a source it did
 * not already name.
 *
 * `requireSearchTerm` is how the caller says which URL it holds. A requested
 * URL keeps its query, so a search term is required there and a bare results
 * endpoint is rejected as the engine's empty form. A canonicalised URL has had
 * its query stripped and cannot be asked for one. An engine root always needs
 * a term, because the engine's home page is not a results page.
 */
export function isWebSearchResultsUrl(
  value: string,
  options: { readonly requireSearchTerm?: boolean } = {},
): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (!SEARCH_ENGINE_HOSTS.has(url.hostname.toLowerCase())) return false
  const hasSearchTerm = SEARCH_QUERY_PARAMETERS.some((parameter) =>
    (url.searchParams.get(parameter) ?? '').trim().length > 0,
  )
  if (options.requireSearchTerm && !hasSearchTerm) return false
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (SEARCH_RESULTS_PATHS.has(path)) return true
  if (path !== '/') return false
  return hasSearchTerm
}

const PATH_NAMES: Readonly<Record<string, string>> = {
  exa: 'the Exa search API',
  brave: 'the Brave Search API',
  browser: 'the managed-browser search fallback',
  'browser-use': 'Browser Use',
  'managed-browser': 'the managed browser',
  'managed-browser-proxied': 'the proxied managed browser',
  'cloud-browser': 'the Browser Use cloud browser',
  [UNNAMED_SEARCH_PATH]: 'search',
}

/** Operator-facing name for a recorded discovery path. */
export function describeDeepResearchDiscoveryPath(
  discoveryPath: string,
): string {
  return PATH_NAMES[discoveryPath] ?? `\`${discoveryPath}\``
}

/**
 * Remediation matched to a recorded code. The codes are the runtime's own, so
 * an operator is sent at the fault that actually happened rather than at the
 * one this blocker was originally written for.
 */
const FAILURE_REMEDIES: Readonly<Record<string, string>> = {
  not_configured:
    'no enabled search provider has an API key and the managed browser could ' +
    'not render the query, so no discovery path existed at all',
  internal:
    'the runtime could not complete the search — an unreadable acquisition ' +
    'settings file or a comparable local fault, which no API key will fix',
  no_results: 'the searches ran and returned nothing to acquire',
  access_challenge:
    'the search engine served a verification wall instead of results',
  budget_exhausted:
    'a discovery budget for the lane was already spent — the search-call ' +
    'budget, or the paid Browser Use budget that was its only remaining path',
  cancelled: 'the searches were cancelled before they returned',
  domain_denied: 'search was not permitted for this agent',
}

/**
 * The operator action matched to the recorded causes.
 *
 * A missing credential is only one of the ways a run can have no discovery
 * path, so the key-purchase sentence is reserved for the code that actually
 * means it. Anything else is sent at the fault the runtime recorded.
 */
export function describeDeepResearchDiscoveryRemediation(
  failureCodes: ReadonlyArray<{
    readonly code: string
    readonly count: number
  }>,
): string {
  const codes = new Set(failureCodes.map((entry) => entry.code))
  if (codes.size === 0) {
    return (
      'No search call was recorded, so restore the managed browser — it is ' +
      'the default discovery path and needs no credential — then re-run the ' +
      'research.'
    )
  }
  if (codes.size === 1 && codes.has('not_configured')) {
    return (
      'Restore the managed browser — it is the default discovery path and ' +
      'needs no credential — or add an Exa or Brave Search API key in ' +
      'acquisition settings, then re-run the research.'
    )
  }
  const named = [...codes].sort().map((code) => `\`${code}\``).join(', ')
  return (
    `Clear the recorded discovery failure (${named}), or restore the managed ` +
    'browser, which is the default discovery path and needs no credential. ' +
    'Then re-run the research.'
  )
}

/**
 * One sentence naming why every discovery attempt produced nothing.
 *
 * The codes come from the journal. Nothing here may assume `not_configured`:
 * telling an operator to buy an API key for a settings-file fault, an empty
 * web, or an exhausted budget is the specific failure this replaces.
 */
export function describeDeepResearchDiscoveryFailure(
  failureCodes: ReadonlyArray<{
    readonly code: string
    readonly count: number
  }>,
): string {
  if (failureCodes.length === 0) {
    return 'No search call was recorded, so no discovery path was exercised.'
  }
  const tally = failureCodes
    .map((entry) => `\`${entry.code}\` ×${entry.count}`)
    .join(', ')
  const causes = failureCodes
    .map((entry) => FAILURE_REMEDIES[entry.code])
    .filter((cause): cause is string => cause !== undefined)
  const explanation = causes.length > 0
    ? ` That means ${[...new Set(causes)].join('; and ')}.`
    : ''
  return `Every recorded search failed (${tally}).${explanation}`
}
