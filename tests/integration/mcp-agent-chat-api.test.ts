import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const repoRoot = process.cwd()
const stdioFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)

test('agent chat API runs a real provider-to-MCP loop and enforces next-call and in-flight revocation', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-chat-')),
  )
  const projectRoot = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  const lifecyclePath = path.join(directory, 'mcp-lifecycle.jsonl')
  const callsPath = path.join(directory, 'mcp-calls.jsonl')
  const toolStartedPath = path.join(directory, 'mcp-tool-started.pid')
  const toolGatePath = path.join(directory, 'mcp-tool-gate')
  fs.writeFileSync(toolGatePath, 'open', 'utf8')
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(directory, 'provider-settings.json'),
    secretCodec: base64Codec,
  })
  const providerConnection = await providerSettingsService.saveConnection({
    kind: 'openai-compatible',
    name: 'Tool-loop fixture',
    baseUrl: `${providerFixture.url}/v1`,
    apiKey: 'fixture-provider-secret',
    enabled: true,
  })
  const validatedProvider = await providerSettingsService.validateConnection(
    providerConnection.id,
  )
  assert.equal(validatedProvider.status, 'connected')
  await providerSettingsService.setModelEnabled(
    providerConnection.id,
    'fixture/tool-loop',
    true,
  )
  await providerSettingsService.setModelEnabled(
    providerConnection.id,
    'fixture/slow',
    true,
  )
  await providerSettingsService.setModelEnabled(
    providerConnection.id,
    'fixture/generate-word',
    true,
  )
  await providerSettingsService.setModelEnabled(
    providerConnection.id,
    'fixture/generate-excel',
    true,
  )
  const provider = configuredProviderName(providerConnection.id)
  createAgent(projectRoot, 'tool-agent', provider, 'fixture/tool-loop')
  createAgent(projectRoot, 'slow-agent', provider, 'fixture/slow')
  createAgent(
    projectRoot,
    'word-writer',
    provider,
    'fixture/generate-word',
    'generate_word',
  )
  createAgent(
    projectRoot,
    'plain-writer',
    provider,
    'fixture/generate-word',
    'none',
  )
  createAgent(
    projectRoot,
    'excel-writer',
    provider,
    'fixture/generate-excel',
    'generate_excel',
  )

  const mcpSettingsService = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    secretCodec: base64Codec,
    clientManager: new McpClientManager({
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      closeTimeoutMs: 1_000,
    }),
  })
  let server: StartedApiServer | null = null

  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath: projectRoot,
      workspacePath,
      providerSettingsService,
      mcpSettingsService,
    })

    const wordSessionResponse = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Generate Word chat' }),
    })
    assert.equal(wordSessionResponse.status, 201)
    const wordSession = await wordSessionResponse.json() as { id: string }
    const wordResponse = await postAgentChatText(
      server.url,
      wordSession.id,
      'word-writer',
      'Create a Word document with headings, page numbers, and a dynamic table of contents.',
    )
    assert.equal(
      wordResponse.status,
      201,
      await wordResponse.clone().text(),
    )
    const wordTurn = await wordResponse.json() as AgentChatTurn
    const delivery = wordTurn.replies[0]?.delivery
    assert.ok(delivery)
    assert.equal(delivery.artifacts.length, 2)
    assert.equal(delivery.artifacts[0]?.role, 'final')
    assert.match(delivery.artifacts[0]?.path ?? '', /\.docx$/)
    assert.equal(delivery.artifacts[1]?.role, 'secondary')
    assert.match(delivery.artifacts[1]?.path ?? '', /\.md$/)

    const wordArtifact = delivery.artifacts[0]!
    const wordDownload = await fetch(
      `${server.url}/runs/${wordArtifact.runId}/assignments/${wordArtifact.path}`,
    )
    assert.equal(wordDownload.status, 200)
    assert.match(
      wordDownload.headers.get('content-type') ?? '',
      /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/,
    )
    assert.equal(
      Buffer.from(await wordDownload.arrayBuffer())
        .subarray(0, 2)
        .toString('ascii'),
      'PK',
    )

    const markdownArtifact = delivery.artifacts[1]!
    const markdownDownload = await fetch(
      `${server.url}/runs/${markdownArtifact.runId}/assignments/${markdownArtifact.path}`,
    )
    assert.equal(markdownDownload.status, 200)
    assert.match(await markdownDownload.text(), /^# Lorem Ipsum Document/m)

    const plainResponse = await postAgentChatText(
      server.url,
      wordSession.id,
      'plain-writer',
      'Create a Word document with headings.',
    )
    assert.equal(plainResponse.status, 201)
    const plainTurn = await plainResponse.json() as AgentChatTurn
    assert.equal(plainTurn.replies[0]?.delivery, undefined)

    const excelSessionResponse = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Generate Excel chat' }),
    })
    assert.equal(excelSessionResponse.status, 201)
    const excelSession = await excelSessionResponse.json() as { id: string }
    const excelResponse = await postAgentChatText(
      server.url,
      excelSession.id,
      'excel-writer',
      'Create an Excel spreadsheet with the funnel metrics.',
    )
    assert.equal(
      excelResponse.status,
      201,
      await excelResponse.clone().text(),
    )
    const excelTurn = await excelResponse.json() as AgentChatTurn
    const excelDelivery = excelTurn.replies[0]?.delivery
    assert.ok(excelDelivery)
    assert.equal(excelDelivery.artifacts.length, 2)
    assert.equal(excelDelivery.artifacts[0]?.role, 'final')
    assert.match(excelDelivery.artifacts[0]?.path ?? '', /\.xlsx$/)
    assert.equal(excelDelivery.artifacts[1]?.role, 'secondary')
    assert.match(excelDelivery.artifacts[1]?.path ?? '', /\.md$/)

    const excelArtifact = excelDelivery.artifacts[0]!
    const excelDownload = await fetch(
      `${server.url}/runs/${excelArtifact.runId}/assignments/${excelArtifact.path}`,
    )
    assert.equal(excelDownload.status, 200)
    assert.match(
      excelDownload.headers.get('content-type') ?? '',
      /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/octet-stream/,
    )
    assert.equal(
      Buffer.from(await excelDownload.arrayBuffer())
        .subarray(0, 2)
        .toString('ascii'),
      'PK',
    )

    const excelMarkdownArtifact = excelDelivery.artifacts[1]!
    const excelMarkdownDownload = await fetch(
      `${server.url}/runs/${excelMarkdownArtifact.runId}/assignments/${excelMarkdownArtifact.path}`,
    )
    assert.equal(excelMarkdownDownload.status, 200)
    assert.match(await excelMarkdownDownload.text(), /^# Lorem Ipsum Workbook/m)

    await createAndValidateMcp(
      server.url,
      lifecyclePath,
      callsPath,
      toolStartedPath,
      toolGatePath,
    )
    await setGrant(server.url, 'tool-agent', true)
    await setGrant(server.url, 'slow-agent', true)

    const sessionResponse = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'MCP agent chat' }),
    })
    assert.equal(sessionResponse.status, 201)
    const session = await sessionResponse.json() as { id: string }

    const first = await postAgentChat(server.url, session.id, 'tool-agent')
    assert.equal(first.status, 201)
    const firstTurn = await first.json() as AgentChatTurn
    assert.equal(
      firstTurn.replies[0]?.text,
      'provider-consumed:echo-marker:provider-loop-marker',
    )
    assert.deepEqual(firstTurn.meta.replies[0]?.mcp, {
      status: 'used',
      availableToolCount: 4,
      toolCallCount: 1,
      executedToolCallCount: 1,
    })
    assert.equal(readJsonLines(callsPath).length, 1)

    const revoked = await setGrant(server.url, 'tool-agent', false)
    assert.equal(revoked.granted, false)
    const afterRevoke = await postAgentChat(
      server.url,
      session.id,
      'tool-agent',
    )
    assert.equal(afterRevoke.status, 201)
    const revokedTurn = await afterRevoke.json() as AgentChatTurn
    assert.equal(revokedTurn.replies[0]?.text, 'provider-no-tools')
    assert.deepEqual(revokedTurn.meta.replies[0]?.mcp, {
      status: 'used', availableToolCount: 3, toolCallCount: 0, executedToolCallCount: 0,
    })
    assert.equal(readJsonLines(callsPath).length, 1)

    await setGrant(server.url, 'tool-agent', true)
    const globallyDisabled = await fetch(
      `${server.url}/settings/mcps/agent-chat-fixture`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
    )
    assert.equal(globallyDisabled.status, 200)
    await waitForEventCount(lifecyclePath, 'stopped', 1)
    const afterGlobalDisable = await postAgentChat(
      server.url,
      session.id,
      'tool-agent',
    )
    assert.equal(afterGlobalDisable.status, 201)
    const disabledTurn = await afterGlobalDisable.json() as AgentChatTurn
    assert.equal(disabledTurn.replies[0]?.text, 'provider-no-tools')
    assert.deepEqual(disabledTurn.meta.replies[0]?.mcp, {
      status: 'used', availableToolCount: 3, toolCallCount: 0, executedToolCallCount: 0,
    })
    assert.equal(readJsonLines(callsPath).length, 1)

    const globallyEnabled = await fetch(
      `${server.url}/settings/mcps/agent-chat-fixture`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    )
    assert.equal(globallyEnabled.status, 200)
    await waitForEventCount(lifecyclePath, 'ready', 2)
    const afterRestore = await postAgentChat(server.url, session.id, 'tool-agent')
    assert.equal(afterRestore.status, 201)
    assert.equal(
      ((await afterRestore.json()) as AgentChatTurn).replies[0]?.text,
      'provider-consumed:echo-marker:provider-loop-marker',
    )
    assert.equal(readJsonLines(callsPath).length, 2)

    fs.rmSync(toolGatePath, { force: true })
    fs.rmSync(toolStartedPath, { force: true })
    const inFlightTurn = postAgentChat(server.url, session.id, 'tool-agent')
    await waitForFile(toolStartedPath, 'in-flight MCP tool start')
    const inFlightRevoke = await setGrant(server.url, 'tool-agent', false)
    assert.equal(inFlightRevoke.granted, false)
    const revokedInFlightResponse = await inFlightTurn
    assert.equal(revokedInFlightResponse.status, 201)
    const revokedInFlightTurn = await revokedInFlightResponse.json() as AgentChatTurn
    assert.equal(
      revokedInFlightTurn.replies[0]?.text,
      'The provider could not complete the response. Try again.',
    )
    assert.doesNotMatch(
      JSON.stringify(revokedInFlightTurn),
      /mcp-tool-started|mcp-tool-gate|fixture-provider-secret/,
    )
    assert.equal(readJsonLines(callsPath).length, 2)
    await setGrant(server.url, 'tool-agent', true)
    fs.writeFileSync(toolGatePath, 'open', 'utf8')

    const slowRequest = postAgentChat(
      server.url,
      session.id,
      'slow-agent',
      AbortSignal.timeout(40),
    )
    await assert.rejects(slowRequest, (error: unknown) =>
      error instanceof DOMException && error.name === 'TimeoutError')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(readJsonLines(callsPath).length, 2)
    const persistedMessages = await fetch(
      `${server.url}/sessions/${session.id}/messages`,
    )
    assert.equal(persistedMessages.status, 200)
    const messagesPayload = await persistedMessages.json() as {
      messages: Array<{ role: string; speaker?: { id?: string } }>
    }
    assert.equal(
      messagesPayload.messages.some(
        (message) =>
          message.role === 'assistant' && message.speaker?.id === 'slow-agent',
      ),
      false,
    )

    const dialogueResponse = await fetch(`${server.url}/sessions/${session.id}/dialogues`, {
      signal: AbortSignal.timeout(2_000),
    })
    assert.equal(dialogueResponse.status, 200)
    const dialogues: unknown = await dialogueResponse.json()
    assert.deepEqual(dialogues, { dialogues: [] }, 'Ordinary MCP chat must not start an Agent dialogue')

    const providerSettings = fs.readFileSync(
      path.join(directory, 'provider-settings.json'),
      'utf8',
    )
    const mcpSettings = fs.readFileSync(
      path.join(directory, 'mcp-settings.json'),
      'utf8',
    )
    assert.equal(providerSettings.includes('fixture-provider-secret'), false)
    assert.equal(mcpSettings.includes(lifecyclePath), false)
    assert.equal(mcpSettings.includes(callsPath), false)
    assert.equal(mcpSettings.includes(toolStartedPath), false)
    assert.equal(mcpSettings.includes(toolGatePath), false)
  } finally {
    await server?.close().catch(() => undefined)
    await providerFixture.close()
    await waitForEventCount(lifecyclePath, 'stopped', 2).catch(() => undefined)
    assert.equal(isProcessAlive(providerFixture.pid), false)
    for (const event of readJsonLines(lifecyclePath) as Array<{ pid: number }>) {
      assert.equal(isProcessAlive(event.pid), false)
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const base64Codec = {
  encrypt(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64')
  },
  decrypt(value: string): string {
    return Buffer.from(value, 'base64').toString('utf8')
  },
}

async function createAndValidateMcp(
  baseUrl: string,
  lifecyclePath: string,
  callsPath: string,
  toolStartedPath: string,
  toolGatePath: string,
): Promise<void> {
  const created = await fetch(`${baseUrl}/settings/mcps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'agent-chat-fixture',
      name: 'Agent chat fixture',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [stdioFixturePath],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_FIXTURE_LIFECYCLE_PATH: {
            operation: 'replace',
            value: lifecyclePath,
          },
          MCP_FIXTURE_CALLS_PATH: {
            operation: 'replace',
            value: callsPath,
          },
          MCP_FIXTURE_TOOL_STARTED_PATH: {
            operation: 'replace',
            value: toolStartedPath,
          },
          MCP_FIXTURE_TOOL_GATE_PATH: {
            operation: 'replace',
            value: toolGatePath,
          },
          MCP_FIXTURE_TOOL_GATE_MARKER: {
            operation: 'replace',
            value: 'provider-loop-marker',
          },
        },
      },
    }),
  })
  assert.equal(created.status, 201)
  const validated = await fetch(
    `${baseUrl}/settings/mcps/agent-chat-fixture/validate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stdioTrustAcknowledged: true }),
    },
  )
  assert.equal(validated.status, 200)
  await waitForEventCount(lifecyclePath, 'ready', 1)
}

