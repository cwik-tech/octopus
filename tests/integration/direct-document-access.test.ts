import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { initProviders } from '../../providers/index.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsRequest } from '../support/fake-chat-completions-server.js'

test('a direct Agent route without a tool service prepares final-section evidence before answering', { timeout: 30_000 }, async () => {
  initProviders()
  const fixture = createSchedulerFixture('direct-document-')
  // Only the nondeterministic provider's HTTP boundary is replaced.
  const model = await startFakeChatCompletionsServer({ script: [
    { match: (request) => Boolean(request.systemPrompt?.includes('Review this fragment') && request.userMessage?.includes('DIRECT_FINAL_FACT=8192')), content: JSON.stringify({ evidence: ['DIRECT_FINAL_FACT=8192'] }) },
    ...Array.from({ length: 30 }, () => ({ match: (request: FakeChatCompletionsRequest) => Boolean(request.systemPrompt?.includes('Review this fragment')), content: '{"evidence":[]}' })),
    { content: 'The final fact is 8192.' },
  ] })
  setConfiguredProviderConnections([{ id: 'direct-reader', name: 'Direct reader', kind: 'openai-compatible', baseUrl: `${model.url}/v1`, apiKey: 'fixture' }]);
  try {
    const agent = path.join(fixture.repoRootPath, 'agents', 'reader')
    fs.mkdirSync(agent, { recursive: true })
    fs.writeFileSync(path.join(agent, 'reader.md'), `---\nname: reader\ndescription: Reads evidence.\nprovider: connection:direct-reader\nmodel: local-7b\n---\nUse document evidence.`)
    const store = new FileSystemSessionStore(fixture.workspacePath)
    const session = await store.createSession({ title: 'Direct document' })
    await store.saveUploadedFile(session.id, { filename: 'source.txt', contents: Buffer.from('background '.repeat(8_000) + '\nDIRECT_FINAL_FACT=8192') })
    await new SourceFileParserLauncher(process.cwd()).parseDirectory(store.inputsDir(session.id))
    const result = await runSessionAgentChatTurn({ sessionId: session.id, session, sessionStore: store, repoRootPath: fixture.repoRootPath, text: 'Find DIRECT_FINAL_FACT.', agentNames: ['reader'] })
    assert.ok(model.requests.length > 0, JSON.stringify(result));
    assert.match(JSON.stringify(model.requests.at(-1)?.body.messages), /DIRECT_FINAL_FACT=8192/)
    assert.ok(model.requests.some((request) => request.systemPrompt?.includes('Review this fragment')))
  } finally { setConfiguredProviderConnections([]); await model.close(); fixture.cleanup() }
})
