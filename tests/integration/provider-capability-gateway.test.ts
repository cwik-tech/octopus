import assert from 'node:assert/strict'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityDispatchEvent,
  CapabilityDispatchResult,
  CapabilityPolicyDecision,
} from '../../contracts/capability-dispatch.js'
import type {
  BuiltinAgentToolAdapter,
  BuiltinToolExecutionInput,
  BuiltinToolExecutionResult,
} from '../../domains/mcp/builtin-agent-tool-adapter.js'
import { startMcpCliHostBridge } from '../../domains/mcp/mcp-cli-host-bridge.js'
import type {
  McpBrokerRequestContext,
  McpJsonObject,
  McpNamespacedTool,
  McpSanitizedErrorCode,
} from '../../domains/mcp/mcp-runtime.js'
import {
  runProviderToolLoop,
  type ProviderToolExecutionResult,
  type ProviderToolLoopAdapter,
  type ProviderToolLoopMessage,
} from '../../domains/provider/provider-tool-loop.js'
import {
  ProviderCapabilityGateway,
  type ProviderCapabilityBrokerPort,
} from '../../services/provider-capability-gateway.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const TOOL_NAME = 'mcp__builtin-provider-parity__probe'
const CAPABILITY_ID = 'provider.parity.probe'

test('native and CLI provider transports preserve governed dispatch identity and sanitized approved results', async () => {
  const events: CapabilityDispatchEvent[] = []
  const approvalInteractions: string[] = []
  let executions = 0
  const dispatcher = createCapabilityTestDispatcher(events, {
    approval: {
      request: async (input) => {
        const interaction = {
          interactionId: `approval-${approvalInteractions.length + 1}`,
          reused: false,
        }
        approvalInteractions.push(interaction.interactionId)
        await input.onInteraction(interaction)
        return { outcome: 'approved', interaction }
      },
    },
  })
  const tool = governedTool({
    dispatcher,
    decision: { kind: 'require-approval', reason: 'Parity approval.' },
    onExecute: () => { executions += 1 },
  })
  const gateway = new ProviderCapabilityGateway({
    context: brokerContext(),
    broker: unusedBroker(),
    tools: [tool.tool],
    builtinTools: [tool],
    requiredServerIds: new Set(),
  })
  const argumentsValue = { marker: 'same-provider-input' }

  const native = await executeThroughNativeProvider(gateway, argumentsValue)
  const cli = await executeThroughCliProvider(gateway, argumentsValue)

  assert.deepEqual(readSafeResult(native.content), {
    ok: true,
    marker: 'same-provider-input',
  })
  assert.deepEqual(readSafeResult(cli.content), {
    ok: true,
    marker: 'same-provider-input',
  })
  assert.equal(native.isError, false)
  assert.equal(cli.isError, false)
  assert.equal(executions, 2)
  assert.equal(approvalInteractions.length, 2)

  const terminalEvents = events.filter((event) =>
    event.type === 'capability.dispatch.completed')
  assert.equal(terminalEvents.length, 2)
  const [nativeEvent, cliEvent] = terminalEvents
  assert.ok(nativeEvent)
  assert.ok(cliEvent)
  assert.deepEqual(dispatchIdentity(nativeEvent), dispatchIdentity(cliEvent))
  assert.equal(nativeEvent.argumentDigest, cliEvent.argumentDigest)
  assert.notEqual(nativeEvent.dispatchId, cliEvent.dispatchId)
  for (const result of [native, cli]) {
    assert.doesNotMatch(
      result.content,
      /dispatchId|argumentDigest|effect|risk|attemptId/,
    )
  }
})

