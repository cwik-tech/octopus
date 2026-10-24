import test from 'node:test'
import assert from 'node:assert/strict'

import { collectProtocolEvents, executeProvider } from '../../providers/protocol.js'
import type { Provider } from '../../providers/types.js'

test('collectProtocolEvents folds normalized stream events into ProviderResult', async () => {
  async function* events() {
    yield { kind: 'text' as const, provider: 'test', text: 'Hello ' }
    yield { kind: 'text' as const, provider: 'test', text: 'world' }
    yield {
      kind: 'usage' as const,
      provider: 'test',
      model: 'model-b',
      inputTokens: 3,
      outputTokens: 2,
      contextTokens: 5,
      cost: 0.01,
    }
    yield { kind: 'complete' as const, provider: 'test', durationMs: 42 }
  }

  const result = await collectProtocolEvents(events(), 'model-a')
  assert.equal(result.text, 'Hello world')
  assert.equal(result.model, 'model-b')
  assert.equal(result.inputTokens, 3)
  assert.equal(result.outputTokens, 2)
  assert.equal(result.contextTokens, 5)
  assert.equal(result.cost, 0.01)
  assert.equal(result.durationMs, 42)
})

test('executeProvider prefers stream when a provider exposes it', async () => {
  let executeCalled = false
  const provider: Provider = {
    name: 'streamed',
    execute: async () => {
      executeCalled = true
      throw new Error('execute should not be called')
    },
    stream: async function* () {
      yield { kind: 'text' as const, provider: 'streamed', text: 'stream result' }
    },
  }

  const result = await executeProvider(provider, {
    systemPrompt: 'sys',
    userMessage: 'msg',
    model: 'model-a',
    thinking: 'low',
  })

  assert.equal(result.text, 'stream result')
  assert.equal(executeCalled, false)
})


test('executeProvider forwards onEvent to an execute-only provider that emits incrementally', async () => {
  const observed: string[] = []
  const provider: Provider = {
    name: 'execute-only',
    execute: async (options) => {
      // An execute()-only provider that genuinely sees bytes mid-turn, exactly
      // as lm-studio and codex do.
      options.onProtocolEvent?.({ kind: 'text', provider: 'execute-only', text: 'Hel' })
      options.onProtocolEvent?.({ kind: 'text', provider: 'execute-only', text: 'lo' })
      return {
        text: 'Hello',
        cost: 0,
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        contextTokens: 2,
        model: options.model,
      }
    },
  }

  const result = await executeProvider(
    provider,
    { systemPrompt: 's', userMessage: 'u', model: 'm', thinking: 'low' },
    (event) => {
      if (event.kind === 'text' && event.text) observed.push(event.text)
    },
  )

  assert.deepEqual(observed, ['Hel', 'lo'])
  assert.equal(result.text, 'Hello')
})

test('executeProvider preserves an observer the caller already put on options', async () => {
  const fromOptions: string[] = []
  const fromArgument: string[] = []
  const provider: Provider = {
    name: 'execute-only',
    execute: async (options) => {
      options.onProtocolEvent?.({ kind: 'text', provider: 'execute-only', text: 'x' })
      return {
        text: 'x',
        cost: 0,
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        model: options.model,
      }
    },
  }

  await executeProvider(
    provider,
    {
      systemPrompt: 's',
      userMessage: 'u',
      model: 'm',
      thinking: 'low',
      onProtocolEvent: (event) => {
        if (event.text) fromOptions.push(event.text)
      },
    },
    (event) => {
      if (event.text) fromArgument.push(event.text)
    },
  )

  assert.deepEqual(fromOptions, ['x'], 'the caller-supplied observer still fires')
  assert.deepEqual(fromArgument, ['x'], 'and so does the third-argument observer')
})

test('executeProvider leaves a silent execute-only provider unchanged', async () => {
  let observedCount = 0
  const provider: Provider = {
    name: 'silent',
    execute: async (options) => ({
      text: 'done',
      cost: 0,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      model: options.model,
    }),
  }

  const result = await executeProvider(
    provider,
    { systemPrompt: 's', userMessage: 'u', model: 'm', thinking: 'low' },
    () => {
      observedCount += 1
    },
  )

  assert.equal(observedCount, 0)
  assert.equal(result.text, 'done')
})
