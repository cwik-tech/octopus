/**
 * Regression test: an agent reply in run chat must be labelled with the model
 * the backend actually ran the turn with, taken from that turn's own admitted
 * record — not the run chat's default model, and not whatever the agent
 * library says today.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ChatPanel from '../chat-panel'
import type { ChatMessage, SessionSummary } from '@/lib/models/session-model'
import { listChatMessages as mockListChatMessages } from '@/lib/clients/session-client'
import { listAgents as mockListAgents } from '@/lib/clients/agent-generator-client'
import { useResearchActivities as mockUseResearchActivities } from '@/hooks/use-research-activities'

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
  listChatMessages: vi.fn().mockResolvedValue({ messages: [], outcomes: [] }),
  openAgentTextStream: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn(),
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
  fetchArtifact: vi.fn().mockResolvedValue('# Report'),
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

const SESSION_FIXTURE: SessionSummary = {
  id: 'sess-1',
  title: 'Test Session',
  status: 'active',
  activityType: 'chat',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const AGENT_NAME = 'regulatory-compliance-specialist'

function agentReply(text: string): ChatMessage {
  return {
    id: 'reply-1',
    role: 'assistant',
    text,
    turnId: 'turn-1',
    createdAt: '2026-05-01T12:00:01.000Z',
    speaker: { type: 'agent', id: AGENT_NAME, name: AGENT_NAME },
  }
}

/** The question whose admission recorded what the reply ran on. */
function admittingQuestion(model: string): ChatMessage {
  return {
    id: 'question-1',
    role: 'user',
    text: 'Compliance question.',
    turnId: 'turn-1',
    createdAt: '2026-05-01T12:00:00.000Z',
    turnRequest: {
      fingerprint: 'turn-1',
      expectedReplies: 1,
      admittedSelections: {
        [AGENT_NAME]: {
          provider: 'codex',
          model,
          source: 'agent',
          reason: 'explicit-agent-choice',
          caller: 'agent',
        },
      },
    },
  }
}

describe('ChatPanel — agent reply model label', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mockUseResearchActivities).mockReturnValue([])
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
    }
  })

  it("labels an agent reply with what its turn recorded, not the chat default", async () => {
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: [admittingQuestion('gpt-5.6-sol'), agentReply('Compliance answer.')],
      outcomes: [],
      modelChoices: [],
    })
    vi.mocked(mockListAgents).mockResolvedValue([])

    render(<ChatPanel session={SESSION_FIXTURE} />)

    expect(await screen.findByLabelText('Model: gpt-5.6-sol')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Model: deepseek-v4-flash'),
    ).not.toBeInTheDocument()
  })

  it('does not relabel a past reply from the current agent library', async () => {
    // The agent has since been repointed. The reply on screen was not run on
    // the new model, so saying it was would make the transcript untrue.
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: [admittingQuestion('gpt-5.6-sol'), agentReply('Compliance answer.')],
      outcomes: [],
      modelChoices: [],
    })
    vi.mocked(mockListAgents).mockResolvedValue([
      {
        name: AGENT_NAME,
        description: 'De-risks the regulatory certification pathway.',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        skills: [],
        usedInTeams: [],
      },
    ])

    render(<ChatPanel session={SESSION_FIXTURE} />)

    expect(await screen.findByLabelText('Model: gpt-5.6-sol')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Model: claude-sonnet-4-6'),
    ).not.toBeInTheDocument()
  })

  it('shows no model label for a reply whose turn recorded no selection', async () => {
    // Older history. A label here would be borrowed from somewhere else.
    vi.mocked(mockListChatMessages).mockResolvedValue({
      messages: [agentReply('Compliance answer.')],
      outcomes: [],
      modelChoices: [],
    })
    vi.mocked(mockListAgents).mockResolvedValue([
      {
        name: AGENT_NAME,
        description: 'De-risks the regulatory certification pathway.',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        skills: [],
        usedInTeams: [],
      },
    ])

    render(<ChatPanel session={SESSION_FIXTURE} />)

    expect(await screen.findByText('Compliance answer.')).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Model:/)).not.toBeInTheDocument()
  })
})
