/**
 * A failed explicit model, and one new attempt the user actually approved.
 *
 * Read through the real session store and conversation journal, because the
 * question this answers is not "does the policy compute the right answer" —
 * that is `tests/unit/model-choice-policy.test.ts` — but whether a failure the
 * product recorded produces an offer, and whether approving it starts exactly
 * one attempt on exactly the pair that was shown.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import type { SessionSummary } from '../../contracts/sessions.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import {
  acceptModelChoice,
  offerModelChoiceForTurn,
} from '../../services/agent-model-choice-service.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  agentChatTurnWiring,
  type AgentChatTurnWiring,
} from '../../services/agent-chat-turn-wiring.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import {
  startFakeChatCompletionsServer,
  type FakeChatCompletionsServer,
} from '../support/fake-chat-completions-server.js'

initProviders()

const SESSION: SessionSummary = {
  id: 'unused',
  title: 'default retry',
  status: 'active',
  activityType: 'chat',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
}

interface Harness {
  readonly sessionId: string
  readonly repoRootPath: string
  readonly workspacePath: string
  readonly store: FileSystemSessionStore
  readonly registry: WorkspaceConversationJournalRegistry
  readonly executionRegistry: WorkspaceExecutionJournalRegistry
  /**
   * The production wiring builder's own output.
   *
   * Hand-rolled journals here would let this suite pass against a server route
   * that forwards none of them, which is exactly the gap that shipped.
   */
  readonly turnWiring: AgentChatTurnWiring
  cleanup(): Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-default-retry-')),
  )
  const repoRootPath = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(path.join(repoRootPath, 'agents'), { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'default retry' })
  const registry = new WorkspaceConversationJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const executionRegistry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  return {
    sessionId: session.id,
    repoRootPath,
    workspacePath,
    store,
    registry,
    executionRegistry,
    turnWiring: agentChatTurnWiring({
      workspacePath,
      conversationJournalRegistry: registry,
      executionJournalRegistry: executionRegistry,
    }),
    cleanup: async () => {
      await registry.close()
      await executionRegistry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** An agent pinned to a provider with no credential: it fails before dispatch. */
function writeUncredentialedAgent(repoRootPath: string, name: string): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'provider: anthropic',
      'model: claude-sonnet-4-6',
      'thinking: low',
      '---',
      '',
      'Answer.',
      '',
    ].join('\n'),
    'utf8',
  )
}


/**
 * An agent that fails before dispatch and carries settings of its own.
 *
 * The settings are chosen to span the three cases §4.3 distinguishes: one the
 * approved provider applies, one it does not, and one that names *where* the
 * request goes rather than how the model should answer.
 */
function writeUncredentialedAgentWithOptions(
  repoRootPath: string,
  name: string,
  providerOptions: Record<string, string | number | boolean>,
): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'provider: anthropic',
      'model: claude-sonnet-4-6',
      'thinking: low',
      `provider_options: '${JSON.stringify(providerOptions)}'`,
      '---',
      '',
      'Answer.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function withWorkingDefault<T>(
  run: (
    providerName: string,
    requestCount: () => number,
    requests: FakeChatCompletionsServer['requests'],
  ) => Promise<T>,
): Promise<T> {
  const server = await startFakeChatCompletionsServer({
    script: [{ content: 'An answer from the app default.' }],
  })
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Default provider',
      baseUrl: `${server.url}/v1`,
      apiKey: 'default-key',
    },
  ])
  const providerName = `connection:${connectionId}`
  setRuntimeDefaultModelState({
    status: 'available',
    provider: providerName,
    model: 'default-model',
  })
  try {
    return await run(
      providerName,
      () => server.requests.length,
      server.requests,
    )
  } finally {
    setConfiguredProviderConnections([])
    setRuntimeDefaultModelState({ status: 'unset' })
    await server.close()
  }
}

