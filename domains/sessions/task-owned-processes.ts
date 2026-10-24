/**
 * Whether a task whose root worker is gone may release its slot
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`,
 * sections 7 and 8). POSIX only; on Windows nothing changes.
 *
 * A slot is released only once the attempt's descendants are verified gone:
 * its scope closed, with a valid closed.json. Anything less holds the task,
 * with a typed reason, and nothing is signalled that cannot be verified.
 */
import * as path from 'node:path'

import {
  closeOwnedProcessScope,
  readScopeClosure,
} from '../../core/owned-processes/owned-process-closer.js'
import { readScopeRecord, scopeRecordSchema } from '../../core/owned-processes/owned-process-records.js'
import { ownedProcessScopePath } from '../../core/owned-processes/owned-process-scope.js'
import type { ProcessCleanupHold, ProcessCleanupHoldReason, SessionTask } from './session-types.js'

export type TaskOwnedProcessCleanup =
  | { readonly kind: 'closed' }
  | { readonly kind: 'held'; readonly reason: ProcessCleanupHoldReason; readonly detail: string }

/** The task's current attempt's own scope, or why it cannot be trusted. Read-only. */
type AttemptScope =
  | { readonly kind: 'scope'; readonly scopePath: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'held'; readonly reason: ProcessCleanupHoldReason; readonly detail: string }

async function readAttemptScope(task: SessionTask, workspacePath: string): Promise<AttemptScope> {
  if (task.ownedProcessScope !== 1) {
    // An earlier version launched this attempt without hosts or intents, so
    // its descendants cannot be known. A request that was never launched has
    // no attempt, and nothing to hold.
    return task.executionAttemptId
      ? {
          kind: 'held',
          reason: 'descendants_unverified_without_scope',
          detail: 'This attempt was launched by an earlier version, which recorded no ownership scope.',
        }
      : { kind: 'none' }
  }
  if (task.executionAttemptNumber === undefined) {
    return { kind: 'held', reason: 'owned_processes_unverified', detail: 'The task records a scope but no attempt number.' }
  }
  const scopePath = ownedProcessScopePath({
    workspacePath,
    sessionId: task.sessionId,
    taskId: task.id,
    executionAttemptNumber: task.executionAttemptNumber,
  })
  const scope = await readScopeRecord({ target: path.join(scopePath, 'scope.json'), schema: scopeRecordSchema })
  if (scope.kind !== 'present') {
    return {
      kind: 'held',
      reason: 'owned_processes_unverified',
      detail: scope.kind === 'absent' ? `The attempt's ownership scope is missing: ${scopePath}` : scope.reason,
    }
  }
  if (
    scope.record.taskId !== task.id ||
    scope.record.sessionId !== task.sessionId ||
    scope.record.executionAttemptNumber !== task.executionAttemptNumber
  ) {
    return { kind: 'held', reason: 'owned_processes_unverified', detail: `The ownership scope at ${scopePath} names another task or attempt.` }
  }
  return { kind: 'scope', scopePath }
}

/**
 * Whether the task's current attempt's descendants are already verified
 * gone, without closing, signalling or probing anything: a valid closed.json
 * in the attempt's own scope, whose scope.json names this task and attempt;
 * no attempt at all; or Windows. An earlier version's launched attempt never
 * is, and neither is a scope whose scope.json is missing, unreadable or
 * foreign.
 */
export async function taskOwnedProcessesClosed(task: SessionTask, workspacePath: string): Promise<boolean> {
  if (process.platform === 'win32') return true
  const scope = await readAttemptScope(task, workspacePath)
  if (scope.kind === 'none') return true
  if (scope.kind === 'held') return false
  return (await readScopeClosure(scope.scopePath)).kind === 'closed'
}

/**
 * Closes the task's current attempt's scope, or says why its descendants
 * cannot be verified. Idempotent: an already closed scope stays closed.
 */
export async function closeTaskOwnedProcesses(
  task: SessionTask,
  workspacePath: string,
  closedBy: string,
): Promise<TaskOwnedProcessCleanup> {
  if (process.platform === 'win32') return { kind: 'closed' }
  const scope = await readAttemptScope(task, workspacePath)
  if (scope.kind === 'none') return { kind: 'closed' }
  if (scope.kind === 'held') return scope
  const scopePath = scope.scopePath
  if ((await readScopeClosure(scopePath)).kind === 'closed') return { kind: 'closed' }
  const closed = await closeOwnedProcessScope(scopePath, closedBy)
  if (closed.kind === 'closed') return { kind: 'closed' }
  return {
    kind: 'held',
    reason: 'owned_processes_unverified',
    detail: closed.unverifiable.map((member) => `${member.ownedProcessId}: ${member.reason}`).join('; '),
  }
}

/**
 * The admission fields of a write that ends an attempt: the slot is released
 * once the attempt's scope is closed, and otherwise kept with the hold
 * recorded (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
 * section 8). `task` is the attempt being ended, never a newer one. An error
 * counts as unverified.
 */
export async function admissionReleaseUnlessHeld(
  task: SessionTask,
  workspacePath: string,
  closedBy: string,
): Promise<
  | { readonly admission: undefined; readonly processCleanupHold: undefined }
  | { readonly processCleanupHold: ProcessCleanupHold }
> {
  let cleanup: TaskOwnedProcessCleanup
  try {
    cleanup = await closeTaskOwnedProcesses(task, workspacePath, closedBy)
  } catch (error) {
    cleanup = {
      kind: 'held',
      reason: 'owned_processes_unverified',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  return cleanup.kind === 'closed'
    ? { admission: undefined, processCleanupHold: undefined }
    : {
        processCleanupHold: {
          reason: cleanup.reason,
          detail: cleanup.detail,
          since: new Date().toISOString(),
        },
      }
}
