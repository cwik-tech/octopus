import test from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { accessCanvasDocument, completeCanvasProposal } from '../../services/canvas-document-service.js'
import { CANVAS_DOCUMENT_MAX_BYTES } from '../../contracts/canvas-documents.js'

const target = { runId: 'canvas-edit-run', artifactPath: 'files/report.md' }
const original = '# Flowers\nRoses are red.\n'
const digest = (content: string | Buffer) => crypto.createHash('sha256').update(content).digest('hex')

async function fixture(options: { recordedDigest?: string; content?: string | Buffer; omitDigest?: boolean } = {}) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-doc-'))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Editable Canvas' })
  const other = await sessionStore.createSession({ title: 'Other owner' })
  const file = path.join(workspacePath, 'assignments', target.runId, target.artifactPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, options.content ?? original)
  await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-18T00:00:00.000Z', delivery: { taskId: 'task', executionAttemptId: 'attempt', artifacts: [{ runId: target.runId, path: target.artifactPath, role: 'final', ...(options.omitDigest ? {} : { digest: options.recordedDigest ?? digest(options.content ?? original) }) }] } })
  const input = { workspacePath, sessionId: session.id, sessionStore, target, signal: AbortSignal.timeout(4000) }
  return { ...input, other, file, call: (action?: Parameters<typeof accessCanvasDocument>[0]['action']) => accessCanvasDocument({ ...input, ...(action ? { action } : {}) }), async close() { await fs.rm(workspacePath, { recursive: true, force: true }) } }
}

test('verified working copies retain exact original bytes and save without rewriting the delivery', async () => {
  const f = await fixture()
  try {
    const created = await f.call({ kind: 'create', target })
    assert.equal(created.content, original)
    assert.equal(created.snapshotDigest, digest(original))
    await fs.writeFile(f.file, 'origin replaced after verification')
    const saved = await f.call({ kind: 'save', target, expectedRevision: 0, content: '# My roses' })
    assert.equal(saved.revision, 1)
    assert.equal(saved.content, '# My roses')
    assert.equal(await fs.readFile(f.file, 'utf8'), 'origin replaced after verification')
    assert.equal((await f.call({ kind: 'create', target })).content, '# My roses')
    assert.equal((await f.call()).content, '# My roses')
  } finally { await f.close() }
})

test('two saves using one base serialize and preserve the winner', async () => {
  const f = await fixture()
  try {
    await f.call({ kind: 'create', target })
    const results = await Promise.allSettled([f.call({ kind: 'save', target, expectedRevision: 0, content: 'one' }), f.call({ kind: 'save', target, expectedRevision: 0, content: 'two' })])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
    assert.equal((await f.call()).revision, 1)
  } finally { await f.close() }
})

test('changed and unverifiable origins cannot create an editable identity', async () => {
  const changed = await fixture({ recordedDigest: digest('published bytes') })
  const legacy = await fixture({ omitDigest: true })
  try {
    await assert.rejects(changed.call({ kind: 'create', target }), { code: 'origin_changed' })
    await assert.rejects(legacy.call({ kind: 'create', target }), { code: 'origin_unverifiable' })
    await assert.rejects(changed.call(), { code: 'document_not_found' })
    await assert.rejects(accessCanvasDocument({ ...changed, sessionId: changed.other.id, action: { kind: 'create', target } }), { code: 'origin_not_found' })
  } finally { await changed.close(); await legacy.close() }
})

test('invalid UTF-8 and missing origins are refused instead of rewritten', async () => {
  const invalid = await fixture({ content: Buffer.from([0xff, 0xfe]) })
  const missing = await fixture()
  try {
    await fs.unlink(missing.file)
    await assert.rejects(invalid.call({ kind: 'create', target }), { code: 'unsupported_encoding' })
    await assert.rejects(missing.call({ kind: 'create', target }), { code: 'origin_unavailable' })
  } finally { await invalid.close(); await missing.close() }
})

async function proposal(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.call()
  const start = state.content.indexOf('Roses')
  return f.call({ kind: 'propose', target, expectedRevision: state.revision, selectionStart: start, selectionEnd: start + 5, selectedText: 'Roses', instruction: 'Change the flowers to tulips' })
}

test('selected revisions remain proposals until guarded acceptance and replay applies only once', async () => {
  const f = await fixture()
  try {
    await f.call({ kind: 'create', target })
    const admitted = await proposal(f)
    assert.equal(admitted.proposal?.status, 'generating')
    assert.ok(admitted.proposal)
    const ready = await completeCanvasProposal({ ...f, proposalId: admitted.proposal.id, baseRevision: 0, generation: admitted.proposal.generation, replacementText: 'Tulips' })
    assert.equal(ready.proposal?.status, 'ready')
    assert.equal(ready.content, original)
    await assert.rejects(f.call({ kind: 'accept', target, proposalId: admitted.proposal.id, hasUnsavedDraft: true }), { code: 'unsaved_draft' })
    const applied = await f.call({ kind: 'accept', target, proposalId: admitted.proposal.id, hasUnsavedDraft: false })
    assert.equal(applied.content, '# Flowers\nTulips are red.\n')
    assert.equal(applied.revision, 1)
    assert.equal(applied.proposal?.status, 'applied')
    assert.equal((await f.call({ kind: 'accept', target, proposalId: admitted.proposal.id, hasUnsavedDraft: false })).revision, 1)
    assert.equal(await fs.readFile(f.file, 'utf8'), original)
  } finally { await f.close() }
})

