import {
  DEEP_RESEARCH_MAX_CORRECTION_WAVES,
  DEEP_RESEARCH_SCHEMA_VERSION,
  type ClaimRecord,
  type CorrectionRequest,
  type EvidencePacket,
  type QualityFinding,
  type QualityFindingCode,
  type QualityVerdict,
  type ResearchPlan,
  type ResearchWorkerSpec,
  type ResearchCoverageRequirement,
  type ResearchRequirementCoverage,
  type ResearchQualityPacket,
  type ResearchSynthesisPacket,
  type SourceRecord,
} from '../../contracts/deep-research.js'
import {
  normalizeResearchCoverageLabel,
  resolveResearchCoverageRequirements,
} from './deep-research-coverage.js'
import {
  parseEvidencePacket,
  parseResearchPlan,
} from './deep-research-validation.js'
import { hashResearchValue } from './deep-research-worker-policy.js'

export interface BuildResearchPacketsInput {
  readonly plan: unknown
  readonly evidencePackets: readonly unknown[]
}

export interface EvaluateResearchQualityInput extends BuildResearchPacketsInput {
  readonly correctionWave: 0 | 1 | 2
  readonly reviewedAt?: string
}

export type QualityRoute =
  | { readonly action: 'publish' }
  | { readonly action: 'correct'; readonly requests: readonly CorrectionRequest[]; readonly nextWave: 1 | 2 }
  | { readonly action: 'escalate'; readonly findings: readonly QualityFinding[] }

export function buildResearchSynthesisPacket(
  input: BuildResearchPacketsInput,
): ResearchSynthesisPacket {
  const plan = parseResearchPlan(input.plan)
  const evidencePackets = prepareEvidencePackets(plan, input.evidencePackets)
  return buildResearchSynthesisPacketFromPrepared(plan, evidencePackets)
}

function buildResearchSynthesisPacketFromPrepared(
  plan: ResearchPlan,
  evidencePackets: readonly EvidencePacket[],
): ResearchSynthesisPacket {
  const claims = uniqueRecords(evidencePackets.flatMap((packet) => packet.findings), 'claimId')
    .sort((left, right) => left.claimId.localeCompare(right.claimId))
  const sources = uniqueRecords(evidencePackets.flatMap((packet) => packet.sources), 'sourceId')
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
  const packetByTask = new Map(evidencePackets.map((packet) => [packet.taskId, packet]))
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: plan.planId,
    coverage: plan.tasks.map((task) => {
      const packet = packetByTask.get(task.id)
      const workerSpec = requireWorkerSpec(plan, task.workerSpecId)
      return {
        taskId: task.id,
        sectionId: task.sectionId,
        ...whenDefined(packet?.assignmentId, (assignmentId) => ({ assignmentId })),
        claimIds: packet?.findings.map((claim) => claim.claimId).sort() ?? [],
        sourceIds: packet?.sources.map((source) => source.sourceId).sort() ?? [],
        requirementCoverage: packet
          ? resolveRequirementCoverage(
              resolveResearchCoverageRequirements(workerSpec),
              packet,
            )
          : [],
        isCovered: Boolean(packet && packet.findings.length > 0),
      }
    }),
    claims,
    sources,
    contradictions: uniqueObjects(evidencePackets.flatMap((packet) => packet.contradictions)),
    unresolvedQuestions: uniqueStrings(evidencePackets.flatMap((packet) => packet.unresolvedQuestions)),
  }
}

export function buildResearchQualityPacket(
  input: BuildResearchPacketsInput,
): ResearchQualityPacket {
  const plan = parseResearchPlan(input.plan)
  const evidencePackets = prepareEvidencePackets(plan, input.evidencePackets)
  const synthesis = buildResearchSynthesisPacketFromPrepared(plan, evidencePackets)
  const sourceById = new Map(synthesis.sources.map((source) => [source.sourceId, source]))
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: plan.planId,
    requiredTaskIds: plan.tasks.map((task) => task.id).sort(),
    reviewScope: {
      stage: 'research',
      criterion: 'safe_to_write',
      downstreamPublicationPending: true,
      excludedArtifacts: ['final-report.md', 'final-report.docx'],
    },
    synthesis,
    claimSourceMatrix: synthesis.claims.map((claim) => ({
      claimId: claim.claimId,
      sourceIds: [...claim.sourceIds].sort(),
      independentPublisherCount: new Set(
        claim.sourceIds
          .map((sourceId) => sourceById.get(sourceId))
          .filter((source) => source !== undefined)
          .map((source) => runtimeSourceIdentity(source)),
      ).size,
    })),
  }
}

