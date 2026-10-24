import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { z } from 'zod'
import { MCP_WORKER_TURN_CONTRACT_VERSION, parseMcpWorkerTurnRequest } from '../../domains/mcp/mcp-worker-turn.js'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { evaluateMcpWorkflowPreflight } from '../../domains/mcp/mcp-workflow-preflight.js'
import { runMcpWorkerTurn } from '../../domains/mcp/mcp-worker-turn-client.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { clearRuntimeEffortSupport, setRuntimeEffortSupport } from '../../domains/provider/effort-support.js'
import { THINKING_LEVELS } from '../../contracts/thinking-levels.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import { PROCESS_IDENTITY_ARGUMENT } from '../../domains/sessions/task-process-supervisor.js'
import { buildRuntimeAssignmentEnvironment } from '../../domains/runtime/runtime-paths.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { handleMcpWorkerTurnRoute } from '../../server/routes/mcp-worker-turn.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpWorkerTurnService } from '../../services/mcp-worker-turn-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { FileSystemWorkflowStateStore, hashWorkflowContent } from '../../workflows/workflow-state-store.js'
import { startDeterministicOpenAiServer } from '../electron/support/deterministic-openai-server.js'
import { runAgent } from '../../domains/agent-execution/agent-runner.js'
import { dispatchWithFailurePolicy } from '../../domains/agent-execution/failure-policy.js'

