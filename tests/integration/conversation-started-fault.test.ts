/**
 * A turn that never began must not keep the slot it claimed — and a turn that
 * might have begun must keep it.
 *
 * Admission is taken before the activity is opened, and `started` is the first
 * thing written into it. If the turn dies before that write lands, the slot it
 * took stays held until the abandoned-age sweep notices, thirty days later; a
 * conversation that hits a run of those stops admitting work for a month over
 * turns that never started.
 *
 * But "give it back on any failure" is the wrong rule, and worse than keeping
 * it. Two failures must not release:
 *
 * Another request already claimed `started` for this identity. That request is
 * live and holds the same slot — reservation is idempotent per turn — so giving
 * it back would take it out from under a turn that is still running, and that
 * turn's terminal would find no slot to release and never be projected.
 *
 * And a failure that does not prove the activity is empty. A write that failed
 * ambiguously, or an activity that already holds events, is exactly the state an
 * operator needs left alone: releasing there discards the record of a turn that
 * may well have started.
 *
 * So the rule is evidence, not error handling: release only what a scan proves
 * is empty.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { CONVERSATION_JOURNAL_MAX_EVENTS } from '../../core/execution-journal.js'
import { CONVERSATION_TURN_STREAM_KIND } from '../../domains/conversations/conversation-turn-journal.js'
import { reserveConversationActivity } from '../../services/conversation-admission-reservation.js'
import {
  readRetentionDocument,
  selectReclaimableActivities,
} from '../../services/conversation-terminal-ledger.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 30_000
const DIGEST = 'e6'.repeat(32)

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

const retentionRoot = (workspacePath: string, sessionId: string) =>
  path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )

async function holdsSlot(
  workspacePath: string,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const document = await readRetentionDocument(
    retentionRoot(workspacePath, sessionId),
  )
  assert.notEqual(document, 'damaged')
  return document === 'damaged' ? false : document.openTurnIds.has(turnId)
}

const started = (turnId: string) => ({
  surface: 'run-receptionist',
  userMessageId: `${turnId}:user`,
  requestDigest: DIGEST,
  expectedResponseCount: 1,
  origin: 'client' as const,
})

test(
  'a first write refused by an activity that is not empty keeps the slot',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('started-fault-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const turnId = randomUUID()
      // Taken the way the turn takes it, so the conversation has an admission
      // document and the resolver below finds the slot already held rather than
      // finding activities with no document at all.
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
      // Fill the activity to its hard bound, so the very next append — this
      // turn's `started` — is refused. A real, visible failure before the
      // provider is reached, with nothing to clean up but the slot.
      const seeding = await registry.acquire({
        owner: owner(sessionId),
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.ok(seeding)
      for (let index = 0; index < CONVERSATION_JOURNAL_MAX_EVENTS; index += 1) {
        const outcome: { kind: string } = await seeding.journal.append({
          eventId: `filler-${index}`,
          streamKind: 'conversation.filler',
          streamId: turnId,
          expectedStreamRevision: index,
          type: 'conversation.turn.noted',
          payloadSchemaVersion: 1,
          payload: { index },
          correlationId: turnId,
        })
        assert.equal(outcome.kind, 'appended')
      }
      await seeding.release()

      const recorder = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(recorder)
      assert.equal(
        await holdsSlot(workspacePath, sessionId, turnId),
        true,
        'the slot was taken before the activity was opened',
      )

      await assert.rejects(recorder.recordStarted(started(turnId)))
      await recorder.release()

      assert.equal(
        await holdsSlot(workspacePath, sessionId, turnId),
        true,
        'this activity holds events, so nothing here proves the turn never ran ' +
          'and the slot is not the thing to reclaim',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'losing the race for a turn does not release the winner’s slot',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('started-race-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const turnId = randomUUID()
      const winner = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(winner)
      await winner.recordStarted(started(turnId))

      // A second request for the same identity. It reserved the same slot —
      // reservation is idempotent per turn — so releasing it here would take it
      // out from under the turn that is still running, and that turn's terminal
      // would then find no slot to release and never be projected.
      const loser = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(loser)
      await assert.rejects(loser.recordStarted(started(turnId)))
      await loser.release()

      assert.equal(
        await holdsSlot(workspacePath, sessionId, turnId),
        true,
        'the running turn keeps the slot it is using',
      )

      // And the winner still finishes, projecting through the slot it kept.
      await winner.recordPrepared({ assistantMessageIds: [`${turnId}:assistant:0`] })
      await winner.recordCompleted({ assistantMessageIds: [`${turnId}:assistant:0`] })
      await winner.release()
      assert.equal(await holdsSlot(workspacePath, sessionId, turnId), false)

      const snapshot = await registry.snapshot({
        owner: owner(sessionId),
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.equal(snapshot.kind, 'read')
      const scan = { events: snapshot.kind === 'read' ? snapshot.events : [] }
      assert.deepEqual(
        scan.events.map((event) => event.type),
        [
          'conversation.turn.started',
          'conversation.turn.prepared',
          'conversation.turn.completed',
        ],
        'one started, one turn, one ending',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a turn that fails before it starts, over a provably empty activity, cleans up',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('started-empty-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // The ordinary shape of a turn that dies before the start barrier: the
      // slot is taken, the activity is created, and the request fails on
      // something else entirely. The activity is empty and can be shown to be,
      // so both the directory and the slot go back now rather than in a month.
      const turnId = randomUUID()
      const recorder = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(recorder)
      assert.equal(await holdsSlot(workspacePath, sessionId, turnId), true)

      await recorder.abandon()
      await recorder.release()

      assert.equal(
        await holdsSlot(workspacePath, sessionId, turnId),
        false,
        'a turn that never began does not hold a slot for thirty days',
      )
      assert.equal(
        fs.existsSync(
          path.join(
            workspacePath,
            'sessions',
            sessionId,
            CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
            turnId,
          ),
        ),
        false,
        'and leaves no activity behind either',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'abandoning an activity that holds anything changes nothing',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('started-nonempty-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // A turn that did start, and then something went wrong afterwards. The
      // evidence that it started is the only record there is, and discarding it
      // because a later step failed is how an operator loses the thing they
      // needed most.
      const turnId = randomUUID()
      const recorder = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(recorder)
      await recorder.recordStarted(started(turnId))

      await recorder.abandon()
      await recorder.release()

      assert.equal(
        await holdsSlot(workspacePath, sessionId, turnId),
        true,
        'a turn with a durable start is unresolved work, not litter',
      )
      const activityPath = path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
        turnId,
      )
      assert.equal(fs.existsSync(activityPath), true)

      const snapshot = await registry.snapshot({
        owner: owner(sessionId),
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.equal(snapshot.kind, 'read')
      const scan = { events: snapshot.kind === 'read' ? snapshot.events : [] }
      assert.deepEqual(
        scan.events.map((event) => event.type),
        ['conversation.turn.started'],
        'and its record is exactly as it was',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a duplicate request giving up does not take the live turn’s slot with it',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('started-shared-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // Two requests for the same turn. They share one slot — reservation is
      // idempotent per turn — and the activity is empty until the winner writes
      // to it. If the loser gives up in that window and takes the slot on the
      // way out, the winner's ending has no slot to release and is never
      // recorded.
      const turnId = randomUUID()
      const winner = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(winner)
      const loser = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId,
        workspacePath,
      })
      assert.ok(loser)

      // The loser gives up while the winner is still holding the activity.
      await loser.abandon()
      await loser.release()

      const activityPath = path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
        turnId,
      )
      assert.equal(
        fs.existsSync(activityPath),
        true,
        'the activity the winner is using is still there',
      )
      assert.equal(
        await holdsSlot(workspacePath, sessionId, turnId),
        true,
        'and so is the slot it is running under',
      )

      // And the winner finishes normally, recording its ending through the slot
      // it kept.
      await winner.recordStarted(started(turnId))
      await winner.recordPrepared({ assistantMessageIds: [`${turnId}:assistant:0`] })
      await winner.recordCompleted({ assistantMessageIds: [`${turnId}:assistant:0`] })
      await winner.release()

      assert.equal(await holdsSlot(workspacePath, sessionId, turnId), false)
      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => Date.now() + 1_000,
        maxTerminalActivities: 0,
      })
      assert.deepEqual(
        selection.candidates.map((entry) => entry.activityId),
        [turnId],
        'the winner’s ending was recorded, which is what the slot was for',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
