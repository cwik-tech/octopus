import type { BrowserNetworkPolicy } from './browser-network-policy.js'
import type { BrowserAgentPolicy } from './browser-policy.js'

/**
 * Whether a browser this application drives may issue one request.
 *
 * Extracted from `BrowserManager` so a second browser backend cannot grow its
 * own copy. The rule is subtle in two places — a redirect is a fresh main
 * navigation that must be re-checked, and a subresource is judged by a
 * different predicate than a navigation — and two copies of a subtle rule drift
 * apart quietly. A cloud browser fetching an internal URL on our behalf because
 * its adapter checked only the starting address is exactly the failure this
 * prevents.
 */

export interface BrowserRequestFacts {
  readonly url: string
  /**
   * True when this is the top-level document being navigated, including every
   * redirect hop, rather than a subresource or a child frame.
   */
  readonly isMainNavigation: boolean
}

export interface BrowserRequestVerdict {
  readonly blocked: boolean
  readonly mainNavigation: boolean
}

export async function authorizeBrowserRequest(
  request: BrowserRequestFacts,
  policy: BrowserAgentPolicy,
  networkPolicy: BrowserNetworkPolicy,
): Promise<BrowserRequestVerdict> {
  const protocol = safeProtocol(request.url)
  // A scheme that never leaves the page — `data:`, `blob:`, `about:` — has no
  // network destination to authorize. A navigation is always checked, whatever
  // its scheme, because that is what moves the browser somewhere new.
  const enforced =
    request.isMainNavigation || protocol === 'http:' || protocol === 'https:'
  if (!enforced) {
    return { blocked: false, mainNavigation: request.isMainNavigation }
  }
  const allowed = request.isMainNavigation
    ? await networkPolicy.allows(request.url, policy)
    : await networkPolicy.allowsSubresource(request.url, policy)
  return { blocked: !allowed, mainNavigation: request.isMainNavigation }
}

function safeProtocol(value: string): string | null {
  try {
    return new URL(value).protocol
  } catch {
    return null
  }
}