async function runQuestionClientProcess(turn: Parameters<typeof runMcpWorkerTurn>[0]) {
  const env = turn.environment ?? {}
  const request = parseMcpWorkerTurnRequest({
    version: MCP_WORKER_TURN_CONTRACT_VERSION, sessionId: env.TEAM_RUNTIME_SESSION_ID, runId: env.TEAM_RUNTIME_RUN_ID,
    assignmentId: env.TEAM_RUNTIME_ASSIGNMENT_ID, taskId: env.TEAM_RUNTIME_TASK_ID, processIdentity: env.TEAM_RUNTIME_PROCESS_IDENTITY,
    workflowId: env.TEAM_RUNTIME_WORKFLOW_ID, workflowStepId: env.TEAM_RUNTIME_WORKFLOW_STEP_ID,
    agentPath: `agents/${turn.options.agentName}`, provider: turn.provider, model: turn.options.model, thinking: turn.options.thinking,
    systemPrompt: turn.options.systemPrompt, userMessage: turn.options.userMessage, questionContext: turn.options.questionContext,
  })
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const response = await fetch(input.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.request), signal: AbortSignal.timeout(5000) });
    process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
  `], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(JSON.stringify({ url: env.PIPELINE_MCP_WORKER_TURN_URL, request }))
  let stdout = ''; let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(7_000) })
  assert.equal(code, 0, stderr)
  return z.object({ status: z.number(), body: z.object({ kind: z.string().optional() }).passthrough() }).parse(JSON.parse(stdout))
}

async function createWorkerFixture(t: TestContext, structured = false, failContinuation = false) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-question-worker-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  // The external paid model is the only replaced boundary.
  const requests: string[] = []
  const model = await startDeterministicOpenAiServer({
    resolveTurn: (body) => {
      requests.push(body)
      if (failContinuation && body.includes('Marta')) return { toolName: 'unavailable_tool', arguments: {} }
      if (structured && body.includes('You are the dedication writer.')) return { text: JSON.stringify(body.includes('Marta')
        ? { decision: 'complete', reason: 'The name is known.', finalResponse: 'For Marta.' }
        : { decision: 'needs_input', progress: 'I need the recipient to finish.', questions: [{ question: 'Who?', reason: 'Required.' }] }) }
      if (body.includes('Marta')) return { text: 'For Marta, a flower opens in the morning light.' }
      return body.includes('You are the dedication writer.') ? {
      toolName: 'request_human_input', arguments: {
        progress: 'I need the recipient to finish.',
        questions: [{ question: 'Who is the dedication for?', reason: 'A recipient is required.' }],
      },
      } : { text: 'Ready.' }
    },
  })
  t.after(() => model.close())
  const secretCodec = {
    encrypt: (value: string) => Buffer.from(value).toString('base64'),
    decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
  }
  const providers = new ProviderSettingsService({ storagePath: path.join(workspace, 'providers.json'), secretCodec })
  const connection = await providers.saveConnection({
    kind: 'openai-compatible', name: 'Question fixture', baseUrl: model.baseUrl, apiKey: 'fixture-only-key', enabled: true,
  })
  await providers.validateConnection(connection.id)
  await providers.setModelEnabled(connection.id, 'gpt-5.4-mini', true)
  const provider = configuredProviderName(connection.id)
  const sessionStore = new FileSystemSessionStore(workspace)
  const session = await sessionStore.createSession({ title: 'Agent question' })
  const mcpResolution = evaluateMcpWorkflowPreflight({
    workflowId: 'question-workflow', generatedAt: '2026-09-19T12:00:00.000Z',
    steps: [{ stepId: 'write', requirements: [], scheduledAgents: [{
      agentPath: 'agents/writer', provider, model: 'gpt-5.4-mini', supportState: 'supported',
    }, {
      agentPath: 'agents/editor', provider, model: 'gpt-5.4-mini', supportState: 'supported',
    }] }], servers: [], grants: [],
  }).snapshot
  const task = await sessionStore.createTaskRecord(session.id, { workflowId: 'question-workflow', brief: 'Write a dedication.', mcpResolution })
  assert.ok(task?.assignmentId)
  assert.ok(task.assignmentPath)
  const processIdentity = '55555555-5555-4555-8555-555555555555'
  const child = spawn(process.execPath, [
    '-e', 'process.on("message", () => {}); process.send("ready")', '--', `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`,
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(2_000) })
    child.kill('SIGKILL')
    await exited
  })
  await once(child, 'message', { signal: AbortSignal.timeout(2_000) })
  assert.ok(child.pid)
  const running = await sessionStore.compareAndSetTaskRecord(session.id, task.id, ['queued'], {
    status: 'running', processIdentity, executionAttemptId: processIdentity,
    executionAttemptNumber: 1, ...await currentAttemptScope(task, 1),
    ownerInstanceId: sessionStore.getInstanceId(), pid: child.pid,
  })
  assert.ok(running?.updated)
  assert.ok(sessionStore.hasValidTaskProcessIdentity(running.task))
  const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)
  await stateStore.initialize({
    manifest: {
      taskId: task.id, sessionId: session.id, rootRunId: task.runId, workflowId: task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('question-workflow'), briefHash: hashWorkflowContent('dedication'),
      teamDefinitionHashes: { poets: hashWorkflowContent('poets') }, runtimeVersion: 'fixture-v1',
    }, executionAttemptId: processIdentity,
    steps: [{
      stepId: 'write', stepIndex: 0, stepType: 'team', team: 'poets', childRunId: task.assignmentId,
      definitionHash: hashWorkflowContent('write'), recoveryPolicy: 'safe_retry',
      inputArtifact: 'brief.md', resultArtifact: 'poem.md', requestedResultType: 'artifact:poem.md',
    }],
  })
  await stateStore.update({ expectedRevision: 0, executionAttemptId: processIdentity, mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'launching'; step.attemptCount = 1; draft.currentStepId = step.stepId
  } })
  await stateStore.update({ expectedRevision: 1, executionAttemptId: processIdentity, mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'running'
  } })
  const manager = new McpClientManager()
  t.after(() => manager.closeAll())
  const settings = new McpSettingsService({ storagePath: path.join(workspace, 'mcps.json'), secretCodec, clientManager: manager })
  const leaseStore = new McpRunLeaseStore()
  const service = new McpWorkerTurnService({
    workspacePath: workspace, sessionStore,
    agentToolService: new McpAgentToolService({
      leaseStore, providerSettingsService: providers,
      broker: new McpParentBroker({
        lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE, settingsService: settings, clientManager: manager,
        grantResolver: () => false, leaseResolver: (context) => leaseStore.resolve(context),
      }),
    }),
  })
  const server = http.createServer((req, res) => {
    // The route owns and serializes all expected errors.
    void handleMcpWorkerTurnRoute({ req, res, service }).catch(() => res.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const location = buildSessionRunAssignmentLocation(workspace, { sessionId: session.id, runId: task.runId, assignmentId: task.assignmentId })
  assert.ok(location)

  const turn: Parameters<typeof runMcpWorkerTurn>[0] = {
    provider, signal: AbortSignal.timeout(2_000),
    environment: {
      ...buildRuntimeAssignmentEnvironment(location),
      PIPELINE_MCP_WORKER_TURN_URL: `http://127.0.0.1:${address.port}/worker`,
      TEAM_RUNTIME_TASK_ID: task.id, TEAM_RUNTIME_PROCESS_IDENTITY: processIdentity,
      TEAM_RUNTIME_WORKFLOW_ID: task.workflowId, TEAM_RUNTIME_WORKFLOW_STEP_ID: 'write',
    },
    options: {
      agentName: 'writer', model: 'gpt-5.4-mini', thinking: 'low',
      systemPrompt: 'You are the dedication writer.', userMessage: 'Ask for the recipient.',
      questionContext: { logicalInvocationId: 'chain-step-one', dispatchId: 'dispatch-one', teamId: 'poets', stageId: 'chain' },
    },
  }
  return { turn, stateStore, sessionStore, task, requests, model, child, workspace, providers, connectionId: connection.id }
}

