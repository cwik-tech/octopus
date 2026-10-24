import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defineTool,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type { CapabilityExecutionContext } from '../../contracts/capability-dispatch.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { BudgetLedger } from '../../core/budget-ledger.js'
import { TeamRuntimeCapabilityBudgetPort } from '../../team-runtime/capability-budget-port.js'
import {
  createDefaultTeamRuntimeToolAdapterFactory,
  governTeamRuntimeTool,
} from '../../team-runtime/capability-tool-adapter.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const EXECUTION_CONTEXT: CapabilityExecutionContext = {
  contractVersion: 1,
  requestId: 'request-team-tool-1',
  sessionId: 'session-team-tool-1',
  runId: 'run-team-tool-1',
  assignmentId: 'assignment-team-tool-1',
  taskId: 'task-team-tool-1',
  agentPath: 'agents/coordinator',
  authority: {
    kind: 'runtime-assignment',
    processIdentity: 'process-team-tool-1',
  },
}

const MODEL_SOURCE = {
  kind: 'pi-host' as const,
  id: 'team-runtime:pi-model',
  version: '1',
}

const RUNTIME_SOURCE = {
  kind: 'engine' as const,
  id: 'team-runtime:runtime-autostart',
  version: '1',
}

test('governed Team Runtime tools revalidate Pi-mutated arguments before raw execute', async () => {
  let rawExecuteCalls = 0
  const rawTool = defineTool({
    name: 'echo_value',
    label: 'Echo value',
    description: 'Echoes one value.',
    parameters: Type.Object({
      value: Type.String(),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      rawExecuteCalls += 1
      return {
        content: [{ type: 'text' as const, text: params.value }],
        details: { echoed: params.value },
      }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => EXECUTION_CONTEXT,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.tool.echo-value',
      effect: serialCapabilityEffect('read-only'),
      risk: 'read-only',
    }),
  })

  await assert.rejects(
    governed.invoke({
      channel: 'model',
      toolCallId: 'tool-call-mutated-1',
      input: { value: 42 },
      extensionContext: emptyExtensionContext(),
    }),
    (error: unknown) => isDispatchError(error, 'invalid_tool_arguments'),
  )
  assert.equal(rawExecuteCalls, 0)
})

test('governed Team Runtime tools preserve the exact successful Pi tool result', async () => {
  const expected = {
    content: [{ type: 'text' as const, text: 'alpha' }],
    details: { echoed: 'alpha', receipt: 'receipt-1' },
  }
  const rawTool = defineTool({
    name: 'echo_value',
    label: 'Echo value',
    description: 'Echoes one value.',
    parameters: Type.Object({ value: Type.String() }),
    async execute() {
      return expected
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => EXECUTION_CONTEXT,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.tool.echo-value',
      effect: serialCapabilityEffect('read-only'),
      risk: 'read-only',
    }),
  })

  const result = await governed.invoke({
    channel: 'runtime',
    toolCallId: 'tool-call-preserve-1',
    input: { value: 'alpha' },
    extensionContext: emptyExtensionContext(),
  })

  assert.equal(result, expected)
})

test('governed result retention cannot collide across dispatch scope identities', async () => {
  let activeContext = EXECUTION_CONTEXT
  const rawTool = defineTool({
    name: 'scoped_echo',
    label: 'Scoped echo',
    description: 'Echoes one scoped value.',
    parameters: Type.Object({ value: Type.String() }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text' as const, text: params.value }],
        details: { echoed: params.value },
      }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => activeContext,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.tool.scoped-echo',
      effect: serialCapabilityEffect('read-only'),
      risk: 'read-only',
    }),
  })
  const sharedInvocation = {
    channel: 'model' as const,
    toolCallId: 'same-call-id',
    extensionContext: emptyExtensionContext(),
  }

  activeContext = { ...EXECUTION_CONTEXT, agentPath: 'agents/alpha' }
  const alpha = await governed.invoke({
    ...sharedInvocation,
    input: { value: 'alpha' },
  })
  activeContext = { ...EXECUTION_CONTEXT, agentPath: 'agents/beta' }
  const beta = await governed.invoke({
    ...sharedInvocation,
    input: { value: 'beta' },
  })
  activeContext = { ...EXECUTION_CONTEXT, agentPath: 'agents/alpha' }
  const replayedAlpha = await governed.invoke({
    ...sharedInvocation,
    input: { value: 'alpha' },
  })

  assert.equal(alpha.content[0]?.type, 'text')
  assert.equal(beta.content[0]?.type, 'text')
  assert.equal(replayedAlpha, alpha)
})

test('governed result retention remains aligned with dispatcher replay retention', async () => {
  let rawExecuteCalls = 0
  const rawTool = defineTool({
    name: 'retained_echo',
    label: 'Retained echo',
    description: 'Echoes a retained value.',
    parameters: Type.Object({ value: Type.String() }),
    async execute(_toolCallId, params) {
      rawExecuteCalls += 1
      return {
        content: [{ type: 'text' as const, text: params.value }],
        details: { echoed: params.value },
      }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher([], {
      bindings: new CapabilityInvocationBindings({
        maxActivePerScope: 8,
        maxRetainedPerScope: 256,
      }),
    }),
    getContext: () => EXECUTION_CONTEXT,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.tool.retained-echo',
      effect: serialCapabilityEffect('read-only'),
      risk: 'read-only',
    }),
  })

  let firstResult: Awaited<ReturnType<typeof governed.invoke>> | undefined
  for (let index = 0; index < 129; index += 1) {
    const result = await governed.invoke({
      channel: 'model',
      toolCallId: `retained-call-${index}`,
      input: { value: `value-${index}` },
      extensionContext: emptyExtensionContext(),
    })
    if (index === 0) firstResult = result
  }
  const replayed = await governed.invoke({
    channel: 'model',
    toolCallId: 'retained-call-0',
    input: { value: 'value-0' },
    extensionContext: emptyExtensionContext(),
  })

  assert.equal(replayed, firstResult)
  assert.equal(rawExecuteCalls, 129)
})

