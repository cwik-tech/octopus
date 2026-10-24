import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { z } from 'zod'

import { sharedFolderViewSchema } from '../../contracts/shared-folders.js'
import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import {
  isProviderHealthProbe,
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
  type FakeChatCompletionsToolCall,
  type FakeChatCompletionsTurn,
} from '../support/fake-chat-completions-server.js'

/**
 * Project folders reach every chat in the project (LF-03,
 * docs/feature-local-folder-access.md, "Which folders a turn gets").
 *
 * Each turn goes through the real API, membership, folder stores, turn
 * assembly and tool loop. Only the model is replaced, at its HTTP boundary.
 * What the agent was given is read from what reached the provider: the folder
 * map in the prompt, and the tool results for the files it asked to read. The
 * chat never sends a folder selection; every message carries only its text.
 */

const AGENT_NAME = 'folder-reader'
const FOLDER_ENTRY = /<folder id="(f_[a-z0-9]{10})" name="[^"]*" source="(session|project)"/g

const idSchema = z.object({ id: z.string() })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolResultContents(request: FakeChatCompletionsRequest): string[] {
  const messages = request.body.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message: unknown) =>
    isRecord(message) && message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [])
}

/** The provider request that opens a turn's tool loop. */
function isFirstToolRound(request: FakeChatCompletionsRequest): boolean {
  return !isProviderHealthProbe(request) && request.toolCount > 0 && toolResultContents(request).length === 0
}

/** The folders the turn's map gives the agent, in order: [folder ID, source]. */
function mappedFolders(request: FakeChatCompletionsRequest): Array<[string, string]> {
  return Array.from((request.userMessage ?? '').matchAll(FOLDER_ENTRY), (entry) => [entry[1] ?? '', entry[2] ?? ''])
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

function readCall(folderId: string, file: string): FakeChatCompletionsToolCall {
  return { id: `call-${randomUUID()}`, name: 'folder_read', arguments: { folder: folderId, path: file } }
}

interface TurnObservation {
  /** The folder map of the turn's first tool round. */
  readonly mapped: Array<[string, string]>
  /** Every tool result the provider received during the turn. */
  readonly toolResults: string[]
}

/**
 * A real API server with one agent on the fake provider, a home folder for
 * the person's folders, and the shared-folder grant list the picker writes.
 *
 * `extraScript` comes before the sequential rounds, for tests that need gates.
 * Otherwise each turn's first tool round makes the calls `nextTurn` was given.
 */
async function makeHarness(t: TestContext, extraScript: readonly FakeChatCompletionsTurn[] = []) {
  const fixture = createSchedulerFixture('shared-folders-turn-')
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folders-turn-home-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folders-turn-appdata-')))

  // The fake provider is started once, so the rounds are slots filled before
  // each turn. A slot with `match` is spent by the first request it accepts,
  // so the n-th turn's first tool round takes the n-th slot.
  const rounds: FakeChatCompletionsToolCall[][] = Array.from({ length: 4 }, () => [])
  let turnsPlanned = 0
  const provider = await startFakeChatCompletionsServer({
    script: [
      ...extraScript,
      ...rounds.map((calls) => ({ match: isFirstToolRound, toolCalls: calls })),
      { content: 'Done.', deltas: ['Done.'] },
    ],
  })

  const agentDir = path.join(fixture.repoRootPath, 'agents', AGENT_NAME)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, `${AGENT_NAME}.md`), [
    '---', `name: ${AGENT_NAME}`, 'description: Reads attached folders.', 'tier: execution',
    'provider: lm-studio', 'model: local-7b', 'thinking: low',
    `provider_options: ${JSON.stringify({ base_url: provider.url })}`, '---', '', '# Folder reader', '',
  ].join('\n'))

  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'shared-folder-grants.json'))
  await grants.initialize()
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
    await provider.close()
    fixture.cleanup()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(appDataPath, { recursive: true, force: true })
  })

  const post = (route: string, body: unknown) => fetch(`${server.url}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  return {
    provider,
    /** A folder in the person's home holding one Markdown file, granted as the picker would. */
    async makeFolder(name: string, file: string, text: string): Promise<string> {
      const folder = path.join(home, name)
      fs.mkdirSync(folder)
      fs.writeFileSync(path.join(folder, file), `${text}\n`, 'utf8')
      await grants.grant(folder)
      return folder
    },
    async createChat(title: string): Promise<string> {
      const created = await post('/sessions', { title })
      assert.equal(created.status, 201)
      return idSchema.parse(await created.json()).id
    },
    async createProject(name: string): Promise<string> {
      const created = await post('/projects', { name })
      assert.equal(created.status, 201)
      return idSchema.parse(await created.json()).id
    },
    async joinProject(projectId: string, sessionId: string): Promise<void> {
      const response = await fetch(`${server.url}/projects/${projectId}/sessions/${sessionId}`, { method: 'PUT' })
      assert.equal(response.status, 200)
    },
    async leaveProject(projectId: string, sessionId: string): Promise<void> {
      const response = await fetch(`${server.url}/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' })
      assert.equal(response.status, 204)
    },
    async attachToChat(sessionId: string, folder: string): Promise<string> {
      const attached = await post(`/sessions/${sessionId}/folders`, { path: folder })
      assert.equal(attached.status, 201, await attached.clone().text())
      return sharedFolderViewSchema.parse(await attached.json()).id
    },
    async attachToProject(projectId: string, folder: string): Promise<string> {
      const attached = await post(`/projects/${projectId}/folders`, { path: folder })
      assert.equal(attached.status, 201, await attached.clone().text())
      return sharedFolderViewSchema.parse(await attached.json()).id
    },
    async removeFromProject(projectId: string, folderId: string): Promise<void> {
      const removed = await fetch(`${server.url}/projects/${projectId}/folders/${folderId}`, { method: 'DELETE' })
      assert.equal(removed.status, 204)
    },
    /** Sends a message with only its text, as the chat does. */
    send(sessionId: string): Promise<Response> {
      return post(`/sessions/${sessionId}/messages`, {
        text: 'What do my folders say?',
        target: { kind: 'agents', agentNames: [AGENT_NAME] },
        turnId: randomUUID(),
      })
    },
    /** Runs one turn whose first tool round makes `calls`, and reports what the agent was given. */
    async nextTurn(sessionId: string, calls: readonly FakeChatCompletionsToolCall[]): Promise<TurnObservation> {
      const slot = rounds[turnsPlanned]
      assert.ok(slot, 'the harness has a round left for this turn')
      turnsPlanned += 1
      slot.push(...calls)
      const before = provider.requests.length
      const answered = await this.send(sessionId)
      assert.ok(answered.status < 400, `turn failed: ${answered.status} ${await answered.clone().text()}`)
      const requests = provider.requests.slice(before)
      const first = requests.find(isFirstToolRound)
      return {
        mapped: first ? mappedFolders(first) : [],
        toolResults: requests.flatMap(toolResultContents),
      }
    },
  }
}

