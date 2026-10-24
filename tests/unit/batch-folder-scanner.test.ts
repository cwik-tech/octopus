import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  BatchFolderScanError,
  scanBatchFolder,
} from '../../domains/batches/batch-folder-scanner.js'

test('Batch scanner hashes eligible flat files in exact UTF-8 byte order', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-scan-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))

  await fs.writeFile(path.join(folder, 'b.TXT'), 'second')
  await fs.writeFile(path.join(folder, 'A.txt'), 'first')
  await fs.writeFile(path.join(folder, '.hidden.txt'), 'hidden')
  await fs.writeFile(path.join(folder, '_manifest.json'), '{}')
  await fs.mkdir(path.join(folder, 'nested'))
  await fs.writeFile(path.join(folder, 'nested', 'ignored.txt'), 'ignored')
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(folder, 'A.txt'), path.join(folder, 'linked.txt'))
  }

  const result = await scanBatchFolder({
    folderPath: folder,
    fileExtensions: ['.txt'],
  })

  assert.deepEqual(result.files.map((file) => file.fileName), ['A.txt', 'b.TXT'])
  assert.deepEqual(result.files.map((file) => file.ordinal), [0, 1])
  assert.deepEqual(result.files.map((file) => file.sourceSize), [5, 6])
  assert.ok(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sourceSha256)))
  assert.equal(result.totalBytes, 11)
  assert.match(result.sourceSnapshotSha256, /^[a-f0-9]{64}$/)
  assert.equal(result.canonicalFolderPath, await fs.realpath(folder))
})

test('Batch scanner treats case-distinct names as separate files where supported', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-case-scan-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  await fs.writeFile(path.join(folder, 'A.pdf'), 'upper')
  await fs.writeFile(path.join(folder, 'a.pdf'), 'lower')
  const entries = await fs.readdir(folder)
  if (entries.length !== 2) {
    t.skip('host filesystem does not preserve case-distinct names')
    return
  }

  const result = await scanBatchFolder({ folderPath: folder, fileExtensions: ['.pdf'] })
  assert.deepEqual(result.files.map((file) => file.fileName), ['A.pdf', 'a.pdf'])
})

test('Batch scanner enforces count, per-file, and total-byte limits', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-limit-scan-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  await fs.writeFile(path.join(folder, 'one.txt'), '1234')
  await fs.writeFile(path.join(folder, 'two.txt'), '5678')

  await assert.rejects(
    scanBatchFolder({
      folderPath: folder,
      fileExtensions: [],
      limits: { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 20 },
    }),
    (error) => error instanceof BatchFolderScanError && error.code === 'batch_too_large',
  )
  await assert.rejects(
    scanBatchFolder({
      folderPath: folder,
      fileExtensions: [],
      limits: { maxFiles: 3, maxFileBytes: 3, maxTotalBytes: 20 },
    }),
    (error) => error instanceof BatchFolderScanError && error.code === 'batch_too_large',
  )
  await assert.rejects(
    scanBatchFolder({
      folderPath: folder,
      fileExtensions: [],
      limits: { maxFiles: 3, maxFileBytes: 10, maxTotalBytes: 7 },
    }),
    (error) => error instanceof BatchFolderScanError && error.code === 'batch_too_large',
  )
})