test('an ordinary turn without a supported question bridge preserves its legacy provider route', async (t) => {
  const { turn, stateStore, providers, connectionId, model } = await createWorkerFixture(t)
  await providers.setModelEnabled(connectionId, 'gpt-5.4-mini', false)
  const outcome = await runMcpWorkerTurn(turn)
  assert.equal(outcome?.kind, 'provider-unsupported')
  assert.equal((await stateStore.load())?.state.agentQuestions, undefined)
  assert.equal(model.requestCount(), 0)
})

test('two worker clients cannot buy the same resumed provider turn twice', async (t) => {
  const { turn, stateStore, sessionStore, task, model } = await createWorkerFixture(t)
  const waiting = await runMcpWorkerTurn(turn)
  assert.equal(waiting?.kind, 'awaiting_input')
  if (waiting?.kind !== 'awaiting_input') throw new Error('Expected a question.')
  const { interaction } = await stateStore.readAgentQuestion(waiting.interruption.interactionId)
  await stateStore.submitAgentInput({ taskId: task.id, sessionId: task.sessionId, interactionId: interaction.interactionId,
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: Object.fromEntries(interaction.questionIds.map((id) => [id, 'Marta'])) })
  const nextExecutionAttemptId = '66666666-6666-4666-8666-666666666666'
  await stateStore.claimAgentQuestionContinuation({ interactionId: interaction.interactionId, submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: interaction.ownerExecutionAttemptId, nextExecutionAttemptId, continuationAdmissionRequestId: 'continue-one' })
  await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: nextExecutionAttemptId })
  model.blockResponses()
  const requestCount = model.requestCount()
  const first = runQuestionClientProcess(turn)
  void first.catch(() => undefined)
  await model.waitForRequest(requestCount + 1)
  try {
    assert.equal((await runQuestionClientProcess(turn)).status, 409)
    assert.equal(model.requestCount(), requestCount + 1, 'The second worker must not reach the paid provider.')
  } finally { model.releaseBlockedResponses() }
  const completed = await first
  assert.equal(completed.status, 200)
  assert.equal(completed.body.kind, 'completed')
})

test('a dead resumed worker with an unknown provider outcome blocks instead of replaying', async (t) => {
  const { turn, stateStore, sessionStore, task, model, child, workspace } = await createWorkerFixture(t)
  const waiting = await runMcpWorkerTurn(turn)
  assert.equal(waiting?.kind, 'awaiting_input')
  if (waiting?.kind !== 'awaiting_input') throw new Error('Expected a question.')
  const { interaction } = await stateStore.readAgentQuestion(waiting.interruption.interactionId)
  await stateStore.submitAgentInput({ taskId: task.id, sessionId: task.sessionId, interactionId: interaction.interactionId,
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: Object.fromEntries(interaction.questionIds.map((id) => [id, 'Marta'])) })
  const nextExecutionAttemptId = '66666666-6666-4666-8666-666666666666'
  await stateStore.claimAgentQuestionContinuation({ interactionId: interaction.interactionId, submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: interaction.ownerExecutionAttemptId, nextExecutionAttemptId, continuationAdmissionRequestId: 'continue-one' })
  await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: nextExecutionAttemptId })
  model.blockResponses()
  const before = model.requestCount()
  const request = runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(5_000) })
  void request.catch(() => undefined)
  await model.waitForRequest(before + 1)
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(2_000) })
  child.kill('SIGKILL')
  await exited
  try {
    await new FileSystemSessionStore(workspace).reconcileTaskRecords(task.sessionId)
    assert.equal((await sessionStore.getTaskRecord(task.sessionId, task.id))?.status, 'blocked')
    const saved = await stateStore.readAgentQuestion(interaction.interactionId)
    assert.equal(saved.interaction.status, 'blocked')
    assert.ok(saved.interaction.status === 'blocked' && saved.interaction.blockCode === 'continuation_indeterminate')
    assert.equal(model.requestCount(), before + 1)
  } finally { model.releaseBlockedResponses(); await request.catch(() => undefined) }
})

