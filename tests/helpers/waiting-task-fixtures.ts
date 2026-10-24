/**
 * Tasks that are waiting for a person, in each of the three ways a task can
 * wait: a workflow's human-in-the-loop step, an agent's question, and a model
 * choice. Each is written through the same stores the worker uses, without a
 * journal, the way the API tests that own these routes seed them
 * (tests/integration/workflow-human-input-api.test.ts,
 * agent-question-api.test.ts, workflow-model-choice-api.test.ts).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { DurableWorkflowState } from '../../workflows/types.js'
import {
  createWorkflowArtifactReference,
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'

export interface WaitingTask {
  readonly sessionId: string
  readonly taskId: string
  readonly assignmentPath: string
}

export const MODEL_CHOICE_FIXTURE = {
  offerId: 'offer-voice',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
} as const

async function createAwaitingTask(
  sessionStore: FileSystemSessionStore,
  status: 'awaiting_input' | 'awaiting_model_choice',
  title: string,
): Promise<WaitingTask & { readonly executionAttemptId: string; readonly runId: string; readonly workflowId: string; readonly brief: string }> {
  const session = await sessionStore.createSession({ title })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'voice-waiting-workflow',
    brief: `${title} brief.`,
  })
  assert.ok(task?.assignmentPath)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status,
      // Entering a wait releases the worker slot, as the task runner does.
      admission: undefined,
      executionAttemptId,
      executionAttemptNumber: 1,
      ...await currentAttemptScope(task, 1),
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)
  return {
    sessionId: session.id,
    taskId: task.id,
    assignmentPath: task.assignmentPath,
    executionAttemptId,
    runId: task.runId,
    workflowId: task.workflowId,
    brief: task.brief,
  }
}

function initializeStore(
  store: FileSystemWorkflowStateStore,
  task: Awaited<ReturnType<typeof createAwaitingTask>>,
  steps: Parameters<FileSystemWorkflowStateStore['initialize']>[0]['steps'],
): ReturnType<FileSystemWorkflowStateStore['initialize']> {
  return store.initialize({
    manifest: {
      taskId: task.taskId,
      sessionId: task.sessionId,
      rootRunId: task.runId,
      workflowId: task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('voice-waiting:v1'),
      briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId: task.executionAttemptId,
    steps,
  })
}

/** A workflow paused on a human-in-the-loop step that wants feedback. */
export async function createHumanInputWait(
  sessionStore: FileSystemSessionStore,
  sourceText = 'Round one findings: oat milk sales grew.',
): Promise<WaitingTask & { readonly interactionId: string }> {
  const task = await createAwaitingTask(sessionStore, 'awaiting_input', 'Human input')
  const sourceChildRunId = randomUUID()
  const sourceAssignmentPath = path.join(path.dirname(task.assignmentPath), sourceChildRunId)
  fs.mkdirSync(sourceAssignmentPath, { recursive: true })
  fs.writeFileSync(path.join(sourceAssignmentPath, 'round-one.md'), sourceText)
  const sourceArtifact = await createWorkflowArtifactReference({
    childAssignmentPath: sourceAssignmentPath,
    childRunId: sourceChildRunId,
    relativePath: 'round-one.md',
  })
  const store = new FileSystemWorkflowStateStore(task.assignmentPath)
  await initializeStore(store, task, [
    {
      stepId: 'human-feedback',
      stepIndex: 0,
      stepType: 'human-in-the-loop',
      definitionHash: hashWorkflowContent('human-feedback:v1'),
      recoveryPolicy: 'manual',
      inputArtifact: 'review/round-one.md',
      resultArtifact: 'feedback/round-one.json',
      requestedResultType: 'artifact:feedback/round-one.json',
    },
    {
      stepId: 'write',
      stepIndex: 1,
      stepType: 'team',
      team: 'writers',
      definitionHash: hashWorkflowContent('write:v1'),
      recoveryPolicy: 'safe_retry',
      inputArtifact: 'incoming-brief.md',
      resultArtifact: 'report.md',
      requestedResultType: 'artifact:report.md',
    },
  ])
  const state = await store.requestHumanInput({
    expectedRevision: 0,
    executionAttemptId: task.executionAttemptId,
    stepId: 'human-feedback',
    interactionId: randomUUID(),
    sourceArtifact,
    successorStepId: 'write',
    eligibleRecipients: [{ id: 'writer', mentionToken: 'writer', displayName: 'Writer' }],
  })
  const interaction = state.steps[0]?.humanInput
  assert.ok(interaction)
  return { ...task, interactionId: interaction.interactionId }
}

