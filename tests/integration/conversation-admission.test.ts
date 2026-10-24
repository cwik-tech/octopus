/**
 * Admission is authority, and authority fails closed.
 *
 * Deletion may fail open — an old activity that survives one pass costs
 * nothing. A limit decided from whatever a sweep happened to look at is not a
 * limit: a hundred open turns spread outside the window, or a restart that
 * reset its cursor, would both admit work the plan says to refuse. So the count
 * comes from a record of the open set rather than from a sample of the
 * conversation, and a count that cannot be established refuses rather than
 * guessing.
 *
 * These drive the reservation itself, because taking a slot and checking for
 * one are the same locked step. Anything that counts first and claims second
 * lets two turns step over the last slot together.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import {
  reconcileConversationReservations,
  reserveConversationActivity,
} from '../../services/conversation-admission-reservation.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 5_000

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

const activitiesRoot = (workspacePath: string, sessionId: string) =>
  path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )

function makeRegistry(workspacePath: string) {
  return new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
}

test(
  'the count is the conversation’s, not a window’s',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('admission-count-')
    try {
      // Four open turns against a cap of four. Nothing here samples anything:
      // the fifth is refused because the record says there are already four,
      // however they are spread across the conversation.
      const held: string[] = []
      for (let index = 0; index < 4; index += 1) {
        const turnId = randomUUID()
        held.push(turnId)
        const outcome = await reserveConversationActivity({
          workspacePath,
          owner: owner(sessionId),
          turnId,
          maxUnresolved: 4,
        })
        assert.equal(outcome.kind, 'reserved')
        assert.equal(outcome.kind === 'reserved' ? outcome.unresolvedCount : -1, index + 1)
      }

      const refused = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
        maxUnresolved: 4,
      })
      assert.equal(refused.kind, 'refused')
      assert.equal(refused.kind === 'refused' ? refused.unresolvedCount : -1, 4)

      // And a turn already holding a slot keeps the one it has rather than
      // consuming a second, so a retry is not a way past the cap.
      const retried = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: held[0] as string,
        maxUnresolved: 4,
      })
      assert.equal(retried.kind, 'reserved')
      assert.equal(retried.kind === 'reserved' ? retried.unresolvedCount : -1, 4)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'admission refuses when the count cannot be established',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('admission-lost-')
    const registry = makeRegistry(workspacePath)
    try {
      // An activity exists and the record that would count it is gone. Rebuilding
      // the count by reading every journal is the unbounded cost this design
      // exists to avoid, and guessing zero would admit work without limit.
      const existing = randomUUID()
      const lease = await registry.acquire({
        owner: owner(sessionId),
        activityId: existing,
        activityKind: 'turn',
      })
      assert.ok(lease)
      await lease.release()
      fs.rmSync(path.join(activitiesRoot(workspacePath, sessionId), '.unresolved.json'), {
        force: true,
      })

      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
      })
      assert.equal(outcome.kind, 'indeterminate')
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a record that cannot be read refuses rather than reading as empty',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('admission-damaged-')
    try {
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId: randomUUID(),
          })
        ).kind,
        'reserved',
      )
      fs.writeFileSync(
        path.join(activitiesRoot(workspacePath, sessionId), '.unresolved.json'),
        '{ this is not json',
        'utf8',
      )

      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
      })
      assert.equal(
        outcome.kind,
        'indeterminate',
        'absent and damaged are different facts, and only one is safe to read as zero',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a healthy conversation is admitted',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('admission-healthy-')
    try {
      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
      })
      assert.equal(outcome.kind, 'reserved')
      assert.equal(outcome.kind === 'reserved' ? outcome.unresolvedCount : -1, 1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'admission refuses a turn id that is not a canonical activity identity',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace(
      'admission-invalid-identity-',
    )
    try {
      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: 'notes',
      })
      assert.equal(outcome.kind, 'indeterminate')
      assert.equal(
        fs.existsSync(activitiesRoot(workspacePath, sessionId)),
        false,
        'invalid input must be rejected before creating the activity root',
      )
      assert.equal(
        fs.existsSync(
          path.join(activitiesRoot(workspacePath, sessionId), '.unresolved.json'),
        ),
        false,
        'invalid input must be rejected before creating an authority document',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a slot taken for a turn that never existed is given back',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('admission-stale-')
    const registry = makeRegistry(workspacePath)
    try {
      // The crash window between taking a slot and opening the activity. The
      // slot is held — correctly, because nothing yet proves the turn is not
      // about to start — and reconciliation is what proves it and returns it.
      const stranded = randomUUID()
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId: stranded,
            maxUnresolved: 1,
          })
        ).kind,
        'reserved',
      )
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId: randomUUID(),
            maxUnresolved: 1,
          })
        ).kind,
        'refused',
        'until then the cap holds, because a held slot is a held slot',
      )

      const result = await reconcileConversationReservations({
        workspacePath,
        owner: owner(sessionId),
        registry,
      })
      assert.deepEqual(result.released, [stranded])
      assert.deepEqual(result.projected, [], 'nothing finished, so nothing is recorded')

      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId: randomUUID(),
            maxUnresolved: 1,
          })
        ).kind,
        'reserved',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
