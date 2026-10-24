export const DEEP_RESEARCH_SCHEMA_VERSION = 1 as const
export const DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION = 2 as const
export const DEEP_RESEARCH_BASE_AGENT = 'web-researcher' as const
export const DEEP_RESEARCH_AGENT_PATH =
  'agents/web-researcher/web-researcher.md' as const
export const DEEP_RESEARCH_MAX_CORRECTION_WAVES = 2 as const
export const DEEP_RESEARCH_METHOD_CARD_IDS = [
  'general-research-v1',
  'domain-bootstrap-v1',
  'competitive-map-v1',
  'marketing-channel-analysis-v1',
  'customer-segmentation-v1',
  'pricing-analysis-v1',
  'regulatory-scan-v1',
  'technical-evaluation-v1',
  'source-verification-v1',
] as const
export type ResearchMethodCardId =
  (typeof DEEP_RESEARCH_METHOD_CARD_IDS)[number]

export type ResearchLens =
  | 'foundational'
  | 'market'
  | 'competitive'
  | 'regulatory'
  | 'technical'
  | 'historical'
  | 'source_verification'

export type ResearchSourceType =
  | 'primary'
  | 'secondary'
  | 'regulatory'
  | 'academic'
  | 'industry'
  | 'news'
  | 'vendor'
  | 'community'

export const RESEARCH_TASK_PURPOSES = [
  'evidence_acquisition',
  'evidence_verification',
  'report_synthesis',
] as const
export const EXECUTABLE_RESEARCH_TASK_PURPOSES = [
  'evidence_acquisition',
  'evidence_verification',
] as const
export type ResearchTaskPurpose = (typeof RESEARCH_TASK_PURPOSES)[number]

export type ResearchCoverageRequirementKind =
  | 'fact'
  | 'quantitative_metric'
  | 'comparison'
  | 'source_authority'
  | 'caveat'
  | 'decision'

export type ResearchCoverageValidation =
  | 'claim_support'
  | 'quantitative_value'
  | 'independent_comparison'
  | 'source_authority'
  | 'explicit_caveat'
  | 'decision_support'

export interface ResearchCoverageRequirement {
  readonly schemaVersion: typeof DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION
  readonly id: string
  readonly label: string
  readonly kind: ResearchCoverageRequirementKind
  readonly validation: ResearchCoverageValidation
  readonly required: boolean
}

export interface ResearchRequirementCoverage {
  readonly schemaVersion: typeof DEEP_RESEARCH_COVERAGE_SCHEMA_VERSION
  readonly requirementId: string
  readonly status: 'satisfied' | 'unresolved' | 'not_applicable'
  readonly claimIds: readonly string[]
  readonly sourceIds: readonly string[]
  readonly value?: string
  readonly unit?: string
  readonly asOf?: string
  readonly scope?: readonly string[]
  readonly note?: string
}

export interface DeepResearchRequest {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly requestId: string
  readonly question: string
  readonly objective: string
  readonly audience: string
  readonly includedScope: readonly string[]
  readonly excludedScope: readonly string[]
  readonly desiredSections: readonly string[]
  readonly jurisdictions: readonly string[]
  readonly freshnessAsOf: string
  readonly authenticatedDomains: readonly string[]
  readonly sourceRequirements: readonly string[]
  readonly maxDurationMinutes: number
  readonly maxResearcherAgents: number
  readonly outputFormats: readonly ['markdown', 'docx']
}

export interface ResearchSection {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly id: string
  readonly title: string
  readonly objective: string
  readonly taskIds: readonly string[]
}

export interface ResearchTask {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly id: string
  readonly sectionId: string
  readonly title: string
  readonly question: string
  /** Declared lane purpose. The runtime rejects report synthesis in a research plan. */
  readonly purpose: ResearchTaskPurpose
  readonly workerSpecId: string
  readonly dependsOn: readonly string[]
  readonly correctionWave: 0 | 1 | 2
}

