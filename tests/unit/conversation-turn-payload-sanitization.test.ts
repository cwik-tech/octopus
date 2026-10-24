/**
 * The journal is content-free by construction, or it is not content-free.
 *
 * Every string field in a payload is a place text can be put. `userMessageId`
 * and `assistantMessageIds` accept any non-blank string up to the payload
 * budget, so a prompt, a response, a credential, or a raw error fits in them —
 * and the existing tests use names like `user-message-1`, which prove the shape
 * is accepted and nothing about what is refused.
 *
 * A guarantee stated as "we do not put content here" is worth only as much as
 * the check that stops it. These are those checks.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConversationTurnPayloadError,
  buildConversationTurnCancelledPayload,
  buildConversationTurnCompletedPayload,
  buildConversationTurnFailedPayload,
  buildConversationTurnPreparedPayload,
  buildConversationTurnStartedPayload,
} from '../../domains/conversations/conversation-turn-journal.js'

const DIGEST = 'b8'.repeat(32)

/** Things that must never be storable, whatever field they are offered in. */
const FORBIDDEN = [
  'Please summarise the acquisition terms for Northwind',
  'Here is the summary you asked for: revenue was 4.2M',
  'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9',
  'Error: connect ECONNREFUSED 10.0.0.5:443',
  '/Users/someone/secret/path/notes.md',
  // Colon-bearing, so a pattern that only checks the suffix lets them through.
  'secret:user',
  'Authorization: Bearer abc:user',
  'sk-proj-abcdefghijklmnop:assistant:0',
  'notes/private.md:user',
]

const startedWith = (userMessageId: string) =>
  buildConversationTurnStartedPayload({
    surface: 'run-receptionist',
    userMessageId,
    requestDigest: DIGEST,
    expectedResponseCount: 1,
    origin: 'client',
  })

test('a user message id must look like a message id, not like prose', () => {
  // The shape a Phase 1 turn actually writes.
  assert.ok(startedWith('7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:user'))

  for (const text of FORBIDDEN) {
    assert.throws(
      () => startedWith(text),
      ConversationTurnPayloadError,
      `a message id must not accept ${JSON.stringify(text.slice(0, 24))}…`,
    )
  }
})

test('assistant message ids are held to the same shape', () => {
  assert.ok(
    buildConversationTurnPreparedPayload({
      assistantMessageIds: ['7b1c9f2e-2f4a-4a7d-9f0b-2c3d4e5f6a7b:assistant:0'],
    }),
  )
  for (const text of FORBIDDEN) {
    assert.throws(
      () => buildConversationTurnPreparedPayload({ assistantMessageIds: [text] }),
      ConversationTurnPayloadError,
    )
    assert.throws(
      () => buildConversationTurnCompletedPayload({ assistantMessageIds: [text] }),
      ConversationTurnPayloadError,
    )
  }
})

test('a failure code is one of the codes this build defines, not any short word', () => {
  // Real lifecycle codes stay accepted.
  assert.ok(
    buildConversationTurnFailedPayload({
      failure: { code: 'plan_conflict', phase: 'plan-revision' },
    }),
  )
  assert.ok(
    buildConversationTurnFailedPayload({
      failure: { code: 'preparation_failed', phase: 'preparation' },
    }),
  )
  assert.ok(
    buildConversationTurnFailedPayload({
      failure: { code: 'provider_failed', phase: 'provider' },
    }),
  )

  // A regex-shaped string is not a code. The ADR claims an allowlist, so an
  // invented one must be refused rather than merely looking plausible.
  for (const invented of ['ok', 'something_else', 'provider_said_no']) {
    assert.throws(
      () =>
        buildConversationTurnFailedPayload({
          failure: { code: invented, phase: 'provider' },
        }),
      ConversationTurnPayloadError,
      `'${invented}' is not a code this build defines`,
    )
  }
})

test('a cancellation phase stays a fixed enum', () => {
  assert.ok(buildConversationTurnCancelledPayload({ phase: 'provider' }))
  assert.throws(
    () => buildConversationTurnCancelledPayload({ phase: FORBIDDEN[0] as string }),
    ConversationTurnPayloadError,
  )
})
