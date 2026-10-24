/**
 * The Run chat receptionist's display-only text stream.
 *
 * The receptionist answers with a strict JSON decision object — `message`
 * beside `selectionAction`, `workflowId` and `launchIntent` — so as with the
 * Workflow Architect, the property under test is that what reaches the screen
 * is prose. The decision itself must still be parsed whole and still drive the
 * run plan.
 */
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { ChatMessage } from '../../contracts/sessions.js'

/**
 * Every wait is bounded so a lane that never streams fails on an assertion
 * rather than sitting on a socket.
 */
const DEADLINE_MS = 10_000

interface SseFrame {
  readonly id: number | undefined
  readonly event: string
  readonly data: Record<string, unknown>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn
  })
  assert.ok(resolve)
  return { promise, resolve }
}

function withDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${message} (within ${DEADLINE_MS}ms)`)),
      DEADLINE_MS,
    )
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

interface ArchitectModelServer {
  readonly close: () => Promise<void>
  readonly url: string
  /** Ends the model response, letting the turn complete. */
  readonly releaseTrailer: () => void
}

/**
 * A model endpoint that answers `text/event-stream`, writing its answer
 * suffixes immediately and withholding only the terminal frames, so the test
 * controls when the turn may finish without depending on the lane to make
 * progress first.
 */
async function startArchitectModelServer(
  suffixes: readonly string[],
): Promise<ArchitectModelServer> {
  const trailerReleased = deferred<void>()
  let released = false
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Consume the real loopback request body.
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      for (const [index, content] of suffixes.entries()) {
        const chunk =
          index === 0
            ? { model: 'test-model', choices: [{ delta: { content } }] }
            : { choices: [{ delta: { content } }] }
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      await trailerReleased.promise
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    releaseTrailer: () => {
      if (released) return
      released = true
      trailerReleased.resolve()
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

/**
 * Read frames as they arrive, resolving `firstDelta` on the first one so the
 * test can assert incrementality without waiting for the stream to end.
 */
function readFramesLive(
  response: Response,
  firstDelta: Deferred<SseFrame>,
): Promise<SseFrame[]> {
  assert.ok(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames: SseFrame[] = []
  let buffer = ''
  return (async () => {
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
            if (line.startsWith('id:')) {
              id = Number.parseInt(line.slice(3).trim(), 10)
            }
            if (line.startsWith('event:')) event = line.slice(6).trim()
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          }
          if (dataLines.length === 0) continue
          const parsed: unknown = JSON.parse(dataLines.join('\n'))
          assert.ok(typeof parsed === 'object' && parsed !== null)
          const frame: SseFrame = { id, event, data: { ...parsed } }
          frames.push(frame)
          if (frame.event === 'delta') firstDelta.resolve(frame)
        }
      }
    } finally {
      reader.releaseLock()
    }
    return frames
  })()
}

test('the receptionist streams its reply as prose while its decision is still parsed whole', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'receptionist-stream-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const repoRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  fs.writeFileSync(path.join(repoRoot, 'workflows', 'registry.yaml'), '')

  // The receptionist's real wire format: one JSON decision object, no fence.
  const model = await startArchitectModelServer([
    '{"mess',
    'age": "Tell me a little more about the brief',
    '.",',
    ' "selectionAction": "clear", "workflowId": null, "launchIntent": "none",',
    ' "deepResearchPlanAction": "keep", "deepResearchMissingInputs": []}',
  ])
  const previousKey = process.env.DEEPSEEK_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
  process.env.DEEPSEEK_API_KEY = 'test-key'
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = model.url

  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  let streamRequest: Promise<Response> | undefined
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath: repoRoot,
      workspacePath,
      agentTextStreamWaitMs: 2_000,
    })

    const created = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Receptionist streaming' }),
    })
    const session = (await created.json()) as { id: string }

    const turnId = crypto.randomUUID()
    streamRequest = fetch(
      `${server.url}/sessions/${session.id}/agent-chat/stream` +
        `?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )

    turn = fetch(`${server.url}/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'I need something reviewed.',
        provider: 'deepseek',
        model: 'test-model',
        turnId,
      }),
    })

    const streamResponse = await withDeadline(
      streamRequest,
      'the session stream endpoint never answered',
    )
    assert.equal(streamResponse.status, 200)
    const firstDelta = deferred<SseFrame>()
    const framesRead = readFramesLive(streamResponse, firstDelta)

    const first = await withDeadline(
      firstDelta.promise,
      'no prose reached the stream while the receptionist was still answering',
    )
    assert.equal(first.data.text, 'Tell me a little more about the brief')

    model.releaseTrailer()
    const frames = await withDeadline(framesRead, 'the stream never closed')
    const turnResponse = await withDeadline(turn, 'the turn never completed')
    const payload = (await turnResponse.json()) as {
      messages?: { text?: string }[]
      plan?: { selectedWorkflow?: unknown }
    }

    const streamedText = frames
      .filter((frame) => frame.event === 'delta')
      .map((frame) => String(frame.data.text ?? ''))
      .join('')

    assert.equal(streamedText, 'Tell me a little more about the brief.')
    assert.equal(streamedText.includes('{'), false)
    assert.equal(streamedText.includes('selectionAction'), false)

    // The decision half of the same reply still took effect.
    const describePayload = JSON.stringify(payload)
    assert.ok(payload.messages?.[0]?.text, describePayload)
    assert.equal(payload.plan?.selectedWorkflow ?? null, null, describePayload)
  } finally {
    model.releaseTrailer()
    await turn.catch(() => undefined)
    await streamRequest?.catch(() => undefined)
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
    if (previousUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
    } else process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = previousUrl
    await server?.close()
    await model.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A store that cannot record the assistant's message.
 *
 * The receptionist's visible answer is not the model's raw text: it is
 * rewritten against the plan revision and only then written to the session.
 * Every one of those steps can fail, and the bubble can only be closed once,
 * so this stands in for any failure between generating and keeping.
 */
class AssistantAppendFailureStore extends FileSystemSessionStore {
  override async appendChatMessage(
    id: string,
    message: ChatMessage,
  ): Promise<boolean> {
    if (message.role === 'assistant') {
      throw new Error('The assistant message could not be written.')
    }
    return super.appendChatMessage(id, message)
  }

  /**
   * A turn carrying an idempotency key publishes through the idempotent
   * append, so the fault has to be injected there too. The guarantee under
   * test is unchanged: whichever way the assistant message is written, failing
   * to keep it must not be reported as success.
   */
  override async appendChatMessageIfAbsent(
    id: string,
    message: ChatMessage,
  ): Promise<
    | 'appended'
    | 'already-present'
    | 'conflict'
    | 'unknown-session'
    | 'invalid-message'
  > {
    if (message.role === 'assistant') {
      throw new Error('The assistant message could not be written.')
    }
    return super.appendChatMessageIfAbsent(id, message)
  }
}

test('the receptionist does not report success for an answer it failed to keep', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'receptionist-durable-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const repoRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  fs.writeFileSync(path.join(repoRoot, 'workflows', 'registry.yaml'), '')

  const model = await startArchitectModelServer([
    '{"message": "Here is what I found',
    '.", "selectionAction": "clear", "workflowId": null,',
    ' "launchIntent": "none", "deepResearchPlanAction": "keep",',
    ' "deepResearchMissingInputs": []}',
  ])
  const previousKey = process.env.DEEPSEEK_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
  process.env.DEEPSEEK_API_KEY = 'test-key'
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = model.url

  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  let streamRequest: Promise<Response> | undefined
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new AssistantAppendFailureStore(workspacePath),
      repoRootPath: repoRoot,
      workspacePath,
      agentTextStreamWaitMs: 2_000,
    })

    const created = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Receptionist durable acceptance' }),
    })
    const session = (await created.json()) as { id: string }

    const turnId = crypto.randomUUID()
    streamRequest = fetch(
      `${server.url}/sessions/${session.id}/agent-chat/stream` +
        `?channelId=${turnId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )

    turn = fetch(`${server.url}/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Please look into this.',
        provider: 'deepseek',
        model: 'test-model',
        turnId,
      }),
    })

    const streamResponse = await withDeadline(
      streamRequest,
      'the session stream endpoint never answered',
    )
    assert.equal(streamResponse.status, 200)
    const firstDelta = deferred<SseFrame>()
    const framesRead = readFramesLive(streamResponse, firstDelta)

    model.releaseTrailer()
    const frames = await withDeadline(framesRead, 'the stream never closed')
    const turnResponse = await withDeadline(turn, 'the turn never completed')

    // The turn genuinely failed, so nothing was kept.
    assert.equal(turnResponse.ok, false)

    const terminals = frames.filter(
      (frame) => frame.event === 'final' || frame.event === 'error',
    )
    const describe = JSON.stringify(terminals)
    assert.equal(
      terminals.some((frame) => frame.event === 'final'),
      false,
      `a reply that was never kept was reported as completed: ${describe}`,
    )
    assert.equal(terminals.at(-1)?.event, 'error', describe)
  } finally {
    model.releaseTrailer()
    await turn.catch(() => undefined)
    await streamRequest?.catch(() => undefined)
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
    if (previousUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
    } else process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = previousUrl
    await server?.close()
    await model.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
