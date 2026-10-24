export const SCHEDULING_SETTINGS_SCHEMA_VERSION = 1 as const
export const DEFAULT_MAXIMUM_CONCURRENT_TASKS = 3 as const
export const MINIMUM_CONCURRENT_TASKS = 1 as const
export const MAXIMUM_CONCURRENT_TASKS = 64 as const
export const MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE =
  'TEAM_RUNTIME_MAX_CONCURRENT_TASKS' as const
export const SCHEDULING_SETTINGS_RELATIVE_PATH =
  'task-queue/settings.json' as const

export type SchedulingSettingsSource =
  | 'default'
  | 'persisted'
  | 'environment'

export type SchedulingSettingsApiErrorCode =
  | 'invalid_request'
  | 'managed_by_environment'
  | 'method_not_allowed'
  | 'scheduling_unavailable'
  | 'settings_persistence_failed'
  | 'task_admission_recovering'

export interface SchedulingSettingsFile {
  readonly version: typeof SCHEDULING_SETTINGS_SCHEMA_VERSION
  readonly maximumConcurrentTasks: number
}

export interface SchedulingSettingsSnapshot {
  readonly maximumConcurrentTasks: number
  readonly constraints: {
    readonly minimum: typeof MINIMUM_CONCURRENT_TASKS
    readonly maximum: typeof MAXIMUM_CONCURRENT_TASKS
  }
  readonly source: SchedulingSettingsSource
  readonly editable: boolean
}

export interface SchedulingSettingsApiError {
  readonly error: string
  readonly code: SchedulingSettingsApiErrorCode
  readonly retryable: boolean
}

export function isValidMaximumConcurrentTasks(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MINIMUM_CONCURRENT_TASKS
    && value <= MAXIMUM_CONCURRENT_TASKS
}

export function parseMaximumConcurrentTasksEnvironmentValue(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(
      `${MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE} must be an integer from ${MINIMUM_CONCURRENT_TASKS} through ${MAXIMUM_CONCURRENT_TASKS}.`,
    )
  }
  const parsed = Number(normalized)
  if (!isValidMaximumConcurrentTasks(parsed)) {
    throw new Error(
      `${MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE} must be an integer from ${MINIMUM_CONCURRENT_TASKS} through ${MAXIMUM_CONCURRENT_TASKS}.`,
    )
  }
  return parsed
}

export function parseSchedulingSettingsFile(
  value: unknown,
): SchedulingSettingsFile {
  if (!isRecord(value)) {
    throw new Error('Scheduling settings must be a JSON object.')
  }
  const keys = Object.keys(value)
  if (
    keys.length !== 2
    || !keys.includes('version')
    || !keys.includes('maximumConcurrentTasks')
  ) {
    throw new Error('Scheduling settings contain an invalid field set.')
  }
  if (value.version !== SCHEDULING_SETTINGS_SCHEMA_VERSION) {
    throw new Error('Scheduling settings use an unsupported schema version.')
  }
  if (!isValidMaximumConcurrentTasks(value.maximumConcurrentTasks)) {
    throw new Error(
      `Scheduling settings maximumConcurrentTasks must be an integer from ${MINIMUM_CONCURRENT_TASKS} through ${MAXIMUM_CONCURRENT_TASKS}.`,
    )
  }
  return {
    version: SCHEDULING_SETTINGS_SCHEMA_VERSION,
    maximumConcurrentTasks: value.maximumConcurrentTasks,
  }
}

export function schedulingSettingsSnapshot(params: {
  readonly maximumConcurrentTasks: number
  readonly source: SchedulingSettingsSource
}): SchedulingSettingsSnapshot {
  if (!isValidMaximumConcurrentTasks(params.maximumConcurrentTasks)) {
    throw new Error('Cannot create a snapshot with an invalid concurrency limit.')
  }
  return {
    maximumConcurrentTasks: params.maximumConcurrentTasks,
    constraints: {
      minimum: MINIMUM_CONCURRENT_TASKS,
      maximum: MAXIMUM_CONCURRENT_TASKS,
    },
    source: params.source,
    editable: params.source !== 'environment',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
