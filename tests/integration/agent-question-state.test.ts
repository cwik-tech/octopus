import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import type { RequestAgentInput } from '../../contracts/agent-questions.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { createJournalBackedWorkflowRecorder } from '../../workflows/workflow-journal.js'

import { FileSystemWorkflowStateStore, hashWorkflowContent } from '../../workflows/workflow-state-store.js'

async function makeRunningStore(t: TestContext, journaled = false) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-question-state-'))
  const assignment = path.join(workspace, 'assignments', 'root-one')
  await fs.mkdir(assignment, { recursive: true })
  const journal = journaled ? await initializeExecutionJournal({
    scopeRoot: assignment,
    identity: {
      scopeKind: 'assignment', scopeId: 'root-one', tenantId: 'local',
      sessionId: 'session-one', runId: 'root-one', assignmentId: 'root-one',
    },
  }) : undefined
  t.after(async () => {
    await journal?.close()
    await fs.rm(workspace, { recursive: true, force: true })
  })
  const recorder = journal ? createJournalBackedWorkflowRecorder(journal) : undefined
  const store = new FileSystemWorkflowStateStore(assignment, {
    now: () => new Date('2026-09-19T12:00:00.000Z'), randomUUID: () => 'question-one',
    ...(recorder ? { journal: recorder } : {}),
  })
  await store.initialize({
    manifest: {
      taskId: 'task-one', sessionId: 'session-one', rootRunId: 'root-one', workflowId: 'chain-one',
      workflowDefinitionHash: hashWorkflowContent('chain-one'), briefHash: hashWorkflowContent('dedication'),
      teamDefinitionHashes: { poets: hashWorkflowContent('poets') }, runtimeVersion: 'test-v1',
    },
    executionAttemptId: 'attempt-one',
    steps: [{
      stepId: 'write', stepIndex: 0, stepType: 'team', team: 'poets', childRunId: 'child-one',
      definitionHash: hashWorkflowContent('write'), recoveryPolicy: 'safe_retry',
      inputArtifact: 'brief.md', resultArtifact: 'poem.md', requestedResultType: 'artifact:poem.md',
    }],
  })
  await store.update({ expectedRevision: 0, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'launching'
    step.attemptCount = 1
    step.startedAt = '2026-09-19T12:00:00.000Z'
    draft.currentStepId = step.stepId
  } })
  await store.update({ expectedRevision: 1, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'running'
  } })
  return { store, assignment, recorder }
}

function makeQuestionInput(): RequestAgentInput {
  return {
    executionAttemptId: 'attempt-one', stepId: 'write',
    invocation: {
      agentId: 'writer', agentDisplayName: 'Dedication Writer', logicalInvocationId: 'chain-step-one',
      dispatchId: 'dispatch-one', childRunId: 'child-one', teamId: 'poets', stageId: 'chain',
      definitionHash: hashWorkflowContent('writer-v1'),
    },
    request: {
      progress: 'I need the recipient before I can finish the dedication.',
      questions: [{ question: 'Who is the dedication for?', reason: 'The recipient is required.' }],
    },
    continuation: {
      systemPrompt: 'You are the dedication writer.', userMessage: 'Write the requested dedication.',
      provider: 'openai', model: 'fixture-model', thinking: 'low',
    },
  }
}

async function makeTwoQuestions(t: TestContext) {
  const fixture = await makeRunningStore(t)
  const first = makeQuestionInput()
  const second = { ...first, invocation: { ...first.invocation, agentId: 'editor', logicalInvocationId: 'fan-out-two', dispatchId: 'dispatch-two' } }
  const results = await Promise.all([
    fixture.store.requestAgentInput(first), new FileSystemWorkflowStateStore(fixture.assignment).requestAgentInput(second),
  ])
  assert.equal(results[0]?.kind, 'awaiting_input')
  assert.equal(results[1]?.kind, 'awaiting_input')
  const saved = (await fixture.store.load())?.state.agentQuestions?.interactions ?? []
  const writer = saved.find((entry) => entry.invocation.agentId === 'writer')
  const editor = saved.find((entry) => entry.invocation.agentId === 'editor')
  assert.ok(writer); assert.ok(editor)
  return { ...fixture, writer, editor }
}

