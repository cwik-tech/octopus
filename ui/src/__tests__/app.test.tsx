import { act, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest'

import App from '@/App'
import type { RunTargetLockReason } from '@/components/run/run-panel'
import { DesktopSidebar } from '@/components/sidebar/desktop-sidebar'

const runPanelImport = vi.hoisted(() => {
  let resolve!: () => void
  const pending = new Promise<void>((resolvePending) => {
    resolve = resolvePending
  })

  return { pending, resolve }
})

const workflowDraftGuard = vi.hoisted(() => vi.fn(() => true))
const libraryNewProjectAction = vi.hoisted(() => vi.fn())
const listProjects = vi.hoisted(() => vi.fn())
const LIBRARY_PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const listTeamBuilderTeams = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve<
      Array<{
        id: string
        name: string
        description?: string
        tags: string[]
        agentCount: number
      }>
    >([]),
  ),
)
let createWorkspaceMountCount = 0
/** The last retention callback the Create panel stand-in was given, and its unmount signal. */
const createRetention = vi.hoisted((): {
  report: (retain: boolean) => void
  unmounted: () => void
} => ({ report: () => {}, unmounted: () => {} }))

vi.mock('@/components/run/run-panel', async () => {
  await runPanelImport.pending
  return {
    default: ({
      onOpenQueueSession,
      onRunTargetLockChange,
      onSessionActivityStarted,
    }: {
      onOpenQueueSession?: (sessionId: string) => void
      onRunTargetLockChange?: (reason: RunTargetLockReason | null) => void
      onSessionActivityStarted?: (sessionId: string) => void
    }) => (
      <div data-testid="run-workspace">
        Run workspace
        <button
          type="button"
          onClick={() => onSessionActivityStarted?.('session-1')}
        >
          Simulate session activity
        </button>
        <button
          type="button"
          onClick={() => onOpenQueueSession?.('scheduled-session')}
        >
          Simulate operational session open
        </button>
        <button
          type="button"
          onClick={() => onRunTargetLockChange?.('team-history')}
        >
          Simulate team run session
        </button>
        <button
          type="button"
          onClick={() => onRunTargetLockChange?.(null)}
        >
          Simulate open target session
        </button>
      </div>
    ),
  }
})

vi.mock('@/components/create/create-panel', () => ({
  default: function MockCreatePanel({
    createTab,
    onConversationRetentionChange,
    onCreateTabChange,
    onResourcesChanged,
    onWorkflowDirtyChange,
  }: {
    createTab: 'agents' | 'teams' | 'workflows'
    onConversationRetentionChange: (retain: boolean) => void
    onCreateTabChange: (tab: 'agents' | 'teams' | 'workflows') => void
    onResourcesChanged: () => Promise<void> | void
    onWorkflowDirtyChange: (dirty: boolean) => void
  }) {
    const [mountId] = useState(() => ++createWorkspaceMountCount)
    createRetention.report = onConversationRetentionChange
    useEffect(() => () => createRetention.unmounted(), [])
    return (
      <div data-testid="create-workspace" data-mount-id={mountId}>
        Create workspace
        <button type="button" onClick={() => onWorkflowDirtyChange(true)}>
          Mark workflow draft dirty
        </button>
        <button type="button" onClick={() => onCreateTabChange('workflows')}>
          Workflows tab
        </button>
        <button type="button" onClick={() => onCreateTabChange('teams')}>
          Teams tab
        </button>
        <button type="button" onClick={() => void onResourcesChanged()}>
          Simulate resource change
        </button>
        <span data-testid="create-mode">{createTab}</span>
      </div>
    )
  },
}))

vi.mock('@/components/library/library-panel', () => ({
  default: function MockLibraryPanel({
    onCreateProjectActionChange,
    onOpenSession,
    selectedProjectId,
  }: {
    onCreateProjectActionChange: (action: (() => void) | null) => void
    onOpenSession: (sessionId: string) => void
    selectedProjectId: string | null
  }) {
    useEffect(() => {
      onCreateProjectActionChange(libraryNewProjectAction)
      return () => onCreateProjectActionChange(null)
    }, [onCreateProjectActionChange])
    return (
      <div data-testid="library-workspace">
        <h1>
          {selectedProjectId === LIBRARY_PROJECT_ID
            ? 'Project detail: Acme launch'
            : 'All projects overview'}
        </h1>
        <button type="button" onClick={() => onOpenSession('library-session')}>
          Open library session
        </button>
      </div>
    )
  },
}))

vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => null,
}))

vi.mock('@/lib/clients/agent-generator-client', () => ({
  listAgents: vi.fn(() => Promise.resolve([])),
  checkAgentProviderHealth: vi.fn(() => Promise.resolve([])),
}))

vi.mock('@/lib/clients/runtime-client', () => ({
  fetchExcelWorkbookPreview: vi.fn(),
  fetchRuns: vi.fn(() => Promise.resolve({ runs: [] })),
}))

vi.mock('@/lib/clients/project-client', () => ({
  listProjects,
}))

vi.mock('@/lib/clients/session-client', () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  createSession: vi.fn(),
  listSessions: vi.fn(() => Promise.resolve([])),
  listWorkflows: vi.fn(() => Promise.resolve([])),
}))

vi.mock('@/lib/clients/team-builder-client', () => ({
  listTeamBuilderTeams,
  invalidateTeamBuilderTeamsCache: vi.fn(),
  subscribeToTeamBuilderTeams: vi.fn(() => () => {}),
}))

vi.mock('@/lib/utils/workflow-draft-guard', () => ({
  confirmWorkflowDraftDiscard: workflowDraftGuard,
}))

describe('App workspace loading and navigation', () => {
  beforeEach(() => {
    createWorkspaceMountCount = 0
    listTeamBuilderTeams.mockReset()
    listTeamBuilderTeams.mockResolvedValue([])
    workflowDraftGuard.mockReset()
    workflowDraftGuard.mockReturnValue(true)
    libraryNewProjectAction.mockReset()
    listProjects.mockReset()
    listProjects.mockResolvedValue([
      {
        version: 1,
        id: LIBRARY_PROJECT_ID,
        name: 'Acme launch',
        description: 'Launch planning and source material.',
        status: 'active',
        sessionCount: 1,
        activeSessionCount: 0,
        createdAt: '2026-08-04T09:00:00.000Z',
        updatedAt: '2026-08-04T11:00:00.000Z',
      },
    ])
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('loads project summaries while Run is active for assigned-session tooltips', async () => {
    render(<App />)

    await waitFor(() => {
      expect(listProjects).toHaveBeenCalledWith({ includeArchived: true })
    })
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true')
  })

  it('loads workspaces on demand and preserves the dirty-workflow guard', async () => {
    const user = userEvent.setup()
    await act(async () => {
      render(<App />)
      await Promise.resolve()
    })

    const loadingStatus = screen.getByRole('status')
    expect(loadingStatus).toHaveAttribute('aria-live', 'polite')
    expect(loadingStatus).toHaveTextContent('Loading Run workspace…')

    await act(async () => {
      runPanelImport.resolve()
      await runPanelImport.pending
    })
    expect(await screen.findByTestId('run-workspace')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Create' }))
    expect(await screen.findByTestId('create-workspace')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Workflows tab' }))
    await user.click(screen.getByRole('button', { name: 'Mark workflow draft dirty' }))
    workflowDraftGuard.mockReturnValue(false)
    await user.click(screen.getByRole('tab', { name: 'Run' }))

    expect(workflowDraftGuard).toHaveBeenCalledWith(true)
    expect(screen.getByRole('tab', { name: 'Create' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByTestId('create-workspace')).toBeInTheDocument()

    workflowDraftGuard.mockReturnValue(true)
    await user.click(screen.getByRole('tab', { name: 'Run' }))

    expect(await screen.findByTestId('run-workspace')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('uses the titlebar plus action for the active workspace', async () => {
    const user = userEvent.setup()
    await act(async () => {
      render(<App />)
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled()

    await user.click(screen.getByRole('tab', { name: 'Create' }))
    const createWorkspace = await screen.findByTestId('create-workspace')
    const initialMountId = createWorkspace.dataset.mountId
    expect(screen.getByRole('button', { name: 'New team' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Workflows tab' }))
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Mark workflow draft dirty' }))
    workflowDraftGuard.mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: 'New workflow' }))
    expect(screen.getByTestId('create-workspace')).toHaveAttribute(
      'data-mount-id',
      initialMountId,
    )

    workflowDraftGuard.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'New workflow' }))
    expect(screen.getByTestId('create-workspace')).not.toHaveAttribute(
      'data-mount-id',
      initialMountId,
    )

    await user.click(screen.getByRole('button', { name: 'Teams tab' }))
    expect(screen.getByRole('button', { name: 'New team' })).toBeEnabled()

    expect(screen.queryByRole('tab', { name: 'Admin' })).not.toBeInTheDocument()
  })

  it('keeps Create until the user has seen work that ended while another workspace was open', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'Create' }))
    const mountId = (await screen.findByTestId('create-workspace')).dataset.mountId
    // Create is keeping unfinished work, such as a running build.
    act(() => createRetention.report(true))
    await user.click(screen.getByRole('tab', { name: 'Run' }))

    // The build fails while Run is open, so Create stops asking to be kept.
    act(() => createRetention.report(false))

    // Nobody has read the failure yet: Create is still the same screen.
    expect(screen.getByTestId('create-workspace')).toHaveAttribute('data-mount-id', mountId)
    await user.click(screen.getByRole('tab', { name: 'Create' }))
    expect(screen.getByTestId('create-workspace')).toHaveAttribute('data-mount-id', mountId)
    // Seen now, so leaving again lets it go. The panel's exit can finish after
    // the click, so the stand-in's own unmount is what this waits for.
    const unmounted = new Promise<void>((resolve) => { createRetention.unmounted = resolve })
    await user.click(screen.getByRole('tab', { name: 'Run' }))
    await unmounted
    expect(screen.queryByTestId('create-workspace')).not.toBeInTheDocument()
  })

  it('opens Library on the project overview and uses the primary sidebar for projects', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Library' }))
    expect(await screen.findByTestId('library-workspace')).toBeInTheDocument()

    const sidebar = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(await within(sidebar).findByRole('button', { name: /All projects/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(sidebar).getByRole('button', { name: /Acme launch/ })).toBeInTheDocument()
    expect(within(sidebar).queryByRole('button', { name: /Queue overview/ })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'All projects overview' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show inspector' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    await user.click(within(screen.getByRole('group', { name: 'Left window actions' })).getByRole('button', { name: 'New project' }))
    expect(libraryNewProjectAction).toHaveBeenCalledOnce()

    await user.click(within(sidebar).getByRole('button', { name: /Acme launch/ }))
    expect(screen.getByRole('heading', { name: 'Project detail: Acme launch' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Run' }))
    await user.click(screen.getByRole('tab', { name: 'Library' }))
    expect(screen.getByRole('heading', { name: 'All projects overview' })).toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: /All projects/ })).toHaveAttribute(
      'aria-current',
      'page',
    )

    await user.click(screen.getByRole('button', { name: 'Open library session' }))
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true')
  })

  it('auto-collapses the Run sidebar once when session activity starts', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('button', { name: 'Hide sidebar' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Hide inspector' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Simulate session activity' }))

    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Show inspector' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show sidebar' }))
    await user.click(screen.getByRole('button', { name: 'Simulate session activity' }))

    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Hide inspector' })).not.toBeInTheDocument()
  })

  it('keeps Sessions available and disables target tabs for a session a Team run already owns', async () => {
    const user = userEvent.setup()
    render(<App />)
    await act(async () => {
      runPanelImport.resolve()
      await runPanelImport.pending
    })

    const navigation = screen.getByRole('tablist', { name: 'Run navigation' })
    expect(within(navigation).getByRole('tab', { name: 'Teams' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Simulate team run session' }))

    expect(within(navigation).getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-disabled', 'true')
    expect(within(navigation).getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-disabled', 'true')
    expect(within(navigation).getByRole('tab', { name: 'Sessions' })).toBeEnabled()

    // Leaving that session restores target selection.
    await user.click(screen.getByRole('button', { name: 'Simulate open target session' }))

    expect(within(navigation).getByRole('tab', { name: 'Teams' })).toBeEnabled()
    expect(within(navigation).getByRole('tab', { name: 'Agents' })).toBeEnabled()
  })

  it('enables left target tabs when an operational view opens a run session', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Queue overview/ }))
    const navigation = screen.getByRole('tablist', { name: 'Run navigation' })
    expect(within(navigation).getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-disabled', 'true')

    await user.click(
      screen.getByRole('button', { name: 'Simulate operational session open' }),
    )

    expect(within(navigation).getByRole('tab', { name: 'Teams' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Hide inspector' })).not.toBeInTheDocument()
  })

  it('uses the shared full-height shell for both sidebars', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Create' }))
    await screen.findByTestId('create-workspace')
    const leftSidebar = screen.getByRole('complementary', {
      name: 'Primary navigation',
    })
    const rightSidebar = screen.getByRole('complementary', {
      name: 'Context sidebar',
    })

    expect(leftSidebar).toHaveAttribute('data-slot', 'workspace-sidebar')
    expect(leftSidebar).toHaveAttribute('data-side', 'left')
    expect(rightSidebar).toHaveAttribute('data-slot', 'workspace-sidebar')
    expect(rightSidebar).toHaveAttribute('data-side', 'right')
    expect(screen.getByRole('separator', { name: 'Resize right sidebar' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(rightSidebar).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button', { name: 'Show details' })).toBeEnabled()
  })

  it('keeps one fixed window-action group per side while panels collapse', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Create' }))
    await screen.findByTestId('create-workspace')
    const leftActions = screen.getByRole('group', { name: 'Left window actions' })
    const rightActions = screen.getByRole('group', { name: 'Right window actions' })
    const leftToggle = within(leftActions).getByRole('button', { name: 'Hide sidebar' })
    const rightToggle = within(rightActions).getByRole('button', { name: 'Hide details' })
    const resizeHandle = screen.getByRole('separator', { name: 'Resize right sidebar' })

    expect(leftActions).toHaveClass('left-21.5', 'gap-1')
    expect(rightActions).toHaveClass('right-2', 'gap-1')
    expect(resizeHandle).toHaveClass('-mx-2')

    await user.click(leftToggle)
    expect(screen.getByRole('group', { name: 'Left window actions' })).toBe(leftActions)
    expect(within(leftActions).getByRole('button', { name: 'Show sidebar' })).toBe(
      leftToggle,
    )

    await user.click(rightToggle)
    expect(screen.getByRole('group', { name: 'Right window actions' })).toBe(
      rightActions,
    )
    expect(
      within(rightActions).getByRole('button', { name: 'Show details' }),
    ).toBe(rightToggle)
    expect(resizeHandle).toHaveClass('mx-0', 'w-0', 'overflow-hidden')
    expect(resizeHandle).not.toHaveClass('-mx-2')
  })

  it('offers contextual details across Create modes', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Create' }))
    await screen.findByTestId('create-workspace')
    expect(screen.getByRole('button', { name: 'Hide details' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'About workflows' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Teams' }))
    expect(screen.getByRole('button', { name: 'Hide details' })).toBeEnabled()

    expect(screen.queryByRole('tab', { name: 'Plan' })).not.toBeInTheDocument()

    expect(screen.queryByRole('tab', { name: 'Admin' })).not.toBeInTheDocument()
  })

  it('guards Create sidebar tab switches behind the unsaved workflow confirmation', async () => {
    const user = userEvent.setup()
    await act(async () => {
      render(<App />)
      await Promise.resolve()
    })

    await user.click(screen.getByRole('tab', { name: 'Create' }))
    await screen.findByTestId('create-workspace')
    expect(screen.getByTestId('create-mode')).toHaveTextContent('teams')
    await user.click(screen.getByRole('button', { name: 'Workflows tab' }))
    expect(screen.getByTestId('create-mode')).toHaveTextContent('workflows')

    await user.click(screen.getByRole('button', { name: 'Mark workflow draft dirty' }))
    workflowDraftGuard.mockReturnValue(false)
    await user.click(screen.getByRole('tab', { name: 'Teams' }))

    expect(workflowDraftGuard).toHaveBeenCalledWith(true)
    expect(screen.getByTestId('create-mode')).toHaveTextContent('workflows')

    workflowDraftGuard.mockReturnValue(true)
    await user.click(screen.getByRole('tab', { name: 'Teams' }))

    expect(screen.getByTestId('create-mode')).toHaveTextContent('teams')
  })

  it('leaves the run mode to the run target sidebar instead of the header', async () => {
    const user = userEvent.setup()
    await act(async () => {
      render(<App />)
      await Promise.resolve()
    })
    // The Run workspace is lazy; resolve its import here so this test does not
    // depend on an earlier one having released it.
    await act(async () => {
      runPanelImport.resolve()
      await runPanelImport.pending
    })

    expect(await screen.findByTestId('run-workspace')).toBeInTheDocument()
    expect(
      screen.queryByRole('tablist', { name: 'Run mode' }),
    ).not.toBeInTheDocument()

    const queueOverview = screen.getByRole('button', {
      name: /Queue overview/,
    })
    await user.click(queueOverview)

    expect(queueOverview).toHaveAttribute('aria-current', 'page')
    expect(
      screen.queryByRole('tablist', { name: 'Run mode' }),
    ).not.toBeInTheDocument()
  })

  it('refreshes the Create sidebar when a child reports a saved resource', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Create' }))
    await user.click(screen.getByRole('button', { name: 'Teams tab' }))
    await user.click(
      within(screen.getByRole('complementary', { name: 'Primary navigation' }))
        .getByRole('tab', { name: 'Teams' }),
    )
    await waitFor(() => expect(listTeamBuilderTeams).toHaveBeenCalled())

    listTeamBuilderTeams.mockResolvedValue([
      {
        id: 'new-team',
        name: 'new-team',
        description: 'A newly saved team.',
        tags: [],
        agentCount: 2,
      },
    ])
    await user.click(
      screen.getByRole('button', { name: 'Simulate resource change' }),
    )

    expect(await screen.findByText('New Team')).toBeInTheDocument()
  })
})

test('groups live Run sessions above recent sessions and opens Queue overview', async () => {
  const user = userEvent.setup();
  const onQueueSelect = vi.fn();
  const updatedAt = "2026-07-14T12:00:00.000Z";

  render(
    <DesktopSidebar
      activeTab="run"
      createData={{ agents: [], teams: [], workflows: [] }}
      createError={null}
      createLoading={false}
      createTab="workflows"
      deletingSidebarItem={null}
      error={null}
      loading={false}
      selectedCreateAgentName={null}
      selectedCreateTeamId={null}
      selectedCreateWorkflowId={null}
      selectedSessionId={"live-session"}
      sessions={[
        {
          id: "recent-session",
          title: "Recent session",
          status: "done",
          activityType: "workflow",
          createdAt: updatedAt,
          updatedAt,
        },
        {
          id: "live-session",
          title: "Live session",
          status: "active",
          activityType: "workflow",
          createdAt: updatedAt,
          updatedAt,
        },
      ]}
      queueError={null}
      queueLoading={false}
      queueSnapshot={{
        version: 1,
        status: "ready",
        maximumConcurrentTasks: 3,
        slotsInUse: 1,
        availableSlots: 2,
        waitingCount: 1,
        observedAt: updatedAt,
        items: [
          {
            sessionId: "live-session",
            taskId: "live-task",
            runId: "live-run",
            workflowId: "workflow",
            state: "running",
            executionKind: "initial",
            source: "apply",
            requestedAt: updatedAt,
          },
        ],
      }}
      runWorkspaceView="session"
      onAgentSelect={vi.fn()}
      onDelete={vi.fn()}
      onQueueSelect={onQueueSelect}
      onSelect={vi.fn()}
      onTeamSelect={vi.fn()}
      onWorkflowSelect={vi.fn()}
    />,
  );

  expect(screen.getByText("Active")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Recent session" })).toBeInTheDocument();
  expect(screen.getByText("Running · 1 task")).toBeInTheDocument();
  expect(screen.getByText("1 of 3 slots · 1 waiting")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Queue overview/ }));
  expect(onQueueSelect).toHaveBeenCalledOnce();
});

test('shows Create item descriptions only from shared info tooltips', async () => {
  const user = userEvent.setup()
  const description = 'A deliberately detailed team description.'

  render(
    <DesktopSidebar
      activeTab="create"
      createData={{
        agents: [],
        teams: [
          {
            id: 'research-team',
            name: 'research-team',
            description,
            tags: [],
            agentCount: 3,
            health: { status: 'ok', errors: [], warnings: [] },
          },
        ],
        workflows: [],
      }}
      createError={null}
      createLoading={false}
      createTab="teams"
      deletingSidebarItem={null}
      error={null}
      loading={false}
      selectedCreateAgentName={null}
      selectedCreateTeamId="research-team"
      selectedCreateWorkflowId={null}
      selectedSessionId={null}
      sessions={[]}
      onAgentSelect={vi.fn()}
      onDelete={vi.fn()}
      onSelect={vi.fn()}
      onTeamSelect={vi.fn()}
      onWorkflowSelect={vi.fn()}
    />,
  )

  expect(screen.queryByText(description)).not.toBeInTheDocument()
  const descriptionButton = screen.getByRole('button', {
    name: 'View description for Research Team',
  })
  await user.hover(descriptionButton)

  expect(await screen.findByText(description)).toBeInTheDocument()
})

test.each([
  ['agents', 'research-agent', 'Agent description.'],
  ['workflows', 'research-workflow', 'Workflow description.'],
] as const)('shows %s descriptions only from shared info tooltips', async (tab, label, description) => {
  const user = userEvent.setup()

  render(
    <DesktopSidebar
      activeTab="create"
      createData={{
        agents: tab === 'agents' ? [{ name: label, description, skills: [], usedInTeams: [] }] : [],
        teams: [],
        workflows: tab === 'workflows' ? [{ id: label, description }] : [],
      }}
      createError={null}
      createLoading={false}
      createTab={tab}
      deletingSidebarItem={null}
      error={null}
      loading={false}
      selectedCreateAgentName={null}
      selectedCreateTeamId={null}
      selectedCreateWorkflowId={null}
      selectedSessionId={null}
      sessions={[]}
      onAgentSelect={vi.fn()}
      onDelete={vi.fn()}
      onSelect={vi.fn()}
      onTeamSelect={vi.fn()}
      onWorkflowSelect={vi.fn()}
    />,
  )

  expect(screen.queryByText(description)).not.toBeInTheDocument()
  const displayLabel = label
    .split('-')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ')
  await user.hover(screen.getByRole('button', {
    name: `View description for ${displayLabel}`,
  }))
  expect(await screen.findByText(description)).toBeInTheDocument()
})

test('humanizes resource names and shows an agent provider logo after the name', () => {
  const { container } = render(
    <DesktopSidebar
      activeTab="create"
      createData={{
        agents: [{
          model: 'gpt-5.4',
          name: 'domain-researcher',
          provider: 'openai',
          skills: [],
          usedInTeams: [],
        }],
        teams: [],
        workflows: [],
      }}
      createError={null}
      createLoading={false}
      createTab="agents"
      deletingSidebarItem={null}
      error={null}
      loading={false}
      selectedCreateAgentName={null}
      selectedCreateTeamId={null}
      selectedCreateWorkflowId={null}
      selectedSessionId={null}
      sessions={[]}
      onAgentSelect={vi.fn()}
      onDelete={vi.fn()}
      onSelect={vi.fn()}
      onTeamSelect={vi.fn()}
      onWorkflowSelect={vi.fn()}
    />,
  )

  expect(screen.getByText('Domain Researcher')).toBeInTheDocument()
  expect(
    container.querySelector('[data-provider-logo="openai"]'),
  ).toBeInTheDocument()
  expect(screen.getByLabelText('Model: gpt-5.4')).toBeInTheDocument()
})

test('filters a sidebar from the third character and clears the filter when dismissed', async () => {
  const user = userEvent.setup()

  render(
    <DesktopSidebar
      activeTab="create"
      createData={{
        agents: [],
        teams: [
          {
            id: 'research-team',
            name: 'research-team',
            description: 'Investigates product questions.',
            tags: ['research'],
            agentCount: 2,
            health: { status: 'ok', errors: [], warnings: [] },
          },
          {
            id: 'delivery-team',
            name: 'delivery-team',
            description: 'Ships approved work.',
            tags: ['delivery'],
            agentCount: 2,
            health: { status: 'ok', errors: [], warnings: [] },
          },
        ],
        workflows: [],
      }}
      createError={null}
      createLoading={false}
      createTab="teams"
      deletingSidebarItem={null}
      error={null}
      loading={false}
      selectedCreateAgentName={null}
      selectedCreateTeamId="research-team"
      selectedCreateWorkflowId={null}
      selectedSessionId={null}
      sessions={[]}
      onAgentSelect={vi.fn()}
      onDelete={vi.fn()}
      onSelect={vi.fn()}
      onTeamSelect={vi.fn()}
      onWorkflowSelect={vi.fn()}
    />,
  )

  await user.click(screen.getByRole('button', { name: 'Search Teams' }))
  const input = screen.getByRole('searchbox', { name: 'Search Teams' })
  await user.type(input, 're')

  expect(screen.getByText('Delivery Team')).toBeInTheDocument()
  await user.type(input, 's')
  expect(screen.queryByText('Delivery Team')).not.toBeInTheDocument()
  expect(screen.getByText('Research Team')).toBeInTheDocument()

  await user.clear(input)
  expect(screen.getByText('Delivery Team')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Clear search' }))
  expect(screen.getByText('Delivery Team')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Search Teams' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
})
