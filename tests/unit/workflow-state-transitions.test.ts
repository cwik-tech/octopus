import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import type {
  DurableWorkflowState,
  DurableWorkflowStatus,
  DurableWorkflowStepState,
  DurableWorkflowStepStatus,
  DurableWorkflowTerminalOutcome,
} from '../../workflows/types.js'
import {
  createJournalBackedWorkflowRecorder,
  WORKFLOW_STATE_STREAM_KIND,
  workflowJournalStreamId,
} from '../../workflows/workflow-journal.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
  WorkflowStateStoreError,
  type InitializeWorkflowExecutionInput,
  type WorkflowStateStoreOptions,
} from '../../workflows/workflow-state-store.js'

// The status and edit rules update() enforces today, pinned through the public
// store against real files before they move out of workflow-state-store.ts.
// Every refusal is matched on its exact message: a candidate refused for some
// other reason would hide a rule that had gone missing.

const CREATED_AT = '2026-07-13T12:00:00.000Z'
const UPDATED_AT = '2026-07-13T12:00:01.000Z'
const COMPLETED_AT = '2026-07-13T12:00:02.000Z'
const OWNER = 'attempt-one'

type Settled = 'completed' | 'completed_with_warnings' | 'blocked' | 'failed' | 'cancelled'

function isSettled(
  status: DurableWorkflowStatus | DurableWorkflowStepStatus,
): status is Settled {
  return status === 'completed' ||
    status === 'completed_with_warnings' ||
    status === 'blocked' ||
    status === 'failed' ||
    status === 'cancelled'
}

const WORKFLOW_STATUSES: readonly DurableWorkflowStatus[] = [
  'running',
  'awaiting_input',
  'awaiting_model_choice',
  'interrupted',
  'completed',
  'completed_with_warnings',
  'blocked',
  'failed',
  'cancelled',
]

const STEP_STATUSES: readonly DurableWorkflowStepStatus[] = [
  'pending',
  'awaiting_input',
  'awaiting_model_choice',
  'launching',
  'running',
  'interrupted',
  'indeterminate',
  'completed',
  'completed_with_warnings',
  'blocked',
  'failed',
  'cancelled',
]

// The moves an active workflow may make. Anything not listed is refused, and
// a settled workflow refuses every update.
const WORKFLOW_MOVES: Record<
  Exclude<DurableWorkflowStatus, Settled>,
  readonly DurableWorkflowStatus[]
> = {
  running: [
    'running',
    'awaiting_input',
    'awaiting_model_choice',
    'interrupted',
    'completed',
    'completed_with_warnings',
    'blocked',
    'failed',
    'cancelled',
  ],
  awaiting_input: ['awaiting_input', 'running', 'cancelled'],
  awaiting_model_choice: ['awaiting_model_choice', 'running', 'failed', 'cancelled'],
  interrupted: [
    'interrupted',
    'running',
    'completed',
    'completed_with_warnings',
    'blocked',
    'failed',
    'cancelled',
  ],
}

// The moves an active step may make. Anything not listed is refused, and a
// settled step refuses every edit.
const STEP_MOVES: Record<
  Exclude<DurableWorkflowStepStatus, Settled>,
  readonly DurableWorkflowStepStatus[]
> = {
  pending: ['pending', 'awaiting_input', 'launching', 'blocked', 'failed', 'cancelled'],
  awaiting_input: [
    'awaiting_input',
    'running',
    'completed',
    'completed_with_warnings',
    'blocked',
    'failed',
    'cancelled',
  ],
  awaiting_model_choice: ['awaiting_model_choice', 'running', 'failed', 'cancelled'],
  launching: [
    'launching',
    'running',
    'interrupted',
    'indeterminate',
    'blocked',
    'failed',
    'cancelled',
  ],
  running: [
    'running',
    'awaiting_input',
    'awaiting_model_choice',
    'interrupted',
    'indeterminate',
    'completed',
    'completed_with_warnings',
    'blocked',
    'failed',
    'cancelled',
  ],
  interrupted: [
    'interrupted',
    'launching',
    'running',
    'indeterminate',
    'blocked',
    'failed',
    'cancelled',
  ],
  indeterminate: ['indeterminate', 'launching', 'blocked', 'failed', 'cancelled'],
}