test('an eligible failure offers the app default, and approving it runs exactly that pair once', async () => {
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    await withWorkingDefault(async (providerName, requestCount) => {
      writeUncredentialedAgent(harness.repoRootPath, 'reviewer')

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        ...harness.turnWiring,
      }).catch(() => undefined)

      // Nothing reached the default while the failure stood on its own.
      assert.equal(requestCount(), 0, 'no request may precede a decision')

      const offer = await offerModelChoiceForTurn({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        sessionStore: harness.store,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
      })

      assert.ok(offer, 'an eligible failure must offer the app default')
      assert.equal(offer.agentName, 'reviewer')
      assert.deepEqual(offer.failedChoice, {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      })
      assert.deepEqual(offer.proposedDefault, {
        provider: providerName,
        model: 'default-model',
      })

      const accepted = await acceptModelChoice({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
        turnWiring: harness.turnWiring,
        acceptance: { offerId: offer.offerId, idempotencyKey: 'approval-1' },
      })

      assert.equal(accepted.ok, true, JSON.stringify(accepted))
      assert.equal(requestCount(), 1, 'approval runs exactly one attempt')

      const messages = await harness.store.listChatMessages(harness.sessionId)
      const retryTurn = messages.find(
        (message) =>
          message.role === 'user' &&
          message.turnId !== failedTurn &&
          message.turnRequest?.admittedSelections !== undefined,
      )
      assert.ok(retryTurn, 'the new attempt must record its own admission')
      assert.deepEqual(retryTurn.turnRequest?.admittedSelections?.reviewer, {
        provider: providerName,
        model: 'default-model',
        source: 'app-default',
        reason: 'user-approved-retry',
        caller: 'agent',
        requestedProvider: 'anthropic',
        requestedModel: 'claude-sonnet-4-6',
      })

      // The original failure is still in the history it belongs to.
      const original = messages.find(
        (message) => message.role === 'user' && message.turnId === failedTurn,
      )
      assert.deepEqual(original?.turnRequest?.admittedSelections?.reviewer, {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        source: 'agent',
        reason: 'explicit-agent-choice',
        caller: 'agent',
      })

      // The agent's own file is untouched: consent covered one attempt.
      assert.match(
        fs.readFileSync(
          path.join(harness.repoRootPath, 'agents', 'reviewer', 'reviewer.md'),
          'utf8',
        ),
        /provider: anthropic\nmodel: claude-sonnet-4-6/,
      )
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})

test('approving the same offer twice starts one attempt', async () => {
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    await withWorkingDefault(async (_providerName, requestCount) => {
      writeUncredentialedAgent(harness.repoRootPath, 'reviewer')
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        ...harness.turnWiring,
      }).catch(() => undefined)

      const offer = await offerModelChoiceForTurn({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        sessionStore: harness.store,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
      })
      assert.ok(offer)

      const accept = () =>
        acceptModelChoice({
          sessionId: harness.sessionId,
          turnId: failedTurn,
          session: SESSION,
          sessionStore: harness.store,
          repoRootPath: harness.repoRootPath,
          conversationRegistry: harness.registry,
          executionRegistry: harness.executionRegistry,
          turnWiring: harness.turnWiring,
          acceptance: { offerId: offer.offerId, idempotencyKey: 'approval-1' },
        })

      const first = await accept()
      const second = await accept()

      assert.equal(first.ok, true)
      // A double click, a retransmitted request, or a stale tab resending the
      // same approval must not pay for a second attempt.
      assert.equal(requestCount(), 1)
      assert.equal(second.ok, true, 'a replay reports the attempt it replays')
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})

