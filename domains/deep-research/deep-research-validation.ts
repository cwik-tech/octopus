import { isSafePathSegment } from '../../core/path-safety.js'
import {
  DEEP_RESEARCH_BASE_AGENT,
  DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION,
  DEEP_RESEARCH_METHOD_CARD_IDS,
  DEEP_RESEARCH_SCHEMA_VERSION,
  RESEARCH_TASK_PURPOSES,
  type ClaimEvidenceLink,
  type ClaimRecord,
  type CorrectionRequest,
  type DeepResearchRequest,
  type DomainCard,
  type EvidencePacket,
  type QualityFinding,
  type QualityVerdict,
  type ResearchLens,
  type ResearchCoverageRequirement,
  type ResearchCoverageRequirementKind,
  type ResearchCoverageValidation,
  type ResearchExecutionPolicy,
  type ResearchMethodCardId,
  type ResearchPlan,
  type ResearchRequirementCoverage,
  type ResearchSection,
  type ResearchSourceType,
  type ResearchTask,
  type ResearchTaskPurpose,
  type ResearchWorkerSpec,
  type SourceRecord,
} from '../../contracts/deep-research.js'
import { isUnknownArray } from '../../core/unknown-array.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_OBSERVED_EXCERPT_CHARACTERS = 2_000
const MAX_EVIDENCE_LOCATOR_CHARACTERS = 500
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const RESEARCH_LENSES = new Set<ResearchLens>([
  'foundational',
  'market',
  'competitive',
  'regulatory',
  'technical',
  'historical',
  'source_verification',
])
const SOURCE_TYPES = new Set<ResearchSourceType>([
  'primary',
  'secondary',
  'regulatory',
  'academic',
  'industry',
  'news',
  'vendor',
  'community',
])
const METHOD_CARD_IDS = new Set<ResearchMethodCardId>(
  DEEP_RESEARCH_METHOD_CARD_IDS,
)
const TASK_PURPOSES = new Set<ResearchTaskPurpose>(RESEARCH_TASK_PURPOSES)
const COVERAGE_REQUIREMENT_KINDS = new Set<ResearchCoverageRequirementKind>([
  'fact',
  'quantitative_metric',
  'comparison',
  'source_authority',
  'caveat',
  'decision',
])
const COVERAGE_VALIDATIONS = new Set<ResearchCoverageValidation>([
  'claim_support',
  'quantitative_value',
  'independent_comparison',
  'source_authority',
  'explicit_caveat',
  'decision_support',
])
const COVERAGE_VALIDATION_BY_KIND: Readonly<Record<
  ResearchCoverageRequirementKind,
  ResearchCoverageValidation
>> = {
  fact: 'claim_support',
  quantitative_metric: 'quantitative_value',
  comparison: 'independent_comparison',
  source_authority: 'source_authority',
  caveat: 'explicit_caveat',
  decision: 'decision_support',
}

export type DeepResearchValidationErrorCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'unknown_field'
  | 'duplicate_value'
  | 'invalid_reference'
  | 'security_violation'

export class DeepResearchValidationError extends Error {
  constructor(
    readonly code: DeepResearchValidationErrorCode,
    readonly field: string,
    message: string,
  ) {
    super(message)
    this.name = 'DeepResearchValidationError'
  }
}

export function parseDeepResearchRequest(value: unknown): DeepResearchRequest {
  const input = strictRecord(value, 'request', [
    'schemaVersion', 'requestId', 'question', 'objective', 'audience',
    'includedScope', 'excludedScope', 'desiredSections', 'jurisdictions',
    'freshnessAsOf', 'authenticatedDomains', 'sourceRequirements',
    'maxDurationMinutes', 'maxResearcherAgents', 'outputFormats',
  ])
  assertVersion(input.schemaVersion, 'request.schemaVersion')
  const outputFormats = stringArray(input.outputFormats, 'request.outputFormats')
  if (outputFormats.length !== 2 || outputFormats[0] !== 'markdown' || outputFormats[1] !== 'docx') {
    invalid('invalid_value', 'request.outputFormats', 'Output formats must be markdown followed by docx.')
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    requestId: safeId(input.requestId, 'request.requestId'),
    question: text(input.question, 'request.question'),
    objective: text(input.objective, 'request.objective'),
    audience: text(input.audience, 'request.audience'),
    includedScope: stringArray(input.includedScope, 'request.includedScope'),
    excludedScope: stringArray(input.excludedScope, 'request.excludedScope'),
    desiredSections: nonEmptyStringArray(input.desiredSections, 'request.desiredSections'),
    jurisdictions: stringArray(input.jurisdictions, 'request.jurisdictions'),
    freshnessAsOf: isoTimestamp(input.freshnessAsOf, 'request.freshnessAsOf'),
    authenticatedDomains: domainArray(input.authenticatedDomains, 'request.authenticatedDomains'),
    sourceRequirements: stringArray(input.sourceRequirements, 'request.sourceRequirements'),
    maxDurationMinutes: integerInRange(input.maxDurationMinutes, 'request.maxDurationMinutes', 5, 120),
    maxResearcherAgents: integerInRange(input.maxResearcherAgents, 'request.maxResearcherAgents', 1, 8),
    outputFormats: ['markdown', 'docx'],
  }
}

export function parseResearchSection(value: unknown): ResearchSection {
  const input = strictRecord(value, 'section', [
    'schemaVersion', 'id', 'title', 'objective', 'taskIds',
  ])
  assertVersion(input.schemaVersion, 'section.schemaVersion')
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    id: safeId(input.id, 'section.id'),
    title: text(input.title, 'section.title'),
    objective: text(input.objective, 'section.objective'),
    taskIds: safeIdArray(input.taskIds, 'section.taskIds'),
  }
}

export function parseResearchTask(value: unknown): ResearchTask {
  const input = strictRecord(value, 'task', [
    'schemaVersion', 'id', 'sectionId', 'title', 'question', 'purpose', 'workerSpecId',
    'dependsOn', 'correctionWave',
  ])
  assertVersion(input.schemaVersion, 'task.schemaVersion')
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    id: safeId(input.id, 'task.id'),
    sectionId: safeId(input.sectionId, 'task.sectionId'),
    title: text(input.title, 'task.title'),
    question: text(input.question, 'task.question'),
    purpose: enumValue(input.purpose, 'task.purpose', TASK_PURPOSES),
    workerSpecId: safeId(input.workerSpecId, 'task.workerSpecId'),
    dependsOn: safeIdArray(input.dependsOn, 'task.dependsOn'),
    correctionWave: correctionWave(input.correctionWave, 'task.correctionWave'),
  }
}

