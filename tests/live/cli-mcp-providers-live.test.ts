import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import {
  executeProvider,
  getProvider,
  initProviders,
} from '../../providers/index.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { startMcpCliHostBridge } from '../../domains/mcp/mcp-cli-host-bridge.js'
import {
  classifyMcpToolRisk,
  mcpToolRequiresApproval,
  namespaceMcpToolName,
  type McpNamespacedTool,
} from '../../domains/mcp/mcp-runtime.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import {
  cliCapability,
  createLiveSecretCodec,
  createLiveTempDirectory,
  liveTest,
} from './live-provider-support.js'

initProviders()

const repoRoot = process.cwd()
const mcpFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)
const providers = [
  { id: 'codex', command: 'codex', marker: 'CODEX_CLI_MCP_LIVE_OK' },
  { id: 'claude', command: 'claude', marker: 'CLAUDE_CLI_MCP_LIVE_OK' },
  { id: 'kimi-cli', command: 'kimi', marker: 'KIMI_CLI_MCP_LIVE_OK' },
] as const

const capabilities = new Map(
  await Promise.all(
    providers.map(async (provider) => [
      provider.id,
      await cliCapability(provider.command),
    ] as const),
  ),
)

for (const provider of providers) {
  const configuredModel = process.env[
    `PIPELINE_LIVE_${provider.id.replaceAll('-', '_').toUpperCase()}_MODEL`
  ]?.trim() || 'default'
  liveTest(
    `${provider.id} performs a real MCP tool call through the Pipeline bridge`,
    provider.id,
    capabilities.get(provider.id)!,
    async () => {
      const directory = createLiveTempDirectory(`${provider.id}-mcp-live-`)
      const callsPath = path.join(directory, 'calls.jsonl')
      const responseMarker = `${provider.marker}_TOOL_RESULT`
      const manager = new McpClientManager({
        connectTimeoutMs: 5_000,
        requestTimeoutMs: 30_000,
        closeTimeoutMs: 2_000,
      })
      const settings = new McpSettingsService({
        storagePath: path.join(directory, 'mcps.json'),
        secretCodec: createLiveSecretCodec(),
        clientManager: manager,
      })
      const providerSettings = new ProviderSettingsService({
        storagePath: path.join(directory, 'providers.json'),
      })
      const leases = new McpRunLeaseStore()
      const broker = new McpParentBroker({
        lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
        settingsService: settings,
        clientManager: manager,
        grantResolver: ({ context, serverId }) =>
          settings.isAgentGranted(context.agentPath, serverId),
        leaseResolver: (context) => leases.resolve(context),
      })

      try {
        await settings.saveServer({
          id: 'live-cli-tool',
          name: 'Live CLI tool',
          capabilityAliases: [],
          transport: {
            type: 'stdio',
            command: process.execPath,
            args: [mcpFixturePath],
            cwd: repoRoot,
            secretEnvironment: {
              MCP_FIXTURE_CALLS_PATH: {
                operation: 'replace',
                value: callsPath,
              },
              MCP_FIXTURE_RESPONSE_MARKER: {
                operation: 'replace',
                value: responseMarker,
              },
            },
          },
        })
        await settings.validateServer('live-cli-tool', {
          stdioTrustAcknowledged: true,
        })
        const agentPath = `agents/live-${provider.id}`
        await settings.setAgentGrant(agentPath, 'live-cli-tool', true)

        if (configuredModel !== 'default') {
          const discovered = (await providerSettings.listCliAgents(true)).find(
            (candidate) => candidate.id === provider.id,
          )
          assert.ok(
            discovered?.models.some((model) => model.id === configuredModel),
            `${provider.id} did not advertise model ${configuredModel}`,
          )
          await providerSettings.setCliModelEnabled(
            provider.id,
            configuredModel,
            true,
          )
        }

        const readiness = (await providerSettings.listCliAgents(true)).find(
          (candidate) => candidate.id === provider.id,
        )
        assert.equal(readiness?.mcpBridge.supported, true, readiness?.error)

        let cliFailure: unknown
        const service = new McpAgentToolService({
          broker,
          leaseStore: leases,
          providerSettingsService: providerSettings,
          cliProviderExecutor: async (providerId, options) => {
            try {
              return await executeProvider(getProvider(providerId), options)
            } catch (error) {
              cliFailure = error
              throw error
            }
          },
        })
        let result
        try {
          result = await service.runTurn({
            sessionId: '11111111-1111-4111-8111-111111111111',
            runId: '22222222-2222-4222-8222-222222222222',
            assignmentId: '33333333-3333-4333-8333-333333333333',
            agentPath,
            provider: provider.id,
            model: configuredModel,
            thinking: 'medium',
            cwd: directory,
            systemPrompt: [
              'You have exactly one MCP tool available.',
              'Call it once with the marker requested by the user.',
              'After the tool returns, reply with the returned marker text only.',
            ].join(' '),
            userMessage: `Call the tool with marker ${provider.marker}.`,
            signal: AbortSignal.timeout(180_000),
          })
        } catch (error) {
          if (cliFailure instanceof Error) {
            throw new Error(cliFailure.message, { cause: error })
          }
          throw error
        }

        assert.equal(result.kind, 'completed')
        if (result.kind !== 'completed') return
        assert.equal(
          result.result.toolCallCount,
          1,
          `provider response: ${result.result.text}`,
        )
        assert.equal(
          result.result.executedToolCallCount,
          1,
          `provider response: ${result.result.text}`,
        )
        assert.match(fs.readFileSync(callsPath, 'utf8'), new RegExp(provider.marker))
        assert.ok(result.result.text.trim().length > 0)
        assert.equal(leases.size, 0)

        if (provider.id === 'codex') {
          const discovery = await service.runTurn({
            sessionId: '44444444-4444-4444-8444-444444444444',
            runId: '55555555-5555-4555-8555-555555555555',
            assignmentId: '66666666-6666-4666-8666-666666666666',
            agentPath,
            provider: provider.id,
            model: configuredModel,
            thinking: 'low',
            cwd: directory,
            systemPrompt: [
              'Answer the user directly.',
              'Do not call an MCP tool when the user only asks what is available.',
            ].join(' '),
            userMessage: 'What MCP tools do you have access to?',
            signal: AbortSignal.timeout(180_000),
          })
          assert.equal(discovery.kind, 'completed')
          if (discovery.kind === 'completed') {
            assert.match(discovery.result.text, /echo[-_]marker/i)
            assert.equal(discovery.result.toolCallCount, 0)
            assert.equal(discovery.result.executedToolCallCount, 0)
          }
          assert.equal(
            fs.readFileSync(callsPath, 'utf8').trim().split('\n').length,
            1,
          )
          assert.equal(leases.size, 0)
        }
      } finally {
        await settings.closeAll().catch(() => undefined)
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
    240_000,
  )
}

liveTest(
  'codex MCP mode cannot mutate the assignment through native file tools',
  'codex',
  capabilities.get('codex')!,
  async () => {
    const directory = createLiveTempDirectory('codex-mcp-read-only-live-')
    const markerPath = path.join(directory, 'native-write-marker.txt')
    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    } as const
    const risk = classifyMcpToolRisk(annotations)
    const tool: McpNamespacedTool = {
      serverId: 'read-only-proof',
      serverName: 'Read-only proof',
      toolName: 'noop',
      namespacedName: namespaceMcpToolName('read-only-proof', 'noop'),
      description: 'Returns a fixed marker without changing state.',
      inputSchema: { type: 'object', additionalProperties: false },
      annotations,
      risk,
      effect: serialCapabilityEffect('read-only'),
      requiresApproval: mcpToolRequiresApproval(risk),
    }
    const bridge = await startMcpCliHostBridge({
      tools: [tool],
      callTool: async () => ({ content: 'noop' }),
    })

    try {
      await executeProvider(getProvider('codex'), {
        systemPrompt: [
          'Do not call the MCP tool.',
          'Attempt the requested native file operation, then report whether it succeeded.',
        ].join(' '),
        userMessage: `Create ${markerPath} with the exact text WRITE_SUCCEEDED.`,
        model: 'default',
        thinking: 'low',
        cwd: directory,
        providerConfig: { sandbox: 'danger-full-access' },
        signal: AbortSignal.timeout(180_000),
        mcpBridge: {
          url: bridge.url,
          tokenEnvironmentVariable: 'PIPELINE_MCP_CLI_BRIDGE_TOKEN',
          token: bridge.bearerToken,
          proxyToolNames: [...bridge.toolMappings.keys()],
        },
      })
      assert.equal(fs.existsSync(markerPath), false)
      assert.equal(bridge.getCounters().toolCallsStarted, 0)
    } finally {
      await bridge.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  240_000,
)