test('concurrent agents retain independent questions under the same execution owner', async (t) => {
  const { store, writer, editor } = await makeTwoQuestions(t)
  assert.notEqual(writer.interactionId, editor.interactionId)
  assert.deepEqual((await store.load())?.state.agentQuestions?.interactions.map((entry) => entry.status), ['pending', 'pending'])
})

test('one answered parallel agent resumes while another question stays pending', async (t) => {
  const { store, writer, editor } = await makeTwoQuestions(t)
  await store.submitAgentInput({
    taskId: writer.taskId, sessionId: writer.sessionId, interactionId: writer.interactionId,
    expectedInteractionRevision: writer.revision, expectedRequestDigest: writer.requestDigest,
    submissionId: 'writer-answer', answers: Object.fromEntries(writer.questionIds.map((id) => [id, 'Marta'])),
  })
  await store.claimAgentQuestionContinuation({
    interactionId: writer.interactionId, submissionId: 'writer-answer', expectedOwnerExecutionAttemptId: 'attempt-one',
    nextExecutionAttemptId: 'attempt-two', continuationAdmissionRequestId: 'continue-writer',
  })
  assert.equal((await store.readAgentQuestion(writer.interactionId)).interaction.status, 'resuming')
  assert.equal((await store.readAgentQuestion(editor.interactionId)).interaction.status, 'pending')
  assert.equal((await store.load())?.state.ownerExecutionAttemptId, 'attempt-two')
  const paused = await store.pauseAgentQuestion({ interactionId: editor.interactionId, executionAttemptId: 'attempt-two' })
  assert.equal(paused.status, 'awaiting_input')
  assert.equal(paused.steps[0]?.status, 'awaiting_input')
  await assert.rejects(store.pauseAgentQuestion({ interactionId: editor.interactionId, executionAttemptId: 'attempt-one' }), { code: 'ownership_conflict' })
})

test('one continuation claims all already submitted parallel answers without a second owner', async (t) => {
  const { store, writer, editor } = await makeTwoQuestions(t)
  await Promise.all([writer, editor].map((question) => store.submitAgentInput({
    taskId: question.taskId, sessionId: question.sessionId, interactionId: question.interactionId,
    expectedInteractionRevision: question.revision, expectedRequestDigest: question.requestDigest,
    submissionId: `${question.invocation.agentId}-answer`, answers: Object.fromEntries(question.questionIds.map((id) => [id, 'Marta'])),
  })))
  const claim = { expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two', continuationAdmissionRequestId: 'continue-all' }
  await store.claimAgentQuestionContinuation({ ...claim, interactionId: writer.interactionId, submissionId: 'writer-answer' })
  const snapshot = await store.load()
  assert.deepEqual(snapshot?.state.agentQuestions?.interactions.map((entry) => entry.status), ['resuming', 'resuming'])
  await store.claimAgentQuestionContinuation({ ...claim, interactionId: editor.interactionId, submissionId: 'editor-answer' })
  assert.equal((await store.load())?.state.revision, snapshot?.state.revision)
})

test('a question survives reopening without accepting the unfinished workflow step or putting human text in metadata', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  const input = makeQuestionInput()
  const accepted = await store.requestAgentInput(input)

  assert.equal(accepted.kind, 'awaiting_input')
  const reopened = new FileSystemWorkflowStateStore(assignment)
  const snapshot = await reopened.load()
  assert.equal(snapshot?.state.agentQuestions?.interactions[0]?.status, 'pending')
  assert.equal(snapshot?.state.steps[0]?.status, 'awaiting_input')
  assert.equal(snapshot?.state.steps[0]?.artifact, undefined)
  assert.equal(snapshot?.state.status, 'awaiting_input')
  const restored = await reopened.readAgentQuestion('question-one')
  assert.deepEqual(restored.request, input.request)
  assert.deepEqual(restored.continuation, input.continuation)
  assert.equal(restored.interaction.invocation.agentId, 'writer')
  const metadata = await fs.readFile(reopened.paths.statePath, 'utf8')
  assert.ok(!metadata.includes('Who is the dedication for?'))
  assert.ok(!metadata.includes('You are the dedication writer.'))
})

