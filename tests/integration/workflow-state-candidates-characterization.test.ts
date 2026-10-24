/**
 * Exact workflow-state.json bytes of the human-input commands, stamps
 * included, and the state a failed journal append leaves behind for an agent
 * question.
 *
 * The existing suites check the human-input commands field by field against a
 * clock that never moves, so they cannot tell which read stamped which field
 * or what order the keys are written in, and the file's bytes depend on that
 * order. These tests drive FileSystemWorkflowStateStore against real files
 * with a clock that moves one second per read and compare the whole file with
 * the expected state written as two-space JSON and a final newline.
 *
 * Two behaviors are pinned on purpose. A continuation claim sets the run to
 * running while its human-input step still reads awaiting_input. That is
 * current behavior, not a quirk. validateState in
 * workflows/workflow-state-validation.ts refuses a pending or submitted
 * interaction on a step that is not awaiting_input. And an agent question
 * saves its request and continuation before the journal append, so a failed
 * append leaves both files behind with no state naming them, and the retry
 * names the same two files under a new interaction id. That one is a
 * recorded quirk. docs/adr/2026-09-27-Workflow-Agent-Question-Content-Module.md
 * lists it under "Recorded quirks, not fixed", where content written before
 * publication is never collected and a retry reuses the same names.
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import type { RequestAgentInput } from '../../contracts/agent-questions.js'
import { initializeExecutionJournal, type ExecutionJournal } from '../../core/execution-journal.js'
import type { DurableWorkflowState, DurableWorkflowStepState, HumanInputInteraction, HumanInputSubmission } from '../../workflows/types.js'
import { createJournalBackedWorkflowRecorder, type WorkflowJournalRecorder } from '../../workflows/workflow-journal.js'
import {
  FileSystemWorkflowStateStore,
  hashHumanInputSubmission,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'

const T0 = Date.parse('2026-09-19T12:00:00.000Z')

const SOURCE_ARTIFACT = {
  childRunId: 'draft-run', relativePath: 'report.md', sha256: hashWorkflowContent('the first draft'), byteLength: 15,
}
const RECIPIENTS = [{ id: 'reviewer', mentionToken: 'reviewer', displayName: 'Reviewer' }]
const MESSAGES = [{ id: 'message-one', text: 'Tighten the second section.', recipients: ['reviewer'] }]
const SUBMISSION: HumanInputSubmission = {
  submissionId: 'submission-one', mode: 'feedback', messages: MESSAGES, submittedAt: '2026-09-19T12:30:00.000Z',
  canonicalHash: hashHumanInputSubmission({ submissionId: 'submission-one', mode: 'feedback', messages: MESSAGES }),
}

/** Each read is one second after the last, so a stamp names the read that made it. */
function makeClock() {
  let reads = 0
  return {
    now: () => new Date(T0 + reads++ * 1_000),
    reads: () => reads,
    at: (read: number) => new Date(T0 + read * 1_000).toISOString(),
  }
}

/** A fresh assignment, removed after the test once any journal opened on it is closed. */
async function makeAssignment(t: TestContext, options: { journaled: boolean }) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-state-candidates-'))
  let journal: ExecutionJournal | undefined
  t.after(async () => {
    await journal?.close()
    await fs.rm(workspace, { recursive: true, force: true })
  })
  const assignment = path.join(workspace, 'assignments', 'root-one')
  await fs.mkdir(assignment, { recursive: true })
  if (options.journaled) {
    journal = await initializeExecutionJournal({
      scopeRoot: assignment,
      identity: {
        scopeKind: 'assignment', scopeId: 'root-one', tenantId: 'local',
        sessionId: 'session-one', runId: 'root-one', assignmentId: 'root-one',
      },
    })
  }
  return { assignment, journal }
}

function openStore(assignment: string, clock: ReturnType<typeof makeClock>, journal?: WorkflowJournalRecorder) {
  let ids = 0
  return new FileSystemWorkflowStateStore(assignment, {
    now: clock.now, randomUUID: () => `question-${++ids}`, ...(journal ? { journal } : {}),
  })
}

/** Draft, then a human review of it, then a revision. Nothing has run yet. */
async function makeReviewStore(t: TestContext) {
  const { assignment } = await makeAssignment(t, { journaled: false })
  const clock = makeClock()
  const store = openStore(assignment, clock)
  await store.initialize({
    manifest: {
      taskId: 'task-one', sessionId: 'session-one', rootRunId: 'root-one', workflowId: 'review-one',
      workflowDefinitionHash: hashWorkflowContent('review-one'), briefHash: hashWorkflowContent('review'),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers') }, runtimeVersion: 'test-v1',
      createdAt: '2026-09-19T11:00:00.000Z',
    },
    executionAttemptId: 'attempt-one',
    steps: [
      { stepId: 'draft', stepIndex: 0, stepType: 'team', team: 'writers', childRunId: 'draft-run',
        definitionHash: hashWorkflowContent('draft'), recoveryPolicy: 'safe_retry',
        inputArtifact: 'brief.md', resultArtifact: 'report.md', requestedResultType: 'artifact:report.md' },
      { stepId: 'feedback', stepIndex: 1, stepType: 'human-in-the-loop', childRunId: 'feedback-run',
        definitionHash: hashWorkflowContent('feedback'), recoveryPolicy: 'never_retry',
        inputArtifact: 'report.md', resultArtifact: 'feedback.json', requestedResultType: 'artifact:feedback.json' },
      { stepId: 'revise', stepIndex: 2, stepType: 'team', team: 'writers', childRunId: 'revise-run',
        definitionHash: hashWorkflowContent('revise'), recoveryPolicy: 'manual',
        inputArtifact: 'feedback.json', resultArtifact: 'report-2.md', requestedResultType: 'artifact:report-2.md' },
    ],
  })
  return { store, clock }
}

