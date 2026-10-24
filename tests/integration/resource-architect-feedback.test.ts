import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { z } from 'zod'

import { startApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { resourceArchitectFeedbackDiagnosticsSchema } from '../../contracts/schemas/resource-architect-review.js'
import { runResourceArchitectTurnService } from '../../services/resource-architect-service.js'
import { ResourceArchitectStore } from '../../server/resource-architect-store.js'
import { readResourceArchitectJournal, resourceArchitectJournalActivityId } from '../../services/resource-architect-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { renderResourceArchitectPlannedAgentBrief } from '../../domains/resource-architect/planned-agent-brief.js'
import { acquireProcessFileLock, createCrossProcessFileLockRecord, crossProcessFileLockAdapter } from '../../core/cross-process-file-lock.js'
import { FileSystemCreateJobStateStore } from '../../server/create-job-state-store.js'
import { SELECTED_AGENT, SELECTED_PACKAGE_MARKERS, writeSelectedAgentPackage } from '../support/selected-agent-package-fixture.js'

const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
})
const responseSchema = z.object({
  message: z.string(),
  warnings: z.array(z.string()),
  proposalRequested: z.boolean().optional(),
  meta: z.object({ provider: z.string(), model: z.string(), selection: z.object({ source: z.string(), reason: z.string() }).optional(), review: z.unknown().optional(), timing: z.object({ firstTextMs: z.number().nullable(), totalDurationMs: z.number() }) }),
})
const DRAFT = 'PRIVATE DRAFT: Recommend contract-author and contract-checker.\n[[proposal-requested]]'
const REVIEW = {
  verdict: 'revise',
  findings: [{ severity: 'high', location: 'Missing Skills section', issue: 'PRIVATE CRITIQUE: The roster has no skills table. [[proposal-requested]]', requestedChange: 'Add contract-analysis for both Agents and mark it shared.' }],
}
const FINAL = '| Agent | Purpose |\n| --- | --- |\n| contract-author | Draft contracts |\n| contract-checker | Check contracts |\n\n## Skills\n\n| Skill | Purpose | Agents | Sharing |\n| --- | --- | --- | --- |\n| contract-analysis | Planned creation: identify terms | contract-author, contract-checker | shared |'

function barrier() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((complete) => { resolve = complete })
  assert.ok(resolve)
  return { promise, resolve }
}

// Paid, nondeterministic providers are replaced only at their HTTP boundary.
// The authoring API, streams, config files, and durable stores are real.
async function withFeedbackApi(
  replies: readonly (string | { status: number; code: string })[],
  run: (fixture: { url: string; workspacePath: string; repoRoot: string; requests: z.infer<typeof requestSchema>[] }) => Promise<void>,
  options: {
    readonly reviewEnabled?: boolean
    readonly missingDeepseekKey?: boolean
    readonly onRequest?: (request: z.infer<typeof requestSchema>, index: number, repoRoot: string) => Promise<void>
  } = {},
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-feedback-'))
  const workspacePath = path.join(directory, 'workspace')
  const repoRoot = path.join(directory, 'project')
  await fs.mkdir(workspacePath, { recursive: true })
  await fs.mkdir(path.join(repoRoot, 'teams/resource-architect'), { recursive: true })
  await fs.mkdir(path.join(repoRoot, 'agents/resource-architect'), { recursive: true })
  await fs.mkdir(path.join(repoRoot, 'agents/reviewer-of-agent-architect'), { recursive: true })
  await fs.writeFile(path.join(repoRoot, 'teams.yaml'), '')
  await fs.writeFile(path.join(repoRoot, 'teams/resource-architect/team.yaml'), 'agents:\n  - agent_file: ../../agents/resource-architect/resource-architect.md\n')
  await fs.writeFile(path.join(repoRoot, 'agents/resource-architect/resource-architect.md'), '---\nprovider: openai\nmodel: persona-author\nthinking: medium\n---\nARCHITECT INSTRUCTIONS: Design Agents with a Skills table after their roster.\n')
  await fs.writeFile(path.join(repoRoot, 'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md'), '---\nname: reviewer-of-agent-architect\nsystem: true\nprovider: openai\nmodel: independent-reviewer\nthinking: medium\n---\n# Reviewer of Agent Architect\nREVIEWER INSTRUCTIONS: Check omissions without inventing issues.\n')
  const requests: z.infer<typeof requestSchema>[] = []
  const modelServer = http.createServer((req, res) => {
    // The callback owns and reports asynchronous request failures.
    void (async () => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const parsed: unknown = JSON.parse(body)
      const request = requestSchema.parse(parsed)
      requests.push(request)
      await options.onRequest?.(request, requests.length, repoRoot)
      const reply = replies[requests.length - 1]
      if (reply === undefined) {
        res.writeHead(500).end('Unexpected extra provider request')
        return
      }
      if (typeof reply !== 'string') {
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: reply.code, message: 'PRIVATE PROVIDER ERROR' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ model: requests.at(-1)?.model, choices: [{ delta: { content: reply } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })().catch(() => res.writeHead(500).end('Invalid provider request'))
  })
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
  const address = modelServer.address()
  assert.ok(address && typeof address === 'object')
  const prior = {
    key: process.env.OPENAI_API_KEY,
    url: process.env.WORKFLOW_GENERATOR_OPENAI_API_URL,
    review: process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
    deepseekUrl: process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL,
  }
  process.env.OPENAI_API_KEY = 'synthetic-test-key'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `http://127.0.0.1:${address.port}/v1/chat/completions`
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  if (options.missingDeepseekKey) delete process.env.DEEPSEEK_API_KEY
  if (options.reviewEnabled === undefined) delete process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED
  else process.env.PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED = String(options.reviewEnabled)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath), launcher: new PiRunLauncher(),
    sessionStore: new FileSystemSessionStore(workspacePath), repoRootPath: repoRoot, workspacePath,
  })
  try {
    await run({ url: server.url, workspacePath, repoRoot, requests })
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
    await server.close()
    modelServer.closeAllConnections()
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()))
    for (const [key, value] of Object.entries({ OPENAI_API_KEY: prior.key, WORKFLOW_GENERATOR_OPENAI_API_URL: prior.url, PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: prior.review, DEEPSEEK_API_KEY: prior.deepseekKey, WORKFLOW_GENERATOR_DEEPSEEK_API_URL: prior.deepseekUrl })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test('one private review corrects an omitted Skills table and publishes only the final Architect answer', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify(REVIEW), FINAL], async ({ url, requests, workspacePath }) => {
    const jobId = randomUUID()
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId, draftId: 'draft-feedback', operation: 'conversation', provider: 'openai', model: 'composer-author', history: [{ role: 'user', text: 'ORIGINAL REQUEST: Recommend a contract drafting and checking Team.' }], currentPlan: null }),
    })
    assert.equal(response.status, 200)
    const payload = responseSchema.parse(await response.json())
    assert.equal(payload.message, FINAL, 'The visible answer must be the reviewed final, not the private draft')
    assert.equal(payload.proposalRequested, undefined, 'A private draft marker cannot request a proposal')
    const diagnostics = resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review)
    assert.ok(payload.meta.timing.firstTextMs !== null && payload.meta.timing.firstTextMs >= (diagnostics.phases[2]?.startOffsetMs ?? Infinity), 'Private draft tokens must not count as visible first text')
    assert.deepEqual(requests.map((request) => request.model), ['composer-author', 'independent-reviewer', 'composer-author'])
    const reviewerInput = requests[1]?.messages.map((message) => message.content).join('\n') ?? ''
    const finalInput = requests[2]?.messages.map((message) => message.content).join('\n') ?? ''
    assert.match(reviewerInput, /REVIEWER INSTRUCTIONS/)
    assert.match(reviewerInput, /ORIGINAL REQUEST/)
    assert.ok(reviewerInput.includes(JSON.stringify(DRAFT).slice(1, -1)))
    assert.match(finalInput, /ARCHITECT INSTRUCTIONS/)
    assert.match(finalInput, /ORIGINAL REQUEST/)
    assert.match(finalInput, /PRIVATE CRITIQUE/)
    assert.ok(finalInput.includes(JSON.stringify(DRAFT).slice(1, -1)))
    const streamed = await fetch(`${url}/create/resource-architect/turn?channelId=${jobId}&from=0`, { signal: AbortSignal.timeout(5_000) })
    const frames = await streamed.text()
    assert.match(frames, /contract-analysis/)
    assert.doesNotMatch(frames, /PRIVATE DRAFT|PRIVATE CRITIQUE|proposal-requested/)
    const metrics = await fs.readFile(path.join(workspacePath, 'resource-architect-telemetry/turns.json'), 'utf8')
    assert.match(metrics, /independent-reviewer/)
    assert.doesNotMatch(metrics, /PRIVATE DRAFT|PRIVATE CRITIQUE|ORIGINAL REQUEST/)
  })
})

