/**
 * Which of an Agent's settings survive a turn that goes through MCP.
 *
 * This service is two lanes wearing one name
 * (`services/mcp-agent-tool-service.ts:478-531`). A CLI host bridge hands the
 * settings to the CLI, which applies the ones it understands. The native Chat
 * Completions tool loop builds a request body of model, messages, tools and
 * tool choice and nothing else
 * (`domains/provider/openai-chat-completions-tool-adapter.ts:137-149`), so no
 * setting reaches the provider on that lane at all.
 *
 * Which lane a turn takes is decided here, from the provider's support mode —
 * so this is the only place that can say which settings a turn will really
 * apply. Deciding it in the caller would mean two lookups that can disagree,
 * and a turn reporting a setting as in force on a lane that never sends it.
 *
 * The reporting is the point. A setting that quietly stops applying is
 * indistinguishable, to a person reading a reply, from a provider that ignored
 * it — so a turn that drops one has to say which.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import {
  McpAgentToolService,
  McpAgentToolServiceError,
} from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import type { ProviderExecuteOptions } from '../../providers/types.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { createDocumentToolAdapters } from '../../services/document-tool-adapters.js'
import { createDocumentSource } from '../../domains/document-access/document-source.js'

test('an admitted document turn refuses an aggregate request beyond its model budget', async () => {
  const harness = await makeHarness('native-tool-loop')
  try {
    await assert.rejects(harness.service.runTurn({ ...turn, provider: harness.provider, model: harness.model, userMessage: '匹'.repeat(100_000), documentSources: [createDocumentSource({ owner: 'owner', name: 'source.md', text: 'reference' })] }), /document request budget/i)
  } finally { await harness.cleanup() }
})

const repoRoot = process.cwd()
const MCP_FIXTURE_PATH = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)
const SERVER_ID = 'options-tools'
const AGENT_PATH = 'agents/optionswriter'

interface Harness {
  readonly service: McpAgentToolService
  readonly cliCalls: ProviderExecuteOptions[]
  readonly provider: string
  readonly model: string
  /** The loopback the native lane talks to, for the endpoint case below. */
  readonly baseUrl: string
  cleanup(): Promise<void>
}

/**
 * A turn that really has tools.
 *
 * Without a granted server `runTurn` answers `no-tools` before either lane is
 * chosen (`services/mcp-agent-tool-service.ts:366-372`), so a fixture with no
 * grant proves nothing about settings — the CLI would simply never be called.
 * A real stdio server, really granted, is what makes the lane the thing under
 * test. The direct fall-through for a turn that genuinely has no tools is
 * deliberately left alone.
 */
