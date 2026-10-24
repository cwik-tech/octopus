import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { voiceControlDescriptorSchema } from '../../contracts/voice-control.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { createDialogueFixture, DIALOGUE_ALPHA, DIALOGUE_BETA, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'
import type { FakeChatCompletionsTurn } from '../support/fake-chat-completions-server.js'

async function createMcpDialogueFixture(t: TestContext, script: readonly FakeChatCompletionsTurn[]) {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-mcp-discovery-'))
  let ownedTransport: StreamableHTTPClientTransport | undefined
  let ownedClient: Client | undefined
  // This hook precedes the API fixture hook: terminate the SDK session while
  // its authenticated HTTP endpoint is still alive.
  t.after(async () => { await ownedTransport?.terminateSession(); await ownedClient?.close() })
  const fixture = await createDialogueFixture(t, script, undefined, {
    apiToken: randomBytes(32).toString('base64url'),
    voiceControl: { mcpToken: randomBytes(32).toString('base64url'), discoveryDir },
  })
  const raw: unknown = JSON.parse(await fs.readFile(path.join(discoveryDir, 'apps', 'octopus.json'), 'utf8'))
  const descriptor = voiceControlDescriptorSchema.parse(raw)
  const transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), {
    requestInit: { headers: { ...descriptor.mcp.headers } },
  })
  const client = new Client({ name: 'dialogue-acceptance', version: '1.0.0' })
  ownedTransport = transport
  ownedClient = client
  await client.connect(new ExactOptionalMcpTransport(transport))
  t.after(async () => { await fs.rm(discoveryDir, { recursive: true, force: true }) })
  return { ...fixture, client }
}

function dialogueResult(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return agentDialogueRecordSchema.parse(result.structuredContent)
}

for (const scenario of [
  { name: 'an ask with a display name instead of its Agent ID', tool: 'ask', arguments: { agentName: 'Alpha Analyst', text: 'Consider pricing.' } },
  { name: 'a dialogue with a display name instead of its Agent ID', tool: 'start_dialogue', arguments: { agents: ['Alpha Analyst', 'beta-builder'], topic: 'Consider pricing.' } },
  { name: 'a dialogue whose continuation is unavailable', tool: 'start_dialogue', arguments: { agents: ['alpha-analyst', 'beta-builder'], topic: 'Consider pricing.', continues: '88888888-8888-4888-8888-888888888888' } },
]) {
  test(`refusing ${scenario.name} leaves no new empty chat`, { timeout: 20_000 }, async (t) => {
    const fixture = await createMcpDialogueFixture(t, [])
    const before = (await fixture.store.listSessions()).map((session) => session.id)
    const result = await fixture.client.callTool({ name: scenario.tool, arguments: scenario.arguments })
    assert.equal(result.isError, true)
    assert.deepEqual((await fixture.store.listSessions()).map((session) => session.id), before, 'A refused call must preserve the pre-existing chats')
    const inExistingChat = await fixture.client.callTool({ name: scenario.tool, arguments: { ...scenario.arguments, sessionId: fixture.session.id } })
    assert.equal(inExistingChat.isError, true)
    assert.deepEqual((await fixture.store.listSessions()).map((session) => session.id), before, 'A refusal must never delete a caller-supplied chat')
  })
}

test('ask advertises its actual two-minute limit and tells callers how to request long work', { timeout: 20_000 }, async (t) => {
  const fixture = await createMcpDialogueFixture(t, [])
  const ask = (await fixture.client.listTools()).tools.find((tool) => tool.name === 'ask')
  assert.ok(ask?.description?.includes('120-second'), 'The voice client must receive the actual REST deadline')
  assert.ok(ask?.description?.includes('start a workflow'), 'Long work must name an available asynchronous alternative')
})

test('refusing an unusable Agent leaves no new empty voice chat', { timeout: 20_000 }, async (t) => {
  const fixture = await createMcpDialogueFixture(t, [])
  const agentFile = path.join(fixture.repoRootPath, 'agents', 'alpha-analyst', 'alpha-analyst.md')
  const before = (await fixture.store.listSessions()).map((session) => session.id)
  const source = await fs.readFile(agentFile, 'utf8')
  await fs.writeFile(agentFile, source.replace('thinking: low', `thinking: low\nprovider_options: '['`))
  const result = await fixture.client.callTool({ name: 'ask', arguments: { agentName: 'alpha-analyst', text: 'Consider pricing.' } })
  assert.equal(result.isError, true)
  assert.deepEqual((await fixture.store.listSessions()).map((session) => session.id), before)
})