export function evaluateResearchQuality(
  input: EvaluateResearchQualityInput,
): QualityVerdict {
  const plan = parseResearchPlan(input.plan)
  const packets = prepareEvidencePackets(plan, input.evidencePackets)
  const synthesis = buildResearchSynthesisPacketFromPrepared(plan, packets)
  const findings = mergeQualityFindings(
    collectQualityFindings(plan, packets, synthesis),
  )
  const hasBlockingFindings = findings.some((finding) => finding.severity === 'blocking')
  const decision = !hasBlockingFindings
    ? 'APPROVE'
    : input.correctionWave < DEEP_RESEARCH_MAX_CORRECTION_WAVES
      ? 'REVISE'
      : 'ESCALATE'
  const correctionRequests = decision === 'REVISE'
    ? mergeCorrectionRequests(
        findings
          .filter((finding) => finding.severity === 'blocking')
          .map(buildCorrectionRequest),
      )
    : []
  const reviewedAt = input.reviewedAt ?? new Date().toISOString()
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    verdictId: `quality-${input.correctionWave}-${hashResearchValue({ findings, reviewedAt }).slice(0, 12)}`,
    correctionWave: input.correctionWave,
    decision,
    findings,
    correctionRequests,
    ...(decision === 'REVISE' ? {
      correctionRoute: correctionRoute(correctionRequests),
    } : {}),
    reviewedAt,
  }
}

function correctionRoute(
  requests: readonly CorrectionRequest[],
): NonNullable<QualityVerdict['correctionRoute']> {
  return requests.every((request) => request.type === 'resynthesize')
    ? 'synthesis'
    : 'research'
}

export function routeQualityVerdict(verdict: QualityVerdict): QualityRoute {
  if (verdict.decision === 'APPROVE') return { action: 'publish' }
  if (verdict.decision === 'ESCALATE') {
    return { action: 'escalate', findings: verdict.findings }
  }
  if (verdict.correctionWave >= DEEP_RESEARCH_MAX_CORRECTION_WAVES) {
    return { action: 'escalate', findings: verdict.findings }
  }
  return {
    action: 'correct',
    requests: verdict.correctionRequests,
    nextWave: (verdict.correctionWave + 1) as 1 | 2,
  }
}

