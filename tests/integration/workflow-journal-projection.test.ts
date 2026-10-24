import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
  WorkflowStateStoreError,
  type InitializeWorkflowExecutionInput,
} from '../../workflows/workflow-state-store.js'
import type { DurableWorkflowState } from '../../workflows/types.js'
import {
  createJournalBackedWorkflowRecorder,
  createWorkflowProjectionMetadataStore,
  importWorkflowBaseline,
  rebuildWorkflowStateProjection,
  workflowJournalStreamId,
  WorkflowJournalError,
} from '../../workflows/workflow-journal.js'

const CREATED_AT = '2026-08-17T12:00:00.000Z'
const UPDATED_AT = '2026-08-17T12:00:01.000Z'

function makeAssignmentRoot(): string {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-journal-projection-'),
  )
  return path.join(workspace, 'assignments', 'root-run')
}

function initializationInput(): InitializeWorkflowExecutionInput {
  return {
    manifest: {
      taskId: 'task-one',
      sessionId: 'product-session',
      rootRunId: 'root-run',
      workflowId: 'research-workflow',
      workflowDefinitionHash: hashWorkflowContent('workflow:v1'),
      briefHash: hashWorkflowContent('Investigate the market.'),
      teamDefinitionHashes: {
        researchers: hashWorkflowContent('researchers:v1'),
      },
      runtimeVersion: 'workflow-runtime-v1',
      createdAt: CREATED_AT,
    },
    executionAttemptId: 'attempt-one',
    steps: [
      {
        stepId: 'research',
        stepIndex: 0,
        stepType: 'team',
        team: 'researchers',
        definitionHash: hashWorkflowContent('research-step:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
      },
    ],
  }
}

function journalIdentity(): ExecutionJournalScopeIdentity {
  return {
    scopeKind: 'assignment',
    scopeId: 'root-run',
    tenantId: 'local',
    sessionId: 'product-session',
    runId: 'root-run',
    assignmentId: 'root-run',
  }
}

function advanceToLaunchingStep(
  store: FileSystemWorkflowStateStore,
  snapshot: { state: DurableWorkflowState },
): Promise<DurableWorkflowState> {
  return store.update({
    expectedRevision: snapshot.state.revision,
    executionAttemptId: snapshot.state.ownerExecutionAttemptId,
    mutate: (draft) => {
      const step = draft.steps[0]
      if (!step) throw new Error('missing step')
      step.status = 'launching'
      step.attemptCount += 1
      step.startedAt = UPDATED_AT
      step.childRunId = 'child-run'
      draft.currentStepId = step.stepId
    },
  })
}

async function completeWorkflow(
  store: FileSystemWorkflowStateStore,
  state: DurableWorkflowState,
): Promise<DurableWorkflowState> {
  // Steps move launching -> running -> completed; the store rejects skips.
  const running = await store.update({
    expectedRevision: state.revision,
    executionAttemptId: state.ownerExecutionAttemptId,
    mutate: (draft) => {
      for (const step of draft.steps) step.status = 'running'
    },
  })
  return store.update({
    expectedRevision: running.revision,
    executionAttemptId: running.ownerExecutionAttemptId,
    mutate: (draft) => {
      for (const step of draft.steps) {
        step.status = 'completed'
        step.completedAt = UPDATED_AT
        step.artifact = {
          childRunId: 'child-run',
          relativePath: 'report.md',
          sha256: hashWorkflowContent('report contents'),
          byteLength: 16,
        }
      }
      draft.status = 'completed'
      const wrapperBody = '# Report\n\nFindings.\n'
      draft.terminalOutcome = {
        status: 'completed',
        summary: 'Research completed.',
        requestedResultType: 'artifact:report.md',
        outputStepId: 'research',
        rootWrapperBody: wrapperBody,
        rootWrapperSha256: hashWorkflowContent(wrapperBody),
      }
    },
  })
}

test('a journaled workflow rebuilds the same state after its projection is deleted', async () => {
  const assignmentRoot = makeAssignmentRoot()
  fs.mkdirSync(assignmentRoot, { recursive: true })
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentRoot,
      identity: journalIdentity(),
    })
    const recorder = createJournalBackedWorkflowRecorder(journal)
    const store = new FileSystemWorkflowStateStore(assignmentRoot, {
      now: () => new Date(UPDATED_AT),
      randomUUID: () => 'child-run',
      journal: recorder,
    })

    const initialized = await store.initialize(initializationInput())
    await advanceToLaunchingStep(store, initialized)
    const before = await store.requireSnapshot()

    fs.rmSync(store.paths.statePath)
    await rebuildWorkflowStateProjection(journal, store)

    const after = await store.requireSnapshot()
    assert.deepEqual(after.state, before.state)
    assert.deepEqual(after.manifest, before.manifest)
    await journal.close()
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentRoot)), {
      recursive: true,
      force: true,
    })
  }
})

