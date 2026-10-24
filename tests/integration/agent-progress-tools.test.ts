import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type { AgentProgressUpdate } from '../../contracts/agent-progress.js'

function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('observed tool progress brackets a real tool call while its result is pending', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-tools-'))
  await fs.writeFile(path.join(directory, 'source.txt'), 'Real fixture evidence.')
  const started = gate()
  const finish = gate()
  const manager = new McpClientManager()
  const settings = new McpSettingsService({ storagePath: path.join(directory, 'mcps.json'), clientManager: manager, secretCodec: { encrypt: value => value, decrypt: value => value } })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({ lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE, settingsService: settings, clientManager: manager, grantResolver: () => false, leaseResolver: context => leases.resolve(context) })
  const updates: AgentProgressUpdate[] = []
  const service = new McpAgentToolService({ broker, leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({ storagePath: path.join(directory, 'providers.json') }),
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode: 'host-tool-bridge' }),
    builtinAgentTools: [{ name: 'inspect_fixture', isEnabledForAgent: () => true,
      tool: { serverId: 'fixture', serverName: 'Fixture', toolName: 'inspect_fixture', namespacedName: 'inspect_fixture', description: 'Read fixture evidence.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, risk: 'read-only', effect: serialCapabilityEffect('read-only'), requiresApproval: false },
      async execute() { started.release(); await finish.promise; const content = await fs.readFile(path.join(directory, 'source.txt'), 'utf8'); return { output: content, content, isError: false } },
    }],
    // Substitute only the paid CLI boundary; the real MCP transport and filesystem tool run.
    cliProviderExecutor: async (_provider, options) => {
      assert.ok(options.mcpBridge)
      const name = options.mcpBridge.proxyToolNames[0]
      assert.ok(name)
      const client = new Client({ name: 'tool-progress-fixture', version: '1' })
      try {
        await client.connect(new ExactOptionalMcpTransport(new StreamableHTTPClientTransport(new URL(options.mcpBridge.url), { requestInit: { headers: { authorization: `Bearer ${options.mcpBridge.token}` } } })), { timeout: 2000 })
        const response = await client.callTool({ name, arguments: {} }, undefined, { timeout: 2000 })
        assert.notEqual(response.isError, true)
      } finally { await client.close() }
      return { text: 'Done.', model: options.model, inputTokens: 1, outputTokens: 1, contextTokens: 2, cost: 0, durationMs: 1 }
    },
  })
  const operation = service.runTurn({ sessionId: 'session', runId: 'turn', assignmentId: 'assignment', agentPath: 'agents/analyst', provider: 'claude', model: 'opus', thinking: 'low', cwd: directory, systemPrompt: 'Read evidence.', userMessage: 'Work.', onProgress: update => updates.push(update) })
  try {
    await started.promise
    assert.deepEqual(updates, [{ kind: 'observed', phase: 'tool', toolName: 'inspect_fixture' }])
    finish.release()
    await operation
    assert.deepEqual(updates, [{ kind: 'observed', phase: 'tool', toolName: 'inspect_fixture' }, { kind: 'observed', phase: 'waiting' }])
  } finally { finish.release(); await operation; await settings.closeAll(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('a tool call that throws does not leave the row showing the tool as running', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-tools-'))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({ storagePath: path.join(directory, 'mcps.json'), clientManager: manager, secretCodec: { encrypt: value => value, decrypt: value => value } })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({ lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE, settingsService: settings, clientManager: manager, grantResolver: () => false, leaseResolver: context => leases.resolve(context) })
  const updates: AgentProgressUpdate[] = []
  const service = new McpAgentToolService({ broker, leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({ storagePath: path.join(directory, 'providers.json') }),
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode: 'host-tool-bridge' }),
    builtinAgentTools: [{ name: 'inspect_fixture', isEnabledForAgent: () => true,
      tool: { serverId: 'fixture', serverName: 'Fixture', toolName: 'inspect_fixture', namespacedName: 'inspect_fixture', description: 'Read fixture evidence.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, risk: 'read-only', effect: serialCapabilityEffect('read-only'), requiresApproval: false },
      async execute() { throw new Error('Fixture tool failed.') },
    }],
    // Substitute only the paid CLI boundary; the real MCP transport runs.
    cliProviderExecutor: async (_provider, options) => {
      assert.ok(options.mcpBridge)
      const name = options.mcpBridge.proxyToolNames[0]
      assert.ok(name)
      const client = new Client({ name: 'tool-progress-fixture', version: '1' })
      try {
        await client.connect(new ExactOptionalMcpTransport(new StreamableHTTPClientTransport(new URL(options.mcpBridge.url), { requestInit: { headers: { authorization: `Bearer ${options.mcpBridge.token}` } } })), { timeout: 2000 })
        const response = await client.callTool({ name, arguments: {} }, undefined, { timeout: 2000 })
        assert.equal(response.isError, true)
      } finally { await client.close() }
      return { text: 'Done.', model: options.model, inputTokens: 1, outputTokens: 1, contextTokens: 2, cost: 0, durationMs: 1 }
    },
  })
  try {
    await service.runTurn({ sessionId: 'session', runId: 'turn', assignmentId: 'assignment', agentPath: 'agents/analyst', provider: 'claude', model: 'opus', thinking: 'low', cwd: directory, systemPrompt: 'Read evidence.', userMessage: 'Work.', onProgress: update => updates.push(update) })
    assert.deepEqual(updates, [{ kind: 'observed', phase: 'tool', toolName: 'inspect_fixture' }, { kind: 'observed', phase: 'waiting' }])
  } finally { await settings.closeAll(); await fs.rm(directory, { recursive: true, force: true }) }
})
