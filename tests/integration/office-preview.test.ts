import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { captureOfficeSource } from '../../services/office-preview-source.js'

async function fixture(t: test.TestContext) {
  const workspacePath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'office-source-')))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Office' })
  const target = { runId: 'office-run', artifactPath: 'files/report.docx' }
  const file = path.join(workspacePath, 'assignments', target.runId, target.artifactPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const bytes = (await generateWordBuffer('# Report', { renderMermaid: false })).buffer
  await fs.writeFile(file, bytes)
  await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-19T00:00:00.000Z', delivery: { taskId: 'task', artifacts: [{ runId: target.runId, path: target.artifactPath, role: 'final' }] } })
  return { workspacePath, sessionStore, sessionId: session.id, target, signal: new AbortController().signal, file, bytes }
}
test('captures exactly the delivered Office bytes without granting other paths in the same run', async (t) => {
  const f = await fixture(t)
  const result = await captureOfficeSource(f)
  assert.equal(result.ok, true)
  assert.deepEqual(result.bytes, f.bytes)
  assert.deepEqual(await captureOfficeSource({ ...f, target: { ...f.target, artifactPath: 'files/private.docx' } }), { ok: false, code: 'foreign_origin' })
})
test('rejects symlinked Office origins and session directories', async (t) => {
  const f = await fixture(t)
  await fs.unlink(f.file)
  const privateFile = path.join(f.workspacePath, 'private.docx')
  await fs.writeFile(privateFile, f.bytes)
  await fs.symlink(privateFile, f.file)
  assert.deepEqual(await captureOfficeSource(f), { ok: false, code: 'origin_unavailable' })
})
