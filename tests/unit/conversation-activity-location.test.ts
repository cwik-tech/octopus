/**
 * The path is keyed by session; the registry is keyed by conversation.
 *
 * For a Run-session owner those are the same identifier, and every writer
 * assumes it. Nothing enforced it, so an owner naming one session and a
 * different conversation resolved to a perfectly valid path under the session —
 * while the journal sealed into its manifest, and the admission document beside
 * it, described the conversation. Two callers with different owners would then
 * share one directory and one admission slot set while believing they were in
 * different conversations.
 *
 * The two agreeing is the invariant that makes a session-keyed path and a
 * conversation-keyed registry the same thing. An owner that breaks it names no
 * location at all.
 *
 * The activity's own name is the other half. Phase 1 mints an activity id from
 * a turn id, and a turn id is a uuid at the request boundary and when the
 * server mints one — so anything else in that position is not an identity this
 * system produced. A safe path segment is not the same question: `notes`,
 * `.keep-me` and `backup` are all perfectly safe and none of them is an
 * activity. Letting them resolve gives a directory somebody dropped into the
 * conversation a journal, a retention slot and a line in an operator's report.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildConversationActivitiesRoot,
  buildConversationActivityLocation,
  isConversationActivityId,
} from '../../core/conversation-activity-location.js'

const WORKSPACE = '/tmp/a-workspace'
const ACTIVITY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

test('a Run-session owner whose conversation is not its session names nothing', () => {
  assert.equal(
    buildConversationActivityLocation(WORKSPACE, {
      owner: {
        kind: 'run-session',
        conversationId: 'a-different-conversation',
        sessionId: 'session-1',
      },
      activityId: ACTIVITY,
    }),
    null,
    'a path under one session must never stand for another conversation',
  )
})

test('a Run-session owner that agrees with itself resolves', () => {
  const location = buildConversationActivityLocation(WORKSPACE, {
    owner: {
      kind: 'run-session',
      conversationId: 'session-1',
      sessionId: 'session-1',
    },
    activityId: ACTIVITY,
  })
  assert.ok(location)
  assert.equal(location.sessionId, 'session-1')
  assert.equal(location.conversationId, 'session-1')
  assert.equal(
    location.relativeActivityPath,
    `sessions/session-1/.conversation-activities/${ACTIVITY}`,
  )
  assert.ok(buildConversationActivitiesRoot(WORKSPACE, 'session-1'))
})

test('an unsafe segment still names nothing, whichever field carries it', () => {
  for (const owner of [
    { kind: 'run-session' as const, conversationId: '..', sessionId: '..' },
    {
      kind: 'run-session' as const,
      conversationId: 'session-1',
      sessionId: 'session-1',
    },
  ]) {
    const location = buildConversationActivityLocation(WORKSPACE, {
      owner,
      activityId: owner.sessionId === '..' ? ACTIVITY : '..',
    })
    assert.equal(location, null)
  }
})

test('an activity id is a uuid, and a safe segment is not enough', () => {
  // The predicate is the definition, shared so that path resolution, retention,
  // discovery and inspection cannot each hold a different idea of what an
  // activity is called.
  assert.equal(isConversationActivityId(ACTIVITY), true)
  assert.equal(
    isConversationActivityId(ACTIVITY.toUpperCase()),
    true,
    'a uuid is a uuid whichever case it was written in',
  )
  for (const notAnActivity of [
    'activity-1',
    'notes',
    'backup',
    'README',
    '',
    `${ACTIVITY}-extra`,
    `x${ACTIVITY}`,
    42,
    null,
    undefined,
  ]) {
    assert.equal(
      isConversationActivityId(notAnActivity),
      false,
      `${JSON.stringify(notAnActivity)} is not an activity id`,
    )
  }
})

test('a safe segment that is not a uuid names no activity location', () => {
  for (const notAnActivity of ['activity-1', 'notes', 'backup']) {
    assert.equal(
      buildConversationActivityLocation(WORKSPACE, {
        owner: {
          kind: 'run-session',
          conversationId: 'session-1',
          sessionId: 'session-1',
        },
        activityId: notAnActivity,
      }),
      null,
      `'${notAnActivity}' is a safe path segment, which is not the same as an activity`,
    )
  }
})
