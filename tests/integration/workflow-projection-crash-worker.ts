import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
  type InitializeWorkflowExecutionInput,
} from '../../workflows/workflow-state-store.js'
import type { DurableWorkflowState } from '../../workflows/types.js'
import {
  createJournalBackedWorkflowRecorder,
  type WorkflowBaselineSourceHashes,
  type WorkflowJournalIdentity,
  type WorkflowJournalRecordedState,
  type WorkflowJournalRecorder,
} from '../../workflows/workflow-journal.js'

const CREATED_AT = '2026-08-22T12:00:00.000Z'
const UPDATED_AT = '2026-08-22T12:00:01.000Z'
const EFFECT_TIMEOUT_MS = 10_000

// The crash phase deliberately never reaches its `finally`. Keep its journal
// strongly reachable until SIGKILL so Node cannot garbage-collect the open
// FileHandle and terminate the child before the parent observes the seam.
const crashPhaseJournalHold = new Set<
  Awaited<ReturnType<typeof initializeExecutionJournal>>
>()

type Phase = 'crash' | 'resume'

/**
 * One half of the AC13 crash-and-restart journey, run as a real process.
 *
 * The workflow has two steps. `crash` completes `research`, including its
 * external effect, and then stops dead between the canonical append of that
 * completion and the projection write, while `publish` is still pending.
 * `resume` is a second process over the same assignment: it must rebuild the
 * projection from the journal, must not repeat `research`, and must run
 * `publish` exactly once.
 *
 * The seam is reached without a production failpoint. The store's contract is
 * "append, then write the projection" (`publishWorkflowState`), so a recorder
 * that delegates the real append and then never returns leaves the process
 * exactly between the two, with no test hook in shipped code.
 */
async function main(): Promise<void> {
  const [phaseArgument, assignmentRoot, counterUrl, markerPath, outcomePath] =
    process.argv.slice(2)
  if (!assignmentRoot || !counterUrl || !markerPath || !outcomePath) {
    throw new Error(
      'Usage: worker <crash|resume> <assignmentRoot> <counterUrl> <markerPath> <outcomePath>',
    )
  }
  const phase = parsePhase(phaseArgument)

  fs.mkdirSync(assignmentRoot, { recursive: true })
  const journal = await initializeExecutionJournal({
    scopeRoot: assignmentRoot,
    identity: journalIdentity(),
  })
  if (phase === 'crash') crashPhaseJournalHold.add(journal)

  try {
    if (phase === 'crash') {
      await runCrashPhase(journal, assignmentRoot, counterUrl, markerPath)
      return
    }
    await runResumePhase(journal, assignmentRoot, counterUrl, outcomePath)
  } finally {
    crashPhaseJournalHold.delete(journal)
    await journal.close()
  }
}

function parsePhase(value: string | undefined): Phase {
  if (value === 'crash' || value === 'resume') return value
  throw new Error(`Unknown phase: ${String(value)}. Expected "crash" or "resume".`)
}

async function runCrashPhase(
  journal: Awaited<ReturnType<typeof initializeExecutionJournal>>,
  assignmentRoot: string,
  counterUrl: string,
  markerPath: string,
): Promise<void> {
  const real = createJournalBackedWorkflowRecorder(journal)
  const store = new FileSystemWorkflowStateStore(assignmentRoot, {
    now: () => new Date(UPDATED_AT),
    // Distinct per call: the store allocates one child run ID per step and
    // rejects duplicates, so a fixed value collides across the two steps.
    randomUUID: deterministicChildRunIds(),
    journal: stopWhenResearchCompletes(real, markerPath),
  })

  const initialized = await store.initialize(initializationInput())
  const launching = await store.update({
    expectedRevision: initialized.state.revision,
    executionAttemptId: initialized.state.ownerExecutionAttemptId,
    mutate: (draft) => {
      const step = researchStep(draft)
      step.status = 'launching'
      step.attemptCount += 1
      step.startedAt = UPDATED_AT
      draft.currentStepId = step.stepId
    },
  })

  const running = await store.update({
    expectedRevision: launching.revision,
    executionAttemptId: launching.ownerExecutionAttemptId,
    mutate: (draft) => {
      researchStep(draft).status = 'running'
    },
  })

  // The research step's external effect, completed and acknowledged before
  // anything crashes. Recovery must never run this a second time.
  await mutateCounter(counterUrl, 'research')

  // Appends the completed transition for research, then never returns. The
  // publish step is still pending at this point, which is what makes the
  // remaining work observable after the restart.
  await store.update({
    expectedRevision: running.revision,
    executionAttemptId: running.ownerExecutionAttemptId,
    mutate: (draft) => {
      const step = researchStep(draft)
      step.status = 'completed'
      step.completedAt = UPDATED_AT
      step.artifact = {
        childRunId: requireChildRunId(step),
        relativePath: 'report.md',
        sha256: hashWorkflowContent('report contents'),
        byteLength: 16,
      }
    },
  })

  throw new Error('the crash phase returned, so the seam was never reached')
}