test('one offer is spent once, even by a second tab with its own key and its own store', async () => {
  // The approved attempt's turn id is derived from the offer and the client's
  // key, so a second tab that mints a fresh key produces a fresh turn id and
  // the admission machinery finds nothing to replay. Only the offer's own
  // recorded consumption stops the second attempt, and it has to survive a
  // reload — which is what the second store here is.
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    await withWorkingDefault(async (_providerName, requestCount) => {
      writeUncredentialedAgent(harness.repoRootPath, 'reviewer')
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        ...harness.turnWiring,
      }).catch(() => undefined)

      const offer = await offerModelChoiceForTurn({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        sessionStore: harness.store,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
      })
      assert.ok(offer)

      const approve = (idempotencyKey: string, store = harness.store) =>
        acceptModelChoice({
          sessionId: harness.sessionId,
          turnId: failedTurn,
          session: SESSION,
          sessionStore: store,
          repoRootPath: harness.repoRootPath,
          conversationRegistry: harness.registry,
          executionRegistry: harness.executionRegistry,
          turnWiring: harness.turnWiring,
          acceptance: { offerId: offer.offerId, idempotencyKey },
        })

      const first = await approve('approval-from-tab-one')
      assert.equal(first.ok, true, JSON.stringify(first))
      assert.equal(requestCount(), 1)

      const second = await approve(
        'approval-from-tab-two',
        new FileSystemSessionStore(harness.workspacePath),
      )
      assert.equal(second.ok, true, JSON.stringify(second))
      assert.equal(
        second.ok ? second.turnId : '',
        first.ok ? first.turnId : '',
        'the second approval names the attempt the first one started',
      )
      assert.equal(requestCount(), 1, 'the second approval pays for nothing')
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})

test('two approvals racing with different keys start one attempt between them', async () => {
  // Sequential approvals are the easy case: the second one reads the first
  // one's record. Concurrent ones do not — both can read a transcript with no
  // consumption in it, and a check that is a read followed by a write lets
  // both through. Each would then derive its own turn id, persist its own
  // message, and pay for its own provider call.
  //
  // Two independently opened stores, so neither can be answered from the
  // other's cache, and a barrier so both are inside the window at once.
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    await withWorkingDefault(async (_providerName, requestCount) => {
      writeUncredentialedAgent(harness.repoRootPath, 'reviewer')
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        ...harness.turnWiring,
      }).catch(() => undefined)

      const offer = await offerModelChoiceForTurn({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        sessionStore: harness.store,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
      })
      assert.ok(offer)

      let releaseBarrier: () => void = () => {}
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve
      })
      const approve = async (idempotencyKey: string) => {
        await barrier
        return acceptModelChoice({
          sessionId: harness.sessionId,
          turnId: failedTurn,
          session: SESSION,
          sessionStore: new FileSystemSessionStore(harness.workspacePath),
          repoRootPath: harness.repoRootPath,
          conversationRegistry: harness.registry,
          executionRegistry: harness.executionRegistry,
          turnWiring: harness.turnWiring,
          acceptance: { offerId: offer.offerId, idempotencyKey },
        })
      }

      const both = Promise.all([approve('tab-one'), approve('tab-two')])
      releaseBarrier()
      const [first, second] = await both

      // One attempt between them, whichever won, and one provider call.
      assert.equal(requestCount(), 1, 'exactly one attempt was paid for')
      const started = [first, second].filter((result) => result.ok)
      assert.ok(started.length >= 1, 'one approval has to start the attempt')
      const startedTurnIds = new Set(
        started.map((result) => (result.ok ? result.turnId : '')),
      )
      assert.equal(
        startedTurnIds.size,
        1,
        'both approvals must address the same attempt, not two',
      )

      // And exactly one retry turn is on disk.
      const reopened = new FileSystemSessionStore(harness.workspacePath)
      const messages = await reopened.listChatMessages(harness.sessionId)
      const retryTurns = messages.filter(
        (message) =>
          message.role === 'user' &&
          message.turnRequest?.approvedOffer?.offerId === offer.offerId,
      )
      assert.equal(retryTurns.length, 1, 'one offer, one durable attempt')
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})

