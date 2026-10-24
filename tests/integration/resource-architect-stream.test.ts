/**
 * The Agent Architect's display-only text stream.
 *
 * Driven through the real loopback API so the assertion covers the whole lane:
 * the client mints a job id, subscribes before the turn exists, and the turn
 * publishes what the model produced while it was still producing it. The
 * persisted turn response stays the authority — nothing here asserts that a
 * frame is what gets stored.
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

function writeArchitectConfig(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, 'teams', 'resource-architect'), {
    recursive: true,
  })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'resource-architect'), {
    recursive: true,
  })
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'resource-architect', 'team.yaml'),
    [
      'agents:',
      '  - agent_file: ../../agents/resource-architect/resource-architect.md',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'resource-architect', 'resource-architect.md'),
    // The architect runs with its own agent file's pair.
    "---\nprovider: openai\nmodel: test-model\nthinking: medium\n---\n\n" + ('Help the user design Agents and Teams.'),
  )
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

test('with review disabled the Agent Architect publishes answer suffixes while the turn is still running', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'architect-stream-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const repoRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(repoRoot, { recursive: true })
  writeArchitectConfig(repoRoot)

  const model = await startArchitectModelServer(['Kestrel', ' and Marlin'])
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  const previousReview = process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = model.url
  process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED = 'false'

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

    // The client mints the job id, subscribes, and only then sends the turn,
    // so the stream legitimately opens before the channel exists.
    // Not awaited: the GET deliberately blocks until the turn opens the
    // channel, so awaiting it before posting would deadlock the contract it is
    // meant to prove.
    const jobId = crypto.randomUUID()
    streamRequest = fetch(
      `${server.url}/create/resource-architect/turn?channelId=${jobId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )

    turn = fetch(`${server.url}/create/resource-architect/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        operation: 'conversation',
        history: [{ role: 'user', text: 'Design me a reviewer.' }],
        currentPlan: null,
      }),
    })

    const streamResponse = await withDeadline(
      streamRequest,
      'the architect stream endpoint never answered',
    )
    assert.equal(streamResponse.status, 200)
    const firstDelta = deferred<SseFrame>()
    const framesRead = readFramesLive(streamResponse, firstDelta)

    const first = await withDeadline(
      firstDelta.promise,
      'no answer suffix reached the stream while the turn was still running',
    )
    assert.equal(first.data.text, 'Kestrel')
    assert.equal(first.data.channel, 'text')

    model.releaseTrailer()
    const frames = await withDeadline(framesRead, 'the stream never closed')
    const turnResponse = await withDeadline(turn, 'the turn never completed')
    const payload = (await turnResponse.json()) as { message?: string }

    // The disclosure comes first, on the real route, before any token. This is
    // the whole point of publishing it from the turn rather than returning it
    // with the answer: on a slow provider the notice is what a person has while
    // they wait, and a notice that arrives with the reply is no notice at all.
    assert.equal(
      frames[0]?.event,
      'selection',
      'the model disclosure reached the stream before any answer text',
    )
    assert.deepEqual(frames[0]?.data.selection, {
      provider: 'openai',
      model: 'test-model',
      source: 'agent',
      reason: 'explicit-agent-choice',
      caller: 'authoring',
    })
    assert.deepEqual(
      frames.filter((frame) => frame.event === 'delta').map((frame) => frame.data.text),
      ['Kestrel', ' and Marlin'],
    )
    // Cursors are channel-global and strictly increasing, because suffix
    // concatenation depends on order.
    const cursors = frames
      .filter((frame) => frame.id !== undefined)
      .map((frame) => frame.id)
    assert.deepEqual(cursors, [...cursors].sort((left, right) => left! - right!))
    assert.equal(frames.at(-1)?.event, 'final')
    assert.equal(frames.at(-1)?.data.reason, 'completed')

    // The persisted turn is the authority; the frames were a preview of it.
    assert.equal(payload.message, 'Kestrel and Marlin')
  } finally {
    model.releaseTrailer()
    await turn.catch(() => undefined)
    await streamRequest?.catch(() => undefined)
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousReview === undefined) delete process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED
    else process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED = previousReview
    if (previousUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    } else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
    await server?.close()
    await model.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
