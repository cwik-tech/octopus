import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import type {
  DurableWorkflowState,
  DurableWorkflowStepState,
} from '../../workflows/types.js'
import {
  isWorkflowBaselineEligible,
  validateWorkflowJournalStream,
  workflowJournalStreamId,
  WORKFLOW_BASELINE_EVENT_TYPE,
  WORKFLOW_SNAPSHOT_EVENT_TYPE,
  WorkflowJournalError,
} from '../../workflows/workflow-journal.js'

const STREAM_ID = workflowJournalStreamId('task-one', 'research-workflow')

function makeState(
  overrides: Partial<DurableWorkflowState> = {},
): DurableWorkflowState {
  return {
    schemaVersion: 2,
    revision: 0,
    taskId: 'task-one',
    sessionId: 'product-session',
    rootRunId: 'root-run',
    workflowId: 'research-workflow',
    ownerExecutionAttemptId: 'attempt-one',
    status: 'running',
    totalCostUsd: 0,
    recoveryCount: 0,
    createdAt: '2026-08-17T12:00:00.000Z',
    updatedAt: '2026-08-17T12:00:01.000Z',
    steps: [],
    ...overrides,
  }
}

function makeEvent(
  state: DurableWorkflowState,
  sequence: number,
  type: string = WORKFLOW_SNAPSHOT_EVENT_TYPE,
): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    recordedAt: '2026-08-17T12:00:01.000Z',
    scopeKind: 'assignment',
    scopeId: 'root-run',
    tenantId: 'local',
    streamKind: 'workflow.state',
    streamId: STREAM_ID,
    streamRevision: sequence,
    type,
    payloadSchemaVersion: 1,
    appendRequestDigest: 'cd'.repeat(32),
    correlationId: STREAM_ID,
    previousEventHash: 'ab'.repeat(32),
    eventHash: 'ef'.repeat(32),
    payload: { state } as unknown as CanonicalJsonObject,
  }
}

test('a strictly increasing snapshot stream validates and returns the latest state', () => {
  const events = [
    makeEvent(makeState({ revision: 0 }), 1),
    makeEvent(makeState({ revision: 1 }), 2),
    makeEvent(makeState({ revision: 2, status: 'completed' }), 3),
  ]
  const { state, lastSequence } = validateWorkflowJournalStream(events, STREAM_ID)
  assert.equal(state.revision, 2)
  assert.equal(state.status, 'completed')
  assert.equal(lastSequence, 3)
})

test('a non-increasing revision fails closed', () => {
  const events = [
    makeEvent(makeState({ revision: 0 }), 1),
    makeEvent(makeState({ revision: 0 }), 2),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'revision_conflict',
  )
})

