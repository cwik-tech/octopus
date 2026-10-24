/**
 * Where the agent-turn journal is ordered against the transcript.
 *
 * The outer API journey proves one failure. These four prove the orderings it
 * cannot reach on its own: a tool-capable success, a fallback to the direct
 * provider, a reply the session could not keep, and a terminal that never got
 * appended — which must stay `reply_pending` and be reconciled by a retry
 * rather than regenerated.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import type { ChatMessage, SessionSummary } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { McpAgentToolTurnResult } from '../../services/mcp-agent-tool-service.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import type { AgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import { resolveAgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import {
  resolveConversationTurnJournalRecorder,
  type ConversationTurnJournalRecorder,
} from '../../services/conversation-turn-journal-recorder.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

initProviders()

const SESSION: SessionSummary = {
  id: 'unused',
  title: 'lifecycle',
  status: 'active',
  activityType: 'chat',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
}

interface Harness {
  readonly sessionId: string
  readonly repoRootPath: string
  readonly workspacePath: string
  readonly messages: ChatMessage[]
  readonly assignmentIds: string[]
  /** Journal opens and closes, observed through the registry's own seam. */
  readonly opens: string[]
  readonly closes: string[]
  readonly sessionStore: Parameters<typeof runSessionAgentChatTurn>[0]['sessionStore']
  resolveRecorder(input: {
    readonly scope: {
      readonly sessionId: string
      readonly runId: string
      readonly assignmentId: string
    }
    readonly agentPath: string
  }): Promise<AgentTurnJournalRecorder | undefined>
  /** The turn-level aggregate, on a real per-activity conversation journal. */
  resolveConversationRecorder(
    turnId: string,
  ): Promise<ConversationTurnJournalRecorder | undefined>
  cleanup(): Promise<void>
}

function makeHarness(options: {
  readonly failAssistantPersistence?: boolean
  /** Fail every assistant append past this many successful ones. */
  readonly assistantPersistenceLimit?: number
} = {}): Harness {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-turn-lifecycle-')),
  )
  const repoRootPath = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(path.join(repoRootPath, 'agents'), { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })
  const sessionId = randomUUID()
  const messages: ChatMessage[] = []
  const assignmentIds: string[] = []
  const opens: string[] = []
  const closes: string[] = []
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
    journalOpener: async ({ scopeRoot, identity }) => {
      opens.push(identity.scopeId)
      const journal = await initializeExecutionJournal({ scopeRoot, identity })
      return {
        manifest: journal.manifest,
        journalDirectoryPath: journal.journalDirectoryPath,
        append: (appendInput) => journal.append(appendInput),
        scan: () => journal.scan(),
        scanStream: (streamKind, streamId) =>
          journal.scanStream(streamKind, streamId),
        getMetrics: () => journal.getMetrics(),
        isRetired: () => journal.isRetired(),
        close: async () => {
          await journal.close()
          closes.push(identity.scopeId)
        },
      }
    },
  })

  // Use the real store for session ownership and assignment paths. This
  // synchronous fixture seeds a valid session before the async turn begins.
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(workspacePath, 'sessions', sessionId, 'session.json'),
    JSON.stringify({ ...SESSION, id: sessionId }),
  )
  const conversationRegistry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })

  const realStore = new FileSystemSessionStore(workspacePath)
  const ensureAgentChatAssignment = realStore.ensureAgentChatAssignment.bind(realStore)
  // The existing transcript fault seam keeps journal failure-ordering tests
  // deterministic; new session claims use the real filesystem store.
  const sessionStore = Object.assign(realStore, {
    listChatMessages: async () => [...messages],
    appendChatMessageIfAbsent: async (_id: string, message: ChatMessage) => {
      if (message.role === 'assistant') {
        const stored = messages.filter(
          (candidate) => candidate.role === 'assistant',
        ).length
        if (
          options.failAssistantPersistence ||
          (options.assistantPersistenceLimit !== undefined &&
            stored >= options.assistantPersistenceLimit)
        ) {
          throw new Error('The assistant message could not be written.')
        }
      }
      messages.push(message)
      return 'appended' as const
    },
    ensureAgentChatAssignment: async (
      id: string,
      runId: string,
      assignmentId: string,
    ) => {
      const location = await ensureAgentChatAssignment(id, runId, assignmentId)
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
    opens,
    closes,
    sessionStore,
    resolveRecorder: (input) =>
      resolveAgentTurnJournalRecorder({
        registry,
        scope: input.scope,
        agentPath: input.agentPath,
        requestId: randomUUID(),
        processIdentity: 'agent-turn-lifecycle-test',
      }),
    resolveConversationRecorder: (turnId) =>
      resolveConversationTurnJournalRecorder({
        registry: conversationRegistry,
        owner: { kind: 'run-session', conversationId: sessionId, sessionId },
        turnId,
      }),
    cleanup: async () => {
      await registry.close()
      await conversationRegistry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

function writeAgent(repoRootPath: string, name: string, provider: string): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'tier: strategic',
      `provider: ${provider}`,
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

async function withConfiguredProvider<T>(
  run: (providerName: string, requestCount: () => number) => Promise<T>,
): Promise<T> {
  const server = await startFakeChatCompletionsServer({
    script: [{ content: 'A complete answer.' }],
  })
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Lifecycle provider',
      baseUrl: `${server.url}/v1`,
      apiKey: 'lifecycle-key',
    },
  ])
  try {
    return await run(
      `connection:${connectionId}`,
      () => server.requests.length,
    )
  } finally {
    setConfiguredProviderConnections([])
    await server.close()
  }
}

/** An MCP service stub: only `runTurn` is ever called by the chat service. */
function mcpService(result: McpAgentToolTurnResult) {
  let calls = 0
  return {
    calls: () => calls,
    service: {
      runTurn: async () => {
        calls += 1
        return result
      },
    },
  }
}

const SUPPORTED = {
  provider: 'connection:lifecycle',
  state: 'supported',
  mode: 'native-tool-loop',
} as const

test('a tool-capable reply that was stored ends as completed on the mcp-native route', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeAgent(harness.repoRootPath, 'tool-agent', providerName)
      const mcp = mcpService({
        kind: 'completed',
        providerSupport: SUPPORTED,
        route: 'mcp-native',
        result: {
          text: 'Tools were used and this is the answer.',
          model: 'fake/resolved',
          toolCallCount: 2,
          executedToolCallCount: 2,
          usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
        },
        availableToolCount: 4,
        artifacts: [],
      })

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Use your tools.',
        agentNames: ['tool-agent'],
        turnId,
        mcpAgentToolService: mcp.service,
        agentTurnJournal: harness.resolveRecorder,
      })

      assert.equal(mcp.calls(), 1)
    })

    const summary = await readSummary(harness, turnId)
    assert.equal(summary?.state, 'completed')
    assert.equal(summary?.route, 'mcp-native')
    assert.equal(summary?.model, 'fake/resolved')
    assert.equal(
      summary?.assistantMessageId,
      harness.messages.find((message) => message.role === 'assistant')?.id,
    )
  } finally {
    await harness.cleanup()
  }
})

