import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { seedChatSessionStore } from '../helpers/chat-session-store-fixture.js'

// The chat service resolves providers through the registry, which the API
// server populates at startup. Driving the service directly means doing it here.
initProviders()

function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const ANSWER_STREAM = [
  chunk({ model: 'vendor/actual', choices: [{ index: 0, delta: { content: 'The answer' } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
]

test('a streamed answer from a provider without activity events shows the reply as being written', async () => {
  const hub = new AgentTextStreamHub()
  const turnId = '12121212-3434-5656-7878-909090909090'
  const sessionId = '21212121-4343-6565-8787-090909090909'
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'answer-progress-')))
  const previousKey = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'test-key'
  // Only the provider's network boundary is replaced; the provider, chat service and hub run.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder()
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of ANSWER_STREAM) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof globalThis.fetch
  const sessionStore = Object.assign(seedChatSessionStore(path.join(repoRoot, 'workspace'), sessionId), {
    listChatMessages: async () => [],
    appendChatMessageIfAbsent: async () => 'appended' as const,
    updateSessionTitle: async () => null,
    listFiles: async () => [],
  })

  try {
    await runSessionAgentChatTurn({
      sessionId,
      session: { id: 'x', title: 't', status: 'active', activityType: 'chat', createdAt: '', updatedAt: '' },
      sessionStore,
      repoRootPath: repoRoot,
      text: 'Answer briefly.',
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

  const frames = hub.read(turnId, 0)?.frames ?? []
  const firstDelta = frames.findIndex(frame => frame.type === 'delta')
  assert.ok(firstDelta >= 0, 'the answer text reached the display channel')
  const progress = frames.flatMap(frame => frame.type === 'progress' ? [frame.progress.current] : [])
  assert.deepEqual(progress.at(-1), { kind: 'observed', phase: 'answering' })
})
