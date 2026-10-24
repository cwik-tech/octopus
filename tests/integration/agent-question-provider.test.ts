import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { ProviderResult } from '../../providers/types.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { requireValidMcpBridge } from '../../providers/text-cli.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'

import { agentQuestionRequestSchema, agentQuestionContinuationEvidenceSchema, type AgentQuestionRequest } from '../../contracts/agent-questions.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpAgentToolService, type McpAgentToolServiceOptions } from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { startDeterministicOpenAiServer } from '../electron/support/deterministic-openai-server.js'

async function createService(t: TestContext, overrides: Partial<McpAgentToolServiceOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-question-provider-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager: manager,
  })
  t.after(() => manager.closeAll())
  const leaseStore = new McpRunLeaseStore()
  const service = new McpAgentToolService({
    leaseStore,
    providerSettingsService: new ProviderSettingsService({ storagePath: path.join(root, 'providers.json') }),
    broker: new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: settings,
      clientManager: manager,
      grantResolver: () => false,
      leaseResolver: (context) => leaseStore.resolve(context),
    }),
    ...overrides,
  })
  return { service, root }
}

test('a resumed no-tools CLI agent finishes without an empty MCP bridge', async (t) => {
  const { service } = await createService(t, {
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode: 'host-tool-bridge' }),
    // The paid CLI is the external replacement. Apply its real bridge validator.
    cliProviderExecutor: async (provider, options) => {
      if (options.mcpBridge) requireValidMcpBridge(options.mcpBridge, provider)
      assert.equal(options.mcpBridge, undefined)
      assert.equal(options.model, 'sonnet')
      assert.equal(options.thinking, 'low')
      return { text: 'For Marta.', model: options.model, cost: 0, durationMs: 1, inputTokens: 10, outputTokens: 5, contextTokens: 10 }
    },
  })
  const result = await service.runTurn({
    sessionId: 'session-one', runId: 'run-one', assignmentId: 'assignment-one', agentPath: 'agents/writer',
    provider: 'claude', model: 'sonnet', thinking: 'low', allowedServerIds: [],
    systemPrompt: 'Finish the dedication; your question allowance is spent.', userMessage: 'The human answered Marta.',
    managedQuestionTurn: true, signal: AbortSignal.timeout(2_000),
  })
  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') throw new Error('Expected a completed continuation.')
  assert.equal(result.result.text, 'For Marta.')
})

/**
 * What reaches the provider for a managed question turn. The effort level is
 * resolved once, against what the pair accepts, and travels as the adapter's
 * own setting; the lane's other settings travel beside it untouched.
 *
 * `reasoning: false` predates the effort vocabulary and means "send no
 * reasoning field". Where the two disagree the merged contract decides, and
 * this lane has to obey the same rule as every other: the legacy levels stay
 * suppressed, an explicit `off` is still sent because omitting it lets the
 * vendor think, and a widened level stops the turn rather than vanishing.
 */
const nativeCases = [
  { name: 'lm-studio keeps its sampling settings', provider: 'lm-studio', thinking: 'low',
    config: { temperature: 0.2, max_tokens: 256 }, expected: { temperature: 0.2, max_tokens: 256 } },
  { name: 'openai carries a legacy level and its token ceiling', provider: 'openai', thinking: 'low',
    config: { max_output_tokens: 256 }, expected: { max_completion_tokens: 256, reasoning_effort: 'low' } },
  { name: 'openai carries a widened level', provider: 'openai', thinking: 'xhigh',
    config: {}, expected: { reasoning_effort: 'xhigh' } },
  { name: 'openai spells off as the vendor does', provider: 'openai', thinking: 'off',
    config: {}, expected: { reasoning_effort: 'none' } },
  { name: 'openai sends no level for the provider default', provider: 'openai', thinking: 'provider-default',
    config: {}, expected: {} },
  { name: 'openai keeps a legacy level suppressed by reasoning false', provider: 'openai', thinking: 'low',
    config: { reasoning: false }, expected: {} },
  { name: 'openai still sends off under reasoning false', provider: 'openai', thinking: 'off',
    config: { reasoning: false }, expected: { reasoning_effort: 'none' } },
] as const

