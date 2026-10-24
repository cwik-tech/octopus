/**
 * What the composer may refuse, and what is not its to refuse.
 *
 * The composer used to decide whether a turn could run by looking at the pair
 * in its own picker. That pair is the application default when nobody has
 * chosen anything — so with no default set, everything went dead: a turn
 * addressed to an Agent that names its own provider and model was refused for
 * want of a default it would never have used, and the model picker, the one
 * control that could have supplied a pair, was disabled by the same absence it
 * exists to fix. Nothing on screen said why.
 *
 * The rule these pin down is narrow. A pair somebody chose has to be one that
 * can actually run, and a turn that would use it is refused out loud when it
 * cannot. Everything else is the server's to answer: without a usable choice
 * the composer sends no pair at all, and an Agent's own model, or the
 * application default, or a plain refusal when there is neither, is decided
 * where the record of it is written. No model is ever invented to fill the gap.
 *
 * Driven through the real provider catalog, the real session and agent clients
 * and the real picker, with only the HTTP boundary replaced. Nothing this
 * component depends on is stubbed in its place: what is under test is how these
 * parts behave together, and swapping one of them out is how a test comes to
 * agree with itself instead of with the product.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import ChatPanel from '../chat-panel'
import {
  ProviderCatalogProvider,
  useProviderCatalog,
} from '@/contexts/provider-catalog-context'
import type { SessionSummary } from '@/lib/models/session-model'

const PROVIDER = 'deepseek'
const APP_DEFAULT = { provider: PROVIDER, model: 'app-default-model' }
const DELIBERATE_NAME = 'Deliberate Model'
const DELIBERATE = { provider: PROVIDER, model: 'deliberate-model' }
/** A pair that is chosen once and then stops being offered. */
const RETIRED_NAME = 'Retired Model'
const RETIRED = { provider: PROVIDER, model: 'retired-model' }

const SESSION_FIXTURE: SessionSummary = {
  id: 'sess-1',
  title: 'Test Session',
  status: 'active',
  activityType: 'chat',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
}

const NAMED_AGENT_TARGET = { kind: 'agents' as const, agentNames: ['reviewer'] }
const TEAM_TARGET = { kind: 'team' as const, teamId: 'review-team' }

/** What the fake service currently holds. Mutable between renders. */
const service = {
  defaultModel: null as { provider: string; model: string } | null,
  offersRetiredModel: true,
}

/** Every message this session posted, as the wire carried it. */
const posted: Record<string, unknown>[] = []
/** Paths the fake service was asked for and does not serve. Asserted empty. */
const unmatched: string[] = []


const INTERRUPTED_TURN_ID = '4a2277b8-e9cf-453e-b058-60b5a55a8b10'

/** What `GET /sessions/:id/messages` currently returns. Mutable per test. */
let transcript: {
  messages: unknown[]
  outcomes: unknown[]
  modelChoices: unknown[]
} = { messages: [], outcomes: [], modelChoices: [] }

/** A turn that was interrupted, so the panel offers its Retry. */
function interruptedTranscript() {
  return {
    modelChoices: [],
    messages: [
      {
        id: `${INTERRUPTED_TURN_ID}:user`,
        role: 'user',
        text: 'Review the supply agreement.',
        createdAt: '2026-09-09T09:00:00.000Z',
        turnId: INTERRUPTED_TURN_ID,
      },
    ],
    outcomes: [
      {
        turnId: INTERRUPTED_TURN_ID,
        state: 'interrupted',
        code: 'provider_interrupted',
        retryable: true,
        // Who the interrupted turn was addressed to. Retry routes from this
        // record rather than from the composer, which is the other path a
        // stale picker must not be able to refuse.
        agentNames: ['reviewer'],
      },
    ],
  }
}