test('a structured lead captures and resumes its decision through the same owned worker boundary', async (t) => {
  const { turn, stateStore, sessionStore, task, requests } = await createWorkerFixture(t, true)
  const options = { ...turn.options, providerConfig: { temperature: 0.25, max_tokens: 512 }, outputSchema: { type: 'object', properties: { decision: { enum: ['needs_input', 'complete'] } }, required: ['decision'] } }
  const waiting = await runMcpWorkerTurn({ ...turn, options })
  assert.equal(waiting?.kind, 'awaiting_input')
  if (waiting?.kind !== 'awaiting_input') throw new Error('Expected the lead to wait.')
  const saved = await stateStore.readAgentQuestion(waiting.interruption.interactionId)
  assert.deepEqual(saved.continuation.outputSchema, options.outputSchema)
  const sent: unknown = JSON.parse(requests.find((body) => body.includes('You are the dedication writer.')) ?? '{}')
  assert.ok(sent && typeof sent === 'object' && 'temperature' in sent && 'max_tokens' in sent)
  assert.equal(sent.temperature, 0.25)
  assert.equal(sent.max_tokens, 512)
  const questionId = saved.interaction.questionIds[0]
  assert.ok(questionId)
  await stateStore.submitAgentInput({
    sessionId: task.sessionId, taskId: task.id, interactionId: saved.interaction.interactionId,
    expectedInteractionRevision: saved.interaction.revision, expectedRequestDigest: saved.interaction.requestDigest,
    submissionId: 'lead-answer', answers: { [questionId]: 'Marta' },
  })
  const attemptId = '66666666-6666-4666-8666-666666666666'
  await stateStore.claimAgentQuestionContinuation({
    interactionId: saved.interaction.interactionId, submissionId: 'lead-answer',
    expectedOwnerExecutionAttemptId: saved.interaction.ownerExecutionAttemptId,
    nextExecutionAttemptId: attemptId, continuationAdmissionRequestId: 'lead-continue',
  })
  await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: attemptId })
  await assert.rejects(runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000), options: {
    ...options, outputSchema: { ...options.outputSchema, properties: { decision: { enum: ['select', 'needs_input'] } } },
  } }), /could not be completed|execution_failed/,
  'A changed control contract must not silently replace the pending lead decision.')
  const completed = await runMcpWorkerTurn({ ...turn, options, signal: AbortSignal.timeout(2_000) })
  assert.equal(completed?.kind, 'completed')
  if (completed?.kind !== 'completed') throw new Error('Expected a completed lead decision.')
  assert.equal(completed.text, '{"decision":"complete","reason":"The name is known.","finalResponse":"For Marta."}')
  assert.equal(completed.availableToolCount, 0)
  assert.equal(requests.filter((body) => body.includes('Marta')).length, 1)
  assert.equal((await stateStore.readAgentQuestion(saved.interaction.interactionId)).interaction.status, 'resolved')
  await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000), options: {
    ...turn.options, agentName: 'editor', systemPrompt: 'You are the editor.',
    questionContext: { logicalInvocationId: 'editor-slot', dispatchId: 'editor-dispatch', teamId: 'poets', stageId: 'discussion' },
  } })
  assert.match(requests.find((body) => body.includes('You are the editor.')) ?? '', /Marta/,
    'A later agent receives accepted human facts without requiring the lead to repeat them.')
})

test('a managed worker with no external tools returns its durable question through the real HTTP boundary', async (t) => {
  const { turn, stateStore, requests, task } = await createWorkerFixture(t)
  const result = await runMcpWorkerTurn(turn)
  assert.match(requests.find((body) => body.includes('You are the dedication writer.')) ?? '', /If only one fact is required, ask only for that fact/)
  assert.equal(result?.kind, 'awaiting_input')
  if (result?.kind !== 'awaiting_input') throw new Error('Expected a managed worker question.')
  const restored = await stateStore.readAgentQuestion(result.interruption.interactionId)
  assert.equal(restored.interaction.invocation.agentId, 'writer')
  assert.equal(restored.interaction.invocation.logicalInvocationId, 'chain-step-one')
  assert.equal(restored.request.questions[0]?.question, 'Who is the dedication for?')
  assert.equal(restored.continuation.evidence?.providerRounds, 1)
  assert.equal(restored.continuation.evidence?.toolCalls, 1)
  assert.ok(task.assignmentPath)
  const events = await fs.readFile(path.join(task.assignmentPath, 'logs/runtime-events.jsonl'), 'utf8')
  assert.match(events, /run.agent_question.requested/)
  assert.ok(!events.includes('Who is the dedication for?'))
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 7, totalTokens: 12 })
})

test('runAgent returns a managed question instead of falling through to another provider call', async (t) => {
  const { turn, stateStore } = await createWorkerFixture(t)
  assert.ok(turn.environment)
  const result = await runAgent({
    ...turn.options, provider: turn.provider, workerEnvironment: turn.environment,
    signal: AbortSignal.timeout(2_000),
  })

  assert.equal(result.interruption?.kind, 'awaiting_input')
  assert.equal(result.text, '')
  assert.equal(result.inputTokens, 5)
  assert.equal(result.outputTokens, 7)
  assert.equal((await stateStore.load())?.state.agentQuestions?.interactions.length, 1)
})