test('a no-tools route that falls back to the direct provider is journaled as direct-provider', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName, requestCount) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      const mcp = mcpService({ kind: 'no-tools', providerSupport: SUPPORTED })

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Just answer.',
        agentNames: ['plain-agent'],
        turnId,
        mcpAgentToolService: mcp.service,
        agentTurnJournal: harness.resolveRecorder,
      })

      assert.ok(requestCount() > 0, 'the direct provider really answered')
    })

    const summary = await readSummary(harness, turnId)
    assert.equal(summary?.state, 'completed')
    assert.equal(summary?.route, 'direct-provider')
  } finally {
    await harness.cleanup()
  }
})

test('a reply the session could not keep is failed, never completed', async () => {
  const harness = makeHarness({ failAssistantPersistence: true })
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Just answer.',
          agentNames: ['plain-agent'],
          turnId,
          agentTurnJournal: harness.resolveRecorder,
        }),
      )
    })

    const summary = await readSummary(harness, turnId)
    assert.equal(summary?.state, 'failed')
    assert.equal(
      summary?.assistantMessageId,
      undefined,
      'nothing was stored, so no reply may be claimed',
    )
    assert.equal(summary?.failure?.layer, 'chat-persistence')
    assert.equal(summary?.failure?.phase, 'assistant-persistence')
  } finally {
    await harness.cleanup()
  }
})

test('a persisted reply whose terminal never landed stays reply_pending and a retry reconciles it', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  let providerRequests = 0
  try {
    await withConfiguredProvider(async (providerName, requestCount) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      // The terminal append fails exactly once, after the reply is stored.
      let terminalsRefused = 0
      const flakyJournal: Harness['resolveRecorder'] = async (input) => {
        const recorder = await harness.resolveRecorder(input)
        if (!recorder) return undefined
        return {
          ...recorder,
          assignmentId: recorder.assignmentId,
          recordStarted: (started) => recorder.recordStarted(started),
          recordPrepared: (prepared) => recorder.recordPrepared(prepared),
          recordPassed: (passed) => recorder.recordPassed(passed),
          recordCompleted: async (completed) => {
            terminalsRefused += 1
            if (terminalsRefused === 1) {
              throw new Error('The terminal append did not reach the journal.')
            }
            await recorder.recordCompleted(completed)
          },
          recordFailed: (failed) => recorder.recordFailed(failed),
          recordCancelled: (cancelled) => recorder.recordCancelled(cancelled),
          readSummary: () => recorder.readSummary(),
          release: () => recorder.release(),
        }
      }

      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Just answer.',
          agentNames: ['plain-agent'],
          turnId,
          agentTurnJournal: flakyJournal,
        }),
        /terminal append/,
      )

      const stranded = await readSummary(harness, turnId)
      assert.equal(stranded?.state, 'reply_pending')
      assert.ok(
        stranded?.assistantMessageId,
        'the prepared event names the reply that was meant to be stored',
      )
      assert.equal(
        harness.messages.filter((message) => message.role === 'assistant').length,
        1,
        'the reply itself is durable',
      )

      providerRequests = requestCount()

      // The retry carries the same turnId, so chat idempotency replays it.
      const replay = await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Just answer.',
        agentNames: ['plain-agent'],
        turnId,
        agentTurnJournal: flakyJournal,
      })

      assert.equal(replay.replayed, true)
      assert.equal(replay.replies.length, 1)
      assert.equal(
        requestCount(),
        providerRequests,
        'reconciliation asks the provider nothing',
      )
    })

    const summary = await readSummary(harness, turnId)
    assert.equal(summary?.state, 'completed')
  } finally {
    await harness.cleanup()
  }
})

