/**
 * Integration tests for RunPanel keyboard shortcuts and empty-state UI.
 *
 * These component tests isolate browser behavior at the API boundary. The
 * matching session and run-plan endpoints are exercised with real HTTP and
 * filesystem storage in tests/integration/session-task-api-contract.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import RunPanel from '../run-panel'
import type { ChatMessage } from '@/lib/models/session-model'

// ── Mock all heavy deps ───────────────────────────────────────────────────

const chatPanelRenderLog = vi.hoisted((): Array<{
  sessionId: string | null
  workflowMessages: string[]
}> => [])
/** Every line the Run panel asked the chat to add, in order. */
const chatPanelInjections = vi.hoisted((): unknown[] => [])

vi.mock('@/lib/clients/session-client', () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn().mockResolvedValue({
    dispatch: { kind: 'coordinator' },
    user: {
      id: 'u1',
      role: 'user',
      text: 'test',
      createdAt: '2026-05-01T12:00:00.000Z',
    },
    messages: [
      {
        id: 'a1',
        role: 'assistant',
        text: 'reply',
        createdAt: '2026-05-01T12:00:01.000Z',
      },
    ],
    plan: {
      id: 'plan-1',
      goal: 'test',
      summary: 'test',
      status: 'needs_input',
      requiredInputs: [],
      actions: [],
      warnings: [],
      createdAt: '2026-05-01T12:00:00.000Z',
    },
    meta: { model: 'test-model', fallback: false },
    replayed: false,
  }),
  SessionTaskStartError: class SessionTaskStartError extends Error {
    assistant?: unknown
    detail?: string | undefined
    plan?: unknown

    constructor(message: string, assistant?: unknown, detail?: string, plan?: unknown) {
      super(message)
      this.name = 'SessionTaskStartError'
      this.assistant = assistant
      this.detail = detail
      this.plan = plan
    }
  },
  cancelSessionTask: vi.fn(),
  resumeSessionTask: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  getWorkflowStages: vi.fn().mockResolvedValue([]),
  getSessionRunPlan: vi.fn(),
  generateSessionResearchPlan: vi.fn(),
  getSessionResearchPlanAttempt: vi.fn(),
  cancelSessionResearchPlanAttempt: vi.fn(),
  openSessionResearchPlanAttemptStream: vi.fn().mockResolvedValue(undefined),
  approveSessionResearchPlan: vi.fn(),
  listSessionTasks: vi.fn(),
  selectSessionWorkflow: vi.fn(),
  startSessionTask: vi.fn(),
}))

vi.mock('@/lib/clients/agent-generator-client', () => ({
  listAgents: vi.fn(),
  checkAgentProviderHealth: vi.fn(),
  readAgentPersona: vi.fn(),
}))

vi.mock('@/lib/clients/team-builder-client', () => ({
  listCachedTeamBuilderTeams: vi.fn().mockResolvedValue([]),
  readTeamBuilderTeam: vi.fn().mockResolvedValue({ agents: [], models: {} }),
  subscribeToTeamBuilderTeams: vi.fn(() => () => {}),
}))

vi.mock('@/lib/clients/runtime-client', () => ({
  openRunEventStream: vi.fn().mockResolvedValue(undefined),
  fetchRunEventsSnapshot: vi.fn(),
  fetchArtifact: vi.fn(),
  fetchExcelWorkbookPreview: vi.fn(),
  fetchRunDetails: vi.fn().mockResolvedValue({ artifactPaths: [] }),
}))

vi.mock('@/components/run/chat/chat-panel', () => ({
  default: vi.fn().mockImplementation((props: {
    onUserMessagePresenceChange?: (sessionId: string, hasUserMessage: boolean) => void
    onRunPlanUpdated?: (sessionId: string, plan: unknown) => void
    onTaskStarted?: (sessionId: string, task: unknown) => void
    onPendingResponseChange?: (sessionId: string, pending: boolean) => void
    onProjectContextChange?: (selection: {
      projectId: string
      includeBrief: boolean
      fileNames: string[]
    }) => void
    target?: {
      kind: string
      workflowId?: string
      expectedPlanId?: string | null
      teamId?: string
      agentNames?: string[]
    }
    presentationTeamId?: string | null
    teamRunActive?: boolean
    onStopTeamRun?: () => Promise<void> | void
    workflowRunNotice?: string | null
    onStopWorkflowRun?: () => Promise<void> | void
    showWorkflowMessages?: boolean
    workflowMessages?: Array<{ text: string }>
    workflowPendingAgents?: Array<{ name: string }>
    conversationAppend?: ReactNode
    ref?: {
      current: {
        injectMessage: (message: unknown) => void
        reloadMessages: () => void
      } | null
    }
    session?: { id: string } | null
    isDraft?: boolean
    ensureSession?: () => Promise<string>
  }) => {
    chatPanelRenderLog.push({
      sessionId: props.session?.id ?? null,
      workflowMessages: (props.workflowMessages ?? []).map(
        (message) => message.text,
      ),
    })
    if (props.ref && typeof props.ref === 'object') {
      props.ref.current = {
        injectMessage: (message: unknown) => {
          chatPanelInjections.push(message)
        },
        reloadMessages: vi.fn(),
      }
    }
    return (
      <div
        aria-label="Run chat"
        data-slot="chat-shell"
        data-testid="chat-panel"
        data-draft={props.isDraft ? 'true' : 'false'}
        data-target={props.target ? props.target.kind : ''}
        data-target-workflow={
          props.target && props.target.kind === 'workflow'
            ? props.target.workflowId
            : ''
        }
        data-target-expects={
          props.target && props.target.kind === 'workflow'
            ? String(props.target.expectedPlanId)
            : ''
        }
        data-agents={
          props.target?.kind === 'agents'
            ? (props.target.agentNames ?? []).join(',')
            : ''
        }
        data-team={
          props.target?.kind === 'team' ? props.target.teamId ?? '' : ''
        }
        data-presentation-team={props.presentationTeamId ?? ''}
        data-team-run-active={String(props.teamRunActive ?? false)}
        data-workflow-run-notice={props.workflowRunNotice ?? ''}
        data-show-workflow-messages={String(props.showWorkflowMessages ?? false)}
        data-workflow-messages={(props.workflowMessages ?? []).map((message) => message.text).join('|')}
        data-workflow-pending={(props.workflowPendingAgents ?? []).map((agent) => agent.name).join('|')}
      >
        {props.conversationAppend}
        {props.onStopTeamRun ? (
          <button type="button" onClick={() => void props.onStopTeamRun?.()}>
            Stop Team run
          </button>
        ) : null}
        {props.onStopWorkflowRun ? (
          <button type="button" onClick={() => void props.onStopWorkflowRun?.()}>
            Stop workflow run
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void props.ensureSession?.().catch(() => undefined)
          }}
        >
          Materialize draft
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onPendingResponseChange?.(props.session.id, true)
            }
          }}
        >
          Mark receptionist pending
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onPendingResponseChange?.(props.session.id, false)
            }
          }}
        >
          Mark receptionist idle
        </button>
        <button
          type="button"
          onClick={() => props.onProjectContextChange?.({
            projectId: '11111111-1111-4111-8111-111111111111',
            includeBrief: true,
            fileNames: ['facts.md'],
          })}
        >
          Select project context
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onUserMessagePresenceChange?.(props.session.id, true)
            }
          }}
        >
          Mark user message
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onRunPlanUpdated?.(props.session.id, {
                id: 'plan-1',
                goal: 'Plan a website',
                summary: 'Ready',
                status: 'ready',
                selectedWorkflow: {
                  id: 'wf-1',
                  selectionSource: 'user',
                  confidence: 'high',
                  rationale: 'Matched the request.',
                },
                requiredInputs: [],
                brief: 'Plan a website',
                actions: [],
                warnings: [],
                createdAt: new Date().toISOString(),
              })
            }
          }}
        >
          Mark ready plan
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onRunPlanUpdated?.(props.session.id, {
                id: 'plan-2',
                goal: 'Plan a website',
                summary: 'Ready',
                status: 'ready',
                selectedWorkflow: {
                  id: 'wf-2',
                  selectionSource: 'user',
                  confidence: 'high',
                  rationale: 'Matched the latest request.',
                },
                requiredInputs: [],
                brief: 'Plan a website',
                actions: [],
                warnings: [],
                createdAt: new Date().toISOString(),
              })
            }
          }}
        >
          Mark alternate ready plan
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onRunPlanUpdated?.(props.session.id, {
                id: 'plan-thin',
                goal: 'Create a site structure',
                summary: 'Workflow selected, but details are missing.',
                status: 'needs_input',
                selectedWorkflow: {
                  id: 'wf-1',
                  selectionSource: 'user',
                  confidence: 'high',
                  rationale: 'Matched the request.',
                },
                requiredInputs: ['specific task details'],
                brief: 'Create a site structure',
                actions: [],
                warnings: [],
                createdAt: new Date().toISOString(),
              })
            }
          }}
        >
          Mark thin plan
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onRunPlanUpdated?.(props.session.id, {
                id: 'plan-stalled',
                goal: 'Plan a website',
                summary: 'Workflow selected, but plan is not ready.',
                status: 'needs_input',
                selectedWorkflow: {
                  id: 'wf-1',
                  selectionSource: 'user',
                  confidence: 'high',
                  rationale: 'Matched the request.',
                },
                requiredInputs: [],
                brief: 'Plan a website',
                actions: [],
                warnings: [],
                createdAt: new Date().toISOString(),
              })
            }
          }}
        >
          Mark stalled plan
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onRunPlanUpdated?.(props.session.id, {
                id: 'plan-workflow-needed',
                goal: 'Write an objective report',
                summary: 'Workflow selection is required.',
                status: 'needs_input',
                requiredInputs: ['workflow selection'],
                brief: 'Write an objective report for a defined audience.',
                actions: [],
                warnings: [],
                createdAt: new Date().toISOString(),
              })
            }
          }}
        >
          Mark workflow-selection plan
        </button>
        <button
          type="button"
          onClick={() => {
            if (props.session?.id) {
              props.onTaskStarted?.(props.session.id, {
                id: 'chat-task',
                sessionId: props.session.id,
                runId: 'chat-run',
                workflowId: 'wf-1',
                brief: 'Chat-started work',
                status: 'running',
                createdAt: new Date().toISOString(),
                cwd: '/workspace',
              })
            }
          }}
        >
          Mark chat task started
        </button>
      </div>
    )
  }),
}))

