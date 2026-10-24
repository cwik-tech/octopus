/**
 * What a conversation may forget, and what it may never forget.
 *
 * Bounded retention here does not come from compaction — the accepted journal
 * ADR forbids rewriting an acknowledged journal — it comes from deleting whole
 * activities that are finished and old. So the selector's job is to be exact
 * about which activities those are, and to refuse to touch anything else.
 *
 * The rule that matters most: an unresolved turn is never selected. A turn that
 * started and never reached a terminal is the one an operator has to be able to
 * look at, and it is precisely the one a naive age sweep would remove first.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONVERSATION_MAX_TERMINAL_ACTIVITIES,
  CONVERSATION_MAX_UNRESOLVED_ACTIVITIES,
  CONVERSATION_TERMINAL_RETENTION_MS,
  CONVERSATION_MAX_PROJECTED_IDS,
  selectExpiredConversationActivities,
  type RetainedConversationActivity,
} from '../../domains/conversations/conversation-turn-retention-policy.js'

const NOW = Date.parse('2026-08-26T12:00:00.000Z')

function activity(
  overrides: Partial<RetainedConversationActivity> = {},
): RetainedConversationActivity {
  return {
    activityId: 'activity-1',
    state: 'completed',
    lastEventAtMs: NOW,
    ...overrides,
  }
}

function daysAgo(days: number): number {
  return NOW - days * 24 * 60 * 60 * 1000
}

test('the defaults are the ones the plan states', () => {
  assert.equal(CONVERSATION_TERMINAL_RETENTION_MS, 30 * 24 * 60 * 60 * 1000)
  assert.equal(CONVERSATION_MAX_TERMINAL_ACTIVITIES, 10_000)
  assert.equal(CONVERSATION_MAX_UNRESOLVED_ACTIVITIES, 100)
  assert.equal(
    CONVERSATION_MAX_PROJECTED_IDS > CONVERSATION_MAX_TERMINAL_ACTIVITIES,
    true,
    'with headroom, because reclamation lags the turn that crosses the cap',
  )
})

test('a terminal activity older than the window is expired', () => {
  const outcome = selectExpiredConversationActivities(
    [
      activity({ activityId: 'old', lastEventAtMs: daysAgo(31) }),
      activity({ activityId: 'fresh', lastEventAtMs: daysAgo(29) }),
    ],
    { now: () => NOW },
  )
  assert.deepEqual(outcome.expired, ['old'])
})

test('the boundary is inclusive of the window rather than off by a day', () => {
  const exactly = selectExpiredConversationActivities(
    [activity({ activityId: 'boundary', lastEventAtMs: daysAgo(30) })],
    { now: () => NOW },
  )
  assert.deepEqual(
    exactly.expired,
    ['boundary'],
    'an activity exactly at the window has spent it',
  )
  const justInside = selectExpiredConversationActivities(
    [
      activity({
        activityId: 'inside',
        lastEventAtMs: daysAgo(30) + 1,
      }),
    ],
    { now: () => NOW },
  )
  assert.deepEqual(justInside.expired, [])
})

test('an unresolved turn is never expired, however old it is', () => {
  for (const state of ['started', 'prepared'] as const) {
    const outcome = selectExpiredConversationActivities(
      [activity({ activityId: `unresolved-${state}`, state, lastEventAtMs: daysAgo(400) })],
      { now: () => NOW },
    )
    assert.deepEqual(
      outcome.expired,
      [],
      `a ${state} turn is evidence an operator still needs`,
    )
    assert.deepEqual(outcome.unresolved, [`unresolved-${state}`])
  }
})

test('an unreadable activity is not swept, because its state is unknown', () => {
  const outcome = selectExpiredConversationActivities(
    [activity({ activityId: 'broken', state: 'invalid', lastEventAtMs: daysAgo(400) })],
    { now: () => NOW },
  )
  assert.deepEqual(
    outcome.expired,
    [],
    'deleting what could not be read would destroy the only evidence of it',
  )
})

test('every terminal kind is eligible once it is old enough', () => {
  const outcome = selectExpiredConversationActivities(
    [
      activity({ activityId: 'completed', state: 'completed', lastEventAtMs: daysAgo(31) }),
      activity({ activityId: 'failed', state: 'failed', lastEventAtMs: daysAgo(31) }),
      activity({ activityId: 'cancelled', state: 'cancelled', lastEventAtMs: daysAgo(31) }),
    ],
    { now: () => NOW },
  )
  assert.deepEqual(outcome.expired.slice().sort(), [
    'cancelled',
    'completed',
    'failed',
  ])
})

test('over the count cap, the oldest terminals go first and deterministically', () => {
  const activities = new Array(12).fill(0).map((_value, index) =>
    activity({
      activityId: `activity-${String(index).padStart(2, '0')}`,
      // index 0 is the oldest.
      lastEventAtMs: NOW - (12 - index) * 1000,
    }),
  )
  const outcome = selectExpiredConversationActivities(activities, {
    now: () => NOW,
    maxTerminalActivities: 10,
  })
  assert.deepEqual(
    outcome.expired,
    ['activity-00', 'activity-01'],
    'exactly the overflow, oldest first',
  )

  // Same input, same answer: a sweep must not depend on directory order.
  const shuffled = [...activities].reverse()
  assert.deepEqual(
    selectExpiredConversationActivities(shuffled, {
      now: () => NOW,
      maxTerminalActivities: 10,
    }).expired,
    outcome.expired,
  )
})

test('the count cap counts terminals only, so unresolved work cannot be evicted by volume', () => {
  const outcome = selectExpiredConversationActivities(
    [
      activity({ activityId: 'unresolved', state: 'started', lastEventAtMs: daysAgo(400) }),
      activity({ activityId: 'terminal-1', lastEventAtMs: daysAgo(3) }),
      activity({ activityId: 'terminal-2', lastEventAtMs: daysAgo(2) }),
    ],
    { now: () => NOW, maxTerminalActivities: 1 },
  )
  assert.deepEqual(outcome.expired, ['terminal-1'])
})

test('too many unresolved turns stops admitting new ones rather than deleting old ones', () => {
  const unresolved = new Array(3).fill(0).map((_value, index) =>
    activity({
      activityId: `unresolved-${index}`,
      state: 'started',
      lastEventAtMs: daysAgo(index + 1),
    }),
  )
  const outcome = selectExpiredConversationActivities(unresolved, {
    now: () => NOW,
    maxUnresolvedActivities: 2,
  })
  assert.equal(
    outcome.admitsNewActivity,
    false,
    'a conversation accumulating unresolved turns has a problem to surface, not to hide',
  )
  assert.deepEqual(outcome.expired, [], 'and still nothing is deleted')
})

test('a healthy conversation admits new activities', () => {
  const outcome = selectExpiredConversationActivities(
    [activity({ activityId: 'unresolved', state: 'started' })],
    { now: () => NOW },
  )
  assert.equal(outcome.admitsNewActivity, true)
})

test('an empty conversation is a valid, empty answer', () => {
  const outcome = selectExpiredConversationActivities([], { now: () => NOW })
  assert.deepEqual(outcome.expired, [])
  assert.deepEqual(outcome.unresolved, [])
  assert.equal(outcome.admitsNewActivity, true)
})