export interface ResearchWorkerSpec {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly id: string
  readonly laneId: string
  readonly sectionId: string
  readonly baseAgent: typeof DEEP_RESEARCH_BASE_AGENT
  readonly displayRole: string
  readonly domain: string
  readonly lens: ResearchLens
  readonly methodCardIds: readonly ResearchMethodCardId[]
  readonly domainCardRef?: string
  /** Task-scoped analytical posture that focuses the reusable worker's reasoning. */
  readonly specialistStance: string
  readonly question: string
  readonly decisionUse: string
  /** Operational counting, classification, and boundary rules for ambiguous terms. */
  readonly workingDefinitions: readonly string[]
  readonly dependencyClaimIds: readonly string[]
  readonly sourceRequirements: {
    readonly preferredTypes: readonly ResearchSourceType[]
    readonly requiredAuthorityTypes: readonly ResearchSourceType[]
    readonly queryHints: readonly string[]
  }
  /** Legacy schema-v1 field retained only when reading an existing approved plan. */
  readonly requiredMetrics?: readonly string[]
  /** Structured quality requirements used by newly generated plans. */
  readonly coverageRequirements?: readonly ResearchCoverageRequirement[]
  readonly prohibitedAssumptions: readonly string[]
  readonly stopRule: {
    readonly minimumPrimarySources: number
    readonly minimumIndependentSources: number
    readonly maximumSources: number
  }
  readonly limits: {
    readonly deadlineMs: number
  }
}

export interface ResearchExecutionPolicy {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly complexity: 'simple' | 'standard' | 'complex'
  readonly complexityRationale: string
  readonly searchBreadth: 'focused' | 'balanced' | 'broad'
  readonly maxCostUsd: number
  readonly evidenceTargets: {
    readonly minimumSupportedClaims: number
    readonly minimumIndependentSourcesPerConsequentialClaim: number
    readonly crossVerifyConsequentialClaims: boolean
  }
  readonly stopping: {
    /** Integer score from 0 (no expected value) to 100 (very high expected value). */
    readonly minimumExpectedInformationGain: number
    readonly maximumCorrectionWaves: 0 | 1 | 2
  }
  readonly synthesis: {
    readonly mode: 'single_pass' | 'section_dossiers'
    readonly maximumParallelSections: number
  }
}

export interface ResearchPlan {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly planId: string
  readonly requestId: string
  /** Canonical intake interpretation covered by the exact user approval hash. */
  readonly request: DeepResearchRequest
  readonly sections: readonly ResearchSection[]
  readonly tasks: readonly ResearchTask[]
  readonly workerSpecs: readonly ResearchWorkerSpec[]
  readonly maxDurationMinutes: number
  readonly maxResearcherAgents: number
  readonly expectedPeakWorkers: number
  readonly authenticatedDomains: readonly string[]
  /**
   * Required on newly generated plans. It remains optional so immutable
   * schema-v1 plans approved before adaptive execution can still be replayed.
   */
  readonly executionPolicy?: ResearchExecutionPolicy
  readonly approvedAt?: string
  readonly approvalHash?: string
}

export interface DomainCardSourceReference {
  readonly sourceIds: readonly string[]
  readonly confidence: 'high' | 'medium' | 'low'
}

export interface DomainCard {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly cardId: string
  readonly domain: string
  readonly scope: readonly string[]
  readonly jurisdictions: readonly string[]
  readonly asOf: string
  readonly glossary: ReadonlyArray<DomainCardSourceReference & {
    readonly term: string
    readonly definition: string
  }>
  readonly authorities: ReadonlyArray<{
    readonly name: string
    readonly role: string
    readonly jurisdiction: string
    readonly sourceIds: readonly string[]
  }>
  readonly sourceHierarchy: ReadonlyArray<{
    readonly claimType: string
    readonly preferredSourceTypes: readonly ResearchSourceType[]
  }>
  readonly constraints: ReadonlyArray<{
    readonly statement: string
    readonly applicableScope: readonly string[]
    readonly sourceIds: readonly string[]
  }>
  readonly disputedConcepts: ReadonlyArray<{
    readonly concept: string
    readonly positions: readonly string[]
    readonly sourceIds: readonly string[]
  }>
  readonly prohibitedAssumptions: readonly string[]
  readonly validUntil: string
  readonly validation: {
    readonly decision: 'accepted' | 'rejected'
    readonly issues: readonly string[]
  }
}

