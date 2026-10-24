/**
 * A terminal that did not land must not pass silently.
 *
 * The failure paths record a terminal on a best-effort basis, which is right —
 * a journal fault must not replace the error the user actually hit. What is not
 * right is discarding the fault: the turn then looks resolved to the code that
 * wrote it and unresolved to everyone who reads the journal, and nothing says
 * the two disagree.
 *
 * So the requirement is narrow: when a terminal append fails, the divergence is
 * surfaced, naming the turn and the stage, and the original failure still
 * propagates.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import {
  runSessionMessageTurn,
  type ConversationTurnDiagnostic,
} from '../../services/session-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

initProviders()

/**
 * Distinctive enough that finding it in a diagnostic proves raw error text
 * reached an operator surface. An underlying fault can carry a path, a host, a
 * credential, or a fragment of a response body; a diagnostic is a safe fact
 * about the turn, so it names identities and a code and nothing it was handed.
 */
const FAULT_TEXT = 'zzq-fault-detail-/secret/path-9f2c'

/**
 * A recorder that starts fine and cannot write its terminal.
 *
 * `onStarted` is how the test gets between the start barrier and the provider.
 * That window is where a terminal is written best-effort, and everything the
 * turn does inside it reads files whose errors are swallowed — so the only way
 * to put a real fault there is to hold the turn at the one collaborator the
 * caller already injects, and break something on disk while it waits.
 */
function brokenTerminalRecorder(
  turnId: string,
  onStarted: () => Promise<void> = async () => {},
) {
  const stages: string[] = []
  return {
    stages,
    recorder: {
      recordStarted: async () => {
        stages.push('started')
        await onStarted()
      },
      recordPrepared: async () => {
        stages.push('prepared')
      },
      recordCompleted: async () => {
        stages.push('completed')
      },
      recordFailed: async () => {
        throw new Error(FAULT_TEXT)
      },
      recordCancelled: async () => {
        throw new Error(FAULT_TEXT)
      },
      readSummary: async () => ({
        turnId,
        state: 'absent' as const,
        assistantMessageIds: [],
      }),
      abandon: async () => {},
      release: async () => {},
    },
  }
}

test('a terminal that could not be written is reported, not discarded', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-divergence-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })

  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'divergence' })
    const turnId = randomUUID()
    // A real fault, on the real store, landed in the window that matters: the
    // transcript this turn is about to read back becomes unreadable after its
    // own message is durable and before anything is sent to a provider.
    //
    // Deliberately not a stubbed method on a derived store. That proved the code
    // calls `getRunPlan`, which is a fact about the implementation rather than
    // about the product — and `getRunPlan` does not even throw, so the fault it
    // modelled could not happen.
    const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
    const { recorder } = brokenTerminalRecorder(turnId, async () => {
      fs.rmSync(chatPath)
      fs.mkdirSync(chatPath)
    })
    // Observed through the service's own boundary rather than by intercepting
    // its logger: a test that reaches inside to a module it does not own is
    // coupled to how the fact is reported, not to the fact.
    const diagnostics: ConversationTurnDiagnostic[] = []

    // A real fault, on the real store. A directory where the run plan belongs
    // reads as "no plan" — that path swallows its errors — and then fails hard
    // when the turn tries to persist its revision, which is the window whose
    // terminal is recorded best-effort.
    //
    // Deliberately not a stubbed method on a derived store: what that proved was
    // that the code calls `getRunPlan`, which is a fact about the
    // implementation. `getRunPlan` does not even throw, so the fault it modelled
    // could not happen.

    await assert.rejects(
      runSessionMessageTurn({
        sessionId: session.id,
        session,
        sessionStore: store,
        text: 'diverge',
        workflows: [],
        workflowEntries: [],
        turnId,
        conversationRecorder: recorder,
        onDiagnostic: (event) => diagnostics.push(event),
      }),
      'the original failure still reaches the caller',
    )

    const divergence = diagnostics.find(
      (event) => event.code === 'terminal_not_recorded' && event.turnId === turnId,
    )
    assert.ok(
      divergence,
      `a terminal that did not land must be surfaced; saw ${JSON.stringify(diagnostics)}`,
    )
    assert.equal(divergence.stage, 'failed')
    assert.equal(
      divergence.turnId,
      turnId,
      'and identifies the turn whose activity will read as unresolved',
    )
    assert.equal(
      JSON.stringify(divergence).includes(FAULT_TEXT),
      false,
      'a diagnostic carries a safe code and identities, never the raw fault text',
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
