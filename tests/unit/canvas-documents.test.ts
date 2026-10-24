import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCanvasDocumentAction, completeCanvasDocumentProposal } from '../../core/canvas-documents.js'
import { CANVAS_MAX_PROPOSAL_HISTORY, type CanvasDocumentAggregate } from '../../contracts/canvas-documents.js'

const target = { runId: 'run', artifactPath: 'files/report.md' }
function working(): CanvasDocumentAggregate {
  return { document: { schemaVersion: 1, id: 'a'.repeat(64), sessionId: 'session', origin: target, snapshotDigest: 'b'.repeat(64), revision: 0, content: 'Roses are red', proposal: null }, proposalHistory: [] }
}
function admitted() {
  const decision = applyCanvasDocumentAction(working(), { kind: 'propose', target, expectedRevision: 0, selectionStart: 0, selectionEnd: 5, selectedText: 'Roses', instruction: 'Use tulips' }, 'proposal')
  assert.ok(decision.ok)
  return decision.aggregate
}
function ready() {
  const decision = completeCanvasDocumentProposal(admitted(), { proposalId: 'proposal', baseRevision: 0, generation: 1, replacementText: 'Tulips' })
  assert.ok(decision.ok)
  return decision.aggregate
}

test('admission captures exact UTF-16 offsets including a bound empty insertion', () => {
  const initial = working()
  initial.document.content = '🌷 rose'
  assert.deepEqual(applyCanvasDocumentAction(initial, { kind: 'propose', target, expectedRevision: 0, selectionStart: 0, selectionEnd: 1, selectedText: '🌷', instruction: 'Edit' }, 'wrong'), { ok: false, code: 'selection_conflict' })
  const valid = applyCanvasDocumentAction(initial, { kind: 'propose', target, expectedRevision: 0, selectionStart: 2, selectionEnd: 2, selectedText: '', instruction: 'Add a word' }, 'insert')
  assert.ok(valid.ok)
  assert.equal(valid.aggregate.document.proposal?.selectionStart, 2)
  assert.equal(valid.aggregate.document.proposal?.selectedText, '')
  assert.equal(initial.document.proposal, null)
})

test('a newer explicit target supersedes the captured generation and ignores its old result', () => {
  const old = admitted()
  const newer = applyCanvasDocumentAction(old, { kind: 'propose', target, expectedRevision: 0, selectionStart: 10, selectionEnd: 13, selectedText: 'red', instruction: 'Use blue' }, 'new-proposal')
  assert.ok(newer.ok)
  assert.equal(newer.aggregate.document.proposal?.generation, 2)
  assert.equal(newer.aggregate.proposalHistory[0]?.status, 'superseded')
  const late = completeCanvasDocumentProposal(newer.aggregate, { proposalId: 'proposal', baseRevision: 0, generation: 1, replacementText: 'Tulips' })
  assert.ok(late.ok)
  assert.equal(late.aggregate, newer.aggregate)
  assert.deepEqual(applyCanvasDocumentAction(newer.aggregate, { kind: 'accept', target, proposalId: 'proposal', hasUnsavedDraft: false }, 'unused'), { ok: false, code: 'proposal_superseded' })
})

test('accept rechecks exact captured text even if the revision number was not changed', () => {
  const state = ready()
  state.document.content = 'Lilies are red'
  assert.deepEqual(applyCanvasDocumentAction(state, { kind: 'accept', target, proposalId: 'proposal', hasUnsavedDraft: false }, 'unused'), { ok: false, code: 'proposal_conflict' })
  assert.equal(state.document.revision, 0)
})

test('applied disposition takes precedence over later draft guards and cannot create another revision', () => {
  const result = applyCanvasDocumentAction(ready(), { kind: 'accept', target, proposalId: 'proposal', hasUnsavedDraft: false }, 'unused')
  assert.ok(result.ok)
  assert.equal(result.aggregate.document.content, 'Tulips are red')
  assert.equal(result.aggregate.document.revision, 1)
  const replay = applyCanvasDocumentAction(result.aggregate, { kind: 'accept', target, proposalId: 'proposal', hasUnsavedDraft: true }, 'unused')
  assert.ok(replay.ok)
  assert.equal(replay.aggregate, result.aggregate)
})

test('terminal replay history is bounded and never allows a discarded request to apply', () => {
  const state = admitted()
  state.proposalHistory = Array.from({ length: CANVAS_MAX_PROPOSAL_HISTORY }, (_, index) => ({ id: `old-${index}`, status: 'discarded', appliedRevision: null }))
  const next = applyCanvasDocumentAction(state, { kind: 'propose', target, expectedRevision: 0, selectionStart: 0, selectionEnd: 5, selectedText: 'Roses', instruction: 'Edit again' }, 'new')
  assert.ok(next.ok)
  assert.equal(next.aggregate.proposalHistory.length, CANVAS_MAX_PROPOSAL_HISTORY)
  assert.deepEqual(applyCanvasDocumentAction(next.aggregate, { kind: 'accept', target, proposalId: 'old-63', hasUnsavedDraft: false }, 'unused'), { ok: false, code: 'proposal_discarded' })
})
