import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { DirectHttpAcquirer } from '../../domains/acquisition/direct-http-acquirer.js'
import type { BrowserAgentPolicy } from '../../domains/browser/browser-policy.js'

const POLICY: BrowserAgentPolicy = {
  enabled: true,
  restrictDomains: false,
  domains: [],
}

const READABLE_PAGE = `<!doctype html><html><head><title>Pinned report</title></head><body><main>
<h1>Pinned report</h1><p>${'This page carries enough readable prose to clear the acquisition quality threshold. '.repeat(6)}</p>
</main></body></html>`

test(
  'a source addressed by hostname is acquired through the vetted address rather than failing to connect',
  async (context) => {
    // A hostname, not an IP literal. Node resolves an IP literal itself and
    // never calls a custom lookup, which is why every existing loopback test
    // passes while a real host cannot be reached at all.
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(READABLE_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    context.after(() => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')

    // The resolver stands in for DNS only. It answers the same shape
    // `dns.lookup` does for this call, so the connection under test receives a
    // vetted address list exactly as it would in production.
    const acquirer = new DirectHttpAcquirer({
      allowHttpLocalhost: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })

    const result = await acquirer.acquire({
      url: `http://localhost:${address.port}/report`,
      policy: POLICY,
    })

    assert.equal(
      result.ok,
      true,
      `expected the pinned agent to connect; got ${JSON.stringify(result)}`,
    )
    assert.equal(result.ok && result.httpStatus, 200)
    assert.match(result.ok && result.kind === 'text' ? result.text : '', /Pinned report/u)
  },
)
