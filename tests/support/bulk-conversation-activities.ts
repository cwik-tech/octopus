/**
 * Build many finished conversation activities quickly, in the real schema.
 *
 * The scale contract is about ten thousand siblings, and creating them one at a
 * time through the registry takes nine minutes — every one pays for a lock, a
 * manifest publish and three durable appends. A test that slow does not get run,
 * and a scale claim nobody runs is not a claim.
 *
 * So the files are written directly. What makes that legitimate rather than a
 * shortcut is that every hash and every envelope comes from the journal's own
 * functions: the genesis hash, the append digest and the event hash are computed
 * by the same code production computes them with, so a fixture that drifted from
 * the format would stop hashing correctly rather than quietly diverge. The
 * caller is expected to open one of these through the real registry and confirm
 * it scans, which is what turns that expectation into a check.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import type {
  ExecutionJournalEvent,
  ExecutionJournalManifest,
  ExecutionJournalScopeIdentity,
} from '../../contracts/execution-journal.js'
import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import {
  EXECUTION_JOURNAL_DIRECTORY_NAME,
  EXECUTION_JOURNAL_FILENAME,
  computeAppendRequestDigest,
  computeGenesisEventHash,
  recomputeEventHash,
} from '../../core/execution-journal.js'
import {
  CONVERSATION_TURN_STREAM_KIND,
  buildConversationTurnCompletedPayload,
  buildConversationTurnPreparedPayload,
  buildConversationTurnStartedPayload,
  conversationTurnEventId,
} from '../../domains/conversations/conversation-turn-journal.js'

const RUNTIME_DIRECTORY_NAME = '.runtime'
const DIGEST = 'b2'.repeat(32)

export interface BulkActivity {
  readonly activityId: string
  /** When this activity's terminal was recorded, in epoch milliseconds. */
  readonly terminalAtMs: number
}

/**
 * Write `count` completed turns under one conversation.
 *
 * Returns them in the order they finished, which is the order retention will
 * reclaim them in.
 */
export function writeBulkTerminalActivities(input: {
  readonly workspacePath: string
  readonly sessionId: string
  readonly tenantId: string
  readonly count: number
  readonly firstTerminalAtMs: number
  /** Milliseconds between one turn finishing and the next. */
  readonly stepMs?: number
}): readonly BulkActivity[] {
  const step = input.stepMs ?? 1_000
  const activitiesRoot = path.join(
    input.workspacePath,
    'sessions',
    input.sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )
  fs.mkdirSync(activitiesRoot, { recursive: true, mode: 0o700 })

  const written: BulkActivity[] = []
  for (let index = 0; index < input.count; index += 1) {
    // Uuid-shaped, because the payload contract requires message identities to
    // carry one, and ordered by index so the order these finish in is also the
    // order they sort in — which is what makes the reclaim order checkable.
    const activityId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    const terminalAtMs = input.firstTerminalAtMs + index * step
    const identity: ExecutionJournalScopeIdentity = {
      scopeKind: 'conversation',
      scopeId: activityId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      conversationId: input.sessionId,
      activityKind: 'turn',
    }
    const journalDirectory = path.join(
      activitiesRoot,
      activityId,
      RUNTIME_DIRECTORY_NAME,
      EXECUTION_JOURNAL_DIRECTORY_NAME,
    )
    fs.mkdirSync(journalDirectory, { recursive: true, mode: 0o700 })

    const manifest: ExecutionJournalManifest = {
      schemaVersion: 1,
      scopeKind: 'conversation',
      scopeId: activityId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      conversationId: input.sessionId,
      activityKind: 'turn',
      createdAt: new Date(terminalAtMs - step).toISOString(),
      journalRelativePath: EXECUTION_JOURNAL_FILENAME,
      initialSequence: 0,
      initialPreviousEventHash: computeGenesisEventHash(identity),
      createdBy: { implementation: 'pipeline-execution-journal', version: 1 },
    }
    fs.writeFileSync(
      path.join(journalDirectory, 'manifest.json'),
      `${JSON.stringify(manifest)}\n`,
      { mode: 0o600 },
    )

    const stages: readonly {
      readonly stage: 'started' | 'prepared' | 'terminal'
      readonly type: string
      readonly payload: CanonicalJsonObject
    }[] = [
      {
        stage: 'started',
        type: 'conversation.turn.started',
        payload: buildConversationTurnStartedPayload({
          surface: 'run-receptionist',
          userMessageId: `${activityId}:user`,
          requestDigest: DIGEST,
          expectedResponseCount: 1,
          origin: 'client',
        }),
      },
      {
        stage: 'prepared',
        type: 'conversation.turn.prepared',
        payload: buildConversationTurnPreparedPayload({
          assistantMessageIds: [`${activityId}:assistant:0`],
        }),
      },
      {
        stage: 'terminal',
        type: 'conversation.turn.completed',
        payload: buildConversationTurnCompletedPayload({
          assistantMessageIds: [`${activityId}:assistant:0`],
        }),
      },
    ]

    let previousEventHash = manifest.initialPreviousEventHash
    const lines: string[] = []
    for (const [offset, entry] of stages.entries()) {
      const fields = {
        eventId: conversationTurnEventId(activityId, activityId, entry.stage),
        streamKind: CONVERSATION_TURN_STREAM_KIND,
        streamId: activityId,
        expectedStreamRevision: offset,
        type: entry.type,
        payloadSchemaVersion: 1,
        payload: entry.payload,
        correlationId: activityId,
      }
      const unhashed: ExecutionJournalEvent = {
        schemaVersion: 1,
        eventId: fields.eventId,
        sequence: offset + 1,
        // The last event's time is what retention ages this activity from, so
        // the stages are spread backwards from the terminal rather than all
        // sharing one instant.
        recordedAt: new Date(
          terminalAtMs - (stages.length - 1 - offset) * 10,
        ).toISOString(),
        scopeKind: 'conversation',
        scopeId: activityId,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        conversationId: input.sessionId,
        activityKind: 'turn',
        streamKind: fields.streamKind,
        streamId: fields.streamId,
        streamRevision: offset + 1,
        type: fields.type,
        payloadSchemaVersion: 1,
        appendRequestDigest: computeAppendRequestDigest(fields),
        correlationId: fields.correlationId,
        previousEventHash,
        eventHash: '',
        payload: entry.payload,
      }
      const event: ExecutionJournalEvent = {
        ...unhashed,
        eventHash: recomputeEventHash(unhashed),
      }
      previousEventHash = event.eventHash
      lines.push(JSON.stringify(event))
    }
    fs.writeFileSync(
      path.join(journalDirectory, EXECUTION_JOURNAL_FILENAME),
      `${lines.join('\n')}\n`,
      { mode: 0o600 },
    )
    written.push({ activityId, terminalAtMs })
  }
  return written
}


