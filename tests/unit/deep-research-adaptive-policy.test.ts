import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  QualityVerdict,
  ResearchExecutionPolicy,
} from '../../contracts/deep-research.js'
import {
  applyAdaptiveResearchPolicy,
  buildResearchPlanAmendment,
  extractApprovedResearchPlanFromBrief,
  resolveAdaptiveResearchBudget,
} from '../../domains/deep-research/deep-research-adaptive-policy.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'
import {
  makePlan,
  TEST_TIME,
} from './deep-research-fixtures.js'

const EXECUTION_POLICY: ResearchExecutionPolicy = {
  schemaVersion: 1,
  complexity: 'complex',
  complexityRationale:
    'The decision depends on independently corroborated quantitative evidence.',
  searchBreadth: 'broad',
  maxCostUsd: 18,
  evidenceTargets: {
    minimumSupportedClaims: 1,
    minimumIndependentSourcesPerConsequentialClaim: 2,
    crossVerifyConsequentialClaims: true,
  },
  stopping: {
    minimumExpectedInformationGain: 80,
    maximumCorrectionWaves: 2,
  },
  synthesis: {
    mode: 'section_dossiers',
    maximumParallelSections: 2,
  },
}

test('adaptive policy continues a valuable correction and creates an approval-bound amendment', () => {
  const plan = approveResearchPlan(
    makePlan({ executionPolicy: EXECUTION_POLICY }),
    TEST_TIME,
  )
  const verdict = revisionVerdict()

  const adaptive = applyAdaptiveResearchPolicy({ plan, verdict })

  assert.equal(adaptive.verdict.decision, 'REVISE')
  assert.equal(adaptive.decision.decision, 'continue')
  assert.equal(adaptive.decision.route, 'research')
  assert.equal(adaptive.decision.aggregateExpectedInformationGain, 85)
  assert.equal(adaptive.decision.minimumExpectedInformationGain, 80)
  assert.equal(adaptive.decision.sourceVerdictHash, hashResearchValue(verdict))

  const amendment = buildResearchPlanAmendment({
    plan,
    verdict,
    decision: adaptive.decision,
    sourceVerdictPath: 'research/quality/verdict-wave-0.json',
  })
  assert.equal(amendment.approvedPlanHash, plan.approvalHash)
  assert.equal(amendment.sourceVerdictHash, hashResearchValue(verdict))
  assert.equal(amendment.fromWave, 0)
  assert.equal(amendment.toWave, 1)
  assert.equal(amendment.approvedMaxCostUsd, 18)
  assert.deepEqual(amendment.targetTaskIds, ['task-one'])
  assert.deepEqual(amendment.targetSectionIds, ['section-one'])
  assert.deepEqual(amendment.targetClaimIds, ['claim-one'])
  assert.deepEqual(amendment.targetRequirementIds, ['cac'])
  assert.equal(amendment.scopeChange, 'none')
})

test('adaptive policy stops below the approved information-gain threshold', () => {
  const plan = approveResearchPlan(
    makePlan({
      executionPolicy: {
        ...EXECUTION_POLICY,
        stopping: {
          ...EXECUTION_POLICY.stopping,
          minimumExpectedInformationGain: 90,
        },
      },
    }),
    TEST_TIME,
  )

  const adaptive = applyAdaptiveResearchPolicy({
    plan,
    verdict: revisionVerdict(),
  })

  assert.equal(adaptive.decision.decision, 'stop')
  assert.equal(adaptive.verdict.decision, 'ESCALATE')
  assert.deepEqual(adaptive.verdict.correctionRequests, [])
  assert.match(adaptive.decision.reason, /below the approved 90\/100 threshold/u)
})

