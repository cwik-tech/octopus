import {
  DEEP_RESEARCH_METHOD_CARD_IDS,
  EXECUTABLE_RESEARCH_TASK_PURPOSES,
  type ResearchLens,
  type ResearchSourceType,
} from '../../contracts/deep-research.js'

export type DeepResearchPlanOutputSchema = Readonly<Record<string, unknown>>

const RESEARCH_LENSES: readonly ResearchLens[] = [
  'foundational',
  'market',
  'competitive',
  'regulatory',
  'technical',
  'historical',
  'source_verification',
]

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

export function createDeepResearchPlanOutputSchema(settings: {
  readonly maxDurationMinutes: number
  readonly maxResearcherAgents: number
}): DeepResearchPlanOutputSchema {
  const text = { type: 'string' } as const
  const textArray = { type: 'array', items: text } as const
  const safeId = text
  const safeIdArray = { type: 'array', items: safeId } as const
  const sourceTypes = {
    type: 'array',
    items: { type: 'string', enum: SOURCE_TYPES },
  } as const

  return strictObject({
    schemaVersion: { type: 'integer', enum: [1] },
    planId: safeId,
    requestId: safeId,
    request: strictObject({
      schemaVersion: { type: 'integer', enum: [1] },
      requestId: safeId,
      question: text,
      objective: text,
      audience: text,
      includedScope: textArray,
      excludedScope: textArray,
      desiredSections: textArray,
      jurisdictions: textArray,
      freshnessAsOf: text,
      authenticatedDomains: textArray,
      sourceRequirements: textArray,
      maxDurationMinutes: boundedInteger(5, settings.maxDurationMinutes),
      maxResearcherAgents: boundedInteger(1, settings.maxResearcherAgents),
      outputFormats: {
        type: 'array',
        items: { type: 'string', enum: ['markdown', 'docx'] },
      },
    }),
    sections: {
      type: 'array',
      items: strictObject({
        schemaVersion: { type: 'integer', enum: [1] },
        id: safeId,
        title: text,
        objective: text,
        taskIds: safeIdArray,
      }),
    },
    tasks: {
      type: 'array',
      items: strictObject({
        schemaVersion: { type: 'integer', enum: [1] },
        id: safeId,
        sectionId: safeId,
        title: text,
        question: text,
        purpose: {
          type: 'string',
          enum: EXECUTABLE_RESEARCH_TASK_PURPOSES,
        },
        workerSpecId: safeId,
        dependsOn: safeIdArray,
        correctionWave: { type: 'integer', enum: [0] },
      }),
    },
    workerSpecs: {
      type: 'array',
      items: strictObject({
        schemaVersion: { type: 'integer', enum: [1] },
        id: safeId,
        laneId: safeId,
        sectionId: safeId,
        baseAgent: { type: 'string', enum: ['web-researcher'] },
        displayRole: text,
        domain: text,
        lens: { type: 'string', enum: RESEARCH_LENSES },
        methodCardIds: {
          type: 'array',
          items: { type: 'string', enum: DEEP_RESEARCH_METHOD_CARD_IDS },
        },
        specialistStance: {
          type: 'string',
          description:
            'One to three concise sentences describing the domain-expert analytical posture and distinctions this worker must maintain. Do not claim credentials or expand authority.',
        },
        question: text,
        decisionUse: text,
        workingDefinitions: {
          type: 'array',
          description:
            'Concise operational counting, classification, or boundary rules needed to resolve material ambiguity. Use an empty array when none are needed.',
          items: text,
        },
        dependencyClaimIds: safeIdArray,
        sourceRequirements: strictObject({
          preferredTypes: sourceTypes,
          requiredAuthorityTypes: sourceTypes,
          queryHints: textArray,
        }),
        coverageRequirements: {
          type: 'array',
          items: strictObject({
            schemaVersion: { type: 'integer', enum: [2] },
            id: safeId,
            label: text,
            kind: {
              type: 'string',
              enum: [
                'fact',
                'quantitative_metric',
                'comparison',
                'source_authority',
                'caveat',
                'decision',
              ],
            },
            validation: {
              type: 'string',
              enum: [
                'claim_support',
                'quantitative_value',
                'independent_comparison',
                'source_authority',
                'explicit_caveat',
                'decision_support',
              ],
            },
            required: { type: 'boolean' },
          }),
        },
        prohibitedAssumptions: textArray,
        stopRule: strictObject({
          minimumPrimarySources: boundedInteger(0, 50),
          minimumIndependentSources: boundedInteger(1, 50),
          maximumSources: boundedInteger(1, 50),
        }),
        limits: strictObject({
          deadlineMs: boundedInteger(
            1_000,
            settings.maxDurationMinutes * 60_000,
          ),
        }),
      }),
    },
    maxDurationMinutes: boundedInteger(5, settings.maxDurationMinutes),
    maxResearcherAgents: boundedInteger(1, settings.maxResearcherAgents),
    expectedPeakWorkers: boundedInteger(1, settings.maxResearcherAgents),
    authenticatedDomains: textArray,
    executionPolicy: strictObject({
      schemaVersion: { type: 'integer', enum: [1] },
      complexity: {
        type: 'string',
        enum: ['simple', 'standard', 'complex'],
      },
      complexityRationale: text,
      searchBreadth: {
        type: 'string',
        enum: ['focused', 'balanced', 'broad'],
      },
      maxCostUsd: boundedInteger(1, 40),
      evidenceTargets: strictObject({
        minimumSupportedClaims: boundedInteger(1, 100),
        minimumIndependentSourcesPerConsequentialClaim: boundedInteger(1, 5),
        crossVerifyConsequentialClaims: { type: 'boolean' },
      }),
      stopping: strictObject({
        minimumExpectedInformationGain: boundedInteger(0, 100),
        maximumCorrectionWaves: boundedInteger(0, 2),
      }),
      synthesis: strictObject({
        mode: {
          type: 'string',
          enum: ['single_pass', 'section_dossiers'],
        },
        maximumParallelSections: boundedInteger(1, 8),
      }),
    }),
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

function boundedInteger(
  _minimum: number,
  _maximum: number,
): Readonly<Record<string, unknown>> {
  // Codex structured output accepts a strict JSON Schema subset. Runtime
  // validation and normalization remain authoritative for numeric bounds.
  return { type: 'integer' }
}
