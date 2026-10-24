import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CreatePanel from '@/components/create/create-panel'
import { fetchChatDefaults } from '@/lib/clients/chat-defaults-client'
import { getWorkflowYaml } from '@/lib/clients/session-client'
import {
  cancelGeneratorJob,
  postGeneratorTurn,
  validateWorkflowYaml,
} from '@/lib/clients/workflow-generator-client'

vi.mock('@/components/create/workflow-diagram', () => ({
  default: () => <div data-testid="workflow-diagram" />,
}))

vi.mock('@/components/create/yaml-preview', () => ({
  default: ({
    dirty,
    onYamlChange,
    yaml,
  }: {
    dirty: boolean
    onYamlChange: (yaml: string) => void
    yaml: string | null
  }) => (
    <div>
      <div data-testid="yaml-preview">{yaml ?? ''}</div>
      <button type="button" onClick={() => onYamlChange('dirty: yaml')}>
        Edit YAML
      </button>
      {dirty ? <span>Unsaved YAML</span> : null}
    </div>
  ),
}))

vi.mock('@/lib/clients/session-client', () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  getWorkflowYaml: vi.fn(),
  updateWorkflowYaml: vi.fn(),
}))

vi.mock('@/lib/clients/chat-defaults-client', () => ({
  fetchChatDefaults: vi.fn(),
}))

vi.mock('@/contexts/provider-catalog-context', () => ({
  useProviderCatalog: () => ({
    groups: [
      {
        provider: 'codex',
        name: 'Codex CLI',
        icon: 'codex',
        source: 'cli',
        models: [
          {
            id: 'default',
            name: 'Default model',
            enabled: true,
            capabilities: ['chat'],
          },
        ],
      },
    ],
    defaultModel: { provider: 'codex', model: 'default' },
    loading: false,
    error: null,
    refresh: async () => undefined,
  }),
}))

vi.mock('@/lib/clients/workflow-generator-client', () => ({
  cancelGeneratorJob: vi.fn(),
  fetchGeneratorRegistry: vi.fn(() => Promise.resolve({ teams: [] })),
  postGeneratorTurn: vi.fn(),
  revealGeneratorArtifact: vi.fn(),
  saveGeneratorDraft: vi.fn(),
  validateWorkflowYaml: vi.fn(),
}))

vi.mock('@/components/create/agent-architect-panel', () => ({
  default: () => <div>Agent inspector</div>,
}))

vi.mock('@/components/create/team-architect-panel', () => ({
  default: () => <div>Team inspector</div>,
}))

vi.mock('@/lib/clients/resource-architect-client', () => ({
  listResourceArchitectMetrics: vi.fn(() => Promise.resolve([])),
  listResourceBuildJobs: vi.fn(() => Promise.resolve([])),
  postResourceArchitectTurn: vi.fn(),
  readResourceBuildJob: vi.fn(),
  retryResourceBuildJob: vi.fn(),
  startResourceBuildJob: vi.fn(),
}))

vi.mock('@/lib/clients/agent-generator-client', () => ({
  cancelAgentJob: vi.fn(),
}))