vi.mock('@/components/run/pickers/workflow-picker', () => ({
  default: (props: { onSelectWorkflow: (id: string) => void }) => (
    <div>
      <button
        data-testid="workflow-picker"
        type="button"
        onClick={() => props.onSelectWorkflow('wf-1')}
      >
        Workflow wf-1
      </button>
      <button
        data-testid="workflow-picker-stale"
        type="button"
        onClick={() => props.onSelectWorkflow('wf-stale')}
      >
        Workflow stale
      </button>
    </div>
  ),
}))

vi.mock('@/components/shared/file-upload', () => ({
  default: () => <div data-testid="session-files" />,
}))

vi.mock('@/components/run/tasks/task-body', () => ({
  TaskBody: ({
    isResuming,
    onCancelTask,
    onResumeTask,
    task,
  }: {
    isResuming?: boolean
    onCancelTask?: (taskId: string) => void
    onResumeTask?: (taskId: string) => void
    task: {
      errorMessage?: string
      label: string
      mode: string
      recoveryReason?: string
      taskId: string
      workflowId?: string
    }
  }) => (
    <div
      data-testid="task-body"
      data-mode={task.mode}
      data-workflow={task.workflowId}
    >
      {task.errorMessage}
      {task.recoveryReason}
      {(task.mode === 'queued' || task.mode === 'running') && (
        <button
          type="button"
          onClick={() => onCancelTask?.(task.taskId)}
        >
          Stop workflow
        </button>
      )}
      {task.mode === 'interrupted' && (
        <button
          type="button"
          disabled={isResuming}
          onClick={() => onResumeTask?.(task.taskId)}
        >
          {isResuming ? 'Resuming…' : 'Resume'}
        </button>
      )}
    </div>
  ),
}))

vi.mock('@/components/run/tasks/task-strip', () => ({
  TaskStrip: ({
    onCancel,
    tasks,
  }: {
    onCancel: (taskId: string) => void
    tasks: Array<{ label: string; mode: string; taskId: string }>
  }) => (
    <div data-testid="task-strip">
      {tasks.map((task) => (
        <button
          key={task.taskId}
          type="button"
          disabled={
            task.mode !== 'queued' &&
            task.mode !== 'running' &&
            task.mode !== 'interrupted'
          }
          onClick={() => onCancel(task.taskId)}
        >
          Cancel task: {task.label}
        </button>
      ))}
    </div>
  ),
}))

vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>()
  return { ...actual, toast: { ...actual.toast, success: vi.fn(), error: vi.fn() }, Toaster: () => null }
})

import {
  SessionTaskStartError,
  cancelSessionTask as mockCancelSessionTask,
  fetchSession as mockFetchSession,
  getWorkflowStages as mockGetWorkflowStages,
  listSessions as mockListSessions,
  createSession as mockCreateSession,
  getSessionRunPlan as mockGetSessionRunPlan,
  listSessionTasks as mockListSessionTasks,
  resumeSessionTask as mockResumeSessionTask,
  selectSessionWorkflow as mockSelectSessionWorkflow,
  startSessionTask as mockStartSessionTask,
} from '@/lib/clients/session-client'
import {
  fetchRunEventsSnapshot as mockFetchRunEventsSnapshot,
  openRunEventStream as mockOpenRunEventStream,
} from '@/lib/clients/runtime-client'
import type { EngineEventEnvelope } from '@/lib/models/runtime-model'
import { toast } from 'sonner'
import {
  checkAgentProviderHealth as mockCheckAgentProviderHealth,
  listAgents as mockListAgents,
  readAgentPersona as mockReadAgentPersona,
} from '@/lib/clients/agent-generator-client'
import { listCachedTeamBuilderTeams as mockListCachedTeamBuilderTeams } from '@/lib/clients/team-builder-client'

/**
 * RunPanel opens on a draft that exists only on the client. A test about a
 * persisted session therefore selects one the way the app does, rather than
 * relying on a session being created at startup.
 */
const SELECTED_SESSION_REQUEST = {
  id: 'sess-1',
  requestId: 'select-session-fixture',
}