test('concurrent transport replays publish one question and preserve its revision', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  const otherProcessStore = new FileSystemWorkflowStateStore(assignment)
  const input = makeQuestionInput()
  const accepted = await Promise.all([
    store.requestAgentInput(input), otherProcessStore.requestAgentInput(input),
  ])

  assert.deepEqual(accepted[0], accepted[1])
  const saved = await store.load()
  assert.equal(saved?.state.agentQuestions?.interactions.length, 1)
  assert.equal(saved?.state.revision, 3)
})

test('a host-verified nested question stays bound to its owning workflow child', async (t) => {
  const { store } = await makeRunningStore(t)
  const input = makeQuestionInput()
  await assert.rejects(store.requestAgentInput({ ...input, invocation: { ...input.invocation, childRunId: 'nested-child', workflowChildRunId: 'wrong-child' } }))
  const result = await store.requestAgentInput({ ...input, invocation: { ...input.invocation, childRunId: 'nested-child', workflowChildRunId: 'child-one' } })
  assert.equal(result.kind, 'awaiting_input')
  assert.equal((await store.readAgentQuestion('question-one')).interaction.invocation.childRunId, 'nested-child')
})

test('an agent cannot gain another question round by changing its invocation or question', async (t) => {
  const { store } = await makeRunningStore(t)
  const input = makeQuestionInput()
  await store.requestAgentInput(input)
  const rejected = await store.requestAgentInput({
    ...input,
    invocation: { ...input.invocation, logicalInvocationId: 'chain-step-two' },
    request: { ...input.request, questions: [{ question: 'What colour?', reason: 'A different question.' }] },
  })

  assert.deepEqual(rejected, { kind: 'blocked', code: 'question_limit_reached' })
  assert.equal((await store.load())?.state.agentQuestions?.interactions.length, 1)
})

test('an ordinary workflow update cannot erase a consumed question allowance', async (t) => {
  const { store } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())

  await assert.rejects(store.update({
    expectedRevision: 3, executionAttemptId: 'attempt-one',
    mutate: (draft) => { delete draft.agentQuestions },
  }), /controlled by the state store/)
})

test('cancelling a waiting run closes its question and refuses a late answer', async (t) => {
  const { store, assignment } = await makeRunningStore(t, true)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  await store.cancelFromAuthoritativeTask({ taskId: 'task-one', summary: 'Cancelled by the user.' })
  const cancelled = await store.readAgentQuestion('question-one')
  assert.equal(cancelled.interaction.status, 'cancelled')
  assert.equal((await store.load())?.state.status, 'cancelled')
  await assert.rejects(store.submitAgentInput({
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'late-answer', answers: { 'question-one:1': 'Marta' },
  }), { code: 'revision_conflict' })
  await assert.rejects(new FileSystemWorkflowStateStore(assignment).requestAgentInput(makeQuestionInput()), { code: 'revision_conflict' })
})

test('a changed private question file is rejected before it can be displayed', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  const contentPath = path.join(assignment, '.runtime', 'agent-questions', `${interaction.requestContent.sha256}.json`)
  const original = await fs.readFile(contentPath, 'utf8')
  await fs.writeFile(contentPath, original.replace('dedication', 'dedicatioN'))
  await assert.rejects(store.readAgentQuestion('question-one'), { code: 'corrupt' })
})

test('question history can be read from the journal after its projection is lost', async (t) => {
  const { store, assignment } = await makeRunningStore(t, true)
  await store.requestAgentInput(makeQuestionInput())
  await store.cancelFromAuthoritativeTask({ taskId: 'task-one', summary: 'Cancelled by the user.' })
  await fs.unlink(store.paths.statePath)
  const reopened = new FileSystemWorkflowStateStore(assignment)
  const saved = await reopened.readAgentQuestion('question-one')
  assert.equal(saved.interaction.status, 'cancelled')
  await assert.rejects(fs.access(store.paths.statePath), { code: 'ENOENT' })
})

