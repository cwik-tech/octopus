import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'
import { createLoopbackRestClient } from '../../server/voice-control/loopback-rest-client.js'

test('a stalled loopback REST request ends at its explicit deadline', { timeout: 2_000 }, async (t) => {
  const server = http.createServer((_req, _res) => { /* The real local HTTP peer deliberately holds its response. */ })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const client = createLoopbackRestClient(() => `http://127.0.0.1:${address.port}`, { requestTimeoutMs: 30 })
    await assert.rejects(client.request('GET', '/held', { signal: t.signal }), (error: unknown) => error instanceof Error && error.name === 'TimeoutError')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
