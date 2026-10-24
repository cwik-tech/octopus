import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MCP_WORKER_TURN_CONTRACT_VERSION,
  McpWorkerTurnContractError,
  parseMcpWorkerTurnRequest,
  parseMcpWorkerTurnResponse,
} from '../../domains/mcp/mcp-worker-turn.js'

const validRequest = {
  version: MCP_WORKER_TURN_CONTRACT_VERSION,
  sessionId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  assignmentId: 'child-research-33333333-3333-4333-8333-333333333333',
  activityScopeId: 'lane-market',
  agentDisplayName: 'Market Evidence Analyst',
  taskId: '22222222-2222-4222-8222-222222222222',
  processIdentity: '44444444-4444-4444-8444-444444444444',
  workflowId: 'research-workflow',
  workflowStepId: 'research-step',
  agentPath: 'agents/researcher',
  provider: 'openai',
  model: 'fixture/tool-loop',
  thinking: 'medium',
  governedWebEvidenceMode: 'acquire',
  systemPrompt: 'Use tools for evidence.',
  userMessage: 'Research this question.',
} as const

test('MCP worker wire version identifies delegated assignment credentials', () => {
  assert.equal(MCP_WORKER_TURN_CONTRACT_VERSION, 6)
  assert.throws(
    () => parseMcpWorkerTurnRequest({ ...validRequest, version: 5 }),
    McpWorkerTurnContractError,
  )
})

test('MCP worker turn contract accepts canonical assignment-scoped requests', () => {
  assert.deepEqual(parseMcpWorkerTurnRequest(validRequest), validRequest)
  const {
    activityScopeId: _activityScopeId,
    agentDisplayName: _agentDisplayName,
    ...withoutActivityScope
  } =
    validRequest
  assert.deepEqual(
    parseMcpWorkerTurnRequest(withoutActivityScope),
    withoutActivityScope,
  )
})

test('MCP worker turn contract rejects identity, agent, and shape confusion', () => {
  for (const invalid of [
    { ...validRequest, version: 999 },
    { ...validRequest, sessionId: '../session' },
    { ...validRequest, assignmentId: '../escape' },
    { ...validRequest, activityScopeId: '../escape' },
    { ...validRequest, activityScopeId: '' },
    { ...validRequest, agentDisplayName: '' },
    { ...validRequest, agentDisplayName: 'Analyst\nforged' },
    { ...validRequest, workflowStepId: '../escape' },
    { ...validRequest, workflowId: undefined },
    { ...validRequest, workflowStepId: undefined },
    { ...validRequest, agentPath: 'agents/researcher/other' },
    { ...validRequest, unexpected: true },
    { ...validRequest, provider: 'openai\nforged' },
    { ...validRequest, thinking: 'maximum' },
    { ...validRequest, thinking: undefined },
    { ...validRequest, governedWebEvidenceMode: 'optional' },
  ]) {
    assert.throws(
      () => parseMcpWorkerTurnRequest(invalid),
      McpWorkerTurnContractError,
    )
  }
})

test('MCP worker turn response contract accepts exact completed and fallback shapes', () => {
  assert.deepEqual(
    parseMcpWorkerTurnResponse({
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      kind: 'completed',
      text: 'Tool-grounded answer.',
      model: 'fixture/tool-loop',
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      availableToolCount: 1,
      toolCallCount: 1,
      executedToolCallCount: 1,
    }),
    {
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      kind: 'completed',
      text: 'Tool-grounded answer.',
      model: 'fixture/tool-loop',
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      availableToolCount: 1,
      toolCallCount: 1,
      executedToolCallCount: 1,
    },
  )
  assert.deepEqual(
    parseMcpWorkerTurnResponse({
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      kind: 'no-tools',
      providerSupport: {
        provider: 'openai',
        state: 'supported',
        mode: 'native-tool-loop',
      },
    }),
    {
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      kind: 'no-tools',
      providerSupport: {
        provider: 'openai',
        state: 'supported',
        mode: 'native-tool-loop',
      },
    },
  )
})

test('MCP worker turn response contract rejects ambiguous and inconsistent output', () => {
  for (const invalid of [
    {
      version: 999,
      kind: 'no-tools',
      providerSupport: { provider: 'openai', state: 'supported' },
    },
    {
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      kind: 'completed',
      text: 'answer',
      model: 'fixture',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 3 },
      availableToolCount: 1,
      toolCallCount: 1,
      executedToolCallCount: 1,
    },
    {
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      kind: 'no-tools',
      providerSupport: { provider: 'openai', state: 'supported' },
      unexpected: true,
    },
    {
      version: MCP_WORKER_TURN_CONTRACT_VERSION,
      kind: 'completed',
      text: 'answer',
      model: 'fixture',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      availableToolCount: 1,
      toolCallCount: 1,
      executedToolCallCount: 2,
    },
  ]) {
    assert.throws(
      () => parseMcpWorkerTurnResponse(invalid),
      McpWorkerTurnContractError,
    )
  }
})

