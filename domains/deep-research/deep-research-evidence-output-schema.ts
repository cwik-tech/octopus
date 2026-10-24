import type { ResearchSourceType } from '../../contracts/deep-research.js'

export type DeepResearchEvidenceOutputSchema = Readonly<Record<string, unknown>>

const SOURCE_TYPES: readonly ResearchSourceType[] = [
  'primary',
  'secondary',
  'regulatory',
  'academic',
  'industry',
  'news',
  'vendor',
  'community',
]

/**
 * Provider-level shape for one runtime-observed Deep Research packet.
 *
 * The schema intentionally permits only usable acquired sources. A
 * blocked or unobserved page belongs in unresolvedQuestions, not in the
 * canonical evidence artifact. Runtime validation remains authoritative for
 * exact task, lane, hash, receipt, excerpt, and content identities.
 */
export function createDeepResearchEvidenceOutputSchema(): DeepResearchEvidenceOutputSchema {
  const text = { type: 'string' } as const
  const textArray = { type: 'array', items: text } as const
  const evidenceLink = strictObject({
    sourceId: text,
    observationReceiptId: text,
    observedExcerpt: {
      type: 'string',
      maxLength: 500,
      description: 'One short contiguous passage copied from the cited source observation. Never join separate regions or omit intervening words.',
    },
    locator: text,
    relationship: {
      type: 'string',
      enum: ['supports', 'contradicts', 'context'],
      description: 'A supported claim must contain at least one link with relationship supports; context-only links are not supporting evidence.',
    },
  })
  const source = strictObject({
    schemaVersion: { type: 'integer', enum: [1] },
    sourceId: text,
    assignmentId: text,
    canonicalUrl: text,
    title: text,
    publisher: text,
    independenceKey: text,
    sourceType: { type: 'string', enum: SOURCE_TYPES },
    accessMethod: {
      type: 'string',
      enum: [
        'direct-http',
        'direct-http-proxied',
        'managed-browser',
        'managed-browser-proxied',
        'managed-reader',
        'cloud-browser',
        'document-parser',
      ],
    },
    observationReceiptId: text,
    status: { type: 'string', enum: ['usable'] },
  })
  const claim = strictObject({
    schemaVersion: { type: 'integer', enum: [1] },
    claimId: text,
    taskId: text,
    sectionId: text,
    statement: text,
    kind: { type: 'string', enum: ['fact', 'inference', 'uncertainty'] },
    evidenceStandard: {
      type: 'string',
      enum: ['single', 'independent_corroboration'],
    },
    sourceIds: textArray,
    evidenceLinks: {
      type: 'array',
      items: evidenceLink,
      description: 'For status supported, include at least one link whose relationship is supports.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    status: {
      type: 'string',
      enum: ['supported', 'disputed', 'unsupported', 'removed'],
      description: 'Use supported only when at least one evidence link has relationship supports.',
    },
    applicableScope: textArray,
  })
  const coverage = strictObject({
    schemaVersion: { type: 'integer', enum: [2] },
    requirementId: text,
    status: {
      type: 'string',
      enum: ['satisfied', 'unresolved', 'not_applicable'],
    },
    claimIds: textArray,
    sourceIds: textArray,
    value: text,
    unit: text,
    asOf: {
      type: 'string',
      description: 'Use an empty string when not applicable; otherwise use a canonical ISO date (YYYY-MM-DD) or canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).',
    },
    scope: textArray,
    note: text,
  })

  return strictObject({
    schemaVersion: { type: 'integer', enum: [1] },
    assignmentId: text,
    taskId: text,
    workerSpecHash: text,
    question: text,
    shortAnswer: text,
    findings: { type: 'array', items: claim },
    sources: { type: 'array', items: source },
    contradictions: {
      type: 'array',
      items: strictObject({
        description: text,
        sourceIds: textArray,
        status: {
          type: 'string',
          enum: ['resolved', 'unresolved'],
          description: 'Use resolved only when the evidence safely reconciles the conflict; otherwise use unresolved.',
        },
        resolution: {
          type: 'string',
          description: 'For resolved conflicts, explain which source governs which date, scope, or fact. Use an empty string for unresolved conflicts.',
        },
      }),
    },
    unresolvedQuestions: textArray,
    coverage: { type: 'array', items: coverage },
    stopReason: {
      type: 'string',
      enum: [
        'decision_useful',
        'source_limit',
        'time_limit',
        'insufficient_evidence',
      ],
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