test('a turn aborted while the provider is answering is journaled as cancelled', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  const controller = new AbortController()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      const mcp = {
        runTurn: async () => {
          controller.abort()
          throw new Error('aborted while answering')
        },
      }

      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Just answer.',
          agentNames: ['plain-agent'],
          turnId,
          signal: controller.signal,
          mcpAgentToolService: mcp,
          agentTurnJournal: harness.resolveRecorder,
        }),
      )
    })

    const summary = await readSummary(harness, turnId)
    assert.equal(summary?.state, 'cancelled')
    assert.equal(
      harness.messages.some((message) => message.role === 'assistant'),
      false,
      'a cancelled turn stored no reply',
    )
  } finally {
    await harness.cleanup()
  }
})

test('lease cleanup cannot replace the failure that ended the chat turn', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  const controller = new AbortController()
  const providerFailure = new Error('provider aborted while answering')
  const recorder: AgentTurnJournalRecorder = {
    assignmentId: randomUUID(),
    recordStarted: async () => undefined,
    recordPrepared: async () => undefined,
    recordCompleted: async () => undefined,
    recordPassed: async () => undefined,
    recordFailed: async () => undefined,
    recordCancelled: async () => undefined,
    readSummary: async () => null,
    release: async () => {
      throw new Error('journal lease cleanup failed')
    },
  }
  try {
    await withConfiguredProvider(async (providerName) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Just answer.',
          agentNames: ['plain-agent'],
          turnId,
          signal: controller.signal,
          mcpAgentToolService: {
            runTurn: async () => {
              controller.abort()
              throw providerFailure
            },
          },
          agentTurnJournal: async () => recorder,
        }),
        (error: unknown) => error === providerFailure,
      )
    })
  } finally {
    await harness.cleanup()
  }
})

async function readSummary(harness: Harness, turnId: string) {
  const assignmentId = harness.assignmentIds.at(-1)
  assert.ok(assignmentId, 'the turn created an assignment')
  const recorder = await harness.resolveRecorder({
    scope: { sessionId: harness.sessionId, runId: turnId, assignmentId },
    agentPath: 'agents/plain-agent',
  })
  assert.ok(recorder)
  return recorder.readSummary()
}

test("a provider's own retry policy is journaled, not re-derived from its kind", async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      const mcp = {
        runTurn: async (): Promise<McpAgentToolTurnResult> => {
          // The shape `providers/openai.ts` raises for a response it could not
          // read: no recognizable kind, but explicitly worth retrying.
          throw new ProviderError({
            provider: 'openai',
            message: 'Unreadable provider response.',
            retryable: true,
          })
        },
      }

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Just answer.',
        agentNames: ['plain-agent'],
        turnId,
        mcpAgentToolService: mcp,
        agentTurnJournal: harness.resolveRecorder,
      })
    })

    const summary = await readSummary(harness, turnId)
    assert.equal(summary?.state, 'failed')
    assert.equal(
      summary?.failure?.retryable,
      true,
      'the provider said this was retryable; the journal must not disagree',
    )
  } finally {
    await harness.cleanup()
  }
})