// How a fresh step reaches each starting status, one accepted update per hop.
const STEP_ROUTES: Record<DurableWorkflowStepStatus, readonly DurableWorkflowStepStatus[]> = {
  pending: [],
  awaiting_input: ['awaiting_input'],
  awaiting_model_choice: ['launching', 'running', 'awaiting_model_choice'],
  launching: ['launching'],
  running: ['launching', 'running'],
  interrupted: ['launching', 'interrupted'],
  indeterminate: ['launching', 'indeterminate'],
  completed: ['launching', 'running', 'completed'],
  completed_with_warnings: ['launching', 'running', 'completed_with_warnings'],
  blocked: ['launching', 'running', 'blocked'],
  failed: ['launching', 'running', 'failed'],
  cancelled: ['launching', 'running', 'cancelled'],
}

const WAITING_OFFER = {
  offerId: 'offer-1',
  scope: { kind: 'task' as const, sessionId: 'product-session', taskId: 'task-one' },
  agentName: 'reviewer',
  expectedRevision: 'running|||0',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
  reason: 'missing-credential' as const,
}

const MATCHING_APPROVAL = {
  offerId: 'offer-1',
  agentName: 'reviewer',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
}

const RESEARCH_ARTIFACT = {
  childRunId: 'research-run',
  relativePath: 'research.md',
  sha256: hashWorkflowContent('research findings'),
  byteLength: Buffer.byteLength('research findings'),
}

type StepSeed = InitializeWorkflowExecutionInput['steps'][number]

function teamStep(stepId: string, stepIndex: number): StepSeed {
  return {
    stepId,
    stepIndex,
    stepType: 'team',
    team: 'researchers',
    definitionHash: hashWorkflowContent(`${stepId}-step:v1`),
    recoveryPolicy: 'safe_retry',
    childRunId: `${stepId}-run`,
    inputArtifact: 'incoming-brief.md',
    resultArtifact: `${stepId}.md`,
    requestedResultType: `artifact:${stepId}.md`,
  }
}

function humanInputStep(stepId: string, stepIndex: number): StepSeed {
  return {
    stepId,
    stepIndex,
    stepType: 'human-in-the-loop',
    definitionHash: hashWorkflowContent(`${stepId}-step:v1`),
    recoveryPolicy: 'never_retry',
    childRunId: `${stepId}-run`,
    inputArtifact: 'research.md',
    resultArtifact: 'feedback/round-1.json',
    requestedResultType: 'artifact:feedback/round-1.json',
  }
}

