import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import test from 'node:test'

import { isRunPlan } from '../../contracts/run-plan.js'
import { isEngineEventEnvelope } from '../../contracts/runtime-events.js'
import {
  isActiveTaskStatus,
  isExecutingTaskStatus,
  isSessionTask,
  isTaskAdmission,
} from '../../contracts/sessions.js'

const validEngineEvent = {
  schema_version: 1,
  timestamp: '2026-07-23T12:00:00.000Z',
  tenant_id: 'local',
  category: 'artifact',
  type: 'artifact.written',
  run_id: 'run-1',
  team: null,
  level_id: 'draft',
  payload: { path: 'output/report.md' },
  futureField: true,
}

const validSessionTask = {
  id: 'task-1',
  sessionId: 'session-1',
  runId: 'run-1',
  assignmentId: 'assignment-1',
  workflowId: 'workflow-1',
  brief: 'Draft a report',
  status: 'running',
  createdAt: '2026-07-23T12:00:00.000Z',
  cwd: '/workspace',
  runPath: '/workspace/runs/run-1',
  assignmentPath: '/workspace/runs/run-1/assignments/assignment-1',
  inputSnapshotPath: '/workspace/runs/run-1/input',
  workflowSnapshotPath: '/workspace/runs/run-1/workflow.yaml',
  mcpResolutionPath: '/workspace/runs/run-1/mcp-resolution.json',
  mcpWarnings: [
    {
      code: 'mcp_requirement_unmet',
      retryable: true,
      stepId: 'research',
      capability: 'search',
      access: ['read'],
      necessity: 'optional',
      eligibleAgentPaths: ['agents/researcher.md'],
      message: 'Optional search capability is unavailable.',
    },
  ],
  configuredProviderBrokerIdentity: 'broker-1',
  pid: 1234,
  executionAttemptNumber: 2,
  executionKind: 'recovery',
  recoveryDisposition: 'automatic',
  admission: {
    version: 1,
    requestId: 'request-1',
    order: '1',
    requestedAt: '2026-07-23T12:00:00.000Z',
    executionKind: 'recovery',
    source: 'automatic_recovery',
    expectedExecutionAttemptId: 'attempt-1',
    phase: 'granted',
    grantId: 'grant-1',
    ownerEpoch: 'epoch-1',
    grantedAt: '2026-07-23T12:00:01.000Z',
    executionAttemptId: 'attempt-2',
  },
  futureField: true,
}

test('awaiting-input tasks remain active without occupying an execution slot', () => {
  assert.equal(isActiveTaskStatus('awaiting_input'), true)
  assert.equal(isExecutingTaskStatus('awaiting_input'), false)
  assert.equal(isSessionTask({ ...validSessionTask, status: 'awaiting_input' }), true)
})

// The type union has carried this status since the workflow could stop for a
// model choice, but the runtime set the guard reads from did not. A task the
// API really returns was therefore rejected at the boundary, which empties the
// whole task list rather than failing on the one task.
test('a task awaiting a model choice survives the boundary it must cross', () => {
  assert.equal(isActiveTaskStatus('awaiting_model_choice'), true)
  assert.equal(isExecutingTaskStatus('awaiting_model_choice'), false)
  assert.equal(
    isSessionTask({ ...validSessionTask, status: 'awaiting_model_choice' }),
    true,
  )
})

test('human-input continuation admissions are valid task admissions', () => {
  const admission = {
    version: 1 as const,
    requestId: 'continuation-request-1',
    order: '2',
    requestedAt: '2026-07-23T12:00:00.000Z',
    executionKind: 'continuation' as const,
    source: 'human_input' as const,
    expectedExecutionAttemptId: 'attempt-1',
    phase: 'pending' as const,
  }
  assert.equal(isTaskAdmission(admission), true)
  assert.equal(isSessionTask({
    ...validSessionTask,
    status: 'awaiting_input',
    executionKind: 'continuation',
    admission,
  }), true)
})