async function editWorkflowYaml(): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name: 'YAML' }))
  await userEvent.click(screen.getByRole('button', { name: 'Edit YAML' }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('CreatePanel cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'job-race' as `${string}-${string}-${string}-${string}-${string}`,
    )
    vi.mocked(validateWorkflowYaml).mockResolvedValue({
      valid: true,
      draft: {
        id: 'test-workflow',
        description: 'Test workflow',
        input: { artifact: 'brief.md' },
        steps: [],
        output: { from_step: 'draft', artifact: 'result.md' },
        on_blocked: 'stop',
        on_failed: 'stop',
      },
      errors: [],
      mermaid: null,
      warnings: [],
    })
    vi.mocked(getWorkflowYaml).mockResolvedValue('workflow:\n  id: loaded')
    vi.mocked(fetchChatDefaults).mockResolvedValue({
      workflow: { provider: 'codex', model: 'default' },
      team: { provider: 'codex', model: 'default' },
      agent: { provider: 'codex', model: 'default' },
      run: { provider: 'codex', model: 'default' },
    })
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the Workflow Architect without a feature-specific card wrapper', () => {
    render(<CreatePanel />)

    const chat = screen.getByRole('region', { name: 'Workflow Architect chat' })
    expect(chat).toHaveAttribute('data-slot', 'chat-shell')
    expect(chat.closest('[data-slot="panel-card"]')).toBeNull()
  })

  it('stops the UI and ignores a late response even when backend cancel returns Not found', async () => {
    const turn = deferred<Awaited<ReturnType<typeof postGeneratorTurn>>>()
    vi.mocked(postGeneratorTurn).mockReturnValue(turn.promise)
    vi.mocked(cancelGeneratorJob).mockRejectedValue(new Error('Not found'))

    render(<CreatePanel />)

    const promptInput = screen.getByPlaceholderText(
      'Describe the workflow you want to build...',
    )
    fireEvent.change(promptInput, {
      target: { value: 'Create a three-stage workflow' },
    })
    expect(promptInput).toHaveValue('Create a three-stage workflow')
    fireEvent.submit(promptInput.closest('form')!)
    await waitFor(() => {
      expect(postGeneratorTurn).toHaveBeenCalled()
    })

    const stopButton = await screen.findByRole('button', {
      name: 'Stop generation',
    })
    expect(stopButton).not.toBeDisabled()

    await userEvent.click(stopButton)

    await waitFor(() => {
      expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Generation stopped.')).toBeInTheDocument()
    expect(cancelGeneratorJob).toHaveBeenCalledWith('job-race')

    turn.resolve({
      jobId: 'job-race',
      message: 'Late response that should not render',
      draft: null,
      warnings: [],
      yaml: 'late: yaml',
      mermaid: 'flowchart LR',
      meta: { model: 'test', fallback: false },
    })

    await waitFor(() => {
      expect(
        screen.queryByText('Late response that should not render'),
      ).not.toBeInTheDocument()
    })
    expect(screen.queryByTestId('yaml-preview')).not.toBeInTheDocument()
  })

  it('keeps workflow details closed until the shell opens the right sidebar', () => {
    render(<CreatePanel />)

    expect(screen.queryByText('Visual Builder')).not.toBeInTheDocument()
    expect(screen.queryByTestId('yaml-preview')).not.toBeInTheDocument()
  })

  it('does not duplicate the shell new-workflow action inside Create', () => {
    render(<CreatePanel />)

    expect(
      screen.queryByRole('button', { name: 'New draft' }),
    ).not.toBeInTheDocument()
  })

  it('guards an external workflow selection and keeps the current draft on cancel', async () => {
    const onWorkflowSelectionBlocked = vi.fn()
    vi.mocked(getWorkflowYaml)
      .mockResolvedValueOnce('workflow:\n  id: workflow-a')
      .mockResolvedValueOnce('workflow:\n  id: workflow-b')
    const { rerender } = render(
      <CreatePanel
        detailsOpen
        onWorkflowSelectionBlocked={onWorkflowSelectionBlocked}
        workflowSelectionRequest={{ id: 'workflow-a', requestId: 'request-a' }}
      />,
    )

    await userEvent.click(screen.getByRole('tab', { name: 'YAML' }))
    await waitFor(() => {
      expect(screen.getByTestId('yaml-preview')).toHaveTextContent('workflow-a')
    })
    await editWorkflowYaml()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    rerender(
      <CreatePanel
        detailsOpen
        onWorkflowSelectionBlocked={onWorkflowSelectionBlocked}
        workflowSelectionRequest={{ id: 'workflow-b', requestId: 'request-b' }}
      />,
    )

    await waitFor(() => {
      expect(onWorkflowSelectionBlocked).toHaveBeenCalledWith('workflow-a')
    })
    expect(getWorkflowYaml).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('yaml-preview')).toHaveTextContent('dirty: yaml')

    confirm.mockReturnValue(true)
    rerender(
      <CreatePanel
        detailsOpen
        onWorkflowSelectionBlocked={onWorkflowSelectionBlocked}
        workflowSelectionRequest={{ id: 'workflow-b', requestId: 'request-b-2' }}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('yaml-preview')).toHaveTextContent('workflow-b')
    })
  })

  it('registers a beforeunload guard only while YAML is dirty', async () => {
    render(<CreatePanel detailsOpen />)

    const cleanEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanEvent)
    expect(cleanEvent.defaultPrevented).toBe(false)

    await editWorkflowYaml()
    const dirtyEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyEvent)

    expect(dirtyEvent.defaultPrevented).toBe(true)
  })
})

describe('CreatePanel create tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(validateWorkflowYaml).mockResolvedValue({
      valid: true,
      draft: {
        id: 'test-workflow',
        description: 'Test workflow',
        input: { artifact: 'brief.md' },
        steps: [],
        output: { from_step: 'draft', artifact: 'result.md' },
        on_blocked: 'stop',
        on_failed: 'stop',
      },
      errors: [],
      mermaid: null,
      warnings: [],
    })
    vi.mocked(fetchChatDefaults).mockResolvedValue({
      workflow: { provider: 'codex', model: 'default' },
      team: { provider: 'codex', model: 'default' },
      agent: { provider: 'codex', model: 'default' },
      run: { provider: 'codex', model: 'default' },
    })
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('follows the create tab: workflow builder on Workflows, team inspector on Teams, agent inspector on Agents', async () => {
    const { rerender } = render(<CreatePanel createTab="workflows" detailsOpen />)

    expect(await screen.findByText('Visual Builder')).toBeInTheDocument()
    expect(screen.queryByText('Team inspector')).not.toBeInTheDocument()

    rerender(<CreatePanel createTab="teams" detailsOpen />)
    await waitFor(() => {
      expect(screen.queryByText('Visual Builder')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Team inspector')).toBeInTheDocument()

    rerender(<CreatePanel createTab="agents" detailsOpen />)
    await waitFor(() => {
      expect(screen.queryByText('Team inspector')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Agent inspector')).toBeInTheDocument()
  })
})