async function makeHarness(
  mode: 'host-tool-bridge' | 'native-tool-loop',
  nativeFixture?: { url: string; close(): Promise<void> },
): Promise<Harness> {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-tool-options-')),
  )
  const codec = {
    encrypt: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
  }
  const manager = new McpClientManager({
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    closeTimeoutMs: 1_000,
  })
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: codec,
    clientManager: manager,
  })
  await settings.saveServer({
    id: SERVER_ID,
    name: 'Options tools',
    capabilityAliases: [{ capability: 'marker.echo', access: 'read' }],
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [MCP_FIXTURE_PATH],
      cwd: repoRoot,
      secretEnvironment: {
        MCP_FIXTURE_CALLS_PATH: {
          operation: 'replace',
          value: path.join(root, 'calls.jsonl'),
        },
      },
    },
  })
  await settings.validateServer(SERVER_ID, { stdioTrustAcknowledged: true })
  await settings.setAgentGrant(AGENT_PATH, SERVER_ID, true)

  const leases = new McpRunLeaseStore()
  // With a codec. Saving a connection without one throws
  // ('Secure credential storage is unavailable outside the desktop app'), and
  // it would throw *after* the fixture children are running.
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(root, 'providers.json'),
    secretCodec: codec,
  })
  const cliCalls: ProviderExecuteOptions[] = []

  // The native lane needs somewhere real to send its request. A loopback tool
  // loop, not a production endpoint and no production credential.
  const providerFixture =
    mode === 'native-tool-loop'
      ? nativeFixture ?? await startOpenAiToolLoopFixture(repoRoot)
      : undefined
  let provider = 'kimi-cli'
  let model = 'default'
  let baseUrl = ''
  try {
  if (providerFixture) {
    const connection = await providerSettings.saveConnection({
      kind: 'openai-compatible',
      name: 'Options loopback',
      baseUrl: `${providerFixture.url}/v1`,
      apiKey: 'options-secret',
      enabled: true,
    })
    await providerSettings.validateConnection(connection.id)
    await providerSettings.setModelEnabled(connection.id, 'fixture/tool-loop', true)
    provider = `connection:${connection.id}`
    model = 'fixture/tool-loop'
    baseUrl = `${providerFixture.url}/v1`
  }
  } catch (error) {
    // A setup failure past this point owns a running MCP server and a running
    // loopback provider, and the caller has no `finally` yet — so releasing
    // them is this function's job, and the original failure is what the reader
    // needs to see.
    await providerFixture?.close().catch(() => undefined)
    await manager.closeAll?.().catch(() => undefined)
    fs.rmSync(root, { recursive: true, force: true })
    throw error
  }

  const service = new McpAgentToolService({
    broker: new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: settings,
      clientManager: settings.getBrokerClientManager(),
      grantResolver: ({ context, serverId }) =>
        settings.isAgentGranted(context.agentPath, serverId),
      leaseResolver: (context) => leases.resolve(context),
    }),
    leaseStore: leases,
    providerSettingsService: providerSettings,
    providerSupportResolver: ({ provider: candidate }) => ({
      provider: candidate,
      state: 'supported',
      mode,
    }),
    cliProviderExecutor: async (_provider, options) => {
      cliCalls.push(options)
      return {
        text: 'Answered.',
        model: options.model,
        cost: 0,
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        contextTokens: 2,
      }
    },
  })
  return {
    service,
    cliCalls,
    provider,
    model,
    baseUrl,
    cleanup: async () => {
      await providerFixture?.close().catch(() => undefined)
      await manager.closeAll?.().catch(() => undefined)
      fs.rmSync(root, { recursive: true, force: true })
    },
  } as Harness
}

const turn = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  assignmentId: 'child-options-1',
  taskId: '22222222-2222-4222-8222-222222222222',
  workflowId: 'options-workflow',
  workflowStepId: 'options-step',
  agentPath: AGENT_PATH,
  thinking: 'medium' as const,
  systemPrompt: 'Answer.',
  userMessage: 'A question.',
  allowedServerIds: [SERVER_ID] as readonly string[],
  requiredServerGroups: [] as readonly (readonly string[])[],
}

test('a CLI host bridge turn receives the setting its CLI applies, and names the rest', async () => {
  const harness = await makeHarness('host-tool-bridge')
  try {
    const result = await harness.service.runTurn({
      ...turn,
      provider: harness.provider,
      model: harness.model,
      // One setting this CLI applies (`providers/kimi-cli.ts:135-137`) and one
      // it has no argument for.
      providerConfig: { max_steps_per_turn: 12, max_tokens: 4_096 },
    })

    assert.equal(result.kind, 'completed', JSON.stringify(result))
    assert.equal(harness.cliCalls.length, 1, 'the CLI lane ran the turn')
    assert.deepEqual(
      harness.cliCalls[0]?.providerConfig,
      { max_steps_per_turn: 12 },
      'the setting the CLI applies reaches it',
    )
    assert.deepEqual(
      'droppedProviderOptions' in result
        ? result.droppedProviderOptions
        : undefined,
      ['max_tokens'],
      'and the turn names the one that does not apply here',
    )
  } finally {
    await harness.cleanup()
  }
})

test('a native tool-loop turn applies no settings, and says so', async () => {
  // Nothing behavioural reaches this lane's request body, so every setting an
  // Agent wrote is one that stopped applying — and the turn has to say which,
  // rather than leaving a person to compare replies and guess.
  const harness = await makeHarness('native-tool-loop')
  try {
    const result = await harness.service.runTurn({
      ...turn,
      provider: harness.provider,
      model: harness.model,
      providerConfig: { max_tokens: 4_096, temperature: 0.2 },
    })

    assert.equal(result.kind, 'completed', JSON.stringify(result))
    assert.equal(harness.cliCalls.length, 0, 'this lane is not the CLI bridge')
    assert.deepEqual(
      'droppedProviderOptions' in result
        ? result.droppedProviderOptions
        : undefined,
      ['max_tokens', 'temperature'],
      'the settings this lane cannot carry are named',
    )
  } finally {
    await harness.cleanup()
  }
})