const SESSION_FIXTURE = {
  id: 'sess-1',
  title: 'Test Session',
  status: 'active' as const,
  activityType: 'chat' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  chatPanelRenderLog.length = 0
  chatPanelInjections.length = 0
  vi.mocked(mockListSessions).mockResolvedValue([SESSION_FIXTURE])
  vi.mocked(mockFetchSession).mockImplementation(async (id) => ({
    ...SESSION_FIXTURE,
    id,
    title: id === SESSION_FIXTURE.id ? SESSION_FIXTURE.title : 'Scheduled run',
    activityType: id === SESSION_FIXTURE.id ? 'chat' : 'workflow',
  }))
  vi.mocked(mockListSessionTasks).mockResolvedValue([])
  vi.mocked(mockListCachedTeamBuilderTeams).mockResolvedValue([])
  vi.mocked(mockGetWorkflowStages).mockResolvedValue([])
  vi.mocked(mockGetSessionRunPlan).mockResolvedValue(null)
  vi.mocked(mockFetchRunEventsSnapshot).mockResolvedValue({ events: [] })
  vi.mocked(mockOpenRunEventStream).mockResolvedValue(undefined)
  vi.mocked(mockCreateSession).mockResolvedValue({
    id: 'sess-1',
    title: 'New Session',
    status: 'active',
    activityType: 'chat',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  vi.mocked(mockStartSessionTask).mockImplementation(async (_sessionId, target) => ({
    id: 'task-1',
    sessionId: 'sess-1',
    runId: 'run-1',
    workflowId: 'workflowId' in target ? target.workflowId : target.teamId,
    brief: 'Do the work',
    status: 'queued',
    createdAt: new Date().toISOString(),
    cwd: '/workspace',
  }))
  vi.mocked(mockSelectSessionWorkflow).mockImplementation(
    async (_sessionId, workflowId) => ({
      id: 'plan-selected',
      goal: 'Plan a website',
      summary: 'Ready',
      status: 'ready',
      selectedWorkflow: {
        id: workflowId,
        selectionSource: 'user',
        confidence: 'high',
        rationale: 'Explicitly selected.',
      },
      requiredInputs: [],
      brief: 'Plan a website for a specific audience and outcome.',
      actions: [],
      warnings: [],
      createdAt: new Date().toISOString(),
    }),
  )
  // Reset before the default, not just cleared. `clearAllMocks` drops the
  // recorded calls but keeps the queued one-shot implementations, so a
  // `mockResolvedValueOnce` that its own test never got as far as consuming
  // stays queued and answers the *next* test's cancel instead. That is not
  // hypothetical: breaking the composer's Workflow wiring made this cancel
  // resolve instantly two describes later, and the case that asserts the
  // cancel waits for the server failed for a reason that had nothing to do
  // with it.
  vi.mocked(mockCancelSessionTask).mockReset()
  vi.mocked(mockCancelSessionTask).mockResolvedValue({
    id: 'task-1',
    sessionId: 'sess-1',
    runId: 'run-1',
    workflowId: 'wf-1',
    brief: 'Do the work',
    status: 'cancelled',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    cwd: '/workspace',
    error: 'Cancelled by user',
  })
  vi.mocked(mockResumeSessionTask).mockResolvedValue({
    id: 'task-1',
    sessionId: 'sess-1',
    runId: 'run-1',
    workflowId: 'wf-1',
    brief: 'Do the work',
    status: 'running',
    createdAt: new Date().toISOString(),
    cwd: '/workspace',
    executionAttemptId: 'attempt-2',
    executionAttemptNumber: 2,
    executionKind: 'recovery',
    recoveryCount: 1,
  })
  vi.mocked(mockListAgents).mockResolvedValue([
    {
      name: 'analyst',
      description: 'Analyst agent',
      provider: 'openai',
      model: 'gpt-5.4',
      skills: ['analysis'],
      usedInTeams: [],
    },
    {
      name: 'writer',
      description: 'Writer agent',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      skills: ['writing'],
      usedInTeams: [],
    },
    {
      name: 'router-agent',
      description: 'Router agent',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      skills: ['routing'],
      usedInTeams: [],
    },
  ])
  vi.mocked(mockCheckAgentProviderHealth).mockResolvedValue([
    {
      agentName: 'analyst',
      provider: 'openai',
      model: 'gpt-5.4',
      status: 'ok',
      message: 'Provider responded.',
      checkedAt: new Date().toISOString(),
    },
    {
      agentName: 'writer',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      status: 'error',
      message: 'Provider credit balance is too low.',
      checkedAt: new Date().toISOString(),
    },
    {
      agentName: 'router-agent',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      status: 'ok',
      message: 'Provider responded.',
      checkedAt: new Date().toISOString(),
    },
  ])
  vi.mocked(mockReadAgentPersona).mockResolvedValue({
    name: 'analyst',
    description: 'Analyst agent',
    tier: 'strategic',
    provider: 'openai',
    model: 'gpt-5.4',
    thinking: 'medium',
    skills: ['analysis'],
    usedInTeams: [],
    personaMarkdown:
      '---\nname: analyst\nprovider: openai\nmodel: gpt-5.4\n---\n\nAnalyze the request.',
    personaPath: 'agents/analyst/analyst.md',
    agentPath: 'agents/analyst',
    frontmatter: {
      name: 'analyst',
      provider: 'openai',
      model: 'gpt-5.4',
    },
    skillDetails: [],
    assets: [],
    counts: {
      skills: 1,
      templates: 0,
      references: 0,
      scripts: 0,
      experience: 0,
      knowledge: 0,
      other: 0,
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * A Deep Research plan the user selected themselves, with intake unfinished.
 *
 * Selection provenance is what opens the workspace, and unfinished intake is
 * what keeps plan generation from starting — leaving the planning composer as
 * the only thing under test.
 */
function makeUserSelectedDeepResearchPlan() {
  return {
    id: 'plan-deep-research',
    goal: 'Research the launch evidence.',
    summary: 'Intake in progress.',
    status: 'needs_input' as const,
    selectedWorkflow: {
      id: 'deep-research-report',
      selectionSource: 'user' as const,
      confidence: 'high' as const,
      rationale: 'The user picked Deep Research.',
    },
    deepResearchIntakeComplete: false,
    requiredInputs: ['target audience'],
    brief: 'Research the launch evidence.',
    actions: [],
    warnings: [],
    createdAt: new Date().toISOString(),
  }
}

/**
 * Run opens on the Agents chat target. Every workflow execution surface —
 * templates picker, launch confirmation, task body — lives behind the
 * Workflows tab of the run target sidebar.
 */
function openWorkflowsTarget(): void {
  fireEvent.click(screen.getByRole('tab', { name: 'Workflows' }))
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('RunPanel — empty state', () => {
  it('opens a draft without creating a session, and reads nothing for it', async () => {
    render(<RunPanel />)

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    expect(mockCreateSession).not.toHaveBeenCalled()
    // A draft exists only on the client, so every session-scoped read would be
    // a 404 and none of them may be issued.
    expect(mockListSessionTasks).not.toHaveBeenCalled()
    expect(mockGetSessionRunPlan).not.toHaveBeenCalled()
  })

  it('selects a session the server already holds and reads it', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1')
    })
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('shows setup controls when a session is selected and no tasks exist', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    // Wait for sessions to load and first session to be auto-selected
    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    // The standalone upload section moved into the chat composer
    // (covered by chat-panel-files tests).
    expect(screen.queryByTestId('session-files')).not.toBeInTheDocument()
  })

  it('renders chat and run activity inside the animated workspace layout', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    const runActivity = screen.getByLabelText('Run activity')
    const runChat = screen.getByLabelText('Run chat')
    expect(runChat).toHaveAttribute('data-slot', 'chat-shell')
    expect(runChat.closest('[data-slot="panel-card"]')).toBeNull()
    expect(runActivity).not.toHaveAttribute('data-slot', 'panel-card')
    expect(runActivity.querySelector('[data-slot="panel-card"]')).toBeNull()
    expect(runActivity).not.toHaveClass('w-97.5')
  })

  it('loads a scheduler-created session before rendering its task inspector', async () => {
    const scheduledTask = {
      id: 'scheduled-task',
      sessionId: 'scheduled-session',
      runId: 'scheduled-run',
      workflowId: 'scheduled-agent-web-researcher',
      brief: 'Research the latest news.',
      status: 'done' as const,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      cwd: '/workspace',
    }
    vi.mocked(mockListSessionTasks).mockImplementation(async (sessionId) =>
      sessionId === 'scheduled-session' ? [scheduledTask] : [],
    )

    const { rerender } = render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    await waitFor(() => expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1'))

    rerender(
      <RunPanel
        sessionSelectionRequest={{
          id: 'scheduled-session',
          requestId: 'open-scheduled-result',
        }}
      />,
    )

    await waitFor(() => {
      expect(mockFetchSession).toHaveBeenCalledWith('scheduled-session')
      expect(mockListSessionTasks).toHaveBeenCalledWith('scheduled-session')
      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'done')
    })
  })

  it('shows agent setup in Chat mode and passes selected agents to the chat panel', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    // The run target sidebar filters what can be picked; it does not change
    // the kind of conversation. With nothing picked, no target is addressed.
    fireEvent.click(screen.getByRole('tab', { name: 'Workflows' }))
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-target', '')

    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))

    await waitFor(() => {
      expect(screen.getByText('Analyst')).toBeInTheDocument()
    })

    const analystName = screen.getByText('Analyst')
    const analystRowButton = analystName.closest('button')
    expect(analystRowButton).toBeInstanceOf(HTMLButtonElement)

    fireEvent.click(analystRowButton as HTMLButtonElement)

    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-target', 'agents')
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-agents', 'analyst')
    expect(mockReadAgentPersona).not.toHaveBeenCalled()
  })

  it('addresses the selected agent from the Deep Research planning composer', async () => {
    vi.mocked(mockGetSessionRunPlan).mockResolvedValue(
      makeUserSelectedDeepResearchPlan(),
    )

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    const workspace = await screen.findByTestId('deep-research-workspace')

    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    await waitFor(() => {
      expect(screen.getByText('Analyst')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Analyst').closest('button') as HTMLButtonElement)

    // The workspace is a way of working, not a second routing rule: the
    // planning composer carries the same target the sidebar just recorded.
    const planningChat = within(workspace).getByTestId('chat-panel')
    expect(planningChat).toHaveAttribute('data-target', 'agents')
    expect(planningChat).toHaveAttribute('data-agents', 'analyst')
  })

  it('restores the team workspace and workflow transcript for a persisted team-chat task', async () => {
    vi.mocked(mockListCachedTeamBuilderTeams).mockResolvedValueOnce([
      {
        id: 'problem-thinking-board',
        name: 'Problem Thinking Board',
        tags: [],
        agentCount: 2,
        agentNames: ['pragmatist', 'contrarian'],
        health: { status: 'ok', errors: [], warnings: [] },
      },
    ])
    vi.mocked(mockGetWorkflowStages).mockResolvedValueOnce([
      {
        id: 'run-problem-thinking-board',
        team: 'problem-thinking-board',
        discussions: [
          {
            levelId: 'deliberation',
            participants: ['pragmatist'],
            minRounds: 1,
            maxRounds: 1,
          },
        ],
      },
    ])
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'team-task',
        sessionId: 'sess-1',
        runId: 'team-run',
        workflowId: 'team-chat-problem-thinking-board',
        targetKind: 'team-chat',
        teamId: 'problem-thinking-board',
        brief: 'Compare desktop runtimes.',
        status: 'running',
        createdAt: new Date().toISOString(),
        cwd: '/workspace',
      },
    ])

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1'))
    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-mode',
        'running',
      )
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-workflow',
        'team-chat-problem-thinking-board',
      )
    })
    const participants = await screen.findByLabelText('Team participants')
    await waitFor(() => expect(participants).toHaveTextContent('Pragmatist'))
    expect(participants).toHaveTextContent('Contrarian')
    // The Team is what the transcript is showing, not what the composer is
    // addressing: nobody has picked a target in this restored session.
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-presentation-team',
      'problem-thinking-board',
    )
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-team', '')
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-team-run-active',
      'false',
    )
    expect(screen.queryByText('Discussion Flow')).not.toBeInTheDocument()
    expect(screen.queryByText('Initial brief')).not.toBeInTheDocument()
    expect(screen.queryByText('Round 1')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-show-workflow-messages',
      'true',
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-presentation-team',
      'problem-thinking-board',
    )
  })

  it('keeps a finished Team discussion visible without making it the next target', async () => {
    vi.mocked(mockListCachedTeamBuilderTeams).mockResolvedValue([
      {
        id: 'problem-thinking-board',
        name: 'Problem Thinking Board',
        tags: [],
        agentCount: 2,
        agentNames: ['pragmatist', 'contrarian'],
        health: { status: 'ok', errors: [], warnings: [] },
      },
    ])
    vi.mocked(mockGetWorkflowStages).mockResolvedValueOnce([
      {
        id: 'run-problem-thinking-board',
        team: 'problem-thinking-board',
        discussions: [
          {
            levelId: 'deliberation',
            participants: ['pragmatist'],
            minRounds: 1,
            maxRounds: 1,
          },
        ],
      },
    ])
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'team-task',
        sessionId: 'sess-1',
        runId: 'team-run',
        workflowId: 'team-chat-problem-thinking-board',
        targetKind: 'team-chat',
        teamId: 'problem-thinking-board',
        brief: 'Compare desktop runtimes.',
        status: 'done',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        cwd: '/workspace',
      },
    ])

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1'))
    const participants = await screen.findByLabelText('Team participants')
    await waitFor(() => expect(participants).toHaveTextContent('Pragmatist'))

    // What happened is still on screen…
    const chatPanel = screen.getByTestId('chat-panel')
    expect(chatPanel).toHaveAttribute(
      'data-presentation-team',
      'problem-thinking-board',
    )
    expect(chatPanel).toHaveAttribute('data-show-workflow-messages', 'true')

    // …and the next turn is addressed to nobody until the user says otherwise.
    expect(chatPanel).toHaveAttribute('data-target', '')
    expect(chatPanel).toHaveAttribute('data-team', '')
    expect(chatPanel).toHaveAttribute('data-team-run-active', 'false')

    fireEvent.click(screen.getByRole('tab', { name: 'Teams' }))
    expect(
      await screen.findByRole('radio', { name: /Problem Thinking Board/ }),
    ).not.toBeChecked()
  })

  it('keeps the discussion on the Team that held it when another Team is picked', async () => {
    vi.mocked(mockListCachedTeamBuilderTeams).mockResolvedValue([
      {
        id: 'problem-thinking-board',
        name: 'Problem Thinking Board',
        tags: [],
        agentCount: 2,
        agentNames: ['pragmatist', 'contrarian'],
        health: { status: 'ok', errors: [], warnings: [] },
      },
      {
        id: 'venture-capital-team',
        name: 'Venture Capital Team',
        tags: [],
        agentCount: 2,
        agentNames: ['investor', 'founder'],
        health: { status: 'ok', errors: [], warnings: [] },
      },
    ])
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'team-task',
        sessionId: 'sess-1',
        runId: 'team-run',
        workflowId: 'team-chat-problem-thinking-board',
        targetKind: 'team-chat',
        teamId: 'problem-thinking-board',
        brief: 'Compare desktop runtimes.',
        status: 'done',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        cwd: '/workspace',
      },
    ])

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1'))
    const participants = await screen.findByLabelText('Team participants')
    await waitFor(() => expect(participants).toHaveTextContent('Pragmatist'))

    fireEvent.click(screen.getByRole('tab', { name: 'Teams' }))
    fireEvent.click(
      await screen.findByRole('radio', { name: /Venture Capital Team/ }),
    )

    // The rail describes the discussion that happened. Another Team may be a
    // target for what comes next, but it never re-labels who already spoke.
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-presentation-team',
      'problem-thinking-board',
    )
    expect(screen.getByLabelText('Team participants')).toHaveTextContent(
      'Pragmatist',
    )
    expect(screen.getByLabelText('Team participants')).not.toHaveTextContent(
      'Investor',
    )
  })

  it('reports a locked run target once a Team run owns the session', async () => {
    const onRunTargetLockChange = vi.fn()
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'team-task',
        sessionId: 'sess-1',
        runId: 'team-run',
        workflowId: 'team-chat-problem-thinking-board',
        targetKind: 'team-chat',
        teamId: 'problem-thinking-board',
        brief: 'Compare desktop runtimes.',
        status: 'done',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        cwd: '/workspace',
      },
    ])

    render(
      <RunPanel
        sessionSelectionRequest={SELECTED_SESSION_REQUEST}
        onRunTargetLockChange={onRunTargetLockChange}
      />,
    )

    await waitFor(() =>
      expect(onRunTargetLockChange).toHaveBeenLastCalledWith('team-history'),
    )
  })

  it('lets the composer stop the Team run it is addressing', async () => {
    vi.mocked(mockListCachedTeamBuilderTeams).mockResolvedValue([
      {
        id: 'problem-thinking-board',
        name: 'Problem Thinking Board',
        tags: [],
        agentCount: 2,
        agentNames: ['pragmatist', 'contrarian'],
        health: { status: 'ok', errors: [], warnings: [] },
      },
    ])
    const runningTeamTask: Awaited<ReturnType<typeof mockCancelSessionTask>> = {
      id: 'team-task',
      sessionId: 'sess-1',
      runId: 'team-run',
      workflowId: 'team-chat-problem-thinking-board',
      targetKind: 'team-chat',
      teamId: 'problem-thinking-board',
      brief: 'Compare desktop runtimes.',
      status: 'running',
      createdAt: new Date().toISOString(),
      cwd: '/workspace',
    }
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningTeamTask])
    vi.mocked(mockCancelSessionTask).mockResolvedValueOnce({
      ...runningTeamTask,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() =>
      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'running'),
    )
    // Nobody is addressing the Team yet, so the composer has nothing to stop.
    expect(
      screen.queryByRole('button', { name: 'Stop Team run' }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Teams' }))
    fireEvent.click(
      await screen.findByRole('radio', { name: /Problem Thinking Board/ }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-team-run-active',
        'true',
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop Team run' }))

    // The same stop the run pane offers: that task, and nothing else. Once the
    // server confirms it, the Team is no longer running and the composer is free.
    await waitFor(() =>
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-team-run-active',
        'false',
      ),
    )
    expect(mockCancelSessionTask).toHaveBeenCalledWith('sess-1', 'team-task')
  })

  /**
   * The Workflow half of the same wiring.
   *
   * The rule that decides the notice and the composer that renders it are both
   * covered on their own; this is the only test that joins them, so it is the
   * only thing standing between a user and a composer that goes back to
   * looking idle through a whole multi-step run.
   */
  it('lets the composer stop the Workflow run it is showing', async () => {
    const runningWorkflowTask: Awaited<ReturnType<typeof mockCancelSessionTask>> = {
      id: 'wf-task',
      sessionId: 'sess-1',
      runId: 'wf-run',
      workflowId: 'writing-workflow',
      brief: 'Write the selected result.',
      status: 'running',
      createdAt: new Date().toISOString(),
      cwd: '/workspace',
    }
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningWorkflowTask])
    vi.mocked(mockCancelSessionTask).mockResolvedValueOnce({
      ...runningWorkflowTask,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    // Named by the Workflow the user chose, in the composer, without being
    // asked for: this run owns the conversation for as long as it lasts.
    await waitFor(() =>
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-workflow-run-notice',
        'Writing Workflow is running. Chat is paused until it finishes, ' +
          'or until you stop the run.',
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop workflow run' }))

    // The same stop the Queue overview offers: that task, and nothing else.
    // Once the server confirms it, the run no longer owns the composer.
    await waitFor(() =>
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-workflow-run-notice',
        '',
      ),
    )
    expect(mockCancelSessionTask).toHaveBeenCalledWith('sess-1', 'wf-task')
    expect(
      screen.queryByRole('button', { name: 'Stop workflow run' }),
    ).not.toBeInTheDocument()
  })

  it('leaves the run target open for a session that ran an ordinary workflow', async () => {
    const onRunTargetLockChange = vi.fn()
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'ordinary-task',
        sessionId: 'sess-1',
        runId: 'ordinary-run',
        workflowId: 'writing-workflow',
        brief: 'Write the selected result.',
        status: 'done',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        cwd: '/workspace',
      },
    ])

    render(
      <RunPanel
        sessionSelectionRequest={SELECTED_SESSION_REQUEST}
        onRunTargetLockChange={onRunTargetLockChange}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-workflow',
        'writing-workflow',
      )
    })
    expect(onRunTargetLockChange).toHaveBeenLastCalledWith(null)
  })

  it('shows a safe startup failure in Team chat when the root run fails before an agent starts', async () => {
    const rawFailure = [
      'Configuration errors:',
      "Host provider 'claude' is not supported.",
      'Child stderr: token=secret-value',
      'Assignment: /Users/example/private/run',
    ].join('\n')
    vi.mocked(mockListCachedTeamBuilderTeams).mockResolvedValueOnce([
      {
        id: 'crypto-investment-board',
        name: 'Crypto Investment Board',
        tags: [],
        agentCount: 2,
        agentNames: ['crypto-investment-lead', 'contrarian'],
        health: { status: 'ok', errors: [], warnings: [] },
      },
    ])
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'team-task',
        sessionId: 'sess-1',
        runId: 'team-run',
        workflowId: 'team-chat-crypto-investment-board',
        targetKind: 'team-chat',
        teamId: 'crypto-investment-board',
        brief: 'Discuss crypto.',
        status: 'failed',
        createdAt: '2026-09-03T03:54:23.000Z',
        completedAt: '2026-09-03T03:54:27.000Z',
        cwd: '/workspace',
        error: rawFailure,
      },
    ])
    vi.mocked(mockFetchRunEventsSnapshot).mockResolvedValue({
      events: [
        {
          schema_version: 1,
          timestamp: '2026-09-03T03:54:27.000Z',
          tenant_id: 'local',
          category: 'runtime',
          type: 'run.failed',
          run_id: 'team-run',
          root_run_id: 'team-run',
          payload: { error: rawFailure },
        },
      ],
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-workflow-messages',
        'The Team could not start. Its configuration or provider setup needs attention before you try again.',
      )
    })
    const visibleMessages = screen
      .getByTestId('chat-panel')
      .getAttribute('data-workflow-messages')
    expect(visibleMessages).not.toContain('secret-value')
    expect(visibleMessages).not.toContain('/Users/example')
  })

  it('does not apply an older Team-chat presentation to a newer ordinary workflow', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'team-task',
        sessionId: 'sess-1',
        runId: 'team-run',
        workflowId: 'team-chat-problem-thinking-board',
        targetKind: 'team-chat',
        brief: 'Compare desktop runtimes.',
        status: 'done',
        createdAt: '2026-05-01T12:00:00.000Z',
        completedAt: '2026-05-01T12:01:00.000Z',
        cwd: '/workspace',
      },
      {
        id: 'ordinary-task',
        sessionId: 'sess-1',
        runId: 'ordinary-run',
        workflowId: 'writing-workflow',
        brief: 'Write the selected result.',
        status: 'running',
        createdAt: '2026-05-01T12:02:00.000Z',
        cwd: '/workspace',
      },
    ])

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-workflow',
        'writing-workflow',
      )
    })
    // The subject is the presentation, not message visibility: an ordinary
    // workflow run shows its replies in the conversation like any other, but
    // it is not addressed to a Team.
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-team', '')
  })

  it('does not treat a user workflow with a team-chat prefix as a Team target', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'ordinary-task',
        sessionId: 'sess-1',
        runId: 'ordinary-run',
        workflowId: 'team-chat-user-authored-workflow',
        brief: 'Run my ordinary workflow.',
        status: 'running',
        createdAt: '2026-05-01T12:02:00.000Z',
        cwd: '/workspace',
      },
    ])

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-workflow',
        'team-chat-user-authored-workflow',
      )
    })
    expect(screen.queryByLabelText('Team participants')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-team', '')
  })

  it('shows WorkflowPicker in the empty state', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
  })

  it('shows Begin workflow in chat after a ready RunPlan selects a workflow', async () => {
    const onSessionActivityStarted = vi.fn()
    render(
      <RunPanel
        onSessionActivityStarted={onSessionActivityStarted}
        sessionSelectionRequest={SELECTED_SESSION_REQUEST}
      />,
    )
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Mark user message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))

    const beginButton = screen.getByRole('button', { name: 'Begin workflow' })
    expect(beginButton).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()

    fireEvent.click(beginButton)
    await waitFor(() => {
      expect(mockStartSessionTask).toHaveBeenCalledWith(
        'sess-1',
        { workflowId: 'wf-1' },
        undefined,
        undefined,
        [],
      )
    })
    expect(onSessionActivityStarted).toHaveBeenCalledWith('sess-1')
  })

  it('shows the stored reply to a refused task start as that stored message', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()
    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark user message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))

    // The server refuses the start and stores its reply in the conversation.
    const storedReply: ChatMessage = {
      id: 'stored-brief-reply',
      role: 'assistant',
      text: 'What would you like this work to be about?',
      createdAt: '2026-05-01T12:00:05.000Z',
    }
    vi.mocked(mockStartSessionTask).mockRejectedValueOnce(
      new SessionTaskStartError('Brief required', storedReply),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Begin workflow' }))

    // The chat is given the stored message itself, so the next transcript
    // read recognises it instead of showing it a second time.
    await waitFor(() => expect(chatPanelInjections).toHaveLength(1))
    expect(chatPanelInjections[0]).toEqual({
      role: 'assistant',
      text: storedReply.text,
      id: storedReply.id,
      createdAt: storedReply.createdAt,
    })
  })

  it('disables Begin workflow while the receptionist is updating the run plan', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))

    const beginButton = screen.getByRole('button', { name: 'Begin workflow' })
    expect(beginButton).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Mark receptionist pending' }))
    expect(beginButton).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Mark receptionist idle' }))
    expect(beginButton).toBeEnabled()
  })

  it('passes the composer project selection into Begin workflow admission', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark user message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select project context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Begin workflow' }))

    await waitFor(() => {
      expect(mockStartSessionTask).toHaveBeenCalledWith(
        'sess-1',
        { workflowId: 'wf-1' },
        undefined,
        {
          projectId: '11111111-1111-4111-8111-111111111111',
          includeBrief: true,
          fileNames: ['facts.md'],
        },
        [],
      )
    })
  })

  it('reports a chat-triggered or Deep Research task start for sidebar collapse', async () => {
    const onSessionActivityStarted = vi.fn()
    render(
      <RunPanel
        onSessionActivityStarted={onSessionActivityStarted}
        sessionSelectionRequest={SELECTED_SESSION_REQUEST}
      />,
    )

    await waitFor(() => {
      expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark chat task started' }))

    expect(onSessionActivityStarted).toHaveBeenCalledWith('sess-1')
  })

  it('enables Begin workflow when a ready plan arrives before user-message presence', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))

    const beginButton = screen.getByRole('button', { name: 'Begin workflow' })
    expect(beginButton).toBeEnabled()

    fireEvent.click(beginButton)
    await waitFor(() => {
      expect(mockStartSessionTask).toHaveBeenCalledWith(
        'sess-1',
        { workflowId: 'wf-1' },
        undefined,
        undefined,
        [],
      )
    })
  })

  it('shows workflow validation detail and applies the failed server plan', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))
    const beginButton = screen.getByRole('button', { name: 'Begin workflow' })
    expect(beginButton).toBeEnabled()
    vi.mocked(mockStartSessionTask).mockRejectedValueOnce(
      new SessionTaskStartError(
        'Workflow is invalid',
        undefined,
        "Step 'clarify' has discussion settings on a routing stage.",
        {
          id: 'plan-failed',
          goal: 'Plan a website',
          summary: 'Workflow launch failed.',
          status: 'failed',
          selectedWorkflow: {
            id: 'wf-1',
            selectionSource: 'user',
            confidence: 'high',
            rationale: 'Matched the request.',
          },
          requiredInputs: [],
          brief: 'Plan a website',
          actions: [],
          warnings: [],
          createdAt: new Date().toISOString(),
        },
      ),
    )

    fireEvent.click(beginButton)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to start task', {
        description: "Step 'clarify' has discussion settings on a routing stage.",
      })
      expect(
        screen.queryByRole('button', { name: 'Begin workflow' }),
      ).not.toBeInTheDocument()
    })
  })

  it('rehydrates a persisted ready plan with the chat launch confirmation', async () => {
    vi.mocked(mockGetSessionRunPlan).mockResolvedValue({
      id: 'persisted-plan',
      goal: 'Write an objective report',
      summary: 'Ready',
      status: 'ready',
      selectedWorkflow: {
        id: 'wf-1',
        selectionSource: 'user',
        confidence: 'high',
        rationale: 'Persisted selection.',
      },
      requiredInputs: [],
      actions: [],
      warnings: [],
      createdAt: new Date().toISOString(),
    })
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    const beginButton = await screen.findByRole('button', {
      name: 'Begin workflow',
    })
    await waitFor(() => expect(beginButton).toBeEnabled())
    expect(screen.getByTestId('workflow-launch-confirmation')).toBeInTheDocument()
  })

  it('does not let late plan hydration overwrite a newer chat plan', async () => {
    type HydratedPlan = Awaited<ReturnType<typeof mockGetSessionRunPlan>>
    let resolveHydration!: (plan: HydratedPlan) => void
    const hydration = new Promise<HydratedPlan>((resolve) => {
      resolveHydration = resolve
    })
    vi.mocked(mockGetSessionRunPlan).mockReturnValue(hydration)
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))
    const beginButton = screen.getByRole('button', { name: 'Begin workflow' })
    expect(beginButton).toBeEnabled()

    await act(async () => {
      resolveHydration({
        id: 'older-plan',
        goal: 'Older request',
        summary: 'Still needs input',
        status: 'needs_input',
        requiredInputs: ['workflow selection'],
        actions: [],
        warnings: [],
        createdAt: new Date().toISOString(),
      })
      await hydration
    })

    expect(beginButton).toBeEnabled()
  })

  it('reloads and displays a task started from chat', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1')
    })
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'chat-task',
        sessionId: 'sess-1',
        runId: 'chat-run',
        workflowId: 'wf-1',
        brief: 'Chat-started work',
        status: 'running',
        createdAt: new Date().toISOString(),
        cwd: '/workspace',
      },
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Mark chat task started' }))

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-mode',
        'running',
      )
      expect(mockListSessionTasks).toHaveBeenCalledTimes(2)
      expect(mockOpenRunEventStream).toHaveBeenCalled()
    })
  })

  it('does not show a launch confirmation while task details are missing', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Mark user message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark thin plan' }))

    expect(
      screen.queryByRole('button', { name: 'Begin workflow' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(mockStartSessionTask).not.toHaveBeenCalled()
  })

  it('does not show a launch confirmation while the RunPlan is not ready', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Mark user message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark stalled plan' }))

    expect(
      screen.queryByRole('button', { name: 'Begin workflow' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(mockStartSessionTask).not.toHaveBeenCalled()
  })

  it('uses the explicit approval-and-launch gate for a Deep Research proposal', async () => {
    vi.mocked(mockGetSessionRunPlan).mockResolvedValueOnce({
      id: 'deep-plan-pending',
      goal: 'Research enterprise adoption evidence',
      summary: 'Proposal awaiting approval',
      status: 'ready',
      selectedWorkflow: {
        id: 'deep-research-report',
        selectionSource: 'user',
        confidence: 'high',
        rationale: 'Deep research requested.',
      },
      deepResearchIntakeComplete: true,
      researchPlan: {
        schemaVersion: 1,
        planId: 'research-plan-1',
        requestId: 'request-1',
        request: {
          schemaVersion: 1,
          requestId: 'request-1',
          question: 'What evidence supports enterprise adoption?',
          objective: 'Produce an evidence-backed adoption recommendation.',
          audience: 'Enterprise decision makers',
          includedScope: ['Enterprise adoption'],
          excludedScope: [],
          desiredSections: ['Adoption evidence'],
          jurisdictions: [],
          freshnessAsOf: new Date().toISOString(),
          authenticatedDomains: [],
          sourceRequirements: ['Prefer primary sources'],
          maxDurationMinutes: 20,
          maxResearcherAgents: 8,
          outputFormats: ['markdown', 'docx'],
        },
        sections: [],
        tasks: [],
        workerSpecs: [],
        maxDurationMinutes: 20,
        maxResearcherAgents: 8,
        expectedPeakWorkers: 1,
        authenticatedDomains: [],
      },
      researchPlanProposalHash: 'a'.repeat(64),
      requiredInputs: [],
      actions: [],
      warnings: [],
      createdAt: new Date().toISOString(),
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() =>
      expect(screen.getByText('Proposed Research Plan')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('button', { name: 'Begin workflow' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Approve & start research' }),
    ).toBeEnabled()
    expect(mockStartSessionTask).not.toHaveBeenCalled()
  })

  it('persists a workflow choice to resolve a workflow-selection dead end', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark user message' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Mark workflow-selection plan' }),
    )

    expect(
      screen.queryByRole('button', { name: 'Begin workflow' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('workflow-picker'))

    await waitFor(() => {
      expect(mockSelectSessionWorkflow).toHaveBeenCalledWith(
        'sess-1',
        'wf-1',
        'plan-workflow-needed',
      )
      expect(
        screen.getByRole('button', { name: 'Begin workflow' }),
      ).toBeEnabled()
    })
  })

  it('restores the persisted workflow when selection persistence fails', async () => {
    vi.mocked(mockSelectSessionWorkflow).mockRejectedValue(
      new Error('Run plan changed'),
    )
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))
    const beginButton = screen.getByRole('button', { name: 'Begin workflow' })
    expect(beginButton).toBeEnabled()

    fireEvent.click(screen.getByTestId('workflow-picker-stale'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to select workflow', {
        description: 'Run plan changed',
      })
    })

    // Begin offers only the workflow the ready plan was built for, so it is
    // withheld while a different selection is in flight and returns once the
    // failed selection has rolled back. Re-query rather than reuse the node
    // captured before that transition.
    const restoredBeginButton = await screen.findByRole('button', {
      name: 'Begin workflow',
    })
    expect(restoredBeginButton).toBeEnabled()

    fireEvent.click(restoredBeginButton)
    await waitFor(() => {
      expect(mockStartSessionTask).toHaveBeenCalledWith(
        'sess-1',
        { workflowId: 'wf-1' },
        undefined,
        undefined,
        [],
      )
    })
  })

  it('carries a workflow picked before any plan into the next message', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    // Nothing has been said yet, so there is no plan to persist the choice
    // against. The pick still has to reach the next turn, or the user selects a
    // Workflow and is then answered as though they had not.
    fireEvent.click(screen.getAllByTestId('workflow-picker')[0]!)

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-target',
        'workflow',
      )
    })
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-target-workflow',
      'wf-1',
    )
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-target-expects',
      'null',
    )
  })

  it('does not race the picker when a workflow is picked against an existing plan', async () => {
    // The picker persists this selection itself. If the next message also
    // carried it, both would compare-and-set the same plan and one would be
    // rejected for work the user did once.
    vi.mocked(mockSelectSessionWorkflow).mockImplementationOnce(
      () => new Promise(() => undefined),
    )
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))
    fireEvent.click(screen.getByTestId('workflow-picker-stale'))

    await waitFor(() => {
      expect(mockSelectSessionWorkflow).toHaveBeenCalled()
    })
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-target', '')
  })

  it('selects a workflow from the preview list and starts it after user context exists', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    expect(
      screen.queryByRole('button', { name: 'Begin workflow' }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByTestId('workflow-picker')[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Mark user message' }))

    // Both clicks change state, and the button is what the second one makes
    // appear. Reading it synchronously assumes the commit has already flushed,
    // which held on an idle machine and failed once under full-suite load.
    // Await the transition this test is actually about.
    const beginButton = await screen.findByRole('button', { name: 'Begin workflow' })
    expect(beginButton).toBeEnabled()

    fireEvent.click(beginButton)
    await waitFor(() => {
      expect(mockStartSessionTask).toHaveBeenCalledWith(
        'sess-1',
        { workflowId: 'wf-1' },
        undefined,
        undefined,
        [],
      )
    })
  })

  it('uses the latest RunPlan workflow instead of a stale manual selection', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Mark user message' }))
    fireEvent.click(screen.getByTestId('workflow-picker-stale'))
    fireEvent.click(screen.getByRole('button', { name: 'Mark alternate ready plan' }))

    const beginButton = screen.getByRole('button', { name: 'Begin workflow' })
    expect(beginButton).toBeEnabled()

    fireEvent.click(beginButton)
    await waitFor(() => {
      expect(mockStartSessionTask).toHaveBeenCalledWith(
        'sess-1',
        { workflowId: 'wf-2' },
        undefined,
        undefined,
        [],
      )
    })
  })
})

