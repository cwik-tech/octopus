import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { subscribeEngineEvents } from '../../domains/runtime/runtime-events.js'
import { TaskQueue } from '../../services/task-queue.js'
import {
  openHumanInputInteraction,
  submitHumanInputFeedback,
  validateHumanInputRecipients,
} from '../../services/workflow-human-input-service.js'
import type { HumanInputMessage, HumanInputRecipient } from '../../workflows/types.js'
import {
  createWorkflowArtifactReference,
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'

function makeRecipient(id: string, mentionToken = id): HumanInputRecipient {
  return { id, mentionToken, displayName: id }
}

function makeMessage(
  text: string,
  recipients: HumanInputMessage['recipients'],
  id = 'message-1',
): HumanInputMessage {
  return { id, text, recipients }
}

const WRITER_AND_EDITOR = [makeRecipient('writer'), makeRecipient('editor')]

test('a message addressed to exactly the agents it @mentions is accepted', () => {
  const violation = validateHumanInputRecipients(
    [makeMessage('@writer and @editor, tighten the intro.', ['editor', 'writer'])],
    WRITER_AND_EDITOR,
  )

  assert.equal(violation, null)
})

test('an @mention matches its recipient regardless of letter case', () => {
  const violation = validateHumanInputRecipients(
    [makeMessage('@WRITER please revise.', ['writer'])],
    WRITER_AND_EDITOR,
  )

  assert.equal(violation, null)
})

test('a message with no @mentions is accepted whatever it is addressed to', () => {
  const violation = validateHumanInputRecipients(
    [
      makeMessage('Looks good overall.', 'all', 'message-1'),
      makeMessage('Keep the second section.', ['editor'], 'message-2'),
    ],
    WRITER_AND_EDITOR,
  )

  assert.equal(violation, null)
})

test('an @mention of an agent outside the recipient list is reported as unknown, lowercased', () => {
  const violation = validateHumanInputRecipients(
    [makeMessage('@Reviewer should check this.', ['writer'])],
    WRITER_AND_EDITOR,
  )

  assert.deepEqual(violation, { kind: 'unknown', mentionToken: 'reviewer' })
})

test('an @mention that two recipients share is reported as ambiguous', () => {
  const violation = validateHumanInputRecipients(
    [makeMessage('@writer please revise.', ['writer-a'])],
    [makeRecipient('writer-a', 'writer'), makeRecipient('writer-b', 'writer')],
  )

  assert.deepEqual(violation, { kind: 'ambiguous', mentionToken: 'writer' })
})

test('a message that @mentions an agent but is addressed to all is a mismatch', () => {
  const violation = validateHumanInputRecipients(
    [makeMessage('@writer please revise.', 'all')],
    WRITER_AND_EDITOR,
  )

  assert.deepEqual(violation, { kind: 'mismatch' })
})

test('a message addressed to more agents than it @mentions is a mismatch', () => {
  const violation = validateHumanInputRecipients(
    [makeMessage('@writer please revise.', ['writer', 'editor'])],
    WRITER_AND_EDITOR,
  )

  assert.deepEqual(violation, { kind: 'mismatch' })
})

test('a message addressed to fewer agents than it @mentions is a mismatch', () => {
  const violation = validateHumanInputRecipients(
    [makeMessage('@writer and @editor, tighten the intro.', ['writer'])],
    WRITER_AND_EDITOR,
  )

  assert.deepEqual(violation, { kind: 'mismatch' })
})

test('the first message that breaks a rule decides the violation', () => {
  const violation = validateHumanInputRecipients(
    [
      makeMessage('@writer please revise.', 'all', 'message-1'),
      makeMessage('@reviewer should check this.', ['writer'], 'message-2'),
    ],
    WRITER_AND_EDITOR,
  )

  assert.deepEqual(violation, { kind: 'mismatch' })
})

class BlockingTaskLauncher implements RunLauncher {
  async startRun(_request: RunStartRequest): Promise<never> {
    return await new Promise<never>(() => undefined)
  }
}

const FIXED_NOW = '2026-07-13T12:00:00.000Z'

/** A task awaiting human input, with a ready queue, in a fresh temporary workspace. */
async function makeWaitingInteraction(): Promise<{
  workspacePath: string
  sessionStore: FileSystemSessionStore
  taskQueue: TaskQueue
  close: () => Promise<void>
  sessionId: string
  taskId: string
  assignmentPath: string
  workflowRevision: number
  sourceArtifactSha256: string
}> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-human-input-service-'))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: process.cwd(),
    workspacePath,
    taskLauncher: new BlockingTaskLauncher(),
    tickIntervalMs: 60_000,
  })
  await taskQueue.initialize()
  const close = async (): Promise<void> => {
    await taskQueue.close(1)
    await owner.release()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }

  const session = await sessionStore.createSession({ title: 'Human input service' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'human-input-service-workflow',
    brief: 'Review the first discussion round.',
  })
  assert.ok(task?.assignmentPath)
  const executionAttemptId = 'attempt-awaiting-feedback'
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_input',
      executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)

  const sourceChildRunId = 'source-child-run'
  const sourceAssignmentPath = path.join(path.dirname(task.assignmentPath), sourceChildRunId)
  fs.mkdirSync(sourceAssignmentPath, { recursive: true })
  fs.writeFileSync(path.join(sourceAssignmentPath, 'round-one.md'), 'Round one findings.')
  const sourceArtifact = await createWorkflowArtifactReference({
    childAssignmentPath: sourceAssignmentPath,
    childRunId: sourceChildRunId,
    relativePath: 'round-one.md',
  })
  const stateStore = new FileSystemWorkflowStateStore(task.assignmentPath)
  await stateStore.initialize({
    manifest: {
      taskId: task.id,
      sessionId: session.id,
      rootRunId: task.runId,
      workflowId: task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('human-input-service:v1'),
      briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId,
    steps: [
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
    ],
  })
  const state = await stateStore.requestHumanInput({
    expectedRevision: 0,
    executionAttemptId,
    stepId: 'human-feedback',
    interactionId: 'interaction-1',
    sourceArtifact,
    successorStepId: 'write',
    eligibleRecipients: [makeRecipient('writer')],
  })
  return {
    workspacePath,
    sessionStore,
    taskQueue,
    close,
    sessionId: session.id,
    taskId: task.id,
    assignmentPath: task.assignmentPath,
    workflowRevision: state.revision,
    sourceArtifactSha256: sourceArtifact.sha256,
  }
}

