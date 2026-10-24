import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { agentQuestionContinuationEvidenceSchema } from '../../contracts/agent-questions.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { namespaceMcpToolName } from '../../domains/mcp/mcp-runtime.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { startDeterministicOpenAiServer, type DeterministicOpenAiServerOptions } from '../electron/support/deterministic-openai-server.js'
import { createHash } from 'node:crypto'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { skillLoaderToolModule } from '../../server/tools/skill-loader.js'
import type { ToolDeps } from '../../server/tools/tool-registry.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'

/**
 * What a resumed question continuation must observe, proved on the real path:
 * a stdio MCP server, the real capability gateway and an authoritative
 * execution journal.
 *
 * Two kinds of builtin behave differently here. A plain fixture adapter runs
 * inside `ProviderCapabilityGateway.executeBuiltin` and reaches no dispatcher,
 * so it cannot show what the journal does. A governed builtin such as the skill
 * loader dispatches through the real `CapabilityDispatcher` and does reach the
 * journal, which is why the loader cases below are the ones that can.
 *
 * A resumed continuation runs a second provider loop whose tool-call ordinal
 * restarts at zero, and `deriveDurableInvocationOperationId` keys an operation
 * partly on that ordinal. Tools reached over MCP never form that address at
 * all, because the broker's context validation drops the ordinal; that loss is
 * separate and untouched here.
 */
const MCP_FIXTURE_PATH = path.join(process.cwd(), 'tests', 'fixtures', 'mcp', 'stdio-server.mjs')
const SERVER_ID = 'question-replay-tools'
const AGENT_PATH = 'agents/writer'
const ECHO_TOOL = namespaceMcpToolName(SERVER_ID, 'echo-marker')

const CODEC = {
  encrypt: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
}

async function createDurableService(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-question-durable-')))
  const callsPath = path.join(root, 'calls.jsonl')
  const manager = new McpClientManager({ connectTimeoutMs: 10_000, requestTimeoutMs: 15_000, closeTimeoutMs: 2_000 })
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'), secretCodec: CODEC, clientManager: manager,
  })
  // Ordered teardown: the MCP children and the journal both stop before the
  // directory is removed, and a setup failure still removes it. Registered
  // before the registry exists, so it is reached through a mutable handle.
  let closeRegistry: (() => Promise<void>) | undefined
  t.after(async () => {
    try {
      await manager.closeAll?.()
      await closeRegistry?.()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  await settings.saveServer({
    id: SERVER_ID,
    name: 'Question replay tools',
    capabilityAliases: [{ capability: 'marker.echo', access: 'read' }],
    transport: {
      type: 'stdio', command: process.execPath, args: [MCP_FIXTURE_PATH], cwd: process.cwd(),
      secretEnvironment: { MCP_FIXTURE_CALLS_PATH: { operation: 'replace', value: callsPath } },
    },
  })
  await settings.validateServer(SERVER_ID, { stdioTrustAcknowledged: true })
  await settings.setAgentGrant(AGENT_PATH, SERVER_ID, true)

  const scope = { sessionId: randomUUID(), runId: randomUUID(), assignmentId: randomUUID() }
  fs.mkdirSync(
    path.join(root, 'sessions', scope.sessionId, 'runs', scope.runId, 'assignments', scope.assignmentId),
    { recursive: true },
  )
  // What production wires at server/composition.ts:778, in its default mode.
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath: root, tenantId: 'local', mode: 'authoritative',
  })
  closeRegistry = () => registry.close()
  const leases = new McpRunLeaseStore()
  // Without this the regression could pass simply because no durable authority
  // was ever consulted, which is how an earlier attempt at this test misled.
  const resolvedPorts: boolean[] = []
  const service = new McpAgentToolService({
    leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({
      storagePath: path.join(root, 'providers.json'), secretCodec: CODEC,
    }),
    broker: new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: settings,
      clientManager: settings.getBrokerClientManager(),
      grantResolver: ({ context, serverId }) => settings.isAgentGranted(context.agentPath, serverId),
      leaseResolver: (context) => leases.resolve(context),
      durable: async (input: Parameters<typeof registry.resolve>[0]) => {
        const port = await registry.resolve(input)
        resolvedPorts.push(Boolean(port))
        return port
      },
    }),
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode: 'native-tool-loop' }),
  })
  const readCalls = () => fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { marker: string })
    : []
  return { service, root, scope, readCalls, resolvedPorts }
}

