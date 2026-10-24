/**
 * A selected-agent turn whose provider never settles must end, durably.
 *
 * The incident this covers left `agent.turn.started` on the assignment, a
 * `conversation.turn.started` above it, no assistant message, and an admission
 * slot held open forever. From Chat it read as a turn that was still thinking,
 * for as long as anybody cared to wait.
 *
 * The journey here is the live half of that: the provider call is entered and
 * never comes back. What must happen is that the turn stops waiting, both
 * journals reach a terminal that names the interruption rather than inventing
 * an answer, the admission slot goes back, and the provider is asked exactly
 * once.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import type { ChatMessage, SessionSummary } from '../../contracts/sessions.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { resolveAgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import {
  conversationRetentionRoot,
  readRetentionDocument,
} from '../../services/conversation-terminal-ledger.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import type { AgentTurnSummary } from '../../domains/agent-execution/agent-turn-journal.js'
import {
  reduceConversationTurnStream,
  type ConversationTurnSummary,
} from '../../domains/conversations/conversation-turn-journal.js'
import type { AgentTextStreamFrame } from '../../contracts/agent-text-stream.js'
import { seedChatSessionStore } from '../helpers/chat-session-store-fixture.js'

initProviders()

const SESSION: SessionSummary = {
  id: 'unused',
  title: 'interrupted',
  status: 'active',
  activityType: 'chat',
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
}

interface Harness {
  readonly sessionId: string
  readonly repoRootPath: string
  readonly workspacePath: string
  readonly messages: ChatMessage[]
  readonly assignmentIds: string[]
  readonly hub: AgentTextStreamHub
  readonly sessionStore: Parameters<typeof runSessionAgentChatTurn>[0]['sessionStore']
  resolveRecorder: NonNullable<
    Parameters<typeof runSessionAgentChatTurn>[0]['agentTurnJournal']
  >
  resolveConversationRecorder: NonNullable<
    Parameters<typeof runSessionAgentChatTurn>[0]['conversationJournal']
  >
  agentTurnSummary(turnId: string): Promise<AgentTurnSummary | null>
  conversationTurnSummary(turnId: string): Promise<ConversationTurnSummary>
  openTurnIds(): Promise<readonly string[]>
  cleanup(): Promise<void>
}

function makeHarness(): Harness {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-interrupted-')),
  )
  const repoRootPath = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(path.join(repoRootPath, 'agents'), { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), {
    recursive: true,
  })

  const messages: ChatMessage[] = []
  const assignmentIds: string[] = []
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const conversationRegistry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const owner = {
    kind: 'run-session' as const,
    conversationId: sessionId,
    sessionId,
  }

  const realStore = seedChatSessionStore(workspacePath, sessionId)
  const ensureAssignment = realStore.ensureAgentChatAssignment.bind(realStore)
  const sessionStore = Object.assign(realStore, {
    listChatMessages: async () => [...messages],
    appendChatMessageIfAbsent: async (_id: string, message: ChatMessage) => {
      messages.push(message)
      return 'appended' as const
    },
    ensureAgentChatAssignment: async (
      id: string,
      runId: string,
      assignmentId: string,
    ) => {
      const location = await ensureAssignment(id, runId, assignmentId)
      assignmentIds.push(assignmentId)
      return location
    },
    updateSessionTitle: async () => null,
    listFiles: async () => [],
  })

  return {
    sessionId,
    repoRootPath,
    workspacePath,
    messages,
    assignmentIds,
    hub: new AgentTextStreamHub(),
    sessionStore,
    resolveRecorder: (input) =>
      resolveAgentTurnJournalRecorder({
        registry,
        scope: input.scope,
        agentPath: input.agentPath,
        requestId: randomUUID(),
        processIdentity: 'agent-chat-interrupted-test',
      }),
    resolveConversationRecorder: (input) =>
      resolveConversationTurnJournalRecorder({
        registry: conversationRegistry,
        owner,
        turnId: input.turnId,
        workspacePath,
      }),
    agentTurnSummary: async (turnId: string) => {
      const assignmentId = assignmentIds.at(-1)
      if (assignmentId === undefined) return null
      const recorder = await resolveAgentTurnJournalRecorder({
        registry,
        scope: { sessionId, runId: turnId, assignmentId },
        agentPath: 'agents/stuck-agent',
        requestId: randomUUID(),
        processIdentity: 'agent-chat-interrupted-test',
      })
      if (!recorder) return null
      try {
        return await recorder.readSummary()
      } finally {
        await recorder.release()
      }
    },
    conversationTurnSummary: async (turnId: string) => {
      const snapshot = await conversationRegistry.snapshot({
        owner,
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
    },
    openTurnIds: async () => {
      const root = conversationRetentionRoot({ workspacePath, owner })
      if (!root) return []
      const stored = await readRetentionDocument(root)
      return stored === 'damaged' ? [] : [...stored.openTurnIds]
    },
    cleanup: async () => {
      await registry.close()
      await conversationRegistry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

function writeAgent(repoRootPath: string, name: string): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'tier: strategic',
      'provider: codex',
      'model: fake/model',
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
      'Answer the question.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * A provider that enters the call and never comes back on its own.
 *
 * Deliberately not a rejection: a provider that throws already reaches the
 * existing fallback path, and the outcome this journey is about is the one
 * where nothing is ever returned. It settles only when the abort it is given
 * fires, which is what the deadline is supposed to make happen.
 */