export function parseResearchWorkerSpec(value: unknown): ResearchWorkerSpec {
  const input = strictRecord(value, 'workerSpec', [
    'schemaVersion', 'id', 'laneId', 'sectionId', 'baseAgent', 'displayRole',
    'domain', 'lens', 'methodCardIds', 'specialistStance', 'question',
    'decisionUse', 'workingDefinitions', 'dependencyClaimIds', 'sourceRequirements',
    'prohibitedAssumptions', 'stopRule', 'limits',
  ], [
    'domainCardRef', 'requiredMetrics', 'coverageRequirements',
  ])
  assertVersion(input.schemaVersion, 'workerSpec.schemaVersion')
  if (input.baseAgent !== DEEP_RESEARCH_BASE_AGENT) {
    invalid('security_violation', 'workerSpec.baseAgent', 'Research workers must use the trusted Web Researcher identity.')
  }
  const sourceRequirements = strictRecord(input.sourceRequirements, 'workerSpec.sourceRequirements', [
    'preferredTypes', 'requiredAuthorityTypes', 'queryHints',
  ])
  const stopRule = strictRecord(input.stopRule, 'workerSpec.stopRule', [
    'minimumPrimarySources', 'minimumIndependentSources', 'maximumSources',
  ])
  const limits = strictRecord(input.limits, 'workerSpec.limits', ['deadlineMs'])
  const maximumSources = integerInRange(stopRule.maximumSources, 'workerSpec.stopRule.maximumSources', 1, 50)
  const minimumPrimarySources = integerInRange(stopRule.minimumPrimarySources, 'workerSpec.stopRule.minimumPrimarySources', 0, maximumSources)
  const minimumIndependentSources = integerInRange(stopRule.minimumIndependentSources, 'workerSpec.stopRule.minimumIndependentSources', 1, maximumSources)
  if ((input.requiredMetrics === undefined) === (input.coverageRequirements === undefined)) {
    invalid(
      'invalid_value',
      'workerSpec.coverageRequirements',
      'Worker specifications must contain exactly one of legacy requiredMetrics or coverageRequirements.',
    )
  }
  const coverageRequirements = input.coverageRequirements === undefined
    ? undefined
    : objectArray(
        input.coverageRequirements,
        'workerSpec.coverageRequirements',
        parseResearchCoverageRequirement,
      )
  if (coverageRequirements) {
    assertUnique(
      coverageRequirements.map((requirement) => requirement.id),
      'workerSpec.coverageRequirements',
    )
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    id: safeId(input.id, 'workerSpec.id'),
    laneId: safeId(input.laneId, 'workerSpec.laneId'),
    sectionId: safeId(input.sectionId, 'workerSpec.sectionId'),
    baseAgent: DEEP_RESEARCH_BASE_AGENT,
    displayRole: text(input.displayRole, 'workerSpec.displayRole'),
    domain: text(input.domain, 'workerSpec.domain'),
    lens: enumValue(input.lens, 'workerSpec.lens', RESEARCH_LENSES),
    methodCardIds: methodCardIdArray(input.methodCardIds, 'workerSpec.methodCardIds'),
    ...(input.domainCardRef === undefined ? {} : {
      domainCardRef: safeId(input.domainCardRef, 'workerSpec.domainCardRef'),
    }),
    specialistStance: text(
      input.specialistStance,
      'workerSpec.specialistStance',
    ),
    question: text(input.question, 'workerSpec.question'),
    decisionUse: text(input.decisionUse, 'workerSpec.decisionUse'),
    workingDefinitions: stringArray(
      input.workingDefinitions,
      'workerSpec.workingDefinitions',
    ),
    dependencyClaimIds: safeIdArray(input.dependencyClaimIds, 'workerSpec.dependencyClaimIds'),
    sourceRequirements: {
      preferredTypes: sourceTypeArray(sourceRequirements.preferredTypes, 'workerSpec.sourceRequirements.preferredTypes'),
      requiredAuthorityTypes: sourceTypeArray(sourceRequirements.requiredAuthorityTypes, 'workerSpec.sourceRequirements.requiredAuthorityTypes'),
      queryHints: stringArray(sourceRequirements.queryHints, 'workerSpec.sourceRequirements.queryHints'),
    },
    ...(input.requiredMetrics === undefined ? {} : {
      requiredMetrics: stringArray(input.requiredMetrics, 'workerSpec.requiredMetrics'),
    }),
    ...(coverageRequirements === undefined ? {} : { coverageRequirements }),
    prohibitedAssumptions: stringArray(input.prohibitedAssumptions, 'workerSpec.prohibitedAssumptions'),
    stopRule: { minimumPrimarySources, minimumIndependentSources, maximumSources },
    limits: {
      deadlineMs: integerInRange(limits.deadlineMs, 'workerSpec.limits.deadlineMs', 1_000, 7_200_000),
    },
  }
}

export function parseResearchCoverageRequirement(
  value: unknown,
): ResearchCoverageRequirement {
  const input = strictRecord(value, 'coverageRequirement', [
    'schemaVersion', 'id', 'label', 'kind', 'validation', 'required',
  ])
  if (input.schemaVersion !== DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION) {
    invalid(
      'invalid_value',
      'coverageRequirement.schemaVersion',
      'Coverage requirements use an unsupported schema version.',
    )
  }
  const kind = enumValue(
    input.kind,
    'coverageRequirement.kind',
    COVERAGE_REQUIREMENT_KINDS,
  )
  const validation = enumValue(
    input.validation,
    'coverageRequirement.validation',
    COVERAGE_VALIDATIONS,
  )
  if (COVERAGE_VALIDATION_BY_KIND[kind] !== validation) {
    invalid(
      'invalid_value',
      'coverageRequirement.validation',
      `Coverage requirement kind '${kind}' must use '${COVERAGE_VALIDATION_BY_KIND[kind]}'.`,
    )
  }
  if (typeof input.required !== 'boolean') {
    invalid(
      'invalid_type',
      'coverageRequirement.required',
      'coverageRequirement.required must be a boolean.',
    )
  }
  return {
    schemaVersion: DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION,
    id: safeId(input.id, 'coverageRequirement.id'),
    label: text(input.label, 'coverageRequirement.label'),
    kind,
    validation,
    required: input.required,
  }
}

