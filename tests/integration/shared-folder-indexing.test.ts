import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import { WorkspaceProjectService } from '../../domains/projects/workspace-project-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { walkFolder } from '../../domains/shared-folders/folder-access.js'
import type { FolderDocument, FolderIndexLimits } from '../../domains/shared-folders/folder-index.js'
import { SharedFolderAccessPolicy } from '../../domains/shared-folders/shared-folder-access-policy.js'
import { SharedFolderStore } from '../../domains/shared-folders/shared-folder-store.js'
import { SharedFolderService } from '../../services/shared-folder-service.js'
import { StandInFileParser } from '../support/stand-in-file-parser.js'

/**
 * Indexing attached folders, their status, and what keeps their parsed text
 * (docs/feature-local-folder-access.md, "Scheduling and publishing", "Status"
 * and "Retention").
 *
 * The service runs over the real stores, grant list, access policy and folder
 * index in a temporary workspace. Only the parser process is replaced, by a
 * stand-in that "parses" a document into its own bytes; tests synchronize on
 * its launches and on the service going idle, never on time.
 */

async function makeService(
  t: TestContext,
  options: { readonly parser?: StandInFileParser; readonly limits?: Partial<FolderIndexLimits> } = {},
) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-indexing-')))
  const workspace = path.join(base, 'workspace')
  const appData = path.join(base, 'app-data')
  const home = path.join(base, 'home')
  for (const directory of [workspace, appData, home]) fs.mkdirSync(directory)
  const sessionStore = new FileSystemSessionStore(workspace)
  const projects = new WorkspaceProjectService({
    projectStore: new WorkspaceProjectStore({ workspacePath: workspace }),
    membershipStore: new WorkspaceProjectMembershipStore({ workspacePath: workspace }),
    sessionStore,
  })
  const grants = new BatchFolderGrantStore(path.join(appData, 'shared-folder-grants.json'))
  await grants.initialize()
  const parser = options.parser ?? new StandInFileParser()
  const started = new Set<SharedFolderService>()
  const startService = async (launcher: StandInFileParser): Promise<SharedFolderService> => {
    const service = new SharedFolderService({
      store: new SharedFolderStore(workspace),
      policy: new SharedFolderAccessPolicy({ protectedPaths: [workspace, appData], listGrants: () => grants.list() }),
      projects,
      index: { workspacePath: workspace, launcher, ...(options.limits ? { limits: options.limits } : {}) },
    })
    started.add(service)
    await service.start()
    return service
  }
  const service = await startService(parser)
  t.after(async () => {
    for (const running of started) await running.close()
    fs.rmSync(base, { recursive: true, force: true })
  })
  /** The app closing and starting again over the same workspace, with a parser of its own. */
  const restart = async (launcher: StandInFileParser): Promise<SharedFolderService> => {
    await service.close()
    return startService(launcher)
  }
  /** A folder the person picked in the native dialog, holding these files. */
  const makeFolder = async (name: string, files: Record<string, string>): Promise<string> => {
    const folder = path.join(home, name)
    for (const [relativePath, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, relativePath)), { recursive: true })
      fs.writeFileSync(path.join(folder, relativePath), content)
    }
    await grants.grant(folder)
    return folder
  }
  const newSession = async (): Promise<string> => (await sessionStore.createSession({ title: 'Folders' })).id
  const indexRoot = path.join(workspace, 'folder-index')
  /** One folder per entry in the workspace's folder index. */
  const cachedFolders = (): string[] => (fs.existsSync(indexRoot) ? fs.readdirSync(indexRoot) : [])
  /** The names of every parsed text file in the folder index. */
  const parsedTexts = (): string[] => (fs.existsSync(indexRoot)
    ? fs.readdirSync(indexRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.pdf.md'))
      .map((entry) => entry.name)
    : [])
  return { service, parser, grants, projects, home, makeFolder, newSession, cachedFolders, parsedTexts, restart }
}

/** A document as folder access measures it just before a read. */
function measure(folder: string, relativePath: string): FolderDocument {
  const stat = fs.statSync(path.join(folder, ...relativePath.split('/')))
  return { path: relativePath, size: stat.size, mtimeMs: stat.mtime.getTime() }
}

async function attachToSession(service: SharedFolderService, sessionId: string, folder: string): Promise<string> {
  const attached = await service.attachToSession(sessionId, folder)
  assert.ok(attached.kind === 'attached', attached.kind)
  return attached.folder.id
}

test('attaching a folder to a project starts parsing its documents in the background, local-only, before any turn', async (t) => {
  const api = await makeService(t)
  const folder = await api.makeFolder('Reports', { 'q3.pdf': 'Q3 revenue.', 'notes.md': 'Plain text.', 'deck/q4.pptx': 'Q4 plan.' })
  const project = await api.projects.createProject({ name: 'Board' })

  const attached = await api.service.attachToProject(project.id, folder)
  await api.service.whenIdle()

  assert.equal(attached.kind, 'attached')
  assert.deepEqual(api.parser.requests.map((request) => path.basename(request.filePath)).sort(), ['q3.pdf', 'q4.pptx'])
  assert.deepEqual(api.parser.requests.map((request) => request.localOnly), [true, true])
})

