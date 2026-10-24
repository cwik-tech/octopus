import test from 'node:test'
import assert from 'node:assert/strict'

import { isTaskAdmission, type TaskAdmission } from '../../contracts/sessions.js'

test('Task admission accepts Batch as an ordinary initial source', () => {
  const admission: TaskAdmission = {
    version: 1,
    requestId: 'request',
    order: '1',
    requestedAt: '2026-08-06T10:00:00.000Z',
    executionKind: 'initial',
    source: 'batch',
    expectedExecutionAttemptId: null,
    phase: 'pending',
  }
  assert.equal(isTaskAdmission(admission), true)
})
