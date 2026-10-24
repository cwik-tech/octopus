import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

import { voiceControlDescriptorSchema } from '../../contracts/voice-control.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { resolveRunAssignmentLocation } from '../../domains/run/run-location.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { buildChatMessage } from '../../services/session-service.js'
import {
  mirrorRepositoryWithoutFrontDoor,
  removeMirroredRepository,
} from '../helpers/repository-mirror.js'

const MODEL_HOST_PORT = ':1234/'
const TEST_NONEXISTENT_PID = 2_147_483_647

/** One model request the test answers frame by frame. */
interface HeldModelRequest {
  delta(text: string): void
  /** Sends `text` as the last piece, then ends the answer. */
  end(text: string): void
  /** Settles when the caller abandons the request. */
  readonly aborted: Promise<void>
}

/**
 * Replaces only the model endpoint. The model is a paid, non-deterministic
 * network service, so it is answered here at the network boundary; every other
 * request, including Octopus's own loopback calls, reaches the real server.
 *
 * An agent with tools runs the Chat Completions tool loop: buffered rounds
 * until one answers without tools, then the answer is asked for again as a
 * stream (docs/flows/agent-chat-live-answer.md). Buffered rounds answer at
 * once with no tool calls; each streamed request is handed to the test.
 */
function installHeldModel(): { nextRequest(): Promise<HeldModelRequest>; restore(): void } {
  const originalFetch = globalThis.fetch
  const waiting: ((request: HeldModelRequest) => void)[] = []
  const ready: HeldModelRequest[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(MODEL_HOST_PORT)) return originalFetch(input, init)
    const requestBody: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const streamed =
      typeof requestBody === 'object' && requestBody !== null && 'stream' in requestBody && requestBody.stream === true
    if (!streamed) {
      return Response.json({
        id: 'round',
        object: 'chat.completion',
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let markAborted: () => void = () => undefined
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve
    })
    const signal = init?.signal
    if (signal?.aborted) markAborted()
    signal?.addEventListener('abort', () => markAborted(), { once: true })
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
      },
      cancel() {
        markAborted()
      },
    })
    const send = (payload: string) => {
      controller?.enqueue(encoder.encode(`data: ${payload}\n\n`))
    }
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      JSON.stringify({
        id: 'answer',
        object: 'chat.completion.chunk',
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })
    const held: HeldModelRequest = {
      delta: (text) => send(chunk({ content: text }, null)),
      end: (text) => {
        if (text !== '') send(chunk({ content: text }, null))
        send(chunk({}, 'stop'))
        send('[DONE]')
        controller?.close()
      },
      aborted,
    }
    const waiter = waiting.shift()
    if (waiter) waiter(held)
    else ready.push(held)
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof globalThis.fetch
  return {
    nextRequest: () => {
      const held = ready.shift()
      if (held) return Promise.resolve(held)
      return new Promise((resolve) => waiting.push(resolve))
    },
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

function writeAgent(projectRoot: string, name: string): void {
  const directory = path.join(projectRoot, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'tier: strategic',
      'provider: lm-studio',
      'model: test-model',
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

function writeWorkflowRegistry(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const registryPath = path.join(dir, 'registry.yaml')
  fs.writeFileSync(
    registryPath,
    ['market-research:', '  description: Research a market.', '  template_path: ./market-research.yaml', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'market-research.yaml'),
    [
      'workflow:',
      '  id: market-research',
      '  description: Test workflow.',
      '  input:',
      '    artifact: incoming-brief.md',
      '  steps:',
      '    - id: write',
      '      type: team',
      '      team: writing-team',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '  output:',
      '    from_step: write',
      '    artifact: final-draft.md',
      '  on_blocked: stop',
      '  on_failed: stop',
      '',
    ].join('\n'),
  )
  return registryPath
}

interface AskFixture {
  readonly server: StartedApiServer
  readonly client: Client
  readonly workspacePath: string
}

async function withAskServer(fn: (fixture: AskFixture) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-ask-')))
  const workspacePath = path.join(root, 'workspace')
  // The repository's own teams and workflow planner, without the front door,
  // plus one fixture agent. The mirror's agents folder is real, so the agent
  // is written there and never into the repository.
  const projectRoot = mirrorRepositoryWithoutFrontDoor('voice-ask-repo-')
  const discoveryDir = path.join(root, 'voice-control')
  fs.mkdirSync(workspacePath, { recursive: true })
  writeAgent(projectRoot, 'analyst')
  const server = await startApiServer({
    apiToken: randomBytes(32).toString('base64url'),
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: TEST_NONEXISTENT_PID, cwd: workspacePath }
      },
    },
    taskLauncher: {
      async startRun(request) {
        return { launched: true as const, pid: TEST_NONEXISTENT_PID, cwd: request.cwd }
      },
    },
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath: projectRoot,
    workflowsRegistryPath: writeWorkflowRegistry(path.join(root, 'workflows')),
    voiceControl: { mcpToken: randomBytes(32).toString('base64url'), discoveryDir },
  })
  let client: Client | undefined
  try {
    const descriptor = voiceControlDescriptorSchema.parse(
      JSON.parse(fs.readFileSync(path.join(discoveryDir, 'apps', 'octopus.json'), 'utf8')),
    )
    const transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), {
      requestInit: { headers: { ...descriptor.mcp.headers } },
    })
    client = new Client({ name: 'voice-layer-test', version: '1.0.0' })
    await client.connect(new ExactOptionalMcpTransport(transport))
    await fn({ server, client, workspacePath })
  } finally {
    await client?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(path.join(projectRoot, 'agents', 'analyst'), { recursive: true, force: true })
    removeMirroredRepository(projectRoot)
  }
}

