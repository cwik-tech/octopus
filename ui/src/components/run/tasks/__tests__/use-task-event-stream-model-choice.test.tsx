/**
 * What the live stream does when a run stops to ask which model may be used.
 *
 * A task started from the desktop is `running`, and `running` is not a polled
 * status, so the only thing that can tell this pane the run has stopped is the
 * event the runner writes. Without a branch for it the pane keeps showing work
 * in flight for a run that has released its worker and is waiting on a person.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskRunEntry } from '@/components/run/tasks/task-strip'
import { useTaskEventStream } from '@/components/run/tasks/use-task-event-stream'
import type { EngineEventEnvelope } from '@/lib/models/runtime-model'

/**
 * One live SSE connection, as the runtime client really opens it.
 *
 * Driven through `fetch` and a real `ReadableStream` rather than by replacing
 * the client module: what this test is about is the stream's lifecycle, and a
 * stand-in for the thing under test cannot show that the real one reconnects,
 * resumes from an index, or stays closed.
 */
interface OpenedStream {
  readonly runId: string
  readonly fromIndex: number
  readonly signal: AbortSignal
  push(id: number, event: EngineEventEnvelope): void
}

const opened: OpenedStream[] = []

function installStreamingFetch(): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const segments = url.pathname.split('/')
    const runId = segments[segments.indexOf('runs') + 1] ?? ''
    const signal = init?.signal ?? new AbortController().signal
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
      },
      cancel() {
        controller = null
      },
    })
    opened.push({
      runId,
      fromIndex: Number(url.searchParams.get('from') ?? '0'),
      signal,
      push: (id, event) => {
        controller?.enqueue(
          new TextEncoder().encode(
            `id: ${id}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        )
      },
    })
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
  })
}

const runningTask = (taskId: string, runId: string): TaskRunEntry => ({
  taskId,
  runId,
  workflowId: 'packaged-smoke',
  label: taskId,
  mode: 'running',
})

const awaitingModelChoice = (runId: string): EngineEventEnvelope => ({
  schema_version: 1,
  timestamp: '2026-09-06T12:00:00.000Z',
  tenant_id: 'local',
  category: 'runtime',
  type: 'run.awaiting_model_choice',
  run_id: runId,
  root_run_id: runId,
  payload: {
    step_id: 'finalize',
    offer_id: 'offer-1',
    agent_name: 'defaultrecoveryworker',
  },
})

function streamFor(runId: string): OpenedStream | undefined {
  return opened.findLast((stream) => stream.runId === runId)
}

/** Waits for the real client to have opened the connection, then feeds it. */
async function emit(
  runId: string,
  id: number,
  event: EngineEventEnvelope,
): Promise<void> {
  await waitFor(() => {
    expect(streamFor(runId)).toBeDefined()
  })
  const stream = streamFor(runId)
  if (!stream || stream.signal.aborted) return
  stream.push(id, event)
}

beforeEach(() => {
  opened.length = 0
  installStreamingFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function renderStream() {
  return renderHook(() => {
    const [tasks, setTasks] = useState<TaskRunEntry[]>([
      runningTask('task-1', 'run-1'),
      runningTask('task-2', 'run-2'),
    ])
    const stream = useTaskEventStream({
      appendTaskEvent: vi.fn(),
      onInjectChatMessage: vi.fn(),
      onReloadChatMessages: vi.fn(),
      setTasks,
    })
    return { ...stream, tasks }
  })
}

describe('useTaskEventStream on run.awaiting_model_choice', () => {
  it('moves only the run that stopped into the waiting state', async () => {
    const { result, unmount } = renderStream()
    act(() => {
      result.current.openTaskStream({ taskId: 'task-1', runId: 'run-1' })
      result.current.openTaskStream({ taskId: 'task-2', runId: 'run-2' })
    })

    await act(async () => {
      await emit('run-1', 10, awaitingModelChoice('run-1'))
    })

    await waitFor(() => {
      expect(result.current.tasks[0]?.mode).toBe('awaiting_model_choice')
    })
    expect(result.current.tasks[1]?.mode).toBe('running')
    unmount()
  })

  // The run has released its worker and will not speak again until someone
  // decides. Holding the registration open would make the continuation stream
  // silently unopenable, because opening is refused while one is registered.
  it('releases the stopped run’s stream so the continuation can be opened later', async () => {
    const { result, unmount } = renderStream()
    act(() => {
      result.current.openTaskStream({ taskId: 'task-1', runId: 'run-1' })
    })

    await act(async () => {
      await emit('run-1', 10, awaitingModelChoice('run-1'))
    })

    await waitFor(() => {
      expect(streamFor('run-1')?.signal.aborted).toBe(true)
    })

    act(() => {
      result.current.openTaskStream({
        taskId: 'task-1',
        runId: 'run-1',
        fromIndex: 7,
      })
    })
    await waitFor(() => {
      expect(opened.filter((stream) => stream.runId === 'run-1')).toHaveLength(2)
    })

    const continuation = streamFor('run-1')
    expect(continuation?.signal.aborted).toBe(false)
    expect(continuation?.fromIndex).toBe(7)
    expect(opened.filter((stream) => stream.runId === 'run-1')).toHaveLength(2)
    unmount()
  })
})