function parseResearchExecutionPolicy(
  value: unknown,
): ResearchExecutionPolicy {
  const input = strictRecord(value, 'executionPolicy', [
    'schemaVersion',
    'complexity',
    'complexityRationale',
    'searchBreadth',
    'maxCostUsd',
    'evidenceTargets',
    'stopping',
    'synthesis',
  ])
  assertVersion(input.schemaVersion, 'executionPolicy.schemaVersion')
  const evidenceTargets = strictRecord(
    input.evidenceTargets,
    'executionPolicy.evidenceTargets',
    [
      'minimumSupportedClaims',
      'minimumIndependentSourcesPerConsequentialClaim',
      'crossVerifyConsequentialClaims',
    ],
  )
  const stopping = strictRecord(input.stopping, 'executionPolicy.stopping', [
    'minimumExpectedInformationGain',
    'maximumCorrectionWaves',
  ])
  const synthesis = strictRecord(input.synthesis, 'executionPolicy.synthesis', [
    'mode',
    'maximumParallelSections',
  ])
  if (typeof evidenceTargets.crossVerifyConsequentialClaims !== 'boolean') {
    invalid(
      'invalid_type',
      'executionPolicy.evidenceTargets.crossVerifyConsequentialClaims',
      'executionPolicy.evidenceTargets.crossVerifyConsequentialClaims must be a boolean.',
    )
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    complexity: literalUnion(
      input.complexity,
      'executionPolicy.complexity',
      ['simple', 'standard', 'complex'] as const,
    ),
    complexityRationale: boundedText(
      input.complexityRationale,
      'executionPolicy.complexityRationale',
      500,
    ),
    searchBreadth: literalUnion(
      input.searchBreadth,
      'executionPolicy.searchBreadth',
      ['focused', 'balanced', 'broad'] as const,
    ),
    maxCostUsd: finiteNumberInRange(
      input.maxCostUsd,
      'executionPolicy.maxCostUsd',
      0.5,
      40,
    ),
    evidenceTargets: {
      minimumSupportedClaims: integerInRange(
        evidenceTargets.minimumSupportedClaims,
        'executionPolicy.evidenceTargets.minimumSupportedClaims',
        1,
        100,
      ),
      minimumIndependentSourcesPerConsequentialClaim: integerInRange(
        evidenceTargets.minimumIndependentSourcesPerConsequentialClaim,
        'executionPolicy.evidenceTargets.minimumIndependentSourcesPerConsequentialClaim',
        1,
        5,
      ),
      crossVerifyConsequentialClaims:
        evidenceTargets.crossVerifyConsequentialClaims,
    },
    stopping: {
      minimumExpectedInformationGain: integerInRange(
        stopping.minimumExpectedInformationGain,
        'executionPolicy.stopping.minimumExpectedInformationGain',
        0,
        100,
      ),
      maximumCorrectionWaves: literalUnion(
        stopping.maximumCorrectionWaves,
        'executionPolicy.stopping.maximumCorrectionWaves',
        [0, 1, 2] as const,
      ),
    },
    synthesis: {
      mode: literalUnion(
        synthesis.mode,
        'executionPolicy.synthesis.mode',
        ['single_pass', 'section_dossiers'] as const,
      ),
      maximumParallelSections: integerInRange(
        synthesis.maximumParallelSections,
        'executionPolicy.synthesis.maximumParallelSections',
        1,
        8,
      ),
    },
  }
}

export function parseResearchPlan(value: unknown): ResearchPlan {
  const input = strictRecord(value, 'plan', [
    'schemaVersion', 'planId', 'requestId', 'request', 'sections', 'tasks', 'workerSpecs',
    'maxDurationMinutes', 'maxResearcherAgents', 'expectedPeakWorkers',
    'authenticatedDomains',
  ], ['executionPolicy', 'approvedAt', 'approvalHash'])
  assertVersion(input.schemaVersion, 'plan.schemaVersion')
  const request = parseDeepResearchRequest(input.request)
  const sections = objectArray(input.sections, 'plan.sections', parseResearchSection, true)
  const tasks = objectArray(input.tasks, 'plan.tasks', parseResearchTask, true)
  const workerSpecs = objectArray(input.workerSpecs, 'plan.workerSpecs', parseResearchWorkerSpec, true)
  const maxResearcherAgents = integerInRange(input.maxResearcherAgents, 'plan.maxResearcherAgents', 1, 8)
  const plan: ResearchPlan = {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: safeId(input.planId, 'plan.planId'),
    requestId: safeId(input.requestId, 'plan.requestId'),
    request,
    sections,
    tasks,
    workerSpecs,
    maxDurationMinutes: integerInRange(input.maxDurationMinutes, 'plan.maxDurationMinutes', 5, 120),
    maxResearcherAgents,
    expectedPeakWorkers: integerInRange(input.expectedPeakWorkers, 'plan.expectedPeakWorkers', 1, maxResearcherAgents),
    authenticatedDomains: domainArray(input.authenticatedDomains, 'plan.authenticatedDomains'),
    ...(input.executionPolicy === undefined ? {} : {
      executionPolicy: parseResearchExecutionPolicy(input.executionPolicy),
    }),
    ...(input.approvedAt === undefined ? {} : {
      approvedAt: isoTimestamp(input.approvedAt, 'plan.approvedAt'),
    }),
    ...(input.approvalHash === undefined ? {} : {
      approvalHash: sha256(input.approvalHash, 'plan.approvalHash'),
    }),
  }
  validatePlanReferences(plan)
  return plan
}

export function parseDomainCard(value: unknown): DomainCard {
  const input = strictRecord(value, 'domainCard', [
    'schemaVersion', 'cardId', 'domain', 'scope', 'jurisdictions', 'asOf',
    'glossary', 'authorities', 'sourceHierarchy', 'constraints',
    'disputedConcepts', 'prohibitedAssumptions', 'validUntil', 'validation',
  ])
  assertVersion(input.schemaVersion, 'domainCard.schemaVersion')
  const validation = strictRecord(input.validation, 'domainCard.validation', ['decision', 'issues'])
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    cardId: safeId(input.cardId, 'domainCard.cardId'),
    domain: text(input.domain, 'domainCard.domain'),
    scope: nonEmptyStringArray(input.scope, 'domainCard.scope'),
    jurisdictions: stringArray(input.jurisdictions, 'domainCard.jurisdictions'),
    asOf: isoTimestamp(input.asOf, 'domainCard.asOf'),
    glossary: objectArray(input.glossary, 'domainCard.glossary', parseGlossaryEntry),
    authorities: objectArray(input.authorities, 'domainCard.authorities', parseAuthority),
    sourceHierarchy: objectArray(input.sourceHierarchy, 'domainCard.sourceHierarchy', parseSourceHierarchy),
    constraints: objectArray(input.constraints, 'domainCard.constraints', parseConstraint),
    disputedConcepts: objectArray(input.disputedConcepts, 'domainCard.disputedConcepts', parseDisputedConcept),
    prohibitedAssumptions: stringArray(input.prohibitedAssumptions, 'domainCard.prohibitedAssumptions'),
    validUntil: isoTimestamp(input.validUntil, 'domainCard.validUntil'),
    validation: {
      decision: literalUnion(validation.decision, 'domainCard.validation.decision', ['accepted', 'rejected'] as const),
      issues: stringArray(validation.issues, 'domainCard.validation.issues'),
    },
  }
}

