import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DiscussionRenderer } from '../discussion'
import type { RunEvent } from '../index'
import { formatTimestamp } from '@/lib/models/runtime-model'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<RunEvent> & { id: string }): RunEvent {
  return {
    type: 'agent.message',
    ts: Date.now(),
    ...overrides,
  }
}

// ── fetch mock ────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.clearAllMocks()
})

function mockTeamFetch(agents: Array<{ id: string; name: string; color?: string }>) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ agents }),
  } as unknown as Response)
}

function mockTeamFetchError() {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DiscussionRenderer', () => {
  beforeEach(() => {
    mockTeamFetchError() // default: no server colors
  })

  it('shows "No events yet" placeholder when events array is empty', () => {
    render(<DiscussionRenderer events={[]} stageType="discussion" />)
    expect(screen.getByText('No events yet')).toBeInTheDocument()
  })

  it('renders agent name for events with agentName', async () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', content: 'Hello!' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Hello!')).toBeInTheDocument()
  })

  it('groups consecutive events from same agent into one card', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', content: 'First message' }),
      makeEvent({ id: 'e2', agentId: 'agent-a', agentName: 'Alice', content: 'Second message' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    // Agent name appears once (grouped), not twice
    expect(screen.getAllByText('Alice')).toHaveLength(1)
    expect(screen.getByText('First message')).toBeInTheDocument()
    expect(screen.getByText('Second message')).toBeInTheDocument()
  })

  it('creates separate groups for different agents', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', content: 'From Alice' }),
      makeEvent({ id: 'e2', agentId: 'agent-b', agentName: 'Bob', content: 'From Bob' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('From Alice')).toBeInTheDocument()
    expect(screen.getByText('From Bob')).toBeInTheDocument()
  })

  it('creates separate groups when same agent appears after another agent', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', content: 'Alice 1' }),
      makeEvent({ id: 'e2', agentId: 'agent-b', agentName: 'Bob', content: 'Bob 1' }),
      makeEvent({ id: 'e3', agentId: 'agent-a', agentName: 'Alice', content: 'Alice 2' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    // Alice appears twice (in two separate groups)
    expect(screen.getAllByText('Alice')).toHaveLength(2)
  })

  it('renders initials avatar for each agent group', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice Smith', content: 'Hi' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    // Avatar shows first two initials
    expect(screen.getByText('AS')).toBeInTheDocument()
  })

  it('shows stage separator when stageName changes between groups', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', content: 'Msg1', stageName: 'Stage A' }),
      makeEvent({ id: 'e2', agentId: 'agent-b', agentName: 'Bob', content: 'Msg2', stageName: 'Stage B' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    expect(screen.getByText('Stage B')).toBeInTheDocument()
  })

  it('does not show separator when stageName stays the same', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', content: 'A1', stageName: 'Same Stage' }),
      makeEvent({ id: 'e2', agentId: 'agent-b', agentName: 'Bob', content: 'B1', stageName: 'Same Stage' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    // Stage name should appear only once (no separator duplicate)
    expect(screen.queryAllByText('Same Stage')).toHaveLength(0)
  })

  it('renders artifact.written events as artifact badge', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', type: 'artifact.written', artifactPath: 'result.md' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    expect(screen.getByText('Artifact:')).toBeInTheDocument()
    expect(screen.getByText('result.md')).toBeInTheDocument()
  })

  it('opens artifact preview when an artifact badge is clicked', () => {
    const onOpenArtifact = vi.fn()
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', type: 'artifact.written', artifactPath: 'result.md' }),
    ]
    render(
      <DiscussionRenderer
        events={events}
        onOpenArtifact={onOpenArtifact}
        runId="run-1"
        stageType="discussion"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /artifact:\s*result\.md/i }))
    expect(onOpenArtifact).toHaveBeenCalledWith({
      artifactPath: 'result.md',
      runId: 'run-1',
    })
  })

  it('uses server colors from GET /api/team when available', async () => {
    mockTeamFetch([{ id: 'agent-a', name: 'Alice', color: '#ff0000' }])
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', content: 'Hi' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/team'))
    })
    // Avatar should have the server color applied
    const avatar = screen.getByText('AL')
    expect(avatar.style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('falls back to static palette when GET /api/team fails', async () => {
    mockTeamFetchError()
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', content: 'Hi' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    // Should render without crashing; avatar gets a fallback color
    await waitFor(() => {
      expect(screen.getByText('AL')).toBeInTheDocument()
    })
  })

  it('skips events without displayable content', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentId: 'agent-a', agentName: 'Alice', type: 'run.session_started' }),
    ]
    const { container } = render(<DiscussionRenderer events={events} stageType="discussion" />)
    // No groups formed from non-displayable event → shows placeholder
    expect(container.textContent).toContain('No events yet')
  })

  it('falls back agentId to agentName when agentId is missing', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', agentName: 'Bob', content: 'Hello' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    expect(screen.getByText('Bob')).toBeInTheDocument()
  })

  it('shows "System" label for events with no agent info', () => {
    const events: RunEvent[] = [
      makeEvent({ id: 'e1', type: 'artifact.written', artifactPath: 'file.md' }),
    ]
    render(<DiscussionRenderer events={events} stageType="discussion" />)
    expect(screen.getByText('System')).toBeInTheDocument()
  })

  it('shows a right-aligned timestamp for messages, system artifacts, and tools', () => {
    const timestamps: [number, number, number] = [
      Date.UTC(2026, 6, 10, 14, 1, 2),
      Date.UTC(2026, 6, 10, 14, 1, 3),
      Date.UTC(2026, 6, 10, 14, 1, 4),
    ]
    const events: RunEvent[] = [
      makeEvent({
        id: 'message',
        agentId: 'agent-a',
        agentName: 'Alice',
        content: 'Reviewing the brief',
        ts: timestamps[0],
      }),
      makeEvent({
        id: 'artifact',
        type: 'artifact.written',
        artifactPath: 'brief.md',
        ts: timestamps[1],
      }),
      makeEvent({
        id: 'tool',
        type: 'tool.execution_logged',
        content: 'Executed',
        ts: timestamps[2],
      }),
    ]

    render(<DiscussionRenderer events={events} stageType="discussion" />)

    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('Artifact:')).toBeInTheDocument()
    expect(screen.getByText('Tool:')).toBeInTheDocument()

    const timestampNodes = screen.getAllByLabelText(/^Event timestamp:/)
    expect(timestampNodes).toHaveLength(3)
    expect(timestampNodes.map((node) => node.getAttribute('dateTime'))).toEqual(
      timestamps.map((timestamp) => new Date(timestamp).toISOString()),
    )
    expect(timestampNodes.map((node) => node.textContent)).toEqual(
      timestamps.map((timestamp) => formatTimestamp(new Date(timestamp).toISOString())),
    )
  })
})

