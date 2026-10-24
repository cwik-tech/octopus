import {
  isSafeWorkspaceProjectContextFilename,
  isValidWorkspaceProjectId,
} from '../../contracts/projects.js'
import type {
  OverlapPolicy,
  ScheduleActiveFire,
  ScheduleDefinition,
  ScheduleInput,
  ScheduleKind,
  ScheduleLastStatus,
  ScheduleModelOverride,
  SchedulePatch,
  SchedulePendingFire,
  ScheduleProjectContextSelection,
  ScheduleRuntime,
} from '../../contracts/schedules.js'

export type {
  OverlapPolicy,
  ScheduleActiveFire,
  ScheduleDefinition,
  ScheduleInput,
  ScheduleKind,
  ScheduleLastStatus,
  ScheduleModelOverride,
  SchedulePatch,
  SchedulePendingFire,
  ScheduleProjectContextSelection,
  ScheduleRuntime,
  ScheduleView,
} from '../../contracts/schedules.js'

export const SCHEDULES_SCHEMA_VERSION = 1 as const
export const SCHEDULES_RELATIVE_PATH = 'task-queue/schedules.json' as const
/** Registry tag marking scheduler-generated wrapper workflows (hidden from catalogs). */
export const SCHEDULER_GENERATED_TAG = 'scheduler-generated' as const

export interface ScheduleExecutionTarget {
  /** Resolved workflow used by the existing run-plan and task-queue path. */
  readonly workflowId: string
}

export interface StoredSchedule extends ScheduleDefinition {
  /** Optional only so an interrupted pre-release build can be repaired on load. */
  readonly execution?: ScheduleExecutionTarget
  readonly runtime?: ScheduleRuntime
}

export interface SchedulesFile {
  readonly version: typeof SCHEDULES_SCHEMA_VERSION
  readonly schedules: readonly StoredSchedule[]
}

export type SchedulesApiErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'method_not_allowed'
  | 'workflow_requires_input'
  | 'schedule_unavailable'
  | 'persistence_failed'

export interface SchedulesApiError {
  readonly error: string
  readonly code: SchedulesApiErrorCode
  readonly retryable: boolean
}

const MAX_NAME_LENGTH = 120
const MAX_TARGET_LENGTH = 200
const MAX_PROMPT_LENGTH = 20_000
const MAX_CRON_LENGTH = 100
const MAX_LABEL_LENGTH = 200
const MAX_PROVIDER_LENGTH = 100
const MAX_MODEL_LENGTH = 300

const SCHEDULE_FIELD_KEYS = [
  'name',
  'kind',
  'target',
  'modelOverride',
  'projectId',
  'projectContext',
  'prompt',
  'cron',
  'timezone',
  'scheduleLabel',
  'overlap',
  'notifyOnFailure',
  'enabled',
] as const

export function isScheduleKind(value: unknown): value is ScheduleKind {
  return value === 'agent' || value === 'workflow'
}

export function isOverlapPolicy(value: unknown): value is OverlapPolicy {
  return value === 'skip' || value === 'queue' || value === 'cancel_previous'
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() })
    return true
  } catch {
    return false
  }
}

export function validateScheduleInput(value: unknown): ScheduleInput {
  const source = requireRecord(value, 'Schedule must be a JSON object.')
  rejectUnknownKeys(source, SCHEDULE_FIELD_KEYS, 'Schedule')
  const kind = readScheduleKind(source.kind)
  const modelOverride = readModelOverride(source.modelOverride, false)
  if (kind === 'workflow' && modelOverride) {
    throw new Error("Schedule field 'modelOverride' is supported only for agent schedules.")
  }
  const enabled = readBoolean(source, 'enabled', false)
  const projectId = readProjectId(source.projectId, false)
  const projectContext = readProjectContext(source.projectContext, false)
  if (projectContext && !projectId) {
    throw new Error("Schedule field 'projectContext' requires 'projectId'.")
  }
  return {
    name: readString(source, 'name', MAX_NAME_LENGTH),
    kind,
    target: readString(source, 'target', MAX_TARGET_LENGTH),
    ...(modelOverride ? { modelOverride } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectContext ? { projectContext } : {}),
    prompt: readString(source, 'prompt', MAX_PROMPT_LENGTH),
    cron: readString(source, 'cron', MAX_CRON_LENGTH),
    timezone: readTimezone(source.timezone),
    scheduleLabel: readString(source, 'scheduleLabel', MAX_LABEL_LENGTH),
    overlap: readOverlapPolicy(source.overlap),
    notifyOnFailure: readBoolean(source, 'notifyOnFailure', true),
    ...(enabled === undefined ? {} : { enabled }),
  }
}

