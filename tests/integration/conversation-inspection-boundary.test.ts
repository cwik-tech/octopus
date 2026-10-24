/**
 * What an operator is shown, and what showing it costs.
 *
 * The inspection report is a read path a route exposes, so two things have to
 * hold. It cannot be made expensive by whatever is in the workspace — listing
 * every activity before applying a page bound means a conversation past its cap
 * makes every operator read pay for all of it — and it cannot be redirected: a
 * link where a session belongs must not resolve into someone else's history.
 *
 * And the report has to actually carry the lifecycle it claims to. `started`
 * records who named the turn and how many replies were expected, and a
 * cancellation records where it was cancelled. A reducer that drops them leaves
 * an operator with a state name and none of the facts that explain it.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import {
  CONVERSATION_TURN_STREAM_KIND,
  buildConversationTurnCancelledPayload,
  buildConversationTurnStartedPayload,
  conversationTurnEventId,
} from '../../domains/conversations/conversation-turn-journal.js'
import { ConversationJournalInspectionService } from '../../services/conversation-journal-inspection.js'
import { ADMITS_EVERY_INSPECTION } from '../support/journal-inspection-authority.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 30_000
const DIGEST = 'f7'.repeat(32)

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

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
  'a conversation past its cap is reported as unavailable, not enumerated',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-overflow-')
    const registry = makeRegistry(workspacePath)
    try {
      const root = activitiesRoot(workspacePath, sessionId)
      fs.mkdirSync(root, { recursive: true })
      for (let index = 0; index < 12; index += 1) {
        // Uuid-shaped, because that is what an activity is called. Ordered by
        // index so the page a bound would return stays predictable.
        fs.mkdirSync(
          path.join(root, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
        )
      }

      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      const outcome = await inspection.inspectRunSession({
        sessionId,
        // Injected so the bound is testable without seeding ten thousand.
        retainedCap: 4,
      })
      assert.equal(
        outcome.kind,
        'unavailable',
        'a conversation outside what retention permits has not been described, ' +
          'and a page of it would read as if it had',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a link where a session belongs is not followed into someone else’s history',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-link-')
    const registry = makeRegistry(workspacePath)
    try {
      // A real session elsewhere, and a link standing in for this one. Asking
      // "does this path exist?" follows the link and answers yes, so the report
      // would describe a conversation the caller did not ask about.
      const elsewhere = path.join(workspacePath, 'sessions', randomUUID())
      fs.mkdirSync(elsewhere, { recursive: true })
      const linked = randomUUID()
      fs.symlinkSync(elsewhere, path.join(workspacePath, 'sessions', linked))

      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      assert.notEqual(
        (await inspection.inspectRunSession({ sessionId: linked })).kind,
        'report',
        'a session that is a link is not a session',
      )
      assert.equal(
        (await inspection.inspectRunSession({ sessionId })).kind,
        'report',
        'and a real one still reads',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'the report carries the lifecycle facts it claims to',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-facts-')
    const registry = makeRegistry(workspacePath)
    try {
      const turnId = randomUUID()
      const lease = await registry.acquire({
        owner: { kind: 'run-session', conversationId: sessionId, sessionId },
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.ok(lease)
      const stages = [
        {
          stage: 'started' as const,
          type: 'conversation.turn.started',
          payload: buildConversationTurnStartedPayload({
            surface: 'run-receptionist',
            userMessageId: `${turnId}:user`,
            requestDigest: DIGEST,
            expectedResponseCount: 3,
            origin: 'server',
          }),
        },
        {
          stage: 'terminal' as const,
          type: 'conversation.turn.cancelled',
          payload: buildConversationTurnCancelledPayload({ phase: 'provider' }),
        },
      ]
      for (const [revision, entry] of stages.entries()) {
        const outcome = await lease.journal.append({
          eventId: conversationTurnEventId(turnId, turnId, entry.stage),
          streamKind: CONVERSATION_TURN_STREAM_KIND,
          streamId: turnId,
          expectedStreamRevision: revision,
          type: entry.type,
          payloadSchemaVersion: 1,
          payload: entry.payload,
          correlationId: turnId,
        })
        assert.equal(outcome.kind, 'appended')
      }
      await lease.release()

      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      const outcome = await inspection.inspectRunSession({ sessionId })
      assert.equal(outcome.kind, 'report')
      if (outcome.kind !== 'report') return
      const turn = outcome.report.turns[0]
      assert.ok(turn)
      assert.equal(turn.state, 'cancelled')
      // The three facts that explain the state, rather than only the state.
      assert.equal(
        turn.origin,
        'server',
        'who named the turn changes what a replay of it means',
      )
      assert.equal(
        turn.expectedResponseCount,
        3,
        'how many replies were expected is how an operator knows one is missing',
      )
      assert.equal(
        turn.cancelledPhase,
        'provider',
        'and where it was cancelled is the difference between a wasted request ' +
          'and one that never happened',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'entries that are not activities cannot make an operator read unbounded',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-flood-')
    const registry = makeRegistry(workspacePath)
    try {
      // Stopping after `cap` directories bounds what is kept, not what is read.
      // A directory can be filled with things that are not activities, and the
      // scan steps over every one of them before it has a single directory to
      // count — so an operator read costs whatever someone chose to put here.
      const root = activitiesRoot(workspacePath, sessionId)
      fs.mkdirSync(root, { recursive: true })
      const elsewhere = path.join(directory, 'elsewhere')
      fs.mkdirSync(elsewhere, { recursive: true })
      for (let index = 0; index < 2_000; index += 1) {
        fs.writeFileSync(path.join(root, `filler-${index}`), '', 'utf8')
        if (index % 2 === 0) {
          fs.symlinkSync(elsewhere, path.join(root, `link-${index}`))
        }
      }

      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      assert.equal(
        (await inspection.inspectRunSession({ sessionId })).kind,
        'unavailable',
        'a listing that stopped short has not described the conversation',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a link where the activities directory belongs is refused',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-linkroot-')
    const registry = makeRegistry(workspacePath)
    try {
      // Another conversation's activities, reached through a link standing in
      // for this one's. Opening it works; what comes back is someone else's
      // history under this conversation's name.
      const elsewhere = path.join(directory, 'another-conversation')
      fs.mkdirSync(path.join(elsewhere, 'activity-1'), { recursive: true })
      fs.symlinkSync(elsewhere, activitiesRoot(workspacePath, sessionId))

      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      assert.equal(
        (await inspection.inspectRunSession({ sessionId })).kind,
        'unavailable',
        'a link is not this conversation’s activities directory',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a listing that fails for any other reason is reported, not thrown',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-denied-')
    const registry = makeRegistry(workspacePath)
    const root = activitiesRoot(workspacePath, sessionId)
    try {
      // Only "it is not there" was handled; everything else escaped through the
      // generic API error path, which turns an operator read into a 500 whose
      // body carries whatever the errno said — including the path it failed on.
      //
      // A file where the activities directory belongs, rather than a directory
      // with no permission bits: permissions are not enforced for every user,
      // so a bit would make this case quietly vanish on some machines instead
      // of testing anything. `ENOTDIR` is `ENOTDIR` for everyone.
      fs.mkdirSync(path.dirname(root), { recursive: true })
      fs.writeFileSync(root, 'not a directory')

      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      const outcome = await inspection.inspectRunSession({ sessionId })
      assert.equal(
        outcome.kind,
        'unavailable',
        'a listing nobody could read is an answer, not an exception',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a directory that is not named like an activity is not reported as one',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // A conversation directory is a place people and tools can write into: a
    // `notes` folder, an editor's `.backup`, a half-finished copy. None of them
    // is a turn. Reporting one puts an activity in front of an operator that
    // never existed, and counting one toward the retained cap lets three stray
    // folders make a healthy conversation read as past its limit.
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-notes-')
    const registry = makeRegistry(workspacePath)
    try {
      const activityId = randomUUID()
      const lease = await registry.acquire({
        owner: { kind: 'run-session', conversationId: sessionId, sessionId },
        activityId,
        activityKind: 'turn',
      })
      assert.ok(lease)
      await lease.journal.append({
        eventId: conversationTurnEventId(activityId, activityId, 'started'),
        streamKind: CONVERSATION_TURN_STREAM_KIND,
        streamId: activityId,
        expectedStreamRevision: 0,
        type: 'conversation.turn.started',
        payloadSchemaVersion: 1,
        payload: buildConversationTurnStartedPayload({
          surface: 'run-receptionist',
          userMessageId: `${activityId}:user`,
          requestDigest: DIGEST,
          expectedResponseCount: 1,
          origin: 'client',
        }),
        correlationId: activityId,
      })
      await lease.release()

      const root = activitiesRoot(workspacePath, sessionId)
      for (const name of ['notes', 'backup', 'drafts', 'tmp-copy']) {
        fs.mkdirSync(path.join(root, name), { recursive: true })
      }

      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      // A cap the strays would blow through and the one real turn will not.
      const outcome = await inspection.inspectRunSession({
        sessionId,
        retainedCap: 3,
      })
      assert.equal(
        outcome.kind,
        'report',
        'four folders that are not activities do not put a one-turn ' +
          'conversation over its retained cap',
      )
      const report = outcome.kind === 'report' ? outcome.report : undefined
      assert.equal(report?.activityCount, 1)
      assert.deepEqual(
        report?.turns.map((turn) => [turn.activityId, turn.state]),
        [[activityId, 'started']],
        'only the turn is reported; the folders beside it are not activities',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
