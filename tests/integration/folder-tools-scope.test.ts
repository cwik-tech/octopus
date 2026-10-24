import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import {
  isProviderHealthProbe,
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
} from '../support/fake-chat-completions-server.js'

/**
 * Two chats, one agent, overlapping turns (LF-08; SEC-8).
 *
 * The tool service is shared by every chat, so the only thing that keeps one
 * chat out of another's folder is the scope each turn is built with. The two
 * turns are forced to overlap by events, not timing: B's provider reply waits
 * until A's first request has arrived, and A's waits until B has finished. A
 * then asks for B's folder by B's real folder ID.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolResultContents(request: FakeChatCompletionsRequest): string[] {
  const messages = request.body.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message: unknown) =>
    isRecord(message) && message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [])
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

test("overlapping turns of one agent in two chats each reach only their own folder", async (t) => {
  const fixture = createSchedulerFixture('folder-scope-')
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-scope-user-')))
  const folderA = path.join(base, 'Alpha')
  const folderB = path.join(base, 'Beta')
  fs.mkdirSync(folderA)
  fs.mkdirSync(folderB)
  fs.writeFileSync(path.join(folderA, 'a.md'), 'ALPHA-CONTENT\n')
  fs.writeFileSync(path.join(folderB, 'b.md'), 'BETA-SECRET\n')
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-scope-appdata-')))

  const ids = { a: '', b: '' }
  const crossRead: Record<string, unknown> = { path: 'b.md' }
  const ownRead: Record<string, unknown> = { path: 'b.md' }
  const aArrived = deferred()
  const bDone = deferred()
  const isFirstRoundOf = (request: FakeChatCompletionsRequest, folderId: string): boolean =>
    !isProviderHealthProbe(request) &&
    request.toolCount > 0 &&
    toolResultContents(request).length === 0 &&
    (request.userMessage ?? '').includes(folderId)

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) => {
          if (!isFirstRoundOf(request, ids.a)) return false
          aArrived.resolve()
          return true
        },
        gate: bDone.promise,
        toolCalls: [{ id: 'call-a-cross', name: 'folder_read', arguments: crossRead }],
      },
      {
        match: (request) => isFirstRoundOf(request, ids.b),
        gate: aArrived.promise,
        toolCalls: [{ id: 'call-b-own', name: 'folder_read', arguments: ownRead }],
      },
      { content: 'Done.', deltas: ['Done.'] },
    ],
  })

  const agentName = 'folder-reader'
  fs.mkdirSync(path.join(fixture.repoRootPath, 'agents', agentName), { recursive: true })
  fs.writeFileSync(path.join(fixture.repoRootPath, 'agents', agentName, `${agentName}.md`), [
    '---', `name: ${agentName}`, 'description: Reads attached folders.', 'tier: execution',
    'provider: lm-studio', 'model: local-7b', 'thinking: low',
    `provider_options: ${JSON.stringify({ base_url: provider.url })}`, '---', '', '# Folder reader', '',
  ].join('\n'))

  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'shared-folder-grants.json'))
  await grants.initialize()
  await grants.grant(folderA)
  await grants.grant(folderB)

  let server: StartedApiServer | undefined
  t.after(async () => {
    await server?.close()
    await provider.close()
    fixture.cleanup()
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(appDataPath, { recursive: true, force: true })
  })
  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: '' } } },
    sessionStore: new FileSystemSessionStore(fixture.workspacePath),
    workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    sharedFolderGrantStore: grants,
    appDataPath,
  })
  const url = server.url

  const createChatWithFolder = async (folder: string): Promise<{ sessionId: string; folderId: string }> => {
    const created = await fetch(`${url}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: path.basename(folder) }),
    })
    const { id: sessionId } = (await created.json()) as { id: string }
    const attached = await fetch(`${url}/sessions/${sessionId}/folders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }),
    })
    assert.equal(attached.status, 201)
    const { id: folderId } = (await attached.json()) as { id: string }
    return { sessionId, folderId }
  }
  const chatA = await createChatWithFolder(folderA)
  const chatB = await createChatWithFolder(folderB)
  ids.a = chatA.folderId
  ids.b = chatB.folderId
  crossRead.folder = chatB.folderId
  ownRead.folder = chatB.folderId

  const send = (sessionId: string) => fetch(`${url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'What does my folder say?', target: { kind: 'agents', agentNames: [agentName] }, turnId: randomUUID() }),
  })
  const turnA = send(chatA.sessionId)
  const turnB = send(chatB.sessionId).finally(() => bDone.resolve())
  const [answeredA, answeredB] = await Promise.all([turnA, turnB])
  assert.ok(answeredA.status < 400, await answeredA.clone().text())
  assert.ok(answeredB.status < 400, await answeredB.clone().text())

  const followUps = provider.requests.filter((request) => toolResultContents(request).length > 0)
  const resultsFor = (folderId: string): string[] => followUps
    .filter((request) => (request.userMessage ?? '').includes(folderId))
    .flatMap(toolResultContents)
  assert.ok(resultsFor(chatB.folderId).some((content) => content.includes('BETA-SECRET')), "B reads its own folder")
  const aResults = resultsFor(chatA.folderId)
  assert.ok(aResults.length > 0, "A's tool call was answered")
  assert.equal(aResults.some((content) => content.includes('BETA-SECRET')), false, "A never sees B's folder")
  assert.ok(aResults.some((content) => /unknown folder/i.test(content)), "A's request for B's folder ID is refused as unknown")
})