test('an unsupported structured question lane is refused before executing its provider', async (t) => {
  const { service } = await createService(t, {
    // Provider discovery and execution are the external boundaries under test.
    providerSupportResolver: ({ provider }) => ({ provider, state: 'unsupported' }),
    cliProviderExecutor: async () => { throw new Error('An unsupported question provider was launched.') },
  })
  const result = await service.runTurn({
    sessionId: 'session-one', runId: 'run-one', assignmentId: 'assignment-one', agentPath: 'agents/writer',
    provider: 'gemini', model: 'fixture', thinking: 'low', systemPrompt: 'Choose.', userMessage: 'The recipient is missing.',
    allowedServerIds: [], managedQuestionTurn: true, outputSchema: { type: 'object', properties: {} }, signal: AbortSignal.timeout(1_000),
  })
  assert.equal(result.kind, 'unavailable')
})

test('a question stops a later side effect in the same model response', async (t) => {
  let markerPath = ''
  const { service, root } = await createService(t, { builtinAgentTools: [{
    name: 'write_marker',
    tool: {
      serverId: 'fixture', serverName: 'Fixture', toolName: 'write_marker', namespacedName: 'write_marker',
      description: 'Write the completed output.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
      risk: 'mutating', effect: serialCapabilityEffect('mutating'), requiresApproval: false,
    },
    isEnabledForAgent: () => true,
    execute: async () => { await fs.writeFile(markerPath, 'The side effect ran.'); return { output: {}, content: 'Written', isError: false } },
  }] })
  markerPath = path.join(root, 'must-not-exist.txt')
  // Only the paid provider HTTP boundary is replaced; the side effect is a real file write.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: () => ({
    toolName: 'request_human_input', arguments: { progress: 'I need a recipient.', questions: [{ question: 'Who?', reason: 'Required.' }] },
    followingTools: [{ name: 'write_marker', arguments: {} }],
  }) })
  t.after(() => provider.close())
  const result = await service.runTurn({
    sessionId: 'session-one', runId: 'run-one', assignmentId: 'assignment-one', agentPath: 'agents/writer',
    provider: 'lm-studio', model: 'fixture', thinking: 'low', providerConfig: { base_url: provider.baseUrl },
    systemPrompt: 'Write the dedication.', userMessage: 'Ask for the recipient.', allowedServerIds: [],
    signal: AbortSignal.timeout(2_000),
    humanInput: { capture: async (request) => {
      await fs.writeFile(path.join(root, 'question.json'), JSON.stringify(request))
      return { kind: 'awaiting_input', interactionId: 'question-one' }
    } },
  })
  assert.equal(result.kind, 'awaiting_input')
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' })
})