async function current(store: FileSystemWorkflowStateStore): Promise<DurableWorkflowState> {
  const snapshot = await store.load()
  assert.ok(snapshot)
  return snapshot.state
}

/** The exact text the store writes for a state. */
function fileText(state: DurableWorkflowState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function feedbackStep(state: DurableWorkflowState): DurableWorkflowStepState {
  const step = state.steps[1]
  assert.ok(step)
  assert.equal(step.stepId, 'feedback')
  return step
}

function feedbackInteraction(state: DurableWorkflowState): HumanInputInteraction {
  const interaction = feedbackStep(state).humanInput
  assert.ok(interaction)
  return interaction
}

function askForFeedback(store: FileSystemWorkflowStateStore, prompt?: string) {
  return store.requestHumanInput({
    expectedRevision: 0, executionAttemptId: 'attempt-one', stepId: 'feedback', interactionId: 'feedback-one',
    sourceArtifact: SOURCE_ARTIFACT, successorStepId: 'revise', eligibleRecipients: RECIPIENTS,
    ...(prompt === undefined ? {} : { prompt }),
  })
}

function submitFeedback(store: FileSystemWorkflowStateStore) {
  return store.submitHumanInput({
    expectedRevision: 1, interactionId: 'feedback-one',
    expectedSourceArtifactSha256: SOURCE_ARTIFACT.sha256, submission: SUBMISSION,
  })
}

test('a human-input request with a prompt writes its wait byte for byte, stamping startedAt, then requestedAt, then updatedAt', async (t) => {
  const { store, clock } = await makeReviewStore(t)
  const before = await current(store)
  const first = clock.reads()

  const waiting = await askForFeedback(store, 'Review the first draft.')

  const expected = structuredClone(before)
  expected.revision = 1
  expected.updatedAt = clock.at(first + 2)
  expected.status = 'awaiting_input'
  expected.currentStepId = 'feedback'
  expected.steps[1] = {
    ...feedbackStep(before), status: 'awaiting_input', attemptCount: 1, startedAt: clock.at(first),
    humanInput: {
      interactionId: 'feedback-one', taskId: 'task-one', sessionId: 'session-one', workflowId: 'review-one',
      stepId: 'feedback', ownerExecutionAttemptId: 'attempt-one', sourceArtifact: SOURCE_ARTIFACT,
      successorStepId: 'revise', eligibleRecipients: RECIPIENTS, prompt: 'Review the first draft.',
      requestedAt: clock.at(first + 1), status: 'pending',
    },
  }
  assert.equal(await fs.readFile(store.paths.statePath, 'utf8'), fileText(expected))
  assert.deepEqual(waiting, expected)
})

test('a human-input request without a prompt writes the same wait with no prompt key and the same startedAt, requestedAt and updatedAt stamps', async (t) => {
  const { store, clock } = await makeReviewStore(t)
  const before = await current(store)
  const first = clock.reads()

  const waiting = await askForFeedback(store)

  const expected = structuredClone(before)
  expected.revision = 1
  expected.updatedAt = clock.at(first + 2)
  expected.status = 'awaiting_input'
  expected.currentStepId = 'feedback'
  expected.steps[1] = {
    ...feedbackStep(before), status: 'awaiting_input', attemptCount: 1, startedAt: clock.at(first),
    humanInput: {
      interactionId: 'feedback-one', taskId: 'task-one', sessionId: 'session-one', workflowId: 'review-one',
      stepId: 'feedback', ownerExecutionAttemptId: 'attempt-one', sourceArtifact: SOURCE_ARTIFACT,
      successorStepId: 'revise', eligibleRecipients: RECIPIENTS,
      requestedAt: clock.at(first + 1), status: 'pending',
    },
  }
  const text = await fs.readFile(store.paths.statePath, 'utf8')
  assert.equal(text, fileText(expected))
  assert.doesNotMatch(text, /"prompt"/)
  assert.deepEqual(waiting, expected)
})

test('a human-input submission writes the submission exactly as given, byte for byte, and stamps only updatedAt', async (t) => {
  const { store, clock } = await makeReviewStore(t)
  await askForFeedback(store, 'Review the first draft.')
  const before = await current(store)
  const first = clock.reads()

  const submitted = await submitFeedback(store)

  const expected = structuredClone(before)
  expected.revision = 2
  expected.updatedAt = clock.at(first)
  expected.steps[1] = {
    ...feedbackStep(before),
    humanInput: { ...feedbackInteraction(before), status: 'submitted', submission: SUBMISSION },
  }
  assert.equal(await fs.readFile(store.paths.statePath, 'utf8'), fileText(expected))
  assert.deepEqual(submitted, expected)
})

test('a human-input continuation claim hands the run to the new attempt, stamps only updatedAt, adds the admission id last, and leaves the step awaiting input', async (t) => {
  const { store, clock } = await makeReviewStore(t)
  await askForFeedback(store, 'Review the first draft.')
  await submitFeedback(store)
  const before = await current(store)
  const first = clock.reads()

  const claimed = await store.claimHumanInputContinuation({
    expectedRevision: 2, interactionId: 'feedback-one', expectedOwnerExecutionAttemptId: 'attempt-one',
    nextExecutionAttemptId: 'attempt-two', continuationAdmissionRequestId: 'admission-one',
  })

  const expected = structuredClone(before)
  expected.revision = 3
  expected.updatedAt = clock.at(first)
  expected.ownerExecutionAttemptId = 'attempt-two'
  expected.status = 'running'
  expected.steps[1] = {
    ...feedbackStep(before),
    humanInput: { ...feedbackInteraction(before), continuationAdmissionRequestId: 'admission-one' },
  }
  assert.equal(await fs.readFile(store.paths.statePath, 'utf8'), fileText(expected))
  assert.deepEqual(claimed, expected)
  // Current behavior, not a quirk. The run is running again and its step still
  // reads awaiting_input, which validateState requires of a submitted interaction.
  assert.deepEqual([claimed.status, feedbackStep(claimed).status], ['running', 'awaiting_input'])
})

function writerQuestion(): RequestAgentInput {
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

/** The real journal recorder, except that the next append can be made to fail once. */
function failNextAppendOf(recorder: WorkflowJournalRecorder) {
  const failure = new Error('journal append failed')
  let failNext = false
  const wrapped: WorkflowJournalRecorder = {
    recordSnapshot: async (state) => {
      if (failNext) {
        failNext = false
        throw failure
      }
      await recorder.recordSnapshot(state)
    },
    recordBaseline: (state, sourceHashes) => recorder.recordBaseline(state, sourceHashes),
    readRecordedState: (identity) => recorder.readRecordedState(identity),
    hasRecordedState: () => recorder.hasRecordedState(),
    recordProjectionApplied: (sequence) => recorder.recordProjectionApplied(sequence),
  }
  return { recorder: wrapped, failure, failNextAppend: () => { failNext = true } }
}

/** The saved content files by name, and none when the content folder was never made. */
async function savedContentFiles(store: FileSystemWorkflowStateStore): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(store.paths.privateRuntimePath, 'agent-questions'))).sort()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