test('an owner change without a recovery bump or continuation fails closed', () => {
  const events = [
    makeEvent(makeState({ revision: 0 }), 1),
    makeEvent(
      makeState({ revision: 1, ownerExecutionAttemptId: 'attacker' }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

test('a recovery claim that bumps the recovery count is legitimate', () => {
  const events = [
    makeEvent(makeState({ revision: 0 }), 1),
    makeEvent(
      makeState({
        revision: 1,
        ownerExecutionAttemptId: 'attempt-two',
        recoveryCount: 1,
        status: 'interrupted',
      }),
      2,
    ),
  ]
  const { state } = validateWorkflowJournalStream(events, STREAM_ID)
  assert.equal(state.ownerExecutionAttemptId, 'attempt-two')
  assert.equal(state.recoveryCount, 1)
})

test('a human-input continuation handoff without a recovery bump is legitimate', () => {
  const events = [
    makeEvent(makeState({ revision: 0, status: 'awaiting_input' }), 1),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'continuation-attempt',
        steps: [
          {
            stepId: 'human-feedback',
            stepIndex: 0,
            stepType: 'human-in-the-loop',
            definitionHash: 'hash',
            status: 'awaiting_input',
            recoveryPolicy: 'never_retry',
            childRunId: 'child-run',
            inputArtifact: 'in.md',
            resultArtifact: 'out.json',
            requestedResultType: 'artifact:out.json',
            attemptCount: 1,
            costUsd: 0,
            humanInput: {
              interactionId: 'interaction-1',
              taskId: 'task-one',
              sessionId: 'product-session',
              workflowId: 'research-workflow',
              stepId: 'human-feedback',
              ownerExecutionAttemptId: 'continuation-attempt',
              sourceArtifact: {
                childRunId: 'child-run',
                relativePath: 'in.md',
                sha256: 'aa'.repeat(32),
                byteLength: 10,
              },
              successorStepId: 'next',
              eligibleRecipients: [],
              requestedAt: '2026-08-17T12:00:00.000Z',
              status: 'submitted',
              continuationAdmissionRequestId: 'admission-1',
            },
          },
        ],
      }),
      2,
    ),
  ]
  const { state } = validateWorkflowJournalStream(events, STREAM_ID)
  assert.equal(state.ownerExecutionAttemptId, 'continuation-attempt')
})

/**
 * The two adjacent journal states an approved model choice really produces.
 *
 * `approveModelChoice` publishes the approval under the *old* owner with the
 * workflow and the step both `running`. `claimModelChoiceContinuation` then
 * publishes the new owner with the workflow still `running`, the approved step
 * moved to `interrupted`, and the continuation admission added. So the handoff
 * the fence actually sees is `running -> running`, never
 * `awaiting_model_choice -> running`.
 */
const APPROVAL = {
  offerId: 'offer-1',
  agentName: 'defaultrecoveryworker',
  logicalInvocationId: 'finalize',
  failedChoice: { provider: 'connection:absent', model: 'fake/never-configured' },
  proposedDefault: { provider: 'connection:fixture', model: 'fake/app-default' },
} as const

function continuationStep(
  overrides: Partial<DurableWorkflowStepState> = {},
): DurableWorkflowStepState {
  return {
    stepId: 'finalize',
    stepIndex: 1,
    stepType: 'agent',
    definitionHash: 'hash',
    status: 'running',
    recoveryPolicy: 'manual',
    childRunId: 'child-run',
    inputArtifact: 'in.md',
    resultArtifact: 'final.md',
    requestedResultType: 'artifact:final.md',
    attemptCount: 1,
    costUsd: 0,
    approvedModelChoice: { ...APPROVAL },
    ...overrides,
  }
}

/** A second, ordinary step, so "the run is on another step" names a real one. */
function publishStep(): DurableWorkflowStepState {
  return {
    stepId: 'publish',
    stepIndex: 2,
    stepType: 'agent',
    definitionHash: 'hash',
    status: 'pending',
    recoveryPolicy: 'manual',
    childRunId: 'publish-run',
    inputArtifact: 'final.md',
    resultArtifact: 'published.md',
    requestedResultType: 'artifact:published.md',
    attemptCount: 0,
    costUsd: 0,
  }
}

/** The same step before any approval was recorded on it. */
function stepWithoutApproval(): DurableWorkflowStepState {
  const step = continuationStep()
  delete step.approvedModelChoice
  return step
}

/** The state `approveModelChoice` leaves behind, under the failed attempt. */
function approvedUnderOldOwner(): DurableWorkflowState {
  return makeState({
    revision: 0,
    status: 'running',
    ownerExecutionAttemptId: 'attempt-one',
    currentStepId: 'finalize',
    steps: [continuationStep()],
  })
}

test('an approved model-choice continuation may take ownership', () => {
  const events = [
    makeEvent(approvedUnderOldOwner(), 1),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'continuation-attempt',
        currentStepId: 'finalize',
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
        ],
      }),
      2,
    ),
  ]
  const { state } = validateWorkflowJournalStream(events, STREAM_ID)
  assert.equal(state.ownerExecutionAttemptId, 'continuation-attempt')
})

