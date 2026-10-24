import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpEvidenceStore } from '../../domains/mcp/mcp-evidence-store.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const repoRoot = process.cwd()
const mcpFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'interactive-stdio-server.mjs',
)

test('MCP interaction API gates real approval and elicitation tool calls without persisting values', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-interactions-api-'))
  const projectRoot = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  const lifecyclePath = path.join(directory, 'mcp-lifecycle.jsonl')
  const callsPath = path.join(directory, 'mcp-calls.jsonl')
  const providerFixture = await startOpenAiToolLoopFixture(
    repoRoot,
    'mcp-interaction-server.mjs',
  )
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(directory, 'provider-settings.json'),
    secretCodec: base64Codec,
  })
  const providerConnection = await providerSettingsService.saveConnection({
    kind: 'openai-compatible',
    name: 'Interaction provider fixture',
    baseUrl: `${providerFixture.url}/v1`,
    apiKey: 'interaction-provider-secret',
    enabled: true,
  })
  assert.equal(
    (await providerSettingsService.validateConnection(providerConnection.id)).status,
    'connected',
  )
  for (const model of providerFixture.models) {
    await providerSettingsService.setModelEnabled(
      providerConnection.id,
      model,
      true,
    )
  }
  const provider = configuredProviderName(providerConnection.id)
  createAgent(projectRoot, 'approval-agent', provider, 'fixture/approval')
  createAgent(projectRoot, 'form-agent', provider, 'fixture/elicitation-form')
  createAgent(projectRoot, 'url-agent', provider, 'fixture/elicitation-url')

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
    await createAndValidateMcp(server.url, lifecyclePath, callsPath)
    for (const agent of ['approval-agent', 'form-agent', 'url-agent']) {
      await setGrant(server.url, agent, true)
    }
    const sessionId = await createSession(server.url, 'MCP interactions')
    const otherSessionId = await createSession(server.url, 'Other session')

    const approvalChat = postAgentChat(server.url, sessionId, 'approval-agent')
    const approval = await waitForPendingInteraction(
      server.url,
      sessionId,
      (interaction) => interaction.kind === 'approval',
    ) as unknown as ApprovalInteraction
    assert.equal(readJsonLines(callsPath).length, 0)
    assert.equal(approval.toolRisk, 'mutating')
    assert.deepEqual(approval.argumentNames, ['marker'])
    assert.equal('arguments' in approval, false)
    assert.equal('argumentsHash' in approval, false)
    assert.doesNotMatch(JSON.stringify(approval), /approval-write-marker/)

    const crossSession = await respond(
      server.url,
      otherSessionId,
      approval.interactionId,
      { kind: 'approval', decision: 'approve', scope: 'once' },
    )
    assert.equal(crossSession.status, 404)
    const wrongKind = await respond(
      server.url,
      sessionId,
      approval.interactionId,
      { kind: 'elicitation', action: 'cancel' },
    )
    assert.equal(wrongKind.status, 409)
    const extraField = await respond(
      server.url,
      sessionId,
      approval.interactionId,
      {
        kind: 'approval',
        decision: 'approve',
        scope: 'once',
        unexpected: true,
      },
    )
    assert.equal(extraField.status, 400)

    const approved = await respond(
      server.url,
      sessionId,
      approval.interactionId,
      { kind: 'approval', decision: 'approve', scope: 'once' },
    )
    assert.equal(approved.status, 200)
    assert.equal(
      ((await approved.json()) as { interaction: { status: string } })
        .interaction.status,
      'approved-once',
    )
    const approvedReplay = await respond(
      server.url,
      sessionId,
      approval.interactionId,
      { kind: 'approval', decision: 'approve', scope: 'once' },
    )
    assert.equal(approvedReplay.status, 200)
    const approvalTurn = await expectChatTurn(approvalChat)
    assert.equal(
      approvalTurn.replies[0]?.text,
      'provider-consumed:approval-write:approval-write-marker',
    )
    assert.equal(readJsonLines(callsPath).length, 1)

    const evidence = new McpEvidenceStore({
      workspacePath,
      sessionId,
      runId: approval.runId,
      assignmentId: approval.assignmentId,
    })
    assert.deepEqual(
      (await evidence.listAuditEvents()).map((event) => event.type),
      [
        'mcp.tool.requested',
        'mcp.approval.requested',
        'mcp.approval.resolved',
        'mcp.tool.started',
        'mcp.tool.completed',
      ],
    )
    assert.equal((await evidence.listToolResultEvidence()).length, 1)

    const deniedChat = postAgentChat(server.url, sessionId, 'approval-agent')
    const denied = await waitForPendingInteraction(
      server.url,
      sessionId,
      (interaction) =>
        interaction.kind === 'approval' &&
        interaction.interactionId !== approval.interactionId,
    )
    assert.equal((await respond(
      server.url,
      sessionId,
      denied.interactionId,
      { kind: 'approval', decision: 'deny' },
    )).status, 200)
    const deniedTurn = await expectChatTurn(deniedChat)
    assert.equal(deniedTurn.meta.replies[0]?.mcp?.status, 'used')
    assert.equal(readJsonLines(callsPath).length, 1)

    const ephemeralValue = 'ephemeral-form-value-19f7'
    const formChat = postAgentChat(server.url, sessionId, 'form-agent')
    const form = await waitForPendingInteraction(
      server.url,
      sessionId,
      (interaction) => interaction.kind === 'elicitation' && interaction.mode === 'form',
    ) as unknown as FormInteraction
    assert.equal('parentRequestId' in form, false)
    assert.equal(form.schema.additionalProperties, false)
    assert.deepEqual(form.schema.required, ['resultCount', 'topic'])
    const invalidForm = await respond(
      server.url,
      sessionId,
      form.interactionId,
      {
        kind: 'elicitation',
        action: 'accept',
        values: {
          topic: 'x',
          resultCount: 99,
        },
      },
    )
    assert.equal(invalidForm.status, 400)
    const formResponse = {
      kind: 'elicitation',
      action: 'accept',
      values: {
        topic: ephemeralValue,
        resultCount: 3,
        includeSources: true,
        category: 'technical',
        formats: ['summary', 'links'],
      },
    } as const
    assert.equal((await respond(
      server.url,
      sessionId,
      form.interactionId,
      formResponse,
    )).status, 200)
    assert.equal((await respond(
      server.url,
      sessionId,
      form.interactionId,
      formResponse,
    )).status, 200)
    assert.equal(
      (await expectChatTurn(formChat)).replies[0]?.text,
      'provider-consumed:elicit-form:accept:elicit-form-marker',
    )
    const formEvidence = new McpEvidenceStore({
      workspacePath,
      sessionId,
      runId: form.runId,
      assignmentId: form.assignmentId,
    })
    const formAudit = await formEvidence.listAuditEvents()
    assert.deepEqual(
      formAudit.map((event) => event.type),
      [
        'mcp.tool.requested',
        'mcp.tool.started',
        'mcp.elicitation.requested',
        'mcp.elicitation.resolved',
        'mcp.tool.completed',
      ],
    )
    assert.equal(formAudit[2]?.elicitationMode, 'form')
    assert.equal(formAudit[3]?.elicitationStatus, 'accepted')
    assert.equal(formAudit[3]?.elicitationAction, 'accept')
    assert.equal(readWorkspaceText(workspacePath).includes(ephemeralValue), false)
    assert.equal(JSON.stringify(readJsonLines(callsPath)).includes(ephemeralValue), false)

    const urlChat = postAgentChat(server.url, sessionId, 'url-agent')
    const urlInteraction = await waitForPendingInteraction(
      server.url,
      sessionId,
      (interaction) => interaction.kind === 'elicitation' && interaction.mode === 'url',
    ) as unknown as UrlInteraction
    assert.equal(
      urlInteraction.url,
      'https://example.test/pipeline-mcp-authorization',
    )
    assert.equal('parentRequestId' in urlInteraction, false)
    assert.equal((await respond(
      server.url,
      sessionId,
      urlInteraction.interactionId,
      { kind: 'elicitation', action: 'decline' },
    )).status, 200)
    assert.equal(
      (await expectChatTurn(urlChat)).replies[0]?.text,
      'provider-consumed:elicit-url:decline:elicit-url-marker',
    )

    const cancelChat = postAgentChat(server.url, sessionId, 'url-agent')
    const cancelled = await waitForPendingInteraction(
      server.url,
      sessionId,
      (interaction) =>
        interaction.kind === 'elicitation' &&
        interaction.mode === 'url' &&
        interaction.interactionId !== urlInteraction.interactionId,
    )
    assert.equal((await respond(
      server.url,
      sessionId,
      cancelled.interactionId,
      { kind: 'elicitation', action: 'cancel' },
    )).status, 200)
    assert.equal(
      (await expectChatTurn(cancelChat)).replies[0]?.text,
      'provider-consumed:elicit-url:cancel:elicit-url-marker',
    )

    const pendingList = await fetch(
      `${server.url}/sessions/${sessionId}/mcp-interactions`,
    )
    assert.equal(pendingList.status, 200)
    assert.equal(pendingList.headers.get('cache-control'), 'no-store')
    assert.deepEqual(
      (await pendingList.json() as { interactions: unknown[] }).interactions,
      [],
    )
    const history = await fetch(
      `${server.url}/sessions/${sessionId}/mcp-interactions?includeResolved=1&limit=20`,
    )
    assert.equal(history.status, 200)
    const historyText = await history.text()
    assert.match(historyText, /approved-once/)
    assert.match(historyText, /accepted/)
    assert.match(historyText, /declined/)
    assert.match(historyText, /cancelled/)
    assert.doesNotMatch(historyText, /parentRequestId/)
    assert.doesNotMatch(historyText, new RegExp(ephemeralValue))
  } finally {
    await server?.close().catch(() => undefined)
    await providerFixture.close()
    await waitForEventCount(lifecyclePath, 'stopped', 1).catch(() => undefined)
    assert.equal(isProcessAlive(providerFixture.pid), false)
    for (const event of readJsonLines(lifecyclePath) as Array<{ pid: number }>) {
      assert.equal(isProcessAlive(event.pid), false)
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

interface InteractionBase {
  interactionId: string
  kind: 'approval' | 'elicitation'
  runId: string
  assignmentId: string
}

interface ApprovalInteraction extends InteractionBase {
  kind: 'approval'
  toolRisk: string
  argumentNames: string[]
}

interface FormInteraction extends InteractionBase {
  kind: 'elicitation'
  mode: 'form'
  schema: {
    required: string[]
    additionalProperties: false
  }
}

interface UrlInteraction extends InteractionBase {
  kind: 'elicitation'
  mode: 'url'
  url: string
}

type Interaction = InteractionBase & Record<string, unknown>

interface AgentChatTurn {
  replies: Array<{ text: string }>
  meta: {
    replies: Array<{ mcp?: { status: string } }>
  }
}

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
): Promise<void> {
  const created = await fetch(`${baseUrl}/settings/mcps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'interactive-fixture',
      name: 'Interactive fixture',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [mcpFixturePath],
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
        },
      },
    }),
  })
  assert.equal(created.status, 201)
  const validated = await fetch(
    `${baseUrl}/settings/mcps/interactive-fixture/validate`,
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
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/create/agents/${agentName}/mcp-grants`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'interactive-fixture', enabled }),
    },
  )
  assert.equal(response.status, 200)
}