test('a folder is listed as indexing with how many documents are left, then as ready with its file count', async (t) => {
  const api = await makeService(t, { parser: new StandInFileParser('gated') })
  const folder = await api.makeFolder('Reports', { 'a.pdf': 'Alpha.', 'b.docx': 'Beta.', 'notes.md': 'Plain text.' })
  const sessionId = await api.newSession()
  await attachToSession(api.service, sessionId, folder)
  await Promise.all([api.parser.whenLaunched('a.pdf'), api.parser.whenLaunched('b.docx')])

  const indexing = (await api.service.listForSession(sessionId)).map((view) => view.status)
  await Promise.all([api.parser.finish('a.pdf'), api.parser.finish('b.docx')])
  await api.service.whenIdle()
  const ready = (await api.service.listForSession(sessionId)).map((view) => view.status)

  assert.deepEqual(indexing, [{ state: 'indexing', files: 3, pendingDocuments: 2 }])
  assert.deepEqual(ready, [{ state: 'ready', files: 3 }])
})

test('a folder whose parsing reached a limit is listed as partial, naming the limit', async (t) => {
  const api = await makeService(t, { limits: { maxInputBytesPerFolder: 30 } })
  const folder = await api.makeFolder('Reports', { 'a.pdf': 'Twenty bytes of text', 'b.pdf': 'Twenty more bytes!!!' })
  const project = await api.projects.createProject({ name: 'Board' })
  await api.service.attachToProject(project.id, folder)
  await api.service.whenIdle()

  const statuses = (await api.service.listForProject(project.id)).map((view) => view.status)

  assert.deepEqual(statuses, [{ state: 'partial', files: 2, limit: 'Documents past 30 bytes were not parsed.' }])
})

test('a listed folder says when it was moved away, when its access was removed, and when it cannot be read',
  { skip: process.getuid?.() === 0 ? 'running as root, which ignores folder permissions' : false },
  async (t) => {
    const api = await makeService(t)
    const moved = await api.makeFolder('Moved', { 'a.md': 'x' })
    const revoked = await api.makeFolder('Revoked', { 'b.md': 'x' })
    const locked = await api.makeFolder('Locked', { 'c.md': 'x' })
    const sessionId = await api.newSession()
    for (const folder of [moved, revoked, locked]) await attachToSession(api.service, sessionId, folder)
    await api.service.whenIdle()
    fs.renameSync(moved, `${moved}-elsewhere`)
    await api.grants.revoke(revoked)
    fs.chmodSync(locked, 0o000)

    // Restored before the folder is removed, which a locked folder would refuse.
    const statuses = await api.service.listForSession(sessionId).finally(() => fs.chmodSync(locked, 0o755))

    assert.deepEqual(statuses.map((view) => [view.label, view.status]), [
      ['Moved', { state: 'unavailable', reason: 'not_found' }],
      ['Revoked', { state: 'unavailable', reason: 'access_removed' }],
      ['Locked', { state: 'unavailable', reason: 'unreadable' }],
    ])
  })

test("removing a folder's last attachment stops its parses and deletes its parsed text; another attachment keeps them", async (t) => {
  const parser = new StandInFileParser('gated')
  const api = await makeService(t, { parser })
  const folder = await api.makeFolder('Reports', { 'a.pdf': 'Alpha report.', 'b.pdf': 'Beta report.' })
  const first = await api.newSession()
  const second = await api.newSession()
  const firstId = await attachToSession(api.service, first, folder)
  const secondId = await attachToSession(api.service, second, folder)
  await Promise.all([parser.whenLaunched('a.pdf'), parser.whenLaunched('b.pdf')])
  // A read of a.pdf waits for its parse, so once it answers, a.pdf's text is in the cache.
  const stat = fs.statSync(path.join(folder, 'a.pdf'))
  const documents = api.service.toolPolicy.documents
  assert.ok(documents)
  const readA = documents.readDocument(folder, { path: 'a.pdf', size: stat.size, mtimeMs: stat.mtime.getTime() })
  await parser.finish('a.pdf')
  assert.equal((await readA).ok, true)

  await api.service.detachFromSession(first, firstId)
  const keptWhileAttached = { cached: api.cachedFolders().length, aborted: parser.isAborted('b.pdf') }
  await api.service.detachFromSession(second, secondId)

  assert.deepEqual(keptWhileAttached, { cached: 1, aborted: false })
  assert.equal(parser.isAborted('b.pdf'), true, "the folder's running parse was stopped")
  assert.deepEqual(api.cachedFolders(), [], "the folder's parsed text was deleted")
})

