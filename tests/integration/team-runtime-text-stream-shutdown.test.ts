/**
 * The Team runtime's display stream has to be closed by the runtime itself.
 *
 * A Team runs two detached process hops from the hub, and its frames are
 * batched: the last suffix of an answer, and the frame that closes the bubble,
 * usually sit in the sender's queue waiting on a short timer. If the process
 * ends without flushing, those are simply lost — the reader is left watching
 * text that stops mid-answer with no terminal. `session_shutdown` is the last
 * moment at which anything in this process can still send, so the flush
 * belongs there, awaited and bounded.
 *
 * Boots the real extension against a fake Pi host, exactly as
 * `team-runtime-receptionist-tools.test.ts` does, so what is under test is the
 * shipped shutdown handler rather than a helper it might no longer call.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../../domains/runtime/agent-text-delta-tokens.js'
import { getProcessRunTextStream } from '../../domains/runtime/agent-text-run-stream.js'

const repoRoot = process.cwd()
const CHANNEL_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

interface IngestServer {
  readonly url: string
  readonly frames: () => unknown[]
  readonly close: () => Promise<void>
}

/** Stands in for the parent's ingest route: records frames, answers at once. */
async function startIngestServer(): Promise<IngestServer> {
  const received: unknown[] = []
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const frames = (parsed as { frames?: unknown }).frames
        if (Array.isArray(frames)) received.push(...frames)
      } catch {
        // A malformed body is a failure of the sender, which the assertions
        // below will report as missing frames.
      }
      response.writeHead(202).end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/internal/agent-text-stream`,
    frames: () => [...received],
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

test('the Team runtime flushes and closes its display stream at session shutdown', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'team-stream-shutdown-'))
  const previousEnv = { ...process.env }
  const ingest = await startIngestServer()

  process.env.TEAM_CONFIG_PATH = path.join(repoRoot, 'teams/reception-desk/team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = 'session-stream'
  process.env.TEAM_RUNTIME_RUN_ID = 'run-stream'
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = 'assignment-stream'
  process.env.TEAM_RUNTIME_TASK_ID = 'task-stream'
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = 'process-stream'
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')
  process.env.ANTHROPIC_API_KEY = 'preflight-presence-only'
  process.env.PIPELINE_DEFAULT_MODEL_SELECTION = Buffer.from(
    JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
    'utf8',
  ).toString('base64')
  // The grant this run was launched with. Set before anything reads it,
  // because the process stream is built once from this environment.
  process.env[AGENT_TEXT_STREAM_URL_ENV] = ingest.url
  process.env[AGENT_TEXT_STREAM_CHANNEL_ENV] = CHANNEL_ID
  process.env[AGENT_TEXT_STREAM_TOKEN_ENV] = 'shutdown-test-token'

  try {
    const { default: teamRuntimeExtension } = await import('../../team-runtime/index.js')

    const handlers = new Map<string, (...args: never[]) => unknown>()
    const registered: Array<{ name: string }> = []
    const hostModel = {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      provider: 'anthropic',
      api: 'anthropic-messages',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }
    let registryModels: unknown[] = [hostModel]

    const pi = {
      on: (event: string, handler: (...args: never[]) => unknown) =>
        handlers.set(event, handler),
      registerTool: (tool: { name: string }) => registered.push(tool),
      registerCommand: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
      registerMarkdownTransformer: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      getActiveTools: () => registered.map((tool) => tool.name),
      getAllTools: () =>
        registered.map((tool) => ({
          ...tool,
          sourceInfo: { path: path.join(repoRoot, 'team-runtime/index.ts') },
        })),
      setActiveTools: () => {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => 'medium',
      setThinkingLevel: () => {},
      registerProvider: (name: string, config: { models?: unknown[] }) => {
        if (typeof name === 'string' && config?.models) {
          registryModels = [
            ...registryModels,
            ...config.models.map((model) => ({ ...(model as object), provider: name })),
          ]
        }
      },
      unregisterProvider: () => {},
      events: { on: () => {}, off: () => {}, emit: () => {} },
    }

    const extensionContext = {
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      mode: 'headless',
      hasUI: false,
      cwd: repoRoot,
      sessionManager: {
        getEntries: () => [],
        getSessionId: () => 'pi-session',
        getSessionFile: () => undefined,
      },
      modelRegistry: {
        getAvailable: () => registryModels,
        getAll: () => registryModels,
      },
      model: undefined,
      scopedModels: [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => '',
    }

    teamRuntimeExtension(pi as never)
    const sessionStart = handlers.get('session_start')
    assert.ok(sessionStart, 'the extension must register a session_start handler')
    await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
      {},
      extensionContext,
    )

    // A dispatch's tail: the last suffix and the frame that ends the bubble,
    // both still queued behind the batch timer.
    const stream = getProcessRunTextStream()
    const sink = stream.sinkFor('call-1#1#spec-beta')
    assert.ok(sink, 'the run was granted a channel, so it has a sink')
    sink.onProtocolEvent({ kind: 'text', provider: 'test', text: 'the last words' })
    sink.close('completed')

    const shutdown = handlers.get('session_shutdown')
    assert.ok(shutdown, 'the extension must register a session_shutdown handler')
    await (shutdown as () => Promise<void>)()

    // 1. The tail reached the parent before shutdown returned.
    const afterShutdown = ingest.frames()
    assert.equal(
      afterShutdown.length,
      2,
      `the queued tail was not flushed at shutdown: ${JSON.stringify(afterShutdown)}`,
    )

    // 2. The stream is genuinely closed, not merely flushed once. Anything
    //    sent afterwards must go nowhere, however long the timer is given —
    //    this is what a shutdown that never closed would fail.
    sink.onProtocolEvent({ kind: 'text', provider: 'test', text: 'after the end' })
    stream.sinkFor('call-2#1#spec-zeta')?.onProtocolEvent({
      kind: 'text',
      provider: 'test',
      text: 'a later dispatch',
    })
    await delay(400)
    assert.deepEqual(
      ingest.frames().length,
      afterShutdown.length,
      'frames were still being sent after the runtime shut its stream down',
    )
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    await ingest.close()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
