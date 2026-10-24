/**
 * A crash between the terminal and its projection must heal.
 *
 * `recordCompleted` appends the canonical terminal and then gives the admission
 * slot back. Those are two writes, so there is a window between them, and a
 * process that dies inside it leaves a conversation whose journal says the turn
 * finished while the sidecar retention reads has never heard of it. Left alone
 * that is a permanent leak in both directions: a slot that is never returned,
 * and a finished turn the count cap will never see.
 *
 * The journal is the authority and is never rewritten to fix this. What gets
 * rebuilt is the projection, from the journal, on the next reconciliation — and
 * rebuilding it twice must leave the same answer as rebuilding it once.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  buildConversationTurnCompletedPayload,
  buildConversationTurnPreparedPayload,
  buildConversationTurnStartedPayload,
  conversationTurnEventId,
  CONVERSATION_TURN_COMPLETED_EVENT_TYPE,
  CONVERSATION_TURN_PAYLOAD_SCHEMA_VERSION,
  CONVERSATION_TURN_PREPARED_EVENT_TYPE,
  CONVERSATION_TURN_STARTED_EVENT_TYPE,
  CONVERSATION_TURN_STREAM_KIND,
} from '../../domains/conversations/conversation-turn-journal.js'
import {
  reconcileConversationReservations,
  reserveConversationActivity,
} from '../../services/conversation-admission-reservation.js'
import {
  readRetentionDocument,
  selectReclaimableActivities,
} from '../../services/conversation-terminal-ledger.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 5_000
const DIGEST = 'b4'.repeat(32)

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

/**
 * The durable state a crash between the terminal append and the release leaves:
 * a reservation still held, and a journal that already says the turn finished.
 *
 * Built from the real payload builders and the real registry rather than by
 * planting files, so what is reconciled below is a genuine terminal journal.
 */
async function crashAfterTerminal(input: {
  readonly registry: WorkspaceConversationJournalRegistry
  readonly workspacePath: string
  readonly sessionId: string
  readonly turnId: string
}): Promise<{ readonly terminalAtMs: number }> {
  const reservation = await reserveConversationActivity({
    workspacePath: input.workspacePath,
    owner: owner(input.sessionId),
    turnId: input.turnId,
  })
  assert.equal(reservation.kind, 'reserved')

  const lease = await input.registry.acquire({
    owner: owner(input.sessionId),
    activityId: input.turnId,
    activityKind: 'turn',
  })
  assert.ok(lease)
  try {
    const stages = [
      {
        stage: 'started' as const,
        type: CONVERSATION_TURN_STARTED_EVENT_TYPE,
        payload: buildConversationTurnStartedPayload({
          surface: 'run-receptionist',
          userMessageId: `${input.turnId}:user`,
          requestDigest: DIGEST,
          expectedResponseCount: 1,
          origin: 'client',
        }),
      },
      {
        stage: 'prepared' as const,
        type: CONVERSATION_TURN_PREPARED_EVENT_TYPE,
        payload: buildConversationTurnPreparedPayload({
          assistantMessageIds: [`${input.turnId}:assistant:0`],
        }),
      },
      {
        stage: 'terminal' as const,
        type: CONVERSATION_TURN_COMPLETED_EVENT_TYPE,
        payload: buildConversationTurnCompletedPayload({
          assistantMessageIds: [`${input.turnId}:assistant:0`],
        }),
      },
    ]
    let terminalRecordedAt = ''
    for (const [revision, entry] of stages.entries()) {
      const outcome = await lease.journal.append({
        eventId: conversationTurnEventId(input.turnId, input.turnId, entry.stage),
        streamKind: CONVERSATION_TURN_STREAM_KIND,
        streamId: input.turnId,
        expectedStreamRevision: revision,
        type: entry.type,
        payloadSchemaVersion: CONVERSATION_TURN_PAYLOAD_SCHEMA_VERSION,
        payload: entry.payload,
        correlationId: input.turnId,
      })
      assert.equal(outcome.kind, 'appended')
    }
    const scan = await lease.journal.scanStream(
      CONVERSATION_TURN_STREAM_KIND,
      input.turnId,
    )
    terminalRecordedAt = scan.events[scan.events.length - 1]?.recordedAt ?? ''
    const terminalAtMs = Date.parse(terminalRecordedAt)
    assert.equal(Number.isFinite(terminalAtMs), true)
    return { terminalAtMs }
  } finally {
    // And then the process dies: no release, no projection.
    await lease.release()
  }
}

