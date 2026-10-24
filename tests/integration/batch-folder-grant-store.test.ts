import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'

test('Batch grant store serializes concurrent mutations and persists canonical paths at 0600', async (t) => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-grants-'))
  t.after(() => fs.rm(owner, { recursive: true, force: true }))
  const storagePath = path.join(owner, 'batch-folder-grants.json')
  const first = path.join(owner, 'first')
  const second = path.join(owner, 'second')
  await Promise.all([fs.mkdir(first), fs.mkdir(second)])
  const store = new BatchFolderGrantStore(storagePath)
  await store.initialize()

  await Promise.all([store.grant(first), store.grant(second), store.revoke(first)])
  assert.deepEqual(await store.list(), [await fs.realpath(second)])
  assert.equal((await fs.stat(storagePath)).mode & 0o777, 0o600)

  const restarted = new BatchFolderGrantStore(storagePath)
  await restarted.initialize()
  assert.deepEqual(await restarted.list(), [await fs.realpath(second)])
})

test('Batch grant store fails closed for unsupported or corrupt durable state', async (t) => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-grants-corrupt-'))
  t.after(() => fs.rm(owner, { recursive: true, force: true }))
  const storagePath = path.join(owner, 'batch-folder-grants.json')
  await fs.writeFile(storagePath, JSON.stringify({ schemaVersion: 2, grants: [] }))
  const unsupported = new BatchFolderGrantStore(storagePath)
  await assert.rejects(unsupported.initialize(), /schema version/i)
  await assert.rejects(unsupported.list(), /unavailable/i)

  await fs.writeFile(storagePath, '{broken')
  const corrupt = new BatchFolderGrantStore(storagePath)
  await assert.rejects(corrupt.initialize(), /grant/i)
  assert.equal(await fs.readFile(storagePath, 'utf8'), '{broken')
})