test('an approval fails closed when nothing can claim the offer exclusively', async () => {
  // The atomic claim behind "one offer, one attempt" is the conversation
  // journal's exclusive turn claim. With journalling disabled there is none:
  // two processes could write byte-identical messages, both be told
  // `already-present`, and both go on to pay for an attempt. Timestamps
  // differing is luck, not a guard, and a shared in-process stream hub is not
  // one either. So an approval refuses rather than running unprotected.
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  const unprotected = new WorkspaceConversationJournalRegistry({
    workspacePath: harness.workspacePath,
    tenantId: 'local',
    mode: 'disabled',
  })
  try {
    await withWorkingDefault(async (_providerName, requestCount) => {
      writeUncredentialedAgent(harness.repoRootPath, 'reviewer')
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        ...harness.turnWiring,
      }).catch(() => undefined)

      const offer = await offerModelChoiceForTurn({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        sessionStore: harness.store,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
      })
      assert.ok(offer, 'the failure is still eligible; only the claim is gone')

      const result = await acceptModelChoice({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        conversationRegistry: unprotected,
        executionRegistry: harness.executionRegistry,
        turnWiring: harness.turnWiring,
        acceptance: { offerId: offer.offerId, idempotencyKey: 'approval-1' },
      })

      assert.equal(result.ok, false)
      assert.equal(!result.ok && result.error.code, 'claim-unavailable')
      assert.equal(requestCount(), 0, 'an unprotected approval pays for nothing')
    })
  } finally {
    await unprotected.close()
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})

