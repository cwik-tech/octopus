import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore, type RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  createWorkflowArtifactReference,
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import { MAX_HUMAN_INPUT_SOURCE_PREVIEW_BYTES } from '../../contracts/human-input.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import {
  rebuildWorkflowStateProjection,
  WORKFLOW_STATE_STREAM_KIND,
} from '../../workflows/workflow-journal.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'

class BlockingTaskLauncher implements RunLauncher {
  async startRun(_request: RunStartRequest): Promise<never> {
    return await new Promise<never>(() => undefined)
  }
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-human-input-api-'))
}

async function createWaitingInteraction(
  workspacePath: string,
  sourceText = 'Round one findings.',
): Promise<{
  sessionStore: FileSystemSessionStore
  sessionId: string
  taskId: string
  assignmentPath: string
  interactionId: string
  workflowRevision: number
  sourceArtifactSha256: string
  sourcePath: string
}> {
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Human input API' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'human-input-api-workflow',
    brief: 'Review the first discussion round.',
  })
  assert.ok(task?.assignmentPath)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: 'awaiting_input',
      executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: 'initial',
      attemptStartedAt: new Date().toISOString(),
      recoveryCount: 0,
    },
    { expectedExecutionAttemptId: null },
  )
  assert.equal(waiting?.updated, true)

  const sourceChildRunId = randomUUID()
  const sourceAssignmentPath = path.join(path.dirname(task.assignmentPath), sourceChildRunId)
  fs.mkdirSync(sourceAssignmentPath, { recursive: true })
  fs.writeFileSync(path.join(sourceAssignmentPath, 'round-one.md'), sourceText)
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
      workflowDefinitionHash: hashWorkflowContent('human-input-api:v1'),
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
    interactionId: randomUUID(),
    sourceArtifact,
    successorStepId: 'write',
    eligibleRecipients: [{
      id: 'writer',
      mentionToken: 'writer',
      displayName: 'Writer',
    }],
  })
  const interaction = state.steps[0]!.humanInput
  assert.ok(interaction)
  return {
    sessionStore,
    sessionId: session.id,
    taskId: task.id,
    assignmentPath: task.assignmentPath,
    interactionId: interaction.interactionId,
    workflowRevision: state.revision,
    sourceArtifactSha256: sourceArtifact.sha256,
    sourcePath: path.join(sourceAssignmentPath, 'round-one.md'),
  }
}

function submissionBody(input: {
  workflowRevision: number
  sourceArtifactSha256: string
  text: string
  recipients: 'all' | string[]
}): Record<string, unknown> {
  return {
    submissionId: randomUUID(),
    expectedWorkflowRevision: input.workflowRevision,
    expectedSourceArtifactSha256: input.sourceArtifactSha256,
    mode: 'feedback',
    messages: [{
      id: randomUUID(),
      text: input.text,
      recipients: input.recipients,
    }],
  }
}

