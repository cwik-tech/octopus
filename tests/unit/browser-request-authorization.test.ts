import assert from 'node:assert/strict'
import test from 'node:test'

import { authorizeBrowserRequest } from '../../domains/browser/browser-request-authorization.js'
import { BrowserNetworkPolicy } from '../../domains/browser/browser-network-policy.js'
import type { BrowserAgentPolicy } from '../../domains/browser/browser-policy.js'

/**
 * The one decision every browser this application drives has to make.
 *
 * It is tested here rather than through a launched Chrome because it is the
 * rule, not the plumbing, and because a second browser backend now depends on
 * exactly the same answer. A copy of this logic living next to a cloud adapter
 * is how two browsers end up with two different ideas of what is reachable.
 */

const unrestricted: BrowserAgentPolicy = {
  enabled: true,
  restrictDomains: false,
  domains: [],
}

const restricted: BrowserAgentPolicy = {
  enabled: true,
  restrictDomains: true,
  domains: ['10.1.2.3'],
}

/**
 * A real policy with no DNS involved.
 *
 * Every URL below addresses a host by literal IP, which the policy classifies
 * without a lookup. This suite is about the authorization rule; how the DNS
 * adapter behaves belongs to `browser-network-policy.test.ts`.
 */
function realPolicy(): BrowserNetworkPolicy {
  return new BrowserNetworkPolicy({})
}

test('a main navigation to a public host is allowed', async () => {
  const verdict = await authorizeBrowserRequest(
    { url: 'https://93.184.216.34/report', isMainNavigation: true },
    unrestricted,
    realPolicy(),
  )

  assert.deepEqual(verdict, { blocked: false, mainNavigation: true })
})

test('a main navigation to a private address is blocked', async () => {
  const verdict = await authorizeBrowserRequest(
    { url: 'https://10.0.0.5/secrets', isMainNavigation: true },
    unrestricted,
    realPolicy(),
  )

  assert.deepEqual(verdict, { blocked: true, mainNavigation: true })
})

test('a redirect is authorized exactly like the navigation it replaces', async () => {
  // The second hop is a main navigation in its own right. Checking only the URL
  // the caller asked for would let a redirect walk the browser inside.
  const hop = await authorizeBrowserRequest(
    { url: 'http://127.0.0.1/', isMainNavigation: true },
    unrestricted,
    realPolicy(),
  )

  assert.equal(hop.blocked, true)
})

test('a subresource pointing at a private address is blocked', async () => {
  const verdict = await authorizeBrowserRequest(
    { url: 'https://192.168.1.9/app.js', isMainNavigation: false },
    unrestricted,
    realPolicy(),
  )

  assert.deepEqual(verdict, { blocked: true, mainNavigation: false })
})

test('a scheme that never leaves the page is not authorized at all', async () => {
  // Data and blob URLs have no network destination, so there is nothing to
  // check and no lookup to make.
  for (const url of ['data:text/plain,hello', 'blob:https://example.com/abc']) {
    const verdict = await authorizeBrowserRequest(
      { url, isMainNavigation: false },
      unrestricted,
      realPolicy(),
    )
    assert.deepEqual(verdict, { blocked: false, mainNavigation: false }, url)
  }
})

test('restricted mode admits an explicitly granted internal host', async () => {
  // The grant is the point of restricted mode: an operator naming an internal
  // host is allowed to reach it, where unrestricted browsing never is.
  const verdict = await authorizeBrowserRequest(
    { url: 'https://10.1.2.3/app', isMainNavigation: true },
    restricted,
    realPolicy(),
  )

  assert.equal(verdict.blocked, false)
})

test('restricted mode blocks a host that was never granted', async () => {
  const verdict = await authorizeBrowserRequest(
    { url: 'https://93.184.216.34/app', isMainNavigation: true },
    restricted,
    realPolicy(),
  )

  assert.equal(verdict.blocked, true)
})

test('a disabled policy blocks everything', async () => {
  const verdict = await authorizeBrowserRequest(
    { url: 'https://93.184.216.34/', isMainNavigation: true },
    { enabled: false, restrictDomains: false, domains: [] },
    realPolicy(),
  )

  assert.equal(verdict.blocked, true)
})
