import assert from 'node:assert/strict'
import * as path from 'node:path'
import test from 'node:test'

import {
  McpClientManager,
  type McpClientElicitationHandlerInput,
} from '../../domains/mcp/mcp-client-manager.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import type { McpServerSettings } from '../../domains/mcp/mcp-settings.js'

const repoRoot = process.cwd()
const fixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'interactive-stdio-server.mjs',
)

function brokerContext(requestId: string): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId,
    leaseId: 'lease-elicitation',
    sessionId: 'session-elicitation',
    runId: 'run-elicitation',
    assignmentId: 'assignment-elicitation',
    agentPath: 'agents/elicitation-agent',
  }
}

function fixtureServer(): McpServerSettings {
  return {
    id: 'interactive-tools',
    name: 'Interactive tools',
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      cwd: repoRoot,
      encryptedEnvironment: {},
    },
    status: 'unvalidated',
    capabilities: { logging: false },
  }
}

test('real stdio tool elicitations stay bound to the active broker call', async () => {
  const requests: McpClientElicitationHandlerInput[] = []
  const manager = new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
    elicitationHandler: async (input) => {
      requests.push(input)
      if (input.request.mode === 'url') return { action: 'decline' }
      return {
        action: 'accept',
        content: {
          topic: 'public infrastructure',
          resultCount: 3,
          includeSources: true,
          category: 'technical',
          formats: ['summary', 'links'],
        },
      }
    },
  })

  let processId: number | undefined
  try {
    const snapshot = await manager.connect(fixtureServer())
    processId = snapshot.processId
    assert.ok(processId)
    assert.deepEqual(
      snapshot.tools.map((tool) => tool.toolName).sort(),
      ['approval-write', 'elicit-form', 'elicit-url'],
    )

    const formContext = brokerContext('parent-request-form')
    const formResult = await manager.callTool(
      fixtureServer().id,
      { name: 'elicit-form', arguments: { marker: 'form-marker' } },
      {
        timeoutMs: 3_000,
        elicitation: {
          context: formContext,
          toolCallId: 'tool-call-form',
          namespacedToolName: 'mcp__interactive-tools__elicit-form',
        },
      },
    ) as { content: Array<{ text?: string }> }
    assert.equal(formResult.content[0]?.text, 'elicit-form:accept:form-marker')

    const urlContext = brokerContext('parent-request-url')
    const urlResult = await manager.callTool(
      fixtureServer().id,
      { name: 'elicit-url', arguments: { marker: 'url-marker' } },
      {
        timeoutMs: 3_000,
        elicitation: {
          context: urlContext,
          toolCallId: 'tool-call-url',
          namespacedToolName: 'mcp__interactive-tools__elicit-url',
        },
      },
    ) as { content: Array<{ text?: string }> }
    assert.equal(urlResult.content[0]?.text, 'elicit-url:decline:url-marker')

    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.context, formContext)
    assert.equal(requests[0]?.serverId, fixtureServer().id)
    assert.equal(requests[0]?.toolCallId, 'tool-call-form')
    assert.equal(requests[0]?.request.mode, 'form')
    assert.equal(requests[1]?.context, urlContext)
    assert.equal(requests[1]?.request.mode, 'url')

    const unbound = await manager.callTool(
      fixtureServer().id,
      { name: 'elicit-form', arguments: { marker: 'unbound-marker' } },
      { timeoutMs: 3_000 },
    ) as { isError?: boolean }
    assert.equal(unbound.isError, true)
    assert.equal(requests.length, 2)
  } finally {
    await manager.closeAll()
  }

  assert.ok(processId)
  await waitForProcessExit(processId)
})

async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = Date.now() + 3_000
  while (isProcessAlive(processId)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('MCP elicitation fixture did not exit')
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)))
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
