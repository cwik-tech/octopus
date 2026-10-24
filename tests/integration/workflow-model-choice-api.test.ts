/**
 * A suspended run, over the real HTTP API.
 *
 * A workflow waiting on a model choice has to be able to *say* what it is
 * waiting for, and one approval has to release exactly that wait — through the
 * ordinary continuation admission, so the resumed attempt is scheduled like any
 * other rather than through a path of its own.
 *
 * Deliberately separate from the human-input route: one wait is for content a
 * person writes and the other for a decision about how to run, and neither
 * answer may release the other.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore, type RunStartRequest } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { currentAttemptScope } from '../support/current-attempt-scope.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'
import { buildDurableWorkflowTerminalOutcome } from '../../workflows/results.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { resolveWorkflowJournalRecorder } from '../../services/workflow-journal-recorder.js'
import type {
  DurableWorkflowState,
  DurableWorkflowStepState,
  WorkflowStepStateSeed,
} from '../../workflows/types.js'
import type { TaskAdmission } from '../../contracts/sessions.js'

const FAILED_CHOICE = { provider: 'anthropic', model: 'claude-opus-4-6' }
const PROPOSED_DEFAULT = { provider: 'connection:abc', model: 'gpt-5.4-mini' }
const OFFER_ID = 'offer-suspended'
/** Distinct from both the failed pair and the offered one, and available. */
const MOVED_DEFAULT = { provider: 'connection:xyz', model: 'gpt-5.6-sol' }

class BlockingTaskLauncher implements RunLauncher {
  async startRun(_request: RunStartRequest): Promise<never> {
    return await new Promise<never>(() => undefined)
  }
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-model-choice-api-'))
}

/** A step ahead of the waiting one, so committed work has something to be. */
function predecessorSeed(): WorkflowStepStateSeed {
  return {
    stepId: 'research',
    stepIndex: 0,
    stepType: 'team',
    team: 'writers',
    definitionHash: hashWorkflowContent('research:v1'),
    recoveryPolicy: 'safe_retry',
    inputArtifact: 'incoming-brief.md',
    resultArtifact: 'research.md',
    requestedResultType: 'artifact:research.md',
  }
}

