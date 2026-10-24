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

const LM_STUDIO_HOST = 'localhost:1234'

interface GatedStub {
  readonly restore: () => void
  /** Resolves once generation has actually started. */
  readonly started: Promise<void>
  /** Let the held generation finish. */
  readonly release: () => void
}

/**
 * Hold LM Studio open so a turn stays mid-generation. That is the state the
 * classifier has to get right: `agent-chat-service.ts` persists the user
 * message before generation begins, so for the whole of a healthy turn the
 * chat log looks exactly like a crashed one.
 */
function installGatedLmStudioStub(): GatedStub {
  const originalFetch = globalThis.fetch
  let signalStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(LM_STUDIO_HOST)) return originalFetch(input, init)

    const encoder = new TextEncoder()
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'message.delta', content: 'Hel' })}\n\n`,
          ),
        )
        signalStarted()
        await gate
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'chat.end',
              result: {
                output: [{ type: 'message', content: 'Hello' }],
                stats: { input_tokens: 1, total_output_tokens: 1 },
              },
            })}\n\n`,
          ),
        )
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch

  return {
    restore: () => {
      globalThis.fetch = originalFetch
    },
    started,
    release: () => release(),
  }
}

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const projectRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
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

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'In-flight chat' }),
  })
  const session = await response.json() as { id: string }
  return session.id
}

function postChat(url: string, sessionId: string, text: string, turnId: string): Promise<Response> {
  return fetch(`${url}/sessions/${sessionId}/agent-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      agentNames: [],
      provider: 'lm-studio',
      model: 'test-model',
      turnId,
    }),
  })
}

test('a duplicate arriving mid-generation is in-flight, never a crashed partial turn', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-inflight-')
  const stub = installGatedLmStudioStub()
  let server: StartedApiServer | undefined
  let first: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    first = postChat(server.url, sessionId, 'hi', turnId)
    await stub.started

    // The user message is already persisted with zero replies, and the channel
    // is open. This is the whole generation window, not a narrow race.
    const store = new FileSystemSessionStore(workspacePath)
    const midFlight = await store.listChatMessages(sessionId)
    assert.equal(
      midFlight.filter((message: ChatMessage) => message.role === 'user').length,
      1,
      'precondition: the user message is persisted before generation finishes',
    )
    assert.equal(
      midFlight.filter((message: ChatMessage) => message.role === 'assistant').length,
      0,
      'precondition: no reply exists yet',
    )

    const duplicate = await postChat(server.url, sessionId, 'hi', turnId)
    assert.equal(duplicate.status, 409, 'an active turn is a conflict')
    const body = await duplicate.json() as { error?: string }
    assert.equal(body.error, 'turn_in_flight')

    stub.release()
    assert.equal((await first).status, 201)

    // Once it has finished, the same request is a clean replay.
    const replay = await postChat(server.url, sessionId, 'hi', turnId)
    assert.equal(replay.status, 200)
  } finally {
    // Release before anything else: an assertion that threw while the gate was
    // still shut would otherwise leave the in-flight request unresolved and the
    // test runner unable to exit.
    stub.release()
    await first.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a partial turn whose channel is closed replays as incomplete', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-incomplete-')
  const restore = installPlainLmStudioStub()
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    // Run a real turn so the user message carries a genuine fingerprint.
    assert.equal((await postChat(server.url, sessionId, 'hi', turnId)).status, 201)

    // Simulate a crash between persisting the user message and persisting the
    // reply: drop the assistant line from the durable log. The channel is long
    // closed, so only the log describes this turn now.
    const chatPath = path.join(workspacePath, 'sessions', sessionId, 'chat.jsonl')
    const kept = fs
      .readFileSync(chatPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed !== 'object' || parsed === null) return true
        const record: Record<string, unknown> = { ...parsed }
        return !(record.role === 'assistant' && record.turnId === turnId)
      })
    fs.writeFileSync(chatPath, `${kept.join('\n')}\n`, 'utf8')

    const response = await postChat(server.url, sessionId, 'hi', turnId)
    assert.equal(response.status, 200)
    const turn = await response.json() as { incomplete?: boolean; replies: ChatMessage[] }
    assert.equal(turn.incomplete, true, 'a crashed turn replays as incomplete')
    assert.equal(turn.replies.length, 0)
  } finally {
    await server?.close()
    restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('two requests released together produce one turn, not two', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('chat-simultaneous-')
  const restore = installPlainLmStudioStub()
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    // One barrier both requests wait on, so neither can classify before the
    // other exists. No sleeps: the barrier is released explicitly.
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = async (): Promise<Response> => {
      await barrier
      return postChat(server!.url, sessionId, 'hi', turnId)
    }
    const both = Promise.all([send(), send()])
    release()
    const [first, second] = await both

    const statuses = [first.status, second.status].sort((a, b) => a - b)
    assert.deepEqual(
      statuses,
      [201, 409],
      'one request creates the turn; the other is rejected, never a second 201',
    )
    const loser = first.status === 409 ? first : second
    const loserBody = await loser.json() as { error?: string }
    assert.equal(loserBody.error, 'turn_in_flight')

    // Exactly one persisted turn: one user message, one reply.
    const store = new FileSystemSessionStore(workspacePath)
    const messages = await store.listChatMessages(sessionId)
    assert.equal(
      messages.filter((message) => message.role === 'user' && message.turnId === turnId).length,
      1,
      'the losing request appended no second user message',
    )
    assert.equal(
      messages.filter((message) => message.role === 'assistant' && message.turnId === turnId).length,
      1,
      'exactly one reply was persisted',
    )
  } finally {
    await server?.close()
    restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** An ungated stub: every request completes immediately. */
function installPlainLmStudioStub(): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(LM_STUDIO_HOST)) return originalFetch(input, init)
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        for (const frame of [
          { type: 'message.delta', content: 'Hel' },
          { type: 'message.delta', content: 'lo' },
          {
            type: 'chat.end',
            result: {
              output: [{ type: 'message', content: 'Hello' }],
              stats: { input_tokens: 1, total_output_tokens: 2 },
            },
          },
        ]) {
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
