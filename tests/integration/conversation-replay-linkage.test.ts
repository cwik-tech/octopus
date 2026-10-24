/**
 * A replay returns the answer this turn already gave, or refuses.
 *
 * "Already gave" has to mean the exact thing the lifecycle recorded. Matching on
 * turn id alone meant any same-turn message satisfied it: a transcript holding a
 * different user message, or a different reply, or the right replies in the
 * wrong order, all read as a clean replay — and the caller was handed an answer
 * the journal never agreed to.
 *
 * The journal names the user message, the request digest, how many replies were
 * expected and which replies they were. A replay is a match on all of it, and
 * anything else is two authorities disagreeing, which is corruption.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createRunPlan } from '../../domains/run-orchestrator/orchestrator.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { CONVERSATION_TURN_STREAM_KIND } from '../../domains/conversations/conversation-turn-journal.js'
import { UNTITLED_SESSION_TITLE } from '../../domains/sessions/session-title.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import {
  receptionistRequestFingerprint,
  runSessionMessageTurn,
} from '../../services/session-service.js'
import { ServiceError } from '../../services/service-errors.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import type { ChatMessage } from '../../contracts/sessions.js'

const CASE_TIMEOUT_MS = 20_000
const DIGEST_TEXT = 'replay me'

function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  return { directory, workspacePath }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

/**
 * A turn that completed, built through the real recorder and store.
 *
 * The transcript lines are written directly so the test can then change exactly
 * one of the things the journal named, which is the whole point.
 */
async function completedTurn(input: {
  readonly workspacePath: string
  readonly registry: WorkspaceConversationJournalRegistry
  readonly sessionId: string
  readonly turnId: string
  readonly store: FileSystemSessionStore
  readonly assistantIds: readonly string[]
}): Promise<{ userMessageId: string; fingerprint: string }> {
  const recorder = await resolveConversationTurnJournalRecorder({
    registry: input.registry,
    owner: owner(input.sessionId),
    turnId: input.turnId,
    workspacePath: input.workspacePath,
  })
  assert.ok(recorder)
  const userMessageId = `${input.turnId}:user`
  // The same fingerprint the service will compute for this request, so the
  // replay path is exercised rather than the reused-identity refusal.
  const fingerprint = receptionistRequestFingerprint({ text: DIGEST_TEXT })
  await recorder.recordStarted({
    surface: 'run-receptionist',
    userMessageId,
    requestDigest: fingerprint,
    expectedResponseCount: input.assistantIds.length,
    origin: 'client',
  })
  await recorder.recordPrepared({ assistantMessageIds: input.assistantIds })
  await recorder.recordCompleted({ assistantMessageIds: input.assistantIds })
  await recorder.release()

  const line = (overrides: Partial<ChatMessage>): ChatMessage => ({
    id: 'unset',
    role: 'assistant',
    text: 'answered',
    createdAt: '2026-08-26T00:00:00.000Z',
    turnId: input.turnId,
    ...overrides,
  })
  assert.equal(
    await input.store.appendChatMessageIfAbsent(
      input.sessionId,
      line({
        id: userMessageId,
        role: 'user',
        text: DIGEST_TEXT,
        turnRequest: {
          fingerprint,
          expectedReplies: input.assistantIds.length,
        },
      }),
    ),
    'appended',
  )
  for (const assistantId of input.assistantIds) {
    assert.equal(
      await input.store.appendChatMessageIfAbsent(
        input.sessionId,
        line({ id: assistantId }),
      ),
      'appended',
    )
  }
  // A completed turn always leaves a plan behind; a replay reads it back.
  assert.equal(
    await input.store.saveRunPlan(
      input.sessionId,
      createRunPlan({ goal: DIGEST_TEXT, workflows: [] }),
    ),
    true,
  )
  return { userMessageId, fingerprint }
}