test('an approved retry runs the request the user originally sent', async () => {
  // The retry is a second attempt at one request, not a new one. Rebuilding it
  // from the text and the agent alone drops the project context the original
  // turn was sent with, so the model that finally answers is answering a
  // different question from the one that failed.
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  const projectContext = {
    projectId: 'project-alpha',
    includeBrief: false,
    fileNames: [],
  }
  // The narrowest real collaborators the context builder asks for. Enough to
  // let the selection be materialized so this test exercises the same path a
  // real turn does, without standing up a project workspace.
  const projectService = {
    getSession: async () => ({ projectId: 'project-alpha' }),
    getProjectRecord: async () => ({ id: 'project-alpha', status: 'active' }),
  } as unknown as NonNullable<Parameters<typeof runSessionAgentChatTurn>[0]['workspaceProjectService']>
  const contextStore = {
    listFiles: async () => [],
    readBrief: async () => null,
  } as unknown as NonNullable<Parameters<typeof runSessionAgentChatTurn>[0]['workspaceProjectContextStore']>
  try {
    await withWorkingDefault(async () => {
      writeUncredentialedAgent(harness.repoRootPath, 'reviewer')
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        projectContext,
        workspaceProjectService: projectService,
        workspaceProjectContextStore: contextStore,
        ...harness.turnWiring,
      }).catch(() => undefined)

      const original = (await harness.store.listChatMessages(harness.sessionId))
        .find((message) => message.role === 'user' && message.turnId === failedTurn)
      assert.deepEqual(
        original?.turnRequest?.projectContext,
        projectContext,
        'the original turn records the context it was sent with',
      )

      const offer = await offerModelChoiceForTurn({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        sessionStore: harness.store,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
      })
      assert.ok(offer)

      const accepted = await acceptModelChoice({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
        turnWiring: {
          ...harness.turnWiring,
          workspaceProjectService: projectService,
          workspaceProjectContextStore: contextStore,
        },
        acceptance: { offerId: offer.offerId, idempotencyKey: 'approval-1' },
      })
      assert.equal(accepted.ok, true, JSON.stringify(accepted))

      const retry = (await harness.store.listChatMessages(harness.sessionId))
        .find(
          (message) =>
            message.role === 'user' &&
            message.turnRequest?.approvedOffer?.offerId === offer.offerId,
        )
      assert.deepEqual(
        retry?.turnRequest?.projectContext,
        projectContext,
        'the approved attempt carries the original request context',
      )
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})


test('an approved retry keeps the settings its new provider applies, and drops the rest', async () => {
  // §4.3: options are *re-evaluated* for the approved provider. Neither extreme
  // is that. Carrying them all sends a vendor's field to a vendor that has no
  // such field; dropping them all discards settings the new provider applies
  // perfectly well, and does it silently — which a person cannot tell apart
  // from a provider that ignored them.
  //
  // Asserted at the request the provider actually received, because that is the
  // only place the difference is real. A mapping function agreeing with itself
  // proves nothing about what was sent.
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    await withWorkingDefault(async (_providerName, _count, requests) => {
      writeUncredentialedAgentWithOptions(harness.repoRootPath, 'reviewer', {
        // Applied by a configured connection
        // (`providers/configured-provider.ts:134-138`).
        max_tokens: 4_096,
        temperature: 0.25,
        // Anthropic's own field. A configured connection has no such thing, so
        // sending it would be inventing a setting for this provider.
        thinking_budget: 2_048,
        // Not a setting about the model at all: it says where the request goes,
        // and the request is signed with this installation's credentials.
        base_url: 'https://elsewhere.invalid/v1',
      })
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        ...harness.turnWiring,
      }).catch(() => undefined)

      const offer = await offerModelChoiceForTurn({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        sessionStore: harness.store,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
      })
      assert.ok(offer)

      const accepted = await acceptModelChoice({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
        turnWiring: harness.turnWiring,
        acceptance: { offerId: offer.offerId, idempotencyKey: 'options-1' },
      })
      assert.equal(accepted.ok, true, JSON.stringify(accepted))

      assert.equal(requests.length, 1, 'the approved retry ran once')
      const body = requests[0]?.body ?? {}
      assert.equal(body.max_tokens, 4_096, 'a setting this provider applies survives the switch')
      assert.equal(body.temperature, 0.25, 'a setting this provider applies survives the switch')
      // Shape checks, not proof. This adapter serialises only `max_tokens` and
      // `temperature` (`providers/configured-provider.ts:134-138`), so these two
      // fields would be absent from the body whether the settings were
      // re-evaluated or carried across untouched — and `base_url` selects a
      // destination rather than appearing in a body at all.
      assert.equal(body.thinking_budget, undefined)
      assert.equal(body.base_url, undefined)
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})


test('a chat turn on an approved pair reports the settings that stopped applying', async () => {
  // The companion to the outbound assertions above. Which settings survived is
  // visible in the request; which ones *stopped* applying is not — this adapter
  // would not have serialised them either way — so the turn reports them, and
  // this reads that report back at the boundary that produces it.
  const harness = await makeHarness()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    await withWorkingDefault(async (providerName) => {
      writeUncredentialedAgentWithOptions(harness.repoRootPath, 'reviewer', {
        max_tokens: 4_096,
        thinking_budget: 2_048,
        base_url: 'https://elsewhere.invalid/v1',
      })

      const turn = await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: randomUUID(),
        approvedSelection: {
          agentName: 'reviewer',
          selection: {
            provider: providerName,
            model: 'default-model',
            source: 'app-default',
            reason: 'user-approved-retry',
          },
        },
        ...harness.turnWiring,
      })

      assert.deepEqual(
        turn.meta.replies[0]?.droppedProviderOptions,
        ['base_url', 'thinking_budget'],
        'the turn reports the settings this approved pair does not apply',
      )

      // And durably, which is the part that matters: read back through a store
      // built fresh over the same workspace, so this is the file's answer
      // rather than anything the turn kept in memory.
      const reread = new FileSystemSessionStore(harness.workspacePath)
      const reply = (await reread.listChatMessages(harness.sessionId))
        .filter((message) => message.role === 'assistant')
        .at(-1)
      assert.deepEqual(
        reply?.speaker?.droppedProviderOptions,
        ['base_url', 'thinking_budget'],
        'the recorded reply still names them after a reload',
      )
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})


test('an approved attempt that fails still reports the settings that stopped applying', async () => {
  // A failure is when a person most needs this. If the disclosure rode only on
  // the success path, an approved retry that failed would look like an ordinary
  // provider error, with no sign that two of the Agent's settings had stopped
  // applying on the way.
  const harness = await makeHarness()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  const server = await startFakeChatCompletionsServer({
    script: [{ failStatus: 500 }],
  })
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Failing default provider',
      baseUrl: `${server.url}/v1`,
      apiKey: 'default-key',
    },
  ])
  const providerName = `connection:${connectionId}`
  setRuntimeDefaultModelState({
    status: 'available',
    provider: providerName,
    model: 'default-model',
  })
  try {
    writeUncredentialedAgentWithOptions(harness.repoRootPath, 'reviewer', {
      max_tokens: 4_096,
      thinking_budget: 2_048,
      base_url: 'https://elsewhere.invalid/v1',
    })

    const turn = await runSessionAgentChatTurn({
      sessionId: harness.sessionId,
      session: SESSION,
      sessionStore: harness.store,
      repoRootPath: harness.repoRootPath,
      text: 'A question.',
      agentNames: ['reviewer'],
      turnId: randomUUID(),
      approvedSelection: {
        agentName: 'reviewer',
        selection: {
          provider: providerName,
          model: 'default-model',
          source: 'app-default',
          reason: 'user-approved-retry',
        },
      },
      ...harness.turnWiring,
    })

    assert.equal(turn.meta.replies[0]?.fallback, true, 'the attempt failed')
    assert.deepEqual(
      turn.meta.replies[0]?.droppedProviderOptions,
      ['base_url', 'thinking_budget'],
      'a failed approved attempt still says which settings stopped applying',
    )
    const reread = new FileSystemSessionStore(harness.workspacePath)
    const reply = (await reread.listChatMessages(harness.sessionId))
      .filter((message) => message.role === 'assistant')
      .at(-1)
    assert.deepEqual(reply?.speaker?.droppedProviderOptions, [
      'base_url',
      'thinking_budget',
    ])
  } finally {
    setConfiguredProviderConnections([])
    setRuntimeDefaultModelState({ status: 'unset' })
    await server.close()
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})

