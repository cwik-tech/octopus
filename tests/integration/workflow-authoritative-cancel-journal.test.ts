/**
 * Cancelling a journaled workflow from its authoritative task, where the
 * journal and `workflow-state.json` disagree.
 *
 * The store appends each state to the journal before it rewrites
 * `workflow-state.json`, so a crash between the two leaves the journal one
 * state ahead, or leaves no projection at all. A cancellation that has already
 * won on the session task then has to end the workflow cancelled, built on the
 * journal's latest state, so nothing the journal recorded is lost, and recorded
 * once, under the next revision. When the files and the journal disagree in a
 * way the journal cannot answer (the manifest is gone, the stream is
 * malformed, or the projection is ahead of the journal) the cancellation is
 * refused and nothing is written, as every other read of the workflow is.
 *
 * These tests drive a real journal and store through their public methods,
 * with a fresh store for the cancellation as a restarted process would build.
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { initializeExecutionJournal, type ExecutionJournal } from '../../core/execution-journal.js'
import {
  createJournalBackedWorkflowRecorder,
  WORKFLOW_SNAPSHOT_EVENT_TYPE,
  WORKFLOW_STATE_STREAM_KIND,
  workflowJournalStreamId,
} from '../../workflows/workflow-journal.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
  WORKFLOW_EXECUTION_MANIFEST_FILENAME,
  WORKFLOW_STATE_FILENAME,
  WorkflowStateStoreError,
} from '../../workflows/workflow-state-store.js'

const IDENTITY = { taskId: 'task-one', workflowId: 'chain-one' }
const STREAM_ID = workflowJournalStreamId(IDENTITY.taskId, IDENTITY.workflowId)
const CANCELLATION = { taskId: IDENTITY.taskId, summary: 'Cancelled by user' }

function openStore(
  assignment: string,
  journal: ExecutionJournal | undefined,
  at = '2026-09-29T12:00:00.000Z',
): FileSystemWorkflowStateStore {
  return new FileSystemWorkflowStateStore(assignment, {
    now: () => new Date(at),
    randomUUID: () => 'fixed-uuid',
    ...(journal ? { journal: createJournalBackedWorkflowRecorder(journal) } : {}),
  })
}

/** A journaled workflow at revision 2, its one step running. */
async function runningWorkflow(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'authoritative-cancel-'))
  const assignment = path.join(workspace, 'assignments', 'root-one')
  await fs.mkdir(assignment, { recursive: true })
  const journal = await initializeExecutionJournal({
    scopeRoot: assignment,
    identity: {
      scopeKind: 'assignment', scopeId: 'root-one', tenantId: 'local',
      sessionId: 'session-one', runId: 'root-one', assignmentId: 'root-one',
    },
  })
  t.after(async () => {
    await journal.close()
    await fs.rm(workspace, { recursive: true, force: true })
  })
  const worker = openStore(assignment, journal)
  await worker.initialize({
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
  await worker.update({ expectedRevision: 0, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'launching'
    step.attemptCount = 1
    step.startedAt = '2026-09-29T12:00:00.000Z'
    draft.currentStepId = step.stepId
  } })
  await worker.update({ expectedRevision: 1, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'running'
  } })
  const runtime = path.join(assignment, '.runtime')
  return {
    assignment, journal, worker, runtime,
    statePath: path.join(runtime, WORKFLOW_STATE_FILENAME),
    manifestPath: path.join(runtime, WORKFLOW_EXECUTION_MANIFEST_FILENAME),
  }
}

/** Every state event in the workflow's stream, in order. */
async function streamEvents(journal: ExecutionJournal) {
  const stream = await journal.scanStream(WORKFLOW_STATE_STREAM_KIND, STREAM_ID)
  return stream.events.map((event) => {
    const state = event.payload['state']
    assert.ok(state !== null && typeof state === 'object' && 'revision' in state)
    return { eventId: event.eventId, streamRevision: event.streamRevision, revision: state.revision }
  })
}

async function readIfPresent(file: string): Promise<string> {
  return fs.readFile(file, 'utf8').catch(() => '<absent>')
}

test('a cancellation after the journal got ahead of the projection ends the workflow cancelled on the journal state', async (t) => {
  const { assignment, journal, worker, statePath } = await runningWorkflow(t)
  const projectionAtRevisionTwo = await fs.readFile(statePath)
  // The worker records spending on the running step (revision 3) ...
  await worker.update({ expectedRevision: 2, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.costUsd = 0.5
    draft.totalCostUsd = 0.5
  } })
  // ... and dies after the journal append, before the projection write.
  await fs.writeFile(statePath, projectionAtRevisionTwo)

  const cancelled = await openStore(assignment, journal).cancelFromAuthoritativeTask(CANCELLATION)

  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(cancelled?.revision, 4)
  assert.equal(cancelled?.totalCostUsd, 0.5, 'the spending the journal recorded is kept')

  const reopened = await openStore(assignment, journal).load()
  assert.equal(reopened?.state.status, 'cancelled')
  assert.equal(reopened?.state.revision, 4)

  const recorded = await createJournalBackedWorkflowRecorder(journal).readRecordedState(IDENTITY)
  assert.equal(recorded?.state.status, 'cancelled')
  assert.equal(recorded?.state.totalCostUsd, 0.5)

  const events = await streamEvents(journal)
  assert.deepEqual(events.map((event) => event.revision), [0, 1, 2, 3, 4])
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length)
})

