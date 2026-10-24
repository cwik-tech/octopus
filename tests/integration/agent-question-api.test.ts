import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { agentQuestionViewsSchema } from '../../contracts/agent-questions.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import { startApiServer } from '../../server/api-server.js'
import { FileSystemWorkflowStateStore, hashWorkflowContent } from '../../workflows/workflow-state-store.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import { resolveWorkflowJournalRecorder } from '../../services/workflow-journal-recorder.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import {
  validateWorkflowJournalStream,
  WORKFLOW_STATE_STREAM_KIND,
  workflowJournalStreamId,
} from '../../workflows/workflow-journal.js'

async function makeApi(t: TestContext, options: { readonly journal?: boolean } = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-question-api-'))
  // Ordered teardown. The server and the services it owns have to stop writing
  // before the workspace is removed, or cleanup races a journal flush and fails
  // with ENOTEMPTY. Registered before the server exists so a failure during
  // setup still removes the directory.
  let closeServer: (() => Promise<void> | void) | undefined
  let closeSeedRegistry: (() => Promise<void>) | undefined
  t.after(async () => {
    await closeServer?.()
    await closeSeedRegistry?.()
    await fs.rm(workspace, { recursive: true, force: true })
  })
  const sessions = new FileSystemSessionStore(workspace)
  const session = await sessions.createSession({ title: 'Dedication' })
  const other = await sessions.createSession({ title: 'Another conversation' })
  const task = await sessions.createTaskRecord(session.id, { workflowId: 'dedication', brief: 'Write a dedication.' })
  assert.ok(task?.assignmentPath)
  const owner = randomUUID()
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['queued'], { status: 'awaiting_input', executionAttemptId: owner })
  // Enrols the assignment's journal and records the fixture through it, then
  // closes before the server starts: the API composition builds its own
  // registry, and two owners on one assignment would conflict.
  const seedRegistry = options.journal
    ? new WorkspaceExecutionJournalRegistry({ workspacePath: workspace, tenantId: 'local', mode: 'authoritative' })
    : undefined
  let seedClosed = false
  closeSeedRegistry = async () => {
    if (seedClosed) return
    seedClosed = true
    await seedRegistry?.close()
  }
  const store = new FileSystemWorkflowStateStore(
    task.assignmentPath,
    seedRegistry
      ? await resolveWorkflowJournalRecorder({ registry: seedRegistry, task, requestId: `seed-${task.id}`, processIdentity: owner })
      : undefined,
  )
  await store.initialize({
    manifest: {
      taskId: task.id, sessionId: session.id, rootRunId: task.runId, workflowId: 'dedication',
      workflowDefinitionHash: hashWorkflowContent('dedication'), briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: {}, runtimeVersion: 'fixture',
    }, executionAttemptId: owner,
    steps: [{ stepId: 'write', stepIndex: 0, stepType: 'team', team: 'poets', childRunId: 'child-one',
      definitionHash: hashWorkflowContent('write'), recoveryPolicy: 'safe_retry',
      inputArtifact: 'brief.md', resultArtifact: 'poem.md', requestedResultType: 'artifact:poem.md' }],
  })
  await store.update({ expectedRevision: 0, executionAttemptId: owner, mutate: (state) => {
    const step = state.steps[0]; assert.ok(step); step.status = 'launching'; step.attemptCount = 1
    state.currentStepId = step.stepId
  } })
  await store.update({ expectedRevision: 1, executionAttemptId: owner, mutate: (state) => {
    const step = state.steps[0]; assert.ok(step); step.status = 'running'
  } })
  const wait = await store.requestAgentInput({
    executionAttemptId: owner, stepId: 'write',
    invocation: { agentId: 'writer', agentDisplayName: 'Writer', logicalInvocationId: 'slot-one', dispatchId: 'dispatch-one',
      childRunId: 'child-one', teamId: 'poets', stageId: 'chain', definitionHash: hashWorkflowContent('writer') },
    request: { progress: 'I need the recipient.', questions: [{ question: 'Who is it for?', reason: 'Required for the dedication.' }] },
    continuation: { systemPrompt: 'Private writer instructions.', userMessage: task.brief, provider: 'openai', model: 'fixture', thinking: 'low' },
  })
  assert.equal(wait.kind, 'awaiting_input')
  if (wait.kind !== 'awaiting_input') throw new Error('Missing question')
  const saved = await store.readAgentQuestion(wait.interactionId)
  await closeSeedRegistry()
  const server = await startApiServer({
    workspacePath: workspace, repoRootPath: process.cwd(), recoverInterruptedTasks: false,
    store: new FileSystemRunStore(workspace), sessionStore: sessions,
    launcher: new PiRunLauncher(), taskLauncher: new SessionTaskRunnerLauncher(),
  })
  closeServer = () => server.close()
  const url = `${server.url}/sessions/${session.id}/tasks/${task.id}/agent-questions`
  const submit = `${url}/${wait.interactionId}/submit`
  const payload = {
    taskId: task.id, sessionId: session.id, interactionId: wait.interactionId, expectedInteractionRevision: 0,
    expectedRequestDigest: saved.interaction.requestDigest, submissionId: randomUUID(),
    answers: Object.fromEntries(saved.interaction.questionIds.map((id) => [id, 'Marta'])),
  }
  return { server, sessions, session, other, task, store, url, submit, payload, owner }
}

