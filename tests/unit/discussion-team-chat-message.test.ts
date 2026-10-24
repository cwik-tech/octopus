/**
 * Which durable family owns an accepted discussion reply.
 *
 * A Team chat run records the reply as `team.message`; an ordinary discussion
 * workflow records it as `discussion.message`. The reader's transcript renders
 * both, so a run that emitted one of each would show the same answer twice.
 *
 * The dangerous case is a second pass over an attempt already recorded. The
 * publisher answers "nothing new here", and code that read that as "not a Team
 * chat run" would emit the legacy event beside the message it already wrote.
 * These tests drive the same attempt twice, which is what a replay is.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ConversationMessage } from '../../core/types.js'
import { recordAcceptedDiscussionMessage } from '../../engines/discussion.js'

const DISPATCH_ID = 'invocation-1#1#analyst'

function makeAssignment(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `discussion-message-${label}-`))
}

function makeScope(assignmentPath: string, chatMode: boolean) {
  return {
    chatMode,
    levelId: 'deliberation',
    outputPath: assignmentPath,
    state: { rootSessionId: 'root-run', sessionId: 'discussion-run' },
    teamName: 'board-team',
  }
}

function makeMessage(): ConversationMessage {
  return {
    from: 'analyst',
    message: 'Demand is credible, but margins remain uncertain.',
    round: 1,
    timestamp: '2026-08-30T12:00:00.000Z',
    to: 'all',
    type: 'position',
  }
}

function announcedTypes(assignmentPath: string): string[] {
  const logPath = path.join(assignmentPath, 'logs', 'engine-events.jsonl')
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return []
      const parsed: unknown = JSON.parse(line)
      return parsed && typeof parsed === 'object' && 'type' in parsed &&
        typeof parsed.type === 'string'
        ? [parsed.type]
        : []
    })
}

test('a Team chat reply replayed for the same attempt stays one visible message', () => {
  const assignmentPath = makeAssignment('replay')

  try {
    const first = recordAcceptedDiscussionMessage(
      makeScope(assignmentPath, true),
      makeMessage(),
      { agentName: 'analyst', dispatchId: DISPATCH_ID },
    )
    const second = recordAcceptedDiscussionMessage(
      makeScope(assignmentPath, true),
      makeMessage(),
      { agentName: 'analyst', dispatchId: DISPATCH_ID },
    )

    assert.equal(first, 'published')
    assert.equal(second, 'duplicate')

    const announced = announcedTypes(assignmentPath)
    assert.equal(
      announced.filter((type) => type === 'team.message').length,
      1,
    )
    assert.equal(
      announced.filter((type) => type === 'discussion.message').length,
      0,
      'a replayed Team chat reply must not fall back to the legacy event',
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('an ordinary discussion workflow still records the legacy message', () => {
  const assignmentPath = makeAssignment('workflow')

  try {
    const outcome = recordAcceptedDiscussionMessage(
      makeScope(assignmentPath, false),
      makeMessage(),
      { agentName: 'analyst', dispatchId: DISPATCH_ID },
    )

    assert.equal(outcome, 'disabled')
    const announced = announcedTypes(assignmentPath)
    assert.equal(
      announced.filter((type) => type === 'discussion.message').length,
      1,
    )
    assert.equal(
      announced.filter((type) => type === 'team.message').length,
      0,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a Team chat reply repaired after a lost event stays out of the legacy family', () => {
  const assignmentPath = makeAssignment('reconciled')

  try {
    // The transcript record survived; the event the reader sees did not.
    recordAcceptedDiscussionMessage(
      makeScope(assignmentPath, true),
      makeMessage(),
      { agentName: 'analyst', dispatchId: DISPATCH_ID },
    )
    fs.rmSync(path.join(assignmentPath, 'logs', 'engine-events.jsonl'))

    const outcome = recordAcceptedDiscussionMessage(
      makeScope(assignmentPath, true),
      makeMessage(),
      { agentName: 'analyst', dispatchId: DISPATCH_ID },
    )

    assert.equal(outcome, 'reconciled')
    const announced = announcedTypes(assignmentPath)
    assert.equal(announced.filter((type) => type === 'team.message').length, 1)
    assert.equal(
      announced.filter((type) => type === 'discussion.message').length,
      0,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a Team chat reply the contract cannot record stays out of the legacy family', () => {
  // Not a replay, but the same trap: the publisher says "nothing recorded",
  // and reading that as "not a Team chat run" would leak a legacy event.
  const assignmentPath = makeAssignment('unrecordable')

  try {
    const outcome = recordAcceptedDiscussionMessage(
      makeScope(assignmentPath, true),
      makeMessage(),
      { agentName: 'analyst' },
    )

    assert.equal(outcome, 'unrecordable')
    assert.equal(
      announcedTypes(assignmentPath).filter(
        (type) => type === 'discussion.message',
      ).length,
      0,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})