test('native and CLI provider transports preserve the same kernel denial code without executing', async () => {
  let executions = 0
  const tool = governedTool({
    dispatcher: createCapabilityTestDispatcher(),
    decision: {
      kind: 'deny',
      code: 'domain_denied',
      reason: 'The governed capability is denied.',
    },
    onExecute: () => { executions += 1 },
  })
  const gateway = new ProviderCapabilityGateway({
    context: brokerContext(),
    broker: unusedBroker(),
    tools: [tool.tool],
    builtinTools: [tool],
    requiredServerIds: new Set(),
  })
  const argumentsValue = { marker: 'denied-provider-input' }

  const native = await executeThroughNativeProvider(gateway, argumentsValue)
  const cli = await executeThroughCliProvider(gateway, argumentsValue)

  assert.deepEqual(readSafeResult(native.content), {
    ok: false,
    error: { code: 'domain_denied' },
  })
  assert.deepEqual(readSafeResult(cli.content), {
    ok: false,
    error: { code: 'domain_denied' },
  })
  assert.equal(native.isError, true)
  assert.equal(cli.isError, true)
  assert.equal(executions, 0)
})

test('native and CLI provider transports both fail closed when approval is denied', async () => {
  let executions = 0
  let approvalRequests = 0
  const dispatcher = createCapabilityTestDispatcher([], {
    approval: {
      request: async (input) => {
        approvalRequests += 1
        const interaction = {
          interactionId: `denied-approval-${approvalRequests}`,
          reused: false,
        }
        await input.onInteraction(interaction)
        return { outcome: 'denied', interaction }
      },
    },
  })
  const tool = governedTool({
    dispatcher,
    decision: { kind: 'require-approval', reason: 'Parity approval.' },
    onExecute: () => { executions += 1 },
  })
  const gateway = new ProviderCapabilityGateway({
    context: brokerContext(),
    broker: unusedBroker(),
    tools: [tool.tool],
    builtinTools: [tool],
    requiredServerIds: new Set(),
  })
  const argumentsValue = { marker: 'approval-denied-input' }

  const native = await executeThroughNativeProvider(gateway, argumentsValue)
  const cli = await executeThroughCliProvider(gateway, argumentsValue)

  assert.deepEqual(readSafeResult(native.content), {
    ok: false,
    error: { code: 'approval_denied' },
  })
  assert.deepEqual(readSafeResult(cli.content), {
    ok: false,
    error: { code: 'approval_denied' },
  })
  assert.equal(native.isError, true)
  assert.equal(cli.isError, true)
  assert.equal(approvalRequests, 2)
  assert.equal(executions, 0)
})

test('provider gateway retains only the longest observed text for each URL', async () => {
  const tool = governedTool({
    dispatcher: createCapabilityTestDispatcher(),
    decision: { kind: 'allow' },
    onExecute: () => undefined,
  })
  const gateway = new ProviderCapabilityGateway({
    context: brokerContext(),
    broker: unusedBroker(),
    tools: [tool.tool],
    builtinTools: [tool],
    requiredServerIds: new Set(),
  })

  await gateway.execute({
    toolCallId: 'short-observation',
    capabilityId: TOOL_NAME,
    arguments: { marker: 'short' },
    signal: new AbortController().signal,
  })
  await gateway.execute({
    toolCallId: 'long-observation',
    capabilityId: TOOL_NAME,
    arguments: { marker: 'the longest observed provider text' },
    signal: new AbortController().signal,
  })
  await gateway.execute({
    toolCallId: 'later-short-observation',
    capabilityId: TOOL_NAME,
    arguments: { marker: 'tiny' },
    signal: new AbortController().signal,
  })

  assert.deepEqual(gateway.observedWebSources(), [{
    url: 'https://provider-parity.test/evidence',
    title: 'Provider parity evidence',
    text: 'the longest observed provider text',
  }])
})

