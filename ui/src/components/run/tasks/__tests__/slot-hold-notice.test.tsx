import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TaskBody } from '../task-body'
import { TaskRunSummary } from '../task-run-summary'
import { applyQueueSnapshot, toTaskRunEntry, withQueueHold } from '../task-run-model'
import type { TaskRunEntry } from '../task-strip'
import type { SchedulingQueueSnapshot } from '@/lib/clients/scheduling-queue-client'
import type { SessionTask } from '@/lib/models/session-model'

// A5.2: a task that still holds its slot says so on its Run card, without
// changing its status or what else the card shows. The persisted part comes
// from the task record (a descendant hold, or a finished task whose grant is
// still held); the live root reason comes from the queue snapshot. Rendered
// from props only; nothing is mocked.

const grantedAdmission: SessionTask['admission'] = {
  version: 1,
  phase: 'granted',
  requestId: 'request-1',
  order: '1',
  requestedAt: '2026-07-14T11:58:00.000Z',
  executionKind: 'initial',
  source: 'apply',
  expectedExecutionAttemptId: null,
  grantId: 'grant-1',
  ownerEpoch: 'owner-epoch',
  grantedAt: '2026-07-14T11:58:00.000Z',
  executionAttemptId: 'attempt-1',
}

function record(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    runId: 'run-1',
    workflowId: 'research-workflow',
    brief: 'Draft.',
    status: 'cancelled',
    createdAt: '2026-07-14T11:00:00.000Z',
    updatedAt: '2026-07-14T12:00:00.000Z',
    cwd: '/tmp/task-1',
    ...overrides,
  }
}

function entry(overrides: Partial<TaskRunEntry> = {}): TaskRunEntry {
  return { taskId: 'task-1', runId: 'run-1', label: 'Research workflow', mode: 'cancelled', ...overrides }
}

describe('the card model', () => {
  it('reads a finished task whose grant is still held as holding its slot, reason not yet known', () => {
    expect(toTaskRunEntry(record({ admission: grantedAdmission }), []).slotHold).toEqual({})
  })

  it('reads a persisted descendant hold, whatever the task\'s status', () => {
    const waiting = toTaskRunEntry(record({
      status: 'awaiting_input',
      admission: grantedAdmission,
      processCleanupHold: { reason: 'owned_processes_unverified', since: '2026-07-14T11:59:00.000Z' },
    }), [])
    expect({ mode: waiting.mode, slotHold: waiting.slotHold }).toEqual({
      mode: 'awaiting_input',
      slotHold: { reason: 'owned_processes_unverified', since: '2026-07-14T11:59:00.000Z' },
    })
  })

  it('reads nothing once the grant is released', () => {
    expect(toTaskRunEntry(record(), []).slotHold).toBeUndefined()
  })

  it('follows the live queue snapshot, which lists every task that holds a slot', () => {
    const finished = entry({ slotHold: {} })
    const snapshot = (items: SchedulingQueueSnapshot['items']): SchedulingQueueSnapshot => ({
      version: 1,
      status: 'ready',
      maximumConcurrentTasks: 1,
      slotsInUse: items.length,
      availableSlots: 1 - items.length,
      waitingCount: 0,
      observedAt: '2026-07-14T12:00:00.000Z',
      items,
    })
    const listed = {
      sessionId: 'session-1',
      taskId: 'task-1',
      runId: 'run-1',
      workflowId: 'research-workflow',
      state: 'finishing' as const,
      executionKind: 'initial' as const,
      source: 'apply' as const,
      requestedAt: '2026-07-14T11:58:00.000Z',
    }

    expect({
      released: applyQueueSnapshot(finished, snapshot([])).slotHold,
      stillListed: applyQueueSnapshot(finished, snapshot([listed])).slotHold,
      // A run the event stream has just marked done, which the queue lists
      // until its next pass releases the slot: the snapshot gives no reason,
      // so it adds no notice (the notice would push the timeline down under
      // the pointer at every completion).
      justFinished: applyQueueSnapshot(entry({ mode: 'done' }), snapshot([listed])).slotHold,
      withReason: applyQueueSnapshot(finished, snapshot([{
        ...listed,
        hold: { reason: 'ambiguous_marker', blocksDispatch: true, processGroupCount: 2 },
      }])).slotHold,
      runningListed: applyQueueSnapshot(entry({ mode: 'running', slotHold: {} }), snapshot([{ ...listed, state: 'running' }])).slotHold,
      noSnapshotYet: applyQueueSnapshot(finished, null).slotHold,
      // A queue still recovering has not read every task yet.
      queueRecovering: applyQueueSnapshot(finished, { ...snapshot([]), status: 'recovering' }).slotHold,
    }).toEqual({
      released: undefined,
      stillListed: {},
      justFinished: undefined,
      withReason: { reason: 'ambiguous_marker', processGroupCount: 2 },
      runningListed: undefined,
      noSnapshotYet: {},
      queueRecovering: {},
    })
  })

  it('takes the live root reason from the queue snapshot', () => {
    expect(withQueueHold(entry({ mode: 'running' }), {
      reason: 'unverified_live_process',
      blocksDispatch: true,
      processId: 4312,
    }).slotHold).toEqual({ reason: 'unverified_live_process', processId: 4312 })
    expect(withQueueHold(entry({ slotHold: {} }), undefined).slotHold).toEqual({})
  })
})