/** A task whose durable workflow is suspended on one model-choice offer. */
async function createSuspendedRun(
  workspacePath: string,
  options: {
    taskStatus?: 'awaiting_model_choice' | 'running'
    withPredecessor?: boolean
    journalRegistry?: WorkspaceExecutionJournalRegistry
  } = {},
): Promise<{
  sessionStore: FileSystemSessionStore
  sessionId: string
  taskId: string
  assignmentPath: string
  approvedFromRevision: number
}> {
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Model choice API' })
  const task = await sessionStore.createTaskRecord(session.id, {
    workflowId: 'model-choice-api-workflow',
    brief: 'Draft a recommendation.',
  })
  assert.ok(task?.assignmentPath)
  const executionAttemptId = randomUUID()
  const waiting = await sessionStore.compareAndSetTaskRecord(
    session.id,
    task.id,
    ['queued'],
    {
      status: options.taskStatus ?? 'awaiting_model_choice',
      // Entering the wait releases the worker slot, which is what the task
      // runner does. Leaving the admission behind would make the approval look
      // like a second claim on work already scheduled.
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

  // Seeded through the journal-backed store when a registry is given, so the
  // canonical records exist and the projection is genuinely derived from them.
  const stateStore = new FileSystemWorkflowStateStore(
    task.assignmentPath,
    options.journalRegistry
      ? await resolveWorkflowJournalRecorder({
          registry: options.journalRegistry,
          task,
          requestId: `seed-${task.id}`,
          processIdentity: executionAttemptId,
        })
      : undefined,
  )
  await stateStore.initialize({
    manifest: {
      taskId: task.id,
      sessionId: session.id,
      rootRunId: task.runId,
      workflowId: task.workflowId,
      workflowDefinitionHash: hashWorkflowContent('model-choice-api:v1'),
      briefHash: hashWorkflowContent(task.brief),
      teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
    },
    executionAttemptId,
    steps: [
      ...(options.withPredecessor ? [predecessorSeed()] : []),
      {
        stepId: 'write',
        stepIndex: options.withPredecessor ? 1 : 0,
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
  let revision = 0
  const advance = async (
    mutate: (draft: DurableWorkflowState) => void,
  ): Promise<void> => {
    await stateStore.update({ expectedRevision: revision, executionAttemptId, mutate })
    revision += 1
  }
  const stepOf = (
    draft: DurableWorkflowState,
    stepId: string,
  ): DurableWorkflowStepState => {
    const step = draft.steps.find((candidate) => candidate.stepId === stepId)
    if (!step) throw new Error(`Fixture has no step '${stepId}'.`)
    return step
  }

  if (options.withPredecessor) {
    // Real committed work ahead of the wait: a refresh must leave it alone.
    for (const status of ['launching', 'running'] as const) {
      await advance((draft) => {
        const step = stepOf(draft, 'research')
        step.status = status
        step.attemptCount = 1
        step.startedAt = new Date().toISOString()
      })
    }
    await advance((draft) => {
      const step = stepOf(draft, 'research')
      step.status = 'completed'
      step.summary = 'Research result.'
      step.costUsd = 0.25
      draft.totalCostUsd = 0.25
      step.completedAt = new Date().toISOString()
      step.artifact = {
        childRunId: step.childRunId,
        relativePath: 'research.md',
        sha256: hashWorkflowContent('Research result.'),
        byteLength: 16,
      }
    })
  }
  for (const status of ['launching', 'running'] as const) {
    await advance((draft) => {
      const step = stepOf(draft, 'write')
      step.status = status
      step.attemptCount = 1
      step.startedAt = new Date().toISOString()
    })
  }
  const offerRevision = String(revision)
  await advance((draft) => {
    draft.status = 'awaiting_model_choice'
    const step = stepOf(draft, 'write')
    step.status = 'awaiting_model_choice'
    step.modelChoice = {
      offerId: OFFER_ID,
      scope: { kind: 'task', sessionId: session.id, taskId: task.id },
      agentName: 'writer',
      ...(options.withPredecessor ? { logicalInvocationId: 'write' } : {}),
      expectedRevision: offerRevision,
      failedChoice: FAILED_CHOICE,
      proposedDefault: PROPOSED_DEFAULT,
      reason: 'missing-credential',
    }
  })

  return {
    sessionStore,
    sessionId: session.id,
    taskId: task.id,
    assignmentPath: task.assignmentPath,
    // The revision the wait was written at, so a test that wants the crash
    // window can approve from here *after* the server has started. Creating
    // that state before startup would have the queue adopt it during
    // initialization, which is a different repair than the one under test.
    approvedFromRevision: revision,
  }
}

async function withServer<T>(
  run: (input: {
    url: string
    fixture: Awaited<ReturnType<typeof createSuspendedRun>>
  }) => Promise<T>,
  options: {
    taskStatus?: 'awaiting_model_choice' | 'running'
    withPredecessor?: boolean
    journal?: boolean
  } = {},
): Promise<T> {
  const workspacePath = makeWorkspace()
  // Used only to write the journal, then closed before the server starts. The
  // API composition builds its own registry, so leaving this one open would put
  // two owners on the same assignment — and this one would outlive the
  // workspace it is rooted in.
  const seedRegistry = options.journal
    ? new WorkspaceExecutionJournalRegistry({
        workspacePath,
        tenantId: 'local',
        mode: 'authoritative',
      })
    : undefined
  let fixture: Awaited<ReturnType<typeof createSuspendedRun>>
  try {
    fixture = await createSuspendedRun(workspacePath, {
      ...options,
      ...(seedRegistry ? { journalRegistry: seedRegistry } : {}),
    })
  } finally {
    await seedRegistry?.close()
  }
  setRuntimeDefaultModelState({ status: 'available', ...PROPOSED_DEFAULT })
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new BlockingTaskLauncher(),
    taskLauncher: new BlockingTaskLauncher(),
    sessionStore: fixture.sessionStore,
    repoRootPath: process.cwd(),
    workspacePath,
  })
  try {
    return await run({ url: server.url, fixture })
  } finally {
    setRuntimeDefaultModelState(undefined)
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
}

test('a suspended run says what it is waiting for, and one approval releases it', async () => {
  await withServer(async ({ url, fixture }) => {
    const base = `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`

    // Set here rather than at server start: the composition hydrates the
    // runtime default from provider settings while it boots. Reading the offer
    // now resolves it against the default, so this has to be settled first.
    setRuntimeDefaultModelState({ status: 'available', ...PROPOSED_DEFAULT })
    const pending = await fetch(base)
    assert.equal(pending.status, 200, await pending.clone().text())
    const offered = await pending.json() as {
      readonly stepId: string
      readonly offer: {
        readonly offerId: string
        readonly failedChoice: unknown
        readonly proposedDefault: unknown
      }
    }
    assert.equal(offered.stepId, 'write')
    assert.equal(offered.offer.offerId, OFFER_ID)
    assert.deepEqual(offered.offer.failedChoice, FAILED_CHOICE)
    assert.deepEqual(offered.offer.proposedDefault, PROPOSED_DEFAULT)

    // An approval for an offer this run is not waiting on authorizes nothing.
    const wrong = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: 'some-other-offer', idempotencyKey: 'k1' }),
    })
    assert.equal(wrong.status, 409, await wrong.clone().text())
    assert.equal(
      (await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot())
        .state.status,
      'awaiting_model_choice',
    )

    // Set here rather than at server start: the composition hydrates the
    // runtime default from provider settings while it boots.
    setRuntimeDefaultModelState({ status: 'available', ...PROPOSED_DEFAULT })
    const approved = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
    })
    assert.equal(approved.status, 202, await approved.clone().text())

    // The question is gone and its answer is on the step that asked it.
    const state = await new FileSystemWorkflowStateStore(
      fixture.assignmentPath,
    ).requireSnapshot()
    assert.equal(state.state.status, 'running')
    assert.equal(state.state.steps[0]?.modelChoice, undefined)
    assert.deepEqual(state.state.steps[0]?.approvedModelChoice, {
      offerId: OFFER_ID,
      agentName: 'writer',
      failedChoice: FAILED_CHOICE,
      proposedDefault: PROPOSED_DEFAULT,
    })

    // And the run is scheduled again through ordinary continuation admission.
    const body = await approved.json() as {
      readonly task: { readonly admission?: { readonly source?: string } }
    }
    assert.equal(body.task.admission?.source, 'model_choice')
  })
})

