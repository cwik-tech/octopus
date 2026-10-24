/**
 * Integration tests for ChatPanel cmd-Enter keyboard shortcut.
 *
 * The shortcut submits the chat form when a textarea is focused and
 * cmd/ctrl+Enter is pressed.
 */
import { StrictMode, createRef } from 'react'
import { findPendingWorkflowAgents } from '@/lib/utils/workflow-chat-events'
import type { RunEvent } from '@/components/run/stage-renderers'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatPanel, { type ChatPanelHandle } from '../chat-panel'
import type {
  ChatMessage,
  SessionMessageDispatchResponse,
  RunPlan,
  SessionSummary,
} from '@/lib/models/session-model'
import {
  listChatMessages as mockListChatMessages,
  postSessionMessage as mockPostSessionMessage,
  updateSessionTitle as mockUpdateSessionTitle,
} from '@/lib/clients/session-client'
import { listAgents as mockListAgents } from '@/lib/clients/agent-generator-client'
import { useResearchActivities as mockUseResearchActivities } from '@/hooks/use-research-activities'
import type { ResearchActivity } from '@/lib/clients/research-activity-client'
import type { SessionMessageTarget } from '@contracts/schemas/session-requests'

// ── Mock heavy deps ───────────────────────────────────────────────────────

vi.mock('@/lib/clients/session-client', () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  listChatMessages: vi.fn().mockResolvedValue({ messages: [], outcomes: [], modelChoices: [] }),
  openAgentTextStream: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn().mockResolvedValue({
    id: 'sess-1',
    title: 'Renamed Session',
    status: 'active',
    activityType: 'chat',
    createdAt: '2026-05-01T12:00:00.000Z',
    updatedAt: '2026-05-01T12:01:00.000Z',
  }),
}))

vi.mock('@/lib/clients/chat-defaults-client', () => ({
  fetchChatDefaults: vi.fn().mockResolvedValue({
    workflow: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    team: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    agent: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    run: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  }),
}))

vi.mock('@/lib/clients/agent-generator-client', () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/clients/runtime-client', () => ({
  artifactUrl: (runId: string, artifactPath: string) =>
    `/api/runs/${runId}/assignments/${artifactPath}`,
  fetchArtifact: vi.fn().mockResolvedValue('# Report\n\nThe delivered body.'),
  fetchExcelWorkbookPreview: vi.fn(),
}))