for (const scenario of [
  {
    name: 'a skill used by one Agent',
    request: 'Recommend one contract-checking Agent and its concrete skill.',
    answer: '| Agent | Purpose |\n| --- | --- |\n| contract-checker | Check contract terms |\n\n## Skills\n\n| Skill | Purpose | Agents | Sharing |\n| --- | --- | --- | --- |\n| contract-analysis | Planned creation: identify conflicting terms | contract-checker | agent-specific |',
  },
  {
    name: 'a reasoned None row when no skill is needed',
    request: 'Recommend one intake Agent and explain why no skill is needed.',
    answer: '| Agent | Purpose |\n| --- | --- |\n| brief-intake | Ask for the missing deliverable |\n\n## Skills\n\n| Skill | Purpose | Agents | Sharing |\n| --- | --- | --- | --- |\n| None | No reusable method is needed for a one-question intake | brief-intake | agent-specific |',
  },
  {
    name: 'a clarification without an invented roster or Skills table',
    request: 'I need help, but have not described the task yet.',
    answer: 'What deliverable should the Agent produce, and who will use it?',
  },
] as const) {
  test(`a passing review preserves ${scenario.name} in the final answer`, async () => {
    await withFeedbackApi([scenario.answer, JSON.stringify({ verdict: 'pass', findings: [] }), scenario.answer], async ({ url, requests }) => {
      const jobId = randomUUID()
      const response = await fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ jobId, operation: 'conversation', history: [{ role: 'user', text: scenario.request }], currentPlan: null }),
      })
      assert.equal(response.status, 200)
      const payload = responseSchema.parse(await response.json())
      assert.equal(payload.message, scenario.answer)
      assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'independent-reviewer', 'persona-author'])
      assert.equal(resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review).reviewStatus, 'completed')
      assert.match(JSON.stringify(requests[2]), /verdict.*pass/)
      assert.equal(payload.proposalRequested, undefined)
      assert.deepEqual(payload.warnings, [])
    })
  })
}

