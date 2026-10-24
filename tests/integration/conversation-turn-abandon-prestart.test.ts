/**
 * A turn that never began does not leave an activity behind.
 *
 * The journal is resolved before the turn runs, on purpose: a conversation
 * that is enrolled but unreachable must fail the request rather than publish
 * an answer with no evidence. Resolving it also creates the activity, and that
 * is the part with a cost — if the turn then fails before its start barrier,
 * an empty activity stays on disk holding an admission slot, and every reader
 * afterwards sees a turn that started and never resolved.
 *
 * Abandoning is evidence-based. It removes only what a scan proves is empty,
 * so a turn that did record something keeps its journal no matter what failed
 * later.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import {
  releaseConversationActivity,
  reserveConversationActivity,
} from '../../services/conversation-admission-reservation.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { runOrchestratorMessageService } from '../../services/run-orchestrator-service.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 20_000

/** The activity directories, without the reservation sidecar beside them. */
function activityIds(activitiesRoot: string): string[] {
  if (!fs.existsSync(activitiesRoot)) return []
  return fs
    .readdirSync(activitiesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  return { directory, workspacePath }
}

test(
  'a turn that fails before its start barrier leaves no activity behind',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('turn-prestart-')
    const store = new FileSystemSessionStore(workspacePath)
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const session = await store.createSession({ title: 'pre-start' })
      const activitiesRoot = path.join(
        workspacePath,
        'sessions',
        session.id,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )

      // A real fault on the real store, in the window that matters: the turn
      // reads the transcript to classify a replay before it records anything,
      // and a directory where the transcript belongs is unreadable rather than
      // absent. Deliberately not a stubbed store method — this is a fault that
      // can actually happen to a file.
      const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
      fs.mkdirSync(chatPath)

      const turnId = randomUUID()
      await assert.rejects(
        runOrchestratorMessageService({
          sessionId: session.id,
          sessionStore: store,
          workspacePath,
          text: 'a turn that cannot get started',
          turnId,
          conversationJournalRegistry: registry,
        }),
        'the failure still reaches the caller',
      )

      assert.deepEqual(
        activityIds(activitiesRoot),
        [],
        'an activity nothing was ever written to is not a record of anything',
      )
      // An empty directory is not proof on its own: what matters is whether
      // the next turn can get in. With a ceiling of one, a slot still held by
      // the failed turn refuses this outright.
      const owner = {
        kind: 'run-session' as const,
        conversationId: session.id,
        sessionId: session.id,
      }
      const nextTurnId = randomUUID()
      const reservation = await reserveConversationActivity({
        workspacePath,
        owner,
        turnId: nextTurnId,
        maxUnresolved: 1,
      })
      assert.equal(
        reservation.kind,
        'reserved',
        'a slot the failed turn gave back is a slot the next turn can take',
      )
      await releaseConversationActivity({ workspacePath, owner, turnId: nextTurnId })
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an activity that recorded something is kept even when the turn fails',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // The other half of the rule, and the reason abandoning reads evidence
    // rather than trusting a flag: a journal holding a `started` is the record
    // an operator needs most when the turn goes wrong. A turn that merely
    // succeeded would never reach the new catch and would prove nothing.
    const { directory, workspacePath } = makeWorkspace('turn-kept-')
    const store = new FileSystemSessionStore(workspacePath)
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const session = await store.createSession({ title: 'kept' })
      const turnId = randomUUID()

      // A real fault, placed after the start barrier: the transcript reads and
      // the user message and `started` both land, and then the plan this turn
      // has to persist cannot be written because a directory sits where the
      // file belongs.
      fs.mkdirSync(path.join(workspacePath, 'sessions', session.id, 'run-plan.json'))

      await assert.rejects(
        runOrchestratorMessageService({
          sessionId: session.id,
          sessionStore: store,
          workspacePath,
          text: 'a turn that does start and then fails',
          turnId,
          conversationJournalRegistry: registry,
        }),
        'the failure still reaches the caller',
      )

      const activitiesRoot = path.join(
        workspacePath,
        'sessions',
        session.id,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )
      assert.deepEqual(
        activityIds(activitiesRoot),
        [turnId],
        'a journal that recorded this turn is not discarded because a later ' +
          'step failed',
      )
      const snapshot = await registry.snapshot({
        owner: {
          kind: 'run-session',
          conversationId: session.id,
          sessionId: session.id,
        },
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.equal(snapshot.kind, 'read')
      // A `started` with no terminal is the point. The provider had already
      // been asked by the time the plan write failed, so nothing may claim the
      // turn produced no reply — and this unresolved record is precisely what
      // an operator needs, which is why abandoning may never take it.
      assert.deepEqual(
        snapshot.kind === 'read' ? snapshot.events.map((event) => event.type) : [],
        ['conversation.turn.started'],
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