export function parseSourceRecord(value: unknown): SourceRecord {
  const input = strictRecord(value, 'source', [
    'schemaVersion', 'sourceId', 'assignmentId', 'canonicalUrl', 'title',
    'publisher', 'independenceKey', 'sourceType', 'accessMethod', 'status',
  ], ['publishedAt', 'observationReceiptId', 'observedAt', 'contentSha256'])
  assertVersion(input.schemaVersion, 'source.schemaVersion')
  const accessMethod = literalUnion(input.accessMethod, 'source.accessMethod', [
    'direct-http',
    'direct-http-proxied',
    'managed-browser',
    'managed-browser-proxied',
    'managed-reader',
    'cloud-browser',
    'document-parser',
    'web.search',
  ] as const)
  const status = literalUnion(input.status, 'source.status', ['usable', 'blocked', 'stale', 'rejected'] as const)
  const directlyObserved = status === 'usable' && accessMethod !== 'web.search'
  if (directlyObserved && input.observationReceiptId === undefined) {
    invalid(
      'invalid_reference',
      'source.observationReceiptId',
      'A usable acquired source requires a runtime observation receipt.',
    )
  }
  if (!directlyObserved && input.observationReceiptId !== undefined) {
    invalid(
      'invalid_reference',
      'source.observationReceiptId',
      'Only usable acquired sources may reference an observation receipt.',
    )
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    sourceId: safeId(input.sourceId, 'source.sourceId'),
    assignmentId: safeId(input.assignmentId, 'source.assignmentId'),
    canonicalUrl: httpUrl(input.canonicalUrl, 'source.canonicalUrl'),
    title: text(input.title, 'source.title'),
    publisher: text(input.publisher, 'source.publisher'),
    independenceKey: text(input.independenceKey, 'source.independenceKey'),
    sourceType: enumValue(input.sourceType, 'source.sourceType', SOURCE_TYPES),
    accessMethod,
    ...(input.observationReceiptId === undefined ? {} : {
      observationReceiptId: safeId(input.observationReceiptId, 'source.observationReceiptId'),
    }),
    // A receipt-backed source has its observation time and content digest
    // supplied by the runtime from the receipt it names, so the worker is not
    // asked to transcribe them and a mistyped copy cannot fail the packet.
    // Every other source is unbacked, so both stay strictly required there.
    observedAt: directlyObserved
      ? optionalIsoTimestamp(input.observedAt, 'source.observedAt')
      : isoTimestamp(input.observedAt, 'source.observedAt'),
    ...(input.publishedAt === undefined ? {} : {
      publishedAt: isoTimestamp(input.publishedAt, 'source.publishedAt'),
    }),
    contentSha256: directlyObserved
      ? optionalSha256(input.contentSha256)
      : sha256(input.contentSha256, 'source.contentSha256'),
    status,
  }
}

/** A runtime-derived timestamp: keep a well-formed copy, tolerate the rest. */
function optionalIsoTimestamp(value: unknown, field: string): string {
  if (value === undefined || value === '') return ''
  try {
    return isoTimestamp(value, field)
  } catch {
    return ''
  }
}

/** A runtime-derived digest: keep a well-formed copy, tolerate the rest. */
function optionalSha256(value: unknown): string {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : ''
}

export function parseClaimEvidenceLink(value: unknown): ClaimEvidenceLink {
  const input = strictRecord(value, 'claim.evidenceLinks[]', [
    'sourceId', 'observationReceiptId', 'observedExcerpt', 'locator',
    'relationship',
  ])
  return {
    sourceId: safeId(input.sourceId, 'claim.evidenceLinks[].sourceId'),
    observationReceiptId: safeId(
      input.observationReceiptId,
      'claim.evidenceLinks[].observationReceiptId',
    ),
    observedExcerpt: boundedText(
      input.observedExcerpt,
      'claim.evidenceLinks[].observedExcerpt',
      MAX_OBSERVED_EXCERPT_CHARACTERS,
    ),
    locator: boundedText(
      input.locator,
      'claim.evidenceLinks[].locator',
      MAX_EVIDENCE_LOCATOR_CHARACTERS,
    ),
    relationship: literalUnion(
      input.relationship,
      'claim.evidenceLinks[].relationship',
      ['supports', 'contradicts', 'context'] as const,
    ),
  }
}

export function parseClaimRecord(value: unknown): ClaimRecord {
  const input = strictRecord(value, 'claim', [
    'schemaVersion', 'claimId', 'taskId', 'sectionId', 'statement', 'kind',
    'evidenceStandard', 'sourceIds', 'evidenceLinks', 'confidence', 'status',
    'applicableScope',
  ])
  assertVersion(input.schemaVersion, 'claim.schemaVersion')
  const status = literalUnion(input.status, 'claim.status', ['supported', 'disputed', 'unsupported', 'removed'] as const)
  const evidenceLinks = objectArray(
    input.evidenceLinks,
    'claim.evidenceLinks',
    parseClaimEvidenceLink,
  )
  assertUnique(
    evidenceLinks.map((link) => [
      link.sourceId,
      link.observationReceiptId,
      link.locator,
      link.observedExcerpt,
      link.relationship,
    ].join('\0')),
    'claim.evidenceLinks',
  )
  if (status === 'supported' && !evidenceLinks.some((link) => link.relationship === 'supports')) {
    invalid(
      'invalid_reference',
      'claim.evidenceLinks',
      'A supported claim requires at least one supporting observation link.',
    )
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    claimId: safeId(input.claimId, 'claim.claimId'),
    taskId: safeId(input.taskId, 'claim.taskId'),
    sectionId: safeId(input.sectionId, 'claim.sectionId'),
    statement: text(input.statement, 'claim.statement'),
    kind: literalUnion(input.kind, 'claim.kind', ['fact', 'inference', 'uncertainty'] as const),
    evidenceStandard: literalUnion(input.evidenceStandard, 'claim.evidenceStandard', ['single', 'independent_corroboration'] as const),
    sourceIds: safeIdArray(input.sourceIds, 'claim.sourceIds'),
    evidenceLinks,
    confidence: confidence(input.confidence, 'claim.confidence'),
    status,
    applicableScope: stringArray(input.applicableScope, 'claim.applicableScope'),
  }
}