test('answer submission is immutable and replayable without starting the unfinished agent', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())
  const pending = await store.readAgentQuestion('question-one')
  const submission = {
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: pending.interaction.requestDigest,
    submissionId: 'answer-one', answers: { 'question-one:1': 'Marta' },
  }
  const accepted = await store.submitAgentInput(submission)
  assert.equal(accepted.status, 'submitted')

  const reopened = new FileSystemWorkflowStateStore(assignment)
  assert.deepEqual(await reopened.submitAgentInput(submission), accepted)
  assert.equal((await reopened.load())?.state.revision, 4)
  assert.equal((await reopened.load())?.state.status, 'awaiting_input')
  assert.deepEqual((await reopened.readAgentQuestion('question-one')).answers, { 'question-one:1': 'Marta' })
  await assert.rejects(reopened.submitAgentInput({ ...submission, answers: { 'question-one:1': 'Someone else' } }), { code: 'revision_conflict' })
  assert.ok(!(await fs.readFile(reopened.paths.statePath, 'utf8')).includes('Marta'))
})

test('one admission claims the original agent and fences an old worker without counting recovery', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  await store.submitAgentInput({
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: { 'question-one:1': 'Marta' },
  })
  const claim = {
    interactionId: 'question-one', submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two',
    continuationAdmissionRequestId: 'admission-one',
  }
  await store.claimAgentQuestionContinuation(claim)

  const reopened = new FileSystemWorkflowStateStore(assignment)
  const resumed = await reopened.readAgentQuestion('question-one')
  assert.equal(resumed.interaction.status, 'resuming')
  assert.equal(resumed.interaction.invocation.agentId, 'writer')
  assert.equal(resumed.interaction.invocation.logicalInvocationId, 'chain-step-one')
  assert.equal((await reopened.load())?.state.ownerExecutionAttemptId, 'attempt-two')
  assert.equal((await reopened.load())?.state.recoveryCount, 0)
  await reopened.claimAgentQuestionContinuation(claim)
  assert.equal((await reopened.load())?.state.revision, 5)
  await assert.rejects(reopened.claimAgentQuestionContinuation({
    ...claim, expectedOwnerExecutionAttemptId: 'attempt-two', nextExecutionAttemptId: 'attempt-three',
    continuationAdmissionRequestId: 'admission-two',
  }), { code: 'revision_conflict' })
  await assert.rejects(store.requestAgentInput(makeQuestionInput()), { code: 'ownership_conflict' })
})

test('journal replay restores the answered agent and its continuation owner after losing the projection', async (t) => {
  const { store, assignment, recorder } = await makeRunningStore(t, true)
  assert.ok(recorder)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  await store.submitAgentInput({
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: { 'question-one:1': 'Marta' },
  })
  await store.claimAgentQuestionContinuation({
    interactionId: 'question-one', submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two',
    continuationAdmissionRequestId: 'admission-one',
  })
  await fs.rm(store.paths.statePath)

  const reopened = new FileSystemWorkflowStateStore(assignment, { journal: recorder })
  const restored = await reopened.readAgentQuestion('question-one')
  assert.equal(restored.interaction.status, 'resuming')
  assert.deepEqual(restored.answers, { 'question-one:1': 'Marta' })
  assert.equal((await reopened.load())?.state.ownerExecutionAttemptId, 'attempt-two')
})

test('only the resumed invocation can durably accept its full response', async (t) => {
  const { store } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  await store.submitAgentInput({
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: { 'question-one:1': 'Marta' },
  })
  await store.claimAgentQuestionContinuation({
    interactionId: 'question-one', submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two',
    continuationAdmissionRequestId: 'admission-one',
  })
  const completion = {
    executionAttemptId: 'attempt-two', interactionId: 'question-one',
    agentId: 'writer', logicalInvocationId: 'chain-step-one',
    result: {
      text: 'For Marta, a flower opens in the morning light.', model: 'fixture-model',
      toolCallCount: 0, executedToolCallCount: 0,
      usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
    },
  }
  const accepted = await store.resolveAgentQuestion(completion)
  assert.equal(accepted.status, 'resolved')
  assert.deepEqual((await store.readAgentQuestion('question-one')).result, completion.result)
  assert.deepEqual(await store.resolveAgentQuestion(completion), accepted)
  assert.equal((await store.load())?.state.revision, 6)
  assert.equal((await store.load())?.state.steps[0]?.artifact, undefined)
  await assert.rejects(store.resolveAgentQuestion({ ...completion, agentId: 'editor' }), { code: 'ownership_conflict' })
  await assert.rejects(store.resolveAgentQuestion({ ...completion, executionAttemptId: 'attempt-one' }), { code: 'ownership_conflict' })
})

