/**
 * What a Team host can actually observe from the Pi session it runs on.
 *
 * The host's lifetime rules are only as good as the events they read, and two
 * of those readings are easy to get wrong from the type definitions alone. Both
 * are checked here against a real `AgentSession`, a real inline extension and a
 * real loopback provider — no fake Pi, and no assumption standing in for one.
 *
 * 1. **Handing over two entries at once loses one.**
 *    `ExtensionAPI.sendUserMessage` is `void` and its rejection goes to Pi's own
 *    error channel (`dist/core/agent-session.js:1855`), so a caller that sends
 *    twice learns nothing about either send. `AgentSession.prompt` reads
 *    `isStreaming` once (`:831`) and then awaits `emitBeforeAgentStart` (`:885`)
 *    before starting the run (`:919`), so two sends from one synchronous loop
 *    both pass that check. The second reaches `agent.prompt`, which throws
 *    "Agent is already processing a prompt"
 *    (`pi-agent-core/dist/agent.js:226-228`) — and `_runAgentPrompt`'s `finally`
 *    emits `agent_settled` even for that rejection (`:744-755`), so the losing
 *    send announces the end of a turn the winner is still running.
 *
 * 2. **A compaction does not always report that it finished.**
 *    `session_compact` is emitted only after a successful save (`:1677`). A
 *    compaction an extension cancels (`:1623`), one that is aborted (`:1660`)
 *    and one that fails (`:1711`) emit a session-level `compaction_end` instead,
 *    which no extension can see. Anything that waits for `session_compact`
 *    before it will act again waits for an event that is never coming.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'

import { flushPendingFollowUps } from '../../domains/runtime/follow-up.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'

const PROVIDER = 'lm-studio'
const MODEL = 'loopback-model'
const FIRST_ENTRY = 'ENTRY_ONE'
const SECOND_ENTRY = 'ENTRY_TWO'

// ── A loopback provider that answers, and says what it was asked ─────────────

function sse(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`
}

/**
 * One complete assistant turn.
 *
 * `inputTokens` is how this fixture reaches Pi's overflow check: it compares
 * the reported usage against the model's context window
 * (`dist/core/agent-session.js` `_checkCompaction`), so a large number against
 * a small window is what makes the next prompt compact.
 */
function assistantTurn(text: string, inputTokens = 1): string {
  return [
    sse('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    }),
    sse('message_stop', {}),
  ].join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The text of the user message this request is asking about. */
function readPromptedText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return '<no messages>'
  const last = body.messages[body.messages.length - 1]
  if (!isRecord(last)) return '<no message>'
  if (typeof last.content === 'string') return last.content
  if (!Array.isArray(last.content)) return '<no content>'
  for (const part of last.content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      return part.text
    }
  }
  return '<no text>'
}

interface LoopbackProvider {
  readonly baseUrl: string
  readonly served: string[]
  readonly close: () => Promise<void>
}

async function startLoopbackProvider(
  respond: (prompted: string, index: number) => string,
  onServed?: (prompted: string, index: number) => void,
): Promise<LoopbackProvider> {
  const served: string[] = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    request.on('end', () => {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Recorded as unreadable below rather than thrown away.
      }
      const prompted = readPromptedText(parsed)
      const index = served.length
      served.push(prompted)
      onServed?.(prompted, index)
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      response.end(respond(prompted, index))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'the provider must have a port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    served,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** A throwaway agent directory whose only model is the loopback one. */
function writeAgentDirectory(
  agentDir: string,
  baseUrl: string,
  contextWindow: number,
  compaction?: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          baseUrl,
          api: 'anthropic-messages',
          apiKey: 'loopback-no-credential',
          models: [
            {
              id: MODEL,
              name: MODEL,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow,
              maxTokens: 1_000,
            },
          ],
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: PROVIDER,
      defaultModel: MODEL,
      ...(compaction ? { compaction } : {}),
    }),
  )
  fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}', { mode: 0o600 })
}

interface RealSession {
  readonly session: AgentSession
  readonly extensionErrors: string[]
  readonly dispose: () => Promise<void>
}