test('a setting this lane still uses is not reported as dropped', async () => {
  // `base_url` is not a behavioural setting and this decision is not about it:
  // the native lane resolves its target from the Agent's own config, so the
  // endpoint is used, not dropped. Reporting it would tell a person a setting
  // stopped applying when it did not — and the fix for that must not be to
  // start dropping it, because endpoint and permission ownership on the
  // ordinary path is deliberately unchanged.
  //
  // Exercised through `lm-studio` rather than a configured connection, because
  // a connection's target comes from Settings before `providerConfig.base_url`
  // is read at all (`domains/mcp/mcp-provider-tool-target.ts:29-36`) — so a
  // connection would prove nothing about the Agent-owned value. Here the
  // loopback is only reachable *because* that value is honoured.
  const harness = await makeHarness('native-tool-loop')
  try {
    const result = await harness.service.runTurn({
      ...turn,
      provider: 'lm-studio',
      model: 'fixture/tool-loop',
      providerConfig: { base_url: harness.baseUrl, max_tokens: 4_096 },
    })

    assert.equal(result.kind, 'completed', JSON.stringify(result))
    assert.deepEqual(
      'droppedProviderOptions' in result
        ? result.droppedProviderOptions
        : undefined,
      ['max_tokens'],
      'only the behavioural setting this lane cannot carry is named',
    )
  } finally {
    await harness.cleanup()
  }
})

test('a turn that fails after its lane was chosen still says what it dropped', async () => {
  // The decision is made once the lane is known, which is before the provider
  // is called — so a turn that then fails has already dropped the settings.
  // Reporting them only on success would mean the one outcome where a person
  // most needs the explanation is the outcome that withholds it.
  //
  // Cancellation is a different boundary and is not claimed here: an abort
  // throws before this point, and immediate cancellation is deliberately left
  // untouched.
  const harness = await makeHarness('native-tool-loop')
  try {
    await assert.rejects(
      harness.service.runTurn({
        ...turn,
        provider: harness.provider,
        // A model this loopback has no script for, so the provider request
        // fails after the lane and its settings decision.
        model: 'fixture/error',
        providerConfig: { max_tokens: 4_096, temperature: 0.2 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpAgentToolServiceError)
        assert.deepEqual(
          error.diagnostics?.droppedProviderOptions,
          ['max_tokens', 'temperature'],
          'the failure carries the decision the lane had already made',
        )
        return true
      },
    )
  } finally {
    await harness.cleanup()
  }
})


test('accumulated document tool results are refused as an invalid oversized request before another provider round', async () => {
  const document = createDocumentSource({ owner: 'owner', name: 'source.md', text: '<'.repeat(20_000) });
  // Only the paid model's HTTP boundary is replaced.
  const model = await startFakeChatCompletionsServer({ models: ['fixture/tool-loop'], script: [{ toolCalls: Array.from({ length: 8 }, (_, index) => ({ id: `read-${index}`, name: 'document_read', arguments: { document: document.id, offset: 0 } })) }, { content: 'Unexpected second request.' }] });
  const harness = await makeHarness('native-tool-loop', model);
  try {
    await assert.rejects(harness.service.runTurn({ ...turn, provider: harness.provider, model: harness.model, userMessage: '匹'.repeat(70_000), documentSources: [document], turnBuiltinAgentTools: createDocumentToolAdapters({ scope: { sessionId: turn.sessionId, runId: turn.runId }, documents: [document] }) }), (error: unknown) => {
      assert.ok(error instanceof McpAgentToolServiceError);
      assert.equal(error.code, 'invalid_request');
      return true;
    });
    assert.equal(model.requests.length, 1, 'The initial request fits; accumulated tool results must prevent the second request');
  } finally { await harness.cleanup() }
});