async function pauseThenResume(
  t: TestContext,
  script: NonNullable<DeterministicOpenAiServerOptions['script']>,
) {
  const { service, root, scope, readCalls, resolvedPorts } = await createDurableService(t)
  const provider = await startDeterministicOpenAiServer({ script })
  t.after(() => provider.close())
  const evidencePath = path.join(root, 'evidence.json')
  const input = {
    ...scope, agentPath: AGENT_PATH, provider: 'lm-studio', model: 'fixture', thinking: 'low' as const,
    providerConfig: { base_url: provider.baseUrl }, systemPrompt: 'Write the dedication.',
    userMessage: 'Ask for the recipient.', allowedServerIds: [SERVER_ID] as readonly string[],
  }
  const paused = await service.runTurn({
    ...input, signal: AbortSignal.timeout(30_000),
    humanInput: { capture: async (_request, _signal, evidence) => {
      fs.writeFileSync(evidencePath, JSON.stringify(evidence ?? null))
      return { kind: 'awaiting_input', interactionId: 'question-one' }
    } },
  })
  assert.equal(paused.kind, 'awaiting_input', 'The asking turn must pause for the human')
  const evidence = agentQuestionContinuationEvidenceSchema.parse(JSON.parse(fs.readFileSync(evidencePath, 'utf8')))
  const completed = await service.runTurn({
    ...input, signal: AbortSignal.timeout(30_000), managedQuestionTurn: true,
    questionAllowanceSpent: true, continuationEvidence: evidence, userMessage: 'Marta.',
  })
  return { completed, evidence, readCalls, resolvedPorts }
}

test('a resumed read reaches the real MCP server instead of the journal record the asking turn left', async (t) => {
  const { completed, readCalls, resolvedPorts } = await pauseThenResume(t, [
    { toolName: ECHO_TOOL, arguments: { marker: 'notes' } },
    { toolName: 'request_human_input', arguments: { progress: 'I read the notes.', questions: [{ question: 'Who?', reason: 'Required.' }] } },
    { toolName: ECHO_TOOL, arguments: { marker: 'notes' } },
    { text: 'Completed for Marta.' },
  ])

  assert.equal(completed.kind, 'completed')
  assert.ok(resolvedPorts.some(Boolean),
    'No durable authority was consulted, so this journey proves nothing about journal replay')
  assert.deepEqual(readCalls().map((entry) => entry.marker), ['notes', 'notes'],
    'The resumed read must reach the server again, not a journal record keyed on the reused ordinal')
})

test('a resumed turn may call the same capability with different arguments', async (t) => {
  const { completed, readCalls, resolvedPorts } = await pauseThenResume(t, [
    { toolName: ECHO_TOOL, arguments: { marker: 'section-a' } },
    { toolName: 'request_human_input', arguments: { progress: 'I read section a.', questions: [{ question: 'Who?', reason: 'Required.' }] } },
    { toolName: ECHO_TOOL, arguments: { marker: 'section-b' } },
    { text: 'Completed for Marta.' },
  ])

  assert.equal(completed.kind, 'completed')
  assert.ok(resolvedPorts.some(Boolean),
    'No durable authority was consulted, so this journey proves nothing about journal replay')
  assert.deepEqual(readCalls().map((entry) => entry.marker), ['section-a', 'section-b'],
    'A differently-argued resumed call must be accepted, not refused as an identity conflict')
})

/**
 * `load_skill` is the governed builtin that keeps the ordinal: its adapter
 * hands the original execution context to `SkillLoaderCapabilityDispatchGateway`
 * and `toBuiltinCapabilityExecutionContext` preserves `providerCallOrdinal`
 * (`services/builtin-capability-context.ts:42`). Unlike the MCP lane, which
 * drops that field in its broker validation, this path can form the operation
 * id the durable journal binds on, so it is where a reused ordinal could serve
 * a resumed call from the asking turn's record.
 *
 * The loader verifies a SHA-256 before returning a skill, which makes a clean
 * discriminator: editing the file between the two turns must surface as a
 * refused load, because a replayed record would hand back the stale content the
 * asking turn read.
 */
