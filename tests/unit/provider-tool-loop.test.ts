import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hostAuditedParallelReadEffect,
  serialCapabilityEffect,
} from '../../contracts/capability-effect.js'
import {
  MAX_CONCURRENT_TOOL_CALLS_CEILING,
  ProviderToolLoopError,
  runProviderToolLoop,
  type ProviderToolAssistantTurn,
  type ProviderToolCall,
  type ProviderToolDefinition,
  type ProviderToolLoopAdapter,
} from '../../domains/provider/provider-tool-loop.js'
import { createOpenAIChatCompletionsToolAdapter } from '../../domains/provider/openai-chat-completions-tool-adapter.js'

const markerTool: ProviderToolDefinition = {
  name: 'mcp__fixture__echo_marker',
  description: 'Returns a deterministic marker.',
  effect: hostAuditedParallelReadEffect(),
  inputSchema: {
    properties: {
      marker: { type: 'string' },
    },
    required: ['marker'],
    additionalProperties: false,
  },
}

const prompt = [
  { role: 'system' as const, content: 'Use tools when required.' },
  { role: 'user' as const, content: 'Return the marker.' },
]

test('provider tool loop normalizes schemas, executes a tool, and stops on final text', async () => {
  const observedRequests: Array<Parameters<ProviderToolLoopAdapter['complete']>[0]> = []
  const adapter = scriptedAdapter([
    toolTurn(toolCall('call-1', markerTool.name, { marker: 'alpha' }), 3),
    finalTurn('final:echo-marker:alpha', 5),
  ], (request) => observedRequests.push(request))

  const result = await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter,
    async executeTool(call) {
      assert.deepEqual(call.arguments, { marker: 'alpha' })
      return { content: 'echo-marker:alpha' }
    },
  })

  assert.equal(observedRequests[0]?.tools[0]?.inputSchema.type, 'object')
  assert.strictEqual(
    observedRequests[0]?.tools[0]?.effect,
    hostAuditedParallelReadEffect(),
  )
  assert.equal(observedRequests[1]?.messages.at(-1)?.role, 'tool')
  assert.equal(result.text, 'final:echo-marker:alpha')
  assert.equal(result.rounds, 2)
  assert.equal(result.toolCallCount, 1)
  assert.equal(result.executedToolCallCount, 1)
  assert.equal(result.cachedToolCallCount, 0)
  assert.deepEqual(result.usage, {
    inputTokens: 8,
    outputTokens: 8,
    totalTokens: 16,
  })
})

test('provider tool loop downgrades structurally injected parallel authority', async () => {
  const structuralEffect = {
    kind: 'read-only',
    concurrency: 'parallel-safe',
  } as const
  const tool: ProviderToolDefinition = {
    ...markerTool,
    effect: structuralEffect,
  }
  const observedRequests: Array<Parameters<ProviderToolLoopAdapter['complete']>[0]> = []

  await runProviderToolLoop({
    messages: prompt,
    tools: [tool],
    adapter: scriptedAdapter([
      finalTurn('no-tool-call'),
    ], (request) => observedRequests.push(request)),
    async executeTool() {
      assert.fail('Tool executor should not be called')
    },
  })

  assert.strictEqual(
    observedRequests[0]?.tools[0]?.effect,
    serialCapabilityEffect('read-only'),
  )
})

test('provider tool loop validates parsed arguments against the tool JSON schema', async () => {
  let executionCount = 0
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-invalid', markerTool.name, {})),
    ]),
    async executeTool() {
      executionCount += 1
      return { content: 'must-not-run' }
    },
  })

  await assertToolLoopError(promise, 'invalid_tool_call')
  assert.equal(executionCount, 0)
})

test('provider tool loop rejects unavailable tool names before execution', async () => {
  let executionCount = 0
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-unknown', 'unknown_tool', { marker: 'alpha' })),
    ]),
    async executeTool() {
      executionCount += 1
      return { content: 'must-not-run' }
    },
  })

  await assertToolLoopError(promise, 'tool_not_found')
  assert.equal(executionCount, 0)
})

test('provider tool loop caches identical repeated call ids exactly once', async () => {
  const objectTool: ProviderToolDefinition = {
    name: 'ordered_tool',
    effect: serialCapabilityEffect('read-only'),
    inputSchema: {
      type: 'object',
      properties: {
        alpha: { type: 'number' },
        beta: { type: 'number' },
      },
      required: ['alpha', 'beta'],
      additionalProperties: false,
    },
  }
  let executionCount = 0
  const result = await runProviderToolLoop({
    messages: prompt,
    tools: [objectTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-repeat', objectTool.name, { beta: 2, alpha: 1 })),
      toolTurn(toolCall('call-repeat', objectTool.name, { alpha: 1, beta: 2 })),
      finalTurn('cache-confirmed'),
    ]),
    async executeTool() {
      executionCount += 1
      return { content: 'cached-result' }
    },
  })

  assert.equal(executionCount, 1)
  assert.equal(result.toolCallCount, 2)
  assert.equal(result.executedToolCallCount, 1)
  assert.equal(result.cachedToolCallCount, 1)
  assert.equal(
    result.messages.filter((message) => message.role === 'tool').length,
    2,
  )
})

test('provider tool loop fails closed when a call id is reused with changed arguments', async () => {
  let executionCount = 0
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-reused', markerTool.name, { marker: 'first' })),
      toolTurn(toolCall('call-reused', markerTool.name, { marker: 'changed' })),
    ]),
    async executeTool() {
      executionCount += 1
      return { content: 'first-result' }
    },
  })

  await assertToolLoopError(promise, 'invalid_tool_call')
  assert.equal(executionCount, 1)
})