vi.mock('@/contexts/provider-catalog-context', () => ({
  useProviderCatalog: () => ({
    groups: [
      {
        provider: 'deepseek',
        name: 'DeepSeek',
        icon: 'deepseek',
        source: 'cli',
        models: [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            enabled: true,
            capabilities: ['chat'],
          },
        ],
      },
    ],
    defaultModel: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

vi.mock('@/hooks/use-research-activities', () => ({
  useResearchActivities: vi.fn().mockReturnValue([]),
}))

// ── Tests ─────────────────────────────────────────────────────────────────

const SESSION_FIXTURE: SessionSummary = {
  id: 'sess-1',
  title: 'Test Session',
  status: 'active',
  activityType: 'chat',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function mockChatParticipants(...agentNames: string[]): void {
  vi.mocked(mockListChatMessages).mockResolvedValueOnce({
    messages: agentNames.map((name, index): ChatMessage => ({
      id: `participant-${index}`,
      role: 'assistant',
      text: `${name} participated in this chat.`,
      createdAt: `2026-05-01T12:00:0${index}.000Z`,
      speaker: {
        type: 'agent',
        id: name.toLowerCase().replaceAll(' ', '-'),
        name,
      },
    })),
    outcomes: [],
    modelChoices: [],
  })
}

/**
 * Checks the turn most recently posted: it went to the fixture session with
 * this text and target, and carried nothing else beside the turn id and abort
 * signal the panel mints for every turn.
 */
function expectLastPostedTurn(text: string, target: SessionMessageTarget): void {
  const call = vi.mocked(mockPostSessionMessage).mock.lastCall
  expect(call).toHaveLength(3)
  expect(call?.slice(0, 2)).toEqual(['sess-1', text])
  const { turnId, signal, ...sent } = call?.[2] ?? {}
  expect(sent).toEqual({ target })
  expect(turnId).toBeTypeOf('string')
  expect(signal).toBeInstanceOf(AbortSignal)
}

const RUN_PLAN_FIXTURE: RunPlan = {
  id: 'plan-1',
  goal: 'First reply',
  summary: 'First reply',
  status: 'needs_input',
  requiredInputs: [],
  actions: [],
  warnings: [],
  createdAt: '2026-05-01T12:00:00.000Z',
}

type AgentCatalog = Awaited<ReturnType<typeof mockListAgents>>

/**
 * Hold the next Agent catalog request open until the test ends it.
 *
 * `requested` resolves when the panel asks; `fail` and `load` end the request
 * inside `act` and wait on the held promise itself, so the panel's own
 * handling has run by the time they return.
 */
function holdAgentCatalog(): {
  requested: Promise<void>
  fail: (message: string) => Promise<void>
  load: (agents: AgentCatalog) => Promise<void>
} {
  let markRequested: () => void = () => undefined
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve
  })
  let settle: { resolve: (agents: AgentCatalog) => void; reject: (error: Error) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  }
  const catalog = new Promise<AgentCatalog>((resolve, reject) => {
    settle = { resolve, reject }
  })
  vi.mocked(mockListAgents).mockImplementationOnce(() => {
    markRequested()
    return catalog
  })
  return {
    requested,
    fail: async (message) => {
      await act(async () => {
        settle.reject(new Error(message))
        await catalog.catch(() => undefined)
      })
    },
    load: async (agents) => {
      await act(async () => {
        settle.resolve(agents)
        await catalog
      })
    },
  }
}

/**
 * Hold the next message POST open until the test settles it.
 *
 * One-time, so it cannot answer a later test's send. `sent` resolves with what
 * the panel sent; `settle` resolves the POST inside `act` and waits on it, so
 * the panel has handled the reply, and finished the send, when it returns.
 * Every send a test starts is settled before it ends: the panel keeps sends in
 * flight per session across remounts, so one left open would outlive its test.
 */
let heldSendsOpen = 0

function holdSend(): {
  sent: Promise<Parameters<typeof mockPostSessionMessage>>
  settle: (response: SessionMessageDispatchResponse) => Promise<void>
} {
  let markSent: (call: Parameters<typeof mockPostSessionMessage>) => void = () => undefined
  const sent = new Promise<Parameters<typeof mockPostSessionMessage>>((resolve) => {
    markSent = resolve
  })
  let resolveReply: (response: SessionMessageDispatchResponse) => void = () => undefined
  const reply = new Promise<SessionMessageDispatchResponse>((resolve) => {
    resolveReply = resolve
  })
  vi.mocked(mockPostSessionMessage).mockImplementationOnce((...call) => {
    heldSendsOpen += 1
    markSent(call)
    return reply
  })
  return {
    sent,
    settle: async (response) => {
      await act(async () => {
        resolveReply(response)
        await reply
      })
      heldSendsOpen -= 1
    },
  }
}

const CATALOG_AGENTS: AgentCatalog = [
  {
    name: 'analyst',
    description: 'Challenges assumptions and evaluates evidence.',
    skills: ['analysis'],
    usedInTeams: [],
  },
  {
    name: 'writer',
    description: 'Turns conclusions into clear prose.',
    skills: ['writing'],
    usedInTeams: [],
  },
]

// A test that started a held send and ended without settling it fails here,
// and the count starts from zero for the next test. The panel is unmounted
// first, as the shared cleanup would, so a failure here cannot leave it on
// screen for the next test.
afterEach(() => {
  cleanup()
  const open = heldSendsOpen
  heldSendsOpen = 0
  expect(open, 'sends a test started and left unsettled').toBe(0)
})

describe('ChatPanel — cmd-Enter keyboard shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mockUseResearchActivities).mockReturnValue([])
    // clearAllMocks keeps implementations, one-off and lasting alike; a
    // catalog request or a send a test set up must not answer the next test.
    vi.mocked(mockListAgents).mockReset()
    vi.mocked(mockPostSessionMessage).mockReset()
    vi.mocked(mockListAgents).mockResolvedValue([
      {
        name: 'analyst',
        description: 'Challenges assumptions and evaluates evidence.',
        skills: ['analysis'],
        usedInTeams: [],
      },
      {
        name: 'writer',
        description: 'Turns conclusions into clear prose.',
        skills: ['writing'],
        usedInTeams: [],
      },
    ])
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
    }
  })

  it('renders one shared model picker for every conversation', () => {
    render(<ChatPanel session={SESSION_FIXTURE} />)

    // One composer, one picker. There is no separate agent-mode control to
    // diverge from it any more.
    expect(screen.getAllByLabelText('Run chat model')).toHaveLength(1)
  })

  it('keeps scoped worker activity out of a conversation-only planning chat', async () => {
    const baseActivity: ResearchActivity = {
      activityId: 'planning-activity',
      sessionId: SESSION_FIXTURE.id,
      runId: 'planning-run',
      assignmentId: 'planning-assignment',
      agentPath: 'agents/research-planner',
      toolCallId: 'planning-call',
      source: 'browser',
      action: 'open',
      kind: 'page',
      state: 'completed',
      createdAt: '2026-08-18T12:00:00.000Z',
      updatedAt: '2026-08-18T12:00:01.000Z',
      url: 'https://planner.example/source',
      title: 'Planner source',
    }
    vi.mocked(mockUseResearchActivities).mockReturnValue([
      baseActivity,
      {
        ...baseActivity,
        activityId: 'worker-activity',
        runId: 'research-run',
        assignmentId: 'research-assignment',
        activityScopeId: 'lane-market',
        agentPath: 'agents/web-researcher',
        toolCallId: 'worker-call',
        createdAt: '2026-08-18T12:00:02.000Z',
        updatedAt: '2026-08-18T12:00:03.000Z',
        url: 'https://worker.example/source',
        title: 'Worker source',
      },
    ])

    render(
      <ChatPanel
        researchActivityVisibility="conversation"
        session={SESSION_FIXTURE}
      />,
    )

    // A finished research group settles closed on its own timer, so make the
    // steps visible regardless of where that timer has got to. The contract
    // under test is the scope filter, not the disclosure.
    const disclosure = await screen.findByRole('button', { name: /research activity: /i })
    if (disclosure.getAttribute('aria-expanded') === 'false') {
      await userEvent.click(disclosure)
    }
    expect(await screen.findByText('Planner source')).toBeInTheDocument()
    expect(screen.queryByText('Worker source')).not.toBeInTheDocument()
  })

  it('registers and cleans up a keydown listener on mount/unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { unmount } = render(<ChatPanel session={SESSION_FIXTURE} />)

    // Should have registered a keydown handler
    const keydownCalls = addSpy.mock.calls.filter(([event]) => event === 'keydown')
    expect(keydownCalls.length).toBeGreaterThan(0)

    unmount()

    // Should have cleaned up
    const removeKeydownCalls = removeSpy.mock.calls.filter(([event]) => event === 'keydown')
    expect(removeKeydownCalls.length).toBeGreaterThan(0)
  })

  it('does not crash and keydown handler is registered for cmd-Enter', async () => {
    // The handler guards: only fires when activeElement is a TEXTAREA.
    // In the test environment the textarea is disabled (no live session state),
    // so we verify the handler is wired without simulating an actual submit.
    const addSpy = vi.spyOn(document, 'addEventListener')

    render(<ChatPanel session={SESSION_FIXTURE} />)

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    const keydownCalls = addSpy.mock.calls.filter(([event]) => event === 'keydown')
    expect(keydownCalls.length).toBeGreaterThan(0)

    // Firing cmd-Enter with body focused should not throw
    expect(() => {
      fireEvent.keyDown(document, { key: 'Enter', metaKey: true })
    }).not.toThrow()
  })

  it('does NOT submit when Enter is pressed without cmd/ctrl modifier', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} />)
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument())

    const textarea = screen.getByRole('textbox')
    textarea.focus()
    const form = textarea.closest('form')
    if (form) {
      const requestSubmitSpy = vi.spyOn(form, 'requestSubmit')
      fireEvent.keyDown(document, { key: 'Enter' })
      expect(requestSubmitSpy).not.toHaveBeenCalled()
    }
  })

  it('does NOT submit when cmd-Enter is pressed but no textarea is focused', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} />)
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument())

    // Blur so body is focused (not the textarea)
    const textarea = screen.getByRole('textbox')
    textarea.blur()
    document.body.focus()

    const form = textarea.closest('form')
    if (form) {
      const requestSubmitSpy = vi.spyOn(form, 'requestSubmit')
      fireEvent.keyDown(document, { key: 'Enter', metaKey: true })
      expect(requestSubmitSpy).not.toHaveBeenCalled()
    }
  })

  it('shows the submitted user message before the assistant response resolves', async () => {
    let resolvePost: (response: SessionMessageDispatchResponse) => void = () => {}
    const pendingPost = new Promise<SessionMessageDispatchResponse>((resolve) => {
      resolvePost = resolve
    })
    vi.mocked(mockPostSessionMessage).mockReturnValueOnce(pendingPost)

    render(<ChatPanel session={SESSION_FIXTURE} />)
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument())

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'First reply' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      const call = vi.mocked(mockPostSessionMessage).mock.lastCall
      expect(call).toHaveLength(3)
      expect(call?.slice(0, 2)).toEqual(['sess-1', 'First reply'])
      // Nobody touched the picker here, so no pair is a person's choice and
      // none is sent: the server resolves the one application default itself
      // and records it as that. Forwarding the filled-in pair made every turn
      // look like an explicit selection nobody had made.
      expect(call?.[2]?.provider ?? null).toBeNull()
    })
    expect(screen.getByText('First reply')).toBeInTheDocument()
    expect(screen.queryByText('Assistant reply')).not.toBeInTheDocument()
    expect(
      screen.getByRole('status', { name: 'General Agent is responding' }),
    ).toHaveTextContent('Reviewing your request…')

    resolvePost({
      user: {
        id: 'server-user-1',
        role: 'user',
        text: 'First reply',
        createdAt: '2026-05-01T12:00:00.000Z',
      },
      dispatch: { kind: 'coordinator' },
      messages: [{
        id: 'server-assistant-1',
        role: 'assistant',
        text: 'Assistant reply',
        createdAt: '2026-05-01T12:00:01.000Z',
      }],
      meta: { model: 'test-model', fallback: false },
      replayed: false,
      plan: RUN_PLAN_FIXTURE,
    })

    await waitFor(() => {
      expect(screen.getByText('Assistant reply')).toBeInTheDocument()
    })
    expect(screen.getByText('First reply')).toBeInTheDocument()
    expect(
      screen.queryByRole('status', { name: 'General Agent is responding' }),
    ).not.toBeInTheDocument()
  })

  it('sends the project references explicitly selected in the composer', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111'
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/mcp-interactions')) {
        return new Response(JSON.stringify({ interactions: [], truncated: false }))
      }
      return url.endsWith('/brief')
        ? new Response(JSON.stringify({
            content: 'Stable project brief',
            updatedAt: '2026-08-04T12:00:00.000Z',
          }))
        : new Response(JSON.stringify({ files: [{
            name: 'facts.md',
            size: 10,
            uploadedAt: '2026-08-04T12:00:00.000Z',
            parseStatus: 'parsed',
          }] }))
    }))
    const user = userEvent.setup()

    const { unmount } = render(
      <ChatPanel session={{ ...SESSION_FIXTURE, projectId }} />,
    )

    await user.click(screen.getByRole('button', { name: 'Add project context' }))
    await user.click(await screen.findByRole('checkbox', { name: 'Project brief' }))
    await user.click(screen.getByRole('checkbox', { name: 'facts.md' }))
    await user.click(screen.getByRole('button', { name: 'Apply project context' }))
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Use these references' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(mockPostSessionMessage).toHaveBeenCalledWith(
        'sess-1',
        'Use these references',
        // Nobody touched the picker here, so no pair is a person's choice and
        // none is sent: the server resolves the one application default itself
        // and records it as that. Forwarding the filled-in pair made every turn
        // look like an explicit selection nobody had made.
        expect.objectContaining({
          projectContext: {
            projectId,
            includeBrief: true,
            fileNames: ['facts.md'],
          },
        }),
      )
    })
    unmount()
    vi.unstubAllGlobals()
  })

  it('shows selected agents inside the chat while their replies are pending', async () => {
    let resolvePost: (response: SessionMessageDispatchResponse) => void = () => {}
    const pendingPost = new Promise<SessionMessageDispatchResponse>((resolve) => {
      resolvePost = resolve
    })
    vi.mocked(mockPostSessionMessage).mockReturnValueOnce(pendingPost)

    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: 'agents', agentNames: ['Analyst', 'Writer'] }}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Review this approach' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expectLastPostedTurn('Review this approach', {
        kind: 'agents',
        agentNames: ['Analyst', 'Writer'],
      })
    })
    expect(
      screen.getByRole('status', { name: 'Selected agents are responding' }),
    ).toHaveTextContent('Analyst and Writer are preparing replies…')

    resolvePost({
      user: {
        id: 'server-user-agent-chat',
        role: 'user',
        text: 'Review this approach',
        createdAt: '2026-05-01T12:00:00.000Z',
      },
      dispatch: { kind: 'agents', agentNames: ['Analyst', 'Writer'] },
      replayed: false,
      messages: [
        {
          id: 'server-analyst-reply',
          role: 'assistant',
          text: 'Analysis complete.',
          createdAt: '2026-05-01T12:00:01.000Z',
          speaker: { type: 'agent', id: 'analyst', name: 'Analyst' },
        },
        {
          id: 'server-writer-reply',
          role: 'assistant',
          text: 'Draft complete.',
          createdAt: '2026-05-01T12:00:02.000Z',
          speaker: { type: 'agent', id: 'writer', name: 'Writer' },
        },
      ],
      meta: { replies: [] },
    })

    await waitFor(() => {
      expect(screen.getByText('Analysis complete.')).toBeInTheDocument()
      expect(screen.getByText('Draft complete.')).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('status', { name: 'Selected agents are responding' }),
    ).not.toBeInTheDocument()
  })

  it('opens an accessible agent dropdown after @ in any conversation', async () => {
    mockChatParticipants('Analyst')
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')

    fireEvent.change(textarea, { target: { value: 'Ask @' } })

    const listbox = await screen.findByRole('listbox', { name: 'Agent mentions' })
    expect(listbox).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Search agents to mention' })).toBeInTheDocument()
    const analystOption = screen.getByRole('option', {
      name: 'Analyst',
    })
    expect(analystOption).toBeInTheDocument()
    expect(analystOption).not.toHaveTextContent('@analyst')
    expect(analystOption).not.toHaveTextContent('Challenges assumptions')
    expect(within(screen.getByRole('group', { name: 'In this chat' })).getByRole('option', { name: 'Analyst' })).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Other agents' })).getByRole('option', { name: 'Writer' })).toBeInTheDocument()
    expect(textarea).toHaveAttribute('aria-expanded', 'true')

    // One composer means mentions are always available; dismissing the
    // dropdown is what closes it, not switching conversation modes.
    fireEvent.keyDown(textarea, { key: 'Escape' })
    await waitFor(() =>
      expect(
        screen.queryByRole('listbox', { name: 'Agent mentions' }),
      ).not.toBeInTheDocument(),
    )

    // Escape in the search box closes the list as well, and hands focus back
    // to the composer rather than leaving it on the removed search input.
    const user = userEvent.setup()
    fireEvent.change(textarea, { target: { value: 'Ask @a' } })
    await user.click(
      await screen.findByRole('combobox', { name: 'Search agents to mention' }),
    )
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(
        screen.queryByRole('listbox', { name: 'Agent mentions' }),
      ).not.toBeInTheDocument(),
    )
    expect(textarea).toHaveFocus()
  })

  it('searches every agent in a new draft and inserts a mention without sending', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} isDraft />)
    const textarea = screen.getByPlaceholderText('Send a message...')
    await userEvent.type(textarea, 'Ask @')

    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    expect(await screen.findAllByRole('option')).toHaveLength(2)
    await userEvent.type(search, 'WRIT')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: 'Writer' })).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')

    expect(textarea).toHaveValue('Ask @writer ')
    expect(mockPostSessionMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['Cmd', '{Meta>}{Enter}{/Meta}'],
    ['Ctrl', '{Control>}{Enter}{/Control}'],
  ])('%s-Enter in an open mention list inserts the mention and sends nothing, as Enter does', async (_modifier, keys) => {
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toBeEnabled())
    await userEvent.type(textarea, 'Ask @')

    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    await userEvent.type(search, 'WRIT')
    expect(screen.getByRole('option', { name: 'Writer' })).toBeInTheDocument()
    await userEvent.keyboard(keys)

    expect(textarea).toHaveValue('Ask @writer ')
    expect(mockPostSessionMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['Cmd', '{Meta>}{Enter}{/Meta}'],
    ['Ctrl', '{Control>}{Enter}{/Control}'],
  ])('%s-Enter in the composer sends the message once', async (_modifier, keys) => {
    const send = holdSend()
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toBeEnabled())
    await userEvent.type(textarea, 'Summarize the findings.')
    await userEvent.keyboard(keys)

    expect((await send.sent).slice(0, 2)).toEqual(['sess-1', 'Summarize the findings.'])
    expect(mockPostSessionMessage).toHaveBeenCalledTimes(1)
    await send.settle({
      user: {
        id: 'server-user-summary',
        role: 'user',
        text: 'Summarize the findings.',
        createdAt: '2026-05-01T12:00:00.000Z',
      },
      dispatch: { kind: 'coordinator' },
      messages: [{
        id: 'server-assistant-summary',
        role: 'assistant',
        text: 'Here is the summary.',
        createdAt: '2026-05-01T12:00:01.000Z',
      }],
      meta: { model: 'test-model', fallback: false },
      replayed: false,
      plan: RUN_PLAN_FIXTURE,
    })
    expect(screen.getByText('Here is the summary.')).toBeInTheDocument()
    expect(mockPostSessionMessage).toHaveBeenCalledTimes(1)
  })

  it('asks for the Agent catalog again when the mention list opens after it failed to load', async () => {
    const firstLoad = holdAgentCatalog()
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toBeEnabled())
    await firstLoad.requested
    await firstLoad.fail('catalog offline')

    const retry = holdAgentCatalog()
    await userEvent.type(textarea, 'Ask @')
    expect(mockListAgents).toHaveBeenCalledTimes(2)
    await retry.requested
    await retry.load(CATALOG_AGENTS)

    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    await userEvent.type(search, 'WRIT')
    await userEvent.click(screen.getByRole('option', { name: 'Writer' }))
    expect(textarea).toHaveValue('Ask @writer ')
  })

  it('asks for the Agent catalog again after a send it refused because the catalog failed, so the next send goes out', async () => {
    const send = holdSend()
    const firstLoad = holdAgentCatalog()
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toBeEnabled())
    await firstLoad.requested
    await firstLoad.fail('catalog offline')

    // A mention written without opening the list, as a paste would.
    const retry = holdAgentCatalog()
    fireEvent.change(textarea, { target: { value: '@writer summarize the draft' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(
      await screen.findByText('Agent mentions are unavailable: catalog offline'),
    ).toBeInTheDocument()
    expect(mockPostSessionMessage).not.toHaveBeenCalled()
    expect(mockListAgents).toHaveBeenCalledTimes(2)

    await retry.requested
    await retry.load(CATALOG_AGENTS)
    expect(textarea).toHaveValue('@writer summarize the draft')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    const [, sentText, input] = await send.sent
    expect(input).toMatchObject({
      target: { kind: 'agents', agentNames: ['writer'] },
    })
    expect(mockPostSessionMessage).toHaveBeenCalledTimes(1)
    await send.settle({
      user: {
        id: 'server-user-writer',
        role: 'user',
        text: sentText,
        createdAt: '2026-05-01T12:00:00.000Z',
      },
      dispatch: { kind: 'agents', agentNames: ['writer'] },
      meta: { replies: [] },
      replayed: false,
      messages: [{
        id: 'server-assistant-writer',
        role: 'assistant',
        text: 'Draft summarized.',
        createdAt: '2026-05-01T12:00:01.000Z',
        speaker: { type: 'agent', id: 'writer', name: 'writer' },
      }],
    })
    expect(screen.getByText('Draft summarized.')).toBeInTheDocument()
  })

  it('does not ask for a loaded Agent catalog again when the mention list reopens', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toBeEnabled())

    await userEvent.type(textarea, 'Ask @')
    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    expect(await screen.findAllByRole('option')).toHaveLength(2)
    await userEvent.type(search, '{Escape}')
    expect(textarea).toHaveFocus()
    // The person keeps typing in the composer that already has focus. Not
    // `type`, which clicks first: a click with the caret still after the old
    // `@` reopens the list, and whether the next keys land in the composer or
    // in the list's search box would then depend on one animation frame.
    await userEvent.keyboard(' and @')
    expect(textarea).toHaveValue('Ask @ and @')
    expect(await screen.findAllByRole('option')).toHaveLength(2)

    expect(mockListAgents).toHaveBeenCalledTimes(1)
  })

  it('finds an agent by the name the list shows', async () => {
    vi.mocked(mockListAgents).mockResolvedValue([
      { name: 'analyst', skills: [], usedInTeams: [] },
      { name: 'domain-researcher', skills: [], usedInTeams: [] },
    ])
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = screen.getByPlaceholderText('Send a message...')
    fireEvent.change(textarea, { target: { value: 'Ask @' } })
    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    await screen.findByRole('option', { name: 'Domain Researcher' })

    // 'domain res' matches the display name, not the id 'domain-researcher'.
    await userEvent.type(search, 'domain res')

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Domain Researcher',
    ])
  })

  it('puts selected agents first while allowing other agents', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} target={{ kind: 'agents', agentNames: ['writer'] }} />)
    const textarea = screen.getByPlaceholderText('Send a message to the selected agents...')
    fireEvent.change(textarea, { target: { value: '@' } })

    const current = await screen.findByRole('group', { name: 'In this chat' })
    const other = screen.getByRole('group', { name: 'Other agents' })
    expect(within(current).getByRole('option', { name: 'Writer' })).toBeInTheDocument()
    expect(within(other).getByRole('option', { name: 'Analyst' })).toBeInTheDocument()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Writer', 'Analyst'])
    await userEvent.click(within(other).getByRole('option', { name: 'Analyst' }))
    expect(textarea).toHaveValue('@analyst ')
  })

  it('highlights the first agent shown, wraps ArrowUp to the last and inserts it with Tab', async () => {
    // Three agents, so the wrap from the first option lands on the last one
    // and not on the option a move down would reach.
    vi.mocked(mockListAgents).mockResolvedValue([
      { name: 'analyst', skills: [], usedInTeams: [] },
      { name: 'writer', skills: [], usedInTeams: [] },
      { name: 'reviewer', skills: [], usedInTeams: [] },
    ])
    render(<ChatPanel session={SESSION_FIXTURE} target={{ kind: 'agents', agentNames: ['writer'] }} />)
    const textarea = screen.getByPlaceholderText('Send a message to the selected agents...')
    fireEvent.change(textarea, { target: { value: '@' } })
    const writer = await screen.findByRole('option', { name: 'Writer' })
    const analyst = screen.getByRole('option', { name: 'Analyst' })
    const reviewer = screen.getByRole('option', { name: 'Reviewer' })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Writer',
      'Analyst',
      'Reviewer',
    ])
    expect(writer).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(reviewer).toHaveAttribute('aria-selected', 'true')
    expect(writer).toHaveAttribute('aria-selected', 'false')
    expect(analyst).toHaveAttribute('aria-selected', 'false')

    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea).toHaveValue('@reviewer ')
  })

  it('replaces only the mention token when searching in the middle of a draft', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Send a message...')
    fireEvent.change(textarea, { target: { value: 'Ask @ana about this' } })
    textarea.setSelectionRange(7, 7)
    fireEvent.click(textarea)

    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    await userEvent.clear(search)
    await userEvent.type(search, 'writer')
    await userEvent.keyboard('{Enter}')
    expect(textarea).toHaveValue('Ask @writer about this')
  })

  it('closes the list after a pick in the middle of a draft and leaves the caret after the name', async () => {
    const user = userEvent.setup()
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Send a message...')
    fireEvent.change(textarea, { target: { value: 'Ask @ana about this' } })
    textarea.setSelectionRange(8, 8)
    fireEvent.click(textarea)
    await screen.findByRole('option', { name: 'Analyst' })

    // Through userEvent, so the Enter's keyup lands on the refocused textarea.
    await user.keyboard('{Enter}')

    expect(textarea).toHaveValue('Ask @analyst about this')
    expect(screen.queryByRole('listbox', { name: 'Agent mentions' })).not.toBeInTheDocument()
    expect(textarea).toHaveAttribute('aria-expanded', 'false')
    expect(textarea).toHaveFocus()
    expect(textarea.selectionStart).toBe(12)
  })

  it('does not send the draft when a mention search has no results', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} isDraft />)
    const textarea = screen.getByPlaceholderText('Send a message...')
    await userEvent.type(textarea, 'Ask @')
    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    await userEvent.type(search, 'missing')
    await userEvent.keyboard('{Enter}')

    expect(screen.getByText('No agents match @missing.')).toBeInTheDocument()
    expect(textarea).toHaveValue('Ask @')
    expect(mockPostSessionMessage).not.toHaveBeenCalled()
  })

  it('visibly moves the active mention option with ArrowDown and inserts it', async () => {
    mockChatParticipants('Analyst', 'Writer')
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')

    fireEvent.change(textarea, { target: { value: 'Ask @' } })
    const analystOption = await screen.findByRole('option', { name: 'Analyst' })
    const writerOption = screen.getByRole('option', { name: 'Writer' })
    expect(analystOption).toHaveAttribute('aria-selected', 'true')
    expect(analystOption).toHaveClass('bg-accent')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })

    expect(analystOption).toHaveAttribute('aria-selected', 'false')
    expect(writerOption).toHaveAttribute('aria-selected', 'true')
    expect(writerOption).toHaveClass('bg-accent')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea).toHaveValue('Ask @writer ')
  })

  it('makes the first match active again when the mention search changes', async () => {
    const user = userEvent.setup()
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = screen.getByPlaceholderText('Send a message...')
    fireEvent.change(textarea, { target: { value: 'Ask @' } })
    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    await screen.findByRole('option', { name: 'Analyst' })
    await user.click(search)
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Writer' })).toHaveAttribute('aria-selected', 'true')

    // Both names contain a 't', so both options stay listed.
    await user.keyboard('t')

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Analyst',
      'Writer',
    ])
    expect(screen.getByRole('option', { name: 'Analyst' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Writer' })).toHaveAttribute('aria-selected', 'false')
  })

  it('loads the mention catalog only once across Chat mode toggles', async () => {
    mockChatParticipants('Analyst')
    const { rerender } = render(
      <ChatPanel session={SESSION_FIXTURE} />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Ask @a' } })
    await screen.findByRole('option', { name: /Analyst/ })

    rerender(<ChatPanel session={SESSION_FIXTURE} />)
    rerender(<ChatPanel session={SESSION_FIXTURE} />)
    fireEvent.change(textarea, { target: { value: 'Ask @an' } })
    await screen.findByRole('option', { name: /Analyst/ })

    expect(mockListAgents).toHaveBeenCalledTimes(1)
  })

  // Component-only smoke test. StrictMode runs effects twice in development
  // builds only (ui/src/main.tsx wraps the app in it), so the catalog effect is
  // cleaned up and runs again before its request settles. It checks the list
  // and a pick; it cannot tell whether the two runs shared one catalog request.
  it('under StrictMode lists each agent once and inserts a pick', async () => {
    render(
      <StrictMode>
        <ChatPanel session={SESSION_FIXTURE} />
      </StrictMode>,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Ask @' } })
    await screen.findByRole('option', { name: 'Analyst' })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Analyst',
      'Writer',
    ])

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea).toHaveValue('Ask @analyst ')
  })

  // Component-only. A switch here is a new `session` prop on the same panel,
  // which the component supports. The desktop app remounts the panel for each
  // session instead (RunPanel keys it by the session id).
  it('closes an open mention list when the conversation switches', async () => {
    const { rerender } = render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Ask @' } })
    await screen.findByRole('listbox', { name: 'Agent mentions' })

    rerender(<ChatPanel session={{ ...SESSION_FIXTURE, id: 'sess-2', title: 'Other' }} />)

    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Agent mentions' })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-expanded', 'false')
  })

  it('reopens mention suggestions after a keyboard caret move into a token', async () => {
    mockChatParticipants('Analyst')
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, {
      target: { value: 'Prefix @analyst suffix' },
    })
    expect(
      screen.queryByRole('listbox', { name: 'Agent mentions' }),
    ).not.toBeInTheDocument()

    textarea.setSelectionRange(11, 11)
    fireEvent.keyUp(textarea, { key: 'ArrowLeft' })

    expect(
      await screen.findByRole('option', { name: /Analyst/ }),
    ).toBeInTheDocument()

    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    fireEvent.keyUp(textarea, { key: 'End' })
    expect(
      screen.queryByRole('listbox', { name: 'Agent mentions' }),
    ).not.toBeInTheDocument()

    textarea.setSelectionRange(11, 11)
    fireEvent.click(textarea)
    expect(
      await screen.findByRole('option', { name: /Analyst/ }),
    ).toBeInTheDocument()
  })

  it('routes literal mentions in first-mention order instead of sidebar agents', async () => {
    mockChatParticipants('Writer', 'Analyst')
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: 'agents', agentNames: ['sidebar-agent'] }}
      />,
    )
    const textarea = await screen.findByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'Ask @wri' } })
    await screen.findByRole('option', { name: /Writer/ })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea).toHaveValue('Ask @writer ')
    expect(mockPostSessionMessage).not.toHaveBeenCalled()

    fireEvent.change(textarea, {
      target: { value: 'Ask @writer and @ana' },
    })
    await screen.findByRole('option', { name: /Analyst/ })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea).toHaveValue('Ask @writer and @analyst ')

    fireEvent.change(textarea, {
      target: { value: 'Ask @writer and @analyst to review this.' },
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expectLastPostedTurn('Ask @writer and @analyst to review this.', {
        kind: 'agents',
        agentNames: ['writer', 'analyst'],
      })
    })
  })

  it('keeps sidebar routing when the message has no valid mentions', async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: 'agents', agentNames: ['analyst'] }}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Review this without a mention' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expectLastPostedTurn('Review this without a mention', {
        kind: 'agents',
        agentNames: ['analyst'],
      })
    })
  })

  it('submits an unknown mention as ordinary text after the catalog loads', async () => {
    mockChatParticipants('Analyst')
    vi.mocked(mockPostSessionMessage).mockResolvedValueOnce({
      user: {
        id: 'server-user-unknown-mention',
        role: 'user',
        text: 'Ask @zzz',
        createdAt: '2026-05-01T12:00:00.000Z',
      },
      dispatch: { kind: 'agents', agentNames: ['analyst'] },
      replayed: false,
      messages: [],
      meta: { replies: [] },
    })
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: 'agents', agentNames: ['analyst'] }}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Ask @zzz' } })
    await screen.findByText('No agents match @zzz.')

    fireEvent.keyDown(textarea, { key: 'Enter' })

    // Sent as typed: the draft leaves the composer and shows in the conversation.
    await waitFor(() => expect(screen.getByText('Ask @zzz')).toBeInTheDocument())
    expect(textarea).toHaveValue('')
    await waitFor(() => {
      expectLastPostedTurn('Ask @zzz', { kind: 'agents', agentNames: ['analyst'] })
    })
  })

  it('guards valid mentions until the agent catalog loads and restores the exact draft', async () => {
    let resolveAgents: (agents: Awaited<ReturnType<typeof mockListAgents>>) => void = () => {}
    vi.mocked(mockListAgents).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAgents = resolve
      }),
    )
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: 'agents', agentNames: ['analyst'] }}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    const draft = '  Ask @writer to review.  '
    fireEvent.change(textarea, { target: { value: draft } })

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(
      await screen.findByText('Agents are still loading. Try again.'),
    ).toBeInTheDocument()
    expect(mockPostSessionMessage).not.toHaveBeenCalled()
    expect(textarea).toHaveValue(draft)

    await act(async () => {
      resolveAgents([
        { name: 'analyst', skills: [], usedInTeams: [] },
        { name: 'writer', skills: [], usedInTeams: [] },
      ])
    })
  })

  it('guards valid mentions when the agent catalog fails to load', async () => {
    // Offline for every request: a failed catalog is asked for again when the
    // list opens and when a send is refused, and the guard must hold each time.
    vi.mocked(mockListAgents).mockRejectedValue(new Error('catalog offline'))
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: 'agents', agentNames: ['analyst'] }}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Ask @writer' } })
    await screen.findByText('Could not load agents: catalog offline')
    fireEvent.change(textarea, { target: { value: 'Ask @writer now.' } })

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(
      await screen.findByText('Agent mentions are unavailable: catalog offline'),
    ).toBeInTheDocument()
    expect(mockPostSessionMessage).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('Ask @writer now.')
  })

  it('blocks submission when pasted text contains more than eight valid mentions', async () => {
    vi.mocked(mockListAgents).mockResolvedValue(
      Array.from({ length: 9 }, (_, index) => ({
        name: `agent-${index + 1}`,
        skills: [],
        usedInTeams: [],
      })),
    )
    render(<ChatPanel session={SESSION_FIXTURE} />)
    const textarea = await screen.findByRole('textbox')
    const text = `  ${Array.from(
      { length: 9 },
      (_, index) => `@agent-${index + 1}`,
    ).join(' ')} review this  `
    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(
      await screen.findByText('A message can mention up to 8 agents.'),
    ).toBeInTheDocument()
    expect(mockPostSessionMessage).not.toHaveBeenCalled()
    expect(textarea).toHaveValue(text)
  })

  it('notifies when an agent chat message starts with agents selected', async () => {
    const onSessionActivityStarted = vi.fn()
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: 'agents', agentNames: ['Analyst', 'Writer'] }}
        onSessionActivityStarted={onSessionActivityStarted}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Review this approach' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(onSessionActivityStarted).toHaveBeenCalledWith('sess-1')
    })
  })

  it('notifies when the default agent chat starts without selected agents', async () => {
    const onSessionActivityStarted = vi.fn()
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        target={{ kind: 'agents', agentNames: [] }}
        onSessionActivityStarted={onSessionActivityStarted}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Just chatting' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(mockPostSessionMessage).toHaveBeenCalled()
    })
    expect(onSessionActivityStarted).toHaveBeenCalledWith('sess-1')
  })

  it('notifies when a workflow planning chat starts', async () => {
    const onSessionActivityStarted = vi.fn()
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        onSessionActivityStarted={onSessionActivityStarted}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Plan something' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(mockPostSessionMessage).toHaveBeenCalled()
    })
    expect(onSessionActivityStarted).toHaveBeenCalledWith('sess-1')
  })

  it('reports the real task returned by a chat-triggered launch', async () => {
    const onRunPlanUpdated = vi.fn()
    const onTaskStarted = vi.fn()
    const task = {
      id: 'task-chat-1',
      sessionId: 'sess-1',
      runId: 'run-chat-1',
      workflowId: 'wf-1',
      brief: 'Do the work',
      status: 'running' as const,
      createdAt: new Date().toISOString(),
      cwd: '/workspace',
    }
    vi.mocked(mockPostSessionMessage).mockResolvedValueOnce({
      user: {
        id: 'server-user-chat',
        role: 'user',
        text: 'The decision is made; hand it over to the team.',
        createdAt: new Date().toISOString(),
      },
      dispatch: { kind: 'team', teamId: 'writing-team' },
      messages: [],
      plan: { ...RUN_PLAN_FIXTURE, status: 'running' },
      task,
      replayed: false,
    })

    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        onRunPlanUpdated={onRunPlanUpdated}
        onTaskStarted={onTaskStarted}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, {
      target: { value: 'The decision is made; hand it over to the team.' },
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(onRunPlanUpdated).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        status: 'running',
      }))
      expect(onTaskStarted).toHaveBeenCalledWith('sess-1', task)
    })
  })

  it('reports the task a front-door chat confirmation launched', async () => {
    // The agents branch carries task/plan when the General Agent's
    // start_workflow tool confirmed a launch; the panel must hand them to the
    // same handlers a Team dispatch uses, or the run silently does not appear.
    const onRunPlanUpdated = vi.fn()
    const onTaskStarted = vi.fn()
    const task = {
      id: 'task-front-door-1',
      sessionId: 'sess-1',
      runId: 'run-front-door-1',
      workflowId: 'test-workflow',
      brief: 'Write the announcement',
      status: 'queued' as const,
      createdAt: new Date().toISOString(),
      cwd: '/workspace',
    }
    const plan = {
      ...RUN_PLAN_FIXTURE,
      status: 'queued' as const,
      selectedWorkflow: {
        id: 'test-workflow',
        rationale: 'Proposed in chat.',
        confidence: 'high' as const,
        selectionSource: 'user' as const,
      },
      taskId: task.id,
    }
    vi.mocked(mockPostSessionMessage).mockResolvedValueOnce({
      user: {
        id: 'server-user-confirm',
        role: 'user',
        text: 'go for it',
        createdAt: new Date().toISOString(),
      },
      dispatch: { kind: 'agents', agentNames: ['general-agent'] },
      messages: [
        {
          id: 'server-assistant-confirm',
          role: 'assistant',
          text: 'Started test-workflow.',
          createdAt: new Date().toISOString(),
        },
      ],
      meta: { replies: [] },
      plan,
      task,
      replayed: false,
    })

    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        onRunPlanUpdated={onRunPlanUpdated}
        onTaskStarted={onTaskStarted}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'go for it' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(onRunPlanUpdated).toHaveBeenCalledWith('sess-1', plan)
      expect(onTaskStarted).toHaveBeenCalledWith('sess-1', task)
    })
  })

  it.each([
    { kind: 'coordinator', selectedWorkflowId: 'wf-1' } as const,
    { kind: 'workflow', workflowId: 'wf-1' } as const,
  ])('reports the task a $kind chat confirmation launched', async (dispatch) => {
    // The coordinator/workflow branches carry the admitted task too, so the
    // planning chat's launch reaches the same handlers as the front door's.
    const onRunPlanUpdated = vi.fn()
    const onTaskStarted = vi.fn()
    const task = {
      id: 'task-coordinator-1',
      sessionId: 'sess-1',
      runId: 'run-coordinator-1',
      workflowId: 'wf-1',
      brief: 'Do the planned work',
      status: 'queued' as const,
      createdAt: new Date().toISOString(),
      cwd: '/workspace',
    }
    const plan = {
      ...RUN_PLAN_FIXTURE,
      status: 'queued' as const,
      selectedWorkflow: {
        id: 'wf-1',
        rationale: 'Selected earlier.',
        confidence: 'high' as const,
        selectionSource: 'user' as const,
      },
      taskId: task.id,
    }
    const response = {
      user: {
        id: 'server-user-coordinator',
        role: 'user' as const,
        text: 'go for it',
        createdAt: new Date().toISOString(),
      },
      messages: [
        {
          id: 'server-assistant-coordinator',
          role: 'assistant' as const,
          text: 'wf-1 is starting.',
          createdAt: new Date().toISOString(),
        },
      ],
      meta: { model: 'test-model', fallback: false },
      plan,
      task,
      replayed: false,
    }
    // Narrow the whole response so its dispatch discriminator stays typed.
    vi.mocked(mockPostSessionMessage).mockResolvedValueOnce(
      dispatch.kind === 'coordinator'
        ? { ...response, dispatch }
        : { ...response, dispatch },
    )

    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        onRunPlanUpdated={onRunPlanUpdated}
        onTaskStarted={onTaskStarted}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'go for it' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(onRunPlanUpdated).toHaveBeenCalledWith('sess-1', plan)
      expect(onTaskStarted).toHaveBeenCalledWith('sess-1', task)
    })
  })

  it('does not report a task when an agents reply did not launch one', async () => {
    const onRunPlanUpdated = vi.fn()
    const onTaskStarted = vi.fn()
    vi.mocked(mockPostSessionMessage).mockResolvedValueOnce({
      user: {
        id: 'server-user-plain',
        role: 'user',
        text: 'start',
        createdAt: new Date().toISOString(),
      },
      dispatch: { kind: 'agents', agentNames: ['general-agent'] },
      messages: [
        {
          id: 'server-assistant-plain',
          role: 'assistant',
          text: 'Nothing has been proposed yet.',
          createdAt: new Date().toISOString(),
        },
      ],
      meta: { replies: [] },
      replayed: false,
    })

    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        onRunPlanUpdated={onRunPlanUpdated}
        onTaskStarted={onTaskStarted}
      />,
    )
    const textarea = await screen.findByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'start' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(mockPostSessionMessage).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByText('Nothing has been proposed yet.')).toBeInTheDocument()
    })
    expect(onTaskStarted).not.toHaveBeenCalled()
    expect(onRunPlanUpdated).not.toHaveBeenCalled()
  })

  it('renders the chat input disabled when no sessionId is provided', async () => {
    render(<ChatPanel session={null} />)
    // Should show a placeholder state
    expect(screen.queryByRole('textbox')).toBeInTheDocument()
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
  })

  it('renders a delivery card on messages that carry a delivery payload', async () => {
    vi.mocked(mockListChatMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'server-delivery-1',
          role: 'assistant',
          text: 'Your report is ready.',
          createdAt: '2026-05-01T12:00:00.000Z',
          delivery: {
            taskId: 'task-1',
            artifacts: [
              { runId: 'run-1', path: 'output/final-report.md', role: 'final' },
            ],
          },
        },
      ],
      outcomes: [],
      modelChoices: [],
    })

    render(<ChatPanel session={SESSION_FIXTURE} />)

    expect(await screen.findByText('Your report is ready.')).toBeInTheDocument()
    expect(await screen.findByText('output/final-report.md')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open full view' }),
    ).toBeInTheDocument()
  })

  it('keeps the extractor visible until its persisted workflow outcome replaces it', async () => {
    vi.mocked(mockListChatMessages).mockResolvedValue({ messages: [], outcomes: [], modelChoices: [] })
    const ref = createRef<ChatPanelHandle>()
    const start: RunEvent = { id: 'extractor-start', type: 'agent.start', ts: Date.parse('2026-05-01T12:00:00.000Z'), agentName: 'youtube-extractor', runId: 'manual-run' }
    const group = { taskId: 'manual-task', taskRunId: 'manual-run', events: [start] }
    const pending = findPendingWorkflowAgents([group])
    const { rerender } = render(<ChatPanel ref={ref} session={SESSION_FIXTURE} showWorkflowMessages workflowPendingAgents={pending} />)
    expect(await screen.findByRole('status', { name: /youtube extractor is thinking/i })).toBeInTheDocument()

    // The worker end event arrives before the separately loaded transcript.
    const finished = findPendingWorkflowAgents([{ ...group, taskActive: false, events: [start, { ...start, id: 'extractor-end', type: 'agent.end' }, { id: 'failed', type: 'run.failed', ts: start.ts + 1000, runId: 'manual-run' }] }], { retainUntilOutcome: true })
    rerender(<ChatPanel ref={ref} session={SESSION_FIXTURE} showWorkflowMessages workflowPendingAgents={finished} />)
    expect(screen.getByRole('status', { name: /youtube extractor is finishing the workflow/i })).toHaveTextContent('Finishing the workflow…')

    const outcome: ChatMessage = {
      id: 'manual-outcome', role: 'assistant', text: 'Screenshot capture failed.',
      createdAt: '2026-05-01T12:01:00.000Z',
      speaker: { type: 'agent', id: 'youtube-extractor', name: 'youtube-extractor' },
      outcome: { taskId: 'manual-task', status: 'failed', workflowId: 'youtube-manual-generation' },
    }
    vi.mocked(mockListChatMessages).mockResolvedValue({ messages: [outcome], outcomes: [], modelChoices: [] })
    act(() => ref.current?.reloadMessages())
    expect(await screen.findByText('Screenshot capture failed.')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /youtube extractor is finishing the workflow/i })).not.toBeInTheDocument()
  })

  it('renders workflow agent responses and working indicators in chat', async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        showWorkflowMessages
        workflowMessages={[
          {
            id: 'workflow:task-1:event-1',
            role: 'assistant',
            text: 'The market assumptions need stronger evidence.',
            createdAt: '2026-05-01T12:00:02.000Z',
            speaker: { type: 'agent', id: 'critic', name: 'Critic' },
            workflow: {
              messageType: 'position',
              round: 1,
              taskId: 'task-1',
            },
          },
        ]}
        workflowPendingAgents={[
          {
            id: 'pending-researcher',
            name: 'Researcher',
            speakerId: 'researcher',
            taskId: 'task-1',
          },
        ]}
      />,
    )

    expect(
      await screen.findByText('The market assumptions need stronger evidence.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Round 1')).toBeInTheDocument()
    expect(screen.getByText('CR')).toBeInTheDocument()
    expect(screen.getByText('Critic')).toBeInTheDocument()
    expect(screen.getByLabelText(/Message time:/)).toHaveAttribute(
      'dateTime',
      '2026-05-01T12:00:02.000Z',
    )
    expect(screen.getByLabelText(/Message time:/)).toHaveClass(
      'opacity-0',
      'group-hover/message:opacity-100',
    )
    expect(
      screen.getByRole('status', { name: 'Researcher is thinking' }),
    ).toHaveTextContent('Thinking…')
  })

  it('does not show workflow events unless the conversation asks for them', async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        workflowMessages={[
          {
            id: 'workflow:task-1:event-1',
            role: 'assistant',
            text: 'Workflow-only response',
            createdAt: '2026-05-01T12:00:02.000Z',
            speaker: { type: 'agent', id: 'critic', name: 'Critic' },
            workflow: {
              messageType: 'position',
              round: 1,
              taskId: 'task-1',
            },
          },
        ]}
        workflowPendingAgents={[
          {
            id: 'pending-researcher',
            name: 'Researcher',
            speakerId: 'researcher',
            taskId: 'task-1',
          },
        ]}
      />,
    )

    await screen.findByLabelText('Run chat model')
    expect(screen.queryByText('Workflow-only response')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Researcher is thinking' })).not.toBeInTheDocument()
  })

  it('keeps journey anchors mounted after a framing-only round finishes', async () => {
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        showWorkflowMessages
        workflowMessages={[
          {
            id: 'workflow:task-1:brief',
            role: 'assistant',
            text: 'Coordinator framing',
            createdAt: '2026-05-01T12:00:02.000Z',
            speaker: {
              type: 'agent',
              id: 'problem-decomposer',
              name: 'Problem Decomposer',
            },
            workflow: {
              messageType: 'framing',
              round: 1,
              taskId: 'task-1',
            },
          },
        ]}
      />,
    )

    expect(await screen.findByText('Coordinator framing')).toBeInTheDocument()
    expect(document.getElementById('workflow-brief-task-1')).not.toBeNull()
    expect(document.getElementById('workflow-round-task-1-1')).not.toBeNull()
    expect(document.getElementById('workflow-writing-task-1')).not.toBeNull()
  })

  it('saves a manual title edit from the header', async () => {
    const onSessionUpdated = vi.fn()
    render(
      <ChatPanel
        session={SESSION_FIXTURE}
        onSessionUpdated={onSessionUpdated}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit session title' }))
    const titleInput = screen.getByRole('textbox', { name: 'Session title' })
    fireEvent.change(titleInput, { target: { value: 'Renamed Session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save session title' }))

    await waitFor(() => {
      expect(mockUpdateSessionTitle).toHaveBeenCalledWith('sess-1', 'Renamed Session')
      expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Renamed Session',
      }))
    })
  })
})

