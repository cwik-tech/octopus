import {
  DEEP_RESEARCH_SCHEMA_VERSION,
  type ResearchEvidenceGraph,
  type ResearchEvidenceGraphClaimNode,
  type ResearchEvidenceGraphSourceNode,
} from '../../contracts/deep-research.js'

export const CITATION_TEST_TIME = '2026-08-15T12:00:00.000Z'

export function makeGraphSource(
  overrides: Partial<ResearchEvidenceGraphSourceNode> = {},
): ResearchEvidenceGraphSourceNode {
  return {
    id: 'S1',
    canonicalUrl: 'https://regulator.example/report',
    title: 'Regulator Report',
    publisher: 'Regulator',
    independenceKey: 'regulator.example',
    sourceType: 'regulatory',
    status: 'usable',
    observedAt: CITATION_TEST_TIME,
    freshness: 'current',
    ...overrides,
  }
}

export function makeGraphClaim(
  overrides: Partial<ResearchEvidenceGraphClaimNode> = {},
): ResearchEvidenceGraphClaimNode {
  return {
    id: 'C1',
    taskId: 'T1',
    sectionId: 'section-one',
    statement: 'The measured adoption rate was 18%.',
    status: 'supported',
    confidence: 'high',
    evidenceStandard: 'single',
    sourceIds: ['S1'],
    supportingSourceIds: ['S1'],
    contradictingSourceIds: [],
    contextSourceIds: [],
    independentPublisherCount: 1,
    crossVerificationRequired: false,
    crossVerified: false,
    ...overrides,
  }
}

export function makeEvidenceGraph(
  overrides: Partial<ResearchEvidenceGraph> = {},
): ResearchEvidenceGraph {
  const sources = overrides.sources ?? [makeGraphSource()]
  const claims = overrides.claims ?? [makeGraphClaim()]
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: 'plan-one',
    approvedPlanHash: 'a'.repeat(64),
    correctionWave: 1,
    generatedAt: CITATION_TEST_TIME,
    requirements: [],
    claims,
    sources,
    edges: [],
    contradictions: [],
    unresolvedQuestions: [],
    gaps: [],
    coverage: {
      requiredRequirements: 0,
      satisfiedRequirements: 0,
      supportedClaims: claims.filter((claim) => claim.status === 'supported')
        .length,
      totalClaims: claims.length,
      crossVerifiedConsequentialClaims: 0,
      consequentialClaims: 0,
    },
    ...overrides,
  }
}
