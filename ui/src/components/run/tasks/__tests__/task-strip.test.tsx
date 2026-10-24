import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { TaskStrip } from '../task-strip'
import type { TaskRunEntry } from '../task-strip'

const makeTask = (overrides: Partial<TaskRunEntry> = {}): TaskRunEntry => ({
  taskId: 'task-1',
  runId: 'run-1',
  label: 'My Workflow',
  mode: 'running',
  ...overrides,
})

describe('TaskStrip', () => {
  it('renders nothing when tasks array is empty', () => {
    const { container } = render(
      <TaskStrip tasks={[]} activeTaskId={null} onSelect={vi.fn()} onCancel={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a tab per task', () => {
    const tasks = [
      makeTask({ taskId: 'a', label: 'Alpha', mode: 'running' }),
      makeTask({ taskId: 'b', label: 'Beta', mode: 'done' }),
    ]
    render(<TaskStrip tasks={tasks} activeTaskId="a" onSelect={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('Select task: Alpha')).toBeInTheDocument()
    expect(screen.getByLabelText('Select task: Beta')).toBeInTheDocument()
  })

  it('calls onSelect with the taskId when a tab label is clicked', () => {
    const onSelect = vi.fn()
    const tasks = [makeTask({ taskId: 'task-x', label: 'X Task', mode: 'done' })]
    render(<TaskStrip tasks={tasks} activeTaskId={null} onSelect={onSelect} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Select task: X Task'))
    expect(onSelect).toHaveBeenCalledWith('task-x')
  })

  it('shows cancel button for queued, running, and interrupted tasks only', () => {
    const tasks = [
      makeTask({ taskId: 'q1', label: 'Queued', mode: 'queued' }),
      makeTask({ taskId: 'r1', label: 'Running', mode: 'running' }),
      makeTask({ taskId: 'i1', label: 'Interrupted', mode: 'interrupted' }),
      makeTask({ taskId: 'd1', label: 'Done', mode: 'done' }),
    ]
    render(<TaskStrip tasks={tasks} activeTaskId="r1" onSelect={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('Cancel task: Queued')).toBeInTheDocument()
    expect(screen.getByLabelText('Cancel task: Running')).toBeInTheDocument()
    expect(screen.getByLabelText('Cancel task: Interrupted')).toBeInTheDocument()
    expect(screen.queryByLabelText('Cancel task: Done')).not.toBeInTheDocument()
  })

  it('calls onCancel with taskId when cancel button is clicked', () => {
    const onCancel = vi.fn()
    const tasks = [makeTask({ taskId: 'run-1', label: 'Running Task', mode: 'running' })]
    render(<TaskStrip tasks={tasks} activeTaskId="run-1" onSelect={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByLabelText('Cancel task: Running Task'))
    expect(onCancel).toHaveBeenCalledWith('run-1')
  })

  it('stops the active running workflow from the header control', () => {
    const onCancel = vi.fn()
    const tasks = [makeTask({ taskId: 'run-1', label: 'Running Task', mode: 'running' })]

    render(
      <TaskStrip
        tasks={tasks}
        activeTaskId="run-1"
        onSelect={vi.fn()}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop workflow: Running Task' }))
    expect(onCancel).toHaveBeenCalledWith('run-1')
  })

  it('does not show the header stop control for a completed workflow', () => {
    render(
      <TaskStrip
        tasks={[makeTask({ label: 'Done Task', mode: 'done' })]}
        activeTaskId="task-1"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: /Stop workflow:/ })).not.toBeInTheDocument()
  })

  it('calls onCancel with taskId for an interrupted task', () => {
    const onCancel = vi.fn()
    const tasks = [
      makeTask({ taskId: 'interrupted-1', label: 'Interrupted Task', mode: 'interrupted' }),
    ]
    render(
      <TaskStrip
        tasks={tasks}
        activeTaskId="interrupted-1"
        onSelect={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByLabelText('Cancel task: Interrupted Task'))
    expect(onCancel).toHaveBeenCalledWith('interrupted-1')
  })

  // Before this state had a mode of its own it was read as running, so the tab
  // offered a stop control. The wait releases the worker, but the run is still
  // unfinished and still the user's to abandon; losing the control would leave
  // the offer as the only way out of it.
  it('still offers the stop controls while a task waits on a model choice', () => {
    const onCancel = vi.fn()
    render(
      <TaskStrip
        tasks={[makeTask({ taskId: 'choice-1', label: 'Choice Task', mode: 'awaiting_model_choice' })]}
        activeTaskId="choice-1"
        onSelect={vi.fn()}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByLabelText('Cancel task: Choice Task'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop workflow: Choice Task' }))
    expect(onCancel.mock.calls).toEqual([['choice-1'], ['choice-1']])
  })

  it('keeps the elapsed time moving while a model choice is pending', () => {
    vi.useFakeTimers()
    try {
      render(
        <TaskStrip
          tasks={[makeTask({
            taskId: 'choice-1',
            label: 'Choice Task',
            mode: 'awaiting_model_choice',
            startedAt: Date.now() - 5_000,
          })]}
          activeTaskId="choice-1"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      )
      // Exact, so this proves elapsed time rather than merely a re-render.
      expect(screen.getByLabelText('Elapsed time: 00:05')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(3_000)
      })
      expect(screen.getByLabelText('Elapsed time: 00:08')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('names the waiting state on the tab instead of showing it as setup', () => {
    render(
      <TaskStrip
        tasks={[makeTask({ taskId: 'choice-1', label: 'Choice Task', mode: 'awaiting_model_choice' })]}
        activeTaskId="choice-1"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Model choice required')).toBeInTheDocument()
    expect(screen.queryByLabelText('Setup')).not.toBeInTheDocument()
  })

  it('shows correct status icons via aria-labels', () => {
    const tasks = [
      makeTask({ taskId: 'q', label: 'Q', mode: 'queued' }),
      makeTask({ taskId: 'r', label: 'R', mode: 'running' }),
      makeTask({ taskId: 'i', label: 'I', mode: 'interrupted' }),
      makeTask({ taskId: 'd', label: 'D', mode: 'done' }),
      makeTask({ taskId: 'e', label: 'E', mode: 'error' }),
      makeTask({ taskId: 'b', label: 'B', mode: 'blocked' }),
      makeTask({ taskId: 'c', label: 'C', mode: 'cancelled' }),
      makeTask({ taskId: 's', label: 'S', mode: 'setup' }),
    ]
    render(<TaskStrip tasks={tasks} activeTaskId={null} onSelect={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('Queued')).toBeInTheDocument()
    expect(screen.getByLabelText('Running')).toBeInTheDocument()
    expect(screen.getByLabelText('Interrupted')).toBeInTheDocument()
    expect(screen.getByLabelText('Done')).toBeInTheDocument()
    expect(screen.getByLabelText('Error')).toBeInTheDocument()
    expect(screen.getByLabelText('Blocked')).toBeInTheDocument()
    expect(screen.getByLabelText('Cancelled')).toBeInTheDocument()
    expect(screen.getByLabelText('Setup')).toBeInTheDocument()
  })

  it('shows the active task elapsed time and freezes it at completion', () => {
    vi.useFakeTimers()
    try {
      const startedAt = new Date('2026-07-10T12:00:00.000Z').getTime()
      vi.setSystemTime(startedAt + 5_000)
      const { rerender } = render(
        <TaskStrip
          tasks={[makeTask({ startedAt })]}
          activeTaskId="task-1"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      )

      expect(screen.getByLabelText('Elapsed time: 00:05')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(2_000)
      })
      expect(screen.getByLabelText('Elapsed time: 00:07')).toBeInTheDocument()

      rerender(
        <TaskStrip
          tasks={[makeTask({ mode: 'done', startedAt, completedAt: startedAt + 8_000 })]}
          activeTaskId="task-1"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      )
      expect(screen.getByLabelText('Elapsed time: 00:08')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(screen.getByLabelText('Elapsed time: 00:08')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show an execution timer for a queued task', () => {
    render(
      <TaskStrip
        tasks={[makeTask({ mode: 'queued', startedAt: Date.now() - 30_000 })]}
        activeTaskId="task-1"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText(/Elapsed time:/)).not.toBeInTheDocument()
  })
})