/**
 * Write one activity holding `eventCount` valid, hash-chained events.
 *
 * The write path refuses to create this once the bound exists, which is the
 * point: a journal can still arrive at that size by being fabricated, restored
 * from elsewhere, or written by a build that had no bound — and the read path
 * has to refuse it too. Built with the journal's own hashing, so what is
 * refused is a genuinely valid file that is merely too long.
 */
export function writeOversizedConversationActivity(input: {
  readonly workspacePath: string
  readonly sessionId: string
  readonly tenantId: string
  readonly activityId: string
  readonly eventCount: number
}): void {
  const identity: ExecutionJournalScopeIdentity = {
    scopeKind: 'conversation',
    scopeId: input.activityId,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    conversationId: input.sessionId,
    activityKind: 'turn',
  }
  const journalDirectory = path.join(
    input.workspacePath,
    'sessions',
    input.sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    input.activityId,
    RUNTIME_DIRECTORY_NAME,
    EXECUTION_JOURNAL_DIRECTORY_NAME,
  )
  fs.mkdirSync(journalDirectory, { recursive: true, mode: 0o700 })

  const manifest: ExecutionJournalManifest = {
    schemaVersion: 1,
    scopeKind: 'conversation',
    scopeId: input.activityId,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    conversationId: input.sessionId,
    activityKind: 'turn',
    createdAt: new Date(0).toISOString(),
    journalRelativePath: EXECUTION_JOURNAL_FILENAME,
    initialSequence: 0,
    initialPreviousEventHash: computeGenesisEventHash(identity),
    createdBy: { implementation: 'pipeline-execution-journal', version: 1 },
  }
  fs.writeFileSync(
    path.join(journalDirectory, 'manifest.json'),
    `${JSON.stringify(manifest)}\n`,
    { mode: 0o600 },
  )

  let previousEventHash = manifest.initialPreviousEventHash
  const lines: string[] = []
  for (let index = 0; index < input.eventCount; index += 1) {
    const fields = {
      eventId: `event-${index}`,
      streamKind: CONVERSATION_TURN_STREAM_KIND,
      streamId: input.activityId,
      expectedStreamRevision: index,
      type: 'conversation.turn.noted',
      payloadSchemaVersion: 1,
      payload: { index } as CanonicalJsonObject,
      correlationId: input.activityId,
    }
    const unhashed: ExecutionJournalEvent = {
      schemaVersion: 1,
      eventId: fields.eventId,
      sequence: index + 1,
      recordedAt: new Date(index).toISOString(),
      scopeKind: 'conversation',
      scopeId: input.activityId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      conversationId: input.sessionId,
      activityKind: 'turn',
      streamKind: fields.streamKind,
      streamId: fields.streamId,
      streamRevision: index + 1,
      type: fields.type,
      payloadSchemaVersion: 1,
      appendRequestDigest: computeAppendRequestDigest(fields),
      correlationId: fields.correlationId,
      previousEventHash,
      eventHash: '',
      payload: fields.payload,
    }
    const event: ExecutionJournalEvent = {
      ...unhashed,
      eventHash: recomputeEventHash(unhashed),
    }
    previousEventHash = event.eventHash
    lines.push(JSON.stringify(event))
  }
  fs.writeFileSync(
    path.join(journalDirectory, EXECUTION_JOURNAL_FILENAME),
    `${lines.join('\n')}\n`,
    { mode: 0o600 },
  )
}