function collectQualityFindings(
  plan: ResearchPlan,
  packets: readonly EvidencePacket[],
  synthesis: ResearchSynthesisPacket,
): QualityFinding[] {
  const findings: QualityFinding[] = []
  const packetByTask = new Map(packets.map((packet) => [packet.taskId, packet]))
  const sourceById = new Map(synthesis.sources.map((source) => [source.sourceId, source]))
  for (const task of plan.tasks) {
    const packet = packetByTask.get(task.id)
    if (!packet) {
      findings.push(finding('task_missing', task, [], [], 'Required research task has no evidence packet.'))
      continue
    }
    findings.push(...taskSourceFindings(plan, task.id, packet))
    if (!packet.shortAnswer.trim() || packet.findings.length === 0) {
      findings.push(finding(
        'task_not_answered',
        task,
        packet.findings.map((claim) => claim.claimId),
        packet.sources.map((source) => source.sourceId),
        'Research packet does not provide a substantive, evidence-backed answer to its approved task.',
      ))
    }
    const workerSpec = requireWorkerSpec(plan, task.workerSpecId)
    findings.push(...requirementCoverageFindings(
      task,
      workerSpec,
      packet,
      sourceById,
    ))
    for (const claim of packet.findings) {
      findings.push(...claimFindings(
        task.sectionId,
        claim,
        sourceById,
        plan.executionPolicy?.evidenceTargets.crossVerifyConsequentialClaims
          ? plan.executionPolicy.evidenceTargets
              .minimumIndependentSourcesPerConsequentialClaim
          : 2,
      ))
    }
    const unresolvedContradictions = packet.contradictions.filter(
      (contradiction) => contradiction.status !== 'resolved',
    )
    if (unresolvedContradictions.length > 0) {
      findings.push(finding(
        'contradiction_unresolved',
        task,
        packet.findings.map((claim) => claim.claimId),
        uniqueStrings(unresolvedContradictions.flatMap((contradiction) => contradiction.sourceIds)),
        'Research packet contains material contradictory evidence that has not been resolved.',
      ))
    }
    if (packet.stopReason === 'insufficient_evidence') {
      findings.push(finding(
        'task_not_answered',
        task,
        packet.findings.map((claim) => claim.claimId),
        packet.sources.map((source) => source.sourceId),
        'Researcher explicitly reports insufficient evidence to answer the approved task.',
      ))
    } else if (packet.unresolvedQuestions.length > 0) {
      findings.push(finding(
        'unresolved_question',
        task,
        packet.findings.map((claim) => claim.claimId),
        packet.sources.map((source) => source.sourceId),
        `Non-blocking open questions remain: ${packet.unresolvedQuestions.join(' | ')}.`,
        'warning',
      ))
    }
  }
  const minimumSupportedClaims =
    plan.executionPolicy?.evidenceTargets.minimumSupportedClaims
  if (minimumSupportedClaims !== undefined) {
    const supportedClaims = synthesis.claims.filter(
      (claim) => claim.status === 'supported' && claim.kind !== 'uncertainty',
    )
    if (supportedClaims.length < minimumSupportedClaims) {
      findings.push({
        code: 'evidence_target_missing',
        severity: 'blocking',
        message:
          `The approved plan requires at least ${minimumSupportedClaims} ` +
          `supported claims; ${supportedClaims.length} are currently validated.`,
        taskIds: plan.tasks.map((task) => task.id).sort(),
        sectionIds: plan.sections.map((section) => section.id).sort(),
        claimIds: supportedClaims.map((claim) => claim.claimId).sort(),
        sourceIds: uniqueStrings(
          supportedClaims.flatMap((claim) => claim.sourceIds),
        ),
      })
    }
  }
  return findings
}

function requirementCoverageFindings(
  task: ResearchPlan['tasks'][number],
  workerSpec: ResearchPlan['workerSpecs'][number],
  packet: EvidencePacket,
  sourceById: ReadonlyMap<string, SourceRecord>,
): QualityFinding[] {
  const requirements = resolveResearchCoverageRequirements(workerSpec)
  if (requirements.length === 0) return []
  const coverage = resolveRequirementCoverage(requirements, packet)
  const entries = new Map(coverage.map((entry) => [entry.requirementId, entry]))
  const approvedIds = new Set(requirements.map((requirement) => requirement.id))
  const findings: QualityFinding[] = []
  const unknownIds = coverage
    .map((entry) => entry.requirementId)
    .filter((requirementId) => !approvedIds.has(requirementId))
  if (unknownIds.length > 0) {
    findings.push(withRequirementIds(finding(
      'task_not_answered',
      task,
      packet.findings.map((claim) => claim.claimId),
      packet.sources.map((source) => source.sourceId),
      `Research packet maps coverage to unapproved requirements: ${unknownIds.join(', ')}.`,
    ), unknownIds))
  }

  const missing = requirements.filter(
    (requirement) => requirement.required && !entries.has(requirement.id),
  )
  if (missing.length > 0) {
    findings.push(withRequirementIds(finding(
      'required_coverage_missing',
      task,
      packet.findings.map((claim) => claim.claimId),
      packet.sources.map((source) => source.sourceId),
      `Research packet has no structured coverage mapping for: ${missing.map((requirement) => requirement.label).join(', ')}.`,
    ), missing.map((requirement) => requirement.id)))
  }

  for (const requirement of requirements) {
    const entry = entries.get(requirement.id)
    if (!entry || !requirement.required) continue
    if (entry.status !== 'satisfied') {
      findings.push(withRequirementIds(finding(
        'requirement_unresolved',
        task,
        entry.claimIds,
        entry.sourceIds,
        `Required coverage remains ${entry.status.replace('_', ' ')} for ${requirement.label}: ${entry.note ?? 'No explanation supplied.'}`,
      ), [requirement.id]))
      continue
    }
    const issue = validateSatisfiedCoverage(
      requirement,
      entry,
      packet,
      sourceById,
      workerSpec.sourceRequirements.requiredAuthorityTypes,
    )
    if (issue) {
      findings.push(withRequirementIds(finding(
        'claim_unsupported',
        task,
        entry.claimIds,
        entry.sourceIds,
        `${requirement.label} is marked satisfied but ${issue}`,
      ), [requirement.id]))
    }
  }
  return findings
}

