import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resourceArchitectFallbackPayloadSchema,
  resourceArchitectJournalJobIdSchema,
} from '../../contracts/schemas/resource-architect-journal.js';

function makeFallbackPayload() {
  return {
    jobId: 'job-1',
    conversationId: 'draft-1',
    reviewerId: 'reviewer-of-agent-architect',
    requestedReviewer: { provider: 'codex', model: 'gpt-5.6-sol' },
    attemptedReviewers: [{ provider: 'codex', model: 'gpt-5.6-sol' }],
    defaultFallbackAttempted: false,
    reason: 'reviewer_unavailable',
    reviewStatus: 'not_reviewed',
    action: 'return_unreviewed_draft',
    proposalSuppressed: true,
  };
}

test('the fallback payload accepts only a content-free disclosed draft decision', () => {
  assert.equal(resourceArchitectFallbackPayloadSchema.safeParse(makeFallbackPayload()).success, true);
  assert.equal(resourceArchitectFallbackPayloadSchema.safeParse({ ...makeFallbackPayload(), draft: 'PRIVATE_DRAFT' }).success, false);
  assert.equal(resourceArchitectFallbackPayloadSchema.safeParse({ ...makeFallbackPayload(), critique: 'PRIVATE_CRITIQUE' }).success, false);
  assert.equal(resourceArchitectFallbackPayloadSchema.safeParse({ ...makeFallbackPayload(), reason: 'provider said SECRET' }).success, false);
  assert.equal(resourceArchitectFallbackPayloadSchema.safeParse({ ...makeFallbackPayload(), diagnosticCode: 'provider said SECRET' }).success, false);
  assert.equal(resourceArchitectFallbackPayloadSchema.safeParse({ ...makeFallbackPayload(), requestedReviewer: { provider: 'codex', model: 'error includes credentials' } }).success, false);
  assert.equal(resourceArchitectFallbackPayloadSchema.safeParse({ ...makeFallbackPayload(), proposalSuppressed: false }).success, false);
  assert.equal(resourceArchitectFallbackPayloadSchema.safeParse({ ...makeFallbackPayload(), reviewStatus: 'completed' }).success, false);
});

test('job correlation supports non-UUID identities without accepting control text or unbounded content', () => {
  assert.equal(resourceArchitectJournalJobIdSchema.safeParse('job:non-uuid-1').success, true);
  assert.equal(resourceArchitectJournalJobIdSchema.safeParse('').success, false);
  assert.equal(resourceArchitectJournalJobIdSchema.safeParse('job\nsecret').success, false);
  assert.equal(resourceArchitectJournalJobIdSchema.safeParse('j'.repeat(129)).success, false);
});