test('a rebuilt workflow projection reports its lag against the journal', async () => {
  const assignmentRoot = makeAssignmentRoot()
  fs.mkdirSync(assignmentRoot, { recursive: true })
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentRoot,
      identity: journalIdentity(),
    })
    const store = new FileSystemWorkflowStateStore(assignmentRoot, {
      now: () => new Date(UPDATED_AT),
      randomUUID: () => 'child-run',
      journal: createJournalBackedWorkflowRecorder(journal),
    })
    const initialized = await store.initialize(initializationInput())
    await advanceToLaunchingStep(store, initialized)
    await rebuildWorkflowStateProjection(journal, store)

    const metadata = createWorkflowProjectionMetadataStore(journal)
    assert.equal(
      await metadata.classifyLag((await journal.scan()).lastSequence),
      'current',
    )

    // An unrelated canonical append leaves the projection behind.
    await journal.append({
      eventId: 'workflow-lag-probe',
      streamKind: 'test',
      streamId: 'workflow-lag',
      expectedStreamRevision: 0,
      type: 'test.observation',
      payloadSchemaVersion: 1,
      payload: { index: 1 },
      correlationId: 'workflow-lag',
    })
    assert.equal(
      await metadata.classifyLag((await journal.scan()).lastSequence),
      'lagging',
    )
    await journal.close()
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentRoot)), {
      recursive: true,
      force: true,
    })
  }
})

test('a validated legacy baseline rebuilds the same workflow state', async () => {
  const assignmentRoot = makeAssignmentRoot()
  fs.mkdirSync(assignmentRoot, { recursive: true })
  try {
    const legacyStore = new FileSystemWorkflowStateStore(assignmentRoot, {
      now: () => new Date(UPDATED_AT),
      randomUUID: () => 'child-run',
    })
    const initialized = await legacyStore.initialize(initializationInput())
    const launched = await advanceToLaunchingStep(legacyStore, initialized)
    // Only a terminal execution may change authorities (ADR §9).
    await completeWorkflow(legacyStore, launched)
    const before = await legacyStore.requireSnapshot()

    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentRoot,
      identity: journalIdentity(),
    })
    await importWorkflowBaseline(journal, legacyStore)

    fs.rmSync(legacyStore.paths.statePath)
    await rebuildWorkflowStateProjection(journal, legacyStore)

    const after = await legacyStore.requireSnapshot()
    assert.deepEqual(after.state, before.state)
    assert.deepEqual(after.manifest, before.manifest)

    // The baseline is imported once; re-importing the same validated state is
    // idempotent, and importing a divergent state fails closed.
    await importWorkflowBaseline(journal, legacyStore)
    await journal.close()
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentRoot)), {
      recursive: true,
      force: true,
    })
  }
})

test('owner fencing rejects a forged ownership transition on rebuild', async () => {
  const assignmentRoot = makeAssignmentRoot()
  fs.mkdirSync(assignmentRoot, { recursive: true })
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentRoot,
      identity: journalIdentity(),
    })
    const recorder = createJournalBackedWorkflowRecorder(journal)
    const store = new FileSystemWorkflowStateStore(assignmentRoot, {
      now: () => new Date(UPDATED_AT),
      randomUUID: () => 'child-run',
      journal: recorder,
    })
    const initialized = await store.initialize(initializationInput())

    // A legitimate recovery claim changes the owner with a bumped
    // recovery count and must rebuild cleanly.
    await store.claimExecutionAttempt({
      expectedRevision: initialized.state.revision,
      expectedOwnerExecutionAttemptId: 'attempt-one',
      nextExecutionAttemptId: 'attempt-two',
    })
    const claimed = await store.requireSnapshot()
    fs.rmSync(store.paths.statePath)
    await rebuildWorkflowStateProjection(journal, store)
    const rebuilt = await store.requireSnapshot()
    assert.deepEqual(rebuilt.state, claimed.state)

    // A forged snapshot that swaps the owner without a recovery-count bump
    // must fail rebuild, not be adopted.
    const forgedState: DurableWorkflowState = {
      ...JSON.parse(JSON.stringify(claimed.state)),
      revision: claimed.state.revision + 1,
      ownerExecutionAttemptId: 'attacker-attempt',
    }
    await recorder.recordSnapshot(forgedState)
    await assert.rejects(
      rebuildWorkflowStateProjection(journal, store),
      /owner/i,
    )
    await journal.close()
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentRoot)), {
      recursive: true,
      force: true,
    })
  }
})

