import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createLmStudioProvider } from '../../providers/lm-studio.js'
import { initProviders } from '../../providers/index.js'
import { runAgent } from '../../domains/agent-execution/agent-runner.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'

initProviders()

test('LM Studio provider: name is "lm-studio"', () => {
  const provider = createLmStudioProvider()
  assert.equal(provider.name, 'lm-studio')
})

test('LM Studio provider: streams events, returns final text, and logs provider lifecycle', async () => {
  const provider = createLmStudioProvider()
  const originalFetch = globalThis.fetch
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmstudio-provider-'))

  globalThis.fetch = async () => sseResponse([
    ['chat.start', { type: 'chat.start', model_instance_id: 'qwen3.5-4b' }],
    ['prompt_processing.start', { type: 'prompt_processing.start' }],
    ['message.start', { type: 'message.start' }],
    ['message.delta', { type: 'message.delta', content: 'Hello ' }],
    ['message.delta', { type: 'message.delta', content: 'world' }],
    ['message.end', { type: 'message.end' }],
    ['chat.end', {
      type: 'chat.end',
      result: {
        model_instance_id: 'qwen3.5-4b',
        response_id: 'resp_123',
        output: [{ type: 'message', content: 'Hello world' }],
        stats: {
          input_tokens: 11,
          total_output_tokens: 2,
        },
      },
    }],
  ])

  try {
    const result = await provider.execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'qwen3.5-4b',
      thinking: 'low',
      outputPath: outputDir,
      sessionId: 'session-1',
      rootSessionId: 'root-1',
      agentName: 'writer',
    })

    assert.equal(result.text, 'Hello world')
    assert.equal(result.model, 'qwen3.5-4b')
    assert.equal(result.inputTokens, 11)
    assert.equal(result.outputTokens, 2)

    const logPath = getAssignmentLogPath(outputDir, 'provider-events.jsonl')
    const entries = readJsonl(logPath)
    assert.equal(entries[0]?.event, 'request.start')
    assert.equal(entries[1]?.event, 'request.accepted')
    assert.ok(entries.some((entry) => entry.event === 'chat.start'))
    assert.ok(entries.some((entry) => entry.event === 'message.delta' && entry.detail === 'Hello '))
    assert.ok(entries.some((entry) => entry.event === 'chat.end' && entry.request_id === 'resp_123'))
    assert.equal(entries.at(-1)?.event, 'request.end')
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('runAgent with LM Studio logs provider failure into provider-events.jsonl', async () => {
  const originalFetch = globalThis.fetch
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmstudio-agent-'))

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { type: 'model_not_found', message: 'unknown model' },
  }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })

  try {
    await assert.rejects(
      runAgent({
        systemPrompt: 'system',
        userMessage: 'user',
        model: 'bad-model',
        thinking: 'low',
        provider: 'lm-studio',
        outputPath: outputDir,
        sessionId: 'session-2',
        rootSessionId: 'root-2',
        agentName: 'brief-builder',
      }),
      /unknown model/,
    )

    const entries = readJsonl(getAssignmentLogPath(outputDir, 'provider-events.jsonl'))
    assert.equal(entries[0]?.event, 'request.start')
    assert.equal(entries.at(-1)?.event, 'request.fail')
    assert.match(String(entries.at(-1)?.detail), /unknown model/)
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('LM Studio provider: emits ordered text protocol events before the promise resolves', async () => {
  const provider = createLmStudioProvider()
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () => sseResponse([
    ['chat.start', { type: 'chat.start', model_instance_id: 'qwen3.5-4b' }],
    ['message.delta', { type: 'message.delta', content: 'Hello ' }],
    ['message.delta', { type: 'message.delta', content: 'brave ' }],
    ['message.delta', { type: 'message.delta', content: 'world' }],
    ['chat.end', {
      type: 'chat.end',
      result: {
        model_instance_id: 'qwen3.5-4b',
        response_id: 'resp_a',
        output: [{ type: 'message', content: 'Hello brave world' }],
        stats: { input_tokens: 3, total_output_tokens: 3 },
      },
    }],
  ])

  const observed: Array<{ kind: string; text?: string }> = []
  let settled = false

  try {
    const promise = provider.execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'qwen3.5-4b',
      thinking: 'low',
      onProtocolEvent: (event) => {
        assert.equal(settled, false, 'events must arrive before the promise resolves')
        observed.push({
          kind: event.kind,
          ...(event.text === undefined ? {} : { text: event.text }),
        })
      },
    })
    const result = await promise
    settled = true

    const textEvents = observed.filter((event) => event.kind === 'text')
    assert.deepEqual(
      textEvents.map((event) => event.text),
      ['Hello ', 'brave ', 'world'],
      'one ordered text event per message.delta, carrying only the new suffix',
    )
    assert.equal(result.text, 'Hello brave world')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('LM Studio provider: the complete event carries the authoritative chat.end text', async () => {
  const provider = createLmStudioProvider()
  const originalFetch = globalThis.fetch

  // chat.end disagrees with the accumulated deltas. chat.end is documented as
  // the final aggregated result, so it wins — and the UI must be told, or the
  // screen keeps text the store never received.
  globalThis.fetch = async () => sseResponse([
    ['message.delta', { type: 'message.delta', content: 'draft' }],
    ['chat.end', {
      type: 'chat.end',
      result: {
        response_id: 'resp_b',
        output: [{ type: 'message', content: 'final answer' }],
        stats: { input_tokens: 1, total_output_tokens: 2 },
      },
    }],
  ])

  const completions: Array<string | undefined> = []
  try {
    const result = await provider.execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'qwen3.5-4b',
      thinking: 'low',
      onProtocolEvent: (event) => {
        if (event.kind === 'complete') completions.push(event.text)
      },
    })

    assert.equal(result.text, 'final answer')
    assert.deepEqual(completions, ['final answer'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('LM Studio provider: falls back to accumulated deltas when chat.end has no output', async () => {
  const provider = createLmStudioProvider()
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () => sseResponse([
    ['message.delta', { type: 'message.delta', content: 'partial ' }],
    ['message.delta', { type: 'message.delta', content: 'answer' }],
    ['chat.end', { type: 'chat.end', result: { response_id: 'resp_c' } }],
  ])

  try {
    const result = await provider.execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'qwen3.5-4b',
      thinking: 'low',
    })
    assert.equal(result.text, 'partial answer')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('LM Studio provider: a run with no observer behaves exactly as before', async () => {
  const provider = createLmStudioProvider()
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () => sseResponse([
    ['message.delta', { type: 'message.delta', content: 'Hello ' }],
    ['message.delta', { type: 'message.delta', content: 'world' }],
    ['chat.end', {
      type: 'chat.end',
      result: {
        output: [{ type: 'message', content: 'Hello world' }],
        stats: { input_tokens: 4, total_output_tokens: 2 },
      },
    }],
  ])

  try {
    const result = await provider.execute({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'qwen3.5-4b',
      thinking: 'low',
    })
    assert.equal(result.text, 'Hello world')
    assert.equal(result.inputTokens, 4)
    assert.equal(result.outputTokens, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('runAgent forwards a protocol-event observer down to the provider', async () => {
  const originalFetch = globalThis.fetch
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmstudio-observer-'))

  globalThis.fetch = async () => sseResponse([
    ['message.delta', { type: 'message.delta', content: 'Hel' }],
    ['message.delta', { type: 'message.delta', content: 'lo' }],
    ['chat.end', {
      type: 'chat.end',
      result: {
        output: [{ type: 'message', content: 'Hello' }],
        stats: { input_tokens: 1, total_output_tokens: 1 },
      },
    }],
  ])

  const streamed: string[] = []
  try {
    const result = await runAgent({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'qwen3.5-4b',
      thinking: 'low',
      provider: 'lm-studio',
      outputPath: outputDir,
      sessionId: 'session-observer',
      rootSessionId: 'root-observer',
      agentName: 'writer',
      onProtocolEvent: (event) => {
        if (event.kind === 'text' && event.text) streamed.push(event.text)
      },
    })

    assert.deepEqual(streamed, ['Hel', 'lo'])
    assert.equal(result.text, 'Hello')
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('runAgent still completes when the observer throws', async () => {
  const originalFetch = globalThis.fetch
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmstudio-observer-throws-'))

  globalThis.fetch = async () => sseResponse([
    ['message.delta', { type: 'message.delta', content: 'Hello' }],
    ['chat.end', {
      type: 'chat.end',
      result: {
        output: [{ type: 'message', content: 'Hello' }],
        stats: { input_tokens: 1, total_output_tokens: 1 },
      },
    }],
  ])

  try {
    const result = await runAgent({
      systemPrompt: 'system',
      userMessage: 'user',
      model: 'qwen3.5-4b',
      thinking: 'low',
      provider: 'lm-studio',
      outputPath: outputDir,
      sessionId: 'session-observer-throws',
      rootSessionId: 'root-observer-throws',
      agentName: 'writer',
      onProtocolEvent: () => {
        throw new Error('observer exploded')
      },
    })
    assert.equal(result.text, 'Hello')
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

function sseResponse(events: Array<[string, Record<string, unknown>]>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const [event, payload] of events) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
        )
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