const validResearchPlan = {
  schemaVersion: 1,
  planId: 'research-plan-1',
  requestId: 'research-request-1',
  request: {
    schemaVersion: 1,
    requestId: 'research-request-1',
    question: 'What changed?',
    objective: 'Support a decision.',
    audience: 'Operators',
    includedScope: ['North America'],
    excludedScope: [],
    desiredSections: ['Summary'],
    jurisdictions: ['US'],
    freshnessAsOf: '2026-07-23',
    authenticatedDomains: [],
    sourceRequirements: ['Primary sources'],
    maxDurationMinutes: 30,
    maxResearcherAgents: 2,
    outputFormats: ['markdown', 'docx'],
  },
  sections: [
    {
      schemaVersion: 1,
      id: 'summary',
      title: 'Summary',
      objective: 'Summarize the evidence.',
      taskIds: ['task-1'],
    },
  ],
  tasks: [
    {
      schemaVersion: 1,
      id: 'task-1',
      sectionId: 'summary',
      title: 'Find sources',
      question: 'What changed?',
      purpose: 'evidence_acquisition',
      workerSpecId: 'worker-1',
      dependsOn: [],
      correctionWave: 0,
    },
  ],
  workerSpecs: [
    {
      schemaVersion: 1,
      id: 'worker-1',
      laneId: 'lane-1',
      sectionId: 'summary',
      baseAgent: 'web-researcher',
      displayRole: 'Researcher',
      domain: 'Operations',
      lens: 'foundational',
      methodCardIds: ['general-research-v1'],
      specialistStance:
        'Approach this assignment as an operations evidence analyst. Separate current observed changes from historical assumptions.',
      question: 'What changed?',
      decisionUse: 'Support a decision.',
      workingDefinitions: [],
      dependencyClaimIds: [],
      sourceRequirements: {
        preferredTypes: ['primary'],
        requiredAuthorityTypes: ['regulatory'],
        queryHints: ['official source'],
      },
      coverageRequirements: [
        {
          schemaVersion: 2,
          id: 'coverage-1',
          label: 'Primary support',
          kind: 'source_authority',
          validation: 'source_authority',
          required: true,
        },
      ],
      prohibitedAssumptions: [],
      stopRule: {
        minimumPrimarySources: 1,
        minimumIndependentSources: 1,
        maximumSources: 5,
      },
      limits: { deadlineMs: 60_000 },
    },
  ],
  maxDurationMinutes: 30,
  maxResearcherAgents: 2,
  expectedPeakWorkers: 1,
  authenticatedDomains: [],
}

const validRunPlan = {
  id: 'plan-1',
  goal: 'Draft a report',
  summary: 'Ready to run.',
  status: 'ready',
  selectedWorkflow: {
    id: 'workflow-1',
    rationale: 'Matches the requested output.',
    confidence: 'high',
  },
  deepResearchIntakeComplete: true,
  researchPlan: validResearchPlan,
  researchPlanProposalHash: 'proposal-hash',
  requiredInputs: [],
  brief: 'Draft a report.',
  actions: [
    {
      id: 'action-1',
      type: 'launch_workflow',
      status: 'ready',
      title: 'Launch workflow',
      rationale: 'All inputs are ready.',
      workflowId: 'workflow-1',
    },
  ],
  warnings: [],
  createdAt: '2026-07-23T12:00:00.000Z',
  updatedAt: '2026-07-23T12:01:00.000Z',
  applyClaimOwnerPid: 1234,
  futureField: true,
}

test('isEngineEventEnvelope accepts the canonical envelope and future fields', () => {
  assert.equal(isEngineEventEnvelope(validEngineEvent), true)
})

test('isEngineEventEnvelope rejects malformed required and optional fields', () => {
  const invalidValues = [
    null,
    { ...validEngineEvent, schema_version: 2 },
    { ...validEngineEvent, category: 'unknown-category' },
    { ...validEngineEvent, payload: [] },
    { ...validEngineEvent, team: 42 },
    { ...validEngineEvent, timestamp: null },
  ]
  for (const value of invalidValues) {
    assert.equal(isEngineEventEnvelope(value), false)
  }
})

test('isSessionTask accepts all canonical task fields and compatibility extensions', () => {
  assert.equal(isSessionTask(validSessionTask), true)
})

test('isSessionTask rejects malformed status, process, admission, and MCP warning fields', () => {
  const invalidValues = [
    { ...validSessionTask, status: 'unknown' },
    { ...validSessionTask, pid: '1234' },
    {
      ...validSessionTask,
      admission: { ...validSessionTask.admission, order: '0' },
    },
    {
      ...validSessionTask,
      mcpWarnings: [{ ...validSessionTask.mcpWarnings[0], retryable: false }],
    },
    { ...validSessionTask, configuredProviderBrokerIdentity: 1 },
  ]
  for (const value of invalidValues) {
    assert.equal(isSessionTask(value), false)
  }
})

test('isRunPlan accepts a complete canonical plan and future fields', () => {
  assert.equal(isRunPlan(validRunPlan), true)
  assert.equal(isRunPlan({ ...validRunPlan, status: 'blocked' }), true)
  assert.equal(isRunPlan({ ...validRunPlan, status: 'cancelled' }), true)
})

test('isRunPlan rejects malformed lifecycle, action, selection, and research fields', () => {
  const invalidValues = [
    { ...validRunPlan, status: 'unknown' },
    { ...validRunPlan, requiredInputs: [1] },
    {
      ...validRunPlan,
      selectedWorkflow: {
        ...validRunPlan.selectedWorkflow,
        confidence: 'certain',
      },
    },
    {
      ...validRunPlan,
      actions: [{ ...validRunPlan.actions[0], status: 'unknown' }],
    },
    {
      ...validRunPlan,
      researchPlan: {
        ...validResearchPlan,
        request: {
          ...validResearchPlan.request,
          outputFormats: ['docx', 'markdown'],
        },
      },
    },
    {
      ...validRunPlan,
      researchPlan: {
        ...validResearchPlan,
        workerSpecs: [
          {
            ...validResearchPlan.workerSpecs[0],
            sourceRequirements: {
              ...requiredValue(validResearchPlan.workerSpecs[0], 'tests/unit/contracts.test.ts:302').sourceRequirements,
              preferredTypes: ['filing'],
            },
          },
        ],
      },
    },
  ]
  for (const value of invalidValues) {
    assert.equal(isRunPlan(value), false)
  }
})
