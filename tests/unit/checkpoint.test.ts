/**
 * Checkpoint Serialization & Resume Tests
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  serializeCheckpoint,
  writeCheckpoint,
  readCheckpoint,
  deleteCheckpoint,
  hasCheckpoint,
  formatCheckpointSummary,
  restoreLevelStatesFromCheckpoint,
  CHECKPOINT_FILENAME,
} from '../../domains/runtime/checkpoint.js'
import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import { readHostEntryAdmission } from '../../contracts/host-entry-admission.js'
import type { RuntimeState, DiscussionState, LevelState } from '../../core/types.js'
import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'

test('a broadcast checkpoint retains settled slots and rejects duplicate slot ownership', () => {
  const state = makeRuntimeState()
  const level = state.levelStates.get('l2')
  assert.ok(level)
  const slot = { slot: 0, agent: 'writer', text: 'Accepted work.', cost: 0.1, halted: false, succeeded: true }
  level.engineState = { type: 'broadcast', responses: [], aggregatedResult: null, settledSlots: [slot] }
  const checkpoint = serializeCheckpoint(state)
  assert.deepEqual(restoreLevelStatesFromCheckpoint(checkpoint).get('l2')?.engineState, level.engineState)
  const saved = checkpoint.levelStates.find((entry) => entry.levelId === 'l2')?.engineState
  assert.ok(saved)
  Reflect.set(saved.state, 'settledSlots', [slot, slot])
  assert.throws(() => restoreLevelStatesFromCheckpoint(checkpoint))
})

test('a review checkpoint retains its unfinished phase and rejects unknown phases', () => {
  const state = makeRuntimeState()
  const level = state.levelStates.get('l2')
  assert.ok(level)
  level.engineState = { type: 'review', iteration: 1, maxIterations: 1, lastVerdict: null, lastFeedback: '', lastDraft: 'The accepted draft.', pendingPhase: 'reviewer' }
  const checkpoint = serializeCheckpoint(state)
  assert.deepEqual(restoreLevelStatesFromCheckpoint(checkpoint).get('l2')?.engineState, level.engineState)
  const serialized = checkpoint.levelStates.find((entry) => entry.levelId === 'l2')?.engineState
  assert.ok(serialized)
  Reflect.set(serialized.state, 'pendingPhase', 'approved')
  assert.throws(() => restoreLevelStatesFromCheckpoint(checkpoint), /producer|reviewer|phase/)
})

function makeRuntimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    sessionId: 'sess-abc',
    tenantId: 'local',
    currentLevelIndex: 1,
    levelStates: new Map<string, LevelState>([
      ['l1', {
        status: LEVEL_STATUS.COMPLETED,
        stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
        engineState: null,
        loopbackCount: 0,
      }],
      ['l2', {
        status: LEVEL_STATUS.ACTIVE,
        stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
        engineState: {
          type: STAGE_TYPE.DISCUSSION,
          round: 3,
          messages: [],
          outputPath: '/tmp/out.md',
          approvedRoster: ['specialist'],
          rosterAnnounced: true,
        } satisfies DiscussionState as unknown as NonNullable<LevelState['engineState']>,
        loopbackCount: 1,
      }],
    ]),
    totalCost: 12.34,
    startTime: Date.now() - 60000,
    timerStarted: true,
    endTime: null,
    spawnDepth: 0,
    rootSessionId: 'root-xyz',
    parentSessionId: 'parent-123',
    ...overrides,
  }
}

test('serializeCheckpoint produces valid structure', () => {
  const state = makeRuntimeState()
  const cp = serializeCheckpoint(state)
  assert.equal(cp.version, 1)
  assert.equal(cp.sessionId, 'sess-abc')
  assert.equal(cp.currentLevelIndex, 1)
  assert.equal(cp.totalCost, 12.34)
  assert.equal(cp.spawnDepth, 0)
  assert.equal(cp.rootSessionId, 'root-xyz')
  assert.equal(cp.parentSessionId, 'parent-123')
  assert.equal(cp.levelStates.length, 2)
  const l2 = cp.levelStates.find((ls) => ls.levelId === 'l2')
  assert.ok(l2)
  assert.equal(l2!.loopbackCount, 1)
  assert.equal(l2!.engineState?.type, 'discussion')
})

test('checkpoint retains the start of human waiting and the already incurred cost', () => {
  const checkpoint = serializeCheckpoint(makeRuntimeState({ startTime: 1_000, questionPausedAt: 6_000, totalCost: 0.25 }))
  assert.equal(checkpoint.questionPausedAt, 6_000)
  assert.equal(checkpoint.totalCost, 0.25)
  assert.equal(checkpoint.startTime, 1_000)
})

test('writeCheckpoint and readCheckpoint roundtrip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'))
  try {
    const assignmentPath = path.join(dir, 'assignments', 'run-a')
    const state = makeRuntimeState()
    writeCheckpoint(assignmentPath, state)
    assert.ok(hasCheckpoint(assignmentPath))

    const cp = readCheckpoint(assignmentPath)
    assert.ok(cp)
    assert.equal(cp!.sessionId, 'sess-abc')
    assert.equal(cp!.currentLevelIndex, 1)
    assert.equal(cp!.totalCost, 12.34)
    assert.equal(
      fs.existsSync(path.join(assignmentPath, CHECKPOINT_FILENAME)),
      false,
    )
    assert.equal(
      fs.existsSync(getRunRuntimePaths(assignmentPath).checkpointPath),
      true,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writeCheckpoint atomically replaces the checkpoint without leaving a temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'))
  try {
    const assignmentPath = path.join(dir, 'assignments', 'run-a')
    const runtimePaths = getRunRuntimePaths(assignmentPath)
    writeCheckpoint(assignmentPath, makeRuntimeState({ totalCost: 1 }))
    writeCheckpoint(assignmentPath, makeRuntimeState({ totalCost: 2 }))

    assert.equal(readCheckpoint(assignmentPath)?.totalCost, 2)
    assert.deepEqual(
      fs.readdirSync(runtimePaths.privateRuntimePath)
        .filter((name) => name.includes(CHECKPOINT_FILENAME) && name.endsWith('.tmp')),
      [],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('assignment-scoped checkpoints remain isolated from each other and the legacy workspace checkpoint', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-scope-test-'))
  const assignmentA = path.join(workspace, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'a')
  const assignmentB = path.join(workspace, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'b')
  try {
    writeCheckpoint(workspace, makeRuntimeState({ sessionId: 'legacy', totalCost: 1 }))
    writeCheckpoint(assignmentA, makeRuntimeState({ sessionId: 'a', totalCost: 2 }))
    writeCheckpoint(assignmentB, makeRuntimeState({ sessionId: 'b', totalCost: 3 }))

    assert.equal(readCheckpoint(workspace)?.sessionId, 'legacy')
    assert.equal(readCheckpoint(assignmentA)?.sessionId, 'a')
    assert.equal(readCheckpoint(assignmentB)?.sessionId, 'b')
    assert.equal(readCheckpoint(assignmentA)?.totalCost, 2)
    assert.equal(readCheckpoint(assignmentB)?.totalCost, 3)

    deleteCheckpoint(assignmentA)
    assert.equal(hasCheckpoint(assignmentA), false)
    assert.equal(hasCheckpoint(assignmentB), true)
    assert.equal(hasCheckpoint(workspace), true)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('deleteCheckpoint removes the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'))
  try {
    const assignmentPath = path.join(dir, 'assignments', 'run-a')
    writeCheckpoint(assignmentPath, makeRuntimeState())
    assert.ok(hasCheckpoint(assignmentPath))
    deleteCheckpoint(assignmentPath)
    assert.equal(hasCheckpoint(assignmentPath), false)
    assert.equal(
      fs.existsSync(getRunRuntimePaths(assignmentPath).privateRuntimePath),
      true,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hasCheckpoint returns false for invalid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'))
  try {
    const assignmentPath = path.join(dir, 'assignments', 'run-a')
    const { checkpointPath, privateRuntimePath } = getRunRuntimePaths(assignmentPath)
    fs.mkdirSync(privateRuntimePath, { recursive: true })
    fs.writeFileSync(checkpointPath, 'not json')
    assert.equal(hasCheckpoint(assignmentPath), false)
    assert.equal(readCheckpoint(assignmentPath), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('checkpoint operations do not import or delete a workspace-root checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'))
  try {
    const assignmentPath = path.join(dir, 'assignments', 'run-a')
    const legacyWorkspaceCheckpoint = path.join(dir, CHECKPOINT_FILENAME)
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(
      legacyWorkspaceCheckpoint,
      `${JSON.stringify(serializeCheckpoint(makeRuntimeState()))}\n`,
    )

    assert.equal(hasCheckpoint(assignmentPath), false)
    assert.equal(readCheckpoint(assignmentPath), null)
    deleteCheckpoint(assignmentPath)
    assert.equal(fs.existsSync(legacyWorkspaceCheckpoint), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('two assignments retain independent checkpoints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'))
  try {
    const firstAssignmentPath = path.join(dir, 'assignments', 'run-a')
    const secondAssignmentPath = path.join(dir, 'assignments', 'run-b')

    writeCheckpoint(
      firstAssignmentPath,
      makeRuntimeState({ sessionId: 'run-a', totalCost: 1 }),
    )
    writeCheckpoint(
      secondAssignmentPath,
      makeRuntimeState({ sessionId: 'run-b', totalCost: 2 }),
    )

    assert.equal(readCheckpoint(firstAssignmentPath)?.sessionId, 'run-a')
    assert.equal(readCheckpoint(firstAssignmentPath)?.totalCost, 1)
    assert.equal(readCheckpoint(secondAssignmentPath)?.sessionId, 'run-b')
    assert.equal(readCheckpoint(secondAssignmentPath)?.totalCost, 2)

    deleteCheckpoint(firstAssignmentPath)
    assert.equal(hasCheckpoint(firstAssignmentPath), false)
    assert.equal(hasCheckpoint(secondAssignmentPath), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('formatCheckpointSummary includes key stats', () => {
  const cp = serializeCheckpoint(makeRuntimeState())
  const summary = formatCheckpointSummary(cp)
  assert.ok(summary.includes('sess-abc'))
  assert.ok(summary.includes('l2'))
  assert.ok(summary.includes('$12.34'))
})

test('restoreLevelStatesFromCheckpoint revives levelStates Map', () => {
  const state = makeRuntimeState()
  const cp = serializeCheckpoint(state)
  const restored = restoreLevelStatesFromCheckpoint(cp)
  assert.equal(restored.size, 2)
  const l1 = restored.get('l1')
  assert.equal(l1!.status, LEVEL_STATUS.COMPLETED)
  const l2 = restored.get('l2')
  assert.equal(l2!.status, LEVEL_STATUS.ACTIVE)
  assert.equal(l2!.loopbackCount, 1)
  assert.ok(l2!.engineState)
  assert.equal((l2!.engineState as DiscussionState).type, STAGE_TYPE.DISCUSSION)
  assert.equal((l2!.engineState as DiscussionState).round, 3)
})

test('checkpoint restore retains the next locked-roster continuation assignment', () => {
  const state = makeRuntimeState()
  const discussion = state.levelStates.get('l2')?.engineState
  assert.equal(discussion?.type, STAGE_TYPE.DISCUSSION)
  if (discussion?.type !== STAGE_TYPE.DISCUSSION) return
  discussion.continuation = {
    phase: 'awaiting_specialist_pass',
    startedAtMs: 1_000,
    assignment: {
      targets: ['specialist'],
      message: 'Resolve the evidence gap.',
    },
  }

  const restored = restoreLevelStatesFromCheckpoint(serializeCheckpoint(state))
  const restoredDiscussion = restored.get('l2')?.engineState
  assert.equal(restoredDiscussion?.type, STAGE_TYPE.DISCUSSION)
  if (restoredDiscussion?.type !== STAGE_TYPE.DISCUSSION) return
  assert.deepEqual(restoredDiscussion.continuation, discussion.continuation)
})

test('checkpoint restore rejects malformed discussion continuation state', () => {
  const checkpoint = serializeCheckpoint(makeRuntimeState())
  const serializedDiscussion = checkpoint.levelStates.find(
    (level) => level.engineState?.type === 'discussion',
  )?.engineState
  assert.equal(serializedDiscussion?.type, 'discussion')
  if (serializedDiscussion?.type !== 'discussion') return
  Reflect.set(serializedDiscussion.state, 'continuation', {
    phase: 'awaiting_specialist_pass',
    startedAtMs: -1,
    assignment: {
      targets: ['specialist', 42],
      message: '',
    },
  })

  assert.throws(
    () => restoreLevelStatesFromCheckpoint(checkpoint),
    /continuation checkpoint/i,
  )
})

test('checkpoint restore rejects a successful target without same-pass accepted evidence', () => {
  const checkpoint = serializeCheckpoint(makeRuntimeState())
  const serializedDiscussion = checkpoint.levelStates.find(
    (level) => level.engineState?.type === 'discussion',
  )?.engineState
  assert.equal(serializedDiscussion?.type, 'discussion')
  if (serializedDiscussion?.type !== 'discussion') return
  Reflect.set(serializedDiscussion.state, 'continuation', {
    phase: 'running_specialist_pass',
    startedAtMs: 1_000,
    passNumber: 3,
    attemptNumber: 1,
    assignment: {
      targets: ['specialist'],
      message: 'Resolve the remaining evidence gap.',
    },
    completedTargets: ['specialist'],
    successfulTargets: ['specialist'],
  })

  assert.throws(
    () => restoreLevelStatesFromCheckpoint(checkpoint),
    /accepted evidence/i,
  )
})

test('checkpoint restore rejects malformed pending roster announcement state', () => {
  const checkpoint = serializeCheckpoint(makeRuntimeState())
  const serializedDiscussion = checkpoint.levelStates.find(
    (level) => level.engineState?.type === 'discussion',
  )?.engineState
  assert.equal(serializedDiscussion?.type, 'discussion')
  if (serializedDiscussion?.type !== 'discussion') return
  Reflect.set(serializedDiscussion.state, 'setup', {
    phase: 'awaiting_roster_announcement',
    agents: ['specialist'],
    rosterRationale: { stranger: 'Not on the selected roster.' },
  })

  assert.throws(
    () => restoreLevelStatesFromCheckpoint(checkpoint),
    /discussion setup checkpoint/i,
  )
})

// ─── The host's admitted stage entry ─────────────────────────────────────────

test('a checkpoint carries the host entry admission that was live when it was written', () => {
  const state = makeRuntimeState({
    hostEntryAdmission: {
      levelId: 'l2',
      visit: 1,
      state: 'pending',
      selection: {
        provider: 'lm-studio',
        model: 'loopback-b',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      },
    },
  })

  const checkpoint = serializeCheckpoint(state)

  assert.deepEqual(checkpoint.hostEntryAdmission, {
    levelId: 'l2',
    visit: 1,
    state: 'pending',
    selection: {
      provider: 'lm-studio',
      model: 'loopback-b',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    },
  })
})

test('a run with nothing admitted writes no admission field at all', () => {
  // Absence has to stay absence, because a reader distinguishes "written by a
  // build with no admissions" from "written and unreadable", and those lead to
  // opposite recovery decisions.
  const checkpoint = serializeCheckpoint(makeRuntimeState())

  assert.equal('hostEntryAdmission' in checkpoint, false)
})

test('an admission survives a write and read through the real file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-admission-'))
  try {
    writeCheckpoint(
      dir,
      makeRuntimeState({
        hostEntryAdmission: {
          levelId: 'l2',
          visit: 2,
          state: 'dispatching',
          selection: {
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            source: 'agent',
            reason: 'explicit-agent-choice',
            caller: 'agent',
          },
        },
      }),
    )

    const restored = readCheckpoint(dir)

    assert.deepEqual(readHostEntryAdmission(restored?.hostEntryAdmission), {
      kind: 'admission',
      admission: {
        levelId: 'l2',
        visit: 2,
        state: 'dispatching',
        selection: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          source: 'agent',
          reason: 'explicit-agent-choice',
          caller: 'agent',
        },
      },
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a checkpoint whose admission is unreadable is still a readable checkpoint', () => {
  // The admission is parsed on its own path, by its own reader, so a record
  // this build cannot understand does not take the rest of the run's position
  // down with it. What to do about it is the caller's decision, not this
  // reader's.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-admission-bad-'))
  try {
    writeCheckpoint(dir, makeRuntimeState())
    const { checkpointPath } = getRunRuntimePaths(dir)
    const raw: Record<string, unknown> = JSON.parse(
      fs.readFileSync(checkpointPath, 'utf8'),
    )
    raw.hostEntryAdmission = { levelId: 'l2', visit: 'later' }
    fs.writeFileSync(checkpointPath, JSON.stringify(raw))

    const restored = readCheckpoint(dir)

    assert.equal(restored?.currentLevelIndex, 1)
    assert.deepEqual(
      readHostEntryAdmission(restored?.hostEntryAdmission),
      { kind: 'invalid' },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test('a pipeline checkpoint rejects duplicate question task ownership', () => {
  const state = makeRuntimeState()
  const level = state.levelStates.get('l2')
  assert.ok(level)
  level.engineState = { type: 'pipeline', planPath: '/tmp/plan.md', completedSprintIds: [], activeTaskIds: [] }
  const checkpoint = serializeCheckpoint(state)
  const saved = checkpoint.levelStates.find((entry) => entry.levelId === 'l2')?.engineState
  assert.ok(saved)
  Reflect.set(saved.state, 'questionTaskIds', ['T1', 'T1'])
  assert.throws(() => restoreLevelStatesFromCheckpoint(checkpoint))
})