function hangingMcpService() {
  let calls = 0
  let announceEntry: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    announceEntry = resolve
  })
  return {
    calls: () => calls,
    /** Settles the moment the provider is entered; no polling required. */
    entered,
    service: {
      runTurn: (input: { readonly signal?: AbortSignal }) => {
        calls += 1
        announceEntry()
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error('The provider call was aborted.'))
          if (input.signal?.aborted) {
            abort()
            return
          }
          input.signal?.addEventListener('abort', abort, { once: true })
        })
      },
    },
  }
}

function framesOf(
  hub: AgentTextStreamHub,
  channelId: string,
): AgentTextStreamFrame[] {
  return [...(hub.read(channelId, 0)?.frames ?? [])]
}

test(
  'a provider that never settles ends the turn as a durable interruption',
  { timeout: 20_000 },
  async () => {
    const harness = makeHarness()
    const turnId = randomUUID()
    const provider = hangingMcpService()
    try {
      writeAgent(harness.repoRootPath, 'stuck-agent')

      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Please answer.',
          agentNames: ['stuck-agent'],
          turnId,
          mcpAgentToolService: provider.service as never,
          agentTurnJournal: harness.resolveRecorder,
          conversationJournal: harness.resolveConversationRecorder,
          textStreamHub: harness.hub,
          // Injected so the policy ceiling is a value, not a hard-coded wait.
          providerDeadlineMs: 250,
          providerCleanupBudgetMs: 100,
        }),
        'the turn settles instead of waiting on the provider forever',
      )

      assert.equal(provider.calls(), 1, 'the provider was asked exactly once')

      const agentTurn = await harness.agentTurnSummary(turnId)
      assert.equal(agentTurn?.state, 'failed')
      assert.equal(agentTurn?.failure?.serviceCode, 'provider_interrupted')
      assert.equal(
        agentTurn?.assistantMessageId,
        undefined,
        'nothing was answered, so no reply may be claimed',
      )

      const conversationTurn = await harness.conversationTurnSummary(turnId)
      assert.equal(conversationTurn.state, 'failed')
      assert.deepEqual(
        conversationTurn.failure,
        { code: 'provider_interrupted', phase: 'provider' },
        'nobody observed a failure; the turn simply stopped being watched',
      )

      assert.deepEqual(
        await harness.openTurnIds(),
        [],
        'the admission slot was released',
      )

      assert.equal(
        harness.messages.filter((message) => message.role === 'assistant').length,
        0,
        'an interruption is never written as an assistant answer',
      )

      const terminal = framesOf(harness.hub, turnId).at(-1)
      assert.ok(terminal, 'the reply channel published a terminal')
    } finally {
      await harness.cleanup()
    }
  },
)

/**
 * A provider that ignores its abort signal entirely.
 *
 * The deadline path above settles because the provider honours the abort. This
 * one settles for nobody, which is what makes it the right fixture for asking
 * whether the *turn* stops waiting rather than whether the provider does.
 */
function unstoppableMcpService() {
  let calls = 0
  let announceEntry: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    announceEntry = resolve
  })
  return {
    calls: () => calls,
    /** Settles the moment the provider is entered; no polling required. */
    entered,
    service: {
      runTurn: () => {
        calls += 1
        announceEntry()
        return new Promise<never>(() => {})
      },
    },
  }
}