export function parseEvidencePacket(value: unknown): EvidencePacket {
  const input = strictRecord(value, 'evidencePacket', [
    'schemaVersion', 'assignmentId', 'taskId', 'workerSpecHash', 'question',
    'shortAnswer', 'findings', 'sources', 'contradictions',
    'unresolvedQuestions', 'stopReason',
  ], ['coverage'])
  assertVersion(input.schemaVersion, 'evidencePacket.schemaVersion')
  const findings = objectArray(input.findings, 'evidencePacket.findings', parseClaimRecord)
  const sources = objectArray(input.sources, 'evidencePacket.sources', parseSourceRecord)
  const taskId = safeId(input.taskId, 'evidencePacket.taskId')
  const assignmentId = safeId(input.assignmentId, 'evidencePacket.assignmentId')
  const sourceIds = uniqueSourceMap(sources)
  const claimIds = new Map(findings.map((claim) => [claim.claimId, claim]))
  assertUnique(findings.map((claim) => claim.claimId), 'evidencePacket.findings')
  if (findings.some((claim) => claim.taskId !== taskId || claim.sourceIds.some((id) => !sourceIds.has(id)))) {
    invalid('invalid_reference', 'evidencePacket.findings', 'Claims must belong to the packet task and reference packet sources.')
  }
  if (sources.some((source) => source.assignmentId !== assignmentId)) {
    invalid('invalid_reference', 'evidencePacket.sources', 'Sources must belong to the packet assignment.')
  }
  const receiptOwners = new Map<string, string>()
  for (const source of sources) {
    if (!source.observationReceiptId) continue
    const existingOwner = receiptOwners.get(source.observationReceiptId)
    if (existingOwner && existingOwner !== source.sourceId) {
      invalid(
        'invalid_reference',
        'evidencePacket.sources',
        'An observation receipt cannot be reused across different source records.',
      )
    }
    receiptOwners.set(source.observationReceiptId, source.sourceId)
  }
  for (const claim of findings) {
    const linkedSourceIds = new Set(claim.evidenceLinks.map((link) => link.sourceId))
    if (!sameStringSet(claim.sourceIds, linkedSourceIds)) {
      invalid(
        'invalid_reference',
        `evidencePacket.findings.${claim.claimId}.evidenceLinks`,
        'Claim sourceIds must exactly match the sources represented by its evidence links.',
      )
    }
    for (const link of claim.evidenceLinks) {
      const source = sourceIds.get(link.sourceId)
      if (!source) {
        invalid(
          'invalid_reference',
          `evidencePacket.findings.${claim.claimId}.evidenceLinks`,
          'Claim evidence links must reference packet sources.',
        )
      }
      if (
        source.accessMethod === 'web.search' ||
        source.status !== 'usable' ||
        source.observationReceiptId !== link.observationReceiptId
      ) {
        invalid(
          'invalid_reference',
          `evidencePacket.findings.${claim.claimId}.evidenceLinks`,
          'Claim evidence must bind to the receipt of a usable acquired source; search snippets are not evidence.',
        )
      }
    }
  }
  const coverage = input.coverage === undefined
    ? undefined
    : objectArray(
        input.coverage,
        'evidencePacket.coverage',
        parseResearchRequirementCoverage,
      )
  if (coverage) {
    assertUnique(
      coverage.map((entry) => entry.requirementId),
      'evidencePacket.coverage',
    )
    for (const entry of coverage) {
      if (
        entry.claimIds.some((claimId) => !claimIds.has(claimId)) ||
        entry.sourceIds.some((sourceId) => !sourceIds.has(sourceId))
      ) {
        invalid(
          'invalid_reference',
          `evidencePacket.coverage.${entry.requirementId}`,
          'Requirement coverage must reference claims and sources in the same evidence packet.',
        )
      }
    }
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    assignmentId,
    taskId,
    workerSpecHash: sha256(input.workerSpecHash, 'evidencePacket.workerSpecHash'),
    question: text(input.question, 'evidencePacket.question'),
    shortAnswer: text(input.shortAnswer, 'evidencePacket.shortAnswer', true),
    findings,
    sources,
    contradictions: objectArray(input.contradictions, 'evidencePacket.contradictions', parseContradiction),
    unresolvedQuestions: stringArray(input.unresolvedQuestions, 'evidencePacket.unresolvedQuestions'),
    ...(coverage === undefined ? {} : { coverage }),
    stopReason: literalUnion(input.stopReason, 'evidencePacket.stopReason', [
      'decision_useful', 'source_limit', 'time_limit', 'insufficient_evidence',
    ] as const),
  }
}

export function parseResearchRequirementCoverage(
  value: unknown,
): ResearchRequirementCoverage {
  const input = strictRecord(value, 'requirementCoverage', [
    'schemaVersion', 'requirementId', 'status', 'claimIds', 'sourceIds',
  ], ['value', 'unit', 'asOf', 'scope', 'note'])
  if (input.schemaVersion !== DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION) {
    invalid(
      'invalid_value',
      'requirementCoverage.schemaVersion',
      'Requirement coverage uses an unsupported schema version.',
    )
  }
  const status = literalUnion(
    input.status,
    'requirementCoverage.status',
    ['satisfied', 'unresolved', 'not_applicable'] as const,
  )
  const claimIds = safeIdArray(input.claimIds, 'requirementCoverage.claimIds')
  const sourceIds = safeIdArray(input.sourceIds, 'requirementCoverage.sourceIds')
  const optionalText = (field: 'value' | 'unit' | 'note'): string | undefined => {
    if (input[field] === undefined) return undefined
    const value = text(input[field], `requirementCoverage.${field}`, true)
    return value || undefined
  }
  const valueText = optionalText('value')
  const unitText = optionalText('unit')
  const noteText = optionalText('note')
  const asOf = input.asOf === undefined || input.asOf === ''
    ? undefined
    : isoDateOrTimestamp(input.asOf, 'requirementCoverage.asOf')
  const parsed = {
    schemaVersion: DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION,
    requirementId: safeId(input.requirementId, 'requirementCoverage.requirementId'),
    status,
    claimIds,
    sourceIds,
    ...(valueText === undefined ? {} : { value: valueText }),
    ...(unitText === undefined ? {} : { unit: unitText }),
    ...(asOf === undefined ? {} : { asOf }),
    ...(input.scope === undefined ? {} : {
      scope: stringArray(input.scope, 'requirementCoverage.scope'),
    }),
    ...(noteText === undefined ? {} : { note: noteText }),
  } satisfies ResearchRequirementCoverage
  if (
    status === 'satisfied' &&
    claimIds.length === 0 &&
    sourceIds.length === 0 &&
    !parsed.value &&
    !parsed.note
  ) {
    invalid(
      'invalid_value',
      'requirementCoverage.status',
      'Satisfied requirement coverage must identify supporting content.',
    )
  }
  if (status !== 'satisfied' && !parsed.note) {
    invalid(
      'invalid_value',
      'requirementCoverage.note',
      'Unresolved or not-applicable requirement coverage requires an explanation.',
    )
  }
  return parsed
}

