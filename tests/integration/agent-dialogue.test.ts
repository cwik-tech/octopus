import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import { z } from 'zod'

import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

const startResponse = z.object({ dialogueId: z.string(), sessionId: z.string() })
const dialogueEvent = z.object({ type: z.string() }).passthrough()
const ALPHA_PERSONA = 'Dialogue source persona alpha-analyst.'
const BETA_PERSONA = 'Dialogue source persona beta-builder.'
const MODEL = 'fake/dialogue'

test('two Agents alternate, read earlier replies and save the dialogue in their chat', { timeout: 20_000 }, async (t) => {
  const fixture = createSchedulerFixture('agent-dialogue-')
  let provider: FakeChatCompletionsServer | undefined
  let server: StartedApiServer | undefined
  t.after(async () => {
    await server?.close()
    await provider?.close()
    fixture.cleanup()
  })
  const turns = [
    { persona: ALPHA_PERSONA, text: 'A short pricing pilot will give us evidence.' },
    { persona: BETA_PERSONA, text: 'The pilot must include people who declined to buy.' },
    { persona: ALPHA_PERSONA, text: 'Then we will recruit both buyers and people who declined.' },
    { persona: BETA_PERSONA, text: 'That comparison addresses the original concern.' },
  ]
  // External providers are paid and nondeterministic. Replace only their HTTP
  // boundary; the API, turn assembly, tool loop and filesystem stores are real.
  provider = await startFakeChatCompletionsServer({
    models: [MODEL],
    script: turns.flatMap((turn) => [
      { match: (request) => request.systemPrompt?.includes(turn.persona) === true && !request.stream, content: turn.text },
      { match: (request) => request.systemPrompt?.includes(turn.persona) === true && request.stream, content: turn.text },
    ]),
  })
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(fixture.repoRootPath, 'provider-settings.json'),
  })
  const connection = await providerSettingsService.saveConnection({
    kind: 'lm-studio', name: 'Dialogue HTTP fixture',
    baseUrl: `${provider.url}/v1`, enabled: true,
  })
  const validated = await providerSettingsService.validateConnection(connection.id)
  assert.equal(validated.status, 'connected', 'the fake provider must validate as a configured connection')
  await providerSettingsService.setModelEnabled(connection.id, MODEL, true)
  const configuredProvider = configuredProviderName(connection.id)
  for (const { name, persona } of [
    { name: 'alpha-analyst', persona: ALPHA_PERSONA },
    { name: 'beta-builder', persona: BETA_PERSONA },
  ]) {
    const directory = path.join(fixture.repoRootPath, 'agents', name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, `${name}.md`), [
      '---', `name: ${name}`, 'description: Pricing dialogue participant.',
      `provider: ${configuredProvider}`, `model: ${MODEL}`, 'thinking: low',
      '---', '', persona, '',
    ].join('\n'))
  }
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const session = await store.createSession({ title: 'Pricing dialogue' })
  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: '' } } },
    sessionStore: store, workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath, workflowsRegistryPath: fixture.workflowsRegistryPath,
    providerSettingsService,
    mcpSettingsService: new McpSettingsService({ storagePath: path.join(fixture.repoRootPath, 'mcp-settings.json') }),
  })

  const topic = 'Discuss whether a small pilot will settle our pricing question.'
  const started = await fetch(`${server.url}/sessions/${session.id}/dialogues`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agents: ['alpha-analyst', 'beta-builder'], topic, maxTurns: 4 }),
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(started.status, 202, `starting a dialogue must return a background job; got ${started.status}: ${await started.clone().text()}`)
  const record = startResponse.parse(await started.json())
  assert.equal(record.sessionId, session.id)
  const events = await fetch(`${server.url}/sessions/${session.id}/dialogues/${record.dialogueId}/events?from=0`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(events.status, 200)
  assert.ok(events.body, 'dialogue events must have a response body')
  const reader = events.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let ended = false
  try {
    while (!ended) {
      const part = await reader.read()
      assert.equal(part.done, false, 'dialogue event stream ended without a terminal event')
      buffered += decoder.decode(part.value, { stream: true })
      let boundary = buffered.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (data !== '') {
          const event = dialogueEvent.parse(JSON.parse(data))
          ended = event.type === 'ended'
        }
        boundary = buffered.indexOf('\n\n')
      }
    }
  } finally {
    await reader.cancel()
  }

  const saved = await store.listChatMessages(session.id)
  assert.deepEqual(saved.map((message) => ({ role: message.role, speaker: message.speaker?.id, text: message.text })), [
    { role: 'user', speaker: undefined, text: topic },
    { role: 'assistant', speaker: 'alpha-analyst', text: 'A short pricing pilot will give us evidence.' },
    { role: 'assistant', speaker: 'beta-builder', text: 'The pilot must include people who declined to buy.' },
    { role: 'assistant', speaker: 'alpha-analyst', text: 'Then we will recruit both buyers and people who declined.' },
    { role: 'assistant', speaker: 'beta-builder', text: 'That comparison addresses the original concern.' },
  ])
  const finalRequests = provider.requests.filter((request) => request.stream)
  assert.equal(finalRequests.length, 4, 'each saved reply must come from one final provider request')
  assert.ok(finalRequests[0]?.systemPrompt?.includes(ALPHA_PERSONA), 'alpha must generate the first reply')
  assert.ok(finalRequests[1]?.systemPrompt?.includes(BETA_PERSONA), 'beta must generate the second reply')
  assert.ok(finalRequests[2]?.systemPrompt?.includes(ALPHA_PERSONA), 'alpha must generate the third reply')
  assert.ok(finalRequests[3]?.systemPrompt?.includes(BETA_PERSONA), 'beta must generate the fourth reply')
  assert.ok(finalRequests[1]?.userMessage?.includes('A short pricing pilot will give us evidence.'), 'the second Agent must read the first reply')
  assert.ok(finalRequests[2]?.userMessage?.includes('A short pricing pilot will give us evidence.'), 'the first Agent must read its own earlier reply')
  assert.ok(finalRequests[2]?.userMessage?.includes('The pilot must include people who declined to buy.'), 'the first Agent must read its colleague before replying again')
  assert.ok(finalRequests[3]?.userMessage?.includes('A short pricing pilot will give us evidence.'), 'the fourth reply must retain the first reply as context')
  assert.ok(finalRequests[3]?.userMessage?.includes('The pilot must include people who declined to buy.'), 'the fourth reply must retain the second reply as context')
  assert.ok(finalRequests[3]?.userMessage?.includes('Then we will recruit both buyers and people who declined.'), 'the fourth reply must read the preceding reply')
})
