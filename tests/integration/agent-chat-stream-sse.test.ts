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
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { buildChatMessage } from '../../services/session-service.js'

const LM_STUDIO_HOST = 'localhost:1234'

test('a saved answer stops appearing active while its channel remains open for titling', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-title-wait-')
  const store = new FileSystemSessionStore(workspacePath)
  const hub = new AgentTextStreamHub()
  const session = await store.createSession({ title: 'Untitled session' })
  const turnId = crypto.randomUUID()
  await store.appendChatMessage(session.id, buildChatMessage('user', 'Which ontology describes flowers?', {
    turnId, turnRequest: { fingerprint: 'a'.repeat(64), expectedReplies: 1 },
  }))
  hub.openChannel(turnId, session.id)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath), launcher: new PiRunLauncher(),
    sessionStore: store, repoRootPath: projectRoot, workspacePath, agentTextStreamHub: hub,
  })
  try {
    const pending = await fetch(`${server.url}/sessions/${session.id}/messages`, { signal: AbortSignal.timeout(5_000) })
    const pendingBody: unknown = await pending.json()
    assert.ok(typeof pendingBody === 'object' && pendingBody !== null && 'activeTurnIds' in pendingBody)
    assert.deepEqual(pendingBody.activeTurnIds, [turnId])
    // The service persists its reply before optional title generation closes the channel.
    await store.appendChatMessage(session.id, buildChatMessage('assistant', 'Use Plant Ontology.', { turnId }))
    const finished = await fetch(`${server.url}/sessions/${session.id}/messages`, { signal: AbortSignal.timeout(5_000) })
    const finishedBody: unknown = await finished.json()
    assert.ok(typeof finishedBody === 'object' && finishedBody !== null && 'activeTurnIds' in finishedBody)
    assert.deepEqual(finishedBody.activeTurnIds, [])
  } finally {
    hub.closeChannel(turnId)
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

interface SseFrame {
  readonly id: number | undefined
  readonly event: string
  readonly data: Record<string, unknown>
}

interface GatedStub {
  readonly restore: () => void
  readonly started: Promise<void>
  readonly release: () => void
}

function installGatedLmStudioStub(deltas: readonly string[]): GatedStub {
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
        for (const content of deltas) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'message.delta', content })}\n\n`),
          )
        }
        signalStarted()
        await gate
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'chat.end',
              result: {
                output: [{ type: 'message', content: deltas.join('') }],
                stats: { input_tokens: 1, total_output_tokens: deltas.length },
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

/** Read the stream to completion, parsing SSE frames. */
async function readStream(response: Response): Promise<SseFrame[]> {
  assert.ok(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames: SseFrame[] = []
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      while (buffer.includes('\n\n')) {
        const separator = buffer.indexOf('\n\n')
        const block = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        if (block.startsWith(':') || block.trim().length === 0) continue
        let id: number | undefined
        let event = 'message'
        const dataLines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = Number.parseInt(line.slice(3).trim(), 10)
          if (line.startsWith('event:')) event = line.slice(6).trim()
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length === 0) continue
        const parsed: unknown = JSON.parse(dataLines.join('\n'))
        assert.ok(typeof parsed === 'object' && parsed !== null)
        frames.push({ id, event, data: { ...parsed } })
      }
    }
  } finally {
    reader.releaseLock()
  }
  return frames
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
    // A GET may wait for its channel; keep that deadline short so the cases
    // that can never be satisfied fail fast and deterministically.
    agentTextStreamWaitMs: 250,
  })
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'SSE chat' }),
  })
  const session = await response.json() as { id: string }
  return session.id
}

function postChat(url: string, sessionId: string, turnId: string): Promise<Response> {
  return fetch(`${url}/sessions/${sessionId}/agent-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'hi',
      agentNames: [],
      provider: 'lm-studio',
      model: 'test-model',
      turnId,
    }),
  })
}