function uniqueSourceMap(sources: readonly SourceRecord[]): Map<string, SourceRecord> {
  const result = new Map<string, SourceRecord>()
  for (const source of sources) {
    if (result.has(source.sourceId)) {
      invalid(
        'duplicate_value',
        'evidencePacket.sources',
        'evidencePacket.sources contains duplicate source IDs.',
      )
    }
    result.set(source.sourceId, source)
  }
  return result
}

function sameStringSet(values: readonly string[], expected: ReadonlySet<string>): boolean {
  return values.length === expected.size && values.every((value) => expected.has(value))
}

export function parseCorrectionRequest(value: unknown): CorrectionRequest {
  const input = strictRecord(value, 'correction', [
    'schemaVersion', 'id', 'type', 'claimIds', 'taskIds', 'sectionIds',
    'acceptanceCriteria', 'impactScope',
  ], ['question', 'requirementIds'])
  assertVersion(input.schemaVersion, 'correction.schemaVersion')
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    id: safeId(input.id, 'correction.id'),
    type: literalUnion(input.type, 'correction.type', [
      'new_research', 'cross_verify', 'verify_source', 'resolve_contradiction',
      'remove_claim', 'resynthesize', 'restructure_packet',
    ] as const),
    claimIds: safeIdArray(input.claimIds, 'correction.claimIds'),
    taskIds: safeIdArray(input.taskIds, 'correction.taskIds'),
    sectionIds: safeIdArray(input.sectionIds, 'correction.sectionIds'),
    ...(input.requirementIds === undefined ? {} : {
      requirementIds: safeIdArray(input.requirementIds, 'correction.requirementIds'),
    }),
    ...(input.question === undefined ? {} : {
      question: text(input.question, 'correction.question'),
    }),
    acceptanceCriteria: nonEmptyStringArray(input.acceptanceCriteria, 'correction.acceptanceCriteria'),
    impactScope: literalUnion(input.impactScope, 'correction.impactScope', ['local', 'global'] as const),
  }
}

export function parseQualityVerdict(value: unknown): QualityVerdict {
  const input = strictRecord(value, 'verdict', [
    'schemaVersion', 'verdictId', 'correctionWave', 'decision', 'findings',
    'correctionRequests', 'reviewedAt',
  ], ['correctionRoute'])
  assertVersion(input.schemaVersion, 'verdict.schemaVersion')
  const findings = objectArray(input.findings, 'verdict.findings', parseQualityFinding)
  const correctionRequests = objectArray(input.correctionRequests, 'verdict.correctionRequests', parseCorrectionRequest)
  const decision = literalUnion(input.decision, 'verdict.decision', ['APPROVE', 'REVISE', 'ESCALATE'] as const)
  if (decision === 'APPROVE' && (findings.some((finding) => finding.severity === 'blocking') || correctionRequests.length > 0)) {
    invalid('invalid_value', 'verdict.decision', 'An approval cannot contain blocking findings or correction requests.')
  }
  if (decision === 'REVISE' && correctionRequests.length === 0) {
    invalid('invalid_value', 'verdict.correctionRequests', 'A revision verdict requires targeted correction requests.')
  }
  const correctionRoute = input.correctionRoute === undefined
    ? undefined
    : literalUnion(
        input.correctionRoute,
        'verdict.correctionRoute',
        ['research', 'synthesis'] as const,
      )
  if (correctionRoute !== undefined && decision !== 'REVISE') {
    invalid(
      'invalid_value',
      'verdict.correctionRoute',
      'Only revision verdicts may select a correction route.',
    )
  }
  if (
    correctionRoute === 'synthesis' &&
    correctionRequests.some((request) => request.type !== 'resynthesize')
  ) {
    invalid(
      'invalid_value',
      'verdict.correctionRoute',
      'Synthesis-only correction routes may contain only resynthesize requests.',
    )
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    verdictId: safeId(input.verdictId, 'verdict.verdictId'),
    correctionWave: correctionWave(input.correctionWave, 'verdict.correctionWave'),
    decision,
    findings,
    correctionRequests,
    ...(correctionRoute === undefined ? {} : { correctionRoute }),
    reviewedAt: isoTimestamp(input.reviewedAt, 'verdict.reviewedAt'),
  }
}

function validatePlanReferences(plan: ResearchPlan): void {
  if (plan.request.requestId !== plan.requestId) {
    invalid('invalid_reference', 'plan.request.requestId', 'Research request ID must match the owning plan request ID.')
  }
  if (
    plan.request.maxDurationMinutes !== plan.maxDurationMinutes ||
    plan.request.maxResearcherAgents !== plan.maxResearcherAgents
  ) {
    invalid('invalid_reference', 'plan.request', 'Research request limits must exactly match the approved plan limits.')
  }
  if (plan.request.authenticatedDomains.join('\0') !== plan.authenticatedDomains.join('\0')) {
    invalid('invalid_reference', 'plan.request.authenticatedDomains', 'Research request domains must exactly match the approved plan domains.')
  }
  if (plan.request.desiredSections.join('\0') !== plan.sections.map((section) => section.title).join('\0')) {
    invalid('invalid_reference', 'plan.request.desiredSections', 'Research request sections must exactly match the ordered approved plan sections.')
  }
  const sections = uniqueById(plan.sections, 'plan.sections')
  const tasks = uniqueById(plan.tasks, 'plan.tasks')
  const specs = uniqueById(plan.workerSpecs, 'plan.workerSpecs')
  const assignedSpecIds = new Set<string>()
  for (const task of plan.tasks) {
    if (task.purpose === 'report_synthesis') {
      invalid(
        'invalid_value',
        `plan.tasks.${task.id}.purpose`,
        'A research task must acquire or verify evidence; the runtime owns report synthesis.',
      )
    }
    const spec = specs.get(task.workerSpecId)
    if (!sections.has(task.sectionId) || !spec) {
      invalid('invalid_reference', `plan.tasks.${task.id}`, 'Task references an unknown section or worker specification.')
    }
    if (task.dependsOn.includes(task.id) || task.dependsOn.some((id) => !tasks.has(id))) {
      invalid('invalid_reference', `plan.tasks.${task.id}.dependsOn`, 'Task dependencies must reference other plan tasks.')
    }
    if (task.dependsOn.length > plan.maxResearcherAgents) {
      invalid(
        'invalid_value',
        `plan.tasks.${task.id}.dependsOn`,
        `A research task cannot directly depend on more than ${plan.maxResearcherAgents} tasks. Split the lane or narrow its scope; the runtime owns synthesis after every evidence lane finishes.`,
      )
    }
    if (spec.sectionId !== task.sectionId || spec.question !== task.question) {
      invalid('invalid_reference', `plan.tasks.${task.id}.workerSpecId`, 'Worker specification must belong to the task section.')
    }
    if (assignedSpecIds.has(spec.id)) {
      invalid('invalid_reference', `plan.tasks.${task.id}.workerSpecId`, 'Each task requires its own assignment-scoped worker specification.')
    }
    assignedSpecIds.add(spec.id)
  }
  if (assignedSpecIds.size !== plan.workerSpecs.length) {
    invalid('invalid_reference', 'plan.workerSpecs', 'Every worker specification must own exactly one task.')
  }
  for (const section of plan.sections) {
    const expected = plan.tasks.filter((task) => task.sectionId === section.id).map((task) => task.id).sort()
    if (section.taskIds.slice().sort().join('\0') !== expected.join('\0')) {
      invalid('invalid_reference', `plan.sections.${section.id}.taskIds`, 'Section task IDs must exactly match its plan tasks.')
    }
  }
  assertAcyclic(plan.tasks)
  if ((plan.approvedAt === undefined) !== (plan.approvalHash === undefined)) {
    invalid('invalid_value', 'plan.approvalHash', 'Approval time and hash must be provided together.')
  }
}