async function replay(input: {
  readonly workspacePath: string
  readonly registry: WorkspaceConversationJournalRegistry
  readonly store: FileSystemSessionStore
  readonly sessionId: string
  readonly turnId: string
}): Promise<unknown> {
  const session = await input.store.getSession(input.sessionId)
  assert.ok(session)
  const recorder = await resolveConversationTurnJournalRecorder({
    registry: input.registry,
    owner: owner(input.sessionId),
    turnId: input.turnId,
    workspacePath: input.workspacePath,
  })
  try {
    return await runSessionMessageTurn({
      sessionId: input.sessionId,
      session,
      sessionStore: input.store,
      text: DIGEST_TEXT,
      workflows: [],
      workflowEntries: [],
      turnId: input.turnId,
      ...(recorder ? { conversationRecorder: recorder } : {}),
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
  } finally {
    await recorder?.release()
  }
}

/**
 * A refusal is a named refusal.
 *
 * Matching the message alone would pass for any error whose text happens to
 * contain the reason, including one raised somewhere else entirely.
 */
function assertConflict(error: unknown, reason: string): void {
  assert.ok(
    error instanceof ServiceError,
    `expected a ServiceError, saw ${String(error)}`,
  )
  assert.equal(error.code, 'conflict')
  assert.equal(error.message, reason)
}

/**
 * Put a line into the durable transcript that the journal never named.
 *
 * Written to the file rather than through the store, because the store is what
 * refuses to write a second line for a turn — and the case under test is a
 * transcript that already holds one, however it got there.
 */
function insertTranscriptLine(input: {
  readonly chatPath: string
  readonly line: Record<string, unknown>
  readonly placement: 'before' | 'after'
}): void {
  const lines = fs.readFileSync(input.chatPath, 'utf8').trim().split('\n')
  const stray = JSON.stringify(input.line)
  const next =
    input.placement === 'before'
      ? [...lines.slice(0, 1), stray, ...lines.slice(1)]
      : [...lines, stray]
  fs.writeFileSync(input.chatPath, `${next.join('\n')}\n`)
}

test(
  'a replay must match the reply the journal named, not merely a reply',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('replay-linkage-')
    const store = new FileSystemSessionStore(workspacePath)
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const session = await store.createSession({ title: 'linkage' })
      const turnId = randomUUID()
      const named = `${turnId}:assistant:0`
      await completedTurn({
        workspacePath,
        registry,
        sessionId: session.id,
        turnId,
        store,
        assistantIds: [named],
      })

      // Another reply on the same turn, which the journal never named. Finding
      // "an assistant message with this turn id" is satisfied by it.
      const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
      const lines = fs.readFileSync(chatPath, 'utf8').trim().split('\n')
      fs.writeFileSync(
        chatPath,
        `${[
          ...lines.filter((line) => !line.includes(`"${named}"`)),
          JSON.stringify({
            id: `${turnId}:assistant:99`,
            role: 'assistant',
            text: 'an answer nobody recorded',
            createdAt: '2026-08-26T00:00:00.000Z',
            turnId,
          }),
        ].join('\n')}\n`,
      )

      const error = await replay({
        workspacePath,
        registry,
        store,
        sessionId: session.id,
        turnId,
      })
      assert.ok(error instanceof Error)
      assert.match(
        error.message,
        /turn_corrupt/,
        'the reply the journal named is gone, so the two authorities disagree',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a replay of a turn whose journal and transcript agree still returns it',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('replay-agree-')
    const store = new FileSystemSessionStore(workspacePath)
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const session = await store.createSession({ title: 'agree' })
      const turnId = randomUUID()
      await completedTurn({
        workspacePath,
        registry,
        sessionId: session.id,
        turnId,
        store,
        assistantIds: [`${turnId}:assistant:0`],
      })

      const error = await replay({
        workspacePath,
        registry,
        store,
        sessionId: session.id,
        turnId,
      })
      assert.equal(error, undefined, `a clean replay must not fail: ${String(error)}`)

      // And it did not run the turn again.
      const registryReader = new WorkspaceConversationJournalRegistry({
        workspacePath,
        tenantId: 'local',
        mode: 'authoritative',
      })
      const snapshot = await registryReader.snapshot({
        owner: owner(session.id),
        activityId: turnId,
        activityKind: 'turn',
      })
      await registryReader.close()
      assert.equal(snapshot.kind, 'read')
      if (snapshot.kind !== 'read') return
      assert.deepEqual(
        snapshot.events
          .filter((event) => event.streamKind === CONVERSATION_TURN_STREAM_KIND)
          .map((event) => event.type),
        [
          'conversation.turn.started',
          'conversation.turn.prepared',
          'conversation.turn.completed',
        ],
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a turn that only started never completes itself from a stray reply',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('replay-started-')
    const store = new FileSystemSessionStore(workspacePath)
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const session = await store.createSession({ title: 'started only' })
      const turnId = randomUUID()
      const fingerprint = receptionistRequestFingerprint({ text: DIGEST_TEXT })

      // Started, and nothing else. There is no durable preparation, so nothing
      // ever named a reply.
      const recorder = await resolveConversationTurnJournalRecorder({
        registry,
        owner: owner(session.id),
        turnId,
        workspacePath,
      })
      assert.ok(recorder)
      await recorder.recordStarted({
        surface: 'run-receptionist',
        userMessageId: `${turnId}:user`,
        requestDigest: fingerprint,
        expectedResponseCount: 1,
        origin: 'client',
      })
      await recorder.release()

      const line = (overrides: Partial<ChatMessage>): ChatMessage => ({
        id: 'unset',
        role: 'assistant',
        text: 'answered',
        createdAt: '2026-08-26T00:00:00.000Z',
        turnId,
        ...overrides,
      })
      assert.equal(
        await store.appendChatMessageIfAbsent(
          session.id,
          line({
            id: `${turnId}:user`,
            role: 'user',
            text: DIGEST_TEXT,
            turnRequest: { fingerprint, expectedReplies: 1 },
          }),
        ),
        'appended',
      )
      // A reply in the transcript that the lifecycle never named. Completing
      // the turn over it would make the journal agree with a claim it never
      // made.
      assert.equal(
        await store.appendChatMessageIfAbsent(
          session.id,
          line({ id: `${turnId}:assistant:0` }),
        ),
        'appended',
      )

      const error = await replay({
        workspacePath,
        registry,
        store,
        sessionId: session.id,
        turnId,
      })
      assert.equal(error instanceof ServiceError, true)
      const failure = error instanceof ServiceError ? error : undefined
      assert.ok(failure)
      assert.equal(failure.code, 'conflict')
      assert.equal(
        failure.message,
        'turn_corrupt',
        'a reply nothing prepared contradicts the lifecycle rather than closing it',
      )

      // And the journal is untouched: no terminal was appended over it.
      const snapshot = await registry.snapshot({
        owner: owner(session.id),
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.equal(snapshot.kind, 'read')
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



/**
 * A loopback chat-completions endpoint.
 *
 * The receptionist and the title generator both reach a model over HTTP, so a
 * real turn needs a real endpoint. Two separate servers keep the two calls
 * distinguishable without inspecting request bodies: whatever arrives here
 * arrived for this one purpose.
 */
async function chatCompletionsServer(input: {
  readonly content: string
  readonly onRequest?: () => void
}): Promise<{ url: string; requests: number; close: () => Promise<void> }> {
  const state = { requests: 0 }
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      state.requests += 1
      input.onRequest?.()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          model: 'loopback-model',
          choices: [{ message: { content: input.content } }],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    get requests() {
      return state.requests
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
}

test(
  'a title that cannot be produced does not fail an answer already published',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace('title-fault-')
    const store = new FileSystemSessionStore(workspacePath)
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    // The session lock lives outside the session directory, so replacing the
    // directory that holds it with a file is a fault only the title update can
    // hit: everything this turn writes has already taken and released its lock
    // by the time a title is asked for.
    const locksPath = path.join(workspacePath, 'sessions', '.locks')
    const poison = () => {
      fs.rmSync(locksPath, { recursive: true, force: true })
      fs.writeFileSync(locksPath, '')
    }
    const previousKey = process.env.OPENAI_API_KEY
    const previousChatUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    const receptionist = await chatCompletionsServer({
      content: JSON.stringify({
        reply: 'Here is the answer you asked for.',
        launchIntent: 'none',
        requiredInputs: [],
      }),
    })
    // Naming happens after the reply is durable and the lifecycle says
    // completed, so the fault is armed at the moment the title is requested and
    // not one step earlier.
    const titleModel = await chatCompletionsServer({
      content: 'Naming After The Answer',
      onRequest: poison,
    })
    process.env.OPENAI_API_KEY = 'test-title-fault-key'
    process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = receptionist.url
    // The title helper owns no agent, so it runs on the one application
    // default and on nothing else. Pointing that default at the loopback is
    // how this fault is armed now; there is no separate title endpoint to
    // configure, because a second model source is exactly what was removed.
    const titleConnectionId = randomUUID()
    setConfiguredProviderConnections([
      {
        id: titleConnectionId,
        kind: 'openai-compatible',
        name: 'Title loopback',
        baseUrl: `${titleModel.url}/v1`,
        apiKey: 'test-title-fault-key',
      },
    ])
    setRuntimeDefaultModelState({
      status: 'available',
      provider: `connection:${titleConnectionId}`,
      model: 'fixture/title',
    })

    // An untitled session is the only kind a turn tries to name.
    const session = await store.createSession()
    assert.equal(session.title, UNTITLED_SESSION_TITLE)
    const turnId = randomUUID()
    const recorder = await resolveConversationTurnJournalRecorder({
      registry,
      owner: owner(session.id),
      turnId,
      workspacePath,
    })
    assert.ok(recorder)
    try {
      const result = await runSessionMessageTurn({
        sessionId: session.id,
        session,
        sessionStore: store,
        text: DIGEST_TEXT,
        workflows: [],
        workflowEntries: [],
        turnId,
        provider: 'openai',
        conversationRecorder: recorder,
      })

      assert.equal(titleModel.requests, 1, 'the title path actually ran')
      // The fault is live rather than assumed: the same call the turn just made
      // still fails while the poison stands.
      await assert.rejects(
        store.updateSessionTitle(session.id, 'Naming After The Answer'),
        'naming the session is genuinely impossible in this window',
      )

      // The caller is handed the answer, not a failure.
      assert.equal(result.replayed, undefined)
      assert.ok(result.assistant.text.length > 0)
      // The session comes back as it stands, and what it says is that it was
      // not renamed. Asserting it were simply absent would enshrine a missing
      // notice: the turn did record which model was about to name this session,
      // and a person has to be able to see that even though the naming failed.
      assert.ok(result.session, 'the session as it stands is still returned')
      assert.equal(
        result.session.title,
        UNTITLED_SESSION_TITLE,
        'and no renamed session is claimed',
      )
      assert.equal((result.session.titleAttempts ?? []).length, 1)

      // The reply is where the user will find it.
      const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')
      const persisted = fs
        .readFileSync(chatPath, 'utf8')
        .split('\n')
        .filter((entry) => entry.trim().length > 0)
        .map((entry): unknown => JSON.parse(entry))
      assert.ok(
        persisted.some(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            Reflect.get(entry, 'id') === result.assistant.id,
        ),
        'the assistant message the caller was handed is in the transcript',
      )

      // And the lifecycle agrees the turn completed.
      const snapshot = await registry.snapshot({
        owner: owner(session.id),
        activityId: turnId,
        activityKind: 'turn',
      })
      assert.equal(snapshot.kind, 'read')
      assert.deepEqual(
        snapshot.kind === 'read' ? snapshot.events.map((event) => event.type) : [],
        [
          'conversation.turn.started',
          'conversation.turn.prepared',
          'conversation.turn.completed',
        ],
      )
    } finally {
      fs.rmSync(locksPath, { recursive: true, force: true })
      await recorder.release()
      await registry.close()
      await receptionist.close()
      await titleModel.close()
      restoreEnvironment('OPENAI_API_KEY', previousKey)
      restoreEnvironment('WORKFLOW_GENERATOR_OPENAI_API_URL', previousChatUrl)
      setConfiguredProviderConnections([])
      setRuntimeDefaultModelState(undefined)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a replay refuses a transcript holding a reply the journal never named',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // An extra same-turn reply is not a lookup problem — the named reply is
    // still there and still found. It is an idempotency problem: the caller is
    // handed one answer while the transcript holds two, and the second is
    // dropped silently every time the request is retried.
    for (const placement of ['before', 'after'] as const) {
      const { directory, workspacePath } = makeWorkspace(`replay-extra-${placement}-`)
      const store = new FileSystemSessionStore(workspacePath)
      const registry = new WorkspaceConversationJournalRegistry({
        workspacePath,
        tenantId: 'local',
        mode: 'authoritative',
      })
      try {
        const session = await store.createSession({ title: 'extra reply' })
        const turnId = randomUUID()
        await completedTurn({
          workspacePath,
          registry,
          sessionId: session.id,
          turnId,
          store,
          assistantIds: [`${turnId}:assistant:0`],
        })
        insertTranscriptLine({
          chatPath: path.join(workspacePath, 'sessions', session.id, 'chat.jsonl'),
          placement,
          line: {
            id: `${turnId}:assistant:99`,
            role: 'assistant',
            text: 'a reply the lifecycle never agreed to',
            createdAt: '2026-08-26T00:00:00.000Z',
            turnId,
          },
        })

        assertConflict(
          await replay({
            workspacePath,
            registry,
            store,
            sessionId: session.id,
            turnId,
          }),
          'turn_corrupt',
        )
      } finally {
        await registry.close()
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  },
)

test(
  'a replay refuses a transcript holding a second user line for the same turn',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // Two user messages under one turn id means the request the journal
    // fingerprinted is not the only request recorded under it. Reading the
    // first and ignoring the rest answers whichever one happened to be written
    // first, which is not authority.
    for (const placement of ['before', 'after'] as const) {
      const { directory, workspacePath } = makeWorkspace(`replay-two-users-${placement}-`)
      const store = new FileSystemSessionStore(workspacePath)
      const registry = new WorkspaceConversationJournalRegistry({
        workspacePath,
        tenantId: 'local',
        mode: 'authoritative',
      })
      try {
        const session = await store.createSession({ title: 'two users' })
        const turnId = randomUUID()
        const { fingerprint } = await completedTurn({
          workspacePath,
          registry,
          sessionId: session.id,
          turnId,
          store,
          assistantIds: [`${turnId}:assistant:0`],
        })
        insertTranscriptLine({
          chatPath: path.join(workspacePath, 'sessions', session.id, 'chat.jsonl'),
          placement,
          line: {
            id: `${turnId}:user:99`,
            role: 'user',
            text: DIGEST_TEXT,
            createdAt: '2026-08-26T00:00:00.000Z',
            turnId,
            turnRequest: { fingerprint, expectedReplies: 1 },
          },
        })

        assertConflict(
          await replay({
            workspacePath,
            registry,
            store,
            sessionId: session.id,
            turnId,
          }),
          'turn_corrupt',
        )
      } finally {
        await registry.close()
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  },
)


test(
  'a replay refuses a lifecycle that named more replies than this build writes',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // A Run Receptionist turn produces exactly one reply. A journal claiming
    // two is a lifecycle this build never created, and handing back the first
    // of them drops the second every time — silently, and forever, because a
    // replay never revisits the decision.
    const { directory, workspacePath } = makeWorkspace('replay-multi-reply-')
    const store = new FileSystemSessionStore(workspacePath)
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const session = await store.createSession({ title: 'two replies' })
      const turnId = randomUUID()
      await completedTurn({
        workspacePath,
        registry,
        sessionId: session.id,
        turnId,
        store,
        assistantIds: [`${turnId}:assistant:0`, `${turnId}:assistant:1`],
      })

      assertConflict(
        await replay({
          workspacePath,
          registry,
          store,
          sessionId: session.id,
          turnId,
        }),
        'turn_corrupt',
      )
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