function resolveRequirementCoverage(
  requirements: readonly ResearchCoverageRequirement[],
  packet: EvidencePacket,
): ResearchRequirementCoverage[] {
  if (packet.coverage) return [...packet.coverage]
  return requirements.flatMap((requirement) => {
    const claims = packet.findings.filter((claim) =>
      claim.status !== 'removed' &&
      claim.applicableScope.some((scope) =>
        explicitScopeLabels(scope).includes(normalizeResearchCoverageLabel(requirement.label)),
      ),
    )
    if (claims.length === 0) return []
    return [{
      schemaVersion: 2,
      requirementId: requirement.id,
      status: 'satisfied' as const,
      claimIds: claims.map((claim) => claim.claimId),
      sourceIds: uniqueStrings(claims.flatMap((claim) => claim.sourceIds)),
      note: 'Mapped from explicit legacy ClaimRecord.applicableScope metadata.',
    }]
  })
}

function validateSatisfiedCoverage(
  requirement: ResearchCoverageRequirement,
  entry: ResearchRequirementCoverage,
  packet: EvidencePacket,
  sourceById: ReadonlyMap<string, SourceRecord>,
  requiredAuthorityTypes: readonly SourceRecord['sourceType'][],
): string | null {
  const claimsById = new Map(packet.findings.map((claim) => [claim.claimId, claim]))
  const claims = entry.claimIds
    .map((claimId) => claimsById.get(claimId))
    .filter(Boolean) as ClaimRecord[]
  const sources = entry.sourceIds
    .map((sourceId) => sourceById.get(sourceId))
    .filter(Boolean) as SourceRecord[]
  const supportedClaims = claims.filter((claim) =>
    claim.status === 'supported' &&
    claim.evidenceLinks.some((link) => link.relationship === 'supports'),
  )
  const directSources = sources.filter(isDirectUsableSource)
  const claimSourceIds = new Set(claims.flatMap((claim) => claim.sourceIds))
  if (entry.sourceIds.some((sourceId) => !claimSourceIds.has(sourceId)) && claims.length > 0) {
    return 'its source mapping is not attached to the referenced claims.'
  }

  switch (requirement.validation) {
    case 'claim_support':
    case 'decision_support':
      return supportedClaims.length > 0 && directSources.length > 0
        ? null
        : 'it lacks a supported claim linked to directly observed usable evidence.'
    case 'quantitative_value':
      if (!entry.value || !entry.unit || !entry.asOf || !entry.scope?.length) {
        return 'its quantitative value, unit, as-of date, or scope is missing.'
      }
      return supportedClaims.length > 0 && directSources.length > 0
        ? null
        : 'its quantitative value lacks a supported claim and directly observed evidence.'
    case 'independent_comparison':
      return supportedClaims.length > 0 &&
        new Set(directSources.map(runtimeSourceIdentity)).size >= 2
        ? null
        : 'the comparison lacks a supported claim backed by two independent usable sources.'
    case 'source_authority':
      if (requiredAuthorityTypes.length > 0) {
        return directSources.some((source) =>
          sourceSatisfiesAuthorityRequirement(source, requiredAuthorityTypes),
        )
          ? null
          : `it lacks a directly observed approved authority source (${requiredAuthorityTypes.join(', ')}).`
      }
      return directSources.some((source) =>
        ['primary', 'regulatory', 'academic', 'vendor'].includes(source.sourceType),
      )
        ? null
        : 'it lacks a directly observed primary, regulatory, academic, or first-party vendor authority source.'
    case 'explicit_caveat':
      return entry.note || entry.value || claims.some((claim) => claim.kind === 'uncertainty')
        ? null
        : 'it does not state the required limitation or uncertainty.'
  }
}