describe('ChatPanel — a Workflow selection still being persisted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // A send set up in the other block must not answer this block's sends.
    vi.mocked(mockPostSessionMessage).mockReset()
  })

  it('sends nothing while the selection is in flight, then sends once it lands', async () => {
    const { rerender } = render(
      <ChatPanel session={SESSION_FIXTURE} selectionPending />,
    )
    const pendingComposer = await screen.findByRole('textbox')
    fireEvent.change(pendingComposer, { target: { value: 'Refine the brief' } })
    fireEvent.keyDown(pendingComposer, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    // Sending now would be answered against the plan as it was before the
    // user's pick, quietly losing the Workflow they just chose.
    await waitFor(async () =>
      expect(await screen.findByRole('textbox')).toBeDisabled(),
    )
    expect(mockPostSessionMessage).not.toHaveBeenCalled()

    // Once the selection has landed the turn goes out, untargeted, so the
    // persisted user selection is what governs it.
    rerender(<ChatPanel session={SESSION_FIXTURE} />)
    const settledComposer = await screen.findByRole('textbox')
    await waitFor(() => expect(settledComposer).toBeEnabled())
    fireEvent.change(settledComposer, { target: { value: 'Refine the brief' } })
    fireEvent.keyDown(settledComposer, { key: 'Enter' })

    await waitFor(() => {
      expect(mockPostSessionMessage).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(mockPostSessionMessage).mock.calls[0]?.[1]).toBe(
      'Refine the brief',
    )
    expect(
      vi.mocked(mockPostSessionMessage).mock.calls[0]?.[2],
    ).not.toHaveProperty('target')
  })

  it('holds a draft typed before the pick until the selection lands', async () => {
    // The sequence that actually loses a selection: type, pick a Workflow,
    // then hit Send while the picker's write is still in flight. Driven
    // through state so the composer is the same mounted node throughout, as it
    // is when RunPanel re-renders around it.
    function Harness({ pending }: { pending: boolean }) {
      return <ChatPanel session={SESSION_FIXTURE} selectionPending={pending} />
    }
    const { rerender } = render(<Harness pending={false} />)
    const composer = await screen.findByRole('textbox')
    await waitFor(() => expect(composer).toBeEnabled())
    fireEvent.change(composer, { target: { value: 'Refine the brief' } })

    rerender(<Harness pending />)
    // The draft survives the transition, which is exactly why Send must not
    // stay available: the retained text is ready to be sent against the plan
    // the pick is about to replace.
    expect(composer).toHaveValue('Refine the brief')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => expect(composer).toBeDisabled())
    expect(mockPostSessionMessage).not.toHaveBeenCalled()

    rerender(<Harness pending={false} />)
    const settled = await screen.findByRole('textbox')
    await waitFor(() => expect(settled).toBeEnabled())
    fireEvent.change(settled, { target: { value: 'Refine the brief' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(mockPostSessionMessage).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(mockPostSessionMessage).mock.calls[0]?.[1]).toBe(
      'Refine the brief',
    )
  })

  it('disables the composer while the selection is in flight', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} selectionPending />)

    expect(await screen.findByRole('textbox')).toBeDisabled()
  })
})
