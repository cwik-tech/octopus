import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ResearchExecutionPolicy,
  ResearchSectionDossierIndex,
} from '../../contracts/deep-research.js'
import {
  buildResearchEvidenceGraph,
  buildResearchSectionDossierIndex,
  buildResearchSectionDossiers,
  buildResearchSectionDraftPlan,
  parseResearchEvidenceGraph,
} from '../../domains/deep-research/deep-research-evidence-graph.js'
import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { buildResearchSynthesisPacket } from '../../domains/deep-research/deep-research-quality.js'
import {
  makeEvidencePacket,
  makePlan,
  makeSource,
  makeWorkerSpec,
  TEST_TIME,
} from './deep-research-fixtures.js'

const SECTION_POLICY: ResearchExecutionPolicy = {
  schemaVersion: 1,
  complexity: 'complex',
  complexityRationale: 'Three evidence-heavy sections require bounded drafting.',
  searchBreadth: 'broad',
  maxCostUsd: 24,
  evidenceTargets: {
    minimumSupportedClaims: 1,
    minimumIndependentSourcesPerConsequentialClaim: 2,
    crossVerifyConsequentialClaims: true,
  },
  stopping: {
    minimumExpectedInformationGain: 50,
    maximumCorrectionWaves: 2,
  },
  synthesis: {
    mode: 'section_dossiers',
    maximumParallelSections: 2,
  },
}

test('evidence graph derives claim-source links, coverage, and section dossiers from validated packets', () => {
  const plan = approveResearchPlan(
    makePlan({ executionPolicy: SECTION_POLICY }),
    TEST_TIME,
  )
  const synthesis = buildResearchSynthesisPacket({
    plan,
    evidencePackets: [makeEvidencePacket()],
  })

  const graph = buildResearchEvidenceGraph({
    plan,
    synthesis,
    correctionWave: 0,
  })
  const dossiers = buildResearchSectionDossiers({
    plan,
    synthesis,
    graph,
    evidencePackets: [makeEvidencePacket()],
  })
  const index = buildResearchSectionDossierIndex({ plan, dossiers })

  assert.equal(graph.approvedPlanHash, plan.approvalHash)
  assert.equal(graph.coverage.requiredRequirements, 2)
  assert.equal(graph.coverage.satisfiedRequirements, 2)
  assert.equal(graph.coverage.supportedClaims, 1)
  assert.equal(graph.coverage.crossVerifiedConsequentialClaims, 1)
  assert.deepEqual(
    graph.edges.map((edge) => edge.type).sort(),
    ['covers', 'covers', 'supports', 'supports'],
  )
  assert.deepEqual(graph.gaps, [])
  assert.equal(dossiers.length, 1)
  assert.deepEqual(dossiers[0]?.gapIds, [])
  assert.equal(
    dossiers[0]?.evidenceGraphPath,
    'research/evidence-graph/graph-wave-0.json',
  )
  assert.equal(index.synthesisMode, 'section_dossiers')
  assert.equal(
    index.dossiers[0]?.draftPath,
    'research/sections/section-one/draft-wave-0.md',
  )
  assert.deepEqual(parseResearchEvidenceGraph(graph), graph)
})

test('evidence graph exposes a missing cross-verification gap without hiding the supported claim', () => {
  const plan = approveResearchPlan(
    makePlan({ executionPolicy: SECTION_POLICY }),
    TEST_TIME,
  )
  const source = makeSource()
  const synthesis = buildResearchSynthesisPacket({
    plan,
    evidencePackets: [makeEvidencePacket({ sources: [source] })],
  })

  const graph = buildResearchEvidenceGraph({
    plan,
    synthesis,
    correctionWave: 0,
  })

  assert.equal(graph.coverage.supportedClaims, 1)
  assert.equal(graph.coverage.consequentialClaims, 1)
  assert.equal(graph.coverage.crossVerifiedConsequentialClaims, 0)
  const gap = graph.gaps.find(
    (candidate) => candidate.type === 'cross_verification_missing',
  )
  assert.ok(gap)
  assert.deepEqual(gap.claimIds, [graph.claims[0]!.id])
  assert.deepEqual(gap.sourceIds, [graph.sources[0]!.id])
  assert.match(gap.message, /1 independent supporting source group/u)
})

test('section draft plan batches independent sections at the approved concurrency limit', () => {
  const plan = approveResearchPlan(makeThreeSectionPlan(), TEST_TIME)
  const index: ResearchSectionDossierIndex = {
    schemaVersion: 1,
    planId: plan.planId,
    approvedPlanHash: plan.approvalHash!,
    correctionWave: 0,
    synthesisMode: 'section_dossiers',
    dossiers: plan.sections.map((section) => ({
      sectionId: section.id,
      title: section.title,
      relativePath:
        `research/sections/${section.id}/dossier-wave-0.json`,
      draftPath: `research/sections/${section.id}/draft-wave-0.md`,
      claimCount: 1,
      sourceCount: 2,
      gapCount: 0,
    })),
  }

  const draftPlan = buildResearchSectionDraftPlan({ plan, index })

  assert.ok(draftPlan)
  assert.match(draftPlan, /#### T1: Section 1[\s\S]*Depends on:\*\* none/u)
  assert.match(draftPlan, /#### T2: Section 2[\s\S]*Depends on:\*\* none/u)
  assert.match(draftPlan, /#### T3: Section 3[\s\S]*Depends on:\*\* T1, T2/u)
  assert.match(
    draftPlan,
    /Result file:\*\* research\/sections\/section-3\/draft-wave-0\.md/u,
  )
})

test('evidence graph parser rejects dangling claim-source edges', () => {
  const plan = approveResearchPlan(
    makePlan({ executionPolicy: SECTION_POLICY }),
    TEST_TIME,
  )
  const synthesis = buildResearchSynthesisPacket({
    plan,
    evidencePackets: [makeEvidencePacket()],
  })
  const graph = buildResearchEvidenceGraph({
    plan,
    synthesis,
    correctionWave: 0,
  })

  assert.throws(
    () => parseResearchEvidenceGraph({
      ...graph,
      edges: [{
        from: 'claim-one',
        to: 'source-not-present',
        type: 'supports',
      }],
    }),
    /invalid edge/u,
  )
})

function makeThreeSectionPlan() {
  const sections = [1, 2, 3].map((number) => ({
    schemaVersion: 1 as const,
    id: `section-${number}`,
    title: `Section ${number}`,
    objective: `Establish evidence for section ${number}.`,
    taskIds: [`task-${number}`],
  }))
  const workers = sections.map((section, index) =>
    makeWorkerSpec({
      id: `worker-${index + 1}`,
      laneId: `lane-${index + 1}`,
      sectionId: section.id,
      displayRole: `Evidence Analyst ${index + 1}`,
      question: `What evidence supports section ${index + 1}?`,
    }))
  const tasks = workers.map((worker, index) => ({
    schemaVersion: 1 as const,
    id: `task-${index + 1}`,
    sectionId: worker.sectionId,
    title: `Research section ${index + 1}`,
    question: worker.question,
    purpose: 'evidence_acquisition' as const,
    workerSpecId: worker.id,
    dependsOn: [],
    correctionWave: 0 as const,
  }))
  return makePlan({
    planId: 'three-section-plan',
    sections,
    tasks,
    workerSpecs: workers,
    expectedPeakWorkers: 3,
    executionPolicy: SECTION_POLICY,
  })
}