test('late responses retain their original base as conflicted and cannot overwrite a concurrent save', async () => {
  const f = await fixture()
  try {
    await f.call({ kind: 'create', target })
    const admitted = await proposal(f)
    assert.ok(admitted.proposal)
    await f.call({ kind: 'save', target, expectedRevision: 0, content: 'My newer document' })
    const conflicted = await completeCanvasProposal({ ...f, proposalId: admitted.proposal.id, baseRevision: 0, generation: admitted.proposal.generation, replacementText: 'Tulips' })
    assert.equal(conflicted.proposal?.status, 'conflicted')
    assert.equal(conflicted.proposal?.baseContent, original)
    await assert.rejects(f.call({ kind: 'accept', target, proposalId: admitted.proposal.id, hasUnsavedDraft: false }), { code: 'proposal_conflict' })
    assert.equal((await f.call()).content, 'My newer document')
  } finally { await f.close() }
})

test('discard and supersession prevent late responses from reactivating proposals', async () => {
  const f = await fixture()
  try {
    await f.call({ kind: 'create', target })
    const old = await proposal(f)
    assert.ok(old.proposal)
    await f.call({ kind: 'discard', target, proposalId: old.proposal.id })
    await f.call({ kind: 'discard', target, proposalId: old.proposal.id })
    assert.equal((await completeCanvasProposal({ ...f, proposalId: old.proposal.id, baseRevision: 0, generation: old.proposal.generation, replacementText: 'Tulips' })).proposal?.status, 'discarded')
    await assert.rejects(f.call({ kind: 'accept', target, proposalId: old.proposal.id, hasUnsavedDraft: false }), { code: 'proposal_discarded' })
    const next = await proposal(f)
    assert.ok(next.proposal)
    assert.ok(next.proposal.generation > old.proposal.generation)
    const late = await completeCanvasProposal({ ...f, proposalId: old.proposal.id, baseRevision: 0, generation: old.proposal.generation, replacementText: 'Lilies' })
    assert.equal(late.proposal?.id, next.proposal.id)
    assert.equal(late.proposal?.status, 'generating')
  } finally { await f.close() }
})

