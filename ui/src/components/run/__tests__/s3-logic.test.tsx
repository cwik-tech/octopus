/**
 * S3 unit tests — pure business logic
 *
 * Covers:
 *   1. TaskBody mode routing (setup / running / done / error / cancelled / unknown)
 *   2. Run-summary behavior before and after process events arrive
 *   3. DoneView artifact-path guard (empty path → error state; non-empty → fetch)
 */

import { cleanup, render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// ── Shared mocks ──────────────────────────────────────────────────────────

// Silence Lucide and UI primitives — we only care about logic outputs.
vi.mock('lucide-react', () => ({
  CheckCircle2: () => null,
  RefreshCw: () => null,
  CircleAlert: () => null,
  MinusCircle: () => null,
  X: () => null,
  FolderOpen: () => null,
  Upload: () => null,
  Plus: () => null,
  Loader2: () => null,
  XCircle: () => null,
  Circle: () => null,
  PlayCircle: () => null,
  Activity: () => null,
  Bug: () => null,
  ChevronDown: () => null,
  CirclePause: () => null,
  Clock3: () => null,
  FileText: () => null,
  GripVertical: () => null,
  Info: () => null,
  MessagesSquare: () => null,
  Check: () => null,
  Copy: () => null,
  Lock: () => null,
  Network: () => null,
  Plug: () => null,
  RotateCcw: () => null,
  Route: () => null,
  ShieldAlert: () => null,
  Square: () => null,
}))

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }))
vi.mock('@/components/ui/button', () => ({ Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement> & React.PropsWithChildren) => <button disabled={p.disabled} onClick={p.onClick}>{p.children}</button> }))
vi.mock('@/components/ui/card', () => ({
  Card: (p: React.PropsWithChildren) => <div>{p.children}</div>,
  CardContent: (p: React.PropsWithChildren) => <div>{p.children}</div>,
  CardHeader: (p: React.PropsWithChildren) => <div>{p.children}</div>,
  CardTitle: (p: React.PropsWithChildren) => <div>{p.children}</div>,
  CardDescription: (p: React.PropsWithChildren) => <div>{p.children}</div>,
  PanelCard: (p: React.PropsWithChildren) => <section>{p.children}</section>,
  PanelContent: (p: React.PropsWithChildren) => <div>{p.children}</div>,
  PanelHeader: (p: React.PropsWithChildren<{ title?: React.ReactNode }>) => (
    <div>
      {p.title}
      {p.children}
    </div>
  ),
}))
vi.mock('@/components/shared/file-upload', () => ({ default: () => null }))
vi.mock('@/components/run/pickers/workflow-picker', () => ({ default: () => null }))
vi.mock('@/components/markdown-viewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}))
vi.mock('@/components/run/stage-renderers/index', () => ({
  getRenderer: () => () => <div data-testid="renderer" />,
}))

// ── Tests: TaskBody mode routing ──────────────────────────────────────────

describe('TaskBody mode routing', () => {
  let TaskBody: typeof import('@/components/run/tasks/task-body').TaskBody
  let fetchArtifact: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    fetchArtifact = vi.fn().mockResolvedValue('# content')
    vi.doMock('@/lib/clients/runtime-client', () => ({
      fetchArtifact,
      fetchRunDetails: vi.fn().mockResolvedValue({ artifactPaths: [] }),
    }))
    const mod = await import('@/components/run/tasks/task-body')
    TaskBody = mod.TaskBody
  })

  afterEach(() => {
    cleanup()
    vi.resetModules()
  })

  function makeTask(mode: import('@/components/run/tasks/task-strip').TaskMode, extras = {}) {
    return { taskId: 't1', runId: 'r1', label: 'Task', mode, ...extras }
  }

  test('setup mode renders without a launch button', () => {
    render(<TaskBody task={makeTask('setup')} sessionId="s1" />)
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull()
  })

  test('running mode renders no event meter', () => {
    render(<TaskBody task={makeTask('running')} sessionId="s1" events={[]} />)
    expect(screen.queryByText(/Events:/)).toBeNull()
  })

  test('error mode renders status without duplicating the error message', () => {
    render(<TaskBody task={makeTask('error', { errorMessage: 'boom' })} sessionId="s1" />)
    expect(screen.getByText('Error')).toBeDefined()
    expect(screen.queryByText('boom')).toBeNull()
  })

  test('cancelled mode keeps the Stop control visible and disabled', () => {
    const onCancelTask = vi.fn()
    render(
      <TaskBody
        task={makeTask('cancelled')}
        sessionId="s1"
        onCancelTask={onCancelTask}
      />,
    )
    expect(screen.getByText('Cancelled')).toBeDefined()
    expect(screen.queryByText('Task was cancelled')).toBeNull()
    const stopButton = screen.getByRole('button', { name: 'Stop workflow' })
    expect(stopButton).toBeDisabled()
    fireEvent.click(stopButton)
    expect(onCancelTask).not.toHaveBeenCalled()
  })

  test('unknown mode renders nothing (null)', () => {
    // @ts-expect-error intentional invalid mode
    const { container } = render(<TaskBody task={makeTask('unknown')} sessionId="s1" />)
    expect(container.firstChild).toBeNull()
  })
})

// ── Tests: summary state before process events ─────────────────────────────