/** A real Pi session carrying one inline extension, and nothing else. */
async function startRealPiSession(options: {
  readonly agentDir: string
  readonly onError?: (described: string) => void
  readonly register: (pi: ExtensionAPI) => void
}): Promise<RealSession> {
  const extensionErrors: string[] = []
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.agentDir,
    agentDir: options.agentDir,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{ name: 'host-probe', factory: options.register }],
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: options.agentDir,
    agentDir: options.agentDir,
    noTools: 'builtin',
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.agentDir),
  })
  await session.bindExtensions({
    mode: 'print',
    onError: (error) => {
      const described = isRecord(error) ? JSON.stringify(error) : String(error)
      extensionErrors.push(described)
      options.onError?.(described)
    },
  })
  return {
    session,
    extensionErrors,
    dispose: async () => {
      await session.waitForIdle()
      session.dispose()
    },
  }
}

/** A pending-work queue with the given entries already due. */
function makeContextWith(pi: ExtensionAPI, messages: readonly string[]): RuntimeContext {
  const due = Date.now() - 1
  return {
    pendingFollowUps: messages.map((message, index) => ({
      id: `entry-${index}`,
      message,
      kind: 'stage_entry' as const,
      notBefore: due,
      attempts: 0,
      createdAt: new Date(due).toISOString(),
    })),
    pendingFollowUpTimer: null,
    outerTurnOwner: null,
    agentMetrics: new Map(),
    // Logging returns early without these, which keeps these tests about the
    // session rather than about an assignment's log files.
    teamConfig: null,
    state: { sessionId: '' },
    pi,
  } as unknown as RuntimeContext
}

