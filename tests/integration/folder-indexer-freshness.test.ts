import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { MCP_RUNTIME_CONTRACT_VERSION } from '../../contracts/mcp.js'
import { coordinateFileParserLauncher } from '../../core/file-parse-coordinator.js'
import { SourceFileParserLauncher, type FileParserLauncher } from '../../core/file-parser-launcher.js'
import type { BuiltinAgentToolAdapter } from '../../domains/mcp/builtin-agent-tool-adapter.js'
import type { McpJsonObject } from '../../domains/mcp/mcp-runtime.js'
import { folderIndexDocuments } from '../../domains/shared-folders/folder-documents.js'
import { FolderIndex } from '../../domains/shared-folders/folder-index.js'
import type { WaitLimit } from '../../domains/shared-folders/folder-parse-queue.js'
import { buildFolderMapContext } from '../../services/folder-map-context.js'
import {
  createFolderToolAdapters,
  type FolderToolPolicy,
  type TurnFolder,
} from '../../services/folder-tool-adapters.js'
import { StandInFileParser } from '../support/stand-in-file-parser.js'

/**
 * Freshness of documents in attached folders (LF-07;
 * docs/feature-local-folder-access.md, "Freshness").
 *
 * Each turn is assembled as the chat service assembles it: the folder map is
 * built first, and its walk is the turn's freshness check, then the turn's
 * folder tools are created. Folders and the cache are real temporary folders.
 * The real file parser runs where the test is about what a read returns; a
 * gated stand-in replaces the parser process where the test needs a parse to
 * still be running, which no real parse can promise.
 */

const FIXTURES = path.join(process.cwd(), 'file-parser', 'tests', 'fixtures')
const FOLDER: Omit<TurnFolder, 'root'> = { id: 'f_aaaaaaaaaa', label: 'Shared', source: 'session' }

function makeSetup(t: TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-freshness-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'Shared')
  const workspace = path.join(base, 'workspace')
  fs.mkdirSync(root)
  fs.mkdirSync(workspace)
  return { root, workspace }
}

function makeIndex(workspace: string, launcher: FileParserLauncher, waitLimit?: WaitLimit): FolderIndex {
  return new FolderIndex({
    workspacePath: workspace,
    launcher,
    isRetained: async () => true,
    // Unless a test ends it, a read waits for its parse however long this machine takes.
    waitLimit: waitLimit ?? (() => new Promise<void>(() => undefined)),
  })
}

function policyFor(index: FolderIndex): FolderToolPolicy {
  return { isRootGranted: async () => true, isProtected: async () => false, documents: folderIndexDocuments(index) }
}

/** A turn as the chat service starts one: the map (and its freshness check) first, then the turn's tools. */
async function startTurn(root: string, policy: FolderToolPolicy) {
  const folder: TurnFolder = { ...FOLDER, root }
  const map = await buildFolderMapContext({ folders: [folder], policy, maxTokens: 2_000 })
  const tools = createFolderToolAdapters({ folders: [folder], policy })
  const run = async (name: string, input: McpJsonObject) => {
    const adapter = tools.find((candidate) => candidate.name === name)
    assert.ok(adapter, `missing ${name}`)
    return adapter.execute({
      context: {
        contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
        requestId: randomUUID(),
        leaseId: randomUUID(),
        sessionId: randomUUID(),
        runId: randomUUID(),
        assignmentId: randomUUID(),
        agentPath: 'agents/folder-reader',
      },
      toolCallId: randomUUID(),
      input,
    } satisfies Parameters<BuiltinAgentToolAdapter['execute']>[0])
  }
  return {
    map,
    read: (relativePath: string) => run('folder_read', { folder: FOLDER.id, path: relativePath }),
    search: (query: string) => run('folder_search', { query }),
  }
}

/** Put a file in the folder with a modification time of its own, so each version is distinct. */
function place(root: string, relativePath: string, content: Buffer | string, day: number): void {
  const file = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  const when = new Date(Date.UTC(2026, 0, day, 12))
  fs.utimesSync(file, when, when)
}

function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, name))
}

