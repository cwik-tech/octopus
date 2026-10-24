import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentPicker from '../agent-picker'

vi.mock('@/lib/clients/agent-generator-client', () => ({
  listAgents: vi.fn(),
  checkAgentProviderHealth: vi.fn(),
}))

import {
  checkAgentProviderHealth,
  listAgents,
} from '@/lib/clients/agent-generator-client'

describe('AgentPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listAgents).mockResolvedValue([
      {
        name: 'domain-researcher',
        provider: 'openai',
        model: 'gpt-5.4',
        skills: ['domain-research'],
        usedInTeams: [],
      },
    ])
  })

  it('names an unhealthy agent row as an issue and explains it on hover', async () => {
    // The row's own aria-label replaces everything nested inside it, so the
    // badge's label never reaches a screen reader on its own. An agent row
    // carries its state exactly the way a Team row does.
    const diagnosticMessage =
      "Agent 'domain-researcher' (openai): The provider rejected the request. Check the model and request settings."
    vi.mocked(checkAgentProviderHealth).mockResolvedValue([
      {
        agentName: 'domain-researcher',
        provider: 'openai',
        model: 'gpt-5.4',
        status: 'error',
        message: diagnosticMessage,
        checkedAt: '2026-07-09T03:01:46.429Z',
        diagnostics: [
          {
            severity: 'error',
            kind: 'invalid_request',
            message: diagnosticMessage,
            subject: {
              agentName: 'domain-researcher',
              provider: 'openai',
              model: 'gpt-5.4',
            },
          },
        ],
      },
    ])

    render(
      <AgentPicker
        query=""
        selectedNames={[]}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    expect(await screen.findByText('Domain Researcher')).toBeInTheDocument()
    expect(
      document.querySelector('[data-provider-logo="openai"]'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Model: gpt-5.4')).toBeInTheDocument()

    const row = await screen.findByRole('button', {
      name: 'Domain Researcher — Agent issue',
    })
    expect(row).toHaveAccessibleDescription(diagnosticMessage)
    expect(await screen.findByRole('img', { name: 'Agent issue' })).toBeInTheDocument()

    await userEvent.hover(row)

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent(diagnosticMessage)
    })
  })

  it('marks a selected agent row without restoring the summary zone', async () => {
    vi.mocked(checkAgentProviderHealth).mockResolvedValue([])

    render(
      <AgentPicker
        query=""
        selectedNames={['domain-researcher']}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    const agent = await screen.findByText('Domain Researcher')
    expect(screen.queryByText(/1 selected:/)).not.toBeInTheDocument()
    expect(agent.closest('button')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('AgentPicker descriptions', () => {
  const description = 'Standing adversarial reviewer on the architecture board'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkAgentProviderHealth).mockResolvedValue([])
    vi.mocked(listAgents).mockResolvedValue([
      {
        name: 'architect-critic',
        description,
        provider: 'claude',
        model: 'opus',
        skills: ['review'],
        usedInTeams: [],
      },
    ])
  })

  it('keeps the description in the hover tooltip instead of the row', async () => {
    render(
      <AgentPicker
        query=""
        selectedNames={[]}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    expect(await screen.findByText('Architect Critic')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'View description for Architect Critic' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(description)).not.toBeInTheDocument()
    expect(screen.queryByText('review')).not.toBeInTheDocument()
  })

  it('still matches the description when searching', async () => {
    const { rerender } = render(
      <AgentPicker
        query=""
        selectedNames={[]}
        onSelectedNamesChange={vi.fn()}
      />,
    )
    expect(await screen.findByText('Architect Critic')).toBeInTheDocument()

    rerender(
      <AgentPicker
        query="adversarial"
        selectedNames={[]}
        onSelectedNamesChange={vi.fn()}
      />,
    )
    expect(screen.getByText('Architect Critic')).toBeInTheDocument()

    rerender(
      <AgentPicker
        query="no-such-agent"
        selectedNames={[]}
        onSelectedNamesChange={vi.fn()}
      />,
    )
    expect(screen.queryByText('Architect Critic')).not.toBeInTheDocument()
  })
})

describe('AgentPicker selected agents space', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkAgentProviderHealth).mockResolvedValue([])
    vi.mocked(listAgents).mockResolvedValue([
      {
        name: 'architect-critic',
        provider: 'claude',
        model: 'opus',
        skills: ['review'],
        usedInTeams: [],
      },
      {
        name: 'domain-researcher',
        provider: 'openai',
        model: 'gpt-5.4',
        skills: ['domain-research'],
        usedInTeams: [],
      },
    ])
  })

  it('stays out of the way until something is selected', async () => {
    render(
      <AgentPicker
        query=""
        selectedNames={[]}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    await screen.findByRole('list', { name: 'Available agents' })
    expect(
      screen.queryByRole('heading', { name: /Selected Agents/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('list', { name: 'Selected agents' }),
    ).not.toBeInTheDocument()
  })

  it('leaves the selected row unfilled, since the tick already says so', async () => {
    render(
      <AgentPicker
        query=""
        selectedNames={['domain-researcher']}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    const row = (await screen.findByText('Domain Researcher')).closest('button')
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(row).not.toHaveClass('bg-sidebar-primary/16')
  })

  it('moves a selected agent out of the available list into the space', async () => {
    render(
      <AgentPicker
        query=""
        selectedNames={['domain-researcher']}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    const selected = await screen.findByRole('list', { name: 'Selected agents' })
    const available = screen.getByRole('list', { name: 'Available agents' })

    expect(selected).toHaveTextContent('Domain Researcher')
    expect(available).not.toHaveTextContent('Domain Researcher')
    expect(available).toHaveTextContent('Architect Critic')
    expect(
      screen.getByRole('heading', { name: 'Selected Agents (1)' }),
    ).toBeVisible()
  })

  it('keeps the selection pinned while the available agents scroll', async () => {
    // Scrolling for an agent further down the roster used to carry the
    // selection off the top of the panel with it.
    const { container } = render(
      <AgentPicker
        query=""
        selectedNames={['domain-researcher']}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    const selected = await screen.findByRole('list', { name: 'Selected agents' })
    const available = screen.getByRole('list', { name: 'Available agents' })
    const scrollViewport = container.querySelector(
      '[data-slot="available-agents-scroll"]',
    )

    expect(scrollViewport).not.toBeNull()
    expect(scrollViewport).toContainElement(available)
    expect(scrollViewport).not.toContainElement(selected)
  })

  it('drops an agent from the selection when its remove action is used', async () => {
    const onSelectedNamesChange = vi.fn()
    render(
      <AgentPicker
        query=""
        selectedNames={['architect-critic', 'domain-researcher']}
        onSelectedNamesChange={onSelectedNamesChange}
      />,
    )

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Remove Domain Researcher from selection',
      }),
    )

    expect(onSelectedNamesChange).toHaveBeenCalledWith(['architect-critic'])
  })

  it('shows the remove action without waiting for a hover', async () => {
    render(
      <AgentPicker
        query=""
        selectedNames={['domain-researcher']}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    // Removing is the point of this space, so its control is not hover-gated
    // the way the sidebar's secondary row actions are.
    const remove = await screen.findByRole('button', {
      name: 'Remove Domain Researcher from selection',
    })
    expect(remove).not.toHaveClass('opacity-0')
  })

  it('returns a removed agent to the available list', async () => {
    const { rerender } = render(
      <AgentPicker
        query=""
        selectedNames={['domain-researcher']}
        onSelectedNamesChange={vi.fn()}
      />,
    )
    expect(
      await screen.findByRole('list', { name: 'Selected agents' }),
    ).toHaveTextContent('Domain Researcher')

    rerender(
      <AgentPicker
        query=""
        selectedNames={[]}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('list', { name: 'Available agents' }),
    ).toHaveTextContent('Domain Researcher')
    expect(
      screen.queryByRole('list', { name: 'Selected agents' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the selection out of the search results', async () => {
    render(
      <AgentPicker
        query="domain"
        selectedNames={['domain-researcher']}
        onSelectedNamesChange={vi.fn()}
      />,
    )

    // The query narrows the available list only: a selected agent stays in its
    // own space so it can always be removed, whatever is being searched for.
    expect(
      await screen.findByRole('list', { name: 'Selected agents' }),
    ).toHaveTextContent('Domain Researcher')
    expect(screen.getByText('No agents found.')).toBeVisible()
  })
})