test(
  'a cancelled turn settles promptly even when the provider ignores the abort',
  { timeout: 15_000 },
  async () => {
    const harness = makeHarness()
    const turnId = randomUUID()
    const provider = unstoppableMcpService()
    const caller = new AbortController()
    try {
      writeAgent(harness.repoRootPath, 'stuck-agent')

      const turn = runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Please answer.',
        agentNames: ['stuck-agent'],
        turnId,
        mcpAgentToolService: provider.service as never,
        agentTurnJournal: harness.resolveRecorder,
        conversationJournal: harness.resolveConversationRecorder,
        textStreamHub: harness.hub,
        signal: caller.signal,
        // Far beyond this test's own patience: only the cancellation can end
        // this turn, so a pass cannot come from the deadline firing instead.
        providerDeadlineMs: 600_000,
        // The unwind never happens here, so the budget is what the turn waits
        // out. Injected small so the suite pays milliseconds to prove a bound
        // that is minutes-shaped in production.
        providerCleanupBudgetMs: 100,
      })

      // Withdrawn once the provider has genuinely been entered, so this is a
      // cancellation of work in flight rather than a race with the setup. The
      // fixture says when that happened; nothing here waits on a clock.
      await provider.entered
      caller.abort()

      await assert.rejects(turn, 'the cancelled turn settles')

      const agentTurn = await harness.agentTurnSummary(turnId)
      assert.equal(
        agentTurn?.state,
        'cancelled',
        'a withdrawal is the user’s decision, not an interruption',
      )

      const conversationTurn = await harness.conversationTurnSummary(turnId)
      assert.equal(conversationTurn.state, 'cancelled')

      assert.deepEqual(
        await harness.openTurnIds(),
        [],
        'the admission slot was released',
      )
    } finally {
      await harness.cleanup()
    }
  },
)

/**
 * A provider that notices the abort and then answers anyway.
 *
 * Real adapters settle a moment after they are told to stop, and some of them
 * settle with a complete answer they had already produced. The user has
 * already withdrawn: publishing that answer would put a reply on the
 * transcript for a turn they cancelled, and close their bubble with content
 * they never waited for.
 */
function lateAnsweringMcpService() {
  let calls = 0
  let announceEntry: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    announceEntry = resolve
  })
  return {
    calls: () => calls,
    /** Settles the moment the provider is entered; no polling required. */
    entered,
    service: {
      runTurn: (input: { readonly signal?: AbortSignal }) => {
        calls += 1
        announceEntry()
        return new Promise<unknown>((resolve) => {
          const answerAnyway = () =>
            setTimeout(
              () =>
                resolve({
                  kind: 'completed',
                  providerSupport: {
                    provider: 'codex',
                    state: 'supported',
                    mode: 'native-tool-loop',
                  },
                  route: 'mcp-native',
                  result: {
                    text: 'An answer produced after the user gave up.',
                    model: 'fake/model',
                    toolCallCount: 0,
                    executedToolCallCount: 0,
                  },
                  availableToolCount: 1,
                  artifacts: [],
                }),
              10,
            )
          if (input.signal?.aborted) {
            answerAnyway()
            return
          }
          input.signal?.addEventListener('abort', answerAnyway, { once: true })
        })
      },
    },
  }
}

test(
  'a reply that arrives after the user cancelled is not published',
  { timeout: 15_000 },
  async () => {
    const harness = makeHarness()
    const turnId = randomUUID()
    const provider = lateAnsweringMcpService()
    const caller = new AbortController()
    try {
      writeAgent(harness.repoRootPath, 'stuck-agent')

      const turn = runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Please answer.',
        agentNames: ['stuck-agent'],
        turnId,
        mcpAgentToolService: provider.service as never,
        agentTurnJournal: harness.resolveRecorder,
        conversationJournal: harness.resolveConversationRecorder,
        textStreamHub: harness.hub,
        signal: caller.signal,
        providerDeadlineMs: 600_000,
        // Generous, so the late answer lands well inside the window rather
        // than being excluded by a budget that expired first.
        providerCleanupBudgetMs: 5_000,
      })

      await provider.entered
      caller.abort()

      await assert.rejects(turn, 'a cancelled turn does not succeed')

      assert.equal(
        harness.messages.filter((message) => message.role === 'assistant').length,
        0,
        'nothing the user cancelled reaches the transcript',
      )

      const agentTurn = await harness.agentTurnSummary(turnId)
      assert.equal(agentTurn?.state, 'cancelled')

      const conversationTurn = await harness.conversationTurnSummary(turnId)
      assert.equal(conversationTurn.state, 'cancelled')
    } finally {
      await harness.cleanup()
    }
  },
)