test('provider tool loop rejects empty and duplicate call ids before execution', async () => {
  const invalidTurns: ProviderToolAssistantTurn[] = [
    toolTurn(toolCall('', markerTool.name, { marker: 'empty' })),
    {
      content: null,
      toolCalls: [
        toolCall('call-duplicate', markerTool.name, { marker: 'one' }),
        toolCall('call-duplicate', markerTool.name, { marker: 'one' }),
      ],
    },
  ]

  for (const turn of invalidTurns) {
    let executionCount = 0
    const promise = runProviderToolLoop({
      messages: prompt,
      tools: [markerTool],
      adapter: scriptedAdapter([turn]),
      async executeTool() {
        executionCount += 1
        return { content: 'must-not-run' }
      },
    })
    await assertToolLoopError(promise, 'invalid_tool_call')
    assert.equal(executionCount, 0)
  }
})

test('provider tool loop enforces total call and provider round limits', async () => {
  let callLimitExecutions = 0
  const callLimit = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([{
      content: null,
      toolCalls: [
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ],
    }]),
    maxToolCalls: 1,
    async executeTool() {
      callLimitExecutions += 1
      return { content: 'must-not-run' }
    },
  })
  await assertToolLoopError(callLimit, 'limit_exceeded')
  assert.equal(callLimitExecutions, 0)

  let roundLimitExecutions = 0
  const roundLimit = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-round', markerTool.name, { marker: 'round' })),
    ]),
    maxRounds: 1,
    async executeTool() {
      roundLimitExecutions += 1
      return { content: 'round-result' }
    },
  })
  await assertToolLoopError(roundLimit, 'limit_exceeded')
  assert.equal(roundLimitExecutions, 1)
})

test('provider tool loop bounds execution and sanitizes executor failures', async () => {
  const privateFailure = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-private', markerTool.name, { marker: 'private' })),
    ]),
    async executeTool() {
      throw new Error('private-token-value')
    },
  })
  const failure = await captureToolLoopError(privateFailure)
  assert.equal(failure.code, 'tool_execution_failed')
  assert.equal(failure.message.includes('private-token-value'), false)

  const oversizedResult = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-large', markerTool.name, { marker: 'large' })),
    ]),
    maxToolResultBytes: 4,
    async executeTool() {
      return { content: 'too-large' }
    },
  })
  await assertToolLoopError(oversizedResult, 'tool_result_too_large')
})

test('provider tool loop carries bounded browser screenshots into the next provider turn', async () => {
  const observed: Array<Parameters<ProviderToolLoopAdapter['complete']>[0]> = []
  const imageData = Buffer.from('real-image-bytes').toString('base64')
  const result = await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-image', markerTool.name, { marker: 'image' })),
      finalTurn('vision-consumed'),
    ], (request) => observed.push(request)),
    async executeTool() {
      return {
        content: 'screenshot-ready',
        images: [{ data: imageData, mimeType: 'image/png' }],
      }
    },
  })

  const toolMessage = observed[1]?.messages.find((message) => message.role === 'tool')
  assert.equal(toolMessage?.role, 'tool')
  if (toolMessage?.role === 'tool') {
    assert.deepEqual(toolMessage.images, [{ data: imageData, mimeType: 'image/png' }])
  }
  assert.equal(result.text, 'vision-consumed')
})

test('provider tool loop enforces executor timeout and caller cancellation', async () => {
  const timeout = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-timeout', markerTool.name, { marker: 'timeout' })),
    ]),
    toolTimeoutMs: 20,
    executeTool: async (_call, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(new Error('private abort detail')),
          { once: true },
        )
      }),
  })
  await assertToolLoopError(timeout, 'timeout')

  const controller = new AbortController()
  controller.abort()
  let adapterCalled = false
  const cancelled = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    signal: controller.signal,
    adapter: {
      async complete() {
        adapterCalled = true
        return finalTurn('must-not-run')
      },
    },
    async executeTool() {
      return { content: 'must-not-run' }
    },
  })
  await assertToolLoopError(cancelled, 'cancelled')
  assert.equal(adapterCalled, false)
})

test('provider tool loop rejects invalid definitions and sanitizes adapter errors', async () => {
  const invalidConfiguration = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool, markerTool],
    adapter: scriptedAdapter([finalTurn('unused')]),
    async executeTool() {
      return { content: 'unused' }
    },
  })
  await assertToolLoopError(invalidConfiguration, 'invalid_configuration')

  const providerFailure = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: {
      async complete() {
        throw new Error('private-provider-body')
      },
    },
    async executeTool() {
      return { content: 'unused' }
    },
  })
  const failure = await captureToolLoopError(providerFailure)
  assert.equal(failure.code, 'provider_request_failed')
  assert.equal(failure.message.includes('private-provider-body'), false)
})

test('provider tool loop executes serial-effect calls strictly in order (characterization)', async () => {
  const serialTool: ProviderToolDefinition = {
    ...markerTool,
    effect: serialCapabilityEffect('read-only'),
  }
  const events: string[] = []
  await runProviderToolLoop({
    messages: prompt,
    tools: [serialTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', serialTool.name, { marker: 'one' }),
        toolCall('call-2', serialTool.name, { marker: 'two' }),
      ]),
      finalTurn('done'),
    ]),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      await deferredTick()
      events.push(`settle:${call.id}`)
      return { content: `done:${call.id}` }
    },
  })

  assert.deepEqual(events, [
    'start:call-1',
    'settle:call-1',
    'start:call-2',
    'settle:call-2',
  ])
})