test('projection metadata tracks the last applied journal sequence', async () => {
  const assignmentRoot = makeAssignmentRoot()
  fs.mkdirSync(assignmentRoot, { recursive: true })
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentRoot,
      identity: journalIdentity(),
    })
    const recorder = createJournalBackedWorkflowRecorder(journal)
    const store = new FileSystemWorkflowStateStore(assignmentRoot, {
      now: () => new Date(UPDATED_AT),
      randomUUID: () => 'child-run',
      journal: recorder,
    })
    const initialized = await store.initialize(initializationInput())
    await advanceToLaunchingStep(store, initialized)

    const scan = await journal.scan()
    const streamEvents = scan.events.filter(
      (event) =>
        event.streamKind === 'workflow.state' &&
        event.streamId === workflowJournalStreamId('task-one', 'research-workflow'),
    )
    assert.ok(streamEvents.length >= 2)
    fs.rmSync(store.paths.statePath)
    const rebuildResult = await rebuildWorkflowStateProjection(journal, store)
    const lastEvent = streamEvents[streamEvents.length - 1]
    assert.ok(lastEvent)
    assert.equal(rebuildResult.lastAppliedSequence, lastEvent.sequence)
    await journal.close()
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentRoot)), {
      recursive: true,
      force: true,
    })
  }
})

test('a workflow that can still resume is refused as a baseline', async () => {
  const assignmentRoot = makeAssignmentRoot()
  fs.mkdirSync(assignmentRoot, { recursive: true })
  try {
    const legacyStore = new FileSystemWorkflowStateStore(assignmentRoot, {
      now: () => new Date(UPDATED_AT),
      randomUUID: () => 'child-run',
    })
    const initialized = await legacyStore.initialize(initializationInput())
    await advanceToLaunchingStep(legacyStore, initialized)

    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentRoot,
      identity: journalIdentity(),
    })
    try {
      // Running: importing it would switch a live execution's authority.
      await assert.rejects(
        importWorkflowBaseline(journal, legacyStore),
        (error: unknown) =>
          error instanceof WorkflowJournalError &&
          error.code === 'invalid_baseline',
      )
      // Nothing was written, so the legacy authority remains untouched.
      assert.equal((await journal.scan()).eventCount, 0)
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentRoot)), {
      recursive: true,
      force: true,
    })
  }
})

/**
 * AC9. `workflow-state.json` is a projection of the canonical journal, so an
 * enrolled assignment must be able to lose it. These cover the classification
 * the production load path performs, and the single lock acquisition that
 * transaction is allowed.
 */

/** An enrolled store over a real journal, cleaned up whatever the body does. */
async function withJournaledStore(
  options: { lockTimeoutMs?: number },
  body: (fixture: {
    readonly store: FileSystemWorkflowStateStore
  }) => Promise<void>,
): Promise<void> {
  const assignmentRoot = makeAssignmentRoot()
  fs.mkdirSync(assignmentRoot, { recursive: true })
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentRoot,
      identity: journalIdentity(),
    })
    try {
      await body({
        store: new FileSystemWorkflowStateStore(assignmentRoot, {
          now: () => new Date(UPDATED_AT),
          randomUUID: () => 'child-run',
          journal: createJournalBackedWorkflowRecorder(journal),
          ...(options.lockTimeoutMs === undefined
            ? {}
            : { lockTimeoutMs: options.lockTimeoutMs, lockRetryMs: 10 }),
        }),
      })
    } finally {
      await journal.close()
    }
  } finally {
    fs.rmSync(path.dirname(path.dirname(assignmentRoot)), {
      recursive: true,
      force: true,
    })
  }
}

