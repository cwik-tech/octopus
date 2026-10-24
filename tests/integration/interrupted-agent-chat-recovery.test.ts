/**
 * A turn whose process died is finished by the next one to open the session.
 *
 * This is the durable half of the incident. The process that was running the
 * turn is gone; what it left behind is `conversation.turn.started`, a
 * `prepared` naming the reply it meant to publish, `agent.turn.started` on the
 * assignment, a user message with no answer under it, and an admission slot
 * nobody will ever give back.
 *
 * Recovery reads that evidence and finishes the turn. What it must never do is
 * ask the provider anything: nobody knows whether the original call ran, and a
 * turn re-run on the user's behalf is exactly the duplicate the conservative
 * replay rule exists to prevent.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ChatMessage } from '../../contracts/sessions.js'
import { resolveAgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import {
  conversationRetentionRoot,
  readRetentionDocument,
} from '../../services/conversation-terminal-ledger.js'
import { recoverInterruptedAgentChatTurns } from '../../services/interrupted-agent-chat-recovery.js'
import {
  reduceConversationTurnStream,
  type ConversationTurnSummary,
} from '../../domains/conversations/conversation-turn-journal.js'
import type { AgentTurnSummary } from '../../domains/agent-execution/agent-turn-journal.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'

/**
 * One workspace, opened twice.
 *
 * The registries are constructed per "process": the first pair writes the state
 * a crash leaves behind and is then closed, and a second pair reads it back.
 * That closing is what makes the second read a restart rather than a
 * continuation of the same in-memory leases.
 */
interface Workspace {
  readonly workspacePath: string
  readonly sessionId: string
  readonly owner: {
    readonly kind: 'run-session'
    readonly conversationId: string
    readonly sessionId: string
  }
  readonly messages: ChatMessage[]
  assignmentPath(runId: string, assignmentId: string): string
  cleanup(): void
}

