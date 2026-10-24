/**
 * The retention decision, actually acted on.
 *
 * A selector nothing calls bounds nothing. These prove the sweep deletes what
 * the policy selects, keeps what it protects, and — the part that is easy to get
 * wrong — never deletes an activity out from under whoever is using it.
 *
 * Everything here goes through the real recorder rather than seeding journals by
 * hand, because what a sweep is offered comes from the retention record, and the
 * record is only written by the path a live turn actually takes.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { sweepConversationActivities } from '../../services/conversation-activity-sweeper.js'
import {
  releaseConversationActivity,
  reserveConversationActivity,
} from '../../services/conversation-admission-reservation.js'
import {
  recordTerminalActivity,
  selectReclaimableActivities,
} from '../../services/conversation-terminal-ledger.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 15_000
const DIGEST = 'c3'.repeat(32)
const FORTY_DAYS_MS = 40 * 24 * 60 * 60 * 1000

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

/** A turn driven all the way through, the way the product drives one. */
async function completeTurn(input: {
  registry: WorkspaceConversationJournalRegistry
  workspacePath: string
  sessionId: string
  turnId: string
}): Promise<void> {
  const recorder = await resolveConversationTurnJournalRecorder({
    registry: input.registry,
    owner: owner(input.sessionId),
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
  await recorder.recordPrepared({
    assistantMessageIds: [`${input.turnId}:assistant:0`],
  })
  await recorder.recordCompleted({
    assistantMessageIds: [`${input.turnId}:assistant:0`],
  })
  await recorder.release()
}

/** A turn that started and never finished. */
async function startTurn(input: {
  registry: WorkspaceConversationJournalRegistry
  workspacePath: string
  sessionId: string
  turnId: string
}): Promise<void> {
  const recorder = await resolveConversationTurnJournalRecorder({
    registry: input.registry,
    owner: owner(input.sessionId),
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
  await recorder.release()
}

function activityExists(
  workspacePath: string,
  sessionId: string,
  activityId: string,
): boolean {
  return fs.existsSync(
    path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      activityId,
    ),
  )
}

function makeRegistry(workspacePath: string) {
  return new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
}

test(
  'an old finished turn is deleted whole and an unfinished one is kept',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('sweep-old-')
    const registry = makeRegistry(workspacePath)
    try {
      const finished = randomUUID()
      const running = randomUUID()
      await completeTurn({ registry, workspacePath, sessionId, turnId: finished })
      await startTurn({ registry, workspacePath, sessionId, turnId: running })

      const result = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        now: () => Date.now() + FORTY_DAYS_MS,
      })

      assert.deepEqual(result.deleted, [finished])
      assert.equal(activityExists(workspacePath, sessionId, finished), false)
      assert.equal(
        activityExists(workspacePath, sessionId, running),
        true,
        'an unfinished turn is the evidence an operator needs, at any age',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a fresh conversation loses nothing to a sweep',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('sweep-fresh-')
    const registry = makeRegistry(workspacePath)
    try {
      const turnId = randomUUID()
      await completeTurn({ registry, workspacePath, sessionId, turnId })

      const result = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
      })
      assert.deepEqual(result.deleted, [])
      assert.equal(activityExists(workspacePath, sessionId, turnId), true)
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a conversation with no activities sweeps cleanly',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('sweep-empty-')
    const registry = makeRegistry(workspacePath)
    try {
      const result = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
      })
      assert.deepEqual(result.deleted, [])
      assert.equal(result.partial, false)
      assert.equal(result.degraded, undefined)
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'successive sweeps drain the record instead of re-reading its front',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('sweep-drain-')
    const registry = makeRegistry(workspacePath)
    try {
      const ids: string[] = []
      for (let index = 0; index < 6; index += 1) {
        const turnId = randomUUID()
        ids.push(turnId)
        await completeTurn({ registry, workspacePath, sessionId, turnId })
      }

      const later = Date.now() + FORTY_DAYS_MS
      const seen: string[] = []
      for (let pass = 0; pass < 3; pass += 1) {
        const result = await sweepConversationActivities({
          workspacePath,
          owner: owner(sessionId),
          registry,
          now: () => later,
          limit: 2,
        })
        assert.equal(
          result.deleted.length <= 2,
          true,
          `a sweep is housekeeping on a live request and must stay inside its ` +
            `bound; pass ${pass} deleted ${result.deleted.length}`,
        )
        assert.equal(
          result.partial,
          pass < 2,
          'and says plainly whether it left work behind',
        )
        seen.push(...result.deleted)
      }

      assert.deepEqual(
        seen,
        ids,
        'three sweeps of two cover all six, in the order they finished',
      )
      for (const turnId of ids) {
        assert.equal(activityExists(workspacePath, sessionId, turnId), false)
      }
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an activity someone is holding is left where it is',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('sweep-busy-')
    const registry = makeRegistry(workspacePath)
    try {
      const held = randomUUID()
      const free = randomUUID()
      await completeTurn({ registry, workspacePath, sessionId, turnId: held })
      await completeTurn({ registry, workspacePath, sessionId, turnId: free })

      // An operator reading the older activity while housekeeping runs. Deleting
      // it here would pull the files out from under a live handle.
      const reader = await registry.acquire({
        owner: owner(sessionId),
        activityId: held,
        activityKind: 'turn',
      })
      assert.ok(reader)
      try {
        const result = await sweepConversationActivities({
          workspacePath,
          owner: owner(sessionId),
          registry,
          now: () => Date.now() + FORTY_DAYS_MS,
        })
        assert.deepEqual(result.deleted, [], 'the sweep stops at what is in use')
        assert.equal(activityExists(workspacePath, sessionId, held), true)
        assert.equal(
          activityExists(workspacePath, sessionId, free),
          true,
          'and does not skip past it, so the order it forgets in is preserved',
        )
      } finally {
        await reader.release()
      }

      // Once the reader lets go, the same sweep finishes the job.
      const after = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        now: () => Date.now() + FORTY_DAYS_MS,
      })
      assert.deepEqual(after.deleted, [held, free])
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a record naming a turn that never finished does not get it deleted',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('sweep-lying-')
    const registry = makeRegistry(workspacePath)
    try {
      const running = randomUUID()
      await startTurn({ registry, workspacePath, sessionId, turnId: running })

      // The record is a projection and can be wrong. The journal is the
      // authority, so a name on the list is re-checked before anything is
      // forgotten — otherwise a damaged record becomes a licence to delete live
      // evidence.
      assert.equal(
        await recordTerminalActivity({
          workspacePath,
          owner: owner(sessionId),
          activityId: running,
          atMs: 1_000,
        }),
        'recorded',
      )

      // A genuinely finished turn behind it. The sweep must not reach past the
      // bad entry to get to this one: stepping over it would advance the front
      // past an activity nothing ever deleted, stranding it with no record that
      // it is still there.
      const finished = randomUUID()
      await completeTurn({ registry, workspacePath, sessionId, turnId: finished })

      const result = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        now: () => Date.now() + FORTY_DAYS_MS,
      })
      assert.deepEqual(
        result.deleted,
        [],
        'the sweep stops at the entry it cannot confirm, rather than skipping it',
      )
      assert.equal(
        activityExists(workspacePath, sessionId, running),
        true,
        'the journal, not the record, decides what is finished',
      )
      assert.equal(
        activityExists(workspacePath, sessionId, finished),
        true,
        'and what was behind it is still reachable next time',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'the oldest turn goes first, whatever order the record learned about them',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('sweep-order-')
    const registry = makeRegistry(workspacePath)
    try {
      // A turn recovered after a crash is projected late and finished early.
      // The order the record learned about turns is therefore not the order
      // they ended in, and a cap that reclaims by insertion order deletes the
      // newest history while keeping the oldest — the opposite of what it is
      // for.
      const older = randomUUID()
      const newer = randomUUID()
      const olderAt = Date.parse('2026-02-01T00:00:00.000Z')
      const newerAt = Date.parse('2026-05-01T00:00:00.000Z')

      // `newer` finished later but is recorded first.
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId: newer,
          })
        ).kind,
        'reserved',
      )
      await releaseConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: newer,
        terminalAtMs: newerAt,
      })
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId: older,
          })
        ).kind,
        'reserved',
      )
      await releaseConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: older,
        terminalAtMs: olderAt,
      })

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => newerAt + 1_000,
        retentionMs: Number.MAX_SAFE_INTEGER,
        maxTerminalActivities: 1,
      })
      assert.deepEqual(
        selection.candidates.map((entry) => entry.activityId),
        [older],
        'the cap reclaims by when a turn ended, not by when it was written down',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