test('native and CLI transports aggregate the longest web observation identically', async () => {
  const scenarios = [
    {
      native: 'short native evidence',
      cli: 'the longest observation arrived through the CLI transport',
      expected: 'the longest observation arrived through the CLI transport',
    },
    {
      native: 'the longest observation arrived through the native transport',
      cli: 'short CLI evidence',
      expected: 'the longest observation arrived through the native transport',
    },
  ] as const

  for (const scenario of scenarios) {
    const tool = governedTool({
      dispatcher: createCapabilityTestDispatcher(),
      decision: { kind: 'allow' },
      onExecute: () => undefined,
    })
    const gateway = new ProviderCapabilityGateway({
      context: brokerContext(),
      broker: unusedBroker(),
      tools: [tool.tool],
      builtinTools: [tool],
      requiredServerIds: new Set(),
    })

    await executeThroughNativeProvider(gateway, { marker: scenario.native })
    await executeThroughCliProvider(gateway, { marker: scenario.cli })

    assert.deepEqual(gateway.observedWebSources(), [{
      url: 'https://provider-parity.test/evidence',
      title: 'Provider parity evidence',
      text: scenario.expected,
    }])
  }
})

test('provider gateway retains a value-determined observation regardless of arrival order', async () => {
  const retainedRecords: unknown[] = []
  for (const order of [
    ['alpha-observation', 'beta-observation'],
    ['beta-observation', 'alpha-observation'],
  ] as const) {
    const tool = observationTool()
    const gateway = new ProviderCapabilityGateway({
      context: brokerContext(),
      broker: unusedBroker(),
      tools: [tool.tool],
      builtinTools: [tool],
      requiredServerIds: new Set(),
    })
    for (const toolCallId of order) {
      await gateway.execute({
        toolCallId,
        capabilityId: TOOL_NAME,
        arguments: { marker: toolCallId },
        signal: new AbortController().signal,
      })
    }
    retainedRecords.push(gateway.observedWebSources())
  }

  assert.deepEqual(retainedRecords[0], retainedRecords[1])
  assert.deepEqual(retainedRecords[0], [{
    url: 'https://provider-parity.test/evidence',
    title: 'Beta observation evidence',
    text: 'same-length evidence text',
  }])
})

test('provider gateway keeps the first fatal required-server error it observed', async () => {
  const tool = providerTool()
  let brokerCalls = 0
  const gateway = new ProviderCapabilityGateway({
    context: brokerContext(),
    broker: {
      callTool: async (request) => {
        brokerCalls += 1
        const code: McpSanitizedErrorCode =
          brokerCalls === 1 ? 'tool_failed' : 'not_found'
        return {
          contractVersion: 1,
          requestId: request.context.requestId,
          toolCallId: request.toolCallId,
          isError: true,
          content: [],
          attachments: [],
          evidence: [],
          error: {
            code,
            message: `Required server failure ${brokerCalls}.`,
            retryable: false,
          },
        }
      },
    },
    tools: [tool],
    builtinTools: [],
    requiredServerIds: new Set([tool.serverId]),
  })

  await assert.rejects(
    gateway.execute({
      toolCallId: 'first-required-failure',
      capabilityId: tool.namespacedName,
      arguments: { marker: 'first' },
      signal: new AbortController().signal,
    }),
    /A required governed capability failed\./,
  )
  await assert.rejects(
    gateway.execute({
      toolCallId: 'second-required-failure',
      capabilityId: tool.namespacedName,
      arguments: { marker: 'second' },
      signal: new AbortController().signal,
    }),
    /A required governed capability failed\./,
  )

  const fatal = gateway.fatalBrokerError()
  assert.ok(fatal)
  assert.equal(fatal.code, 'tool_failed')
  assert.equal(fatal.message, 'Required server failure 1.')
})

