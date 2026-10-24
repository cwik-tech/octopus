import type {
  CorrectionRequest,
  QualityFinding,
  QualityFindingCode,
} from '../../contracts/deep-research.js'

export type DeepResearchQualityVerdictOutputSchema = Readonly<
  Record<string, unknown>
>

const FINDING_CODES: readonly QualityFindingCode[] = [
  'task_missing',
  'task_not_answered',
  'task_irrelevant',
  'required_metric_missing',
  'required_coverage_missing',
  'evidence_target_missing',
  'requirement_unresolved',
  'claim_unsupported',
  'source_unobserved',
  'source_not_independent',
  'primary_source_missing',
  'required_authority_missing',
  'contradiction_unresolved',
  'unresolved_question',
  'evidence_stale',
  'scope_mismatch',
  'report_evidence_mismatch',
  'decision_not_supported',
]

const FINDING_SEVERITIES: readonly QualityFinding['severity'][] = [
  'blocking',
  'warning',
]

const CORRECTION_TYPES: readonly CorrectionRequest['type'][] = [
  'new_research',
  'cross_verify',
  'verify_source',
  'resolve_contradiction',
  'remove_claim',
  'resynthesize',
  'restructure_packet',
]

const IMPACT_SCOPES: readonly CorrectionRequest['impactScope'][] = [
  'local',
  'global',
]

/**
 * Provider-level shape for the evidence critic's single machine verdict.
 *
 * This constrains transport only. `parseQualityVerdict` and the assignment's
 * reference checks stay authoritative for every rule a schema cannot express:
 * an approval carrying blocking findings, a revision with no correction, a
 * route on a non-revision verdict, a synthesis route holding a non-resynthesize
 * request, and every task, section, claim, and source identity.
 *
 * The wire shape makes every property required, because the strict JSON Schema
 * subset the Codex CLI accepts has no optional properties. Two of those
 * properties have a neutral value meaning "absent", because the contract cannot
 * express absence as a value: an empty `correctionRoute` and an empty
 * correction `question`. The parser removes exactly those two before semantic
 * validation. An empty `requirementIds` is not absence — it is the answer that
 * this finding or request targets no deterministic requirement — so it stays
 * the empty array it arrived as.
 */
export function createDeepResearchQualityVerdictOutputSchema(): DeepResearchQualityVerdictOutputSchema {
  const text = { type: 'string' } as const
  const safeIdArray = { type: 'array', items: text } as const

  return strictObject({
    schemaVersion: { type: 'integer', enum: [1] },
    verdictId: text,
    correctionWave: { type: 'integer', enum: [0, 1, 2] },
    decision: { type: 'string', enum: ['APPROVE', 'REVISE', 'ESCALATE'] },
    findings: {
      type: 'array',
      items: strictObject({
        code: { type: 'string', enum: FINDING_CODES },
        severity: { type: 'string', enum: FINDING_SEVERITIES },
        message: text,
        taskIds: safeIdArray,
        sectionIds: safeIdArray,
        claimIds: safeIdArray,
        sourceIds: safeIdArray,
        requirementIds: {
          ...safeIdArray,
          description:
            'Deterministic requirement identifiers this finding targets. Use an empty array when none apply.',
        },
      }),
    },
    correctionRequests: {
      type: 'array',
      items: strictObject({
        schemaVersion: { type: 'integer', enum: [1] },
        id: text,
        type: { type: 'string', enum: CORRECTION_TYPES },
        claimIds: safeIdArray,
        taskIds: safeIdArray,
        sectionIds: safeIdArray,
        requirementIds: {
          ...safeIdArray,
          description:
            'Deterministic requirement identifiers this correction targets. Use an empty array when none apply.',
        },
        question: {
          ...text,
          description:
            'The question this correction must answer. Use an empty string when the acceptance criteria are sufficient.',
        },
        acceptanceCriteria: { type: 'array', items: text },
        impactScope: { type: 'string', enum: IMPACT_SCOPES },
      }),
    },
    correctionRoute: {
      type: 'string',
      enum: ['', 'research', 'synthesis'],
      description:
        'Use synthesis only when every request is resynthesize, research for any other revision, and an empty string for APPROVE or ESCALATE.',
    },
    reviewedAt: {
      ...text,
      description: 'Canonical ISO UTC timestamp, for example 2026-07-16T12:00:00.000Z.',
    },
  })
}

function strictObject(
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}