test('provider tool loop overlaps two eligible calls within one turn', async () => {
  const events: string[] = []
  const result = await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
      finalTurn('done'),
    ]),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      if (call.id === 'call-1') {
        await waitForCondition(() => events.includes('start:call-2'))
      }
      events.push(`settle:${call.id}`)
      return { content: `done:${call.id}` }
    },
  })

  assert.equal(result.text, 'done')
  assert.ok(
    events.indexOf('start:call-2') < events.indexOf('settle:call-1'),
    `eligible calls must overlap, observed: ${events.join(',')}`,
  )
})

test('provider tool loop emits tool messages in call order when a later eligible call settles first', async () => {
  const events: string[] = []
  const observed: Array<Parameters<ProviderToolLoopAdapter['complete']>[0]> = []
  await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
      finalTurn('done'),
    ], (request) => observed.push(request)),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      if (call.id === 'call-1') {
        await waitForCondition(() => events.includes('settle:call-2'))
      }
      events.push(`settle:${call.id}`)
      return { content: `done:${call.id}` }
    },
  })

  assert.ok(
    events.indexOf('start:call-2') < events.indexOf('settle:call-1'),
    `eligible calls must overlap, observed: ${events.join(',')}`,
  )
  const toolMessages = (observed[1]?.messages ?? []).filter(
    (message) => message.role === 'tool',
  )
  assert.deepEqual(
    toolMessages.map((message) =>
      message.role === 'tool' ? message.toolCallId : '',
    ),
    ['call-1', 'call-2'],
  )
})

test('provider tool loop bounds eligible concurrency to maxConcurrentToolCalls', async () => {
  const events: string[] = []
  await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    maxConcurrentToolCalls: 2,
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
        toolCall('call-3', markerTool.name, { marker: 'three' }),
      ]),
      finalTurn('done'),
    ]),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      if (call.id === 'call-1') {
        await waitForCondition(() => events.includes('start:call-2'))
      }
      await deferredTick()
      events.push(`settle:${call.id}`)
      return { content: `done:${call.id}` }
    },
  })

  assert.ok(
    events.indexOf('start:call-2') < events.indexOf('settle:call-1'),
    `a pool of two must run the first two calls concurrently, observed: ${events.join(',')}`,
  )
  const startOfThird = events.indexOf('start:call-3')
  const firstSettle = Math.min(
    events.indexOf('settle:call-1'),
    events.indexOf('settle:call-2'),
  )
  assert.ok(
    startOfThird > firstSettle,
    `the third call must wait for a pool slot, observed: ${events.join(',')}`,
  )
})

test('provider tool loop keeps an ineligible call as an order-preserving barrier', async () => {
  const serialTool: ProviderToolDefinition = {
    ...markerTool,
    name: 'serial_barrier_tool',
    effect: serialCapabilityEffect('mutating'),
  }
  const events: string[] = []
  await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool, serialTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-a', markerTool.name, { marker: 'a' }),
        toolCall('call-b', serialTool.name, { marker: 'b' }),
        toolCall('call-c', markerTool.name, { marker: 'c' }),
      ]),
      finalTurn('done'),
    ]),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      await deferredTick()
      events.push(`settle:${call.id}`)
      return { content: `done:${call.id}` }
    },
  })

  assert.ok(
    events.indexOf('start:call-b') > events.indexOf('settle:call-a'),
    `the ineligible call must wait for prior eligible calls, observed: ${events.join(',')}`,
  )
  assert.ok(
    events.indexOf('start:call-c') > events.indexOf('settle:call-b'),
    `later eligible calls must wait for the ineligible call, observed: ${events.join(',')}`,
  )
})

test('provider tool loop produces today result shape for a validating all-ineligible turn', async () => {
  const serialTool: ProviderToolDefinition = {
    ...markerTool,
    effect: serialCapabilityEffect('read-only'),
  }
  const observed: Array<Parameters<ProviderToolLoopAdapter['complete']>[0]> = []
  const result = await runProviderToolLoop({
    messages: prompt,
    tools: [serialTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', serialTool.name, { marker: 'one' }),
        toolCall('call-2', serialTool.name, { marker: 'two' }),
      ]),
      finalTurn('done'),
    ], (request) => observed.push(request)),
    async executeTool(call) {
      return { content: `done:${call.id}` }
    },
  })

  assert.equal(result.text, 'done')
  assert.equal(result.toolCallCount, 2)
  assert.equal(result.executedToolCallCount, 2)
  assert.equal(result.cachedToolCallCount, 0)
  const toolMessages = (observed[1]?.messages ?? []).filter(
    (message) => message.role === 'tool',
  )
  assert.deepEqual(
    toolMessages.map((message) =>
      message.role === 'tool' ? message.content : '',
    ),
    ['done:call-1', 'done:call-2'],
  )
})

test('provider tool loop never overlaps calls whose parallel-safe effect was injected structurally', async () => {
  const structuralTool: ProviderToolDefinition = {
    name: 'structural_parallel_tool',
    description: 'Structurally injected parallel-safe effect.',
    effect: { kind: 'read-only', concurrency: 'parallel-safe' },
    inputSchema: {
      properties: { marker: { type: 'string' } },
      required: ['marker'],
      additionalProperties: false,
    },
  }
  const events: string[] = []
  await runProviderToolLoop({
    messages: prompt,
    tools: [structuralTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', structuralTool.name, { marker: 'one' }),
        toolCall('call-2', structuralTool.name, { marker: 'two' }),
      ]),
      finalTurn('done'),
    ]),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      await deferredTick()
      events.push(`settle:${call.id}`)
      return { content: `done:${call.id}` }
    },
  })

  assert.ok(
    events.indexOf('start:call-2') > events.indexOf('settle:call-1'),
    `downgraded effects must stay strictly sequential, observed: ${events.join(',')}`,
  )
})

