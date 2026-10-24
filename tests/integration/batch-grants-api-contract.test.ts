import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { URL } from 'node:url'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { BatchFolderGrantStoreUnavailableError } from '../../domains/batches/batch-folder-grant-store.js'
import { handleBatchFolderGrantRoutes } from '../../server/routes/batch-folder-grants.js'

test('Batch folder grant REST contract lists and revokes canonical external folders strictly', async (t) => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-grants-api-'))
  t.after(() => fs.rm(owner, { recursive: true, force: true }))
  const externalPath = path.join(owner, 'external')
  await fs.mkdir(externalPath)
  const store = new BatchFolderGrantStore(path.join(owner, 'grants.json'))
  await store.initialize()
  const canonicalPath = await store.grant(externalPath)
  const server = http.createServer((req, res) => {
    void handleBatchFolderGrantRoutes({
      req,
      res,
      url: new URL(req.url!, 'http://localhost'),
      runtime: store,
    }).catch((error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/settings/batch-folder-grants`

  const listed = await jsonRequest(endpoint)
  assert.equal(listed.response.status, 200)
  assert.deepEqual(listed.body, { grants: [{ path: canonicalPath }] })
  assert.equal(listed.response.headers.get('cache-control'), 'no-store')

  const invalidQuery = await jsonRequest(`${endpoint}?unknown=true`)
  assert.equal(invalidQuery.response.status, 400)
  assert.equal(invalidQuery.body.code, 'invalid_batch_request')

  const missing = await jsonRequest(endpoint, 'DELETE', { path: path.join(owner, 'missing') })
  assert.equal(missing.response.status, 404)
  assert.equal(missing.body.code, 'grant_not_found')

  const revoked = await fetch(endpoint, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: canonicalPath }),
  })
  assert.equal(revoked.status, 204)
  assert.deepEqual((await jsonRequest(endpoint)).body, { grants: [] })
})

test('Batch folder grant routes classify store and unexpected failures without leaking details', async (t) => {
  let failure: Error = new BatchFolderGrantStoreUnavailableError('private store path')
  const server = http.createServer((req, res) => {
    void handleBatchFolderGrantRoutes({
      req,
      res,
      url: new URL(req.url!, 'http://localhost'),
      runtime: {
        async list() { throw failure },
        async revoke() { throw failure },
      },
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/settings/batch-folder-grants`

  const unavailable = await jsonRequest(endpoint)
  assert.equal(unavailable.response.status, 503)
  assert.deepEqual(unavailable.body, {
    error: 'Batch folder grants are unavailable.',
    code: 'batch_service_unavailable',
  })

  failure = new Error('private implementation detail')
  const internal = await jsonRequest(endpoint)
  assert.equal(internal.response.status, 500)
  assert.deepEqual(internal.body, {
    error: 'Batch folder grant request failed.',
    code: 'internal_batch_error',
  })
})

async function jsonRequest(
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { response, body: await response.json() }
}
