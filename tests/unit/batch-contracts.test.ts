import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCreateBatchRequest,
  parseEmptyBatchRequest,
  parsePatchBatchRequest,
  parseRevokeBatchFolderGrantRequest,
} from '../../contracts/schemas/batch-requests.js'

test('Batch request schemas are strict and normalize extension filters', () => {
  assert.deepEqual(parseCreateBatchRequest({
    name: 'Invoices',
    workflowId: 'invoice-review',
    folderPath: '/tmp/invoices',
    fileExtensions: ['PDF', '.Docx'],
    rerunPolicy: 'new_only',
  }), {
    name: 'Invoices',
    workflowId: 'invoice-review',
    folderPath: '/tmp/invoices',
    fileExtensions: ['.pdf', '.docx'],
    rerunPolicy: 'new_only',
  })
  assert.throws(() => parseCreateBatchRequest({
    name: 'Invoices',
    workflowId: 'invoice-review',
    folderPath: '/tmp/invoices',
    fileExtensions: [],
    rerunPolicy: 'always',
    unexpected: true,
  }), /unknown fields/i)
  assert.throws(() => parseCreateBatchRequest({
    name: 'Invoices',
    workflowId: 'invoice-review',
    folderPath: '/tmp/invoices',
    fileExtensions: [],
    promptTemplate: 'Review',
    rerunPolicy: 'always',
  }), /unknown fields/i)
})

test('Batch patch requires expectedRevision and at least one actual change', () => {
  assert.deepEqual(parsePatchBatchRequest({
    expectedRevision: 2,
    projectId: null,
    rerunPolicy: 'new_and_changed',
  }), {
    expectedRevision: 2,
    projectId: null,
    rerunPolicy: 'new_and_changed',
  })
  assert.throws(() => parsePatchBatchRequest({ expectedRevision: 2 }), /change/i)
  assert.throws(() => parsePatchBatchRequest({ name: 'No revision' }), /expectedRevision/i)
})

test('Batch action bodies and grant revocation reject unknown fields', () => {
  assert.deepEqual(parseEmptyBatchRequest(undefined), {})
  assert.deepEqual(parseEmptyBatchRequest({}), {})
  assert.throws(() => parseEmptyBatchRequest(null), /JSON object/i)
  assert.throws(() => parseEmptyBatchRequest(''), /JSON object/i)
  assert.throws(() => parseEmptyBatchRequest({ force: true }), /unknown fields/i)
  assert.deepEqual(parseRevokeBatchFolderGrantRequest({ path: '/tmp/grant' }), {
    path: '/tmp/grant',
  })
  assert.throws(() => parseRevokeBatchFolderGrantRequest({ path: 'relative' }), /absolute/i)
})
