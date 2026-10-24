import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMcpProviderSupportResolver,
  hasMcpProviderAdapter,
  mcpProviderSupportReason,
  type McpProviderConnectionReader,
} from '../../domains/mcp/mcp-provider-support.js'
import type { LocalCliAgentView } from '../../domains/provider/provider-settings.js'

test('question decisions are offered only on providers with a managed adapter', () => {
  assert.equal(hasMcpProviderAdapter('pi'), false)
  assert.equal(hasMcpProviderAdapter('anthropic'), false)
  assert.equal(hasMcpProviderAdapter('unknown'), false)
  assert.equal(hasMcpProviderAdapter('openai'), true)
  assert.equal(hasMcpProviderAdapter('claude'), true)
  assert.equal(hasMcpProviderAdapter('codex'), true)
  assert.equal(hasMcpProviderAdapter('connection:fixture'), true)
})

test('CLI MCP support uses the host bridge only for ready Codex, Claude, and Kimi CLIs', async () => {
  for (const provider of ['codex', 'claude', 'kimi-cli']) {
    const resolver = createMcpProviderSupportResolver(
      readerWithCli(cliAgent(provider)),
    )
    assert.deepEqual(await resolver({ provider, model: 'fixture-model' }), {
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    })
    assert.deepEqual(await resolver({ provider, model: 'default' }), {
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    })
  }
})

test('CLI MCP support reports explicit readiness failures', async () => {
  const cases: Array<{
    name: string
    agent: LocalCliAgentView | undefined
    model?: string
    reasonCode: string
    reason: RegExp
  }> = [
    {
      name: 'missing executable',
      agent: cliAgent('codex', { available: false }),
      reasonCode: 'cli_unavailable',
      reason: /Codex CLI is not installed/i,
    },
    {
      name: 'disabled CLI',
      agent: cliAgent('codex', { enabled: false }),
      reasonCode: 'cli_disabled',
      reason: /Enable Codex CLI in AI Providers/i,
    },
    {
      name: 'disabled model',
      agent: cliAgent('codex', {
        models: [{ id: 'gpt-disabled', name: 'Disabled model', enabled: false }],
      }),
      model: 'gpt-disabled',
      reasonCode: 'cli_model_unavailable',
      reason: /configured Codex CLI model/i,
    },
    {
      name: 'missing bridge flags',
      agent: cliAgent('codex', {
        mcpBridge: {
          supported: false,
          reasonCode: 'cli_mcp_config_unsupported',
        },
      }),
      reasonCode: 'cli_mcp_config_unsupported',
      reason: /supports isolated MCP configuration/i,
    },
    {
      name: 'unsafe executable tools',
      agent: cliAgent('kimi-cli', {
        mcpBridge: {
          supported: false,
          reasonCode: 'cli_tool_isolation_unsupported',
        },
      }),
      reasonCode: 'cli_tool_isolation_unsupported',
      reason: /cannot safely isolate Pipeline MCP tools/i,
    },
    {
      name: 'failed capability probe',
      agent: cliAgent('claude', {
        mcpBridge: {
          supported: false,
          reasonCode: 'cli_mcp_bridge_unavailable',
        },
      }),
      reasonCode: 'cli_mcp_bridge_unavailable',
      reason: /could not be checked/i,
    },
  ]

  for (const entry of cases) {
    const provider = entry.agent?.id ?? 'codex'
    const resolver = createMcpProviderSupportResolver(
      readerWithCli(entry.agent),
    )
    const support = await resolver({
      provider,
      model: entry.model ?? 'default',
    })
    assert.equal(support.state, 'unsupported', entry.name)
    assert.equal(support.reasonCode, entry.reasonCode, entry.name)
    assert.match(mcpProviderSupportReason(support) ?? '', entry.reason, entry.name)
  }
})

test('CLI MCP support treats default as the CLI-selected model alias', async () => {
  const resolver = createMcpProviderSupportResolver(
    readerWithCli(cliAgent('codex', {
      models: [
        { id: 'default', name: 'Default model', enabled: false },
        { id: 'gpt-5.5', name: 'GPT-5.5', enabled: true },
      ],
    }), { provider: 'codex', model: 'gpt-5.5' }),
  )

  assert.deepEqual(await resolver({ provider: 'codex', model: 'default' }), {
    provider: 'codex',
    state: 'supported',
    mode: 'host-tool-bridge',
    resolvedModel: 'gpt-5.5',
  })
})

test('CLI MCP support fails closed when default has no enabled concrete selection', async () => {
  const resolver = createMcpProviderSupportResolver(
    readerWithCli(cliAgent('codex', {
      models: [{ id: 'default', name: 'Default model', enabled: false }],
    }), null),
  )

  assert.equal(
    (await resolver({ provider: 'codex', model: 'default' })).reasonCode,
    'cli_model_unavailable',
  )
})

test('CLI MCP support fails closed when readiness cannot be read', async () => {
  const noCliReader = createMcpProviderSupportResolver({
    listConnections: async () => [],
  })
  assert.equal(
    (await noCliReader({ provider: 'codex', model: 'default' })).reasonCode,
    'cli_mcp_bridge_unavailable',
  )

  const failingReader = createMcpProviderSupportResolver({
    listConnections: async () => [],
    listCliAgents: async () => {
      throw new Error('probe failed')
    },
  })
  assert.equal(
    (await failingReader({ provider: 'claude', model: 'default' })).reasonCode,
    'cli_mcp_bridge_unavailable',
  )
})

function readerWithCli(
  agent: LocalCliAgentView | undefined,
  defaultModel: { provider: string; model: string } | null = agent
    ? { provider: agent.id, model: 'fixture-model' }
    : null,
): McpProviderConnectionReader {
  return {
    listConnections: async () => [],
    listCliAgents: async () => agent ? [agent] : [],
    snapshot: async () => ({
      connections: [],
      cliAgents: agent ? [agent] : [],
      catalog: [],
      defaultModel,
      defaultModelState: defaultModel
        ? { status: 'available' as const, ...defaultModel }
        : { status: 'unset' as const },
      effortCapabilities: [],
      defaultEffort: 'medium' as const,
    }),
  }
}

function cliAgent(
  id: string,
  overrides: Partial<LocalCliAgentView> = {},
): LocalCliAgentView {
  return {
    id,
    name: id,
    command: id === 'kimi-cli' ? 'kimi' : id,
    available: true,
    enabled: true,
    path: `/fixture/${id}`,
    models: [
      { id: 'default', name: 'Default model', enabled: true },
      { id: 'fixture-model', name: 'Fixture model', enabled: true },
    ],
    mcpBridge: { supported: true },
    ...overrides,
  }
}
