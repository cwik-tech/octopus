import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeGeneratedResearchPlan } from '../../domains/deep-research/deep-research-plan-normalization.js'
import { parseResearchPlan } from '../../domains/deep-research/deep-research-validation.js'
import { makePlan } from './deep-research-fixtures.js'

test('a reviewer zero source minimum is raised to the executable contract minimum', () => {
  const sourcePlan = makePlan()
  const workerSpec = sourcePlan.workerSpecs[0]
  assert.ok(workerSpec)
  const generatedPlan = {
    ...sourcePlan,
    workerSpecs: [{
      ...workerSpec,
      stopRule: {
        ...workerSpec.stopRule,
        minimumIndependentSources: 0,
      },
    }],
  }

  const normalized = normalizeGeneratedResearchPlan({
    value: generatedPlan,
    sessionId: 'planning-regression-session',
    settings: {
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
    },
  })

  const parsed = parseResearchPlan(normalized)
  assert.equal(parsed.workerSpecs[0]?.stopRule.minimumIndependentSources, 1)
})

test('a report-only synthesis section remains valid without an evidence task', () => {
  const sourcePlan = makePlan()
  const comparisonSection = {
    schemaVersion: 1 as const,
    id: 'cross-source-comparison',
    title: 'Cross-source comparison and uncertainty',
    objective: 'Compare the acquired evidence and identify unresolved uncertainty.',
    taskIds: [],
  }
  const generatedPlan = {
    ...sourcePlan,
    request: {
      ...sourcePlan.request,
      desiredSections: [
        ...sourcePlan.request.desiredSections,
        comparisonSection.title,
      ],
    },
    sections: [...sourcePlan.sections, comparisonSection],
  }

  const normalized = normalizeGeneratedResearchPlan({
    value: generatedPlan,
    sessionId: 'planning-synthesis-section-regression',
    settings: {
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
    },
  })

  const parsed = parseResearchPlan(normalized)
  assert.deepEqual(parsed.sections.at(-1), comparisonSection)
  assert.deepEqual(parsed.request.desiredSections, [
    sourcePlan.sections[0]?.title,
    comparisonSection.title,
  ])
})
