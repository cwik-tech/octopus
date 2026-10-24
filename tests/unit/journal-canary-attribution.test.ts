import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attributeCanaryOutcome,
  parseArmOutcome,
} from '../../tests/live/journal-canary-attribution.js'

/**
 * AC15's failure-attribution rule, as a pure function.
 *
 * The canary runs two arms in separate processes, so the verdict belongs to
 * whoever holds both outcomes. Pinning the rule here keeps it testable without
 * provider spend, and keeps the live test free to report rather than reason.
 *
 * The rule is deliberately not biconditional. Two arms failing is not
 * agreement, and a control arm that fails while the journal arm completes is
 * not a pass — it is a different question.
 */
test('a journal-arm failure with a completing control arm implicates the journal', () => {
  assert.deepEqual(
    attributeCanaryOutcome({
      journal: { completed: false, failureSignature: 'workflow blocked at discuss' },
      control: { completed: true },
    }),
    {
      verdict: 'journal-implicated',
      summary:
        'The journal is implicated for that failure: the journal arm failed and the control arm completed.',
    },
  )
})

test('the same failure in both arms exonerates the journal for that failure only', () => {
  const outcome = attributeCanaryOutcome({
    journal: { completed: false, failureSignature: 'host.agent_end.no_tool_call' },
    control: { completed: false, failureSignature: 'host.agent_end.no_tool_call' },
  })
  assert.equal(outcome.verdict, 'journal-exonerated')
  assert.match(outcome.summary, /exonerated for that failure/)
  assert.match(
    outcome.summary,
    /says nothing about any other/,
    'the exoneration is scoped to the failure observed, not to the journal at large',
  )
})

test('different failures in both arms are undetermined, not agreement', () => {
  const outcome = attributeCanaryOutcome({
    journal: { completed: false, failureSignature: 'journal lock unreadable' },
    control: { completed: false, failureSignature: 'host.agent_end.no_tool_call' },
  })
  assert.equal(outcome.verdict, 'undetermined-different-failures')
  assert.match(outcome.summary, /Undetermined/)
  assert.match(
    outcome.summary,
    /two arms failing is not agreement/,
    'the rule refuses to read coincidence as corroboration',
  )
})

test('a failing control arm with a completing journal arm is undetermined', () => {
  const outcome = attributeCanaryOutcome({
    journal: { completed: true },
    control: { completed: false, failureSignature: 'provider timeout' },
  })
  assert.equal(outcome.verdict, 'undetermined-control-failed')
  assert.match(outcome.summary, /Undetermined/)
  assert.match(outcome.summary, /simpler path/)
})

/**
 * The outcome file is written by another process, so it is external input. A
 * live gate that has already spent provider credit must not die on an uncaught
 * `SyntaxError`; it must say which arm produced what.
 */
test('a malformed arm outcome fails with a diagnostic naming the arm', () => {
  assert.throws(
    () => parseArmOutcome('control', '{not json'),
    /control arm outcome is not valid JSON/,
  )
  assert.throws(
    () => parseArmOutcome('journal', '[]'),
    /journal arm outcome is not an object/,
  )
  assert.throws(
    () => parseArmOutcome('control', '{"completed":"yes"}'),
    /no boolean 'completed'/,
  )
  assert.throws(
    () => parseArmOutcome('journal', '{"completed":false,"failureSignature":7}'),
    /non-string 'failureSignature'/,
  )
  assert.throws(
    () => parseArmOutcome('control', '{"completed":false}'),
    /cannot be compared/,
    'a failure with no signature cannot take part in the same-versus-different rule',
  )
})

test('a well-formed arm outcome is narrowed rather than trusted', () => {
  assert.deepEqual(parseArmOutcome('journal', '{"completed":true}'), {
    completed: true,
  })
  assert.deepEqual(
    parseArmOutcome('control', '{"completed":false,"failureSignature":"boom","extra":1}'),
    { completed: false, failureSignature: 'boom' },
  )
})

test('both arms completing is the only passing verdict', () => {
  const outcome = attributeCanaryOutcome({
    journal: { completed: true },
    control: { completed: true },
  })
  assert.equal(outcome.verdict, 'both-completed')
  assert.match(outcome.summary, /Both arms completed/)
})