/** A team step whose agent asked one question and waits for the answer. */
export async function createAgentQuestionWait(
  sessionStore: FileSystemSessionStore,
  question = 'Who is the dedication for?',
): Promise<WaitingTask & { readonly interactionId: string; readonly questionIds: readonly string[] }> {
  const task = await createAwaitingTask(sessionStore, 'awaiting_input', 'Agent question')
  const store = new FileSystemWorkflowStateStore(task.assignmentPath)
  await initializeStore(store, task, [
    {
      stepId: 'write',
      stepIndex: 0,
      stepType: 'team',
      team: 'writers',
      childRunId: 'child-one',
      definitionHash: hashWorkflowContent('write:v1'),
      recoveryPolicy: 'safe_retry',
      inputArtifact: 'brief.md',
      resultArtifact: 'poem.md',
      requestedResultType: 'artifact:poem.md',
    },
  ])
  await store.update({
    expectedRevision: 0,
    executionAttemptId: task.executionAttemptId,
    mutate: (state) => {
      const step = state.steps[0]
      assert.ok(step)
      step.status = 'launching'
      step.attemptCount = 1
      state.currentStepId = step.stepId
    },
  })
  await store.update({
    expectedRevision: 1,
    executionAttemptId: task.executionAttemptId,
    mutate: (state) => {
      const step = state.steps[0]
      assert.ok(step)
      step.status = 'running'
    },
  })
  const wait = await store.requestAgentInput({
    executionAttemptId: task.executionAttemptId,
    stepId: 'write',
    invocation: {
      agentId: 'writer',
      agentDisplayName: 'Writer',
      logicalInvocationId: 'slot-one',
      dispatchId: 'dispatch-one',
      childRunId: 'child-one',
      teamId: 'writers',
      stageId: 'chain',
      definitionHash: hashWorkflowContent('writer'),
    },
    request: { progress: 'I need the recipient.', questions: [{ question, reason: 'Required for the dedication.' }] },
    continuation: {
      systemPrompt: 'Private writer instructions.',
      userMessage: task.brief,
      provider: 'openai',
      model: 'fixture',
      thinking: 'low',
    },
  })
  assert.equal(wait.kind, 'awaiting_input')
  if (wait.kind !== 'awaiting_input') throw new Error('The fixture question was not recorded.')
  const saved = await store.readAgentQuestion(wait.interactionId)
  return { ...task, interactionId: wait.interactionId, questionIds: saved.interaction.questionIds }
}

/** A workflow step whose model failed and that offers one retry on the default. */
export async function createModelChoiceWait(
  sessionStore: FileSystemSessionStore,
): Promise<WaitingTask> {
  const task = await createAwaitingTask(sessionStore, 'awaiting_model_choice', 'Model choice')
  const store = new FileSystemWorkflowStateStore(task.assignmentPath)
  await initializeStore(store, task, [
    {
      stepId: 'write',
      stepIndex: 0,
      stepType: 'team',
      team: 'writers',
      definitionHash: hashWorkflowContent('write:v1'),
      recoveryPolicy: 'safe_retry',
      inputArtifact: 'incoming-brief.md',
      resultArtifact: 'report.md',
      requestedResultType: 'artifact:report.md',
    },
  ])
  let revision = 0
  const advance = async (mutate: (draft: DurableWorkflowState) => void): Promise<void> => {
    await store.update({ expectedRevision: revision, executionAttemptId: task.executionAttemptId, mutate })
    revision += 1
  }
  for (const status of ['launching', 'running'] as const) {
    await advance((draft) => {
      const step = draft.steps[0]
      assert.ok(step)
      step.status = status
      step.attemptCount = 1
      step.startedAt = new Date().toISOString()
    })
  }
  const offerRevision = String(revision)
  await advance((draft) => {
    draft.status = 'awaiting_model_choice'
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'awaiting_model_choice'
    step.modelChoice = {
      offerId: MODEL_CHOICE_FIXTURE.offerId,
      scope: { kind: 'task', sessionId: task.sessionId, taskId: task.taskId },
      agentName: 'writer',
      expectedRevision: offerRevision,
      failedChoice: { ...MODEL_CHOICE_FIXTURE.failedChoice },
      proposedDefault: { ...MODEL_CHOICE_FIXTURE.proposedDefault },
      reason: 'missing-credential',
    }
  })
  return { sessionId: task.sessionId, taskId: task.taskId, assignmentPath: task.assignmentPath }
}