test('the question API exposes only the owning conversation and display content', async (t) => {
  const { server, other, task, url } = await makeApi(t)
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  const questions = agentQuestionViewsSchema.parse(body)
  assert.equal(questions.length, 1)
  assert.equal(questions[0]?.request.questions[0]?.question, 'Who is it for?')
  assert.equal(questions[0]?.canSubmit, true)
  assert.ok(!JSON.stringify(body).includes('Private writer instructions.'))
  const wrongSession = await fetch(`${server.url}/sessions/${other.id}/tasks/${task.id}/agent-questions`, { signal: AbortSignal.timeout(2_000) })
  assert.equal(wrongSession.status, 404)
})

test('stale or mismatched submissions do not change the question or admit a continuation', async (t) => {
  const { store, submit, payload, other } = await makeApi(t)
  const wrongOwner = await fetch(submit, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2_000),
    body: JSON.stringify({ ...payload, sessionId: other.id }),
  })
  assert.equal(wrongOwner.status, 409)
  const stale = await fetch(submit, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2_000),
    body: JSON.stringify({ ...payload, expectedRequestDigest: 'a'.repeat(64) }),
  })
  assert.equal(stale.status, 409)
  assert.equal((await store.load())?.state.agentQuestions?.interactions[0]?.status, 'pending')
})

test('an identical answer retry acknowledges the running continuation without starting another', async (t) => {
  const { sessions, session, task, store, submit, payload, owner } = await makeApi(t)
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['awaiting_input'], { status: 'running', executionAttemptId: owner })
  await store.submitAgentInput(payload)
  const nextOwner = randomUUID()
  await store.claimAgentQuestionContinuation({
    interactionId: payload.interactionId, submissionId: payload.submissionId,
    expectedOwnerExecutionAttemptId: owner, nextExecutionAttemptId: nextOwner, continuationAdmissionRequestId: 'admission-one',
  })
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['running'], { status: 'running', executionAttemptId: nextOwner })
  const retry = await fetch(submit, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2_000),
    body: JSON.stringify(payload),
  })
  assert.equal(retry.status, 202)
  assert.deepEqual(await retry.json(), { status: 'resuming' })
  assert.equal((await sessions.getTaskRecord(session.id, task.id))?.executionAttemptId, nextOwner)
})

test('an answer can be saved while independent work drains without starting another attempt', async (t) => {
  const { sessions, session, task, store, url, submit, payload, owner } = await makeApi(t)
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['awaiting_input'], { status: 'running', executionAttemptId: owner })
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
  assert.equal(agentQuestionViewsSchema.parse(await response.json())[0]?.canSubmit, true)
  const answer = await fetch(submit, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2_000),
    body: JSON.stringify(payload),
  })
  assert.equal(answer.status, 202)
  assert.equal((await store.load())?.state.agentQuestions?.interactions[0]?.status, 'submitted')
  const active = await sessions.getTaskRecord(session.id, task.id)
  assert.equal(active?.status, 'running')
  assert.equal(active?.executionAttemptId, owner)
  assert.equal(active?.admission, undefined)
})

test('an answer to a journal-backed task that accepts answers is recorded in its journal', async (t) => {
  // The answer writes the canonical journal-backed state, not only the
  // projection, so a reader of the journal (recovery, a replay) sees it.
  const { sessions, session, task, submit, payload, owner } = await makeApi(t, { journal: true })
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['awaiting_input'], { status: 'running', executionAttemptId: owner })
  const answer = await fetch(submit, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
    body: JSON.stringify(payload),
  })
  assert.equal(answer.status, 202, await answer.clone().text())

  assert.ok(task.assignmentPath)
  const journal = await readExecutionJournal(task.assignmentPath)
  assert.equal(journal.kind, 'ok')
  if (journal.kind !== 'ok') return
  const streamId = workflowJournalStreamId(task.id, 'dedication')
  const events = journal.events.filter((event) =>
    event.streamKind === WORKFLOW_STATE_STREAM_KIND && event.streamId === streamId)
  const { state } = validateWorkflowJournalStream(events, streamId)
  assert.equal(state.agentQuestions?.interactions[0]?.status, 'submitted')
})

