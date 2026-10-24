import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import { RESOURCE_ARCHITECT_TURN_TIMEOUT_MS } from '../../contracts/resource-architect.js'
import { runResourceArchitectTurn } from '../../domains/resource-architect/resource-architect-llm.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { runResourceArchitectTurnService } from '../../services/resource-architect-service.js'
import { CreateJobRegistry } from '../../server/create-job-registry.js'
import { ResourceArchitectStore } from '../../server/resource-architect-store.js'
import { handleResourceArchitectRoutes, type ResourceArchitectRoutesOptions } from '../../server/routes/resource-architect.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { readResourceArchitectJournal } from '../../services/resource-architect-journal-recorder.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'

const PASS = JSON.stringify({ verdict: 'pass', findings: [] })
const requestSchema = z.object({ model: z.string() })

function barrier() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((complete) => { resolve = complete })
  assert.ok(resolve)
  return { promise, resolve }
}

// Paid and nondeterministic providers are replaced at the HTTP boundary only.
// Config, route, stores, streams, and filesystem operations remain real.
async function withPublicationFixture(
  replies: readonly string[],
  run: (fixture: {
    repoRoot: string
    store: ResourceArchitectStore
    registry: CreateJobRegistry
    hub: AgentTextStreamHub
    url: string
    requests: string[]
    routeSettled: Promise<void>
    requestDisconnected: Promise<void>
    journalRegistry: WorkspaceConversationJournalRegistry
  }) => Promise<void>,
  options: {
    createTurnTimeoutSignal?: (durationMs: number) => AbortSignal
    onRequest?: (index: number) => Promise<void>
    publicationFailure?: Error
    onJournalWrite?: (text: string) => Promise<void>
    reviewEnabled?: boolean
  } = {},
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-publication-'))
  const repoRoot = path.join(directory, 'project')
  await fs.mkdir(path.join(repoRoot, 'teams/resource-architect'), { recursive: true })
  await fs.mkdir(path.join(repoRoot, 'agents/resource-architect'), { recursive: true })
  await fs.mkdir(path.join(repoRoot, 'agents/reviewer-of-agent-architect'), { recursive: true })
  await fs.writeFile(path.join(repoRoot, 'teams.yaml'), '')
  await fs.writeFile(path.join(repoRoot, 'teams/resource-architect/team.yaml'), 'agents:\n  - agent_file: ../../agents/resource-architect/resource-architect.md\n')
  await fs.writeFile(path.join(repoRoot, 'agents/resource-architect/resource-architect.md'), '---\nprovider: openai\nmodel: persona-author\n---\nDesign Agents.\n')
  await fs.writeFile(path.join(repoRoot, 'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md'), '---\nname: reviewer-of-agent-architect\nsystem: true\nprovider: openai\nmodel: independent-reviewer\n---\nReview omissions.\n')
  const requests: string[] = []
  const provider = http.createServer((req, res) => {
    void (async () => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const parsed: unknown = JSON.parse(body)
      requests.push(requestSchema.parse(parsed).model)
      const index = requests.length
      await options.onRequest?.(index)
      const reply = replies[index - 1]
      assert.notEqual(reply, undefined, 'No unexpected later phase may start')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })().catch(() => res.writeHead(500).end('Synthetic provider failed'))
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const providerAddress = provider.address()
  assert.ok(providerAddress && typeof providerAddress === 'object')
  const previous = { key: process.env.OPENAI_API_KEY, url: process.env.WORKFLOW_GENERATOR_OPENAI_API_URL }
  process.env.OPENAI_API_KEY = 'synthetic-test-key'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `http://127.0.0.1:${providerAddress.port}/v1/chat/completions`
  const store = new ResourceArchitectStore(path.join(directory, 'workspace'))
  const registry = new CreateJobRegistry()
  const hub = new AgentTextStreamHub()
  const journalRegistry = new WorkspaceConversationJournalRegistry({
    workspacePath: path.join(directory, 'workspace'), tenantId: 'local', mode: 'disabled',
    // Use the journal's established byte-write seam to hold a real commit.
    // Its manifest validation, append, fsync, hashes, and later reads stay real.
    journalOpener: (input) => initializeExecutionJournal({
      ...input,
      writeInterceptorForTest: (target) => ({
        write: async (buffer, offset, length) => {
          await options.onJournalWrite?.(buffer.subarray(offset, offset + length).toString('utf8'))
          return target.write(buffer, offset, length)
        },
        sync: () => target.sync(),
      }),
    }),
  })
  const settled = barrier()
  const disconnected = barrier()
  const routeOptions: ResourceArchitectRoutesOptions = {
    repoRootPath: repoRoot, resourceArchitectStore: store, createJobRegistry: registry,
    agentTextStreamHub: hub, conversationJournalRegistry: journalRegistry,
    isAbortLike: (error) => error instanceof Error && error.name === 'AbortError',
    ...options,
  }
  // A synchronous socket-write failure is nondeterministic on a live network.
  // Inject it at the actual HTTP response boundary, after all durable writes.
  class PublicationResponse extends http.ServerResponse {
    override setHeader(name: string, value: number | string | readonly string[]): this {
      if (this.statusCode === 200 && name === 'content-type' && options.publicationFailure) throw options.publicationFailure
      return super.setHeader(name, value)
    }
  }
  const server = http.createServer({ ServerResponse: PublicationResponse }, (req, res) => {
    res.once('close', () => { if (!res.writableFinished) disconnected.resolve() })
    void handleResourceArchitectRoutes({ req, res, url: new URL(req.url ?? '/', 'http://localhost'), options: routeOptions })
      .catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.name : 'Error' }))
      }).finally(settled.resolve)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run({ repoRoot, store, registry, hub, journalRegistry, url: `http://127.0.0.1:${address.port}`, requests, routeSettled: settled.promise, requestDisconnected: disconnected.promise })
  } finally {
    server.closeAllConnections()
    provider.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => provider.close(() => resolve())),
    ])
    await journalRegistry.close()
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous.key
    if (previous.url === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previous.url
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const conversation = { operation: 'conversation' as const, history: [{ role: 'user' as const, text: 'Recommend Agents.' }], currentPlan: null }

test('an expired route deadline admits no provider work and reports failure rather than cancellation', async () => {
  const deadline = new AbortController()
  deadline.abort(new DOMException('Synthetic turn deadline', 'TimeoutError'))
  await withPublicationFixture(['draft', PASS, 'final'], async ({ url, requests, store, registry, routeSettled }) => {
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...conversation, jobId: 'expired-turn' }),
    })
    await routeSettled
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'TimeoutError' })
    assert.deepEqual(requests, [])
    assert.equal((await store.listTurnMetrics()).at(-1)?.status, 'failed')
    assert.equal(registry.isActive('expired-turn'), false)
  }, { createTurnTimeoutSignal: (durationMs) => {
    assert.equal(durationMs, RESOURCE_ARCHITECT_TURN_TIMEOUT_MS)
    return deadline.signal
  } })
})

