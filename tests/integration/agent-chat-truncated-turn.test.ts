import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import type { AgentTextStreamFrame } from '../../contracts/agent-text-stream.js'
import { seedChatSessionStore } from '../helpers/chat-session-store-fixture.js'

/**
 * A truncated turn has to reach the display channel as a truncation.
 *
 * This is the one failure where the user has already read something. The text
 * is on screen, it stops mid-sentence, and the provider discarded it rather
 * than returning it as an answer. Closing that bubble with a generic error
 * frame says "nothing was produced", which contradicts what is on screen;
 * closing it with `final` / `reason: 'truncated'` is what lets the UI mark the
 * rendered partial text as discarded.
 *
 * Driven through the real OpenRouter provider so the whole chain is exercised:
 * a streamed `finish_reason: length`, the shared reader, `detectProviderTruncation`,
 * the typed `ProviderError`, and the service's mapping onto a stream frame.
 */

// The chat service resolves providers through the registry, which the API
// server populates at startup. Driving the service directly means doing it here.
initProviders()

function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const TRUNCATED_STREAM = [
  chunk({ model: 'vendor/actual', choices: [{ index: 0, delta: { content: 'The answer beg' } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
  'data: [DONE]\n\n',
]

const WHOLE_STREAM = [
  chunk({ model: 'vendor/actual', choices: [{ index: 0, delta: { content: 'A title' } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
]

/** Truncate the first request only; later ones (the title turn) succeed. */
function stubOpenRouter(): () => void {
  const originalFetch = globalThis.fetch
  let requests = 0
  const fake = async (): Promise<Response> => {
    requests += 1
    return sseResponse(requests === 1 ? TRUNCATED_STREAM : WHOLE_STREAM)
  }
  globalThis.fetch = fake as unknown as typeof globalThis.fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

function framesOf(hub: AgentTextStreamHub, channelId: string): AgentTextStreamFrame[] {
  return [...(hub.read(channelId, 0)?.frames ?? [])]
}

test('a turn the provider truncated closes the bubble as truncated, not as an error', async () => {
  const hub = new AgentTextStreamHub()
  const turnId = '55555555-6666-7777-8888-999999999999'
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'truncated-turn-')),
  )
  const previousKey = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'test-key'
  const restore = stubOpenRouter()

  const messages: Array<Record<string, unknown>> = []
  const sessionStore = Object.assign(seedChatSessionStore(path.join(repoRoot, 'workspace'), '66666666-7777-8888-9999-aaaaaaaaaaaa'), {
    listChatMessages: async () => [],
    appendChatMessageIfAbsent: async (
      _id: string,
      message: Record<string, unknown>,
    ) => {
      messages.push(message)
      return 'appended' as const
    },
    updateSessionTitle: async () => null,
    listFiles: async () => [],
  })

  try {
    await runSessionAgentChatTurn({
      sessionId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      session: {
        id: 'x',
        title: 't',
        status: 'active',
        activityType: 'chat',
        createdAt: '',
        updatedAt: '',
      },
      sessionStore,
      repoRootPath: repoRoot,
      text: 'Write something long.',
      agentNames: [],
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      turnId,
      textStreamHub: hub,
    })
  } finally {
    restore()
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }

  const frames = framesOf(hub, turnId)
  const deltas = frames.filter((frame) => frame.type === 'delta')
  assert.ok(
    deltas.some((frame) => frame.type === 'delta' && frame.text === 'The answer beg'),
    'the partial text reached the display channel before the failure',
  )

  const terminal = frames.at(-1)
  assert.equal(
    terminal?.type,
    'final',
    'a truncated turn closes with a final frame, not an error frame',
  )
  assert.equal(terminal?.type === 'final' ? terminal.reason : undefined, 'truncated')
})

test('a turn that failed for any other reason still closes with an error frame', async () => {
  const hub = new AgentTextStreamHub()
  const turnId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb'
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'failed-turn-')),
  )
  const previousKey = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'test-key'
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'nope' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch

  const sessionStore = Object.assign(seedChatSessionStore(path.join(repoRoot, 'workspace'), '88888888-9999-aaaa-bbbb-cccccccccccc'), {
    listChatMessages: async () => [],
    appendChatMessageIfAbsent: async () => 'appended' as const,
    updateSessionTitle: async () => null,
    listFiles: async () => [],
  })

  try {
    await runSessionAgentChatTurn({
      sessionId: '88888888-9999-aaaa-bbbb-cccccccccccc',
      session: {
        id: 'x',
        title: 't',
        status: 'active',
        activityType: 'chat',
        createdAt: '',
        updatedAt: '',
      },
      sessionStore,
      repoRootPath: repoRoot,
      text: 'Anything.',
      agentNames: [],
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      turnId,
      textStreamHub: hub,
    })
  } finally {
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }

  const terminal = framesOf(hub, turnId).at(-1)
  assert.equal(
    terminal?.type,
    'error',
    'an ordinary provider failure is still an error, not a truncation',
  )
})