describe('RunPanel — queued task state', () => {
  const queuedTaskRecord = {
    id: 'task-queued',
    sessionId: 'sess-1',
    runId: 'run-queued',
    workflowId: 'wf-1',
    brief: 'Wait for capacity',
    status: 'queued' as const,
    createdAt: '2026-05-01T12:00:00.000Z',
    cwd: '/workspace',
  }
  const queuedTask = {
    ...queuedTaskRecord,
    admission: {
      version: 1 as const,
      phase: 'pending' as const,
      requestId: 'request-queued',
      order: '4',
      requestedAt: '2026-05-01T12:00:00.000Z',
      executionKind: 'initial' as const,
      source: 'apply' as const,
      expectedExecutionAttemptId: null,
    },
  }

  it('renders an accepted start as queued, keeps Cancel enabled, and opens its stream', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Begin workflow' }))

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'queued')
    })
    expect(screen.getByRole('button', { name: 'Stop workflow' })).toBeEnabled()
    expect(mockOpenRunEventStream).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
    )
    expect(toast.success).toHaveBeenCalledWith('Task queued', {
      description: 'Waiting for execution capacity. It will start automatically.',
    })
  })

  it('promotes a queued task when the durable workflow-start event arrives', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        ...queuedTask,
        executionAttemptId: 'attempt-current',
        admission: {
          ...queuedTask.admission,
          phase: 'granted' as const,
          grantId: 'grant-current',
          ownerEpoch: 'owner-current',
          grantedAt: '2026-05-01T12:00:04.000Z',
          executionAttemptId: 'attempt-current',
        },
      },
    ])
    vi.mocked(mockOpenRunEventStream).mockImplementation(async ({ onEvent }) => {
      onEvent('started-1', {
        schema_version: 1,
        timestamp: '2026-05-01T12:00:05.000Z',
        tenant_id: 'local',
        category: 'runtime',
        type: 'session_task.workflow_started',
        run_id: 'run-queued',
        payload: { execution_attempt_id: 'attempt-current' },
      })
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'running')
    })
  })

  it('ignores a live worker-start event from a prior recovery attempt', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        ...queuedTask,
        executionAttemptId: 'attempt-current',
        admission: {
          ...queuedTask.admission,
          phase: 'granted' as const,
          executionKind: 'recovery' as const,
          source: 'manual_resume' as const,
          expectedExecutionAttemptId: 'attempt-prior',
          grantId: 'grant-current',
          ownerEpoch: 'owner-current',
          grantedAt: '2026-05-01T12:00:04.000Z',
          executionAttemptId: 'attempt-current',
        },
      },
    ])
    vi.mocked(mockOpenRunEventStream).mockImplementation(async ({ onEvent }) => {
      onEvent('started-stale', {
        schema_version: 1,
        timestamp: '2026-05-01T12:00:05.000Z',
        tenant_id: 'local',
        category: 'runtime',
        type: 'session_task.workflow_started',
        run_id: 'run-queued',
        payload: { execution_attempt_id: 'attempt-prior' },
      })
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    expect(await screen.findByTestId('task-body')).toHaveAttribute(
      'data-mode',
      'queued',
    )
  })

  it('promotes a queued task from the persisted task refresh', async () => {
    vi.mocked(mockListSessionTasks)
      .mockResolvedValueOnce([queuedTask])
      .mockResolvedValue([
        {
          ...queuedTaskRecord,
          status: 'running',
          workerStartedAt: '2026-05-01T12:00:05.000Z',
        },
      ])

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    expect(await screen.findByTestId('task-body')).toHaveAttribute(
      'data-mode',
      'queued',
    )
    await waitFor(
      () => {
        expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'running')
      },
      { timeout: 3_000 },
    )
  })

  it('does not treat a prior recovery attempt start event as the queued attempt starting', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        ...queuedTask,
        status: 'interrupted',
        executionAttemptId: 'attempt-1',
        admission: {
          ...queuedTask.admission,
          executionKind: 'recovery',
          source: 'manual_resume',
          expectedExecutionAttemptId: 'attempt-1',
        },
      },
    ])
    vi.mocked(mockFetchRunEventsSnapshot).mockResolvedValue({
      events: [
        {
          schema_version: 1,
          timestamp: '2026-05-01T12:00:01.000Z',
          tenant_id: 'local',
          category: 'runtime',
          type: 'session_task.workflow_started',
          run_id: 'run-queued',
          payload: { execution_attempt_id: 'attempt-1' },
        },
      ],
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    expect(await screen.findByTestId('task-body')).toHaveAttribute(
      'data-mode',
      'queued',
    )
  })
})