function explicitScopeLabels(value: string): string[] {
  return [value, ...value.split(/[;,|]/)]
    .map(normalizeResearchCoverageLabel)
    .filter(Boolean)
}

function withRequirementIds(
  value: QualityFinding,
  requirementIds: readonly string[],
): QualityFinding {
  return { ...value, requirementIds: uniqueStrings(requirementIds) }
}

function taskSourceFindings(
  plan: ResearchPlan,
  taskId: string,
  packet: EvidencePacket,
): QualityFinding[] {
  const task = plan.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`Research plan has no task '${taskId}'.`)
  const spec = requireWorkerSpec(plan, task.workerSpecId)
  const usable = packet.sources.filter(isDirectUsableSource)
  const primaryCount = usable.filter((source) =>
    ['primary', 'regulatory', 'vendor'].includes(source.sourceType)
  ).length
  const independentCount = new Set(usable.map(runtimeSourceIdentity)).size
  const findings: QualityFinding[] = []
  if (primaryCount < spec.stopRule.minimumPrimarySources) {
    findings.push(finding(
      'primary_source_missing', task, [], usable.map((source) => source.sourceId),
      'Task does not satisfy its minimum primary-source requirement.',
    ))
  }
  if (independentCount < spec.stopRule.minimumIndependentSources) {
    findings.push(finding(
      'source_not_independent', task, [], usable.map((source) => source.sourceId),
      'Task does not satisfy its minimum independent-source requirement.',
    ))
  }
  const acceptedAuthorityTypes = spec.sourceRequirements.requiredAuthorityTypes
  if (
    acceptedAuthorityTypes.length > 0 &&
    !usable.some((source) =>
      sourceSatisfiesAuthorityRequirement(source, acceptedAuthorityTypes))
  ) {
    findings.push(finding(
      'required_authority_missing', task, [], usable.map((source) => source.sourceId),
      `Task lacks an approved authority source type (${acceptedAuthorityTypes.join(', ')}).`,
    ))
  }
  return findings
}

function claimFindings(
  sectionId: string,
  claim: ClaimRecord,
  sourceById: ReadonlyMap<string, SourceRecord>,
  minimumIndependentSources: number,
): QualityFinding[] {
  if (claim.status === 'removed') return []
  const sources = claim.sourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean) as SourceRecord[]
  const directUsable = sources.filter(isDirectUsableSource)
  const task = { id: claim.taskId, sectionId }
  const findings: QualityFinding[] = []
  const unobserved = sources.filter((source) => source.accessMethod === 'web.search' || source.status !== 'usable')
  if (unobserved.length > 0) {
    findings.push(finding(
      'source_unobserved', task, [claim.claimId], unobserved.map((source) => source.sourceId),
      'Claim relies on search-only, blocked, stale, or rejected source records.',
    ))
  }
  if (
    claim.kind !== 'uncertainty' &&
    (claim.status === 'unsupported' || directUsable.length === 0)
  ) {
    findings.push(finding(
      'claim_unsupported', task, [claim.claimId], claim.sourceIds,
      'Factual claim lacks directly observed usable evidence.',
    ))
  }
  if (
    claim.kind !== 'uncertainty' &&
    claim.evidenceStandard === 'independent_corroboration' &&
    new Set(directUsable.map(runtimeSourceIdentity)).size <
      minimumIndependentSources
  ) {
    findings.push(finding(
      'source_not_independent', task, [claim.claimId], claim.sourceIds,
      `Claim requiring cross-verification lacks ${minimumIndependentSources} independent usable sources.`,
    ))
  }
  if (sources.some((source) => source.status === 'stale')) {
    findings.push(finding(
      'evidence_stale', task, [claim.claimId], sources.filter((source) => source.status === 'stale').map((source) => source.sourceId),
      'Claim relies on evidence marked stale.',
    ))
  }
  return findings
}

function isDirectUsableSource(source: SourceRecord): boolean {
  return source.status === 'usable' && source.accessMethod !== 'web.search'
}

/**
 * `primary` is the generic authority class. Regulatory issuers and a vendor's
 * own documentation are first-party sources even when their more precise
 * source type is retained for downstream review.
 */
