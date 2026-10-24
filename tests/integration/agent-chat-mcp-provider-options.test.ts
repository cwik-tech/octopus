/**
 * A chat turn that goes through MCP says which of its Agent's settings it did
 * not apply — and still says so after a reload.
 *
 * Nothing here is stood in for. A real Agent persona on disk carries a real
 * `provider_options`; a real stdio MCP server is registered and really granted
 * to that Agent; a real loopback provider runs a real tool round; the turn goes
 * through the real `McpAgentToolService` and the real `McpParentBroker`; and
 * the reply is read back through a `FileSystemSessionStore` built fresh over
 * the same workspace, so what is asserted is the file's answer rather than
 * anything the turn kept in memory.
 *
 * The fact under test is one a reader cannot get any other way. On the native
 * tool loop the request body carries model, messages, tools and tool choice and
 * nothing else, so an Agent's `max_tokens` reaches the provider in no form at
 * all. A reply that came out longer than the Agent asked for then has two
 * indistinguishable explanations — the provider ignored the setting, or it was
 * never sent — and only the run can say which.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { SessionSummary } from '../../contracts/sessions.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { createMcpProviderSupportResolver } from '../../domains/mcp/mcp-provider-support.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import {
  McpSettingsService,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const repoRoot = process.cwd()
const MCP_FIXTURE_PATH = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)
const SERVER_ID = 'chat-options-tools'
const AGENT_NAME = 'optionswriter'

const CODEC: McpSecretCodec = {
  encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
}

test('a chat turn through MCP records the settings its lane did not apply', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'chat-mcp-options-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const projectRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

  const manager = new McpClientManager({
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    closeTimeoutMs: 1_000,
  })
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  try {
    const mcpSettings = new McpSettingsService({
      storagePath: path.join(directory, 'mcps.json'),
      secretCodec: CODEC,
      clientManager: manager,
    })
    await mcpSettings.saveServer({
      id: SERVER_ID,
      name: 'Chat options tools',
      capabilityAliases: [{ capability: 'marker.echo', access: 'read' }],
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [MCP_FIXTURE_PATH],
        cwd: repoRoot,
      },
    })
    await mcpSettings.validateServer(SERVER_ID, {
      stdioTrustAcknowledged: true,
    })
    await mcpSettings.setAgentGrant(`agents/${AGENT_NAME}`, SERVER_ID, true)

    const providerSettings = new ProviderSettingsService({
      storagePath: path.join(directory, 'providers.json'),
      secretCodec: CODEC,
    })
    const connection = await providerSettings.saveConnection({
      kind: 'openai-compatible',
      name: 'Chat options loopback',
      baseUrl: `${providerFixture.url}/v1`,
      apiKey: 'chat-options-secret',
      enabled: true,
    })
    await providerSettings.validateConnection(connection.id)
    await providerSettings.setModelEnabled(
      connection.id,
      'fixture/tool-loop',
      true,
    )
    const provider = configuredProviderName(connection.id)

    // Written after the connection exists, because the persona has to name the
    // pair that will really run — an Agent pinned to something else would take
    // a different route and answer a different question.
    const agentDir = path.join(projectRoot, 'agents', AGENT_NAME)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${AGENT_NAME}.md`),
      [
        '---',
        `name: ${AGENT_NAME}`,
        'description: Settings disclosure through the MCP lane.',
        'tier: execution',
        `provider: ${provider}`,
        'model: fixture/tool-loop',
        'thinking: low',
        `provider_options: '${JSON.stringify({ max_tokens: 4096 })}'`,
        '---',
        '',
        '# Options writer',
        '',
        'Answer briefly.',
        '',
      ].join('\n'),
      'utf8',
    )

    const leases = new McpRunLeaseStore()
    const mcpAgentToolService = new McpAgentToolService({
      broker: new McpParentBroker({
        lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
        settingsService: mcpSettings,
        clientManager: mcpSettings.getBrokerClientManager(),
        grantResolver: ({ context, serverId }) =>
          mcpSettings.isAgentGranted(context.agentPath, serverId),
        leaseResolver: (context) => leases.resolve(context),
      }),
      leaseStore: leases,
      providerSettingsService: providerSettings,
      // The real resolver, over the real connection: it answers
      // `native-tool-loop` for a configured provider, which is the lane whose
      // request body carries no settings.
      providerSupportResolver:
        createMcpProviderSupportResolver(providerSettings),
    })

    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Chat MCP options' })
    const summary: SessionSummary = {
      id: session.id,
      title: 'Chat MCP options',
      status: 'active',
      activityType: 'chat',
      createdAt: '2026-09-09T10:00:00.000Z',
      updatedAt: '2026-09-09T10:00:00.000Z',
    }

    const turn = await runSessionAgentChatTurn({
      sessionId: session.id,
      session: summary,
      sessionStore: store,
      repoRootPath: projectRoot,
      text: 'Ask the agent.',
      agentNames: [AGENT_NAME],
      turnId: randomUUID(),
      mcpAgentToolService,
    })

    assert.deepEqual(
      turn.meta.replies[0]?.droppedProviderOptions,
      ['max_tokens'],
      'the turn reports the setting its lane could not carry',
    )

    // Durably, through a store built fresh over the same workspace.
    const reread = new FileSystemSessionStore(workspacePath)
    const reply = (await reread.listChatMessages(session.id))
      .filter((message) => message.role === 'assistant')
      .at(-1)
    assert.deepEqual(
      reply?.speaker?.droppedProviderOptions,
      ['max_tokens'],
      'and the recorded reply still names it after a reload',
    )
  } finally {
    await providerFixture.close().catch(() => undefined)
    await manager.closeAll?.().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
