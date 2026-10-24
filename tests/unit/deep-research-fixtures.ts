import {
  DEEP_RESEARCH_SCHEMA_VERSION,
  type DeepResearchRequest,
  type DomainCard,
  type EvidencePacket,
  type ResearchPlan,
  type ResearchWorkerSpec,
  type SourceRecord,
} from '../../contracts/deep-research.js'
import {
  createResearchWorkerSpec,
  hashResearchValue,
} from '../../domains/deep-research/deep-research-worker-policy.js'

export const TEST_TIME = '2026-07-16T12:00:00.000Z'
export const TEST_HASH = 'a'.repeat(64)

export function makeRequest(
  overrides: Partial<DeepResearchRequest> = {},
): DeepResearchRequest {
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    requestId: 'request-one',
    question: 'Which acquisition channels are economically sustainable?',
    objective: 'Choose two channels for the next planning cycle.',
    audience: 'B2B SaaS marketing leadership',
    includedScope: ['B2B SaaS acquisition'],
    excludedScope: [],
    desiredSections: ['Acquisition'],
    jurisdictions: [],
    freshnessAsOf: TEST_TIME,
    authenticatedDomains: [],
    sourceRequirements: ['Prefer direct and independent evidence.'],
    maxDurationMinutes: 20,
    maxResearcherAgents: 8,
    outputFormats: ['markdown', 'docx'],
    ...overrides,
  }
}

export function makeWorkerSpec(
  overrides: Partial<ResearchWorkerSpec> = {},
): ResearchWorkerSpec {
  return createResearchWorkerSpec({
    id: 'worker-one',
    laneId: 'lane-one',
    sectionId: 'section-one',
    displayRole: 'B2B Marketing Analyst',
    domain: 'B2B SaaS marketing',
    lens: 'market',
    methodCardIds: ['marketing-channel-analysis-v1'],
    specialistStance:
      'Approach this assignment as a B2B acquisition economics analyst. Separate channel engagement from attributable revenue and compare like-for-like payback periods.',
    question: 'Which acquisition channels are economically sustainable?',
    decisionUse: 'Choose two channels for the next planning cycle.',
    workingDefinitions: [
      'Treat a channel as economically sustainable only when observed acquisition cost and payback evidence fit the same customer segment and time period.',
    ],
    dependencyClaimIds: [],
    sourceRequirements: {
      preferredTypes: ['primary', 'industry'],
      requiredAuthorityTypes: ['primary'],
      queryHints: ['CAC payback benchmark'],
    },
    coverageRequirements: [
      {
        schemaVersion: 2,
        id: 'cac',
        label: 'CAC',
        kind: 'quantitative_metric',
        validation: 'quantitative_value',
        required: true,
      },
      {
        schemaVersion: 2,
        id: 'payback-period',
        label: 'Payback period',
        kind: 'quantitative_metric',
        validation: 'quantitative_value',
        required: true,
      },
    ],
    prohibitedAssumptions: ['Engagement equals revenue.'],
    stopRule: {
      minimumPrimarySources: 1,
      minimumIndependentSources: 2,
      maximumSources: 6,
    },
    limits: { deadlineMs: 60_000 },
    ...overrides,
  })
}

export function makePlan(
  overrides: Partial<ResearchPlan> = {},
): ResearchPlan {
  const workerSpec = overrides.workerSpecs?.[0] ?? makeWorkerSpec()
  const task = overrides.tasks?.[0] ?? {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    id: 'task-one',
    sectionId: 'section-one',
    title: 'Channel economics',
    question: workerSpec.question,
    purpose: 'evidence_acquisition' as const,
    workerSpecId: workerSpec.id,
    dependsOn: [],
    correctionWave: 0 as const,
  }
  const sections = overrides.sections ?? [{
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    id: 'section-one',
    title: 'Acquisition',
    objective: 'Compare acquisition economics.',
    taskIds: [task.id],
  }]
  const requestId = overrides.requestId ?? 'request-one'
  const maxDurationMinutes = overrides.maxDurationMinutes ?? 20
  const maxResearcherAgents = overrides.maxResearcherAgents ?? 8
  const authenticatedDomains = overrides.authenticatedDomains ?? []
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: 'plan-one',
    requestId,
    request: overrides.request ?? makeRequest({
      requestId,
      desiredSections: sections.map((section) => section.title),
      authenticatedDomains,
      maxDurationMinutes,
      maxResearcherAgents,
    }),
    sections,
    tasks: [task],
    workerSpecs: [workerSpec],
    maxDurationMinutes,
    maxResearcherAgents,
    expectedPeakWorkers: 1,
    authenticatedDomains,
    ...overrides,
  }
}