describe('DiscussionRenderer — default-use disclosure', () => {
  beforeEach(() => {
    mockTeamFetchError()
  })

  it('discloses default use for any Team run shape, not only a discussion', async () => {
    // This renderer draws every Team run's transcript, whatever the stage
    // type. A notice that only appeared for discussion stages would leave a
    // linear or broadcast Team silently running on the application default.
    const events: RunEvent[] = [
      makeEvent({
        id: 'e1',
        type: 'agent.start',
        agentName: 'reviewer',
        provider: 'openai',
        model: 'gpt-5',
        modelSelection: {
          provider: 'openai',
          model: 'gpt-5',
          source: 'app-default',
          reason: 'agent-default',
          caller: 'agent',
        },
      }),
      makeEvent({
        id: 'e2',
        agentName: 'reviewer',
        content: 'A considered answer.',
      }),
    ]

    render(<DiscussionRenderer events={events} stageType="chain" />)

    expect(await screen.findByText('app default')).toBeInTheDocument()
  })

  it('labels each attempt with its own selection when one Agent speaks twice', async () => {
    // An explicit attempt followed by a user-approved retry on the app
    // default. Taking the first selection per Agent, and merging adjacent
    // same-Agent messages regardless of dispatch, gives the retry the explicit
    // label and hides the notice the retry is the whole reason for.
    const events: RunEvent[] = [
      makeEvent({
        id: 'e1',
        type: 'agent.start',
        agentName: 'reviewer',
        dispatchId: 'dispatch-1',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        modelSelection: {
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          source: 'agent',
          reason: 'explicit-agent-choice',
          caller: 'agent',
        },
      }),
      makeEvent({
        id: 'e2',
        agentName: 'reviewer',
        dispatchId: 'dispatch-1',
        content: 'The first attempt spoke.',
      }),
      makeEvent({
        id: 'e3',
        type: 'agent.start',
        agentName: 'reviewer',
        dispatchId: 'dispatch-2',
        provider: 'openai',
        model: 'gpt-5',
        modelSelection: {
          provider: 'openai',
          model: 'gpt-5',
          source: 'app-default',
          reason: 'user-approved-retry',
          caller: 'agent',
          requestedProvider: 'anthropic',
          requestedModel: 'claude-opus-4-6',
        },
      }),
      makeEvent({
        id: 'e4',
        agentName: 'reviewer',
        dispatchId: 'dispatch-2',
        content: 'The approved retry spoke.',
      }),
    ]

    render(<DiscussionRenderer events={events} stageType="chain" />)

    await screen.findByText('The approved retry spoke.')
    await screen.findByText('The first attempt spoke.')
    // Exactly one notice, on the retry — not none, and not one on each.
    expect(screen.getAllByText('app default')).toHaveLength(1)
  })

  it('does not put a later attempt\'s explicit label on an earlier default one', async () => {
    const events: RunEvent[] = [
      makeEvent({
        id: 'e1',
        type: 'agent.start',
        agentName: 'reviewer',
        dispatchId: 'dispatch-1',
        provider: 'openai',
        model: 'gpt-5',
        modelSelection: {
          provider: 'openai',
          model: 'gpt-5',
          source: 'app-default',
          reason: 'agent-default',
          caller: 'agent',
        },
      }),
      makeEvent({
        id: 'e2',
        agentName: 'reviewer',
        dispatchId: 'dispatch-1',
        content: 'The default attempt spoke.',
      }),
      makeEvent({
        id: 'e3',
        type: 'agent.start',
        agentName: 'reviewer',
        dispatchId: 'dispatch-2',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        modelSelection: {
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          source: 'agent',
          reason: 'explicit-agent-choice',
          caller: 'agent',
        },
      }),
      makeEvent({
        id: 'e4',
        agentName: 'reviewer',
        dispatchId: 'dispatch-2',
        content: 'The explicit attempt spoke.',
      }),
    ]

    render(<DiscussionRenderer events={events} stageType="chain" />)

    await screen.findByText('The explicit attempt spoke.')
    expect(screen.getAllByText('app default')).toHaveLength(1)
  })

  it('says nothing for an agent that ran on its own choice', async () => {
    const events: RunEvent[] = [
      makeEvent({
        id: 'e1',
        type: 'agent.start',
        agentName: 'reviewer',
        provider: 'openai',
        model: 'gpt-5',
        modelSelection: {
          provider: 'openai',
          model: 'gpt-5',
          source: 'agent',
          reason: 'explicit-agent-choice',
          caller: 'agent',
        },
      }),
      makeEvent({ id: 'e2', agentName: 'reviewer', content: 'An answer.' }),
    ]

    render(<DiscussionRenderer events={events} stageType="chain" />)

    await screen.findByText('An answer.')
    expect(screen.queryByText('app default')).not.toBeInTheDocument()
  })
})

