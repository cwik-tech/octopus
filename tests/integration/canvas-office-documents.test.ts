import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createOfficeDocument, getOfficeDocument, readOfficeRevision } from '../../services/canvas-office-document-store.js'
import { createServer } from 'node:http'
import { handleCanvasOfficeRoutes } from '../../server/routes/canvas-office-documents.js'
import { officeDocumentSchema } from '../../contracts/office-documents.js'

async function fixture(t: TestContext, verified = true) {
  const workspacePath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'office-copy-')))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Office working copy' })
  const target = { runId: 'office-run', artifactPath: 'files/report.docx' }
  const file = path.join(workspacePath, 'assignments', target.runId, target.artifactPath)
  const bytes = (await generateWordBuffer('# Quarterly report\n\nKeep the original.', { renderMermaid: false })).buffer
  const digest = createHash('sha256').update(bytes).digest('hex')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
  await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-19T00:00:00.000Z', delivery: { taskId: target.runId, artifacts: [{ runId: target.runId, path: target.artifactPath, role: 'final', ...(verified ? { digest } : {}) }] } })
  return { workspacePath, sessionStore, sessionId: session.id, target, signal: new AbortController().signal, file, bytes }
}

test('a verified binary working copy and retained original survive the live origin disappearing', async (t) => {
  const f = await fixture(t)
  const created = await createOfficeDocument(f)
  assert.equal(created.ok, true)
  await fs.unlink(f.file)

  const reopened = await getOfficeDocument({ ...f, documentId: created.document.id })
  assert.equal(reopened.ok, true)
  assert.equal(reopened.document.revision, 0)
  const downloaded = await readOfficeRevision({ ...f, documentId: created.document.id, revision: 0 })
  assert.equal(downloaded.ok, true)
  assert.deepEqual(downloaded.bytes, f.bytes)
  assert.deepEqual(await createOfficeDocument(f), reopened)
})

test('an unverified binary is readable but cannot become an editable working copy', async (t) => {
  const f = await fixture(t, false)
  const created = await createOfficeDocument(f)
  assert.deepEqual(created, { ok: false, code: 'origin_unverifiable' })
  assert.deepEqual(await fs.readFile(f.file), f.bytes)
})

test('another session cannot read or download a retained Office document', async (t) => {
  const f = await fixture(t)
  const created = await createOfficeDocument(f)
  assert.equal(created.ok, true)
  const other = await f.sessionStore.createSession({ title: 'Other owner' })
  assert.deepEqual(await getOfficeDocument({ ...f, sessionId: other.id, documentId: created.document.id }), { ok: false, code: 'document_not_found' })
  assert.deepEqual(await readOfficeRevision({ ...f, sessionId: other.id, documentId: created.document.id, revision: 0 }), { ok: false, code: 'document_not_found' })
})

test('the real Office API creates a retained copy and downloads its immutable original after origin removal', async (t) => {
  const f = await fixture(t)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void handleCanvasOfficeRoutes({ req, res, url, sessionId: f.sessionId, options: { workspacePath: f.workspacePath, sessionStore: f.sessionStore, repoRootPath: process.cwd() } }).catch((error: unknown) => { res.statusCode = 500; res.end(error instanceof Error ? error.message : 'Unexpected error') })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/sessions/${f.sessionId}/canvas/office/documents`
  const created = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: f.target }), signal: AbortSignal.timeout(2000) })
  assert.equal(created.status, 200)
  const document = officeDocumentSchema.parse(await created.json())
  await fs.unlink(f.file)
  const response = await fetch(`${base}/${document.id}/original/download`, { signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes)
})

async function publishOffice(f: Awaited<ReturnType<typeof fixture>>, digest: string, deliveryDigest?: string) {
  const task = await f.sessionStore.createTaskRecord(f.sessionId, { workflowId: 'office-fixture', brief: 'Published Office document' })
  assert.ok(task?.assignmentPath)
  await fs.writeFile(path.join(f.sessionStore.taskDir(f.sessionId, task.id), 'task.json'), JSON.stringify({ ...task, status: 'done', executionAttemptId: 'office-attempt' }))
  const markers = path.join(task.assignmentPath, '.runtime', 'task-results')
  await fs.mkdir(markers, { recursive: true })
  await fs.writeFile(path.join(markers, 'office-attempt.published.json'), JSON.stringify({ schemaVersion: 2, taskId: task.id, executionAttemptId: 'office-attempt', resultSha256: 'a'.repeat(64), publishedAt: '2026-10-19T00:00:00.000Z', artifacts: [{ stepId: 'write', role: 'primary', childRunId: f.target.runId, path: f.target.artifactPath, sha256: digest, byteLength: f.bytes.length }] }))
  await f.sessionStore.appendChatMessage(f.sessionId, { id: 'published-delivery', role: 'assistant', text: 'Published', createdAt: '2026-10-19T00:00:00.000Z', delivery: { taskId: task.id, executionAttemptId: 'office-attempt', artifacts: [{ runId: f.target.runId, path: f.target.artifactPath, role: 'final', ...(deliveryDigest ? { digest: deliveryDigest } : {}) }] } })
}

test('Office admission refuses disagreement between delivery and exact task publication digests', async (t) => {
  const f = await fixture(t)
  await publishOffice(f, 'f'.repeat(64), createHash('sha256').update(f.bytes).digest('hex'))

  assert.deepEqual(await createOfficeDocument(f), { ok: false, code: 'origin_unverifiable' })
})

test('Office admission can recover a digest from the exact persisted task publication', async (t) => {
  const f = await fixture(t, false)
  await publishOffice(f, createHash('sha256').update(f.bytes).digest('hex'))

  const result = await createOfficeDocument(f)

  assert.equal(result.ok, true)
  assert.equal(result.document.originalDigest, createHash('sha256').update(f.bytes).digest('hex'))
})

test('an abandoned generating proposal becomes interrupted without regenerating or changing saved bytes', async (t) => {
  const { admitOfficeProposal } = await import('../../core/canvas-office-documents.js')
  const { withOfficeDocument } = await import('../../services/canvas-office-document-store.js')
  const { getOfficeDocumentState, proposeOfficeEdit } = await import('../../services/canvas-office-document-service.js')
  const f = await fixture(t)
  const created = await createOfficeDocument(f)
  assert.equal(created.ok, true)
  const scope = { ...f, documentId: created.document.id, repoRoot: process.cwd() }
  const request = { baseRevision: 0, instruction: 'Interrupted instruction', requestId: 'lost-request', requestSequence: 1 }
  const { hashCanonicalJson } = await import('../../core/canonical-json-hash.js')
  const admitted = admitOfficeProposal(created.document, { ...request, fingerprint: hashCanonicalJson({ documentId: created.document.id, ...request }).value }, 'lost-proposal')
  assert.equal(admitted.ok, true)
  // Persist an admission with no in-memory owner, as a previous app process
  // leaves behind. No provider or internal module is replaced.
  await withOfficeDocument(scope, async () => ({ next: admitted.document, result: undefined }))

  const recovered = await getOfficeDocumentState(scope)

  assert.equal(recovered.ok, true)
  assert.equal(recovered.document.proposal?.status, 'interrupted')
  assert.equal(recovered.document.revision, 0)
  assert.deepEqual(await proposeOfficeEdit({ ...scope, request }), recovered)
  const retained = await readOfficeRevision({ ...scope, revision: 0 })
  assert.equal(retained.ok, true)
  assert.deepEqual(retained.bytes, f.bytes)
})
