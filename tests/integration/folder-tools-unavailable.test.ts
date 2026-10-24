import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

/**
 * Models that can't use the folder tools (docs/feature-local-folder-access.md,
 * "Models that can't use tools"; LF-09).
 *
 * The direct Anthropic connection has no tool lane in chat
 * (`domains/mcp/mcp-provider-support.ts`), so its replies come from a plain
 * call. With folders attached the model sees the map but can't open a file,
 * and the reply's meta says so for the chat to show its notice. Everything is
 * production code through the real API except the two models, each replaced
 * at its HTTP boundary on loopback.
 */

interface MessagesRequest {
  readonly body: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A loopback Anthropic Messages endpoint that answers every request whole, as JSON. */
async function startFakeMessagesEndpoint(t: TestContext): Promise<{ url: string; requests: MessagesRequest[] }> {
  const requests: MessagesRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      requests.push({ body: isRecord(parsed) ? parsed : {} })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'fake-claude',
        content: [{ type: 'text', text: 'I can see the folder name only.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 8 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { url: `http://127.0.0.1:${address.port}/v1/messages`, requests }
}

function writeAgent(repoRootPath: string, name: string, header: readonly string[]): void {
  const agentDir = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    ['---', `name: ${name}`, 'description: Answers about attached folders.', 'tier: execution', ...header, '---', '', `# ${name}`, ''].join('\n'),
    'utf8',
  )
}

/** A real API with one agent on the direct Anthropic lane and one on a tool-capable lane. */
async function makeApi(t: TestContext) {
  const fixture = createSchedulerFixture('folder-tools-unavailable-')
  const userFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-tools-unavailable-user-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-tools-unavailable-appdata-')))
  fs.writeFileSync(path.join(userFolder, 'notes.md'), '# Notes\n', 'utf8')

  // The direct Anthropic provider reads its key from the environment. A fake
  // key for a loopback endpoint; the real one, if any, comes back afterwards.
  const previousKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'test-key-loopback-only'
  const messages = await startFakeMessagesEndpoint(t)
  const toolLane = await startFakeChatCompletionsServer({
    script: [{ content: 'I could open the files.', deltas: ['I could open the files.'] }],
  })

  writeAgent(fixture.repoRootPath, 'plain-reader', [
    'provider: anthropic',
    'model: fake-claude',
    'thinking: low',
    `provider_options: ${JSON.stringify({ base_url: messages.url })}`,
  ])
  writeAgent(fixture.repoRootPath, 'tool-reader', [
    'provider: lm-studio',
    'model: local-7b',
    'thinking: low',
    `provider_options: ${JSON.stringify({ base_url: toolLane.url })}`,
  ])

  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'shared-folder-grants.json'))
  await grants.initialize()
  await grants.grant(userFolder)
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: '' } } },
    sessionStore: new FileSystemSessionStore(fixture.workspacePath),
    workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    sharedFolderGrantStore: grants,
    appDataPath,
  })
  t.after(async () => {
    await server.close()
    await toolLane.close()
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    fixture.cleanup()
    fs.rmSync(userFolder, { recursive: true, force: true })
    fs.rmSync(appDataPath, { recursive: true, force: true })
  })

  const createChat = async (withFolder: boolean): Promise<string> => {
    const created = await fetch(`${server.url}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Folder notice' }),
    })
    assert.equal(created.status, 201)
    const { id } = (await created.json()) as { id: string }
    if (withFolder) {
      const attached = await fetch(`${server.url}/sessions/${id}/folders`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: userFolder }),
      })
      assert.equal(attached.status, 201, await attached.clone().text())
    }
    return id
  }

  /** Sends one turn to one agent and returns its reply's meta entry. */
  const replyMeta = async (sessionId: string, agentName: string): Promise<Record<string, unknown>> => {
    const answered = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'What is in my notes?',
        target: { kind: 'agents', agentNames: [agentName] },
        turnId: randomUUID(),
      }),
    })
    assert.equal(answered.status, 201, await answered.clone().text())
    const body: unknown = await answered.json()
    assert.ok(isRecord(body) && isRecord(body.meta) && Array.isArray(body.meta.replies))
    const [reply] = body.meta.replies
    assert.ok(isRecord(reply), 'the turn has one reply')
    assert.equal(reply.fallback, false, `the reply is the model's answer: ${JSON.stringify(reply)}`)
    return reply
  }

  return { createChat, replyMeta, messages }
}

test('a reply from a model without tools, in a turn with folders, says the folder tools were unavailable', async (t) => {
  const api = await makeApi(t)
  const sessionId = await api.createChat(true)

  const reply = await api.replyMeta(sessionId, 'plain-reader')

  assert.equal(reply.folderToolsUnavailable, true)
  // The reply came from the plain call: the model was asked, with no tools.
  const asked = api.messages.requests.at(-1)
  assert.ok(asked, 'the direct Anthropic endpoint answered the turn')
  assert.equal('tools' in asked.body, false)
})

test('a reply from a model without tools, in a turn without folders, says nothing about folder tools', async (t) => {
  const api = await makeApi(t)
  const sessionId = await api.createChat(false)

  const reply = await api.replyMeta(sessionId, 'plain-reader')

  assert.equal('folderToolsUnavailable' in reply, false)
  assert.ok(api.messages.requests.length > 0, 'the direct Anthropic endpoint answered the turn')
})

test('a reply that ran with tools, in a turn with folders, says nothing about folder tools', async (t) => {
  const api = await makeApi(t)
  const sessionId = await api.createChat(true)

  const reply = await api.replyMeta(sessionId, 'tool-reader')

  assert.equal('folderToolsUnavailable' in reply, false)
})