function writeSkill(repoRootPath: string, name: string, body: string) {
  const source = path.join(repoRootPath, 'agents', 'analyst', 'skills', name, 'SKILL.md')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, body)
  return { source, sha256: createHash('sha256').update(body).digest('hex') }
}

interface CliPlan { args?: Record<string, unknown> }

async function createGovernedBuiltinService(
  t: TestContext,
  mode: 'native-tool-loop' | 'host-tool-bridge' = 'native-tool-loop',
  cliPlan: CliPlan = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-question-skill-')))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'), secretCodec: CODEC, clientManager: manager,
  })
  let closeRegistry: (() => Promise<void>) | undefined
  // Ordered teardown. The fixture directory always goes, but a journal that
  // cannot flush or close is a real failure and must surface, so only the
  // removal is in the `finally`.
  t.after(async () => {
    try {
      await manager.closeAll?.()
      await closeRegistry?.()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  const scope = { sessionId: randomUUID(), runId: randomUUID(), assignmentId: randomUUID() }
  fs.mkdirSync(
    path.join(root, 'sessions', scope.sessionId, 'runs', scope.runId, 'assignments', scope.assignmentId),
    { recursive: true },
  )
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath: root, tenantId: 'local', mode: 'authoritative',
  })
  closeRegistry = () => registry.close()
  const resolvedPorts: boolean[] = []
  // The real dispatcher, carrying the same durable resolver production wires.
  const dispatcher = new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({ maxActivePerScope: 4, maxRetainedPerScope: 32 }),
    authority: { authorize: async () => ({ kind: 'allow' }) },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'unused' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    evidence: { append: async () => undefined },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: () => Date.now() },
    ids: { nextAttemptId: () => `attempt-${randomUUID()}` },
    durable: async (input) => {
      const port = await registry.resolve(input)
      resolvedPorts.push(Boolean(port))
      return port
    },
  })
  // The production tool module, so this exercises the shipped adapter.
  const toolDeps: ToolDeps = { repoRootPath: root, capabilityDispatcher: dispatcher }
  const contribution = skillLoaderToolModule.build(toolDeps)
  const agentTool = contribution.agentTool
  assert.ok(agentTool, 'The skill-loader module must contribute its agent tool')
  // Observation only: the shipped adapter still does the work, this records
  // what each call actually returned so a replay is distinguishable from a run.
  const loadOutcomes: Array<{ readonly ok: boolean; readonly code?: string; readonly content?: string; readonly ordinal?: number }> = []
  const observedTool = {
    ...agentTool,
    execute: async (args: Parameters<typeof agentTool.execute>[0]) => {
      const result = await agentTool.execute(args)
      const output = result.output as { ok?: unknown; code?: unknown; content?: unknown }
      const ordinal = (args.context as { providerCallOrdinal?: number }).providerCallOrdinal
      loadOutcomes.push({
        ok: output?.ok === true,
        ...(typeof output?.code === 'string' ? { code: output.code } : {}),
        ...(typeof output?.content === 'string' ? { content: output.content } : {}),
        ...(ordinal === undefined ? {} : { ordinal }),
      })
      return result
    },
  }
  const leases = new McpRunLeaseStore()
  const service = new McpAgentToolService({
    leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({
      storagePath: path.join(root, 'providers.json'), secretCodec: CODEC,
    }),
    broker: new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: settings,
      clientManager: manager,
      grantResolver: () => false,
      leaseResolver: (context) => leases.resolve(context),
    }),
    builtinAgentTools: [observedTool],
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode }),
    // Only the paid CLI is replaced. It speaks the real bridge protocol, so the
    // gateway, governed loader, dispatcher and journal below it are untouched.
    ...(mode === 'host-tool-bridge' ? { cliProviderExecutor: async (_provider, options) => {
      assert.ok(options.mcpBridge, 'A managed CLI question turn must be given its bridge')
      const args = cliPlan.args
      assert.ok(args, 'The CLI plan must name the skill to load')
      await callBridgeTool(options.mcpBridge, 'load_skill', args)
      if (!options.userMessage.includes('Marta')) {
        // The bridge withholds this result until the owner stops the CLI, so
        // this call is expected to end with the turn rather than return.
        await callBridgeTool(options.mcpBridge, 'request_human_input', {
          progress: 'I loaded the checklist.',
          questions: [{ question: 'Who is it for?', reason: 'Required.' }],
        })
      }
      return {
        text: 'Completed for Marta.', model: options.model, cost: 0,
        durationMs: 1, inputTokens: 10, outputTokens: 5, contextTokens: 10,
      }
    } } : {}),
  })
  return { service, root, scope, resolvedPorts, loadOutcomes, toolName: agentTool.tool.namespacedName }
}