test('provider tool loop reports the lowest-index failure among overlapping eligible calls', async () => {
  const executed: string[] = []
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
    ]),
    async executeTool(call) {
      executed.push(call.id)
      if (call.id === 'call-1') {
        return { content: 'x'.repeat(16) }
      }
      throw new Error('private failure')
    },
    maxToolResultBytes: 8,
  })

  const error = await captureToolLoopError(promise)
  assert.equal(error.code, 'tool_result_too_large')
  assert.deepEqual(executed, ['call-1', 'call-2'])
})

test('provider tool loop waits for an in-flight sibling and reports the surviving failure when a later call fails first', async () => {
  const events: string[] = []
  const releaseFirstCall = deferred<void>()
  const firstCallRejected = deferred<void>()
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
    ]),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      if (call.id === 'call-1') {
        await waitForCondition(() => events.includes('fail:call-2'))
        events.push(`settle:${call.id}`)
        releaseFirstCall.resolve()
        try {
          throw new Error('private late failure')
        } finally {
          firstCallRejected.resolve()
        }
      }
      events.push(`fail:${call.id}`)
      return { content: 'x'.repeat(16) }
    },
    maxToolResultBytes: 8,
  })

  const error = await captureToolLoopError(promise)
  assert.equal(error.code, 'tool_result_too_large')
  await firstCallRejected.promise
  void releaseFirstCall
  assert.ok(
    events.indexOf('start:call-2') < events.indexOf('settle:call-1'),
    `the later call must fail while the earlier call is in flight, observed: ${events.join(',')}`,
  )
  assert.ok(
    events.includes('settle:call-1'),
    'the loop must observe the in-flight sibling outcome before throwing',
  )
})

test('provider tool loop aborts an in-flight sibling on its own executor signal after another eligible call fails', async () => {
  const events: string[] = []
  const siblingObservedAbort = deferred<boolean>()
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
    ]),
    async executeTool(call, context) {
      events.push(`start:${call.id}`)
      if (call.id === 'call-1') {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        siblingObservedAbort.resolve(context.signal.aborted === true)
        events.push(`abort-observed:${call.id}`)
        throw new Error('aborted sibling settlement')
      }
      events.push(`fail:${call.id}`)
      return { content: 'x'.repeat(16) }
    },
    maxToolResultBytes: 8,
  })

  const error = await captureToolLoopError(promise)
  assert.equal(error.code, 'tool_result_too_large')
  assert.equal(
    await Promise.race([
      siblingObservedAbort.promise.then(() => true),
      deferredTick().then(deferredTick).then(() => false),
    ]),
    true,
    'the sibling abort must be delivered before the loop rejects',
  )
  assert.ok(events.includes('abort-observed:call-1'))
})

test('provider tool loop observes a sibling rejection that lands after the elected failure', async () => {
  const events: string[] = []
  const lateSiblingSettled = deferred<void>()
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
    ]),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      if (call.id === 'call-2') {
        try {
          await new Promise<void>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error('private late sibling rejection')),
              30,
            )
          })
        } finally {
          events.push('late-sibling-settled')
          lateSiblingSettled.resolve()
        }
      }
      return { content: 'x'.repeat(16) }
    },
    maxToolResultBytes: 8,
  })

  const error = await captureToolLoopError(promise)
  assert.equal(error.code, 'tool_result_too_large')
  await lateSiblingSettled.promise
  assert.ok(events.includes('late-sibling-settled'))
  assert.ok(events.includes('start:call-2'))
})

test('provider tool loop settles every eligible call as cancelled when the loop aborts during fan-out', async () => {
  const controller = new AbortController()
  const events: string[] = []
  const secondCallStarted = deferred<void>()
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    signal: controller.signal,
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
    ]),
    async executeTool(call, context) {
      events.push(`start:${call.id}`)
      if (call.id === 'call-1') {
        await secondCallStarted.promise
      } else {
        secondCallStarted.resolve()
      }
      controller.abort()
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          resolve()
          return
        }
        context.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      events.push(`abort-observed:${call.id}`)
      return { content: 'settled-after-abort' }
    },
  })

  await assertToolLoopError(promise, 'cancelled')
  for (const id of ['call-1', 'call-2']) {
    assert.ok(events.includes(`start:${id}`), `${id} must have started`)
    assert.ok(
      events.includes(`abort-observed:${id}`),
      `${id} must have observed cancellation, observed: ${events.join(',')}`,
    )
  }
})

test('provider tool loop rejects invalid maxConcurrentToolCalls options', async () => {
  for (const invalid of [0, -1, 1.5, MAX_CONCURRENT_TOOL_CALLS_CEILING + 1]) {
    const promise = runProviderToolLoop({
      messages: prompt,
      tools: [markerTool],
      maxConcurrentToolCalls: invalid,
      adapter: scriptedAdapter([finalTurn('unused')]),
      async executeTool() {
        return { content: 'unused' }
      },
    })
    await assertToolLoopError(promise, 'invalid_configuration')
  }
})