const has = (results: readonly string[], text: string | RegExp): boolean =>
  results.some((content) => (typeof text === 'string' ? content.includes(text) : text.test(content)))

test('a chat in a project gets every project folder and its own on its next turn, with no folder selection sent', async (t) => {
  const harness = await makeHarness(t)
  const projectId = await harness.createProject('Acme')
  const sessionId = await harness.createChat('Acme chat')
  await harness.joinProject(projectId, sessionId)
  const research = await harness.attachToChat(sessionId, await harness.makeFolder('Research', 'notes.md', 'RESEARCH-NOTE'))
  // Added in Library after the chat joined the project.
  const contracts = await harness.attachToProject(projectId, await harness.makeFolder('Contracts', 'msa.md', 'CONTRACT-CLAUSE'))
  const brand = await harness.attachToProject(projectId, await harness.makeFolder('Brand', 'guide.md', 'BRAND-GUIDE'))

  const turn = await harness.nextTurn(sessionId, [
    readCall(contracts, 'msa.md'),
    readCall(brand, 'guide.md'),
    readCall(research, 'notes.md'),
  ])

  assert.deepEqual(turn.mapped, [[contracts, 'project'], [brand, 'project'], [research, 'session']])
  for (const text of ['CONTRACT-CLAUSE', 'BRAND-GUIDE', 'RESEARCH-NOTE']) {
    assert.ok(has(turn.toolResults, text), `the agent read ${text}`)
  }
})

test('a chat gains the project folders on its next turn after joining, and loses them after leaving, keeping its own', async (t) => {
  const harness = await makeHarness(t)
  const projectId = await harness.createProject('Acme')
  const contracts = await harness.attachToProject(projectId, await harness.makeFolder('Contracts', 'msa.md', 'CONTRACT-CLAUSE'))
  const sessionId = await harness.createChat('Moving chat')
  const research = await harness.attachToChat(sessionId, await harness.makeFolder('Research', 'notes.md', 'RESEARCH-NOTE'))
  const calls = () => [readCall(contracts, 'msa.md'), readCall(research, 'notes.md')]

  const outside = await harness.nextTurn(sessionId, calls())
  await harness.joinProject(projectId, sessionId)
  const inside = await harness.nextTurn(sessionId, calls())
  await harness.leaveProject(projectId, sessionId)
  const after = await harness.nextTurn(sessionId, calls())

  assert.deepEqual(outside.mapped, [[research, 'session']], 'before joining, only its own folder')
  assert.equal(has(outside.toolResults, 'CONTRACT-CLAUSE'), false, 'a chat outside the project never reads its folder')
  assert.ok(has(outside.toolResults, /unknown folder/i), "the project folder's ID is unknown outside the project")
  assert.deepEqual(inside.mapped, [[contracts, 'project'], [research, 'session']], 'after joining, the project folder first')
  assert.ok(has(inside.toolResults, 'CONTRACT-CLAUSE'))
  assert.ok(has(inside.toolResults, 'RESEARCH-NOTE'))
  assert.deepEqual(after.mapped, [[research, 'session']], 'after leaving, its own folder stays')
  assert.equal(has(after.toolResults, 'CONTRACT-CLAUSE'), false)
  assert.ok(has(after.toolResults, 'RESEARCH-NOTE'))
})

