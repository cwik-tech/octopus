import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BATCH_SCHEMA_VERSION,
  parseBatchDefinitionsFile,
  parseBatchDeletionFile,
  parseBatchExecutionFile,
  parseBatchResultClearFile,
  type BatchDefinition,
  type BatchExecution,
} from '../../domains/batches/batch-types.js'

const BATCH_ID = 'batch_00000000-0000-4000-8000-000000000001'
const EXECUTION_ID = 'exec_00000000-0000-4000-8000-000000000002'

function makeDefinition(): BatchDefinition {
  return {
    id: BATCH_ID,
    revision: 1,
    name: 'Invoices',
    workflowId: 'invoice-review',
    folderPath: '/tmp/invoices',
    fileExtensions: ['.pdf'],
    rerunPolicy: 'new_and_changed',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function makeLegacyDefinition() {
  return {
    ...makeDefinition(),
    promptTemplate: 'Review {{FILE_NAME}}',
  }
}

function makeExecution(): BatchExecution {
  return {
    id: EXECUTION_ID,
    batchId: BATCH_ID,
    definitionSnapshot: makeDefinition(),
    sourceFolderCanonicalPath: '/tmp/invoices',
    sourceSnapshotSha256: 'a'.repeat(64),
    status: 'running',
    items: [],
    retainedResultBytes: 0,
    startedAt: '2026-08-06T10:01:00.000Z',
    updatedAt: '2026-08-06T10:01:00.000Z',
  }
}

test('Batch durable envelopes migrate legacy prompts and reject unknown or corrupt state', () => {
  assert.equal(BATCH_SCHEMA_VERSION, 2)
  assert.deepEqual(
    parseBatchDefinitionsFile({
      schemaVersion: 1,
      definitions: [makeLegacyDefinition()],
    }),
    { schemaVersion: 2, definitions: [makeDefinition()] },
  )
  assert.deepEqual(
    parseBatchExecutionFile({
      schemaVersion: 1,
      revision: 3,
      execution: {
        ...makeExecution(),
        definitionSnapshot: makeLegacyDefinition(),
      },
    }),
    { schemaVersion: 2, revision: 3, execution: makeExecution() },
  )
  assert.deepEqual(parseBatchDeletionFile({
    schemaVersion: 1,
    batchId: BATCH_ID,
    requestedAt: '2026-08-06T10:02:00.000Z',
  }), {
    schemaVersion: 1,
    batchId: BATCH_ID,
    requestedAt: '2026-08-06T10:02:00.000Z',
  })
  assert.deepEqual(parseBatchResultClearFile({
    schemaVersion: 1,
    batchId: BATCH_ID,
    executionId: EXECUTION_ID,
    requestedAt: '2026-08-06T10:03:00.000Z',
  }), {
    schemaVersion: 1,
    batchId: BATCH_ID,
    executionId: EXECUTION_ID,
    requestedAt: '2026-08-06T10:03:00.000Z',
  })

  assert.throws(() => parseBatchDefinitionsFile({
    schemaVersion: 3,
    definitions: [],
  }), /schema version/i)
  assert.throws(() => parseBatchDefinitionsFile({
    schemaVersion: 2,
    definitions: [{ ...makeDefinition(), unexpected: true }],
  }), /unknown fields/i)
  assert.throws(() => parseBatchExecutionFile({
    schemaVersion: 2,
    revision: 0,
    execution: makeExecution(),
  }), /revision/i)
  assert.throws(() => parseBatchDeletionFile({
    schemaVersion: 1,
    batchId: '../escape',
    requestedAt: 'not-a-time',
  }), /batch/i)
})

test('Batch definition validation normalizes extensions and rejects unsafe fields', () => {
  const parsed = parseBatchDefinitionsFile({
    schemaVersion: 2,
    definitions: [{ ...makeDefinition(), fileExtensions: ['.PDF', '.docx'] }],
  })
  assert.deepEqual(parsed.definitions[0]?.fileExtensions, ['.pdf', '.docx'])

  assert.throws(() => parseBatchDefinitionsFile({
    schemaVersion: 2,
    definitions: [{ ...makeDefinition(), fileExtensions: ['../pdf'] }],
  }), /extension/i)
  assert.throws(() => parseBatchDefinitionsFile({
    schemaVersion: 2,
    definitions: [{ ...makeDefinition(), folderPath: 'relative/folder' }],
  }), /absolute/i)
})