async function runResumePhase(
  journal: Awaited<ReturnType<typeof initializeExecutionJournal>>,
  assignmentRoot: string,
  counterUrl: string,
  outcomePath: string,
): Promise<void> {
  const recorder = createJournalBackedWorkflowRecorder(journal)
  const store = new FileSystemWorkflowStateStore(assignmentRoot, {
    now: () => new Date(UPDATED_AT),
    randomUUID: deterministicChildRunIds(),
    journal: recorder,
  })

  // AC9's rebuild runs inside load(): the projection is behind the journal, so
  // the journal answers. Nothing here asks for a rebuild explicitly.
  const recovered = await store.requireSnapshot()
  const research = researchStep(recovered.state)
  const publish = publishStep(recovered.state)

  const researchAlreadyCompleted = research.status === 'completed'
  if (!researchAlreadyCompleted) {
    // Would be the duplicate: this effect already ran before the crash.
    await mutateCounter(counterUrl, 'research')
  }

  // The remaining work, which no process has done yet.
  await mutateCounter(counterUrl, 'publish')

  const publishLaunching = await store.update({
    expectedRevision: recovered.state.revision,
    executionAttemptId: recovered.state.ownerExecutionAttemptId,
    mutate: (draft) => {
      const step = publishStep(draft)
      step.status = 'launching'
      step.attemptCount += 1
      step.startedAt = UPDATED_AT
      draft.currentStepId = step.stepId
    },
  })

  const publishRunning = await store.update({
    expectedRevision: publishLaunching.revision,
    executionAttemptId: publishLaunching.ownerExecutionAttemptId,
    mutate: (draft) => {
      publishStep(draft).status = 'running'
    },
  })

  const finished = await store.update({
    expectedRevision: publishRunning.revision,
    executionAttemptId: publishRunning.ownerExecutionAttemptId,
    mutate: (draft) => {
      const step = publishStep(draft)
      step.status = 'completed'
      step.completedAt = UPDATED_AT
      step.artifact = {
        childRunId: requireChildRunId(step),
        relativePath: 'published.md',
        sha256: hashWorkflowContent('published contents'),
        byteLength: 19,
      }
      draft.status = 'completed'
      const wrapperBody = '# Report\n\nFindings.\n'
      draft.terminalOutcome = {
        status: 'completed',
        summary: 'Research published.',
        requestedResultType: 'artifact:published.md',
        outputStepId: 'publish',
        rootWrapperBody: wrapperBody,
        rootWrapperSha256: hashWorkflowContent(wrapperBody),
      }
    },
  })

  fs.writeFileSync(
    outcomePath,
    `${JSON.stringify({
      recoveredRevision: recovered.state.revision,
      recoveredResearchStatus: research.status,
      recoveredPublishStatus: publish.status,
      repeatedCompletedEffect: !researchAlreadyCompleted,
      finalRevision: finished.revision,
      finalStatus: finished.status,
    })}\n`,
    { mode: 0o600 },
  )
}

/**
 * Delegates every call to the real recorder, and after the append that leaves
 * `research` completed while `publish` is still pending it publishes an fsynced
 * marker and blocks forever.
 *
 * The marker is written only once the real append has resolved, so the parent
 * that observes it knows the canonical event is durable and the projection
 * write has not begun.
 */