function assertAcyclic(tasks: readonly ResearchTask[]): void {
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) invalid('invalid_reference', 'plan.tasks.dependsOn', 'Task dependencies contain a cycle.')
    if (visited.has(taskId)) return
    visiting.add(taskId)
    for (const dependency of dependencies.get(taskId) ?? []) visit(dependency)
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const task of tasks) visit(task.id)
}

function parseGlossaryEntry(value: unknown) {
  const input = strictRecord(value, 'domainCard.glossary[]', ['term', 'definition', 'sourceIds', 'confidence'])
  return {
    term: text(input.term, 'domainCard.glossary[].term'),
    definition: text(input.definition, 'domainCard.glossary[].definition'),
    sourceIds: safeIdArray(input.sourceIds, 'domainCard.glossary[].sourceIds', true),
    confidence: confidence(input.confidence, 'domainCard.glossary[].confidence'),
  }
}

function parseAuthority(value: unknown) {
  const input = strictRecord(value, 'domainCard.authorities[]', ['name', 'role', 'jurisdiction', 'sourceIds'])
  return {
    name: text(input.name, 'domainCard.authorities[].name'),
    role: text(input.role, 'domainCard.authorities[].role'),
    jurisdiction: text(input.jurisdiction, 'domainCard.authorities[].jurisdiction'),
    sourceIds: safeIdArray(input.sourceIds, 'domainCard.authorities[].sourceIds', true),
  }
}

function parseSourceHierarchy(value: unknown) {
  const input = strictRecord(value, 'domainCard.sourceHierarchy[]', ['claimType', 'preferredSourceTypes'])
  return {
    claimType: text(input.claimType, 'domainCard.sourceHierarchy[].claimType'),
    preferredSourceTypes: sourceTypeArray(input.preferredSourceTypes, 'domainCard.sourceHierarchy[].preferredSourceTypes'),
  }
}

function parseConstraint(value: unknown) {
  const input = strictRecord(value, 'domainCard.constraints[]', ['statement', 'applicableScope', 'sourceIds'])
  return {
    statement: text(input.statement, 'domainCard.constraints[].statement'),
    applicableScope: nonEmptyStringArray(input.applicableScope, 'domainCard.constraints[].applicableScope'),
    sourceIds: safeIdArray(input.sourceIds, 'domainCard.constraints[].sourceIds', true),
  }
}

function parseDisputedConcept(value: unknown) {
  const input = strictRecord(value, 'domainCard.disputedConcepts[]', ['concept', 'positions', 'sourceIds'])
  return {
    concept: text(input.concept, 'domainCard.disputedConcepts[].concept'),
    positions: nonEmptyStringArray(input.positions, 'domainCard.disputedConcepts[].positions'),
    sourceIds: safeIdArray(input.sourceIds, 'domainCard.disputedConcepts[].sourceIds', true),
  }
}

function parseContradiction(value: unknown) {
  const input = strictRecord(
    value,
    'evidencePacket.contradictions[]',
    ['description', 'sourceIds'],
    ['status', 'resolution'],
  )
  const status = input.status === undefined
    ? undefined
    : literalUnion(
        input.status,
        'evidencePacket.contradictions[].status',
        ['resolved', 'unresolved'] as const,
      )
  const resolution = input.resolution === undefined || input.resolution === ''
    ? undefined
    : text(input.resolution, 'evidencePacket.contradictions[].resolution')
  if (status === 'resolved' && resolution === undefined) {
    invalid(
      'invalid_value',
      'evidencePacket.contradictions[].resolution',
      'A resolved contradiction requires an explicit evidence-safe resolution.',
    )
  }
  if (status !== 'resolved' && resolution !== undefined) {
    invalid(
      'invalid_value',
      'evidencePacket.contradictions[].status',
      'A contradiction resolution may be supplied only when status is resolved.',
    )
  }
  return {
    description: text(input.description, 'evidencePacket.contradictions[].description'),
    sourceIds: safeIdArray(input.sourceIds, 'evidencePacket.contradictions[].sourceIds', true),
    ...(status === undefined ? {} : { status }),
    ...(resolution === undefined ? {} : { resolution }),
  }
}

function parseQualityFinding(value: unknown): QualityFinding {
  const input = strictRecord(value, 'finding', [
    'code', 'severity', 'message', 'taskIds', 'sectionIds', 'claimIds', 'sourceIds',
  ], ['requirementIds'])
  return {
    code: literalUnion(input.code, 'finding.code', [
      'task_missing', 'task_not_answered', 'task_irrelevant',
      'required_metric_missing', 'required_coverage_missing',
      'evidence_target_missing', 'requirement_unresolved',
      'claim_unsupported', 'source_unobserved',
      'source_not_independent', 'primary_source_missing',
      'required_authority_missing',
      'contradiction_unresolved', 'unresolved_question', 'evidence_stale',
      'scope_mismatch', 'report_evidence_mismatch', 'decision_not_supported',
    ] as const),
    severity: literalUnion(input.severity, 'finding.severity', ['blocking', 'warning'] as const),
    message: text(input.message, 'finding.message'),
    taskIds: safeIdArray(input.taskIds, 'finding.taskIds'),
    sectionIds: safeIdArray(input.sectionIds, 'finding.sectionIds'),
    claimIds: safeIdArray(input.claimIds, 'finding.claimIds'),
    sourceIds: safeIdArray(input.sourceIds, 'finding.sourceIds'),
    ...(input.requirementIds === undefined ? {} : {
      requirementIds: safeIdArray(input.requirementIds, 'finding.requirementIds'),
    }),
  }
}

