import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  isTeamChatMessagePayload,
  teamChatMessageId,
} from '../../contracts/team-chat-messages.js'
import type { EngineEventEnvelope } from '../../contracts/runtime-events.js'
import { subscribeEngineEvents } from '../../domains/runtime/runtime-events.js'
import {
  publishAcceptedTeamChatMessage,
  publishTeamChatMessage,
  readTeamChatMessages,
  teamChatMessageLogPath,
} from '../../domains/runtime/team-chat-messages.js'

function makeAssignment(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `team-chat-message-${label}-`))
}

function captureTeamMessages(): {
  events: EngineEventEnvelope[]
  stop: () => void
} {
  const events: EngineEventEnvelope[] = []
  const stop = subscribeEngineEvents((event) => {
    if (event.type === 'team.message') events.push(event)
  })
  return { events, stop }
}

function makePublication(
  assignmentPath: string,
  overrides: Partial<Parameters<typeof publishTeamChatMessage>[0]> = {},
): Parameters<typeof publishTeamChatMessage>[0] {
  return {
    agentName: 'line-one',
    assignmentPath,
    dispatchId: 'call-1#1#line-one',
    runId: 'run-1',
    stageId: 'run',
    stageType: 'chain',
    team: 'line-team',
    text: 'Phased rollout recommended.',
    timestamp: '2026-08-30T10:00:00.000Z',
    ...overrides,
  }
}

