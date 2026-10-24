/**
 * A tool-enabled Team agent still has to say what it answered.
 *
 * Every orchestrated task tree is launched with a worker-turn endpoint, so a
 * Team agent that declares tools runs its turn in the parent rather than
 * through a provider in this process. That path returns the finished answer
 * and nothing else — there is no token stream to observe — and until now it
 * returned without telling the display observer anything at all, which is why
 * those agents showed no bubble whatsoever.
 *
 * The contract this pins is deliberately modest and is the honest limit of
 * this transport: exactly one text event, carrying the whole answer, once the
 * turn has completed. It is a bubble that appears rather than one that grows.
 */
import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { runAgent } from '../../domains/agent-execution/agent-runner.js'
import {
  MCP_WORKER_TURN_CONTRACT_VERSION,
  MCP_WORKER_TURN_URL_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import type { ProviderProtocolEvent } from '../../contracts/provider.js'

const ANSWER = 'Electron ships faster but Tauri ships smaller.'

interface WorkerServer {
  readonly url: string
  readonly close: () => Promise<void>
}

/** The parent's worker-turn route, reduced to one completed answer. */
async function startWorkerServer(provider?: string): Promise<WorkerServer> {
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Consume the real request body.
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          version: MCP_WORKER_TURN_CONTRACT_VERSION,
          kind: 'completed',
          ...(provider ? { provider } : {}),
          text: ANSWER,
          model: 'vendor/actual',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          availableToolCount: 3,
          toolCallCount: 1,
          executedToolCallCount: 1,
        }),
      )
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/internal/mcp-worker-turn`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

test('a completed worker turn reports its answer to the display observer once', async () => {
  const worker = await startWorkerServer()
  const observed: ProviderProtocolEvent[] = []

  try {
    const result = await runAgent({
      agentName: 'spec-beta',
      provider: 'openai',
      model: 'vendor/configured',
      thinking: 'medium',
      systemPrompt: 'Compare the runtimes.',
      userMessage: 'Which desktop runtime should we pick?',
      tools: ['browser'],
      workerEnvironment: {
        [MCP_WORKER_TURN_URL_ENV]: worker.url,
        TEAM_RUNTIME_SESSION_ID: '11111111-1111-4111-8111-111111111111',
        TEAM_RUNTIME_RUN_ID: '22222222-2222-4222-8222-222222222222',
        TEAM_RUNTIME_ASSIGNMENT_ID:
          'child-research-33333333-3333-4333-8333-333333333333',
        TEAM_RUNTIME_TASK_ID: '22222222-2222-4222-8222-222222222222',
        TEAM_RUNTIME_PROCESS_IDENTITY: '44444444-4444-4444-8444-444444444444',
        TEAM_RUNTIME_WORKFLOW_ID: 'team-chat',
        TEAM_RUNTIME_WORKFLOW_STEP_ID: 'chat-turn',
      },
      onProtocolEvent: (event) => observed.push(event),
    })

    // The turn's own result is untouched: this is a display concern.
    assert.equal(result.text, ANSWER)

    const textEvents = observed.filter((event) => event.kind === 'text')
    const describe = JSON.stringify(observed)
    assert.equal(
      textEvents.length,
      1,
      `a tool-enabled agent must report its answer exactly once: ${describe}`,
    )
    assert.equal(textEvents[0]?.text, ANSWER, describe)
  } finally {
    await worker.close()
  }
})

test('a display observer that throws cannot fail a worker turn', async () => {
  const worker = await startWorkerServer()
  try {
    const result = await runAgent({
      agentName: 'spec-beta',
      provider: 'openai',
      model: 'vendor/configured',
      thinking: 'medium',
      systemPrompt: 'Compare the runtimes.',
      userMessage: 'Which desktop runtime should we pick?',
      tools: ['browser'],
      workerEnvironment: {
        [MCP_WORKER_TURN_URL_ENV]: worker.url,
        TEAM_RUNTIME_SESSION_ID: '11111111-1111-4111-8111-111111111111',
        TEAM_RUNTIME_RUN_ID: '22222222-2222-4222-8222-222222222222',
        TEAM_RUNTIME_ASSIGNMENT_ID:
          'child-research-33333333-3333-4333-8333-333333333333',
        TEAM_RUNTIME_TASK_ID: '22222222-2222-4222-8222-222222222222',
        TEAM_RUNTIME_PROCESS_IDENTITY: '44444444-4444-4444-8444-444444444444',
        TEAM_RUNTIME_WORKFLOW_ID: 'team-chat',
        TEAM_RUNTIME_WORKFLOW_STEP_ID: 'chat-turn',
      },
      onProtocolEvent: () => {
        throw new Error('the renderer is gone')
      },
    })
    assert.equal(result.text, ANSWER)
  } finally {
    await worker.close()
  }
})

test('a Gemini fallback reports its actual provider instead of free Codex usage', async () => {
  const worker = await startWorkerServer('gemini-api')
  const observed: ProviderProtocolEvent[] = []

  try {
    const result = await runAgent({
      agentName: 'spec-beta',
      provider: 'codex',
      model: 'vendor/configured',
      providerConfig: { input_cost_per_million_usd: 0, output_cost_per_million_usd: 0 },
      thinking: 'medium',
      systemPrompt: 'Compare the runtimes.',
      userMessage: 'Which desktop runtime should we pick?',
      tools: ['browser'],
      workerEnvironment: {
        [MCP_WORKER_TURN_URL_ENV]: worker.url,
        TEAM_RUNTIME_SESSION_ID: '11111111-1111-4111-8111-111111111111',
        TEAM_RUNTIME_RUN_ID: '22222222-2222-4222-8222-222222222222',
        TEAM_RUNTIME_ASSIGNMENT_ID:
          'child-research-33333333-3333-4333-8333-333333333333',
        TEAM_RUNTIME_TASK_ID: '22222222-2222-4222-8222-222222222222',
        TEAM_RUNTIME_PROCESS_IDENTITY: '44444444-4444-4444-8444-444444444444',
        TEAM_RUNTIME_WORKFLOW_ID: 'team-chat',
        TEAM_RUNTIME_WORKFLOW_STEP_ID: 'chat-turn',
      },
      onProtocolEvent: (event) => observed.push(event),
    })

    // The turn's own result is untouched: this is a display concern.
    assert.equal(result.text, ANSWER)
    assert.equal(result.provider, 'gemini-api')
    assert.notEqual(result.costSource, 'zero_cost')
    assert.notEqual(result.costSource, 'provider_config')
    assert.equal(observed.find((event) => event.kind === 'text')?.provider, 'gemini-api')

    const textEvents = observed.filter((event) => event.kind === 'text')
    const describe = JSON.stringify(observed)
    assert.equal(
      textEvents.length,
      1,
      `a tool-enabled agent must report its answer exactly once: ${describe}`,
    )
    assert.equal(textEvents[0]?.text, ANSWER, describe)
  } finally {
    await worker.close()
  }
})