describe('the Run summary card', () => {
  it('says a cancelled task still holds its slot, and why, keeping its Cancelled status', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[]}
        isResuming={false}
        task={entry({ slotHold: { reason: 'unverified_live_process', processId: 4312 } })}
      />,
    )

    const notice = screen.getByRole('status', { name: 'Slot still in use' })
    expect(notice).toHaveTextContent(
      "Its slot is still in use: its recorded worker is still running but cannot be confirmed as this task's, so it is not stopped automatically.",
    )
    expect(notice).toHaveTextContent('Process 4312')
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
  })

  it('says a wait held for its descendants still holds its slot, keeping its status', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[]}
        isResuming={false}
        task={entry({
          mode: 'awaiting_model_choice',
          slotHold: { reason: 'owned_processes_unverified', since: '2026-07-14T11:59:00.000Z' },
        })}
      />,
    )

    expect(screen.getByRole('status', { name: 'Slot still in use' })).toHaveTextContent(
      'Its slot is still in use: processes this task started may still be running.',
    )
    expect(screen.getByText('Model choice required')).toBeInTheDocument()
  })

  it('says a slot is in use while its reason is not known yet', () => {
    render(
      <TaskRunSummary declaredStages={[]} events={[]} isResuming={false} task={entry({ slotHold: {} })} />,
    )

    expect(screen.getByRole('status', { name: 'Slot still in use' })).toHaveTextContent(
      'Its slot is still in use while its worker is checked.',
    )
  })

  it('shows no notice when the slot is free', () => {
    render(<TaskRunSummary declaredStages={[]} events={[]} isResuming={false} task={entry()} />)

    expect(screen.queryByRole('status', { name: 'Slot still in use' })).not.toBeInTheDocument()
  })
})

describe('a held wait for an answer', () => {
  it('says its slot is still in use and keeps asking for the answer', () => {
    render(
      <TaskBody
        task={entry({
          mode: 'awaiting_input',
          slotHold: { reason: 'descendants_unverified_without_scope', since: '2026-07-14T11:59:00.000Z' },
        })}
        sessionId="session-1"
        agentQuestionWaitTaskIds={new Set(['task-1'])}
        agentQuestionReadTaskIds={new Set(['task-1'])}
      />,
    )

    expect(screen.getByRole('status', { name: 'Slot still in use' })).toHaveTextContent(
      'Its slot is still in use: processes this task started may still be running.',
    )
    expect(screen.getByText('Waiting for your answer in the conversation.')).toBeInTheDocument()
  })
})
