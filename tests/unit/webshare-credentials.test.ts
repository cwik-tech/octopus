import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWebshareCredentials } from '../../domains/proxy/webshare-credentials.js'

test('the Webshare credential response is accepted under either field spelling', () => {
  assert.deepEqual(
    parseWebshareCredentials({ username: 'reader', password: 'secret' }),
    { username: 'reader', password: 'secret' },
  )
  assert.deepEqual(
    parseWebshareCredentials({ proxy_username: 'reader', proxy_password: 'secret' }),
    { username: 'reader', password: 'secret' },
  )
})

test('a Webshare credential response is trimmed and preferred over the prefixed spelling', () => {
  assert.deepEqual(
    parseWebshareCredentials({
      username: '  reader  ',
      password: ' secret ',
      proxy_username: 'ignored',
      proxy_password: 'ignored',
    }),
    { username: 'reader', password: 'secret' },
  )
})

test('a malformed Webshare credential response is rejected rather than trusted', () => {
  for (const payload of [
    null,
    'not-an-object',
    [],
    {},
    { username: 'reader' },
    { password: 'secret' },
    { username: '   ', password: 'secret' },
    { username: 'reader', password: 42 },
    { proxy_username: [], proxy_password: 'secret' },
  ]) {
    assert.throws(
      () => parseWebshareCredentials(payload),
      /Webshare did not return proxy credentials\./u,
      `expected ${JSON.stringify(payload)} to be refused`,
    )
  }
})