/**
 * The model request a call makes, or a failure as soon as the call settles
 * without making one, so a refused call fails the test instead of leaving it
 * waiting for a request that will never come.
 */
async function modelRequestFor(
  model: { nextRequest(): Promise<HeldModelRequest> },
  call: Promise<unknown>,
): Promise<HeldModelRequest> {
  return Promise.race([
    model.nextRequest(),
    call.then(
      (result) => {
        throw new Error(`The call finished without asking the model: ${JSON.stringify(result)}`)
      },
      (error: unknown) => {
        throw error
      },
    ),
  ])
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[]
  assert.equal(content[0]?.type, 'text')
  return content[0]?.text ?? ''
}

function structuredOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  assert.notEqual(result.isError, true, firstText(result))
  const structured = result.structuredContent
  assert.ok(isRecord(structured), 'the result carries structuredContent')
  return structured
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolves when the client has seen `count` progress notifications. */
function progressCounter(): { onprogress: () => void; reached(count: number): Promise<void>; count(): number } {
  let seen = 0
  const waiters: { count: number; resolve: () => void }[] = []
  return {
    onprogress: () => {
      seen += 1
      for (const waiter of waiters.filter((entry) => entry.count <= seen)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    },
    reached: (count) =>
      count <= seen
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ count, resolve })),
    count: () => seen,
  }
}

test('ask returns the agent answer after progress notifications while it is written', async () => {
  const model = installHeldModel()
  try {
    await withAskServer(async ({ client }) => {
      const progress = progressCounter()

      // Act: ask by voice with progress turned on, as the voice layer does.
      const call = client.callTool(
        { name: 'ask', arguments: { agentName: 'analyst', text: 'How big is the oat milk market?' } },
        undefined,
        {
          onprogress: progress.onprogress,
          timeout: 30_000,
          resetTimeoutOnProgress: true,
          signal: AbortSignal.timeout(120_000),
        },
      )

      // The model writes its answer in pieces. Each piece is sent only after
      // the client has seen progress for the one before it.
      const request = await modelRequestFor(model, call)
      request.delta('The market ')
      await progress.reached(1)
      request.delta('is growing.')
      await progress.reached(2)
      request.end('')

      // Assert: the answer comes back as the first text block.
      const result = await call
      assert.match(firstText(result), /The market is growing\./)
      const structured = structuredOf(result)
      assert.equal(typeof structured.sessionId, 'string')
      assert.ok(progress.count() >= 2)
    })
  } finally {
    model.restore()
  }
})

