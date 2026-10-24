import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { whenDefined } from '../../core/optional-properties.js'
import type {
  DurableWorkflowState,
  DurableWorkflowStatus,
  DurableWorkflowStepState,
  DurableWorkflowStepStatus,
  WorkflowExecutionManifest,
  WorkflowStepRecoveryPolicy,
} from '../../workflows/types.js'
import {
  classifyWorkflowRecovery,
  classifyWorkflowRecoveryWithReceipts,
  hashWorkflowContent,
  WorkflowStateStoreError,
  writeWorkflowCompletionReceipt,
  type WorkflowExecutionSnapshot,
  type WorkflowRecoveryDisposition,
} from '../../workflows/workflow-state-store.js'

// How recovery classifies a durable workflow today, pinned before the pure
// classifier moves out of workflow-state-store.ts. Every result is compared
// whole. The task recovery manager copies the disposition and the reason onto
// the task record, so a reworded reason is a different record.

const CREATED_AT = '2026-07-13T12:00:00.000Z'
const COMPLETED_AT = '2026-07-13T12:00:02.000Z'
const TASK_ID = 'task-one'
const ROOT_RUN_ID = 'root-run'
const WORKFLOW_ID = 'writing-workflow'

const POLICIES: readonly WorkflowStepRecoveryPolicy[] = [
  'safe_retry',
  'idempotent',
  'manual',
  'never_retry',
]

const SETTLED_WORKFLOW_STATUSES = [
  'completed',
  'completed_with_warnings',
  'blocked',
  'failed',
  'cancelled',
] as const

const ADVERSE_STEP_STATUSES = ['blocked', 'failed', 'cancelled'] as const

const NOT_STARTED_REASON = 'The next workflow step has not started.'

// What a step that has already started is told, by its recovery policy.
const STARTED_STEP_RESULTS: Record<
  WorkflowStepRecoveryPolicy,
  Pick<WorkflowRecoveryDisposition, 'disposition' | 'reason'>
> = {
  safe_retry: {
    disposition: 'automatic',
    reason: 'The interrupted step explicitly permits a safe retry.',
  },
  idempotent: {
    disposition: 'automatic',
    reason: 'The interrupted step has a persisted idempotency key.',
  },
  manual: {
    disposition: 'manual',
    reason: 'The interrupted step requires a user recovery decision.',
  },
  never_retry: {
    disposition: 'not_resumable',
    reason: 'The interrupted step is explicitly marked never retry.',
  },
}

function receiptReason(stepId: StepId): string {
  return `Workflow step '${stepId}' has a validated immutable completion receipt ` +
    'that can be adopted without rerunning the child.'
}

type StepId = 'gather' | 'draft' | 'review'

interface StepSetup {
  status: DurableWorkflowStepStatus
  recoveryPolicy?: WorkflowStepRecoveryPolicy
}

interface StateSetup {
  status: DurableWorkflowStatus
  currentStepId?: StepId
  gather?: StepSetup
  draft?: StepSetup
  review?: StepSetup
}

function makeStep(stepId: StepId, stepIndex: number, setup: StepSetup): DurableWorkflowStepState {
  const recoveryPolicy = setup.recoveryPolicy ?? 'safe_retry'
  return {
    stepId,
    stepIndex,
    stepType: 'team',
    team: 'writers',
    definitionHash: hashWorkflowContent(`${stepId}-step:v1`),
    status: setup.status,
    recoveryPolicy,
    childRunId: `${stepId}-run`,
    inputArtifact: 'brief.md',
    resultArtifact: `${stepId}.md`,
    requestedResultType: `artifact:${stepId}.md`,
    attemptCount: setup.status === 'pending' ? 0 : 1,
    costUsd: 0,
    ...whenDefined(
      recoveryPolicy === 'idempotent' ? `${ROOT_RUN_ID}/${stepId}` : undefined,
      (idempotencyKey) => ({ idempotencyKey }),
    ),
  }
}

