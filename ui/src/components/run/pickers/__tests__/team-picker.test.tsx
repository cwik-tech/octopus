import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TeamPicker } from '../team-picker'

vi.mock('@/lib/clients/team-builder-client', () => ({
  listCachedTeamBuilderTeams: vi.fn(),
  subscribeToTeamBuilderTeams: vi.fn(() => () => {}),
}))

function teamSummary(id: string) {
  return {
    id,
    name: id,
    tags: [],
    agentCount: 1,
    health: { status: 'ok' as const, errors: [], warnings: [] },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

import {
  listCachedTeamBuilderTeams,
  subscribeToTeamBuilderTeams,
} from '@/lib/clients/team-builder-client'

describe('TeamPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listCachedTeamBuilderTeams).mockResolvedValue([
      {
        id: 'problem-thinking-board',
        name: 'problem-thinking-board',
        description: 'Specialist board for ambiguous problems',
        tags: [],
        agentCount: 12,
        entryStageType: 'discussion',
        health: {
          status: 'error',
          errors: ["Discussion participant 'writer' not found in agent roster"],
          warnings: [],
        },
      },
      {
        id: 'writing-team',
        name: 'writing-team',
        description: 'Drafting and editing',
        tags: [],
        agentCount: 3,
        entryStageType: 'chain',
        health: { status: 'ok', errors: [], warnings: [] },
      },
    ])
  })

  it('lists teams by name without exposing their entry stage type', async () => {
    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )

    expect(await screen.findByText('Problem Thinking Board')).toBeInTheDocument()
    expect(screen.getByText('Writing Team')).toBeInTheDocument()
    // The stage type is an authoring detail; the picker row shows the name
    // and its health only, so neither label nor badge text may carry it.
    expect(screen.queryByText('discussion')).not.toBeInTheDocument()
    expect(screen.queryByText('chain')).not.toBeInTheDocument()
    for (const row of screen.getAllByRole('radio')) {
      expect(row.getAttribute('aria-label')).not.toMatch(/stage:/)
    }
  })

  it('offers each team description on hover, the way the agent rows do', async () => {
    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )

    const user = userEvent.setup()
    const info = await screen.findByRole('button', {
      name: 'View description for Writing Team',
    })
    await user.hover(info)

    expect(await screen.findByText('Drafting and editing')).toBeInTheDocument()
  })

  it('shows a blocking Team issue beside the name and explains it on hover', async () => {
    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )

    const issue = await screen.findByRole('img', { name: 'Team issue' })
    await userEvent.hover(issue)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      "Discussion participant 'writer' not found in agent roster",
    )
  })

  it('lets keyboard users focus the Team issue and read the same diagnostic', async () => {
    const user = userEvent.setup()
    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )

    const row = await screen.findByRole('radio', {
      name: 'Problem Thinking Board — Team issue',
    })
    await user.tab()

    expect(row).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      "Discussion participant 'writer' not found in agent roster",
    )

    // Each row also offers its description on a button of its own, so the
    // next row is two stops away, not one.
    await user.tab()
    expect(
      screen.getByRole('button', {
        name: 'View description for Problem Thinking Board',
      }),
    ).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Writing Team' })).toHaveFocus()
  })

  it('names an unhealthy row as a Team issue and describes it with the diagnostic', async () => {
    // A row's own aria-label replaces everything nested inside it, so the
    // indicator's label never reaches a screen reader on its own. The status
    // has to be part of the row's name, and the reason its description.
    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )

    const row = await screen.findByRole('radio', {
      name: 'Problem Thinking Board — Team issue',
    })

    expect(row).toHaveAccessibleDescription(
      "Discussion participant 'writer' not found in agent roster",
    )
  })

  it('renders no description line, matching the agent picker', async () => {
    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )

    expect(await screen.findByText('Problem Thinking Board')).toBeInTheDocument()
    expect(
      screen.queryByText('Specialist board for ambiguous problems'),
    ).not.toBeInTheDocument()
  })

  it('is single-select: choosing a team replaces the previous one', async () => {
    const onSelectedTeamIdChange = vi.fn()
    render(
      <TeamPicker
        query=""
        selectedTeamId="problem-thinking-board"
        onSelectedTeamIdChange={onSelectedTeamIdChange}
      />,
    )

    const selected = await screen.findByRole('radio', {
      name: 'Problem Thinking Board — Team issue',
    })
    expect(selected).toBeChecked()
    expect(
      screen.getByRole('radio', { name: 'Writing Team' }),
    ).not.toBeChecked()

    await userEvent.click(screen.getByRole('radio', { name: 'Writing Team' }))
    expect(onSelectedTeamIdChange).toHaveBeenCalledExactlyOnceWith('writing-team')
  })

  it('deselects when the selected team is clicked again', async () => {
    const onSelectedTeamIdChange = vi.fn()
    render(
      <TeamPicker
        query=""
        selectedTeamId="writing-team"
        onSelectedTeamIdChange={onSelectedTeamIdChange}
      />,
    )

    await userEvent.click(
      await screen.findByRole('radio', { name: 'Writing Team' }),
    )
    expect(onSelectedTeamIdChange).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('filters on name and description', async () => {
    const { rerender } = render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )
    expect(await screen.findByText('Problem Thinking Board')).toBeInTheDocument()

    rerender(
      <TeamPicker
        query="ambiguous"
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )
    expect(screen.getByText('Problem Thinking Board')).toBeInTheDocument()
    expect(screen.queryByText('Writing Team')).not.toBeInTheDocument()

    rerender(
      <TeamPicker
        query="writing"
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )
    expect(screen.getByText('Writing Team')).toBeInTheDocument()
    expect(
      screen.queryByText('Problem Thinking Board'),
    ).not.toBeInTheDocument()
  })
})

