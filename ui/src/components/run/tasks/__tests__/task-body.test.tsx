import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { TaskBody } from '../task-body'
import type { TaskRunEntry } from '../task-strip'
import type { RunEvent } from '../../stage-renderers/index'
import { fetchArtifact } from '@/lib/clients/runtime-client'
import type { ExecutionTimelineItem } from '@/lib/models/runtime-model'
import { getWorkflowStages } from '@/lib/clients/session-client'

// Mock heavy deps to keep tests fast and isolated
vi.mock('@/components/run/pickers/workflow-picker', () => ({
  default: ({ onSelectWorkflow }: { onSelectWorkflow: (id: string) => void }) => (
    <div>
      <button onClick={() => onSelectWorkflow('wf-1')}>Mock workflow</button>
    </div>
  ),
}))

vi.mock('@/components/shared/file-upload', () => ({
  default: ({ ownerId }: { ownerId: string }) => <div data-testid="session-files">{ownerId}</div>,
}))

vi.mock('@/components/process-timeline-table', () => ({
  ProcessTimelineTable: ({ items, onArtifactSelect, toolbarStart }: {
    items: ExecutionTimelineItem[]
    onArtifactSelect: (target: { path: string; runId: string }) => void
    toolbarStart?: ReactNode
  }) => (
    <div data-testid="process-timeline">
      {toolbarStart}
      {items.length} items
      {items.flatMap((item) => item.artifactRefs).map((artifact) => (
        <button
          key={`${artifact.runId}:${artifact.path}`}
          type="button"
          onClick={() => onArtifactSelect(artifact)}
        >
          Artifact: {artifact.path}
        </button>
      ))}
    </div>
  ),
}))

vi.mock('@/lib/clients/runtime-client', () => ({
  artifactUrl: (runId: string, artifactPath: string) => `/api/runs/${runId}/assignments/${artifactPath}`,
  fetchArtifact: vi.fn(),
  fetchExcelWorkbookPreview: vi.fn(),
  fetchRunDetails: vi.fn(),
}))

vi.mock('@/lib/clients/session-client', () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  getWorkflowStages: vi.fn(),
}))

const baseTask = (overrides: Partial<TaskRunEntry> = {}): TaskRunEntry => ({
  taskId: 'task-1',
  runId: 'run-1',
  label: 'Test Task',
  mode: 'setup',
  ...overrides,
})