function sourceSatisfiesAuthorityRequirement(
  source: SourceRecord,
  requiredTypes: readonly SourceRecord['sourceType'][],
): boolean {
  return requiredTypes.some((requiredType) =>
    requiredType === 'primary'
      ? ['primary', 'regulatory', 'vendor'].includes(source.sourceType)
      : source.sourceType === requiredType,
  )
}

/**
 * Independence decisions use the runtime-verified source URL, not the
 * researcher's descriptive independenceKey assertion. Exact host identity is
 * deliberately conservative and deterministic; the critic still evaluates
 * whether different hosts are controlled by the same publisher.
 */
function runtimeSourceIdentity(source: SourceRecord): string {
  return new URL(source.canonicalUrl).hostname.toLowerCase().replace(/^www\./, '')
}

function finding(
  code: QualityFindingCode,
  task: { readonly id: string; readonly sectionId: string },
  claimIds: readonly string[],
  sourceIds: readonly string[],
  message: string,
  severity: QualityFinding['severity'] = 'blocking',
): QualityFinding {
  return {
    code,
    severity,
    message,
    taskIds: [task.id],
    sectionIds: [task.sectionId],
    claimIds: [...claimIds].sort(),
    sourceIds: [...sourceIds].sort(),
  }
}

function buildCorrectionRequest(
  findingValue: QualityFinding,
  index: number,
): CorrectionRequest {
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    id: `correction-${String(index + 1).padStart(2, '0')}-${findingValue.code}`,
    type: correctionType(findingValue.code),
    claimIds: findingValue.claimIds,
    taskIds: findingValue.taskIds,
    sectionIds: findingValue.sectionIds,
    ...(findingValue.requirementIds === undefined ? {} : {
      requirementIds: findingValue.requirementIds,
    }),
    question: findingValue.message,
    acceptanceCriteria: [acceptanceCriterion(findingValue.code)],
    impactScope: 'local',
  }
}

function correctionType(code: QualityFindingCode): CorrectionRequest['type'] {
  if (code === 'required_coverage_missing') return 'restructure_packet'
  if (code === 'source_not_independent') return 'cross_verify'
  if (code === 'source_unobserved' || code === 'evidence_stale') return 'verify_source'
  if (code === 'contradiction_unresolved') return 'resolve_contradiction'
  if (code === 'report_evidence_mismatch' || code === 'decision_not_supported') return 'resynthesize'
  if (code === 'task_irrelevant' || code === 'scope_mismatch') return 'remove_claim'
  return 'new_research'
}

function acceptanceCriterion(code: QualityFindingCode): string {
  switch (code) {
    case 'task_missing': return 'Produce a validated evidence packet for the missing task.'
    case 'task_not_answered': return 'Answer the approved task directly with material, validated evidence or document an irreducible gap.'
    case 'task_irrelevant': return 'Remove irrelevant material and replace it with evidence that directly answers the approved task.'
    case 'required_metric_missing': return 'Supply every required metric with units, scope, date, and usable source support.'
    case 'required_coverage_missing': return 'Map every approved coverage requirement to existing validated claims and sources, or mark it unresolved with an explicit reason.'
    case 'evidence_target_missing': return 'Add only decision-relevant supported claims until the approved evidence target is met, or document an irreducible gap.'
    case 'requirement_unresolved': return 'Resolve the required evidence gap or document why the approved task cannot be completed safely.'
    case 'claim_unsupported': return 'Support or remove every targeted factual claim.'
    case 'source_unobserved': return 'Open and validate the underlying source or remove it.'
    case 'source_not_independent': return 'Provide the required number of independent usable sources.'
    case 'primary_source_missing': return 'Provide the required primary evidence or document the irreducible gap.'
    case 'required_authority_missing': return 'Provide usable evidence for every authority source type required by the approved task.'
    case 'contradiction_unresolved': return 'Resolve or explicitly represent the contradictory evidence.'
    case 'unresolved_question': return 'Preserve the non-blocking uncertainty transparently in the final report.'
    case 'evidence_stale': return 'Replace stale evidence or qualify the claim as historical.'
    case 'scope_mismatch': return 'Use evidence matching the approved population, jurisdiction, period, units, and product scope.'
    case 'report_evidence_mismatch': return 'Make the report faithfully reflect the validated evidence packet and remove unsupported additions.'
    case 'decision_not_supported': return 'Revise the recommendation so it follows from the cited evidence and stated uncertainty.'
  }
}