for (const scenario of [
  {
    name: 'both the explicit reviewer and its distinct default are unavailable',
    defaultState: { status: 'available', provider: 'openai', model: 'fallback-reviewer' },
    reviewerChange: 'unchanged',
    replies: [DRAFT, { status: 401, code: 'invalid_api_key' }, { status: 404, code: 'model_not_found' }],
    models: ['persona-author', 'independent-reviewer', 'fallback-reviewer'],
    attempted: [{ provider: 'openai', model: 'independent-reviewer' }, { provider: 'openai', model: 'fallback-reviewer' }],
    reason: 'reviewer_unavailable', fallbackAttempted: true,
  },
  {
    name: 'the explicit reviewer fails with no usable application default',
    defaultState: { status: 'unset' },
    reviewerChange: 'unchanged',
    replies: [DRAFT, { status: 401, code: 'invalid_api_key' }],
    models: ['persona-author', 'independent-reviewer'],
    attempted: [{ provider: 'openai', model: 'independent-reviewer' }],
    reason: 'reviewer_unavailable', fallbackAttempted: false,
  },
  {
    name: 'the failed reviewer is also the application default',
    defaultState: { status: 'available', provider: 'openai', model: 'independent-reviewer' },
    reviewerChange: 'unchanged',
    replies: [DRAFT, { status: 401, code: 'invalid_api_key' }],
    models: ['persona-author', 'independent-reviewer'],
    attempted: [{ provider: 'openai', model: 'independent-reviewer' }],
    reason: 'reviewer_unavailable', fallbackAttempted: false,
  },
  {
    name: 'the reviewer inherits an unavailable default',
    defaultState: { status: 'unset' },
    reviewerChange: 'inherited', replies: [DRAFT], models: ['persona-author'], attempted: [],
    reason: 'reviewer_unavailable', fallbackAttempted: false,
  },
  {
    name: 'the reviewer persona contains an incomplete model pair',
    defaultState: { status: 'available', provider: 'openai', model: 'fallback-reviewer' },
    reviewerChange: 'incomplete', replies: [DRAFT], models: ['persona-author'], attempted: [],
    reason: 'reviewer_config_invalid', fallbackAttempted: false,
  },
] as const) {
  test(`a journaled Not reviewed draft is the only result when ${scenario.name}`, async () => {
    await withFeedbackApi(scenario.replies, async ({ url, requests, repoRoot, workspacePath }) => {
      setRuntimeDefaultModelState(scenario.defaultState)
      const personaPath = path.join(repoRoot, 'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md')
      const original = await fs.readFile(personaPath, 'utf8')
      const changed = {
        unchanged: original,
        inherited: original.replace('provider: openai\nmodel: independent-reviewer\n', ''),
        incomplete: original.replace('model: independent-reviewer\n', ''),
      }
      await fs.writeFile(personaPath, changed[scenario.reviewerChange])
      const jobId = randomUUID()
      const draftId = `draft-${jobId}`
      const response = await fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ jobId, draftId, operation: 'conversation', history: [{ role: 'user', text: 'Recommend a contract Team.' }], currentPlan: null }),
      })
      assert.equal(response.status, 200)
      const payload = responseSchema.parse(await response.json())
      const diagnostics = resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review)
      assert.equal(payload.message, 'PRIVATE DRAFT: Recommend contract-author and contract-checker.')
      assert.equal(payload.proposalRequested, undefined)
      assert.deepEqual(payload.warnings, ['Not reviewed. Reviewer of Agent Architect could not complete review.'])
      assert.equal(diagnostics.reviewStatus, 'not_reviewed')
      assert.equal(diagnostics.failureReason, scenario.reason)
      assert.equal(diagnostics.defaultFallbackAttempted, scenario.fallbackAttempted)
      assert.deepEqual(requests.map((request) => request.model), scenario.models)
      const registry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' })
      try {
        const journal = await readResourceArchitectJournal({ registry, conversationId: draftId, jobId })
        assert.ok(journal.kind === 'read')
        assert.equal(journal.eventCount, 2, 'Exactly one fallback decision and one terminal outcome survive a fresh read')
        assert.equal(journal.terminal, 'completed')
        assert.equal(journal.fallback?.reason, scenario.reason)
        assert.equal(journal.fallback?.defaultFallbackAttempted, scenario.fallbackAttempted)
        assert.deepEqual(journal.fallback?.attemptedReviewers, scenario.attempted)
        assert.equal(journal.fallback?.proposalSuppressed, true)
        assert.doesNotMatch(JSON.stringify(journal), /PRIVATE DRAFT|PRIVATE CRITIQUE|PRIVATE PROVIDER ERROR/)
      } finally { await registry.close() }
      const restored = await new ResourceArchitectStore(workspacePath).listTurnMetrics()
      assert.equal(restored.at(-1)?.review?.reviewStatus, 'not_reviewed')
      assert.equal(restored.at(-1)?.review?.failureReason, scenario.reason)
      const stream = await fetch(`${url}/create/resource-architect/turn?channelId=${jobId}&from=0`, { signal: AbortSignal.timeout(5_000) })
      assert.doesNotMatch(await stream.text(), /proposal-requested|PRIVATE CRITIQUE|PRIVATE PROVIDER ERROR/)
    })
  })
}

test('missing reviewer credentials use the default without sending a request with an empty credential', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify({ verdict: 'pass', findings: [] }), FINAL], async ({ url, requests, repoRoot }) => {
    const persona = path.join(repoRoot, 'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md')
    const original = await fs.readFile(persona, 'utf8')
    await fs.writeFile(persona, original.replace('provider: openai', 'provider: deepseek'))
    setRuntimeDefaultModelState({ status: 'available', provider: 'openai', model: 'default-reviewer' })
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId: randomUUID(), operation: 'conversation', history: [{ role: 'user', text: 'Recommend a Team.' }], currentPlan: null }),
    })
    const result = responseSchema.parse(await response.json())
    assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'default-reviewer', 'persona-author'])
    assert.equal(resourceArchitectFeedbackDiagnosticsSchema.parse(result.meta.review).diagnosticCode, 'credential_missing')
  }, { missingDeepseekKey: true })
})

test('an unavailable explicit reviewer attempts the captured distinct application default once', async () => {
  await withFeedbackApi([DRAFT, { status: 401, code: 'invalid_api_key' }, JSON.stringify({ verdict: 'pass', findings: [] }), FINAL], async ({ url, requests }) => {
    setRuntimeDefaultModelState({ status: 'available', provider: 'openai', model: 'default-reviewer' })
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId: randomUUID(), operation: 'conversation', provider: 'openai', model: 'composer-author', history: [{ role: 'user', text: 'Recommend a contract Team.' }], currentPlan: null }),
    })
    const payload = responseSchema.parse(await response.json())
    assert.deepEqual(requests.map((request) => request.model), ['composer-author', 'independent-reviewer', 'default-reviewer', 'composer-author'])
    assert.equal(payload.message, FINAL)
    assert.match(payload.warnings.join('\n'), /application default/)
    assert.equal(resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review).failureReason, 'reviewer_unavailable')
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE PROVIDER ERROR/)
  })
})

test('the finalizer retains uploaded evidence, library facts and the exact original context', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify(REVIEW), FINAL], async ({ repoRoot, workspacePath, requests }) => {
    await fs.mkdir(path.join(repoRoot, 'agents/existing-contract-reader'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'agents/existing-contract-reader/existing-contract-reader.md'), '---\nname: existing-contract-reader\ndescription: LIBRARY FACT: Extract clauses.\n---\nRead contracts.\n')
    const result = await runResourceArchitectTurnService({
      repoRootPath: repoRoot, store: new ResourceArchitectStore(workspacePath), operation: 'conversation',
      history: [{ role: 'user', text: 'ORIGINAL REQUEST: Use this contract and available library.' }], currentPlan: null,
      uploadedDocuments: [{ name: 'synthetic-contract.txt', content: 'UPLOADED EVIDENCE: Termination notice is thirty days.' }], jobId: randomUUID(),
    })
    assert.equal(result.message, FINAL)
    assert.match(JSON.stringify(requests[2]), /UPLOADED EVIDENCE: Termination notice is thirty days/)
    assert.match(JSON.stringify(requests[2]), /LIBRARY FACT: Extract clauses/)
    assert.match(JSON.stringify(requests[2]), /ORIGINAL REQUEST/)
  })
})

