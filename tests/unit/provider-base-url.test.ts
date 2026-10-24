import test from 'node:test'
import assert from 'node:assert/strict'
import { assertProviderBaseUrl } from '../../domains/provider/provider-base-url.js'

const OPTS = { providerName: 'anthropic' }

test('assertProviderBaseUrl accepts the provider official HTTPS host', () => {
  assert.equal(assertProviderBaseUrl('https://api.anthropic.com/v1/messages', OPTS), 'https://api.anthropic.com/v1/messages')
})

test('assertProviderBaseUrl rejects untrusted HTTPS hosts from team configuration', () => {
  assert.throws(
    () => assertProviderBaseUrl('https://attacker.example/v1', OPTS),
    /official anthropic API host/,
  )
})

test('assertProviderBaseUrl permits operator-owned HTTPS environment overrides', () => {
  const options = { ...OPTS, allowUnlistedHttpsHost: true }
  assert.equal(
    assertProviderBaseUrl('https://proxy.corp.example/v1', options),
    'https://proxy.corp.example/v1',
  )
})

test('assertProviderBaseUrl allows http only for loopback hosts', () => {
  for (const url of ['http://localhost:8080/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) {
    assert.equal(assertProviderBaseUrl(url, OPTS), url)
  }
  assert.throws(() => assertProviderBaseUrl('http://api.anthropic.com/v1', OPTS), /official anthropic API host/)
  assert.throws(() => assertProviderBaseUrl('http://192.168.1.10/v1', OPTS), /official anthropic API host/)
})

test('assertProviderBaseUrl rejects URLs with embedded credentials', () => {
  assert.throws(() => assertProviderBaseUrl('https://user:pass@api.example.com/v1', OPTS), /must not embed credentials/)
})

test('assertProviderBaseUrl rejects invalid URLs and names the provider', () => {
  assert.throws(() => assertProviderBaseUrl('not-a-url', OPTS), /Provider 'anthropic' base_url/)
})
