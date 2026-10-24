import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  FileSystemWorkflowStateStore,
  WorkflowStateStoreError,
  classifyWorkflowRecovery,
  classifyWorkflowRecoveryWithReceipts,
  createWorkflowArtifactReference,
  hashHumanInputSubmission,
  hashWorkflowContent,
  readVerifiedWorkflowArtifactPreview,
  readWorkflowCompletionReceipt,
  terminalTaskStatusForWorkflow,
  verifyWorkflowArtifactReference,
  writeWorkflowCompletionReceipt,
  type InitializeWorkflowExecutionInput,
  type WorkflowStateStoreErrorCode,
} from '../../workflows/workflow-state-store.js'
import { BUILTIN_TRANSFORM_EXECUTOR } from '../../workflows/artifact-contracts.js'
import type {
  DurableWorkflowState,
  WorkflowStepRecoveryPolicy,
} from '../../workflows/types.js'

const CREATED_AT = '2026-07-13T12:00:00.000Z'
const UPDATED_AT = '2026-07-13T12:00:01.000Z'
const COMPLETED_AT = '2026-07-13T12:00:02.000Z'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-state-store-'))
}

function rootAssignmentPath(workspace: string, rootRunId = 'root-run'): string {
  return path.join(workspace, 'assignments', rootRunId)
}

function initializationInput(params: {
  rootRunId?: string
  executionAttemptId?: string
  recoveryPolicy?: WorkflowStepRecoveryPolicy
  idempotencyKey?: string
  childRunId?: string
  includeHumanInputStep?: boolean
} = {}): InitializeWorkflowExecutionInput {
  const recoveryPolicy = params.recoveryPolicy ?? 'safe_retry'
  return {
    manifest: {
      taskId: 'task-one',
      sessionId: 'product-session',
      rootRunId: params.rootRunId ?? 'root-run',
      workflowId: 'research-workflow',
      workflowDefinitionHash: hashWorkflowContent('workflow:v1'),
      briefHash: hashWorkflowContent('Investigate the market.'),
      teamDefinitionHashes: {
        researchers: hashWorkflowContent('researchers:v1'),
      },
      runtimeVersion: 'workflow-runtime-v1',
      createdAt: CREATED_AT,
    },
    executionAttemptId: params.executionAttemptId ?? 'attempt-one',
    steps: [
      {
        stepId: 'research',
        stepIndex: 0,
        stepType: 'team',
        team: 'researchers',
        definitionHash: hashWorkflowContent('research-step:v1'),
        recoveryPolicy,
        ...whenDefined(params.childRunId, (childRunId) => ({ childRunId: childRunId })),
        inputArtifact: 'incoming-brief.md',
        resultArtifact: 'report.md',
        requestedResultType: 'artifact:report.md',
        ...whenDefined(recoveryPolicy === 'idempotent'
            ? params.idempotencyKey ?? 'root-run/research'
            : params.idempotencyKey, (idempotencyKey) => ({ idempotencyKey: idempotencyKey })),
      },
      ...(params.includeHumanInputStep
        ? [
            {
              stepId: 'human-feedback',
              stepIndex: 1,
              stepType: 'human-in-the-loop' as const,
              definitionHash: hashWorkflowContent('human-feedback-step:v1'),
              recoveryPolicy: 'never_retry' as const,
              childRunId: 'human-feedback-run',
              inputArtifact: 'review/round-1.md',
              resultArtifact: 'feedback/round-1.json',
              requestedResultType: 'artifact:feedback/round-1.json',
            },
            {
              stepId: 'discussion-two',
              stepIndex: 2,
              stepType: 'team' as const,
              team: 'researchers',
              definitionHash: hashWorkflowContent('discussion-two-step:v1'),
              recoveryPolicy: 'manual' as const,
              childRunId: 'discussion-two-run',
              inputArtifact: 'feedback/round-1.json',
              resultArtifact: 'report-2.md',
              requestedResultType: 'artifact:report-2.md',
            },
          ]
        : []),
    ],
  }
}

function makeStore(
  assignmentPath: string,
  childRunId = 'child-run',
): FileSystemWorkflowStateStore {
  return new FileSystemWorkflowStateStore(assignmentPath, {
    now: () => new Date(UPDATED_AT),
    randomUUID: () => childRunId,
  })
}

function hasStoreCode(code: WorkflowStateStoreErrorCode) {
  return (error: unknown): boolean =>
    error instanceof WorkflowStateStoreError && error.code === code
}

function cloneState(state: DurableWorkflowState): DurableWorkflowState {
  return JSON.parse(JSON.stringify(state)) as DurableWorkflowState
}

function terminalOutcome(
  status: 'completed' | 'completed_with_warnings' | 'blocked' | 'failed',
  artifact?: DurableWorkflowState['steps'][number]['artifact'],
): NonNullable<DurableWorkflowState['terminalOutcome']> {
  const rootWrapperBody = [
    '# Workflow Result',
    '',
    '- Workflow: research-workflow',
    `- Status: ${status}`,
    '- Primary artifact: /workspace/assignments/child-run/report.md',
    '',
    '## Summary',
    '',
    'Research complete.',
  ].join('\n')
  return {
    status,
    summary: 'Research complete.',
    requestedResultType: 'artifact:report.md',
    outputStepId: 'research',
    ...whenDefined(artifact, (primaryArtifact) => ({ primaryArtifact: primaryArtifact })),
    rootWrapperBody,
    rootWrapperSha256: hashWorkflowContent(rootWrapperBody),
  }
}