export function mergeQualityFindings(
  values: readonly QualityFinding[],
): QualityFinding[] {
  const merged = new Map<string, QualityFinding>()
  for (const value of values) {
    const identity = qualityFindingIdentity(value)
    const existing = merged.get(identity)
    if (!existing) {
      merged.set(identity, {
        ...value,
        taskIds: uniqueStrings(value.taskIds),
        sectionIds: uniqueStrings(value.sectionIds),
        claimIds: uniqueStrings(value.claimIds),
        sourceIds: uniqueStrings(value.sourceIds),
        ...(value.requirementIds === undefined ? {} : {
          requirementIds: uniqueStrings(value.requirementIds),
        }),
      })
      continue
    }
    merged.set(identity, {
      ...existing,
      severity:
        existing.severity === 'blocking' || value.severity === 'blocking'
          ? 'blocking'
          : 'warning',
      message: mergeQualityFindingMessages(existing.message, value.message),
      sectionIds: uniqueStrings([...existing.sectionIds, ...value.sectionIds]),
      claimIds: uniqueStrings([...existing.claimIds, ...value.claimIds]),
      sourceIds: uniqueStrings([...existing.sourceIds, ...value.sourceIds]),
      ...(
        existing.requirementIds === undefined && value.requirementIds === undefined
          ? {}
          : {
              requirementIds: uniqueStrings([
                ...(existing.requirementIds ?? []),
                ...(value.requirementIds ?? []),
              ]),
            }
      ),
    })
  }
  return [...merged.values()].sort((left, right) =>
    qualityFindingIdentity(left).localeCompare(qualityFindingIdentity(right)),
  )
}

function mergeQualityFindingMessages(left: string, right: string): string {
  const normalizedLeft = left.trim()
  const normalizedRight = right.trim()
  if (normalizedLeft.includes(normalizedRight)) return normalizedLeft
  if (normalizedRight.includes(normalizedLeft)) return normalizedRight
  return uniqueStrings([normalizedLeft, normalizedRight]).join(' ')
}

export function mergeCorrectionRequests(
  values: readonly CorrectionRequest[],
): CorrectionRequest[] {
  const merged = new Map<string, CorrectionRequest>()
  for (const value of values) {
    const identity = correctionRequestIdentity(value)
    const existing = merged.get(identity)
    if (!existing) {
      merged.set(identity, value)
      continue
    }
    merged.set(identity, {
      ...existing,
      claimIds: uniqueStrings([...existing.claimIds, ...value.claimIds]),
      sectionIds: uniqueStrings([...existing.sectionIds, ...value.sectionIds]),
      acceptanceCriteria: uniqueStrings([
        ...existing.acceptanceCriteria,
        ...value.acceptanceCriteria,
      ]),
      ...(
        existing.requirementIds === undefined && value.requirementIds === undefined
          ? {}
          : {
              requirementIds: uniqueStrings([
                ...(existing.requirementIds ?? []),
                ...(value.requirementIds ?? []),
              ]),
            }
      ),
    })
  }
  return [...merged.values()].sort((left, right) =>
    correctionRequestIdentity(left).localeCompare(correctionRequestIdentity(right)),
  )
}

function qualityFindingIdentity(value: QualityFinding): string {
  return [
    value.code,
    uniqueStrings(value.taskIds).join(','),
    uniqueStrings(value.requirementIds ?? []).join(','),
    uniqueStrings(value.claimIds).join(','),
  ].join('|')
}

function correctionRequestIdentity(value: CorrectionRequest): string {
  return [
    value.type,
    uniqueStrings(value.taskIds).join(','),
    uniqueStrings(value.requirementIds ?? []).join(','),
    uniqueStrings(value.claimIds).join(','),
  ].join('|')
}

function requireWorkerSpec(plan: ResearchPlan, workerSpecId: string): ResearchWorkerSpec {
  const workerSpec = plan.workerSpecs.find((candidate) => candidate.id === workerSpecId)
  if (!workerSpec) throw new Error(`Research plan has no worker spec '${workerSpecId}'.`)
  return workerSpec
}