describe('run summary state (running mode)', () => {
  let TaskBody: typeof import('@/components/run/tasks/task-body').TaskBody
  let fetchArtifact: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    fetchArtifact = vi.fn().mockResolvedValue('# content')
    vi.doMock('@/lib/clients/runtime-client', () => ({
      fetchArtifact,
      fetchRunDetails: vi.fn().mockResolvedValue({ artifactPaths: [] }),
    }))
    const mod = await import('@/components/run/tasks/task-body')
    TaskBody = mod.TaskBody
  })

  afterEach(() => {
    cleanup()
    vi.resetModules()
  })

  function makeRunningTask() {
    return { taskId: 't1', runId: 'r1', label: 'Task', mode: 'running' as const }
  }

  test('shows Running and the empty process timeline before events arrive', () => {
    render(<TaskBody task={makeRunningTask()} sessionId="s1" events={[]} />)
    expect(screen.getByText('Running')).toBeDefined()
    expect(
      screen.getByText('Waiting for the workflow to report process events…'),
    ).toBeDefined()
    expect(screen.queryByText('Connecting…')).toBeNull()
  })

  test('keeps the summary concise once events arrive', () => {
    const event = { id: 'e0', type: 'log' as const, ts: 0, content: 'hello' }
    render(<TaskBody task={makeRunningTask()} sessionId="s1" events={[event]} />)
    expect(screen.queryByText('Connecting…')).toBeNull()
  })

  test('carries no status footer once events arrive', () => {
    const { rerender } = render(
      <TaskBody task={makeRunningTask()} sessionId="s1" events={[]} />
    )
    expect(screen.queryByText(/Events:/)).toBeNull()
    expect(screen.queryByText('Connecting to stream…')).toBeNull()

    const event = { id: 'e0', type: 'log' as const, ts: 0, content: 'hello' }
    rerender(
      <TaskBody task={makeRunningTask()} sessionId="s1" events={[event]} />
    )
    expect(screen.queryByText(/Events:/)).toBeNull()
    expect(screen.queryByText('Live')).toBeNull()
  })

  test('renders the new task summary when taskId changes', () => {
    const event = { id: 'e0', type: 'log' as const, ts: 0, content: 'hello' }

    // First task: was connected (has events)
    const { rerender } = render(
      <TaskBody task={{ taskId: 't1', runId: 'r1', label: 'T1', mode: 'running' }} sessionId="s1" events={[event]} />
    )
    expect(screen.queryByText('Connecting…')).toBeNull()

    // Switch to a new task with no events.
    rerender(
      <TaskBody task={{ taskId: 't2', runId: 'r2', label: 'T2', mode: 'running' }} sessionId="s1" events={[]} />
    )
    expect(screen.getByText('T2')).toBeDefined()
    expect(screen.getByText('Running')).toBeDefined()
    expect(screen.queryByText('Connecting…')).toBeNull()
  })
})

// ── Tests: DoneView artifact-path guard ───────────────────────────────────

describe('DoneView artifact-path guard', () => {
  let DoneView: typeof import('@/components/run/stage-renderers/done').DoneView
  let fetchArtifact: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    fetchArtifact = vi.fn().mockResolvedValue('# Hello world')
    vi.doMock('@/lib/clients/runtime-client', () => ({
      fetchArtifact,
      fetchRunDetails: vi.fn().mockResolvedValue({ artifactPaths: [] }),
    }))
    const mod = await import('@/components/run/stage-renderers/done')
    DoneView = mod.DoneView
  })

  afterEach(() => {
    cleanup()
    vi.resetModules()
  })

  test('empty artifactPath shows error without calling fetch', async () => {
    await act(async () => {
      render(<DoneView taskId="t1" runId="r1" artifactPath="" />)
    })
    expect(screen.getByText(/No artifact was produced by this task/)).toBeDefined()
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  test('non-empty artifactPath calls fetchArtifact with correct args', async () => {
    await act(async () => {
      render(<DoneView taskId="t1" runId="r1" artifactPath="output/report.md" />)
    })
    expect(fetchArtifact).toHaveBeenCalledWith('r1', 'output/report.md')
  })

  test('successful fetch renders markdown content', async () => {
    fetchArtifact.mockResolvedValue('# My Report')
    await act(async () => {
      render(<DoneView taskId="t1" runId="r1" artifactPath="output/report.md" />)
    })
    expect(screen.getByTestId('markdown').textContent).toBe('# My Report')
  })

  test('fetch error shows error message', async () => {
    fetchArtifact.mockRejectedValue(new Error('500 Internal Server Error'))
    await act(async () => {
      render(<DoneView taskId="t1" runId="r1" artifactPath="output/report.md" />)
    })
    expect(screen.getByText('500 Internal Server Error')).toBeDefined()
    expect(screen.getByText('Failed to load artifact')).toBeDefined()
  })

  test('completion banner is always shown', async () => {
    await act(async () => {
      render(<DoneView taskId="t1" runId="r1" artifactPath="output/report.md" />)
    })
    expect(screen.getByText('Task complete')).toBeDefined()
  })

  test('retry button re-invokes fetchArtifact', async () => {
    fetchArtifact.mockRejectedValueOnce(new Error('network error'))
    fetchArtifact.mockResolvedValueOnce('# retry content')

    await act(async () => {
      render(<DoneView taskId="t1" runId="r1" artifactPath="output/report.md" />)
    })

    expect(screen.getByText('network error')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.getByTestId('markdown').textContent).toBe('# retry content'))

    expect(fetchArtifact).toHaveBeenCalledTimes(2)
  })
})
