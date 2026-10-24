/**
 * What cancelling a workflow from its authoritative task answers today, in the
 * cases the journal-ahead fix must leave alone.
 *
 * The session task's cancellation has already won when this runs, so the store
 * converges the workflow to it: nothing to cancel for an execution that never
 * started, a refusal for another task's workflow (before anything is repaired
 * or written, even when the journal is ahead of the projection) and, without a
 * journal, for a manifest without its state, the same answer twice, the
 * override of a terminal state a worker committed in the window, and a refusal
 * that writes nothing when the journal is closed. Each case names whether the
 * assignment has a journal and what the journal holds afterwards. These tests
 * drive a real journal and store through their public methods.
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { initializeExecutionJournal, type ExecutionJournal } from '../../core/execution-journal.js'
import { buildDurableWorkflowTerminalOutcome } from '../../workflows/results.js'
import {
  createJournalBackedWorkflowRecorder,
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

const CANCELLATION = { taskId: 'task-one', summary: 'Cancelled by user' }

interface Assignment {
  assignment: string
  runtime: string
  journal: ExecutionJournal | undefined
  closeJournal(): Promise<void>
  open(): FileSystemWorkflowStateStore
}

async function makeAssignment(t: TestContext, journaled: boolean): Promise<Assignment> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'authoritative-cancel-kept-'))
  const assignment = path.join(workspace, 'assignments', 'root-one')
  await fs.mkdir(assignment, { recursive: true })
  const journal = journaled ? await initializeExecutionJournal({
    scopeRoot: assignment,
    identity: {
      scopeKind: 'assignment', scopeId: 'root-one', tenantId: 'local',
      sessionId: 'session-one', runId: 'root-one', assignmentId: 'root-one',
    },
  }) : undefined
  let closed = false
  t.after(async () => {
    if (journal && !closed) {
      closed = true
      await journal.close()
    }
    await fs.rm(workspace, { recursive: true, force: true })
  })
  return {
    assignment,
    runtime: path.join(assignment, '.runtime'),
    journal,
    closeJournal: async () => {
      if (!journal || closed) return
      closed = true
      await journal.close()
    },
    open: () => new FileSystemWorkflowStateStore(assignment, {
      now: () => new Date('2026-09-29T12:00:00.000Z'),
      randomUUID: () => 'fixed-uuid',
      ...(journal ? { journal: createJournalBackedWorkflowRecorder(journal) } : {}),
    }),
  }
}

/** Starts the workflow and runs its one step, ending at revision 2. */
async function startRunning(store: FileSystemWorkflowStateStore): Promise<void> {
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
    step.startedAt = '2026-09-29T12:00:00.000Z'
    draft.currentStepId = step.stepId
  } })
  await store.update({ expectedRevision: 1, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'running'
  } })
}

/** The revision and status of every state event in the workflow's stream. */
async function streamStates(journal: ExecutionJournal): Promise<string[]> {
  const stream = await journal.scanStream(
    WORKFLOW_STATE_STREAM_KIND, workflowJournalStreamId('task-one', 'chain-one'))
  return stream.events.map((event) => {
    const state = event.payload['state']
    assert.ok(state !== null && typeof state === 'object' && 'revision' in state && 'status' in state)
    return `r${String(state.revision)} ${String(state.status)}`
  })
}

/** What the journal holds for the workflow, or that the assignment has none. */
async function journalRecord(fixture: Assignment): Promise<'unenrolled' | string[]> {
  return fixture.journal ? streamStates(fixture.journal) : 'unenrolled'
}

/** Every journal event of the assignment, whole, for a before-and-after comparison. */
async function journalEvents(fixture: Assignment): Promise<unknown[]> {
  return fixture.journal ? [...(await fixture.journal.scan()).events] : []
}

async function runtimeFiles(runtime: string): Promise<Record<string, Buffer | '<absent>'>> {
  const files: Record<string, Buffer | '<absent>'> = {}
  for (const name of [WORKFLOW_EXECUTION_MANIFEST_FILENAME, WORKFLOW_STATE_FILENAME]) {
    files[name] = await fs.readFile(path.join(runtime, name)).catch(() => '<absent>' as const)
  }
  return files
}

/** Every file under the private runtime folder, with its bytes. */
async function runtimeTree(runtime: string): Promise<Record<string, Buffer>> {
  const tree: Record<string, Buffer> = {}
  const entries = await fs.readdir(runtime, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath, entry.name)
    tree[path.relative(runtime, full)] = await fs.readFile(full)
  }
  return tree
}

