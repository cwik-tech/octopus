import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { buildSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsRequest, type FakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

const WRITER_PERSONA = 'Dialogue file writer alpha-tool-writer.'
const MODEL = 'fake/dialogue-tools'
const FILE_CONTENT = '# Pilot evidence\n\nRecruit buyers and people who declined.\n'
const ANSWER = 'I saved the pilot evidence; compare buyers with people who declined.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolResults(request: FakeChatCompletionsRequest): string[] {
  const messages = request.body.messages
  return Array.isArray(messages) ? messages.flatMap((message: unknown) =>
    isRecord(message) && message.role === 'tool' && typeof message.content === 'string' ? [message.content] : []) : []
}

function toolNames(request: FakeChatCompletionsRequest): string[] {
  const tools = request.body.tools
  return Array.isArray(tools) ? tools.flatMap((tool: unknown) => {
    const fn = isRecord(tool) ? tool.function : undefined
    return isRecord(fn) && typeof fn.name === 'string' ? [fn.name] : []
  }) : []
}

test('a dialogue Agent creates a real file through its tools and its saved reply delivers that file', { timeout: 20_000 }, async (t) => {
  const createdFixture = createSchedulerFixture('agent-dialogue-tools-')
  // create_file rejects an assignment reached through a symlink; macOS /var
  // is one, so use the real paths for this actual file-creation journey.
  const fixture = { ...createdFixture,
    repoRootPath: fs.realpathSync(createdFixture.repoRootPath),
    workspacePath: fs.realpathSync(createdFixture.workspacePath),
    workflowsRegistryPath: fs.realpathSync(createdFixture.workflowsRegistryPath) }
  let provider: FakeChatCompletionsServer | undefined
  let server: StartedApiServer | undefined
  t.after(async () => { await server?.close(); await provider?.close(); fixture.cleanup() })

  // Paid, nondeterministic model output is replaced at HTTP only. API,
  // capability dispatch, create_file, journal and transcript stores are real.
  provider = await startFakeChatCompletionsServer({ models: [MODEL], script: [
    { match: (request) => request.systemPrompt?.includes(WRITER_PERSONA) === true && request.toolCount > 0 && toolResults(request).length === 0,
      toolCalls: [{ id: 'call-pilot-evidence', name: 'create_file', arguments: { filename: 'pilot-evidence.md', content: FILE_CONTENT } }] },
    { match: (request) => request.systemPrompt?.includes(WRITER_PERSONA) === true && request.toolCount > 0 && toolResults(request).length > 0,
      content: 'The file tool confirmed the pilot evidence.' },
    { match: (request) => request.systemPrompt?.includes(WRITER_PERSONA) === true && request.stream, content: ANSWER },
    { content: '[pass]' },
  ] })
  const settings = new ProviderSettingsService({ storagePath: path.join(fixture.repoRootPath, 'provider-settings.json') })
  const connection = await settings.saveConnection({ kind: 'lm-studio', name: 'Dialogue tool HTTP fixture', baseUrl: `${provider.url}/v1`, enabled: true })
  assert.equal((await settings.validateConnection(connection.id)).status, 'connected')
  await settings.setModelEnabled(connection.id, MODEL, true)
  const route = configuredProviderName(connection.id)
  for (const { name, persona } of [{ name: 'alpha-tool-writer', persona: WRITER_PERSONA }, { name: 'beta-tool-reader', persona: 'Dialogue file reader beta-tool-reader.' }]) {
    const directory = path.join(fixture.repoRootPath, 'agents', name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, `${name}.md`), [
      '---', `name: ${name}`, 'description: Dialogue file tool participant.',
      `provider: ${route}`, `model: ${MODEL}`, 'thinking: low', '---', '', persona, '',
    ].join('\n'))
  }
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession({ title: 'Dialogue tool evidence' })
  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath), sessionStore: store,
    launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: '' } } },
    workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath, providerSettingsService: settings,
    mcpSettingsService: new McpSettingsService({ storagePath: path.join(fixture.repoRootPath, 'mcp-settings.json') }),
  })

  const started = await fetch(`${server.url}/sessions/${session.id}/dialogues`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agents: ['alpha-tool-writer', 'beta-tool-reader'], topic: 'Create pilot-evidence.md with the pilot evidence, then discuss it.', maxTurns: 1 }),
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(started.status, 202, await started.clone().text())
  const record = agentDialogueRecordSchema.parse(await started.json())
  const streamed = await fetch(`${server.url}/sessions/${session.id}/dialogues/${record.dialogueId}/events?from=0`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(streamed.status, 200)
  assert.match(await streamed.text(), /event: ended\n/, 'wait for this dialogue to settle through its actual event stream')

  const saved = await store.listChatMessages(session.id)
  const reply = saved.find((message) => message.id === `${record.dialogueId}:reply:0`)
  assert.ok(reply, 'the exact first dialogue slot must have a saved reply')
  assert.equal(reply.speaker?.id, 'alpha-tool-writer')
  assert.equal(reply.text, ANSWER)
  assert.ok(reply.turnId, 'a dialogue slot must retain its provider turn identity')
  const assignmentIds = fs.readdirSync(path.join(fixture.workspacePath, 'sessions', session.id, 'runs', reply.turnId, 'assignments'))
  assert.equal(assignmentIds.length, 1, 'this slot owns exactly one tool assignment')
  const assignmentId = assignmentIds[0]
  assert.ok(assignmentId)
  const location = buildSessionRunAssignmentLocation(fixture.workspacePath, { sessionId: session.id, runId: reply.turnId, assignmentId })
  assert.ok(location, 'the persisted execution must identify a valid assignment location')
  assert.equal(fs.readFileSync(path.join(location.assignmentPath, 'files', 'pilot-evidence.md'), 'utf8'), FILE_CONTENT)
  assert.deepEqual(reply.execution, { runId: reply.turnId, assignmentId }, 'the saved reply must retain the exact execution that created its file')
  assert.equal(reply.delivery?.taskId, assignmentId)
  assert.ok(reply.delivery?.artifacts.some((artifact) => artifact.runId === assignmentId && artifact.path === 'files/pilot-evidence.md'), 'reloading the transcript must still offer the created file')
  const firstRequest = provider.requests.find((request) => request.systemPrompt?.includes(WRITER_PERSONA) === true && request.toolCount > 0)
  assert.ok(firstRequest, 'a plain provider fallback cannot satisfy this tool journey')
  assert.ok(toolNames(firstRequest).includes('create_file'))
  assert.ok(provider.requests.some((request) => toolResults(request).some((result) => result.includes('pilot-evidence.md'))), 'the tool result must reach the provider through the real tool loop')
})