test('a model-choice wait is invisible to the human-input route', async () => {
  await withServer(async ({ url, fixture }) => {
    const response = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/human-in-the-loop`,
    )
    assert.equal(response.status, 404, await response.clone().text())

    assert.equal(
      (await new FileSystemWorkflowStateStore(fixture.assignmentPath).requireSnapshot())
        .state.status,
      'awaiting_model_choice',
    )
  })
})

test('a stale offer is replaced by a fresh one for the current default', async () => {
  // The offer named a pair. Approving it after Settings moved on would admit a
  // continuation that can only be refused later in the child, leaving the run
  // scheduled for work nobody authorized. Refusing alone is not enough either:
  // the wait would sit there advertising a pair that can no longer run, and
  // nothing would ever move it on. The refusal refreshes it instead, and only
  // the fresh offer approves.
  await withServer(async ({ url, fixture }) => {
    const base = `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
    const before = await store.requireSnapshot()

    setRuntimeDefaultModelState({ status: 'available', ...MOVED_DEFAULT })

    const refused = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
    })
    assert.equal(refused.status, 409, await refused.clone().text())
    const refusal = await refused.json() as {
      readonly code?: string
      readonly offer?: { readonly offerId: string; readonly proposedDefault: unknown }
    }
    assert.equal(refusal.code, 'default-changed')
    // The refusal hands back the offer that replaced it, so a client does not
    // have to guess that re-reading is worthwhile.
    assert.ok(refusal.offer, 'the refusal carries the refreshed offer')
    assert.notEqual(refusal.offer.offerId, OFFER_ID)
    assert.deepEqual(refusal.offer.proposedDefault, MOVED_DEFAULT)

    // Nothing was dispatched.
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(task?.admission, undefined, 'no continuation was admitted')

    // The replacement is durable, and it is a different offer.
    const after = await store.requireSnapshot()
    assert.equal(after.state.status, 'awaiting_model_choice')
    const waiting = after.state.steps.find((step) => step.stepId === 'write')
    assert.equal(waiting?.status, 'awaiting_model_choice')
    const fresh = waiting?.modelChoice
    assert.ok(fresh)
    assert.notEqual(fresh.offerId, OFFER_ID)
    assert.deepEqual(fresh.proposedDefault, MOVED_DEFAULT)
    assert.equal(fresh.expectedRevision, String(before.state.revision))

    // Everything that says *which* retry this is survives the refresh.
    assert.equal(fresh.agentName, 'writer')
    assert.equal(fresh.logicalInvocationId, 'write')
    assert.equal(fresh.reason, 'missing-credential')
    assert.deepEqual(fresh.failedChoice, FAILED_CHOICE)
    assert.deepEqual(fresh.scope, {
      kind: 'task',
      sessionId: fixture.sessionId,
      taskId: fixture.taskId,
    })

    // Committed work is untouched.
    const predecessor = after.state.steps.find((step) => step.stepId === 'research')
    assert.equal(predecessor?.status, 'completed')
    assert.equal(predecessor?.summary, 'Research result.')
    assert.equal(predecessor?.costUsd, 0.25)

    // A reader sees the fresh offer, not the one that can no longer run.
    const reread = await fetch(base)
    assert.equal(reread.status, 200, await reread.clone().text())
    const current = await reread.json() as {
      readonly offer: { readonly offerId: string; readonly proposedDefault: unknown }
    }
    assert.equal(current.offer.offerId, fresh.offerId)
    assert.deepEqual(current.offer.proposedDefault, MOVED_DEFAULT)

    // The offer that was replaced approves nothing, ever again.
    const stale = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k2' }),
    })
    assert.equal(stale.status, 409, await stale.clone().text())
    assert.equal((await stale.json() as { code?: string }).code, 'offer-not-found')

    // And the fresh one admits exactly one continuation. Nothing consented on
    // the user's behalf along the way: this is the first admission of the run.
    const approved = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: fresh.offerId, idempotencyKey: 'k3' }),
    })
    assert.equal(approved.status, 202, await approved.clone().text())
    const body = await approved.json() as {
      readonly task: { readonly admission?: { readonly source?: string } }
    }
    assert.equal(body.task.admission?.source, 'model_choice')

    const resumed = await store.requireSnapshot()
    assert.equal(resumed.state.status, 'running')
    const released = resumed.state.steps.find((step) => step.stepId === 'write')
    assert.equal(released?.modelChoice, undefined)
    assert.equal(released?.approvedModelChoice?.offerId, fresh.offerId)
    assert.deepEqual(released?.approvedModelChoice?.proposedDefault, MOVED_DEFAULT)
    assert.deepEqual(released?.approvedModelChoice?.failedChoice, FAILED_CHOICE)
  }, { withPredecessor: true })
})

