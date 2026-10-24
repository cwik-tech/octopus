import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { z } from 'zod'

import { sharedFolderListResponseSchema } from '../../contracts/shared-folders.js'
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
import { StandInFileParser } from '../support/stand-in-file-parser.js'

/**
 * Revoking a folder's grant (LF-12; SEC-9; docs/feature-local-folder-access.md,
 * "Retention").
 *
 * Through the real API, grant list, folder store, turn assembly, tool loop and
 * folder index. The model is replaced at its HTTP boundary, and the parser
 * process by a gated stand-in, because the test needs one parse still running
 * when access is removed; no real parse can promise that.
 *
 * The barrier is inside the turn: the provider holds its second answer until
 * the test has revoked the grant and seen the cleanup. That answer then asks
 * for the same file again.
 */

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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

test('after its grant is revoked, the next tool call of a running turn fails, running parses stop and parsed text is deleted', async (t) => {
  const fixture = createSchedulerFixture('folder-revocation-')
  const userFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-revocation-user-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-revocation-appdata-')))
  fs.writeFileSync(path.join(userFolder, 'minutes.pdf'), 'The board approved the ALPHA-BUDGET.\n')
  fs.writeFileSync(path.join(userFolder, 'forecast.pdf'), 'Forecast still being parsed.\n')
  const parser = new StandInFileParser('gated-first')
  const indexRoot = path.join(fixture.workspacePath, 'folder-index')
  const cachedFolders = (): string[] => (fs.existsSync(indexRoot) ? fs.readdirSync(indexRoot) : [])

  const readArguments: Record<string, unknown> = { path: 'minutes.pdf' }
  const secondRound = deferred()
  const cleanupSeen = deferred()
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) => isTurnRequest(request) && toolResultContents(request).length === 0,
        toolCalls: [{ id: 'call-read-before', name: 'folder_read', arguments: readArguments }],
      },
      {
        match: (request) => {
          if (!isTurnRequest(request) || toolResultContents(request).length !== 1) return false
          secondRound.resolve()
          return true
        },
        gate: cleanupSeen.promise,
        toolCalls: [{ id: 'call-read-after', name: 'folder_read', arguments: readArguments }],
      },
      { content: 'Done.', deltas: ['Done.'] },
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
    cleanupSeen.resolve()
    await server?.close()
    await provider.close()
    fixture.cleanup()
    fs.rmSync(userFolder, { recursive: true, force: true })
    fs.rmSync(appDataPath, { recursive: true, force: true })
  })
  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: noRuns,
    fileParserLauncher: parser,
    sessionStore: new FileSystemSessionStore(fixture.workspacePath),
    workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    sharedFolderGrantStore: grants,
    appDataPath,
  })
  const created = await fetch(`${server.url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Board' }),
  })
  const { id: sessionId } = createdSchema.parse(await created.json())
  const folders = `${server.url}/sessions/${sessionId}/folders`
  const attached = await fetch(folders, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: userFolder }),
  })
  assert.equal(attached.status, 201, await attached.clone().text())
  readArguments.folder = createdSchema.parse(await attached.json()).id
  // Attaching starts both parses; the minutes finish, the forecast stays running.
  await Promise.all([parser.whenLaunched('minutes.pdf'), parser.whenLaunched('forecast.pdf')])
  await parser.finish('minutes.pdf')

  const turn = fetch(`${server.url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'What did the board approve?',
      target: { kind: 'agents', agentNames: [agentName] },
      turnId: randomUUID(),
    }),
  })
  // The first read has answered, so its text is in the cache, and the turn is still running.
  await secondRound.promise
  const cachedBefore = cachedFolders().length
  await grants.revoke(userFolder)
  const listed = sharedFolderListResponseSchema.parse(await (await fetch(folders)).json()).folders
  const afterRevocation = { aborted: parser.isAborted('forecast.pdf'), cached: cachedFolders() }
  cleanupSeen.resolve()
  const answered = await turn
  assert.ok(answered.status < 400, `turn failed: ${answered.status} ${await answered.clone().text()}`)

  const results = turnToolResults(provider.requests)
  assert.ok((results[0] ?? '').includes('ALPHA-BUDGET'), `first read: ${results[0] ?? ''}`)
  assert.equal(cachedBefore, 1)
  assert.deepEqual(listed.map((folder) => folder.status), [{ state: 'unavailable', reason: 'access_removed' }])
  assert.deepEqual(afterRevocation, { aborted: true, cached: [] })
  assert.match(results[1] ?? '', /Access to this folder was removed/)
  assert.equal((results[1] ?? '').includes('ALPHA-BUDGET'), false)
})
