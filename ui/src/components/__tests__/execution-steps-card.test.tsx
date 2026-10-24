import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ExecutionStepsCard, type ExecutionStepsRunNode } from '@/components/execution-steps-card'
import type { RunTeamFlow } from '@/lib/models/runtime-model'

function makeRunNode(overrides: Partial<ExecutionStepsRunNode> = {}): ExecutionStepsRunNode {
  return {
    activeAgentNames: [],
    currentLevelId: null,
    currentStageType: null,
    depth: 0,
    executionState: 'completed',
    id: 'test-node-id',
    parentRunId: null,
    runId: 'run-1',
    startedAt: null,
    status: 'completed',
    team: null,
    updatedAt: null,
    ...overrides,
  }
}

function makeFlow(overrides: Partial<RunTeamFlow> = {}): RunTeamFlow {
  return {
    entryLevelId: 'onboard',
    levels: [
      { actorNames: ['planner'], id: 'onboard', loopLabel: null, name: 'Onboard', stageType: 'setup' },
      { actorNames: ['researcher'], id: 'research', loopLabel: 'retry', name: 'Research', stageType: 'analysis' },
      { actorNames: ['writer'], id: 'write', loopLabel: null, name: 'Write', stageType: 'production' },
    ],
    runId: 'run-1',
    team: 'research-team',
    transitions: [
      { from: 'onboard', isLoopback: false, label: 'Start research', to: 'research' },
      { from: 'research', isLoopback: true, label: 'Re-research', to: 'research' },
      { from: 'research', isLoopback: false, label: 'Write report', to: 'write' },
      { from: 'write', isLoopback: false, label: 'Done', to: 'finish' },
    ],
    ...overrides,
  }
}