test('the human-input API rejects unknown literal @mentions before persisting feedback', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    const interactionResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop`,
    )
    assert.equal(interactionResponse.status, 200)
    const interactionBody = await interactionResponse.json() as { sourceText?: string }
    assert.equal(interactionBody.sourceText, 'Round one findings.')

    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/${fixture.interactionId}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submissionBody({
          workflowRevision: fixture.workflowRevision,
          sourceArtifactSha256: fixture.sourceArtifactSha256,
          text: '@unknown Please reconsider the findings.',
          recipients: ['writer'],
        })),
      },
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Unknown human-input recipient @unknown' })
    const snapshot = await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot()
    assert.equal(snapshot.state.steps[0]!.humanInput?.status, 'pending')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the human-input API reports a stale interaction ID as not found', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/stale-interaction/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submissionBody({
          workflowRevision: fixture.workflowRevision,
          sourceArtifactSha256: fixture.sourceArtifactSha256,
          text: '@writer Review the findings.',
          recipients: ['writer'],
        })),
      },
    )

    assert.equal(response.status, 404)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an unsupported method on the human-input read route returns 404 when no interaction is open and 405 when one is', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  // A task with a durable assignment but no human-input interaction yet.
  const session = await fixture.sessionStore.createSession({ title: 'No interaction yet' })
  const idleTask = await fixture.sessionStore.createTaskRecord(session.id, {
    workflowId: 'human-input-api-workflow',
    brief: 'Not waiting for anyone.',
  })
  assert.ok(idleTask?.assignmentPath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    // No open interaction: an unsupported method gets 404.
    const withoutInteraction = await fetch(
      `${server.url}/sessions/${session.id}/tasks/${idleTask.id}/human-in-the-loop`,
      { method: 'DELETE' },
    )
    assert.equal(withoutInteraction.status, 404)
    assert.deepEqual(await withoutInteraction.json(), { error: 'Human-in-the-loop interaction not found' })

    // An open interaction: the same unsupported method gets 405.
    const withInteraction = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop`,
      { method: 'DELETE' },
    )
    assert.equal(withInteraction.status, 405)
    assert.deepEqual(await withInteraction.json(), { error: 'Method not allowed' })
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a GET to a human-input submit URL with a stale interaction id returns 405 and leaves the interaction pending', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    // A POST with a stale id gets 404; see the stale-id test above.
    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/stale-interaction/submit`,
    )
    assert.equal(response.status, 405)
    assert.deepEqual(await response.json(), { error: 'Method not allowed' })
    const snapshot = await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot()
    assert.equal(snapshot.state.steps[0]?.humanInput?.status, 'pending')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the human-input API bounds large source previews after verifying the full artifact', async () => {
  const workspacePath = makeWorkspace()
  const sourceText = 'x'.repeat(MAX_HUMAN_INPUT_SOURCE_PREVIEW_BYTES + 1024)
  const fixture = await createWaitingInteraction(workspacePath, sourceText)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop`,
    )
    assert.equal(response.status, 200)
    const body = await response.json() as {
      sourceText: string
      sourceTruncated?: boolean
      sourceByteLength?: number
    }
    assert.equal(Buffer.byteLength(body.sourceText), MAX_HUMAN_INPUT_SOURCE_PREVIEW_BYTES)
    assert.equal(body.sourceTruncated, true)
    assert.equal(body.sourceByteLength, Buffer.byteLength(sourceText))
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a source file changed after the interaction opened returns 409 on read and on submit, and the interaction stays pending', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    // Same length, different bytes, so only the recorded hash tells them apart.
    fs.writeFileSync(fixture.sourcePath, 'Round two findings.')

    const read = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop`,
    )
    assert.equal(read.status, 409)

    const submit = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/${fixture.interactionId}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submissionBody({
          workflowRevision: fixture.workflowRevision,
          sourceArtifactSha256: fixture.sourceArtifactSha256,
          text: '@writer Please tighten the summary.',
          recipients: ['writer'],
        })),
      },
    )
    assert.equal(submit.status, 409)
    const snapshot = await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot()
    assert.equal(snapshot.state.steps[0]!.humanInput?.status, 'pending')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the human-input API emits immutable message and submission events after persistence', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/${fixture.interactionId}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submissionBody({
          workflowRevision: fixture.workflowRevision,
          sourceArtifactSha256: fixture.sourceArtifactSha256,
          text: '@writer Please include the rollout constraint.',
          recipients: ['writer'],
        })),
      },
    )
    assert.equal(response.status, 202)

    const eventPath = path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl')
    const events = fs.readFileSync(eventPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const message = events.find((event) => event.event === 'workflow.human_input.message')
    const submitted = events.find((event) => event.event === 'workflow.human_input.submitted')
    assert.deepEqual(message?.recipients, ['writer'])
    assert.equal(message?.text, '@writer Please include the rollout constraint.')
    assert.equal(submitted?.message_count, 1)
    assert.equal(submitted?.mode, 'feedback')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the human-input API rejects request bodies over 64 KiB before durable submission', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/${fixture.interactionId}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submissionBody({
          workflowRevision: fixture.workflowRevision,
          sourceArtifactSha256: fixture.sourceArtifactSha256,
          text: 'x'.repeat(70_000),
          recipients: ['writer'],
        })),
      },
    )

    assert.equal(response.status, 413)
    const snapshot = await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot()
    assert.equal(snapshot.state.steps[0]!.humanInput?.status, 'pending')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the human-input API accepts an empty continue-without-feedback submission', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/${fixture.interactionId}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submissionId: randomUUID(),
          expectedWorkflowRevision: fixture.workflowRevision,
          expectedSourceArtifactSha256: fixture.sourceArtifactSha256,
          mode: 'continue_without_feedback',
          messages: [],
        }),
      },
    )

    assert.equal(response.status, 202)
    const snapshot = await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot()
    assert.deepEqual(snapshot.state.steps[0]?.humanInput?.submission?.messages, [])
    assert.equal(
      snapshot.state.steps[0]?.humanInput?.submission?.mode,
      'continue_without_feedback',
    )
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the human-input API enforces message, recipient, and character limits at the boundary', async () => {
  const workspacePath = makeWorkspace()
  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    const base = {
      expectedWorkflowRevision: fixture.workflowRevision,
      expectedSourceArtifactSha256: fixture.sourceArtifactSha256,
      mode: 'feedback',
    }
    const invalidMessages = [
      Array.from({ length: 33 }, (_, index) => ({
        id: `message-${index}`,
        text: 'Feedback',
        recipients: 'all',
      })),
      [{
        id: 'too-many-recipients',
        text: 'Feedback',
        recipients: Array.from({ length: 9 }, (_, index) => `recipient-${index}`),
      }],
      [{
        id: 'too-many-characters',
        text: 'x'.repeat(32_001),
        recipients: 'all',
      }],
    ]
    for (const messages of invalidMessages) {
      const response = await fetch(
        `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/${fixture.interactionId}/submit`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...base, submissionId: randomUUID(), messages }),
        },
      )
      assert.equal(response.status, 400)
    }
    const snapshot = await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot()
    assert.equal(snapshot.state.steps[0]?.humanInput?.status, 'pending')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * AC5c: answering a human-input prompt is an authoritative workflow
 * transition, so for an enrolled assignment it must reach the canonical
 * journal — not just `workflow-state.json`.
 *
 * This drives the **real loopback route**. `server/routes/sessions.ts` builds
 * its own `FileSystemWorkflowStateStore`, so calling `submitHumanInput`
 * directly would step over the defect entirely.
 */
test('submitting human input through the loopback route records it in the journal', async (t) => {
  const workspacePath = fs.realpathSync(makeWorkspace())
  const previousFlag = process.env.PIPELINE_DURABLE_JOURNAL
  const previousTenant = process.env.TEAM_TENANT_ID
  process.env.PIPELINE_DURABLE_JOURNAL = 'authoritative'
  process.env.TEAM_TENANT_ID = 'tenant-human-input'
  t.after(() => {
    if (previousFlag === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = previousFlag
    if (previousTenant === undefined) delete process.env.TEAM_TENANT_ID
    else process.env.TEAM_TENANT_ID = previousTenant
  })

  const fixture = await createWaitingInteraction(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })

  let submitted = false
  try {
    const before = await journalWorkflowEventCount(fixture.assignmentPath)

    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop/${fixture.interactionId}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submissionBody({
          workflowRevision: fixture.workflowRevision,
          sourceArtifactSha256: fixture.sourceArtifactSha256,
          text: '@writer Keep the rollout constraint.',
          recipients: ['writer'],
        })),
      },
    )
    assert.equal(response.status, 202, await response.text())
    submitted = true

    const after = await journalWorkflowEventCount(fixture.assignmentPath)
    assert.ok(
      after > before,
      `the submission must append to the canonical journal: ${before} events before, ${after} after`,
    )
  } finally {
    // Closed before the rebuild so the route's registry releases the
    // assignment's journal handle and its per-scope lock.
    await server.close()
  }

  assert.ok(submitted)

  const workflowStore = new FileSystemWorkflowStateStore(fixture.assignmentPath)
  fs.rmSync(workflowStore.paths.statePath)

  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'tenant-human-input',
    mode: 'authoritative',
  })
  try {
    const journal = await registry.resolveJournalHandle({
      context: {
        contractVersion: 1,
        requestId: 'rebuild-ac5c',
        sessionId: fixture.sessionId,
        runId: path.basename(fixture.assignmentPath),
        assignmentId: path.basename(fixture.assignmentPath),
        agentPath: 'workflows/runner',
        authority: { kind: 'runtime-assignment', processIdentity: 'rebuild' },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    })
    assert.ok(journal)
    await rebuildWorkflowStateProjection(journal, workflowStore)

    const rebuilt = await workflowStore.requireSnapshot()
    const interaction = rebuilt.state.steps[0]?.humanInput
    assert.equal(
      interaction?.status,
      'submitted',
      'a rebuild from the journal must not lose the submitted input',
    )
    assert.equal(
      interaction?.submission?.messages[0]?.text,
      '@writer Keep the rollout constraint.',
    )
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/** Workflow-state events currently in this assignment's canonical journal. */
async function journalWorkflowEventCount(
  assignmentPath: string,
): Promise<number> {
  const read = await readExecutionJournal(assignmentPath)
  // The assignment enrols on the route's first journal resolve, so an absent
  // journal is the expected starting point. Any other unreadable result is a
  // real failure and must not read as zero.
  if (read.kind === 'not_found') return 0
  assert.equal(read.kind, 'ok', `journal unreadable: ${read.kind}`)
  if (read.kind !== 'ok') return 0
  return read.events.filter(
    (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
  ).length
}