test('draft, private review and final answer all see an uploaded file directly before the message that first used it', async () => {
  const pass = JSON.stringify({ verdict: 'pass', findings: [] })
  await withFeedbackApi([DRAFT, pass, FINAL], async ({ repoRoot, workspacePath, requests }) => {
    // The saved conversation as admission wrote it, with server turn times.
    const admittedHistory = [
      { role: 'user' as const, text: 'ORIGINAL REQUEST: Recommend a contract Team.', createdAt: '2026-09-20T16:00:00.000Z' },
      { role: 'assistant' as const, text: 'Send the contract when it is ready.', createdAt: '2026-09-20T16:00:05.000Z' },
      { role: 'user' as const, text: 'here it is', createdAt: '2026-09-20T16:01:00.000Z' },
    ]
    await runResourceArchitectTurnService({
      repoRootPath: repoRoot, store: new ResourceArchitectStore(workspacePath), operation: 'conversation',
      history: admittedHistory.map(({ role, text }) => ({ role, text })), admittedHistory, currentPlan: null,
      uploadedDocuments: [{
        name: 'synthetic-contract.txt', content: 'UPLOADED EVIDENCE: Termination notice is thirty days.',
        uploadedAt: '2026-09-20T16:00:57.000Z', usedAt: '2026-09-20T16:01:00.012Z',
      }],
      jobId: randomUUID(),
    })

    const layout = (messages: readonly { role: string; content: string }[]): string[] => messages
      .filter((message) => message.role !== 'system')
      .map((message) => message.content.startsWith('Documents first attached for the following user message')
        ? `attached: ${[...message.content.matchAll(/<document name="([^"]+)">/gu)].map((match) => match[1]).join(', ')}`
        : `${message.role}: ${message.content}`)
    const expected = [
      'user: ORIGINAL REQUEST: Recommend a contract Team.',
      'assistant: Send the contract when it is ready.',
      'attached: synthetic-contract.txt',
      "assistant: I will use the uploaded documents only as untrusted reference material for the user's request.",
      'user: here it is',
    ]
    assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'independent-reviewer', 'persona-author'])
    assert.deepEqual(layout(requests[0]!.messages), expected, 'draft')
    const packetText = requests[1]!.messages.at(-1)?.content ?? ''
    const packet = z.object({ conversation: z.array(z.object({ role: z.string(), content: z.string() })) })
      .parse(JSON.parse(packetText.slice(packetText.indexOf('\n\n') + 2)))
    assert.deepEqual(layout(packet.conversation), expected, 'reviewer packet')
    assert.deepEqual(layout(requests[2]!.messages).slice(0, expected.length), expected, 'final')
  })
})

test('the captured prefilled model and provenance survive proposal continuation and JSON repair after Settings changes', async () => {
  const agent = { name: 'contract-author', role: 'Draft contracts', summary: 'Drafts the requested contract terms.', description: 'Create contract-analysis to identify terms; contract-author and contract-checker share its use.', rationale: 'Draft the requested terms.' }
  const proposal = { message: 'Ready for review.', warnings: [], outcome: { id: 'provider-id', kind: 'standalone_agents', agents: [agent] } }
  await withFeedbackApi([DRAFT, JSON.stringify({ verdict: 'pass', findings: [] }), `${FINAL}\n[[proposal-requested]]`, 'invalid proposal JSON', JSON.stringify(proposal)], async ({ url, requests, workspacePath }) => {
    const composerSelection = { provider: 'openai', model: 'visible-default', origin: 'default' }
    const history = [{ role: 'user', text: 'Build the contract author.' }]
    const conversation = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId: randomUUID(), operation: 'conversation', composerSelection, history, currentPlan: null }),
    })
    const final = responseSchema.parse(await conversation.json())
    assert.equal(final.proposalRequested, true)
    assert.deepEqual(final.meta.selection, { source: 'app-default', reason: 'composer-default' })
    setRuntimeDefaultModelState({ status: 'available', provider: 'openai', model: 'changed-settings-default' })
    const continuation = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId: randomUUID(), operation: 'proposal', composerSelection, history: [...history, { role: 'assistant', text: final.message }], currentPlan: null }),
    })
    assert.equal(continuation.status, 200)
    const built = z.object({ outcome: z.object({ id: z.string(), agents: z.array(z.object({ name: z.string(), role: z.string(), description: z.string(), rationale: z.string() })) }), meta: z.object({ selection: z.object({ reason: z.string() }) }) }).parse(await continuation.json())
    assert.deepEqual(requests.map((request) => request.model), ['visible-default', 'independent-reviewer', 'visible-default', 'visible-default', 'visible-default'])
    assert.equal(built.meta.selection.reason, 'composer-default')
    const restored = await new ResourceArchitectStore(workspacePath).getPlan(built.outcome.id)
    assert.equal(restored?.kind, 'standalone_agents')
    const planned = built.outcome.agents[0]
    assert.ok(planned)
    assert.match(renderResourceArchitectPlannedAgentBrief(undefined, planned), /contract-analysis.*contract-author and contract-checker share its use/)
  })
})