test('a stranded reply in a turn that never finished its roster is still reconciled', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeAgent(harness.repoRootPath, 'first-agent', providerName)
      writeAgent(harness.repoRootPath, 'second-agent', providerName)
      let terminalsRefused = 0
      const flakyJournal: Harness['resolveRecorder'] = async (input) => {
        const recorder = await harness.resolveRecorder(input)
        if (!recorder) return undefined
        return {
          ...recorder,
          assignmentId: recorder.assignmentId,
          recordStarted: (started) => recorder.recordStarted(started),
          recordPrepared: (prepared) => recorder.recordPrepared(prepared),
          recordPassed: (passed) => recorder.recordPassed(passed),
          recordCompleted: async (completed) => {
            terminalsRefused += 1
            if (terminalsRefused === 1) {
              throw new Error('The terminal append did not reach the journal.')
            }
            await recorder.recordCompleted(completed)
          },
          recordFailed: (failed) => recorder.recordFailed(failed),
          recordCancelled: (cancelled) => recorder.recordCancelled(cancelled),
          readSummary: () => recorder.readSummary(),
          release: () => recorder.release(),
        }
      }

      // The first reply is stored, its terminal is refused, and the second
      // speaker never runs — so the roster is incomplete on every retry.
      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Both of you answer.',
          agentNames: ['first-agent', 'second-agent'],
          turnId,
          agentTurnJournal: flakyJournal,
        }),
        /terminal append/,
      )

      const strandedAssignment = harness.assignmentIds[0]
      assert.ok(strandedAssignment)
      assert.equal(
        (await summaryFor(harness, turnId, strandedAssignment))?.state,
        'reply_pending',
      )

      const replay = await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Both of you answer.',
        agentNames: ['first-agent', 'second-agent'],
        turnId,
        agentTurnJournal: flakyJournal,
      })

      assert.equal(replay.replayed, true)
      assert.equal(replay.incomplete, true, 'the roster is still unfinished')
      assert.equal(
        (await summaryFor(harness, turnId, strandedAssignment))?.state,
        'completed',
        'the reply that was stored is no longer stranded',
      )
    })
  } finally {
    await harness.cleanup()
  }
})

async function summaryFor(
  harness: Harness,
  turnId: string,
  assignmentId: string,
) {
  const recorder = await harness.resolveRecorder({
    scope: { sessionId: harness.sessionId, runId: turnId, assignmentId },
    agentPath: 'agents/first-agent',
  })
  assert.ok(recorder)
  return recorder.readSummary()
}

/**
 * A chat assignment never reaches the terminal transition that closes a task's
 * journal, so the turn itself has to give the handle back. Otherwise every
 * selected-agent reply leaves an open journal, its index, and a descriptor
 * behind for the life of the process.
 */
for (const scenario of [
  { name: 'a completed reply', mode: 'completed' as const },
  { name: 'a failed reply', mode: 'failed' as const },
  { name: 'a cancelled turn', mode: 'cancelled' as const },
]) {
  test(`${scenario.name} gives its journal handle back`, async () => {
    const harness = makeHarness()
    const turnId = randomUUID()
    const controller = new AbortController()
    try {
      await withConfiguredProvider(async (providerName) => {
        writeAgent(harness.repoRootPath, 'plain-agent', providerName)
        const runTurn = async (): Promise<McpAgentToolTurnResult> => {
          if (scenario.mode === 'cancelled') {
            controller.abort()
            throw new Error('aborted while answering')
          }
          if (scenario.mode === 'failed') {
            throw new ProviderError({
              provider: 'openai',
              message: 'refused',
              retryable: false,
            })
          }
          return { kind: 'no-tools', providerSupport: SUPPORTED }
        }
        const call = runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Just answer.',
          agentNames: ['plain-agent'],
          turnId,
          mcpAgentToolService: { runTurn },
          agentTurnJournal: harness.resolveRecorder,
          ...(scenario.mode === 'cancelled'
            ? { signal: controller.signal }
            : {}),
        })
        if (scenario.mode === 'cancelled') await assert.rejects(call)
        else await call
      })

      const assignmentId = harness.assignmentIds.at(-1)
      assert.ok(assignmentId)
      assert.deepEqual(
        harness.closes,
        [assignmentId],
        'the turn closed exactly the journal it opened',
      )
    } finally {
      await harness.cleanup()
    }
  })
}

test('a reconciling replay gives its journal handle back too', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName, requestCount) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      let terminalsRefused = 0
      const flakyJournal: Harness['resolveRecorder'] = async (input) => {
        const recorder = await harness.resolveRecorder(input)
        if (!recorder) return undefined
        return {
          ...recorder,
          assignmentId: recorder.assignmentId,
          recordStarted: (started) => recorder.recordStarted(started),
          recordPrepared: (prepared) => recorder.recordPrepared(prepared),
          recordPassed: (passed) => recorder.recordPassed(passed),
          recordCompleted: async (completed) => {
            terminalsRefused += 1
            if (terminalsRefused === 1) {
              throw new Error('The terminal append did not reach the journal.')
            }
            await recorder.recordCompleted(completed)
          },
          recordFailed: (failed) => recorder.recordFailed(failed),
          recordCancelled: (cancelled) => recorder.recordCancelled(cancelled),
          readSummary: () => recorder.readSummary(),
          release: () => recorder.release(),
        }
      }

      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Just answer.',
          agentNames: ['plain-agent'],
          turnId,
          agentTurnJournal: flakyJournal,
        }),
        /terminal append/,
      )
      const afterFirstTurn = requestCount()
      const assignmentId = harness.assignmentIds.at(-1)
      assert.ok(assignmentId)
      assert.deepEqual(harness.closes, [assignmentId])

      const replay = await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.sessionStore,
        repoRootPath: harness.repoRootPath,
        text: 'Just answer.',
        agentNames: ['plain-agent'],
        turnId,
        agentTurnJournal: flakyJournal,
      })

      assert.equal(replay.replayed, true)
      assert.equal(requestCount(), afterFirstTurn, 'no second provider call')
      // Reopened to reconcile, then handed back again.
      assert.deepEqual(harness.opens, [assignmentId, assignmentId])
      assert.deepEqual(harness.closes, [assignmentId, assignmentId])
    })
  } finally {
    await harness.cleanup()
  }
})

