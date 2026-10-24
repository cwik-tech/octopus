import assert from 'node:assert/strict'
import test from 'node:test'
import { officeDocumentSchema } from '../../contracts/office-documents.js'
import { admitOfficeProposal, completeOfficeProposal, disposeOfficeProposal, failOfficeProposal } from '../../core/canvas-office-documents.js'

const original = 'a'.repeat(64)
const candidate = 'c'.repeat(64)
const request = { baseRevision: 0, instruction: 'Change the heading', requestSequence: 1, requestId: 'request-one', fingerprint: 'b'.repeat(64) }
function document() { return officeDocumentSchema.parse({ schemaVersion: 1, id: 'd'.repeat(64), sessionId: 'ad605beb-dadc-403a-bca4-b05df6e00001', origin: { runId: 'run', artifactPath: 'files/report.docx' }, originalDigest: original, format: 'docx', revision: 0, revisions: [{ revision: 0, digest: original }] }) }

test('a ready Office candidate changes the saved binary only after acceptance and terminal replay never applies twice', () => {
  const admitted = admitOfficeProposal(document(), request, 'proposal-one')
  assert.equal(admitted.ok, true)
  const ready = completeOfficeProposal(admitted.document, { proposalId: 'proposal-one', generation: 1, baseRevision: 0, baseDigest: original, candidateDigest: candidate, summary: 'Heading changed' })
  assert.equal(ready.ok, true)
  assert.equal(ready.document.revision, 0)
  assert.equal(ready.document.revisions[0]?.digest, original)
  const accepted = disposeOfficeProposal(ready.document, { proposalId: 'proposal-one', expectedRevision: 0, kind: 'accept' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.document.revision, 1)
  assert.equal(accepted.document.revisions[1]?.digest, candidate)
  assert.deepEqual(disposeOfficeProposal(accepted.document, { proposalId: 'proposal-one', expectedRevision: 0, kind: 'accept' }), accepted)
  assert.deepEqual(admitOfficeProposal(accepted.document, request, 'different-id'), accepted)
})

test('discarding during generation prevents a late result from replacing a newer proposal on the same revision', () => {
  const admitted = admitOfficeProposal(document(), request, 'proposal-one')
  assert.equal(admitted.ok, true)
  const discarded = disposeOfficeProposal(admitted.document, { proposalId: 'proposal-one', expectedRevision: 0, kind: 'discard' })
  assert.equal(discarded.ok, true)
  const newer = admitOfficeProposal(discarded.document, { ...request, requestSequence: 2, requestId: 'request-two' }, 'proposal-two')
  assert.equal(newer.ok, true)
  assert.deepEqual(completeOfficeProposal(newer.document, { proposalId: 'proposal-one', generation: 1, baseRevision: 0, baseDigest: original, candidateDigest: candidate, summary: 'Late result' }), { ok: false, code: 'revision_conflict' })
  assert.equal(newer.document.proposal?.id, 'proposal-two')
})

test('reused request identities conflict and expired sequences never regenerate', () => {
  const admitted = admitOfficeProposal(document(), request, 'proposal-one')
  assert.equal(admitted.ok, true)
  assert.deepEqual(admitOfficeProposal(admitted.document, { ...request, fingerprint: 'e'.repeat(64) }, 'proposal-two'), { ok: false, code: 'request_conflict' })
  const stale = { ...document(), highestRequestSequence: 2 }
  assert.deepEqual(admitOfficeProposal(stale, request, 'proposal-two'), { ok: false, code: 'request_expired' })
})

test('generation failure preserves the saved revision and a late failure cannot affect a new proposal', () => {
  const admitted = admitOfficeProposal(document(), request, 'proposal-one')
  assert.equal(admitted.ok, true)
  const failed = failOfficeProposal(admitted.document, 'proposal-one', 1, 'failed', 'Generation failed')
  assert.equal(failed.ok, true)
  assert.equal(failed.document.revision, 0)
  assert.equal(failed.document.proposal?.status, 'failed')
  const newer = admitOfficeProposal(failed.document, { ...request, requestId: 'request-two', requestSequence: 2 }, 'proposal-two')
  assert.equal(newer.ok, true)
  assert.deepEqual(failOfficeProposal(newer.document, 'proposal-one', 1, 'failed', 'Late failure'), { ok: false, code: 'revision_conflict' })
})

test('accepting a binary edit records a fork without changing its Markdown source provenance', () => {
  const source = { target: { runId: 'run', artifactPath: 'files/source.md' }, revision: 3, digest: original, assets: [], profile: 'business-report' as const, mermaid: 'keep-code' as const, notices: [], forked: false }
  const admitted = admitOfficeProposal({ ...document(), source }, request, 'proposal-one')
  assert.equal(admitted.ok, true)
  const ready = completeOfficeProposal(admitted.document, { proposalId: 'proposal-one', generation: 1, baseRevision: 0, baseDigest: original, candidateDigest: candidate, summary: 'Changed Word' })
  assert.equal(ready.ok, true)
  const accepted = disposeOfficeProposal(ready.document, { proposalId: 'proposal-one', expectedRevision: 0, kind: 'accept' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.document.source?.forked, true)
  assert.equal(accepted.document.source?.revision, 3)
  assert.equal(accepted.document.revisions.at(-1)?.source?.forked, true)
})