test('MCP worker turn contract rejects provider target and header injection', () => {
  for (const providerConfig of [
    { base_url: 'http://127.0.0.1:9999/v1' },
    {
      base_url: 'http://127.0.0.1:9999/v1',
      site_url: 'https://worker-controlled.invalid',
      site_name: 'Worker controlled',
      headers: { 'X-Worker-Injected': 'true' },
    },
  ]) {
    assert.throws(
      () => parseMcpWorkerTurnRequest({ ...validRequest, providerConfig }),
      McpWorkerTurnContractError,
    )
  }
})

test('a child cannot smuggle provider settings, or an endpoint, into a worker turn', () => {
  // The request is exact-field validated, and this is why that matters rather
  // than being tidy. `domains/mcp/mcp-provider-tool-target.ts:36-44` honours a
  // `base_url` using the *parent's* credentials, so a request that accepted a
  // worker-supplied endpoint would let a child redirect them. The child is not
  // a source of authority about where a request goes, what headers it carries,
  // or what a process may do; those are owned by settings and by the
  // capability authority, and nothing here may become a second way in.
  //
  // The behavioural settings are refused on the same footing, and for now that
  // means this route carries none at all: `services/mcp-worker-turn-service.ts`
  // passes no `providerConfig` and never consults the re-evaluation, so a
  // worker turn applies an Agent's settings on neither the native tool loop nor
  // the CLI bridge. That is a gap in what the route supports, recorded in the
  // phase plan — not something this test should be read as closing. What it
  // does establish is that a *worker* cannot supply them, which is separate:
  // the request would then be the child's own claim about how to run, which is
  // exactly what the sealed boundary exists to refuse.
  for (const smuggled of [
    { providerConfig: { base_url: 'https://elsewhere.invalid/v1' } },
    { providerConfig: { max_tokens: 4_096 } },
    { provider_options: { temperature: 2 } },
    { baseUrl: 'https://elsewhere.invalid/v1' },
    { headers: { authorization: 'Bearer stolen' } },
    { sandbox: 'danger-full-access' },
  ]) {
    assert.throws(
      () => parseMcpWorkerTurnRequest({ ...validRequest, ...smuggled }),
      McpWorkerTurnContractError,
      `a worker turn must refuse ${Object.keys(smuggled)[0]}`,
    )
  }
})

test('a completed response that names no dropped settings is still readable', () => {
  // Every response written before settings could be dropped omits the field,
  // and so does every turn that drops nothing — which is nearly all of them.
  // An additive field has to be genuinely optional or it stops being additive:
  // the exact-key boundary is what keeps a child from smuggling anything in,
  // and it must not turn "absent" into "invalid".
  const completed = {
    version: MCP_WORKER_TURN_CONTRACT_VERSION,
    kind: 'completed',
    text: 'An answer.',
    model: 'fixture/tool-loop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    availableToolCount: 0,
    toolCallCount: 0,
    executedToolCallCount: 0,
  } as const

  assert.deepEqual(parseMcpWorkerTurnResponse(completed), completed)
  assert.deepEqual(
    parseMcpWorkerTurnResponse({
      ...completed,
      droppedProviderOptions: ['max_tokens'],
    }),
    { ...completed, droppedProviderOptions: ['max_tokens'] },
  )
  // And the closed vocabulary still holds on the way back.
  assert.throws(
    () =>
      parseMcpWorkerTurnResponse({
        ...completed,
        droppedProviderOptions: ['base_url'],
      }),
    McpWorkerTurnContractError,
  )
})

test('a response whose required fields are only inherited is not a response', () => {
  // The parser reads unknown input, so its closed contract has to be about the
  // object's *own* fields. An object that carries none of them but inherits
  // them all describes nothing that was actually sent, and accepting it would
  // let a shape stand in for a payload.
  const completed = {
    version: MCP_WORKER_TURN_CONTRACT_VERSION,
    kind: 'completed',
    text: 'An answer.',
    model: 'fixture/tool-loop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    availableToolCount: 0,
    toolCallCount: 0,
    executedToolCallCount: 0,
  }

  assert.throws(
    () => parseMcpWorkerTurnResponse(Object.create(completed) as unknown),
    McpWorkerTurnContractError,
  )
})
