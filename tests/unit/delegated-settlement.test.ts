/**
 * When a delegated run may report, and whether it may clean up.
 *
 * Three facts decide it, and nothing else: whether the child has closed,
 * whether termination has been asked for, and what the group's forced
 * termination came back with. Keeping that decision away from processes and
 * timers is what lets the hard case be tested at all — a group that survives
 * SIGKILL cannot be conjured on demand, so an implementation that only ever ran
 * against real processes could never be shown to handle one.
 *
 * The rule the run turns on: a group that could not be confirmed dead may still
 * be using the private Pi agent directory, which holds a copy of the user's
 * credentials. Removing it then takes it out from under a live process. So an
 * unconfirmed termination reports failure and deliberately keeps the directory,
 * and says so.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DelegatedSettlement } from '../../domains/agent-execution/delegated-settlement.js'

const CLEAN_CLOSE = { code: 0, signal: null } as const

test('a run with no news yet decides nothing', () => {
  const settlement = new DelegatedSettlement()
  assert.deepEqual(settlement.decide(), { kind: 'wait' })
})

test('an unconfirmed termination is decided without waiting for a child close', () => {
  // The backstop. A survivor can hold the child's stdout open, so `close` may
  // never arrive; waiting for it would leave the caller hanging on a run that
  // has already failed.
  const settlement = new DelegatedSettlement()
  settlement.recordTermination({
    terminated: false,
    reason: 'Delegated process group 4242 was still alive 500ms after SIGTERM and SIGKILL.',
  })

  const decision = settlement.decide()
  assert.equal(decision.kind, 'abandon', 'an unkillable group must not wait for a close')
  assert.equal(
    decision.kind === 'abandon' && decision.releaseResources,
    false,
    'and must not release resources a live process may still be using',
  )
  assert.match(
    decision.kind === 'abandon' ? decision.message : '',
    /still alive .* after SIGTERM and SIGKILL/,
    'the message must carry what was observed',
  )
  assert.match(
    decision.kind === 'abandon' ? decision.message : '',
    /intentionally|deliberately/i,
    'and must say the directory was kept on purpose, not lost',
  )
})

test('an unconfirmed termination still refuses to release once the child does close', () => {
  const settlement = new DelegatedSettlement()
  settlement.recordTermination({ terminated: false, reason: 'still alive' })
  settlement.recordChildClose(CLEAN_CLOSE)

  const decision = settlement.decide()
  assert.equal(decision.kind, 'abandon', 'a closed child does not prove the group is gone')
  assert.equal(
    decision.kind === 'abandon' && decision.releaseResources,
    false,
    'the group may still hold the agent directory',
  )
})

test('a close during an unfinished termination is not yet an answer', () => {
  // The direct child dying is the ordinary shape of cancellation: it obeys
  // SIGTERM while a grandchild in its group ignores it. Reporting on that close
  // would announce a finished cancellation with the group still being killed,
  // and would release the agent directory out from under it.
  const settlement = new DelegatedSettlement()
  settlement.recordTerminationRequested()
  settlement.recordChildClose(CLEAN_CLOSE)

  assert.deepEqual(
    settlement.decide(),
    { kind: 'wait' },
    'a requested termination has to come back before a close means anything',
  )

  settlement.recordTermination({ terminated: true })
  assert.equal(settlement.decide().kind, 'report', 'and once it does, the close reports')
})

test('a confirmed termination waits for the child to close before reporting', () => {
  const settlement = new DelegatedSettlement()
  settlement.recordTermination({ terminated: true })
  assert.deepEqual(
    settlement.decide(),
    { kind: 'wait' },
    'the final output is only complete once the child has closed',
  )

  settlement.recordChildClose(CLEAN_CLOSE)
  const decision = settlement.decide()
  assert.equal(decision.kind, 'report')
  assert.equal(
    decision.kind === 'report' && decision.releaseResources,
    true,
    'a group confirmed gone is not using the directory any more',
  )
  assert.deepEqual(
    decision.kind === 'report' ? decision.close : null,
    CLEAN_CLOSE,
    'and the close it reports is the one that arrived',
  )
})

test('a run that was never cancelled settles on its close alone', () => {
  const settlement = new DelegatedSettlement()
  assert.deepEqual(settlement.decide(), { kind: 'wait' })

  settlement.recordChildClose({ code: 1, signal: null })
  const decision = settlement.decide()
  assert.equal(decision.kind, 'report')
  assert.equal(decision.kind === 'report' && decision.releaseResources, true)
  assert.deepEqual(
    decision.kind === 'report' ? decision.close : null,
    { code: 1, signal: null },
    'a non-zero exit is still a close to report, not a termination failure',
  )
})

test('a decision is handed out once, however often it is asked for', () => {
  const settlement = new DelegatedSettlement()
  settlement.recordChildClose(CLEAN_CLOSE)

  assert.equal(settlement.decide().kind, 'report')
  assert.deepEqual(
    settlement.decide(),
    { kind: 'wait' },
    'releasing twice, or reporting twice, is the defect this prevents',
  )
  assert.deepEqual(settlement.decide(), { kind: 'wait' })
})

test('a termination arriving after a close is still decided once', () => {
  const settlement = new DelegatedSettlement()
  settlement.recordChildClose(CLEAN_CLOSE)
  settlement.recordTermination({ terminated: true })

  assert.equal(settlement.decide().kind, 'report')
  assert.deepEqual(settlement.decide(), { kind: 'wait' })
})

// A spawner closes its direct child's subtree once the child has exited, for
// any reason (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// section 8). The child's nested Teams and file-parser runs live in their own
// process groups, so the child closing says nothing about them.

test('a run whose child owns a subtree waits for that subtree to close before reporting', () => {
  const settlement = new DelegatedSettlement({ closesSubtree: true })
  settlement.recordChildClose(CLEAN_CLOSE)
  assert.deepEqual(settlement.decide(), { kind: 'wait' }, 'a closed child is not yet a closed subtree')

  settlement.recordSubtreeClosure({ closed: true })
  assert.deepEqual(settlement.decide(), {
    kind: 'report',
    close: CLEAN_CLOSE,
    releaseResources: true,
  })
})

test('a held subtree fails the run and keeps its resources, as an unconfirmed termination does', () => {
  const settlement = new DelegatedSettlement({ closesSubtree: true })
  settlement.recordChildClose(CLEAN_CLOSE)
  settlement.recordSubtreeClosure({
    closed: false,
    reason: 'owned process 7 is unverifiable: group 4242 is alive and no process carries its host marker.',
  })

  const decision = settlement.decide()
  assert.equal(decision.kind, 'abandon', 'nothing is released over a descendant that may still run')
  assert.equal(decision.kind === 'abandon' && decision.releaseResources, false)
  assert.match(
    decision.kind === 'abandon' ? decision.message : '',
    /group 4242 is alive/,
    'the message must carry what was observed',
  )
  assert.match(
    decision.kind === 'abandon' ? decision.message : '',
    /intentionally|deliberately/i,
    'and must say the directory was kept on purpose, not lost',
  )
})