describe('RunPanel — workflow chat event projection', () => {
  it('projects agent responses from every session task and restores pending work', async () => {
    vi.mocked(mockGetWorkflowStages).mockResolvedValue([
      {
        id: 'discuss',
        team: 'problem-thinking-board',
        discussions: [
          {
            levelId: 'discussion',
            participants: ['critic'],
            minRounds: 2,
            maxRounds: 2,
          },
        ],
      },
      {
        id: 'write',
        team: 'writing-team',
      },
    ])
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        id: 'task-a',
        sessionId: 'sess-1',
        runId: 'run-a',
        workflowId: 'wf-1',
        brief: 'First task',
        status: 'done',
        createdAt: '2026-05-01T12:00:00.000Z',
        completedAt: '2026-05-01T12:01:00.000Z',
        cwd: '/workspace',
      },
      {
        id: 'task-b',
        sessionId: 'sess-1',
        runId: 'run-b',
        workflowId: 'wf-2',
        brief: 'Second task',
        status: 'running',
        createdAt: '2026-05-01T12:02:00.000Z',
        cwd: '/workspace',
      },
    ])
    vi.mocked(mockFetchRunEventsSnapshot).mockImplementation(async (runId) => ({
      events: runId === 'run-a'
        ? [
            {
              schema_version: 1,
              timestamp: '2026-05-01T12:00:30.000Z',
              tenant_id: 'local',
              category: 'stage',
              type: 'discussion.message',
              run_id: 'child-a',
              root_run_id: 'run-a',
              payload: {
                agent_name: 'Analyst',
                message_type: 'position',
                round: 1,
                text: 'Analysis from task A',
              },
            },
          ]
        : [
            {
              schema_version: 1,
              timestamp: '2026-05-01T12:02:30.000Z',
              tenant_id: 'local',
              category: 'stage',
              type: 'discussion.message',
              run_id: 'child-b',
              root_run_id: 'run-b',
              payload: {
                agent_name: 'Critic',
                message_type: 'position',
                round: 1,
                text: 'Critique from task B',
              },
            },
            {
              schema_version: 1,
              timestamp: '2026-05-01T12:02:31.000Z',
              tenant_id: 'local',
              category: 'agent',
              type: 'agent.start',
              run_id: 'child-b',
              root_run_id: 'run-b',
              payload: { agent_name: 'Writer' },
            },
          ],
    }))

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-workflow-messages',
        'Analysis from task A|Critique from task B',
      )
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-workflow-pending',
        'Writer',
      )
    })
    const journey = await screen.findByLabelText('Discussion Journey')
    expect(journey).toHaveTextContent('Discussion Flow')
    expect(journey).toHaveTextContent('Round 1')
    await waitFor(() => expect(journey).toHaveTextContent('Round 2'))
    expect(within(journey).getByText('CR')).toBeInTheDocument()
    expect(within(journey).getByText('WR')).toBeInTheDocument()
  })

  it('never projects the previous session workflow into a newly selected session', async () => {
    vi.mocked(mockListSessionTasks).mockImplementation(async (sessionId) =>
      sessionId === 'sess-1'
        ? [
            {
              id: 'task-old',
              sessionId: 'sess-1',
              runId: 'run-old',
              workflowId: 'wf-old',
              brief: 'Old session brief',
              status: 'done',
              createdAt: '2026-05-01T12:00:00.000Z',
              completedAt: '2026-05-01T12:01:00.000Z',
              cwd: '/workspace',
            },
          ]
        : [],
    )
    vi.mocked(mockFetchRunEventsSnapshot).mockResolvedValue({
      events: [
        {
          schema_version: 1,
          timestamp: '2026-05-01T12:00:30.000Z',
          tenant_id: 'local',
          category: 'stage',
          type: 'discussion.message',
          run_id: 'child-old',
          root_run_id: 'run-old',
          payload: {
            agent_name: 'Problem Decomposer',
            text: 'Previous session routing brief',
          },
        },
      ],
    })

    const { rerender } = render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-workflow-messages',
        'Previous session routing brief',
      )
    })
    chatPanelRenderLog.length = 0

    rerender(
      <RunPanel
        sessionSelectionRequest={{ id: 'sess-fresh', requestId: 'switch-1' }}
      />,
    )

    await waitFor(() => {
      expect(
        chatPanelRenderLog.some((entry) => entry.sessionId === 'sess-fresh'),
      ).toBe(true)
    })
    expect(
      chatPanelRenderLog
        .filter((entry) => entry.sessionId === 'sess-fresh')
        .flatMap((entry) => entry.workflowMessages),
    ).not.toContain('Previous session routing brief')
  })
})