test('a lost answer acknowledgement can be replayed after the agent has completed', async (t) => {
  const { sessions, session, task, store, submit, payload, owner } = await makeApi(t)
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['awaiting_input'], { status: 'running', executionAttemptId: owner })
  await store.submitAgentInput(payload)
  const nextOwner = randomUUID()
  await store.claimAgentQuestionContinuation({ interactionId: payload.interactionId, submissionId: payload.submissionId,
    expectedOwnerExecutionAttemptId: owner, nextExecutionAttemptId: nextOwner, continuationAdmissionRequestId: 'completed-admission' })
  await store.resolveAgentQuestion({ executionAttemptId: nextOwner, interactionId: payload.interactionId, agentId: 'writer', logicalInvocationId: 'slot-one',
    result: { text: 'For Marta.', model: 'fixture', toolCallCount: 0, executedToolCallCount: 0, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } } })
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['running'], { status: 'done', executionAttemptId: nextOwner })
  const retry = await fetch(submit, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(2_000) })
  assert.equal(retry.status, 202)
  assert.deepEqual(await retry.json(), { status: 'resolved' })
  const conflict = await fetch(submit, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, submissionId: randomUUID() }), signal: AbortSignal.timeout(2_000) })
  assert.equal(conflict.status, 409)
  assert.equal((await sessions.getTaskRecord(session.id, task.id))?.status, 'done')
})

test('the question list still shows each question and its saved answer when the private continuation is gone', async (t) => {
  const { sessions, session, task, store, url, payload, owner } = await makeApi(t)
  // Same preparation as the other manual-submission cases: with the task left
  // awaiting_input the real queue can observe the submitted answer and admit a
  // continuation while this test is still editing files.
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['awaiting_input'], { status: 'running', executionAttemptId: owner })
  await store.submitAgentInput(payload)
  const interaction = (await store.load())?.state.agentQuestions?.interactions[0]
  assert.ok(interaction)
  await fs.rm(path.join(store.paths.privateRuntimePath, 'agent-questions', `${interaction.continuationContent.sha256}.json`))

  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })

  assert.equal(response.status, 200)
  const questions = agentQuestionViewsSchema.parse(await response.json())
  assert.equal(questions[0]?.request.questions[0]?.question, 'Who is it for?')
  assert.deepEqual(Object.values(questions[0]?.answers ?? {}), ['Marta'])
})

test('an answered question whose agent then asked again keeps its exchange and says the run stopped', async (t) => {
  const { sessions, session, task, store, url, payload, owner } = await makeApi(t)
  await sessions.compareAndSetTaskRecord(session.id, task.id, ['awaiting_input'], { status: 'running', executionAttemptId: owner })
  await store.submitAgentInput(payload)
  const resumedAttemptId = randomUUID()
  await store.claimAgentQuestionContinuation({
    interactionId: payload.interactionId, submissionId: payload.submissionId,
    expectedOwnerExecutionAttemptId: owner, nextExecutionAttemptId: resumedAttemptId,
    continuationAdmissionRequestId: randomUUID(),
  })
  await store.resolveAgentQuestion({
    executionAttemptId: resumedAttemptId, interactionId: payload.interactionId,
    agentId: 'writer', logicalInvocationId: 'slot-one',
    result: {
      text: 'For Marta, a flower opens in the morning light.', model: 'fixture',
      toolCallCount: 0, executedToolCallCount: 0,
      usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
    },
  })
  await store.blockAgentQuestions({ executionAttemptId: resumedAttemptId, agentId: 'writer', code: 'question_limit_reached' })

  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })

  assert.equal(response.status, 200)
  const questions = agentQuestionViewsSchema.parse(await response.json())
  assert.equal(questions[0]?.status, 'resolved', 'The answered round stays answered')
  assert.equal(questions[0]?.blockCode, 'question_limit_reached', 'The card must be able to say why the run stopped')
  assert.deepEqual(Object.values(questions[0]?.answers ?? {}), ['Marta'])
  assert.equal(questions[0]?.request.questions[0]?.question, 'Who is it for?')
})
