/**
 * A5.2: a held wait's "slot still in use" goes once its record says the hold
 * is gone.
 *
 * The session's tasks are read through the real history hook, whose poll
 * re-reads a wait's record every second. The task and event endpoints are
 * served through `fetch`, the network boundary, and the poll's timer is
 * advanced as the hook's own tests advance it.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useSessionTaskHistory } from '@/components/run/tasks/use-session-task-history'
import { useTaskEventStream } from '@/components/run/tasks/use-task-event-stream'
import { useTaskRunStore } from '@/components/run/tasks/use-task-run-store'
import type { SessionSummary, SessionTask } from '@/lib/models/session-model'

const session: SessionSummary = {
  id: 'session-1',
  title: 'Held wait',
  status: 'active',
  activityType: 'workflow',
  createdAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T09:00:00.000Z',
}

const grantedAdmission: SessionTask['admission'] = {
  version: 1,
  phase: 'granted',
  requestId: 'request-1',
  order: '1',
  requestedAt: '2026-09-12T09:00:00.000Z',
  executionKind: 'initial',
  source: 'apply',
  expectedExecutionAttemptId: null,
  grantId: 'grant-1',
  ownerEpoch: 'owner-epoch',
  grantedAt: '2026-09-12T09:00:00.000Z',
  executionAttemptId: 'attempt-1',
}

function taskRecord(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id: 'task-1',
    sessionId: session.id,
    runId: 'run-1',
    workflowId: 'research-workflow',
    brief: 'Wait for an answer.',
    status: 'awaiting_input',
    createdAt: '2026-09-12T09:00:00.000Z',
    cwd: '/workspace',
    executionAttemptId: 'attempt-1',
    ...overrides,
  }
}

/** What the server would answer right now. Rewritten mid-test, as a server is. */
let serverTask: SessionTask

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function installFetch(): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith(`/sessions/${session.id}/tasks`)) {
      return jsonResponse({ tasks: [serverTask] })
    }
    if (url.pathname.endsWith(`/runs/${serverTask.runId}/events`)) {
      return jsonResponse({ events: [] })
    }
    return Promise.reject(new Error(`Unexpected request: ${url.pathname}`))
  })
}

const noop = () => {}

function mountHistory() {
  return renderHook(() => {
    const store = useTaskRunStore()
    const stream = useTaskEventStream({
      appendTaskEvent: store.appendTaskEvent,
      onInjectChatMessage: noop,
      onReloadChatMessages: noop,
      setTasks: store.setTasks,
    })
    useSessionTaskHistory({
      clearResumingTaskIds: noop,
      onLatestTaskWorkflowChange: noop,
      resetWorkflowSelection: noop,
      session,
      store,
      stream,
      taskRefreshKey: 0,
    })
    return store.tasks
  })
}

/** Runs the poll once, flushing the read it starts. */
async function pass(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
}

beforeEach(() => {
  installFetch()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('drops a wait\'s slot notice once its record no longer holds the slot', async () => {
  serverTask = taskRecord({
    admission: grantedAdmission,
    processCleanupHold: { reason: 'owned_processes_unverified', since: '2026-09-12T09:01:00.000Z' },
  })
  const { result } = mountHistory()
  await pass()
  expect(result.current.at(-1)?.slotHold).toEqual({
    reason: 'owned_processes_unverified',
    since: '2026-09-12T09:01:00.000Z',
  })

  // Its descendants were verified gone: recovery cleared the hold, and the
  // queue released the wait's slot.
  serverTask = taskRecord()
  await pass()

  expect({
    mode: result.current.at(-1)?.mode,
    slotHold: result.current.at(-1)?.slotHold,
  }).toEqual({ mode: 'awaiting_input', slotHold: undefined })
})