/**
 * What the turn-level record says when a multi-speaker turn goes wrong.
 *
 * Each reply's own `agent.turn` already says what that speaker did. These two
 * prove the aggregate above them: a turn that publishes one reply and loses the
 * other must say exactly that rather than reading as a whole turn that failed,
 * and a turn whose ending never landed must be closed by the next replay
 * instead of staying open forever.
 */
async function readConversationSummary(harness: Harness, turnId: string) {
  const recorder = await harness.resolveConversationRecorder(turnId)
  assert.ok(recorder, 'the conversation activity exists')
  try {
    return await recorder.readSummary()
  } finally {
    await recorder.release()
  }
}

function conversationJournalPath(harness: Harness, turnId: string): string {
  return path.join(
    harness.workspacePath,
    'sessions',
    harness.sessionId,
    '.conversation-activities',
    turnId,
    '.runtime',
    'execution-journal',
    'journal.jsonl',
  )
}

async function runTwoSpeakerTurn(input: {
  readonly harness: Harness
  readonly turnId: string
  readonly providerName: string
}): Promise<void> {
  writeAgent(input.harness.repoRootPath, 'alpha-agent', input.providerName)
  writeAgent(input.harness.repoRootPath, 'beta-agent', input.providerName)
  const recorder = await input.harness.resolveConversationRecorder(input.turnId)
  assert.ok(recorder)
  try {
    await runSessionAgentChatTurn({
      sessionId: input.harness.sessionId,
      session: SESSION,
      sessionStore: input.harness.sessionStore,
      repoRootPath: input.harness.repoRootPath,
      text: 'Both of you, answer.',
      agentNames: ['alpha-agent', 'beta-agent'],
      turnId: input.turnId,
      agentTurnJournal: input.harness.resolveRecorder,
      conversationJournal: async () => recorder,
    })
  } finally {
    await recorder.release()
  }
}

test('a two-speaker turn that loses its second reply keeps both links and names only the first', async () => {
  const harness = makeHarness({ assistantPersistenceLimit: 1 })
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      await assert.rejects(
        runTwoSpeakerTurn({ harness, turnId, providerName }),
      )
    })

    const summary = await readConversationSummary(harness, turnId)
    assert.equal(summary.state, 'failed')
    assert.deepEqual(summary.failure, {
      code: 'reply_not_published',
      phase: 'publication',
    })
    assert.deepEqual(
      summary.assistantMessageIds,
      [`${turnId}:assistant:0`],
      'only the reply the transcript kept is claimed',
    )
    assert.equal(
      summary.assignments?.length,
      2,
      'both assignments ran, so both stay reachable from the turn',
    )
    assert.deepEqual(
      summary.assignments?.map((link) => link.assistantMessageId),
      [`${turnId}:assistant:0`, `${turnId}:assistant:1`],
      'the lost reply is still linked to the assignment that tried to produce it',
    )
    assert.deepEqual(
      summary.assignments?.map((link) => link.assignmentId),
      harness.assignmentIds,
      'the links name the assignments this turn actually created',
    )
  } finally {
    await harness.cleanup()
  }
})

test('a turn whose aggregate terminal never landed is completed by the next replay', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      await runTwoSpeakerTurn({ harness, turnId, providerName })

      // The crash: both replies are durable and the turn's ending is not.
      const journalPath = conversationJournalPath(harness, turnId)
      const kept = fs
        .readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(0, 2)
      fs.writeFileSync(journalPath, `${kept.join('\n')}\n`, 'utf8')
      assert.equal(
        (await readConversationSummary(harness, turnId)).state,
        'prepared',
        'the turn reads as still publishing',
      )

      const replayRecorder = await harness.resolveConversationRecorder(turnId)
      assert.ok(replayRecorder)
      try {
        const replay = await runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Both of you, answer.',
          agentNames: ['alpha-agent', 'beta-agent'],
          turnId,
          agentTurnJournal: harness.resolveRecorder,
          conversationJournal: async () => replayRecorder,
        })
        assert.equal(replay.replayed, true)
        assert.equal(replay.replies.length, 2)
      } finally {
        await replayRecorder.release()
      }
    })

    const summary = await readConversationSummary(harness, turnId)
    assert.equal(
      summary.state,
      'completed',
      'the replay closes the turn from what the transcript proves',
    )
    assert.deepEqual(summary.assistantMessageIds, [
      `${turnId}:assistant:0`,
      `${turnId}:assistant:1`,
    ])
  } finally {
    await harness.cleanup()
  }
})