test('persona and default edits during review take effect only on the following turn', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify({ verdict: 'pass', findings: [] }), FINAL, DRAFT, JSON.stringify({ verdict: 'pass', findings: [] }), FINAL], async ({ url, requests }) => {
    for (const turn of [1, 2]) {
      const response = await fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ jobId: randomUUID(), operation: 'conversation', history: [{ role: 'user', text: `Recommend a Team, turn ${turn}.` }], currentPlan: null }),
      })
      assert.equal(response.status, 200)
    }
    assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'independent-reviewer', 'persona-author', 'next-author', 'next-reviewer', 'next-author'])
    assert.doesNotMatch(JSON.stringify(requests[2]), /NEXT ARCHITECT INSTRUCTIONS/)
    assert.match(JSON.stringify(requests[3]), /NEXT ARCHITECT INSTRUCTIONS/)
    assert.match(JSON.stringify(requests[4]), /NEXT REVIEWER INSTRUCTIONS/)
  }, { onRequest: async (_request, index, repoRoot) => {
    if (index === 2) {
      const architect = path.join(repoRoot, 'agents/resource-architect/resource-architect.md')
      const reviewer = path.join(repoRoot, 'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md')
      const authorText = await fs.readFile(architect, 'utf8')
      const reviewerText = await fs.readFile(reviewer, 'utf8')
      await fs.writeFile(architect, authorText.replace('persona-author', 'next-author').replace('ARCHITECT INSTRUCTIONS', 'NEXT ARCHITECT INSTRUCTIONS'))
      await fs.writeFile(reviewer, reviewerText.replace('independent-reviewer', 'next-reviewer').replace('REVIEWER INSTRUCTIONS', 'NEXT REVIEWER INSTRUCTIONS'))
      setRuntimeDefaultModelState({ status: 'available', provider: 'openai', model: 'changed-default' })
    }
  } })
})

for (const [phase, index] of [['draft', 1], ['review', 2], ['final', 3]] as const) {
  test(`Stop during ${phase} cancels the turn and starts no later phase`, async () => {
    const arrived = barrier()
    const release = barrier()
    await withFeedbackApi([DRAFT, JSON.stringify(REVIEW), FINAL], async ({ url, requests }) => {
      const jobId = randomUUID()
      const turn = fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ jobId, operation: 'conversation', history: [{ role: 'user', text: 'Recommend a contract Team.' }], currentPlan: null }),
      })
      try {
        await arrived.promise
        const cancelled = await fetch(`${url}/create/jobs/${jobId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5_000) })
        assert.equal(cancelled.status, 200)
        const result = z.object({ cancelled: z.literal(true) }).parse(await (await turn).json())
        assert.equal(result.cancelled, true)
        assert.equal(requests.length, index)
        const metricsResponse = await fetch(`${url}/create/resource-architect/metrics`, { signal: AbortSignal.timeout(5_000) })
        const metrics = z.object({ metrics: z.array(z.object({ status: z.string(), review: resourceArchitectFeedbackDiagnosticsSchema })) }).parse(await metricsResponse.json())
        assert.equal(metrics.metrics.at(-1)?.status, 'cancelled')
        assert.equal(metrics.metrics.at(-1)?.review.failedPhase, phase)
      } finally {
        release.resolve()
        await turn
      }
    }, { onRequest: async (_request, requestIndex) => {
      if (requestIndex === index) {
        arrived.resolve()
        await release.promise
      }
    } })
  })
}

test('an invalid review returns a disclosed draft without its proposal marker', async () => {
  await withFeedbackApi([DRAFT, 'not a valid review'], async ({ url, requests, workspacePath }) => {
    const jobId = randomUUID()
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId, draftId: 'draft-unreviewed', operation: 'conversation', history: [{ role: 'user', text: 'Recommend a contract Team.' }], currentPlan: null }),
    })
    const payload = responseSchema.parse(await response.json())
    assert.match(payload.warnings.join('\n'), /Not reviewed.*Reviewer of Agent Architect/)
    assert.equal(payload.message, 'PRIVATE DRAFT: Recommend contract-author and contract-checker.')
    assert.equal(payload.proposalRequested, undefined)
    assert.equal(requests.length, 2, 'Invalid review must not start finalization or a repair call')
    const registry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' })
    try {
      const journal = await readResourceArchitectJournal({ registry, conversationId: 'draft-unreviewed', jobId })
      assert.equal(journal.kind, 'read')
      assert.ok(journal.kind === 'read')
      assert.equal(journal.fallback?.reason, 'review_output_invalid')
      assert.equal(journal.fallback?.action, 'return_unreviewed_draft')
      assert.equal(journal.terminal, 'completed')
      assert.doesNotMatch(JSON.stringify(journal), /PRIVATE DRAFT|PRIVATE CRITIQUE|not a valid review/)
      const metrics = await new ResourceArchitectStore(workspacePath).listTurnMetrics()
      assert.equal(metrics.at(-1)?.review?.reviewStatus, 'not_reviewed')
    } finally { await registry.close() }
  })
})

test('Stop while the fallback journal is waiting for its filesystem lock publishes no draft', async () => {
  await withFeedbackApi([DRAFT, 'invalid review'], async ({ url, requests, workspacePath }) => {
    const jobId = randomUUID()
    const draftId = `draft-${jobId}`
    const activityId = resourceArchitectJournalActivityId(jobId)
    const journalDirectory = path.join(workspacePath, 'create/conversations', draftId,
      '.conversation-activities', activityId, '.runtime/execution-journal')
    await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 })

    // Real lock contention keeps journal admission pending. A filesystem event
    // proves the API attempted that lock before Stop, without polling or mocks.
    const held = await acquireProcessFileLock({
      lockPath: path.join(journalDirectory, 'journal.lock'), record: createCrossProcessFileLockRecord(),
      adapter: crossProcessFileLockAdapter, timeoutMs: 5_000,
    })
    const waitingForAdmission = (async () => {
      for await (const event of fs.watch(journalDirectory, { signal: AbortSignal.timeout(5_000) })) {
        // macOS may deliver our earlier lock publication after the watch opens.
        if (event.filename?.startsWith('journal.lock.candidate-') && !event.filename.endsWith(held.record.nonce)) return
      }
      throw new Error('Journal admission ended without a lock attempt')
    })()
    const turn = fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId, draftId, operation: 'conversation', history: [{ role: 'user', text: 'Recommend a Team.' }], currentPlan: null }),
    })
    try {
      await waitingForAdmission
      const cancellationStored = (async () => {
        for await (const _event of fs.watch(path.join(workspacePath, 'create-jobs'), { signal: AbortSignal.timeout(5_000) })) {
          const state = new FileSystemCreateJobStateStore(workspacePath).read()
          if (state.activeJobs.some((job) => job.jobId === jobId && job.status === 'cancelled')) return
        }
        throw new Error('Stop ended without persisting cancellation')
      })()
      // The cancel endpoint waits for job settlement. Release the held lock
      // only after its real state store proves that Stop was admitted.
      const stopping = fetch(`${url}/create/jobs/${jobId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5_000) })
      await cancellationStored
      await held.release()
      assert.equal((await stopping).status, 200)
      const response = await turn
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { jobId, operation: 'conversation', cancelled: true })
      assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'independent-reviewer'])
      const fresh = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' })
      try {
        const journal = await readResourceArchitectJournal({ registry: fresh, conversationId: draftId, jobId })
        assert.ok(journal.kind === 'read')
        assert.equal(journal.terminal, 'cancelled')
        assert.equal(journal.fallback, undefined)
        assert.equal(journal.eventCount, 1)
      } finally { await fresh.close() }
      const stream = await fetch(`${url}/create/resource-architect/turn?channelId=${jobId}&from=0`, { signal: AbortSignal.timeout(5_000) })
      assert.doesNotMatch(await stream.text(), /PRIVATE DRAFT|PRIVATE CRITIQUE|proposal-requested/)
    } finally {
      await held.release()
      await turn
    }
  })
})