async function pauseThenResumeSkill(
  t: TestContext,
  build: (root: string, toolName: string) => {
    readonly script: NonNullable<DeterministicOpenAiServerOptions['script']>
    readonly betweenTurns?: () => void
  },
) {
  const { service, root, scope, resolvedPorts, loadOutcomes, toolName } = await createGovernedBuiltinService(t)
  const plan = build(root, toolName)
  const provider = await startDeterministicOpenAiServer({ script: plan.script })
  t.after(() => provider.close())
  const evidencePath = path.join(root, 'evidence.json')
  const input = {
    ...scope, agentPath: 'agents/analyst', provider: 'lm-studio', model: 'fixture', thinking: 'low' as const,
    providerConfig: { base_url: provider.baseUrl }, systemPrompt: 'Use your skills.',
    userMessage: 'Load the skill then ask.', allowedServerIds: [] as readonly string[],
  }
  const paused = await service.runTurn({
    ...input, signal: AbortSignal.timeout(30_000),
    humanInput: { capture: async (_request, _signal, evidence) => {
      fs.writeFileSync(evidencePath, JSON.stringify(evidence ?? null))
      return { kind: 'awaiting_input', interactionId: 'question-one' }
    } },
  })
  assert.equal(paused.kind, 'awaiting_input', 'The asking turn must pause for the human')
  const evidence = agentQuestionContinuationEvidenceSchema.parse(JSON.parse(fs.readFileSync(evidencePath, 'utf8')))
  plan.betweenTurns?.()
  const completed = await service.runTurn({
    ...input, signal: AbortSignal.timeout(30_000), managedQuestionTurn: true,
    questionAllowanceSpent: true, continuationEvidence: evidence, userMessage: 'Marta.',
  })
  return { completed, evidence, resolvedPorts, loadOutcomes }
}

test('a governed read-only builtin repeated after the answer is not served from the asking turn record', async (t) => {
  const { completed, resolvedPorts, loadOutcomes } = await pauseThenResumeSkill(t, (root, toolName) => {
    const skill = writeSkill(root, 'analysis', '# analysis skill\n\nOriginal checklist.\n')
    return {
      script: [
        { toolName, arguments: { source: skill.source, sha256: skill.sha256 } },
        { toolName: 'request_human_input', arguments: { progress: 'I loaded the checklist.', questions: [{ question: 'Who?', reason: 'Required.' }] } },
        { toolName, arguments: { source: skill.source, sha256: skill.sha256 } },
        { text: 'Completed for Marta.' },
      ],
      // The human edits the very file the agent is about to re-read.
      betweenTurns: () => fs.writeFileSync(skill.source, '# analysis skill\n\nRevised checklist.\n'),
    }
  })

  assert.equal(completed.kind, 'completed')
  assert.ok(resolvedPorts.some(Boolean),
    'No durable authority was consulted, so this journey proves nothing about journal replay')
  assert.equal(loadOutcomes.length, 2, 'Both turns must reach the governed loader')
  assert.equal(loadOutcomes[0]?.ok, true)
  assert.match(String(loadOutcomes[0]?.content), /Original checklist/)
  // Re-running the loader against the edited file must fail its provenance
  // check. Returning the original content instead is the replay.
  // The exact provenance code, not a bare ok:false, which an unrelated dispatch
  // failure could also produce.
  assert.equal(loadOutcomes[1]?.ok, false,
    'A replayed record would hand the resumed turn the content the asking turn read')
  assert.equal(loadOutcomes[1]?.code, 'skill_content_changed',
    'The resumed load must fail its own provenance check against the edited file')
  // The resumed call continues the asking turn's sequence instead of restarting
  // it: one tool call plus the question itself were already spent.
  assert.equal(loadOutcomes[0]?.ordinal, 0)
  assert.equal(loadOutcomes[1]?.ordinal, 2)
})

