/**
 * What the composer's model picker means, and what it therefore sends.
 *
 * The picker always shows a pair, because an empty control is not useful. But
 * showing the application default is not the same as somebody choosing it, and
 * the server records the difference: a pair on the request is a person's
 * explicit choice for that one turn, and its absence means "resolve the one
 * application default and say so". Sending the filled-in pair regardless made
 * every turn record `source: user`, so a session named on the default was
 * disclosed as one named on a model a person had picked, which nobody had.
 *
 * These are the branches of that distinction, at the component boundary. The
 * whole journey belongs to the desktop test; this is where each branch is
 * pinned down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import ChatPanel from '../chat-panel'
import type { RunPlan, SessionSummary } from '@/lib/models/session-model'
import { postSessionMessage as mockPostSessionMessage } from '@/lib/clients/session-client'

const APP_DEFAULT = { provider: 'deepseek', model: 'app-default-model' }
const APP_DEFAULT_NAME = 'App Default Model'
const DELIBERATE = { provider: 'deepseek', model: 'deliberate-model' }
const DELIBERATE_NAME = 'Deliberate Model'
const REPLACEMENT = { provider: 'deepseek', model: 'replacement-model' }
const REPLACEMENT_NAME = 'Replacement Model'

/**
 * Mutable, so a test can change the application default while the panel is
 * mounted — which is what Settings does, and the case that tells a live reading
 * of the default from a copy taken once at startup.
 */
const catalog = {
  defaultModel: APP_DEFAULT as { provider: string; model: string } | null,
}

/**
 * Both of the catalog's accounts of the default, kept in step.
 *
 * `defaultModel` is the pair when it can run and `defaultModelState` is the
 * deliberate choice behind it. A fixture that moved one without the other would
 * describe a Settings state that cannot exist.
 */
function setApplicationDefault(pair: { provider: string; model: string }): void {
  catalog.defaultModel = pair
}

vi.mock('@/lib/clients/session-client', () => ({
  postSessionMessage: vi.fn(),
  listChatMessages: vi
    .fn()
    .mockResolvedValue({ messages: [], outcomes: [], modelChoices: [] }),
  openAgentTextStream: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn(),
}))

vi.mock('@/lib/clients/agent-generator-client', () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/clients/runtime-client', () => ({
  artifactUrl: (runId: string, artifactPath: string) =>
    `/api/runs/${runId}/assignments/${artifactPath}`,
  fetchArtifact: vi.fn(),
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
            id: APP_DEFAULT.model,
            name: APP_DEFAULT_NAME,
            enabled: true,
            capabilities: ['chat'],
          },
          {
            id: DELIBERATE.model,
            name: DELIBERATE_NAME,
            enabled: true,
            capabilities: ['chat'],
          },
          {
            id: REPLACEMENT.model,
            name: REPLACEMENT_NAME,
            enabled: true,
            capabilities: ['chat'],
          },
        ],
      },
    ],
    defaultModel: catalog.defaultModel,
    defaultModelState: catalog.defaultModel
      ? { status: 'available', ...catalog.defaultModel }
      : { status: 'unset' },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/hooks/use-research-activities', () => ({
  useResearchActivities: vi.fn().mockReturnValue([]),
}))

const SESSION_FIXTURE: SessionSummary = {
  id: 'sess-1',
  title: 'Test Session',
  status: 'active',
  activityType: 'chat',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
}

const RUN_PLAN_FIXTURE: RunPlan = {
  id: 'plan-1',
  goal: 'Name this for me',
  summary: 'Name this for me',
  status: 'needs_input',
  requiredInputs: [],
  actions: [],
  warnings: [],
  createdAt: '2026-09-09T12:00:00.000Z',
}

/** The options the request carried, from the one call that was made. */
function sentOptions(): Record<string, unknown> {
  expect(vi.mocked(mockPostSessionMessage)).toHaveBeenCalledTimes(1)
  const call = vi.mocked(mockPostSessionMessage).mock.calls[0]
  const options = call?.[2]
  return options === undefined ? {} : { ...options }
}

async function send(text: string): Promise<void> {
  const textarea = await screen.findByRole('textbox')
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.keyDown(textarea, { key: 'Enter' })
  await waitFor(() => expect(mockPostSessionMessage).toHaveBeenCalled())
}

async function pick(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(await screen.findByLabelText('Run chat model'))
  // By its option role, so the trigger — which shows the same words — cannot
  // stand in for the list entry.
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }))
  await waitFor(() =>
    expect(screen.getByLabelText('Run chat model')).toHaveTextContent(name),
  )
}