test('stale admission, changed selected text and mismatched responses are refused', async () => {
  const f = await fixture()
  try {
    await f.call({ kind: 'create', target })
    await assert.rejects(f.call({ kind: 'propose', target, expectedRevision: 1, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Edit' }), { code: 'revision_conflict' })
    await assert.rejects(f.call({ kind: 'propose', target, expectedRevision: 0, selectionStart: 10, selectionEnd: 15, selectedText: 'wrong', instruction: 'Edit' }), { code: 'selection_conflict' })
    const admitted = await proposal(f)
    assert.ok(admitted.proposal)
    await assert.rejects(completeCanvasProposal({ ...f, proposalId: admitted.proposal.id, baseRevision: 1, generation: admitted.proposal.generation, replacementText: 'Tulips' }), { code: 'proposal_target_mismatch' })
  } finally { await f.close() }
})

test('missing or altered retained snapshots block proposal admission and acceptance', async () => {
  const f = await fixture()
  try {
    const created = await f.call({ kind: 'create', target })
    const admitted = await proposal(f)
    assert.ok(admitted.proposal)
    await completeCanvasProposal({ ...f, proposalId: admitted.proposal.id, baseRevision: 0, generation: admitted.proposal.generation, replacementText: 'Tulips' })
    const snapshot = path.join(f.workspacePath, 'sessions', f.sessionId, 'canvas-documents', 'snapshots', created.snapshotDigest)
    await fs.writeFile(snapshot, 'tampered')
    await assert.rejects(proposal(f), { code: 'snapshot_changed' })
    await assert.rejects(f.call({ kind: 'accept', target, proposalId: admitted.proposal.id, hasUnsavedDraft: false }), { code: 'snapshot_changed' })
    await fs.unlink(snapshot)
    await assert.rejects(f.call({ kind: 'create', target }), { code: 'snapshot_unavailable' })
  } finally { await f.close() }
})

async function publication(f: Awaited<ReturnType<typeof fixture>>, options: { deliveryAttempt?: string; publishedPath?: string; publishedDigest?: string } = {}) {
  const task = await f.sessionStore.createTaskRecord(f.sessionId, { workflowId: 'canvas-fixture', brief: 'Published report' })
  assert.ok(task?.assignmentPath)
  await fs.writeFile(path.join(f.sessionStore.taskDir(f.sessionId, task.id), 'task.json'), JSON.stringify({ ...task, status: 'done', executionAttemptId: 'exact-attempt' }))
  const markers = path.join(task.assignmentPath, '.runtime', 'task-results')
  await fs.mkdir(markers, { recursive: true })
  await fs.writeFile(path.join(markers, 'exact-attempt.published.json'), JSON.stringify({ schemaVersion: 2, taskId: task.id, executionAttemptId: 'exact-attempt', resultSha256: digest('wrapper'), publishedAt: '2026-10-18T00:00:00.000Z', artifacts: [{ stepId: 'write', role: 'primary', childRunId: target.runId, path: options.publishedPath ?? target.artifactPath, sha256: options.publishedDigest ?? digest(original), byteLength: Buffer.byteLength(original) }] }))
  await f.sessionStore.appendChatMessage(f.sessionId, { id: 'legacy-delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-18T00:00:00.000Z', delivery: { taskId: task.id, executionAttemptId: options.deliveryAttempt ?? 'exact-attempt', artifacts: [{ runId: target.runId, path: target.artifactPath, role: 'final' }] } })
}

test('legacy delivery recovery uses only the exact task attempt, publishing run and artifact path', async () => {
  const f = await fixture({ omitDigest: true })
  try {
    await publication(f)
    assert.equal((await f.call({ kind: 'create', target })).snapshotDigest, digest(original))
  } finally { await f.close() }
})

test('a ready publication from another attempt cannot repair missing provenance', async () => {
  const f = await fixture({ omitDigest: true })
  try {
    await publication(f, { deliveryAttempt: 'other-attempt' })
    await assert.rejects(f.call({ kind: 'create', target }), { code: 'origin_unverifiable' })
  } finally { await f.close() }
})

test('a same-named artifact from another path cannot repair missing provenance', async () => {
  const f = await fixture({ omitDigest: true })
  try {
    await publication(f, { publishedPath: 'other/report.md' })
    await assert.rejects(f.call({ kind: 'create', target }), { code: 'origin_unverifiable' })
  } finally { await f.close() }
})

test('disagreeing authoritative delivery and publication records fail closed', async () => {
  const f = await fixture()
  try {
    await publication(f, { publishedDigest: digest('other bytes') })
    await assert.rejects(f.call({ kind: 'create', target }), { code: 'origin_changed' })
  } finally { await f.close() }
})

test('multi-byte saves are bounded before publication', async () => {
  const f = await fixture()
  try {
    await f.call({ kind: 'create', target })
    await assert.rejects(f.call({ kind: 'save', target, expectedRevision: 0, content: '字'.repeat(CANVAS_DOCUMENT_MAX_BYTES / 2) }), { code: 'document_size_limit' })
    assert.equal((await f.call()).revision, 0)
  } finally { await f.close() }
})

test('a symlinked retained-snapshot directory cannot become editable provenance', async () => {
  const f = await fixture()
  try {
    const created = await f.call({ kind: 'create', target })
    const snapshots = path.join(f.workspacePath, 'sessions', f.sessionId, 'canvas-documents', 'snapshots')
    const outside = path.join(f.workspacePath, 'outside-snapshots')
    await fs.rename(snapshots, outside)
    await fs.symlink(outside, snapshots)
    await assert.rejects(f.call({ kind: 'create', target }), { code: 'snapshot_changed' })
    assert.equal(await fs.readFile(path.join(outside, created.snapshotDigest), 'utf8'), original)
  } finally { await f.close() }
})

test('oversized origins admit no working copy', async () => {
  const f = await fixture({ content: Buffer.alloc(CANVAS_DOCUMENT_MAX_BYTES + 1, 65) })
  try {
    await assert.rejects(f.call({ kind: 'create', target }), { code: 'origin_unavailable' })
    await assert.rejects(f.call(), { code: 'document_not_found' })
  } finally { await f.close() }
})

test('concurrent accept and save produce one revision and retain both proposal disposition and content', async () => {
  const f = await fixture()
  try {
    await f.call({ kind: 'create', target })
    const admitted = await proposal(f)
    assert.ok(admitted.proposal)
    await completeCanvasProposal({ ...f, proposalId: admitted.proposal.id, baseRevision: 0, generation: admitted.proposal.generation, replacementText: 'Tulips' })
    const results = await Promise.allSettled([f.call({ kind: 'accept', target, proposalId: admitted.proposal.id, hasUnsavedDraft: false }), f.call({ kind: 'save', target, expectedRevision: 0, content: 'Concurrent draft' })])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.equal((await f.call()).revision, 1)
    const disk = path.join(f.workspacePath, 'sessions', f.sessionId, 'canvas-documents', `${admitted.id}.json`)
    await fs.writeFile(disk, '{broken')
    await assert.rejects(f.call({ kind: 'save', target, expectedRevision: 1, content: 'Do not replace corruption' }), { code: 'invalid_saved_document' })
    assert.equal(await fs.readFile(disk, 'utf8'), '{broken')
  } finally { await f.close() }
})
