import { whenDefined } from '../../core/optional-properties.js'
import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'
import { normalizeMcpWorkflowRequirements } from '../../contracts/mcp-workflow-capabilities.js'
import type {
  LevelOverride,
  RuntimeOverrides,
  StepDraft,
  WorkflowDraft,
  WorkflowStageType,
} from './workflow-draft.js'

function str(value: YamlValue | undefined, fallback = ''): string {
  if (value == null) return fallback
  return String(value)
}

function bool(value: YamlValue | undefined): boolean | undefined {
  if (value == null) return undefined
  if (typeof value === 'boolean') return value
  return String(value).toLowerCase() === 'true'
}

function stringList(value: YamlValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => String(item)).filter(Boolean)
}

function parseStep(value: YamlValue, index: number): StepDraft {
  const step = value as YamlObject
  const parsed: StepDraft = {
    id: str(step.id),
    type: str(step.type, 'team') as StepDraft['type'],
    ...(step.team ? { team: str(step.team) } : {}),
    input_artifact: str(step.input_artifact),
    result_artifact: str(step.result_artifact),
  }

  if (step.agent) {
    parsed.agent = str(step.agent)
  }
  if (step.prompt) {
    parsed.prompt = str(step.prompt)
  }
  if (step.stage_type) {
    const stageType = str(step.stage_type)
    if (isWorkflowStageType(stageType)) parsed.stage_type = stageType
  }

  if (step.requested_result_type) {
    parsed.requested_result_type = str(step.requested_result_type)
  }
  if (step.brief_prefix != null) {
    parsed.brief_prefix = str(step.brief_prefix)
  }
  if (step.brief_suffix != null) {
    parsed.brief_suffix = str(step.brief_suffix)
  }
  const includeInitialBrief = bool(step.include_initial_brief)
  if (includeInitialBrief !== undefined) {
    parsed.include_initial_brief = includeInitialBrief
  }
  const mcpRequirements = parseMcpRequirements(
    step.mcp_requirements,
    `workflow.steps[${index}].mcp_requirements`,
  )
  if (mcpRequirements !== undefined) {
    parsed.mcp_requirements = mcpRequirements
  }
  if (step.runtime_overrides && typeof step.runtime_overrides === 'object') {
    const runtimeOverrides = parseRuntimeOverrides(step.runtime_overrides)
    if (runtimeOverrides) parsed.runtime_overrides = runtimeOverrides
  }
  if (step.recovery_policy) {
    const recoveryPolicy = str(step.recovery_policy)
    if (isRecoveryPolicy(recoveryPolicy)) parsed.recovery_policy = recoveryPolicy
  }
  if (step.handoff && typeof step.handoff === 'object') {
    const handoff = step.handoff as YamlObject
    parsed.handoff = {
      from_step: str(handoff.from_step),
      from_artifact: str(handoff.from_artifact),
      to_artifact: str(handoff.to_artifact),
    }
  }

  return parsed
}

function isWorkflowStageType(value: string): value is WorkflowStageType {
  return value === 'routing' || value === 'discussion' || value === 'pipeline' ||
    value === 'chain' || value === 'broadcast' || value === 'review'
}

function isRecoveryPolicy(
  value: string,
): value is NonNullable<StepDraft['recovery_policy']> {
  return value === 'safe_retry' || value === 'idempotent' ||
    value === 'manual' || value === 'never_retry'
}

function parseRuntimeOverrides(value: YamlValue): RuntimeOverrides | undefined {
  if (!isYamlObject(value)) return undefined
  if (value.levels === undefined) return {}
  if (!isYamlObject(value.levels)) return undefined
  const levels: Record<string, LevelOverride> = {}
  for (const [levelId, rawOverride] of Object.entries(value.levels)) {
    if (!isYamlObject(rawOverride)) return undefined
    const override: LevelOverride = {}
    if (rawOverride.discussion !== undefined) {
      if (!isYamlObject(rawOverride.discussion)) return undefined
      const discussion = rawOverride.discussion
      const participants = stringList(discussion.participants)
      const minRounds = finiteNumber(discussion.min_rounds)
      const maxRounds = finiteNumber(discussion.max_rounds)
      const minimumSuccessful = finiteNumber(discussion.min_successful_participants)
      override.discussion = {
        ...whenDefined(participants, (presentParticipants) => ({ participants: presentParticipants })),
        ...whenDefined(minRounds, (min_rounds) => ({ min_rounds })),
        ...whenDefined(maxRounds, (max_rounds) => ({ max_rounds })),
        ...whenDefined(minimumSuccessful, (min_successful_participants) => ({ min_successful_participants })),
      }
    }
    if (rawOverride.review !== undefined) {
      if (!isYamlObject(rawOverride.review)) return undefined
      override.review = {
        ...whenDefined(finiteNumber(rawOverride.review.max_iterations), (max_iterations) => ({ max_iterations })),
      }
    }
    levels[levelId] = override
  }
  return { levels }
}

function isYamlObject(value: YamlValue | undefined): value is YamlObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: YamlValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseWorkflowYaml(yaml: string): WorkflowDraft {
  const raw = parseYaml(yaml)
  const workflow = (raw.workflow && typeof raw.workflow === 'object'
    ? raw.workflow
    : raw) as YamlObject
  const input = workflow.input && typeof workflow.input === 'object'
    ? (workflow.input as YamlObject)
    : {}
  const output = workflow.output && typeof workflow.output === 'object'
    ? (workflow.output as YamlObject)
    : {}
  const steps = Array.isArray(workflow.steps) ? workflow.steps : []
  const mcpRequirements = parseMcpRequirements(
    workflow.mcp_requirements,
    'workflow.mcp_requirements',
  )

  return {
    id: str(workflow.id),
    description: str(workflow.description),
    ...whenDefined(stringList(workflow.matches), (matches) => ({ matches })),
    ...(mcpRequirements !== undefined ? { mcp_requirements: mcpRequirements } : {}),
    input: { artifact: str(input.artifact) },
    steps: steps.map(parseStep),
    output: {
      from_step: str(output.from_step),
      artifact: str(output.artifact),
    },
    on_blocked: str(workflow.on_blocked, 'stop') as WorkflowDraft['on_blocked'],
    on_failed: str(workflow.on_failed, 'stop') as WorkflowDraft['on_failed'],
  }
}

function parseMcpRequirements(
  value: YamlValue | undefined,
  scope: string,
): WorkflowDraft['mcp_requirements'] {
  if (value === undefined) return undefined
  const normalized = normalizeMcpWorkflowRequirements(value, scope)
  return (
    normalized.errors.length === 0
      ? normalized.requirements
      : value
  ) as WorkflowDraft['mcp_requirements']
}
