import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  DurableWorkflowState,
  HumanInputMessage,
  HumanInputRecipient,
  HumanInputSubmission,
  WorkflowArtifactReference,
  WorkflowExecutionManifest,
} from '../../workflows/types.js'
import {
  FileSystemWorkflowStateStore,
  hashHumanInputSubmission,
  hashWorkflowContent,
  WorkflowStateStoreError,
  type InitializeWorkflowExecutionInput,
} from '../../workflows/workflow-state-store.js'

// The schema and invariant checks the store runs on the records it reads and
// on the input it is asked to persist, observed through its public operations
// against real files. Refusals are compared as `code: message` and only a
// WorkflowStateStoreError is turned into one; any other error fails the test.

const CREATED_AT = '2026-07-13T12:00:00.000Z'
const UPDATED_AT = '2026-07-13T12:00:01.000Z'
const COMPLETED_AT = '2026-07-13T12:00:02.000Z'
const OWNER = 'attempt-one'

type JsonObject = Record<string, unknown>
type StepSeed = InitializeWorkflowExecutionInput['steps'][number]

const RESEARCH_ARTIFACT: WorkflowArtifactReference = {
  childRunId: 'research-run',
  relativePath: 'research.md',
  sha256: hashWorkflowContent('research findings'),
  byteLength: Buffer.byteLength('research findings'),
}

const SECURITY_REVIEWER: HumanInputRecipient = {
  id: 'security-reviewer',
  mentionToken: 'security-reviewer',
  displayName: 'Security reviewer',
}

// Two recipients whose mention tokens differ only in letter case.
const CASE_ONLY_DUPLICATES: HumanInputRecipient[] = [
  { id: 'editor', mentionToken: 'Reviewer', displayName: 'Editor' },
  { id: 'critic', mentionToken: 'reviewer', displayName: 'Critic' },
]

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

function initialization(): InitializeWorkflowExecutionInput {
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
    steps: [
      teamStep('research', 0),
      humanInputStep('human-feedback', 1),
      teamStep('discussion-two', 2),
    ],
  }
}

function feedbackFor(recipients: string[]): HumanInputSubmission {
  const messages = [{ id: 'message-one', text: 'Please check the threat model.', recipients }]
  return {
    submissionId: 'submission-one',
    mode: 'feedback',
    messages,
    submittedAt: COMPLETED_AT,
    canonicalHash: hashHumanInputSubmission({ submissionId: 'submission-one', mode: 'feedback', messages }),
  }
}

function assignmentIn(workspace: string): string {
  return path.join(workspace, 'assignments', 'root-run')
}