test('adaptive policy continues bounded packet repair without expanding research', () => {
  const plan = approveResearchPlan(
    makePlan({
      executionPolicy: {
        ...EXECUTION_POLICY,
        stopping: {
          ...EXECUTION_POLICY.stopping,
          minimumExpectedInformationGain: 90,
        },
      },
    }),
    TEST_TIME,
  )
  const verdict = revisionVerdict({
    findings: [{
      code: 'claim_unsupported',
      severity: 'blocking',
      message: 'The claim aggregates details not established by its excerpts.',
      taskIds: ['task-one'],
      sectionIds: ['section-one'],
      claimIds: ['claim-one'],
      sourceIds: ['source-one'],
    }],
    correctionRequests: [{
      schemaVersion: 1,
      id: 'repair-claim-one',
      type: 'restructure_packet',
      claimIds: ['claim-one'],
      taskIds: ['task-one'],
      sectionIds: ['section-one'],
      requirementIds: ['cac'],
      acceptanceCriteria: [
        'Remove unsupported clauses while reusing the validated evidence.',
      ],
      impactScope: 'local',
    }],
    correctionRoute: 'research',
  })

  const adaptive = applyAdaptiveResearchPolicy({ plan, verdict })

  assert.equal(adaptive.verdict.decision, 'REVISE')
  assert.equal(adaptive.decision.decision, 'continue')
  assert.equal(adaptive.decision.route, 'research')
  assert.match(adaptive.decision.reason, /reuses already acquired evidence/u)
})

test('adaptive policy enforces the approved correction-wave cap', () => {
  const plan = approveResearchPlan(
    makePlan({
      executionPolicy: {
        ...EXECUTION_POLICY,
        stopping: {
          ...EXECUTION_POLICY.stopping,
          maximumCorrectionWaves: 1,
        },
      },
    }),
    TEST_TIME,
  )

  const adaptive = applyAdaptiveResearchPolicy({
    plan,
    verdict: revisionVerdict({ correctionWave: 1 }),
  })

  assert.equal(adaptive.decision.decision, 'stop')
  assert.equal(adaptive.verdict.decision, 'ESCALATE')
  assert.match(adaptive.decision.reason, /at most 1 correction wave/u)
})

test('approved plan extraction applies the lower runtime budget boundary', () => {
  const plan = approveResearchPlan(
    makePlan({ executionPolicy: EXECUTION_POLICY }),
    TEST_TIME,
  )
  const brief = [
    '# Approved brief',
    '',
    '<!-- pipeline-runtime:approved-deep-research-plan:v1 -->',
    JSON.stringify(plan, null, 2),
    '',
  ].join('\n')

  assert.equal(extractApprovedResearchPlanFromBrief(brief)?.planId, plan.planId)
  assert.equal(
    resolveAdaptiveResearchBudget({
      brief,
      parentRemainingBudgetUsd: 25,
    }),
    18,
  )
  assert.equal(
    resolveAdaptiveResearchBudget({
      brief,
      parentRemainingBudgetUsd: 7,
    }),
    7,
  )
})

function revisionVerdict(
  overrides: Partial<QualityVerdict> = {},
): QualityVerdict {
  return {
    schemaVersion: 1,
    verdictId: 'verdict-one',
    correctionWave: 0,
    decision: 'REVISE',
    findings: [{
      code: 'source_not_independent',
      severity: 'blocking',
      message: 'The consequential claim needs independent corroboration.',
      taskIds: ['task-one'],
      sectionIds: ['section-one'],
      claimIds: ['claim-one'],
      sourceIds: ['source-one'],
    }],
    correctionRequests: [{
      schemaVersion: 1,
      id: 'cross-verify-claim-one',
      type: 'cross_verify',
      claimIds: ['claim-one'],
      taskIds: ['task-one'],
      sectionIds: ['section-one'],
      requirementIds: ['cac'],
      question: 'Can an independent publisher corroborate the claim?',
      acceptanceCriteria: [
        'Add a directly observed, independently published source.',
      ],
      impactScope: 'local',
    }],
    correctionRoute: 'research',
    reviewedAt: TEST_TIME,
    ...overrides,
  }
}