test('provider tool loop keeps its pool ceiling below the dispatch admission bound', async () => {
  // A turn's calls share one capability scope key, and admission refuses at
  // `activeLeaders >= maxActivePerScope` with the smallest production bound of
  // 8 (`team-runtime/index.ts`). A pool that could reach 8 would let a
  // saturated fan-out be the reason a dispatch on its own scope is refused.
  assert.ok(
    MAX_CONCURRENT_TOOL_CALLS_CEILING < 8,
    `pool ceiling ${MAX_CONCURRENT_TOOL_CALLS_CEILING} must leave admission headroom`,
  )
  const result = await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    maxConcurrentToolCalls: MAX_CONCURRENT_TOOL_CALLS_CEILING,
    adapter: scriptedAdapter([finalTurn('ceiling accepted')]),
    async executeTool() {
      return { content: 'unused' }
    },
  })
  assert.equal(result.text, 'ceiling accepted')
})

test('provider tool loop hoists argument validation before any executor starts', async () => {
  const executed: string[] = []
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { notMarker: 'oops' }),
      ]),
    ]),
    async executeTool(call) {
      executed.push(call.id)
      return { content: `done:${call.id}` }
    },
  })

  await assertToolLoopError(promise, 'invalid_tool_call')
  assert.deepEqual(executed, [])
})

test('provider tool loop hoists tool resolution before any executor starts', async () => {
  const executed: string[] = []
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', 'unknown_tool', { marker: 'two' }),
      ]),
    ]),
    async executeTool(call) {
      executed.push(call.id)
      return { content: `done:${call.id}` }
    },
  })

  await assertToolLoopError(promise, 'tool_not_found')
  assert.deepEqual(executed, [])
})

test('provider tool loop surfaces a hoisted validation error over an earlier execution timeout', async () => {
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { notMarker: 'oops' }),
      ]),
    ]),
    toolTimeoutMs: 20,
    executeTool: async (_call, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(new Error('timed out')),
          { once: true },
        )
      }),
  })

  const error = await captureToolLoopError(promise)
  assert.equal(error.code, 'invalid_tool_call')
  assert.equal(error.retryable, false)
})

test('provider tool loop keeps a cached ineligible call as a barrier', async () => {
  const serialTool: ProviderToolDefinition = {
    ...markerTool,
    name: 'serial_cached_tool',
    effect: serialCapabilityEffect('read-only'),
  }
  const observed: Array<Parameters<ProviderToolLoopAdapter['complete']>[0]> = []
  let executionCount = 0
  const result = await runProviderToolLoop({
    messages: prompt,
    tools: [serialTool, markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-1', serialTool.name, { marker: 'one' })),
      multiCallTurn([
        toolCall('call-1', serialTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
      finalTurn('done'),
    ], (request) => observed.push(request)),
    async executeTool(call) {
      executionCount += 1
      return { content: `done:${call.id}` }
    },
  })

  assert.equal(result.text, 'done')
  assert.equal(executionCount, 2)
  assert.equal(result.cachedToolCallCount, 1)
  const toolMessages = (observed[2]?.messages ?? [])
    .filter((message) => message.role === 'tool')
    .slice(-2)
  assert.deepEqual(
    toolMessages.map((message) =>
      message.role === 'tool' ? message.toolCallId : '',
    ),
    ['call-1', 'call-2'],
  )
})

test('provider tool loop does not re-execute a cached eligible call and keeps pool ordering for fresh calls', async () => {
  const events: string[] = []
  let executionCount = 0
  await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    maxConcurrentToolCalls: 1,
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-1', markerTool.name, { marker: 'one' })),
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
        toolCall('call-3', markerTool.name, { marker: 'three' }),
      ]),
      finalTurn('done'),
    ]),
    async executeTool(call) {
      executionCount += 1
      events.push(`start:${call.id}`)
      await deferredTick()
      events.push(`settle:${call.id}`)
      return { content: `done:${call.id}` }
    },
  })

  assert.equal(executionCount, 3)
  assert.ok(
    events.indexOf('start:call-2') > events.indexOf('settle:call-1') ||
      !events.includes('settle:call-1'),
    'the cached call must not occupy the single pool slot',
  )
  assert.ok(
    events.indexOf('start:call-3') > events.indexOf('settle:call-2'),
    `a pool of one must serialize fresh calls, observed: ${events.join(',')}`,
  )
})

test('provider tool loop rejects a changed fingerprint at execution time without hoisting the cache check', async () => {
  const executed: string[] = []
  const promise = runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-1', markerTool.name, { marker: 'one' })),
      multiCallTurn([
        toolCall('call-2', markerTool.name, { marker: 'two' }),
        toolCall('call-1', markerTool.name, { marker: 'changed' }),
      ]),
    ]),
    async executeTool(call) {
      executed.push(call.id)
      return { content: `done:${call.id}` }
    },
  })

  await assertToolLoopError(promise, 'invalid_tool_call')
  assert.deepEqual(executed, ['call-1', 'call-2'])
})

test('provider tool loop handles degenerate eligible segment shapes unchanged', async () => {
  const observed: Array<Parameters<ProviderToolLoopAdapter['complete']>[0]> = []
  const single = await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: scriptedAdapter([
      toolTurn(toolCall('call-1', markerTool.name, { marker: 'one' })),
      finalTurn('done-single'),
    ], (request) => observed.push(request)),
    async executeTool(call) {
      return { content: `done:${call.id}` }
    },
  })

  assert.equal(single.text, 'done-single')
  assert.equal(single.executedToolCallCount, 1)
  assert.equal(single.cachedToolCallCount, 0)

  const observedPair: Array<Parameters<ProviderToolLoopAdapter['complete']>[0]> = []
  const pair = await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    maxConcurrentToolCalls: 4,
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
      finalTurn('done-pair'),
    ], (request) => observedPair.push(request)),
    async executeTool(call) {
      return { content: `done:${call.id}` }
    },
  })

  assert.equal(pair.text, 'done-pair')
  assert.equal(pair.executedToolCallCount, 2)
  assert.equal(pair.cachedToolCallCount, 0)
  const toolMessages = (observedPair[1]?.messages ?? []).filter(
    (message) => message.role === 'tool',
  )
  assert.deepEqual(
    toolMessages.map((message) =>
      message.role === 'tool' ? message.toolCallId : '',
    ),
    ['call-1', 'call-2'],
  )
})