test('a direct read refreshes a stale offer rather than presenting it', async () => {
  // A reader that never approves still has to be told the truth. Answering the
  // read from stored state alone shows a pair Settings has already moved past,
  // so the one actionable thing on screen is the one thing that cannot be done.
  // Reading resolves the offer the same way approving does, and writes the
  // replacement — but authorizes nothing.
  await withServer(async ({ url, fixture }) => {
    const base = `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
    const before = await store.requireSnapshot()

    setRuntimeDefaultModelState({ status: 'available', ...MOVED_DEFAULT })

    const first = await fetch(base)
    assert.equal(first.status, 200, await first.clone().text())
    const read = await first.json() as {
      readonly stepId: string
      readonly offer: { readonly offerId: string; readonly proposedDefault: unknown }
    }
    assert.equal(read.stepId, 'write')
    assert.notEqual(read.offer.offerId, OFFER_ID)
    assert.deepEqual(read.offer.proposedDefault, MOVED_DEFAULT)

    // Reading admits nothing.
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(task?.admission, undefined, 'a read admitted a continuation')

    const after = await store.requireSnapshot()
    assert.equal(after.state.status, 'awaiting_model_choice')
    const waiting = after.state.steps.find((step) => step.stepId === 'write')
    assert.equal(waiting?.status, 'awaiting_model_choice')
    assert.equal(waiting?.modelChoice?.offerId, read.offer.offerId)
    assert.equal(waiting?.modelChoice?.expectedRevision, String(before.state.revision))
    assert.equal(waiting?.modelChoice?.agentName, 'writer')
    assert.equal(waiting?.modelChoice?.logicalInvocationId, 'write')
    assert.deepEqual(waiting?.modelChoice?.failedChoice, FAILED_CHOICE)

    // Committed work is untouched by a read.
    const predecessor = after.state.steps.find((step) => step.stepId === 'research')
    assert.equal(predecessor?.status, 'completed')
    assert.equal(predecessor?.costUsd, 0.25)

    // Reading again changes nothing: the stored offer already names B.
    const second = await fetch(base)
    assert.equal(second.status, 200, await second.clone().text())
    const reread = await second.json() as {
      readonly workflowRevision: number
      readonly offer: { readonly offerId: string }
    }
    assert.equal(reread.offer.offerId, read.offer.offerId)
    const settled = await store.requireSnapshot()
    assert.equal(
      settled.state.revision,
      after.state.revision,
      'a second read wrote a second replacement',
    )
  }, { withPredecessor: true })
})

for (const unusable of [
  {
    name: 'no default is configured',
    state: { status: 'unset' as const },
    code: 'no-app-default',
  },
  {
    name: 'the configured default cannot run',
    state: { status: 'unavailable' as const, ...MOVED_DEFAULT },
    code: 'no-app-default',
  },
  {
    name: 'the default is the pair that already failed',
    state: { status: 'available' as const, ...FAILED_CHOICE },
    code: 'default-equals-failed-choice',
  },
]) {
  test(`a stale offer is not refreshed when ${unusable.name}`, async () => {
    // Refreshing would have to invent an eligible pair. The wait is kept so the
    // run can still be answered once Settings are fixed, and the refusal says
    // which of the three problems it is — but nothing is offered as current.
    await withServer(async ({ url, fixture }) => {
      const base = `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`
      setRuntimeDefaultModelState(unusable.state)

      // Reading and approving give the same answer. A read that returned the
      // stored offer here would put the pair that cannot run back on screen as
      // the one actionable choice.
      for (const request of [
        (): Promise<Response> => fetch(base),
        (): Promise<Response> =>
          fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
          }),
      ]) {
        const response = await request()
        assert.equal(response.status, 409, await response.clone().text())
        const refusal = await response.json() as {
          readonly code?: string
          readonly offer?: unknown
        }
        // The exact code, not either of them: naming the wrong one sends a
        // person to fix a setting that was never the problem.
        assert.equal(refusal.code, unusable.code)
        assert.equal(
          refusal.offer,
          undefined,
          'a refusal that cannot be acted on must not carry an offer',
        )
      }

      const task = await fixture.sessionStore.getTaskRecord(
        fixture.sessionId,
        fixture.taskId,
      )
      assert.equal(task?.admission, undefined, 'no continuation was admitted')

      // The wait survives, unchanged.
      const state = await new FileSystemWorkflowStateStore(
        fixture.assignmentPath,
      ).requireSnapshot()
      assert.equal(state.state.status, 'awaiting_model_choice')
      const waiting = state.state.steps.find((step) => step.stepId === 'write')
      assert.equal(waiting?.modelChoice?.offerId, OFFER_ID)
      assert.deepEqual(waiting?.modelChoice?.proposedDefault, PROPOSED_DEFAULT)
    }, { withPredecessor: true })
  })
}

test('an approval recorded before its admission is answered from the attempt it already authorized', async () => {
  // The crash window between the two writes. The workflow durably holds the
  // approval the user gave; the task never recorded the admission that acts on
  // it. Startup adoption repairs this, but a person whose request died mid
  // flight retransmits it, and that request has to find the decision it already
  // made rather than a 404 saying nothing is waiting. Answering it must not
  // approve a second time, resolve another model, or admit twice.
  await withServer(async ({ url, fixture }) => {
    const base = `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)

    // Created here, after the server is up. Startup adoption has already run
    // and never runs again, so this isolates the HTTP reconciliation from the
    // queue's own repair of the same window.
    await store.approveModelChoice({
      expectedRevision: fixture.approvedFromRevision,
      offerId: OFFER_ID,
    })
    const approvedBefore = await store.requireSnapshot()
    const authorization = approvedBefore.state.steps.find(
      (step) => step.stepId === 'write',
    )?.approvedModelChoice
    assert.ok(authorization, 'the approval is recorded with no admission')

    // The default has moved on since the approval. The approved pair is what
    // the user was shown, and recovering must use it exactly as persisted
    // rather than resolving Settings again.
    setRuntimeDefaultModelState({ status: 'available', ...MOVED_DEFAULT })

    const retransmitted = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
    })
    assert.equal(retransmitted.status, 202, await retransmitted.clone().text())
    const body = await retransmitted.json() as {
      readonly task: {
        readonly admission?: {
          readonly source?: string
          readonly executionKind?: string
        }
        readonly recoveryCount?: number
      }
      readonly stepId: string
    }
    assert.equal(body.stepId, 'write')
    assert.equal(body.task.admission?.source, 'model_choice')
    assert.equal(body.task.admission?.executionKind, 'continuation')

    // Exactly one continuation, and it is a continuation rather than a
    // recovery: the user decided this, so it must not spend the run's
    // recovery budget.
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(task?.admission?.source, 'model_choice')
    assert.equal(task?.admission?.executionKind, 'continuation')
    assert.equal(task?.recoveryCount, 0)
    const admissionRequestId = task?.admission?.requestId

    // The authorization is untouched: the same offer, the same pair the user
    // saw, not the default that has since replaced it.
    const after = await store.requireSnapshot()
    const step = after.state.steps.find((candidate) => candidate.stepId === 'write')
    assert.deepEqual(step?.approvedModelChoice, authorization)
    assert.deepEqual(step?.approvedModelChoice?.proposedDefault, PROPOSED_DEFAULT)
    assert.equal(step?.modelChoice, undefined)

    // Committed work is untouched.
    const predecessor = after.state.steps.find(
      (candidate) => candidate.stepId === 'research',
    )
    assert.equal(predecessor?.status, 'completed')
    assert.equal(predecessor?.costUsd, 0.25)

    // Retransmitting again answers from the same admission rather than making
    // a second one.
    const again = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k2' }),
    })
    assert.equal(again.status, 202, await again.clone().text())
    const settled = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(settled?.admission?.requestId, admissionRequestId)
    assert.equal(settled?.recoveryCount, 0)
  }, { withPredecessor: true })
})

