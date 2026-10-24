/**
 * The retention record is authority, so it has to be bounded and coherent.
 *
 * Three ways it stopped being either, all of which end with a conversation that
 * cannot be read at all:
 *
 * The projection set is what makes counting a finished turn exactly-once, and it
 * is sized to the retention cap. Nothing stopped it growing past that. Sweeping
 * is best-effort by design, so a conversation whose deletions keep failing kept
 * adding names to a set with a hard bound — and the first write past the bound
 * produces a document the next reader classifies as damaged. The cap is not the
 * thing to relax there: the writer has to refuse, and admission has to stop
 * taking work while the pressure is real.
 *
 * And the record is a projection, so its timestamps are a hint. Deleting on one
 * without checking the journal means a stale or tampered entry can remove a turn
 * that finished a minute ago.
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { CONVERSATION_MAX_PROJECTED_IDS } from '../../domains/conversations/conversation-turn-retention-policy.js'
import { reserveConversationActivity } from '../../services/conversation-admission-reservation.js'
import { sweepConversationActivities } from '../../services/conversation-activity-sweeper.js'
import { selectReclaimableActivities } from '../../services/conversation-terminal-ledger.js'
import {
  readRetentionDocument,
  recordTerminalActivity,
  writeRetentionDocument,
} from '../../services/conversation-terminal-ledger.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { writeBulkTerminalActivities } from '../support/bulk-conversation-activities.js'

const CASE_TIMEOUT_MS = 30_000

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  const root = path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )

  fs.mkdirSync(root, { recursive: true })
  return { directory, workspacePath, sessionId, root }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

function ids(count: number, from = 0): string[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      `00000000-0000-4000-8000-${String(from + index).padStart(12, '0')}`,
  )
}

function documentOf(overrides: {
  openTurnIds?: Set<string>
  retained?: { activityId: string; atMs: number }[]
}) {
  return {
    openTurnIds: overrides.openTurnIds ?? new Set<string>(),
    retained: overrides.retained ?? [],
    reconcileCursor: 0,
  }
}

test(
  'a record is refused before it grows past what it can name exactly',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, root } = makeWorkspace('bounded-write-')
    try {
      // Writing this would produce a document the next reader has to call
      // damaged, and a damaged record is one that stops projecting exactly —
      // so the failure arrives later, somewhere else, as a lost count.
      await assert.rejects(
        writeRetentionDocument(
          root,
          documentOf({
            retained: ids(CONVERSATION_MAX_PROJECTED_IDS + 1).map((id, index) => ({
              activityId: id,
              atMs: 1_000 + index,
            })),
          }),
        ),
        'the writer refuses rather than producing a record nobody can read',
      )
      assert.equal(
        fs.existsSync(path.join(root, '.unresolved.json')),
        false,
        'and nothing was left behind',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'projecting one more than the record can name is refused, not written',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId, root } = makeWorkspace('bounded-project-')
    try {
      const full = ids(CONVERSATION_MAX_PROJECTED_IDS)
      await writeRetentionDocument(
        root,
        documentOf({
          retained: full.map((id, index) => ({ activityId: id, atMs: 1_000 + index })),
        }),
      )

      assert.equal(
        await recordTerminalActivity({
          workspacePath,
          owner: owner(sessionId),
          activityId: randomUUID(),
          atMs: 2_000,
        }),
        'unavailable',
        'a full record refuses the next ending rather than overflowing',
      )
      const after = await readRetentionDocument(root)
      assert.notEqual(after, 'damaged')
      assert.equal(
        after === 'damaged' ? -1 : after.retained.length,
        full.length,
        'and the record is unchanged and still readable',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a conversation under retained pressure stops taking work',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId, root } = makeWorkspace('bounded-admit-')
    try {
      // Sweeping is best-effort: it may have had its chance and got nowhere.
      // Admission is not best-effort, and taking another turn here guarantees a
      // projection that cannot be written.
      const full = ids(CONVERSATION_MAX_PROJECTED_IDS)
      await writeRetentionDocument(
        root,
        documentOf({
          retained: full.map((id, index) => ({ activityId: id, atMs: 1_000 + index })),
        }),
      )

      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
      })
      assert.notEqual(
        outcome.kind,
        'reserved',
        'a conversation that cannot record another ending must not start one',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a record whose numbers contradict each other is damage, not data',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, root } = makeWorkspace('bounded-invariants-')
    const documentPath = path.join(root, '.unresolved.json')
    try {
      const contradictions: readonly [string, Record<string, unknown>][] = [
        ['the same turn open twice', { turnIds: ['a-turn', 'a-turn'] }],
        [
          'the same turn kept twice',
          {
            retained: [
              { id: 'a-turn', atMs: 1 },
              { id: 'a-turn', atMs: 2 },
            ],
          },
        ],
        [
          'kept turns out of the order they ended in',
          {
            retained: [
              { id: 'b-turn', atMs: 9 },
              { id: 'a-turn', atMs: 1 },
            ],
          },
        ],
        [
          'an ending with no time',
          { retained: [{ id: 'a-turn' }] },
        ],
        [
          'an ending with no turn',
          { retained: [{ atMs: 1 }] },
        ],
      ]
      for (const [why, fields] of contradictions) {
        fs.writeFileSync(
          documentPath,
          JSON.stringify({
            turnIds: [],
            retained: [],
            reconcileCursor: 0,
            ...fields,
          }),
          'utf8',
        )
        assert.equal(
          await readRetentionDocument(root),
          'damaged',
          `'${why}' was read as a usable record`,
        )
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a stale entry cannot delete a turn that only just finished',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId, root } = makeWorkspace('bounded-stale-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // The journal says this turn finished a moment ago. The record says it
      // finished a year ago. The record is a projection — a hint about where to
      // look — and the journal is the authority, so the hint does not get to
      // decide that recent history is expendable.
      const recent = Date.parse('2026-08-26T12:00:00.000Z')
      const written = writeBulkTerminalActivities({
        workspacePath,
        sessionId,
        tenantId: 'local',
        count: 1,
        firstTerminalAtMs: recent,
      })
      const activityId = written[0]?.activityId ?? ''
      const stale = Date.parse('2025-01-01T00:00:00.000Z')
      await writeRetentionDocument(
        root,
        documentOf({ retained: [{ activityId, atMs: stale }] }),
      )

      const result = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        // Well past the window measured from the record, nowhere near it
        // measured from the journal.
        now: () => recent + 60_000,
      })
      assert.deepEqual(
        result.deleted,
        [],
        'the journal decides whether a turn is old enough to forget',
      )
      assert.equal(
        fs.existsSync(path.join(root, activityId)),
        true,
        'and the activity is still there',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'open turns count towards the room the record has left',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId, root } = makeWorkspace('bounded-open-')
    try {
      // Every open turn is an ending this record has already promised to make
      // room for. Counting only what is finished means the last few slots get
      // handed out twice.
      const kept = ids(CONVERSATION_MAX_PROJECTED_IDS - 2)
      await writeRetentionDocument(
        root,
        documentOf({
          openTurnIds: new Set(ids(2, 900_000)),
          retained: kept.map((id, index) => ({ activityId: id, atMs: 1_000 + index })),
        }),
      )

      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
      })
      assert.notEqual(
        outcome.kind,
        'reserved',
        'the two turns already running have the last two endings spoken for',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'an aged turn reclaimed also relieves the pressure the cap was under',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId, root } = makeWorkspace('bounded-pressure-')
    try {
      // Twelve kept against a cap of ten, and the two oldest are past the
      // window. Two deletions bring the conversation back to its cap — counting
      // age and volume separately reclaims those two *and* two more that are
      // neither old nor excess.
      const kept = ids(12)
      await writeRetentionDocument(root, {
        openTurnIds: new Set(),
        retained: kept.map((id, index) => ({ activityId: id, atMs: 1_000 + index })),
        reconcileCursor: 0,
      })

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        // Only the first two are past the window.
        now: () => 1_001 + 5_000,
        retentionMs: 5_000,
        maxTerminalActivities: 10,
      })
      assert.deepEqual(
        selection.candidates.map((entry) => entry.activityId),
        kept.slice(0, 2),
        'two deletions is what the conversation needs; the rest are neither ' +
          'old nor excess',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a conversation with nothing to reclaim does not report unfinished work',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId, root } = makeWorkspace('bounded-partial-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // One recent turn, comfortably inside both limits. `partial` says a sweep
      // left work behind, and a caller that believes it will keep coming back
      // for work that does not exist.
      const kept = ids(1)[0] as string
      await writeRetentionDocument(root, {
        openTurnIds: new Set(),
        retained: [{ activityId: kept, atMs: 1_000 }],
        reconcileCursor: 0,
      })

      const result = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        now: () => 2_000,
        retentionMs: 1_000_000,
        maxTerminalActivities: 100,
      })
      assert.deepEqual(result.deleted, [])
      assert.equal(
        result.partial,
        false,
        'nothing was reclaimable, so nothing was left behind',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an activity-shaped name that is not a directory is evidence, not absence',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId, root } = makeWorkspace('bounded-shaped-')
    try {
      // No retention document, and something activity-shaped on disk. Reading
      // that as an empty conversation hands it a fresh count and admits work
      // without limit — which is the fail-open the missing-document rule exists
      // to prevent.
      fs.symlinkSync(
        path.join(directory, 'elsewhere'),
        path.join(root, ids(1, 7)[0] as string),
      )

      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
      })
      assert.equal(
        outcome.kind,
        'indeterminate',
        'something shaped like an activity is not nothing',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a sweep that deleted activities it could not record does not report success',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // The two halves of retention are the activities on disk and the record
    // that lists them. Deleting the first and failing to update the second is
    // not a delay that costs one repeated pass: the record now describes a
    // conversation that is not there, and every later reader trusts it. A
    // sweep that returns cleanly over that tells its caller the work is done.
    const { directory, workspacePath, sessionId, root } = makeWorkspace('retention-commit-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const long_ago = Date.parse('2026-01-01T00:00:00.000Z')
      const written = writeBulkTerminalActivities({
        workspacePath,
        sessionId,
        tenantId: 'local',
        count: 1,
        firstTerminalAtMs: long_ago,
      })
      const activityId = written[0]?.activityId ?? ''
      await writeRetentionDocument(root, {
        openTurnIds: new Set(),
        retained: [{ activityId, atMs: long_ago }],
        reconcileCursor: 0,
      })

      // A directory where the record's replacement file has to be created.
      // Nothing can write the record after this, and the sweep still deletes.
      fs.mkdirSync(path.join(root, '.unresolved.json.tmp'))

      await assert.rejects(
        sweepConversationActivities({
          workspacePath,
          owner: owner(sessionId),
          registry,
          limit: 8,
        }),
        'a sweep whose record write failed has not finished its work',
      )

      // Both halves observed: the activity really is gone, and the record
      // really does still claim it — which is why silence here is wrong.
      assert.equal(
        fs.existsSync(path.join(root, activityId)),
        false,
        'the activity was deleted',
      )
      const stored = await readRetentionDocument(root)
      assert.notEqual(stored, 'damaged')
      assert.deepEqual(
        stored === 'damaged' ? [] : stored.retained.map((entry) => entry.activityId),
        [activityId],
        'and the record still lists it',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a sweep that reached everything reclaimable does not ask to be run again',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // `partial` sends the caller back for more work. Deciding it by comparing
    // the page size to the whole conversation says "more" whenever the page was
    // full — even when everything left is a turn inside both limits, which no
    // number of further sweeps will ever reclaim. The record is what knows
    // whether another one would find anything.
    const { directory, workspacePath, sessionId, root } = makeWorkspace('retention-partial-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const now = Date.parse('2026-08-27T00:00:00.000Z')
      const retentionMs = 60_000
      const long_ago = now - 10 * retentionMs
      const written = writeBulkTerminalActivities({
        workspacePath,
        sessionId,
        tenantId: 'local',
        count: 4,
        firstTerminalAtMs: long_ago,
      })
      const ids = written.map((entry) => entry.activityId)
      assert.equal(ids.length, 4)
      // Two old enough to reclaim, then two that finished a moment ago. A page
      // of two takes exactly the two that qualify.
      await writeRetentionDocument(root, {
        openTurnIds: new Set(),
        retained: [
          { activityId: ids[0] ?? '', atMs: long_ago },
          { activityId: ids[1] ?? '', atMs: long_ago + 1 },
          { activityId: ids[2] ?? '', atMs: now - 1 },
          { activityId: ids[3] ?? '', atMs: now },
        ],
        reconcileCursor: 0,
      })

      const swept = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        now: () => now,
        retentionMs,
        limit: 2,
      })
      assert.deepEqual([...swept.deleted].sort(), [ids[0], ids[1]].sort())
      assert.equal(
        swept.partial,
        false,
        'everything reclaimable was reclaimed, so another sweep would find nothing',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a sweep that filled its page and left more behind says so',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId, root } = makeWorkspace('retention-more-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const now = Date.parse('2026-08-27T00:00:00.000Z')
      const retentionMs = 60_000
      const long_ago = now - 10 * retentionMs
      const written = writeBulkTerminalActivities({
        workspacePath,
        sessionId,
        tenantId: 'local',
        count: 3,
        firstTerminalAtMs: long_ago,
      })
      const ids = written.map((entry) => entry.activityId)
      await writeRetentionDocument(root, {
        openTurnIds: new Set(),
        retained: ids.map((activityId, index) => ({
          activityId,
          atMs: long_ago + index,
        })),
        reconcileCursor: 0,
      })

      const swept = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        now: () => now,
        retentionMs,
        limit: 2,
      })
      assert.equal(swept.deleted.length, 2)
      assert.equal(
        swept.partial,
        true,
        'a third turn is past the window and was not reached',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