test('a governed read-only builtin may be called with different arguments after the answer', async (t) => {
  const { completed, resolvedPorts, loadOutcomes } = await pauseThenResumeSkill(t, (root, toolName) => {
    const analysis = writeSkill(root, 'analysis', '# analysis skill\n\nAnalysis checklist.\n')
    const review = writeSkill(root, 'review', '# review skill\n\nReview checklist.\n')
    return {
      script: [
        { toolName, arguments: { source: analysis.source, sha256: analysis.sha256 } },
        { toolName: 'request_human_input', arguments: { progress: 'I loaded analysis.', questions: [{ question: 'Who?', reason: 'Required.' }] } },
        { toolName, arguments: { source: review.source, sha256: review.sha256 } },
        { text: 'Completed for Marta.' },
      ],
    }
  })

  assert.equal(completed.kind, 'completed')
  assert.ok(resolvedPorts.some(Boolean),
    'No durable authority was consulted, so this journey proves nothing about journal replay')
  assert.equal(loadOutcomes.length, 2, 'Both turns must reach the governed loader')
  // Reusing the asking turn's ordinal made this an identity conflict against a
  // record for a different skill, so the resumed load was refused outright.
  assert.equal(loadOutcomes[1]?.ok, true, 'The differently-argued resumed load must be accepted')
  assert.match(String(loadOutcomes[1]?.content), /Review checklist/)
})

/**
 * The CLI lane reaches the same capability boundary through its host bridge
 * rather than the native tool loop, and its call numbering restarts per turn in
 * the same way. This drives a real CLI-shaped continuation: the paid CLI is
 * replaced by a client that speaks the bridge protocol, and everything below it
 * — bridge, gateway, governed loader, dispatcher, journal — is real.
 */
async function callBridgeTool(
  bridge: { readonly url: string; readonly token: string },
  name: string,
  args: Record<string, unknown>,
) {
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { authorization: `Bearer ${bridge.token}` } },
  })
  const client = new Client({ name: 'agent-question-cli-fixture', version: '1.0.0' })
  try {
    await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 10_000 })
    const listed = await client.listTools(undefined, { timeout: 10_000 })
    const tool = listed.tools.find((candidate) => candidate.name.includes(name))
    assert.ok(tool, `The bridge must expose ${name}, saw ${listed.tools.map((entry) => entry.name).join(',')}`)
    return await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: 10_000 })
  } finally {
    await client.close().catch(() => undefined)
  }
}

test('a resumed CLI continuation re-reads through its bridge instead of the asking turn record', async (t) => {
  const cliPlan: CliPlan = {}
  const { service, root, scope, resolvedPorts, loadOutcomes } = await createGovernedBuiltinService(t, 'host-tool-bridge', cliPlan)
  const skill = writeSkill(root, 'analysis', '# analysis skill\n\nOriginal checklist.\n')
  cliPlan.args = { source: skill.source, sha256: skill.sha256 }
  const input = {
    ...scope, agentPath: 'agents/analyst', provider: 'claude', model: 'sonnet', thinking: 'low' as const,
    systemPrompt: 'Use your skills.', userMessage: 'Load the skill then ask.', allowedServerIds: [] as readonly string[],
  }
  const evidenceHolder: { value?: unknown } = {}

  const paused = await service.runTurn({
    ...input, signal: AbortSignal.timeout(30_000),
    humanInput: { capture: async (_request, _signal, evidence) => {
      evidenceHolder.value = evidence
      return { kind: 'awaiting_input', interactionId: 'question-one' }
    } },
  })
  assert.equal(paused.kind, 'awaiting_input', 'The asking CLI turn must pause for the human')
  const evidence = agentQuestionContinuationEvidenceSchema.parse(evidenceHolder.value)
  fs.writeFileSync(skill.source, '# analysis skill\n\nRevised checklist.\n')

  const completed = await service.runTurn({
    ...input, signal: AbortSignal.timeout(30_000), managedQuestionTurn: true,
    questionAllowanceSpent: true, continuationEvidence: evidence, userMessage: 'Marta.',
  })

  assert.equal(completed.kind, 'completed')
  assert.ok(resolvedPorts.some(Boolean),
    'No durable authority was consulted, so this journey proves nothing about journal replay')
  assert.equal(loadOutcomes.length, 2, 'Both CLI turns must reach the governed loader')
  assert.equal(loadOutcomes[1]?.ok, false)
  assert.equal(loadOutcomes[1]?.code, 'skill_content_changed',
    'The resumed CLI load must fail its own provenance check against the edited file')
})