test('a cancellation retried after its own journal append survived a crash answers with that cancellation, recorded once', async (t) => {
  const { assignment, journal, statePath } = await runningWorkflow(t)
  const projectionAtRevisionTwo = await fs.readFile(statePath)
  const first = await openStore(assignment, journal).cancelFromAuthoritativeTask(CANCELLATION)
  // The cancelling process died after the journal append, before the
  // projection write, and the task's cancellation is applied again later.
  await fs.writeFile(statePath, projectionAtRevisionTwo)

  const retried = await openStore(assignment, journal, '2026-09-29T12:05:00.000Z')
    .cancelFromAuthoritativeTask(CANCELLATION)

  assert.equal(first?.revision, 3)
  assert.deepEqual(retried, first)
  assert.deepEqual((await streamEvents(journal)).map((event) => event.revision), [0, 1, 2, 3])
  assert.equal((await openStore(assignment, journal).load())?.state.status, 'cancelled')
})

test('a cancellation that finds no projection while the journal holds the workflow rebuilds it and cancels', async (t) => {
  const { assignment, journal, statePath } = await runningWorkflow(t)
  await fs.rm(statePath)

  const cancelled = await openStore(assignment, journal).cancelFromAuthoritativeTask(CANCELLATION)

  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(cancelled?.revision, 3)
  assert.deepEqual((await streamEvents(journal)).map((event) => event.revision), [0, 1, 2, 3])
  assert.equal((await openStore(assignment, journal).load())?.state.status, 'cancelled')
})

test('a lost manifest while the journal still holds the workflow is refused as not found, and nothing is written', async (t) => {
  const MANIFEST_LOST =
    'The workflow execution manifest is missing while the canonical journal holds workflow state, so this workflow cannot be recovered.'
  const { assignment, journal, statePath, manifestPath } = await runningWorkflow(t)
  const projection = await fs.readFile(statePath, 'utf8')
  await fs.rm(manifestPath)

  // With the projection still there ...
  await assert.rejects(openStore(assignment, journal).cancelFromAuthoritativeTask(CANCELLATION), (error: unknown) => {
    assert.ok(error instanceof WorkflowStateStoreError, String(error))
    assert.equal(error.code, 'not_found')
    assert.equal(error.message, MANIFEST_LOST)
    return true
  })
  assert.equal(await readIfPresent(statePath), projection)

  // ... and with it gone too: the journal's evidence is not "nothing to cancel".
  await fs.rm(statePath)
  await assert.rejects(openStore(assignment, journal).cancelFromAuthoritativeTask(CANCELLATION), (error: unknown) => {
    assert.ok(error instanceof WorkflowStateStoreError, String(error))
    assert.equal(error.code, 'not_found')
    assert.equal(error.message, MANIFEST_LOST)
    return true
  })
  assert.equal(await readIfPresent(statePath), '<absent>')
  assert.equal(await readIfPresent(manifestPath), '<absent>')
  assert.deepEqual((await streamEvents(journal)).map((event) => event.revision), [0, 1, 2])
})

test('a journal stream holding a malformed workflow state refuses the cancellation, and nothing is written', async (t) => {
  const { assignment, journal, statePath } = await runningWorkflow(t)
  const projection = await fs.readFile(statePath, 'utf8')
  await journal.append({
    eventId: `${STREAM_ID}:malformed`, streamKind: WORKFLOW_STATE_STREAM_KIND, streamId: STREAM_ID,
    expectedStreamRevision: 3, type: WORKFLOW_SNAPSHOT_EVENT_TYPE, payloadSchemaVersion: 1,
    payload: { state: { schemaVersion: 2, revision: 'three' } }, correlationId: STREAM_ID,
  })
  const eventsBefore = await streamEvents(journal)

  await assert.rejects(openStore(assignment, journal).cancelFromAuthoritativeTask(CANCELLATION), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error, String(error))
    assert.equal(error.code, 'corrupt')
    return true
  })
  assert.equal(await readIfPresent(statePath), projection)
  assert.deepEqual(await streamEvents(journal), eventsBefore)
})

test('a projection ahead of the journal refuses the cancellation, and nothing is written', async (t) => {
  const { assignment, journal, statePath } = await runningWorkflow(t)
  // A store with no journal (a process without a journal registry) moves the
  // projection to revision 3; the journal stays at 2.
  await openStore(assignment, undefined).update({
    expectedRevision: 2, executionAttemptId: 'attempt-one', mutate: (draft) => {
      const step = draft.steps[0]
      assert.ok(step)
      step.costUsd = 0.25
      draft.totalCostUsd = 0.25
    },
  })
  const projection = await fs.readFile(statePath, 'utf8')

  await assert.rejects(openStore(assignment, journal).cancelFromAuthoritativeTask(CANCELLATION), (error: unknown) => {
    assert.ok(error instanceof WorkflowStateStoreError, String(error))
    assert.equal(error.code, 'revision_conflict')
    return true
  })
  assert.equal(await readIfPresent(statePath), projection)
  assert.deepEqual((await streamEvents(journal)).map((event) => event.revision), [0, 1, 2])
})
