import {
  DEEP_RESEARCH_MAX_CORRECTION_WAVES,
  DEEP_RESEARCH_SCHEMA_VERSION,
  type CorrectionRequest,
  type QualityVerdict,
  type ResearchAdaptiveDecision,
  type ResearchExecutionPolicy,
  type ResearchPlan,
  type ResearchPlanAmendment,
} from '../../contracts/deep-research.js'
import { assertResearchPlanApproved } from './deep-research-approval.js'
import {
  parseQualityVerdict,
  parseResearchPlan,
} from './deep-research-validation.js'
import { hashResearchValue } from './deep-research-worker-policy.js'

const APPROVED_PLAN_MARKER =
  '<!-- pipeline-runtime:approved-deep-research-plan:v1 -->'

const BOUNDED_EVIDENCE_REPAIR_TYPES: ReadonlySet<CorrectionRequest['type']> =
  new Set(['remove_claim', 'resynthesize', 'restructure_packet'])

const EXPECTED_INFORMATION_GAIN: Readonly<
  Record<CorrectionRequest['type'], { score: number; reason: string }>
> = {
  cross_verify: {
    score: 85,
    reason: 'Independent corroboration can materially change confidence in a consequential claim.',
  },
  resolve_contradiction: {
    score: 80,
    reason: 'Resolving material contradictory evidence can change the report conclusion.',
  },
  verify_source: {
    score: 75,
    reason: 'Replacing stale or unobserved evidence can determine whether a claim is publishable.',
  },
  new_research: {
    score: 70,
    reason: 'The targeted evidence gap can add a decision-relevant supported claim.',
  },
  restructure_packet: {
    score: 45,
    reason: 'A packet-only correction can recover approved coverage without additional acquisition.',
  },
  resynthesize: {
    score: 35,
    reason: 'The evidence is stable; another synthesis pass can correct report-level interpretation.',
  },
  remove_claim: {
    score: 25,
    reason: 'Removing a weak local claim improves safety but adds little new information.',
  },
}

export interface AppliedAdaptiveResearchPolicy {
  readonly verdict: QualityVerdict
  readonly decision: ResearchAdaptiveDecision
}

/**
 * Preserve pre-adaptive schema-v1 behavior by returning null for legacy plans.
 * Callers that need a policy decision should treat null as a zero-threshold,
 * two-wave policy and must not invent a cost cap.
 */
function resolveResearchExecutionPolicy(
  plan: ResearchPlan,
): ResearchExecutionPolicy | null {
  return plan.executionPolicy ?? null
}

export function extractApprovedResearchPlanFromBrief(
  brief: string,
): ResearchPlan | null {
  const markerIndex = brief.lastIndexOf(APPROVED_PLAN_MARKER)
  if (markerIndex < 0) return null
  const jsonText = extractJsonObject(
    brief.slice(markerIndex + APPROVED_PLAN_MARKER.length),
  )
  return assertResearchPlanApproved(JSON.parse(jsonText))
}

export function resolveAdaptiveResearchBudget(params: {
  readonly brief: string
  readonly parentRemainingBudgetUsd?: number
}): number | undefined {
  const plan = extractApprovedResearchPlanFromBrief(params.brief)
  const approvedCostCap = plan?.executionPolicy?.maxCostUsd
  if (approvedCostCap === undefined) return params.parentRemainingBudgetUsd
  if (params.parentRemainingBudgetUsd === undefined) return approvedCostCap
  return Math.min(params.parentRemainingBudgetUsd, approvedCostCap)
}

