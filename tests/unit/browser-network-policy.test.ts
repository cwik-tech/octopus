import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserNetworkPolicy } from '../../domains/browser/browser-network-policy.js'

test('unrestricted browser policy resolves only public addresses while restricted grants remain explicit', async () => {
  const lookups: string[] = []
  const policy = new BrowserNetworkPolicy({
    lookup: (async (host: string) => {
      lookups.push(host)
      return host === 'public.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.5', family: 4 }]
    }) as never,
    cacheTtlMs: 60_000,
  })
  const publicPolicy = { enabled: true, restrictDomains: false, domains: [] }
  assert.equal(await policy.allows('https://public.example/report', publicPolicy), true)
  assert.equal(await policy.allows('https://private.example/report', publicPolicy), false)
  assert.equal(await policy.allows('https://127.0.0.1/report', publicPolicy), false)
  assert.equal(await policy.allows('https://internal.example/report', {
    enabled: true,
    restrictDomains: true,
    domains: ['internal.example'],
  }), true)
  assert.equal(await policy.allowsSubresource('https://private.example/pixel', {
    enabled: true,
    restrictDomains: true,
    domains: ['public.example'],
  }), false)
  assert.equal(await policy.allowsSubresource('https://private.example/pixel', {
    enabled: true,
    restrictDomains: true,
    domains: ['private.example'],
  }), true)
  assert.deepEqual(lookups, ['public.example', 'private.example'])
})