test('the same managed agent finishes with its answer and replays the persisted result without another model turn', async (t) => {
  const { turn, stateStore, sessionStore, task, requests } = await createWorkerFixture(t)
  const waiting = await runMcpWorkerTurn({ ...turn, options: { ...turn.options, providerConfig: { temperature: 0.25, max_tokens: 512 } } })
  assert.equal(waiting?.kind, 'awaiting_input')
  if (waiting?.kind !== 'awaiting_input') throw new Error('Expected a question.')
  const { interaction } = await stateStore.readAgentQuestion(waiting.interruption.interactionId)
  const questionId = interaction.questionIds[0]
  assert.ok(questionId)
  await stateStore.submitAgentInput({
    sessionId: task.sessionId, taskId: task.id, interactionId: interaction.interactionId,
    expectedInteractionRevision: interaction.revision, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: { [questionId]: 'Marta' },
  })
  const nextExecutionAttemptId = '66666666-6666-4666-8666-666666666666'
  await stateStore.claimAgentQuestionContinuation({
    interactionId: interaction.interactionId, submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: interaction.ownerExecutionAttemptId,
    nextExecutionAttemptId, continuationAdmissionRequestId: 'continue-one',
  })
  await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: nextExecutionAttemptId })

  const result = await runMcpWorkerTurn({ ...turn, options: { ...turn.options, providerConfig: { temperature: 0.8, max_tokens: 256 } }, signal: AbortSignal.timeout(2_000) })
  assert.equal(result?.kind, 'completed')
  if (result?.kind !== 'completed') throw new Error('Expected the completed dedication.')
  assert.equal(result.text, 'For Marta, a flower opens in the morning light.')
  assert.equal((await stateStore.readAgentQuestion(interaction.interactionId)).interaction.status, 'resolved')
  const resumed = requests.filter((body) => body.includes('Marta'))
  assert.equal(resumed.length, 1)
  assert.match(resumed[0] ?? '', /You are the dedication writer\./, 'The answer must return to the original agent instructions.')
  const requestBody: unknown = JSON.parse(resumed[0] ?? '')
  assert.ok(requestBody && typeof requestBody === 'object' && 'tools' in requestBody)
  assert.deepEqual(requestBody.tools, [], 'The used question capability must be removed.')
  assert.ok('temperature' in requestBody && 'max_tokens' in requestBody)
  assert.equal(requestBody.temperature, 0.25, 'Answering must preserve the original provider settings.')
  assert.equal(requestBody.max_tokens, 512)

  const beforeReplay = requests.length
  const replay = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) })
  assert.equal(replay?.kind, 'completed')
  assert.equal(requests.length, beforeReplay, 'Replaying a completed invocation must not buy another turn.')
})

for (const stageType of ['chain', 'discussion', 'review', 'broadcast', 'pipeline'] as const) {
test(`a ${stageType} dispatch returns a wait without validation, retry, fallback or accepted output`, async (t) => {
  const { turn, stateStore, task, requests } = await createWorkerFixture(t)
  assert.ok(task.assignmentPath)
  assert.ok(turn.environment)
  const previous = { ...process.env }
  Object.assign(process.env, turn.environment)
  t.after(() => { process.env = previous })
  const result = await dispatchWithFailurePolicy({
    rosterEntry: undefined,
    agent: {
      name: 'writer', model: 'gpt-5.4-mini', thinking: 'low', tools: [],
      systemPrompt: 'You are the dedication writer.', experienceContent: '', experienceEnabled: false,
      skillsContent: '', knowledgeContent: '', agentDir: '', color: 1, provider: turn.provider, providerConfig: {},
      selection: null,
    },
    finalPrompt: 'You are the dedication writer.', userMessage: 'Ask for the recipient.',
    state: {
      sessionId: task.runId, currentLevelIndex: 0, levelStates: new Map(), totalCost: 0,
      startTime: 0, timerStarted: false, endTime: null, spawnDepth: 1,
    },
    workspacePath: task.assignmentPath, outputPath: task.assignmentPath, metrics: undefined,
    logicalInvocationId: `${stageType}-step-one`, teamName: 'poets', stageType, levelId: stageType,
    sessionId: task.runId, errorLogPath: task.assignmentPath,
    policy: { policy: 'retry', maxRetries: 2 }, signal: AbortSignal.timeout(2_000),
    validateResult: () => { throw new Error('An unfinished turn must never be validated as an answer.') },
  })

  assert.ok('interruption' in result)
  assert.equal(result.text, '')
  assert.equal(requests.filter((body) => body.includes('You are the dedication writer.')).length, 1)
  assert.equal((await stateStore.load())?.state.status, 'awaiting_input')
})
}

