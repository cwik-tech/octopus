/**
 * A Run → Agents bubble may not report success before the answer is kept.
 *
 * Between the last token and the durable message there is real work that can
 * fail: an MCP delivery is generated, and the message itself is written to the
 * session. A bubble closes exactly once, so a `final` published before those
 * steps cannot be withdrawn when one of them throws — the user is told the
 * reply completed and then finds nothing in the transcript.
 */
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

const WHOLE_STREAM = [
  chunk({
    model: 'vendor/actual',
    choices: [{ index: 0, delta: { content: 'A complete answer.' } }],
  }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
]

function framesOf(
  hub: AgentTextStreamHub,
  channelId: string,
): AgentTextStreamFrame[] {
  return [...(hub.read(channelId, 0)?.frames ?? [])]
}

test('a reply the session could not keep is not reported as completed', async () => {
  const hub = new AgentTextStreamHub()
  const turnId = '99999999-aaaa-bbbb-cccc-dddddddddddd'
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-')),
  )
  const previousKey = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'test-key'
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    sseResponse(WHOLE_STREAM)) as unknown as typeof globalThis.fetch

  // The model answered; the session cannot record what it said.
  const sessionStore = Object.assign(seedChatSessionStore(path.join(repoRoot, 'workspace'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), {
    listChatMessages: async () => [],
    appendChatMessageIfAbsent: async (
      _id: string,
      message: { role?: string },
    ) => {
      if (message.role === 'assistant') {
        throw new Error('The assistant message could not be written.')
      }
      return 'appended' as const
    },
    updateSessionTitle: async () => null,
    listFiles: async () => [],
  })

  let threw = false
  try {
    await runSessionAgentChatTurn({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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
  } catch {
    threw = true
  } finally {
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }

  assert.equal(threw, true, 'the turn genuinely failed')

  const frames = framesOf(hub, turnId)
  const describe = JSON.stringify(frames)
  assert.equal(
    frames.some((frame) => frame.type === 'final'),
    false,
    `a reply that was never kept was reported as completed: ${describe}`,
  )
  // The bubble still has to close: an open reply strands the reader on text
  // that will never finish.
  assert.equal(frames.at(-1)?.type, 'error', describe)
})