export function applyAdaptiveResearchPolicy(params: {
  readonly plan: unknown
  readonly verdict: unknown
}): AppliedAdaptiveResearchPolicy {
  const plan = parseResearchPlan(params.plan)
  const verdict = parseQualityVerdict(params.verdict)
  const policy = resolveResearchExecutionPolicy(plan)
  const threshold = policy?.stopping.minimumExpectedInformationGain ?? 0
  const maximumCorrectionWaves =
    policy?.stopping.maximumCorrectionWaves ??
    DEEP_RESEARCH_MAX_CORRECTION_WAVES
  const estimates = verdict.correctionRequests.map((request) => ({
    correctionRequestId: request.id,
    expectedInformationGain: EXPECTED_INFORMATION_GAIN[request.type].score,
    reason: EXPECTED_INFORMATION_GAIN[request.type].reason,
  }))
  const aggregateExpectedInformationGain = estimates.length === 0
    ? 0
    : Math.max(...estimates.map((estimate) => estimate.expectedInformationGain))
  const sourceVerdictHash = hashResearchValue(verdict)

  if (verdict.decision !== 'REVISE') {
    return {
      verdict,
      decision: {
        schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
        planId: plan.planId,
        approvedPlanHash: plan.approvalHash ?? hashResearchValue(plan),
        sourceVerdictId: verdict.verdictId,
        sourceVerdictHash,
        correctionWave: verdict.correctionWave,
        decision: 'not_applicable',
        minimumExpectedInformationGain: threshold,
        aggregateExpectedInformationGain,
        maximumCorrectionWaves,
        estimates,
        reason: `Quality decision ${verdict.decision} does not authorize another correction wave.`,
        decidedAt: verdict.reviewedAt,
      },
    }
  }

  const waveCapReached = verdict.correctionWave >= maximumCorrectionWaves
  const isBoundedEvidenceRepair =
    verdict.correctionRequests.length > 0 &&
    verdict.correctionRequests.every((request) =>
      BOUNDED_EVIDENCE_REPAIR_TYPES.has(request.type),
    )
  const belowInformationGain =
    !isBoundedEvidenceRepair && aggregateExpectedInformationGain < threshold
  const shouldStop = waveCapReached || belowInformationGain
  const reason = waveCapReached
    ? `The approved policy allows at most ${maximumCorrectionWaves} correction wave${maximumCorrectionWaves === 1 ? '' : 's'}.`
    : isBoundedEvidenceRepair
      ? 'The correction reuses already acquired evidence and does not expand the approved research scope.'
    : belowInformationGain
      ? `Expected information gain ${aggregateExpectedInformationGain}/100 is below the approved ${threshold}/100 threshold.`
      : `Expected information gain ${aggregateExpectedInformationGain}/100 meets the approved ${threshold}/100 threshold.`
  const decision: ResearchAdaptiveDecision = {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: plan.planId,
    approvedPlanHash: plan.approvalHash ?? hashResearchValue(plan),
    sourceVerdictId: verdict.verdictId,
    sourceVerdictHash,
    correctionWave: verdict.correctionWave,
    decision: shouldStop ? 'stop' : 'continue',
    ...(shouldStop || !verdict.correctionRoute
      ? {}
      : { route: verdict.correctionRoute }),
    minimumExpectedInformationGain: threshold,
    aggregateExpectedInformationGain,
    maximumCorrectionWaves,
    estimates,
    reason,
    decidedAt: verdict.reviewedAt,
  }
  if (!shouldStop) return { verdict, decision }

  return {
    decision,
    verdict: parseQualityVerdict({
      ...verdict,
      verdictId: `adaptive-stop-${verdict.correctionWave}-${hashResearchValue({
        sourceVerdictHash,
        reason,
      }).slice(0, 12)}`,
      decision: 'ESCALATE',
      correctionRequests: [],
      correctionRoute: undefined,
    }),
  }
}

export function buildResearchPlanAmendment(params: {
  readonly plan: unknown
  readonly verdict: unknown
  readonly decision: ResearchAdaptiveDecision
  readonly sourceVerdictPath: string
}): ResearchPlanAmendment {
  const plan = assertResearchPlanApproved(params.plan)
  const verdict = parseQualityVerdict(params.verdict)
  if (
    verdict.decision !== 'REVISE' ||
    !verdict.correctionRoute ||
    params.decision.decision !== 'continue' ||
    params.decision.sourceVerdictHash !== hashResearchValue(verdict) ||
    params.decision.approvedPlanHash !== plan.approvalHash ||
    params.decision.correctionWave !== verdict.correctionWave ||
    verdict.correctionWave >= DEEP_RESEARCH_MAX_CORRECTION_WAVES
  ) {
    throw new Error(
      'A Deep Research amendment requires one continued, approval-bound REVISE verdict.',
    )
  }
  const targetTaskIds = uniqueSorted(
    verdict.correctionRequests.flatMap((request) => request.taskIds),
  )
  const targetSectionIds = uniqueSorted(
    verdict.correctionRequests.flatMap((request) => request.sectionIds),
  )
  const targetClaimIds = uniqueSorted(
    verdict.correctionRequests.flatMap((request) => request.claimIds),
  )
  const targetRequirementIds = uniqueSorted(
    verdict.correctionRequests.flatMap(
      (request) => request.requirementIds ?? [],
    ),
  )
  const fromWave = verdict.correctionWave as 0 | 1
  const amendmentBase = {
    planId: plan.planId,
    approvedPlanHash: plan.approvalHash,
    sourceVerdictPath: params.sourceVerdictPath,
    sourceVerdictHash: hashResearchValue(verdict),
    fromWave,
    toWave: (fromWave + 1) as 1 | 2,
    route: verdict.correctionRoute,
    targetTaskIds,
    targetSectionIds,
    targetClaimIds,
    targetRequirementIds,
    expectedInformationGain: params.decision.aggregateExpectedInformationGain,
    ...(plan.executionPolicy
      ? { approvedMaxCostUsd: plan.executionPolicy.maxCostUsd }
      : {}),
    scopeChange: 'none' as const,
    createdAt: verdict.reviewedAt,
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    amendmentId: `amendment-wave-${fromWave + 1}-${hashResearchValue(
      amendmentBase,
    ).slice(0, 12)}`,
    ...amendmentBase,
  }
}

function extractJsonObject(value: string): string {
  const start = value.indexOf('{')
  if (start < 0) {
    throw new Error('Approved Deep Research plan JSON was not found.')
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return value.slice(start, index + 1)
    }
  }
  throw new Error('Approved Deep Research plan JSON is incomplete.')
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}