for (const crashPoint of ['before provider launch', 'after result acceptance'] as const) {
  test(`recovery ${crashPoint} completes the original answered invocation without buying duplicate work`, async (t) => {
    const { turn, stateStore, sessionStore, task, model } = await createWorkerFixture(t)
    const waiting = await runMcpWorkerTurn(turn)
    assert.ok(waiting?.kind === 'awaiting_input')
    const { interaction } = await stateStore.readAgentQuestion(waiting.interruption.interactionId)
    await stateStore.submitAgentInput({ taskId: task.id, sessionId: task.sessionId, interactionId: interaction.interactionId,
      expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
      submissionId: 'answer-one', answers: Object.fromEntries(interaction.questionIds.map((id) => [id, 'Marta'])) })
    const admitted = '66666666-6666-4666-8666-666666666666'
    const recovered = '77777777-7777-4777-8777-777777777777'
    await stateStore.claimAgentQuestionContinuation({ interactionId: interaction.interactionId, submissionId: 'answer-one',
      expectedOwnerExecutionAttemptId: interaction.ownerExecutionAttemptId, nextExecutionAttemptId: admitted, continuationAdmissionRequestId: 'continue-one' })
    await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: admitted })
    // These are two fixed crash windows; every case asserts the same complete public outcome.
    if (crashPoint === 'after result acceptance') await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) })
    const snapshot = await stateStore.load(); assert.ok(snapshot)
    await stateStore.claimExecutionAttempt({ expectedRevision: snapshot.state.revision, expectedOwnerExecutionAttemptId: admitted, nextExecutionAttemptId: recovered })
    await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: recovered })
    const completed = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) })
    assert.ok(completed?.kind === 'completed')
    assert.equal(completed.text, 'For Marta, a flower opens in the morning light.')
    assert.equal(model.requestCount(), 2)
    assert.equal((await stateStore.readAgentQuestion(interaction.interactionId)).interaction.status, 'resolved')
  })
}

test('a changed agent definition blocks the saved continuation without retrying a provider', async (t) => {
  const { turn, stateStore, model } = await createWorkerFixture(t)
  const waiting = await runMcpWorkerTurn(turn)
  assert.ok(waiting?.kind === 'awaiting_input')
  const blocked = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000),
    options: { ...turn.options, systemPrompt: 'You are a different agent definition.' } })
  assert.ok(blocked?.kind === 'blocked')
  assert.equal(blocked.interruption.code, 'continuation_unavailable')
  assert.equal(model.requestCount(), 1)
  assert.equal((await stateStore.readAgentQuestion(waiting.interruption.interactionId)).interaction.status, 'blocked')
})

test('a failed answered turn blocks its original invocation instead of inviting retry or fallback', async (t) => {
  const { turn, stateStore, sessionStore, task, model } = await createWorkerFixture(t, false, true)
  const waiting = await runMcpWorkerTurn(turn)
  assert.ok(waiting?.kind === 'awaiting_input')
  const { interaction } = await stateStore.readAgentQuestion(waiting.interruption.interactionId)
  await stateStore.submitAgentInput({ taskId: task.id, sessionId: task.sessionId, interactionId: interaction.interactionId,
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: Object.fromEntries(interaction.questionIds.map((id) => [id, 'Marta'])) })
  const nextExecutionAttemptId = '66666666-6666-4666-8666-666666666666'
  await stateStore.claimAgentQuestionContinuation({ interactionId: interaction.interactionId, submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: interaction.ownerExecutionAttemptId, nextExecutionAttemptId, continuationAdmissionRequestId: 'continue-one' })
  await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: nextExecutionAttemptId })
  const stopped = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) })
  assert.ok(stopped?.kind === 'blocked')
  assert.equal(stopped.interruption.code, 'continuation_indeterminate')
  assert.equal((await stateStore.readAgentQuestion(interaction.interactionId)).interaction.status, 'blocked')
  assert.equal((await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) }))?.kind, 'blocked')
  assert.equal(model.requestCount(), 2)
})

/** Drive one agent's question round all the way to an accepted response. */
async function completeOneRound(fixture: Awaited<ReturnType<typeof createWorkerFixture>>) {
  const { turn, stateStore, sessionStore, task } = fixture
  const waiting = await runMcpWorkerTurn(turn)
  assert.ok(waiting?.kind === 'awaiting_input')
  const { interaction } = await stateStore.readAgentQuestion(waiting.interruption.interactionId)
  await stateStore.submitAgentInput({
    taskId: task.id, sessionId: task.sessionId, interactionId: interaction.interactionId,
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: Object.fromEntries(interaction.questionIds.map((id) => [id, 'Marta'])),
  })
  const nextExecutionAttemptId = '66666666-6666-4666-8666-666666666666'
  await stateStore.claimAgentQuestionContinuation({
    interactionId: interaction.interactionId, submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: interaction.ownerExecutionAttemptId,
    nextExecutionAttemptId, continuationAdmissionRequestId: 'continue-one',
  })
  await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: nextExecutionAttemptId })
  return { interaction, nextExecutionAttemptId }
}

