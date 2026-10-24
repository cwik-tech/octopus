/**
 * The notice for models that can't use the folder tools
 * (docs/feature-local-folder-access.md, "Models that can't use tools"; LF-09).
 *
 * The server marks a reply that ran without tools in a turn with folders
 * (tests/integration/folder-tools-unavailable.test.ts). The chat says so in one
 * line under its header until a later reply in that chat ran with tools, and
 * another chat never inherits it.
 *
 * Driven through the real panel, the real session client and the real provider
 * catalog, with only the HTTP boundary replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import ChatPanel from '../chat-panel'
import { ProviderCatalogProvider } from '@/contexts/provider-catalog-context'
import type { SessionSummary } from '@/lib/models/session-model'

const NOTICE =
  "This model can see folder names but can't open files. Use a model with tool support to work with folder contents."

function makeSession(id: string, title: string): SessionSummary {
  return {
    id,
    title,
    status: 'active',
    activityType: 'chat',
    createdAt: '2026-10-08T12:00:00.000Z',
    updatedAt: '2026-10-08T12:00:00.000Z',
  }
}

const FOLDER_CHAT = makeSession('sess-folders', 'Folder chat')
const OTHER_CHAT = makeSession('sess-other', 'Other chat')
const TARGET = { kind: 'agents' as const, agentNames: ['reader'] }

/** Whether each next reply ran without folder tools, in the order they are asked for. */
let replies: boolean[] = []
/** Every message posted, by session. */
const posted: string[] = []
/** Paths the fake service does not serve. Asserted empty. */
const unmatched: string[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The agent dispatch envelope the server answers a turn with. */
function agentTurn(sessionId: string, folderToolsUnavailable: boolean): Response {
  const n = posted.length
  return json({
    dispatch: { kind: 'agents', agentNames: ['reader'] },
    user: { id: `${sessionId}-user-${n}`, role: 'user', text: 'question', createdAt: '2026-10-08T12:00:01.000Z' },
    messages: [{
      id: `${sessionId}-reply-${n}`,
      role: 'assistant',
      text: `Answer ${n}.`,
      createdAt: '2026-10-08T12:00:02.000Z',
      speaker: { type: 'agent', id: 'reader', name: 'Reader' },
    }],
    meta: {
      replies: [{
        speakerId: 'reader',
        speakerName: 'Reader',
        model: 'some-model',
        fallback: false,
        ...(folderToolsUnavailable ? { folderToolsUnavailable: true } : {}),
      }],
    },
    replayed: false,
  }, 201)
}

function stubService(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : '')
    const method = init?.method ?? 'GET'
    if (url.includes('/settings/model-catalog')) {
      return json({ catalog: [], defaultModel: null, defaultModelState: { status: 'unset' } })
    }
    if (url.includes('/create/agents')) {
      return json({ agents: [{ name: 'reader', description: 'Reads folders.', skills: [], usedInTeams: [] }] })
    }
    const sessionId = /\/sessions\/([^/]+)\//.exec(url)?.[1] ?? ''
    if (url.endsWith('/messages') && method === 'POST') {
      posted.push(sessionId)
      return agentTurn(sessionId, replies.shift() ?? false)
    }
    if (url.includes('/agent-chat/stream')) {
      return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.includes('/mcp-interactions')) return json({ interactions: [] })
    if (url.includes('/messages')) return json({ messages: [], outcomes: [], modelChoices: [] })
    if (url.includes('/files')) return json({ files: [] })
    if (url.endsWith('/folders') && method === 'GET') return json({ folders: [] })
    if (url.includes('/research-activity')) return json({ activities: [] })
    unmatched.push(`${method} ${url}`)
    return json({ error: `unexpected path: ${url}` }, 500)
  }))
}

function panel(session: SessionSummary) {
  return (
    <ProviderCatalogProvider>
      <ChatPanel session={session} target={TARGET} />
    </ProviderCatalogProvider>
  )
}

/** Sends one turn and waits until its reply is on screen. */
async function sendAndAwaitReply(text: string): Promise<void> {
  const before = posted.length
  const composer = await screen.findByRole('textbox')
  await waitFor(() => expect(composer).toBeEnabled())
  fireEvent.change(composer, { target: { value: text } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  await waitFor(() => expect(posted.length).toBe(before + 1))
  expect(await screen.findByText(`Answer ${before + 1}.`)).toBeInTheDocument()
}

describe('ChatPanel — the notice for models without folder tools', () => {
  beforeEach(() => {
    replies = []
    posted.length = 0
    unmatched.length = 0
    stubService()
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
    }
  })

  afterEach(() => {
    try {
      expect(unmatched.join(' | ')).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows the notice after a reply without folder tools and clears it once a later reply ran with them', async () => {
    replies = [true, false]
    render(panel(FOLDER_CHAT))
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()

    await sendAndAwaitReply('What is in my notes?')
    expect(screen.getByText(NOTICE)).toBeInTheDocument()

    await sendAndAwaitReply('And now, with tools?')
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })

  it('does not carry the notice over to another chat', async () => {
    replies = [true]
    const { rerender } = render(panel(FOLDER_CHAT))
    await sendAndAwaitReply('What is in my notes?')
    expect(screen.getByText(NOTICE)).toBeInTheDocument()

    rerender(panel(OTHER_CHAT))

    expect(await screen.findByText('Other chat')).toBeInTheDocument()
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })
})