export interface SourceRecord {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly sourceId: string
  readonly assignmentId: string
  readonly canonicalUrl: string
  readonly title: string
  readonly publisher: string
  readonly independenceKey: string
  readonly sourceType: ResearchSourceType
  readonly accessMethod:
    | 'direct-http'
    | 'direct-http-proxied'
    | 'managed-browser'
    | 'managed-browser-proxied'
    | 'managed-reader'
    | 'cloud-browser'
    | 'document-parser'
    | 'web.search'
  /** Runtime-issued receipt for directly observed usable content. */
  readonly observationReceiptId?: string
  readonly observedAt: string
  readonly publishedAt?: string
  readonly contentSha256: string
  readonly status: 'usable' | 'blocked' | 'stale' | 'rejected'
}

export interface ClaimEvidenceLink {
  readonly sourceId: string
  readonly observationReceiptId: string
  readonly observedExcerpt: string
  readonly locator: string
  readonly relationship: 'supports' | 'contradicts' | 'context'
}

export interface ClaimRecord {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly claimId: string
  readonly taskId: string
  readonly sectionId: string
  readonly statement: string
  readonly kind: 'fact' | 'inference' | 'uncertainty'
  readonly evidenceStandard: 'single' | 'independent_corroboration'
  readonly sourceIds: readonly string[]
  readonly evidenceLinks: readonly ClaimEvidenceLink[]
  readonly confidence: 'high' | 'medium' | 'low'
  readonly status: 'supported' | 'disputed' | 'unsupported' | 'removed'
  readonly applicableScope: readonly string[]
}

export interface EvidencePacket {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly assignmentId: string
  readonly taskId: string
  readonly workerSpecHash: string
  readonly question: string
  readonly shortAnswer: string
  readonly findings: readonly ClaimRecord[]
  readonly sources: readonly SourceRecord[]
  readonly contradictions: ReadonlyArray<{
    readonly description: string
    readonly sourceIds: readonly string[]
    /** Absent on legacy packets and treated as unresolved. */
    readonly status?: 'resolved' | 'unresolved'
    /** Required when status is resolved; explains the evidence-safe reconciliation. */
    readonly resolution?: string
  }>
  readonly unresolvedQuestions: readonly string[]
  /** Absent only on legacy evidence packets created before coverage contract v2. */
  readonly coverage?: readonly ResearchRequirementCoverage[]
  readonly stopReason:
    | 'decision_useful'
    | 'source_limit'
    | 'time_limit'
    | 'insufficient_evidence'
}

export type QualityFindingCode =
  | 'task_missing'
  | 'task_not_answered'
  | 'task_irrelevant'
  | 'required_metric_missing'
  | 'required_coverage_missing'
  | 'evidence_target_missing'
  | 'requirement_unresolved'
  | 'claim_unsupported'
  | 'source_unobserved'
  | 'source_not_independent'
  | 'primary_source_missing'
  | 'required_authority_missing'
  | 'contradiction_unresolved'
  | 'unresolved_question'
  | 'evidence_stale'
  | 'scope_mismatch'
  | 'report_evidence_mismatch'
  | 'decision_not_supported'

export interface QualityFinding {
  readonly code: QualityFindingCode
  readonly severity: 'blocking' | 'warning'
  readonly message: string
  readonly taskIds: readonly string[]
  readonly sectionIds: readonly string[]
  readonly claimIds: readonly string[]
  readonly sourceIds: readonly string[]
  readonly requirementIds?: readonly string[]
}

