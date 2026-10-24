import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cdpEndpointAllowed,
  decimalToMicrosCeiling,
  DEFAULT_CDP_HOST_ALLOWLIST,
} from '../../domains/browser/cloud-browser-metering.js'
import { isAcquisitionCloudBrowserRuntime } from '../../domains/browser/cloud-browser-types.js'

test('a provider decimal becomes exact integer micros', () => {
  assert.equal(decimalToMicrosCeiling('0'), 0)
  assert.equal(decimalToMicrosCeiling('0.0234'), 23_400)
  assert.equal(decimalToMicrosCeiling('1.5'), 1_500_000)
  assert.equal(decimalToMicrosCeiling('12.345678'), 12_345_678)
})

test('any positive fraction below one micro rounds up, never away', () => {
  // This number backs a spend threshold. Nearest rounding discards 0.0000004
  // on every call it is consulted, and a threshold that under-counts is not a
  // threshold, so the conversion is a ceiling rather than a rounding.
  assert.equal(decimalToMicrosCeiling('0.0000004'), 1)
  assert.equal(decimalToMicrosCeiling('0.0000006'), 1)
  assert.equal(decimalToMicrosCeiling('0.0000000001'), 1)
  assert.equal(decimalToMicrosCeiling('1.0000001'), 1_000_001)
  // An exact micro is already exact and must not be inflated.
  assert.equal(decimalToMicrosCeiling('0.000001'), 1)
  assert.equal(decimalToMicrosCeiling('2.000000'), 2_000_000)
})

test('the non-negative decimal forms the provider may emit are accepted', () => {
  // A JSON decimal string is not obliged to be the shortest form. Rejecting a
  // leading plus or a bare fractional part would read a real cost as unparseable
  // and quietly fall back to a stale meter.
  assert.equal(decimalToMicrosCeiling('+0.5'), 500_000)
  assert.equal(decimalToMicrosCeiling('.5'), 500_000)
  assert.equal(decimalToMicrosCeiling('+2'), 2_000_000)
  assert.equal(decimalToMicrosCeiling('0.'), 0)
})

test('a decimal that is not a decimal, or too large to count, is refused', () => {
  for (const value of ['', 'free', '-1', '-0.5', '1e6', '1.2.3', ' 1.0', '99999999999999999999']) {
    assert.equal(decimalToMicrosCeiling(value), undefined, value)
  }
})

test('the default CDP allowlist admits the provider domain and nothing else', () => {
  assert.deepEqual(DEFAULT_CDP_HOST_ALLOWLIST, ['.browser-use.com'])

  assert.equal(
    cdpEndpointAllowed('wss://cdp.browser-use.com/session/abc', DEFAULT_CDP_HOST_ALLOWLIST),
    true,
  )
  assert.equal(
    cdpEndpointAllowed('https://session.cdp.browser-use.com', DEFAULT_CDP_HOST_ALLOWLIST),
    true,
    'the provider REST API returns a secure HTTP discovery endpoint',
  )
  assert.equal(
    cdpEndpointAllowed('wss://attacker.example.com/session', DEFAULT_CDP_HOST_ALLOWLIST),
    false,
  )
  // Suffix matching must not admit a lookalike registered domain.
  assert.equal(
    cdpEndpointAllowed('wss://evil-browser-use.com/session', DEFAULT_CDP_HOST_ALLOWLIST),
    false,
  )
})

test('plaintext and private endpoints are refused unless explicitly allowlisted', () => {
  // Plaintext CDP to a remote host would hand the session to anyone on the path.
  assert.equal(cdpEndpointAllowed('ws://cdp.browser-use.com/s', DEFAULT_CDP_HOST_ALLOWLIST), false)
  // SSRF: an allowlist entry is required before this client will aim a browser
  // at anything inside the network it runs in.
  assert.equal(cdpEndpointAllowed('ws://127.0.0.1:9222/s', DEFAULT_CDP_HOST_ALLOWLIST), false)
  assert.equal(cdpEndpointAllowed('ws://127.0.0.1:9222/s', ['127.0.0.1']), true)
  assert.equal(cdpEndpointAllowed('wss://127.0.0.1:9222/s', ['127.0.0.1']), true)
  // Plain HTTP discovery follows the same exact-host rule as plaintext
  // WebSocket, so a loopback fixture is possible without admitting a remote
  // plaintext endpoint by suffix.
  assert.equal(cdpEndpointAllowed('http://cdp.browser-use.com/s', ['.browser-use.com']), false)
  assert.equal(cdpEndpointAllowed('http://127.0.0.1:9222', ['127.0.0.1']), true)
  assert.equal(cdpEndpointAllowed('file:///etc/passwd', ['127.0.0.1']), false)
  assert.equal(cdpEndpointAllowed('not a url', ['127.0.0.1']), false)
})

test('the runtime guard is exact-key so nothing can ride into a receipt', () => {
  const valid = {
    provider: 'browser-use',
    proxyCountry: 'none',
    browserCostMicros: 0,
    proxyCostMicros: 0,
    proxyUsedMilliMb: 0,
    sessionStatus: 'stopped',
    meterSource: 'stop-confirmed',
  }
  assert.equal(isAcquisitionCloudBrowserRuntime(valid), true)
  assert.equal(
    isAcquisitionCloudBrowserRuntime({ ...valid, apiKey: 'bu_leaked' }),
    false,
    'an extra key must reject the whole object, not be ignored',
  )
  assert.equal(isAcquisitionCloudBrowserRuntime({ ...valid, meterSource: 'guessed' }), false)
  assert.equal(isAcquisitionCloudBrowserRuntime({ ...valid, browserCostMicros: -1 }), false)
  assert.equal(isAcquisitionCloudBrowserRuntime({ ...valid, browserCostMicros: 1.5 }), false)
})

test('the recorded exit country is a country code, not an arbitrary string', () => {
  const valid = {
    provider: 'browser-use',
    proxyCountry: 'none',
    browserCostMicros: 0,
    proxyCostMicros: 0,
    proxyUsedMilliMb: 0,
    sessionStatus: 'stopped',
    meterSource: 'stop-confirmed',
  }
  assert.equal(isAcquisitionCloudBrowserRuntime({ ...valid, proxyCountry: 'gb' }), true)
  // This field reaches persisted telemetry documented as non-secret by
  // construction. Production only ever writes `none` or a two-letter code, so a
  // free-form string here is something that came from somewhere else.
  for (const proxyCountry of ['bu_secret_key', 'United Kingdom', 'GB', 'g', '']) {
    assert.equal(
      isAcquisitionCloudBrowserRuntime({ ...valid, proxyCountry }),
      false,
      proxyCountry,
    )
  }
})