/** A registry from a later process: nothing of the first one survives. */
function restartRegistry(workspacePath: string) {
  return new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
}

const retentionRoot = (workspacePath: string, sessionId: string) =>
  path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )

/** Reconciliation exactly as a later turn drives it. */
async function reconcile(input: {
  readonly registry: WorkspaceConversationJournalRegistry
  readonly workspacePath: string
  readonly sessionId: string
}) {
  return reconcileConversationReservations({
    workspacePath: input.workspacePath,
    owner: owner(input.sessionId),
    registry: input.registry,
  })
}

test(
  'a terminal that never reached the projection is rebuilt from the journal',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('projection-rebuild-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const turnId = randomUUID()
      const { terminalAtMs } = await crashAfterTerminal({
        registry,
        workspacePath,
        sessionId,
        turnId,
      })
      // The process that wrote it is gone. Everything below is a later one.
      await registry.close()

      // Nothing knows this turn finished except the journal.
      const before = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 5_000,
        maxTerminalActivities: 0,
      })
      assert.equal(before.liveCount, 0, 'the projection missed it')

      const restarted = restartRegistry(workspacePath)
      const first = await reconcile({
        registry: restarted,
        workspacePath,
        sessionId,
      })
      assert.deepEqual(
        first.released,
        [turnId],
        'the slot the crash held is given back',
      )
      assert.deepEqual(first.projected, [turnId])

      const after = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 5_000,
        maxTerminalActivities: 0,
      })
      assert.equal(after.liveCount, 1, 'and the count cap can finally see it')
      assert.deepEqual(
        after.candidates.map((entry) => entry.activityId),
        [turnId],
      )
      // The age it actually has, not the age of having been noticed. A turn
      // recovered after a long outage must not get its retention clock reset.
      assert.equal(
        after.candidates[0]?.atMs,
        terminalAtMs,
        'the projection carries the journal time, not the reconciliation time',
      )
      await restarted.close()
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'rebuilding twice leaves the same answer as rebuilding once',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('projection-twice-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const turnId = randomUUID()
      await crashAfterTerminal({ registry, workspacePath, sessionId, turnId })

      const scanBefore = await (async () => {
        const snapshot = await registry.snapshot({
          owner: owner(sessionId),
          activityId: turnId,
          activityKind: 'turn',
        })
        assert.equal(snapshot.kind, 'read')
        return { events: snapshot.kind === 'read' ? snapshot.events : [] }
      })()

      await reconcile({ registry, workspacePath, sessionId })
      const second = await reconcile({ registry, workspacePath, sessionId })
      assert.deepEqual(second.released, [], 'the slot was already returned')
      assert.deepEqual(second.projected, [], 'and the terminal is already projected')

      const after = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 6_000,
        maxTerminalActivities: 0,
      })
      assert.equal(after.liveCount, 1, 'a second rebuild does not double-count')

      // The journal is the authority and reconciliation is not allowed to touch
      // it: same events, same hashes, in the same order.
      const reread = await registry.snapshot({
        owner: owner(sessionId),
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.equal(reread.kind, 'read')
      {
        const scanAfter = { events: reread.kind === 'read' ? reread.events : [] }
        assert.deepEqual(
          scanAfter.events.map((event) => [event.type, event.eventHash]),
          scanBefore.events.map((event) => [event.type, event.eventHash]),
          'reconciliation reads the journal and never writes to it',
        )
      }
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a turn still running is neither released nor projected',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('projection-live-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const turnId = randomUUID()
      const reservation = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId,
      })
      assert.equal(reservation.kind, 'reserved')

      const lease = await registry.acquire({
        owner: owner(sessionId),
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.ok(lease)
      const outcome = await lease.journal.append({
        eventId: conversationTurnEventId(turnId, turnId, 'started'),
        streamKind: CONVERSATION_TURN_STREAM_KIND,
        streamId: turnId,
        expectedStreamRevision: 0,
        type: CONVERSATION_TURN_STARTED_EVENT_TYPE,
        payloadSchemaVersion: CONVERSATION_TURN_PAYLOAD_SCHEMA_VERSION,
        payload: buildConversationTurnStartedPayload({
          surface: 'run-receptionist',
          userMessageId: `${turnId}:user`,
          requestDigest: DIGEST,
          expectedResponseCount: 1,
          origin: 'client',
        }),
        correlationId: turnId,
      })
      assert.equal(outcome.kind, 'appended')
      await lease.release()

      const result = await reconcile({ registry, workspacePath, sessionId })
      assert.deepEqual(result.released, [], 'a started turn keeps its slot')
      assert.deepEqual(result.projected, [])
      const after = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => 5_000,
        maxTerminalActivities: 0,
      })
      assert.equal(after.liveCount, 0, 'and is never counted as finished')
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a projection that cannot be written keeps the slot as its retry anchor',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('projection-anchor-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const turnId = randomUUID()
      const { terminalAtMs } = await crashAfterTerminal({
        registry,
        workspacePath,
        sessionId,
        turnId,
      })

      // The record cannot be written. Surrendering the slot here would lose the
      // finished turn for good: nothing else remembers it needs recording.
      const root = retentionRoot(workspacePath, sessionId)
      const blocked = path.join(root, '.unresolved.json.tmp')
      fs.rmSync(blocked, { force: true })
      fs.symlinkSync(path.join(directory, 'nowhere'), blocked)

      const blockedPass = await reconcile({ registry, workspacePath, sessionId })
      assert.deepEqual(blockedPass.released, [], 'the slot is not given away')
      assert.deepEqual(blockedPass.projected, [])
      const held = await readRetentionDocument(root)
      assert.notEqual(held, 'damaged')
      assert.equal(
        held === 'damaged' ? false : held.openTurnIds.has(turnId),
        true,
        'the reservation is still the anchor a later pass retries from',
      )

      // Once the record can be written again, the same reconciliation finishes
      // the job it could not finish before.
      fs.rmSync(blocked, { force: true })
      const recovered = await reconcile({ registry, workspacePath, sessionId })
      assert.deepEqual(recovered.released, [turnId])
      assert.deepEqual(recovered.projected, [turnId])
      const after = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => terminalAtMs + 1_000,
        maxTerminalActivities: 0,
      })
      assert.deepEqual(
        after.candidates.map((entry) => entry.activityId),
        [turnId],
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'opening the next turn is what rebuilds the projection in production',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('projection-wiring-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const crashed = randomUUID()
      await crashAfterTerminal({ registry, workspacePath, sessionId, turnId: crashed })
      await registry.close()

      // No direct reconciliation call. The next turn simply opens, the way the
      // product opens one, and that has to be enough — a build where the
      // resolver stopped reconciling would leave the crashed turn invisible
      // forever and nothing else would notice.
      const restarted = restartRegistry(workspacePath)
      const recorder = await resolveConversationTurnJournalRecorder({
        registry: restarted,
        owner: owner(sessionId),
        turnId: randomUUID(),
        workspacePath,
      })
      assert.ok(recorder)
      await recorder.release()

      const after = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => Date.now(),
        maxTerminalActivities: 0,
      })
      assert.deepEqual(
        after.candidates.map((entry) => entry.activityId),
        [crashed],
        'the crashed turn was picked up by the turn that came after it',
      )
      await restarted.close()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a finished turn is projected with the time the journal recorded, and only then released',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('projection-time-')
    const registry = restartRegistry(workspacePath)
    try {
      const turnId = randomUUID()
      const recorder = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
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
      await recorder.recordPrepared({
        assistantMessageIds: [`${turnId}:assistant:0`],
      })
      await recorder.recordCompleted({
        assistantMessageIds: [`${turnId}:assistant:0`],
      })
      await recorder.release()

      // The slot goes back, and it goes back because the projection landed —
      // not merely because the terminal did. Releasing without one loses the
      // finished turn for good: nothing else remembers it needs projecting, and
      // reconciliation only revisits turns that still hold a slot.
      const document = await readRetentionDocument(
        retentionRoot(workspacePath, sessionId),
      )
      assert.notEqual(document, 'damaged')
      assert.equal(
        document === 'damaged' ? true : document.openTurnIds.has(turnId),
        false,
        'the slot was released',
      )

      const snapshot = await registry.snapshot({
        owner: owner(sessionId),
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.equal(snapshot.kind, 'read')
      const scan = { events: snapshot.kind === 'read' ? snapshot.events : [] }
      const terminal = scan.events[scan.events.length - 1]
      assert.ok(terminal)

      const selection = await selectReclaimableActivities({
        workspacePath,
        owner: owner(sessionId),
        now: () => Date.parse(terminal.recordedAt) + 1_000,
        maxTerminalActivities: 0,
      })
      assert.deepEqual(
        selection.candidates.map((entry) => entry.activityId),
        [turnId],
        'and the turn is in the record',
      )
      assert.equal(
        selection.candidates[0]?.atMs,
        Date.parse(terminal.recordedAt),
        'carrying the time the journal recorded, not the time it was noticed',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