test('initialization persists a versioned manifest and stable child run IDs', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const firstStore = makeStore(assignmentPath)
    const initialized = await firstStore.initialize(initializationInput())

    assert.equal(initialized.manifest.schemaVersion, 1)
    assert.equal(initialized.manifest.workflowDefinitionHash, hashWorkflowContent('workflow:v1'))
    assert.equal(initialized.manifest.briefHash, hashWorkflowContent('Investigate the market.'))
    assert.equal(initialized.state.schemaVersion, 2)
    assert.equal(initialized.state.revision, 0)
    assert.equal(initialized.state.ownerExecutionAttemptId, 'attempt-one')
    assert.equal(initialized.state.steps[0]?.childRunId, 'child-run')
    assert.equal(initialized.state.steps[0]?.status, 'pending')
    assert.ok(fs.existsSync(firstStore.paths.manifestPath))
    assert.ok(fs.existsSync(firstStore.paths.statePath))

    const secondStore = makeStore(assignmentPath, 'different-generated-id')
    const repeated = await secondStore.initialize(initializationInput())
    assert.equal(repeated.state.steps[0]?.childRunId, 'child-run')
    assert.deepEqual(await secondStore.load(), repeated)
    assert.equal(fs.existsSync(secondStore.paths.lockPath), false)
    assert.deepEqual(
      fs.readdirSync(secondStore.paths.privateRuntimePath)
        .filter((name) => name.endsWith('.tmp')),
      [],
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('reads a version-1 state as the normalized version-2 workflow state without rewriting it', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const store = makeStore(assignmentPath)
    await store.initialize(initializationInput())

    const legacyState = JSON.parse(
      fs.readFileSync(store.paths.statePath, 'utf8'),
    ) as Record<string, unknown>
    legacyState.schemaVersion = 1
    fs.writeFileSync(store.paths.statePath, JSON.stringify(legacyState))

    const loaded = await makeStore(assignmentPath).load()
    assert.equal(loaded?.state.schemaVersion, 2)
    assert.equal(loaded?.state.steps[0]?.team, 'researchers')
    assert.equal(
      (JSON.parse(fs.readFileSync(store.paths.statePath, 'utf8')) as { schemaVersion: number }).schemaVersion,
      1,
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('initializes version-1 transform and agent steps with their template seed types', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const input = initializationInput()
    input.steps = [
      {
        stepId: 'publish',
        stepIndex: 0,
        stepType: 'transform',
        team: BUILTIN_TRANSFORM_EXECUTOR,
        definitionHash: hashWorkflowContent('publish-step:v1'),
        recoveryPolicy: 'idempotent',
        childRunId: 'publish-run',
        inputArtifact: 'draft.md',
        resultArtifact: 'report.docx',
        requestedResultType: 'artifact:report.docx',
        idempotencyKey: 'root-run/publish',
      },
      {
        stepId: 'review',
        stepIndex: 1,
        stepType: 'agent',
        team: 'researchers',
        definitionHash: hashWorkflowContent('review-step:v1'),
        recoveryPolicy: 'manual',
        childRunId: 'review-run',
        inputArtifact: 'report.docx',
        resultArtifact: 'review.md',
        requestedResultType: 'artifact:review.md',
      },
    ]
    input.manifest.teamDefinitionHashes = {
      [BUILTIN_TRANSFORM_EXECUTOR]: hashWorkflowContent('markdown-to-docx-v2'),
      researchers: hashWorkflowContent('researchers:v1'),
    }
    const store = makeStore(assignmentPath)
    await store.initialize(input)

    const legacyState = JSON.parse(fs.readFileSync(store.paths.statePath, 'utf8')) as {
      schemaVersion: number
      steps: Array<Record<string, unknown>>
    }
    legacyState.schemaVersion = 1
    for (const step of legacyState.steps) delete step.stepType
    fs.writeFileSync(store.paths.statePath, JSON.stringify(legacyState))

    const initialized = await makeStore(assignmentPath).initialize(input)
    assert.deepEqual(
      initialized.state.steps.map((step) => step.stepType),
      ['transform', 'agent'],
    )
    assert.equal(
      (JSON.parse(fs.readFileSync(store.paths.statePath, 'utf8')) as { schemaVersion: number }).schemaVersion,
      1,
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('preview decoding drops an incomplete trailing UTF-8 code point', async () => {
  const workspace = makeWorkspace()
  try {
    const childAssignmentPath = path.join(workspace, 'assignments', 'child-run')
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    fs.writeFileSync(path.join(childAssignmentPath, 'source.md'), 'abc😀')
    const artifact = await createWorkflowArtifactReference({
      childAssignmentPath,
      childRunId: 'child-run',
      relativePath: 'source.md',
    })

    const preview = await readVerifiedWorkflowArtifactPreview(
      childAssignmentPath,
      artifact,
      5,
    )

    assert.equal(preview.text, 'abc')
    assert.equal(preview.truncated, true)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('persists one hash-bound human-input request and idempotent feedback submission', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const store = makeStore(assignmentPath)
    await store.initialize(initializationInput({ includeHumanInputStep: true }))
    const sourceArtifact = {
      childRunId: 'child-run',
      relativePath: 'report.md',
      sha256: hashWorkflowContent('round one report'),
      byteLength: Buffer.byteLength('round one report'),
    }
    const waiting = await store.requestHumanInput({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      stepId: 'human-feedback',
      interactionId: 'workflow_hitl_feedback_one',
      sourceArtifact,
      successorStepId: 'discussion-two',
      eligibleRecipients: [{
        id: 'security-reviewer',
        mentionToken: 'security-reviewer',
        displayName: 'Security reviewer',
      }],
      prompt: 'Review the first discussion round.',
    })
    assert.equal(waiting.status, 'awaiting_input')
    assert.equal(waiting.revision, 1)
    assert.equal(waiting.steps[1]?.humanInput?.status, 'pending')
    assert.equal(waiting.steps[1]?.humanInput?.sourceArtifact.sha256, sourceArtifact.sha256)

    const submission = {
      submissionId: 'submission-one',
      mode: 'feedback' as const,
      messages: [{
        id: 'message-one',
        text: 'Please check the threat model.',
        recipients: ['security-reviewer'],
      }],
      submittedAt: COMPLETED_AT,
      canonicalHash: hashHumanInputSubmission({
        submissionId: 'submission-one',
        mode: 'feedback',
        messages: [{
          id: 'message-one',
          text: 'Please check the threat model.',
          recipients: ['security-reviewer'],
        }],
      }),
    }

    await assert.rejects(
      store.submitHumanInput({
        expectedRevision: 1,
        interactionId: 'workflow_hitl_feedback_one',
        expectedSourceArtifactSha256: sourceArtifact.sha256,
        submission: { ...submission, canonicalHash: '0'.repeat(64) },
      }),
      hasStoreCode('invalid_state'),
    )
    await assert.rejects(
      store.submitHumanInput({
        expectedRevision: 0,
        interactionId: 'workflow_hitl_feedback_one',
        expectedSourceArtifactSha256: sourceArtifact.sha256,
        submission,
      }),
      hasStoreCode('revision_conflict'),
    )
    await assert.rejects(
      store.submitHumanInput({
        expectedRevision: 1,
        interactionId: 'workflow_hitl_feedback_one',
        expectedSourceArtifactSha256: '0'.repeat(64),
        submission,
      }),
      hasStoreCode('revision_conflict'),
    )
    const submitted = await store.submitHumanInput({
      expectedRevision: 1,
      interactionId: 'workflow_hitl_feedback_one',
      expectedSourceArtifactSha256: sourceArtifact.sha256,
      submission,
    })
    assert.equal(submitted.revision, 2)
    assert.equal(submitted.status, 'awaiting_input')
    assert.equal(submitted.steps[1]?.humanInput?.status, 'submitted')
    assert.deepEqual(submitted.steps[1]?.humanInput?.submission, submission)

    const retried = await store.submitHumanInput({
      expectedRevision: 1,
      interactionId: 'workflow_hitl_feedback_one',
      expectedSourceArtifactSha256: sourceArtifact.sha256,
      submission: { ...submission, submittedAt: UPDATED_AT },
    })
    assert.equal(retried.revision, 2)

    const claimed = await store.claimHumanInputContinuation({
      expectedRevision: 2,
      interactionId: 'workflow_hitl_feedback_one',
      expectedOwnerExecutionAttemptId: 'attempt-one',
      nextExecutionAttemptId: 'attempt-two',
      continuationAdmissionRequestId: 'continuation-admission-one',
    })
    assert.equal(claimed.revision, 3)
    assert.equal(claimed.status, 'running')
    assert.equal(claimed.ownerExecutionAttemptId, 'attempt-two')
    assert.equal(claimed.recoveryCount, 0)
    assert.equal(
      claimed.steps[1]?.humanInput?.continuationAdmissionRequestId,
      'continuation-admission-one',
    )

    await assert.rejects(
      store.submitHumanInput({
        expectedRevision: 3,
        interactionId: 'workflow_hitl_feedback_one',
        expectedSourceArtifactSha256: sourceArtifact.sha256,
        submission: {
          ...submission,
          submissionId: 'submission-two',
          canonicalHash: hashHumanInputSubmission({
            submissionId: 'submission-two',
            mode: submission.mode,
            messages: submission.messages,
          }),
        },
      }),
      hasStoreCode('revision_conflict'),
    )

    const cancelled = await store.cancelFromAuthoritativeTask({
      taskId: 'task-one',
      summary: 'Cancelled before feedback continuation.',
      completedAt: COMPLETED_AT,
    })
    assert.equal(cancelled?.steps[1]?.humanInput?.status, 'cancelled')
    await assert.rejects(
      store.submitHumanInput({
        expectedRevision: 3,
        interactionId: 'workflow_hitl_feedback_one',
        expectedSourceArtifactSha256: sourceArtifact.sha256,
        submission,
      }),
      hasStoreCode('revision_conflict'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a requested human-input wait remains active and can converge to cancellation', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const store = makeStore(assignmentPath)
    await store.initialize(initializationInput({ includeHumanInputStep: true }))
    const sourceArtifact = {
      childRunId: 'child-run',
      relativePath: 'report.md',
      sha256: hashWorkflowContent('round one report'),
      byteLength: Buffer.byteLength('round one report'),
    }

    const waiting = await store.requestHumanInput({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      stepId: 'human-feedback',
      interactionId: 'workflow_hitl_feedback_cancel',
      sourceArtifact,
      successorStepId: 'discussion-two',
      eligibleRecipients: [],
    })

    assert.equal(waiting.status, 'awaiting_input')
    assert.equal(waiting.steps[1]?.status, 'awaiting_input')
    assert.equal(terminalTaskStatusForWorkflow(waiting.status), null)
    assert.equal(classifyWorkflowRecovery(waiting).disposition, 'manual')

    const cancelled = await store.cancelFromAuthoritativeTask({
      taskId: 'task-one',
      summary: 'Cancelled while awaiting feedback.',
      completedAt: COMPLETED_AT,
    })
    assert.equal(cancelled?.status, 'cancelled')
    assert.equal(cancelled?.steps[1]?.status, 'cancelled')
    assert.equal(terminalTaskStatusForWorkflow(cancelled!.status), 'cancelled')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('revisioned updates persist legal transitions and make terminal state immutable', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const store = makeStore(assignmentPath)
    await store.initialize(initializationInput())

    const launching = await store.update({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.currentStepId = 'research'
        draft.steps[0]!.status = 'launching'
        draft.steps[0]!.attemptCount = 1
        draft.steps[0]!.startedAt = UPDATED_AT
      },
    })
    assert.equal(launching.revision, 1)
    assert.equal(launching.steps[0]?.status, 'launching')

    const running = await store.update({
      expectedRevision: 1,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.steps[0]!.status = 'running'
      },
    })
    assert.equal(running.revision, 2)

    const childAssignment = path.join(workspace, 'assignments', 'child-run')
    fs.mkdirSync(childAssignment, { recursive: true })
    fs.writeFileSync(path.join(childAssignment, 'report.md'), '# Report\n')
    const artifact = await createWorkflowArtifactReference({
      childAssignmentPath: childAssignment,
      childRunId: 'child-run',
      relativePath: 'report.md',
    })
    const completed = await store.update({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'completed'
        draft.totalCostUsd = 1.25
        draft.steps[0]!.status = 'completed'
        draft.steps[0]!.artifact = artifact
        draft.steps[0]!.summary = 'Research complete.'
        draft.steps[0]!.costUsd = 1.25
        draft.steps[0]!.costTracked = true
        draft.steps[0]!.completedAt = COMPLETED_AT
        draft.terminalOutcome = terminalOutcome('completed', artifact)
      },
    })
    assert.equal(completed.revision, 3)
    assert.equal(completed.totalCostUsd, 1.25)
    assert.equal(completed.terminalOutcome?.status, 'completed')
    assert.equal(completed.terminalOutcome?.primaryArtifact?.sha256, artifact.sha256)
    assert.equal(
      completed.terminalOutcome?.rootWrapperSha256,
      hashWorkflowContent(completed.terminalOutcome!.rootWrapperBody),
    )

    await assert.rejects(
      store.update({
        expectedRevision: 3,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.totalCostUsd = 2
        },
      }),
      hasStoreCode('invalid_state'),
    )
    assert.equal((await store.requireSnapshot()).state.totalCostUsd, 1.25)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('revision CAS allows only one concurrent writer across store instances', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const firstStore = makeStore(assignmentPath)
    const secondStore = makeStore(assignmentPath)
    await firstStore.initialize(initializationInput())

    const update = (store: FileSystemWorkflowStateStore) => store.update({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.currentStepId = 'research'
        draft.steps[0]!.status = 'launching'
        draft.steps[0]!.attemptCount = 1
        draft.steps[0]!.startedAt = UPDATED_AT
      },
    })
    const results = await Promise.allSettled([
      update(firstStore),
      update(secondStore),
    ])

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.ok(hasStoreCode('revision_conflict')(rejected.reason))
    assert.equal((await firstStore.requireSnapshot()).state.revision, 1)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('concurrent stale-lock reclaimers never overlap workflow state mutation', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const initialStore = makeStore(assignmentPath)
    await initialStore.initialize(initializationInput())
    fs.writeFileSync(
      initialStore.paths.lockPath,
      `${JSON.stringify({
        pid: 2_000_000_000,
        nonce: 'dead-owner',
        createdAt: CREATED_AT,
      })}\n`,
    )
    const pausedCandidatePath = `${initialStore.paths.lockPath}.candidate-${process.pid}-paused-concurrent-owner`
    fs.writeFileSync(pausedCandidatePath, `${JSON.stringify({
      pid: process.pid,
      nonce: 'paused-concurrent-owner',
      createdAt: CREATED_AT,
    })}\n`)

    const contenders = Array.from(
      { length: 8 },
      () => new FileSystemWorkflowStateStore(assignmentPath, {
        now: () => new Date(UPDATED_AT),
        randomUUID: () => 'child-run',
        isProcessAlive: (pid) => pid === process.pid,
        lockTimeoutMs: 2_000,
        lockRetryMs: 1,
      }),
    )
    const results = await Promise.allSettled(
      contenders.map((store) => store.update({
        expectedRevision: 0,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.currentStepId = 'research'
          draft.steps[0]!.status = 'launching'
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })),
    )

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 7)
    assert.equal((await initialStore.requireSnapshot()).state.revision, 1)
    assert.equal(fs.existsSync(initialStore.paths.lockPath), false)
    assert.equal(fs.existsSync(pausedCandidatePath), true)
    fs.unlinkSync(pausedCandidatePath)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('workflow lock acquisition removes abandoned reclaim guards', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    const reclaimPath = `${store.paths.lockPath}.reclaim`
    fs.mkdirSync(reclaimPath, { recursive: true })
    const staleTime = new Date('2000-01-01T00:00:00.000Z')
    fs.utimesSync(reclaimPath, staleTime, staleTime)

    await store.initialize(initializationInput())
    assert.equal(fs.existsSync(reclaimPath), false)

    fs.mkdirSync(reclaimPath)
    fs.writeFileSync(
      path.join(reclaimPath, 'owner.json'),
      `${JSON.stringify({
        pid: 2_000_000_000,
        nonce: 'killed-reclaimer',
        createdAt: CREATED_AT,
      })}\n`,
    )
    const updated = await store.update({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.currentStepId = 'research'
        draft.steps[0]!.status = 'launching'
        draft.steps[0]!.attemptCount = 1
        draft.steps[0]!.startedAt = UPDATED_AT
      },
    })

    assert.equal(updated.revision, 1)
    assert.equal(fs.existsSync(reclaimPath), false)

    fs.writeFileSync(
      reclaimPath,
      `${JSON.stringify({
        pid: 2_000_000_000,
        nonce: 'killed-atomic-reclaimer',
        createdAt: CREATED_AT,
      })}\n`,
    )
    const running = await store.update({
      expectedRevision: 1,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.steps[0]!.status = 'running'
      },
    })
    assert.equal(running.revision, 2)
    assert.equal(fs.existsSync(reclaimPath), false)
    assert.deepEqual(
      fs.readdirSync(store.paths.privateRuntimePath)
        .filter((name) => name.includes('.reclaim') || name.includes('.orphan-')),
      [],
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a paused unpublished workflow lock candidate cannot block an atomic winner', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    fs.mkdirSync(store.paths.privateRuntimePath, { recursive: true })
    const candidatePath = `${store.paths.lockPath}.candidate-${process.pid}-paused-owner`
    fs.writeFileSync(candidatePath, `${JSON.stringify({
      pid: process.pid,
      nonce: 'paused-owner',
      createdAt: CREATED_AT,
    })}\n`)

    const initialized = await store.initialize(initializationInput())

    assert.equal(initialized.state.revision, 0)
    assert.equal(fs.existsSync(store.paths.lockPath), false)
    assert.equal(fs.existsSync(candidatePath), true)
    fs.unlinkSync(candidatePath)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a recovery claim fences the old attempt and interrupts in-flight work', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    await store.update({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.currentStepId = 'research'
        draft.steps[0]!.status = 'launching'
        draft.steps[0]!.attemptCount = 1
        draft.steps[0]!.startedAt = UPDATED_AT
      },
    })
    await store.update({
      expectedRevision: 1,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.steps[0]!.status = 'running'
      },
    })

    const claimed = await store.claimExecutionAttempt({
      expectedRevision: 2,
      expectedOwnerExecutionAttemptId: 'attempt-one',
      nextExecutionAttemptId: 'attempt-two',
    })
    assert.equal(claimed.revision, 3)
    assert.equal(claimed.ownerExecutionAttemptId, 'attempt-two')
    assert.equal(claimed.recoveryCount, 1)
    assert.equal(claimed.status, 'interrupted')
    assert.equal(claimed.steps[0]?.status, 'interrupted')

    await assert.rejects(
      store.update({
        expectedRevision: 3,
        executionAttemptId: 'attempt-one',
        mutate() {},
      }),
      hasStoreCode('ownership_conflict'),
    )
    const resumed = await store.update({
      expectedRevision: 3,
      executionAttemptId: 'attempt-two',
      mutate(draft) {
        draft.status = 'running'
        draft.steps[0]!.status = 'launching'
        draft.steps[0]!.attemptCount = 2
      },
    })
    assert.equal(resumed.revision, 4)
    assert.equal(resumed.steps[0]?.attemptCount, 2)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('initialization fails closed on definition, brief, owner, and step mismatches', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const store = makeStore(assignmentPath)
    const initial = initializationInput({ childRunId: 'child-run' })
    await store.initialize(initial)

    await assert.rejects(
      store.initialize({
        ...initial,
        manifest: {
          ...initial.manifest,
          briefHash: hashWorkflowContent('A changed brief.'),
        },
      }),
      hasStoreCode('identity_mismatch'),
    )
    await assert.rejects(
      store.initialize({ ...initial, executionAttemptId: 'attempt-two' }),
      hasStoreCode('ownership_conflict'),
    )
    await assert.rejects(
      store.initialize({
        ...initial,
        steps: [{
          ...initial.steps[0]!,
          definitionHash: hashWorkflowContent('changed-step'),
        }],
      }),
      hasStoreCode('identity_mismatch'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('corrupt, partial, unsupported, and internally mismatched journals fail closed', async (t) => {
  await t.test('corrupt JSON', async () => {
    const workspace = makeWorkspace()
    try {
      const store = makeStore(rootAssignmentPath(workspace))
      await store.initialize(initializationInput())
      fs.writeFileSync(store.paths.statePath, '{broken')
      await assert.rejects(store.load(), hasStoreCode('corrupt'))
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  await t.test('unsupported schema', async () => {
    const workspace = makeWorkspace()
    try {
      const store = makeStore(rootAssignmentPath(workspace))
      await store.initialize(initializationInput())
      const manifest = JSON.parse(fs.readFileSync(store.paths.manifestPath, 'utf8')) as Record<string, unknown>
      manifest.schemaVersion = 2
      fs.writeFileSync(store.paths.manifestPath, JSON.stringify(manifest))
      await assert.rejects(store.load(), hasStoreCode('unsupported_version'))
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  await t.test('future workflow state schema', async () => {
    const workspace = makeWorkspace()
    try {
      const store = makeStore(rootAssignmentPath(workspace))
      await store.initialize(initializationInput())
      const state = JSON.parse(fs.readFileSync(store.paths.statePath, 'utf8')) as Record<string, unknown>
      state.schemaVersion = 99
      fs.writeFileSync(store.paths.statePath, JSON.stringify(state))
      await assert.rejects(store.load(), hasStoreCode('unsupported_version'))
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  await t.test('partial journal', async () => {
    const workspace = makeWorkspace()
    try {
      const store = makeStore(rootAssignmentPath(workspace))
      await store.initialize(initializationInput())
      fs.rmSync(store.paths.manifestPath)
      await assert.rejects(store.load(), hasStoreCode('corrupt'))
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  await t.test('state identity mismatch', async () => {
    const workspace = makeWorkspace()
    try {
      const store = makeStore(rootAssignmentPath(workspace))
      await store.initialize(initializationInput())
      const state = JSON.parse(fs.readFileSync(store.paths.statePath, 'utf8')) as Record<string, unknown>
      state.workflowId = 'other-workflow'
      fs.writeFileSync(store.paths.statePath, JSON.stringify(state))
      await assert.rejects(store.load(), hasStoreCode('identity_mismatch'))
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  await t.test('terminal outcome hash mismatch', async () => {
    const workspace = makeWorkspace()
    try {
      const store = makeStore(rootAssignmentPath(workspace))
      await store.initialize(initializationInput())
      const state = JSON.parse(
        fs.readFileSync(store.paths.statePath, 'utf8'),
      ) as DurableWorkflowState
      state.status = 'failed'
      state.terminalOutcome = terminalOutcome('failed')
      state.terminalOutcome.rootWrapperSha256 = '0'.repeat(64)
      fs.writeFileSync(store.paths.statePath, JSON.stringify(state))
      await assert.rejects(store.load(), hasStoreCode('invalid_state'))
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })
})

test('illegal transitions and inconsistent cost are rejected without publishing a revision', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())

    await assert.rejects(
      store.update({
        expectedRevision: 0,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = 'completed'
        },
      }),
      hasStoreCode('invalid_state'),
    )
    await assert.rejects(
      store.update({
        expectedRevision: 0,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.totalCostUsd = 1
        },
      }),
      hasStoreCode('invalid_state'),
    )
    assert.equal((await store.requireSnapshot()).state.revision, 0)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('idempotent steps require a persisted key and duplicate child IDs are rejected', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const missingKey = initializationInput({ recoveryPolicy: 'idempotent' })
    delete missingKey.steps[0]!.idempotencyKey
    await assert.rejects(
      makeStore(assignmentPath).initialize(missingKey),
      hasStoreCode('invalid_state'),
    )

    const duplicateWorkspace = makeWorkspace()
    try {
      const duplicate = initializationInput({ childRunId: 'same-child' })
      duplicate.steps.push({
        ...duplicate.steps[0]!,
        stepId: 'synthesize',
        stepIndex: 1,
      })
      await assert.rejects(
        makeStore(rootAssignmentPath(duplicateWorkspace)).initialize(duplicate),
        hasStoreCode('invalid_state'),
      )
    } finally {
      fs.rmSync(duplicateWorkspace, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('artifact references and immutable completion receipts are content-addressed', async () => {
  const workspace = makeWorkspace()
  try {
    const childAssignment = path.join(workspace, 'assignments', 'child-run')
    fs.mkdirSync(path.join(childAssignment, 'deliverables'), { recursive: true })
    const artifactPath = path.join(childAssignment, 'deliverables', 'report.md')
    fs.writeFileSync(artifactPath, '# Durable report\n')
    const artifact = await createWorkflowArtifactReference({
      childAssignmentPath: childAssignment,
      childRunId: 'child-run',
      relativePath: 'deliverables/report.md',
    })
    assert.equal(artifact.sha256, hashWorkflowContent('# Durable report\n'))
    assert.equal(
      await verifyWorkflowArtifactReference(childAssignment, artifact),
      artifactPath,
    )

    const receiptInput = {
      taskId: 'task-one',
      rootRunId: 'root-run',
      workflowId: 'research-workflow',
      stepId: 'research',
      childRunId: 'child-run',
      executionAttemptId: 'attempt-one',
      status: 'completed' as const,
      artifact,
      summary: 'Completed research.',
      costUsd: 0.75,
      costTracked: true,
      completedAt: COMPLETED_AT,
    }
    const written = await writeWorkflowCompletionReceipt(childAssignment, receiptInput)
    const repeated = await writeWorkflowCompletionReceipt(childAssignment, {
      ...receiptInput,
      
    })
    assert.equal(repeated.completedAt, written.completedAt)
    assert.deepEqual(
      await readWorkflowCompletionReceipt(childAssignment, {
        taskId: 'task-one',
        rootRunId: 'root-run',
        childRunId: 'child-run',
      }),
      written,
    )

    await assert.rejects(
      writeWorkflowCompletionReceipt(childAssignment, {
        ...receiptInput,
        summary: 'A conflicting completion.',
      }),
      hasStoreCode('already_exists'),
    )
    fs.writeFileSync(artifactPath, '# Modified report\n')
    await assert.rejects(
      readWorkflowCompletionReceipt(childAssignment),
      hasStoreCode('artifact_invalid'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('artifact helpers reject traversal, assignment mismatches, and symlink escapes', async () => {
  const workspace = makeWorkspace()
  try {
    const childAssignment = path.join(workspace, 'assignments', 'child-run')
    fs.mkdirSync(childAssignment, { recursive: true })
    const outsidePath = path.join(workspace, 'outside.md')
    fs.writeFileSync(outsidePath, 'outside')

    await assert.rejects(
      createWorkflowArtifactReference({
        childAssignmentPath: childAssignment,
        childRunId: 'child-run',
        relativePath: '../outside.md',
      }),
      (error: unknown) => error instanceof WorkflowStateStoreError,
    )
    fs.symlinkSync(outsidePath, path.join(childAssignment, 'linked.md'))
    await assert.rejects(
      createWorkflowArtifactReference({
        childAssignmentPath: childAssignment,
        childRunId: 'child-run',
        relativePath: 'linked.md',
      }),
      hasStoreCode('artifact_invalid'),
    )
    await assert.rejects(
      createWorkflowArtifactReference({
        childAssignmentPath: childAssignment,
        childRunId: 'other-child',
        relativePath: 'linked.md',
      }),
      hasStoreCode('identity_mismatch'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('recovery classification and terminal task mapping are deterministic', async () => {
  const workspace = makeWorkspace()
  try {
    const safeStore = makeStore(rootAssignmentPath(workspace))
    const safe = await safeStore.initialize(initializationInput())
    assert.equal(classifyWorkflowRecovery(safe.state).disposition, 'automatic')

    const manual = cloneState(safe.state)
    manual.status = 'interrupted'
    manual.currentStepId = 'research'
    manual.steps[0]!.status = 'interrupted'
    manual.steps[0]!.attemptCount = 1
    manual.steps[0]!.recoveryPolicy = 'manual'
    assert.equal(classifyWorkflowRecovery(manual).disposition, 'manual')

    const neverRetry = cloneState(manual)
    neverRetry.steps[0]!.recoveryPolicy = 'never_retry'
    assert.equal(classifyWorkflowRecovery(neverRetry).disposition, 'not_resumable')

    const childAssignment = path.join(workspace, 'assignments', 'child-run')
    fs.mkdirSync(childAssignment, { recursive: true })
    await writeWorkflowCompletionReceipt(childAssignment, {
      taskId: safe.manifest.taskId,
      rootRunId: safe.manifest.rootRunId,
      workflowId: safe.manifest.workflowId,
      stepId: 'research',
      childRunId: 'child-run',
      executionAttemptId: 'attempt-one',
      status: 'failed',
      summary: 'The child completed with a durable failure.',
      costUsd: 0,
      completedAt: COMPLETED_AT,
    })
    assert.equal(
      (
        await classifyWorkflowRecoveryWithReceipts(
          rootAssignmentPath(workspace),
          { manifest: safe.manifest, state: manual },
        )
      ).disposition,
      'automatic',
    )
    assert.equal(
      (
        await classifyWorkflowRecoveryWithReceipts(
          rootAssignmentPath(workspace),
          { manifest: safe.manifest, state: neverRetry },
        )
      ).disposition,
      'automatic',
    )

    const idempotent = cloneState(manual)
    idempotent.steps[0]!.recoveryPolicy = 'idempotent'
    idempotent.steps[0]!.idempotencyKey = 'root-run/research'
    assert.equal(classifyWorkflowRecovery(idempotent).disposition, 'automatic')

    assert.equal(terminalTaskStatusForWorkflow('completed'), 'done')
    assert.equal(terminalTaskStatusForWorkflow('completed_with_warnings'), 'done')
    assert.equal(terminalTaskStatusForWorkflow('blocked'), 'blocked')
    assert.equal(terminalTaskStatusForWorkflow('failed'), 'failed')
    assert.equal(terminalTaskStatusForWorkflow('cancelled'), 'cancelled')
    assert.equal(terminalTaskStatusForWorkflow('running'), null)
    assert.equal(terminalTaskStatusForWorkflow('interrupted'), null)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a live cross-process lock times out without deleting the owner lock', async () => {
  const workspace = makeWorkspace()
  try {
    const assignmentPath = rootAssignmentPath(workspace)
    const store = new FileSystemWorkflowStateStore(assignmentPath, {
      now: () => new Date(UPDATED_AT),
      randomUUID: () => 'child-run',
      lockTimeoutMs: 25,
      lockRetryMs: 5,
    })
    fs.mkdirSync(store.paths.privateRuntimePath, { recursive: true })
    const lockRecord = {
      pid: process.pid,
      nonce: 'other-owner',
      createdAt: CREATED_AT,
    }
    fs.writeFileSync(store.paths.lockPath, JSON.stringify(lockRecord))

    await assert.rejects(
      store.initialize(initializationInput()),
      hasStoreCode('lock_timeout'),
    )
    assert.ok(fs.existsSync(store.paths.lockPath))
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

// ─── Waiting for a model-choice decision ────────────────────────────────────
//
// An unattended execution must never consent on the user's behalf, so an
// eligible model failure suspends the run instead of ending it. This is the
// durable half: the condition exists, carries exactly the offer the user will
// be shown, and cannot reach a result without running again.

const WAITING_OFFER = {
  offerId: 'offer-1',
  scope: { kind: 'task' as const, sessionId: 'product-session', taskId: 'task-one' },
  agentName: 'reviewer',
  expectedRevision: 'running|||0',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
  reason: 'missing-credential' as const,
}

const WAITING_APPROVAL = {
  offerId: 'offer-1',
  agentName: 'reviewer',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
}

test('a workflow can wait on a model-choice decision and say what it is waiting for', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    await store.update({
      expectedRevision: 0,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.steps[0]!.status = 'launching'
        draft.steps[0]!.attemptCount = 1
        draft.steps[0]!.startedAt = UPDATED_AT
      },
    })
    await store.update({
      expectedRevision: 1,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.steps[0]!.status = 'running'
      },
    })

    await store.update({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'awaiting_model_choice'
        draft.steps[0]!.status = 'awaiting_model_choice'
        draft.steps[0]!.modelChoice = WAITING_OFFER
      },
    })

    // Read back from disk, because that is what a replacement process sees.
    const reopened = await makeStore(rootAssignmentPath(workspace)).requireSnapshot()
    assert.equal(reopened.state.status, 'awaiting_model_choice')
    assert.equal(reopened.state.steps[0]?.status, 'awaiting_model_choice')
    assert.deepEqual(reopened.state.steps[0]?.modelChoice, WAITING_OFFER)
    // A wait is not a terminal state, so no task outcome is reconciled from it.
    assert.equal(terminalTaskStatusForWorkflow(reopened.state.status), null)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a waiting workflow cannot reach a result without running again', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }
    await store.update({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'awaiting_model_choice'
        draft.steps[0]!.status = 'awaiting_model_choice'
        draft.steps[0]!.modelChoice = WAITING_OFFER
      },
    })

    // Completing from here would let a generic exit path finish a run nobody
    // authorized. Asserted on the transition itself, not merely on "some
    // rejection": a run that stops for an unrelated consistency rule would
    // satisfy a bare rejects() while the guard that matters was absent.
    await assert.rejects(
      store.update({
        expectedRevision: 3,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.status = 'completed'
          draft.steps[0]!.status = 'completed'
          draft.steps[0]!.completedAt = COMPLETED_AT
        },
      }),
      (error: unknown) =>
        hasStoreCode('invalid_state')(error) &&
        /Illegal workflow (step )?transition 'awaiting_model_choice' -> 'completed'/.test(
          error instanceof Error ? error.message : '',
        ),
    )
    assert.equal((await store.requireSnapshot()).state.revision, 3)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a waiting step must record the offer it is waiting on', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }

    // A wait with nothing to approve is a run that can never move again.
    await assert.rejects(
      store.update({
        expectedRevision: 2,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.status = 'awaiting_model_choice'
          draft.steps[0]!.status = 'awaiting_model_choice'
        },
      }),
      hasStoreCode('invalid_state'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('an approval replaces the question rather than sitting beside it', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }
    await store.update({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'awaiting_model_choice'
        draft.steps[0]!.status = 'awaiting_model_choice'
        draft.steps[0]!.modelChoice = WAITING_OFFER
      },
    })

    // Both live at once would leave no way to say whether the user decided.
    await assert.rejects(
      store.update({
        expectedRevision: 3,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.approvedModelChoice = WAITING_APPROVAL
        },
      }),
      hasStoreCode('invalid_state'),
    )

    await store.update({
      expectedRevision: 3,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'running'
        draft.steps[0]!.status = 'running'
        delete draft.steps[0]!.modelChoice
        draft.steps[0]!.approvedModelChoice = WAITING_APPROVAL
      },
    })

    const reopened = await makeStore(rootAssignmentPath(workspace)).requireSnapshot()
    assert.equal(reopened.state.steps[0]?.modelChoice, undefined)
    assert.deepEqual(reopened.state.steps[0]?.approvedModelChoice, WAITING_APPROVAL)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a refresh replaces one exact offer, and a stale one replaces nothing', async () => {
  // Two refreshes can race: a person retries a stale approval twice, or a tab
  // that has been open a while posts after another already moved the offer on.
  // The second must not overwrite the first, or the offer a user is looking at
  // stops being the offer the run is waiting on. Fenced on the offer being
  // replaced as well as the revision, because a revision alone cannot say
  // *which* question is being answered.
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }
    await store.update({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'awaiting_model_choice'
        draft.steps[0]!.status = 'awaiting_model_choice'
        draft.steps[0]!.modelChoice = WAITING_OFFER
      },
    })

    const refreshed = await store.refreshModelChoiceOffer({
      expectedRevision: 3,
      offerId: WAITING_OFFER.offerId,
      proposedDefault: { provider: 'connection:xyz', model: 'gpt-5.6-sol' },
    })
    assert.notEqual(refreshed.offer.offerId, WAITING_OFFER.offerId)
    assert.deepEqual(refreshed.offer.proposedDefault, {
      provider: 'connection:xyz',
      model: 'gpt-5.6-sol',
    })
    assert.equal(refreshed.offer.expectedRevision, '3')
    // What the offer is *about* is carried over rather than recomputed.
    assert.equal(refreshed.offer.agentName, WAITING_OFFER.agentName)
    assert.equal(refreshed.offer.reason, WAITING_OFFER.reason)
    assert.deepEqual(refreshed.offer.failedChoice, WAITING_OFFER.failedChoice)
    assert.deepEqual(refreshed.offer.scope, WAITING_OFFER.scope)
    assert.equal(refreshed.stepId, 'research')

    const reopened = await makeStore(rootAssignmentPath(workspace)).requireSnapshot()
    assert.equal(reopened.state.status, 'awaiting_model_choice')
    assert.equal(reopened.state.steps[0]?.status, 'awaiting_model_choice')
    assert.deepEqual(reopened.state.steps[0]?.modelChoice, refreshed.offer)

    // The replaced offer names nothing now, at the revision it was replaced at
    // or at the current one.
    await assert.rejects(
      store.refreshModelChoiceOffer({
        expectedRevision: 3,
        offerId: WAITING_OFFER.offerId,
        proposedDefault: { provider: 'connection:zzz', model: 'gpt-5.7' },
      }),
      hasStoreCode('revision_conflict'),
    )
    await assert.rejects(
      store.refreshModelChoiceOffer({
        expectedRevision: refreshed.revision,
        offerId: WAITING_OFFER.offerId,
        proposedDefault: { provider: 'connection:zzz', model: 'gpt-5.7' },
      }),
      hasStoreCode('invalid_state'),
    )

    // And the offer on disk is still the one the first refresh wrote.
    const settled = await makeStore(rootAssignmentPath(workspace)).requireSnapshot()
    assert.deepEqual(settled.state.steps[0]?.modelChoice, refreshed.offer)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('one approval admits one continuation, and only while it is unconsumed', async () => {
  // Approval and admission are separate, and the gap between them is where a
  // second admission can appear: a retransmitted request, or a queue that runs
  // the continuation twice. The file lock fences two simultaneous claims; it
  // does nothing about a later caller that rereads the state and claims the
  // same approval again under a fresh attempt.
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }
    await store.update({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.status = 'running'
        draft.steps[0]!.status = 'running'
        draft.steps[0]!.approvedModelChoice = WAITING_APPROVAL
      },
    })

    const claimed = await store.claimModelChoiceContinuation({
      expectedRevision: 3,
      stepId: 'research',
      expectedOwnerExecutionAttemptId: 'attempt-one',
      nextExecutionAttemptId: 'attempt-two',
      continuationAdmissionRequestId: 'admission-1',
    })
    assert.equal(claimed.ownerExecutionAttemptId, 'attempt-two')
    // The exact admission that authorized this continuation, on the step it
    // authorized. Ownership alone cannot say which request moved it.
    assert.equal(
      claimed.steps[0]?.modelChoiceContinuationAdmissionRequestId,
      'admission-1',
    )

    // A second admission, with the revision and owner it would genuinely read
    // back. Refused because the approval it names has already been spent.
    await assert.rejects(
      store.claimModelChoiceContinuation({
        expectedRevision: claimed.revision,
        stepId: 'research',
        expectedOwnerExecutionAttemptId: 'attempt-two',
        nextExecutionAttemptId: 'attempt-three',
        continuationAdmissionRequestId: 'admission-2',
      }),
      hasStoreCode('revision_conflict'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a settled step cannot be continued, and gets no admission written onto it', async () => {
  // Two approvals in one run. The first step was approved, continued and
  // finished; the second later earns its own approval. Nothing may reach back
  // for the first: claiming it would overwrite a settled record and leave the
  // step that is actually waiting exactly where it was.
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(
      initializationInput({ includeHumanInputStep: true, childRunId: 'research-run' }),
    )
    let revision = 0
    const advance = async (mutate: (draft: DurableWorkflowState) => void) => {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate,
      })
      revision += 1
    }
    await advance((draft) => {
      draft.steps[0]!.status = 'launching'
      draft.steps[0]!.attemptCount = 1
      draft.steps[0]!.startedAt = UPDATED_AT
    })
    await advance((draft) => {
      draft.steps[0]!.status = 'running'
    })
    // Approved, then run to completion by the attempt that already owned it —
    // so the approval is still on the step and no admission was ever needed.
    // This is the shape the consumed-admission guard cannot catch.
    await advance((draft) => {
      draft.steps[0]!.approvedModelChoice = WAITING_APPROVAL
    })
    await advance((draft) => {
      draft.steps[0]!.status = 'completed'
      draft.steps[0]!.completedAt = UPDATED_AT
      draft.steps[0]!.artifact = {
        childRunId: 'research-run',
        relativePath: 'report.md',
        sha256: hashWorkflowContent('round one report'),
        byteLength: 1,
      }
    })

    // A settled step is not waiting on anything, whatever it still records.
    await assert.rejects(
      store.claimModelChoiceContinuation({
        expectedRevision: revision,
        stepId: 'research',
        expectedOwnerExecutionAttemptId: 'attempt-one',
        nextExecutionAttemptId: 'attempt-two',
        continuationAdmissionRequestId: 'admission-b',
      }),
      hasStoreCode('revision_conflict'),
    )
    const reopened = await makeStore(rootAssignmentPath(workspace)).requireSnapshot()
    assert.equal(
      reopened.state.steps[0]?.status,
      'completed',
      'the settled step is left exactly as it was',
    )
    assert.equal(
      reopened.state.steps[0]?.modelChoiceContinuationAdmissionRequestId,
      undefined,
      'no admission was written onto a step that was not waiting',
    )
    assert.equal(reopened.state.ownerExecutionAttemptId, 'attempt-one')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a continuation receipt is once-only authority, not editable metadata', async () => {
  // The receipt is what makes an approval spent. If an ordinary update can
  // clear or replace it, the same approval can be admitted a second time under
  // a new attempt — which is the exact thing the claim refuses to do directly.
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }
    await store.update({
      expectedRevision: 2,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.steps[0]!.approvedModelChoice = WAITING_APPROVAL
      },
    })
    const claimed = await store.claimModelChoiceContinuation({
      expectedRevision: 3,
      stepId: 'research',
      expectedOwnerExecutionAttemptId: 'attempt-one',
      nextExecutionAttemptId: 'attempt-two',
      continuationAdmissionRequestId: 'admission-1',
    })

    for (const [description, mutate] of [
      ['cleared', (draft: DurableWorkflowState) => {
        delete draft.steps[0]!.modelChoiceContinuationAdmissionRequestId
      }],
      ['replaced', (draft: DurableWorkflowState) => {
        draft.steps[0]!.modelChoiceContinuationAdmissionRequestId = 'admission-2'
      }],
    ] as const) {
      await assert.rejects(
        store.update({
          expectedRevision: claimed.revision,
          executionAttemptId: 'attempt-two',
          mutate,
        }),
        hasStoreCode('invalid_state'),
        `a receipt that can be ${description} is not authority`,
      )
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a restored continuation receipt is read as a receipt or not at all', async () => {
  // History comes back from disk. A receipt that is not a readable identifier,
  // or one standing on its own with no approval behind it, marks an approval
  // spent on the strength of a value nothing wrote.
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }

    await assert.rejects(
      store.update({
        expectedRevision: 2,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          // No approval behind it: a receipt for a decision nobody made.
          draft.steps[0]!.modelChoiceContinuationAdmissionRequestId = 'admission-1'
        },
      }),
      hasStoreCode('invalid_state'),
    )
    await assert.rejects(
      store.update({
        expectedRevision: 2,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.approvedModelChoice = WAITING_APPROVAL
          draft.steps[0]!.modelChoiceContinuationAdmissionRequestId = '../admission'
        },
      }),
      hasStoreCode('invalid_state'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('an approval that proposes the pair that already failed is refused', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }

    await assert.rejects(
      store.update({
        expectedRevision: 2,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.approvedModelChoice = {
            ...WAITING_APPROVAL,
            proposedDefault: { ...WAITING_APPROVAL.failedChoice },
          }
        },
      }),
      hasStoreCode('invalid_state'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

async function waitingStore(workspace: string) {
  const store = makeStore(rootAssignmentPath(workspace))
  await store.initialize(initializationInput())
  for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
    await store.update({
      expectedRevision: revision,
      executionAttemptId: 'attempt-one',
      mutate(draft) {
        draft.steps[0]!.status = status
        draft.steps[0]!.attemptCount = 1
        draft.steps[0]!.startedAt = UPDATED_AT
      },
    })
  }
  await store.update({
    expectedRevision: 2,
    executionAttemptId: 'attempt-one',
    mutate(draft) {
      draft.status = 'awaiting_model_choice'
      draft.steps[0]!.status = 'awaiting_model_choice'
      draft.steps[0]!.modelChoice = WAITING_OFFER
    },
  })
  return store
}

test('leaving the wait requires the approval that answers the offer', async () => {
  const workspace = makeWorkspace()
  try {
    const store = await waitingStore(workspace)

    // Deleting the question and calling it an answer.
    await assert.rejects(
      store.update({
        expectedRevision: 3,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.status = 'running'
          draft.steps[0]!.status = 'running'
          delete draft.steps[0]!.modelChoice
        },
      }),
      hasStoreCode('invalid_state'),
    )

    // A well-formed approval for a different offer is still not this one.
    await assert.rejects(
      store.update({
        expectedRevision: 3,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.status = 'running'
          draft.steps[0]!.status = 'running'
          delete draft.steps[0]!.modelChoice
          draft.steps[0]!.approvedModelChoice = {
            ...WAITING_APPROVAL,
            offerId: 'a-different-offer',
          }
        },
      }),
      hasStoreCode('invalid_state'),
    )

    // An approval for a different Agent, with everything else matching.
    await assert.rejects(
      store.update({
        expectedRevision: 3,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.status = 'running'
          draft.steps[0]!.status = 'running'
          delete draft.steps[0]!.modelChoice
          draft.steps[0]!.approvedModelChoice = {
            ...WAITING_APPROVAL,
            agentName: 'somebody-else',
          }
        },
      }),
      hasStoreCode('invalid_state'),
    )

    // And an approval that quietly changes the pair the user was shown.
    await assert.rejects(
      store.update({
        expectedRevision: 3,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.status = 'running'
          draft.steps[0]!.status = 'running'
          delete draft.steps[0]!.modelChoice
          draft.steps[0]!.approvedModelChoice = {
            ...WAITING_APPROVAL,
            proposedDefault: { provider: 'connection:abc', model: 'gpt-5.6-sol' },
          }
        },
      }),
      hasStoreCode('invalid_state'),
    )

    assert.equal((await store.requireSnapshot()).state.revision, 3)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a workflow cannot claim to be waiting when no step is', async () => {
  const workspace = makeWorkspace()
  try {
    const store = makeStore(rootAssignmentPath(workspace))
    await store.initialize(initializationInput())
    for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
      await store.update({
        expectedRevision: revision,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.steps[0]!.status = status
          draft.steps[0]!.attemptCount = 1
          draft.steps[0]!.startedAt = UPDATED_AT
        },
      })
    }

    // A run that says it is waiting, with nothing to approve anywhere in it,
    // is a run no approval can ever release.
    await assert.rejects(
      store.update({
        expectedRevision: 2,
        executionAttemptId: 'attempt-one',
        mutate(draft) {
          draft.status = 'awaiting_model_choice'
        },
      }),
      hasStoreCode('invalid_state'),
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a persisted offer must be a complete offer for this run', async () => {
  const workspace = makeWorkspace()
  try {
    const malformed = [
      ['no session in scope', { scope: { kind: 'task', taskId: 'task-one' } }],
      ['no task in scope', { scope: { kind: 'task', sessionId: 'product-session' } }],
      [
        'another run entirely',
        { scope: { kind: 'task', sessionId: 'other-session', taskId: 'other-task' } },
      ],
      ['no eligibility reason', { reason: undefined }],
      ['an unknown eligibility reason', { reason: 'because-i-said-so' }],
      ['a non-string invocation id', { logicalInvocationId: 7 }],
    ] as const

    for (const [label, patch] of malformed) {
      const store = makeStore(rootAssignmentPath(workspace, `root-${label.replace(/\W+/g, '-')}`))
      await store.initialize(
        initializationInput({ rootRunId: `root-${label.replace(/\W+/g, '-')}` }),
      )
      for (const [revision, status] of [[0, 'launching'], [1, 'running']] as const) {
        await store.update({
          expectedRevision: revision,
          executionAttemptId: 'attempt-one',
          mutate(draft) {
            draft.steps[0]!.status = status
            draft.steps[0]!.attemptCount = 1
            draft.steps[0]!.startedAt = UPDATED_AT
          },
        })
      }
      await assert.rejects(
        store.update({
          expectedRevision: 2,
          executionAttemptId: 'attempt-one',
          mutate(draft) {
            draft.status = 'awaiting_model_choice'
            draft.steps[0]!.status = 'awaiting_model_choice'
            draft.steps[0]!.modelChoice = {
              ...WAITING_OFFER,
              ...patch,
            } as typeof WAITING_OFFER
          },
        }),
        hasStoreCode('invalid_state'),
        label,
      )
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