describe('RunPanel — task cancellation', () => {
  const runningTask = {
    id: 'task-running',
    sessionId: 'sess-1',
    runId: 'run-running',
    workflowId: 'wf-1',
    brief: 'Do the work',
    status: 'running' as const,
    createdAt: '2026-05-01T12:00:00.000Z',
    cwd: '/workspace',
  }

  it('waits for the server before marking a task cancelled', async () => {
    let emitEvent: ((id: string, event: EngineEventEnvelope) => void) | undefined
    let resolveCancellation!: (task: Awaited<ReturnType<typeof mockCancelSessionTask>>) => void
    const cancellation = new Promise<Awaited<ReturnType<typeof mockCancelSessionTask>>>(
      (resolve) => {
        resolveCancellation = resolve
      },
    )
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningTask])
    vi.mocked(mockCancelSessionTask).mockReturnValue(cancellation)
    vi.mocked(mockOpenRunEventStream).mockImplementation(async ({ onEvent }) => {
      emitEvent = onEvent
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    const cancelButton = await screen.findByRole('button', {
      name: 'Stop workflow',
    })
    await act(async () => {
      emitEvent?.('domain-researcher-started', {
        schema_version: 1,
        timestamp: '2026-05-01T12:00:30.000Z',
        tenant_id: 'local',
        category: 'agent',
        type: 'agent.start',
        run_id: 'discussion-child-run',
        root_run_id: 'run-running',
        payload: { agent_name: 'Domain Researcher' },
      })
    })
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-workflow-pending',
      'Domain Researcher',
    )
    fireEvent.click(cancelButton)

    expect(mockCancelSessionTask).toHaveBeenCalledWith('sess-1', 'task-running')
    expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'running')

    resolveCancellation({
      ...runningTask,
      status: 'cancelled',
      completedAt: '2026-05-01T12:01:00.000Z',
      error: 'Cancelled by user',
    })

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-mode',
        'cancelled',
      )
    })
    expect(screen.getByTestId('task-body')).toHaveTextContent('Cancelled by user')
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-workflow-pending',
      '',
    )
    expect(toast.success).toHaveBeenCalledWith('Task cancelled', {
      description: 'Cancelled by user',
    })
  })

  it('keeps the task running and surfaces a server cancellation error', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningTask])
    vi.mocked(mockCancelSessionTask).mockRejectedValue(
      new Error('Task cancellation failed'),
    )

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Stop workflow' }),
    )

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to cancel task', {
        description: 'Task cancellation failed',
      })
    })
    expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'running')
  })
})

