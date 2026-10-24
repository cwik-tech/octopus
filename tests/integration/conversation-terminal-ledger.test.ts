/**
 * Retention needs to see the whole conversation without reading it.
 *
 * The count cap is a per-conversation limit, and a sweep that only looks at a
 * window of activities cannot enforce one: the excess may sit entirely outside
 * whatever the window happened to cover. Listing the directory instead makes
 * the newest turn pay for every turn before it, which is the growth per-activity
 * journals exist to avoid — and a directory listing is unbounded raw work in a
 * place a caller can influence.
 *
 * So terminals are written down as they happen, in the order they happen, and
 * retention reads the front of that record. The whole count is one small number;
 * the oldest are wherever the front is. Both are bounded whatever the history.
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { CONVERSATION_MAX_TERMINAL_ACTIVITIES } from '../../domains/conversations/conversation-turn-retention-policy.js'
import {
  releaseConversationActivity,
  reserveConversationActivity,
} from '../../services/conversation-admission-reservation.js'
import {
  commitReclaimedActivities,
  EMPTY_RETENTION_DOCUMENT,
  MAX_TURN_ID_LENGTH,
  readRetentionDocument,
  recordTerminalActivity,
  selectReclaimableActivities,
  writeRetentionDocument,
} from '../../services/conversation-terminal-ledger.js'

const CASE_TIMEOUT_MS = 15_000

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(
    path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    ),
    { recursive: true },
  )
  return { directory, workspacePath, sessionId }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

/**
 * Put many finished turns into the record at once.
 *
 * Driving hundreds of turns one locked write at a time costs seconds and proves
 * nothing these tests are about. The record is a document, so a fixture writes
 * the document — the same shape production writes, through the same writer.
 */
async function bulkRetain(input: {
  readonly workspacePath: string
  readonly sessionId: string
  readonly count: number
  readonly firstAtMs: number
}): Promise<readonly string[]> {
  const ids = Array.from({ length: input.count }, () => randomUUID()).sort()
  await writeRetentionDocument(ledgerRoot(input.workspacePath, input.sessionId), {
    openTurnIds: new Set(),
    retained: ids.map((activityId, index) => ({
      activityId,
      atMs: input.firstAtMs + index,
    })),
    reconcileCursor: 0,
  })
  return ids
}

const ledgerRoot = (workspacePath: string, sessionId: string) =>
  path.join(workspacePath, 'sessions', sessionId, CONVERSATION_ACTIVITIES_DIRECTORY_NAME)


