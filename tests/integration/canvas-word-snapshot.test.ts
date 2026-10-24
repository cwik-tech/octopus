import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { accessCanvasDocument } from '../../services/canvas-document-service.js'
import { createWordSnapshot, getWordSnapshot } from '../../services/canvas-word-snapshot-service.js'
import { readOfficeRevision } from '../../services/canvas-office-document-store.js'
async function fixture(t: test.TestContext, content = '# Saved heading\n\nSource paragraph.') {
  const workspacePath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'word-snapshot-')))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Saved source' })
  const target = { runId: 'source-run', artifactPath: 'files/report.md' }
  const file = path.join(workspacePath, 'assignments', target.runId, target.artifactPath)
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content)
  await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-19T00:00:00.000Z', delivery: { taskId: target.runId, artifacts: [{ runId: target.runId, path: target.artifactPath, role: 'final', digest: createHash('sha256').update(content).digest('hex') }] } })
  const scope = { workspacePath, sessionId: session.id, sessionStore, target, signal: AbortSignal.timeout(15000) }
  await accessCanvasDocument({ ...scope, action: { kind: 'create', target } })
  return { ...scope, file }
}

test('Word snapshots use a saved Markdown revision and report later saves as out of date', async (t) => {
  const scope = await fixture(t)
  const target = scope.target
  const snapshot = await createWordSnapshot({ ...scope, expectedRevision: 0 })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.stale, false)
  assert.equal(snapshot.document.source?.revision, 0)
  const downloaded = await readOfficeRevision({ ...scope, documentId: snapshot.document.id, revision: 0 })
  assert.equal(downloaded.ok, true)
  assert.equal(downloaded.name, 'report.docx')
  assert.match(await (await JSZip.loadAsync(downloaded.bytes)).file('word/document.xml')?.async('string') ?? '', /Saved heading/)
  await accessCanvasDocument({ ...scope, action: { kind: 'save', target, expectedRevision: 0, content: '# New saved heading' } })
  const state = await getWordSnapshot(scope)
  assert.equal(state.ok, true); assert.equal(state.stale, true)
  const fresh = await createWordSnapshot({ ...scope, expectedRevision: 1 })
  assert.equal(fresh.ok, true); assert.equal(fresh.stale, false); assert.equal(fresh.document.revision, 1)
  assert.equal((await getWordSnapshot(scope)).ok, true)
})

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')

test('Word snapshots retain exact relative image bytes and their provenance after the source image disappears', async (t) => {
  const scope = await fixture(t, '# Image report\n\n![Chart](images/chart.png)')
  const image = path.join(path.dirname(scope.file), 'images', 'chart.png')
  await fs.mkdir(path.dirname(image), { recursive: true })
  await fs.writeFile(image, imageBytes)

  const result = await createWordSnapshot({ ...scope, expectedRevision: 0 })

  assert.equal(result.ok, true)
  assert.deepEqual(result.document.source?.assets, [{ path: 'images/chart.png', digest: createHash('sha256').update(imageBytes).digest('hex') }])
  await fs.unlink(image)
  const retained = await readOfficeRevision({ ...scope, documentId: result.document.id, revision: 0 })
  assert.equal(retained.ok, true)
  const zip = await JSZip.loadAsync(retained.bytes)
  const media = zip.file(/^word\/media\/.*\.png$/)
  assert.equal(media.length, 1)
  assert.deepEqual(await media[0]?.async('nodebuffer'), imageBytes)
})

for (const url of ['../private.png', '%2e%2e/private.png', '/private.png', 'file:///private.png']) {
  test(`Word snapshots refuse unsafe image source ${url}`, async (t) => {
    const scope = await fixture(t, `![Private](${url})`)

    assert.deepEqual(await createWordSnapshot({ ...scope, expectedRevision: 0 }), { ok: false, code: 'unsafe_package' })
    assert.deepEqual(await getWordSnapshot(scope), { ok: false, code: 'document_not_found' })
  })
}

test('Word snapshots refuse symlinked image sources', async (t) => {
  const scope = await fixture(t, '![Private](chart.png)')
  const privateFile = path.join(scope.workspacePath, 'private.png')
  await fs.writeFile(privateFile, imageBytes)
  await fs.symlink(privateFile, path.join(path.dirname(scope.file), 'chart.png'))

  assert.deepEqual(await createWordSnapshot({ ...scope, expectedRevision: 0 }), { ok: false, code: 'origin_unavailable' })
})