describe('RunPanel — interrupted task recovery', () => {
  const interruptedTaskBase = {
    id: 'task-interrupted',
    sessionId: 'sess-1',
    runId: 'run-interrupted',
    workflowId: 'wf-1',
    brief: 'Recover the work',
    status: 'interrupted' as const,
    createdAt: '2026-05-01T12:00:00.000Z',
    startedAt: '2026-05-01T12:00:05.000Z',
    interruptedAt: '2026-05-01T12:01:00.000Z',
    cwd: '/workspace',
    executionAttemptId: 'attempt-1',
    executionAttemptNumber: 1,
    recoveryCount: 0,
    recoveryDisposition: 'manual' as const,
  }
  const interruptedTask = {
    ...interruptedTaskBase,
    recoveryReason: 'The worker exited unexpectedly.',
  }

  it('resumes the same task and opens its stream after the API confirms recovery', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([interruptedTask])
    vi.mocked(mockResumeSessionTask).mockResolvedValue({
      ...interruptedTaskBase,
      status: 'running',
      executionAttemptId: 'attempt-2',
      executionAttemptNumber: 2,
      executionKind: 'recovery',
      recoveryCount: 1,
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    const body = await screen.findByTestId('task-body')
    expect(body).toHaveAttribute('data-mode', 'interrupted')
    expect(body).toHaveTextContent('The worker exited unexpectedly.')

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))

    await waitFor(() => {
      expect(mockResumeSessionTask).toHaveBeenCalledWith(
        'sess-1',
        'task-interrupted',
      )
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-mode',
        'running',
      )
      expect(screen.getByTestId('task-body')).not.toHaveTextContent(
        'The worker exited unexpectedly.',
      )
    })
    expect(mockOpenRunEventStream).toHaveBeenCalledWith(
      expect.objectContaining({
        fromIndex: 0,
        runId: 'run-interrupted',
      }),
    )
    expect(toast.success).toHaveBeenCalledWith('Task resumed', {
      description: 'Execution attempt 2 is running.',
    })
  })

  it('shows a queued recovery until execution capacity is available', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([interruptedTask])
    vi.mocked(mockResumeSessionTask).mockResolvedValue({
      ...interruptedTask,
      admission: {
        version: 1,
        phase: 'pending',
        requestId: 'recovery-request',
        order: '8',
        requestedAt: '2026-05-01T12:02:00.000Z',
        executionKind: 'recovery',
        source: 'manual_resume',
        expectedExecutionAttemptId: 'attempt-1',
      },
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'queued')
    })
    expect(mockOpenRunEventStream).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-interrupted' }),
    )
    expect(toast.success).toHaveBeenCalledWith('Resume queued', {
      description: 'Waiting for execution capacity. It will start automatically.',
    })
  })

  it('keeps the task interrupted when recovery is rejected', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([interruptedTask])
    vi.mocked(mockResumeSessionTask).mockRejectedValue(
      new Error('Recovery state is incompatible'),
    )

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to resume task', {
        description: 'Recovery state is incompatible',
      })
    })
    expect(screen.getByTestId('task-body')).toHaveAttribute(
      'data-mode',
      'interrupted',
    )
  })
})