function storeError(code: string, message?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof WorkflowStateStoreError, String(error))
    assert.equal(error.code, code)
    if (message !== undefined) assert.equal(error.message, message)
    return true
  }
}

const RUNNING = ['r0 running', 'r1 running', 'r2 running']

test('an execution that never started has nothing to cancel', async (t) => {
  const cases = [
    { name: 'unenrolled', journaled: false, journal: 'unenrolled' as const },
    { name: 'journaled', journaled: true, journal: [] },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const fixture = await makeAssignment(t, scenario.journaled)

      assert.equal(await fixture.open().cancelFromAuthoritativeTask(CANCELLATION), null)

      assert.deepEqual(await runtimeFiles(fixture.runtime), {
        [WORKFLOW_EXECUTION_MANIFEST_FILENAME]: '<absent>',
        [WORKFLOW_STATE_FILENAME]: '<absent>',
      })
      assert.deepEqual(await journalRecord(fixture), scenario.journal)
    })
  }
})

test('without a journal, a manifest without its state is refused as incomplete', async (t) => {
  const fixture = await makeAssignment(t, false)
  await startRunning(fixture.open())
  await fs.rm(path.join(fixture.runtime, WORKFLOW_STATE_FILENAME))

  await assert.rejects(
    fixture.open().cancelFromAuthoritativeTask(CANCELLATION),
    storeError('corrupt', 'Workflow execution is incomplete: both manifest and state are required.'),
  )
  assert.equal((await runtimeFiles(fixture.runtime))[WORKFLOW_STATE_FILENAME], '<absent>')
})

test("a cancellation for another task's workflow is refused before anything is repaired or written", async (t) => {
  const cases = [
    { name: 'unenrolled, projection current', journaled: false, journalAhead: false, journal: 'unenrolled' as const },
    { name: 'journaled, projection current', journaled: true, journalAhead: false, journal: RUNNING },
    // A crash after the journal append and before the projection write. A
    // rebuild would rewrite the projection, which is not this request's to do.
    {
      name: 'journaled, journal one state ahead of the projection', journaled: true, journalAhead: true,
      journal: [...RUNNING, 'r3 running'],
    },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const fixture = await makeAssignment(t, scenario.journaled)
      const worker = fixture.open()
      await startRunning(worker)
      if (scenario.journalAhead) {
        const statePath = path.join(fixture.runtime, WORKFLOW_STATE_FILENAME)
        const projectionAtRevisionTwo = await fs.readFile(statePath)
        await worker.update({ expectedRevision: 2, executionAttemptId: 'attempt-one', mutate: (draft) => {
          const step = draft.steps[0]
          assert.ok(step)
          step.costUsd = 0.5
          draft.totalCostUsd = 0.5
        } })
        await fs.writeFile(statePath, projectionAtRevisionTwo)
      }
      const filesBefore = await runtimeFiles(fixture.runtime)
      const treeBefore = await runtimeTree(fixture.runtime)
      const eventsBefore = await journalEvents(fixture)

      await assert.rejects(
        fixture.open().cancelFromAuthoritativeTask({ ...CANCELLATION, taskId: 'task-two' }),
        storeError('identity_mismatch', 'Authoritative cancellation belongs to a different session task.'),
      )

      assert.deepEqual(await runtimeFiles(fixture.runtime), filesBefore)
      assert.deepEqual(await runtimeTree(fixture.runtime), treeBefore)
      assert.deepEqual(await journalEvents(fixture), eventsBefore)
      assert.deepEqual(await journalRecord(fixture), scenario.journal)
    })
  }
})