async function setGrant(
  baseUrl: string,
  agentName: string,
  enabled: boolean,
): Promise<{ granted: boolean }> {
  const response = await fetch(
    `${baseUrl}/create/agents/${agentName}/mcp-grants`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'agent-chat-fixture', enabled }),
    },
  )
  assert.equal(response.status, 200)
  return response.json() as Promise<{ granted: boolean }>
}

function postAgentChat(
  baseUrl: string,
  sessionId: string,
  agentName: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${baseUrl}/sessions/${sessionId}/agent-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Use the available marker tool and return its result.',
      agentNames: [agentName],
    }),
    ...whenDefined(signal, (definedSignal) => ({ signal: definedSignal })),
  })
}

function postAgentChatText(
  baseUrl: string,
  sessionId: string,
  agentName: string,
  text: string,
): Promise<Response> {
  return fetch(`${baseUrl}/sessions/${sessionId}/agent-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, agentNames: [agentName] }),
  })
}

function createAgent(
  root: string,
  name: string,
  provider: string,
  model: string,
  tools?: string,
): void {
  const directory = path.join(root, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'tier: strategic',
      `provider: ${provider}`,
      `model: ${model}`,
      'thinking: low',
      ...(tools ? [`tools: ${tools}`] : []),
      '---',
      '',
      `# ${name}`,
      '',
      'Use tools when they can provide verifiable evidence.',
      '',
    ].join('\n'),
    'utf8',
  )
}

interface AgentChatTurn {
  replies: Array<{
    text: string
    delivery?: {
      artifacts: Array<{
        runId: string
        path: string
        role: 'final' | 'secondary'
      }>
    }
  }>
  meta: {
    replies: Array<{
      mcp?: {
        status: string
        availableToolCount?: number
        toolCallCount?: number
        executedToolCallCount?: number
      }
    }>
  }
}

function readJsonLines(filePath: string): unknown[] {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function waitForEventCount(
  filePath: string,
  event: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const events = readJsonLines(filePath) as Array<{ event?: string }>
    if (events.filter((entry) => entry.event === event).length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`Timed out waiting for ${count} ${event} events`)
}

async function waitForFile(filePath: string, description: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`Timed out waiting for ${description}`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
import { whenDefined } from '../../core/optional-properties.js'