test('MCP provider calls preserve their turn ordinal at the broker boundary', async () => {
  const tool = providerTool()
  let observedOrdinal: number | undefined
  const gateway = new ProviderCapabilityGateway({
    context: brokerContext(),
    broker: {
      callTool: async (request) => {
        observedOrdinal = request.context.providerCallOrdinal
        return {
          contractVersion: 1,
          requestId: request.context.requestId,
          toolCallId: request.toolCallId,
          isError: false,
          content: [{ type: 'text', text: 'ordinal-preserved' }],
          attachments: [],
          evidence: [],
        }
      },
    },
    tools: [tool],
    builtinTools: [],
    requiredServerIds: new Set(),
  })

  await gateway.execute({
    toolCallId: 'ordinal-call',
    capabilityId: tool.namespacedName,
    arguments: { marker: 'ordinal' },
    signal: new AbortController().signal,
    providerCallOrdinal: 7,
  })

  assert.equal(observedOrdinal, 7)
})

test('gateway records resolved typed results but excludes thrown capability executions', async () => {
  // "Resolved" means the capability returned a wire result, whatever it says.
  // A thrown execution is dispatch or infrastructure breaking down, and it must
  // never look like the provider received an answer.
  const successful = resultTool(async () => ({
    output: { ok: true },
    content: JSON.stringify({ ok: true }),
    isError: false,
  }))
  const successfulGateway = gatewayFor(successful)
  assert.equal(successfulGateway.hasResolvedCapabilityResult(TOOL_NAME), false)
  await successfulGateway.execute(probeCall('successful'))
  assert.equal(successfulGateway.hasResolvedCapabilityResult(TOOL_NAME), true)

  const typedError = resultTool(async () => ({
    output: { ok: false, error: 'source_blocked' },
    content: JSON.stringify({ ok: false, error: 'source_blocked' }),
    isError: true,
  }))
  const typedErrorGateway = gatewayFor(typedError)
  await typedErrorGateway.execute(probeCall('typed-error'))
  assert.equal(typedErrorGateway.hasResolvedCapabilityResult(TOOL_NAME), true)

  const thrown = resultTool(async () => {
    throw new Error('The parity capability could not be dispatched.')
  })
  const thrownGateway = gatewayFor(thrown)
  await assert.rejects(thrownGateway.execute(probeCall('thrown')))
  assert.equal(thrownGateway.hasResolvedCapabilityResult(TOOL_NAME), false)

  // An identity nobody called stays uncounted even after a sibling resolved.
  assert.equal(
    successfulGateway.hasResolvedCapabilityResult('provider.parity.absent'),
    false,
  )
})

function resultTool(
  execute: () => Promise<BuiltinToolExecutionResult>,
): BuiltinAgentToolAdapter {
  return {
    name: TOOL_NAME,
    tool: providerTool(),
    isEnabledForAgent: () => true,
    execute: async () => execute(),
  }
}

function gatewayFor(tool: BuiltinAgentToolAdapter): ProviderCapabilityGateway {
  return new ProviderCapabilityGateway({
    context: brokerContext(),
    broker: unusedBroker(),
    tools: [tool.tool],
    builtinTools: [tool],
    requiredServerIds: new Set(),
  })
}

function probeCall(toolCallId: string) {
  return {
    toolCallId,
    capabilityId: TOOL_NAME,
    arguments: { marker: toolCallId },
    signal: new AbortController().signal,
  }
}

function observationTool(): BuiltinAgentToolAdapter {
  const observations: Record<string, { title: string; text: string }> = {
    'alpha-observation': {
      title: 'Alpha observation evidence',
      text: 'same-length evidence text',
    },
    'beta-observation': {
      title: 'Beta observation evidence',
      text: 'same-length evidence text',
    },
  }
  const tool = providerTool()
  return {
    name: TOOL_NAME,
    tool,
    isEnabledForAgent: () => true,
    execute: async (execution) => {
      const marker = readMarker(execution.input)
      const observation = observations[marker]
      assert.ok(observation)
      return {
        output: { ok: true },
        content: JSON.stringify({ ok: true, marker }),
        isError: false,
        webObservation: {
          url: 'https://provider-parity.test/evidence',
          title: observation.title,
          text: observation.text,
        },
      }
    },
  }
}

