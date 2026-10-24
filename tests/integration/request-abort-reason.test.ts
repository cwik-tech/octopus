import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'
import { createRequestAbort } from '../../server/http.js'

test('a disconnected HTTP caller has a distinct abort reason', async () => {
  let accepted = () => {}
  const ready = new Promise<void>((resolve) => { accepted = resolve })
  let receiveReason: (value: unknown) => void = () => {}
  const reason = new Promise<unknown>((resolve) => { receiveReason = resolve })
  const server = http.createServer((req, res) => {
    const request = createRequestAbort(req, res)
    request.signal.addEventListener('abort', () => { receiveReason(request.signal.reason); request.dispose() }, { once: true })
    accepted()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const caller = new AbortController()
  const response = fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.any([caller.signal, AbortSignal.timeout(2000)]) })
  try {
    await ready
    caller.abort()
    await assert.rejects(response)
    assert.deepEqual(await reason, { kind: 'provider-abort', source: 'request-disconnected' })
  } finally {
    caller.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