test('the stream delivers deltas in cursor order and closes when the turn ends', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-order-')
  const stub = installGatedLmStudioStub(['Hel', 'lo ', 'world'])
  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    turn = postChat(server.url, sessionId, turnId)
    await stub.started

    const stream = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(stream.status, 200)
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)

    stub.release()
    const frames = await readStream(stream)

    const deltas = frames.filter((frame) => frame.event === 'delta')
    assert.deepEqual(
      deltas.map((frame) => frame.data.text),
      ['Hel', 'lo ', 'world'],
      'every delta arrives, in order, carrying only its suffix',
    )

    const ids = frames
      .map((frame) => frame.id)
      .filter((id): id is number => id !== undefined)
    for (let index = 1; index < ids.length; index += 1) {
      assert.ok(
        (ids[index] ?? 0) > (ids[index - 1] ?? 0),
        'SSE ids are the channel cursor and stay strictly monotonic',
      )
    }
    assert.equal(ids[0], 0)

    assert.ok(
      frames.some((frame) => frame.event === 'final'),
      'the reply is terminated by a final frame',
    )
    assert.equal((await turn).status, 201)
  } finally {
    stub.release()
    await turn.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('every delta carries the replyId that binds it to a speaker bubble', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-reply-')
  const stub = installGatedLmStudioStub(['one', 'two'])
  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    turn = postChat(server.url, sessionId, turnId)
    await stub.started
    const stream = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    stub.release()
    const frames = await readStream(stream)

    const replyIds = new Set(
      frames
        .filter((frame) => frame.event === 'delta' || frame.event === 'final')
        .map((frame) => frame.data.replyId),
    )
    assert.equal(replyIds.size, 1, 'a single-speaker turn uses one replyId')
    const replyId = [...replyIds][0]
    assert.equal(typeof replyId, 'string')
    assert.match(String(replyId), /:0$/, 'the replyId ends with the speaker ordinal')
    assert.equal((await turn).status, 201)
  } finally {
    stub.release()
    await turn.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a provider failure publishes an error frame, never a truncated final', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-error-')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(LM_STUDIO_HOST)) return originalFetch(input, init)
    // A transport/auth style failure. Nothing about this is truncation.
    return new Response(
      JSON.stringify({ error: { type: 'model_not_found', message: 'unknown model' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof globalThis.fetch

  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    assert.equal((await postChat(server.url, sessionId, turnId)).status, 201)

    // The channel is closed but still inside its retention window, so the pump
    // replays what it holds and then ends.
    const stream = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(stream.status, 200)
    const frames = await readStream(stream)

    assert.equal(
      frames.some(
        (frame) => frame.event === 'final' && frame.data.reason === 'truncated',
      ),
      false,
      'a provider failure is not truncation and must not be labelled as such',
    )

    const errorFrame = frames.find((frame) => frame.event === 'error')
    assert.ok(errorFrame, 'a failed reply publishes an error frame')
    assert.equal(typeof errorFrame.data.message, 'string')
    // Display-safe: the formatted message the user is shown, not the raw
    // provider payload. The reply text and the frame agree, so the bubble and
    // the persisted message say the same thing.
    const message = String(errorFrame.data.message)
    assert.ok(message.length > 0)
    assert.match(message, /not found. Check provider settings/i)
    assert.equal(
      message.includes('model_not_found'),
      false,
      'the raw provider error payload is not leaked into the stream',
    )
  } finally {
    await server?.close()
    globalThis.fetch = originalFetch
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a successful reply publishes final completed', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-completed-')
  const stub = installGatedLmStudioStub(['ok'])
  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    turn = postChat(server.url, sessionId, turnId)
    await stub.started
    const stream = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    stub.release()
    const frames = await readStream(stream)

    const finals = frames.filter((frame) => frame.event === 'final')
    assert.equal(finals.length, 1)
    assert.equal(finals[0]?.data.reason, 'completed')
    assert.equal(
      frames.some((frame) => frame.event === 'error'),
      false,
    )
    assert.equal((await turn).status, 201)
  } finally {
    stub.release()
    await turn.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a stream opened before the turn starts receives that turn\'s frames', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-before-')
  const stub = installGatedLmStudioStub(['Hel', 'lo'])
  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  let streamAbort: AbortController | undefined
  let streamPromise: Promise<Response> | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    // The UI mints the id, subscribes, and only then sends the turn. The
    // stream must wait for its channel rather than 404 on arrival order.
    streamAbort = new AbortController()
    streamPromise = fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' }, signal: streamAbort.signal },
    )

    turn = postChat(server.url, sessionId, turnId)
    await stub.started

    const stream = await streamPromise
    assert.equal(stream.status, 200, 'the waiting stream is served, not rejected')

    stub.release()
    const frames = await readStream(stream)
    assert.deepEqual(
      frames.filter((frame) => frame.event === 'delta').map((frame) => frame.data.text),
      ['Hel', 'lo'],
      'the connection opened first receives every delta from cursor zero',
    )
    assert.equal(frames[0]?.id, 0)
    assert.equal((await turn).status, 201)
  } finally {
    // Abort the subscription first. A still-open SSE response keeps a socket
    // alive, and `server.close()` would then wait for it forever — turning any
    // assertion failure in this test into a hang.
    streamAbort?.abort()
    await streamPromise?.then(
      (response) => response.body?.cancel().catch(() => undefined),
      () => undefined,
    )
    stub.release()
    await turn.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('aborting a waiting stream releases its waiter slot immediately', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-abort-')
  const stub = installGatedLmStudioStub(['Hel', 'lo'])
  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  let secondAbort: AbortController | undefined
  let secondPromise: Promise<Response> | undefined
  // One waiter slot in total, so a leaked slot is immediately observable.
  const hub = new AgentTextStreamHub({ maxPendingWaiters: 1 })
  try {
    // One waiter slot in total, so a leaked slot is immediately observable:
    // the next waiter would be refused rather than served.
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath: projectRoot,
      workspacePath,
      agentTextStreamWaitMs: 10_000,
      agentTextStreamHub: hub,
    })
    const sessionId = await createSession(server.url)
    const turnId = crypto.randomUUID()

    // First subscriber waits, then its client goes away.
    const firstAbort = new AbortController()
    const firstPromise = fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' }, signal: firstAbort.signal },
    )
    await waitFor(() => hub.pendingWaiterCount === 1)
    firstAbort.abort()
    await firstPromise.catch(() => undefined)
    await waitFor(() => hub.pendingWaiterCount === 0)
    assert.equal(
      hub.pendingWaiterCount,
      0,
      'the aborted connection released its slot without waiting out the deadline',
    )

    // The slot must be free now, without waiting out the 10s deadline.
    secondAbort = new AbortController()
    secondPromise = fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' }, signal: secondAbort.signal },
    )

    turn = postChat(server.url, sessionId, turnId)
    await stub.started
    const second = await secondPromise
    assert.equal(
      second.status,
      200,
      'the second waiter was admitted, so the aborted one released its slot',
    )
    stub.release()
    const frames = await readStream(second)
    assert.ok(frames.some((frame) => frame.event === 'delta'))
    assert.equal((await turn).status, 201)
  } finally {
    secondAbort?.abort()
    await secondPromise?.then(
      (response) => response.body?.cancel().catch(() => undefined),
      () => undefined,
    )
    stub.release()
    await turn.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a channel owned by another session is refused at once, consuming no waiter slot', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-owner-fast-')
  const stub = installGatedLmStudioStub(['secret'])
  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  // One slot in total, so consuming it is immediately observable.
  const hub = new AgentTextStreamHub({ maxPendingWaiters: 1 })
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath: projectRoot,
      workspacePath,
      // Long enough that waiting would be unmistakable.
      agentTextStreamWaitMs: 30_000,
      agentTextStreamHub: hub,
    })
    const ownerSession = await createSession(server.url)
    const otherSession = await createSession(server.url)
    const turnId = crypto.randomUUID()

    turn = postChat(server.url, ownerSession, turnId)
    await stub.started

    // The owner is known and it is not this session. There is nothing to wait
    // for, so waiting would only hold a bounded slot and delay a certain 404.
    const startedAt = Date.now()
    const response = await fetch(
      `${server.url}/sessions/${otherSession}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(response.status, 404)
    await response.text()
    assert.ok(
      Date.now() - startedAt < 5_000,
      'a known owner mismatch is refused immediately, not after the wait deadline',
    )
    assert.equal(
      hub.pendingWaiterCount,
      0,
      'and it never registered a waiter',
    )
  } finally {
    stub.release()
    await turn.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown channel is a 404 rather than an open stream that never speaks', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-404-')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)

    const response = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${crypto.randomUUID()}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(response.status, 404)
    await response.text()
  } finally {
    await server?.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a non-numeric from cursor is rejected rather than coerced to zero', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-from-nan-')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const response = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${crypto.randomUUID()}&from=abc`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(response.status, 400)
    await response.text()
  } finally {
    await server?.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a negative from cursor is rejected', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-from-neg-')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const response = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${crypto.randomUUID()}&from=-5`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(response.status, 400)
    await response.text()
  } finally {
    await server?.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a non-integer from cursor is rejected', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-from-frac-')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)
    const response = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=${crypto.randomUUID()}&from=1.5`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(response.status, 400)
    await response.text()
  } finally {
    await server?.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("another session's URL cannot read a channel it does not own", async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-owner-')
  const stub = installGatedLmStudioStub(['secret'])
  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  try {
    server = await startServer(workspacePath, projectRoot)
    const ownerSession = await createSession(server.url)
    const otherSession = await createSession(server.url)
    const turnId = crypto.randomUUID()

    turn = postChat(server.url, ownerSession, turnId)
    await stub.started

    // The channel is live and its id is known, but it belongs to another
    // session. The path is part of the contract, not decoration.
    const response = await fetch(
      `${server.url}/sessions/${otherSession}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(response.status, 404)
    await response.text()
  } finally {
    stub.release()
    await turn.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a nonexistent session URL cannot read a live channel', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-nosession-')
  const stub = installGatedLmStudioStub(['secret'])
  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  try {
    server = await startServer(workspacePath, projectRoot)
    const ownerSession = await createSession(server.url)
    const turnId = crypto.randomUUID()

    turn = postChat(server.url, ownerSession, turnId)
    await stub.started

    const response = await fetch(
      `${server.url}/sessions/${crypto.randomUUID()}/agent-chat/stream?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(response.status, 404)
    await response.text()
  } finally {
    stub.release()
    await turn.catch(() => undefined)
    await server?.close()
    stub.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a malformed channelId is rejected', async () => {
  const { directory, workspacePath, projectRoot } = makeWorkspace('sse-bad-')
  let server: StartedApiServer | undefined
  try {
    server = await startServer(workspacePath, projectRoot)
    const sessionId = await createSession(server.url)

    const response = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/stream?channelId=not-a-uuid&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )
    assert.equal(response.status, 400)
    await response.text()
  } finally {
    await server?.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Yield to the event loop until `predicate` holds. No timers and no sleeps: the
 * surrounding test timeout is the only bound.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition never held')
}
