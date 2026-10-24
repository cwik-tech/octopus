import assert from 'node:assert/strict'
import test from 'node:test'
import { documentReviewCoverageSchema } from '../../contracts/document-reference.js'

const complete = { document: `doc_${'a'.repeat(64)}`, name: 'source.pdf', revision: 'b'.repeat(64), state: 'complete', pageCoverage: 'known', reviewedPages: [1, 2], unresolvedPages: [], reviewedCharacters: 20, totalCharacters: 20 }
for (const [name, change] of [
  ['missing pages', { reviewedPages: [1, 3] }],
  ['duplicate pages', { reviewedPages: [1, 1] }],
  ['unresolved pages', { unresolvedPages: [2] }],
  ['unread characters', { reviewedCharacters: 10 }],
] as const) test(`complete review receipts reject ${name}`, () => {
  assert.equal(documentReviewCoverageSchema.safeParse({ ...complete, ...change }).success, false)
})
