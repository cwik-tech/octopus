import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { SessionTask } from '../../contracts/sessions.js'
import {
  ownedProcessScopePath,
  publishOwnedProcessScope,
} from '../../core/owned-processes/owned-process-scope.js'
import {
  closeTaskOwnedProcesses,
  taskOwnedProcessesClosed,
} from '../../domains/sessions/task-owned-processes.js'

// Requirement (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// sections 6 and 8): a closed.json proves an attempt's descendants gone only
// when it sits in that attempt's own scope, whose scope.json names the task's
// session, task and attempt. The read-only check that frees a slot and the
// closer must agree: a missing, unreadable or foreign scope.json is never
// closed, whatever closed.json says.

function task(workspacePath: string): SessionTask {
  return {
    id: 'task-one',
    sessionId: 'session-one',
    runId: 'task-one',
    workflowId: 'workflow',
    brief: 'brief',
    status: 'done',
    createdAt: 'then',
    cwd: path.join(workspacePath, 'sessions', 'session-one', 'tasks', 'task-one'),
    executionAttemptId: 'attempt-one',
    executionAttemptNumber: 1,
    ownedProcessScope: 1,
  }
}

async function withClosedScope(
  variant: 'valid' | 'missing' | 'unreadable' | 'another task' | 'another attempt',
  fn: (workspacePath: string) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'task-owned-processes-'))
  try {
    const scopePath = await publishOwnedProcessScope({ workspacePath, sessionId: 'session-one', taskId: 'task-one', executionAttemptNumber: 1 })
    const scopeJson = path.join(scopePath, 'scope.json')
    if (variant === 'missing') fs.rmSync(scopeJson)
    if (variant === 'unreadable') fs.writeFileSync(scopeJson, '')
    if (variant === 'another task' || variant === 'another attempt') {
      fs.rmSync(scopeJson)
      fs.writeFileSync(scopeJson, JSON.stringify({
        version: 1,
        taskId: variant === 'another task' ? 'task-two' : 'task-one',
        sessionId: 'session-one',
        executionAttemptNumber: variant === 'another attempt' ? 2 : 1,
        createdAt: 'then',
      }))
    }
    fs.writeFileSync(path.join(scopePath, 'closed.json'), JSON.stringify({ version: 1, closedBy: 'someone', closedAt: 'then' }))
    assert.equal(scopePath, ownedProcessScopePath({ workspacePath, sessionId: 'session-one', taskId: 'task-one', executionAttemptNumber: 1 }))
    await fn(workspacePath)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
}

test('a closed.json in the task\'s own scope is closed', async () => {
  await withClosedScope('valid', async (workspacePath) => {
    assert.equal(await taskOwnedProcessesClosed(task(workspacePath), workspacePath), true)
    assert.deepEqual(await closeTaskOwnedProcesses(task(workspacePath), workspacePath, 'test'), { kind: 'closed' })
  })
})

for (const variant of ['missing', 'unreadable', 'another task', 'another attempt'] as const) {
  test(`a closed.json beside a ${variant} scope.json is not closed, and the check agrees with the closer`, async () => {
    await withClosedScope(variant, async (workspacePath) => {
      assert.equal(
        await taskOwnedProcessesClosed(task(workspacePath), workspacePath),
        false,
        `a closed.json beside a ${variant} scope.json was accepted as closure`,
      )
      const closer = await closeTaskOwnedProcesses(task(workspacePath), workspacePath, 'test')
      assert.equal(closer.kind, 'held')
    })
  })
}