/** Choosing the entry the picker is already showing. */
async function confirmShown(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<void> {
  expect(screen.getByLabelText('Run chat model')).toHaveTextContent(name)
  await user.click(screen.getByLabelText('Run chat model'))
  const option = await screen.findByRole('option', { name: new RegExp(name) })
  expect(option).toHaveAttribute('data-checked', 'true')
  await user.click(option)
  await waitFor(() =>
    expect(screen.queryByRole('option', { name: new RegExp(name) })).toBeNull(),
  )
}

describe('ChatPanel — the model picker as a choice, or as a default', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setApplicationDefault(APP_DEFAULT)
    // A whole response, not a fragment. A cast past the missing `dispatch`,
    // `plan` and `meta` would let the component fail after the send with
    // nothing in the test to notice it.
    vi.mocked(mockPostSessionMessage).mockResolvedValue({
      user: {
        id: 'server-user-1',
        role: 'user',
        text: 'anything',
        createdAt: '2026-09-09T12:00:01.000Z',
      },
      dispatch: { kind: 'coordinator' },
      messages: [
        {
          id: 'server-assistant-1',
          role: 'assistant',
          text: 'Assistant reply',
          createdAt: '2026-09-09T12:00:02.000Z',
        },
      ],
      meta: { model: 'test-model', fallback: false },
      replayed: false,
      plan: RUN_PLAN_FIXTURE,
    })
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
    }
  })

  it('sends no pair when the picker only shows the application default', async () => {
    render(<ChatPanel session={SESSION_FIXTURE} />)
    await waitFor(() =>
      expect(screen.getByLabelText('Run chat model')).toHaveTextContent(
        APP_DEFAULT_NAME,
      ),
    )

    await send('Name this for me')

    const options = sentOptions()
    expect(options.provider).toBeUndefined()
    expect(options.model).toBeUndefined()
  })

  it('sends the pair a person deliberately picked', async () => {
    const user = userEvent.setup()
    render(<ChatPanel session={SESSION_FIXTURE} />)
    await waitFor(() =>
      expect(screen.getByLabelText('Run chat model')).toHaveTextContent(
        APP_DEFAULT_NAME,
      ),
    )

    await pick(user, DELIBERATE_NAME)
    await send('Use the model I picked')

    expect(sentOptions()).toMatchObject(DELIBERATE)
  })

  it('sends a deliberate pick that happens to equal the application default', async () => {
    // The record says who decided, never whether two pairs match. A person who
    // picks the default has still chosen it, and comparing pairs to decide that
    // would silently reclassify their decision as inheritance.
    const user = userEvent.setup()
    render(<ChatPanel session={SESSION_FIXTURE} />)
    await waitFor(() =>
      expect(screen.getByLabelText('Run chat model')).toHaveTextContent(
        APP_DEFAULT_NAME,
      ),
    )

    // Confirmed directly, without visiting another model first: going away and
    // back would have set the choice on the first click and proved nothing
    // about this one. The control calls `onChange` from `onSelect` with no
    // equality check (`model-select.tsx:217`), so choosing the entry already
    // shown really is an act.
    await confirmShown(user, APP_DEFAULT_NAME)
    await send('I meant this one')

    expect(sentOptions()).toMatchObject(APP_DEFAULT)
  })

  it('keeps a choice already made when the application default changes underneath it', async () => {
    // The other half of reading the default live. A person's pick is theirs
    // until they change it: a default that moves in Settings must not quietly
    // take a turn back off the model they selected.
    const user = userEvent.setup()
    const { rerender } = render(<ChatPanel session={SESSION_FIXTURE} />)
    await waitFor(() =>
      expect(screen.getByLabelText('Run chat model')).toHaveTextContent(
        APP_DEFAULT_NAME,
      ),
    )

    await pick(user, DELIBERATE_NAME)
    setApplicationDefault(REPLACEMENT)
    rerender(
      <ChatPanel
        session={{ ...SESSION_FIXTURE, updatedAt: '2026-09-09T12:05:00.000Z' }}
      />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Run chat model')).toHaveTextContent(
        DELIBERATE_NAME,
      ),
    )
    await send('Still mine')
    expect(sentOptions()).toMatchObject(DELIBERATE)
  })

  it('shows the application default that would actually be used, not the one it started with', async () => {
    // Nothing is sent while no one has chosen, so the server resolves whatever
    // the default is *at that moment*. A pair copied once at startup keeps
    // showing the old one, and the page then names a model the turn did not
    // use — the same false account as any other misreported selection.
    const { rerender } = render(<ChatPanel session={SESSION_FIXTURE} />)
    await waitFor(() =>
      expect(screen.getByLabelText('Run chat model')).toHaveTextContent(
        APP_DEFAULT_NAME,
      ),
    )

    setApplicationDefault(REPLACEMENT)
    rerender(<ChatPanel session={{ ...SESSION_FIXTURE, updatedAt: '2026-09-09T12:05:00.000Z' }} />)

    await waitFor(() =>
      expect(screen.getByLabelText('Run chat model')).toHaveTextContent(
        REPLACEMENT_NAME,
      ),
    )
    await send('Name this for me')
    const options = sentOptions()
    expect(options.provider).toBeUndefined()
    expect(options.model).toBeUndefined()
  })
})