export function makeLegacyWorkerSpec(
  requiredMetrics: readonly string[],
): ResearchWorkerSpec {
  const { coverageRequirements: _coverageRequirements, ...legacyWorker } = makeWorkerSpec()
  return createResearchWorkerSpec({ ...legacyWorker, requiredMetrics })
}

export function makeSource(
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  const source: SourceRecord = {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    sourceId: 'source-one',
    assignmentId: 'assignment-one',
    canonicalUrl: 'https://example.com/report',
    title: 'Channel economics report',
    publisher: 'Example Research',
    independenceKey: 'example-research',
    sourceType: 'primary',
    accessMethod: 'managed-browser',
    observationReceiptId: 'receipt-one',
    observedAt: TEST_TIME,
    publishedAt: TEST_TIME,
    contentSha256: TEST_HASH,
    status: 'usable',
    ...overrides,
  }
  if (source.status === 'usable' && source.accessMethod !== 'web.search') {
    return {
      ...source,
      observationReceiptId: overrides.observationReceiptId ??
        `receipt-${source.sourceId.replace(/^source-/, '')}`,
    }
  }
  const { observationReceiptId: _observationReceiptId, ...withoutReceipt } = source
  return withoutReceipt
}

export function makeEvidencePacket(
  overrides: Partial<EvidencePacket> = {},
): EvidencePacket {
  const sources = overrides.sources ?? [
    makeSource(),
    makeSource({
      sourceId: 'source-two',
      canonicalUrl: 'https://independent.example.org/benchmark',
      publisher: 'Independent Benchmark',
      independenceKey: 'independent-benchmark',
      sourceType: 'industry',
      contentSha256: 'b'.repeat(64),
    }),
  ]
  const findings = overrides.findings ?? [{
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    claimId: 'claim-one',
    taskId: 'task-one',
    sectionId: 'section-one',
    statement: 'The channel has sustainable acquisition economics.',
    kind: 'fact' as const,
    evidenceStandard: 'independent_corroboration' as const,
    sourceIds: sources.map((source) => source.sourceId),
    evidenceLinks: sources.map((source) => ({
      sourceId: source.sourceId,
      observationReceiptId: source.observationReceiptId!,
      observedExcerpt: `Observed evidence from ${source.publisher}.`,
      locator: `Source ${source.sourceId}`,
      relationship: 'supports' as const,
    })),
    confidence: 'high' as const,
    status: 'supported' as const,
    applicableScope: ['B2B SaaS'],
  }]
  const coverage = overrides.coverage ?? (findings.length === 0 ? [] : [
    {
      schemaVersion: 2 as const,
      requirementId: 'cac',
      status: 'satisfied' as const,
      claimIds: [findings[0]!.claimId],
      sourceIds: findings[0]!.sourceIds,
      value: '$120',
      unit: 'USD per acquired customer',
      asOf: TEST_TIME,
      scope: ['B2B SaaS'],
    },
    {
      schemaVersion: 2 as const,
      requirementId: 'payback-period',
      status: 'satisfied' as const,
      claimIds: [findings[0]!.claimId],
      sourceIds: findings[0]!.sourceIds,
      value: '9',
      unit: 'months',
      asOf: TEST_TIME,
      scope: ['B2B SaaS'],
    },
  ])
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    assignmentId: 'assignment-one',
    taskId: 'task-one',
    workerSpecHash: hashResearchValue(makeWorkerSpec()),
    question: 'Which acquisition channels are economically sustainable?',
    shortAnswer: 'Two channels have independently supported acquisition economics.',
    findings,
    sources,
    contradictions: [],
    unresolvedQuestions: [],
    coverage,
    stopReason: 'decision_useful',
    ...overrides,
  }
}

export function makeLegacyEvidencePacket(
  overrides: Partial<EvidencePacket> = {},
): EvidencePacket {
  const { coverage: _coverage, ...legacyPacket } = makeEvidencePacket(overrides)
  return legacyPacket
}

export function makeDomainCard(
  overrides: Partial<DomainCard> = {},
): DomainCard {
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    cardId: 'domain-one',
    domain: 'B2B SaaS marketing',
    scope: ['Acquisition economics'],
    jurisdictions: ['US'],
    asOf: TEST_TIME,
    glossary: [{
      term: 'CAC',
      definition: 'Customer acquisition cost.',
      sourceIds: ['source-one'],
      confidence: 'high',
    }],
    authorities: [],
    sourceHierarchy: [{
      claimType: 'Channel economics',
      preferredSourceTypes: ['primary', 'industry'],
    }],
    constraints: [],
    disputedConcepts: [],
    prohibitedAssumptions: ['Engagement equals revenue.'],
    validUntil: '2027-07-16T12:00:00.000Z',
    validation: { decision: 'accepted', issues: [] },
    ...overrides,
  }
}