export function validateSchedulePatch(value: unknown): SchedulePatch {
  const source = requireRecord(value, 'Schedule patch must be a JSON object.')
  rejectUnknownKeys(source, SCHEDULE_FIELD_KEYS, 'Schedule patch')
  if (Object.keys(source).length === 0) {
    throw new Error('Schedule patch must contain at least one field.')
  }

  const patch: Record<string, unknown> = {}
  if ('name' in source) patch.name = readString(source, 'name', MAX_NAME_LENGTH)
  if ('kind' in source) patch.kind = readScheduleKind(source.kind)
  if ('target' in source) patch.target = readString(source, 'target', MAX_TARGET_LENGTH)
  if ('modelOverride' in source) {
    patch.modelOverride = source.modelOverride === null
      ? null
      : readModelOverride(source.modelOverride, true)
  }
  if ('projectId' in source) {
    patch.projectId = source.projectId === null
      ? null
      : readProjectId(source.projectId, true)
  }
  if ('projectContext' in source) {
    patch.projectContext = source.projectContext === null
      ? null
      : readProjectContext(source.projectContext, true)
  }
  if ('prompt' in source) patch.prompt = readString(source, 'prompt', MAX_PROMPT_LENGTH)
  if ('cron' in source) patch.cron = readString(source, 'cron', MAX_CRON_LENGTH)
  if ('timezone' in source) patch.timezone = readTimezone(source.timezone)
  if ('scheduleLabel' in source) {
    patch.scheduleLabel = readString(source, 'scheduleLabel', MAX_LABEL_LENGTH)
  }
  if ('overlap' in source) patch.overlap = readOverlapPolicy(source.overlap)
  if ('notifyOnFailure' in source) {
    patch.notifyOnFailure = readBoolean(source, 'notifyOnFailure', true)
  }
  if ('enabled' in source) patch.enabled = readBoolean(source, 'enabled', true)
  return patch as SchedulePatch
}

export function parseSchedulesFile(value: unknown): SchedulesFile {
  const source = requireRecord(value, 'Schedules must be a JSON object.')
  if (source.version !== SCHEDULES_SCHEMA_VERSION) {
    throw new Error('Schedules use an unsupported schema version.')
  }
  if (!Array.isArray(source.schedules)) {
    throw new Error("Schedules field 'schedules' must be an array.")
  }
  return {
    version: SCHEDULES_SCHEMA_VERSION,
    schedules: source.schedules.map(parseStoredSchedule),
  }
}

function parseStoredSchedule(value: unknown): StoredSchedule {
  const source = requireRecord(value, 'Stored schedule must be a JSON object.')
  const id = readDirectString(source.id, 'id', 200)
  const input = validateScheduleInput(
    Object.fromEntries(
      SCHEDULE_FIELD_KEYS
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, source[key]]),
    ),
  )
  const enabled = readBoolean(source, 'enabled', true)
  const createdAt = readTimestamp(source.createdAt, 'createdAt')
  const updatedAt = readTimestamp(source.updatedAt, 'updatedAt')
  const execution = parseExecutionTarget(source.execution)
  const runtime = parseRuntime(source.runtime)
  return {
    id,
    ...input,
    enabled,
    createdAt,
    updatedAt,
    ...(execution ? { execution } : {}),
    ...(runtime ? { runtime } : {}),
  }
}

function parseExecutionTarget(value: unknown): ScheduleExecutionTarget | undefined {
  if (value === undefined || value === null) return undefined
  const source = requireRecord(value, 'Stored schedule execution target is invalid.')
  return {
    workflowId: readDirectString(source.workflowId, 'execution.workflowId', 300),
  }
}

function parseRuntime(value: unknown): ScheduleRuntime | undefined {
  if (value === undefined || value === null) return undefined
  const source = requireRecord(value, 'Stored schedule runtime is invalid.')
  const runtime: Record<string, unknown> = {}
  for (const key of ['nextFireAt', 'lastFireAt'] as const) {
    if (source[key] !== undefined && source[key] !== null) {
      runtime[key] = readTimestamp(source[key], `runtime.${key}`)
    }
  }
  for (const key of ['lastSessionId', 'lastTaskId'] as const) {
    if (source[key] !== undefined && source[key] !== null) {
      runtime[key] = readDirectString(source[key], `runtime.${key}`, 300)
    }
  }
  if (source.lastError !== undefined && source.lastError !== null) {
    if (typeof source.lastError !== 'string') {
      throw new Error("Stored schedule runtime 'lastError' is invalid.")
    }
    runtime.lastError = source.lastError
  }
  if (source.lastStatus !== undefined && source.lastStatus !== null) {
    if (!isScheduleLastStatus(source.lastStatus)) {
      throw new Error("Stored schedule runtime 'lastStatus' is invalid.")
    }
    runtime.lastStatus = source.lastStatus
  }

  const activeFires = Array.isArray(source.activeFires)
    ? source.activeFires.map(parseActiveFire)
    : []
  // Migrate the single-fire shape written by the interrupted implementation.
  if (source.activeFire !== undefined && source.activeFire !== null) {
    activeFires.push(parseActiveFire(source.activeFire))
  }
  if (activeFires.length > 0) {
    runtime.activeFires = deduplicateActiveFires(activeFires)
  }
  if (source.pendingFire !== undefined && source.pendingFire !== null) {
    runtime.pendingFire = parsePendingFire(source.pendingFire)
  }
  return runtime as ScheduleRuntime
}