function strictRecord(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('invalid_type', field, `${field} must be an object.`)
  }
  const input = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(input).find((key) => !allowed.has(key))
  if (unknown) invalid('unknown_field', `${field}.${unknown}`, `${field} contains an unknown field.`)
  const missing = required.find((key) => !(key in input))
  if (missing) invalid('invalid_value', `${field}.${missing}`, `${field} is missing a required field.`)
  return input
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || (!allowEmpty && !value.trim())) {
    invalid('invalid_type', field, `${field} must be a ${allowEmpty ? '' : 'non-empty '}string.`)
  }
  return value.trim()
}

function boundedText(value: unknown, field: string, maximumCharacters: number): string {
  const result = text(value, field)
  if (result.length > maximumCharacters) {
    invalid(
      'invalid_value',
      field,
      `${field} must not exceed ${maximumCharacters} characters.`,
    )
  }
  return result
}

function safeId(value: unknown, field: string): string {
  const id = text(value, field)
  if (!isSafePathSegment(id)) invalid('invalid_value', field, `${field} must be a safe identifier.`)
  return id
}

function safeIdArray(value: unknown, field: string, requireOne = false): string[] {
  const values = array(value, field).map((entry, index) => safeId(entry, `${field}[${index}]`))
  if (requireOne && values.length === 0) invalid('invalid_value', field, `${field} must not be empty.`)
  assertUnique(values, field)
  return values
}

function stringArray(value: unknown, field: string): string[] {
  const values = array(value, field).map((entry, index) => text(entry, `${field}[${index}]`))
  assertUnique(values, field)
  return values
}

function nonEmptyStringArray(value: unknown, field: string): string[] {
  const values = stringArray(value, field)
  if (values.length === 0) invalid('invalid_value', field, `${field} must not be empty.`)
  return values
}

function domainArray(value: unknown, field: string): string[] {
  const values = stringArray(value, field).map((entry) => entry.toLowerCase())
  if (values.some((entry) => !DOMAIN_PATTERN.test(entry))) {
    invalid('invalid_value', field, `${field} must contain hostname-only domains.`)
  }
  assertUnique(values, field)
  return values
}

function sourceTypeArray(value: unknown, field: string): ResearchSourceType[] {
  const values = array(value, field).map((entry) => enumValue(entry, field, SOURCE_TYPES))
  assertUnique(values, field)
  return values
}

function methodCardIdArray(value: unknown, field: string): ResearchMethodCardId[] {
  const values = array(value, field).map((entry) => enumValue(entry, field, METHOD_CARD_IDS))
  if (values.length === 0) invalid('invalid_value', field, `${field} must not be empty.`)
  assertUnique(values, field)
  return values
}

function objectArray<T>(
  value: unknown,
  field: string,
  parser: (entry: unknown) => T,
  requireOne = false,
): T[] {
  const values = array(value, field).map(parser)
  if (requireOne && values.length === 0) invalid('invalid_value', field, `${field} must not be empty.`)
  return values
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!isUnknownArray(value)) invalid('invalid_type', field, `${field} must be an array.`)
  return value
}

function integerInRange(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalid('invalid_value', field, `${field} must be an integer from ${minimum} through ${maximum}.`)
  }
  return value
}

function finiteNumberInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(
      'invalid_value',
      field,
      `${field} must be a finite number from ${minimum} through ${maximum}.`,
    )
  }
  return Math.round(value * 100) / 100
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = text(value, field)
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    invalid('invalid_value', field, `${field} must be a canonical ISO timestamp.`)
  }
  return timestamp
}

function isoDateOrTimestamp(value: unknown, field: string): string {
  const dateOrTimestamp = text(value, field)
  if (ISO_DATE_PATTERN.test(dateOrTimestamp)) {
    const parsedDate = new Date(`${dateOrTimestamp}T00:00:00.000Z`)
    if (
      !Number.isFinite(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== dateOrTimestamp
    ) {
      invalid('invalid_value', field, `${field} must be a valid canonical ISO date.`)
    }
    return dateOrTimestamp
  }
  return isoTimestamp(dateOrTimestamp, field)
}

function sha256(value: unknown, field: string): string {
  const hash = text(value, field)
  if (!SHA256_PATTERN.test(hash)) invalid('invalid_value', field, `${field} must be a lowercase SHA-256 digest.`)
  return hash
}

function httpUrl(value: unknown, field: string): string {
  const input = text(value, field)
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    invalid('invalid_value', field, `${field} must be an absolute HTTP URL.`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    invalid('invalid_value', field, `${field} must be a credential-free HTTP URL without a fragment.`)
  }
  return parsed.toString()
}

function confidence(value: unknown, field: string) {
  return literalUnion(value, field, ['high', 'medium', 'low'] as const)
}

function correctionWave(value: unknown, field: string): 0 | 1 | 2 {
  return literalUnion(value, field, [0, 1, 2] as const)
}

function enumValue<T extends string>(value: unknown, field: string, values: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    invalid('invalid_value', field, `${field} contains an unsupported value.`)
  }
  return value as T
}

function literalUnion<const T extends readonly (string | number)[]>(
  value: unknown,
  field: string,
  values: T,
): T[number] {
  if (!values.includes(value as T[number])) invalid('invalid_value', field, `${field} contains an unsupported value.`)
  return value as T[number]
}

function assertVersion(value: unknown, field: string): void {
  if (value !== DEEP_RESEARCH_SCHEMA_VERSION) invalid('invalid_value', field, `${field} uses an unsupported schema version.`)
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) invalid('duplicate_value', field, `${field} contains duplicate values.`)
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[], field: string): Map<string, T> {
  const entries = new Map<string, T>()
  for (const value of values) {
    if (entries.has(value.id)) invalid('duplicate_value', field, `${field} contains duplicate IDs.`)
    entries.set(value.id, value)
  }
  return entries
}

function invalid(
  code: DeepResearchValidationErrorCode,
  field: string,
  message: string,
): never {
  throw new DeepResearchValidationError(code, field, message)
}
