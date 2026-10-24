import assert from 'node:assert/strict'
import test from 'node:test'

import type { HostEntryAdmission } from '../../contracts/host-entry-admission.js'
import { STAGE_TYPE } from '../../core/constants.js'
import type { DiscussionState } from '../../core/types.js'
import type { RuntimeCheckpoint } from '../../domains/runtime/checkpoint.js'
import {
  adoptedCheckpointHeader,
  adoptedCheckpointLevels,
  resumedCheckpointStartTime,
} from '../../team-runtime/checkpoint-adoption.js'

/**
 * Direct checks on what a session start adopts from its own checkpoint.
 *
 * The entrypoint tests in
 * `tests/integration/team-runtime-checkpoint-adoption.test.ts` boot the
 * runtime, whose clock is the real one, so they can show that the run clock
 * and every discussion clock move forward by the same positive span but not
 * by how much. They also cannot see the checkpoint object the start read,
 * which it drops after adoption. These pin the span against a fixed `now`,
 * and that adopting leaves the checkpoint as it was read.
 */

const SAVED_START = Date.parse('2026-01-01T00:00:00.000Z')
/** The question was asked ten seconds into the run. */
const QUESTION_PAUSED_AT = SAVED_START + 10_000
/** The person answered a minute after the question was asked. */
const NOW = QUESTION_PAUSED_AT + 60_000

function makeCheckpoint(
  levelStates: RuntimeCheckpoint['levelStates'],
  fields: Partial<RuntimeCheckpoint> = {},
): RuntimeCheckpoint {
  return {
    version: 1,
    savedAt: '2026-01-01T00:00:10.000Z',
    sessionId: 'session-under-test',
    currentLevelIndex: 0,
    totalCost: 3,
    startTime: SAVED_START,
    questionPausedAt: QUESTION_PAUSED_AT,
    levelStates,
    spawnDepth: 1,
    ...fields,
  }
}

function discussionLevel(levelId: string, state: DiscussionState): RuntimeCheckpoint['levelStates'][number] {
  return {
    levelId,
    status: 'active',
    stageStatus: 'ready',
    loopbackCount: 0,
    visitCount: 0,
    engineState: { type: 'discussion', state },
  }
}

test('a checkpoint saved while a question waited resumes the run clock by exactly the time since the pause, and moves each discussion\'s clocks by the same span', () => {
  const checkpoint = makeCheckpoint([
    discussionLevel('intake', {
      type: STAGE_TYPE.DISCUSSION,
      round: 1,
      messages: [],
      outputPath: 'decision.md',
      activationStartedAtMs: SAVED_START + 1_000,
      approvedRoster: ['analyst'],
      rosterAnnounced: true,
      continuation: { phase: 'awaiting_lead_decision', startedAtMs: SAVED_START + 2_000 },
    }),
    {
      levelId: 'next',
      status: 'pending',
      stageStatus: 'not_started',
      loopbackCount: 0,
      visitCount: 0,
      engineState: null,
    },
  ])

  const resumedStart = resumedCheckpointStartTime(checkpoint, NOW)
  const { levelStates } = adoptedCheckpointLevels(checkpoint, resumedStart)

  assert.equal(resumedStart, SAVED_START + 60_000)
  const intake = levelStates.get('intake')?.engineState
  assert.ok(intake?.type === STAGE_TYPE.DISCUSSION, 'the intake level is a discussion')
  assert.equal(intake.activationStartedAtMs, SAVED_START + 61_000)
  assert.deepEqual(intake.continuation, {
    phase: 'awaiting_lead_decision',
    startedAtMs: SAVED_START + 62_000,
  })
  assert.equal(levelStates.get('next')?.engineState, null, 'a level with no engine state has no clock to move')
})

/** An entry the interrupted process admitted and had not sent. */
const PENDING_ADMISSION: HostEntryAdmission = {
  levelId: 'intake',
  visit: 0,
  state: 'pending',
  selection: {
    provider: 'lm-studio',
    model: 'local-model',
    source: 'agent',
    reason: 'explicit-agent-choice',
    caller: 'agent',
  },
}

test('adopting a checkpoint leaves the checkpoint as it was read', () => {
  // A specialist pass saved before passes recorded an attempt number. The
  // restore reads it as attempt 0.
  const continuation: DiscussionState['continuation'] = {
    phase: 'running_specialist_pass',
    startedAtMs: SAVED_START + 2_000,
    passNumber: 1,
    attemptNumber: 0,
    targets: ['analyst'],
    completedTargets: ['analyst'],
    successfulTargets: [],
  }
  Reflect.deleteProperty(continuation, 'attemptNumber')
  const checkpoint = makeCheckpoint(
    [
      discussionLevel('intake', {
        type: STAGE_TYPE.DISCUSSION,
        round: 1,
        messages: [],
        outputPath: 'decision.md',
        activationStartedAtMs: SAVED_START + 1_000,
        approvedRoster: ['analyst'],
        rosterAnnounced: true,
        continuation,
      }),
    ],
    // No rootSessionId: the header takes the session id as the root.
    { hostEntryAdmission: PENDING_ADMISSION },
  )
  const asRead = structuredClone(checkpoint)

  const header = adoptedCheckpointHeader(checkpoint)
  const resumedStart = resumedCheckpointStartTime(checkpoint, NOW)
  const adopted = adoptedCheckpointLevels(checkpoint, resumedStart)

  assert.equal(header.rootSessionId, 'session-under-test')
  assert.equal(adopted.admission.kind, 'admission')
  const intake = adopted.levelStates.get('intake')?.engineState
  assert.ok(intake?.type === STAGE_TYPE.DISCUSSION, 'the intake level is a discussion')
  assert.ok(intake.continuation?.phase === 'running_specialist_pass', 'the pass is still running')
  assert.equal(intake.continuation.attemptNumber, 0, 'precondition: the restore filled in the attempt number')
  assert.deepEqual(checkpoint, asRead, 'the checkpoint is unchanged')
})

test('adopting a checkpoint whose engine state carries an unknown field nested thousands deep revives it and leaves the checkpoint as it was read', () => {
  let deep: Record<string, unknown> = {}
  for (let depth = 0; depth < 3_000; depth += 1) deep = { nested: deep }
  const state: DiscussionState = {
    type: STAGE_TYPE.DISCUSSION,
    round: 0,
    messages: [],
    outputPath: 'decision.md',
    activationStartedAtMs: SAVED_START + 1_000,
  }
  Reflect.set(state, 'notes', deep)
  const checkpoint = makeCheckpoint([discussionLevel('intake', state)])
  // Serialized for the comparison: a structural deep-equal would recurse as
  // far as the field goes.
  const asRead = JSON.stringify(checkpoint)

  const adopted = adoptedCheckpointLevels(checkpoint, resumedCheckpointStartTime(checkpoint, NOW))

  assert.equal(adopted.levelStates.get('intake')?.engineState?.type, STAGE_TYPE.DISCUSSION)
  assert.equal(JSON.stringify(checkpoint), asRead, 'the checkpoint is unchanged')
})
