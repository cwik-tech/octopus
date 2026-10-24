import assert from 'node:assert/strict'
import test from 'node:test'

import { browserConnectOptions } from '../../domains/browser/cloud-browser-acquirer.js'

test('secure HTTP control endpoints use Puppeteer discovery', () => {
  assert.deepEqual(browserConnectOptions('https://session.cdp.browser-use.com', 15_000), {
    browserURL: 'https://session.cdp.browser-use.com',
    protocolTimeout: 15_000,
  })
})

test('WebSocket control endpoints connect directly', () => {
  assert.deepEqual(
    browserConnectOptions(
      'wss://session.cdp.browser-use.com/devtools/browser/abc',
      15_000,
    ),
    {
      browserWSEndpoint:
        'wss://session.cdp.browser-use.com/devtools/browser/abc',
      protocolTimeout: 15_000,
    },
  )
})