function parsePendingFire(value: unknown): SchedulePendingFire {
  const source = requireRecord(value, 'Stored schedule pending fire is invalid.')
  return {
    sessionId: readDirectString(source.sessionId, 'pendingFire.sessionId', 300),
    firedAt: readTimestamp(source.firedAt, 'pendingFire.firedAt'),
  }
}

function parseActiveFire(value: unknown): ScheduleActiveFire {
  const source = requireRecord(value, 'Stored schedule active fire is invalid.')
  return {
    sessionId: readDirectString(source.sessionId, 'activeFire.sessionId', 300),
    taskId: readDirectString(source.taskId, 'activeFire.taskId', 300),
    firedAt: readTimestamp(source.firedAt, 'activeFire.firedAt'),
  }
}

function deduplicateActiveFires(
  fires: readonly ScheduleActiveFire[],
): ScheduleActiveFire[] {
  const seen = new Set<string>()
  return fires.filter((fire) => {
    const key = `${fire.sessionId}\u0000${fire.taskId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readModelOverride(
  value: unknown,
  required: boolean,
): ScheduleModelOverride | undefined {
  if (value === undefined) {
    if (required) throw new Error("Schedule field 'modelOverride' is required.")
    return undefined
  }
  const source = requireRecord(
    value,
    "Schedule field 'modelOverride' must be an object.",
  )
  rejectUnknownKeys(source, ['provider', 'model'], 'Schedule model override')
  return {
    provider: readString(source, 'provider', MAX_PROVIDER_LENGTH),
    model: readString(source, 'model', MAX_MODEL_LENGTH),
  }
}

function readProjectId(value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new Error("Schedule field 'projectId' is required.")
    return undefined
  }
  if (typeof value !== 'string' || !isValidWorkspaceProjectId(value)) {
    throw new Error("Schedule field 'projectId' must be a UUID.")
  }
  return value
}

function readProjectContext(
  value: unknown,
  required: boolean,
): ScheduleProjectContextSelection | undefined {
  if (value === undefined) {
    if (required) throw new Error("Schedule field 'projectContext' is required.")
    return undefined
  }
  const source = requireRecord(
    value,
    "Schedule field 'projectContext' must be an object.",
  )
  rejectUnknownKeys(
    source,
    ['version', 'includeBrief', 'fileNames'],
    'Schedule project context',
  )
  if (source.version !== 1) {
    throw new Error("Schedule field 'projectContext.version' must be 1.")
  }
  if (typeof source.includeBrief !== 'boolean') {
    throw new Error("Schedule field 'projectContext.includeBrief' must be a boolean.")
  }
  if (!Array.isArray(source.fileNames) || source.fileNames.length > 20) {
    throw new Error("Schedule field 'projectContext.fileNames' must contain at most 20 files.")
  }
  const fileNames = source.fileNames.map((fileName) => {
    if (typeof fileName !== 'string') {
      throw new Error("Schedule field 'projectContext.fileNames' contains an invalid filename.")
    }
    const normalized = fileName.trim()
    if (!isSafeWorkspaceProjectContextFilename(normalized)) {
      throw new Error("Schedule field 'projectContext.fileNames' contains an invalid filename.")
    }
    return normalized
  })
  if (new Set(fileNames).size !== fileNames.length) {
    throw new Error("Schedule field 'projectContext.fileNames' must not contain duplicates.")
  }
  return { version: 1, includeBrief: source.includeBrief, fileNames }
}

function readScheduleKind(value: unknown): ScheduleKind {
  if (!isScheduleKind(value)) {
    throw new Error("Schedule field 'kind' must be 'agent' or 'workflow'.")
  }
  return value
}

function readOverlapPolicy(value: unknown): OverlapPolicy {
  if (!isOverlapPolicy(value)) {
    throw new Error("Schedule field 'overlap' must be 'skip', 'queue', or 'cancel_previous'.")
  }
  return value
}

function readTimezone(value: unknown): string {
  if (!isValidTimezone(value)) {
    throw new Error("Schedule field 'timezone' must be a valid IANA timezone.")
  }
  return value.trim()
}

function readString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  return readDirectString(source[key], key, maxLength)
}

function readDirectString(value: unknown, key: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Schedule field '${key}' must be a string.`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(
      `Schedule field '${key}' must be a non-empty string of at most ${maxLength} characters.`,
    )
  }
  return normalized
}

function readBoolean(source: Record<string, unknown>, key: string, required: true): boolean
function readBoolean(source: Record<string, unknown>, key: string, required: boolean): boolean | undefined
function readBoolean(
  source: Record<string, unknown>,
  key: string,
  required: boolean,
): boolean | undefined {
  const value = source[key]
  if (value === undefined) {
    if (required) throw new Error(`Schedule field '${key}' is required.`)
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Schedule field '${key}' must be a boolean.`)
  }
  return value
}

function readTimestamp(value: unknown, key: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Stored schedule '${key}' is invalid.`)
  }
  return value
}

function isScheduleLastStatus(value: unknown): value is ScheduleLastStatus {
  return value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'skipped_overlap' ||
    value === 'error'
}

function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}.`)
  }
}
