import assert from 'node:assert/strict'
import * as http from 'node:http'
import type { Socket } from 'node:net'
import test from 'node:test'

import { startForwardProxy } from '../support/research-web-proxy-fixture.js'

test('an upstream reset aborts the partial proxy response and the proxy still serves later requests', { timeout: 3000 }, async (context) => {
  let upstreamSocket: Socket | undefined
  const origin = http.createServer((request, response) => {
    if (request.url === '/held') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('partial response')
      upstreamSocket = request.socket
      return
    }
    response.end('healthy')
  })
  context.after(() => new Promise<void>((resolve, reject) => {
    origin.closeAllConnections()
    origin.close((error) => error ? reject(error) : resolve())
  }))
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const address = origin.address()
  assert.ok(address && typeof address !== 'string')
  const proxy = await startForwardProxy()
  context.after(() => proxy.close())
  const originUrl = `http://127.0.0.1:${address.port}`

  const resetCode = await new Promise<string | undefined>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: proxy.port, path: `${originUrl}/held` }, (response) => {
      response.on('error', (error: NodeJS.ErrnoException) => resolve(error.code))
      response.on('end', () => reject(new Error('A partial upstream response must not look complete')))
      response.once('data', () => upstreamSocket?.resetAndDestroy())
    })
    request.on('error', reject)
  })
  assert.equal(resetCode, 'ECONNRESET')

  const body = await new Promise<string>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: proxy.port, path: `${originUrl}/health` }, (response) => {
      let contents = ''
      response.on('data', (chunk: Buffer) => { contents += chunk.toString('utf8') })
      response.on('error', reject)
      response.on('end', () => resolve(contents))
    })
    request.on('error', reject)
  })
  assert.equal(body, 'healthy')
})

test('resetting a rejected CONNECT authentication challenge leaves the proxy available', { timeout: 3000 }, async (context) => {
  const { connect } = await import('node:net')
  const proxy = await startForwardProxy({ requireAuth: { username: 'fixture-user', password: 'fixture-password' } })
  context.after(() => proxy.close())
  await new Promise<void>((resolve, reject) => {
    const client = connect({ host: '127.0.0.1', port: proxy.port }, () => {
      client.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n')
    })
    client.on('error', reject)
    client.once('data', (chunk: Buffer) => {
      assert.match(chunk.toString('utf8'), /407 Proxy Authentication Required/)
      client.resetAndDestroy()
    })
    client.once('close', () => resolve())
  })
  // Fetch treats 407 as a network error, so observe this HTTP response directly.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${proxy.port}/health`, (response) => {
      response.resume()
      response.on('error', reject)
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
  })
  assert.equal(status, 407)
})