export interface CorrectionRequest {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly id: string
  readonly type:
    | 'new_research'
    | 'cross_verify'
    | 'verify_source'
    | 'resolve_contradiction'
    | 'remove_claim'
    | 'resynthesize'
    | 'restructure_packet'
  readonly claimIds: readonly string[]
  readonly taskIds: readonly string[]
  readonly sectionIds: readonly string[]
  readonly requirementIds?: readonly string[]
  readonly question?: string
  readonly acceptanceCriteria: readonly string[]
  readonly impactScope: 'local' | 'global'
}

export interface QualityVerdict {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly verdictId: string
  readonly correctionWave: 0 | 1 | 2
  readonly decision: 'APPROVE' | 'REVISE' | 'ESCALATE'
  readonly findings: readonly QualityFinding[]
  readonly correctionRequests: readonly CorrectionRequest[]
  /** Present on new REVISE verdicts; absent only on legacy artifacts. */
  readonly correctionRoute?: 'research' | 'synthesis'
  readonly reviewedAt: string
}

export interface ResearchCoverageEntry {
  readonly taskId: string
  readonly sectionId: string
  readonly assignmentId?: string
  readonly claimIds: readonly string[]
  readonly sourceIds: readonly string[]
  readonly requirementCoverage: readonly ResearchRequirementCoverage[]
  readonly isCovered: boolean
}

export interface ResearchSynthesisPacket {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly planId: string
  readonly coverage: readonly ResearchCoverageEntry[]
  readonly claims: readonly ClaimRecord[]
  readonly sources: readonly SourceRecord[]
  readonly contradictions: EvidencePacket['contradictions']
  readonly unresolvedQuestions: readonly string[]
}

export interface ResearchQualityPacket {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly planId: string
  readonly requiredTaskIds: readonly string[]
  readonly reviewScope: {
    readonly stage: 'research'
    readonly criterion: 'safe_to_write'
    readonly downstreamPublicationPending: true
    readonly excludedArtifacts: readonly ['final-report.md', 'final-report.docx']
  }
  readonly synthesis: ResearchSynthesisPacket
  readonly claimSourceMatrix: ReadonlyArray<{
    readonly claimId: string
    readonly sourceIds: readonly string[]
    readonly independentPublisherCount: number
  }>
}

export interface ResearchEvidenceGraphRequirementNode {
  /** Graph-unique identity; approved requirement IDs are task-local. */
  readonly id: string
  readonly requirementId: string
  readonly taskId: string
  readonly sectionId: string
  readonly label: string
  readonly required: boolean
  readonly status: ResearchRequirementCoverage['status'] | 'missing'
  readonly claimIds: readonly string[]
  readonly sourceIds: readonly string[]
}

export interface ResearchEvidenceGraphClaimNode {
  readonly id: string
  readonly taskId: string
  readonly sectionId: string
  readonly statement: string
  readonly status: ClaimRecord['status']
  readonly confidence: ClaimRecord['confidence']
  readonly evidenceStandard: ClaimRecord['evidenceStandard']
  readonly sourceIds: readonly string[]
  readonly supportingSourceIds: readonly string[]
  readonly contradictingSourceIds: readonly string[]
  readonly contextSourceIds: readonly string[]
  readonly independentPublisherCount: number
  readonly crossVerificationRequired: boolean
  readonly crossVerified: boolean
}

export interface ResearchEvidenceGraphSourceNode {
  readonly id: string
  readonly canonicalUrl: string
  readonly title: string
  readonly publisher: string
  readonly independenceKey: string
  readonly sourceType: ResearchSourceType
  readonly status: SourceRecord['status']
  readonly observedAt: string
  readonly publishedAt?: string
  readonly freshness: 'current' | 'stale' | 'unknown'
}

export interface ResearchEvidenceGraphEdge {
  readonly from: string
  readonly to: string
  readonly type: 'supports' | 'contradicts' | 'context' | 'covers'
}

export interface ResearchEvidenceGraphGap {
  readonly id: string
  readonly type:
    | 'requirement_missing'
    | 'claim_unsupported'
    | 'cross_verification_missing'
    | 'contradiction_unresolved'
    | 'question_unresolved'
  readonly taskIds: readonly string[]
  readonly sectionIds: readonly string[]
  readonly claimIds: readonly string[]
  readonly sourceIds: readonly string[]
  readonly message: string
}