test('a replay of an approval already admitted is answered from that admission', async () => {
  // The double click, the second tab, the resent request. The continuation
  // exists; the answer is which attempt it is, not a second one, and never that
  // the decision disappeared after it was accepted.
  await withServer(async ({ url, fixture }) => {
    const base = `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
    await store.approveModelChoice({
      expectedRevision: fixture.approvedFromRevision,
      offerId: OFFER_ID,
    })

    const first = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
    })
    assert.equal(first.status, 202, await first.clone().text())
    const admitted = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(admitted?.admission?.source, 'model_choice')
    const requestId = admitted?.admission?.requestId

    const replayed = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k2' }),
    })
    assert.equal(replayed.status, 202, await replayed.clone().text())
    const settled = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(settled?.admission?.requestId, requestId, 'a second admission appeared')
    assert.equal(settled?.recoveryCount, 0)
  }, { withPredecessor: true })
})

/**
 * Drives one approval all the way to a settled continuation, the way production
 * does.
 *
 * The receipt is written by `claimModelChoiceContinuation` and by nothing else,
 * and that transition moves the workflow to a new continuation execution
 * attempt. So the task has to end up on that same new attempt, terminal, with
 * its admission cleared. Writing the receipt by hand and leaving ownership
 * behind would build a state production cannot produce.
 *
 * The negative cases deliberately break one link each; the positive one is
 * reachable end to end through the public transitions.
 */
async function settleApprovedContinuation(
  fixture: Awaited<ReturnType<typeof createSuspendedRun>>,
  options: {
    claim?: boolean
    settleStep?: boolean
    terminalWorkflow?: boolean
    terminalTask?: boolean
    /** How the retry ended. `blocked` is terminal too, and was once refused. */
    ending?: 'completed' | 'blocked'
  } = {},
): Promise<void> {
  const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
  const approved = await store.approveModelChoice({
    expectedRevision: fixture.approvedFromRevision,
    offerId: OFFER_ID,
  })

  const continuationAttemptId = randomUUID()
  let owner = approved.ownerExecutionAttemptId
  let revision = approved.revision
  if (options.claim !== false) {
    const claimed = await store.claimModelChoiceContinuation({
      expectedRevision: revision,
      stepId: 'write',
      expectedOwnerExecutionAttemptId: owner,
      nextExecutionAttemptId: continuationAttemptId,
      continuationAdmissionRequestId: randomUUID(),
    })
    owner = claimed.ownerExecutionAttemptId
    revision = claimed.revision
  }

  if (options.settleStep !== false) {
    // Through the legal transitions rather than straight to completed: the
    // claim leaves the step interrupted, and a step is relaunched rather than
    // resumed. The workflow itself stays running — a terminal workflow needs a
    // terminal outcome, which is a different thing from a settled step.
    const advanceTo = async (
      apply: (step: DurableWorkflowStepState) => void,
    ): Promise<void> => {
      const next = await store.update({
        expectedRevision: revision,
        executionAttemptId: owner,
        mutate(draft) {
          const step = draft.steps.find((candidate) => candidate.stepId === 'write')
          if (step) apply(step)
        },
      })
      revision = next.revision
    }
    if (options.claim !== false) {
      await advanceTo((step) => {
        step.status = 'launching'
        step.attemptCount += 1
        step.startedAt = new Date().toISOString()
      })
      await advanceTo((step) => {
        step.status = 'running'
      })
    }
    const ending = options.ending ?? 'completed'
    await advanceTo((step) => {
      step.status = ending
      step.summary = 'Draft.'
      step.completedAt = new Date().toISOString()
      if (ending === 'completed') {
        step.artifact = {
          childRunId: step.childRunId,
          relativePath: 'report.md',
          sha256: hashWorkflowContent('Draft.'),
          byteLength: 6,
        }
      } else {
        step.error = 'The retry could not proceed.'
      }
    })
  }

  if (options.terminalWorkflow !== false) {
    // The workflow's ending is committed before the task's, and through the
    // same helper production uses, so the terminal outcome the store demands is
    // the shape it demands.
    const terminal = await store.update({
      expectedRevision: revision,
      executionAttemptId: owner,
      mutate(draft) {
        const ending = options.ending ?? 'completed'
        draft.status = ending
        draft.terminalOutcome = buildDurableWorkflowTerminalOutcome({
          workflowId: 'model-choice-api-workflow',
          status: ending,
          summary: 'Draft.',
          requestedResultType: 'artifact:report.md',
          outputStepId: 'write',
        })
        delete draft.currentStepId
      },
    })
    revision = terminal.revision
  }

  if (options.terminalTask !== false) {
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    // The task follows the workflow onto the continuation attempt, then ends.
    const settled = await fixture.sessionStore.compareAndSetTaskRecord(
      fixture.sessionId,
      fixture.taskId,
      ['awaiting_model_choice'],
      {
        status: options.ending === 'blocked' ? 'blocked' : 'done',
        admission: undefined,
        executionAttemptId: owner,
      },
      { expectedExecutionAttemptId: task?.executionAttemptId ?? null },
    )
    assert.equal(settled?.updated, true)
  }
}

test('a replay after the continuation has been consumed is still answered', async () => {
  // The approval was acted on, ran, and the task has finished. Retransmitting
  // then must not tell a person their decision was lost, and must not start the
  // authorized attempt a second time.
  await withServer(async ({ url, fixture }) => {
    await settleApprovedContinuation(fixture)

    const replayed = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
      },
    )
    assert.equal(replayed.status, 202, await replayed.clone().text())

    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(task?.admission, undefined, 'a spent approval was admitted again')
    assert.equal(task?.status, 'done')
    assert.equal(task?.recoveryCount, 0)
  }, { withPredecessor: true })
})

test('a replay after the retry ended blocked is answered like any other ending', async () => {
  // `blocked` is terminal for a step, a workflow and a task, exactly as
  // `completed` is. A retry that ended that way is just as finished, and a
  // replay of it must be answered rather than refused.
  await withServer(async ({ url, fixture }) => {
    await settleApprovedContinuation(fixture, { ending: 'blocked' })

    const replayed = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
      },
    )
    assert.equal(replayed.status, 202, await replayed.clone().text())

    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(task?.status, 'blocked')
    assert.equal(task?.admission, undefined, 'a spent approval was admitted again')
  }, { withPredecessor: true })
})

for (const partial of [
  {
    name: 'the continuation was claimed but nothing settled',
    options: { settleStep: false, terminalTask: false },
  },
  {
    name: 'the step settled without the continuation ever being claimed',
    options: { claim: false },
  },
  {
    name: 'the continuation ran but the task never finished',
    options: { terminalTask: false },
  },
  {
    name: 'the task finished while the workflow is still running',
    options: { terminalWorkflow: false },
  },
]) {
  test(`a half-recorded continuation is a conflict when ${partial.name}`, async () => {
    // Each of these is a broken chain rather than a completed one. Reporting
    // success over any of them would tell a person their retry finished when
    // the durable record cannot say that.
    await withServer(async ({ url, fixture }) => {
      await settleApprovedContinuation(fixture, partial.options)

      const response = await fetch(
        `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
        },
      )
      assert.notEqual(
        response.status,
        202,
        `a half-recorded continuation reported success: ${await response.clone().text()}`,
      )
      assert.equal(response.status, 409, await response.clone().text())

      const task = await fixture.sessionStore.getTaskRecord(
        fixture.sessionId,
        fixture.taskId,
      )
      assert.equal(task?.admission, undefined, 'a broken chain was admitted')
    }, { withPredecessor: true })
  })
}

