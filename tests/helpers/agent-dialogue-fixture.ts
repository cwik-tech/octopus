import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { TestContext } from 'node:test'
import { agentDialogueEventSchema, agentDialogueRecordSchema, type AgentDialogueEvent } from '../../contracts/agent-dialogue.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { startApiServer, type ApiServerOptions, type StartedApiServer } from '../../server/api-server.js'
import type { AgentDialogueClock } from '../../services/agent-dialogue-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsServer, type FakeChatCompletionsTurn } from '../support/fake-chat-completions-server.js'
import { createSchedulerFixture } from './scheduler-fixture.js'

export const DIALOGUE_ALPHA = 'Dialogue source persona alpha-analyst.'
export const DIALOGUE_BETA = 'Dialogue source persona beta-builder.'

export async function createDialogueFixture(t: TestContext, script: readonly FakeChatCompletionsTurn[], clock?: AgentDialogueClock,
  contextOptions: Pick<ApiServerOptions, 'sharedFolderGrantStore' | 'appDataPath' | 'apiToken' | 'voiceControl'> = {}) {
  const fixture = createSchedulerFixture('dialogue-controls-')
  let provider: FakeChatCompletionsServer | undefined
  let server: StartedApiServer | undefined
  t.after(async () => { await server?.close(); await provider?.close(); fixture.cleanup() })
  // Paid, nondeterministic providers are replaced at HTTP; all local services
  // and stores are real and every provider request remains observable.
  provider = await startFakeChatCompletionsServer({ models: ['fake/dialogue'], script })
  const settings = new ProviderSettingsService({ storagePath: path.join(fixture.repoRootPath, 'providers.json') })
  const connection = await settings.saveConnection({ kind: 'lm-studio', name: 'Fixture', baseUrl: `${provider.url}/v1`, enabled: true })
  assert.equal((await settings.validateConnection(connection.id)).status, 'connected')
  await settings.setModelEnabled(connection.id, 'fake/dialogue', true)
  for (const agent of [{ name: 'alpha-analyst', persona: DIALOGUE_ALPHA }, { name: 'beta-builder', persona: DIALOGUE_BETA }]) {
    const directory = path.join(fixture.repoRootPath, 'agents', agent.name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, `${agent.name}.md`), ['---', `name: ${agent.name}`, 'description: Dialogue fixture.', `provider: ${configuredProviderName(connection.id)}`, 'model: fake/dialogue', 'thinking: low', '---', '', agent.persona].join('\n'))
  }
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const hub = new AgentTextStreamHub()
  const session = await store.createSession({ title: 'Dialogue controls' })
  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath), launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: '' } } },
    sessionStore: store, agentTextStreamHub: hub, repoRootPath: fixture.repoRootPath, workspacePath: fixture.workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath, providerSettingsService: settings,
    mcpSettingsService: new McpSettingsService({ storagePath: path.join(fixture.repoRootPath, 'mcp.json') }),
    ...(clock ? { agentDialogueClock: clock } : {}),
    ...contextOptions,
  })
  const base = `${server.url}/sessions/${session.id}/dialogues`
  const post = (suffix: string, body: unknown = {}) => fetch(`${base}${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  })
  const start = async (overrides: Record<string, unknown> = {}) => {
    const response = await post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Consider pricing.', maxTurns: 4, ...overrides })
    assert.equal(response.status, 202, await response.clone().text())
    return agentDialogueRecordSchema.parse(await response.json())
  }
  return { ...fixture, store, session, server, provider, hub, base, post, start }
}

export async function waitForDialogueEvent(base: string, dialogueId: string, accepts: (event: AgentDialogueEvent) => boolean): Promise<AgentDialogueEvent> {
  const response = await fetch(`${base}/${dialogueId}/events?from=0`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  let buffered = ''
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const part = await reader.read()
      assert.equal(part.done, false, 'Dialogue stream closed before the expected event')
      buffered += decoder.decode(part.value, { stream: true })
      let boundary = buffered.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (data) {
          const event = agentDialogueEventSchema.parse(JSON.parse(data))
          if (accepts(event)) return event
        }
        boundary = buffered.indexOf('\n\n')
      }
    }
  } finally { await reader.cancel() }
}