test('a journal append failure prevents publication of an unreviewed draft', async () => {
  await withFeedbackApi([DRAFT, 'invalid review'], async ({ url, workspacePath }) => {
    const jobId = randomUUID()
    const activity = path.join(workspacePath, 'create/conversations/draft-journal-failure/.conversation-activities', resourceArchitectJournalActivityId(jobId))
    await fs.mkdir(activity, { recursive: true })
    await fs.writeFile(path.join(activity, '.runtime'), 'A file prevents journal creation.')
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId, draftId: 'draft-journal-failure', operation: 'conversation', history: [{ role: 'user', text: 'Recommend a Team.' }], currentPlan: null }),
    })
    assert.equal(response.status, 500)
    assert.doesNotMatch(await response.text(), /PRIVATE DRAFT|PRIVATE CRITIQUE/)
    const stream = await fetch(`${url}/create/resource-architect/turn?channelId=${jobId}&from=0`, { signal: AbortSignal.timeout(5_000) })
    assert.doesNotMatch(await stream.text(), /PRIVATE DRAFT|PRIVATE CRITIQUE/)
  })
})

test('disabled review uses one Architect call even when the reviewer persona is missing', async () => {
  await withFeedbackApi([FINAL], async ({ url, requests, repoRoot }) => {
    await fs.rm(path.join(repoRoot, 'agents/reviewer-of-agent-architect'), { recursive: true })
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId: randomUUID(), operation: 'conversation', history: [{ role: 'user', text: 'Recommend a contract Team.' }], currentPlan: null }),
    })
    const payload = responseSchema.parse(await response.json())
    assert.match(payload.warnings.join('\n'), /Review disabled/)
    assert.equal(payload.message, FINAL)
    assert.equal(requests.length, 1)
  }, { reviewEnabled: false })
})

const selectedAgentTurn = (jobId: string) => ({
  jobId, draftId: `draft-${jobId}`, operation: 'conversation',
  history: [{ role: 'user', text: 'Explain the exact run order of the Agent I have open.' }],
  currentPlan: null, selectedResource: { kind: 'agent', id: SELECTED_AGENT },
})
const contextBudgetSchema = z.object({
  selectedAgentPackageTokens: z.number(),
  aggregateEstimatedInputTokens: z.number(),
  phases: z.array(z.object({ phase: z.string(), estimatedInputTokens: z.number(), admissibleInputTokens: z.number(), dispatched: z.boolean() })),
})
function requestText(request: z.infer<typeof requestSchema> | undefined): string {
  return request?.messages.map((message) => message.content).join('\n') ?? ''
}
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}
/** Plain ASCII with nothing JSON has to escape, so its size is the same in every packet. */
function candidateOfBytes(bytes: number): string {
  // Trimmed, because a published answer never ends in whitespace.
  return 'candidate '.repeat(Math.ceil(bytes / 10)).slice(0, bytes).trimEnd()
}

test('the selected package appears exactly once in the draft, review and final requests, with each phase estimated', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify(REVIEW), FINAL], async ({ url, repoRoot, requests }) => {
    writeSelectedAgentPackage(repoRoot)
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(selectedAgentTurn(randomUUID())),
    })
    assert.equal(response.status, 200)
    const payload = responseSchema.parse(await response.json())
    assert.equal(payload.message, FINAL)
    assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'independent-reviewer', 'persona-author'])
    for (const [index, request] of requests.entries()) {
      const text = requestText(request)
      assert.equal(occurrences(text, `<selected_agent_package agent=`), 1, `request ${index} carries the package once`)
      assert.ok(text.includes(SELECTED_PACKAGE_MARKERS.skill), `request ${index} carries it whole`)
    }
    const budget = contextBudgetSchema.parse(resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review).contextBudget)
    assert.deepEqual(budget.phases.map((phase) => [phase.phase, phase.dispatched]), [['draft', true], ['review', true], ['final', true]])
    assert.ok(budget.selectedAgentPackageTokens > 0)
    for (const [index, phase] of budget.phases.entries()) {
      assert.ok(phase.estimatedInputTokens > budget.selectedAgentPackageTokens, `${phase.phase} counts the package it carries`)
      // A real tokenizer reads English at about four bytes a token; the estimate may not run below that.
      assert.ok(phase.estimatedInputTokens >= Math.floor(Buffer.byteLength(requestText(requests[index]), 'utf8') / 4), `${phase.phase} is not under-counted`)
      assert.ok(phase.estimatedInputTokens <= phase.admissibleInputTokens)
    }
    assert.equal(budget.aggregateEstimatedInputTokens, budget.phases.reduce((sum, phase) => sum + phase.estimatedInputTokens, 0))
  })
})