export interface ResearchEvidenceGraph {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly planId: string
  readonly approvedPlanHash: string
  readonly correctionWave: 0 | 1 | 2
  readonly generatedAt: string
  readonly requirements: readonly ResearchEvidenceGraphRequirementNode[]
  readonly claims: readonly ResearchEvidenceGraphClaimNode[]
  readonly sources: readonly ResearchEvidenceGraphSourceNode[]
  readonly edges: readonly ResearchEvidenceGraphEdge[]
  readonly contradictions: EvidencePacket['contradictions']
  readonly unresolvedQuestions: readonly string[]
  readonly gaps: readonly ResearchEvidenceGraphGap[]
  readonly coverage: {
    readonly requiredRequirements: number
    readonly satisfiedRequirements: number
    readonly supportedClaims: number
    readonly totalClaims: number
    readonly crossVerifiedConsequentialClaims: number
    readonly consequentialClaims: number
  }
}

export interface ResearchSectionDossier {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly planId: string
  readonly approvedPlanHash: string
  readonly correctionWave: 0 | 1 | 2
  readonly sectionId: string
  readonly title: string
  readonly objective: string
  readonly taskIds: readonly string[]
  readonly claims: readonly ClaimRecord[]
  readonly sources: readonly SourceRecord[]
  readonly coverage: readonly ResearchCoverageEntry[]
  readonly contradictions: EvidencePacket['contradictions']
  readonly unresolvedQuestions: readonly string[]
  readonly gapIds: readonly string[]
  readonly evidenceGraphPath: string
}

export interface ResearchSectionDossierIndex {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly planId: string
  readonly approvedPlanHash: string
  readonly correctionWave: 0 | 1 | 2
  readonly synthesisMode: ResearchExecutionPolicy['synthesis']['mode']
  readonly dossiers: ReadonlyArray<{
    readonly sectionId: string
    readonly title: string
    readonly relativePath: string
    readonly draftPath?: string
    readonly claimCount: number
    readonly sourceCount: number
    readonly gapCount: number
  }>
}

export interface ResearchAdaptiveDecision {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly planId: string
  readonly approvedPlanHash: string
  readonly sourceVerdictId: string
  readonly sourceVerdictHash: string
  readonly correctionWave: 0 | 1 | 2
  readonly decision: 'continue' | 'stop' | 'not_applicable'
  readonly route?: NonNullable<QualityVerdict['correctionRoute']>
  readonly minimumExpectedInformationGain: number
  readonly aggregateExpectedInformationGain: number
  readonly maximumCorrectionWaves: 0 | 1 | 2
  readonly estimates: ReadonlyArray<{
    readonly correctionRequestId: string
    readonly expectedInformationGain: number
    readonly reason: string
  }>
  readonly reason: string
  readonly decidedAt: string
}

export interface ResearchPlanAmendment {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly amendmentId: string
  readonly planId: string
  readonly approvedPlanHash: string
  readonly sourceVerdictPath: string
  readonly sourceVerdictHash: string
  readonly fromWave: 0 | 1
  readonly toWave: 1 | 2
  readonly route: NonNullable<QualityVerdict['correctionRoute']>
  readonly targetTaskIds: readonly string[]
  readonly targetSectionIds: readonly string[]
  readonly targetClaimIds: readonly string[]
  readonly targetRequirementIds: readonly string[]
  readonly expectedInformationGain: number
  readonly approvedMaxCostUsd?: number
  readonly scopeChange: 'none'
  readonly createdAt: string
}

export type ResearchPublicationViolationCode =
  | 'source_inventory_empty'
  | 'source_removed'
  | 'source_introduced'
  | 'claim_numeral_removed'
  | 'claim_numeral_introduced'
  | 'caveat_removed'
  | 'graph_source_missing'
  | 'numeric_claim_uncited'

