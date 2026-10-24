import assert from 'node:assert/strict'
import test from 'node:test'
import { nextReviewTurn } from '../../core/review-question-continuation.js'

test('an unanswered reviewer retains the final iteration instead of spending another one', () => {
  assert.deepEqual(nextReviewTurn({ iteration: 1, maxIterations: 1, lastVerdict: null, pendingPhase: 'reviewer' }), { kind: 'reviewer', iteration: 1 })
})

test('an unanswered producer retains its current iteration', () => {
  assert.deepEqual(nextReviewTurn({ iteration: 2, maxIterations: 3, lastVerdict: 'revise', pendingPhase: 'producer' }), { kind: 'producer', iteration: 2 })
})

test('a completed revision spends exactly one more iteration within the limit', () => {
  assert.deepEqual(nextReviewTurn({ iteration: 1, maxIterations: 2, lastVerdict: 'revise' }), { kind: 'producer', iteration: 2 })
  assert.deepEqual(nextReviewTurn({ iteration: 2, maxIterations: 2, lastVerdict: 'revise' }), { kind: 'limit' })
})

test('approval closes the review regardless of its iteration', () => {
  assert.deepEqual(nextReviewTurn({ iteration: 1, maxIterations: 3, lastVerdict: 'approve' }), { kind: 'complete' })
})