test('an agent that spent its round earlier keeps the ordinary route when its provider stops supporting tools', async (t) => {
  const fixture = await createWorkerFixture(t)
  const { turn, stateStore, providers, connectionId } = fixture
  const { interaction } = await completeOneRound(fixture)
  const finished = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) })
  assert.equal(finished?.kind, 'completed')
  await providers.setModelEnabled(connectionId, 'gpt-5.4-mini', false)

  // A later stage dispatches the same agent under a new logical invocation. It
  // holds no reserved continuation, so it is ordinary work.
  const later = await runMcpWorkerTurn({
    ...turn, signal: AbortSignal.timeout(2_000),
    options: {
      ...turn.options,
      questionContext: { logicalInvocationId: 'chain-step-two', dispatchId: 'dispatch-two', teamId: 'poets', stageId: 'chain' },
    },
  })

  assert.equal(later?.kind, 'provider-unsupported',
    'An agent that merely spent its round must take the route it would have taken had it never asked')
  const answered = await stateStore.readAgentQuestion(interaction.interactionId)
  assert.equal(answered.interaction.status, 'resolved')
  assert.equal(answered.interaction.blockCode, undefined,
    'An ordinary unsupported turn must write nothing against the answered round')
})

test('a failed continuation records the classified reason it failed', async (t) => {
  const fixture = await createWorkerFixture(t, false, true)
  const { turn, stateStore, task } = fixture
  const { interaction } = await completeOneRound(fixture)

  const stopped = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) })

  assert.ok(stopped?.kind === 'blocked')
  assert.equal(stopped.interruption.code, 'continuation_indeterminate')
  const events = (await fs.readFile(path.join(task.assignmentPath!, 'logs/runtime-events.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  const failure = events.find((event) => event.event === 'run.agent_question.continuation_failed')
  assert.ok(failure, 'A failed continuation must leave a record of why it failed')
  assert.equal(failure.interaction_id, interaction.interactionId)
  assert.equal(failure.blocker_persisted, true)
  // The exact classified code, so an unrelated failure or an invented one
  // cannot satisfy this.
  assert.equal(failure.failure_code, 'tool_not_found')
  assert.equal(failure.failure_retryable, false)
})

test('a continuation that loses its owned state still blocks and keeps the original reason', async (t) => {
  const fixture = await createWorkerFixture(t, false, true)
  const { turn, stateStore, sessionStore, task, model } = fixture
  const { interaction } = await completeOneRound(fixture)
  // Hold the failing continuation response so the run can lose its owner while
  // the turn is still in flight, which is what makes the blocker write fail.
  model.blockResponses()
  const running = runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(10_000) })
  await model.waitForRequest(2)
  await stateStore.cancelFromAuthoritativeTask({ taskId: task.id, summary: 'Cancelled while the agent was continuing.' })
  model.releaseBlockedResponses()

  const stopped = await running

  assert.ok(stopped?.kind === 'blocked')
  assert.equal(stopped.interruption.code, 'continuation_indeterminate',
    'Losing the owned state must not turn a reserved continuation into a retry')
  const events = (await fs.readFile(path.join(task.assignmentPath!, 'logs/runtime-events.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  const failure = events.find((event) => event.event === 'run.agent_question.continuation_failed')
  assert.ok(failure, 'A failed continuation must leave a record of why it failed')
  assert.equal(failure.failure_code, 'tool_not_found', 'The original reason must survive the failed write')
  assert.equal(failure.blocker_persisted, false)
  // The terminal-state rejection, not merely some error.
  assert.equal(failure.blocker_failure_code, 'revision_conflict',
    'A blocker refused by a terminal run must say exactly that')
  // The cancellation the failed write could not disturb.
  const persisted = await stateStore.load()
  assert.equal(persisted?.state.status, 'cancelled')
  assert.equal((await stateStore.readAgentQuestion(interaction.interactionId)).interaction.status, 'cancelled')
})

test('a refused later round is still refused after recovery, without asking a provider again', async (t) => {
  const fixture = await createWorkerFixture(t)
  const { turn, stateStore, sessionStore, task, model } = fixture
  const { interaction, nextExecutionAttemptId } = await completeOneRound(fixture)
  assert.equal((await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) }))?.kind, 'completed')
  await stateStore.blockAgentQuestions({
    executionAttemptId: nextExecutionAttemptId, agentId: 'writer', code: 'question_limit_reached',
  })
  const spent = model.requestCount()
  const laterStage = {
    ...turn.options,
    questionContext: { logicalInvocationId: 'chain-step-two', dispatchId: 'dispatch-two', teamId: 'poets', stageId: 'chain' },
  }

  const refused = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000), options: laterStage })
  assert.ok(refused?.kind === 'blocked')
  assert.equal(refused.interruption.code, 'question_limit_reached')

  // A replacement owner reads the same refusal rather than buying a turn.
  const snapshot = await stateStore.load()
  assert.ok(snapshot)
  const recoveredAttemptId = '77777777-7777-4777-8777-777777777777'
  await stateStore.claimExecutionAttempt({
    expectedRevision: snapshot.state.revision,
    expectedOwnerExecutionAttemptId: nextExecutionAttemptId, nextExecutionAttemptId: recoveredAttemptId,
  })
  await sessionStore.compareAndSetTaskRecord(task.sessionId, task.id, ['running'], { executionAttemptId: recoveredAttemptId })

  const afterRecovery = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000), options: laterStage })
  assert.ok(afterRecovery?.kind === 'blocked')
  assert.equal(afterRecovery.interruption.code, 'question_limit_reached')
  assert.equal(model.requestCount(), spent, 'A refused round must never buy another provider turn')
  const answered = await stateStore.readAgentQuestion(interaction.interactionId)
  assert.equal(answered.interaction.status, 'resolved')
  assert.deepEqual(answered.answers, Object.fromEntries(interaction.questionIds.map((id) => [id, 'Marta'])))
})

