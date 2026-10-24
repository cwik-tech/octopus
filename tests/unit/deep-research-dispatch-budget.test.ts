/**
 * Deep Research dispatch time budget.
 *
 * Contract: an agent timeout clamped exactly to the remaining plan budget
 * expires at the deadline and can never fire early enough to terminate work,
 * persist state, and route. Every dispatch therefore keeps an explicit
 * shutdown reserve, refuses to start when the remainder cannot cover the
 * reserve plus the minimum dispatch quantum, and a level may not declare an
 * agent timeout greater than or equal to the whole plan budget because such a
 * timeout can never fire.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'

import {
  DEEP_RESEARCH_MINIMUM_DISPATCH_MS,
  DEEP_RESEARCH_SHUTDOWN_RESERVE_MS,
  describeDeepResearchDispatchRefusal,
  planDeepResearchDispatchBudget,
  resolveDeepResearchDeadline,
  validateDeepResearchLevelTimeout,
} from '../../domains/deep-research/deep-research-pipeline-adapter.js'

test('the effective timeout is the remaining budget minus the reserve', () => {
  const budget = planDeepResearchDispatchBudget({
    declaredTimeoutMinutes: 8,
    remainingMs: 60_000,
  })
  assert.equal(budget.refusalReason, undefined)
  assert.equal(budget.effectiveTimeoutMinutes, 0.5)
})

test('a remainder below the viable floor refuses dispatch instead of starting', () => {
  const budget = planDeepResearchDispatchBudget({
    declaredTimeoutMinutes: 8,
    remainingMs: DEEP_RESEARCH_SHUTDOWN_RESERVE_MS - 5_000,
    minimumDispatchMs: 0,
  })
  assert.equal(budget.refusalReason, 'insufficient')
  assert.equal(
    budget.requiredMs,
    DEEP_RESEARCH_MINIMUM_DISPATCH_MS + DEEP_RESEARCH_SHUTDOWN_RESERVE_MS,
    'a caller cannot opt out of the minimum dispatch quantum by passing zero',
  )
})

test('a remainder that clears the reserve but not the dispatch floor still refuses', () => {
  const budget = planDeepResearchDispatchBudget({
    declaredTimeoutMinutes: 8,
    remainingMs: DEEP_RESEARCH_SHUTDOWN_RESERVE_MS + 1,
  })
  assert.equal(
    budget.refusalReason,
    'insufficient',
    'one millisecond of dispatchable time is doomed work, not a viable dispatch',
  )
})

test('the effective timeout never falls below the minimum dispatch quantum', () => {
  const budget = planDeepResearchDispatchBudget({
    declaredTimeoutMinutes: 8,
    remainingMs: DEEP_RESEARCH_SHUTDOWN_RESERVE_MS + 1,
  })
  assert.equal(
    budget.effectiveTimeoutMinutes,
    DEEP_RESEARCH_MINIMUM_DISPATCH_MS / 60_000,
    'a sub-second agent timeout is never a viable dispatch quantum',
  )
})

test('an expired deadline is reported as expired, not insufficient', () => {
  const budget = planDeepResearchDispatchBudget({
    declaredTimeoutMinutes: 8,
    remainingMs: -1_000,
  })
  assert.equal(budget.refusalReason, 'expired')
})

test('ample budget leaves the declared timeout unchanged', () => {
  const budget = planDeepResearchDispatchBudget({
    declaredTimeoutMinutes: 8,
    remainingMs: 20 * 60_000,
  })
  assert.equal(budget.refusalReason, undefined)
  assert.equal(budget.effectiveTimeoutMinutes, 8)
})

test('the worker deadline binds when it is the smallest term', () => {
  const budget = planDeepResearchDispatchBudget({
    declaredTimeoutMinutes: 8,
    remainingMs: 20 * 60_000,
    workerDeadlineMs: 2 * 60_000,
  })
  assert.equal(budget.effectiveTimeoutMinutes, 2)
})

test('the minimum dispatch quantum raises the viable floor', () => {
  const budget = planDeepResearchDispatchBudget({
    declaredTimeoutMinutes: 8,
    remainingMs: 60_000,
    minimumDispatchMs: 90_000,
  })
  assert.equal(budget.refusalReason, 'insufficient')
  assert.equal(
    budget.requiredMs,
    90_000 + DEEP_RESEARCH_SHUTDOWN_RESERVE_MS,
  )
})

test('a declared timeout at or above the plan budget is rejected at admission', () => {
  assert.match(
    validateDeepResearchLevelTimeout({
      declaredAgentTimeoutMinutes: 20,
      planMaxDurationMinutes: 20,
    }) ?? '',
    /agent_timeout_minutes.*20.*never fire/i,
  )
  assert.match(
    validateDeepResearchLevelTimeout({
      declaredAgentTimeoutMinutes: 25,
      planMaxDurationMinutes: 20,
    }) ?? '',
    /agent_timeout_minutes.*25.*never fire/i,
  )
  assert.equal(
    validateDeepResearchLevelTimeout({
      declaredAgentTimeoutMinutes: 8,
      planMaxDurationMinutes: 20,
    }),
    undefined,
    'a timeout below the plan budget can fire and is valid',
  )
  assert.equal(
    validateDeepResearchLevelTimeout({
      declaredAgentTimeoutMinutes: undefined,
      planMaxDurationMinutes: 20,
    }),
    undefined,
    'an undeclared timeout has nothing to validate',
  )
})

test('the expired refusal states the same arithmetic as the insufficient one', () => {
  const expired = describeDeepResearchDispatchRefusal(
    planDeepResearchDispatchBudget({
      declaredTimeoutMinutes: 8,
      remainingMs: -5_000,
    }),
  )
  assert.match(expired, /deadline expired/i)
  assert.match(expired, /60 seconds are required/, 'names the required seconds')
  assert.match(expired, /30s shutdown reserve/, 'names the reserve')
  assert.match(expired, /0 seconds remain/, 'names the remaining seconds')
})

test('the insufficient refusal keeps its arithmetic', () => {
  const insufficient = describeDeepResearchDispatchRefusal(
    planDeepResearchDispatchBudget({
      declaredTimeoutMinutes: 8,
      remainingMs: 45_000,
    }),
  )
  assert.match(insufficient, /Insufficient remaining execution budget/)
  assert.match(insufficient, /60 seconds are required/)
  assert.match(insufficient, /30s shutdown reserve/)
  assert.match(insufficient, /45 seconds remain/)
})

test('the resolved deadline carries the approved plan budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-deadline-'))
  try {
    writeDeadlineFixture(dir, 20)
    const deadline = resolveDeepResearchDeadline({
      assignmentPath: dir,
      deadlineArtifact: 'research/runtime-limits.json',
      planArtifact: 'research/approved-plan.json',
    })
    assert.equal(
      deadline.maxDurationMinutes,
      20,
      'a stage without a plan artifact still needs the plan budget to ' +
        'diagnose a timeout that can never fire',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a two-hour research plan retains its own budget after thirty minutes of work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-long-budget-'))
  try {
    writeDeadlineFixture(dir, 120)
    const deadline = resolveDeepResearchDeadline({
      assignmentPath: dir,
      deadlineArtifact: 'research/runtime-limits.json',
      now: new Date('2026-07-16T12:30:00.000Z'),
    })
    const dispatch = planDeepResearchDispatchBudget({ remainingMs: deadline.remainingMs })

    assert.equal(deadline.maxDurationMinutes, 120)
    assert.equal(deadline.remainingMs, 5_400_000)
    assert.equal(dispatch.refusalReason, undefined)
    assert.equal(dispatch.effectiveTimeoutMinutes, 89.5)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function writeDeadlineFixture(dir: string, maxDurationMinutes: number): void {
  const approvedPlan = approveResearchPlan({
    schemaVersion: 1,
    planId: 'plan-one',
    requestId: 'request-one',
    request: {
      schemaVersion: 1,
      requestId: 'request-one',
      question: 'What does the evidence establish?',
      objective: 'Establish the evidence for the report.',
      audience: 'Decision makers',
      includedScope: ['Example evidence'],
      excludedScope: [],
      desiredSections: ['Evidence'],
      jurisdictions: [],
      freshnessAsOf: '2026-07-16T12:00:00.000Z',
      authenticatedDomains: [],
      sourceRequirements: [],
      maxDurationMinutes,
      maxResearcherAgents: 1,
      outputFormats: ['markdown', 'docx'],
    },
    sections: [{
      schemaVersion: 1,
      id: 'section-one',
      title: 'Evidence',
      objective: 'Establish the evidence.',
      taskIds: ['T1'],
    }],
    tasks: [{
      schemaVersion: 1,
      id: 'T1',
      sectionId: 'section-one',
      title: 'Research',
      question: 'What does the evidence establish?',
      purpose: 'evidence_acquisition',
      workerSpecId: 'worker-one',
      dependsOn: [],
      correctionWave: 0,
    }],
    workerSpecs: [{
      schemaVersion: 1,
      id: 'worker-one',
      laneId: 'lane-one',
      sectionId: 'section-one',
      baseAgent: 'web-researcher',
      displayRole: 'Evidence analyst',
      domain: 'example',
      lens: 'foundational',
      methodCardIds: ['general-research-v1'],
      specialistStance:
        'Approach this assignment as an evidence verification analyst. Separate observed facts from inference.',
      question: 'What does the evidence establish?',
      decisionUse: 'Support the report.',
      workingDefinitions: [],
      dependencyClaimIds: [],
      sourceRequirements: {
        preferredTypes: ['primary'],
        requiredAuthorityTypes: ['primary'],
        queryHints: [],
      },
      requiredMetrics: [],
      prohibitedAssumptions: [],
      stopRule: {
        minimumPrimarySources: 0,
        minimumIndependentSources: 1,
        maximumSources: 5,
      },
      limits: { deadlineMs: 60_000 },
    }],
    maxDurationMinutes,
    maxResearcherAgents: 1,
    expectedPeakWorkers: 1,
    authenticatedDomains: [],
  }, '2026-07-16T12:00:00.000Z')
  fs.mkdirSync(path.join(dir, 'research'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'research', 'approved-plan.json'),
    JSON.stringify(approvedPlan),
  )
  const startedAt = new Date('2026-07-16T12:00:00.000Z')
  fs.writeFileSync(
    path.join(dir, 'research', 'runtime-limits.json'),
    JSON.stringify({
      schemaVersion: 1,
      planId: 'plan-one',
      maxDurationMinutes,
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + maxDurationMinutes * 60_000,
      ).toISOString(),
    }),
  )
}