test('a service deadline expiring during the durable fallback decision prevents draft publication', async () => {
  const deadline = new AbortController()
  const deltas: string[] = []
  await withPublicationFixture(['private draft', 'invalid review'], async ({ repoRoot, store }) => {
    await assert.rejects(runResourceArchitectTurnService({
      ...conversation, repoRootPath: repoRoot, store, jobId: 'journal-expiry',
      createTurnTimeoutSignal: () => deadline.signal,
      onUnreviewedDraft: async () => { deadline.abort(new DOMException('Synthetic turn deadline', 'TimeoutError')) },
      onTextDelta: (text) => deltas.push(text),
    }), { name: 'TimeoutError' })
    assert.deepEqual(deltas, [])
  })
})

test('a domain deadline expiring during final diagnostics prevents the final response', async () => {
  const deadline = new AbortController()
  await withPublicationFixture(['private draft', PASS, 'final'], async ({ repoRoot }) => {
    await assert.rejects(runResourceArchitectTurn({
      ...conversation, repoRoot,
      createTurnTimeoutSignal: () => deadline.signal,
      onReviewDiagnostics: async (review) => {
        if (review.phases.some((phase) => phase.phase === 'final')) deadline.abort(new DOMException('Synthetic turn deadline', 'TimeoutError'))
      },
    }), { name: 'TimeoutError' })
  })
})

