import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PipelineRenderer } from '../pipeline'
import type { RunEvent } from '../index'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<RunEvent> & { id: string }): RunEvent {
  return {
    type: 'step',
    ts: Date.now(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('PipelineRenderer', () => {
  it('shows "No events yet" placeholder when events array is empty', () => {
    render(<PipelineRenderer events={[]} stageType="pipeline" />)
    expect(screen.getByText('No events yet')).toBeInTheDocument()
  })

  it('shows "No pipeline steps yet" when events exist but none have stepIndex', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', type: 'agent.message', content: 'Something' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    expect(screen.getByText('No pipeline steps yet')).toBeInTheDocument()
  })

  it('renders a step row for a single step', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Fetch Data' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    expect(screen.getByText('Fetch Data')).toBeInTheDocument()
    // Step number badge (1-indexed)
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('renders step number badge as 1-indexed', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Step Zero' }),
      makeEvent({ id: 'e2', stepIndex: 1, stageName: 'Step One' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('shows artifact In and Out labels', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Process', artifactIn: 'input.md', artifactOut: 'output.md' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    expect(screen.getByText('input.md')).toBeInTheDocument()
    expect(screen.getByText('output.md')).toBeInTheDocument()
    expect(screen.getByText('In')).toBeInTheDocument()
    expect(screen.getByText('Out')).toBeInTheDocument()
  })

  it('opens artifact preview when an artifact badge is clicked', () => {
    const onOpenArtifact = vi.fn()
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Process', artifactOut: 'output.md' }),
    ]
    render(
      <PipelineRenderer
        events={events}
        onOpenArtifact={onOpenArtifact}
        runId="run-1"
        stageType="pipeline"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /out\s*output\.md/i }))
    expect(onOpenArtifact).toHaveBeenCalledWith({
      artifactPath: 'output.md',
      runId: 'run-1',
    })
  })

  it('shows only artifactIn when no artifactOut', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Read', artifactIn: 'source.md' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    expect(screen.getByText('source.md')).toBeInTheDocument()
    expect(screen.queryByText('Out')).not.toBeInTheDocument()
  })

  it('shows running spinner for the current (last) step', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Running Step' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    // Loader2 icon has aria-label="Running"
    expect(screen.getByLabelText('Running')).toBeInTheDocument()
  })

  it('shows done checkmark for completed steps (lower index than current)', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Done Step' }),
      makeEvent({ id: 'e2', stepIndex: 1, stageName: 'Current Step' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    // Step 0 is done (lower index than step 1)
    expect(screen.getByLabelText('Done')).toBeInTheDocument()
    // Step 1 is running
    expect(screen.getByLabelText('Running')).toBeInTheDocument()
  })

  it('marks step as done when artifact.written event is in its group', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Only Step', type: 'artifact.written' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    expect(screen.getByLabelText('Done')).toBeInTheDocument()
  })

  it('renders multiple steps in ascending order', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 2, stageName: 'Third' }),
      makeEvent({ id: 'e2', stepIndex: 0, stageName: 'First' }),
      makeEvent({ id: 'e3', stepIndex: 1, stageName: 'Second' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    // All step names visible
    expect(screen.getByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.getByText('Third')).toBeInTheDocument()
  })

  it('falls back to "Step N" label when stageName is absent', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0 }), // no stageName
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    expect(screen.getByText('Step 1')).toBeInTheDocument()
  })

  it('groups multiple events with same stepIndex into one step row', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', stepIndex: 0, stageName: 'Step Alpha', artifactIn: 'a.md' }),
      makeEvent({ id: 'e2', stepIndex: 0, artifactOut: 'b.md' }),
    ]
    render(<PipelineRenderer events={events} stageType="pipeline" />)
    // One step row, not two
    expect(screen.getAllByText('1')).toHaveLength(1)
    expect(screen.getByText('Step Alpha')).toBeInTheDocument()
    expect(screen.getByText('a.md')).toBeInTheDocument()
    expect(screen.getByText('b.md')).toBeInTheDocument()
  })
})