/**
 * Writes one admission onto the task, in an exact phase and linkage.
 *
 * Written rather than raced for: the phases this has to distinguish are
 * produced by the queue at moments a test cannot schedule, and the rule under
 * test is about the record, not about how it came to exist.
 */
async function writeAdmission(
  fixture: Awaited<ReturnType<typeof createSuspendedRun>>,
  admission: AdmissionShape,
  taskExecutionAttemptId: string,
): Promise<TaskAdmission> {
  const current = await fixture.sessionStore.getTaskRecord(
    fixture.sessionId,
    fixture.taskId,
  )
  const base = {
    version: 1 as const,
    requestId: admission.requestId ?? randomUUID(),
    order: '1',
    requestedAt: new Date().toISOString(),
    executionKind: 'continuation' as const,
    source: admission.source ?? ('model_choice' as const),
    expectedExecutionAttemptId: admission.expectedExecutionAttemptId,
  }
  const grantedAt = new Date().toISOString()
  const record: TaskAdmission =
    admission.phase === 'granted'
      ? {
          ...base,
          phase: 'granted',
          grantId: randomUUID(),
          ownerEpoch: randomUUID(),
          grantedAt,
          executionAttemptId: admission.executionAttemptId ?? randomUUID(),
        }
      : admission.phase === 'pending'
        ? { ...base, phase: 'pending' }
        : { ...base, phase: 'staged' }

  // Granting is not just a phase change. `TaskQueue` moves the task to
  // `queued` on the new attempt, as its process identity, counts the attempt
  // and starts it at the moment of the grant — so a granted record written
  // without those describes a task the queue never produces.
  const grantedTaskFields =
    record.phase === 'granted'
      ? {
          status: 'queued' as const,
          processIdentity: record.executionAttemptId,
          executionAttemptId: record.executionAttemptId,
          executionAttemptNumber: (current?.executionAttemptNumber ?? 0) + 1,
          executionKind: 'continuation' as const,
          attemptStartedAt: record.grantedAt,
        }
      : { executionAttemptId: taskExecutionAttemptId }

  const updated = await fixture.sessionStore.compareAndSetTaskRecord(
    fixture.sessionId,
    fixture.taskId,
    ['awaiting_model_choice'],
    { ...grantedTaskFields, admission: record },
    { expectedExecutionAttemptId: current?.executionAttemptId ?? null },
  )
  assert.equal(updated?.updated, true)
  return record
}

interface AdmissionShape {
  phase: 'staged' | 'pending' | 'granted'
  expectedExecutionAttemptId: string
  executionAttemptId?: string
  requestId?: string
  source?: 'model_choice' | 'automatic_recovery'
}

interface LinkageCase {
  name: string
  expect: number
  build: (owner: string) => { admission: AdmissionShape; taskAttempt: string }
}