describe('DiscussionRenderer — a helper is not a participant', () => {
  beforeEach(() => {
    mockTeamFetch([])
  })

  it('does not label a Team member with the model that named a delegated job', async () => {
    // Naming a delegated job is the routing stage's own work, disclosed as its
    // own notice in the conversation. It carries a selection and a runtime id
    // like any other event, so a renderer that took every selection it saw
    // would label whichever participant shared that id — saying a member ran
    // on a model it never used.
    const events: RunEvent[] = [
      makeEvent({
        id: 'e1',
        type: 'delegation.job_title_selected',
        // The runtime that made the call, which `toRunEvent` also falls back to
        // for `agentId`.
        agentId: 'child-run',
        delegationId: 'child-run:research-team:abc',
        modelSelection: {
          provider: 'openai',
          model: 'job-title-model',
          source: 'app-default',
          reason: 'agent-default',
          caller: 'title',
        },
      }),
      makeEvent({
        id: 'e2',
        agentId: 'child-run',
        agentName: 'reviewer',
        content: 'A considered answer.',
      }),
    ]

    render(<DiscussionRenderer events={events} stageType="routing" />)

    await screen.findByText('A considered answer.')
    // The member said something; nothing says it ran on the naming's model.
    expect(screen.queryByText('app default')).not.toBeInTheDocument()
    expect(screen.queryByText(/job-title-model/)).not.toBeInTheDocument()
  })

  it('does not label a Team member with a background helper’s model', async () => {
    // Compressing a discussion and writing its minutes are the application's
    // own work, run on the application default and disclosed as that. They are
    // recorded against the runtime, which is the identity a member's own events
    // also fall back to — so the same collision that job titles have, twice
    // more. Every one of these has to stay out of a participant's label.
    const events: RunEvent[] = [
      makeEvent({
        id: 'e1',
        type: 'runtime.helper_model_selected',
        agentId: 'child-run',
        modelSelection: {
          provider: 'openai',
          model: 'compression-model',
          source: 'app-default',
          reason: 'agent-default',
          caller: 'compression',
        },
      }),
      makeEvent({
        id: 'e2',
        type: 'runtime.helper_model_selected',
        agentId: 'child-run',
        modelSelection: {
          provider: 'openai',
          model: 'minutes-model',
          source: 'app-default',
          reason: 'agent-default',
          caller: 'minutes',
        },
      }),
      makeEvent({
        id: 'e3',
        agentId: 'child-run',
        agentName: 'reviewer',
        content: 'A considered answer.',
      }),
    ]

    render(<DiscussionRenderer events={events} stageType="discussion" />)

    await screen.findByText('A considered answer.')
    expect(screen.queryByText('app default')).not.toBeInTheDocument()
    expect(screen.queryByText(/compression-model/)).not.toBeInTheDocument()
    expect(screen.queryByText(/minutes-model/)).not.toBeInTheDocument()
  })
})
