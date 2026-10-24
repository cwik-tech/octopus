/**
 * `started` is a claim, not a note.
 *
 * Two requests carrying one turn id can both get past the transcript append —
 * the second adopts the durable user message the first wrote, which is exactly
 * what makes the crash window recoverable. What must not happen is both of them
 * walking on to the provider. The journal adjudicates that: one append wins and
 * the other is told the stage was already accepted, which is the losing side of
 * a claim rather than a successful replay.
 *
 * Deterministic on purpose. Racing two HTTP requests and hoping the interleave
 * occurs proves nothing on the runs where it does not.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const DIGEST = 'd4'.repeat(32)

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

test('only one holder of a turn id may claim its start', async () => {
  const { directory, workspacePath, sessionId } = makeWorkspace('conversation-claim-')
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const owner = {
    kind: 'run-session' as const,
    conversationId: sessionId,
    sessionId,
  }
  const turnId = randomUUID()
  try {
    // Two recorders on one turn, as two concurrent requests would hold.
    const first = await resolveConversationTurnJournalRecorder({
      registry,
      owner,
      turnId,
    })
    const second = await resolveConversationTurnJournalRecorder({
      registry,
      owner,
      turnId,
    })
    assert.ok(first)
    assert.ok(second)

    const claim = {
      surface: 'run-receptionist',
      userMessageId: `${turnId}:user`,
      requestDigest: DIGEST,
      expectedResponseCount: 1,
      origin: 'client',
    }

    await first.recordStarted(claim)
    // Byte-identical: the second request adopted the same durable user message,
    // so its payload matches. That is what makes this the interesting case —
    // the journal reports `already-accepted`, and only the claim semantics
    // distinguish the loser from a replay.
    await assert.rejects(
      second.recordStarted(claim),
      /could not record its started stage/,
      'the second holder must be refused, not told it succeeded',
    )

    await first.release()
    await second.release()
  } finally {
    await registry.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