test('an authenticated MCP client explicitly starts a text dialogue in a new chat and reads its saved replies', { timeout: 20_000 }, async (t) => {
  const fixture = await createMcpDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Alpha proposes a monthly plan.' },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Alpha proposes a monthly plan.' },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'Beta adds annual billing.' },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'Beta adds annual billing.' },
  ])
  assert.equal(fixture.provider.requests.length, 0, 'Connecting must not begin a dialogue')
  const catalog = await fixture.client.listTools()
  const dialogueTools = catalog.tools.filter((tool) => tool.name.endsWith('_dialogue'))
  assert.deepEqual(dialogueTools.map((tool) => tool.name).sort(), ['get_dialogue', 'interject_dialogue', 'pause_dialogue', 'resume_dialogue', 'start_dialogue', 'stop_dialogue'])
  const startTool = dialogueTools.find((tool) => tool.name === 'start_dialogue')
  assert.ok(startTool)
  // The real SDK catalog is what Hexa forwards to its brain. This protects the
  // instruction boundary; live model clarification still needs a live trial.
  assert.ok(startTool.description?.includes('ask for clarification before calling start_dialogue'), 'The MCP tool must instruct clarification before an ambiguous dialogue start')
  assert.ok(startTool.description?.includes('ambiguous about starting a dialogue, its topic, or the named Agents'), 'MCP clarification must cover intent, topic and participant ambiguity')
  assert.ok(startTool.description?.includes('Do not choose unnamed Agents'), 'The MCP tool must not invite the model to invent participant Agents')
  const started = dialogueResult(await fixture.client.callTool({ name: 'start_dialogue', arguments: {
    agents: ['alpha-analyst', 'beta-builder'], topic: 'Compare billing plans.', maxTurns: 2,
  } }))
  assert.equal(started.delivery, 'text')
  assert.notEqual(started.sessionId, fixture.session.id, 'Omitting the session creates a normal chat')
  const base = `${fixture.server.url}/sessions/${started.sessionId}/dialogues`
  await waitForDialogueEvent(base, started.dialogueId, (event) => event.type === 'ended')
  const read = dialogueResult(await fixture.client.callTool({ name: 'get_dialogue', arguments: { dialogueId: started.dialogueId } }))
  assert.equal(read.status, 'ended')
  assert.equal(read.replyCount, 2)
  assert.equal((await fixture.store.listChatMessages(started.sessionId))[0]?.role, 'user', 'An explicit voice-layer start retains the user topic')
  assert.deepEqual((await fixture.store.listChatMessages(started.sessionId)).map((message) => ({ text: message.text, kind: message.source?.kind })), [
    { text: 'Compare billing plans.', kind: 'agent-dialogue' },
    { text: 'Alpha proposes a monthly plan.', kind: 'agent-dialogue' },
    { text: 'Beta adds annual billing.', kind: 'agent-dialogue' },
  ])
  assert.ok(fixture.provider.requests.filter((request) => request.stream)[1]?.userMessage?.includes('Alpha proposes a monthly plan.'), 'The second speaker must receive the first reply through the shared loop')
})

test('MCP controls pause, interject once, resume and idempotently stop the same dialogue without deleting its chat', { timeout: 20_000 }, async (t) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const streaming = new Promise<void>((resolve) => { requested = resolve })
  const fixture = await createMcpDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'A pending reply.' },
    { match: (request) => { if (!request.stream) return false; requested(); return true }, content: 'A pending reply.', gate },
  ])
  t.after(release)
  const started = dialogueResult(await fixture.client.callTool({ name: 'start_dialogue', arguments: {
    sessionId: fixture.session.id, agents: ['alpha-analyst', 'beta-builder'], topic: 'Consider pricing.', delivery: 'text', maxTurns: 4,
  } }))
  assert.equal(started.delivery, 'text')
  await streaming
  const address = { dialogueId: started.dialogueId }
  assert.equal(dialogueResult(await fixture.client.callTool({ name: 'pause_dialogue', arguments: address })).status, 'paused')
  const interjection = { ...address, messageId: 'mcp-interjection-1', text: 'Consider smaller customers.' }
  await fixture.client.callTool({ name: 'interject_dialogue', arguments: interjection })
  const replay = dialogueResult(await fixture.client.callTool({ name: 'interject_dialogue', arguments: interjection }))
  assert.equal(replay.status, 'running', 'An interjection resumes a paused dialogue')
  assert.equal(dialogueResult(await fixture.client.callTool({ name: 'resume_dialogue', arguments: address })).status, 'running')
  assert.equal(dialogueResult(await fixture.client.callTool({ name: 'stop_dialogue', arguments: address })).status, 'stopped')
  assert.equal(dialogueResult(await fixture.client.callTool({ name: 'stop_dialogue', arguments: address })).status, 'stopped')
  release()
  await waitForDialogueEvent(fixture.base, started.dialogueId, (event) => event.type === 'ended')
  assert.ok(await fixture.store.getSession(fixture.session.id))
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.', interjection.text])
  const stopTool = (await fixture.client.listTools()).tools.find((tool) => tool.name === 'stop_dialogue')
  assert.equal(stopTool?.annotations?.destructiveHint, false)
  assert.equal(stopTool?.annotations?.idempotentHint, true)
})

test('deleting a completed dialogue chat removes durable and live lookups', { timeout: 20_000 }, async (t) => {
  const fixture = await createMcpDialogueFixture(t, [{ content: 'A finished reply.' }, { content: 'A finished reply.' }])
  const record = dialogueResult(await fixture.client.callTool({ name: 'start_dialogue', arguments: {
    agents: ['alpha-analyst', 'beta-builder'], topic: 'A temporary discussion.', maxTurns: 1,
  } }))
  await waitForDialogueEvent(`${fixture.server.url}/sessions/${record.sessionId}/dialogues`, record.dialogueId, (event) => event.type === 'ended')
  const deleted = await fetch(`${fixture.server.url}/sessions/${record.sessionId}`, { method: 'DELETE', signal: t.signal })
  assert.equal(deleted.status, 204)
  const read = await fixture.client.callTool({ name: 'get_dialogue', arguments: { dialogueId: record.dialogueId } })
  assert.equal(read.isError, true, 'A deleted chat must no longer resolve through an in-memory dialogue')
  const explicit = await fetch(`${fixture.server.url}/sessions/${record.sessionId}/dialogues/${record.dialogueId}`, { signal: t.signal })
  assert.equal(explicit.status, 404)
})