/** Every published output folder in the workspace's folder index. */
function generationFolders(workspace: string): string[] {
  const indexRoot = path.join(workspace, 'folder-index')
  if (!fs.existsSync(indexRoot)) return []
  return fs.readdirSync(indexRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^generation-\d+$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

test('after a document changes, folder_read returns its new text and never the old', async (t) => {
  const { root, workspace } = makeSetup(t)
  const index = makeIndex(workspace, coordinateFileParserLauncher(new SourceFileParserLauncher(process.cwd())))
  const policy = policyFor(index)
  place(root, 'Clients/contract.docx', fixture('docx-table.docx'), 1)
  const first = await (await startTurn(root, policy)).read('Clients/contract.docx')

  place(root, 'Clients/contract.docx', fixture('business-plan.docx'), 2)
  const second = await (await startTurn(root, policy)).read('Clients/contract.docx')
  await index.whenIdle()

  assert.ok(first.content.includes('| Growth | 12.5% |'), first.content)
  assert.ok(second.content.includes('ExampleCo'), second.content)
  assert.equal(second.content.includes('12.5%'), false, 'the old text never comes back')
})

test('a changed document whose parse outlasts the read\'s wait answers that it is still parsing, never with the old text', async (t) => {
  const { root, workspace } = makeSetup(t)
  let waitOut = false
  const index = makeIndex(
    workspace,
    coordinateFileParserLauncher(new SourceFileParserLauncher(process.cwd())),
    // The first read waits for its parse; the second runs out of time at once.
    (_ms, signal) => waitOut
      ? Promise.resolve()
      : new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  )
  const policy = policyFor(index)
  place(root, 'contract.docx', fixture('docx-table.docx'), 1)
  const first = await (await startTurn(root, policy)).read('contract.docx')

  place(root, 'contract.docx', fixture('business-plan.docx'), 2)
  waitOut = true
  const second = await (await startTurn(root, policy)).read('contract.docx')
  await index.whenIdle()

  assert.ok(first.content.includes('| Growth | 12.5% |'), first.content)
  assert.equal(second.isError, true)
  assert.equal(second.content, 'Still parsing; try again shortly. (folder f_aaaaaaaaaa)')
})

test('search flags a changed document as re-indexing until it is parsed again, and never matches its old text', async (t) => {
  const { root, workspace } = makeSetup(t)
  const parser = new StandInFileParser('gated')
  const index = makeIndex(workspace, parser)
  const policy = policyFor(index)
  place(root, 'pricing.pdf', 'Old price list: kiwi costs 3 euro.', 1)
  const firstTurn = await startTurn(root, policy)
  await parser.whenLaunched('pricing.pdf', 1)
  await parser.finish('pricing.pdf', 1)
  await index.whenIdle()
  const before = await firstTurn.search('kiwi')

  place(root, 'pricing.pdf', 'New price list: mango costs 4 euro.', 2)
  const changedTurn = await startTurn(root, policy)
  const oldWords = await changedTurn.search('kiwi')
  const byName = await changedTurn.search('pricing')
  await parser.whenLaunched('pricing.pdf', 2)
  await parser.finish('pricing.pdf', 2)
  await index.whenIdle()
  const after = await (await startTurn(root, policy)).search('mango')

  assert.ok(before.content.includes('pricing.pdf:1: Old price list'), before.content)
  assert.equal(oldWords.content.includes('Old price list'), false, oldWords.content)
  assert.ok(oldWords.content.includes('1 document is still being indexed'), oldWords.content)
  assert.ok(byName.content.includes('pricing.pdf: (changed, re-indexing)'), byName.content)
  assert.ok(after.content.includes('pricing.pdf:1: New price list'), after.content)
})

test('a deleted document disappears on the next turn, and its cached text is removed', async (t) => {
  const { root, workspace } = makeSetup(t)
  const index = makeIndex(workspace, new StandInFileParser())
  const policy = policyFor(index)
  place(root, 'pricing.pdf', 'Price list: kiwi costs 3 euro.', 1)
  place(root, 'notes.md', 'Plain notes.', 1)
  const first = await (await startTurn(root, policy)).read('pricing.pdf')
  await index.whenIdle()
  const cachedBefore = generationFolders(workspace).length

  fs.rmSync(path.join(root, 'pricing.pdf'))
  const next = await startTurn(root, policy)
  const read = await next.read('pricing.pdf')

  assert.ok(first.content.includes('kiwi costs 3 euro'), first.content)
  assert.equal(cachedBefore, 1)
  assert.equal(next.map.includes('pricing.pdf'), false)
  assert.equal(read.content, 'This path is not available. (folder f_aaaaaaaaaa)')
  assert.deepEqual(generationFolders(workspace), [], 'the next turn removed the cached text')
})

test('a deleted document disappears on the next turn and its cached text is removed, even while a subfolder can not be read',
  { skip: process.getuid?.() === 0 ? 'running as root, which ignores folder permissions' : false },
  async (t) => {
    const { root, workspace } = makeSetup(t)
    const index = makeIndex(workspace, new StandInFileParser())
    const policy = policyFor(index)
    place(root, 'pricing.pdf', 'Price list: kiwi costs 3 euro.', 1)
    place(root, 'locked/notes.md', 'Locked notes.', 1)
    const first = await (await startTurn(root, policy)).read('pricing.pdf')
    await index.whenIdle()
    const cachedBefore = generationFolders(workspace).length

    fs.rmSync(path.join(root, 'pricing.pdf'))
    const locked = path.join(root, 'locked')
    fs.chmodSync(locked, 0o000)
    // Restored before the folder is removed, which a locked folder would refuse.
    const next = await startTurn(root, policy).finally(() => fs.chmodSync(locked, 0o755))

    assert.ok(first.content.includes('kiwi costs 3 euro'), first.content)
    assert.equal(cachedBefore, 1)
    assert.ok(next.map.includes("1 folder can't be read"), next.map)
    assert.deepEqual(generationFolders(workspace), [], 'the next turn removed the cached text')
  })