function governedTool(input: {
  readonly dispatcher: ReturnType<typeof createCapabilityTestDispatcher>
  readonly decision: CapabilityPolicyDecision
  readonly onExecute: () => void
}): BuiltinAgentToolAdapter {
  const tool = providerTool()
  return {
    name: TOOL_NAME,
    tool,
    isEnabledForAgent: () => true,
    execute: async (execution) => {
      const result = await input.dispatcher.dispatch({
        context: {
          contractVersion: 1,
          requestId: execution.context.requestId,
          sessionId: execution.context.sessionId,
          runId: execution.context.runId,
          assignmentId: execution.context.assignmentId,
          agentPath: execution.context.agentPath,
          authority: {
            kind: 'mcp-lease',
            leaseId: execution.context.leaseId,
          },
        },
        invocation: {
          capabilityId: CAPABILITY_ID,
          source: {
            kind: 'builtin',
            id: 'builtin.provider-parity',
            version: '1',
          },
          toolCallId: execution.toolCallId,
          input: execution.input,
        },
        adapter: governedCapabilityAdapter(
          execution,
          input.decision,
          input.onExecute,
        ),
        ...(execution.signal ? { signal: execution.signal } : {}),
      })
      const safe = safeDispatchResult(result, execution.input)
      const marker = readMarker(execution.input)
      return {
        output: result,
        content: JSON.stringify(safe),
        isError: !safe.ok,
        ...(safe.ok && marker
          ? {
              webObservation: {
                url: 'https://provider-parity.test/evidence',
                title: 'Provider parity evidence',
                text: marker,
              },
            }
          : {}),
      }
    },
  }
}