function stopWhenResearchCompletes(
  real: WorkflowJournalRecorder,
  markerPath: string,
): WorkflowJournalRecorder {
  return {
    async recordSnapshot(state: DurableWorkflowState): Promise<void> {
      await real.recordSnapshot(state)
      const researchDone = researchStep(state).status === 'completed'
      const publishPending = publishStep(state).status === 'pending'
      if (!researchDone || !publishPending) return
      publishMarker(markerPath, state.revision)
      // Block on a stdin the parent holds open and never writes to. An
      // unresolved promise alone is not enough: Node exits once the event loop
      // drains, which would end the process cleanly instead of leaving it to be
      // killed. A resumed stdin is a referenced handle, so the loop stays alive
      // with no timer and nothing to poll, and the parent's SIGKILL is what
      // ends it — leaving the projection write below this frame unreached.
      process.stdin.resume()
      await new Promise<never>(() => {})
    },
    recordBaseline(
      state: DurableWorkflowState,
      sourceHashes: WorkflowBaselineSourceHashes,
    ): Promise<void> {
      return real.recordBaseline(state, sourceHashes)
    },
    readRecordedState(
      identity: WorkflowJournalIdentity,
    ): Promise<WorkflowJournalRecordedState | null> {
      return real.readRecordedState(identity)
    },
    hasRecordedState(): Promise<boolean> {
      return real.hasRecordedState()
    },
    recordProjectionApplied(lastAppliedSequence: number): Promise<void> {
      return real.recordProjectionApplied(lastAppliedSequence)
    },
  }
}

/**
 * Distinct per call, because the store allocates one child run ID per step at
 * `initialize` and rejects a workflow whose steps share one.
 *
 * Only the crash phase reaches this: allocation happens inside `initialize`,
 * which the resume phase never calls. The resumed store takes the IDs the
 * rebuilt state already carries, so this generator has no bearing on recovery
 * and is deterministic only to keep the crash phase reproducible.
 */
function deterministicChildRunIds(): () => string {
  let issued = 0
  return () => {
    issued += 1
    return `child-run-${issued}`
  }
}

function researchStep(state: DurableWorkflowState): DurableWorkflowState['steps'][number] {
  return requireStep(state, 'research')
}

function publishStep(state: DurableWorkflowState): DurableWorkflowState['steps'][number] {
  return requireStep(state, 'publish')
}

/** The child run ID the store allocated for this step at initialize. */
function requireChildRunId(step: DurableWorkflowState['steps'][number]): string {
  const childRunId = step.childRunId
  if (!childRunId) throw new Error(`${step.stepId} has no allocated child run ID`)
  return childRunId
}

function requireStep(
  state: DurableWorkflowState,
  stepId: string,
): DurableWorkflowState['steps'][number] {
  const step = state.steps.find((candidate) => candidate.stepId === stepId)
  if (!step) throw new Error(`workflow state has no ${stepId} step`)
  return step
}

/** Atomic publication with the bytes synced before the name appears. */
function publishMarker(markerPath: string, revision: number): void {
  const temporaryPath = `${markerPath}.partial`
  const handle = fs.openSync(temporaryPath, 'wx', 0o600)
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ revision })}\n`)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(temporaryPath, markerPath)
  const directory = fs.openSync(path.dirname(markerPath), 'r')
  try {
    fs.fsyncSync(directory)
  } finally {
    fs.closeSync(directory)
  }
}

async function mutateCounter(counterUrl: string, effect: string): Promise<void> {
  const response = await fetch(`${counterUrl}/mutate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ effect }),
    // A hung ledger must fail the worker rather than stall the journey.
    signal: AbortSignal.timeout(EFFECT_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`counter rejected ${effect}: ${response.status}`)
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
        publishers: hashWorkflowContent('publishers:v1'),
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
      {
        stepId: 'publish',
        stepIndex: 1,
        stepType: 'team',
        team: 'publishers',
        definitionHash: hashWorkflowContent('publish-step:v1'),
        recoveryPolicy: 'safe_retry',
        inputArtifact: 'report.md',
        resultArtifact: 'published.md',
        requestedResultType: 'artifact:published.md',
      },
    ],
  }
}

await main()
