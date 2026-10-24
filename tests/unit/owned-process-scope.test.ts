import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ownedProcessScopePath,
  publishOwnedProcessScope,
} from '../../core/owned-processes/owned-process-scope.js'
import {
  ownedProcessScopeFolders,
  readScopeRecord,
  scopeRecordSchema,
} from '../../core/owned-processes/owned-process-records.js'

// Requirement (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// section 1): an attempt's scope lives in its task's own folder, derived from
// the session, task and attempt number; publishing it creates its folders and
// scope.json; publishing the same attempt again is accepted, and a scope that
// names another task or attempt, or cannot be read, is refused.

async function withWorkspace(fn: (workspacePath: string) => Promise<void>): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-scope-'))
  try {
    await fn(workspacePath)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
}

const identity = { sessionId: 'session-1', taskId: 'task-1', executionAttemptNumber: 2 }

test('an attempt\'s scope is in its task\'s own folder, and publishing it creates its folders and scope.json', async () => {
  await withWorkspace(async (workspacePath) => {
    const scopePath = ownedProcessScopePath({ workspacePath, ...identity })
    assert.equal(scopePath, path.join(workspacePath, 'sessions', 'session-1', 'tasks', 'task-1', 'owned-processes', 'attempt-2'))

    assert.equal(await publishOwnedProcessScope({ workspacePath, ...identity }), scopePath)

    for (const folder of Object.values(ownedProcessScopeFolders(scopePath))) {
      assert.equal(fs.statSync(folder).isDirectory(), true, `${folder} exists`)
    }
    const scope = await readScopeRecord({ target: path.join(scopePath, 'scope.json'), schema: scopeRecordSchema })
    assert.equal(scope.kind, 'present')
    assert.deepEqual(
      scope.kind === 'present'
        ? { taskId: scope.record.taskId, sessionId: scope.record.sessionId, attempt: scope.record.executionAttemptNumber }
        : undefined,
      { taskId: 'task-1', sessionId: 'session-1', attempt: 2 },
    )
    assert.equal(await publishOwnedProcessScope({ workspacePath, ...identity }), scopePath, 'the same attempt again is accepted')
  })
})

test('a scope that names another attempt, or cannot be read, is refused', async () => {
  await withWorkspace(async (workspacePath) => {
    const scopePath = ownedProcessScopePath({ workspacePath, ...identity })
    fs.mkdirSync(scopePath, { recursive: true })
    fs.writeFileSync(path.join(scopePath, 'scope.json'), JSON.stringify({
      version: 1, taskId: 'task-1', sessionId: 'session-1', executionAttemptNumber: 3, createdAt: 'then',
    }))
    await assert.rejects(publishOwnedProcessScope({ workspacePath, ...identity }), /another/u)

    fs.writeFileSync(path.join(scopePath, 'scope.json'), '')
    await assert.rejects(publishOwnedProcessScope({ workspacePath, ...identity }), /unreadable/u)
  })
})
