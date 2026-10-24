/**
 * Replaying a finished turn must not consume an admission slot.
 *
 * A slot means "this turn started and has not finished". The resolver takes one
 * before anything has looked at whether the turn is finished, so replaying a
 * turn that already reached a terminal re-adds its id to the unresolved set —
 * and the replay path returns the stored answer without recording a terminal,
 * so nothing gives the slot back. Enough replays and a healthy conversation
 * refuses all new work.
 *
 * The rule is about terminal state generally, not the completed case: failed,
 * cancelled, and an unreadable stream all mean "not unresolved", and each throws
 * or returns after the resolver has already reserved.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const DIGEST = 'f6'.repeat(32)

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

function reservedTurnIds(workspacePath: string, sessionId: string): string[] {
  const indexPath = path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    '.unresolved.json',
  )
  if (!fs.existsSync(indexPath)) return []
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
    turnIds?: unknown
  }
  return Array.isArray(parsed.turnIds) ? (parsed.turnIds as string[]) : []
}

type Terminal = 'completed' | 'failed' | 'cancelled'

/** Drive one turn to a terminal through the real recorder. */
async function driveToTerminal(input: {
  registry: WorkspaceConversationJournalRegistry
  workspacePath: string
  sessionId: string
  turnId: string
  terminal: Terminal
}): Promise<void> {
  const owner = {
    kind: 'run-session' as const,
    conversationId: input.sessionId,
    sessionId: input.sessionId,
  }
  const recorder = await resolveConversationTurnJournalRecorder({
    registry: input.registry,
    owner,
    turnId: input.turnId,
    workspacePath: input.workspacePath,
  })
  assert.ok(recorder)
  await recorder.recordStarted({
    surface: 'run-receptionist',
    userMessageId: `${input.turnId}:user`,
    requestDigest: DIGEST,
    expectedResponseCount: 1,
    origin: 'client',
  })
  if (input.terminal === 'completed') {
    await recorder.recordPrepared({
      assistantMessageIds: [`${input.turnId}:assistant:0`],
    })
    await recorder.recordCompleted({
      assistantMessageIds: [`${input.turnId}:assistant:0`],
    })
  } else if (input.terminal === 'failed') {
    await recorder.recordFailed({
      failure: { code: 'plan_conflict', phase: 'plan-revision' },
    })
  } else {
    await recorder.recordCancelled({ phase: 'provider' })
  }
  await recorder.release()
}

for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
  test(`replaying a ${terminal} turn does not consume an admission slot`, async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace(
      `conversation-replay-${terminal}-`,
    )
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    const owner = {
      kind: 'run-session' as const,
      conversationId: sessionId,
      sessionId,
    }
    const turnId = randomUUID()
    try {
      await driveToTerminal({
        registry,
        workspacePath,
        sessionId,
        turnId,
        terminal,
      })
      assert.deepEqual(
        reservedTurnIds(workspacePath, sessionId),
        [],
        'the finished turn gave its slot back',
      )

      // The replay: a second request for the same turn id resolves a recorder
      // before anything classifies the turn as already answered.
      const replay = await resolveConversationTurnJournalRecorder({
        registry,
        owner,
        turnId,
        workspacePath,
      })
      await replay?.release()

      assert.deepEqual(
        reservedTurnIds(workspacePath, sessionId),
        [],
        'and replaying it did not take the slot back',
      )

      // Proven without leaning on reconciliation: under a cap of one, a new
      // turn must still be admissible.
      const fresh = await resolveConversationTurnJournalRecorder({
        registry,
        owner,
        turnId: randomUUID(),
        workspacePath,
        maxUnresolved: 1,
      })
      assert.ok(fresh, 'a replayed terminal turn must not occupy the only slot')
      await fresh.release()
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}

test('a genuinely unresolved turn keeps its slot when it is resolved again', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace(
    'conversation-replay-unresolved-',
  )
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const owner = {
    kind: 'run-session' as const,
    conversationId: sessionId,
    sessionId,
  }
  const turnId = randomUUID()
  try {
    const recorder = await resolveConversationTurnJournalRecorder({
      registry,
      owner,
      turnId,
      workspacePath,
    })
    assert.ok(recorder)
    await recorder.recordStarted({
      surface: 'run-receptionist',
      userMessageId: `${turnId}:user`,
      requestDigest: DIGEST,
      expectedResponseCount: 1,
      origin: 'client',
    })
    await recorder.release()

    // Started and unfinished: this one really is unresolved, and releasing its
    // slot would be the opposite mistake.
    const again = await resolveConversationTurnJournalRecorder({
      registry,
      owner,
      turnId,
      workspacePath,
    })
    await again?.release()

    assert.deepEqual(
      reservedTurnIds(workspacePath, sessionId),
      [turnId],
      'an unfinished turn still holds its slot',
    )
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
