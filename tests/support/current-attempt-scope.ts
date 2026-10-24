import * as path from 'node:path'

import type { SessionTask } from '../../contracts/sessions.js'
import {
  ownedProcessScopePath,
  publishOwnedProcessScope,
} from '../../core/owned-processes/owned-process-scope.js'

/**
 * What a current-version launch records for an attempt: its ownership scope,
 * published, and the task-record field that says so. Tests that seed a
 * launched attempt directly spread this into the record, so recovery treats
 * the task as this version's rather than an earlier version's
 * (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md, section 7).
 * The scope is empty: the seeded attempt started no delegated child.
 */
export async function currentAttemptScope(
  task: SessionTask,
  executionAttemptNumber: number,
): Promise<{ readonly ownedProcessScope: 1 }> {
  // A task's own folder is <workspace>/sessions/<session>/tasks/<task>.
  const workspacePath = path.resolve(task.cwd, '..', '..', '..', '..')
  const identity = { workspacePath, sessionId: task.sessionId, taskId: task.id, executionAttemptNumber }
  if (path.dirname(path.dirname(ownedProcessScopePath(identity))) !== path.resolve(task.cwd)) {
    throw new Error(`Task ${task.id} does not live in its session's tasks folder: ${task.cwd}`)
  }
  await publishOwnedProcessScope(identity)
  return { ownedProcessScope: 1 }
}