test('an accepted contribution becomes one durable record and one content event', () => {
  const assignmentPath = makeAssignment('publish')
  const captured = captureTeamMessages()

  try {
    const outcome = publishTeamChatMessage(
      makePublication(assignmentPath, { rootRunId: 'root-1' }),
    )

    assert.equal(outcome, 'published')

    const records = readTeamChatMessages(assignmentPath)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.agent_name, 'line-one')
    assert.equal(records[0]?.text, 'Phased rollout recommended.')
    assert.equal(records[0]?.stage_id, 'run')
    assert.equal(records[0]?.message_type, 'position')
    assert.equal(
      records[0]?.message_id,
      teamChatMessageId({ runId: 'run-1', dispatchId: 'call-1#1#line-one' }),
    )

    assert.equal(captured.events.length, 1)
    const event = captured.events[0]
    assert.equal(event?.category, 'stage')
    assert.equal(event?.run_id, 'run-1')
    assert.equal(event?.root_run_id, 'root-1')
    assert.equal(event?.team, 'line-team')
    assert.equal(event?.level_id, 'run')
    assert.equal(event?.stage_type, 'chain')
    assert.ok(isTeamChatMessagePayload(event?.payload))
  } finally {
    captured.stop()
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a durable message carries only the fields needed to render it', () => {
  const assignmentPath = makeAssignment('fields')

  try {
    publishTeamChatMessage(makePublication(assignmentPath))

    const record = readTeamChatMessages(assignmentPath)[0]
    assert.ok(record)
    assert.deepEqual(Object.keys(record).sort(), [
      'agent_name',
      'dispatch_id',
      'message_id',
      'message_type',
      'run_id',
      'stage_id',
      'text',
      'timestamp',
    ])
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a message already recorded and announced is neither written nor announced again', () => {
  const assignmentPath = makeAssignment('duplicate')
  const captured = captureTeamMessages()

  try {
    publishTeamChatMessage(makePublication(assignmentPath))
    captured.events.length = 0

    const outcome = publishTeamChatMessage(makePublication(assignmentPath))

    assert.equal(outcome, 'duplicate')
    assert.equal(readTeamChatMessages(assignmentPath).length, 1)
    assert.equal(captured.events.length, 0)
  } finally {
    captured.stop()
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a message recorded but never announced is announced on the next attempt', () => {
  // The crash window: the transcript record lands, the process dies, and the
  // event the reader actually sees was never written. A dedupe that trusted
  // the record alone would make that permanent.
  const assignmentPath = makeAssignment('crash-window')
  const captured = captureTeamMessages()

  try {
    fs.mkdirSync(path.dirname(teamChatMessageLogPath(assignmentPath)), {
      recursive: true,
    })
    fs.writeFileSync(
      teamChatMessageLogPath(assignmentPath),
      `${JSON.stringify({
        agent_name: 'line-one',
        dispatch_id: 'call-1#1#line-one',
        message_id: teamChatMessageId({
          runId: 'run-1',
          dispatchId: 'call-1#1#line-one',
        }),
        message_type: 'position',
        run_id: 'run-1',
        stage_id: 'run',
        text: 'Phased rollout recommended.',
        timestamp: '2026-08-30T10:00:00.000Z',
      })}\n`,
    )

    const outcome = publishTeamChatMessage(makePublication(assignmentPath))

    assert.equal(outcome, 'reconciled')
    assert.equal(readTeamChatMessages(assignmentPath).length, 1)
    assert.equal(captured.events.length, 1)
    assert.equal(
      captured.events[0]?.payload.message_id,
      teamChatMessageId({ runId: 'run-1', dispatchId: 'call-1#1#line-one' }),
    )
  } finally {
    captured.stop()
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('repairing a missing event announces the recorded message, not the replay', () => {
  // The transcript is what was accepted. A replay that reaches the publisher
  // with drifted text or a new clock must not announce a different answer
  // under the same identity than the one already written down.
  const assignmentPath = makeAssignment('canonical-repair')
  const captured = captureTeamMessages()

  try {
    fs.mkdirSync(path.dirname(teamChatMessageLogPath(assignmentPath)), {
      recursive: true,
    })
    fs.writeFileSync(
      teamChatMessageLogPath(assignmentPath),
      `${JSON.stringify({
        agent_name: 'line-one',
        dispatch_id: 'call-1#1#line-one',
        message_id: teamChatMessageId({
          runId: 'run-1',
          dispatchId: 'call-1#1#line-one',
        }),
        message_type: 'position',
        run_id: 'run-1',
        stage_id: 'run',
        text: 'Phased rollout recommended.',
        timestamp: '2026-08-30T10:00:00.000Z',
      })}\n`,
    )

    const outcome = publishTeamChatMessage(
      makePublication(assignmentPath, {
        text: 'A different answer from the replay.',
        timestamp: '2026-08-30T11:00:00.000Z',
      }),
    )

    assert.equal(outcome, 'reconciled')
    assert.equal(captured.events.length, 1)
    assert.equal(
      captured.events[0]?.payload.text,
      'Phased rollout recommended.',
    )
    assert.equal(
      captured.events[0]?.payload.timestamp,
      '2026-08-30T10:00:00.000Z',
    )
    assert.equal(captured.events[0]?.timestamp, '2026-08-30T10:00:00.000Z')
    assert.equal(readTeamChatMessages(assignmentPath).length, 1)
    assert.equal(
      readTeamChatMessages(assignmentPath)[0]?.text,
      'Phased rollout recommended.',
    )
  } finally {
    captured.stop()
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a missing private record is recovered from the announced event, not the replay', () => {
  // The inverse crash window. The event the reader sees survived; this run's
  // own transcript did not. Writing the replay's text into the gap would make
  // the two logs disagree about an answer the reader has already been shown.
  const assignmentPath = makeAssignment('inverse-window')
  const captured = captureTeamMessages()

  try {
    publishTeamChatMessage(makePublication(assignmentPath))
    fs.rmSync(teamChatMessageLogPath(assignmentPath))
    captured.events.length = 0

    const outcome = publishTeamChatMessage(
      makePublication(assignmentPath, {
        text: 'A different answer from the replay.',
        timestamp: '2026-08-30T11:00:00.000Z',
      }),
    )

    assert.equal(outcome, 'reconciled')
    // Nothing new is announced: the reader already has this message.
    assert.equal(captured.events.length, 0)
    const records = readTeamChatMessages(assignmentPath)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.text, 'Phased rollout recommended.')
    assert.equal(records[0]?.timestamp, '2026-08-30T10:00:00.000Z')
  } finally {
    captured.stop()
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a second attempt by the same agent is its own message', () => {
  const assignmentPath = makeAssignment('retry')

  try {
    publishTeamChatMessage(makePublication(assignmentPath))
    publishTeamChatMessage(
      makePublication(assignmentPath, {
        dispatchId: 'call-1#2#line-one',
        text: 'Corrected: phased rollout with a supplier contingency.',
      }),
    )

    const records = readTeamChatMessages(assignmentPath)
    assert.equal(records.length, 2)
    assert.deepEqual(
      records.map((record) => record.dispatch_id),
      ['call-1#1#line-one', 'call-1#2#line-one'],
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('an attempt that produced no text does not become a message', () => {
  const assignmentPath = makeAssignment('empty')
  const captured = captureTeamMessages()

  try {
    const outcome = publishTeamChatMessage(
      makePublication(assignmentPath, { text: '   \n  ' }),
    )

    assert.equal(outcome, 'unrecordable')
    assert.equal(readTeamChatMessages(assignmentPath).length, 0)
    assert.equal(captured.events.length, 0)
  } finally {
    captured.stop()
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a corrupt line in the log neither hides the messages around it nor crashes the run', () => {
  const assignmentPath = makeAssignment('corrupt')

  try {
    fs.mkdirSync(path.dirname(teamChatMessageLogPath(assignmentPath)), {
      recursive: true,
    })
    fs.writeFileSync(teamChatMessageLogPath(assignmentPath), 'not json\n')

    const outcome = publishTeamChatMessage(makePublication(assignmentPath))

    assert.equal(outcome, 'published')
    assert.equal(readTeamChatMessages(assignmentPath).length, 1)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

function makeScope(assignmentPath: string, chatMode: boolean) {
  return {
    chatMode,
    levelId: 'run',
    outputPath: assignmentPath,
    state: { rootSessionId: 'root-1', sessionId: 'run-1' },
    teamName: 'line-team',
  }
}

test('a Team running outside chat records no chat message', () => {
  const assignmentPath = makeAssignment('scope-off')
  const captured = captureTeamMessages()

  try {
    const outcome = publishAcceptedTeamChatMessage(
      makeScope(assignmentPath, false),
      {
        agentName: 'line-one',
        dispatchId: 'call-1#1#line-one',
        stageType: 'chain',
        text: 'Phased rollout recommended.',
      },
    )

    assert.equal(outcome, 'disabled')
    assert.equal(readTeamChatMessages(assignmentPath).length, 0)
    assert.equal(captured.events.length, 0)
  } finally {
    captured.stop()
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a Team chat contribution is attributed to the run and stage that produced it', () => {
  const assignmentPath = makeAssignment('scope-on')

  try {
    const outcome = publishAcceptedTeamChatMessage(
      makeScope(assignmentPath, true),
      {
        agentName: 'line-two',
        dispatchId: 'call-1#1#line-two',
        stageType: 'chain',
        text: 'Supplier contingency added.',
      },
    )

    assert.equal(outcome, 'published')
    const record = readTeamChatMessages(assignmentPath)[0]
    assert.equal(record?.run_id, 'run-1')
    assert.equal(record?.stage_id, 'run')
    assert.equal(record?.agent_name, 'line-two')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a contribution with no attempt identity is not recorded as a message', () => {
  const assignmentPath = makeAssignment('scope-no-dispatch')

  try {
    const outcome = publishAcceptedTeamChatMessage(
      makeScope(assignmentPath, true),
      {
        agentName: 'line-one',
        stageType: 'chain',
        text: 'Phased rollout recommended.',
      },
    )

    // Not 'disabled': this run does record Team chat messages, so a caller
    // must not read the refusal as permission to publish a legacy event.
    assert.equal(outcome, 'unrecordable')
    assert.equal(readTeamChatMessages(assignmentPath).length, 0)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})