test('an approval for an offer that was never made dispatches nothing', async () => {
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    await withWorkingDefault(async (_providerName, requestCount) => {
      writeUncredentialedAgent(harness.repoRootPath, 'reviewer')
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        ...harness.turnWiring,
      }).catch(() => undefined)

      const result = await acceptModelChoice({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
        turnWiring: harness.turnWiring,
        acceptance: { offerId: 'invented-offer', idempotencyKey: 'approval-1' },
      })

      assert.equal(result.ok, false)
      assert.equal(!result.ok && result.error.code, 'offer-not-found')
      assert.equal(requestCount(), 0)
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})

test('a default that changed after the offer requires a refreshed offer', async () => {
  const harness = await makeHarness()
  const failedTurn = randomUUID()
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    await withWorkingDefault(async (providerName, requestCount) => {
      writeUncredentialedAgent(harness.repoRootPath, 'reviewer')
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId: failedTurn,
        ...harness.turnWiring,
      }).catch(() => undefined)

      const offer = await offerModelChoiceForTurn({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        sessionStore: harness.store,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
      })
      assert.ok(offer)

      // Settings moves after the offer was shown.
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'a-different-default',
      })

      const result = await acceptModelChoice({
        sessionId: harness.sessionId,
        turnId: failedTurn,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        conversationRegistry: harness.registry,
        executionRegistry: harness.executionRegistry,
        turnWiring: harness.turnWiring,
        acceptance: { offerId: offer.offerId, idempotencyKey: 'approval-1' },
      })

      assert.equal(result.ok, false)
      assert.equal(!result.ok && result.error.code, 'offer-not-found')
      assert.equal(requestCount(), 0, 'an unseen pair must never run')
    })
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await harness.cleanup()
  }
})