test('a folder removed from the project is gone from the next turn of its chats', async (t) => {
  const harness = await makeHarness(t)
  const projectId = await harness.createProject('Acme')
  const sessionId = await harness.createChat('Acme chat')
  await harness.joinProject(projectId, sessionId)
  const contracts = await harness.attachToProject(projectId, await harness.makeFolder('Contracts', 'msa.md', 'CONTRACT-CLAUSE'))
  const brand = await harness.attachToProject(projectId, await harness.makeFolder('Brand', 'guide.md', 'BRAND-GUIDE'))

  const before = await harness.nextTurn(sessionId, [readCall(brand, 'guide.md')])
  await harness.removeFromProject(projectId, brand)
  const after = await harness.nextTurn(sessionId, [readCall(brand, 'guide.md')])

  assert.deepEqual(before.mapped, [[contracts, 'project'], [brand, 'project']])
  assert.ok(has(before.toolResults, 'BRAND-GUIDE'))
  assert.deepEqual(after.mapped, [[contracts, 'project']])
  assert.equal(has(after.toolResults, 'BRAND-GUIDE'), false)
  assert.ok(has(after.toolResults, /unknown folder/i))
})

test('a folder the chat already had and its project also shares reaches the turn once, as the project folder', async (t) => {
  const harness = await makeHarness(t)
  const folder = await harness.makeFolder('Contracts', 'msa.md', 'CONTRACT-CLAUSE')
  const sessionId = await harness.createChat('Early chat')
  await harness.attachToChat(sessionId, folder)
  const projectId = await harness.createProject('Acme')
  const shared = await harness.attachToProject(projectId, folder)
  await harness.joinProject(projectId, sessionId)

  const turn = await harness.nextTurn(sessionId, [readCall(shared, 'msa.md')])

  assert.deepEqual(turn.mapped, [[shared, 'project']])
  assert.ok(has(turn.toolResults, 'CONTRACT-CLAUSE'))
})

test('overlapping turns of chats in different projects each reach only their own project folder', async (t) => {
  // A's first round asks for B's folder by its real ID, and is answered only
  // after B's turn has finished; B's waits until A's request has arrived. So
  // both turns are open at once, ordered by events, not timing.
  const ids = { alpha: '', beta: '' }
  const crossRead: Record<string, unknown> = { path: 'b.md' }
  const ownRead: Record<string, unknown> = { path: 'b.md' }
  const aArrived = deferred()
  const bDone = deferred()
  const firstRoundNaming = (request: FakeChatCompletionsRequest, folderId: string): boolean =>
    isFirstToolRound(request) && folderId !== '' && (request.userMessage ?? '').includes(folderId)
  const harness = await makeHarness(t, [
    {
      match: (request) => {
        if (!firstRoundNaming(request, ids.alpha)) return false
        aArrived.resolve()
        return true
      },
      gate: bDone.promise,
      toolCalls: [{ id: 'call-a-cross', name: 'folder_read', arguments: crossRead }],
    },
    {
      match: (request) => firstRoundNaming(request, ids.beta),
      gate: aArrived.promise,
      toolCalls: [{ id: 'call-b-own', name: 'folder_read', arguments: ownRead }],
    },
  ])
  const projectX = await harness.createProject('X')
  const projectY = await harness.createProject('Y')
  ids.alpha = await harness.attachToProject(projectX, await harness.makeFolder('Alpha', 'a.md', 'ALPHA-CONTENT'))
  ids.beta = await harness.attachToProject(projectY, await harness.makeFolder('Beta', 'b.md', 'BETA-SECRET'))
  crossRead.folder = ids.beta
  ownRead.folder = ids.beta
  const chatA = await harness.createChat('Chat in X')
  const chatB = await harness.createChat('Chat in Y')
  await harness.joinProject(projectX, chatA)
  await harness.joinProject(projectY, chatB)

  // If A never reaches its first round, releasing B keeps the test from hanging.
  const turnA = harness.send(chatA).finally(() => aArrived.resolve())
  const turnB = harness.send(chatB).finally(() => bDone.resolve())
  const [answeredA, answeredB] = await Promise.all([turnA, turnB])

  assert.ok(answeredA.status < 400, await answeredA.clone().text())
  assert.ok(answeredB.status < 400, await answeredB.clone().text())
  const followUps = harness.provider.requests.filter((request) => toolResultContents(request).length > 0)
  const resultsOf = (folderId: string): string[] => followUps
    .filter((request) => (request.userMessage ?? '').includes(folderId))
    .flatMap(toolResultContents)
  assert.ok(has(resultsOf(ids.beta), 'BETA-SECRET'), 'B reads its project folder')
  const aResults = resultsOf(ids.alpha)
  assert.ok(aResults.length > 0, "A's tool call was answered")
  assert.equal(has(aResults, 'BETA-SECRET'), false, "A never sees the other project's folder")
  assert.ok(has(aResults, /unknown folder/i), "A's request for the other project's folder ID is refused as unknown")
})
