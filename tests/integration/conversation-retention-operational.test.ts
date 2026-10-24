/**
 * Retention has to actually bound a conversation.
 *
 * The selector's rules are unit-tested, but a rule nothing can reach is not a
 * limit. Two claims are made about a running conversation and neither is
 * demonstrated by testing the selector: that the terminal-count cap eventually
 * removes the oldest finished turns, and that a turn which was claimed and
 * never began does not sit in the conversation forever.
 *
 * Both are asserted here against real activities, through the sweep a live turn
 * actually runs.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { sweepConversationActivities } from '../../services/conversation-activity-sweeper.js'
import { readRetentionDocument } from '../../services/conversation-terminal-ledger.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 15_000
const DIGEST = 'a7'.repeat(32)
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

function activityIds(workspacePath: string, sessionId: string): string[] {
  const root = path.join(
    workspacePath,
    'sessions',
    sessionId,
    CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

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

test(
  'the terminal count cap removes the oldest finished turns',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('retention-count-cap-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // Six finished turns against a cap of three. Nothing is old enough to
      // expire by time, so only the count rule can remove anything — and it
      // must, or the cap is a number that never fires.
      const ids: string[] = []
      for (let index = 0; index < 6; index += 1) {
        const turnId = randomUUID()
        ids.push(turnId)
        await completeTurn({ registry, workspacePath, sessionId, turnId })
      }
      assert.equal(activityIds(workspacePath, sessionId).length, 6)

      // Two per sweep against a six-turn conversation: the excess the cap has
      // to remove is larger than anything one sweep looks at. A limit decided
      // from a window cannot find it, which is the whole reason the count comes
      // from a record rather than from a listing.
      const deleted: string[] = []
      for (let pass = 0; pass < 2; pass += 1) {
        const result = await sweepConversationActivities({
          workspacePath,
          owner: owner(sessionId),
          registry,
          maxTerminalActivities: 3,
          retentionMs: Number.MAX_SAFE_INTEGER,
          limit: 2,
        })
        assert.equal(result.deleted.length <= 2, true)
        deleted.push(...result.deleted)
      }

      assert.deepEqual(
        deleted,
        ids.slice(0, 3),
        'the cap fires across the conversation, and the oldest are the ones that go',
      )
      const settled = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        maxTerminalActivities: 3,
        retentionMs: Number.MAX_SAFE_INTEGER,
        limit: 2,
      })
      assert.deepEqual(
        settled.deleted,
        [],
        'and stops exactly at the cap rather than eating into what it keeps',
      )
      assert.deepEqual(
        activityIds(workspacePath, sessionId).sort(),
        [...ids.slice(3)].sort(),
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an activity claimed but never begun does not linger forever',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('retention-abandoned-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // The crash window before the first append: a journal exists and holds
      // nothing. It is not unresolved work — nothing started — so retention has
      // to be able to reclaim it, and it has to date it from something durable
      // rather than from whenever it was noticed.
      const abandoned = randomUUID()
      const recorder = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(sessionId),
        turnId: abandoned,
        workspacePath,
      })
      assert.ok(recorder)
      await recorder.release()
      assert.deepEqual(activityIds(workspacePath, sessionId), [abandoned])

      const fresh = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
      })
      assert.deepEqual(
        fresh.deleted,
        [],
        'a turn that has only just claimed its journal is not abandoned yet',
      )

      const result = await sweepConversationActivities({
        workspacePath,
        owner: owner(sessionId),
        registry,
        now: () => Date.now() + FORTY_DAYS_MS,
      })
      assert.deepEqual(result.deleted, [abandoned])
      assert.deepEqual(
        activityIds(workspacePath, sessionId),
        [],
        'an empty journal that no turn ever used is reclaimed like any other',
      )

      const document = await readRetentionDocument(
        path.join(
          workspacePath,
          'sessions',
          sessionId,
          CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
        ),
      )
      assert.notEqual(document, 'damaged')
      assert.equal(
        document === 'damaged' ? true : document.openTurnIds.has(abandoned),
        false,
        'and its admission slot goes back with it',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