test('governed result replay survives wrapper recreation for the same dispatcher', async () => {
  let rawExecuteCalls = 0
  const expected = {
    content: [{ type: 'text' as const, text: 'retained across registration' }],
    details: { generation: 1 },
  }
  const rawTool = defineTool({
    name: 'recreated_echo',
    label: 'Recreated echo',
    description: 'Returns one retained result.',
    parameters: Type.Object({ value: Type.String() }),
    async execute() {
      rawExecuteCalls += 1
      return expected
    },
  })
  const dispatcher = createCapabilityTestDispatcher()
  const makeGoverned = () => governTeamRuntimeTool({
    tool: rawTool,
    dispatcher,
    getContext: () => EXECUTION_CONTEXT,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.tool.recreated-echo',
      effect: serialCapabilityEffect('read-only'),
      risk: 'read-only',
    }),
  })
  const invocation = {
    channel: 'model' as const,
    toolCallId: 'recreated-echo-call',
    input: { value: 'same' },
    extensionContext: emptyExtensionContext(),
  }

  const original = await makeGoverned().invoke(invocation)
  const replayed = await makeGoverned().invoke(invocation)

  assert.equal(original, expected)
  assert.equal(replayed, expected)
  assert.equal(rawExecuteCalls, 1)
})

test('governed raw execute adopts only its dispatcher-owned budget scope', async () => {
  const budget = new TeamRuntimeCapabilityBudgetPort({
    ledger: new BudgetLedger({ capUsd: 10, policy: 'halt' }),
    readTotalCostUsd: () => 2,
    isMetered: () => true,
  })
  const rawTool = defineTool({
    name: 'budget_adoption',
    label: 'Budget adoption',
    description: 'Adopts the active dispatch budget.',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      return {
        content: [{ type: 'text' as const, text: 'adopted' }],
        details: budget.adopt(toolCallId),
      }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher([], { budget }),
    budgetAdoptionScope: budget,
    getContext: () => EXECUTION_CONTEXT,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.engine.budget-adoption',
      effect: serialCapabilityEffect('mutating'),
      risk: 'delegation',
    }),
  })

  const result = await governed.invoke({
    channel: 'model',
    toolCallId: 'budget-adoption-call',
    input: {},
    extensionContext: emptyExtensionContext(),
  })

  assert.equal(result.details?.remainingBudget, 8)
  assert.equal(typeof result.details?.runChildDispatch, 'function')
})

test('model tool calls preserve the exact Pi execution context', async () => {
  const expectedContext = {
    ...emptyExtensionContext(),
    tools: [],
    executeTool: async () => { throw new Error('This probe must not call another tool.') },
  }
  let receivedContext: unknown
  const governed = governTeamRuntimeTool({
    tool: defineTool({
      name: 'model_context_probe',
      label: 'Model context probe',
      description: 'Observes the Pi context received by a governed tool.',
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, context) {
        receivedContext = context
        return { content: [{ type: 'text' as const, text: 'preserved' }], details: {} }
      },
    }),
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => EXECUTION_CONTEXT,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.tool.model-context-probe',
      effect: serialCapabilityEffect('read-only'),
      risk: 'read-only',
    }),
  })

  await governed.definition.execute('model-context-probe', {}, undefined, undefined, expectedContext)

  assert.equal(receivedContext, expectedContext)
})

test('runtime tool invocations cannot acquire Pi nested-tool authority', async () => {
  const rawTool = defineTool({
    name: 'runtime_context_probe',
    label: 'Runtime context probe',
    description: 'Checks the authority supplied to a runtime invocation.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, context) {
      assert.deepEqual(context.tools, [])
      await assert.rejects(
        context.executeTool('bash', { command: 'must not run' }),
        (error: unknown) => isDispatchError(error, 'runtime_nested_tool_unavailable'),
      )
      return { content: [{ type: 'text' as const, text: 'restricted' }], details: {} }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => EXECUTION_CONTEXT,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.tool.runtime-context-probe',
      effect: serialCapabilityEffect('read-only'),
      risk: 'read-only',
    }),
  })

  const result = await governed.runtimeInvoker.invoke({
    toolCallId: 'runtime-context-probe',
    input: {},
    extensionContext: emptyExtensionContext(),
  })

  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'restricted' }], details: {},
  })
})

test('governed Team Runtime tools report the exact raw execution error', async () => {
  const expected = new Error('raw engine failure')
  const reported: Array<{ readonly toolCallId: string; readonly error: unknown }> = []
  const rawTool = defineTool({
    name: 'failing_engine',
    label: 'Failing engine',
    description: 'Fails after admission.',
    parameters: Type.Object({}),
    async execute() {
      throw expected
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => EXECUTION_CONTEXT,
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.engine.failing-engine',
      effect: serialCapabilityEffect('mutating'),
      risk: 'engine',
    }),
    onRawError: (toolCallId, error) => reported.push({ toolCallId, error }),
  })

  await assert.rejects(governed.invoke({
    channel: 'model',
    toolCallId: 'failing-engine-call',
    input: {},
    extensionContext: emptyExtensionContext(),
  }), expected)
  assert.deepEqual(reported, [{
    toolCallId: 'failing-engine-call',
    error: expected,
  }])
})

function emptyExtensionContext(): ExtensionContext {
  return Object.create(null)
}

function isDispatchError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    'code' in error &&
    error.code === code
}