function readRuntimeEventTimestamps(assignmentPath: string): Array<[unknown, unknown]> {
  return fs.readFileSync(path.join(assignmentPath, 'logs', 'runtime-events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const event: unknown = JSON.parse(line)
      assert.ok(event && typeof event === 'object' && 'event' in event && 'timestamp' in event)
      return [event.event, event.timestamp]
    })
}

test('a submission takes its submittedAt and its runtime event timestamps from the supplied clock', async () => {
  const fixture = await makeWaitingInteraction()
  try {
    const opened = await openHumanInputInteraction(
      { sessionStore: fixture.sessionStore },
      { sessionId: fixture.sessionId, taskId: fixture.taskId },
    )
    assert.ok(opened.kind === 'open')

    const result = await submitHumanInputFeedback(
      { taskQueue: fixture.taskQueue, now: () => new Date(FIXED_NOW) },
      opened.open,
      {
        readRequest: async () => ({
          submissionId: 'submission-1',
          expectedWorkflowRevision: fixture.workflowRevision,
          expectedSourceArtifactSha256: fixture.sourceArtifactSha256,
          mode: 'feedback',
          messages: [{ id: 'message-1', text: '@writer tighten the intro.', recipients: ['writer'] }],
        }),
      },
    )

    assert.equal(result.kind, 'submitted')
    const snapshot = await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot()
    assert.equal(snapshot.state.steps[0]?.humanInput?.submission?.submittedAt, FIXED_NOW)
    assert.deepEqual(readRuntimeEventTimestamps(fixture.assignmentPath), [
      ['workflow.human_input.message', FIXED_NOW],
      ['workflow.human_input.submitted', FIXED_NOW],
    ])
  } finally {
    await fixture.close()
  }
})

test('the submission events are published before the continuation re-admits the task', async () => {
  // Whoever reads the events as they are published (the UI's Run activity, a
  // running queue, recovery) must see the submission before the task is back
  // in the queue. A subscriber reads the task record from disk at the moment
  // the submitted event arrives.
  const fixture = await makeWaitingInteraction()
  const taskRecordPath = path.join(
    fixture.workspacePath, 'sessions', fixture.sessionId, 'tasks', fixture.taskId, 'task.json',
  )
  const recordAtSubmittedEvent: Array<{ status: unknown; admission: unknown }> = []
  const unsubscribe = subscribeEngineEvents((event) => {
    if (event.type !== 'workflow.human_input.submitted') return
    const record: unknown = JSON.parse(fs.readFileSync(taskRecordPath, 'utf8'))
    assert.ok(record && typeof record === 'object' && 'status' in record)
    recordAtSubmittedEvent.push({ status: record.status, admission: 'admission' in record ? record.admission : undefined })
  })
  try {
    assert.ok(fs.existsSync(taskRecordPath), 'the task record is where this test reads it')
    const opened = await openHumanInputInteraction(
      { sessionStore: fixture.sessionStore },
      { sessionId: fixture.sessionId, taskId: fixture.taskId },
    )
    assert.ok(opened.kind === 'open')

    const result = await submitHumanInputFeedback(
      { taskQueue: fixture.taskQueue, now: () => new Date(FIXED_NOW) },
      opened.open,
      {
        readRequest: async () => ({
          submissionId: 'submission-1',
          expectedWorkflowRevision: fixture.workflowRevision,
          expectedSourceArtifactSha256: fixture.sourceArtifactSha256,
          mode: 'feedback',
          messages: [{ id: 'message-1', text: '@writer tighten the intro.', recipients: ['writer'] }],
        }),
      },
    )

    assert.ok(result.kind === 'submitted')
    assert.deepEqual(recordAtSubmittedEvent, [{ status: 'awaiting_input', admission: undefined }])
    // The continuation did re-admit the task afterwards, so the observation
    // above can tell the two orders apart.
    assert.notEqual(result.task.admission, undefined)
  } finally {
    unsubscribe()
    await fixture.close()
  }
})
