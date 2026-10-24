/**
 * What may be recorded as a title attempt, and what may not.
 *
 * This schema guards a durable public shape, and the two things it must not do
 * are accept a value the reader cannot rebuild, and quietly change one. A
 * silently stripped field is the second: it survives in the file until the next
 * ordinary metadata write persists the stripped copy, and then the evidence is
 * gone with nothing to show it was ever there.
 *
 * The provenance rules are narrower here than for model selections generally.
 * Titling owns no Agent, so it is either the application default or a model a
 * person picked for that one turn — never an Agent's own choice, and never an
 * approved retry, because nothing offers a retry for a title.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { sessionTitleAttemptSchema } from '../../contracts/schemas/session-title-attempts.js'

const APP_DEFAULT_SELECTION = {
  provider: 'openai',
  model: 'app-default-model',
  source: 'app-default',
  reason: 'agent-default',
  caller: 'title',
} as const

const AD_HOC_SELECTION = {
  provider: 'openai',
  model: 'ad-hoc-user-model',
  source: 'user',
  reason: 'explicit-user-choice',
  caller: 'title',
} as const

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'selected-agent-chat',
    owner: 'turn-1',
    attemptId: 'attempt-1',
    selection: { ...APP_DEFAULT_SELECTION },
    at: '2026-09-09T12:00:00.000Z',
    ...overrides,
  }
}

test('the two provenances titling can actually have are accepted', () => {
  for (const selection of [APP_DEFAULT_SELECTION, AD_HOC_SELECTION]) {
    const parsed = sessionTitleAttemptSchema.safeParse(attempt({ selection: { ...selection } }))
    // Narrowed rather than guarded: a conditional assertion passes silently
    // when the parse failed, which is the case it exists to catch.
    assert.ok(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues))
    assert.deepEqual(parsed.data.selection, selection)
  }
})

test('a timestamp that is not a real instant is refused', () => {
  for (const at of ['1', '2026-02-30T12:00:00.000Z', 'the other day', '2026-09-09']) {
    const parsed = sessionTitleAttemptSchema.safeParse(attempt({ at }))
    assert.equal(parsed.success, false, `accepted ${JSON.stringify(at)}`)
  }
})

test('a provenance titling cannot have is refused', () => {
  // An Agent's own choice: titling has no Agent, so this describes some other
  // call and does not belong in this history.
  const agentOwned = sessionTitleAttemptSchema.safeParse(
    attempt({
      selection: {
        ...APP_DEFAULT_SELECTION,
        source: 'agent',
        reason: 'explicit-agent-choice',
      },
    }),
  )
  assert.equal(agentOwned.success, false)

  // An approved retry: nothing offers a retry for a title, so a record that
  // claims one is describing something that cannot have happened.
  const approvedRetry = sessionTitleAttemptSchema.safeParse(
    attempt({
      selection: {
        ...APP_DEFAULT_SELECTION,
        source: 'user',
        reason: 'user-approved-retry',
        requestedProvider: 'openai',
        requestedModel: 'refused-model',
      },
    }),
  )
  assert.equal(approvedRetry.success, false)

  // A source and a reason that do not go together.
  const mismatched = sessionTitleAttemptSchema.safeParse(
    attempt({
      selection: { ...APP_DEFAULT_SELECTION, source: 'user' },
    }),
  )
  assert.equal(mismatched.success, false)
})

test('a field this schema does not know is refused rather than dropped', () => {
  // Stripping would look harmless and is not: the value stays in the file until
  // the next ordinary metadata write persists the stripped copy, and then it is
  // gone with nothing to say it was ever there.
  const extraOnAttempt = sessionTitleAttemptSchema.safeParse(
    attempt({ unknownHistoryField: 'kept by some later version' }),
  )
  assert.equal(extraOnAttempt.success, false)

  const extraOnSelection = sessionTitleAttemptSchema.safeParse(
    attempt({
      selection: { ...APP_DEFAULT_SELECTION, unknownSelectionField: 'something' },
    }),
  )
  assert.equal(extraOnSelection.success, false)
})

test('an unknown field whose name is empty is refused too', () => {
  // A key can be the empty string, and an empty string is falsy. Searching for
  // the first unknown key and then testing it for truthiness lets that one
  // through — and it is then stripped, which is the silent loss this rule
  // exists to stop.
  const emptyKeyOnSelection = sessionTitleAttemptSchema.safeParse(
    attempt({ selection: { ...APP_DEFAULT_SELECTION, '': 'something' } }),
  )
  assert.equal(emptyKeyOnSelection.success, false)

  const emptyKeyOnAttempt = sessionTitleAttemptSchema.safeParse(attempt({ '': 'something' }))
  assert.equal(emptyKeyOnAttempt.success, false)
})