/** How an unknown citation URL appeared in the editorial draft. */
export type ResearchCitationRemovalKind =
  | 'inline_link'
  | 'autolink'
  | 'bare_url'
  | 'reference_definition'
  | 'footnote_definition'

export interface ResearchCitationRemoval {
  readonly url: string
  readonly kind: ResearchCitationRemovalKind
  /** Byte offset of the occurrence in the pre-canonical editorial Markdown. */
  readonly offset: number
}

/**
 * Record of one citation canonicalization pass, persisted inside the
 * publication audit. Its presence switches the audit's URL-delta checks onto
 * the graph-derived baseline.
 */
export interface ResearchCitationCanonicalizationSummary {
  readonly inputSha256: string
  readonly outputSha256: string
  /** Normalized canonical URLs of every usable graph source. */
  readonly graphUrlBaseline: readonly string[]
  /** Normalized citation URLs observed in the canonical Markdown. */
  readonly publicationUrlInventory: readonly string[]
  readonly normalizedLinkCount: number
  readonly generatedSourceCount: number
  readonly removedSourceSectionHeadings: readonly string[]
  readonly removedUnknownUrls: readonly ResearchCitationRemoval[]
}

export interface ResearchPublicationAudit {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly auditId: string
  readonly decision: 'APPROVE' | 'REVISE'
  readonly auditedAt: string
  /** Absent on legacy audits and on transforms without canonicalization. */
  readonly canonicalization?: ResearchCitationCanonicalizationSummary
  readonly sourceSummary: {
    readonly sourceUrls: readonly string[]
    readonly publicationUrls: readonly string[]
    readonly claimBearingNumerals: readonly string[]
    readonly publicationClaimBearingNumerals: readonly string[]
    readonly caveatMarkers: readonly string[]
    readonly publicationCaveatMarkers: readonly string[]
  }
  readonly citationInventory: ReadonlyArray<{
    readonly url: string
    readonly occurrences: number
    readonly sourceIds: readonly string[]
  }>
  readonly graphCoverage: {
    readonly requiredClaimSourceLinks: number
    readonly preservedClaimSourceLinks: number
    readonly missingClaimIds: readonly string[]
    readonly missingSourceIds: readonly string[]
  }
  readonly numericClaimParagraphs: ReadonlyArray<{
    readonly paragraph: string
    readonly numerals: readonly string[]
    readonly citationUrls: readonly string[]
    readonly cited: boolean
  }>
  readonly violations: ReadonlyArray<{
    readonly code: ResearchPublicationViolationCode
    readonly message: string
    readonly claimIds: readonly string[]
    readonly sourceIds: readonly string[]
  }>
}

export const RESEARCH_EVALUATION_ARTIFACT_KINDS = [
  'evidence_graph',
  'section_dossiers',
  'section_drafts',
  'research_package',
  'publication_audit',
  'final_markdown',
  'final_docx',
] as const

export type ResearchEvaluationArtifactKind =
  (typeof RESEARCH_EVALUATION_ARTIFACT_KINDS)[number]

export const RESEARCH_EVALUATION_METRIC_IDS = [
  'requirement_coverage',
  'claim_support',
  'authoritative_sources',
  'independent_claim_verification',
  'contradiction_resolution',
  'semantic_coherence',
  'citation_correctness',
  'artifact_validity',
  'acquisition_yield',
  'elapsed_time',
  'cost',
] as const

export type ResearchEvaluationMetricId =
  (typeof RESEARCH_EVALUATION_METRIC_IDS)[number]

export interface ResearchEvaluationThresholds {
  readonly minimumRequirementCoverage: number
  readonly minimumClaimSupport: number
  readonly minimumAuthoritativeSourceRatio: number
  readonly minimumIndependentClaimRatio: number
  readonly minimumContradictionResolution: number
  readonly minimumSemanticCoherence: number
  readonly minimumCitationCorrectness: number
  readonly minimumArtifactValidity: number
  readonly minimumAcquisitionYield: number
  readonly minimumCompositeScore: number
  readonly maximumElapsedMs: number
  readonly maximumCostUsd: number
  readonly maximumCompositeRegression: number
}