describe('TaskBody', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchArtifact).mockResolvedValue('# Job request\n\nWrite the report.')
    vi.mocked(getWorkflowStages).mockResolvedValue([])
  })

  describe('setup mode', () => {
    it('renders WorkflowPicker without the old standalone upload section', () => {
      render(
        <TaskBody
          task={baseTask({ mode: 'setup' })}
          sessionId="sess-1"
        />
      )
      expect(screen.getByText('Workflow Templates')).toBeInTheDocument()
      // File sources moved into the chat composer (see chat-panel-files tests).
      expect(screen.queryByText('Upload Files')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Add from MCP' })).not.toBeInTheDocument()
    })

    it('uses the compact borderless sidebar heading for workflow templates', () => {
      render(
        <TaskBody
          task={baseTask({ mode: 'setup' })}
          sessionId="sess-1"
        />
      )

      const heading = screen.getByRole('heading', { name: 'Workflow Templates' })
      expect(heading).toHaveClass('text-xs', 'tracking-[0.14em]')
      expect(heading.closest('[data-slot="panel-header"]')).toBeNull()
      expect(heading.parentElement?.querySelector('svg')).toBeNull()
    })

    it('keeps launch controls out of the right-pane setup view', () => {
      render(
        <TaskBody
          task={baseTask({ mode: 'setup' })}
          sessionId="sess-1"
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Mock workflow' }))
      expect(
        screen.queryByRole('button', { name: /^Start$/i }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Begin workflow' }),
      ).not.toBeInTheDocument()
    })
  })

  describe('running mode', () => {
    it('shows the run summary while waiting for process events', () => {
      const runName =
        'Quarterly competitor intelligence briefing for North America'
      render(
        <TaskBody
          task={baseTask({
            label: 'scheduled-agent-web-researcher-ab8b3ba58f64',
            mode: 'running',
          })}
          sessionId="sess-1"
          runName={runName}
          events={[]}
        />
      )
      const summary = screen.getByLabelText('Run summary')
      expect(summary).toHaveClass(
        'bg-transparent',
        'mb-3',
        'ring-0',
        'rounded-none',
      )
      expect(
        within(summary).getByText('Quarterly competitor intelligence…'),
      ).toHaveAttribute('title', runName)
      expect(
        within(summary).queryByText('scheduled-agent-web-researcher-ab8b3ba58f64'),
      ).not.toBeInTheDocument()
      expect(within(summary).getByText('Running')).toBeInTheDocument()
      expect(within(summary).getByText('0 / 0')).toBeInTheDocument()
      expect(screen.queryByText('Connecting…')).not.toBeInTheDocument()
      expect(screen.queryByText('Stages')).not.toBeInTheDocument()
    })

    it('shows the run summary and process timeline instead of stages or agent activity', () => {
      const events: RunEvent[] = [
        {
          id: 'e1',
          type: 'discussion.message',
          ts: Date.now(),
          agentName: 'contrarian',
          content: 'Is the audience assumption sound?',
        },
      ]
      render(
        <TaskBody
          task={baseTask({ mode: 'running' })}
          sessionId="sess-1"
          events={events}
        />
      )
      expect(screen.getByLabelText('Run summary')).toBeInTheDocument()
      expect(screen.queryByLabelText('Workflow stages')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Process timeline')).toBeInTheDocument()
      expect(screen.queryByText('Agent activity')).not.toBeInTheDocument()
      expect(screen.queryByText('Is the audience assumption sound?')).not.toBeInTheDocument()
    })

    it('keeps a durable Team answer out of the process timeline', () => {
      const events: RunEvent[] = [
        {
          id: 'e1',
          type: 'team.message',
          ts: Date.now(),
          agentName: 'line-one',
          content: 'Phased rollout recommended.',
          messageId: 'run#call#1#line-one',
        },
      ]
      render(
        <TaskBody
          task={baseTask({ mode: 'running' })}
          sessionId="sess-1"
          events={events}
        />
      )

      expect(screen.getByLabelText('Process timeline')).toBeInTheDocument()
      expect(
        screen.queryByText('Phased rollout recommended.'),
      ).not.toBeInTheDocument()
    })

    it('keeps the timeline title fixed and moves its explanation into an info tooltip', async () => {
      const user = userEvent.setup()
      render(
        <TaskBody
          task={baseTask({ mode: 'running' })}
          sessionId="sess-1"
          events={[{ id: 'e1', type: 'agent.start', ts: Date.now() }]}
        />,
      )

      const timeline = screen.getByLabelText('Process timeline')
      expect(timeline).toHaveClass('min-h-[30rem]', 'flex-1')
      expect(timeline.parentElement).toHaveClass('overflow-y-auto')
      expect(timeline).not.toHaveTextContent('Running')
      expect(
        screen.queryByText(/End-to-end workflow events, including delegated teams/),
      ).not.toBeInTheDocument()

      await user.hover(screen.getByRole('button', { name: 'About process timeline' }))
      expect(
        await screen.findByText(/End-to-end workflow events, including delegated teams/),
      ).toBeInTheDocument()
    })

    it('renders the activity pane without a diagnostics section or event meter', () => {
      const events: RunEvent[] = [
        { id: 'e1', type: 'agent.start', ts: Date.now() },
        { id: 'e2', type: 'agent.end', ts: Date.now() },
      ]
      render(
        <TaskBody
          task={baseTask({ mode: 'running' })}
          sessionId="sess-1"
          events={events}
        />
      )
      expect(screen.queryByText('Events: 2')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Runtime diagnostics' }),
      ).not.toBeInTheDocument()
    })

    it('keeps stage registry errors out of the sidebar', async () => {
      vi.mocked(getWorkflowStages).mockRejectedValueOnce(
        new Error('Stage registry unavailable'),
      )

      render(
        <TaskBody
          task={baseTask({ mode: 'running', workflowId: 'workflow-1' })}
          sessionId="sess-1"
          events={[]}
        />,
      )

      await waitFor(() => expect(getWorkflowStages).toHaveBeenCalledTimes(1))
      expect(screen.getByLabelText('Run summary')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText('Stage registry unavailable')).not.toBeInTheDocument()
    })

    it('summarizes durable source issues and moves cancellation into the summary', async () => {
      const user = userEvent.setup()
      const onCancelTask = vi.fn()
      const events: RunEvent[] = [
        {
          id: 'observation-1',
          type: 'artifact.written',
          ts: Date.now(),
          runId: 'lane-1',
          artifactPath: 'research/observations/lane-1/a.json',
          artifactType: 'observation-receipt',
        },
        {
          id: 'observation-1-duplicate',
          type: 'artifact.written',
          ts: Date.now(),
          runId: 'lane-1',
          artifactPath: 'research/observations/lane-1/a.json',
          artifactType: 'observation-receipt',
        },
        {
          id: 'observation-2',
          type: 'artifact.written',
          ts: Date.now(),
          runId: 'lane-2',
          artifactPath: 'research/observations/lane-2/b.json',
          artifactType: 'observation-receipt',
        },
        {
          id: 'extraction-1',
          type: 'artifact.written',
          ts: Date.now(),
          runId: 'lane-2',
          artifactPath: 'research/extractions/lane-2/b.json',
          artifactType: 'source-extraction-receipt',
        },
        {
          id: 'blocked-source',
          type: 'research.acquisition.completed',
          ts: 1,
          acquisitionSourceKey: 'source-a',
          acquisitionIssueKind: 'blocked',
          acquisitionUsable: false,
        },
        {
          id: 'recovered-source',
          type: 'research.acquisition.completed',
          ts: 2,
          acquisitionSourceKey: 'source-a',
          acquisitionIssueKind: 'none',
          acquisitionUsable: true,
        },
        {
          id: 'limited-source',
          type: 'research.acquisition.completed',
          ts: 3,
          acquisitionSourceKey: 'source-b',
          acquisitionIssueKind: 'limited',
          acquisitionUsable: false,
        },
        {
          id: 'rate-limited-source',
          type: 'research.acquisition.completed',
          ts: 4,
          acquisitionSourceKey: 'source-c',
          acquisitionIssueKind: 'rate-limited',
          acquisitionUsable: false,
        },
      ]

      render(
        <TaskBody
          task={baseTask({
            mode: 'running',
            workflowId: 'deep-research-report',
          })}
          sessionId="sess-1"
          onCancelTask={onCancelTask}
          events={events}
        />,
      )

      const summary = screen.getByLabelText('Run summary')
      expect(within(summary).getByText('Source issues')).toBeInTheDocument()
      const issueDetails = within(summary).getByRole('button', {
        name: 'Source issues details: 3 issues',
      })
      expect(issueDetails).toHaveTextContent('3')
      await user.hover(issueDetails)
      expect(await screen.findByText('1 rate-limited')).toBeInTheDocument()
      expect(screen.getByText('1 limited')).toBeInTheDocument()
      expect(screen.getByText('1 recovered by fallback')).toBeInTheDocument()
      expect(screen.getByText('2 usable sources saved')).toBeInTheDocument()
      fireEvent.click(
        within(summary).getByRole('button', { name: 'Stop research' }),
      )
      expect(onCancelTask).toHaveBeenCalledWith('task-1')
    })

    it('opens a resizable artifact sheet from a live artifact badge and closes on outside click', async () => {
      const events: RunEvent[] = [
        {
          id: 'e1',
          type: 'gate.transition',
          ts: Date.now(),
          stageType: 'discussion',
        },
        {
          id: 'e2',
          type: 'artifact.written',
          ts: Date.now(),
          artifactPath: 'job-request.md',
          runId: 'run-1',
        },
      ]
      render(
        <TaskBody
          task={baseTask({ mode: 'running', runId: 'run-1' })}
          sessionId="sess-1"
          events={events}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /artifact:\s*job-request\.md/i }))

      await waitFor(() => {
        expect(fetchArtifact).toHaveBeenCalledWith('run-1', 'job-request.md')
      })
      expect(await screen.findByRole('heading', { name: /job-request\.md/i })).toBeInTheDocument()
      expect(screen.getByLabelText('Resize artifact sheet')).toBeInTheDocument()
      expect(await screen.findByText('Write the report.')).toBeInTheDocument()

      const [backdrop] = screen.getAllByLabelText('Close artifact sheet')
      if (!backdrop) throw new Error('The open artifact sheet needs its outside-click backdrop')
      fireEvent.click(backdrop)

      await waitFor(() => {
        expect(screen.queryByRole('heading', { name: /job-request\.md/i })).not.toBeInTheDocument()
      })
    })
  })

  describe('queued mode', () => {
    it('shows queued status without a verbose notice', () => {
      render(
        <TaskBody
          task={baseTask({ mode: 'queued', executionKind: 'initial' })}
          sessionId="sess-1"
        />,
      )

      expect(
        within(screen.getByLabelText('Run summary')).getByText('Queued'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('Waiting for execution capacity. It will start automatically.'),
      ).not.toBeInTheDocument()
      expect(screen.getByLabelText('Process timeline')).toBeInTheDocument()
    })

    it('keeps a pending recovery concise without offering Resume again', () => {
      render(
        <TaskBody
          task={baseTask({ mode: 'queued', executionKind: 'recovery' })}
          sessionId="sess-1"
          onResumeTask={vi.fn()}
        />,
      )

      expect(
        within(screen.getByLabelText('Run summary')).getByText('Queued'),
      ).toBeInTheDocument()
      expect(screen.queryByText('Queued for recovery')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    })
  })

  describe('done mode', () => {
    it('keeps the live work view when a running task completes', () => {
      const events: RunEvent[] = [
        {
          id: 'delivery',
          type: 'artifact.delivery_selected',
          ts: Date.now(),
          runId: 'root-run',
          artifactRunId: 'child-run',
          artifactPath: 'result.md',
          artifactRole: 'final',
        },
      ]
      const { rerender } = render(
        <TaskBody
          task={baseTask({ mode: 'running', runId: 'root-run' })}
          sessionId="scheduled-session"
          events={events}
        />,
      )

      expect(screen.getAllByText('Running').length).toBeGreaterThan(0)

      rerender(
        <TaskBody
          task={baseTask({ mode: 'done', runId: 'root-run' })}
          sessionId="scheduled-session"
          events={events}
        />,
      )

      // No Delivery tab remains: the completed task keeps the process record.
      expect(screen.getAllByText('Complete').length).toBeGreaterThan(0)
      expect(screen.getByLabelText('Process timeline')).toBeInTheDocument()
      expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    })

    it('shows completed task totals and warnings without the stage rail', async () => {
      vi.mocked(getWorkflowStages).mockResolvedValue([
        {
          id: 'discuss',
          team: 'problem-thinking-board',
          resultArtifact: 'output/decomposition-plan.md',
        },
        {
          id: 'write',
          team: 'writing-team',
          resultArtifact: 'final-draft.md',
        },
      ])
      const events: RunEvent[] = [
        {
          id: 'step-discuss',
          type: 'workflow.step.completed',
          ts: Date.now(),
          runId: 'root-run',
          stepIndex: 0,
          stageName: 'discuss',
          childRunId: 'discussion-run',
          artifactOut: 'output/decomposition-plan.md',
        },
        {
          id: 'discussion-output',
          type: 'artifact.written',
          ts: Date.now(),
          runId: 'discussion-run',
          artifactPath: 'output/decomposition-plan.md',
          artifactType: 'result',
        },
        {
          id: 'step-write',
          type: 'workflow.step.completed',
          ts: Date.now(),
          runId: 'root-run',
          stepIndex: 1,
          stageName: 'write',
          childRunId: 'writing-run',
          artifactOut: 'final-draft.md',
        },
        {
          id: 'writing-output',
          type: 'artifact.written',
          ts: Date.now(),
          runId: 'writing-run',
          artifactPath: 'final-draft.md',
          artifactRole: 'final',
          artifactStatus: 'approved_with_warnings',
          artifactType: 'result',
        },
        {
          id: 'delivery',
          type: 'artifact.delivery_selected',
          ts: Date.now(),
          runId: 'root-run',
          artifactRunId: 'writing-run',
          artifactPath: 'final-draft.md',
          artifactRole: 'final',
        },
        {
          id: 'root-complete',
          type: 'run.completed',
          ts: Date.now(),
          runId: 'root-run',
        },
      ]

      render(
        <TaskBody
          task={baseTask({
            mode: 'done',
            runId: 'root-run',
            workflowId: 'discussion-to-writing',
          })}
          sessionId="sess-1"
          events={events}
        />
      )

      const summary = await screen.findByLabelText('Run summary')
      expect(
        await within(summary).findByText('Complete with warnings'),
      ).toBeInTheDocument()
      expect(await within(summary).findByText('2 / 2')).toBeInTheDocument()
      expect(screen.queryByLabelText('Workflow stages')).not.toBeInTheDocument()
      expect(screen.queryByText('discuss')).not.toBeInTheDocument()
      expect(screen.queryByText('write')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Process timeline')).toBeInTheDocument()
      expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    })
  })

  describe('error mode', () => {
    it('shows only error status and keeps the message out of the sidebar', () => {
      render(
        <TaskBody
          task={baseTask({ mode: 'error', errorMessage: 'Something went wrong' })}
          sessionId="sess-1"
        />
      )
      const summary = screen.getByLabelText('Run summary')
      expect(within(summary).getByText('Error')).toBeInTheDocument()
      expect(screen.queryByText('Task failed')).not.toBeInTheDocument()
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /start again/i }),
      ).not.toBeInTheDocument()
      expect(screen.getByLabelText('Process timeline')).toBeInTheDocument()
    })
  })

  describe('blocked mode', () => {
    it('shows blocked status while keeping the process timeline and diagnostics available', () => {
      render(
        <TaskBody
          task={baseTask({
            mode: 'blocked',
            runId: 'run-1',
            errorMessage: 'Approval required',
          })}
          sessionId="sess-1"
          events={[
            {
              id: 'blocked',
              type: 'run.blocked',
              ts: Date.now(),
              runId: 'run-1',
              errorMessage: 'Approval required',
            },
          ]}
        />,
      )

      expect(
        within(screen.getByLabelText('Run summary')).getByText('Blocked'),
      ).toBeInTheDocument()
      expect(screen.queryByText('Task blocked')).not.toBeInTheDocument()
      expect(screen.queryByText('Approval required')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Process timeline')).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Runtime diagnostics' }),
      ).not.toBeInTheDocument()
    })
  })

  describe('cancelled mode', () => {
    it('renders cancelled status without a notice', () => {
      render(
        <TaskBody
          task={baseTask({ mode: 'cancelled' })}
          sessionId="sess-1"
        />
      )
      expect(
        within(screen.getByLabelText('Run summary')).getByText('Cancelled'),
      ).toBeInTheDocument()
      expect(screen.queryByText('Task was cancelled')).not.toBeInTheDocument()
    })
  })

  describe('interrupted mode', () => {
    it('shows concise interrupted status without recovery details', () => {
      render(
        <TaskBody
          task={baseTask({
            mode: 'interrupted',
            executionAttemptId: 'attempt-previous',
            executionAttemptNumber: 2,
            recoveryCount: 1,
            recoveryReason: 'The worker exited unexpectedly.',
          })}
          sessionId="sess-1"
          onResumeTask={vi.fn()}
        />,
      )

      expect(
        within(screen.getByLabelText('Run summary')).getByText('Interrupted'),
      ).toBeInTheDocument()
      expect(screen.queryByText('Task interrupted')).not.toBeInTheDocument()
      expect(screen.queryByText('The worker exited unexpectedly.')).not.toBeInTheDocument()
      expect(screen.queryByText('Attempt 2')).not.toBeInTheDocument()
      expect(screen.queryByText('Recoveries 1')).not.toBeInTheDocument()
      expect(screen.queryByText('attempt-previous')).not.toBeInTheDocument()
    })

    it('offers Resume only for an interrupted task and invokes its handler', () => {
      const onResumeTask = vi.fn()
      const { rerender } = render(
        <TaskBody
          task={baseTask({ mode: 'interrupted' })}
          sessionId="sess-1"
          onResumeTask={onResumeTask}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
      expect(onResumeTask).toHaveBeenCalledWith('task-1')

      rerender(
        <TaskBody
          task={baseTask({ mode: 'blocked' })}
          sessionId="sess-1"
          onResumeTask={onResumeTask}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    })

    it('disables Resume when the task is not safely resumable', () => {
      render(
        <TaskBody
          task={baseTask({
            mode: 'interrupted',
            recoveryDisposition: 'not_resumable',
          })}
          sessionId="sess-1"
          onResumeTask={vi.fn()}
        />,
      )

      expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled()
      expect(
        screen.queryByText('This task cannot be resumed safely.'),
      ).not.toBeInTheDocument()
    })
  })
})
