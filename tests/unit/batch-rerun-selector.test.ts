import test from 'node:test'
import assert from 'node:assert/strict'

import { selectBatchFiles } from '../../domains/batches/batch-rerun-selector.js'
import type { BatchExecution, BatchItem } from '../../domains/batches/batch-types.js'
import type { BatchScannedFile } from '../../domains/batches/batch-folder-scanner.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function file(fileName: string, sourceSha256: string): BatchScannedFile {
  return {
    ordinal: 0,
    fileName,
    sourceSize: 1,
    sourceMtime: '2026-08-06T10:00:00.000Z',
    sourceSha256,
    canonicalPath: `/tmp/${fileName}`,
  }
}

function item(status: BatchItem['status'], sourceSha256 = HASH_A): BatchItem {
  return {
    id: `item_00000000-0000-4000-8000-00000000000${sourceSha256 === HASH_A ? '1' : '2'}`,
    ordinal: 0,
    fileName: 'A.pdf',
    sourceSize: 1,
    sourceMtime: '2026-08-06T10:00:00.000Z',
    sourceSha256,
    status,
    resultArtifacts: [],
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
    ...(status === 'done' ? { completedAt: '2026-08-06T10:01:00.000Z' } : {}),
  }
}

function execution(items: readonly BatchItem[], startedAt: string): BatchExecution {
  return {
    id: `exec_00000000-0000-4000-8000-00000000000${startedAt.endsWith('02.000Z') ? '2' : '1'}`,
    batchId: 'batch_00000000-0000-4000-8000-000000000001',
    definitionSnapshot: {
      id: 'batch_00000000-0000-4000-8000-000000000001',
      revision: 1,
      name: 'History',
      workflowId: 'workflow',
      folderPath: '/tmp',
      fileExtensions: [],
      rerunPolicy: 'always',
      createdAt: startedAt,
      updatedAt: startedAt,
    },
    sourceFolderCanonicalPath: '/tmp',
    sourceSnapshotSha256: HASH_A,
    status: 'completed',
    items,
    retainedResultBytes: 0,
    startedAt,
    updatedAt: startedAt,
    completedAt: startedAt,
  }
}

test('Batch rerun policies use only the latest successful exact-name history', () => {
  const history = [
    execution([item('done', HASH_A)], '2026-08-06T10:00:01.000Z'),
    execution([item('failed', HASH_B)], '2026-08-06T10:00:02.000Z'),
  ]
  assert.deepEqual(selectBatchFiles('always', [file('A.pdf', HASH_B)], history), [
    { file: file('A.pdf', HASH_B), selected: true },
  ])
  assert.deepEqual(selectBatchFiles('new_only', [file('A.pdf', HASH_B)], history), [
    { file: file('A.pdf', HASH_B), selected: false, skipReason: 'already_processed' },
  ])
  assert.deepEqual(selectBatchFiles('new_and_changed', [file('A.pdf', HASH_B)], history), [
    { file: file('A.pdf', HASH_B), selected: true },
  ])
  assert.deepEqual(selectBatchFiles('new_and_changed', [file('A.pdf', HASH_A)], history), [
    { file: file('A.pdf', HASH_A), selected: false, skipReason: 'unchanged' },
  ])
  assert.deepEqual(
    selectBatchFiles(
      'new_only',
      [file('A.pdf', HASH_B)],
      [execution([item('failed', HASH_B)], '2026-08-06T10:00:02.000Z')],
    ),
    [{ file: file('A.pdf', HASH_B), selected: true }],
  )
})

test('Batch rerun identity is exact filename and recreated definitions have empty history', () => {
  const history = [execution([item('done')], '2026-08-06T10:00:01.000Z')]
  assert.equal(selectBatchFiles('new_only', [file('a.pdf', HASH_A)], history)[0]?.selected, true)
  assert.equal(selectBatchFiles('new_only', [file('A-renamed.pdf', HASH_A)], history)[0]?.selected, true)
  assert.equal(selectBatchFiles('new_only', [file('A.pdf', HASH_A)], [])[0]?.selected, true)
})
