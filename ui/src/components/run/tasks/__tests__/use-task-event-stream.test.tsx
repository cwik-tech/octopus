import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '@/components/run/stage-renderers/index'
import type { TaskRunEntry } from '@/components/run/tasks/task-strip'
import { useTaskEventStream } from '@/components/run/tasks/use-task-event-stream'
import type { EngineEventEnvelope } from '@/lib/models/runtime-model'

interface CapturedStream {
  onEvent: (id: string, event: EngineEventEnvelope) => void
  signal: AbortSignal
}

const streamHarness = vi.hoisted(() => ({
  latest: null as CapturedStream | null,
}))

vi.mock('@/lib/clients/runtime-client', () => ({
  openRunEventStream: vi.fn((args: CapturedStream) => {
    streamHarness.latest = args
    return new Promise<void>((resolve) => {
      args.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }),
}))

const makeTask = (): TaskRunEntry => ({
  taskId: 'task-1',
  runId: 'run-1',
  workflowId: 'human-review',
  label: 'Human review',
  mode: 'running',
})

const makeEvent = (
  type: 'run.awaiting_input' | 'run.completed' | 'run.failed' | 'run.blocked',
  timestamp: string,
): EngineEventEnvelope => ({
  schema_version: 1,
  timestamp,
  tenant_id: 'local',
  category: type === 'run.awaiting_input' ? 'runtime' : 'run',
  type,
  run_id: 'run-1',
  root_run_id: 'run-1',
  payload: {},
})

function emit(id: string, event: EngineEventEnvelope): void {
  const stream = streamHarness.latest
  if (!stream || stream.signal.aborted) return
  stream.onEvent(id, event)
}

afterEach(() => {
  streamHarness.latest = null
  vi.clearAllMocks()
})

describe('useTaskEventStream', () => {
  it('keeps the root stream open across human input and processes completion on the same run', async () => {
    const appendTaskEvent = vi.fn<(taskId: string, event: RunEvent) => void>()
    const onInjectChatMessage = vi.fn()
    const onReloadChatMessages = vi.fn()
    const { result, unmount } = renderHook(() => {
      const [tasks, setTasks] = useState<TaskRunEntry[]>([makeTask()])
      const stream = useTaskEventStream({
        appendTaskEvent,
        onInjectChatMessage,
        onReloadChatMessages,
        setTasks,
      })
      return { ...stream, tasks }
    })

    act(() => {
      result.current.openTaskStream({ taskId: 'task-1', runId: 'run-1' })
    })
    expect(streamHarness.latest).not.toBeNull()

    act(() => {
      emit(
        '10',
        makeEvent('run.awaiting_input', '2026-08-10T12:00:00.000Z'),
      )
    })

    await waitFor(() => {
      expect(result.current.tasks[0]?.mode).toBe('awaiting_input')
    })
    expect(streamHarness.latest?.signal.aborted).toBe(false)

    act(() => {
      emit('11', makeEvent('run.completed', '2026-08-10T12:00:01.000Z'))
    })

    await waitFor(() => {
      expect(result.current.tasks[0]?.mode).toBe('done')
    })
    expect(appendTaskEvent.mock.calls.map((call) => call[1].type)).toEqual([
      'run.awaiting_input',
      'run.completed',
    ])
    expect(onReloadChatMessages).toHaveBeenCalledOnce()
    expect(onInjectChatMessage).toHaveBeenCalledWith(
      '✅ Done. What’s next? You can run another workflow or ask me about the results.',
      'assistant',
    )
    expect(streamHarness.latest?.signal.aborted).toBe(true)

    unmount()
  })
})

for (const type of ['run.failed', 'run.blocked'] as const) {
  it(`refreshes the persisted outcome immediately on ${type}`, () => {
    const onReloadChatMessages = vi.fn()
    const { result, unmount } = renderHook(() => {
      const [, setTasks] = useState<TaskRunEntry[]>([makeTask()])
      return useTaskEventStream({ appendTaskEvent: vi.fn(), onInjectChatMessage: vi.fn(), onReloadChatMessages, setTasks })
    })
    act(() => result.current.openTaskStream({ taskId: 'task-1', runId: 'run-1' }))
    act(() => emit('terminal', makeEvent(type, '2026-08-10T12:00:00.000Z')))
    expect(onReloadChatMessages).toHaveBeenCalledOnce()
    unmount()
  })
}