export interface ResearchEvaluationCase {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly id: string
  readonly title: string
  readonly scenarioClass: 'simple' | 'complex'
  readonly brief: string
  readonly expectedTerms: readonly string[]
  readonly requiredArtifacts: readonly ResearchEvaluationArtifactKind[]
  readonly thresholds: ResearchEvaluationThresholds
}

export interface ResearchEvaluationCorpus {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly frozenAt: string
  readonly cases: readonly ResearchEvaluationCase[]
}

export interface ResearchEvaluationMetric {
  readonly id: ResearchEvaluationMetricId
  readonly label: string
  readonly value: number
  readonly unit: 'ratio' | 'sources_per_task' | 'milliseconds' | 'usd'
  readonly comparison: 'at_least' | 'at_most'
  readonly threshold: number
  readonly passed: boolean
  readonly numerator?: number
  readonly denominator?: number
}

export interface ResearchEvaluationReport {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly evaluationId: string
  readonly caseId: string
  readonly caseTitle: string
  readonly scenarioClass: ResearchEvaluationCase['scenarioClass']
  readonly planId: string
  readonly approvedPlanHash: string
  readonly correctionWave: 0 | 1 | 2
  readonly decision: 'PASS' | 'FAIL'
  readonly evaluatedAt: string
  readonly compositeScore: number
  readonly metrics: readonly ResearchEvaluationMetric[]
  readonly blockingReasons: readonly string[]
  readonly artifactHashes: {
    readonly evidenceGraph: string
    readonly publicationAudit: string
    readonly finalMarkdown: string
    readonly finalDocx: string
  }
  readonly retainedArtifacts: readonly string[]
  readonly comparison?: {
    readonly baselineEvaluationId: string
    readonly baselineCompositeScore: number
    readonly compositeScoreDelta: number
    readonly maximumCompositeRegression: number
    readonly passed: boolean
    readonly metricDeltas: ReadonlyArray<{
      readonly id: ResearchEvaluationMetricId
      readonly delta: number
    }>
  }
}

export type ResearchRunStatus =
  | 'planned'
  | 'running'
  | 'correcting'
  | 'synthesizing'
  | 'reviewing'
  | 'approved'
  | 'escalated'
  | 'cancelled'
  | 'timed_out'

export type ResearchWorkItemStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'timed_out'

export interface ResearchExecutionManifest {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly sessionId: string
  readonly runId: string
  readonly planId: string
  readonly approvedPlanHash: string
  readonly maxDurationMinutes: number
  readonly maxResearcherAgents: number
  readonly authenticatedDomains: readonly string[]
  readonly createdAt: string
}

export interface ResearchArtifactReceipt {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly taskId: string
  readonly assignmentId: string
  readonly attempt: number
  readonly workerSpecHash: string
  readonly relativePath: string
  readonly sha256: string
  readonly byteLength: number
  readonly completedAt: string
}

export interface ResearchWorkItem {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly taskId: string
  readonly assignmentId: string
  readonly workerSpecHash: string
  readonly attempt: number
  readonly status: ResearchWorkItemStatus
  readonly startedAt?: string
  readonly completedAt?: string
  readonly receipt?: ResearchArtifactReceipt
  readonly errorCode?: string
}

export interface ResearchJournal {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly revision: number
  readonly ownerExecutionAttemptId: string
  readonly status: ResearchRunStatus
  readonly correctionWave: 0 | 1 | 2
  readonly workItemIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ResearchRunSnapshot {
  readonly manifest: ResearchExecutionManifest
  readonly journal: ResearchJournal
  readonly workItems: readonly ResearchWorkItem[]
}

export interface ResearchStoreEvent {
  readonly schemaVersion: typeof DEEP_RESEARCH_SCHEMA_VERSION
  readonly eventId: string
  readonly timestamp: string
  readonly type: string
  readonly taskId?: string
  readonly revision: number
  readonly details: Readonly<Record<string, string | number | boolean | null>>
}