test(
  'a turn whose caller withdrew before it began never reaches the provider',
  { timeout: 15_000 },
  async () => {
    // A client can go away between opening the connection and the turn
    // reaching its provider. Entering the call anyway spends a provider
    // request — and, on a tool-capable route, runs whatever side effects that
    // request causes — for an answer nobody is waiting for.
    const harness = makeHarness()
    const turnId = randomUUID()
    const provider = hangingMcpService()
    const caller = new AbortController()
    caller.abort()
    try {
      writeAgent(harness.repoRootPath, 'stuck-agent')

      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Please answer.',
          agentNames: ['stuck-agent'],
          turnId,
          mcpAgentToolService: provider.service as never,
          agentTurnJournal: harness.resolveRecorder,
          conversationJournal: harness.resolveConversationRecorder,
          textStreamHub: harness.hub,
          signal: caller.signal,
          providerDeadlineMs: 600_000,
          providerCleanupBudgetMs: 100,
        }),
      )

      assert.equal(
        provider.calls(),
        0,
        'a withdrawn turn spends no provider request',
      )

      const agentTurn = await harness.agentTurnSummary(turnId)
      assert.equal(agentTurn?.state, 'cancelled')
    } finally {
      await harness.cleanup()
    }
  },
)

/**
 * A provider that never settles, and says when it was told to stop.
 *
 * The signal it receives is the turn's own, so its abort is the deadline
 * firing. That is the only moment from which the window this test is about can
 * be entered deliberately.
 */
function abortAnnouncingMcpService() {
  let calls = 0
  let announce: () => void = () => undefined
  const aborted = new Promise<void>((resolve) => {
    announce = resolve
  })
  return {
    calls: () => calls,
    aborted,
    service: {
      runTurn: (input: { readonly signal?: AbortSignal }) => {
        calls += 1
        input.signal?.addEventListener('abort', () => announce(), { once: true })
        return new Promise<never>(() => {})
      },
    },
  }
}

test(
  'a caller who leaves after the deadline fired does not relabel the interruption',
  { timeout: 15_000 },
  async () => {
    // Both endings can land on the same turn: the deadline decides it, and the
    // user closes the tab a moment later while it is unwinding. Classification
    // read the signal at recording time rather than the cause that ended the
    // turn, so this durably became a cancellation — losing the interruption,
    // and with it the "Response interrupted" status and its Retry.
    const harness = makeHarness()
    const turnId = randomUUID()
    const provider = abortAnnouncingMcpService()
    const caller = new AbortController()
    try {
      writeAgent(harness.repoRootPath, 'stuck-agent')

      const turn = runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Please answer.',
        agentNames: ['stuck-agent'],
        turnId,
        mcpAgentToolService: provider.service as never,
        agentTurnJournal: harness.resolveRecorder,
        conversationJournal: harness.resolveConversationRecorder,
        textStreamHub: harness.hub,
        signal: caller.signal,
        providerDeadlineMs: 150,
        // Long enough that the withdrawal below lands inside the unwind rather
        // than after the turn has already recorded its ending.
        providerCleanupBudgetMs: 3_000,
      })

      // The deadline has fired; the turn is now unwinding.
      await provider.aborted
      caller.abort()

      await assert.rejects(turn)

      const agentTurn = await harness.agentTurnSummary(turnId)
      assert.equal(agentTurn?.state, 'failed')
      assert.equal(
        agentTurn?.failure?.serviceCode,
        'provider_interrupted',
        'the ending belongs to whatever actually ended the turn',
      )

      const conversationTurn = await harness.conversationTurnSummary(turnId)
      assert.equal(conversationTurn.state, 'failed')
      assert.deepEqual(conversationTurn.failure, {
        code: 'provider_interrupted',
        phase: 'provider',
      })
    } finally {
      await harness.cleanup()
    }
  },
)
