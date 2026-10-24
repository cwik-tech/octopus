import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { URL } from 'node:url'

import {
  BatchFolderGrantStore,
  BatchFolderGrantStoreUnavailableError,
} from '../../domains/batches/batch-folder-grant-store.js'
import {
  handleSharedFolderGrantRoutes,
  type SharedFolderGrantsRouteRuntime,
} from '../../server/routes/shared-folder-grants.js'

/**
 * `/settings/shared-folder-grants`: the shared folder grant list in Settings.
 *
 * It answers with the same status codes and the same validation as
 * `/settings/batch-folder-grants` (tests/integration/batch-grants-api-contract.test.ts),
 * over its own grant list, so revoking one feature's grant never touches the other's.
 */

async function serve(t: TestContext, runtime: SharedFolderGrantsRouteRuntime | undefined): Promise<string> {
  const server = http.createServer((req, res) => {
    void handleSharedFolderGrantRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://localhost'),
      ...(runtime ? { runtime } : {}),
    }).then((handled) => {
      if (!handled) res.writeHead(404).end()
    }).catch((error: unknown) => {
      res.statusCode = 599
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}/settings/shared-folder-grants`
}

async function jsonRequest(
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  })
  // A route that does not answer leaves an empty body, which the status check reports.
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

test('shared folder grant routes list and revoke exact grants strictly', async (t) => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-grants-api-'))
  t.after(() => fs.rm(owner, { recursive: true, force: true }))
  const picked = path.join(owner, 'Contracts')
  await fs.mkdir(picked)
  const store = new BatchFolderGrantStore(path.join(owner, 'shared-folder-grants.json'))
  await store.initialize()
  const canonicalPath = await store.grant(picked)
  const endpoint = await serve(t, store)

  const listed = await jsonRequest(endpoint)
  assert.equal(listed.response.status, 200)
  assert.deepEqual(listed.body, { grants: [{ path: canonicalPath }] })
  assert.equal(listed.response.headers.get('cache-control'), 'no-store')

  const invalidQuery = await jsonRequest(`${endpoint}?unknown=true`)
  assert.equal(invalidQuery.response.status, 400)

  const relative = await jsonRequest(endpoint, 'DELETE', { path: 'Contracts' })
  assert.equal(relative.response.status, 400)
  const extraKey = await jsonRequest(endpoint, 'DELETE', { path: canonicalPath, recursive: true })
  assert.equal(extraKey.response.status, 400)
  const notJson = await jsonRequest(endpoint, 'DELETE', '{')
  assert.equal(notJson.response.status, 400)

  const missing = await jsonRequest(endpoint, 'DELETE', { path: path.join(owner, 'missing') })
  assert.equal(missing.response.status, 404)
  assert.deepEqual(missing.body, { error: 'Shared folder grant not found.', code: 'grant_not_found' })

  const wrongMethod = await jsonRequest(endpoint, 'POST', { path: canonicalPath })
  assert.equal(wrongMethod.response.status, 405)
  assert.equal(wrongMethod.response.headers.get('allow'), 'GET, DELETE')

  // Nothing above changed the list: refused requests revoke nothing.
  assert.deepEqual(await store.list(), [canonicalPath])

  const revoked = await fetch(endpoint, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: canonicalPath }),
  })
  assert.equal(revoked.status, 204)
  assert.deepEqual((await jsonRequest(endpoint)).body, { grants: [] })
})

test('shared folder grant routes without a grant list list nothing and refuse to revoke', async (t) => {
  const endpoint = await serve(t, undefined)

  const listed = await jsonRequest(endpoint)
  assert.equal(listed.response.status, 200)
  assert.deepEqual(listed.body, { grants: [] })

  const revoke = await jsonRequest(endpoint, 'DELETE', { path: '/Users/someone/Contracts' })
  assert.equal(revoke.response.status, 503)
  assert.deepEqual(revoke.body, { error: 'Shared folder grants are unavailable.', code: 'shared_folders_unavailable' })
})

test('shared folder grant routes classify store and unexpected failures without leaking details', async (t) => {
  let failure: Error = new BatchFolderGrantStoreUnavailableError('private store path')
  const endpoint = await serve(t, {
    async list() { throw failure },
    async revoke() { throw failure },
  })

  const unavailable = await jsonRequest(endpoint)
  assert.equal(unavailable.response.status, 503)
  assert.deepEqual(unavailable.body, {
    error: 'Shared folder grants are unavailable.',
    code: 'shared_folders_unavailable',
  })

  failure = new Error('private implementation detail')
  const internal = await jsonRequest(endpoint, 'DELETE', { path: '/Users/someone/Contracts' })
  assert.equal(internal.response.status, 500)
  assert.deepEqual(internal.body, {
    error: 'Shared folder grant request failed.',
    code: 'internal_shared_folder_error',
  })
})