async function createSession(baseUrl: string, title: string): Promise<string> {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  assert.equal(response.status, 201)
  return ((await response.json()) as { id: string }).id
}

function postAgentChat(
  baseUrl: string,
  sessionId: string,
  agentName: string,
): Promise<Response> {
  return fetch(`${baseUrl}/sessions/${sessionId}/agent-chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Use the interaction tool and return its result.',
      agentNames: [agentName],
    }),
  })
}

async function expectChatTurn(response: Promise<Response>): Promise<AgentChatTurn> {
  const result = await response
  assert.equal(result.status, 201)
  return result.json() as Promise<AgentChatTurn>
}

async function waitForPendingInteraction(
  baseUrl: string,
  sessionId: string,
  predicate: (interaction: Interaction) => boolean,
): Promise<Interaction> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl}/sessions/${sessionId}/mcp-interactions`,
    )
    assert.equal(response.status, 200)
    const payload = await response.json() as { interactions: Interaction[] }
    const interaction = payload.interactions.find(predicate)
    if (interaction) return interaction
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('Timed out waiting for a pending MCP interaction')
}

function respond(
  baseUrl: string,
  sessionId: string,
  interactionId: string,
  body: unknown,
): Promise<Response> {
  return fetch(
    `${baseUrl}/sessions/${sessionId}/mcp-interactions/${encodeURIComponent(interactionId)}/respond`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

function createAgent(
  root: string,
  name: string,
  provider: string,
  model: string,
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

function readWorkspaceText(root: string): string {
  if (!fs.existsSync(root)) return ''
  const chunks: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) chunks.push(readWorkspaceText(entryPath))
    else if (entry.isFile()) chunks.push(fs.readFileSync(entryPath).toString('utf8'))
  }
  return chunks.join('\n')
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