/** Three team steps in order gather, draft, review; each is pending with safe_retry unless set. */
function makeState(setup: StateSetup): DurableWorkflowState {
  const pending: StepSetup = { status: 'pending' }
  return {
    schemaVersion: 2,
    revision: 3,
    taskId: TASK_ID,
    sessionId: 'product-session',
    rootRunId: ROOT_RUN_ID,
    workflowId: WORKFLOW_ID,
    ownerExecutionAttemptId: 'attempt-one',
    status: setup.status,
    ...whenDefined(setup.currentStepId, (currentStepId) => ({ currentStepId })),
    totalCostUsd: 0,
    recoveryCount: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    steps: [
      makeStep('gather', 0, setup.gather ?? pending),
      makeStep('draft', 1, setup.draft ?? pending),
      makeStep('review', 2, setup.review ?? pending),
    ],
  }
}

function makeSnapshot(state: DurableWorkflowState): WorkflowExecutionSnapshot {
  const manifest: WorkflowExecutionManifest = {
    schemaVersion: 1,
    taskId: TASK_ID,
    sessionId: 'product-session',
    rootRunId: ROOT_RUN_ID,
    workflowId: WORKFLOW_ID,
    workflowDefinitionHash: hashWorkflowContent('writing-workflow:v1'),
    briefHash: hashWorkflowContent('Write the report.'),
    teamDefinitionHashes: { writers: hashWorkflowContent('writers:v1') },
    runtimeVersion: 'workflow-runtime-v1',
    createdAt: CREATED_AT,
  }
  return { manifest, state }
}