test('a question whose journal append fails once leaves the state bytes unchanged and its two content files behind, and the retry asks question-2 naming the same two files', async (t) => {
  const { assignment, journal } = await makeAssignment(t, { journaled: true })
  assert.ok(journal)
  const appends = failNextAppendOf(createJournalBackedWorkflowRecorder(journal))
  const store = openStore(assignment, makeClock(), appends.recorder)
  await store.initialize({
    manifest: {
      taskId: 'task-one', sessionId: 'session-one', rootRunId: 'root-one', workflowId: 'chain-one',
      workflowDefinitionHash: hashWorkflowContent('chain-one'), briefHash: hashWorkflowContent('dedication'),
      teamDefinitionHashes: { poets: hashWorkflowContent('poets') }, runtimeVersion: 'test-v1',
      createdAt: '2026-09-19T11:00:00.000Z',
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
    step.startedAt = '2026-09-19T11:30:00.000Z'
    draft.currentStepId = step.stepId
  } })
  await store.update({ expectedRevision: 1, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'running'
  } })
  const bytes = await fs.readFile(store.paths.statePath)

  appends.failNextAppend()
  await assert.rejects(store.requestAgentInput(writerQuestion()), (error) => error === appends.failure)

  assert.deepEqual(await fs.readFile(store.paths.statePath), bytes)
  const left = await savedContentFiles(store)
  assert.equal(left.length, 2)
  assert.ok(left.every((name) => /^[0-9a-f]{64}\.json$/.test(name)), left.join(', '))

  assert.deepEqual(await store.requestAgentInput(writerQuestion()), { kind: 'awaiting_input', interactionId: 'question-2' })

  assert.deepEqual(await savedContentFiles(store), left)
  const asked = (await current(store)).agentQuestions?.interactions ?? []
  assert.deepEqual(asked.map((interaction) => interaction.interactionId), ['question-2'])
  assert.deepEqual(asked.flatMap((interaction) => [
    `${interaction.requestContent.sha256}.json`, `${interaction.continuationContent.sha256}.json`,
  ]).sort(), left)
})