test('a reviewer deadline records a failed phase without treating it as a user cancellation', async () => {
  const deadline = new AbortController()
  const outcomes: string[] = []
  await withPublicationFixture(['private draft', PASS], async ({ repoRoot }) => {
    await assert.rejects(runResourceArchitectTurn({
      ...conversation, repoRoot, signal: deadline.signal,
      onReviewDiagnostics: async (review) => {
        const phase = review.phases.at(-1)
        if (phase?.phase === 'review') outcomes.push(phase.outcome)
      },
    }), { name: 'TimeoutError' })
    assert.deepEqual(outcomes, ['failed'])
  }, { onRequest: async (index) => {
    if (index === 2) deadline.abort(new DOMException('Synthetic turn deadline', 'TimeoutError'))
  } })
})

test('Stop after the durable review decision prevents final dispatch', async () => {
  const caller = new AbortController()
  await withPublicationFixture(['private draft', PASS, 'unexpected final'], async ({ repoRoot, requests }) => {
    await assert.rejects(runResourceArchitectTurn({
      ...conversation, repoRoot, signal: caller.signal,
      onReviewDiagnostics: async (review) => {
        if (review.reviewStatus === 'completed' && review.phases.length === 2) caller.abort()
      },
    }), { name: 'AbortError' })
    assert.deepEqual(requests, ['persona-author', 'independent-reviewer'])
  })
})

test('a marker-only final answer counts and streams only its visible acknowledgement after final diagnostics', async () => {
  await withPublicationFixture(['private draft', PASS, '[[proposal-requested]]'], async ({ repoRoot }) => {
    const deltas: string[] = []
    let finalDiagnosticsRecorded = false
    const result = await runResourceArchitectTurn({
      ...conversation, repoRoot,
      onReviewDiagnostics: async (review) => { finalDiagnosticsRecorded = review.phases.some((phase) => phase.phase === 'final') },
      onTextDelta: (text) => {
        assert.equal(finalDiagnosticsRecorded, true, 'Control-marker bytes are not visible first text')
        deltas.push(text)
      },
    })
    assert.equal(result.fallback, false, result.reason)
    assert.equal(result.response.operation, 'conversation')
    assert.deepEqual(deltas, ['Understood — preparing the proposal for your review.'])
    assert.equal(result.response.message, deltas.join(''))
    const final = result.review?.phases.at(-1)
    assert.ok(final)
    assert.ok(result.timing.firstTextMs !== null && result.timing.firstTextMs >= final.startOffsetMs + final.durationMs)
  })
})

test('cancellation retains the resolved author pair while review phases replace the running metric', async () => {
  const arrived = barrier()
  const release = barrier()
  await withPublicationFixture(['private draft', PASS], async ({ url, registry, requests, store, routeSettled }) => {
    const turn = fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...conversation, jobId: 'retained-author' }),
    })
    await arrived.promise
    registry.cancel('retained-author')
    release.resolve()
    assert.deepEqual(await (await turn).json(), { jobId: 'retained-author', operation: 'conversation', cancelled: true })
    await routeSettled
    const metric = (await store.listTurnMetrics()).at(-1)
    assert.equal(metric?.status, 'cancelled')
    assert.equal(metric?.provider, 'openai')
    assert.equal(metric?.model, 'persona-author')
    assert.equal(metric?.selection?.model, 'persona-author')
    assert.deepEqual(requests, ['persona-author', 'independent-reviewer'])
  }, { onRequest: async (index) => { if (index === 2) { arrived.resolve(); await release.promise } } })
})