async function withWorkspace<T>(run: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-state-validation-'))
  try {
    return await run(workspace)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

function openStore(assignmentPath: string): FileSystemWorkflowStateStore {
  return new FileSystemWorkflowStateStore(assignmentPath, {
    now: () => new Date(UPDATED_AT),
  })
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonObject(filePath: string): JsonObject {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!isJsonObject(value)) throw new Error(`${filePath} does not hold a JSON object.`)
  return value
}

function stepAt(state: JsonObject, index: number): JsonObject {
  const steps = state.steps
  if (!Array.isArray(steps)) throw new Error('The workflow state has no step list.')
  const step: unknown = steps[index]
  if (!isJsonObject(step)) throw new Error(`The workflow has no step at position ${index}.`)
  return step
}

/** 'accepted', or the store's refusal as `code: message`. */
async function outcome(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
    return 'accepted'
  } catch (error) {
    if (error instanceof WorkflowStateStoreError) return `${error.code}: ${error.message}`
    throw error
  }
}

/**
 * Initializes the three-step workflow in a new workspace, lets `edit` change
 * the state it persisted, writes the state back, and loads it with a new store.
 */
async function loadAfterEdit(edit: (state: JsonObject) => void): Promise<string> {
  return withWorkspace(async (workspace) => {
    const assignmentPath = assignmentIn(workspace)
    const store = openStore(assignmentPath)
    await store.initialize(initialization())
    const state = readJsonObject(store.paths.statePath)
    edit(state)
    fs.writeFileSync(store.paths.statePath, JSON.stringify(state))
    return outcome(() => openStore(assignmentPath).load())
  })
}

test('load refuses each persisted record with the code and message of the check that decides it', async () => {
  const notes: WorkflowArtifactReference = { ...RESEARCH_ARTIFACT, relativePath: 'notes.md' }
  const observed: Record<string, string> = {
    'result artifact glob that climbs out of the child run': await loadAfterEdit((state) => {
      stepAt(state, 0).resultArtifactGlobs = ['../*']
    }),
    'artifact reference without a digest': await loadAfterEdit((state) => {
      stepAt(state, 0).artifact = { ...RESEARCH_ARTIFACT, sha256: 'not-a-digest' }
    }),
    'artifacts that list one path twice': await loadAfterEdit((state) => {
      const step = stepAt(state, 0)
      step.artifact = RESEARCH_ARTIFACT
      step.artifacts = [RESEARCH_ARTIFACT, RESEARCH_ARTIFACT]
    }),
    'artifacts that are not the declared result': await loadAfterEdit((state) => {
      const step = stepAt(state, 0)
      step.artifact = notes
      step.artifacts = [notes]
    }),
  }

  assert.deepEqual(observed, {
    'result artifact glob that climbs out of the child run':
      "invalid_state: Workflow step 'research' result artifact glob must be a safe bounded artifact glob.",
    'artifact reference without a digest':
      "invalid_state: Workflow step 'research' artifact hash must be a lowercase SHA-256 digest.",
    'artifacts that list one path twice':
      "invalid_state: Workflow step 'research' artifacts contains duplicate path 'research.md'.",
    'artifacts that are not the declared result':
      "invalid_state: Workflow step 'research' artifacts must match its declared result artifacts.",
  })
})

test('load reports the check that runs first when a persisted state breaks several', async () => {
  const observed: Record<string, string> = {
    'another workflow with an unknown status': await loadAfterEdit((state) => {
      state.workflowId = 'other-workflow'
      state.status = 'paused'
    }),
    'an unknown agent-question version with an unknown status': await loadAfterEdit((state) => {
      state.agentQuestions = { schemaVersion: 2, interactions: [] }
      state.status = 'paused'
    }),
    'an unknown status with an unknown step recovery policy': await loadAfterEdit((state) => {
      state.status = 'paused'
      stepAt(state, 0).recoveryPolicy = 'sometimes'
    }),
    'an unknown step recovery policy with a total that disagrees': await loadAfterEdit((state) => {
      stepAt(state, 0).recoveryPolicy = 'sometimes'
      state.totalCostUsd = 1
    }),
  }

  assert.deepEqual(observed, {
    'another workflow with an unknown status':
      "invalid_state: Unsupported workflow status 'paused'.",
    'an unknown agent-question version with an unknown status':
      'invalid_state: Agent-question state is invalid.',
    'an unknown status with an unknown step recovery policy':
      "invalid_state: Unsupported workflow status 'paused'.",
    'an unknown step recovery policy with a total that disagrees':
      "invalid_state: Unsupported recovery policy 'sometimes' for workflow step 'research'.",
  })
})

test('initialization refuses a step list or creation time that differs from the persisted one and leaves both files as they were', async () => {
  await withWorkspace(async (workspace) => {
    const store = openStore(assignmentIn(workspace))
    await store.initialize(initialization())
    const manifestBytes = fs.readFileSync(store.paths.manifestPath)
    const stateBytes = fs.readFileSync(store.paths.statePath)
    const fewerSteps = initialization()
    fewerSteps.steps.pop()
    const laterCreation = initialization()
    laterCreation.manifest.createdAt = COMPLETED_AT

    assert.equal(
      await outcome(() => store.initialize(fewerSteps)),
      'identity_mismatch: Persisted workflow step count does not match initialization.',
    )
    assert.equal(
      await outcome(() => store.initialize(laterCreation)),
      "identity_mismatch: Existing execution manifest does not match 'createdAt'.",
    )
    assert.ok(fs.readFileSync(store.paths.manifestPath).equals(manifestBytes), 'manifest rewritten')
    assert.ok(fs.readFileSync(store.paths.statePath).equals(stateBytes), 'state rewritten')
  })
})

test('a first initialization refused by validation writes no manifest and no state', async () => {
  await withWorkspace(async (workspace) => {
    const store = openStore(assignmentIn(workspace))
    const input = initialization()
    input.steps[0] = { ...teamStep('research', 0), recoveryPolicy: 'idempotent' }

    assert.equal(
      await outcome(() => store.initialize(input)),
      "invalid_state: Idempotent workflow step 'research' requires a persisted idempotency key.",
    )
    assert.equal(fs.existsSync(store.paths.manifestPath), false, 'manifest written')
    assert.equal(fs.existsSync(store.paths.statePath), false, 'state written')
  })
})

test('human-input commands refuse caller input that fails validation before publishing it', async () => {
  const request = {
    expectedRevision: 0,
    executionAttemptId: OWNER,
    stepId: 'human-feedback',
    interactionId: 'workflow_hitl_feedback_one',
    sourceArtifact: { ...RESEARCH_ARTIFACT },
    successorStepId: 'discussion-two',
    eligibleRecipients: [SECURITY_REVIEWER],
  }

  /** Initializes, runs `prepare`, then reports the refusal of `command` and whether the state file kept its bytes. */
  async function refusal(
    prepare: (store: FileSystemWorkflowStateStore) => Promise<unknown>,
    command: (store: FileSystemWorkflowStateStore) => Promise<unknown>,
  ): Promise<string> {
    return withWorkspace(async (workspace) => {
      const store = openStore(assignmentIn(workspace))
      await store.initialize(initialization())
      await prepare(store)
      const stateBytes = fs.readFileSync(store.paths.statePath)
      const refused = await outcome(() => command(store))
      const unchanged = fs.readFileSync(store.paths.statePath).equals(stateBytes)
      return `${refused} | ${unchanged ? 'state unchanged' : 'state rewritten'}`
    })
  }

  const observed: Record<string, string> = {
    'a request naming recipients that differ only in case': await refusal(
      async () => undefined,
      (store) => store.requestHumanInput({ ...request, eligibleRecipients: CASE_ONLY_DUPLICATES }),
    ),
    'feedback addressed to an ineligible recipient': await refusal(
      (store) => store.requestHumanInput(request),
      (store) => store.submitHumanInput({
        expectedRevision: 1,
        interactionId: request.interactionId,
        expectedSourceArtifactSha256: RESEARCH_ARTIFACT.sha256,
        submission: feedbackFor(['nobody']),
      }),
    ),
  }

  assert.deepEqual(observed, {
    'a request naming recipients that differ only in case':
      "invalid_state: Duplicate human input recipient mention 'reviewer'. | state unchanged",
    'feedback addressed to an ineligible recipient':
      "invalid_state: Human input message references ineligible recipient 'nobody'. | state unchanged",
  })
})

test('load returns the persisted manifest and state exactly as they were written', async () => {
  await withWorkspace(async (workspace) => {
    const store = openStore(assignmentIn(workspace))
    const figure: WorkflowArtifactReference = {
      childRunId: 'research-run',
      relativePath: 'figures/chart.png',
      sha256: hashWorkflowContent('chart'),
      byteLength: Buffer.byteLength('chart'),
    }
    const messages: HumanInputMessage[] = [
      { id: 'message-one', text: 'Please check the threat model.', recipients: ['security-reviewer'] },
      { id: 'message-two', text: 'Everyone, keep the rollout constrained.', recipients: 'all' },
    ]
    const manifest: WorkflowExecutionManifest = {
      schemaVersion: 1,
      ...initialization().manifest,
      createdAt: CREATED_AT,
    }
    const state: DurableWorkflowState = {
      schemaVersion: 2,
      revision: 4,
      taskId: 'task-one',
      sessionId: 'product-session',
      rootRunId: 'root-run',
      workflowId: 'research-workflow',
      ownerExecutionAttemptId: OWNER,
      status: 'awaiting_input',
      currentStepId: 'human-feedback',
      totalCostUsd: 0.25,
      recoveryCount: 0,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      steps: [
        {
          stepId: 'research',
          stepIndex: 0,
          stepType: 'team',
          team: 'researchers',
          definitionHash: hashWorkflowContent('research-step:v1'),
          status: 'completed',
          recoveryPolicy: 'safe_retry',
          childRunId: 'research-run',
          inputArtifact: 'incoming-brief.md',
          resultArtifact: 'research.md',
          resultArtifactGlobs: ['figures/*'],
          requestedResultType: 'artifact:research.md',
          attemptCount: 1,
          costUsd: 0.25,
          costTracked: true,
          artifact: { ...RESEARCH_ARTIFACT },
          artifacts: [{ ...RESEARCH_ARTIFACT }, figure],
          summary: 'Research complete.',
          startedAt: UPDATED_AT,
          completedAt: COMPLETED_AT,
        },
        {
          stepId: 'human-feedback',
          stepIndex: 1,
          stepType: 'human-in-the-loop',
          definitionHash: hashWorkflowContent('human-feedback-step:v1'),
          status: 'awaiting_input',
          recoveryPolicy: 'never_retry',
          childRunId: 'human-feedback-run',
          inputArtifact: 'research.md',
          resultArtifact: 'feedback/round-1.json',
          requestedResultType: 'artifact:feedback/round-1.json',
          attemptCount: 1,
          costUsd: 0,
          startedAt: UPDATED_AT,
          humanInput: {
            interactionId: 'workflow_hitl_feedback_one',
            taskId: 'task-one',
            sessionId: 'product-session',
            workflowId: 'research-workflow',
            stepId: 'human-feedback',
            ownerExecutionAttemptId: OWNER,
            sourceArtifact: { ...RESEARCH_ARTIFACT },
            successorStepId: 'discussion-two',
            eligibleRecipients: [SECURITY_REVIEWER],
            prompt: 'Review the first discussion round.',
            requestedAt: UPDATED_AT,
            status: 'submitted',
            submission: {
              submissionId: 'submission-one',
              mode: 'feedback',
              messages,
              submittedAt: COMPLETED_AT,
              canonicalHash: hashHumanInputSubmission({ submissionId: 'submission-one', mode: 'feedback', messages }),
            },
          },
        },
        {
          stepId: 'discussion-two',
          stepIndex: 2,
          stepType: 'team',
          team: 'researchers',
          definitionHash: hashWorkflowContent('discussion-two-step:v1'),
          status: 'pending',
          recoveryPolicy: 'safe_retry',
          childRunId: 'discussion-two-run',
          inputArtifact: 'feedback/round-1.json',
          resultArtifact: 'discussion-two.md',
          requestedResultType: 'artifact:discussion-two.md',
          attemptCount: 0,
          costUsd: 0,
        },
      ],
    }
    fs.mkdirSync(path.dirname(store.paths.statePath), { recursive: true })
    fs.writeFileSync(store.paths.manifestPath, JSON.stringify(manifest))
    fs.writeFileSync(store.paths.statePath, JSON.stringify(state))

    assert.deepEqual(await store.load(), { manifest, state })
  })
})