test('competing resumed workers reserve only one provider attempt', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  await store.submitAgentInput({ taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: { 'question-one:1': 'Marta' } })
  await store.claimAgentQuestionContinuation({ interactionId: 'question-one', submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two', continuationAdmissionRequestId: 'admission-one' })
  const input = { interactionId: 'question-one', executionAttemptId: 'attempt-two', agentId: 'writer', logicalInvocationId: 'chain-step-one' }
  const reservations = await Promise.all([store.beginAgentQuestionProviderAttempt(input), new FileSystemWorkflowStateStore(assignment).beginAgentQuestionProviderAttempt(input)])
  assert.deepEqual(reservations.sort(), ['in_progress', 'started'])
  const saved = await store.readAgentQuestion('question-one')
  assert.equal(saved.interaction.status, 'resuming')
  assert.ok('continuation' in saved.interaction && saved.interaction.continuation?.providerStartedAt)
})

test('a generic workflow update cannot resume an unanswered agent question', async (t) => {
  const { store } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())

  await assert.rejects(store.update({
    expectedRevision: 3, executionAttemptId: 'attempt-one', mutate: (draft) => {
      const step = draft.steps[0]
      assert.ok(step)
      step.status = 'running'
      draft.status = 'running'
    },
  }), { code: 'invalid_state' })
})

test('question content cannot be published through a symlink outside its assignment', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  const outside = path.join(path.dirname(assignment), 'unowned-content')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(assignment, '.runtime', 'agent-questions'))
  await assert.rejects(store.requestAgentInput(makeQuestionInput()), { code: 'corrupt' })
  assert.deepEqual(await fs.readdir(outside), [])
  assert.equal((await store.load())?.state.agentQuestions, undefined)
})

test('missing private content is a typed corruption error without changing the wait', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  await fs.unlink(path.join(assignment, '.runtime/agent-questions', `${interaction.requestContent.sha256}.json`))
  await assert.rejects(store.readAgentQuestion('question-one'), { code: 'corrupt' })
  assert.equal((await store.load())?.state.agentQuestions?.interactions[0]?.status, 'pending')
})

test('a question-limit blocker closes unresolved sibling cards without accepting their work', async (t) => {
  const { store, writer, editor } = await makeTwoQuestions(t)
  await store.blockAgentQuestions({ executionAttemptId: 'attempt-one', agentId: 'writer', code: 'question_limit_reached' })
  const state = (await store.load())?.state
  assert.deepEqual(state?.agentQuestions?.interactions.map((question) => question.status), ['blocked', 'blocked'])
  assert.equal(state?.steps[0]?.artifact, undefined)
  await assert.rejects(store.submitAgentInput({
    taskId: editor.taskId, sessionId: editor.sessionId, interactionId: editor.interactionId,
    expectedInteractionRevision: editor.revision, expectedRequestDigest: editor.requestDigest,
    submissionId: 'too-late', answers: Object.fromEntries(editor.questionIds.map((id) => [id, 'Marta'])),
  }), { code: 'revision_conflict' })
  assert.equal((await store.readAgentQuestion(writer.interactionId)).interaction.status, 'blocked')
})

