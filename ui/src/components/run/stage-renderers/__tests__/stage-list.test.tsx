import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { StageList } from '../stage-list'
import type { RunEvent } from '../index'
import type { WorkflowStageInfo } from '@/lib/models/session-model'

const declaredStages: WorkflowStageInfo[] = [
  {
    id: 'research',
    team: 'research-team',
    inputArtifact: 'incoming-brief.md',
    resultArtifact: 'research.md',
  },
  {
    id: 'write',
    team: 'writing-team',
    inputArtifact: 'research.md',
    resultArtifact: 'final-draft.md',
  },
]

function event(overrides: Partial<RunEvent> & { id: string }): RunEvent {
  return {
    ts: Date.now(),
    type: 'workflow.step.started',
    ...overrides,
  }
}

describe('StageList', () => {
  it('renders declared stages as pending before live events arrive', () => {
    render(<StageList declaredStages={declaredStages} events={[]} />)

    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(screen.getByText('Research Team')).toBeInTheDocument()
    expect(screen.getByText('Write')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Pending')).toHaveLength(2)
  })

  it('marks the current live step as active', () => {
    render(
      <StageList
        declaredStages={declaredStages}
        events={[event({ id: 'e1', stepIndex: 0, stageName: 'research' })]}
      />,
    )

    expect(screen.getByLabelText('Active')).toBeInTheDocument()
    expect(screen.getByLabelText('Active').firstElementChild).toHaveClass(
      'animate-pulse',
      'bg-orange-500',
    )
    expect(screen.getByText('1')).toHaveClass('animate-pulse', 'border-orange-500/60')
    expect(screen.getByText('Research')).toBeInTheDocument()
  })

  it('marks a completed live step as done', () => {
    render(
      <StageList
        declaredStages={declaredStages}
        events={[
          event({
            id: 'e1',
            type: 'workflow.step.completed',
            stepIndex: 0,
            childRunId: 'child-run-1',
          }),
        ]}
      />,
    )

    expect(screen.getByLabelText('Done')).toBeInTheDocument()
    expect(screen.getByLabelText('Done')).toHaveClass('text-emerald-500')
    expect(screen.getByText('1')).toHaveClass('border-emerald-500/60', 'text-emerald-500')
    expect(screen.getByText('Research')).toBeInTheDocument()
  })

  it('waits for the root run before finishing an active stage', () => {
    const { rerender } = render(
      <StageList
        declaredStages={declaredStages}
        rootRunId="workflow-run"
        events={[
          event({
            id: 'e1',
            runId: 'workflow-run',
            stepIndex: 1,
            stageName: 'write',
          }),
          event({
            id: 'e2',
            type: 'run.completed',
            runId: 'writing-child-run',
            stepIndex: 1,
          }),
        ]}
      />,
    )

    expect(screen.getByLabelText('Active')).toBeInTheDocument()

    rerender(
      <StageList
        declaredStages={declaredStages}
        rootRunId="workflow-run"
        events={[
          event({
            id: 'e1',
            runId: 'workflow-run',
            stepIndex: 1,
            stageName: 'write',
          }),
          event({
            id: 'e2',
            type: 'run.completed',
            runId: 'writing-child-run',
            stepIndex: 1,
          }),
          event({
            id: 'e3',
            type: 'run.completed',
            runId: 'workflow-run',
          }),
        ]}
      />,
    )

    expect(screen.getAllByLabelText('Done')).toHaveLength(2)
    expect(screen.getByText('Write')).toBeInTheDocument()
  })

  it('keeps artifact badges disabled until a child run id is known', () => {
    const onOpenArtifact = vi.fn()
    const { rerender } = render(
      <StageList
        declaredStages={declaredStages}
        events={[]}
        onOpenArtifact={onOpenArtifact}
      />,
    )

    expect(screen.getByRole('button', { name: /out\s*research\.md/i })).toBeDisabled()

    rerender(
      <StageList
        declaredStages={declaredStages}
        events={[
          event({
            id: 'e1',
            type: 'workflow.step.completed',
            stepIndex: 0,
            artifactOut: 'research.md',
            childRunId: 'child-run-1',
          }),
        ]}
        onOpenArtifact={onOpenArtifact}
      />,
    )

    const artifactButton = screen.getByRole('button', { name: /out\s*research\.md/i })
    expect(artifactButton).toBeEnabled()

    fireEvent.click(artifactButton)

    expect(onOpenArtifact).toHaveBeenCalledWith({
      artifactPath: 'research.md',
      runId: 'child-run-1',
    })
  })

  it('falls back to done when the task record says the run is complete but the SSE stream missed run.completed', () => {
    render(
      <StageList
        declaredStages={declaredStages}
        rootRunId="workflow-run"
        taskCompleted
        events={[
          event({
            id: 'e1',
            runId: 'workflow-run',
            stepIndex: 0,
            stageName: 'research',
          }),
        ]}
      />,
    )

    expect(screen.getAllByLabelText('Done')).toHaveLength(2)
    expect(screen.getByText('1')).toHaveClass('border-emerald-500/60', 'text-emerald-500')
  })

  it('falls back to error when the task record says the run failed but the SSE stream missed run.failed', () => {
    render(
      <StageList
        declaredStages={declaredStages}
        rootRunId="workflow-run"
        taskFailed
        events={[
          event({
            id: 'e1',
            runId: 'workflow-run',
            stepIndex: 0,
            stageName: 'research',
          }),
        ]}
      />,
    )

    expect(screen.getAllByLabelText('Failed').length).toBeGreaterThan(0)
  })
})
