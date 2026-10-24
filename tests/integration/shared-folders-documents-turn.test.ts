import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { z } from 'zod'

import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
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
 * Local folder access, phase 3 acceptance (docs/feature-local-folder-access.md,
 * "Indexing and the parse cache"; LF-06 end to end).
 *
 * One journey through the real API, folder store, turn assembly, tool loop,
 * folder index and file parser. Only the model is replaced, at its HTTP
 * boundary. The agent reads a PDF in an attached folder and then searches for
 * a phrase that exists only inside that PDF.
 *
 * The read comes first because a turn never waits for background indexing: a
 * read parses on demand and waits, so by the time the search runs the PDF's
 * text is in the cache, whatever the machine's speed.
 */

const PDF_PHRASE = 'soil water retention technology'
const FIXTURES = path.join(process.cwd(), 'file-parser', 'tests', 'fixtures')

/** This journey starts no workflow runs. */
const noRuns: RunLauncher = { async startRun() { return { launched: true, pid: 0, cwd: '' } } }
const createdSchema = z.object({ id: z.string() })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolResultContents(request: FakeChatCompletionsRequest): string[] {
  const messages = request.body.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message: unknown) =>
    isRecord(message) && message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [])
}

function isTurnRequest(request: FakeChatCompletionsRequest): boolean {
  return !isProviderHealthProbe(request) && request.toolCount > 0
}

/** Every tool result of the turn, in order: the turn's last request carries them all. */
function turnToolResults(requests: readonly FakeChatCompletionsRequest[]): string[] {
  const last = requests.filter(isTurnRequest).at(-1)
  return last ? toolResultContents(last) : []
}

/** Every entry under `root` with its size and modification time; equal snapshots mean nothing was written. */
function snapshotTree(root: string): string[] {
  const rows = [`.|dir|${fs.statSync(root).mtimeMs}`]
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const fullPath = path.join(entry.parentPath, entry.name)
    const stat = fs.lstatSync(fullPath)
    rows.push(`${path.relative(root, fullPath)}|${stat.isDirectory() ? 'dir' : String(stat.size)}|${stat.mtimeMs}`)
  }
  return rows.sort()
}

test('a turn reads and searches text inside a PDF in an attached folder, and the folder gains no files', async (t) => {
  const fixture = createSchedulerFixture('shared-folder-documents-')
  const userFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-documents-user-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-documents-appdata-')))
  fs.mkdirSync(path.join(userFolder, 'Board packs'))
  fs.copyFileSync(path.join(FIXTURES, 'malformed-trailer.pdf'), path.join(userFolder, 'Board packs', 'business plan.pdf'))
  fs.writeFileSync(path.join(userFolder, 'readme.md'), 'Board packs for 2026.\n')

  // The folder ID is known only once the folder is attached, so the calls are filled in then.
  const readArguments: Record<string, unknown> = { path: 'Board packs/business plan.pdf' }
  const searchArguments: Record<string, unknown> = { query: 'soil water retention' }
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) => isTurnRequest(request) && toolResultContents(request).length === 0,
        toolCalls: [{ id: 'call-read-pdf', name: 'folder_read', arguments: readArguments }],
      },
      {
        match: (request) => isTurnRequest(request) && toolResultContents(request).length === 1,
        toolCalls: [{ id: 'call-search-pdf', name: 'folder_search', arguments: searchArguments }],
      },
      { content: 'Answered from the PDF.', deltas: ['Answered from the PDF.'] },
    ],
  })

  const agentName = 'folder-reader'
  const agentDir = path.join(fixture.repoRootPath, 'agents', agentName)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${agentName}.md`),
    [
      '---',
      `name: ${agentName}`,
      'description: Reads attached folders.',
      'tier: execution',
      'provider: lm-studio',
      'model: local-7b',
      'thinking: low',
      `provider_options: ${JSON.stringify({ base_url: provider.url })}`,
      '---',
      '',
      '# Folder reader',
      '',
    ].join('\n'),
    'utf8',
  )

  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'shared-folder-grants.json'))
  await grants.initialize()
  await grants.grant(userFolder)

  let server: StartedApiServer | undefined
  t.after(async () => {
    await server?.close()
    await provider.close()
    fixture.cleanup()
    fs.rmSync(userFolder, { recursive: true, force: true })
    fs.rmSync(appDataPath, { recursive: true, force: true })
  })
  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: noRuns,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
    sessionStore: new FileSystemSessionStore(fixture.workspacePath),
    workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    sharedFolderGrantStore: grants,
    appDataPath,
  })
  const before = snapshotTree(userFolder)

  const created = await fetch(`${server.url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Board packs' }),
  })
  assert.equal(created.status, 201)
  const { id: sessionId } = createdSchema.parse(await created.json())
  const attached = await fetch(`${server.url}/sessions/${sessionId}/folders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: userFolder }),
  })
  assert.equal(attached.status, 201, await attached.clone().text())
  const folder = createdSchema.parse(await attached.json())
  readArguments.folder = folder.id
  searchArguments.folder = folder.id

  const answered = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'What technology does the business plan describe?',
      target: { kind: 'agents', agentNames: [agentName] },
      turnId: randomUUID(),
    }),
  })
  assert.ok(answered.status < 400, `turn failed: ${answered.status} ${await answered.clone().text()}`)

  const turnRequests = provider.requests.filter(isTurnRequest)
  const results = turnToolResults(provider.requests)
  const readResult = results[0] ?? ''
  const searchResult = results[1] ?? ''
  assert.ok(readResult.includes(PDF_PHRASE), `folder_read returned: ${readResult}`)
  assert.match(readResult, /trust="untrusted_user_content"/)
  assert.equal(results.length, 2)
  assert.match(
    searchResult,
    /^Board packs\/business plan\.pdf:\d+: .*soil water retention technology/m,
    `folder_search returned: ${searchResult}`,
  )
  for (const request of turnRequests) {
    assert.equal((request.userMessage ?? '').includes(PDF_PHRASE), false, 'document text never enters the prompt')
  }
  assert.deepEqual(snapshotTree(userFolder), before, "nothing was written inside the user's folder")
})