test('a reply the transcript kept is named by the aggregate even when its own terminal failed', async () => {
  // The two journals fail independently. A reply can be durable in
  // `chat.jsonl` while the assignment's `agent.turn` terminal never lands —
  // that window already exists and is reconciled by a retry. What must not
  // happen is the turn-level record denying the reply on the strength of the
  // other journal's failure: the aggregate answers for publication, and
  // publication succeeded.
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName, requestCount) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      let terminalsRefused = 0
      const flakyJournal: Harness['resolveRecorder'] = async (input) => {
        const recorder = await harness.resolveRecorder(input)
        if (!recorder) return undefined
        return {
          ...recorder,
          assignmentId: recorder.assignmentId,
          recordStarted: (started) => recorder.recordStarted(started),
          recordPrepared: (prepared) => recorder.recordPrepared(prepared),
          recordPassed: (passed) => recorder.recordPassed(passed),
          recordCompleted: async (completed) => {
            terminalsRefused += 1
            if (terminalsRefused === 1) {
              throw new Error('The terminal append did not reach the journal.')
            }
            await recorder.recordCompleted(completed)
          },
          recordFailed: (failed) => recorder.recordFailed(failed),
          recordCancelled: (cancelled) => recorder.recordCancelled(cancelled),
          readSummary: () => recorder.readSummary(),
          release: () => recorder.release(),
        }
      }

      const recorder = await harness.resolveConversationRecorder(turnId)
      assert.ok(recorder)
      try {
        await assert.rejects(
          runSessionAgentChatTurn({
            sessionId: harness.sessionId,
            session: SESSION,
            sessionStore: harness.sessionStore,
            repoRootPath: harness.repoRootPath,
            text: 'Just answer.',
            agentNames: ['plain-agent'],
            turnId,
            agentTurnJournal: flakyJournal,
            conversationJournal: async () => recorder,
          }),
          /terminal append/,
        )
      } finally {
        await recorder.release()
      }

      assert.equal(
        harness.messages.filter((message) => message.role === 'assistant').length,
        1,
        'the reply itself is durable',
      )

      const stranded = await readConversationSummary(harness, turnId)
      assert.deepEqual(
        stranded.assistantMessageIds,
        [`${turnId}:assistant:0`],
        'the aggregate names the reply the transcript actually holds',
      )
      assert.equal(
        stranded.state,
        'completed',
        'every reply this turn claimed reached the transcript, so publication finished',
      )

      const providerRequests = requestCount()
      const replayRecorder = await harness.resolveConversationRecorder(turnId)
      assert.ok(replayRecorder)
      try {
        const replay = await runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Just answer.',
          agentNames: ['plain-agent'],
          turnId,
          agentTurnJournal: flakyJournal,
          conversationJournal: async () => replayRecorder,
        })
        assert.equal(replay.replayed, true)
        assert.equal(replay.replies.length, 1)
        assert.equal(
          requestCount(),
          providerRequests,
          'reconciliation asks the provider nothing',
        )
      } finally {
        await replayRecorder.release()
      }
    })

    // The replay repairs the assignment journal and leaves the aggregate as it
    // found it: one lifecycle, appended once.
    assert.equal((await readSummary(harness, turnId))?.state, 'completed')
    const summary = await readConversationSummary(harness, turnId)
    assert.equal(summary.state, 'completed')
    assert.deepEqual(summary.assistantMessageIds, [`${turnId}:assistant:0`])
    assert.deepEqual(
      fs
        .readFileSync(conversationJournalPath(harness, turnId), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => (JSON.parse(line) as { type: string }).type),
      [
        'conversation.turn.started',
        'conversation.turn.prepared',
        'conversation.turn.completed',
      ],
      'a replay must not append a second lifecycle',
    )
  } finally {
    await harness.cleanup()
  }
})

/**
 * A recorder whose lease refuses to come back.
 *
 * Every method delegates except `release`. Methods live on the prototype, so
 * they are listed rather than spread: a spread copies the instance's own
 * fields and silently produces an object with no behaviour at all.
 */
function refusingRelease(underlying: ConversationTurnJournalRecorder): {
  readonly recorder: ConversationTurnJournalRecorder
  attempts(): number
} {
  let attempts = 0
  return {
    attempts: () => attempts,
    recorder: {
      recordStarted: (input) => underlying.recordStarted(input),
      recordPrepared: (input) => underlying.recordPrepared(input),
      recordCompleted: (input) => underlying.recordCompleted(input),
      recordFailed: (input) => underlying.recordFailed(input),
      recordCancelled: (input) => underlying.recordCancelled(input),
      readSummary: () => underlying.readSummary(),
      abandon: () => underlying.abandon(),
      release: async () => {
        attempts += 1
        throw new Error('The journal lease could not be released.')
      },
    },
  }
}

/**
 * Capture what the process log was told, so "swallowed" can be told apart from
 * "silently dropped". A cleanup fault that reaches nobody is not handled.
 */