const LINKAGE_CASES: LinkageCase[] = [
  {
    name: 'a pending admission raised against the workflow owner',
    expect: 202,
    build: (owner: string) => ({
      admission: { phase: 'pending', expectedExecutionAttemptId: owner },
      taskAttempt: owner,
    }),
  },
  {
    name: 'a granted admission still waiting for the workflow claim',
    expect: 202,
    build: (owner: string) => {
      const grantedAttempt = randomUUID()
      return {
        admission: {
          phase: 'granted',
          expectedExecutionAttemptId: owner,
          executionAttemptId: grantedAttempt,
        },
        taskAttempt: grantedAttempt,
      }
    },
  },
  // Deliberately impossible records. The queue never leaves a task in either
  // shape; they exist to show the route fails closed rather than trusting a
  // matching owner.
  {
    name: 'a staged admission that has not been raised yet',
    expect: 409,
    build: (owner: string) => ({
      admission: { phase: 'staged', expectedExecutionAttemptId: owner },
      taskAttempt: owner,
    }),
  },
  {
    name: 'a pending admission whose task moved to another execution',
    expect: 409,
    build: (owner: string) => ({
      admission: { phase: 'pending', expectedExecutionAttemptId: owner },
      taskAttempt: randomUUID(),
    }),
  },
]

