export const ENGINE_EVENT_SCHEMA_VERSION = 1 as const

export const ENGINE_EVENT_CATEGORIES = [
  'run',
  'stage',
  'agent',
  'tool',
  'gate',
  'artifact',
  'runtime',
  'delegation',
] as const

export type EngineEventCategory = (typeof ENGINE_EVENT_CATEGORIES)[number]

export interface EngineEventEnvelope<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  schema_version: typeof ENGINE_EVENT_SCHEMA_VERSION
  timestamp: string
  tenant_id: string
  category: EngineEventCategory
  type: string
  run_id?: string
  root_run_id?: string
  parent_run_id?: string
  assignment_path?: string
  team?: string | null
  level_id?: string | null
  stage_type?: string | null
  payload: TPayload
}

export interface WorkflowHumanInputRequestedPayload extends Record<string, unknown> {
  interaction_id: string
  step_id: string
  recipients: Array<{
    id: string
    mentionToken: string
    displayName: string
  }>
}

export interface RunAwaitingInputPayload extends Record<string, unknown> {
  interaction_id: string
  step_id: string
  source_artifact: {
    childRunId: string
    relativePath: string
    sha256: string
    byteLength: number
  }
}

export interface WorkflowHumanInputMessagePayload extends Record<string, unknown> {
  interaction_id: string
  step_id: string
  submission_id: string
  message_id: string
  text: string
  recipients: 'all' | string[]
}

export interface WorkflowHumanInputSubmittedPayload extends Record<string, unknown> {
  interaction_id: string
  step_id: string
  submission_id: string
  mode: 'feedback' | 'continue_without_feedback'
  message_count: number
}

export type WorkflowHumanInputRuntimeEvent =
  | (EngineEventEnvelope<RunAwaitingInputPayload> & {
      category: 'runtime'
      type: 'run.awaiting_input'
    })
  | (EngineEventEnvelope<WorkflowHumanInputRequestedPayload> & {
      category: 'runtime'
      type: 'workflow.human_input.requested'
    })
  | (EngineEventEnvelope<WorkflowHumanInputMessagePayload> & {
      category: 'runtime'
      type: 'workflow.human_input.message'
    })
  | (EngineEventEnvelope<WorkflowHumanInputSubmittedPayload> & {
      category: 'runtime'
      type: 'workflow.human_input.submitted'
    })

const ENGINE_EVENT_CATEGORY_SET = new Set<string>(ENGINE_EVENT_CATEGORIES)

export function isEngineEventEnvelope(
  value: unknown,
): value is EngineEventEnvelope {
  if (!isRecord(value)) return false
  if (
    value.schema_version !== ENGINE_EVENT_SCHEMA_VERSION ||
    !isString(value.timestamp) ||
    !isString(value.tenant_id) ||
    typeof value.category !== 'string' ||
    !ENGINE_EVENT_CATEGORY_SET.has(value.category) ||
    !isString(value.type) ||
    !isRecord(value.payload)
  ) {
    return false
  }

  return (
    isOptionalString(value.run_id) &&
    isOptionalString(value.root_run_id) &&
    isOptionalString(value.parent_run_id) &&
    isOptionalString(value.assignment_path) &&
    isOptionalNullableString(value.team) &&
    isOptionalNullableString(value.level_id) &&
    isOptionalNullableString(value.stage_type)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalNullableString(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}