function captureProcessWarnings(): {
  lines(): readonly string[]
  restore(): void
} {
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return Reflect.apply(original, process.stderr, [chunk, ...rest])
  }) as typeof process.stderr.write
  return {
    lines: () => written,
    restore: () => {
      process.stderr.write = original
    },
  }
}

test('a lease that refuses to come back does not replace the failure the turn is already reporting', async () => {
  // Cleanup runs in a `finally`, and a throw there replaces whatever exception
  // was in flight. The caller would be told the lease could not be released
  // for a turn that actually failed to store its reply — the one fact they
  // needed, overwritten by a fault about housekeeping.
  const harness = makeHarness({ assistantPersistenceLimit: 0 })
  const turnId = randomUUID()
  const warnings = captureProcessWarnings()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      const underlying = await harness.resolveConversationRecorder(turnId)
      assert.ok(underlying)
      const refusing = refusingRelease(underlying)
      try {
        await assert.rejects(
          runSessionAgentChatTurn({
            sessionId: harness.sessionId,
            session: SESSION,
            sessionStore: harness.sessionStore,
            repoRootPath: harness.repoRootPath,
            text: 'Just answer.',
            agentNames: ['plain-agent'],
            turnId,
            agentTurnJournal: harness.resolveRecorder,
            conversationJournal: async () => refusing.recorder,
          }),
          /The assistant message could not be written/,
          'the caller receives why the turn failed, not why its lease stuck',
        )
        assert.ok(
          refusing.attempts() >= 1,
          'the lease was still handed back on the failure path',
        )
        assert.ok(
          warnings
            .lines()
            .some((line) => line.includes('conversation journal lease not released')),
          'the cleanup fault is reported rather than discarded',
        )
      } finally {
        await underlying.release()
      }
    })

    // The turn's own ending is unaffected: it failed before any reply was
    // durable, and that is what the record says.
    const summary = await readConversationSummary(harness, turnId)
    assert.equal(summary.state, 'failed')
    assert.deepEqual(summary.assistantMessageIds, [])
  } finally {
    warnings.restore()
    await harness.cleanup()
  }
})

test('a lease that refuses to come back still fails a turn that otherwise succeeded', async () => {
  // The other half of the same decision, pinned deliberately. With no failure
  // to preserve there is nothing to mask, so the cleanup fault is the only
  // thing that went wrong and the caller hears about it — the same rule the
  // per-reply journal already follows.
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeAgent(harness.repoRootPath, 'plain-agent', providerName)
      const underlying = await harness.resolveConversationRecorder(turnId)
      assert.ok(underlying)
      const refusing = refusingRelease(underlying)
      try {
        await assert.rejects(
          runSessionAgentChatTurn({
            sessionId: harness.sessionId,
            session: SESSION,
            sessionStore: harness.sessionStore,
            repoRootPath: harness.repoRootPath,
            text: 'Just answer.',
            agentNames: ['plain-agent'],
            turnId,
            agentTurnJournal: harness.resolveRecorder,
            conversationJournal: async () => refusing.recorder,
          }),
          /The journal lease could not be released/,
        )
      } finally {
        await underlying.release()
      }
    })

    // The reply was published before cleanup ran, so the record says so.
    assert.equal(
      harness.messages.filter((message) => message.role === 'assistant').length,
      1,
    )
    const summary = await readConversationSummary(harness, turnId)
    assert.equal(summary.state, 'completed')
  } finally {
    await harness.cleanup()
  }
})

/**
 * A recorder that cannot read its own stream, and optionally cannot be given
 * back either. Methods are listed rather than spread, for the same reason as
 * above: behaviour lives on the prototype.
 */
function unreadableAggregate(
  underlying: ConversationTurnJournalRecorder,
  options: { readonly refuseRelease?: boolean } = {},
): { readonly recorder: ConversationTurnJournalRecorder; releases(): number } {
  let releases = 0
  return {
    releases: () => releases,
    recorder: {
      recordStarted: (input) => underlying.recordStarted(input),
      recordPrepared: (input) => underlying.recordPrepared(input),
      recordCompleted: (input) => underlying.recordCompleted(input),
      recordFailed: (input) => underlying.recordFailed(input),
      recordCancelled: (input) => underlying.recordCancelled(input),
      readSummary: async () => {
        throw new Error('The activity journal could not be read.')
      },
      abandon: () => underlying.abandon(),
      release: async () => {
        releases += 1
        if (options.refuseRelease) {
          throw new Error('The journal lease could not be released.')
        }
        await underlying.release()
      },
    },
  }
}

