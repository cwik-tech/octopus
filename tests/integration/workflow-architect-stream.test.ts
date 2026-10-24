/**
 * The Workflow Architect's display-only text stream.
 *
 * This architect must answer with one JSON object whose visible reply sits
 * under `message`, so the interesting property is not that something streams —
 * it is that what streams is prose. A preview that leaked a brace, a key name
 * or a fragment of the draft would be worse than no preview at all.
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
  fs.mkdirSync(path.join(repoRoot, 'teams', 'workflow-architect'), {
    recursive: true,
  })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'workflow-architect'), {
    recursive: true,
  })
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  fs.mkdirSync(path.join(repoRoot, 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'workflows', 'registry.yaml'), '')
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'workflow-architect', 'team.yaml'),
    [
      'agents:',
      '  - agent_file: ../../agents/workflow-architect/workflow-architect.md',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'workflow-architect', 'workflow-architect.md'),
    // The architect runs with its own agent file's pair.
    "---\nprovider: openai\nmodel: test-model\nthinking: medium\n---\n\n" + ('Reply with one JSON object in a fenced code block.'),
  )
}

/**
 * Read frames as they arrive, resolving `firstDelta` on the first one so the
 * test can assert incrementality without waiting for the stream to end.
 */
/** What survives a restart, read from the file rather than a cache. */
function readStoredWorkflowTurns(
  workspacePath: string,
): { jobId: string; status: string; selection?: Record<string, unknown> }[] {
  const file = path.join(
    workspacePath,
    'workflow-architect-telemetry',
    'turns.json',
  )
  if (!fs.existsSync(file)) return []
  return (
    JSON.parse(fs.readFileSync(file, 'utf8')) as {
      metrics: { jobId: string; status: string; selection?: Record<string, unknown> }[]
    }
  ).metrics
}

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

test('the Workflow Architect streams its reply as prose, never as the JSON it is wrapped in', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-architect-stream-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const repoRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(repoRoot, { recursive: true })
  writeArchitectConfig(repoRoot)

  // The architect's real wire format: a fenced JSON object whose `message` is
  // the only prose, followed by the structured draft.
  const model = await startArchitectModelServer([
    '```json\n{"mess',
    'age": "I suggest the review workflow',
    '.\\nIt fits your brief.",',
    ' "draft": {"id": "review-flow", "description": "Review an incoming brief.", "input": {"artifact": "incoming-brief.md"}, "steps": [{"id": "one", "type": "team", "team": "review-team", "input_artifact": "incoming-brief.md", "result_artifact": "review.md"}], "output": {"from_step": "one", "artifact": "review.md"}, "on_blocked": "stop", "on_failed": "stop"}, "warnings": []}\n```',
  ])
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = model.url

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

    const jobId = crypto.randomUUID()
    streamRequest = fetch(
      `${server.url}/create/turn?channelId=${jobId}&from=0`,
      { headers: { accept: 'text/event-stream' } },
    )

    turn = fetch(`${server.url}/create/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        history: [{ role: 'user', text: 'Build me a review workflow.' }],
        currentDraft: null,
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
      'no prose reached the stream while the turn was still running',
    )
    assert.equal(first.data.text, 'I suggest the review workflow')

// While the provider is still held, the turn's own record is already on disk.
    // Read from the file rather than any in-process cache: the point is that a
    // reopened Create — or a crash — still knows which model this turn used.
    const pendingRecords = readStoredWorkflowTurns(workspacePath)
    const pending = pendingRecords.find((record) => record.jobId === jobId)
    assert.ok(pending, 'the pending turn recorded its model choice')
    assert.equal(pending.status, 'running')
    assert.deepEqual(pending.selection, {
      provider: 'openai',
      model: 'test-model',
      source: 'agent',
      reason: 'explicit-agent-choice',
      caller: 'authoring',
    })

        model.releaseTrailer()
    const frames = await withDeadline(framesRead, 'the stream never closed')
    // The disclosure comes first, before any token. The Workflow Architect is
    // an Agent like any other: when it runs on the application default, the
    // operation that owns the turn has to be able to say so while it is still
    // running, not once the answer has arrived.
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
    const turnResponse = await withDeadline(turn, 'the turn never completed')
    const payload = (await turnResponse.json()) as {
      message?: string
      draft?: { id?: string } | null
    }

    const streamedText = frames
      .filter((frame) => frame.event === 'delta')
      .map((frame) => String(frame.data.text ?? ''))
      .join('')

    // What the user saw is exactly the reply, decoded — the `\n` escape became
    // a newline, and nothing structural leaked.
    assert.equal(
      streamedText,
      'I suggest the review workflow.\nIt fits your brief.',
    )
    assert.equal(streamedText.includes('{'), false)
    assert.equal(streamedText.includes('draft'), false)
    assert.equal(streamedText.includes('```'), false)

    // The structured half of the same reply still arrives intact.
    const describePayload = JSON.stringify(payload)
    assert.equal(payload.message, streamedText, describePayload)
    assert.equal(payload.draft?.id, 'review-flow', describePayload)
  } finally {
    model.releaseTrailer()
    await turn.catch(() => undefined)
    await streamRequest?.catch(() => undefined)
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    } else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
    await server?.close()
    await model.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a Workflow Architect turn that is cancelled records its outcome, not a stale running turn', async () => {
  // The record written before the provider is called says the turn is running.
  // If nothing ever replaces it, every later read — a reopened Create, a
  // restart — reports a turn still in progress that ended long ago.
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'architect-cancel-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const repoRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(repoRoot, { recursive: true })
  writeArchitectConfig(repoRoot)

  const model = await startArchitectModelServer(['Held'])
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = model.url

  let server: StartedApiServer | undefined
  let turn: Promise<Response> = Promise.resolve(new Response(null, { status: 204 }))
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath: repoRoot,
      workspacePath,
      agentTextStreamWaitMs: 2_000,
    })
    const jobId = crypto.randomUUID()
    turn = fetch(`${server.url}/create/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        history: [{ role: 'user', text: 'Design me a reviewer.' }],
        currentDraft: null,
      }),
    })

    // Wait until the pending record exists. That says the turn has resolved a
    // pair and written it — deliberately *before* the provider is called — so
    // this is a pending turn, not a turn whose provider has been reached. What
    // this test proves is that a cancellation from that point stops saying the
    // turn is running; it makes no claim about provider start.
    const deadline = Date.now() + DEADLINE_MS
    let pending = readStoredWorkflowTurns(workspacePath).find(
      (record) => record.jobId === jobId,
    )
    while (!pending && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      pending = readStoredWorkflowTurns(workspacePath).find(
        (record) => record.jobId === jobId,
      )
    }
    assert.ok(pending, 'the pending turn recorded its model choice')
    assert.equal(pending.status, 'running')

    const cancelled = await fetch(`${server.url}/create/jobs/${jobId}/cancel`, {
      method: 'POST',
    })
    assert.equal(cancelled.status, 200)
    model.releaseTrailer()
    await turn

    const settled = readStoredWorkflowTurns(workspacePath).filter(
      (record) => record.jobId === jobId,
    )
    assert.equal(settled.length, 1, 'the turn still owns one record')
    assert.equal(settled[0]?.status, 'cancelled')
    // The outcome replaces the status, not the account of how the model was
    // chosen: the turn did use a model before it was stopped.
    assert.ok(settled[0]?.selection)
  } finally {
    model.releaseTrailer()
    await turn.catch(() => undefined)
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
    await server?.close()
    await model.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