function assertPacketsBelongToPlan(
  plan: ResearchPlan,
  packets: readonly EvidencePacket[],
): void {
  const taskIds = new Set(plan.tasks.map((task) => task.id))
  const expectedWorkerHashes = new Map(plan.tasks.map((task) => {
    const workerSpec = requireWorkerSpec(plan, task.workerSpecId)
    return [task.id, hashResearchValue(workerSpec)]
  }))
  const seen = new Set<string>()
  for (const packet of packets) {
    if (!taskIds.has(packet.taskId)) throw new Error(`Evidence packet references unknown task '${packet.taskId}'.`)
    if (seen.has(packet.taskId)) throw new Error(`Task '${packet.taskId}' has multiple active evidence packets.`)
    if (packet.workerSpecHash !== expectedWorkerHashes.get(packet.taskId)) {
      throw new Error(`Evidence packet for task '${packet.taskId}' does not match its approved worker specification.`)
    }
    seen.add(packet.taskId)
  }
}

function prepareEvidencePackets(
  plan: ResearchPlan,
  packetValues: readonly unknown[],
): EvidencePacket[] {
  const packets = packetValues.map(parseEvidencePacket)
  assertPacketsBelongToPlan(plan, packets)
  return packets.map(namespaceTaskLocalIdentifiers)
}

function namespaceTaskLocalIdentifiers(packet: EvidencePacket): EvidencePacket {
  const sourceIds = new Map(
    packet.sources.map((source) => [
      source.sourceId,
      namespaceIdentifier(packet.taskId, source.sourceId),
    ]),
  )
  const namespacedSourceId = (sourceId: string): string => {
    const namespaced = sourceIds.get(sourceId)
    if (!namespaced) {
      throw new Error(
        `Evidence packet '${packet.taskId}' references unknown source '${sourceId}'.`,
      )
    }
    return namespaced
  }

  return {
    ...packet,
    findings: packet.findings.map((claim) =>
      namespaceClaimIdentifiers(claim, packet.taskId, namespacedSourceId)),
    sources: packet.sources.map((source) => ({
      ...source,
      sourceId: namespacedSourceId(source.sourceId),
    })),
    contradictions: packet.contradictions.map((contradiction) => ({
      ...contradiction,
      sourceIds: contradiction.sourceIds.map(namespacedSourceId),
    })),
    ...(packet.coverage === undefined ? {} : {
      coverage: packet.coverage.map((entry) => ({
        ...entry,
        claimIds: entry.claimIds.map((claimId) =>
          namespaceIdentifier(packet.taskId, claimId)),
        sourceIds: entry.sourceIds.map(namespacedSourceId),
      })),
    }),
  }
}

function namespaceClaimIdentifiers(
  claim: EvidencePacket['findings'][number],
  taskId: string,
  namespacedSourceId: (sourceId: string) => string,
): EvidencePacket['findings'][number] {
  return {
    ...claim,
    claimId: namespaceIdentifier(taskId, claim.claimId),
    sourceIds: claim.sourceIds.map(namespacedSourceId),
    evidenceLinks: claim.evidenceLinks.map((link) => ({
      ...link,
      sourceId: namespacedSourceId(link.sourceId),
    })),
  }
}

function namespaceIdentifier(taskId: string, localId: string): string {
  const prefix = `${taskId}--`
  return localId.startsWith(prefix) ? localId : `${prefix}${localId}`
}

function uniqueRecords<T extends Record<K, string>, K extends keyof T>(
  values: readonly T[],
  key: K,
): T[] {
  const records = new Map<string, T>()
  for (const value of values) {
    const identity = value[key]
    const existing = records.get(identity)
    if (existing && hashResearchValue(existing) !== hashResearchValue(value)) {
      throw new Error(`Conflicting research records share ID '${identity}'.`)
    }
    records.set(identity, value)
  }
  return [...records.values()]
}

function uniqueObjects<T>(values: readonly T[]): T[] {
  const entries = new Map(values.map((value) => [hashResearchValue(value), value]))
  return [...entries.values()]
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}
import { whenDefined } from '../../core/optional-properties.js'