function governedCapabilityAdapter(
  execution: BuiltinToolExecutionInput,
  decision: CapabilityPolicyDecision,
  onExecute: () => void,
): CapabilityAdapter {
  return {
    capabilityId: CAPABILITY_ID,
    prepare: async () => ({
      effect: serialCapabilityEffect('read-only'),
      risk: 'read-only',
      argumentNames: Object.keys(execution.input).sort(),
      policyDecision: decision,
      ...(decision.kind === 'require-approval'
        ? {
            approval: {
              serverId: 'builtin.provider-parity',
              namespacedToolName: TOOL_NAME,
              title: 'Provider parity approval',
              description: 'Approve the provider parity probe.',
            },
          }
        : {}),
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        onExecute()
        return { marker: readMarker(execution.input) }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function safeDispatchResult(
  result: CapabilityDispatchResult,
  argumentsValue: McpJsonObject,
): SafeProviderResult {
  if (result.status === 'completed') {
    return { ok: true, marker: readMarker(argumentsValue) }
  }
  return {
    ok: false,
    error: {
      code: result.code ?? 'internal',
    },
  }
}

function providerTool(): McpNamespacedTool {
  return {
    serverId: 'builtin.provider-parity',
    serverName: 'Provider parity',
    toolName: 'probe',
    namespacedName: TOOL_NAME,
    description: 'Exercises the provider capability seam.',
    inputSchema: {
      type: 'object',
      properties: { marker: { type: 'string' } },
      required: ['marker'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    risk: 'read-only',
    effect: serialCapabilityEffect('read-only'),
    requiresApproval: false,
  }
}

function brokerContext(): Omit<McpBrokerRequestContext, 'requestId'> {
  return {
    contractVersion: 1,
    leaseId: 'provider-parity-lease',
    sessionId: 'provider-parity-session',
    runId: 'provider-parity-run',
    assignmentId: 'provider-parity-assignment',
    agentPath: 'agents/provider-parity',
  }
}

function unusedBroker(): ProviderCapabilityBrokerPort {
  return {
    callTool: async () => {
      throw new Error('The provider parity fixture must not call MCP transport.')
    },
  }
}

async function executeThroughNativeProvider(
  gateway: ProviderCapabilityGateway,
  argumentsValue: McpJsonObject,
): Promise<ProviderToolExecutionResult> {
  const result = await runProviderToolLoop({
    messages: [{ role: 'user', content: 'Call the parity probe.' }],
    tools: [{
      name: TOOL_NAME,
      description: 'Provider parity probe.',
      inputSchema: providerTool().inputSchema,
      effect: providerTool().effect,
    }],
    adapter: singleToolCallAdapter(argumentsValue),
    executeTool: (call, context) => gateway.execute({
      toolCallId: call.id,
      capabilityId: call.name,
      arguments: call.arguments,
      signal: context.signal,
    }),
  })
  const message = result.messages.find(
    (candidate): candidate is Extract<ProviderToolLoopMessage, { role: 'tool' }> =>
      candidate.role === 'tool',
  )
  assert.ok(message)
  return {
    content: message.content,
    isError: message.isError,
  }
}

function singleToolCallAdapter(
  argumentsValue: McpJsonObject,
): ProviderToolLoopAdapter {
  return {
    complete: async (request) => {
      const toolResult = request.messages.find((message) => message.role === 'tool')
      if (toolResult) {
        return {
          content: 'Provider consumed the governed result.',
          toolCalls: [],
        }
      }
      return {
        content: null,
        toolCalls: [{
          id: 'native-provider-call',
          name: TOOL_NAME,
          arguments: argumentsValue,
        }],
      }
    },
  }
}

async function executeThroughCliProvider(
  gateway: ProviderCapabilityGateway,
  argumentsValue: McpJsonObject,
): Promise<ProviderToolExecutionResult> {
  const bridge = await startMcpCliHostBridge({
    tools: [providerTool()],
    callTool: (call) => gateway.execute({
      toolCallId: call.toolCallId,
      capabilityId: call.namespacedToolName,
      arguments: call.arguments,
      signal: call.signal,
    }),
  })
  const client = new Client({
    name: 'provider-capability-parity-client',
    version: '1.0.0',
  })
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: {
      headers: { authorization: `Bearer ${bridge.bearerToken}` },
    },
  })
  try {
    await client.connect(new ExactOptionalMcpTransport(transport))
    const listed = await client.listTools()
    const toolName = listed.tools[0]?.name
    assert.ok(toolName)
    const result = await client.callTool({
      name: toolName,
      arguments: argumentsValue,
    })
    return readCliToolResult(result)
  } finally {
    await client.close().catch(() => undefined)
    await bridge.close()
  }
}

function readCliToolResult(value: unknown): ProviderToolExecutionResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error('CLI provider fixture returned an invalid tool result.')
  }
  const text = value.content.find((entry) =>
    isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string')
  if (!isRecord(text) || typeof text.text !== 'string') {
    throw new Error('CLI provider fixture omitted its text result.')
  }
  return {
    content: text.text,
    isError: value.isError === true,
  }
}

type SafeProviderResult =
  | { readonly ok: true; readonly marker: string }
  | { readonly ok: false; readonly error: { readonly code: string } }

function readSafeResult(value: string): SafeProviderResult {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new Error('Provider-safe result is invalid.')
  }
  if (parsed.ok) {
    if (typeof parsed.marker !== 'string') {
      throw new Error('Provider-safe success marker is invalid.')
    }
    return { ok: true, marker: parsed.marker }
  }
  if (!isRecord(parsed.error) || typeof parsed.error.code !== 'string') {
    throw new Error('Provider-safe failure is invalid.')
  }
  return { ok: false, error: { code: parsed.error.code } }
}

function readMarker(value: McpJsonObject): string {
  return typeof value.marker === 'string' ? value.marker : ''
}

function dispatchIdentity(event: CapabilityDispatchEvent): object {
  return {
    capabilityId: event.capabilityId,
    sourceKind: event.sourceKind,
    sourceId: event.sourceId,
    sourceVersion: event.sourceVersion,
    sessionId: event.sessionId,
    runId: event.runId,
    assignmentId: event.assignmentId,
    agentPath: event.agentPath,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