function makeWorkspace(): Workspace {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'interrupted-recovery-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), {
    recursive: true,
  })
  return {
    workspacePath,
    sessionId,
    owner: { kind: 'run-session', conversationId: sessionId, sessionId },
    messages: [],
    assignmentPath: (runId, assignmentId) => {
      const assignmentPath = path.join(
        workspacePath,
        'sessions',
        sessionId,
        'runs',
        runId,
        'assignments',
        assignmentId,
      )
      fs.mkdirSync(assignmentPath, { recursive: true })
      return assignmentPath
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
}

function makeRegistries(workspacePath: string) {
  const conversation = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const execution = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  return {
    conversation,
    execution,
    close: async () => {
      await conversation.close()
      await execution.close()
    },
  }
}

function userMessage(turnId: string, text: string): ChatMessage {
  return {
    id: `${turnId}:user`,
    role: 'user',
    text,
    createdAt: '2026-08-31T09:00:00.000Z',
    turnId,
    schemaVersion: 2,
    conversationId: 'unused',
    kind: 'chat',
    source: { kind: 'conversation-turn', turnId },
    turnRequest: { fingerprint: 'fingerprint', expectedReplies: 1 },
  }
}

/**
 * Write exactly what a process that died mid-provider leaves on disk.
 *
 * Through the real recorders, in the real order, stopped at the point the
 * incident stopped: the turn is admitted, both journals record that it began,
 * the reply it intends to publish is named, and then nothing.
 */
async function seedInterruptedTurn(workspace: Workspace): Promise<{
  readonly turnId: string
  readonly assignmentId: string
}> {
  const turnId = randomUUID()
  const assignmentId = randomUUID()
  const replyId = `stuck-agent:0`
  const assistantMessageId = `${turnId}:assistant:0`
  workspace.assignmentPath(turnId, assignmentId)
  const registries = makeRegistries(workspace.workspacePath)
  try {
    const conversation = await resolveConversationTurnJournalRecorder({
      registry: registries.conversation,
      owner: workspace.owner,
      turnId,
      workspacePath: workspace.workspacePath,
    })
    assert.ok(conversation, 'the conversation journal is enrolled')
    await conversation.recordStarted({
      surface: 'run-selected-agents',
      userMessageId: `${turnId}:user`,
      requestDigest: 'a'.repeat(64),
      expectedResponseCount: 1,
      origin: 'client',
      requestedProvider: 'codex',
      requestedModel: 'fake/model',
    })
    await conversation.recordPrepared({
      assistantMessageIds: [assistantMessageId],
      assignments: [{ assignmentId, assistantMessageId }],
    })

    const agentTurn = await resolveAgentTurnJournalRecorder({
      registry: registries.execution,
      scope: { sessionId: workspace.sessionId, runId: turnId, assignmentId },
      agentPath: 'agents/stuck-agent',
      requestId: randomUUID(),
      processIdentity: 'crashed-process',
    })
    assert.ok(agentTurn, 'the assignment journal is enrolled')
    await agentTurn.recordStarted({
      turnId,
      replyId,
      speakerOrdinal: 0,
      agentPath: 'agents/stuck-agent',
      requestedProvider: 'codex',
      requestedModel: 'fake/model',
    })
    // No terminal on either journal, and no assistant message. The process is
    // gone from here on.
    await agentTurn.release()
    await conversation.release()
  } finally {
    await registries.close()
  }
  workspace.messages.push(userMessage(turnId, 'Please answer.'))
  return { turnId, assignmentId }
}

async function readConversationSummary(
  workspace: Workspace,
): Promise<(turnId: string) => Promise<ConversationTurnSummary>> {
  const registries = makeRegistries(workspace.workspacePath)
  return async (turnId: string) => {
    try {
      const snapshot = await registries.conversation.snapshot({
        owner: workspace.owner,
        activityId: turnId,
        activityKind: 'turn',
      })
      if (snapshot.kind !== 'read') {
        throw new Error(`the conversation activity is ${snapshot.kind}`)
      }
      return reduceConversationTurnStream(
        turnId,
        snapshot.events.map((event) => ({
          type: event.type,
          payload: event.payload,
        })),
      )
    } finally {
      await registries.close()
    }
  }
}

async function readAgentTurnSummary(
  workspace: Workspace,
  turnId: string,
  assignmentId: string,
): Promise<AgentTurnSummary | null> {
  const registries = makeRegistries(workspace.workspacePath)
  try {
    const recorder = await resolveAgentTurnJournalRecorder({
      registry: registries.execution,
      scope: { sessionId: workspace.sessionId, runId: turnId, assignmentId },
      agentPath: 'agents/stuck-agent',
      requestId: randomUUID(),
      processIdentity: 'reader',
    })
    if (!recorder) return null
    try {
      return await recorder.readSummary()
    } finally {
      await recorder.release()
    }
  } finally {
    await registries.close()
  }
}

async function openTurnIds(workspace: Workspace): Promise<readonly string[]> {
  const root = conversationRetentionRoot({
    workspacePath: workspace.workspacePath,
    owner: workspace.owner,
  })
  if (!root) return []
  const stored = await readRetentionDocument(root)
  return stored === 'damaged' ? [] : [...stored.openTurnIds]
}

test(
  'a turn left unresolved by a dead process is terminalized on the next session load',
  { timeout: 30_000 },
  async () => {
    const workspace = makeWorkspace()
    try {
      const seeded = await seedInterruptedTurn(workspace)
      assert.deepEqual(
        await openTurnIds(workspace),
        [seeded.turnId],
        'the crashed turn is holding an admission slot',
      )

      // A new process opens the same workspace.
      const restarted = makeRegistries(workspace.workspacePath)
      let outcomes
      try {
        outcomes = await recoverInterruptedAgentChatTurns({
          workspacePath: workspace.workspacePath,
          sessionId: workspace.sessionId,
          conversationRegistry: restarted.conversation,
          executionRegistry: restarted.execution,
          messages: workspace.messages,
        })
      } finally {
        await restarted.close()
      }

      assert.deepEqual(
        outcomes.map((outcome) => ({
          turnId: outcome.turnId,
          state: outcome.state,
        })),
        [{ turnId: seeded.turnId, state: 'interrupted' }],
        'the user is told the response was interrupted',
      )

      const agentTurn = await readAgentTurnSummary(
        workspace,
        seeded.turnId,
        seeded.assignmentId,
      )
      assert.equal(agentTurn?.state, 'failed')
      assert.equal(agentTurn?.failure?.serviceCode, 'provider_interrupted')
      assert.equal(
        agentTurn?.assistantMessageId,
        undefined,
        'no reply may be claimed for a turn nobody watched finish',
      )

      const readConversation = await readConversationSummary(workspace)
      const conversation = await readConversation(seeded.turnId)
      assert.equal(conversation.state, 'failed')
      assert.deepEqual(conversation.failure, {
        code: 'provider_interrupted',
        phase: 'provider',
      })

      assert.deepEqual(
        await openTurnIds(workspace),
        [],
        'the admission slot went back',
      )

      assert.equal(
        workspace.messages.filter((message) => message.role === 'assistant')
          .length,
        0,
        'recovery invents no answer',
      )

      // Run again, exactly as the next session load would. A second pass must
      // change nothing: the terminals are already there and the slot is gone.
      const again = makeRegistries(workspace.workspacePath)
      let secondPass
      try {
        secondPass = await recoverInterruptedAgentChatTurns({
          workspacePath: workspace.workspacePath,
          sessionId: workspace.sessionId,
          conversationRegistry: again.conversation,
          executionRegistry: again.execution,
          messages: workspace.messages,
        })
      } finally {
        await again.close()
      }
      assert.deepEqual(
        secondPass.map((outcome) => ({
          turnId: outcome.turnId,
          state: outcome.state,
        })),
        [{ turnId: seeded.turnId, state: 'interrupted' }],
        'the settled turn keeps reading the same way',
      )
      assert.deepEqual(await openTurnIds(workspace), [])
    } finally {
      workspace.cleanup()
    }
  },
)

test(
  'a turn still owned by a live stream is left exactly as it was',
  { timeout: 30_000 },
  async () => {
    // The durable record of a healthy turn mid-flight is identical to the
    // record of one whose process died: `started`, `prepared`, no terminal.
    // Only the live stream can tell them apart, and getting that wrong ends a
    // turn that was about to succeed — with its own terminal then colliding
    // against the one recovery wrote.
    const workspace = makeWorkspace()
    const hub = new AgentTextStreamHub()
    let seededTurnId: string | undefined
    try {
      const seeded = await seedInterruptedTurn(workspace)
      seededTurnId = seeded.turnId
      hub.openChannel(seeded.turnId, workspace.sessionId)

      const restarted = makeRegistries(workspace.workspacePath)
      let outcomes
      try {
        outcomes = await recoverInterruptedAgentChatTurns({
          workspacePath: workspace.workspacePath,
          sessionId: workspace.sessionId,
          conversationRegistry: restarted.conversation,
          executionRegistry: restarted.execution,
          messages: workspace.messages,
          hub,
        })
      } finally {
        await restarted.close()
      }

      assert.deepEqual(
        outcomes,
        [{ turnId: seeded.turnId, state: 'pending' }],
        'a running turn is reported as still running, not as failed',
      )

      const agentTurn = await readAgentTurnSummary(
        workspace,
        seeded.turnId,
        seeded.assignmentId,
      )
      assert.equal(
        agentTurn?.state,
        'provider_in_progress',
        'the live turn keeps its own journal to terminalize',
      )

      const readConversation = await readConversationSummary(workspace)
      assert.equal((await readConversation(seeded.turnId)).state, 'prepared')

      assert.deepEqual(
        await openTurnIds(workspace),
        [seeded.turnId],
        'the running turn keeps the admission slot it is using',
      )
    } finally {
      if (seededTurnId) hub.closeChannel(seededTurnId)
      workspace.cleanup()
    }
  },
)

/**
 * The crash window on the other side of persistence.
 *
 * A turn can store its reply and then lose the process before either terminal
 * lands. The transcript is complete and correct, and both journals still read
 * as unfinished — so the admission slot stays held for a turn that succeeded.
 * Nothing else closes this: the replay path only runs when the same turn id is
 * submitted again, which for a turn the user can already read never happens.
 */
async function seedStoredReplyWithoutTerminal(workspace: Workspace): Promise<{
  readonly turnId: string
  readonly assignmentId: string
  readonly assistantMessageId: string
}> {
  const turnId = randomUUID()
  const assignmentId = randomUUID()
  const assistantMessageId = `${turnId}:assistant:0`
  workspace.assignmentPath(turnId, assignmentId)
  const registries = makeRegistries(workspace.workspacePath)
  try {
    const conversation = await resolveConversationTurnJournalRecorder({
      registry: registries.conversation,
      owner: workspace.owner,
      turnId,
      workspacePath: workspace.workspacePath,
    })
    assert.ok(conversation)
    await conversation.recordStarted({
      surface: 'run-selected-agents',
      userMessageId: `${turnId}:user`,
      requestDigest: 'c'.repeat(64),
      expectedResponseCount: 1,
      origin: 'client',
    })
    await conversation.recordPrepared({
      assistantMessageIds: [assistantMessageId],
      assignments: [{ assignmentId, assistantMessageId }],
    })

    const agentTurn = await resolveAgentTurnJournalRecorder({
      registry: registries.execution,
      scope: { sessionId: workspace.sessionId, runId: turnId, assignmentId },
      agentPath: 'agents/stuck-agent',
      requestId: randomUUID(),
      processIdentity: 'crashed-process',
    })
    assert.ok(agentTurn)
    await agentTurn.recordStarted({
      turnId,
      replyId: 'stuck-agent:0',
      speakerOrdinal: 0,
      agentPath: 'agents/stuck-agent',
    })
    await agentTurn.recordPrepared({
      turnId,
      replyId: 'stuck-agent:0',
      assistantMessageId,
      route: 'mcp-cli',
      outcome: 'success',
      outputByteLength: 42,
    })
    await agentTurn.release()
    await conversation.release()
  } finally {
    await registries.close()
  }
  workspace.messages.push(userMessage(turnId, 'Please answer.'))
  workspace.messages.push({
    id: assistantMessageId,
    role: 'assistant',
    text: 'The answer the user can already read.',
    createdAt: '2026-08-31T09:00:30.000Z',
    turnId,
  })
  return { turnId, assignmentId, assistantMessageId }
}

test(
  'a turn whose reply is durable is closed as the success it was',
  { timeout: 30_000 },
  async () => {
    const workspace = makeWorkspace()
    try {
      const seeded = await seedStoredReplyWithoutTerminal(workspace)
      assert.deepEqual(await openTurnIds(workspace), [seeded.turnId])

      const restarted = makeRegistries(workspace.workspacePath)
      let outcomes
      try {
        outcomes = await recoverInterruptedAgentChatTurns({
          workspacePath: workspace.workspacePath,
          sessionId: workspace.sessionId,
          conversationRegistry: restarted.conversation,
          executionRegistry: restarted.execution,
          messages: workspace.messages,
        })
      } finally {
        await restarted.close()
      }

      assert.deepEqual(
        outcomes,
        [],
        'a turn the user can read needs no explanation',
      )

      const agentTurn = await readAgentTurnSummary(
        workspace,
        seeded.turnId,
        seeded.assignmentId,
      )
      assert.equal(agentTurn?.state, 'completed')
      assert.equal(agentTurn?.assistantMessageId, seeded.assistantMessageId)

      const readConversation = await readConversationSummary(workspace)
      const conversation = await readConversation(seeded.turnId)
      assert.equal(conversation.state, 'completed')

      assert.deepEqual(
        await openTurnIds(workspace),
        [],
        'a finished turn stops holding an admission slot',
      )
    } finally {
      workspace.cleanup()
    }
  },
)

test(
  'an assignment this pass cannot read is never terminalized on its absence',
  { timeout: 30_000 },
  async () => {
    // The classifier reads "no assignment named" as a turn that died before
    // its provider was reached, and terminalizes it. A read that merely failed
    // must not arrive looking like that: it is the difference between evidence
    // that says nothing happened and evidence nobody could see.
    const workspace = makeWorkspace()
    try {
      const seeded = await seedInterruptedTurn(workspace)

      const restarted = makeRegistries(workspace.workspacePath)
      let outcomes
      try {
        outcomes = await recoverInterruptedAgentChatTurns({
          workspacePath: workspace.workspacePath,
          sessionId: workspace.sessionId,
          conversationRegistry: restarted.conversation,
          // The registry is present and every assignment read through it
          // fails, which is what an unreadable journal looks like from here.
          executionRegistry: {
            acquireJournalHandle: async () => {
              throw new Error('the assignment journal could not be opened')
            },
          } as never,
          messages: workspace.messages,
        })
      } finally {
        await restarted.close()
      }

      assert.deepEqual(
        outcomes,
        [{ turnId: seeded.turnId, state: 'pending' }],
        'a turn whose evidence could not be read is not called interrupted',
      )

      const readConversation = await readConversationSummary(workspace)
      assert.equal(
        (await readConversation(seeded.turnId)).state,
        'prepared',
        'nothing is written on evidence this pass could not see',
      )
      assert.deepEqual(
        await openTurnIds(workspace),
        [seeded.turnId],
        'the slot is kept rather than released on a failed read',
      )
    } finally {
      workspace.cleanup()
    }
  },
)

test(
  'the aggregate stays open while a referenced assignment could not be ended',
  { timeout: 30_000 },
  async () => {
    // The assignments are terminalized first because their journals are the
    // authority for what each reply did, and the aggregate above them is a
    // claim about all of them. Closing the aggregate while one still reads as
    // in flight leaves a record contradicting itself — and releases the slot,
    // so nothing will come back to finish the assignment later.
    const workspace = makeWorkspace()
    try {
      const seeded = await seedInterruptedTurn(workspace)

      const restarted = makeRegistries(workspace.workspacePath)
      let outcomes
      try {
        // Reads succeed; the write does not. One handle is granted — the one
        // the verdict is formed from — and the acquisition that would append
        // the terminal is refused.
        let granted = 0
        const failingExecution = {
          acquireJournalHandle: async (request: unknown) => {
            granted += 1
            if (granted > 1) return null
            return restarted.execution.acquireJournalHandle(request as never)
          },
        }
        outcomes = await recoverInterruptedAgentChatTurns({
          workspacePath: workspace.workspacePath,
          sessionId: workspace.sessionId,
          conversationRegistry: restarted.conversation,
          executionRegistry: failingExecution as never,
          messages: workspace.messages,
        })
      } finally {
        await restarted.close()
      }

      assert.deepEqual(
        outcomes,
        [{ turnId: seeded.turnId, state: 'pending' }],
        'a turn whose assignment could not be ended is still unresolved',
      )

      const agentTurn = await readAgentTurnSummary(
        workspace,
        seeded.turnId,
        seeded.assignmentId,
      )
      assert.equal(agentTurn?.state, 'provider_in_progress')

      const readConversation = await readConversationSummary(workspace)
      assert.equal(
        (await readConversation(seeded.turnId)).state,
        'prepared',
        'the aggregate is not closed over an assignment still in flight',
      )
      assert.deepEqual(
        await openTurnIds(workspace),
        [seeded.turnId],
        'and the slot is kept, so a later pass can finish the job',
      )
    } finally {
      workspace.cleanup()
    }
  },
)

test(
  'a durable reply is not declared complete until its assignment terminal is',
  { timeout: 30_000 },
  async () => {
    // The success path has the same obligation as the failure path. The
    // aggregate's completion claims every assignment beneath it finished, so
    // closing it while one is still `reply_pending` states something the
    // record does not support — and releases the slot that is the only thing
    // bringing a later pass back to append the missing terminal.
    const workspace = makeWorkspace()
    try {
      const seeded = await seedStoredReplyWithoutTerminal(workspace)

      const restarted = makeRegistries(workspace.workspacePath)
      try {
        let granted = 0
        const failingExecution = {
          acquireJournalHandle: async (request: unknown) => {
            granted += 1
            // The read that forms the verdict is allowed; the acquisition that
            // would append the terminal is not.
            if (granted > 1) return null
            return restarted.execution.acquireJournalHandle(request as never)
          },
        }
        await recoverInterruptedAgentChatTurns({
          workspacePath: workspace.workspacePath,
          sessionId: workspace.sessionId,
          conversationRegistry: restarted.conversation,
          executionRegistry: failingExecution as never,
          messages: workspace.messages,
        })
      } finally {
        await restarted.close()
      }

      const agentTurn = await readAgentTurnSummary(
        workspace,
        seeded.turnId,
        seeded.assignmentId,
      )
      assert.equal(agentTurn?.state, 'reply_pending')

      const readConversation = await readConversationSummary(workspace)
      assert.equal(
        (await readConversation(seeded.turnId)).state,
        'prepared',
        'the aggregate waits for the terminal it is about to claim',
      )
      assert.deepEqual(
        await openTurnIds(workspace),
        [seeded.turnId],
        'and the slot is kept so a later pass can finish it',
      )
    } finally {
      workspace.cleanup()
    }
  },
)