test('an owner change that adds no continuation admission fails closed', () => {
  const events = [
    makeEvent(approvedUnderOldOwner(), 1),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'finalize',
        steps: [continuationStep({ status: 'interrupted' })],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// The approval must already be in the record the new owner inherits. An event
// that both grants the permission and claims it is a new owner writing its own
// authorization, which is the whole thing this fence exists to prevent.
test('an owner change that introduces the approval itself fails closed', () => {
  const priorWithoutApproval = makeState({
    revision: 0,
    status: 'running',
    ownerExecutionAttemptId: 'attempt-one',
    currentStepId: 'finalize',
    steps: [stepWithoutApproval()],
  })
  const events = [
    makeEvent(priorWithoutApproval, 1),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'finalize',
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// One approval authorizes one continuation. A step that already carries an
// admission has already been claimed, so a second owner claiming the same
// approval is refused — and refused on the admission itself, not on the step
// status that happens to accompany it in a well-behaved record.
test('a second owner claiming an already-admitted approval fails closed', () => {
  const alreadyClaimed = makeState({
    revision: 0,
    status: 'running',
    ownerExecutionAttemptId: 'attempt-one',
    currentStepId: 'finalize',
    steps: [
      continuationStep({
        modelChoiceContinuationAdmissionRequestId: 'admission-1',
      }),
    ],
  })
  const events = [
    makeEvent(alreadyClaimed, 1),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'finalize',
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-2',
          }),
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// The step the continuation claims must be one an attempt was actually lost
// on. A step that already produced its result is not waiting for anything, and
// an approval sitting on it is not a licence to run it again.
test('an owner change claiming a step that already finished fails closed', () => {
  const events = [
    makeEvent(
      makeState({
        revision: 0,
        status: 'running',
        ownerExecutionAttemptId: 'attempt-one',
        currentStepId: 'finalize',
        steps: [continuationStep({ status: 'completed' })],
      }),
      1,
    ),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'finalize',
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// The claimed step has to be the step the run is on, both before and after.
// Without that, an untouched approval sitting on some other step is enough to
// hand ownership over while the run is somewhere else entirely.
test('an owner change claiming a step the run is not on fails closed', () => {
  const elsewhere = makeState({
    revision: 0,
    status: 'running',
    ownerExecutionAttemptId: 'attempt-one',
    currentStepId: 'publish',
    steps: [continuationStep(), publishStep()],
  })
  const events = [
    makeEvent(elsewhere, 1),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'publish',
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
          publishStep(),
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// The new owner does not get to say which step it is continuing. If only the
// claiming event named the step, an attacker could move the run onto the step
// whose approval it wants and claim it in the same breath.
test('an owner change that moves the run onto the step it claims fails closed', () => {
  const events = [
    makeEvent(
      makeState({
        revision: 0,
        status: 'running',
        ownerExecutionAttemptId: 'attempt-one',
        currentStepId: 'publish',
        steps: [continuationStep(), publishStep()],
      }),
      1,
    ),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'finalize',
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
          publishStep(),
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// A recovery bump is enough on its own to hand ownership over, so an event
// that bumps it *and* claims an approval would never reach a single
// model-choice check. That is the whole fence bypassed by incrementing a
// counter, so claiming a receipt has to be judged as what it is.
test('a recovery bump that also claims an approval fails closed', () => {
  const events = [
    makeEvent(
      makeState({
        revision: 0,
        status: 'running',
        ownerExecutionAttemptId: 'attempt-one',
        currentStepId: 'finalize',
        recoveryCount: 0,
        steps: [stepWithoutApproval()],
      }),
      1,
    ),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'finalize',
        recoveryCount: 1,
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// A continuation is not a recovery: its recovery count is carried across
// unchanged, and a handoff that also rewrites that count is not one.
test('an approved continuation that also bumps the recovery count fails closed', () => {
  const events = [
    makeEvent(
      makeState({
        revision: 0,
        status: 'running',
        ownerExecutionAttemptId: 'attempt-one',
        currentStepId: 'finalize',
        recoveryCount: 0,
        steps: [continuationStep()],
      }),
      1,
    ),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'finalize',
        recoveryCount: 1,
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// One approval authorizes one continuation, and the two checks either side of
// this — "a receipt was added" and "the current step's receipt is valid" — are
// separate `some()` scans. An event that satisfies the second on the current
// step can smuggle a second new receipt onto another step and have it accepted
// with everything else.
test('an owner change that adds a second receipt elsewhere fails closed', () => {
  const events = [
    makeEvent(
      makeState({
        revision: 0,
        status: 'running',
        ownerExecutionAttemptId: 'attempt-one',
        currentStepId: 'finalize',
        steps: [continuationStep(), publishStep()],
      }),
      1,
    ),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'continuation-attempt',
        currentStepId: 'finalize',
        steps: [
          continuationStep({
            status: 'interrupted',
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
          {
            ...publishStep(),
            modelChoiceContinuationAdmissionRequestId: 'admission-smuggled',
          },
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

test('an owner change that rewrites the approved pair fails closed', () => {
  const events = [
    makeEvent(approvedUnderOldOwner(), 1),
    makeEvent(
      makeState({
        revision: 1,
        status: 'running',
        ownerExecutionAttemptId: 'attacker',
        currentStepId: 'finalize',
        steps: [
          continuationStep({
            status: 'interrupted',
            approvedModelChoice: {
              ...APPROVAL,
              proposedDefault: {
                provider: 'connection:fixture',
                model: 'fake/something-else',
              },
            },
            modelChoiceContinuationAdmissionRequestId: 'admission-1',
          }),
        ],
      }),
      2,
    ),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'ownership_conflict',
  )
})

// The fence dereferences `approvedModelChoice.failedChoice` and
// `.proposedDefault`. A record that carries the field but not those objects is
// corrupt journal content, and corrupt content must be reported as such rather
// than thrown as a raw TypeError from inside a comparison.
test('a malformed durable approval fails closed as corrupt', () => {
  const malformed = makeState({
    revision: 0,
    status: 'running',
    currentStepId: 'finalize',
    steps: [continuationStep()],
  })
  const brokenStep = malformed.steps[0] as unknown as Record<string, unknown>
  brokenStep.approvedModelChoice = { offerId: 'offer-1', agentName: 'writer' }
  assert.throws(
    () => validateWorkflowJournalStream([makeEvent(malformed, 1)], STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError && error.code === 'corrupt',
  )
})

test('a stream identity change between events fails closed', () => {
  const events = [
    makeEvent(makeState({ revision: 0 }), 1),
    makeEvent(makeState({ revision: 1, taskId: 'other-task' }), 2),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'identity_mismatch',
  )
})

test('a baseline event is only valid as the single first event', () => {
  const validBaseline = [
    makeEvent(makeState({ revision: 0 }), 1, WORKFLOW_BASELINE_EVENT_TYPE),
    makeEvent(makeState({ revision: 1 }), 2),
  ]
  const { state } = validateWorkflowJournalStream(validBaseline, STREAM_ID)
  assert.equal(state.revision, 1)

  const lateBaseline = [
    makeEvent(makeState({ revision: 0 }), 1),
    makeEvent(makeState({ revision: 1 }), 2, WORKFLOW_BASELINE_EVENT_TYPE),
  ]
  assert.throws(
    () => validateWorkflowJournalStream(lateBaseline, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError &&
      error.code === 'invalid_baseline',
  )
})

test('an unexpected event type fails closed', () => {
  const events = [makeEvent(makeState({ revision: 0 }), 1, 'workflow.other')]
  assert.throws(
    () => validateWorkflowJournalStream(events, STREAM_ID),
    (error: unknown) =>
      error instanceof WorkflowJournalError && error.code === 'invalid_event',
  )
})

/**
 * Owner fencing reads into each step, so a payload whose steps are not
 * objects must be rejected as corruption rather than dereferenced.
 */
test('validateWorkflowJournalStream fails closed on malformed step entries', () => {
  for (const steps of [[null], ['not-an-object'], [1]] as unknown[][]) {
    assert.throws(
      () =>
        validateWorkflowJournalStream(
          [makeEvent({ ...makeState(), steps } as unknown as DurableWorkflowState, 1)],
          STREAM_ID,
        ),
      (error: unknown) =>
        error instanceof WorkflowJournalError && error.code === 'corrupt',
      JSON.stringify(steps),
    )
  }
})

/**
 * ADR §9: a running execution is never switched between authorities. Only a
 * workflow that has reached a terminal status may be imported as a baseline;
 * `interrupted` and `awaiting_input` are not running *right now* but are
 * resumable, so importing them would switch a live execution mid-flight.
 */
test('baseline eligibility admits terminal statuses and refuses resumable ones', () => {
  const resumable = ['running', 'awaiting_input', 'interrupted'] as const
  const terminal = [
    'completed',
    'completed_with_warnings',
    'blocked',
    'failed',
    'cancelled',
  ] as const

  for (const status of resumable) {
    assert.equal(
      isWorkflowBaselineEligible(makeState({ status })),
      false,
      status,
    )
  }
  for (const status of terminal) {
    assert.equal(
      isWorkflowBaselineEligible(makeState({ status })),
      true,
      status,
    )
  }
})