async function withRootAssignment(run: (rootAssignmentPath: string) => Promise<void>): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-recovery-classification-'))
  try {
    await run(path.join(workspace, 'assignments', ROOT_RUN_ID))
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

/** Writes a valid receipt into the step's child assignment, a sibling of the root. */
async function writeReceipt(rootAssignmentPath: string, stepId: StepId): Promise<void> {
  const childRunId = `${stepId}-run`
  const childAssignmentPath = path.join(path.dirname(rootAssignmentPath), childRunId)
  fs.mkdirSync(childAssignmentPath, { recursive: true })
  await writeWorkflowCompletionReceipt(childAssignmentPath, {
    taskId: TASK_ID,
    rootRunId: ROOT_RUN_ID,
    workflowId: WORKFLOW_ID,
    stepId,
    childRunId,
    executionAttemptId: 'attempt-one',
    status: 'failed',
    summary: `The ${stepId} child finished with a durable failure.`,
    costUsd: 0,
    completedAt: COMPLETED_AT,
  })
}

test('workflow content hashes are lowercase hex SHA-256 over UTF-8 text or raw bytes', () => {
  assert.equal(
    hashWorkflowContent(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  assert.equal(
    hashWorkflowContent('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  assert.equal(
    hashWorkflowContent(new Uint8Array([0x61, 0x62, 0x63])),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  // U+00E9 is the two bytes c3 a9 in UTF-8.
  assert.equal(
    hashWorkflowContent('é'),
    '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
  )
  assert.equal(
    hashWorkflowContent(new Uint8Array([0xc3, 0xa9])),
    '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
  )
})

test('a settled workflow is not resumable, whatever its steps still say', () => {
  for (const status of SETTLED_WORKFLOW_STATUSES) {
    const state = makeState({
      status,
      currentStepId: 'draft',
      gather: { status: 'completed' },
      draft: { status: 'interrupted', recoveryPolicy: 'safe_retry' },
    })

    assert.deepEqual(
      classifyWorkflowRecovery(state),
      {
        disposition: 'not_resumable',
        reason: `Workflow is already terminal with status '${status}'.`,
      },
      status,
    )
  }
})

test('a workflow awaiting human input needs a person and names the waiting step but not its policy', () => {
  const state = makeState({
    status: 'awaiting_input',
    currentStepId: 'draft',
    gather: { status: 'completed' },
    draft: { status: 'awaiting_input', recoveryPolicy: 'never_retry' },
  })

  assert.deepEqual(classifyWorkflowRecovery(state), {
    disposition: 'manual',
    stepId: 'draft',
    reason: 'Workflow is awaiting human input.',
  })
})

test('an active workflow whose steps are all committed continues to terminal reconciliation', () => {
  for (const status of ['running', 'interrupted'] as const) {
    const state = makeState({
      status,
      currentStepId: 'review',
      gather: { status: 'completed' },
      draft: { status: 'completed_with_warnings' },
      review: { status: 'completed' },
    })

    assert.deepEqual(
      classifyWorkflowRecovery(state),
      {
        disposition: 'automatic',
        reason: 'All workflow steps are committed; terminal reconciliation may continue.',
      },
      status,
    )
  }
})

test('an active workflow whose steps have all ended is not resumable at the first step that ended adversely', () => {
  for (const status of ['running', 'interrupted'] as const) {
    for (const adverse of ADVERSE_STEP_STATUSES) {
      const state = makeState({
        status,
        currentStepId: 'review',
        gather: { status: 'completed' },
        draft: { status: adverse, recoveryPolicy: 'manual' },
        review: { status: 'failed', recoveryPolicy: 'never_retry' },
      })

      assert.deepEqual(
        classifyWorkflowRecovery(state),
        {
          disposition: 'not_resumable',
          stepId: 'draft',
          policy: 'manual',
          reason: `Workflow journal is active but step 'draft' is already '${adverse}'.`,
        },
        `${status} workflow, draft ${adverse}`,
      )
    }
  }
})

test('the first step that has not started resumes automatically whatever its recovery policy', () => {
  for (const status of ['running', 'interrupted'] as const) {
    for (const policy of POLICIES) {
      const state = makeState({
        status,
        gather: { status: 'pending', recoveryPolicy: policy },
      })

      assert.deepEqual(
        classifyWorkflowRecovery(state),
        {
          disposition: 'automatic',
          stepId: 'gather',
          policy,
          reason: NOT_STARTED_REASON,
        },
        `${status} workflow, ${policy} step`,
      )
    }
  }
})

test('a step that has started resumes only as its recovery policy allows', () => {
  // classifyWorkflowRecovery has no rule of its own for awaiting_model_choice:
  // the waiting step goes through the same policy rules as any started step.
  const started: ReadonlyArray<readonly [DurableWorkflowStatus, DurableWorkflowStepStatus]> = [
    ['running', 'launching'],
    ['running', 'running'],
    ['interrupted', 'interrupted'],
    ['interrupted', 'indeterminate'],
    ['awaiting_model_choice', 'awaiting_model_choice'],
  ]
  for (const [status, stepStatus] of started) {
    for (const policy of POLICIES) {
      const state = makeState({
        status,
        currentStepId: 'draft',
        gather: { status: 'completed' },
        draft: { status: stepStatus, recoveryPolicy: policy },
      })

      assert.deepEqual(
        classifyWorkflowRecovery(state),
        { ...STARTED_STEP_RESULTS[policy], stepId: 'draft', policy },
        `${status} workflow, ${stepStatus} ${policy} step`,
      )
    }
  }
})

test('the step named current is classified ahead of an earlier unfinished step', () => {
  const state = makeState({
    status: 'interrupted',
    currentStepId: 'review',
    gather: { status: 'interrupted', recoveryPolicy: 'safe_retry' },
    review: { status: 'interrupted', recoveryPolicy: 'manual' },
  })

  assert.deepEqual(classifyWorkflowRecovery(state), {
    disposition: 'manual',
    stepId: 'review',
    policy: 'manual',
    reason: 'The interrupted step requires a user recovery decision.',
  })
})

test('without a live current step the first unfinished step in step order is classified', () => {
  const steps = {
    gather: { status: 'completed' },
    draft: { status: 'interrupted', recoveryPolicy: 'manual' },
    review: { status: 'interrupted', recoveryPolicy: 'never_retry' },
  } satisfies Pick<StateSetup, 'gather' | 'draft' | 'review'>
  const expected = {
    disposition: 'manual',
    stepId: 'draft',
    policy: 'manual',
    reason: 'The interrupted step requires a user recovery decision.',
  }

  assert.deepEqual(
    classifyWorkflowRecovery(makeState({ status: 'interrupted', currentStepId: 'gather', ...steps })),
    expected,
    'current step already completed',
  )
  assert.deepEqual(
    classifyWorkflowRecovery(makeState({ status: 'interrupted', ...steps })),
    expected,
    'no current step',
  )
})

test('recovery adopts a completion receipt at the step named current, ahead of an earlier unfinished step', async () => {
  await withRootAssignment(async (rootAssignmentPath) => {
    await writeReceipt(rootAssignmentPath, 'review')
    const state = makeState({
      status: 'interrupted',
      currentStepId: 'review',
      gather: { status: 'interrupted', recoveryPolicy: 'safe_retry' },
      review: { status: 'interrupted', recoveryPolicy: 'manual' },
    })

    assert.deepEqual(
      await classifyWorkflowRecoveryWithReceipts(rootAssignmentPath, makeSnapshot(state)),
      {
        disposition: 'automatic',
        stepId: 'review',
        policy: 'manual',
        reason: receiptReason('review'),
      },
    )
  })
})

test('without a live current step recovery adopts a completion receipt at the first unfinished step', async () => {
  await withRootAssignment(async (rootAssignmentPath) => {
    await writeReceipt(rootAssignmentPath, 'draft')
    const steps = {
      gather: { status: 'completed' },
      draft: { status: 'interrupted', recoveryPolicy: 'manual' },
      review: { status: 'interrupted', recoveryPolicy: 'never_retry' },
    } satisfies Pick<StateSetup, 'gather' | 'draft' | 'review'>
    const expected = {
      disposition: 'automatic',
      stepId: 'draft',
      policy: 'manual',
      reason: receiptReason('draft'),
    }

    assert.deepEqual(
      await classifyWorkflowRecoveryWithReceipts(
        rootAssignmentPath,
        makeSnapshot(makeState({ status: 'interrupted', currentStepId: 'gather', ...steps })),
      ),
      expected,
      'current step already completed',
    )
    assert.deepEqual(
      await classifyWorkflowRecoveryWithReceipts(
        rootAssignmentPath,
        makeSnapshot(makeState({ status: 'interrupted', ...steps })),
      ),
      expected,
      'no current step',
    )
  })
})

test('a step that has not started is classified by the plain rules even when its child left a receipt', async () => {
  await withRootAssignment(async (rootAssignmentPath) => {
    await writeReceipt(rootAssignmentPath, 'gather')
    const state = makeState({
      status: 'interrupted',
      gather: { status: 'pending', recoveryPolicy: 'never_retry' },
    })

    assert.deepEqual(
      await classifyWorkflowRecoveryWithReceipts(rootAssignmentPath, makeSnapshot(state)),
      {
        disposition: 'automatic',
        stepId: 'gather',
        policy: 'never_retry',
        reason: NOT_STARTED_REASON,
      },
    )
  })
})

test('a settled workflow is not resumable even when an unfinished step left a receipt', async () => {
  await withRootAssignment(async (rootAssignmentPath) => {
    await writeReceipt(rootAssignmentPath, 'draft')
    const state = makeState({
      status: 'failed',
      currentStepId: 'draft',
      gather: { status: 'completed' },
      draft: { status: 'interrupted', recoveryPolicy: 'manual' },
    })

    assert.deepEqual(
      await classifyWorkflowRecoveryWithReceipts(rootAssignmentPath, makeSnapshot(state)),
      {
        disposition: 'not_resumable',
        reason: "Workflow is already terminal with status 'failed'.",
      },
    )
  })
})

test('a receipt left under another task is refused with the store error rather than adopted or ignored', async () => {
  await withRootAssignment(async (rootAssignmentPath) => {
    await writeReceipt(rootAssignmentPath, 'draft')
    const snapshot = makeSnapshot(makeState({
      status: 'interrupted',
      currentStepId: 'draft',
      gather: { status: 'completed' },
      draft: { status: 'interrupted', recoveryPolicy: 'manual' },
    }))

    // Only the manifest's task ID differs.
    await assert.rejects(
      classifyWorkflowRecoveryWithReceipts(rootAssignmentPath, {
        ...snapshot,
        manifest: { ...snapshot.manifest, taskId: 'another-task' },
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowStateStoreError)
        assert.equal(
          `${error.code}: ${error.message}`,
          "identity_mismatch: Completion receipt does not match expected 'taskId'.",
        )
        return true
      },
    )
  })
})