describe('ExecutionStepsCard', () => {
  it('renders with no run nodes selected when runNodes is empty', () => {
    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[]}
        selectedRunId={null}
      />,
    )
    expect(screen.getByText('Execution Steps')).toBeInTheDocument()
    expect(screen.queryByText('System')).not.toBeInTheDocument() // no nodes = no buttons
  })

  it('renders each run node as a clickable button', async () => {
    const user = userEvent.setup()
    const onRunSelect = vi.fn()
    const runNode = makeRunNode({
      runId: 'run-A',
      team: 'backend-team',
      executionState: 'running',
    })

    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={onRunSelect}
        runNodes={[runNode]}
        selectedRunId={null}
      />,
    )

    // humanized team name
    expect(screen.getByText('Backend Team')).toBeInTheDocument()
    // state badge
    expect(screen.getByText('running')).toBeInTheDocument()

    // button is clickable
    const button = screen.getByRole('button', { name: /Backend Team/i })
    await user.click(button)
    expect(onRunSelect).toHaveBeenCalledWith('run-A')
  })

  it('humanizes a hyphenated team name', () => {
    const runNode = makeRunNode({ team: 'frontend-ops' })
    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode]}
        selectedRunId={null}
      />,
    )
    expect(screen.getByText('Frontend Ops')).toBeInTheDocument()
  })

  it('shows "System" when team is null', () => {
    const runNode = makeRunNode({ team: null })
    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode]}
        selectedRunId={null}
      />,
    )
    expect(screen.getByText('System')).toBeInTheDocument()
  })

  it('shows "System" when team is undefined', () => {
    const runNode = makeRunNode({ team: undefined })
    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode]}
        selectedRunId={null}
      />,
    )
    expect(screen.getByText('System')).toBeInTheDocument()
  })

  it('highlights the selected run node', () => {
    const runNode = makeRunNode({ runId: 'run-1', team: 'team-a' })
    const { container } = render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode]}
        selectedRunId='run-1'
      />,
    )
    // selected styling is provided by the shared PanelItemButton primitive.
    const [selectedButton] = container.querySelectorAll('button')
    if (!selectedButton) throw new Error('The selected run node needs a button')
    expect(selectedButton.className).toContain('bg-primary/8')
  })

  it('does NOT highlight non-selected run nodes', () => {
    const runNode1 = makeRunNode({ runId: 'run-1', team: 'team-a' })
    const runNode2 = makeRunNode({ runId: 'run-2', team: 'team-b' })
    const { container } = render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode1, runNode2]}
        selectedRunId='run-1'
      />,
    )
    const [selectedButton, otherButton] = container.querySelectorAll('button')
    if (!selectedButton || !otherButton) throw new Error('Each run node needs a button')
    expect(selectedButton.className).toContain('bg-primary/8') // selected
    expect(otherButton.className).not.toContain('bg-primary/8') // not selected
  })

  it('renders the detail panel when a run node is selected', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'research-team',
      currentLevelId: 'research',
      currentStageType: 'analysis',
      executionState: 'running',
      activeAgentNames: ['researcher-bot'],
    })

    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    expect(screen.getAllByText('Research Team').length).toBeGreaterThan(0)
    expect(screen.getByText('Research · Analysis')).toBeInTheDocument()
    expect(screen.getByText('Current level')).toBeInTheDocument()
    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(screen.getByText('Current stage')).toBeInTheDocument()
    expect(screen.getByText('Analysis')).toBeInTheDocument()
    expect(screen.getByText('Researcher Bot')).toBeInTheDocument()
  })

  it('shows "none" when activeAgentNames is empty', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'test-team',
      executionState: 'waiting',
      activeAgentNames: [],
    })

    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    expect(screen.getByText('none')).toBeInTheDocument()
  })

  it('shows "No active level yet" when currentLevelId is null', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'test-team',
      executionState: 'waiting',
      currentLevelId: null,
      currentStageType: null,
    })

    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    expect(screen.getByText('No active level yet')).toBeInTheDocument()
  })

  it('shows "No team flow metadata found" when flow is null and not loading', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'test-team',
    })

    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    expect(screen.getByText('No team flow metadata found for this run.')).toBeInTheDocument()
  })

  it('shows "Loading team flow..." when flowLoading is true', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'test-team',
    })

    render(
      <ExecutionStepsCard
        flow={null}
        flowLoading
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    expect(screen.getByText('Loading team flow...')).toBeInTheDocument()
  })

  it('renders flow levels with Correct visual indicators', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'research-team',
      currentLevelId: 'research',
      executionState: 'running',
      activeAgentNames: ['researcher-bot', 'validator'],
    })
    const flow = makeFlow()

    render(
      <ExecutionStepsCard
        flow={flow}
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    expect(screen.getByText('Onboard')).toBeInTheDocument()
    expect(screen.getAllByText('Research').length).toBeGreaterThan(0)
    expect(screen.getByText('Write')).toBeInTheDocument()
    // Current badge
    expect(screen.getByText('Current')).toBeInTheDocument()
    // Actors
    expect(screen.getByText('planner')).toBeInTheDocument()
    expect(screen.getByText('researcher')).toBeInTheDocument()
    expect(screen.getByText('writer')).toBeInTheDocument()
  })

  it('shows "Current" badge only for the current level', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'research-team',
      currentLevelId: 'research',
      executionState: 'running',
      activeAgentNames: ['researcher-bot'],
    })
    const flow = makeFlow()

    render(
      <ExecutionStepsCard
        flow={flow}
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    // Only "Research" level should have "Current" badge
    // We have 3 levels but only Research is current
    const badges = screen.getAllByText('Current')
    expect(badges.length).toBe(1)
  })

  it('renders loopback information when present', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'research-team',
      currentLevelId: 'research',
      executionState: 'running',
      activeAgentNames: ['researcher-bot'],
    })
    const flow = makeFlow()

    render(
      <ExecutionStepsCard
        flow={flow}
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    // The loopback "Re-research" label
    expect(screen.getByText(/Re-research/)).toBeInTheDocument()
  })

  it('renders transition labels between levels', () => {
    const selectedNode = makeRunNode({
      runId: 'run-1',
      team: 'research-team',
      currentLevelId: 'research',
      executionState: 'running',
      activeAgentNames: ['researcher-bot'],
    })
    const flow = makeFlow()

    render(
      <ExecutionStepsCard
        flow={flow}
        onRunSelect={vi.fn()}
        runNodes={[selectedNode]}
        selectedRunId='run-1'
      />,
    )

    expect(screen.getByText('Start research')).toBeInTheDocument()
    expect(screen.getByText('Write report')).toBeInTheDocument()
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0)
  })

  it('hides the detail panel when selectedRunId does not match any node', () => {
    const runNode = makeRunNode({ runId: 'run-1', team: 'test-team' })

    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode]}
        selectedRunId='nonexistent'
      />,
    )

    expect(screen.queryByText('Current level')).not.toBeInTheDocument()
    expect(screen.queryByText('Execution Steps')).toBeInTheDocument()
  })

  it('renders arrow dividers between multiple run nodes', () => {
    const runNode1 = makeRunNode({ runId: 'run-1', team: 'team-a' })
    const runNode2 = makeRunNode({ runId: 'run-2', team: 'team-b' })
    const runNode3 = makeRunNode({ runId: 'run-3', team: 'team-c' })

    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode1, runNode2, runNode3]}
        selectedRunId={null}
      />,
    )

    // There should be 2 arrow dividers for 3 nodes
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(3)
  })

  it('renders ExecutionStateBadge with correct variant for running state', () => {
    const runNode = makeRunNode({ executionState: 'running' })
    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode]}
        selectedRunId='run-1'
      />,
    )

    const runningText = screen.getAllByText('running')[0]
    expect(runningText?.closest('span')).toHaveAttribute('data-variant', 'default')
  })

  it('renders ExecutionStateBadge with correct variant for waiting state', () => {
    const runNode = makeRunNode({ executionState: 'waiting' })
    render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode]}
        selectedRunId='run-1'
      />,
    )

    // "waiting" should render with "outline" variant
    const waitingText = screen.getAllByText('waiting')[0]
    expect(waitingText?.closest('span')).toHaveAttribute('data-variant', 'outline')
  })

  it('renders ExecutionStateBadge with outline variant for incomplete', () => {
    const runNode = makeRunNode({ executionState: 'incomplete' })
    const { container } = render(
      <ExecutionStepsCard
        flow={null}
        onRunSelect={vi.fn()}
        runNodes={[runNode]}
        selectedRunId='run-1'
      />,
    )

    const containerSpan = container.querySelector('.border-amber-300.text-amber-700')
    expect(containerSpan).toBeInTheDocument()
  })
})
