import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCloudBrowserEnvironment } from '../../domains/browser/cloud-browser-environment.js'
import { DEFAULT_CDP_HOST_ALLOWLIST } from '../../domains/browser/cloud-browser-metering.js'

/**
 * The cloud browser's runtime inputs, parsed on their own.
 *
 * They are validated here rather than at the point of use so a mistyped
 * variable fails before anything is constructed and long before a request could
 * reach the provider.
 */

test('an unset environment keeps the documented default allowlist', () => {
  const runtime = parseCloudBrowserEnvironment({})

  assert.deepEqual(runtime.cdpHostAllowlist, [...DEFAULT_CDP_HOST_ALLOWLIST])
  assert.equal('proxyCountryCode' in runtime, false)
})

test('an allowlist is read as a bounded, lowercased list', () => {
  // The default is an unverified guess at the provider's domain, so an operator
  // whose live create returns another legitimate host needs a way in that is
  // not a code change.
  const runtime = parseCloudBrowserEnvironment({
    BROWSER_USE_CDP_HOST_ALLOWLIST: ' .Example-Cdp.net , cdp.example.org ,',
  })

  assert.deepEqual(runtime.cdpHostAllowlist, ['.example-cdp.net', 'cdp.example.org'])
})

test('an exact host is accepted so loopback and self-hosted cases still work', () => {
  assert.deepEqual(
    parseCloudBrowserEnvironment({ BROWSER_USE_CDP_HOST_ALLOWLIST: '127.0.0.1,localhost' })
      .cdpHostAllowlist,
    ['127.0.0.1', 'localhost'],
  )
})

test('an allowlist entry that is not a host, or is too broad, is refused', () => {
  for (const value of [
    'wss://cdp.example.org',
    'has space',
    'UPPER/slash',
    '.',
    // A public suffix names every organisation under it, which would authorize
    // a CDP endpoint on any host at all.
    '.com',
    '.co.',
    'x'.repeat(300),
    Array.from({ length: 40 }, (_value, index) => `h${index}.example`).join(','),
  ]) {
    assert.throws(
      () => parseCloudBrowserEnvironment({ BROWSER_USE_CDP_HOST_ALLOWLIST: value }),
      /cloud browser CDP host allowlist/iu,
      value.slice(0, 24),
    )
  }
})

test('a proxy country is normalised to its two-letter form', () => {
  assert.equal(
    parseCloudBrowserEnvironment({ BROWSER_USE_PROXY_COUNTRY: 'GB' }).proxyCountryCode,
    'gb',
  )
})

test('a proxy country of none means run unproxied', () => {
  // `null` is the documented way to disable the provider proxy, and is not the
  // same as omitting the field, which takes the provider's own default.
  assert.equal(
    parseCloudBrowserEnvironment({ BROWSER_USE_PROXY_COUNTRY: ' None ' }).proxyCountryCode,
    null,
  )
})

test('a proxy country that is not a country code is refused', () => {
  for (const value of ['United Kingdom', 'g', 'gbr', '12']) {
    assert.throws(
      () => parseCloudBrowserEnvironment({ BROWSER_USE_PROXY_COUNTRY: value }),
      /cloud browser proxy country/iu,
      value,
    )
  }
})