test('a selected package larger than the reference share but inside the draft window reaches the Architect whole', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify(REVIEW), FINAL], async ({ url, repoRoot, requests }) => {
    writeSelectedAgentPackage(repoRoot)
    // The package renders each file line with its indent, so these 6,000 lines
    // come to roughly 46,000 estimated tokens: past the 19,584-token reference
    // share of a 128k-token window, inside its 108,800 admitted tokens with room
    // for the rest of the draft.
    await fs.writeFile(path.join(repoRoot, 'agents', SELECTED_AGENT, 'knowledge', 'archive.md'), 'Evidence line.\n'.repeat(6_000))
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify(selectedAgentTurn(randomUUID())),
    })
    assert.equal(response.status, 200)
    const payload = responseSchema.parse(await response.json())
    assert.doesNotMatch(payload.message, /Nothing was sent/)
    assert.ok(requests.length > 0, 'the Architect was asked')
    assert.equal(requestText(requests[0]).split('Evidence line.').length - 1, 6_000, 'the draft carried every archive line')
  })
})

test('a selected package larger than the draft window refuses the turn before any provider call and is never shortened', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify(REVIEW), FINAL], async ({ url, repoRoot, requests }) => {
    writeSelectedAgentPackage(repoRoot)
    // 450,000 bytes, about 128,600 estimated tokens: more than the 108,800 input
    // tokens a 128k-token window admits for a whole request.
    await fs.writeFile(path.join(repoRoot, 'agents', SELECTED_AGENT, 'knowledge', 'archive.md'), 'Evidence line.\n'.repeat(30_000))
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(selectedAgentTurn(randomUUID())),
    })
    assert.equal(response.status, 200)
    const payload = responseSchema.parse(await response.json())
    assert.equal(requests.length, 0, 'no provider was contacted')
    assert.match(payload.message, /The saved package for Agent researcher is about \d+ tokens \(\d+ bytes\), more than the 108800 input tokens the openai\/persona-author context window admits for a whole request\. Nothing was sent, and the package was not shortened\./)
  })
})

test('a review request too large for the reviewer is not sent and the draft is disclosed as not reviewed', async () => {
  // Larger than a 128k-token window minus its answer reserve, so only the review, which carries it, overflows.
  const candidate = candidateOfBytes(400_000)
  await withFeedbackApi([candidate, JSON.stringify(REVIEW), FINAL], async ({ url, repoRoot, requests }) => {
    writeSelectedAgentPackage(repoRoot)
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify(selectedAgentTurn(randomUUID())),
    })
    assert.equal(response.status, 200)
    const payload = responseSchema.parse(await response.json())
    assert.deepEqual(requests.map((request) => request.model), ['persona-author'], 'the review was not dispatched')
    assert.ok(requestText(requests[0]).includes(SELECTED_PACKAGE_MARKERS.knowledge), 'the draft carried the whole package')
    assert.equal(payload.message, candidate)
    assert.match(payload.warnings.join('\n'), /Not reviewed\. The complete request would not fit the reviewer's context window/)
    const diagnostics = resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review)
    assert.equal(diagnostics.reviewStatus, 'not_reviewed')
    assert.equal(diagnostics.failureReason, 'context_budget_exceeded')
    assert.equal(diagnostics.failedPhase, 'review')
    const budget = contextBudgetSchema.parse(diagnostics.contextBudget)
    assert.deepEqual(budget.phases.map((phase) => [phase.phase, phase.dispatched]), [['draft', true], ['review', false]])
    const review = budget.phases[1]
    assert.ok(review && review.estimatedInputTokens > review.admissibleInputTokens)
  })
})

test('a proposal request dropped because review did not fit says the proposal was not prepared', async () => {
  // Larger than a 128k-token window minus its answer reserve once it rides in the review,
  // and ending with the marker that asks Create to prepare a proposal.
  const candidate = `${candidateOfBytes(400_000)}\n[[proposal-requested]]`
  await withFeedbackApi([candidate, JSON.stringify(REVIEW), FINAL], async ({ url, repoRoot, requests }) => {
    writeSelectedAgentPackage(repoRoot)
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify(selectedAgentTurn(randomUUID())),
    })
    assert.equal(response.status, 200)
    const payload = responseSchema.parse(await response.json())
    assert.deepEqual(requests.map((request) => request.model), ['persona-author'], 'the review was not dispatched')
    assert.equal(payload.proposalRequested, undefined, 'an unreviewed turn still prepares no proposal')
    assert.ok(!payload.message.includes('[[proposal-requested]]'))
    assert.ok(
      payload.warnings.includes('The proposal was not prepared, because a reviewed turn does not fit this model\'s context window. Choose a model with a larger context window, select a different Agent, or shorten the conversation, then ask again.'),
      payload.warnings.join('\n'),
    )
  })
})

test('a final request too large for the Architect is not sent and the reviewed draft is disclosed as not reviewed', async () => {
  // Fits a DeepSeek reviewer's 120k admissible tokens, but not the 108.8k an OpenAI Architect admits once the draft is added back.
  const candidate = candidateOfBytes(385_000)
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'synthetic-deepseek-key'
  try {
    await withFeedbackApi([candidate, JSON.stringify({ verdict: 'pass', findings: [] }), FINAL], async ({ url, repoRoot, requests }) => {
      writeSelectedAgentPackage(repoRoot)
      const reviewerPath = path.join(repoRoot, 'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md')
      await fs.writeFile(reviewerPath, (await fs.readFile(reviewerPath, 'utf8')).replace('provider: openai', 'provider: deepseek'))
      const response = await fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(selectedAgentTurn(randomUUID())),
      })
      assert.equal(response.status, 200)
      const payload = responseSchema.parse(await response.json())
      assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'independent-reviewer'], 'the final phase was not dispatched')
      assert.equal(payload.message, candidate)
      assert.match(payload.warnings.join('\n'), /Not reviewed\. The reviewed answer would not fit the Agent Architect's context window/)
      const diagnostics = resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review)
      assert.equal(diagnostics.reviewStatus, 'not_reviewed')
      assert.equal(diagnostics.failureReason, 'context_budget_exceeded')
      assert.equal(diagnostics.failedPhase, 'final')
      const budget = contextBudgetSchema.parse(diagnostics.contextBudget)
      assert.deepEqual(budget.phases.map((phase) => [phase.phase, phase.dispatched]), [['draft', true], ['review', true], ['final', false]])
    })
  } finally {
    if (previousDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousDeepseekKey
  }
})

