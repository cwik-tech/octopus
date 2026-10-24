import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { createMcpProviderSupportResolver } from '../../domains/mcp/mcp-provider-support.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { buildToolRegistry, providerAgentTools } from '../../server/tools/tool-registry.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'

for (const provider of ['codex', 'claude', 'kimi-cli']) {
  test(`${provider} creates and returns a text artifact through the shared MCP bridge`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-bridge-')))
    const workspacePath = path.join(root, 'workspace')
    const identity = { sessionId: 'session-files', runId: 'run-files', assignmentId: 'assignment-files' }
    const location = buildSessionRunAssignmentLocation(workspacePath, identity)
    assert.ok(location)
    await fs.mkdir(location.assignmentPath, { recursive: true })
    const leases = new McpRunLeaseStore()
    const runtime = new CapabilityDispatchRuntime({
      workspacePath, leaseResolver: (context) => leases.resolve(context),
      runtimeAuthority: { authorize: async () => { throw new Error('This test requires MCP lease authority.') } },
    })
    const manager = new McpClientManager()
    const settings = new McpSettingsService({
      storagePath: path.join(root, 'mcps.json'), clientManager: manager,
      secretCodec: { encrypt: (value) => value, decrypt: (value) => value },
    })
    const broker = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: settings, clientManager: manager,
      grantResolver: () => false, leaseResolver: (context) => leases.resolve(context),
    })
    const service = new McpAgentToolService({
      broker, leaseStore: leases,
      providerSettingsService: new ProviderSettingsService({ storagePath: path.join(root, 'providers.json') }),
      // Paid model execution and machine-specific CLI discovery are replaced.
      // The support resolver, authenticated MCP transport, leases, capability
      // dispatcher, artifact collection and filesystem are production code.
      providerSupportResolver: createMcpProviderSupportResolver({
        listConnections: async () => [],
        listCliAgents: async () => [{
          id: provider, name: provider, command: provider, available: true, enabled: true,
          models: [{ id: 'fixture', name: 'fixture', enabled: true }], mcpBridge: { supported: true },
        }],
      }),
      builtinAgentTools: providerAgentTools(buildToolRegistry({ workspacePath, capabilityDispatcher: runtime.dispatcher })),
      cliProviderExecutor: async (_provider, options) => {
        assert.ok(options.mcpBridge)
        const client = new Client({ name: 'file-provider-fixture', version: '1' })
        const transport = new StreamableHTTPClientTransport(new URL(options.mcpBridge.url), {
          requestInit: { headers: { authorization: `Bearer ${options.mcpBridge.token}` } },
        })
        try {
          await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 2_000 })
          const listed = await client.listTools(undefined, { timeout: 2_000 })
          const tool = listed.tools.find((item) => item.name.includes('create_file'))
          assert.ok(tool, 'The shared file tool must reach the CLI provider')
          const called = await client.callTool({ name: tool.name, arguments: { filename: 'notes.md', content: '# Shared file\n' } }, undefined, { timeout: 2_000 })
          assert.notEqual(called.isError, true)
        } finally {
          await client.close()
        }
        return { text: 'Created notes.md.', model: options.model, cost: 0, durationMs: 1, inputTokens: 1, outputTokens: 1, contextTokens: 2 }
      },
    })
    try {
      const result = await service.runTurn({
        ...identity, agentPath: 'agents/writer', provider, model: 'fixture', thinking: 'medium',
        cwd: location.assignmentPath, systemPrompt: 'Create the requested file.', userMessage: 'Create notes.md.', allowedServerIds: [],
      })
      assert.equal(result.kind, 'completed')
      assert.ok(result.kind === 'completed')
      assert.deepEqual(result.artifacts, [{ path: 'files/notes.md', title: 'notes.md', mediaType: 'text/markdown', role: 'final', digest: '22a2970d07427cab1aa42562bc23d1cf50e4e5ee3f8c7d8383c84215983d9f92' }])
      assert.equal(await fs.readFile(path.join(location.assignmentPath, 'files/notes.md'), 'utf8'), '# Shared file\n')
    } finally {
      await settings.closeAll()
      await runtime.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}