test('a question retains earlier tool results and continuation reuses the completed side effect', async (t) => {
  let marker = ''
  const { service, root } = await createService(t, { builtinAgentTools: [{
    name: 'write_marker', isEnabledForAgent: () => true,
    tool: { serverId: 'fixture', serverName: 'Fixture', toolName: 'write_marker', namespacedName: 'write_marker',
      description: 'Write a marker.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false }, risk: 'mutating', effect: serialCapabilityEffect('mutating'), requiresApproval: false },
    execute: async () => { await fs.appendFile(marker, 'written\n'); return { output: {}, content: 'Marker saved.', isError: false } },
  }] })
  marker = path.join(root, 'marker.txt')
  const evidencePath = path.join(root, 'evidence.json')
  const provider = await startDeterministicOpenAiServer({ script: [
    { toolName: 'write_marker', arguments: {} },
    { toolName: 'request_human_input', arguments: { progress: 'The marker is saved.', questions: [{ question: 'Who?', reason: 'Required.' }] } },
    { toolName: 'write_marker', arguments: {} }, { text: 'Completed for Marta.' },
  ] })
  t.after(() => provider.close())
  const input = { sessionId: 'session-one', runId: 'run-one', assignmentId: 'assignment-one', agentPath: 'agents/writer',
    provider: 'lm-studio', model: 'fixture', thinking: 'low' as const, providerConfig: { base_url: provider.baseUrl },
    systemPrompt: 'Write the dedication.', userMessage: 'Ask for the recipient.', allowedServerIds: [], signal: AbortSignal.timeout(2_000) }
  const paused = await service.runTurn({ ...input, humanInput: { capture: async (_request, _signal, evidence) => {
    await fs.writeFile(evidencePath, JSON.stringify(evidence ?? null))
    return { kind: 'awaiting_input', interactionId: 'question-one' }
  } } })
  assert.equal(paused.kind, 'awaiting_input')
  const evidence = agentQuestionContinuationEvidenceSchema.parse(JSON.parse(await fs.readFile(evidencePath, 'utf8')))
  assert.equal(evidence.completedTools[0]?.content, 'Marker saved.')
  assert.equal(evidence.providerRounds, 2)
  assert.equal(evidence.toolCalls, 2)
  const completed = await service.runTurn({ ...input, signal: AbortSignal.timeout(2_000), managedQuestionTurn: true,
    questionAllowanceSpent: true, continuationEvidence: evidence, userMessage: 'Marta.' })
  assert.equal(completed.kind, 'completed')
  assert.equal(await fs.readFile(marker, 'utf8'), 'written\n', 'A completed side effect must not execute a second time after answering.')
})

for (const nativeCase of nativeCases) test(`${nativeCase.name}, durably asks and stops`, async (t) => {
  const environment = { ...process.env }
  process.env.OPENAI_API_KEY = 'fixture-only-key'
  t.after(() => { process.env = environment })
  const { service, root } = await createService(t)
  const question = {
    progress: 'The dedication needs a recipient before I can finish.',
    questions: [{ question: 'Who is the dedication for?', reason: 'A dedication must name its recipient.' }],
  }
  const providerRequests: string[] = []
  // Only the paid, nondeterministic provider boundary is replaced. The service,
  // gateway, HTTP adapter and capture filesystem are real.
  const provider = await startDeterministicOpenAiServer({
    resolveTurn: (body) => {
      providerRequests.push(body)
      return { toolName: 'request_human_input', arguments: question }
    },
  })
  t.after(() => provider.close())
  const requestPath = path.join(root, 'captured-request.json')

  const result = await service.runTurn({
    sessionId: 'session-one', runId: 'run-one', assignmentId: 'assignment-one',
    agentPath: 'agents/writer', provider: nativeCase.provider, model: 'question-fixture-model',
    thinking: nativeCase.thinking, providerConfig: { base_url: provider.baseUrl, ...nativeCase.config },
    systemPrompt: 'You write the requested dedication.', userMessage: 'Ask for the missing recipient.',
    allowedServerIds: [], signal: AbortSignal.timeout(2_000),
    humanInput: {
      capture: async (request: AgentQuestionRequest, signal: AbortSignal) => {
        await fs.writeFile(requestPath, JSON.stringify(request), { signal })
        return { kind: 'awaiting_input', interactionId: 'question-one' }
      },
    },
  })

  assert.equal(result.kind, 'awaiting_input', 'The request must suspend, not fall through to no-tools or complete.')
  assert.deepEqual(agentQuestionRequestSchema.parse(JSON.parse(await fs.readFile(requestPath, 'utf8'))), question)
  assert.equal(providerRequests.length, 1, 'Waiting for a human must not buy a second model turn.')
  assert.match(providerRequests[0] ?? '', /question-fixture-model/)
  assert.match(providerRequests[0] ?? '', /request_human_input/)
  const observed: unknown = JSON.parse(providerRequests[0] ?? '')
  assert.ok(observed && typeof observed === 'object')
  assert.deepEqual(Object.fromEntries(Object.entries(observed).filter(([key]) =>
    ['temperature', 'max_tokens', 'max_completion_tokens', 'reasoning_effort'].includes(key),
  )), nativeCase.expected)
  if (result.kind !== 'awaiting_input') throw new Error('Expected a suspended provider turn.')
  assert.equal(result.interruption.interactionId, 'question-one')
  assert.equal(result.route, 'mcp-native')
  assert.equal(result.result.model, 'question-fixture-model')
  assert.deepEqual(result.result.usage, { inputTokens: 5, outputTokens: 7, totalTokens: 12 })
})

const cliEndings = [
  { name: 'returned usage', finish: (result: ProviderResult) => result },
  { name: 'cancellation error', finish: (_result: ProviderResult): ProviderResult => { throw new ProviderError({ provider: 'codex', kind: 'cancelled', message: 'Provider was stopped.', retryable: false }) } },
]
for (const ending of cliEndings) test(`a CLI question persists before stopping and retains usage after ${ending.name}`, async (t) => {
  let stoppedPath = ''
  let requestPath = ''
  let continuedPath = ''
  let bridgeUrl = ''
  const { service, root } = await createService(t, {
    // The paid CLI model is replaced by a child process speaking real MCP.
    // Provider discovery is supplied because this fixture is not an installed CLI.
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode: 'host-tool-bridge' }),
    cliProviderExecutor: async (provider, options) => {
      assert.equal(provider, 'codex')
      assert.equal(options.model, 'fixture-codex-model')
      assert.equal(options.thinking, 'high')
      assert.ok(options.mcpBridge)
      assert.ok(options.signal)
      options.onProtocolEvent?.({ kind: 'usage', provider, inputTokens: 5, outputTokens: 7 })
      bridgeUrl = options.mcpBridge.url
      const child = spawn(process.execPath, ['tests/fixtures/providers/agent-question-cli.mjs'], { stdio: ['pipe', 'ignore', 'pipe'] })
      t.after(() => { child.kill() })
      const abort = () => { child.kill('SIGTERM') }
      options.signal.addEventListener('abort', abort, { once: true })
      child.stdin.end(JSON.stringify({
        url: bridgeUrl, token: options.mcpBridge.token,
        toolName: options.mcpBridge.proxyToolNames[0], requestPath, stoppedPath, continuedPath,
      }))
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Fixture exited ${code}: ${stderr}`)))
      })
      options.signal.removeEventListener('abort', abort)
      return ending.finish({ text: '', model: options.model, cost: 0, durationMs: 1, inputTokens: 5, outputTokens: 7, contextTokens: 5 })
    },
  })
  requestPath = path.join(root, 'request.json')
  stoppedPath = path.join(root, 'stopped-after-persist.json')
  continuedPath = path.join(root, 'continued.txt')

  const result = await service.runTurn({
    sessionId: 'session-one', runId: 'run-one', assignmentId: 'assignment-one',
    agentPath: 'agents/writer', provider: 'codex', model: 'fixture-codex-model', thinking: 'high',
    systemPrompt: 'Write a dedication.', userMessage: 'Ask for the missing recipient.',
    allowedServerIds: [], signal: AbortSignal.timeout(2_000),
    humanInput: { capture: async (request, signal) => {
      await fs.writeFile(requestPath, JSON.stringify(request), { signal })
      return { kind: 'awaiting_input', interactionId: 'cli-question-one' }
    } },
  })

  assert.equal(result.kind, 'awaiting_input')
  assert.equal(await fs.readFile(stoppedPath, 'utf8'), await fs.readFile(requestPath, 'utf8'))
  await assert.rejects(fs.access(continuedPath), { code: 'ENOENT' })
  await assert.rejects(fetch(bridgeUrl, { signal: AbortSignal.timeout(500) }))
  if (result.kind !== 'awaiting_input') throw new Error('Expected a suspended CLI turn.')
  assert.equal(result.route, 'mcp-cli')
  assert.equal(result.interruption.interactionId, 'cli-question-one')
  assert.ok(result.result.executedToolCallCount <= result.result.toolCallCount, 'A captured CLI tool must be counted once across process shutdown.')
  assert.deepEqual(result.result.usage, { inputTokens: 5, outputTokens: 7, totalTokens: 12 })
})

test('a consumed question tool is absent and a repeated call blocks without buying another model turn', async (t) => {
  const environment = { ...process.env }
  process.env.OPENAI_API_KEY = 'fixture-only-key'
  t.after(() => { process.env = environment })
  const { service } = await createService(t)
  const requests: string[] = []
  // Replace the nondeterministic model at its HTTP boundary.
  const provider = await startDeterministicOpenAiServer({ resolveTurn: (body) => {
    requests.push(body)
    return { toolName: 'request_human_input', arguments: { progress: 'Another detail.', questions: [{ question: 'What colour?', reason: 'A required detail.' }] } }
  } })
  t.after(() => provider.close())
  const result = await service.runTurn({
    sessionId: 'session-one', runId: 'run-one', assignmentId: 'assignment-one', agentPath: 'agents/writer',
    provider: 'openai', model: 'question-fixture-model', thinking: 'low', allowedServerIds: [],
    providerConfig: { base_url: provider.baseUrl }, systemPrompt: 'Complete the dedication.', userMessage: 'The human answered Marta.',
    managedQuestionTurn: true, signal: AbortSignal.timeout(2_000),
    questionAllowanceSpent: true,
  })
  assert.equal(result.kind, 'blocked')
  assert.equal(requests.length, 1)
  assert.doesNotMatch(requests[0] ?? '', /request_human_input/)
})

/**
 * The service keeps completed tool results so a resumed turn does not repeat a
 * side effect. A read is different: the human may have changed the very thing
 * the agent is about to re-read, which is usually why they were asked. These
 * run over the real capability gateway with an authoritative execution journal,
 * because that journal carries a second replay layer of its own.
 */
function readNotesAdapter(read: () => Promise<string>, observed: string[]) {
  return {
    name: 'read_notes',
    isEnabledForAgent: () => true,
    tool: {
      serverId: 'fixture', serverName: 'Fixture', toolName: 'read_notes', namespacedName: 'read_notes',
      description: 'Read the shared notes.',
      inputSchema: { type: 'object', properties: { section: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      risk: 'read-only' as const, effect: serialCapabilityEffect('read-only'), requiresApproval: false,
    },
    execute: async () => {
      const content = await read()
      observed.push(content)
      return { output: {}, content, isError: false }
    },
  }
}

async function seedAssignment(root: string) {
  const scope = { sessionId: randomUUID(), runId: randomUUID(), assignmentId: randomUUID() }
  await fs.mkdir(
    path.join(root, 'sessions', scope.sessionId, 'runs', scope.runId, 'assignments', scope.assignmentId),
    { recursive: true },
  )
  return scope
}

test('the service no longer serves a saved result for a read-only capability on resume', async (t) => {
  const observed: string[] = []
  let notesPath = ''
  const { service, root } = await createService(t, {
    builtinAgentTools: [readNotesAdapter(() => fs.readFile(notesPath, 'utf8'), observed)],
  })
  notesPath = path.join(root, 'notes.txt')
  await fs.writeFile(notesPath, 'before')
  const scope = await seedAssignment(root)
  const evidencePath = path.join(root, 'evidence.json')
  const provider = await startDeterministicOpenAiServer({ script: [
    { toolName: 'read_notes', arguments: {} },
    { toolName: 'request_human_input', arguments: { progress: 'I read the notes.', questions: [{ question: 'Who?', reason: 'Required.' }] } },
    { toolName: 'read_notes', arguments: {} },
    { text: 'Completed for Marta.' },
  ] })
  t.after(() => provider.close())
  const input = {
    ...scope, agentPath: 'agents/writer', provider: 'lm-studio', model: 'fixture', thinking: 'low' as const,
    providerConfig: { base_url: provider.baseUrl }, systemPrompt: 'Write the dedication.',
    userMessage: 'Ask for the recipient.', allowedServerIds: [], signal: AbortSignal.timeout(10_000),
  }

  const paused = await service.runTurn({ ...input, humanInput: { capture: async (_request, _signal, evidence) => {
    await fs.writeFile(evidencePath, JSON.stringify(evidence ?? null))
    return { kind: 'awaiting_input', interactionId: 'question-one' }
  } } })
  assert.equal(paused.kind, 'awaiting_input')
  const evidence = agentQuestionContinuationEvidenceSchema.parse(JSON.parse(await fs.readFile(evidencePath, 'utf8')))
  await fs.writeFile(notesPath, 'after')

  const completed = await service.runTurn({
    ...input, signal: AbortSignal.timeout(10_000), managedQuestionTurn: true,
    questionAllowanceSpent: true, continuationEvidence: evidence, userMessage: 'Marta.',
  })

  assert.equal(completed.kind, 'completed')
  assert.deepEqual(observed, ['before', 'after'],
    'The resumed read must run again and see what the human changed')
})

test('a widened level and reasoning false stop the question turn rather than one of them vanishing', async (t) => {
  const environment = { ...process.env }
  process.env.OPENAI_API_KEY = 'fixture-only-key'
  t.after(() => { process.env = environment })
  const { service } = await createService(t)
  const provider = await startDeterministicOpenAiServer({
    resolveTurn: () => { throw new Error('A conflicting effort setting must not reach a provider.') },
  })
  t.after(() => provider.close())

  await assert.rejects(service.runTurn({
    sessionId: 'session-one', runId: 'run-one', assignmentId: 'assignment-one',
    agentPath: 'agents/writer', provider: 'openai', model: 'question-fixture-model',
    thinking: 'xhigh', providerConfig: { base_url: provider.baseUrl, reasoning: false },
    systemPrompt: 'You write the requested dedication.', userMessage: 'Ask for the missing recipient.',
    allowedServerIds: [], signal: AbortSignal.timeout(2_000),
    humanInput: { capture: async () => ({ kind: 'awaiting_input', interactionId: 'question-one' }) },
  }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'provider_unsupported')
    assert.match((error as Error).message, /xhigh/)
    assert.match((error as Error).message, /provider_options\.reasoning/)
    return true
  })
})