/** A library of Agents whose compact rows alone take about `bytes` of the Architect's instructions. */
async function writeLargeAgentLibrary(repoRoot: string, bytes: number): Promise<void> {
  const description = 'Reviews long commercial contracts for renewal, liability and termination terms. '.repeat(50)
  for (let index = 0; index * description.length < bytes; index += 1) {
    const name = `library-agent-${index}`
    await fs.mkdir(path.join(repoRoot, 'agents', name), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'agents', name, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\nprovider: openai\nmodel: gpt-5.4\n---\n\n# ${name}\n`)
  }
}

test('a draft larger than the Architect model admits is refused before any provider call, with or without an Agent open', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify(REVIEW), FINAL], async ({ url, repoRoot, requests }) => {
    writeSelectedAgentPackage(repoRoot)
    // More than the 108,800 input tokens a 128k-token window admits once 15% is held back
    // for the answer, even at four bytes a token.
    await writeLargeAgentLibrary(repoRoot, 480_000)
    for (const turn of [
      { operation: 'conversation' },
      // The package itself fits its share; only the whole draft does not fit.
      { operation: 'proposal', selectedResource: { kind: 'agent', id: SELECTED_AGENT } },
    ]) {
      const jobId = randomUUID()
      const response = await fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ jobId, draftId: `draft-${jobId}`, history: [{ role: 'user', text: 'Recommend a contract Team.' }], currentPlan: null, ...turn }),
      })
      assert.equal(response.status, 200, turn.operation)
      const payload = responseSchema.parse(await response.json())
      assert.match(
        payload.message,
        /Agent Architect draft request was refused before launch: estimated \d+ input tokens \(.*\) exceeds the 108800 admissible tokens of a 128000-token context window/,
        turn.operation,
      )
    }
    assert.equal(requests.length, 0, 'no provider was contacted')
  })
})

test('a proposal repair too large for the Architect model is refused before it is sent', async () => {
  // Plain text fails the proposal JSON contract, so the turn needs a repair.
  // 147,000 bytes is about 42,000 estimated tokens.
  const unparseable = 'Not a JSON proposal. '.repeat(7_000)
  await withFeedbackApi([unparseable, 'The repair should never be requested.'], async ({ url, repoRoot, requests }) => {
    // About 86,000 estimated tokens of library rows: the draft fits the 108,800
    // input tokens a 128k-token window admits; the draft plus the first answer does not.
    await writeLargeAgentLibrary(repoRoot, 300_000)
    const jobId = randomUUID()
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId, draftId: `draft-${jobId}`, operation: 'proposal', history: [{ role: 'user', text: 'Recommend a contract Team.' }], currentPlan: null }),
    })
    assert.equal(response.status, 200)
    const payload = responseSchema.parse(await response.json())
    assert.equal(requests.length, 1, 'only the first proposal answer was requested')
    assert.match(
      payload.message,
      /Agent Architect repair request was refused before launch: estimated \d+ input tokens \(.*\) exceeds the 108800 admissible tokens of a 128000-token context window/,
    )
  })
})

test('a reviewer that is never contacted is not counted among the phases sent', async () => {
  await withFeedbackApi([DRAFT, JSON.stringify({ verdict: 'pass', findings: [] }), FINAL], async ({ url, requests, repoRoot }) => {
    const persona = path.join(repoRoot, 'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md')
    await fs.writeFile(persona, (await fs.readFile(persona, 'utf8')).replace('provider: openai', 'provider: deepseek'))
    setRuntimeDefaultModelState({ status: 'available', provider: 'openai', model: 'default-reviewer' })
    const response = await fetch(`${url}/create/resource-architect/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jobId: randomUUID(), operation: 'conversation', history: [{ role: 'user', text: 'Recommend a Team.' }], currentPlan: null }),
    })
    const payload = responseSchema.parse(await response.json())
    // The configured DeepSeek reviewer has no key, so only the default reviewer is asked.
    assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'default-reviewer', 'persona-author'])
    const budget = contextBudgetSchema.parse(resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review).contextBudget)
    assert.deepEqual(budget.phases.map((phase) => [phase.phase, phase.dispatched]), [['draft', true], ['review', true], ['final', true]])
    assert.equal(budget.aggregateEstimatedInputTokens, budget.phases.reduce((sum, phase) => sum + phase.estimatedInputTokens, 0))
  }, { missingDeepseekKey: true })
})

test('a fallback reviewer too small for the request is not sent, and the configured reviewer is disclosed as asked', async () => {
  // Fits the 120,000 input tokens a DeepSeek reviewer admits, but not the 108,800 of the OpenAI default.
  const candidate = candidateOfBytes(395_000)
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'synthetic-deepseek-key'
  try {
    await withFeedbackApi([candidate, { status: 401, code: 'invalid_api_key' }], async ({ url, repoRoot, requests }) => {
      writeSelectedAgentPackage(repoRoot)
      const reviewerPath = path.join(repoRoot, 'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md')
      await fs.writeFile(reviewerPath, (await fs.readFile(reviewerPath, 'utf8')).replace('provider: openai', 'provider: deepseek'))
      setRuntimeDefaultModelState({ status: 'available', provider: 'openai', model: 'default-reviewer' })
      const response = await fetch(`${url}/create/resource-architect/turn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(selectedAgentTurn(randomUUID())),
      })
      assert.equal(response.status, 200)
      const payload = responseSchema.parse(await response.json())
      assert.deepEqual(requests.map((request) => request.model), ['persona-author', 'independent-reviewer'], 'the fallback review was not dispatched')
      assert.equal(payload.message, candidate)
      assert.deepEqual(payload.warnings, [
        "Not reviewed. The configured model for Reviewer of Agent Architect was unavailable, and the complete request would not fit the application default's context window, so the application default was not asked.",
      ])
      const diagnostics = resourceArchitectFeedbackDiagnosticsSchema.parse(payload.meta.review)
      assert.equal(diagnostics.defaultFallbackAttempted, true)
      assert.equal(diagnostics.failureReason, 'context_budget_exceeded')
      const budget = contextBudgetSchema.parse(diagnostics.contextBudget)
      assert.deepEqual(budget.phases.map((phase) => [phase.phase, phase.dispatched]), [['draft', true], ['review', true], ['review', false]])
    })
  } finally {
    if (previousDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousDeepseekKey
  }
})
