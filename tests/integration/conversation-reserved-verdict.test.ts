/**
 * What a reserved turn's journal is allowed to say about itself.
 *
 * Reconciliation reads this to decide whether a slot may go back, and retention
 * later deletes what reconciliation settled — so every answer short of proof has
 * to be "I could not tell". Three ways it was not:
 *
 * An activity holding events that are not this turn's read as empty, because
 * only one stream was scanned. Empty means reclaimable, so a journal holding
 * something else entirely could be deleted for holding nothing.
 *
 * A stream this build cannot understand reduced to `invalid`, and `invalid` fell
 * through the same branch as a terminal — so a malformed journal was treated as
 * a finished turn, its slot returned and its contents eventually removed. That
 * journal is the only evidence that anything went wrong.
 *
 * And `terminal` was whatever was left over, rather than one of the three states
 * that actually mean a turn ended.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  CONVERSATION_TURN_STREAM_KIND,
  buildConversationTurnCompletedPayload,
  buildConversationTurnPreparedPayload,
  buildConversationTurnStartedPayload,
  conversationTurnEventId,
} from '../../domains/conversations/conversation-turn-journal.js'
import { inspectReservedActivity } from '../../services/conversation-admission-reservation.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 15_000
const DIGEST = 'c9'.repeat(32)

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

async function withActivity(
  workspacePath: string,
  sessionId: string,
  turnId: string,
  write: (
    lease: NonNullable<
      Awaited<ReturnType<WorkspaceConversationJournalRegistry['acquire']>>
    >,
  ) => Promise<void>,
): Promise<void> {
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  try {
    const lease = await registry.acquire({
      owner: owner(sessionId),
      activityId: turnId,
      activityKind: 'turn',
    })
    assert.ok(lease)
    await write(lease)
    await lease.release()
  } finally {
    await registry.close()
  }
}

async function verdictFor(
  workspacePath: string,
  sessionId: string,
  turnId: string,
) {
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  try {
    return await inspectReservedActivity({
      registry,
      owner: owner(sessionId),
      turnId,
    })
  } finally {
    await registry.close()
  }
}

test(
  'an activity holding something else is not an empty one',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('verdict-other-')
    try {
      const turnId = randomUUID()
      await withActivity(workspacePath, sessionId, turnId, async (lease) => {
        const outcome = await lease.journal.append({
          eventId: 'from-somewhere-else',
          streamKind: 'something.else',
          streamId: turnId,
          expectedStreamRevision: 0,
          type: 'something.else.happened',
          payloadSchemaVersion: 1,
          payload: { note: 'not this turn' },
          correlationId: turnId,
        })
        assert.equal(outcome.kind, 'appended')
      })

      const verdict = await verdictFor(workspacePath, sessionId, turnId)
      assert.equal(
        verdict.kind,
        'unreadable',
        'empty means reclaimable, and this activity is holding something',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a stream this build cannot understand keeps its slot',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('verdict-invalid-')
    try {
      // Completed with no preparation before it: a stream that cannot have
      // happened. It is not a finished turn, and the journal saying so is the
      // only evidence anything went wrong.
      const turnId = randomUUID()
      await withActivity(workspacePath, sessionId, turnId, async (lease) => {
        const outcome = await lease.journal.append({
          eventId: conversationTurnEventId(turnId, turnId, 'terminal'),
          streamKind: CONVERSATION_TURN_STREAM_KIND,
          streamId: turnId,
          expectedStreamRevision: 0,
          type: 'conversation.turn.completed',
          payloadSchemaVersion: 1,
          payload: buildConversationTurnCompletedPayload({
            assistantMessageIds: [`${turnId}:assistant:0`],
          }),
          correlationId: turnId,
        })
        assert.equal(outcome.kind, 'appended')
      })

      const verdict = await verdictFor(workspacePath, sessionId, turnId)
      assert.equal(
        verdict.kind,
        'unreadable',
        'a journal that cannot be understood is not a turn that finished',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a turn that really finished is the only thing reported as terminal',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('verdict-terminal-')
    try {
      const turnId = randomUUID()
      await withActivity(workspacePath, sessionId, turnId, async (lease) => {
        const stages = [
          [
            'started' as const,
            'conversation.turn.started',
            buildConversationTurnStartedPayload({
              surface: 'run-receptionist',
              userMessageId: `${turnId}:user`,
              requestDigest: DIGEST,
              expectedResponseCount: 1,
              origin: 'client' as const,
            }),
          ],
          [
            'prepared' as const,
            'conversation.turn.prepared',
            buildConversationTurnPreparedPayload({
              assistantMessageIds: [`${turnId}:assistant:0`],
            }),
          ],
          [
            'terminal' as const,
            'conversation.turn.completed',
            buildConversationTurnCompletedPayload({
              assistantMessageIds: [`${turnId}:assistant:0`],
            }),
          ],
        ] as const
        for (const [revision, [stage, type, payload]] of stages.entries()) {
          const outcome = await lease.journal.append({
            eventId: conversationTurnEventId(turnId, turnId, stage),
            streamKind: CONVERSATION_TURN_STREAM_KIND,
            streamId: turnId,
            expectedStreamRevision: revision,
            type,
            payloadSchemaVersion: 1,
            payload,
            correlationId: turnId,
          })
          assert.equal(outcome.kind, 'appended')
        }
      })

      assert.equal(
        (await verdictFor(workspacePath, sessionId, turnId)).kind,
        'terminal',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'empty means the whole journal is empty, not one stream of it',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('verdict-empty-')
    try {
      const turnId = randomUUID()
      await withActivity(workspacePath, sessionId, turnId, async () => {})

      const verdict = await verdictFor(workspacePath, sessionId, turnId)
      assert.equal(verdict.kind, 'empty')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'an activity mixing this turn with anything else is not readable either',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('verdict-mixed-')
    try {
      // A complete, valid turn — and one event that is not part of it. The turn
      // reads as finished, so the slot goes back and retention eventually
      // deletes the activity, taking the foreign event with it. An activity
      // holding something this build does not account for is not one it may
      // decide the fate of.
      const turnId = randomUUID()
      await withActivity(workspacePath, sessionId, turnId, async (lease) => {
        const stages = [
          [
            'started' as const,
            'conversation.turn.started',
            buildConversationTurnStartedPayload({
              surface: 'run-receptionist',
              userMessageId: `${turnId}:user`,
              requestDigest: DIGEST,
              expectedResponseCount: 1,
              origin: 'client' as const,
            }),
          ],
          [
            'prepared' as const,
            'conversation.turn.prepared',
            buildConversationTurnPreparedPayload({
              assistantMessageIds: [`${turnId}:assistant:0`],
            }),
          ],
          [
            'terminal' as const,
            'conversation.turn.completed',
            buildConversationTurnCompletedPayload({
              assistantMessageIds: [`${turnId}:assistant:0`],
            }),
          ],
        ] as const
        for (const [revision, [stage, type, payload]] of stages.entries()) {
          const outcome = await lease.journal.append({
            eventId: conversationTurnEventId(turnId, turnId, stage),
            streamKind: CONVERSATION_TURN_STREAM_KIND,
            streamId: turnId,
            expectedStreamRevision: revision,
            type,
            payloadSchemaVersion: 1,
            payload,
            correlationId: turnId,
          })
          assert.equal(outcome.kind, 'appended')
        }
        const foreign = await lease.journal.append({
          eventId: 'a-foreign-event',
          streamKind: 'something.else',
          streamId: turnId,
          expectedStreamRevision: 0,
          type: 'something.else.happened',
          payloadSchemaVersion: 1,
          payload: { note: 'not part of this turn' },
          correlationId: turnId,
        })
        assert.equal(foreign.kind, 'appended')
      })

      assert.equal(
        (await verdictFor(workspacePath, sessionId, turnId)).kind,
        'unreadable',
        'a finished turn beside something unaccounted for is not a clean ending',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
