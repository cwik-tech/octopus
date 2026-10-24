export const DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION = 3 as const
export const DEFAULT_DEEP_RESEARCH_DURATION_MINUTES = 20 as const
export const MINIMUM_DEEP_RESEARCH_DURATION_MINUTES = 5 as const
export const MAXIMUM_DEEP_RESEARCH_DURATION_MINUTES = 120 as const
export const DEFAULT_MAXIMUM_RESEARCHER_AGENTS = 8 as const
export const MINIMUM_RESEARCHER_AGENTS = 1 as const
export const MAXIMUM_RESEARCHER_AGENTS = 8 as const
export const DEEP_RESEARCH_SETTINGS_RELATIVE_PATH =
  'deep-research/settings.json' as const

export type DeepResearchSettingsSource = 'default' | 'persisted'

export type DeepResearchSettingsApiErrorCode =
  | 'invalid_request'
  | 'method_not_allowed'
  | 'deep_research_settings_unavailable'
  | 'settings_persistence_failed'

export interface DeepResearchSettingsValues {
  readonly maxDurationMinutes: number
  readonly maxResearcherAgents: number
}

export interface DeepResearchSettingsFile extends DeepResearchSettingsValues {
  readonly schemaVersion: typeof DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION
}

export interface DeepResearchSettingsSnapshot extends DeepResearchSettingsFile {
  readonly constraints: {
    readonly maxDurationMinutes: {
      readonly minimum: typeof MINIMUM_DEEP_RESEARCH_DURATION_MINUTES
      readonly maximum: typeof MAXIMUM_DEEP_RESEARCH_DURATION_MINUTES
    }
    readonly maxResearcherAgents: {
      readonly minimum: typeof MINIMUM_RESEARCHER_AGENTS
      readonly maximum: typeof MAXIMUM_RESEARCHER_AGENTS
    }
  }
  readonly source: DeepResearchSettingsSource
  readonly editable: boolean
}

export interface DeepResearchSettingsApiError {
  readonly error: string
  readonly code: DeepResearchSettingsApiErrorCode
  readonly retryable: boolean
}

export function isValidDeepResearchDurationMinutes(
  value: unknown,
): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MINIMUM_DEEP_RESEARCH_DURATION_MINUTES
    && value <= MAXIMUM_DEEP_RESEARCH_DURATION_MINUTES
}

export function isValidMaximumResearcherAgents(
  value: unknown,
): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MINIMUM_RESEARCHER_AGENTS
    && value <= MAXIMUM_RESEARCHER_AGENTS
}

export function parseDeepResearchSettingsFile(
  value: unknown,
): DeepResearchSettingsFile {
  if (!isRecord(value)) {
    throw new Error('Deep Research settings must be a JSON object.')
  }
  if (value.schemaVersion === 1) {
    return migrateV1SettingsFile(value)
  }
  if (value.schemaVersion === 2) {
    return migrateV2SettingsFile(value)
  }
  const keys = Object.keys(value)
  if (
    keys.length !== 3
    || !keys.includes('schemaVersion')
    || !keys.includes('maxDurationMinutes')
    || !keys.includes('maxResearcherAgents')
  ) {
    throw new Error('Deep Research settings contain an invalid field set.')
  }
  if (value.schemaVersion !== DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION) {
    throw new Error('Deep Research settings use an unsupported schema version.')
  }
  validateDeepResearchSettingsValues(value)
  return {
    schemaVersion: DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION,
    maxDurationMinutes: value.maxDurationMinutes,
    maxResearcherAgents: value.maxResearcherAgents,
  }
}

function migrateV1SettingsFile(
  value: Record<string, unknown>,
): DeepResearchSettingsFile {
  const keys = Object.keys(value)
  if (
    keys.length !== 3
    || !keys.includes('schemaVersion')
    || !keys.includes('maxDurationMinutes')
    || !keys.includes('maxResearcherAgents')
  ) {
    throw new Error('Deep Research settings contain an invalid field set.')
  }
  if (!isValidDeepResearchDurationMinutes(value.maxDurationMinutes)) {
    throw new Error(
      `Deep Research maxDurationMinutes must be an integer from ${MINIMUM_DEEP_RESEARCH_DURATION_MINUTES} through ${MAXIMUM_DEEP_RESEARCH_DURATION_MINUTES}.`,
    )
  }
  if (!isValidMaximumResearcherAgents(value.maxResearcherAgents)) {
    throw new Error(
      `Deep Research maxResearcherAgents must be an integer from ${MINIMUM_RESEARCHER_AGENTS} through ${MAXIMUM_RESEARCHER_AGENTS}.`,
    )
  }
  return {
    schemaVersion: DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION,
    maxDurationMinutes: value.maxDurationMinutes,
    maxResearcherAgents: value.maxResearcherAgents,
  }
}

function migrateV2SettingsFile(
  value: Record<string, unknown>,
): DeepResearchSettingsFile {
  const keys = Object.keys(value)
  if (
    keys.length !== 4
    || !keys.includes('schemaVersion')
    || !keys.includes('maxDurationMinutes')
    || !keys.includes('maxResearcherAgents')
    || !keys.includes('browserMode')
  ) {
    throw new Error('Deep Research settings contain an invalid field set.')
  }
  if (value.browserMode !== 'headed' && value.browserMode !== 'headless') {
    throw new Error('Deep Research settings contain an invalid legacy browser mode.')
  }
  validateDeepResearchSettingsValues(value)
  return {
    schemaVersion: DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION,
    maxDurationMinutes: value.maxDurationMinutes,
    maxResearcherAgents: value.maxResearcherAgents,
  }
}

export function validateDeepResearchSettingsValues(
  value: DeepResearchSettingsValues | Record<string, unknown>,
): asserts value is DeepResearchSettingsValues {
  if (!isValidDeepResearchDurationMinutes(value.maxDurationMinutes)) {
    throw new Error(
      `Deep Research maxDurationMinutes must be an integer from ${MINIMUM_DEEP_RESEARCH_DURATION_MINUTES} through ${MAXIMUM_DEEP_RESEARCH_DURATION_MINUTES}.`,
    )
  }
  if (!isValidMaximumResearcherAgents(value.maxResearcherAgents)) {
    throw new Error(
      `Deep Research maxResearcherAgents must be an integer from ${MINIMUM_RESEARCHER_AGENTS} through ${MAXIMUM_RESEARCHER_AGENTS}.`,
    )
  }
}

export function deepResearchSettingsSnapshot(params: {
  readonly values: DeepResearchSettingsValues
  readonly source: DeepResearchSettingsSource
}): DeepResearchSettingsSnapshot {
  validateDeepResearchSettingsValues(params.values)
  return {
    schemaVersion: DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION,
    ...params.values,
    constraints: {
      maxDurationMinutes: {
        minimum: MINIMUM_DEEP_RESEARCH_DURATION_MINUTES,
        maximum: MAXIMUM_DEEP_RESEARCH_DURATION_MINUTES,
      },
      maxResearcherAgents: {
        minimum: MINIMUM_RESEARCHER_AGENTS,
        maximum: MAXIMUM_RESEARCHER_AGENTS,
      },
    },
    source: params.source,
    editable: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