function makeAgentDirectory(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

// ── 1. Delivery ─────────────────────────────────────────────────────────────

test(
  'a second admitted entry reaches the host only after the first has finished',
  { timeout: 60_000, skip: process.platform === 'win32' },
  async () => {
    const order: string[] = []

    /**
     * Both entries served, or the first sign that one was refused.
     *
     * Racing these is what makes a lost entry fail here rather than hang, and
     * each is resolved from the event that decides it rather than polled.
     */
    let bothServed = (): void => {}
    const secondServed = new Promise<void>((resolve) => {
      bothServed = resolve
    })
    let entryRefused = (): void => {}
    const refused = new Promise<void>((resolve) => {
      entryRefused = resolve
    })

    const provider = await startLoopbackProvider(
      () => assistantTurn('ok'),
      (prompted, index) => {
        order.push(`provider:${prompted}`)
        if (index >= 1) bothServed()
      },
    )
    const agentDir = makeAgentDirectory('host-delivery-')
    writeAgentDirectory(agentDir, provider.baseUrl, 100_000)

    /** Held open until the test lets go, which it does on its own. */
    let releaseFirstTurn = (): void => {}
    const firstTurnHeld = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    let firstTurnReachedBarrier = (): void => {}
    const atBarrier = new Promise<void>((resolve) => {
      firstTurnReachedBarrier = resolve
    })

    let context: RuntimeContext | undefined
    let starts = 0
    let live: RealSession | undefined

    try {
      live = await startRealPiSession({
        agentDir,
        onError: () => {
          order.push('extension_error')
          entryRefused()
        },
        register: (pi) => {
          context = makeContextWith(pi, [FIRST_ENTRY, SECOND_ENTRY])
          pi.on('before_agent_start', async () => {
            starts += 1
            order.push(`before_agent_start:${starts}`)
            if (starts === 1) {
              firstTurnReachedBarrier()
              await firstTurnHeld
            }
            return undefined
          })
          pi.on('agent_start', () => {
            order.push('agent_start')
          })
          pi.on('agent_settled', () => {
            order.push('agent_settled')
            // The production trigger: a settled turn is when the runtime looks
            // at its queue again.
            if (context) flushPendingFollowUps(context)
          })
        },
      })

      assert.ok(context, 'the inline extension must have been given a Pi API')

      flushPendingFollowUps(context)
      order.push('flushed')

      // Released on its own, never by waiting for a second arrival: correct
      // delivery is precisely what stops that second arrival from happening.
      await atBarrier
      releaseFirstTurn()

      await Promise.race([secondServed, refused])
      await live.session.waitForIdle()

      const trace = `order ${JSON.stringify(order)}; errors ${JSON.stringify(live.extensionErrors)}`

      assert.deepEqual(
        live.extensionErrors,
        [],
        `no admitted entry may be refused by the host; ${trace}`,
      )
      assert.deepEqual(
        provider.served,
        [FIRST_ENTRY, SECOND_ENTRY],
        `both entries must reach the provider, in order, exactly once; ${trace}`,
      )
      assert.equal(
        order.filter((step) => step === 'agent_start').length,
        2,
        `each entry must get its own turn; ${trace}`,
      )
      assert.ok(
        order.indexOf(`provider:${SECOND_ENTRY}`) > order.indexOf('agent_settled'),
        `the second entry must be admitted only after the first turn settled; ${trace}`,
      )
    } finally {
      releaseFirstTurn()
      await live?.dispose()
      await provider.close()
      fs.rmSync(agentDir, { recursive: true, force: true })
    }
  },
)

// ── 2. Compaction ───────────────────────────────────────────────────────────

test(
  'a cancelled compaction reports no completion of its own, and the turn still starts',
  { timeout: 60_000, skip: process.platform === 'win32' },
  async () => {
    // The host holds its missing-start deadline while Pi compacts, because
    // compaction is itself a provider call that legitimately delays the next
    // turn. This is why that hold can never wait for `session_compact`: the
    // cancelled path does not emit it, and the turn arrives anyway.
    const order: string[] = []
    let secondTurnStarted = (): void => {}
    const secondStart = new Promise<void>((resolve) => {
      secondTurnStarted = resolve
    })

    const provider = await startLoopbackProvider(
      // A first answer that reports far more input than the window holds, which
      // is what makes the next prompt compact before it starts its turn.
      (_prompted, index) => assistantTurn('ok', index === 0 ? 500_000 : 1),
      (prompted) => {
        order.push(`provider:${prompted}`)
      },
    )
    const agentDir = makeAgentDirectory('host-compaction-')
    // Keep almost nothing recent, so the one turn of history the first entry
    // produces is enough for Pi to find something to compact.
    writeAgentDirectory(agentDir, provider.baseUrl, 1_000, {
      enabled: true,
      reserveTokens: 1,
      keepRecentTokens: 1,
    })

    let context: RuntimeContext | undefined
    let starts = 0
    let live: RealSession | undefined

    try {
      live = await startRealPiSession({
        agentDir,
        onError: () => {
          order.push('extension_error')
        },
        register: (pi) => {
          context = makeContextWith(pi, [FIRST_ENTRY, SECOND_ENTRY])
          pi.on('session_before_compact', () => {
            order.push('session_before_compact')
            // Cancelled by this extension, which is one of the three outcomes
            // that emit no `session_compact`.
            return { cancel: true }
          })
          pi.on('session_compact', () => {
            order.push('session_compact')
          })
          pi.on('agent_start', () => {
            starts += 1
            order.push(`agent_start:${starts}`)
            if (starts === 2) secondTurnStarted()
          })
          pi.on('agent_settled', () => {
            order.push('agent_settled')
            if (context) flushPendingFollowUps(context)
          })
        },
      })

      assert.ok(context, 'the inline extension must have been given a Pi API')

      flushPendingFollowUps(context)
      await secondStart
      await live.session.waitForIdle()

      const trace = `order ${JSON.stringify(order)}`

      assert.ok(
        order.includes('session_before_compact'),
        `the fixture must actually reach a compaction, or it proves nothing; ${trace}`,
      )
      assert.ok(
        !order.includes('session_compact'),
        `a cancelled compaction must not report a completion an extension can see; ${trace}`,
      )
      assert.equal(
        order.filter((step) => step.startsWith('agent_start')).length,
        2,
        `the prompt that compacted must still start its turn; ${trace}`,
      )
      assert.ok(
        order.indexOf('agent_start:2') > order.indexOf('session_before_compact'),
        `and it must start after the compaction it cancelled; ${trace}`,
      )
    } finally {
      await live?.dispose()
      await provider.close()
      fs.rmSync(agentDir, { recursive: true, force: true })
    }
  },
)
