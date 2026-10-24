/**
 * The Phase 1 scale contract, exercised rather than described.
 *
 * Ten thousand finished turns beside one that is still running, and four claims
 * about that state that only hold if the real code paths are the ones running:
 *
 * Opening one turn costs one turn. That is the whole reason the physical
 * journal is per-activity: opening a journal reads the file, revalidates every
 * line and indexes every event, and the accepted ADR forbids compacting the
 * result, so one journal for a long conversation would make each turn pay for
 * every turn before it.
 *
 * Retention removes whole activities, from the front, in bounded batches, and
 * never the live one.
 *
 * Startup describes the conversation — the preflight reads the retained
 * manifests and accounts for them rather than declining or guessing.
 *
 * And inspection stays paged.
 *
 * The siblings are written directly rather than driven through the registry:
 * ten thousand lock-and-publish cycles take nine minutes, and a scale test that
 * slow is one nobody runs. Every hash in them is computed by the journal's own
 * functions, and the first assertion below opens one through the real registry —
 * so a fixture that drifted from the persisted format would fail here rather
 * than quietly prove nothing.
 *
 * Timings are recorded as benchmark evidence and are deliberately not the
 * correctness assertion: a loaded machine must not fail this suite.
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import {
  CONVERSATION_TURN_STREAM_KIND,
  buildConversationTurnStartedPayload,
  conversationTurnEventId,
} from '../../domains/conversations/conversation-turn-journal.js'
import { CONVERSATION_MAX_TERMINAL_ACTIVITIES } from '../../domains/conversations/conversation-turn-retention-policy.js'
import { sweepConversationActivities } from '../../services/conversation-activity-sweeper.js'
import { writeRetentionDocument } from '../../services/conversation-terminal-ledger.js'
import { inspectWorkspaceActivationReadiness } from '../../services/execution-journal-preflight.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { ConversationJournalInspectionService } from '../../services/conversation-journal-inspection.js'
import { ADMITS_EVERY_INSPECTION } from '../support/journal-inspection-authority.js'
import { writeBulkTerminalActivities } from '../support/bulk-conversation-activities.js'

const SIBLING_COUNT = CONVERSATION_MAX_TERMINAL_ACTIVITIES
const DIGEST = 'b2'.repeat(32)
const FIRST_TERMINAL_AT = Date.parse('2026-01-01T00:00:00.000Z')
/** Well past the thirty-day window for every sibling written above. */
const LONG_AFTER = Date.parse('2026-06-01T00:00:00.000Z')

