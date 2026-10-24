import { formatDisplayName } from '@/lib/utils/display-name'
import type { TaskRunEntry } from './task-strip'

export interface WorkflowRunState {
  /** What the composer says while this run owns the conversation. */
  notice: string | null
  /** The task the composer's Stop would end. */
  taskId: string | null
}

const NO_RUN: WorkflowRunState = { notice: null, taskId: null }

/**
 * What the composer says this run is doing, or null when the run has no claim
 * on the conversation.
 *
 * One total switch over the mode, deliberately: `noImplicitReturns` turns a
 * mode added to `TaskMode` into a compile error here, so no future mode can
 * reach the strip, the backend's cancellable statuses and the run pane's Stop
 * while the composer quietly says nothing about it. That is how
 * `awaiting_model_choice` got in — nothing was wrong with the rule, the rule
 * simply had never heard of the mode.
 *
 * The word is the one the surfaces beside the composer are already using. A
 * run waiting for capacity is queued, not running, and saying "running" under
 * a Queued icon and a "Waiting for execution capacity" toast contradicts both.
 *
 * `getScheduledChatState` answers the same question for a scheduled run and
 * used to answer it identically. It no longer does: it still omits
 * `awaiting_model_choice` and still says "recovering". Whether a scheduled run
 * should read the same way is a question about that surface, not this one.
 */
function composerStatus(task: TaskRunEntry): string | null {
  switch (task.mode) {
    // Queued counts. A run waiting for capacity has no conversation to read a
    // message either, so an open composer would send it to the General Agent —
    // the misrouting this module exists to close — and queued becomes running
    // without the user doing anything, so an open composer would also be a
    // race the user could lose between typing and pressing Send. The Stop is
    // worth most here: cancelling before capacity is granted costs nothing.
    case 'queued':
    case 'running':
      return task.mode

    // Stopped, not finished. The worker is released and the decision is taken
    // in the run pane, but the continuation runs as a new attempt, the backend
    // still accepts a cancel, and the run will speak into this conversation
    // again — so a message typed here would reach the General Agent.
    case 'awaiting_model_choice':
      return 'waiting for a model choice'

    // An interrupted run counts only while it is coming back by itself. A
    // manual or unresumable interruption is released, because nothing is
    // coming back until the user asks for it.
    //
    // Not "recovering": automatic recovery is admitted when the task queue
    // starts, so between a worker dying and the next start nothing is
    // recovering, and this notice was the only surface claiming otherwise.
    case 'interrupted':
      return task.recoveryDisposition === 'automatic' ? 'waiting to resume' : null

    // The answer a run awaiting human input is waiting for is given in the
    // right pane's own panel, so the composer stays the user's own.
    case 'awaiting_input':
    case 'setup':
    case 'done':
    case 'error':
    case 'blocked':
    case 'cancelled':
      return null
  }
}

/**
 * The Workflow run that owns this conversation, if one is under way.
 *
 * Read from the newest task alone, like every other statement about what the
 * session is doing now. Two runs are deliberately left out.
 *
 * A Team run is the composer's own case: it already locks the box, says so in
 * its own words, and offers the Stop the panel above hands it.
 *
 * A scheduled run belongs to the schedule that fired it rather than to whoever
 * opened the conversation, and it already has its own line above the composer.
 * Offering a Stop there would also take away the disabled Send that the
 * scheduled desktop journey reads as proof the box is shut.
 */
export function getWorkflowRunState({
  tasks,
  hasTeamChatTask,
  scheduledNotice,
}: {
  tasks: readonly TaskRunEntry[]
  hasTeamChatTask: boolean
  scheduledNotice: string | null
}): WorkflowRunState {
  if (hasTeamChatTask || scheduledNotice !== null) return NO_RUN
  const latestTask = tasks.at(-1)
  if (!latestTask) return NO_RUN
  const status = composerStatus(latestTask)
  if (status === null) return NO_RUN
  // Named from the Workflow the user chose. The task id is generated, and
  // `label` is that id whenever the record carries no workflowId — so it is no
  // fallback, it is the one string this notice must never print.
  const name = latestTask.workflowId
    ? formatDisplayName(latestTask.workflowId)
    : 'The workflow'
  return {
    notice:
      `${name} is ${status}. Chat is paused until it finishes, ` +
      'or until you stop the run.',
    taskId: latestTask.taskId,
  }
}
