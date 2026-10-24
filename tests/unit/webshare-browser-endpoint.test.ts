import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWebshareProxy } from '../../domains/proxy/webshare-proxy.js'

/**
 * The browser-shaped view of a resolved Webshare proxy.
 *
 * Chrome refuses credentials inside a proxy argument and answers a 407
 * challenge instead, so the resolved proxy has to offer the endpoint twice: as
 * one URL with userinfo for undici, and split for the browser. Both come from
 * the same resolution, so the two cannot drift apart.
 */

const CONFIG = {
  proxyEnabled: true,
  credentialMode: 'username-password',
  proxyHost: 'proxy.example.test',
  proxyPort: 8080,
  countries: [],
  username: 'account-user',
  password: 'p@ss word/with:reserved',
} as const

test('a resolved proxy offers a browser endpoint with no credentials in its server address', async () => {
  const resolved = await resolveWebshareProxy(CONFIG)
  assert.ok(resolved)
  try {
    assert.equal(resolved.browserEndpoint.server, 'http://proxy.example.test:8080')
    assert.doesNotMatch(resolved.browserEndpoint.server, /@/u)
    assert.doesNotMatch(resolved.browserEndpoint.server, /account-user|p@ss/u)
  } finally {
    await resolved.close()
  }
})

test('the browser endpoint carries the country-targeted username and the exact password', async () => {
  const resolved = await resolveWebshareProxy({ ...CONFIG, countries: ['US', 'GB'] })
  assert.ok(resolved)
  try {
    // The targeting rule is Webshare's, and it lives in the username. The
    // browser pair must carry the same name undici dials with, or a proxied
    // browser read would leave from a different country than a proxied direct
    // read on the same configuration.
    assert.equal(resolved.browserEndpoint.username, resolved.username)
    assert.equal(resolved.browserEndpoint.username, 'account-user-us-gb-rotate')
    // Percent-encoding is a property of the URL form, not of the credential.
    assert.equal(resolved.browserEndpoint.password, CONFIG.password)
  } finally {
    await resolved.close()
  }
})

test('a disabled proxy resolves to nothing at all, so no endpoint can be read from it', async () => {
  assert.equal(
    await resolveWebshareProxy({ ...CONFIG, proxyEnabled: false }),
    undefined,
  )
})