test(
  'ten thousand finished turns beside one live turn, swept and accounted for',
  { timeout: 120_000 },
  async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-scale-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const sessionId = randomUUID()
    fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), {
      recursive: true,
    })
    const activitiesRoot = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    const owner = {
      kind: 'run-session' as const,
      conversationId: sessionId,
      sessionId,
    }
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })

    try {
      const siblings = writeBulkTerminalActivities({
        workspacePath,
        sessionId,
        tenantId: 'local',
        count: SIBLING_COUNT,
        firstTerminalAtMs: FIRST_TERMINAL_AT,
      })

      // The retention record the sweep works from, written to match what the
      // siblings say about themselves.
      await writeRetentionDocument(activitiesRoot, {
        openTurnIds: new Set(),
        retained: siblings.map((sibling) => ({
          activityId: sibling.activityId,
          atMs: sibling.terminalAtMs,
        })),
        reconcileCursor: 0,
      })

      // The fixture is only worth anything if the real journal can read it.
      const sampled = await registry.snapshot({
        owner,
        activityId: siblings[0]?.activityId ?? '',
        activityKind: 'turn',
      })
      assert.equal(
        sampled.kind,
        'read',
        'a generated activity opens through the real registry',
      )
      assert.equal(
        sampled.kind === 'read' ? sampled.events.length : 0,
        3,
        'and its hash chain validates, so the fixture is the persisted schema',
      )

      // One real, live turn beside them, written through the registry.
      const turnId = randomUUID()
      const lease = await registry.acquire({
        owner,
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.ok(lease)
      const startedPayload: CanonicalJsonObject =
        buildConversationTurnStartedPayload({
          surface: 'run-receptionist',
          userMessageId: `${turnId}:user`,
          requestDigest: DIGEST,
          expectedResponseCount: 1,
          origin: 'client',
        })
      assert.equal(
        (
          await lease.journal.append({
            eventId: conversationTurnEventId(turnId, turnId, 'started'),
            streamKind: CONVERSATION_TURN_STREAM_KIND,
            streamId: turnId,
            expectedStreamRevision: 0,
            type: 'conversation.turn.started',
            payloadSchemaVersion: 1,
            payload: startedPayload,
            correlationId: turnId,
          })
        ).kind,
        'appended',
      )
      await lease.release()

      // Claim one: opening one turn costs one turn.
      const startedAt = process.hrtime.bigint()
      const reopened = await registry.acquire({
        owner,
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.ok(reopened)
      const scan = await reopened.journal.scanStream(
        CONVERSATION_TURN_STREAM_KIND,
        turnId,
      )
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      await reopened.release()
      assert.equal(
        scan.eventCount,
        1,
        'the turn reads its own events, not the conversation’s history',
      )
      console.log(
        `[benchmark] reopen+scan of a live activity beside ${SIBLING_COUNT} siblings: ${elapsedMs.toFixed(1)}ms`,
      )

      // Claim two, first half: at the cap and inside the window, the count rule
      // removes nothing. A cap that eats into what it is meant to keep is worse
      // than no cap.
      const atCap = await sweepConversationActivities({
        workspacePath,
        owner,
        registry,
        now: () => FIRST_TERMINAL_AT,
        retentionMs: Number.MAX_SAFE_INTEGER,
        maxTerminalActivities: SIBLING_COUNT,
      })
      assert.deepEqual(atCap.deleted, [], 'exactly at the cap is not over it')

      // Claim two, second half: whole activities, from the front, bounded.
      const firstSweep = await sweepConversationActivities({
        workspacePath,
        owner,
        registry,
        now: () => LONG_AFTER,
        limit: 32,
      })
      assert.deepEqual(
        firstSweep.deleted,
        siblings.slice(0, 32).map((sibling) => sibling.activityId),
        'the oldest thirty-two, in the order they finished',
      )
      assert.equal(firstSweep.partial, true, 'and it says it left work behind')
      for (const sibling of siblings.slice(0, 32)) {
        assert.equal(
          fs.existsSync(path.join(activitiesRoot, sibling.activityId)),
          false,
          'the directory is the unit of forgetting',
        )
      }
      assert.equal(
        fs.existsSync(path.join(activitiesRoot, turnId)),
        true,
        'and the turn that has not finished is never swept',
      )

      const secondSweep = await sweepConversationActivities({
        workspacePath,
        owner,
        registry,
        now: () => LONG_AFTER,
        limit: 32,
      })
      assert.deepEqual(
        secondSweep.deleted,
        siblings.slice(32, 64).map((sibling) => sibling.activityId),
        'successive sweeps resume rather than re-reading the front',
      )

      // Claim three: startup describes this conversation rather than declining
      // to. The preflight reads the retained manifests, so the count it reports
      // is the conversation's, and nothing about ten thousand siblings makes
      // the workspace unpinnable.
      const report = await inspectWorkspaceActivationReadiness({
        workspacePath,
        environmentTenantId: 'local',
      })
      assert.equal(
        report.verdict,
        'ready',
        `a workspace at its documented cap must still activate: ${report.problems
          .map((problem) => problem.detail)
          .join(' | ')}`,
      )
      assert.equal(
        report.enrolledJournalCount,
        SIBLING_COUNT - 64 + 1,
        'every retained manifest is accounted for, plus the live turn',
      )

      // Claim four: inspection stays paged rather than returning the set.
      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        authority: ADMITS_EVERY_INSPECTION,
        registry,
      })
      const outcome = await inspection.inspectRunSession({ sessionId })
      assert.equal(outcome.kind, 'report')
      if (outcome.kind !== 'report') return
      assert.equal(outcome.report.turns.length, 100, 'a page, not the whole set')
      assert.equal(outcome.report.truncated, true)
      assert.equal(outcome.report.activityCount, SIBLING_COUNT - 64 + 1)

      // Paging has to actually reach later turns. Without a cursor the first
      // page would be the only page, and every turn after it unreachable.
      const cursor = outcome.report.nextCursor
      assert.ok(cursor, 'a truncated report names where the next page starts')
      const second = await inspection.inspectRunSession({ sessionId, cursor })
      assert.equal(second.kind, 'report')
      if (second.kind !== 'report') return
      assert.equal(second.report.turns.length, 100)
      assert.equal(
        outcome.report.turns.some(
          (turn) => turn.activityId === second.report.turns[0]?.activityId,
        ),
        false,
        'and it does not overlap the page before it',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
