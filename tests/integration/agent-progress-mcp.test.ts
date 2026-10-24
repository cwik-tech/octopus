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
import type { AgentProgressUpdate } from '../../contracts/agent-progress.js'

test('a CLI progress report cannot expose its bridge credential in summaries or tasks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-mcp-'))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({ storagePath: path.join(directory, 'mcps.json'), clientManager: manager,
    secretCodec: { encrypt: value => value, decrypt: value => value },
  })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({ lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE, settingsService: settings, clientManager: manager, grantResolver: () => false, leaseResolver: context => leases.resolve(context) })
  const updates: AgentProgressUpdate[] = []
  let token = ''
  const service = new McpAgentToolService({ broker, leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({ storagePath: path.join(directory, 'providers.json') }),
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode: 'host-tool-bridge' }),
    // Substitute the paid provider boundary; the MCP HTTP server, client and tool execute for real.
    cliProviderExecutor: async (_provider, options) => {
      assert.ok(options.mcpBridge)
      token = options.mcpBridge.token
      const client = new Client({ name: 'progress-fixture', version: '1' })
      try {
        await client.connect(new ExactOptionalMcpTransport(new StreamableHTTPClientTransport(new URL(options.mcpBridge.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })), { timeout: 2000 })
        const tools = await client.listTools(undefined, { timeout: 2000 })
        const tool = tools.tools[0]
        assert.ok(tool)
        await client.callTool({ name: tool.name, arguments: { summary: `Working ${token}`, tasks: [{ id: token, label: `File ${token}`, status: 'active' }] } }, undefined, { timeout: 2000 })
      } finally { await client.close() }
      return { text: 'Done.', model: options.model, inputTokens: 1, outputTokens: 1, contextTokens: 2, cost: 0, durationMs: 1 }
    },
  })
  try {
    await service.runTurn({ sessionId: 'session', runId: 'turn', assignmentId: 'assignment', agentPath: 'agents/analyst', provider: 'claude', model: 'opus', thinking: 'low', cwd: directory, systemPrompt: 'Report progress.', userMessage: 'Work.', onProgress: update => updates.push(update) })
    assert.ok(token.length > 0)
    assert.equal(JSON.stringify(updates).includes(token), false)
    assert.equal(updates.length, 1)
    const report = updates[0]
    assert.ok(report?.kind === 'reported')
    assert.equal(report.summary, 'Working [REDACTED]')
    assert.equal(report.tasks?.[0]?.label, 'File [REDACTED]')
    assert.equal(report.tasks?.[0]?.status, 'active')
    assert.match(report.tasks?.[0]?.id ?? '', /^[a-f0-9]{64}$/)
  } finally { await settings.closeAll(); await fs.rm(directory, { recursive: true, force: true }) }
})
