import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { ChatMessage } from '../../contracts/sessions.js'

interface ChatTurnResponse {
  readonly user: ChatMessage
  readonly replies: ChatMessage[]
  readonly incomplete?: boolean
}

const LM_STUDIO_HOST = 'localhost:1234'

/**
 * Intercept only the LM Studio endpoint. The test's own calls to the API server
 * must keep working, so everything else is delegated to the real fetch.
 */
function installLmStudioStub(deltas: readonly string[], finalText: string): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(LM_STUDIO_HOST)) {
      return originalFetch(input, init)
    }
    const frames = [
      ...deltas.map((content) => ({ type: 'message.delta', content })),
      {
        type: 'chat.end',
        result: {
          output: [{ type: 'message', content: finalText }],
          stats: { input_tokens: 1, total_output_tokens: deltas.length },
        },
      },
    ]
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        }
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Streaming chat' }),
  })
  assert.equal(response.status, 201)
  const session = await response.json() as { id: string }
  return session.id
}

function chatBody(text: string, turnId?: string): string {
  return JSON.stringify({
    text,
    agentNames: [],
    provider: 'lm-studio',
    model: 'test-model',
    ...(turnId === undefined ? {} : { turnId }),
  })
}

async function postChat(
  url: string,
  sessionId: string,
  text: string,
  turnId?: string,
): Promise<Response> {
  return fetch(`${url}/sessions/${sessionId}/agent-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chatBody(text, turnId),
  })
}

async function listChat(url: string, sessionId: string): Promise<ChatMessage[]> {
  const response = await fetch(`${url}/sessions/${sessionId}/messages`)
  assert.equal(response.status, 200)
  const body = await response.json() as { messages: ChatMessage[] }
  return body.messages
}

function makeWorkspace(prefix: string): { directory: string; workspacePath: string; projectRoot: string } {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const projectRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(projectRoot, { recursive: true })
  // Agent chat refuses to run without one (agent-chat-service.ts:771-775).
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })
  return { directory, workspacePath, projectRoot }
}

async function startServer(workspacePath: string, projectRoot: string): Promise<StartedApiServer> {
  return startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: projectRoot,
    workspacePath,
  })
}

test('a turn sent with no turnId behaves exactly as before', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-no-id-')
  const restoreFetch = installLmStudioStub(['Hel', 'lo'], 'Hello')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)

    const response = await postChat(server.url, sessionId, 'hi')
    assert.equal(response.status, 201, await response.clone().text())
    const turn = await response.json() as ChatTurnResponse
    assert.equal(turn.replies[0]?.text, 'Hello')
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a malformed turnId is rejected before any generation happens', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-bad-id-')
  const restoreFetch = installLmStudioStub(['x'], 'x')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)

    const response = await postChat(server.url, sessionId, 'hi', 'not-a-uuid')
    assert.equal(response.status, 400)

    assert.deepEqual(await listChat(server.url, sessionId), [])
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a malformed turnId is rejected at the request boundary, before project work', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-boundary-')
  const restoreFetch = installLmStudioStub(['x'], 'x')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)

    // The wording identifies where the rejection came from. The request schema
    // prefixes "Field"; the old downstream service check did not. Asserting the
    // schema's wording is what proves the id is validated at the boundary
    // rather than after project-context resolution.
    const response = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'hi',
          agentNames: [],
          provider: 'lm-studio',
          model: 'test-model',
          turnId: 'not-a-uuid',
        }),
      },
    )
    assert.equal(response.status, 400)
    const body = await response.json() as { error?: string }
    assert.match(
      String(body.error),
      /^Field turnId must be a UUID$/,
      'rejected by the request schema, not by a downstream service check',
    )
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('replaying a completed turn returns 200 and persists nothing new', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-replay-')
  const restoreFetch = installLmStudioStub(['Hel', 'lo'], 'Hello')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    const first = await postChat(server.url, sessionId, 'hi', turnId)
    assert.equal(first.status, 201, await first.clone().text())
    const afterFirst = await listChat(server.url, sessionId)

    const replay = await postChat(server.url, sessionId, 'hi', turnId)
    assert.equal(replay.status, 200, 'a replay is a 200, not a second 201')
    const replayTurn = await replay.json() as ChatTurnResponse
    assert.equal(replayTurn.replies[0]?.text, 'Hello')

    const afterReplay = await listChat(server.url, sessionId)
    assert.deepEqual(
      afterReplay.map((message) => message.id),
      afterFirst.map((message) => message.id),
      'the replay wrote nothing to the chat log',
    )
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('reusing a turnId with a different request is a conflict, not a replay', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-mismatch-')
  const restoreFetch = installLmStudioStub(['Hel', 'lo'], 'Hello')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    assert.equal((await postChat(server.url, sessionId, 'first question', turnId)).status, 201)

    const mismatched = await postChat(server.url, sessionId, 'a different question', turnId)
    assert.equal(mismatched.status, 409)
    const body = await mismatched.json() as { error?: string }
    assert.equal(body.error, 'turn_id_reused')
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a changed model with the same turnId is also a conflict', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-model-')
  const restoreFetch = installLmStudioStub(['Hel', 'lo'], 'Hello')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    assert.equal((await postChat(server.url, sessionId, 'hi', turnId)).status, 201)

    const changed = await fetch(`${server.url}/sessions/${sessionId}/agent-chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hi',
        agentNames: [],
        provider: 'lm-studio',
        model: 'a-different-model',
        turnId,
      }),
    })
    assert.equal(changed.status, 409)
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a stored turn with no recorded request cannot be verified and is refused', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-legacy-')
  const restoreFetch = installLmStudioStub(['Hel', 'lo'], 'Hello')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    // A turn written before this change: it carries a turnId but no fingerprint.
    const store = new FileSystemSessionStore(workspacePath)
    await store.appendChatMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      text: 'legacy question',
      createdAt: new Date().toISOString(),
      turnId,
    })

    const response = await postChat(server.url, sessionId, 'legacy question', turnId)
    assert.equal(response.status, 409)
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the chat log, not the hub, is the replay authority across an API restart', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-restart-')
  const restoreFetch = installLmStudioStub(['Hel', 'lo'], 'Hello')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    assert.equal((await postChat(server.url, sessionId, 'hi', turnId)).status, 201)
    const afterFirst = await listChat(server.url, sessionId)

    // Restart: the in-memory hub is gone, the chat log is not.
    await server.close()
    server = await startServer(workspacePath, projectRoot)

    const replay = await postChat(server.url, sessionId, 'hi', turnId)
    assert.equal(replay.status, 200, 'still a replay after the hub was lost')
    const afterReplay = await listChat(server.url, sessionId)
    assert.equal(afterReplay.length, afterFirst.length, 'no duplicate turn was written')

    const mismatched = await postChat(server.url, sessionId, 'something else', turnId)
    assert.equal(mismatched.status, 409, 'mismatch is still detected after a restart')
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the user message records the fingerprint and the expected reply count', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-fingerprint-')
  const restoreFetch = installLmStudioStub(['Hel', 'lo'], 'Hello')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    assert.equal((await postChat(server.url, sessionId, 'hi', turnId)).status, 201)

    const messages = await listChat(server.url, sessionId)
    const userMessage = messages.find(
      (message) => message.role === 'user' && message.turnId === turnId,
    )
    assert.ok(userMessage)
    assert.ok(userMessage.turnRequest, 'the request fingerprint is persisted')
    assert.equal(typeof userMessage.turnRequest.fingerprint, 'string')
    assert.equal(userMessage.turnRequest.expectedReplies, 1)
  } finally {
    await server?.close()
    restoreFetch()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('another view can cancel a silent agent turn by its session and turn IDs', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-remote-stop-')
  const originalFetch = globalThis.fetch
  let ready = () => {}
  const requested = new Promise<void>((resolve) => { ready = resolve })
  const caller = new AbortController()
  // The external provider is nondeterministic; replace only its HTTP boundary.
  globalThis.fetch = (input, init) => {
    const url = String(input)
    if (!url.includes(LM_STUDIO_HOST)) return originalFetch(input, init)
    ready()
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
    })
  }
  let server: StartedApiServer | undefined
  let response: Promise<Response> | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const otherSessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()
    response = fetch(`${server.url}/sessions/${sessionId}/agent-chat/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: chatBody('Hold this answer', turnId), signal: AbortSignal.any([caller.signal, AbortSignal.timeout(2000)]),
    })
    await requested
    const refused = await fetch(`${server.url}/sessions/${otherSessionId}/turns/${turnId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(2000) })
    assert.equal(refused.status, 404)
    const stopped = await fetch(`${server.url}/sessions/${sessionId}/turns/${turnId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(2000) })
    assert.equal(stopped.status, 202, await stopped.text())
    await response.catch(() => assert.fail('Stop was accepted but the original request did not finish before its safety deadline'))
    const transcript = await fetch(`${server.url}/sessions/${sessionId}/messages`, { signal: AbortSignal.timeout(2000) })
    const body = await transcript.json()
    assert.deepEqual(body.activeTurnIds, [])
    assert.equal(body.outcomes[0]?.state, 'cancelled')
    assert.equal(body.messages.filter((message: ChatMessage) => message.role === 'assistant').length, 0)
    const ended = await fetch(`${server.url}/sessions/${sessionId}/turns/${turnId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(2000) })
    assert.equal(ended.status, 404, 'completed turns must release their live cancellation controller')
    const malformed = await fetch(`${server.url}/sessions/${sessionId}/turns/not-a-uuid/cancel`, { method: 'POST', signal: AbortSignal.timeout(2000) })
    assert.equal(malformed.status, 400)
  } finally {
    caller.abort()
    await response?.catch(() => undefined)
    await server?.close()
    globalThis.fetch = originalFetch
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
