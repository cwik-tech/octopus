import { describe, expect, it } from 'vitest'

import type { SessionSummary, SessionTask } from '@/lib/models/session-model'
import { getScheduledChatState } from '../scheduled-chat-state'
import { toTaskRunEntry } from '../task-run-model'
import type { TaskRunEntry } from '../task-strip'

function makeSessionWithoutOrigin(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1', title: 'Research', status: 'active', activityType: 'workflow',
    createdAt: '2026-09-09T12:00:00Z', updatedAt: '2026-09-09T12:00:00Z',
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return makeSessionWithoutOrigin({
    origin: { kind: 'scheduled', scheduleId: 'sch_00000000-0000-4000-8000-000000000001' },
    ...overrides,
  })
}

function makeTask(overrides: Partial<TaskRunEntry> = {}): TaskRunEntry {
  return { taskId: 'task-1', runId: 'run-1', label: 'Research', mode: 'running', ...overrides }
}

describe('scheduled chat availability', () => {
  it('locks scheduled chat while its task history is loading', () => {
    const state = getScheduledChatState(makeSession(), [])
    expect(state.isScheduled).toBe(true)
    expect(state.notice).toContain('Please wait')
  })

  it.each(['queued', 'running'] as const)('locks input while scheduled research is %s', (mode) => {
    expect(getScheduledChatState(makeSession(), [makeTask({ mode })])).toEqual({
      isScheduled: true,
      notice: `Scheduled research is ${mode}. Please wait; chat will be available when it finishes.`,
    })
  })

  it('keeps the lock during automatic recovery', () => {
    expect(getScheduledChatState(makeSession(), [makeTask({ mode: 'interrupted', recoveryDisposition: 'automatic' })])).toEqual({
      isScheduled: true,
      notice: 'Scheduled research is recovering. Please wait; chat will be available when it finishes.',
    })
  })

  it.each(['done', 'error', 'blocked', 'cancelled', 'awaiting_input', 'interrupted'] as const)(
    'restores input when the run is %s, retaining its schedule identity', (mode) => {
      expect(getScheduledChatState(makeSession(), [makeTask({ mode })])).toEqual({ isScheduled: true, notice: null })
    },
  )

  it('keeps input locked if another scheduled task has not finished', () => {
    expect(getScheduledChatState(makeSession(), [makeTask(), makeTask({ taskId: 'task-2', mode: 'done' })]).notice).not.toBeNull()
  })

  it('recognizes existing scheduled tasks whose sessions predate origin metadata', () => {
    expect(getScheduledChatState(makeSessionWithoutOrigin(), [makeTask({ isScheduled: true })]).isScheduled).toBe(true)
  })

  it('does not restrict an ordinary conversation that happens to have a schedule-like title', () => {
    expect(getScheduledChatState(makeSessionWithoutOrigin({ title: '⏰ Daily research' }), [makeTask()])).toEqual({ isScheduled: false, notice: null })
  })

  it('does not carry a lock into an unselected conversation', () => {
    expect(getScheduledChatState(null, [makeTask({ isScheduled: true })])).toEqual({ isScheduled: false, notice: null })
  })
})

describe('scheduled task history', () => {
  function makeRecord(overrides: Partial<SessionTask> = {}): SessionTask {
    return {
      id: 'task-1', sessionId: 'session-1', runId: 'run-1', workflowId: 'research',
      brief: 'Research report', status: 'running', cwd: '/workspace/task-1', createdAt: '2026-09-09T12:00:00Z',
      ...overrides,
    }
  }

  it('preserves a scheduled workflow admission in the UI projection', () => {
    const record = makeRecord({ admission: {
      version: 1, phase: 'pending', requestId: 'request-1', order: '1', source: 'scheduled',
      executionKind: 'initial', requestedAt: '2026-09-09T12:00:00Z', expectedExecutionAttemptId: null,
    } })
    expect(toTaskRunEntry(record, []).isScheduled).toBe(true)
  })

  it('recognizes legacy scheduled-agent history after its queue admission has been cleared', () => {
    expect(toTaskRunEntry(makeRecord({ workflowId: 'scheduled-agent-web-researcher-0123456789ab', status: 'done' }), []).isScheduled).toBe(true)
  })

  it('does not erase a known legacy schedule when a refresh has no admission metadata', () => {
    const knownSchedule = makeTask({ isScheduled: true })
    const refreshed = { ...knownSchedule, ...toTaskRunEntry(makeRecord({ status: 'done' }), []) }

    expect(getScheduledChatState(makeSessionWithoutOrigin(), [refreshed])).toEqual({
      isScheduled: true, notice: null,
    })
  })
})