/** Read the projection file as raw JSON, without the store's validation. */
function readProjectionFile(
  store: FileSystemWorkflowStateStore,
): Record<string, unknown> {
  const raw = fs.readFileSync(store.paths.statePath, 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

test('load rebuilds a projection that is behind the canonical journal', async () => {
  await withJournaledStore({}, async ({ store }) => {
    const initialized = await store.initialize(initializationInput())
    // The bytes a worker crash can leave behind: a projection written before
    // the next transition was journaled, then never caught up.
    const staleBytes = fs.readFileSync(store.paths.statePath)
    const advanced = await advanceToLaunchingStep(store, initialized)
    fs.writeFileSync(store.paths.statePath, staleBytes)

    const loaded = await store.load()

    assert.equal(loaded?.state.revision, advanced.revision)
    assert.deepEqual(loaded?.state, advanced)
    assert.equal(
      readProjectionFile(store)['revision'],
      advanced.revision,
      'the rebuilt projection must be republished, not only returned',
    )
  })
})

test('load fails closed on a projection ahead of the canonical journal', async () => {
  await withJournaledStore({}, async ({ store }) => {
    const initialized = await store.initialize(initializationInput())
    const advanced = await advanceToLaunchingStep(store, initialized)

    // After AC5 nothing may legitimately publish a projection the journal has
    // never seen, so this is a violation rather than lag.
    const forged = { ...readProjectionFile(store), revision: advanced.revision + 1 }
    fs.writeFileSync(
      store.paths.statePath,
      `${JSON.stringify(forged, null, 2)}\n`,
    )

    await assert.rejects(store.load(), (error: unknown) => {
      assert.ok(error instanceof WorkflowStateStoreError)
      assert.equal(error.code, 'revision_conflict')
      assert.match(error.message, /ahead of the canonical journal/i)
      return true
    })
    assert.equal(
      readProjectionFile(store)['revision'],
      advanced.revision + 1,
      'a refused load must not overwrite the projection it refused',
    )
  })
})

test('load refuses to rebuild without an intact execution manifest', async () => {
  await withJournaledStore({}, async ({ store }) => {
    const initialized = await store.initialize(initializationInput())
    await advanceToLaunchingStep(store, initialized)

    // The manifest is the rebuild's only identity source: a workflow journal
    // event carries `{ state }`, and the stream id is derived from it.
    fs.rmSync(store.paths.manifestPath)

    await assert.rejects(store.load(), (error: unknown) => {
      assert.ok(error instanceof WorkflowStateStoreError)
      assert.equal(error.code, 'not_found')
      assert.match(error.message, /execution manifest/i)
      return true
    })

    // And with the projection gone too, the answer is still an honest refusal
    // rather than a fresh execution that would collide with the journal.
    fs.rmSync(store.paths.statePath)
    await assert.rejects(store.load(), (error: unknown) => {
      assert.ok(error instanceof WorkflowStateStoreError)
      assert.equal(error.code, 'not_found')
      assert.match(error.message, /execution manifest/i)
      return true
    })
    assert.equal(
      fs.existsSync(store.paths.statePath),
      false,
      'a refused load must not attempt a rebuild',
    )
  })
})

test('a rebuild during load takes the workflow lock exactly once', async () => {
  // The workflow lock is a cross-process file lock and is not reentrant, so a
  // second acquisition inside the same transaction can only wait out the
  // timeout. A short timeout turns that mistake into a fast failure.
  await withJournaledStore({ lockTimeoutMs: 250 }, async ({ store }) => {
    const initialized = await store.initialize(initializationInput())
    const advanced = await advanceToLaunchingStep(store, initialized)
    fs.rmSync(store.paths.statePath)

    const rebuilt = await store.load()
    assert.deepEqual(rebuilt?.state, advanced)

    // The mutators read the projection while already holding the lock, so they
    // must keep working under the same short timeout.
    const running = await store.update({
      expectedRevision: advanced.revision,
      executionAttemptId: advanced.ownerExecutionAttemptId,
      mutate: (draft) => {
        const step = draft.steps[0]
        if (!step) throw new Error('missing step')
        step.status = 'running'
      },
    })
    assert.equal(running.revision, advanced.revision + 1)
  })
})

test('load rebuilds a projection whose JSON parses but fails the workflow-state schema', async () => {
  await withJournaledStore({}, async ({ store }) => {
    const initialized = await store.initialize(initializationInput())
    const advanced = await advanceToLaunchingStep(store, initialized)

    // Well-formed JSON at the right revision, carrying a status the schema
    // does not define: readable bytes are not the same as a usable state.
    fs.writeFileSync(
      store.paths.statePath,
      `${JSON.stringify({ ...readProjectionFile(store), status: 'not-a-status' }, null, 2)}\n`,
    )
    const repairedFromInvalidState = await store.load()
    assert.deepEqual(repairedFromInvalidState?.state, advanced)

    // And an unsupported schema version, which fails before validation.
    fs.writeFileSync(
      store.paths.statePath,
      `${JSON.stringify({ ...readProjectionFile(store), schemaVersion: 99 }, null, 2)}\n`,
    )
    const repairedFromSchemaVersion = await store.load()
    assert.deepEqual(repairedFromSchemaVersion?.state, advanced)
    assert.equal(readProjectionFile(store)['schemaVersion'], 2)
  })
})

test('load refuses to rebuild from an unreadable execution manifest', async () => {
  await withJournaledStore({}, async ({ store }) => {
    const initialized = await store.initialize(initializationInput())
    await advanceToLaunchingStep(store, initialized)
    const projectionBefore = fs.readFileSync(store.paths.statePath, 'utf8')

    // An invalid manifest is as unrecoverable as a missing one: it is the only
    // identity the replay can be addressed by.
    fs.writeFileSync(store.paths.manifestPath, '{broken-json')

    await assert.rejects(store.load(), (error: unknown) => {
      assert.ok(error instanceof WorkflowStateStoreError)
      assert.equal(error.code, 'corrupt')
      assert.match(error.message, /execution manifest could not be read/i)
      assert.match(error.message, /cannot be recovered/i)
      return true
    })
    assert.equal(
      fs.readFileSync(store.paths.statePath, 'utf8'),
      projectionBefore,
      'a refused load must not republish the projection',
    )
  })
})
