import type { SessionSummary } from '@/lib/models/session-model'
import type { TaskRunEntry } from './task-strip'

export function getScheduledChatState(
  session: SessionSummary | null,
  tasks: readonly TaskRunEntry[],
): { isScheduled: boolean; notice: string | null } {
  const isScheduled = session !== null && (
    session.origin?.kind === 'scheduled' || tasks.some((task) => task.isScheduled)
  )
  if (!isScheduled) return { isScheduled: false, notice: null }
  if (tasks.length === 0) {
    return { isScheduled: true, notice: 'Loading scheduled research. Please wait while its status is checked.' }
  }
  const activeTask = tasks.findLast((task) =>
    task.mode === 'queued' || task.mode === 'running' ||
    (task.mode === 'interrupted' && task.recoveryDisposition === 'automatic'),
  )
  if (!activeTask) return { isScheduled: true, notice: null }
  const status = activeTask.mode === 'interrupted' ? 'recovering' : activeTask.mode
  return {
    isScheduled: true,
    notice: `Scheduled research is ${status}. Please wait; chat will be available when it finishes.`,
  }
}