test('provider tool loop at maxConcurrentToolCalls one reproduces sequential execution exactly', async () => {
  const events: string[] = []
  await runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    maxConcurrentToolCalls: 1,
    adapter: scriptedAdapter([
      multiCallTurn([
        toolCall('call-1', markerTool.name, { marker: 'one' }),
        toolCall('call-2', markerTool.name, { marker: 'two' }),
      ]),
      finalTurn('done'),
    ]),
    async executeTool(call) {
      events.push(`start:${call.id}`)
      await deferredTick()
      events.push(`settle:${call.id}`)
      return { content: `done:${call.id}` }
    },
  })

  assert.deepEqual(events, [
    'start:call-1',
    'settle:call-1',
    'start:call-2',
    'settle:call-2',
  ])
})

function scriptedAdapter(
  turns: readonly ProviderToolAssistantTurn[],
  observe?: (
    request: Parameters<ProviderToolLoopAdapter['complete']>[0],
    index: number,
  ) => void,
): ProviderToolLoopAdapter {
  let index = 0
  return {
    async complete(request) {
      observe?.(request, index)
      const turn = turns[index]
      index += 1
      if (!turn) throw new Error('Scripted adapter exhausted')
      return turn
    },
  }
}

function multiCallTurn(
  calls: readonly ProviderToolCall[],
): ProviderToolAssistantTurn {
  return { content: null, toolCalls: [...calls] }
}

function deferredTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await deferredTick()
  }
  return condition()
}

function toolCall(
  id: string,
  name: string,
  argumentsValue: ProviderToolCall['arguments'],
): ProviderToolCall {
  return { id, name, arguments: argumentsValue }
}

function toolTurn(
  call: ProviderToolCall,
  usageTokens = 0,
): ProviderToolAssistantTurn {
  return {
    content: null,
    toolCalls: [call],
    usage: {
      inputTokens: usageTokens,
      outputTokens: usageTokens,
      totalTokens: usageTokens * 2,
    },
  }
}

function finalTurn(
  content: string,
  usageTokens = 0,
): ProviderToolAssistantTurn {
  return {
    content,
    toolCalls: [],
    usage: {
      inputTokens: usageTokens,
      outputTokens: usageTokens,
      totalTokens: usageTokens * 2,
    },
  }
}

async function assertToolLoopError(
  promise: Promise<unknown>,
  code: ProviderToolLoopError['code'],
): Promise<void> {
  const error = await captureToolLoopError(promise)
  assert.equal(error.code, code)
}

async function captureToolLoopError(
  promise: Promise<unknown>,
): Promise<ProviderToolLoopError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ProviderToolLoopError)
    return error
  }
  assert.fail('Expected provider tool loop to reject')
}