test('a continuation whose run log is unwritable still blocks and still says why it failed', async (t) => {
  const fixture = await createWorkerFixture(t, false, true)
  const { turn, stateStore, task } = fixture
  const { interaction } = await completeOneRound(fixture)
  // The run's own event log becomes unwritable: a directory sits where the file
  // belongs, so the synchronous append throws. Writing a diagnostic must not be
  // able to replace the failure that diagnostic describes, nor lose it.
  const eventsPath = path.join(task.assignmentPath!, 'logs/runtime-events.jsonl')
  await fs.rm(eventsPath, { force: true })
  await fs.mkdir(eventsPath, { recursive: true })
  const written: string[] = []
  // The exact original is what gets restored; the delegate is a separate bound
  // copy, so `finally` cannot leave a different function installed for good.
  const originalWrite = process.stderr.write
  const passThrough = originalWrite.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return (passThrough as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write

  let stopped: Awaited<ReturnType<typeof runMcpWorkerTurn>>
  try {
    stopped = await runMcpWorkerTurn({ ...turn, signal: AbortSignal.timeout(2_000) })
  } finally {
    process.stderr.write = originalWrite
  }

  assert.ok(stopped?.kind === 'blocked', 'A reserved continuation must not be turned into a retry by a failed log write')
  assert.equal(stopped.interruption.code, 'continuation_indeterminate')
  assert.equal((await stateStore.readAgentQuestion(interaction.interactionId)).interaction.status, 'blocked',
    'The blocker must still be persisted')
  // The classified cause survives the log it could not be written to.
  const reported = written.join('')
  assert.match(reported, /agent-question/)
  assert.match(reported, /tool_not_found/)
  assert.ok(reported.includes(interaction.interactionId),
    'The surviving record must name the interaction it belongs to')
})

/**
 * A level the durable record could not hold was a level a question could not be
 * asked at. These drive the whole journey: ask at the level, answer, reload the
 * saved context, and check what the RESUMED provider request actually carries,
 * since the saved value alone does not prove it was restored into the request.
 */
const RESUMED_EFFORT_CASES = [
  { thinking: 'xhigh', sent: 'xhigh' },
  { thinking: 'off', sent: 'none' },
  { thinking: 'provider-default', sent: undefined },
] as const

for (const effort of RESUMED_EFFORT_CASES) {
  test(`a question asked by an agent thinking at '${effort.thinking}' is answered and resumed on that level`, async (t) => {
    const fixture = await createWorkerFixture(t)
    // What the connection publishes for this model, stated the way the provider
    // settings service states it, so the pair really accepts these levels.
    setRuntimeEffortSupport([{
      provider: configuredProviderName(fixture.connectionId),
      model: 'gpt-5.4-mini',
      levels: [...THINKING_LEVELS],
    }])
    t.after(() => clearRuntimeEffortSupport())
    const widened = {
      ...fixture,
      turn: { ...fixture.turn, options: { ...fixture.turn.options, thinking: effort.thinking } },
    }
    const { interaction } = await completeOneRound(widened)

    const finished = await runMcpWorkerTurn({ ...widened.turn, signal: AbortSignal.timeout(2_000) })

    assert.equal(finished?.kind, 'completed')
    const saved = await fixture.stateStore.readAgentQuestion(interaction.interactionId)
    assert.equal(saved.continuation.thinking, effort.thinking, 'The saved context must keep the level it was asked at')
    assert.equal(saved.interaction.status, 'resolved')
    // The resumed request itself, not merely what was stored beside it.
    const resumed: unknown = JSON.parse(fixture.requests.at(-1) ?? '{}')
    assert.ok(resumed && typeof resumed === 'object')
    assert.equal((resumed as { reasoning_effort?: unknown }).reasoning_effort, effort.sent)
  })
}