test('after a restart, documents still waiting to be parsed are parsed again without a turn', async (t) => {
  const api = await makeService(t, { parser: new StandInFileParser('gated') })
  const folder = await api.makeFolder('Reports', { 'q3.pdf': 'Q3 revenue.' })
  const sessionId = await api.newSession()
  await attachToSession(api.service, sessionId, folder)
  await api.parser.whenLaunched('q3.pdf')

  const parser = new StandInFileParser()
  const restarted = await api.restart(parser)
  await restarted.whenIdle()

  assert.deepEqual(parser.requests.map((request) => path.basename(request.filePath)), ['q3.pdf'])
  assert.deepEqual((await restarted.listForSession(sessionId)).map((view) => view.status), [{ state: 'ready', files: 1 }])
})

test('a turn that began before its folder was detached parses nothing in it and writes no cache for it', async (t) => {
  const api = await makeService(t)
  const folder = await api.makeFolder('Reports', { 'a.pdf': 'Alpha secret text.' })
  const sessionId = await api.newSession()
  const folderId = await attachToSession(api.service, sessionId, folder)
  await api.service.whenIdle()
  // The turn resolved its folders, and got its tools, while the folder was attached.
  const [turnFolder] = await api.service.resolveTurnFolders(sessionId)
  const documents = api.service.toolPolicy.documents
  assert.ok(turnFolder && documents)
  const launchesBefore = api.parser.requests.length
  await api.service.detachFromSession(sessionId, folderId)
  const cachedAfterDetach = api.cachedFolders()

  fs.writeFileSync(path.join(folder, 'a.pdf'), 'Alpha secret text, edited.')
  const read = await documents.readDocument(turnFolder.root, measure(folder, 'a.pdf'))
  await api.service.whenIdle()
  const afterRead = { launches: api.parser.requests.length - launchesBefore, cached: api.cachedFolders() }
  const walk = await walkFolder({
    root: turnFolder.root,
    isProtected: (absolutePath) => api.service.toolPolicy.isProtected(absolutePath),
    documents,
  })
  assert.ok(walk.ok)
  await documents.refresh(turnFolder.root, walk)
  await api.service.whenIdle()
  const afterRefresh = { launches: api.parser.requests.length - launchesBefore, cached: api.cachedFolders() }

  assert.deepEqual(cachedAfterDetach, [])
  assert.equal(read.ok, false)
  assert.deepEqual({ afterRead, afterRefresh }, {
    afterRead: { launches: 0, cached: [] },
    afterRefresh: { launches: 0, cached: [] },
  })
})

test("revoking a folder's grant stops the parses reads started and deletes their text, even when no indexing walk reached the folder",
  { skip: process.getuid?.() === 0 ? 'running as root, which ignores folder permissions' : false },
  async (t) => {
    const parser = new StandInFileParser('gated')
    const api = await makeService(t, { parser })
    const folder = await api.makeFolder('Reports', { 'a.pdf': 'Alpha secret text.', 'b.pdf': 'Beta report.' })
    const sessionId = await api.newSession()
    // The folder can't be read while it is attached, so its indexing walk finds nothing.
    fs.chmodSync(folder, 0o000)
    try {
      await attachToSession(api.service, sessionId, folder)
      await api.service.whenIdle()
    } finally {
      fs.chmodSync(folder, 0o755)
    }
    const documents = api.service.toolPolicy.documents
    assert.ok(documents)
    // Reads parse on demand: a.pdf's text is published, b.pdf's parse is still running.
    const readA = documents.readDocument(folder, measure(folder, 'a.pdf'))
    await parser.whenLaunched('a.pdf')
    await parser.finish('a.pdf')
    assert.equal((await readA).ok, true)
    const readB = documents.readDocument(folder, measure(folder, 'b.pdf'))
    await parser.whenLaunched('b.pdf')
    const textBefore = api.parsedTexts()

    await api.grants.revoke(folder)
    api.service.handleGrantsChanged()
    // A list waits for the retention work the revocation started.
    await api.service.listForSession(sessionId)

    assert.deepEqual(textBefore, ['a.pdf.md'])
    assert.deepEqual({ aborted: parser.isAborted('b.pdf'), cached: api.cachedFolders() }, { aborted: true, cached: [] })
    await readB
  })

test('a grant change while the app closes keeps the parsed text of folders still attached', async (t) => {
  const api = await makeService(t)
  const folder = await api.makeFolder('Reports', { 'a.pdf': 'Alpha report.' })
  const sessionId = await api.newSession()
  await attachToSession(api.service, sessionId, folder)
  await api.service.whenIdle()
  const textBefore = api.parsedTexts()

  const closed = api.service.close()
  api.service.handleGrantsChanged()
  await closed
  await api.service.whenIdle()

  assert.deepEqual(textBefore, ['a.pdf.md'])
  assert.deepEqual(api.parsedTexts(), ['a.pdf.md'])
})