function catalogGroups() {
  return [
    {
      provider: PROVIDER,
      name: 'DeepSeek',
      icon: 'deepseek',
      source: 'connection',
      models: [
        {
          id: APP_DEFAULT.model,
          name: 'App Default Model',
          enabled: true,
          capabilities: ['chat'],
        },
        {
          id: DELIBERATE.model,
          name: DELIBERATE_NAME,
          enabled: true,
          capabilities: ['chat'],
        },
        ...(service.offersRetiredModel
          ? [
              {
                id: RETIRED.model,
                name: RETIRED_NAME,
                enabled: true,
                capabilities: ['chat'],
              },
            ]
          : []),
      ],
    },
  ]
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * The one boundary that is replaced: HTTP.
 *
 * Routed by path, the way the desktop routes it, so the clients under test do
 * their own encoding, decoding and error handling rather than being bypassed.
 */
function stubService(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(
        typeof input === 'string' ? input : (input as { url?: string }).url ?? '',
      )
      if (url.includes('/settings/model-catalog')) {
        return json({
          catalog: catalogGroups(),
          defaultModel: service.defaultModel,
          defaultModelState: service.defaultModel
            ? { status: 'available', ...service.defaultModel }
            : { status: 'unset' },
        })
      }
      if (url.includes('/create/agents')) {
        return json({
          agents: [
            {
              name: 'reviewer',
              description: 'Reviews contracts on its own pair.',
              skills: ['review'],
              usedInTeams: [],
            },
          ],
        })
      }
      if (url.includes('/messages') && init?.method === 'POST') {
        const body: unknown = JSON.parse(String(init.body ?? '{}'))
        if (body && typeof body === 'object') posted.push({ ...body })
        return json({
          user: {
            id: 'server-user-1',
            role: 'user',
            text: 'anything',
            createdAt: '2026-09-09T12:00:01.000Z',
          },
          dispatch: { kind: 'coordinator' },
          messages: [],
          meta: { model: 'test-model', fallback: false },
          replayed: false,
          plan: {
            id: 'plan-1',
            goal: 'g',
            summary: 's',
            status: 'needs_input',
            requiredInputs: [],
            actions: [],
            warnings: [],
            createdAt: '2026-09-09T12:00:00.000Z',
          },
        })
      }
      if (url.includes('/agent-chat/stream')) {
        // A stream that is already over. The client reads until the body ends,
        // so an empty finite one is a channel with nothing in it rather than a
        // connection left hanging (`session-client.ts:1599`).
        return new Response('', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (url.includes('/mcp-interactions')) {
        return json({ interactions: [] })
      }
      if (url.includes('/messages')) {
        return json(transcript)
      }
      if (url.includes('/files')) {
        return json({ files: [] })
      }
      if (url.endsWith('/folders') && (init?.method ?? 'GET') === 'GET') {
        // The header's folder control lists the chat's attached folders.
        return json({ folders: [] })
      }
      if (url.includes('/research-activity')) {
        return json({ activities: [] })
      }
      // Answered by name or not at all. A body shaped to satisfy every reader
      // at once would let a route change, or a decoder change, pass unnoticed
      // here — which is the opposite of driving the real clients.
      unmatched.push(url)
      return new Response(JSON.stringify({ error: `unexpected path: ${url}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

/**
 * Re-reads the catalog through the context's own public `refresh`.
 *
 * The provider fetches once on mount and its `refresh` is stable, so a rerender
 * changes nothing. Remounting would change the catalog and lose the choice
 * being tested at the same time, which is the opposite of what these need: a
 * pair chosen while it was offered, still chosen after it stopped being.
 */
function CatalogRefresher() {
  const { refresh } = useProviderCatalog()
  return (
    <button type="button" onClick={() => void refresh()}>
      refresh catalog
    </button>
  )
}

function renderPanel(props: Record<string, unknown> = {}) {
  return render(
    <ProviderCatalogProvider>
      <CatalogRefresher />
      <ChatPanel session={SESSION_FIXTURE} {...props} />
    </ProviderCatalogProvider>,
  )
}

/** Withdraws the retired model and waits for the picker to say so. */
async function retireChosenModel(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  service.offersRetiredModel = false
  await user.click(screen.getByRole('button', { name: 'refresh catalog' }))
  await waitFor(() =>
    expect(screen.getByLabelText('Run chat model')).toHaveTextContent(/unavailable/i),
  )
}

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<void> {
  await user.click(await screen.findByLabelText('Run chat model'))
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }))
  await waitFor(() =>
    expect(screen.getByLabelText('Run chat model')).toHaveTextContent(name),
  )
}

async function send(text: string): Promise<void> {
  const textarea = await screen.findByRole('textbox')
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.keyDown(textarea, { key: 'Enter' })
  await waitFor(() => expect(posted.length).toBeGreaterThan(0))
}

/** The composer's own model picker, once the catalog has arrived. */
async function readyPicker() {
  const picker = await screen.findByLabelText('Run chat model')
  await waitFor(() => expect(picker).toBeEnabled())
  return picker
}

describe('ChatPanel — what the composer may refuse', () => {
  beforeEach(() => {
    posted.length = 0
    unmatched.length = 0
    transcript = { messages: [], outcomes: [], modelChoices: [] }
    service.defaultModel = APP_DEFAULT
    service.offersRetiredModel = true
    stubService()
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
    }
  })

  afterEach(() => {
    // Cleanup first, whatever the report says. An assertion thrown before the
    // globals are restored leaves the next test running against this one's
    // fixture, and a file of cascading failures hides which one is real.
    try {
      // A path this fixture does not serve is a routing or decoding change
      // these tests would otherwise sail past.
      expect(unmatched.join(' | ')).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('dispatches to a named Agent when no application default is set', async () => {
    // The Agent names its own provider and model. Whether the application has a
    // default decides nothing about this turn, and refusing it for want of one
    // refuses a turn that would have run perfectly well.
    service.defaultModel = null
    renderPanel({ target: NAMED_AGENT_TARGET })

    const composer = await screen.findByRole('textbox')
    await waitFor(() => expect(composer).toBeEnabled())

    await send('Review the supply agreement.')

    expect(posted[0]?.target).toEqual(NAMED_AGENT_TARGET)
    // And no pair is invented on the way out: the Agent's own is the server's
    // to apply.
    expect(posted[0]?.provider).toBeUndefined()
    expect(posted[0]?.model).toBeUndefined()
  })

  it('keeps the model picker usable when no application default is set', async () => {
    // The picker is what supplies a pair when nothing else does. Disabling it
    // because nothing else does leaves a person with no way out at all.
    service.defaultModel = null
    const user = userEvent.setup()
    renderPanel()

    await readyPicker()
    await pick(user, DELIBERATE_NAME)
    await send('Use the one I picked')

    expect(posted[0]).toMatchObject(DELIBERATE)
  })

  it('does not let a stale choice block a turn addressed to a named Agent', async () => {
    // A pair chosen earlier can stop being offered — a connection edited, a
    // model withdrawn. That is a fact about the picker, and a turn addressed to
    // an Agent running on its own model has nothing to do with it.
    const user = userEvent.setup()
    renderPanel({ target: NAMED_AGENT_TARGET })
    await readyPicker()
    await pick(user, RETIRED_NAME)
    await retireChosenModel(user)

    await send('Review it anyway')
    expect(posted[0]?.target).toEqual(NAMED_AGENT_TARGET)
    // The broken pair is not sent along to be tried anyway.
    expect(posted[0]?.provider).toBeUndefined()
  })

  it('does not let a stale choice block a turn addressed to a Team', async () => {
    // The same rule for the other addressee that runs on its own models. A Team
    // is a roster of Agents with their own pairs; the composer's picker is not
    // what carries any of them.
    const user = userEvent.setup()
    renderPanel({ target: TEAM_TARGET })
    await readyPicker()
    await pick(user, RETIRED_NAME)
    await retireChosenModel(user)

    await send('Team, take this one')
    expect(posted[0]?.target).toEqual(TEAM_TARGET)
    expect(posted[0]?.provider).toBeUndefined()
  })

  it('refuses an unaddressed turn on a chosen pair that cannot run, and says so', async () => {
    // The one refusal that belongs to the composer, and only for a turn that
    // would have used the pair. It is said out loud: a disabled box explains
    // nothing, and the person needs to know which of their own choices broke.
    const user = userEvent.setup()
    renderPanel()
    await readyPicker()
    await pick(user, RETIRED_NAME)
    await retireChosenModel(user)

    const composer = await screen.findByRole('textbox')
    fireEvent.change(composer, { target: { value: 'Answer this yourself' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument()
    expect(posted).toHaveLength(0)
    // The refused draft is still there to correct. `PromptInput` clears its
    // composer once `onSubmit` resolves, so a refusal that returned quietly
    // would take the person's message with it.
    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue('Answer this yourself'),
    )
    // And their choice is left as they made it, shown as the broken thing it
    // is. Replacing it quietly is the other way to lose a decision.
    const picker = screen.getByLabelText('Run chat model')
    expect(picker).toHaveTextContent(RETIRED.model)
    expect(picker).toHaveTextContent(/unavailable/i)
  })

  it('lets a broken choice be talked past by mentioning an Agent', async () => {
    // Typing a mention is one of the ways out of a broken selection, so the
    // composer stays editable through all of it — a box disabled for the pair's
    // sake would take that way out away. Driven as a person drives it: the
    // mention is typed, the list offers the Agent, and the turn routes to it.
    const user = userEvent.setup()
    renderPanel()
    await readyPicker()
    await pick(user, RETIRED_NAME)
    await retireChosenModel(user)

    const composer = await screen.findByRole('textbox')
    expect(composer).toBeEnabled()
    await user.click(composer)
    await user.type(composer, '@')
    const search = await screen.findByRole('combobox', { name: 'Search agents to mention' })
    await user.type(search, 'reviewer')
    await user.click(await screen.findByRole('option', { name: 'Reviewer' }))
    await user.type(composer, 'take this one')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(posted.length).toBeGreaterThan(0))
    expect(posted[0]?.target).toEqual({ kind: 'agents', agentNames: ['reviewer'] })
    expect(posted[0]?.provider).toBeUndefined()
  })

  it('does not let a stale choice block the retry of an interrupted turn', async () => {
    // A retry names its own addressee, from the record of the turn that was
    // interrupted, and never consults the composer's picker. So a pair the
    // picker can no longer offer has nothing to do with it — and refusing the
    // retry would strand the one turn a person most wants back.
    transcript = interruptedTranscript()
    const user = userEvent.setup()
    renderPanel()
    await readyPicker()
    await pick(user, RETIRED_NAME)
    await retireChosenModel(user)

    await user.click(await screen.findByRole('button', { name: /Retry/i }))

    await waitFor(() => expect(posted.length).toBeGreaterThan(0))
    expect(posted[0]?.target).toEqual({ kind: 'agents', agentNames: ['reviewer'] })
    expect(posted[0]?.provider).toBeUndefined()
  })

  it('sends no pair for an unaddressed turn when nothing has been chosen', async () => {
    // No default, no choice, no Agent. Nothing is invented on the way out. What
    // the server then answers is its own business, and is proved against the
    // real API and the desktop rather than here.
    service.defaultModel = null
    renderPanel()

    await send('Just talk to me')

    expect(posted[0]?.provider).toBeUndefined()
    expect(posted[0]?.model).toBeUndefined()
  })
})
