/**
 * Opening a session says what happened to the turns that have no answer.
 *
 * The transcript alone cannot: it holds what was said, and an interruption is
 * not something anybody said. Before this, a reload of the incident session
 * returned the user's question and nothing else — the same view whether the
 * agent was still thinking, had died an hour ago, or had never been asked.
 *
 * So the messages endpoint returns the outcomes beside the transcript, and
 * opening the session is also when a turn left behind by a dead process is
 * finished. Both halves are proved here through the real HTTP boundary,
 * because that boundary is what the renderer actually reads.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { resolveAgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import {
  conversationRetentionRoot,
  readRetentionDocument,
} from '../../services/conversation-terminal-ledger.js'
import { isConversationTurnOutcome } from '../../contracts/sessions.js'

/**
 * Leave behind exactly what the incident left behind.
 *
 * Written through the real recorders and then closed, so the API server that
 * starts afterwards is reading a workspace some other process abandoned —
 * which is the situation, not a simulation of it.
 */
async function seedAbandonedTurn(input: {
  readonly workspacePath: string
  readonly sessionId: string
  readonly turnId: string
  readonly assignmentId: string
}): Promise<void> {
  const owner = {
    kind: 'run-session' as const,
    conversationId: input.sessionId,
    sessionId: input.sessionId,
  }
  fs.mkdirSync(
    path.join(
      input.workspacePath,
      'sessions',
      input.sessionId,
      'runs',
      input.turnId,
      'assignments',
      input.assignmentId,
    ),
    { recursive: true },
  )
  const conversationRegistry = new WorkspaceConversationJournalRegistry({
    workspacePath: input.workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const executionRegistry = new WorkspaceExecutionJournalRegistry({
    workspacePath: input.workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  try {
    const assistantMessageId = `${input.turnId}:assistant:0`
    const conversation = await resolveConversationTurnJournalRecorder({
      registry: conversationRegistry,
      owner,
      turnId: input.turnId,
      workspacePath: input.workspacePath,
    })
    assert.ok(conversation)
    await conversation.recordStarted({
      surface: 'run-selected-agents',
      userMessageId: `${input.turnId}:user`,
      requestDigest: 'b'.repeat(64),
      expectedResponseCount: 1,
      origin: 'client',
      requestedProvider: 'codex',
      requestedModel: 'fake/model',
    })
    await conversation.recordPrepared({
      assistantMessageIds: [assistantMessageId],
      assignments: [
        { assignmentId: input.assignmentId, assistantMessageId },
      ],
    })
    const agentTurn = await resolveAgentTurnJournalRecorder({
      registry: executionRegistry,
      scope: {
        sessionId: input.sessionId,
        runId: input.turnId,
        assignmentId: input.assignmentId,
      },
      agentPath: 'agents/stuck-agent',
      requestId: randomUUID(),
      processIdentity: 'abandoned-process',
    })
    assert.ok(agentTurn)
    await agentTurn.recordStarted({
      turnId: input.turnId,
      replyId: 'stuck-agent:0',
      speakerOrdinal: 0,
      agentPath: 'agents/stuck-agent',
      requestedProvider: 'codex',
      requestedModel: 'fake/model',
    })
    await agentTurn.release()
    await conversation.release()
  } finally {
    await conversationRegistry.close()
    await executionRegistry.close()
  }
}

test(
  'opening a session reports the interrupted turn and releases its slot',
  { timeout: 60_000 },
  async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'session-turn-outcomes-')),
    )
    const projectRoot = path.join(directory, 'project')
    const workspacePath = path.join(directory, 'workspace')
    fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })
    fs.mkdirSync(workspacePath, { recursive: true })

    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({ title: 'Interrupted' })
    const turnId = randomUUID()
    const assignmentId = randomUUID()
    await sessionStore.appendChatMessageIfAbsent(session.id, {
      id: `${turnId}:user`,
      role: 'user',
      text: 'Find me the TripAdvisor listing.',
      createdAt: '2026-08-31T09:00:00.000Z',
      turnId,
      turnRequest: { fingerprint: 'seeded', expectedReplies: 1 },
    })
    await seedAbandonedTurn({
      workspacePath,
      sessionId: session.id,
      turnId,
      assignmentId,
    })

    const owner = {
      kind: 'run-session' as const,
      conversationId: session.id,
      sessionId: session.id,
    }
    const retentionRoot = conversationRetentionRoot({ workspacePath, owner })
    assert.ok(retentionRoot)
    const before = await readRetentionDocument(retentionRoot)
    assert.notEqual(before, 'damaged')
    assert.deepEqual(
      before === 'damaged' ? [] : [...before.openTurnIds],
      [turnId],
      'the abandoned turn is holding an admission slot',
    )

    let server: StartedApiServer | undefined
    try {
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: new FileSystemSessionStore(workspacePath),
        repoRootPath: projectRoot,
        workspacePath,
      })

      const response = await fetch(
        `${server.url}/sessions/${session.id}/messages`,
      )
      assert.equal(response.status, 200)
      const payload: unknown = await response.json()
      assert.ok(
        typeof payload === 'object' && payload !== null && !Array.isArray(payload),
      )
      const body: Record<string, unknown> = { ...payload }

      assert.ok(Array.isArray(body.messages))
      assert.equal(
        body.messages.length,
        1,
        'the transcript is the user question and nothing else',
      )

      assert.ok(
        Array.isArray(body.outcomes),
        'the envelope explains the turns the transcript cannot',
      )
      assert.equal(body.outcomes.length, 1)
      const outcome: unknown = body.outcomes[0]
      assert.ok(
        isConversationTurnOutcome(outcome),
        'the outcome is the validated contract, not a loose object',
      )
      assert.deepEqual(outcome, {
        turnId,
        state: 'interrupted',
        code: 'provider_interrupted',
        retryable: true,
        // Who the interrupted turn was addressed to, recovered from the
        // assignment's own record. Retry routes from this rather than from
        // whatever the user has selected when they see the card.
        agentNames: ['stuck-agent'],
      })

      const after = await readRetentionDocument(retentionRoot)
      assert.deepEqual(
        after === 'damaged' ? ['damaged'] : [...after.openTurnIds],
        [],
        'opening the session gave the admission slot back',
      )
    } finally {
      await server?.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'sending a new selected-agent turn first also finishes the abandoned one',
  { timeout: 60_000 },
  async () => {
    // A client does not have to load the transcript before it posts. One that
    // sends straight into a session holding an abandoned turn would otherwise
    // keep that turn's admission slot indefinitely — and, once enough of them
    // accumulate, be refused new work by a conversation whose backlog nothing
    // is clearing.
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'session-post-catchup-')),
    )
    const projectRoot = path.join(directory, 'project')
    const workspacePath = path.join(directory, 'workspace')
    fs.mkdirSync(path.join(projectRoot, 'agents', 'stuck-agent'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(projectRoot, 'agents', 'stuck-agent', 'stuck-agent.md'),
      [
        '---',
        'name: stuck-agent',
        'tier: strategic',
        'provider: codex',
        'model: fake/model',
        'thinking: low',
        '---',
        '',
        '# stuck-agent',
        '',
        'Answer the question.',
        '',
      ].join('\n'),
      'utf8',
    )
    fs.mkdirSync(workspacePath, { recursive: true })

    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({ title: 'Post first' })
    const turnId = randomUUID()
    const assignmentId = randomUUID()
    await sessionStore.appendChatMessageIfAbsent(session.id, {
      id: `${turnId}:user`,
      role: 'user',
      text: 'The question nobody answered.',
      createdAt: '2026-08-31T09:00:00.000Z',
      turnId,
      turnRequest: { fingerprint: 'seeded', expectedReplies: 1 },
    })
    await seedAbandonedTurn({
      workspacePath,
      sessionId: session.id,
      turnId,
      assignmentId,
    })

    const owner = {
      kind: 'run-session' as const,
      conversationId: session.id,
      sessionId: session.id,
    }
    const retentionRoot = conversationRetentionRoot({ workspacePath, owner })
    assert.ok(retentionRoot)

    let server: StartedApiServer | undefined
    try {
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: new FileSystemSessionStore(workspacePath),
        repoRootPath: projectRoot,
        workspacePath,
      })

      // Straight to POST. The new turn's own outcome is not this test's
      // subject — there is no provider configured for it — but the abandoned
      // turn beside it must be settled by the time the request is answered.
      await fetch(`${server.url}/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'A brand new question.',
          target: { kind: 'agents', agentNames: ['stuck-agent'] },
        }),
      })

      const after = await readRetentionDocument(retentionRoot)
      assert.ok(after !== 'damaged')
      assert.ok(
        !after.openTurnIds.has(turnId),
        'posting released the abandoned turn’s admission slot',
      )
    } finally {
      await server?.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