describe('RunPanel — blocked task state', () => {
  const runningTask = {
    id: 'task-blocked',
    sessionId: 'sess-1',
    runId: 'run-blocked',
    workflowId: 'wf-1',
    brief: 'Wait for approval',
    status: 'running' as const,
    createdAt: '2026-05-01T12:00:00.000Z',
    cwd: '/workspace',
  }

  it('hydrates a persisted blocked task without converting it to error', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([
      {
        ...runningTask,
        status: 'blocked',
        completedAt: '2026-05-01T12:01:00.000Z',
        error: 'Human approval is required.',
      },
    ])

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    const body = await screen.findByTestId('task-body')
    expect(body).toHaveAttribute('data-mode', 'blocked')
    expect(body).toHaveTextContent('Human approval is required.')
  })

  it('maps a live run.blocked event to blocked instead of error', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningTask])
    vi.mocked(mockOpenRunEventStream).mockImplementation(async ({ onEvent }) => {
      onEvent('blocked-1', {
        schema_version: 1,
        timestamp: '2026-05-01T12:01:00.000Z',
        tenant_id: 'local',
        category: 'runtime',
        type: 'run.blocked',
        run_id: 'run-blocked',
        payload: { error: 'Approval gate stopped the workflow.' },
      })
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute(
        'data-mode',
        'blocked',
      )
    })
    expect(screen.getByTestId('task-body')).toHaveTextContent(
      'Approval gate stopped the workflow.',
    )
  })
})

describe('RunPanel — root terminal state', () => {
  const runningTask = {
    id: 'task-root-terminal',
    sessionId: 'sess-1',
    runId: 'workflow-root-run',
    workflowId: 'wf-1',
    brief: 'Discuss and then write',
    status: 'running' as const,
    createdAt: '2026-05-01T12:00:00.000Z',
    cwd: '/workspace',
  }

  it('keeps streaming after child terminal events and finishes on root completion', async () => {
    let emitEvent: ((id: string, event: EngineEventEnvelope) => void) | undefined
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningTask])
    vi.mocked(mockOpenRunEventStream).mockImplementation(async ({ onEvent }) => {
      emitEvent = onEvent
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(mockOpenRunEventStream).toHaveBeenCalled()
      expect(emitEvent).toBeDefined()
    })

    for (const type of ['run.completed', 'run.failed', 'run.blocked', 'run.cancelled'] as const) {
      await act(async () => {
        emitEvent?.(`child-${type}`, {
          schema_version: 1,
          timestamp: '2026-05-01T12:01:00.000Z',
          tenant_id: 'local',
          category: 'runtime',
          type,
          run_id: 'discussion-child-run',
          root_run_id: 'workflow-root-run',
          payload: { error: 'Child lifecycle event.' },
        })
      })

      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'running')
    }

    await act(async () => {
      emitEvent?.('workflow-completed', {
        schema_version: 1,
        timestamp: '2026-05-01T12:02:00.000Z',
        tenant_id: 'local',
        category: 'runtime',
        type: 'run.completed',
        run_id: 'workflow-root-run',
        root_run_id: 'workflow-root-run',
        payload: {},
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'done')
    })
  })

  it('moves an actively viewed root task to interrupted when reconciliation reports worker loss', async () => {
    let emitEvent: ((id: string, event: EngineEventEnvelope) => void) | undefined
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningTask])
    vi.mocked(mockOpenRunEventStream).mockImplementation(async ({ onEvent }) => {
      emitEvent = onEvent
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    openWorkflowsTarget()

    await waitFor(() => expect(emitEvent).toBeDefined())
    await act(async () => {
      emitEvent?.('workflow-interrupted', {
        schema_version: 1,
        timestamp: '2026-05-01T12:01:30.000Z',
        tenant_id: 'local',
        category: 'runtime',
        type: 'run.interrupted',
        run_id: 'workflow-root-run',
        root_run_id: 'workflow-root-run',
        payload: {
          execution_attempt_id: 'attempt-1',
          recovery_disposition: 'manual',
          recovery_reason: 'The interrupted step requires a user recovery decision.',
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'interrupted')
    })
    expect(screen.getByTestId('task-body')).toHaveTextContent(
      'The interrupted step requires a user recovery decision.',
    )
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled()
  })

  it('rehydrates a task as running when its snapshot only has a child terminal event', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningTask])
    vi.mocked(mockFetchRunEventsSnapshot).mockResolvedValue({
      events: [
        {
          schema_version: 1,
          timestamp: '2026-05-01T12:01:00.000Z',
          tenant_id: 'local',
          category: 'runtime',
          type: 'run.failed',
          run_id: 'discussion-child-run',
          root_run_id: 'workflow-root-run',
          payload: { error: 'The discussion worker stopped.' },
        },
      ],
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    await waitFor(() => {
      expect(screen.getByTestId('task-body')).toHaveAttribute('data-mode', 'running')
      expect(mockOpenRunEventStream).toHaveBeenCalledWith(
        expect.objectContaining({
          fromIndex: 1,
          runId: 'workflow-root-run',
        }),
      )
    })
  })

  it('ignores a child-run delivery selection when rehydrating task state', async () => {
    vi.mocked(mockListSessionTasks).mockResolvedValue([runningTask])
    vi.mocked(mockFetchRunEventsSnapshot).mockResolvedValue({
      events: [
        {
          schema_version: 1,
          timestamp: '2026-05-01T12:01:00.000Z',
          tenant_id: 'local',
          category: 'artifact',
          type: 'artifact.delivery_selected',
          run_id: 'discussion-child-run',
          root_run_id: 'workflow-root-run',
          payload: {
            artifact_role: 'final',
            artifact_run_id: 'discussion-child-run',
            path: 'brief.md',
          },
        },
      ],
    })

    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)

    const body = await screen.findByTestId('task-body')
    expect(body).toHaveAttribute('data-mode', 'running')
  })
})

describe('RunPanel — cmd-K keyboard shortcut', () => {
  it('starts a fresh draft when cmd-K is pressed outside of inputs', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    await waitFor(() => {
      expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1')
    })
    vi.mocked(mockListSessionTasks).mockClear()

    // Fire cmd-K from document body (not inside an input)
    fireEvent.keyDown(document, { key: 'k', metaKey: true })

    // The new conversation is a draft: nothing is persisted, and nothing about
    // it is read back from the server.
    await waitFor(() => {
      expect(chatPanelRenderLog.at(-1)?.sessionId).not.toBe('sess-1')
    })
    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockListSessionTasks).not.toHaveBeenCalled()
  })

  it('starts a fresh draft when ctrl-K is pressed (Windows/Linux)', async () => {
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    await waitFor(() => {
      expect(mockListSessionTasks).toHaveBeenCalledWith('sess-1')
    })

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })

    await waitFor(() => {
      expect(chatPanelRenderLog.at(-1)?.sessionId).not.toBe('sess-1')
    })
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('does NOT start a new draft when cmd-K is pressed inside a textarea', async () => {
    render(
      <div>
        <textarea data-testid="input" />
        <RunPanel />
      </div>
    )
    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-picker').length).toBeGreaterThan(0)
    })
    vi.mocked(mockCreateSession).mockClear()

    const before = chatPanelRenderLog.at(-1)?.sessionId
    const textarea = screen.getByTestId('input')
    textarea.focus()
    // Simulate keydown while textarea is focused. Restored afterwards: leaving
    // `activeElement` overridden would make every later cmd-K look like typing.
    const activeElementDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'activeElement',
    )
    Object.defineProperty(document, 'activeElement', { value: textarea, configurable: true })
    try {
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
    } finally {
      if (activeElementDescriptor) {
        Object.defineProperty(document, 'activeElement', activeElementDescriptor)
      }
    }

    // Guarded by the activeElement check: the conversation on screen is the
    // same one, so the user's typing was not thrown away.
    expect(chatPanelRenderLog.at(-1)?.sessionId).toBe(before)
    expect(mockCreateSession).not.toHaveBeenCalled()
  })
})

describe('RunPanel — loading and error states', () => {
  it('shows a loading skeleton while sessions are fetching', () => {
    vi.mocked(mockListSessions).mockImplementation(() => new Promise(() => {}))
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    // Skeleton elements should be present
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('handles session list fetch error gracefully', async () => {
    vi.mocked(mockListSessions).mockRejectedValue(new Error('Failed to fetch'))
    render(<RunPanel sessionSelectionRequest={SELECTED_SESSION_REQUEST} />)
    // Should not crash; may show an error state or empty sessions
    await waitFor(() => {
      // Just ensure the component doesn't throw
      expect(document.body).toBeInTheDocument()
    })
  })
})

describe('RunPanel — deferred session creation', () => {
  it('keeps the conversation mounted when a draft becomes durable', async () => {
    render(<RunPanel />)

    const before = await screen.findByTestId('chat-panel')
    expect(before).toHaveAttribute('data-draft', 'true')
    const draftId = chatPanelRenderLog.at(-1)?.sessionId
    expect(draftId).toBeTruthy()
    if (!draftId) throw new Error('the panel rendered without a draft')
    vi.mocked(mockCreateSession).mockResolvedValue({
      id: draftId,
      title: 'Untitled session',
      status: 'idle',
      activityType: 'chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Materialize draft' }))

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel')).toHaveAttribute(
        'data-draft',
        'false',
      )
    })
    // The same element, not an equal one. A remount here would have discarded
    // whatever the user had typed at the moment they made the chat real.
    expect(screen.getByTestId('chat-panel')).toBe(before)
    expect(chatPanelRenderLog.at(-1)?.sessionId).toBe(draftId)
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
  })

  it('prunes per-session state for a draft abandoned without being created', async () => {
    render(<RunPanel />)
    await screen.findByTestId('chat-panel')

    const seen = new Set<string>()
    for (let index = 0; index < 5; index += 1) {
      const current = chatPanelRenderLog.at(-1)?.sessionId
      if (current) seen.add(current)
      fireEvent.keyDown(document, { key: 'k', metaKey: true })
      await waitFor(() => {
        expect(chatPanelRenderLog.at(-1)?.sessionId).not.toBe(current)
      })
    }

    // Every draft got its own id, and none of them was ever persisted.
    expect(seen.size).toBe(5)
    expect(mockCreateSession).not.toHaveBeenCalled()
  })
})