test('recovery transfers an unstarted continuation and preserves a waiting sibling', async (t) => {
  const { store, writer, editor } = await makeTwoQuestions(t)
  await store.submitAgentInput({ taskId: writer.taskId, sessionId: writer.sessionId, interactionId: writer.interactionId,
    expectedInteractionRevision: 0, expectedRequestDigest: writer.requestDigest,
    submissionId: 'answer-one', answers: Object.fromEntries(writer.questionIds.map((id) => [id, 'Marta'])) })
  await store.claimAgentQuestionContinuation({ interactionId: writer.interactionId, submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two', continuationAdmissionRequestId: 'admission-one' })
  const snapshot = await store.load(); assert.ok(snapshot)
  await store.claimExecutionAttempt({ expectedRevision: snapshot.state.revision, expectedOwnerExecutionAttemptId: 'attempt-two', nextExecutionAttemptId: 'attempt-three' })
  const recovered = (await store.readAgentQuestion(writer.interactionId)).interaction
  assert.equal(recovered.status, 'resuming')
  assert.ok(recovered.status === 'resuming' && recovered.continuation.executionAttemptId === 'attempt-three')
  assert.equal((await store.readAgentQuestion(editor.interactionId)).interaction.status, 'pending')
  assert.equal(await store.beginAgentQuestionProviderAttempt({ interactionId: writer.interactionId,
    executionAttemptId: 'attempt-three', agentId: 'writer', logicalInvocationId: writer.invocation.logicalInvocationId }), 'started')
  const reserved = await store.load(); assert.ok(reserved)
  assert.equal(reserved.state.status, 'running')
  assert.equal(reserved.state.steps[0]?.status, 'running')
  await assert.rejects(store.claimExecutionAttempt({ expectedRevision: reserved.state.revision,
    expectedOwnerExecutionAttemptId: 'attempt-three', nextExecutionAttemptId: 'attempt-four' }), { code: 'invalid_state' })
})

test('journal replay accepts a single admission for multiple answered agents', async (t) => {
  const { store, assignment, recorder } = await makeRunningStore(t, true)
  const first = makeQuestionInput()
  await store.requestAgentInput(first)
  await new FileSystemWorkflowStateStore(assignment, { ...(recorder ? { journal: recorder } : {}) }).requestAgentInput({ ...first, invocation: { ...first.invocation, agentId: 'editor', logicalInvocationId: 'slot-two', dispatchId: 'dispatch-two' } })
  const questions = (await store.load())?.state.agentQuestions?.interactions ?? []
  assert.equal(questions.length, 2)
  await Promise.all(questions.map((question) => store.submitAgentInput({ taskId: question.taskId, sessionId: question.sessionId,
    interactionId: question.interactionId, expectedInteractionRevision: 0, expectedRequestDigest: question.requestDigest,
    submissionId: `${question.invocation.agentId}-answer`, answers: Object.fromEntries(question.questionIds.map((id) => [id, 'Marta'])) })))
  const writer = questions.find((question) => question.invocation.agentId === 'writer'); assert.ok(writer)
  await store.claimAgentQuestionContinuation({ interactionId: writer.interactionId, submissionId: 'writer-answer',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two', continuationAdmissionRequestId: 'admission-all' })
  const reopened = await new FileSystemWorkflowStateStore(assignment).loadAgentQuestionSnapshot()
  assert.deepEqual(reopened?.state.agentQuestions?.interactions.map((question) => question.status), ['resuming', 'resuming'])
})

test('the display read returns the question and its answers without touching the saved prompts', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  await store.submitAgentInput({
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: { 'question-one:1': 'Marta' },
  })
  const answered = (await store.load())?.state.agentQuestions?.interactions[0]
  assert.ok(answered)
  // The saved prompts are what the display must never need.
  await fs.unlink(path.join(assignment, '.runtime', 'agent-questions', `${answered.continuationContent.sha256}.json`))

  assert.deepEqual(await store.readAgentQuestionDisplay(answered), {
    request: {
      progress: 'I need the recipient before I can finish the dedication.',
      questions: [{ question: 'Who is the dedication for?', reason: 'The recipient is required.' }],
    },
    answers: { 'question-one:1': 'Marta' },
  })
})

test('a changed private question file is rejected by the display read too', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  const contentPath = path.join(assignment, '.runtime', 'agent-questions', `${interaction.requestContent.sha256}.json`)
  const original = await fs.readFile(contentPath, 'utf8')
  await fs.writeFile(contentPath, original.replace('dedication', 'dedicatioN'))

  await assert.rejects(store.readAgentQuestionDisplay(interaction), { code: 'corrupt' })
})

/**
 * One round per agent per root run. When that agent asks again in a later
 * invocation the run stops, but the round the human already answered is part of
 * the conversation's history and the refusal must still survive a recovery, or
 * the stopped run quietly buys another provider turn.
 */
async function makeAnsweredWriter(t: TestContext) {
  const fixture = await makeRunningStore(t)
  const { store } = fixture
  await store.requestAgentInput(makeQuestionInput())
  const { interaction } = await store.readAgentQuestion('question-one')
  await store.submitAgentInput({
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: interaction.requestDigest,
    submissionId: 'answer-one', answers: { 'question-one:1': 'Marta' },
  })
  await store.claimAgentQuestionContinuation({
    interactionId: 'question-one', submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two',
    continuationAdmissionRequestId: 'admission-one',
  })
  const result = {
    text: 'For Marta, a flower opens in the morning light.', model: 'fixture-model',
    toolCallCount: 0, executedToolCallCount: 0,
    usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
  }
  await store.resolveAgentQuestion({
    executionAttemptId: 'attempt-two', interactionId: 'question-one',
    agentId: 'writer', logicalInvocationId: 'chain-step-one', result,
  })
  return { ...fixture, result }
}

test('a refused later round keeps the answered round readable and records the refusal', async (t) => {
  const { store, result } = await makeAnsweredWriter(t)

  await store.blockAgentQuestions({
    executionAttemptId: 'attempt-two', agentId: 'writer', code: 'question_limit_reached',
  })

  const saved = await store.readAgentQuestion('question-one')
  assert.equal(saved.interaction.status, 'resolved', 'The answered round must stay in history')
  assert.deepEqual(saved.result, result, 'The accepted response must stay readable')
  assert.deepEqual(saved.answers, { 'question-one:1': 'Marta' })
  assert.equal(saved.interaction.blockCode, 'question_limit_reached',
    'The refusal must be durably recorded against the agent')
})

test('a refused later round survives an ownership recovery', async (t) => {
  const { store } = await makeAnsweredWriter(t)
  await store.blockAgentQuestions({
    executionAttemptId: 'attempt-two', agentId: 'writer', code: 'question_limit_reached',
  })
  const snapshot = await store.load()
  assert.ok(snapshot)

  await store.claimExecutionAttempt({
    expectedRevision: snapshot.state.revision,
    expectedOwnerExecutionAttemptId: 'attempt-two', nextExecutionAttemptId: 'attempt-three',
  })

  const recovered = await store.readAgentQuestion('question-one')
  assert.equal(recovered.interaction.status, 'resolved')
  assert.equal(recovered.interaction.blockCode, 'question_limit_reached',
    'A recovered run must not admit the round it already refused')
})

test('a second refusal does not overwrite the reason the run first stopped', async (t) => {
  const { store } = await makeAnsweredWriter(t)
  await store.blockAgentQuestions({
    executionAttemptId: 'attempt-two', agentId: 'writer', code: 'question_limit_reached',
  })
  const first = (await store.readAgentQuestion('question-one')).interaction
  if (first.status !== 'resolved') throw new Error('Expected the answered round to stay resolved')

  await store.blockAgentQuestions({
    executionAttemptId: 'attempt-two', agentId: 'writer', code: 'continuation_unavailable',
  })

  const after = (await store.readAgentQuestion('question-one')).interaction
  if (after.status !== 'resolved') throw new Error('Expected the answered round to stay resolved')
  assert.equal(after.blockCode, 'question_limit_reached', 'The first refusal is why the run stopped')
  assert.equal(after.blockedAt, first.blockedAt, 'A repeated refusal must not restamp the original')
  assert.equal(after.revision, first.revision, 'A repeated refusal must not bump the record')
})

/**
 * An agent's effort level is part of the context a continuation restores. The
 * durable record has to accept every level the application can express, or a
 * question asked by an agent running at one of the newer levels cannot be saved
 * at all, and `provider-default` has to survive as itself rather than becoming
 * some level nobody chose.
 */
for (const thinking of ['xhigh', 'off', 'provider-default'] as const) {
  test(`a question saved by an agent thinking at '${thinking}' restores that level`, async (t) => {
    const { store } = await makeRunningStore(t)
    const input = makeQuestionInput()

    await store.requestAgentInput({ ...input, continuation: { ...input.continuation, thinking } })

    const saved = await store.readAgentQuestion('question-one')
    assert.equal(saved.continuation.thinking, thinking)
  })
}