test('a call whose deadline signal fires is cancelled and the agent turn stops', async () => {
  const model = installHeldModel()
  try {
    await withAskServer(async ({ client }) => {
      // Arrange: the total deadline is a signal. SDK 1.30 checks
      // `maxTotalTimeout` only when progress arrives and never tells the
      // server, while an aborted signal always sends `notifications/cancelled`.
      // The test fires it itself, once the turn has reached the model, so the
      // order does not depend on how fast the machine is.
      const deadline = new AbortController()
      const call = client.callTool(
        { name: 'ask', arguments: { agentName: 'analyst', text: 'Take your time.' } },
        undefined,
        { onprogress: () => undefined, timeout: 30_000, resetTimeoutOnProgress: true, signal: deadline.signal },
      )
      const request = await modelRequestFor(model, call)
      request.delta('Thinking')

      // Act: the deadline passes.
      deadline.abort(new DOMException('The total deadline passed.', 'TimeoutError'))

      // Assert: the call ends as a timeout, and the cancellation reaches the
      // turn, which abandons the model request.
      await assert.rejects(call, (error: unknown) =>
        error instanceof McpError && error.code === ErrorCode.RequestTimeout,
      )
      await request.aborted
    })
  } finally {
    model.restore()
  }
})

test('opening a voice chat reports its live turn until the answer is saved', async () => {
  const model = installHeldModel()
  try {
    await withAskServer(async ({ client, server }) => {
      const created = structuredOf(await client.callTool({ name: 'create_session', arguments: { title: 'Flower question' } }))
      assert.ok(isRecord(created.session))
      const sessionId = String(created.session.id)
      const call = client.callTool({ name: 'ask', arguments: { sessionId, agentName: 'analyst', text: 'Which ontology describes flowers?' } })
      const request = await modelRequestFor(model, call)
      try {
        const response = await fetch(`${server.url}/sessions/${sessionId}/messages`, { signal: AbortSignal.timeout(5_000) })
        assert.equal(response.status, 200)
        const body: unknown = await response.json()
        assert.ok(isRecord(body))
        assert.ok(Array.isArray(body.activeTurnIds), 'the transcript identifies live turns for a newly opened chat')
        assert.equal(body.activeTurnIds.length, 1)
        assert.ok(Array.isArray(body.messages))
        const user: unknown = body.messages[0]
        assert.ok(isRecord(user))
        assert.deepEqual(body.activeTurnIds, [user.turnId])
      } finally {
        request.end('Use Plant Ontology.')
        await call
      }
      const finished = await fetch(`${server.url}/sessions/${sessionId}/messages`, { signal: AbortSignal.timeout(5_000) })
      const body: unknown = await finished.json()
      assert.ok(isRecord(body))
      assert.deepEqual(body.activeTurnIds, [])
    })
  } finally {
    model.restore()
  }
})

test('list_results offers an agent answer and read_result reads it aloud', async () => {
  const model = installHeldModel()
  try {
    await withAskServer(async ({ client }) => {
      const call = client.callTool({
        name: 'ask',
        arguments: { agentName: 'analyst', text: 'Summarise the market.' },
      })
      const request = await modelRequestFor(model, call)
      request.end('Oat milk sales rose 12 percent last year.')
      const asked = structuredOf(await call)
      const sessionId = String(asked.sessionId)

      const listed = structuredOf(await client.callTool({ name: 'list_results', arguments: { sessionId } }))
      const results = listed.results as { id: string; producer: { kind: string; id: string } }[]
      const answer = results.find((result) => result.producer.kind === 'agent')
      assert.ok(answer, 'the agent answer is offered as a result')

      const read = await client.callTool({ name: 'read_result', arguments: { sessionId, resultId: answer.id } })
      assert.equal(firstText(read), 'Oat milk sales rose 12 percent last year.')
    })
  } finally {
    model.restore()
  }
})

