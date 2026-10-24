import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import type { McpServerInput } from '../../domains/mcp/mcp-settings.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import type {
  ProviderExecuteOptions,
  ProviderResult,
} from '../../providers/types.js'
import {
  McpAgentToolService,
  McpAgentToolServiceError,
} from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const fixtureMcpPath = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)

test('native provider turns escalate a required-server broker denial with its sanitized fatal code', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'provider-required-fatal-')),
  )
  const providerFixture = await startOpenAiToolLoopFixture(process.cwd())
  const clientManager = new McpClientManager({
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  })
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager,
  })
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(root, 'providers.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
  })
  const leaseStore = new McpRunLeaseStore()
  let grantChecks = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager,
    grantResolver: () => {
      grantChecks += 1
      return grantChecks === 1
    },
    leaseResolver: (context) => leaseStore.resolve(context),
  })

  try {
    await settings.saveServer(fixtureServer())
    await settings.validateServer('required-provider-server', {
      stdioTrustAcknowledged: true,
    })
    const connection = await providerSettings.saveConnection({
      kind: 'openai-compatible',
      name: 'Provider required-capability fixture',
      baseUrl: `${providerFixture.url}/v1`,
      apiKey: 'provider-fixture-key',
      enabled: true,
    })
    await providerSettings.validateConnection(connection.id)
    await providerSettings.setModelEnabled(
      connection.id,
      'fixture/tool-loop',
      true,
    )
    const provider = configuredProviderName(connection.id)
    const service = new McpAgentToolService({
      broker,
      leaseStore,
      providerSettingsService: providerSettings,
      providerSupportResolver: () => ({
        provider,
        state: 'supported',
        mode: 'native-tool-loop',
      }),
    })

    await assert.rejects(
      service.runTurn({
        sessionId: 'required-provider-session',
        runId: 'required-provider-run',
        assignmentId: 'required-provider-assignment',
        agentPath: 'agents/required-provider',
        provider,
        model: 'fixture/tool-loop',
        thinking: 'low',
        systemPrompt: 'Call the required marker tool.',
        userMessage: 'Return the marker result.',
        requiredServerGroups: [['required-provider-server']],
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpAgentToolServiceError, String(error))
        assert.equal(error.code, 'tool_not_found')
        assert.equal(error.retryable, false)
        assert.match(error.message, /^(?!.*(provider-fixture-key|provider-loop-marker))/s)
        // The route and phase the chat boundary journals. A fatal broker
        // failure used to arrive with no diagnostics at all, so it was
        // recorded under the default route and `provider-request` — the wrong
        // client and the wrong moment for a tool that failed.
        assert.equal(error.diagnostics?.route, 'mcp-native')
        assert.equal(error.diagnostics?.phase, 'tool-execution')
        assert.equal(error.diagnostics?.layer, 'mcp-service')
        return true
      },
    )
    assert.ok(grantChecks >= 2)
    assert.equal(leaseStore.size, 0)
  } finally {
    await Promise.allSettled([
      settings.closeAll(),
      providerFixture.close(),
    ])
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('CLI provider turns escalate a required-server broker denial with its sanitized fatal code', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'provider-required-cli-fatal-')),
  )
  const clientManager = new McpClientManager({
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  })
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager,
  })
  const leaseStore = new McpRunLeaseStore()
  let grantChecks = 0
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager,
    grantResolver: () => {
      grantChecks += 1
      return grantChecks === 1
    },
    leaseResolver: (context) => leaseStore.resolve(context),
  })
  const executeCliProvider = async (
    _provider: string,
    options: ProviderExecuteOptions,
  ): Promise<ProviderResult> => {
    assert.ok(options.mcpBridge)
    const transport = new StreamableHTTPClientTransport(
      new URL(options.mcpBridge.url),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${options.mcpBridge.token}`,
          },
        },
      },
    )
    const client = new Client({
      name: 'required-capability-cli-fixture',
      version: '1.0.0',
    })
    try {
      await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 2_000 })
      const listed = await client.listTools(undefined, { timeout: 2_000 })
      const toolName = listed.tools[0]?.name
      assert.ok(toolName)
      await client.callTool(
        { name: toolName, arguments: { marker: 'cli-required-marker' } },
        undefined,
        { timeout: 2_000 },
      )
      return {
        text: 'CLI provider observed the rejected tool result.',
        model: options.model,
        cost: 0,
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        contextTokens: 2,
      }
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  try {
    await settings.saveServer(fixtureServer())
    await settings.validateServer('required-provider-server', {
      stdioTrustAcknowledged: true,
    })
    const service = new McpAgentToolService({
      broker,
      leaseStore,
      providerSettingsService: new ProviderSettingsService({
        storagePath: path.join(root, 'providers.json'),
      }),
      providerSupportResolver: () => ({
        provider: 'codex',
        state: 'supported',
        mode: 'host-tool-bridge',
      }),
      cliProviderExecutor: executeCliProvider,
    })

    await assert.rejects(
      service.runTurn({
        sessionId: 'required-cli-session',
        runId: 'required-cli-run',
        assignmentId: 'required-cli-assignment',
        agentPath: 'agents/required-cli-provider',
        provider: 'codex',
        model: 'gpt-test',
        thinking: 'low',
        cwd: root,
        systemPrompt: 'Call the required marker tool.',
        userMessage: 'Return the marker result.',
        requiredServerGroups: [['required-provider-server']],
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpAgentToolServiceError, String(error))
        assert.equal(error.code, 'tool_not_found')
        assert.equal(error.retryable, false)
        assert.equal(/cli-required-marker/.test(error.message), false)
        // A CLI tool execution is journaled as one: on the CLI route, in the
        // tool-execution phase, not as a native provider request.
        assert.equal(error.diagnostics?.route, 'mcp-cli')
        assert.equal(error.diagnostics?.phase, 'tool-execution')
        assert.equal(error.diagnostics?.layer, 'mcp-service')
        return true
      },
    )
    assert.ok(grantChecks >= 2)
    assert.equal(leaseStore.size, 0)
  } finally {
    await settings.closeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixtureServer(): McpServerInput {
  return {
    id: 'required-provider-server',
    name: 'Required provider server',
    enabled: true,
    capabilityAliases: [{ capability: 'marker.echo', access: 'read' }],
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [fixtureMcpPath],
      cwd: process.cwd(),
      secretEnvironment: {},
    },
  }
}