test('the chat-completions tool adapter refuses a response truncated at the token limit', async () => {
  // The MCP native tool-loop mode does not call providers/<name>.ts at all — it
  // is a separate HTTP client. Truncation detection added to the provider
  // adapters therefore never runs here, so the same defect has to be closed on
  // this path too or a truncated worker turn is silently accepted.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'fixture/tool-loop',
    choices: [{
      finish_reason: 'length',
      message: { role: 'assistant', content: 'A partial ans' },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  try {
    const adapter = createOpenAIChatCompletionsToolAdapter({
      apiUrl: 'https://provider.invalid/v1/chat/completions',
      model: 'fixture/tool-loop',
      apiKey: 'test-key',
    })
    await assert.rejects(
      adapter.complete({
        messages: [{ role: 'user', content: 'Write it.' }],
        tools: [],
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderToolLoopError)
        assert.equal(error.code, 'provider_truncated')
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the adapter reports only a round that made no tool calls', async () => {
  const originalFetch = globalThis.fetch
  const reported: string[] = []
  let call = 0
  globalThis.fetch = async () => {
    call += 1
    // Round 1 asks for a tool AND emits reasoning-ish prose. That prose is not
    // the answer, so it must never reach a display channel.
    const payload = call === 1
      ? {
          model: 'fixture/tool-loop',
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Let me look that up first.',
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              }],
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
      : {
          model: 'fixture/tool-loop',
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'The final answer.' },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const adapter = createOpenAIChatCompletionsToolAdapter({
      apiUrl: 'https://provider.invalid/v1/chat/completions',
      model: 'fixture/tool-loop',
      apiKey: 'test-key',
      onFinalRoundText: (text) => reported.push(text),
    })

    await adapter.complete({
      messages: [{ role: 'user', content: 'Look it up.' }],
      tools: [{ name: 'lookup', inputSchema: { type: 'object' }, effect: { kind: 'read-only', concurrency: 'parallel-safe' } }],
      signal: new AbortController().signal,
    })
    await adapter.complete({
      messages: [{ role: 'user', content: 'Look it up.' }],
      tools: [{ name: 'lookup', inputSchema: { type: 'object' }, effect: { kind: 'read-only', concurrency: 'parallel-safe' } }],
      signal: new AbortController().signal,
    })

    assert.deepEqual(
      reported,
      ['The final answer.'],
      'intermediate tool-round prose is suppressed; only the answer is reported',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// The streamed, tool-free final request (streaming/DESIGN.md R4, R5, R9, R10).
// Each test drives the real adapter through the real loop and reads the
// requests at the HTTP boundary.

const FIXTURE_URL = 'https://provider.invalid/v1/chat/completions'
const FIXTURE_MODEL = 'fixture/tool-loop'

interface CapturedProviderRequest {
  readonly body: Record<string, unknown>
  readonly headers: Record<string, string>
}

async function withScriptedFetch(
  responses: readonly (() => Response)[],
  run: (requests: readonly CapturedProviderRequest[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  const requests: CapturedProviderRequest[] = []
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const encoded = typeof init?.body === 'string' ? init.body : '{}'
    const parsed: unknown = JSON.parse(encoded)
    requests.push({
      body: isPlainRecord(parsed) ? parsed : {},
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    const respond = responses[requests.length - 1]
    if (!respond) throw new Error(`No scripted response for request ${requests.length}`)
    return respond()
  }
  try {
    await run(requests)
  } finally {
    globalThis.fetch = originalFetch
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonCompletion(
  message: Readonly<Record<string, unknown>>,
  usageTokens = 1,
): Response {
  return new Response(JSON.stringify({
    model: FIXTURE_MODEL,
    choices: [{
      finish_reason: Array.isArray(message.tool_calls) ? 'tool_calls' : 'stop',
      message: { role: 'assistant', ...message },
    }],
    usage: {
      prompt_tokens: usageTokens,
      completion_tokens: usageTokens,
      total_tokens: usageTokens * 2,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function markerCallMessage(id: string, marker: string): Record<string, unknown> {
  return {
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name: markerTool.name, arguments: JSON.stringify({ marker }) },
    }],
  }
}

function sseResponse(frames: readonly Readonly<Record<string, unknown>>[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function streamChunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null = null,
  usageTokens?: number,
): Record<string, unknown> {
  return {
    model: FIXTURE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usageTokens === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: usageTokens,
            completion_tokens: usageTokens,
            total_tokens: usageTokens * 2,
          },
        }),
  }
}

function requestShape(request: CapturedProviderRequest): readonly unknown[] {
  return [request.body.tool_choice, request.body.stream]
}

test('with a live observer the answer streams from a tool-free final request sent as the answering round was', async () => {
  const deltas: string[] = []
  const answers: string[] = []
  await withScriptedFetch([
    () => jsonCompletion(markerCallMessage('call-1', 'alpha'), 1),
    () => jsonCompletion({ content: 'DRAFT from the tool-capable round.' }, 2),
    () => sseResponse([
      streamChunk({ content: 'The marker ' }),
      streamChunk({ content: 'is alpha.' }),
      streamChunk({}, 'stop', 3),
    ]),
  ], async (requests) => {
    const result = await runProviderToolLoop({
      messages: prompt,
      tools: [markerTool],
      adapter: createOpenAIChatCompletionsToolAdapter({
        apiUrl: FIXTURE_URL,
        model: FIXTURE_MODEL,
        apiKey: 'test-key',
        headers: { 'x-fixture': 'kept' },
        modelParameters: { temperature: 0.2 },
        reasoningEffort: 'high',
        onFinalTextDelta: (text) => deltas.push(text),
        onFinalRoundText: (text) => answers.push(text),
      }),
      executeTool: async () => ({ content: 'echo-marker:alpha' }),
    })

    assert.deepEqual(deltas, ['The marker ', 'is alpha.'], 'the answer arrives piece by piece')
    assert.deepEqual(answers, ['The marker is alpha.'], 'the whole answer is reported once, and the draft never')
    assert.equal(result.text, 'The marker is alpha.')
    assert.equal(result.rounds, 3, 'the final request is a provider round')
    assert.deepEqual(result.usage, { inputTokens: 6, outputTokens: 6, totalTokens: 12 })

    const [, answering, final] = requests
    assert.ok(answering && final)
    assert.deepEqual(
      [answering.body.reasoning_effort, answering.body.temperature],
      ['high', 0.2],
    )
    assert.deepEqual(
      final.body,
      {
        ...answering.body,
        tool_choice: 'none',
        stream: true,
        stream_options: { include_usage: true },
      },
      'the final request is the answering round\'s request, with tools forbidden and streaming on',
    )
    assert.deepEqual(final.headers, answering.headers)
  })
})

test('without a live observer every round is one buffered request and the answering round is the answer', async () => {
  const answers: string[] = []
  await withScriptedFetch([
    () => jsonCompletion(markerCallMessage('call-1', 'alpha')),
    () => jsonCompletion({ content: 'The marker is alpha.' }),
  ], async (requests) => {
    const result = await runProviderToolLoop({
      messages: prompt,
      tools: [markerTool],
      adapter: createOpenAIChatCompletionsToolAdapter({
        apiUrl: FIXTURE_URL,
        model: FIXTURE_MODEL,
        apiKey: 'test-key',
        onFinalRoundText: (text) => answers.push(text),
      }),
      executeTool: async () => ({ content: 'echo-marker:alpha' }),
    })

    assert.deepEqual(requests.map(requestShape), [['auto', false], ['auto', false]])
    assert.equal(result.text, 'The marker is alpha.')
    assert.equal(result.rounds, 2)
    assert.deepEqual(answers, ['The marker is alpha.'])
  })
})

test('with a live observer the last slot of maxRounds is the final request, even when every round calls a tool', async () => {
  await withScriptedFetch([
    () => jsonCompletion(markerCallMessage('call-1', 'one')),
    () => jsonCompletion(markerCallMessage('call-2', 'two')),
    () => sseResponse([streamChunk({ content: 'Two markers.' }), streamChunk({}, 'stop')]),
  ], async (requests) => {
    const result = await runProviderToolLoop({
      messages: prompt,
      tools: [markerTool],
      adapter: createOpenAIChatCompletionsToolAdapter({
        apiUrl: FIXTURE_URL,
        model: FIXTURE_MODEL,
        apiKey: 'test-key',
        onFinalTextDelta: () => undefined,
      }),
      maxRounds: 3,
      executeTool: async (call) => ({ content: `echo:${String(call.arguments.marker)}` }),
    })

    assert.deepEqual(
      requests.map(requestShape),
      [['auto', false], ['auto', false], ['none', true]],
      'two tool-capable rounds, then the final request in the reserved third slot',
    )
    assert.equal(result.rounds, 3)
    assert.equal(result.text, 'Two markers.')
  })
})

test('a final request answered with tool calls fails the turn and runs none of them', async () => {
  const answers: string[] = []
  const executed: string[] = []
  await withScriptedFetch([
    () => jsonCompletion({ content: 'I can answer now.' }),
    // Content first, then a tool call, under `finish_reason: "stop"`: the
    // call is recognised from its chunks, not from the finish reason.
    () => sseResponse([
      streamChunk({ content: 'Let me check first.' }),
      streamChunk({
        tool_calls: [{
          index: 0,
          id: 'call-late',
          type: 'function',
          function: { name: markerTool.name, arguments: '{"marker":"late"}' },
        }],
      }),
      streamChunk({}, 'stop'),
    ]),
  ], async () => {
    await assertToolLoopError(runProviderToolLoop({
      messages: prompt,
      tools: [markerTool],
      adapter: createOpenAIChatCompletionsToolAdapter({
        apiUrl: FIXTURE_URL,
        model: FIXTURE_MODEL,
        apiKey: 'test-key',
        onFinalTextDelta: () => undefined,
        onFinalRoundText: (text) => answers.push(text),
      }),
      executeTool: async (call) => {
        executed.push(call.id)
        return { content: 'must-not-run' }
      },
    }), 'invalid_provider_response')
  })
  assert.deepEqual(answers, [], 'no answer is reported')
  assert.deepEqual(executed, [], 'no tool runs after text that may already be on screen')

  // The loop holds the same line for any adapter's final request. The reply
  // carries an answer beside its call, so only the tool-call check can refuse
  // it: without that check the turn would complete with this text.
  const loopExecuted: string[] = []
  await assertToolLoopError(runProviderToolLoop({
    messages: prompt,
    tools: [markerTool],
    adapter: {
      complete: async () => finalTurn('I can answer now.'),
      completeFinal: async () => ({
        content: 'The marker is late.',
        toolCalls: [toolCall('call-late', markerTool.name, { marker: 'late' })],
      }),
    },
    executeTool: async (call) => {
      loopExecuted.push(call.id)
      return { content: 'must-not-run' }
    },
  }), 'invalid_provider_response')
  assert.deepEqual(loopExecuted, [])
})

test('the response bound covers the whole streamed final answer, not each frame', async () => {
  const answers: string[] = []
  const frame = 'x'.repeat(100)
  await withScriptedFetch([
    // 64 frames of 100 characters each: every frame is far under the bound,
    // together they are well over it.
    () => sseResponse([
      ...Array.from({ length: 64 }, () => streamChunk({ content: frame })),
      streamChunk({}, 'stop'),
    ]),
  ], async () => {
    const adapter = createOpenAIChatCompletionsToolAdapter({
      apiUrl: FIXTURE_URL,
      model: FIXTURE_MODEL,
      apiKey: 'test-key',
      maxResponseBytes: 4_096,
      onFinalTextDelta: () => undefined,
      onFinalRoundText: (text) => answers.push(text),
    })
    assert.ok(adapter.completeFinal, 'a live observer adds the final request')
    await assertToolLoopError(adapter.completeFinal({
      messages: prompt,
      tools: [markerTool],
      signal: new AbortController().signal,
    }), 'response_too_large')
  })
  assert.deepEqual(answers, [], 'no part of the oversize answer is reported as the answer')
})

test('a streamed final answer that stops at its token limit is a truncation, and no whole answer is reported', async () => {
  const deltas: string[] = []
  const answers: string[] = []
  await withScriptedFetch([
    () => sseResponse([
      streamChunk({ content: 'The answer ' }),
      streamChunk({ content: 'beg' }),
      streamChunk({}, 'length'),
    ]),
  ], async () => {
    const adapter = createOpenAIChatCompletionsToolAdapter({
      apiUrl: FIXTURE_URL,
      model: FIXTURE_MODEL,
      apiKey: 'test-key',
      onFinalTextDelta: (text) => deltas.push(text),
      onFinalRoundText: (text) => answers.push(text),
    })
    assert.ok(adapter.completeFinal, 'a live observer adds the final request')
    await assertToolLoopError(adapter.completeFinal({
      messages: prompt,
      tools: [markerTool],
      signal: new AbortController().signal,
    }), 'provider_truncated')
  })
  assert.deepEqual(deltas, ['The answer ', 'beg'], 'the partial answer was shown as it arrived')
  assert.deepEqual(answers, [], 'a truncated answer is never reported as the whole answer')
})