function initialization(steps: StepSeed[]): InitializeWorkflowExecutionInput {
  return {
    manifest: {
      taskId: 'task-one',
      sessionId: 'product-session',
      rootRunId: 'root-run',
      workflowId: 'research-workflow',
      workflowDefinitionHash: hashWorkflowContent('workflow:v1'),
      briefHash: hashWorkflowContent('Investigate the market.'),
      teamDefinitionHashes: { researchers: hashWorkflowContent('researchers:v1') },
      runtimeVersion: 'workflow-runtime-v1',
      createdAt: CREATED_AT,
    },
    executionAttemptId: OWNER,
    steps,
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

function assignmentIn(workspace: string): string {
  return path.join(workspace, 'assignments', 'root-run')
}

async function withWorkspace<T>(run: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-state-transitions-'))
  try {
    return await run(workspace)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

async function withAssignment<T>(run: (assignmentPath: string) => Promise<T>): Promise<T> {
  return withWorkspace((workspace) => run(assignmentIn(workspace)))
}

function openStore(
  assignmentPath: string,
  options: WorkflowStateStoreOptions = {},
): FileSystemWorkflowStateStore {
  return new FileSystemWorkflowStateStore(assignmentPath, {
    now: () => new Date(UPDATED_AT),
    ...options,
  })
}

function stepAt(state: DurableWorkflowState, index: number): DurableWorkflowStepState {
  const step = state.steps[index]
  if (!step) throw new Error(`The workflow has no step at position ${index}.`)
  return step
}

function settledOutcome(status: Settled): DurableWorkflowTerminalOutcome {
  const rootWrapperBody = `# Workflow Result\n\n- Status: ${status}\n`
  return {
    status,
    summary: `Workflow ${status}.`,
    requestedResultType: 'artifact:research.md',
    outputStepId: 'research',
    rootWrapperBody,
    rootWrapperSha256: hashWorkflowContent(rootWrapperBody),
  }
}

/** Give a step the status and whatever that status needs to be valid on its own. */
function moveStepTo(step: DurableWorkflowStepState, status: DurableWorkflowStepStatus): void {
  step.status = status
  if (status !== 'pending' && step.attemptCount === 0) step.attemptCount = 1
  if (status === 'awaiting_model_choice' && !step.modelChoice) {
    step.modelChoice = structuredClone(WAITING_OFFER)
  }
  if (status === 'running' && step.modelChoice) {
    delete step.modelChoice
    step.approvedModelChoice = structuredClone(MATCHING_APPROVAL)
  }
  if (status === 'completed' || status === 'completed_with_warnings') {
    step.artifact = { ...RESEARCH_ARTIFACT }
    step.completedAt = COMPLETED_AT
  }
}

/**
 * Give a single-step workflow the status and what that status needs, leaving
 * the step alone unless the workflow status is defined by it.
 */
function moveWorkflowTo(draft: DurableWorkflowState, status: DurableWorkflowStatus): void {
  draft.status = status
  const step = stepAt(draft, 0)
  if (isSettled(status)) draft.terminalOutcome = settledOutcome(status)
  if (status === 'awaiting_input') {
    draft.currentStepId = step.stepId
    moveStepTo(step, 'awaiting_input')
  }
  if (status === 'awaiting_model_choice') moveStepTo(step, 'awaiting_model_choice')
}

async function advance(
  store: FileSystemWorkflowStateStore,
  mutate: (draft: DurableWorkflowState) => void,
): Promise<DurableWorkflowState> {
  const { state } = await store.requireSnapshot()
  return store.update({
    expectedRevision: state.revision,
    executionAttemptId: state.ownerExecutionAttemptId,
    mutate,
  })
}

/** 'accepted', or the store's refusal as `code: message`. */
async function attempt(
  store: FileSystemWorkflowStateStore,
  mutate: (draft: DurableWorkflowState) => void,
): Promise<string> {
  try {
    await advance(store, mutate)
    return 'accepted'
  } catch (error) {
    if (error instanceof WorkflowStateStoreError) return `${error.code}: ${error.message}`
    throw error
  }
}

/**
 * Build one single-step starting state, then try each update on a private copy
 * of its files, so no attempt can see what another one wrote.
 */
async function outcomesFrom(
  reachStart: (store: FileSystemWorkflowStateStore) => Promise<void>,
  attempts: ReadonlyArray<readonly [string, (draft: DurableWorkflowState) => void]>,
): Promise<Record<string, string>> {
  return withWorkspace(async (startWorkspace) => {
    const start = openStore(assignmentIn(startWorkspace))
    await start.initialize(initialization([teamStep('research', 0)]))
    await reachStart(start)
    const outcomes: Record<string, string> = {}
    for (const [label, mutate] of attempts) {
      outcomes[label] = await withWorkspace(async (caseWorkspace) => {
        fs.cpSync(startWorkspace, caseWorkspace, { recursive: true })
        return attempt(openStore(assignmentIn(caseWorkspace)), mutate)
      })
    }
    return outcomes
  })
}

async function reachWorkflowStatus(
  store: FileSystemWorkflowStateStore,
  status: DurableWorkflowStatus,
): Promise<void> {
  if (status === 'awaiting_input') {
    await advance(store, (draft) => moveWorkflowTo(draft, 'awaiting_input'))
    return
  }
  await advance(store, (draft) => moveStepTo(stepAt(draft, 0), 'launching'))
  await advance(store, (draft) => moveStepTo(stepAt(draft, 0), 'running'))
  if (status === 'running') return
  await advance(store, (draft) => {
    if (status === 'interrupted') moveStepTo(stepAt(draft, 0), 'interrupted')
    moveWorkflowTo(draft, status)
  })
}

test('update accepts exactly the workflow status changes the transition rules allow', async () => {
  const expected: Record<string, string> = {}
  const observed: Record<string, string> = {}
  for (const from of WORKFLOW_STATUSES) {
    const outcomes = await outcomesFrom(
      (store) => reachWorkflowStatus(store, from),
      WORKFLOW_STATUSES.map((to) => [to, (draft: DurableWorkflowState) => moveWorkflowTo(draft, to)] as const),
    )
    for (const to of WORKFLOW_STATUSES) {
      const pair = `${from} -> ${to}`
      expected[pair] = isSettled(from)
        ? `invalid_state: Terminal workflow state '${from}' is immutable.`
        : WORKFLOW_MOVES[from].includes(to)
          ? 'accepted'
          : `invalid_state: Illegal workflow transition '${from}' -> '${to}'.`
      observed[pair] = outcomes[to] ?? 'not attempted'
    }
  }

  assert.deepEqual(observed, expected)
})

test('update accepts exactly the step status changes the transition rules allow', async () => {
  const expected: Record<string, string> = {}
  const observed: Record<string, string> = {}
  for (const from of STEP_STATUSES) {
    const outcomes = await outcomesFrom(
      async (store) => {
        for (const hop of STEP_ROUTES[from]) {
          await advance(store, (draft) => moveStepTo(stepAt(draft, 0), hop))
        }
      },
      STEP_STATUSES.map((to) => [to, (draft: DurableWorkflowState) => {
        const step = stepAt(draft, 0)
        moveStepTo(step, to)
        // Always a real edit, so a step that keeps its status is still tested.
        step.summary = `Edited on the way to ${to}.`
      }] as const),
    )
    for (const to of STEP_STATUSES) {
      const pair = `${from} -> ${to}`
      expected[pair] = isSettled(from)
        ? `invalid_state: Terminal workflow step 'research' is immutable.`
        : STEP_MOVES[from].includes(to)
          ? 'accepted'
          : `invalid_state: Illegal transition for workflow step 'research': '${from}' -> '${to}'.`
      observed[pair] = outcomes[to] ?? 'not attempted'
    }
  }

  assert.deepEqual(observed, expected)
})

test('update refuses a step attempt count or cost that goes down', async () => {
  await withAssignment(async (assignmentPath) => {
    const store = openStore(assignmentPath)
    await store.initialize(initialization([teamStep('research', 0), teamStep('synthesize', 1)]))
    await advance(store, (draft) => moveStepTo(stepAt(draft, 0), 'launching'))
    await advance(store, (draft) => {
      const research = stepAt(draft, 0)
      moveStepTo(research, 'running')
      research.attemptCount = 2
      research.costUsd = 0.5
      moveStepTo(stepAt(draft, 1), 'launching')
      draft.totalCostUsd = 0.5
    })
    const persisted = fs.readFileSync(store.paths.statePath)

    const observed = {
      // Still a valid running step at one attempt.
      'fewer attempts': await attempt(store, (draft) => {
        stepAt(draft, 0).attemptCount = 1
      }),
      // The workflow total stays put, so only the step's own cost went down.
      'cost moved to another step': await attempt(store, (draft) => {
        stepAt(draft, 0).costUsd = 0.25
        stepAt(draft, 1).costUsd = 0.25
      }),
      'lower cost and lower total': await attempt(store, (draft) => {
        stepAt(draft, 0).costUsd = 0.25
        draft.totalCostUsd = 0.25
      }),
    }

    assert.deepEqual(observed, {
      'fewer attempts': "invalid_state: Workflow step 'research' attempt count cannot decrease.",
      'cost moved to another step': "invalid_state: Workflow step 'research' cost cannot decrease.",
      'lower cost and lower total': 'invalid_state: Workflow total cost cannot decrease.',
    })
    assert.ok(
      fs.readFileSync(store.paths.statePath).equals(persisted),
      'no refused update reached workflow-state.json',
    )
  })
})

test('update refuses to add or remove a step after initialization', async () => {
  await withAssignment(async (assignmentPath) => {
    const store = openStore(assignmentPath)
    await store.initialize(initialization([teamStep('research', 0), teamStep('synthesize', 1)]))
    const persisted = fs.readFileSync(store.paths.statePath)

    const observed = {
      added: await attempt(store, (draft) => {
        draft.steps.push({
          ...stepAt(draft, 1),
          stepId: 'appendix',
          stepIndex: 2,
          childRunId: 'appendix-run',
          resultArtifact: 'appendix.md',
          requestedResultType: 'artifact:appendix.md',
        })
      }),
      removed: await attempt(store, (draft) => {
        draft.steps.pop()
      }),
    }

    const refusal = 'invalid_state: Workflow steps cannot be added or removed after initialization.'
    assert.deepEqual(observed, { added: refusal, removed: refusal })
    assert.ok(
      fs.readFileSync(store.paths.statePath).equals(persisted),
      'no refused update reached workflow-state.json',
    )
  })
})

test('update refuses to change any identity field of a step', async () => {
  const edits: ReadonlyArray<readonly [string, (step: DurableWorkflowStepState) => void]> = [
    ['stepId', (step) => { step.stepId = 'research-renamed' }],
    ['stepIndex', (step) => { step.stepIndex = 1 }],
    ['stepType', (step) => { step.stepType = 'agent' }],
    ['team', (step) => { step.team = 'reviewers' }],
    ['definitionHash', (step) => { step.definitionHash = hashWorkflowContent('research-step:v2') }],
    ['recoveryPolicy', (step) => { step.recoveryPolicy = 'manual' }],
    ['childRunId', (step) => { step.childRunId = 'replacement-run' }],
    ['inputArtifact', (step) => { step.inputArtifact = 'revised-brief.md' }],
    ['resultArtifact', (step) => { step.resultArtifact = 'revised-research.md' }],
    ['resultArtifacts', (step) => { step.resultArtifacts = ['research.md', 'appendix.md'] }],
    ['resultArtifactGlobs', (step) => { step.resultArtifactGlobs = ['figures/*'] }],
    ['requestedResultType', (step) => { step.requestedResultType = 'chat:messages' }],
    ['idempotencyKey', (step) => { step.idempotencyKey = 'root-run/research' }],
  ]
  await withAssignment(async (assignmentPath) => {
    const store = openStore(assignmentPath)
    await store.initialize(initialization([teamStep('research', 0)]))
    await advance(store, (draft) => moveStepTo(stepAt(draft, 0), 'launching'))
    await advance(store, (draft) => moveStepTo(stepAt(draft, 0), 'running'))
    const persisted = fs.readFileSync(store.paths.statePath)

    const expected: Record<string, string> = {}
    const observed: Record<string, string> = {}
    for (const [field, edit] of edits) {
      expected[field] = `invalid_state: Workflow step 'research' field '${field}' is immutable.`
      observed[field] = await attempt(store, (draft) => edit(stepAt(draft, 0)))
    }

    assert.deepEqual(observed, expected)
    assert.ok(
      fs.readFileSync(store.paths.statePath).equals(persisted),
      'no refused update reached workflow-state.json',
    )
  })
})

test('a settled step cannot be edited while its workflow is still waiting for input', async () => {
  await withAssignment(async (assignmentPath) => {
    const store = openStore(assignmentPath)
    await store.initialize(initialization([
      teamStep('research', 0),
      humanInputStep('human-feedback', 1),
      teamStep('discussion-two', 2),
    ]))
    await advance(store, (draft) => moveStepTo(stepAt(draft, 0), 'launching'))
    await advance(store, (draft) => moveStepTo(stepAt(draft, 0), 'running'))
    await advance(store, (draft) => {
      const research = stepAt(draft, 0)
      moveStepTo(research, 'completed')
      research.summary = 'Research complete.'
      research.costUsd = 0.5
      draft.totalCostUsd = 0.5
    })
    const beforeWait = (await store.requireSnapshot()).state
    const waiting = await store.requestHumanInput({
      expectedRevision: beforeWait.revision,
      executionAttemptId: OWNER,
      stepId: 'human-feedback',
      interactionId: 'workflow_hitl_feedback_one',
      sourceArtifact: { ...RESEARCH_ARTIFACT },
      successorStepId: 'discussion-two',
      eligibleRecipients: [],
    })
    assert.equal(waiting.status, 'awaiting_input')
    const persisted = fs.readFileSync(store.paths.statePath)

    const observed = {
      'rewrite its summary': await attempt(store, (draft) => {
        stepAt(draft, 0).summary = 'Rewritten after the fact.'
      }),
      'raise its cost': await attempt(store, (draft) => {
        stepAt(draft, 0).costUsd = 0.75
        draft.totalCostUsd = 0.75
      }),
      'reopen it': await attempt(store, (draft) => {
        stepAt(draft, 0).status = 'running'
      }),
    }

    const refusal = "invalid_state: Terminal workflow step 'research' is immutable."
    assert.deepEqual(observed, {
      'rewrite its summary': refusal,
      'raise its cost': refusal,
      'reopen it': refusal,
    })
    assert.ok(
      fs.readFileSync(store.paths.statePath).equals(persisted),
      'no refused update reached workflow-state.json',
    )

    // The waiting workflow still takes edits to a step that has not settled.
    const edited = await advance(store, (draft) => {
      stepAt(draft, 2).summary = 'Queued behind the feedback round.'
    })
    assert.equal(stepAt(edited, 2).summary, 'Queued behind the feedback round.')
    assert.deepEqual(stepAt(edited, 0), stepAt(waiting, 0))
  })
})

test('a refused transition appends nothing to the workflow journal', async () => {
  await withAssignment(async (assignmentPath) => {
    fs.mkdirSync(assignmentPath, { recursive: true })
    const journal = await initializeExecutionJournal({
      scopeRoot: assignmentPath,
      identity: journalIdentity(),
    })
    try {
      const store = openStore(assignmentPath, {
        journal: createJournalBackedWorkflowRecorder(journal),
      })
      await store.initialize(initialization([teamStep('research', 0)]))
      await advance(store, (draft) => moveStepTo(stepAt(draft, 0), 'launching'))
      const streamId = workflowJournalStreamId('task-one', 'research-workflow')
      const journaled = async () =>
        (await journal.scanStream(WORKFLOW_STATE_STREAM_KIND, streamId)).events.length
      assert.equal(await journaled(), 2, 'initialization and the launch are both journaled')
      const persisted = fs.readFileSync(store.paths.statePath)

      const outcome = await attempt(store, (draft) => moveStepTo(stepAt(draft, 0), 'completed'))

      assert.equal(
        outcome,
        "invalid_state: Illegal transition for workflow step 'research': 'launching' -> 'completed'.",
      )
      assert.equal(await journaled(), 2)
      assert.ok(fs.readFileSync(store.paths.statePath).equals(persisted))
      // The journal is what a restarted store trusts, so it must still say launching.
      const reopened = await openStore(assignmentPath, {
        journal: createJournalBackedWorkflowRecorder(journal),
      }).requireSnapshot()
      assert.equal(reopened.state.revision, 1)
      assert.equal(stepAt(reopened.state, 0).status, 'launching')
    } finally {
      await journal.close()
    }
  })
})