test('a timeout during HTTP publication corrects the completed metric and closes the stream as failed', async () => {
  await withPublicationFixture(['private draft', PASS, 'final'], async ({ url, store, registry, hub, routeSettled }) => {
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...conversation, jobId: 'publication-timeout' }),
    })
    await routeSettled
    assert.equal(response.status, 500)
    const metrics = await store.listTurnMetrics()
    assert.equal(metrics.length, 1, 'A failed publication corrects this turn instead of appending another turn')
    assert.equal(metrics[0]?.status, 'failed')
    assert.equal(metrics[0]?.model, 'persona-author')
    assert.equal(metrics[0]?.review?.reviewStatus, 'completed')
    assert.equal(hub.read('publication-timeout', 0)?.closed, true)
    assert.equal(hub.read('publication-timeout', 0)?.frames.at(-1)?.type, 'error')
    assert.equal(registry.isActive('publication-timeout'), false)
  }, { publicationFailure: new DOMException('Synthetic publication deadline', 'TimeoutError') })
})

test('failed D1 publication leaves one failed metric and a failed journal with its server completion retained', async () => {
  await withPublicationFixture(['private draft', 'invalid review'], async ({ url, repoRoot, store, journalRegistry, routeSettled }) => {
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...conversation, draftId: 'publication-failure', jobId: 'd1-publication' }),
    })
    await routeSettled
    assert.equal(response.status, 500)
    const metrics = await store.listTurnMetrics()
    assert.equal(metrics.length, 1)
    assert.equal(metrics[0]?.status, 'failed')
    const journal = await readResourceArchitectJournal({ registry: journalRegistry, conversationId: 'publication-failure', jobId: 'd1-publication' })
    assert.ok(journal.kind === 'read')
    assert.equal(journal.terminal, 'failed')
    assert.equal(journal.serverTerminal, 'completed')
    assert.equal(journal.publicationFailed, true)
    const freshStore = new ResourceArchitectStore(path.join(path.dirname(repoRoot), 'workspace'))
    assert.deepEqual(await freshStore.listTurnMetrics(), metrics, 'A fresh reader observes the corrected outcome')
    await freshStore.recordTurnPublicationFailure('d1-publication', 'failed', metrics[0]?.timing.totalDurationMs ?? 0)
    assert.deepEqual(await freshStore.listTurnMetrics(), metrics, 'Replaying a correction does not add or change a turn')
  }, { publicationFailure: new Error('Synthetic synchronous socket failure') })
})

test('Stop after the completion claim agrees with the D1 reply, metric and terminal journal', async () => {
  const terminalStarted = barrier()
  const releaseTerminal = barrier()
  await withPublicationFixture(['private draft', 'invalid review'], async ({ url, registry, store, journalRegistry, routeSettled }) => {
    const jobId = 'stop-after-completion-claim'
    const draftId = 'claimed-draft'
    const turn = fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ ...conversation, jobId, draftId }),
    })
    try {
      await terminalStarted.promise
      const stopping = registry.cancelAndWait(jobId)
      releaseTerminal.resolve()
      const response = await turn
      await routeSettled
      const stopped = await stopping
      const metrics = await store.listTurnMetrics()
      const journal = await readResourceArchitectJournal({ registry: journalRegistry, conversationId: draftId, jobId })
      assert.equal(response.status, 200, 'The completion claim already owns this result; Stop must not turn it into a failed reply')
      assert.deepEqual(stopped, { jobId, cancelled: false, status: 'completed' })
      assert.equal(metrics.at(-1)?.status, 'completed')
      assert.ok(journal.kind === 'read')
      assert.equal(journal.terminal, 'completed')
      assert.equal(journal.publicationFailed, undefined)
    } finally {
      releaseTerminal.resolve()
      await turn
    }
  }, { onJournalWrite: async (text) => {
    if (text.includes('"type":"resource-architect.review.terminal"')) {
      terminalStarted.resolve()
      await releaseTerminal.promise
    }
  } })
})

