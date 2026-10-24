/**
 * A deleted session stays deleted, even when a turn is already on its way.
 *
 * `runOrchestratorMessageService` establishes that a session exists and then
 * resolves a turn recorder, and resolving one provisions directories: the
 * admission document's root, and the activity's own scope root. Both are built
 * with a recursive create, so if a deletion lands in between, the very act of
 * preparing to journal the turn recreates `sessions/<id>` — and what comes back
 * is a session directory holding a reservation and an activity journal for a
 * conversation nobody can open, under an owner that no longer exists.
 *
 * The rule is that provisioning may create what belongs to a conversation and
 * never what belongs to its owner. If the owner is gone, the turn fails; it does
 * not rebuild it on the way past.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 10_000

test(
  'resolving a recorder for a deleted session rebuilds nothing',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'delete-vs-resolve-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const sessionId = randomUUID()
    const sessionDir = path.join(workspacePath, 'sessions', sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const owner = {
        kind: 'run-session' as const,
        conversationId: sessionId,
        sessionId,
      }

      // The window: the caller established the session existed, and the
      // deletion lands before the recorder is resolved.
      fs.rmSync(sessionDir, { recursive: true, force: true })

      await assert.rejects(
        resolveConversationTurnJournalRecorder({
          registry,
          owner,
          turnId: randomUUID(),
          workspacePath,
        }),
        'a turn whose session is gone cannot be journalled, and must say so',
      )

      assert.equal(
        fs.existsSync(sessionDir),
        false,
        'no session directory, no sidecar, no activity, no reservation — ' +
          'preparing to journal a turn must not rebuild the owner it belongs to',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'acquiring an activity for a deleted session rebuilds nothing either',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'delete-vs-acquire-')),
    )
    const workspacePath = path.join(directory, 'workspace')
    const sessionId = randomUUID()
    const sessionDir = path.join(workspacePath, 'sessions', sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true })

      await assert.rejects(
        registry.acquire({
          owner: {
            kind: 'run-session',
            conversationId: sessionId,
            sessionId,
          },
          activityId: randomUUID(),
          activityKind: 'turn',
        }),
      )
      assert.equal(fs.existsSync(sessionDir), false)
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