describe('TeamPicker eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listCachedTeamBuilderTeams).mockResolvedValue([
      {
        id: 'problem-thinking-board',
        name: 'problem-thinking-board',
        tags: [],
        agentCount: 12,
        health: { status: 'ok', errors: [], warnings: [] },
        entryStageType: 'discussion',
        userInvocable: true,
      },
      {
        id: 'research-team',
        name: 'research-team',
        tags: [],
        agentCount: 6,
        health: { status: 'ok', errors: [], warnings: [] },
        entryStageType: 'chain',
        userInvocable: false,
      },
      {
        id: 'legacy-team',
        name: 'legacy-team',
        tags: [],
        agentCount: 2,
        health: { status: 'ok', errors: [], warnings: [] },
        entryStageType: 'chain',
      },
    ])
  })

  it('hides teams that declare themselves caller-only', async () => {
    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )

    expect(await screen.findByText('Problem Thinking Board')).toBeInTheDocument()
    // research-team declares user_facing: false — it needs a caller to
    // prepare its inputs, so it must not be launchable from chat.
    expect(screen.queryByText('Research Team')).not.toBeInTheDocument()
    // An undeclared team stays visible; absence is not a prohibition.
    expect(screen.getByText('Legacy Team')).toBeInTheDocument()
  })
})

describe('TeamPicker catalog refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refetches when the catalog is invalidated by a server-side build', async () => {
    let notify = () => {}
    vi.mocked(subscribeToTeamBuilderTeams).mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    vi.mocked(listCachedTeamBuilderTeams)
      .mockResolvedValueOnce([teamSummary('writing-team')])
      .mockResolvedValueOnce([
        teamSummary('writing-team'),
        teamSummary('knowledge-systems-crew'),
      ])

    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )
    expect(await screen.findByText('Writing Team')).toBeInTheDocument()

    await act(async () => {
      notify()
    })

    expect(
      await screen.findByText('Knowledge Systems Crew'),
    ).toBeInTheDocument()
  })

  it('does not let a slow initial response overwrite a newer refresh', async () => {
    let notify = () => {}
    vi.mocked(subscribeToTeamBuilderTeams).mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    // The mount request is still in flight when the post-build refresh
    // resolves. Applying it afterwards would restore the stale catalog.
    const slowInitial = deferred<ReturnType<typeof teamSummary>[]>()
    vi.mocked(listCachedTeamBuilderTeams)
      .mockReturnValueOnce(slowInitial.promise)
      .mockResolvedValueOnce([
        teamSummary('writing-team'),
        teamSummary('knowledge-systems-crew'),
      ])

    render(
      <TeamPicker
        query=""
        selectedTeamId={null}
        onSelectedTeamIdChange={vi.fn()}
      />,
    )

    await act(async () => {
      notify()
    })
    expect(
      await screen.findByText('Knowledge Systems Crew'),
    ).toBeInTheDocument()

    await act(async () => {
      slowInitial.resolve([teamSummary('writing-team')])
      await slowInitial.promise
    })

    await waitFor(() => {
      expect(screen.getByText('Knowledge Systems Crew')).toBeInTheDocument()
    })
  })
})
