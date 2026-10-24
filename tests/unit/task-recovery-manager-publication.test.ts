import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTaskPublicationMarker } from '../../domains/sessions/task-recovery-manager.js'

const taskId = 'task-1'
const executionAttemptId = 'attempt-1'

function marker() {
  return {
    schemaVersion: 2,
    taskId,
    executionAttemptId,
    resultSha256: 'a'.repeat(64),
    artifacts: [
      {
        stepId: 'output',
        role: 'primary',
        childRunId: 'child-1',
        path: 'report.md',
        sha256: 'b'.repeat(64),
        byteLength: 12,
      },
      {
        stepId: 'output',
        role: 'secondary',
        childRunId: 'child-1',
        path: 'report.docx',
        sha256: 'c'.repeat(64),
        byteLength: 24,
      },
    ],
    publishedAt: '2026-08-06T10:00:00.000Z',
  }
}

test('task publication marker parser accepts only the exact task and attempt artifact receipt', () => {
  const parsed = parseTaskPublicationMarker(marker(), { taskId, executionAttemptId })

  assert.deepEqual(parsed, [
    {
      role: 'primary',
      childRunId: 'child-1',
      path: 'report.md',
      byteLength: 12,
      sha256: 'b'.repeat(64),
    },
    {
      role: 'secondary',
      childRunId: 'child-1',
      path: 'report.docx',
      byteLength: 24,
      sha256: 'c'.repeat(64),
    },
  ])
  assert.throws(
    () => parseTaskPublicationMarker({ ...marker(), taskId: 'task-2' }, { taskId, executionAttemptId }),
    /identity/i,
  )
  assert.throws(
    () => parseTaskPublicationMarker({ ...marker(), executionAttemptId: 'attempt-2' }, { taskId, executionAttemptId }),
    /identity/i,
  )
  assert.throws(
    () => parseTaskPublicationMarker({ ...marker(), unexpected: true }, { taskId, executionAttemptId }),
    /unknown/i,
  )
  assert.throws(
    () => parseTaskPublicationMarker({ ...marker(), schemaVersion: 1 }, { taskId, executionAttemptId }),
    /schema/i,
  )
  assert.throws(
    () => parseTaskPublicationMarker({ ...marker(), artifacts: [] }, { taskId, executionAttemptId }),
    /primary/i,
  )
})
