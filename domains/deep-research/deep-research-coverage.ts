import {
  DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION,
  type ResearchCoverageRequirement,
  type ResearchWorkerSpec,
} from '../../contracts/deep-research.js'

/**
 * Present new and legacy approved plans through one explicit execution
 * contract without changing the immutable approved plan or its approval hash.
 */
export function resolveResearchCoverageRequirements(
  workerSpec: ResearchWorkerSpec,
): readonly ResearchCoverageRequirement[] {
  if (workerSpec.coverageRequirements) return workerSpec.coverageRequirements
  return (workerSpec.requiredMetrics ?? []).map((label, index) => ({
    schemaVersion: DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION,
    id: legacyResearchCoverageRequirementId(label, index),
    label,
    kind: 'fact',
    validation: 'claim_support',
    required: true,
  }))
}

export function normalizeResearchCoverageLabel(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim()
}

function legacyResearchCoverageRequirementId(label: string, index: number): string {
  const slug = normalizeResearchCoverageLabel(label).replace(/\s+/g, '-').slice(0, 48)
  return `legacy-${String(index + 1).padStart(2, '0')}-${slug || 'requirement'}`
}