/** Publish one durable single-speaker turn, so the next request is a replay. */
async function publishReplayableTurn(input: {
  readonly harness: Harness
  readonly turnId: string
  readonly providerName: string
}): Promise<void> {
  writeAgent(input.harness.repoRootPath, 'plain-agent', input.providerName)
  const recorder = await input.harness.resolveConversationRecorder(input.turnId)
  assert.ok(recorder)
  try {
    await runSessionAgentChatTurn({
      sessionId: input.harness.sessionId,
      session: SESSION,
      sessionStore: input.harness.sessionStore,
      repoRootPath: input.harness.repoRootPath,
      text: 'Just answer.',
      agentNames: ['plain-agent'],
      turnId: input.turnId,
      agentTurnJournal: input.harness.resolveRecorder,
      conversationJournal: async () => recorder,
    })
  } finally {
    await recorder.release()
  }
}

function replayTurn(input: {
  readonly harness: Harness
  readonly turnId: string
  readonly recorder: ConversationTurnJournalRecorder
}): Promise<unknown> {
  return runSessionAgentChatTurn({
    sessionId: input.harness.sessionId,
    session: SESSION,
    sessionStore: input.harness.sessionStore,
    repoRootPath: input.harness.repoRootPath,
    text: 'Just answer.',
    agentNames: ['plain-agent'],
    turnId: input.turnId,
    agentTurnJournal: input.harness.resolveRecorder,
    conversationJournal: async () => input.recorder,
  })
}

test('a replay that cannot read the aggregate journal fails instead of reporting success', async () => {
  // Swallowing the read made a replay indistinguishable from one that
  // reconciled: the caller was told the turn replayed cleanly while the record
  // that decides whether it needs closing could not be opened at all. The
  // per-reply reconciliation beside it has always propagated this.
  const harness = makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      await publishReplayableTurn({ harness, turnId, providerName })

      const underlying = await harness.resolveConversationRecorder(turnId)
      assert.ok(underlying)
      const unreadable = unreadableAggregate(underlying)
      try {
        await assert.rejects(
          replayTurn({ harness, turnId, recorder: unreadable.recorder }),
          /The activity journal could not be read/,
          'an aggregate nobody can read is not a reconciled aggregate',
        )
      } finally {
        await underlying.release()
      }
    })
  } finally {
    await harness.cleanup()
  }
})

test('a replay keeps its reconciliation failure when the lease also refuses to come back', async () => {
  const harness = makeHarness()
  const turnId = randomUUID()
  const warnings = captureProcessWarnings()
  try {
    await withConfiguredProvider(async (providerName) => {
      await publishReplayableTurn({ harness, turnId, providerName })

      const underlying = await harness.resolveConversationRecorder(turnId)
      assert.ok(underlying)
      const unreadable = unreadableAggregate(underlying, { refuseRelease: true })
      try {
        await assert.rejects(
          replayTurn({ harness, turnId, recorder: unreadable.recorder }),
          /The activity journal could not be read/,
          'the caller receives why reconciliation failed, not why its lease stuck',
        )
        assert.ok(
          unreadable.releases() >= 1,
          'the lease was still handed back on the failure path',
        )
        assert.ok(
          warnings
            .lines()
            .some((line) => line.includes('conversation journal lease not released')),
          'the cleanup fault is reported rather than discarded',
        )
      } finally {
        await underlying.release()
      }
    })
  } finally {
    warnings.restore()
    await harness.cleanup()
  }
})

test('an activity that could not be abandoned is reported, and does not replace the turn failure', async () => {
  // The turn fails before its start barrier, so the activity it opened holds
  // nothing and is given back. That cleanup can fail on its own, and when it
  // does it is a fact about the workspace worth saying out loud — but never
  // the answer the caller gets.
  const harness = makeHarness()
  const turnId = randomUUID()
  const warnings = captureProcessWarnings()
  try {
    const underlying = await harness.resolveConversationRecorder(turnId)
    assert.ok(underlying)
    const refusing: ConversationTurnJournalRecorder = {
      recordStarted: (input) => underlying.recordStarted(input),
      recordPrepared: (input) => underlying.recordPrepared(input),
      recordCompleted: (input) => underlying.recordCompleted(input),
      recordFailed: (input) => underlying.recordFailed(input),
      recordCancelled: (input) => underlying.recordCancelled(input),
      readSummary: () => underlying.readSummary(),
      abandon: async () => {
        throw new Error('The activity could not be abandoned.')
      },
      release: () => underlying.release(),
    }
    try {
      await assert.rejects(
        runSessionAgentChatTurn({
          sessionId: harness.sessionId,
          session: SESSION,
          sessionStore: harness.sessionStore,
          repoRootPath: harness.repoRootPath,
          text: 'Just answer.',
          agentNames: ['no-such-agent'],
          turnId,
          agentTurnJournal: harness.resolveRecorder,
          conversationJournal: async () => refusing,
        }),
        /Unknown agent/,
        'the caller still learns the roster was wrong',
      )
      assert.ok(
        warnings
          .lines()
          .some((line) => line.includes('conversation activity not abandoned')),
        'a cleanup fault is reported rather than silently discarded',
      )
    } finally {
      await underlying.release()
    }
  } finally {
    warnings.restore()
    await harness.cleanup()
  }
})
