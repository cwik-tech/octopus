/**
 * Which workflow state store a task's model-choice and agent-question requests
 * use.
 *
 * The rule is whether the request gets a store that records to the task's
 * writable journal, or a read-only store that does not reopen one. The HTTP
 * routes call these after their own task lookup and checks, at the same point
 * where they used to build the store, and keep every status code. Errors from
 * the journal registry are thrown unchanged.
 */

import { isTerminalTaskStatus, type SessionTask } from '../contracts/sessions.js'
import { FileSystemWorkflowStateStore } from '../workflows/workflow-state-store.js'
import { resolveWorkflowJournalRecorder } from './workflow-journal-recorder.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'

export interface WorkflowTaskStateStoreDeps {
  readonly executionJournalRegistry?: WorkspaceExecutionJournalRegistry | undefined
}

/**
 * The store a model-choice request reads and decides with.
 *
 * A task that has ended released its execution journal, and releasing
 * flushes the projection before it closes, so the terminal state on disk is
 * whole. Reopening a closed journal throws, which is why a replay of an
 * approval whose run has finished could not be answered at all. For that one
 * case the request is read-only (there is no decision left to admit), so it
 * reads the flushed projection instead.
 *
 * Every task that is still active keeps the journal-backed canonical store,
 * with no fallback: an unavailable journal on a live run is a different
 * question, and answering it from a projection that may be behind would
 * decide a run's fate on evidence this could not read.
 */
export async function openModelChoiceWorkflowStore(
  deps: WorkflowTaskStateStoreDeps,
  task: SessionTask,
  assignmentPath: string,
): Promise<FileSystemWorkflowStateStore> {
  return isTerminalTaskStatus(task.status)
    ? new FileSystemWorkflowStateStore(assignmentPath)
    : new FileSystemWorkflowStateStore(
        assignmentPath,
        await resolveWorkflowJournalRecorder({
          registry: deps.executionJournalRegistry,
          task,
          requestId: `model-choice-${task.id}`,
          processIdentity: task.executionAttemptId ?? task.id,
        }),
      )
}

/**
 * The store an agent-question request reads and answers with.
 *
 * Only an answer to a task that still accepts answers opens the writable
 * journal. A read, or an acknowledgement for a task that no longer accepts
 * answers, gets a read-only store without reopening a writable journal; its
 * question reads (`loadAgentQuestionSnapshot`) still read an existing journal
 * directly, so they are not necessarily projection-only.
 */
export async function openAgentQuestionWorkflowStore(
  deps: WorkflowTaskStateStoreDeps,
  task: SessionTask,
  assignmentPath: string,
  request: { readonly writesAnswer: boolean },
): Promise<FileSystemWorkflowStateStore> {
  return new FileSystemWorkflowStateStore(assignmentPath, !request.writesAnswer ? {} : await resolveWorkflowJournalRecorder({
    registry: deps.executionJournalRegistry, task, requestId: `agent-questions-${task.id}`,
    processIdentity: task.executionAttemptId ?? task.id,
  }))
}