test(
  'a conversation that has finished nothing offers nothing',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-empty-')
    try {
      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 1_000,
      })
      assert.equal(selection.liveCount, 0)
      assert.deepEqual(selection.candidates, [])
      assert.equal(selection.degraded, undefined)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'the oldest finished turns are offered first',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-order-')
    try {
      const ids = [randomUUID(), randomUUID(), randomUUID()]
      for (const [index, activityId] of ids.entries()) {
        await recordTerminalActivity({
          workspacePath,
          owner: owner(sessionId),
          activityId,
          atMs: 1_000 + index,
        })
      }

      // Cap of one: two must go, and they are the two written first — not the
      // two that sort first, which for uuids is a different pair.
      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 1_010,
        maxTerminalActivities: 1,
      })
      assert.equal(selection.liveCount, 3)
      assert.deepEqual(
        selection.candidates.map((entry) => entry.activityId),
        [ids[0], ids[1]],
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a conversation inside both limits is left entirely alone',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-quiet-')
    try {
      for (let index = 0; index < 3; index += 1) {
        await recordTerminalActivity({
          workspacePath,
          owner: owner(sessionId),
          activityId: randomUUID(),
          atMs: 1_000 + index,
        })
      }
      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 1_010,
        maxTerminalActivities: 10,
        retentionMs: 1_000_000,
      })
      assert.equal(selection.liveCount, 3)
      assert.deepEqual(selection.candidates, [])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a turn older than the retention window is offered even well under the cap',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-age-')
    try {
      const old = randomUUID()
      const recent = randomUUID()
      await recordTerminalActivity({
        workspacePath,
        owner: owner(sessionId),
        activityId: old,
        atMs: 0,
      })
      await recordTerminalActivity({
        workspacePath,
        owner: owner(sessionId),
        activityId: recent,
        atMs: 9_000,
      })

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 10_000,
        retentionMs: 5_000,
        maxTerminalActivities: 10_000,
      })
      assert.deepEqual(
        selection.candidates.map((entry) => entry.activityId),
        [old],
        'age reclaims the front and stops at the first turn still inside the window',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'the cap is measured across the whole conversation while the work stays bounded',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-cap-')
    try {
      const ids = await bulkRetain({
        workspacePath,
        sessionId,
        count: 600,
        firstAtMs: 1_000,
      })

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 2_000,
        maxTerminalActivities: 500,
        retentionMs: 1_000_000,
        limit: 32,
      })
      assert.equal(
        selection.liveCount,
        600,
        'the count is the conversation, not the window',
      )
      assert.equal(
        selection.candidates.length,
        32,
        'and one turn only ever pays for a bounded slice of it',
      )
      assert.deepEqual(
        selection.candidates.map((entry) => entry.activityId),
        ids.slice(0, 32),
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'committing advances past exactly what was dealt with',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-commit-')
    try {
      const ids: string[] = []
      for (let index = 0; index < 5; index += 1) {
        const activityId = randomUUID()
        ids.push(activityId)
        await recordTerminalActivity({
          workspacePath,
          owner: owner(sessionId),
          activityId,
          atMs: 1_000 + index,
        })
      }

      const first = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 2_000,
        maxTerminalActivities: 0,
      })
      assert.equal(first.candidates.length, 5)

      // Two were handled; the third refused, so the front stops there.
      await commitReclaimedActivities({
        workspacePath,
        owner: owner(sessionId),
        reclaimedIds: ids.slice(0, 2),
      })

      const second = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 2_000,
        maxTerminalActivities: 0,
      })
      assert.equal(second.liveCount, 3, 'what was reclaimed no longer counts')
      assert.deepEqual(
        second.candidates.map((entry) => entry.activityId),
        ids.slice(2),
        'and the next pass resumes rather than re-reading the front',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a record that is a link is refused rather than followed',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-link-')
    try {
      const outside = path.join(directory, 'elsewhere.log')
      fs.writeFileSync(outside, `${JSON.stringify({ id: 'planted', atMs: 0 })}\n`, 'utf8')
      fs.symlinkSync(
        outside,
        path.join(ledgerRoot(workspacePath, sessionId), '.unresolved.json'),
      )

      // A link here must not turn this conversation's record into an append
      // into someone else's file, nor let that file name what gets deleted.
      const before = fs.readFileSync(outside, 'utf8')
      assert.equal(
        await recordTerminalActivity({
          workspacePath,
          owner: owner(sessionId),
          activityId: randomUUID(),
          atMs: 1_000,
        }),
        'unavailable',
      )
      assert.equal(
        fs.readFileSync(outside, 'utf8'),
        before,
        'the file the link pointed at is untouched',
      )

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 10_000,
        maxTerminalActivities: 0,
      })
      assert.deepEqual(
        selection.candidates,
        [],
        'nothing outside this conversation gets to name what it deletes',
      )
      assert.equal(selection.liveCount, 0, 'and the refused write recorded nothing')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a turn that finishes twice is projected once',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-duplicate-')
    try {
      const turnId = randomUUID()
      // A replay of a turn that already finished re-runs the release path. The
      // projection has to absorb that, or a retried turn inflates the count and
      // the cap starts deleting history that is not really over the limit.
      const reservation = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId,
      })
      assert.equal(reservation.kind, 'reserved')

      await releaseConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId,
        terminalAtMs: 1_000,
      })
      await releaseConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId,
        terminalAtMs: 1_005,
      })

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 2_000,
        maxTerminalActivities: 0,
      })
      assert.equal(selection.liveCount, 1)
      assert.deepEqual(
        selection.candidates.map((entry) => entry.activityId),
        [turnId],
      )
      assert.equal(selection.degraded, undefined)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a replay long after the turn finished is still projected only once',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-late-replay-')
    try {
      // Idempotency that only reaches back a fixed number of turns is not
      // idempotency: a conversation simply has to run past the window before a
      // replay double-counts, and the count cap then deletes real history.
      //
      // And a replay does not arrive as a bare second release. It re-enters
      // through the resolver, which reserves the turn id again before anything
      // else — so the open set is holding that id when the release runs, and
      // "is it still open?" cannot be the thing that makes this exactly-once.
      const turnId = randomUUID()
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId,
          })
        ).kind,
        'reserved',
      )
      await releaseConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId,
        terminalAtMs: 1_000,
      })

      await bulkRetain({
        workspacePath,
        sessionId,
        count: 600,
        firstAtMs: 2_000,
      })

      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId,
          })
        ).kind,
        'reserved',
        'the replay takes the slot again, exactly as the resolver does',
      )
      await releaseConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId,
        terminalAtMs: 900_000,
      })

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 1_000_000,
        maxTerminalActivities: 0,
        limit: 1_000,
      })
      assert.equal(
        selection.liveCount,
        601,
        'the replay added nothing, however long ago the turn finished',
      )
      assert.equal(
        selection.candidates.filter((entry) => entry.activityId === turnId).length,
        1,
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a projected turn is forgotten only once it has been reclaimed',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-projected-life-')
    const root = ledgerRoot(workspacePath, sessionId)
    try {
      const turnId = randomUUID()
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId,
          })
        ).kind,
        'reserved',
      )
      await releaseConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId,
        terminalAtMs: 1_000,
      })

      const held = await readRetentionDocument(root)
      assert.notEqual(held, 'damaged')
      assert.equal(
        held === 'damaged'
          ? false
          : held.retained.some((entry) => entry.activityId === turnId),
        true,
        'the fact that it was projected outlives the slot it was projected from',
      )

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 2_000,
        maxTerminalActivities: 0,
      })
      assert.equal(selection.candidates.length, 1)
      await commitReclaimedActivities({
        workspacePath,
        owner: owner(sessionId),
        reclaimedIds: [turnId],
      })

      const after = await readRetentionDocument(root)
      assert.notEqual(after, 'damaged')
      assert.equal(
        after === 'damaged'
          ? true
          : after.retained.some((entry) => entry.activityId === turnId),
        false,
        'and is dropped once the entry it describes has been reclaimed',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'turns finishing at the same moment are all counted, exactly once each',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-concurrent-')
    try {
      const ids = Array.from({ length: 12 }, () => randomUUID())
      // Issued together on purpose: a read-modify-write that is not serialised
      // loses records here, and a lost record is a conversation that never
      // reaches its cap.
      await Promise.all(
        ids.map((activityId, index) =>
          recordTerminalActivity({
            workspacePath,
            owner: owner(sessionId),
            activityId,
            atMs: 1_000 + index,
          }),
        ),
      )

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 2_000,
        maxTerminalActivities: 0,
        limit: 100,
      })
      assert.equal(selection.liveCount, ids.length)
      assert.deepEqual(
        [...selection.candidates.map((entry) => entry.activityId)].sort(),
        [...ids].sort(),
      )
      assert.equal(selection.degraded, undefined)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a conversation holding a full cap of finished turns still reads exactly',
  { timeout: 120_000 },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-at-cap-')
    const root = ledgerRoot(workspacePath, sessionId)
    try {
      // The bound that matters is the one the policy actually allows. If the
      // record cannot hold a full cap of projected ids, exact membership stops
      // at some number below the cap and a replay past it double-counts — which
      // is the failure this whole structure exists to prevent, arriving only
      // for the conversations big enough to hit it.
      // Ids of the shape the contract admits, and a full cap of them. An
      // activity is named by a uuid — the same identity the path resolver,
      // discovery and the operator report use — so that is the population this
      // record has to hold exactly. `MAX_TURN_ID_LENGTH` stays the ceiling
      // `MAX_DOCUMENT_BYTES` is computed from, comfortably above it.
      const ids = Array.from({ length: CONVERSATION_MAX_TERMINAL_ACTIVITIES }, () =>
        randomUUID(),
      )
      assert.ok(
        (ids[0]?.length ?? 0) <= MAX_TURN_ID_LENGTH,
        'the document bound still covers every id the contract admits',
      )
      await writeRetentionDocument(root, {
        openTurnIds: new Set(),
        retained: ids.map((activityId, index) => ({
          activityId,
          atMs: 1_000 + index,
        })),
        reconcileCursor: 0,
      })

      const stored = await readRetentionDocument(root)
      assert.notEqual(stored, 'damaged', 'a full cap is inside the record bound')
      assert.equal(
        stored === 'damaged' ? 0 : stored.retained.length,
        CONVERSATION_MAX_TERMINAL_ACTIVITIES,
        'and every retained terminal is still named exactly',
      )

      // A replay of the very first turn, from the far end of a full cap.
      const replayed = ids[0] as string
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId: replayed,
          })
        ).kind,
        'reserved',
      )
      await releaseConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: replayed,
        terminalAtMs: 900_000,
      })

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 1_000_000,
        maxTerminalActivities: CONVERSATION_MAX_TERMINAL_ACTIVITIES,
        retentionMs: 1_000_000_000,
      })
      assert.equal(
        selection.liveCount,
        CONVERSATION_MAX_TERMINAL_ACTIVITIES,
        'the replay added nothing at the cap either',
      )
      assert.equal(selection.degraded, undefined)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a record naming something that is not an activity is damaged, not trusted',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // Every count retention makes — the unresolved cap, the retained cap, the
    // reclaim order — is a count of the names in this document. A record that
    // accepts any short word can be handed names no activity ever had, and
    // then the cap that protects a conversation is measuring something else.
    // The same identity the path resolver, discovery and the operator report
    // use has to be the one this record holds.
    const { directory, workspacePath, sessionId } = makeWorkspace('ledger-identity-')
    const root = ledgerRoot(workspacePath, sessionId)
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      await assert.rejects(
        writeRetentionDocument(root, {
          openTurnIds: new Set(['notes']),
          retained: [],
          reconcileCursor: 0,
        }),
        /canonical activity id/,
        'the writer must not create a document its reader immediately rejects',
      )
      await assert.rejects(
        writeRetentionDocument(root, {
          openTurnIds: new Set(),
          retained: [{ activityId: 'backup', atMs: 1_000 }],
          reconcileCursor: 0,
        }),
        /canonical activity id/,
        'the terminal projection has the same identity boundary as open turns',
      )
      assert.deepEqual(
        await readRetentionDocument(root),
        EMPTY_RETENTION_DOCUMENT,
        'refused values leave no damaged authority document behind',
      )

      fs.writeFileSync(
        path.join(root, '.unresolved.json'),
        JSON.stringify({ turnIds: ['notes'], retained: [], reconcileCursor: 0 }),
        { encoding: 'utf8', mode: 0o600 },
      )
      assert.equal(
        await readRetentionDocument(root),
        'damaged',
        'an open slot held by something that is not an activity is not a count',
      )

      fs.writeFileSync(
        path.join(root, '.unresolved.json'),
        JSON.stringify({
          turnIds: [],
          retained: [{ id: 'backup', atMs: 1_000 }],
          reconcileCursor: 0,
        }),
        { encoding: 'utf8', mode: 0o600 },
      )
      assert.equal(
        await readRetentionDocument(root),
        'damaged',
        'a finished turn that is not an activity is not a finished turn',
      )

      assert.equal(
        await recordTerminalActivity({
          workspacePath,
          owner: owner(sessionId),
          activityId: 'drafts',
          atMs: 2_000,
        }),
        'unavailable',
        'and nothing that is not an activity can be written into the record',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