for (const linkage of LINKAGE_CASES) {
  test(`an approval is answered from ${linkage.name} only when it links`, async () => {
    // Matching the workflow owner is not on its own enough to say an admission
    // belongs to this approval. The phase has to be one the queue actually
    // raised, and the task has to be on the attempt that admission names.
    await withServer(async ({ url, fixture }) => {
      const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
      const approved = await store.approveModelChoice({
        expectedRevision: fixture.approvedFromRevision,
        offerId: OFFER_ID,
      })
      const shape = linkage.build(approved.ownerExecutionAttemptId)
      await writeAdmission(fixture, shape.admission, shape.taskAttempt)
      const before = await fixture.sessionStore.getTaskRecord(
        fixture.sessionId,
        fixture.taskId,
      )

      const response = await fetch(
        `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
        },
      )
      assert.equal(response.status, linkage.expect, await response.clone().text())

      // Whichever way it went, no second admission was raised.
      const after = await fixture.sessionStore.getTaskRecord(
        fixture.sessionId,
        fixture.taskId,
      )
      assert.equal(after?.admission?.requestId, before?.admission?.requestId)
    }, { withPredecessor: true })
  })
}

test('an approval is answered from a granted admission the claim already used', async () => {
  // The after-claim shape, built through the real claim: the step's receipt is
  // this admission's request id, the workflow has moved to the granted attempt,
  // and the task carries it. Every link agrees, so the replay is answered.
  await withServer(async ({ url, fixture }) => {
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
    const approved = await store.approveModelChoice({
      expectedRevision: fixture.approvedFromRevision,
      offerId: OFFER_ID,
    })
    const preClaimOwner = approved.ownerExecutionAttemptId
    // Production order: the queue grants first, and the worker then claims the
    // continuation under the identifiers that grant published.
    const granted = await writeAdmission(
      fixture,
      { phase: 'granted', expectedExecutionAttemptId: preClaimOwner },
      preClaimOwner,
    )
    // Narrows as well as asserts, so a record that came back in another phase
    // fails the test rather than skipping the claim and everything after it.
    assert.ok(granted.phase === 'granted', `granted admission was ${granted.phase}`)
    await store.claimModelChoiceContinuation({
      expectedRevision: approved.revision,
      stepId: 'write',
      expectedOwnerExecutionAttemptId: preClaimOwner,
      nextExecutionAttemptId: granted.executionAttemptId,
      continuationAdmissionRequestId: granted.requestId,
    })

    const response = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
      },
    )
    assert.equal(response.status, 202, await response.clone().text())
  }, { withPredecessor: true })
})

test('an approval is refused when a claim happened under a different admission', async () => {
  // The owner still matches what this admission was raised against, so the
  // pre-claim shape would accept it — but the step's receipt names a different
  // admission, which means the continuation was claimed under something else.
  // Accepting here would tie this approval to an attempt it never authorized.
  await withServer(async ({ url, fixture }) => {
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
    const approved = await store.approveModelChoice({
      expectedRevision: fixture.approvedFromRevision,
      offerId: OFFER_ID,
    })
    const claimedAttempt = randomUUID()
    await store.claimModelChoiceContinuation({
      expectedRevision: approved.revision,
      stepId: 'write',
      expectedOwnerExecutionAttemptId: approved.ownerExecutionAttemptId,
      nextExecutionAttemptId: claimedAttempt,
      continuationAdmissionRequestId: randomUUID(),
    })
    // Raised against the post-claim owner, so the owner comparison passes, but
    // it is not the admission the receipt names.
    await writeAdmission(
      fixture,
      { phase: 'pending', expectedExecutionAttemptId: claimedAttempt },
      claimedAttempt,
    )
    const before = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )

    const response = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
      },
    )
    assert.equal(response.status, 409, await response.clone().text())

    const after = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(after?.admission?.requestId, before?.admission?.requestId)
  }, { withPredecessor: true })
})

test('an approval whose workflow belongs to another execution is refused', async () => {
  // Ownership is what keeps one run from continuing another's approval. A
  // workflow whose owner is not this task's execution attempt is a conflict,
  // not something to recover from.
  await withServer(async ({ url, fixture }) => {
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
    await store.approveModelChoice({
      expectedRevision: fixture.approvedFromRevision,
      offerId: OFFER_ID,
    })
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.ok(task?.executionAttemptId)
    // The task moves to a different execution attempt than the one the
    // workflow records as its owner.
    const moved = await fixture.sessionStore.compareAndSetTaskRecord(
      fixture.sessionId,
      fixture.taskId,
      ['awaiting_model_choice'],
      { executionAttemptId: randomUUID() },
      { expectedExecutionAttemptId: task.executionAttemptId },
    )
    assert.equal(moved?.updated, true)

    const response = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
      },
    )
    assert.equal(response.status, 409, await response.clone().text())
    assert.equal(
      (await response.json() as { code?: string }).code,
      'already-accepted',
    )

    const after = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(after?.admission, undefined, 'a mismatched owner was admitted')
  }, { withPredecessor: true })
})

test('an approval whose task already holds a different claim is refused', async () => {
  // A recovery admission is not this approval's continuation. The classifier
  // refuses before the queue is asked, so this never reaches the queue's own
  // error: it proves the claim check, not the `TaskQueueError` response.
  await withServer(async ({ url, fixture }) => {
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
    await store.approveModelChoice({
      expectedRevision: fixture.approvedFromRevision,
      offerId: OFFER_ID,
    })
    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    // A claim the queue will not treat as this approval's continuation.
    const claimed = await fixture.sessionStore.compareAndSetTaskRecord(
      fixture.sessionId,
      fixture.taskId,
      ['awaiting_model_choice'],
      {
        admission: {
          version: 1,
          requestId: randomUUID(),
          order: '9',
          requestedAt: new Date().toISOString(),
          executionKind: 'recovery',
          source: 'automatic_recovery',
          expectedExecutionAttemptId: task?.executionAttemptId ?? '',
          phase: 'pending',
        },
      },
      { expectedExecutionAttemptId: task?.executionAttemptId ?? null },
    )
    assert.equal(claimed?.updated, true)

    const response = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: OFFER_ID, idempotencyKey: 'k1' }),
      },
    )
    assert.equal(response.status, 409, await response.clone().text())
    const body = await response.json() as { error?: string }
    assert.match(String(body.error), /admission/i)
  }, { withPredecessor: true })
})

test('an approval that names a different offer recovers nothing', async () => {
  // Recovery is scoped to the exact offer that was approved. A request naming
  // anything else must not inherit somebody else's authorization, and it is
  // refused as the wrong offer rather than as nothing to decide: an offer this
  // run never had is a different answer from a run that is waiting on none.
  await withServer(async ({ url, fixture }) => {
    const store = new FileSystemWorkflowStateStore(fixture.assignmentPath)
    await store.approveModelChoice({
      expectedRevision: fixture.approvedFromRevision,
      offerId: OFFER_ID,
    })
    const before = await store.requireSnapshot()

    const response = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offerId: 'some-other-offer', idempotencyKey: 'k1' }),
      },
    )
    assert.equal(response.status, 409, await response.clone().text())
    assert.equal(
      (await response.json() as { code?: string }).code,
      'offer-not-found',
    )

    const task = await fixture.sessionStore.getTaskRecord(
      fixture.sessionId,
      fixture.taskId,
    )
    assert.equal(task?.admission, undefined, 'no continuation was admitted')

    const after = await store.requireSnapshot()
    const step = after.state.steps.find((candidate) => candidate.stepId === 'write')
    assert.deepEqual(
      step?.approvedModelChoice,
      before.state.steps.find((candidate) => candidate.stepId === 'write')
        ?.approvedModelChoice,
      'a refused request rewrote the authorization',
    )
  }, { withPredecessor: true })
})

test('an active run is read through its journal, not a projection that may be gone', async () => {
  // Characterization of an invariant this phase deliberately leaves alone. The
  // terminal replay reads the flushed projection because its journal is closed;
  // an active run must not, because the projection is derived and can be
  // missing, stale or behind. Deleting it is the cheapest way to show the
  // difference: the journal-backed store rebuilds the offer, and a route that
  // always read the projection could not.
  await withServer(async ({ url, fixture }) => {
    const projection = path.join(
      fixture.assignmentPath,
      '.runtime',
      'workflow-state.json',
    )
    assert.ok(fs.existsSync(projection), 'the fixture wrote a projection to remove')
    fs.rmSync(projection)

    // Set after boot, like the other reads here: the composition hydrates the
    // runtime default from provider settings while it starts, and reading an
    // offer resolves it against that default.
    setRuntimeDefaultModelState({ status: 'available', ...PROPOSED_DEFAULT })

    const response = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
    )
    assert.equal(response.status, 200, await response.clone().text())
    const read = await response.json() as {
      readonly stepId: string
      readonly offer: { readonly offerId: string; readonly proposedDefault: unknown }
    }
    assert.equal(read.stepId, 'write')
    assert.equal(read.offer.offerId, OFFER_ID)
    assert.deepEqual(read.offer.proposedDefault, PROPOSED_DEFAULT)
  }, { withPredecessor: true, journal: true })
})

test('a restart between saving the wait and recording it restores the wait, not a worker', async () => {
  // The crash window: the runner has committed `awaiting_model_choice` to the
  // durable workflow, and the process stopped before the task row followed.
  // The task still says `running`, so ordinary recovery would treat it as
  // interrupted work and re-admit a worker — restarting the very step the run
  // is waiting to be told how to run.
  await withServer(async ({ url, fixture }) => {
    await expectEventually(async () => {
      const task = await fixture.sessionStore.getTaskRecord(
        fixture.sessionId,
        fixture.taskId,
      )
      assert.equal(task?.status, 'awaiting_model_choice')
      assert.equal(task?.admission, undefined, 'no worker was admitted')
    })

    // And the wait is still answerable.
    setRuntimeDefaultModelState({ status: 'available', ...PROPOSED_DEFAULT })
    const pending = await fetch(
      `${url}/sessions/${fixture.sessionId}/tasks/${fixture.taskId}/model-choice`,
    )
    assert.equal(pending.status, 200, await pending.clone().text())
  }, { taskStatus: 'running' })
})

/** Recovery runs on its own schedule, so this polls rather than assuming. */
async function expectEventually(
  check: () => Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await check()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}
