import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { captureSessionDocuments } from '../../services/document-context-service.js'
import { readSnapshotDocuments } from '../../services/snapshot-document-context.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { WorkspaceProjectContextStore } from '../../domains/projects/project-context-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import { makeTextPdf } from '../helpers/text-pdf.js'
import { TeamFileStore } from '../../domains/team-files/team-file-store.js'
import { readTeamFileContext } from '../../domains/team-files/team-file-context.js'
import { randomUUID } from 'node:crypto'

test('Create upgrades legacy PDF page evidence from the locked original for an entire-file request', { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-create-document-'))
  try {
    const store = new TeamFileStore(directory)
    const owner = randomUUID()
    const parser = new SourceFileParserLauncher(process.cwd())
    await store.saveUploadedFile(owner, { filename: 'legacy.pdf', contents: makeTextPdf(2) })
    await parser.parseDirectory(store.inputsDir(owner))
    const files = await store.listFiles(owner)
    assert.ok(files[0]?.outputs?.parse)
    await fs.writeFile(path.join(store.inputsDir(owner), 'parsed', files[0].outputs.parse), JSON.stringify({ page_count: 2 }))
    const context = await readTeamFileContext(store, owner, { requirePageIndex: true, parserLauncher: parser })
    assert.equal(context.documents[0]?.documentSource?.pages?.length, 2)
    assert.match(context.documents[0]?.documentSource?.pages?.[1]?.markdown ?? '', /PAGE_FACT_2=verified/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a legacy run without a document snapshot exposes no document tools rather than failing unrelated work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-document-snapshot-'))
  try { assert.deepEqual(await readSnapshotDocuments({ runPath: root, runId: 'legacy' }), []) }
  finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('chat and worker documents keep validated PDF page evidence from their admitted revision', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'document-snapshot-'))
  const store = new FileSystemSessionStore(directory)
  try {
    const session = await store.createSession({ title: 'Page evidence' })
    await store.saveUploadedFile(session.id, { filename: 'evidence.pdf', contents: Buffer.from('pdf fixture original') })
    const parsed = path.join(store.inputsDir(session.id), 'parsed')
    await fs.mkdir(parsed, { recursive: true })
    await fs.writeFile(path.join(parsed, 'evidence.pdf.md'), 'flattened text')
    await fs.writeFile(path.join(parsed, 'evidence.pdf.parse.json'), JSON.stringify({ page_count: 2, pages: [{ page: 1, markdown: 'first page', status: 'read' }, { page: 2, markdown: 'LAST_PAGE_FACT=3187', status: 'read' }] }))
    await fs.writeFile(path.join(parsed, '_manifest.json'), JSON.stringify({ generated_at: '2026-10-09T00:00:00Z', files: [{ source: 'evidence.pdf', status: 'success', outputs: { text: 'evidence.pdf.md', parse: 'evidence.pdf.parse.json' } }] }))
    const captured = await captureSessionDocuments({ sessionId: session.id, files: await store.listFiles(session.id), sessionStore: store })
    assert.equal(captured[0]?.pages?.length, 2)
    assert.equal(captured[0]?.pages?.[1]?.markdown, 'LAST_PAGE_FACT=3187')
    const task = await store.createTaskRecord(session.id, { workflowId: 'reader', brief: 'Read all pages.' })
    assert.ok(task?.runPath)
    await fs.writeFile(path.join(parsed, 'evidence.pdf.parse.json'), JSON.stringify({ page_count: 1, pages: [{ page: 1, markdown: 'changed', status: 'read' }] }))
    const documents = await readSnapshotDocuments({ runPath: task.runPath, runId: task.runId })
    assert.equal(documents[0]?.uploadedAt, (await store.listFiles(session.id))[0]?.uploadedAt)
    assert.equal(documents[0]?.pages?.length, 2)
    assert.equal(documents[0]?.pages?.[1]?.markdown, 'LAST_PAGE_FACT=3187')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a worker can consume every page of its selected project PDF without exposing other project files', { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-document-snapshot-'))
  const store = new FileSystemSessionStore(directory)
  const context = new WorkspaceProjectContextStore({ workspacePath: directory })
  try {
    const session = await store.createSession({ title: 'Project PDF' })
    const project = await new WorkspaceProjectStore({ workspacePath: directory }).create({ name: 'References' })
    await new WorkspaceProjectMembershipStore({ workspacePath: directory }).assign(session.id, project.id)
    await context.saveFile(project.id, { filename: 'selected.pdf', contents: makeTextPdf(2) })
    await context.saveFile(project.id, { filename: 'private.md', contents: Buffer.from('PRIVATE_NOT_SELECTED') })
    const task = await store.createTaskRecord(session.id, { workflowId: 'reader', brief: 'Read the whole document.', projectContext: { projectId: project.id, includeBrief: false, fileNames: ['selected.pdf'] } })
    assert.ok(task?.runPath)
    await context.deleteFile(project.id, 'selected.pdf')
    const documents = await readSnapshotDocuments({ runPath: task.runPath, runId: task.runId, parserLauncher: new SourceFileParserLauncher(process.cwd()) })
    assert.equal(documents[0]?.pages?.length, 2)
    assert.match(documents[0]?.text ?? '', /PAGE_FACT_2=verified/)
    assert.doesNotMatch(JSON.stringify(documents), /PRIVATE_NOT_SELECTED/)
    const manifestPath = path.join(task.runPath, 'input-snapshot', 'project-context', 'manifest.json')
    await fs.chmod(manifestPath, 0o600)
    await fs.appendFile(manifestPath, '\n ')
    await assert.rejects(readSnapshotDocuments({ runPath: task.runPath, runId: task.runId }), /does not match its seal/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a chat can upgrade a legacy parsed PDF to verified page evidence from its locked original', { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-chat-document-'))
  const store = new FileSystemSessionStore(directory)
  try {
    const session = await store.createSession({ title: 'Legacy PDF' })
    await store.saveUploadedFile(session.id, { filename: 'legacy.pdf', contents: makeTextPdf(2) })
    const documents = await captureSessionDocuments({ sessionId: session.id, files: await store.lockFilesForChat(session.id), sessionStore: store, sourceRoot: store.inputsDir(session.id), parserLauncher: new SourceFileParserLauncher(process.cwd()) })
    assert.equal(documents[0]?.pages?.length, 2)
    assert.match(documents[0]?.text ?? '', /PAGE_FACT_2=verified/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
