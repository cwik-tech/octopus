import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  FileSourceRepository,
  FileSourceStreamError,
} from '../../domains/file-sources/file-source-repository.js'

test('file source repository streams a file into an atomic hash-verified target', async (t) => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'file-source-stream-'))
  t.after(() => fs.rm(owner, { recursive: true, force: true }))
  const source = path.join(owner, 'source.bin')
  const contents = Buffer.alloc(2 * 1024 * 1024, 7)
  await fs.writeFile(source, contents)
  const repository = new FileSourceRepository({
    rootDir: path.join(owner, 'inputs'),
    containmentRoot: owner,
  })
  const saved = await repository.saveFromFile(source, 'copy.bin', {
    overwrite: false,
    maxBytes: contents.length,
    expectedSha256: createHash('sha256').update(contents).digest('hex'),
  })
  assert.equal(saved.status, 'saved')
  assert.deepEqual(await fs.readFile(path.join(owner, 'inputs', 'copy.bin')), contents)
  assert.equal((await fs.readdir(path.join(owner, 'inputs'))).some((name) => name.startsWith('.')), false)
})

test('file source streaming rejects size/hash/symlink violations without a partial target', async (t) => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'file-source-stream-fail-'))
  t.after(() => fs.rm(owner, { recursive: true, force: true }))
  const source = path.join(owner, 'source.txt')
  await fs.writeFile(source, 'content')
  const repository = new FileSourceRepository({ rootDir: path.join(owner, 'inputs'), containmentRoot: owner })

  await assert.rejects(
    repository.saveFromFile(source, 'large.txt', {
      overwrite: false,
      maxBytes: 3,
      expectedSha256: createHash('sha256').update('content').digest('hex'),
    }),
    (error) => error instanceof FileSourceStreamError && error.code === 'file_too_large',
  )
  await assert.rejects(
    repository.saveFromFile(source, 'wrong.txt', {
      overwrite: false,
      maxBytes: 100,
      expectedSha256: 'a'.repeat(64),
    }),
    (error) => error instanceof FileSourceStreamError && error.code === 'source_changed',
  )
  if (process.platform !== 'win32') {
    const linked = path.join(owner, 'linked.txt')
    await fs.symlink(source, linked)
    await assert.rejects(
      repository.saveFromFile(linked, 'linked.txt', {
        overwrite: false,
        maxBytes: 100,
        expectedSha256: createHash('sha256').update('content').digest('hex'),
      }),
      (error) => error instanceof FileSourceStreamError && error.code === 'unsafe_source',
    )
  }
  const inputs = path.join(owner, 'inputs')
  assert.deepEqual(await fs.readdir(inputs).catch(() => []), [])
})