test('read_result reads a finished workflow report by its task', async () => {
  await withAskServer(async ({ client, workspacePath }) => {
    // Arrange: a workflow started by voice finishes and publishes its report.
    const started = structuredOf(await client.callTool({
      name: 'start_workflow',
      arguments: { workflowId: 'market-research', brief: 'Research the market for oat milk in Poland.' },
    }))
    const sessionId = String(started.sessionId)
    const taskId = String(started.taskId)
    const runId = String((started.task as { id: string }).id === taskId
      ? (await new FileSystemSessionStore(workspacePath).getTaskRecord(sessionId, taskId))?.runId
      : '')
    assert.ok(runId)
    const assignmentPath =
      resolveRunAssignmentLocation(workspacePath, runId)?.assignmentPath ??
      path.join(workspacePath, 'assignments', runId)
    fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
    const report = 'Oat milk is the fastest growing plant milk. Prices are stable.\n\nDetails follow.'
    fs.writeFileSync(path.join(assignmentPath, 'output', 'report.md'), report)
    const workerStore = new FileSystemSessionStore(workspacePath)
    await workerStore.updateTaskRecord(sessionId, taskId, {
      status: 'done',
      completedAt: new Date().toISOString(),
    })
    await workerStore.appendChatMessage(
      sessionId,
      buildChatMessage('assistant', 'Your report is ready.', {
        delivery: {
          taskId,
          artifacts: [{
            runId,
            path: 'output/report.md',
            role: 'final',
            mediaType: 'text/markdown',
            // A delivery card carries the published file's own digest.
            digest: createHash('sha256').update(report).digest('hex'),
          }],
        },
      }),
    )

    // Act: "read me the summary", as the notify action asks for it.
    const read = await client.callTool({ name: 'read_result', arguments: { sessionId, taskId } })

    // Assert: the report's opening is spoken; the whole text is in the data.
    assert.equal(firstText(read), 'Oat milk is the fastest growing plant milk. Prices are stable.')
    assert.match(String(structuredOf(read).text), /Details follow\./)
  })
})

test('read_result refuses a result that is not a text file', async () => {
  await withAskServer(async ({ client, workspacePath }) => {
    const started = structuredOf(await client.callTool({
      name: 'start_workflow',
      arguments: { workflowId: 'market-research', brief: 'Research the market for oat milk in Poland.' },
    }))
    const sessionId = String(started.sessionId)
    const taskId = String(started.taskId)
    const workerStore = new FileSystemSessionStore(workspacePath)
    const runId = (await workerStore.getTaskRecord(sessionId, taskId))?.runId
    assert.ok(runId)
    const assignmentPath =
      resolveRunAssignmentLocation(workspacePath, runId)?.assignmentPath ??
      path.join(workspacePath, 'assignments', runId)
    fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
    const video = Buffer.from('not really a video')
    fs.writeFileSync(path.join(assignmentPath, 'output', 'walkthrough.mp4'), video)
    await workerStore.updateTaskRecord(sessionId, taskId, { status: 'done', completedAt: new Date().toISOString() })
    await workerStore.appendChatMessage(
      sessionId,
      buildChatMessage('assistant', 'Your video is ready.', {
        delivery: {
          taskId,
          artifacts: [{
            runId,
            path: 'output/walkthrough.mp4',
            role: 'final',
            mediaType: 'video/mp4',
            digest: createHash('sha256').update(video).digest('hex'),
          }],
        },
      }),
    )

    const read = await client.callTool({ name: 'read_result', arguments: { sessionId, taskId } })

    assert.equal(read.isError, true)
    assert.match(firstText(read), /can't read aloud/)
  })
})