const disconnectScenarios = [
  {
    phase: 'draft', heldRequest: 1, reviewEnabled: true,
    replies: ['private draft', PASS, 'final'], models: ['persona-author', 'independent-reviewer', 'persona-author'],
    journalKind: 'absent', journalTerminal: undefined, answer: 'final',
  },
  {
    phase: 'review', heldRequest: 2, reviewEnabled: true,
    replies: ['private draft', PASS, 'final'], models: ['persona-author', 'independent-reviewer', 'persona-author'],
    journalKind: 'absent', journalTerminal: undefined, answer: 'final',
  },
  {
    phase: 'finalization', heldRequest: 3, reviewEnabled: true,
    replies: ['private draft', PASS, 'final'], models: ['persona-author', 'independent-reviewer', 'persona-author'],
    journalKind: 'absent', journalTerminal: undefined, answer: 'final',
  },
  {
    phase: 'disabled review', heldRequest: 1, reviewEnabled: false,
    replies: ['final'], models: ['persona-author'],
    journalKind: 'absent', journalTerminal: undefined, answer: 'final',
  },
  {
    phase: 'a review that needs D1 fallback', heldRequest: 2, reviewEnabled: true,
    replies: ['disclosed draft', 'invalid review'], models: ['persona-author', 'independent-reviewer'],
    journalKind: 'read', journalTerminal: 'completed', answer: 'disclosed draft',
  },
] as const

for (const scenario of disconnectScenarios) {
  test(`disconnecting during ${scenario.phase} keeps the same Create job running until its answer completes`, { timeout: 3_000 }, async (context) => {
    const arrived = barrier()
    const release = barrier()
    const client = new AbortController()
    const jobId = 'disconnected-turn'
    const draftId = 'disconnected-draft'
    await withPublicationFixture(scenario.replies, async ({ url, repoRoot, registry, requests, hub, journalRegistry, routeSettled, requestDisconnected }) => {
      // Cleanup releases the real provider barrier even when an assertion fails.
      context.signal.addEventListener('abort', () => { registry.cancel(jobId); release.resolve() }, { once: true })
      const turn = fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: client.signal,
        body: JSON.stringify({ ...conversation, jobId, draftId }),
      })
      try {
        await arrived.promise
        client.abort()
        await assert.rejects(turn, { name: 'AbortError' })
        await requestDisconnected
        const workspace = path.join(path.dirname(repoRoot), 'workspace')
        const pending = await new ResourceArchitectStore(workspace).listTurnMetrics()
        assert.equal(pending.length, 1)
        assert.equal(pending[0]?.jobId, jobId)
        assert.equal(pending[0]?.status, 'running', 'Reloading abandons the HTTP request, not the admitted Create job')
        assert.equal(pending[0]?.selection?.model, 'persona-author')
        assert.equal(registry.isActive(jobId), true)
        assert.equal(hub.read(jobId, 0)?.closed, false)

        release.resolve()
        await routeSettled
        const completed = await new ResourceArchitectStore(workspace).listTurnMetrics()
        assert.equal(completed.length, 1)
        assert.equal(completed[0]?.jobId, jobId)
        assert.equal(completed[0]?.status, 'completed')
        assert.equal(completed[0]?.provider, 'openai')
        assert.equal(completed[0]?.model, 'persona-author')
        assert.deepEqual(completed[0]?.selection, pending[0]?.selection)
        assert.deepEqual(requests, scenario.models)
        assert.equal(registry.isActive(jobId), false)
        const frames = hub.read(jobId, 0)
        assert.equal(frames?.closed, true)
        assert.equal(frames?.frames.at(-1)?.type, 'final')
        assert.equal(frames?.frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text).join(''), scenario.answer)
        const journal = await readResourceArchitectJournal({ registry: journalRegistry, conversationId: draftId, jobId })
        assert.equal(journal.kind, scenario.journalKind)
        assert.equal('terminal' in journal ? journal.terminal : undefined, scenario.journalTerminal)
      } finally {
        client.abort()
        release.resolve()
        await routeSettled
      }
    }, { reviewEnabled: scenario.reviewEnabled, onRequest: async (index) => {
      if (index === scenario.heldRequest) { arrived.resolve(); await release.promise }
    } })
  })
}