test("a state naming another task under this task's manifest is refused, and nothing is repaired or written", async (t) => {
  const cases = [
    { name: 'unenrolled', journaled: false, journalAhead: false, journal: 'unenrolled' as const },
    { name: 'journaled, projection current', journaled: true, journalAhead: false, journal: RUNNING },
    {
      name: 'journaled, journal one state ahead of the projection', journaled: true, journalAhead: true,
      journal: [...RUNNING, 'r3 running'],
    },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const fixture = await makeAssignment(t, scenario.journaled)
      const worker = fixture.open()
      await startRunning(worker)
      const statePath = path.join(fixture.runtime, WORKFLOW_STATE_FILENAME)
      const projectionAtRevisionTwo = await fs.readFile(statePath, 'utf8')
      if (scenario.journalAhead) {
        await worker.update({ expectedRevision: 2, executionAttemptId: 'attempt-one', mutate: (draft) => {
          const step = draft.steps[0]
          assert.ok(step)
          step.costUsd = 0.5
          draft.totalCostUsd = 0.5
        } })
      }
      // The projection says another task owns it; the manifest still says
      // this one does.
      const otherTask = projectionAtRevisionTwo.replace('"taskId": "task-one"', '"taskId": "task-two"')
      assert.notEqual(otherTask, projectionAtRevisionTwo)
      await fs.writeFile(statePath, otherTask)
      const treeBefore = await runtimeTree(fixture.runtime)
      const eventsBefore = await journalEvents(fixture)

      await assert.rejects(
        fixture.open().cancelFromAuthoritativeTask(CANCELLATION),
        storeError('identity_mismatch', "Workflow state 'taskId' does not match its execution manifest."),
      )

      assert.deepEqual(await runtimeTree(fixture.runtime), treeBefore)
      assert.deepEqual(await journalEvents(fixture), eventsBefore)
      assert.deepEqual(await journalRecord(fixture), scenario.journal)
    })
  }
})

test('cancelling twice answers with the one cancellation, recorded once', async (t) => {
  const cases = [
    { name: 'unenrolled', journaled: false, journal: 'unenrolled' as const },
    { name: 'journaled', journaled: true, journal: [...RUNNING, 'r3 cancelled'] },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const fixture = await makeAssignment(t, scenario.journaled)
      await startRunning(fixture.open())
      const first = await fixture.open().cancelFromAuthoritativeTask(CANCELLATION)
      const afterFirst = await runtimeFiles(fixture.runtime)

      const second = await fixture.open().cancelFromAuthoritativeTask({ ...CANCELLATION, summary: 'Cancelled again' })

      assert.equal(first?.status, 'cancelled')
      assert.equal(first?.revision, 3)
      assert.deepEqual(second, first)
      assert.deepEqual(await runtimeFiles(fixture.runtime), afterFirst)
      assert.deepEqual(await journalRecord(fixture), scenario.journal)
    })
  }
})

test('a workflow a worker already failed is cancelled over it, and the failed step keeps its evidence', async (t) => {
  const cases = [
    { name: 'unenrolled', journaled: false, journal: 'unenrolled' as const },
    { name: 'journaled', journaled: true, journal: [...RUNNING, 'r3 failed', 'r4 cancelled'] },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const fixture = await makeAssignment(t, scenario.journaled)
      const worker = fixture.open()
      await startRunning(worker)
      await worker.update({ expectedRevision: 2, executionAttemptId: 'attempt-one', mutate: (draft) => {
        const step = draft.steps[0]
        assert.ok(step)
        step.status = 'failed'
        step.summary = 'The poet stopped.'
        step.error = 'The poet stopped.'
        step.completedAt = '2026-09-29T12:00:00.000Z'
        draft.status = 'failed'
        delete draft.currentStepId
        draft.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: draft.workflowId, status: 'failed', summary: 'The poet stopped.',
          requestedResultType: step.requestedResultType, outputStepId: step.stepId,
        })
      } })

      const cancelled = await fixture.open().cancelFromAuthoritativeTask(CANCELLATION)

      assert.equal(cancelled?.status, 'cancelled')
      assert.equal(cancelled?.revision, 4)
      assert.equal(cancelled?.terminalOutcome?.status, 'cancelled')
      assert.equal(cancelled?.steps[0]?.status, 'failed')
      assert.equal(cancelled?.steps[0]?.summary, 'The poet stopped.')
      assert.deepEqual(await journalRecord(fixture), scenario.journal)
    })
  }
})

test('with the journal closed, the cancellation is refused, and nothing is written', async (t) => {
  const fixture = await makeAssignment(t, true)
  assert.ok(fixture.journal)
  await startRunning(fixture.open())
  const before = await runtimeFiles(fixture.runtime)
  const store = fixture.open()
  await fixture.closeJournal()

  await assert.rejects(store.cancelFromAuthoritativeTask(CANCELLATION), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error, String(error))
    assert.equal(error.code, 'closed')
    return true
  })
  assert.deepEqual(await runtimeFiles(fixture.runtime), before)
})
