/**
 * Type definitions for the workflow-generator feature.
 *
 * `WorkflowDraft` is the JSON shape the LLM emits each turn. It mirrors the
 * YAML schema parsed by `workflows/loader.ts:parseWorkflowTemplate` so a
 * draft can be stringified to YAML and loaded back unchanged.
 */

import type { ChatTurn } from './agent-generator.js'
import type { McpWorkflowCapabilityRequirement } from './mcp.js'

export type { ChatTurn }

export type WorkflowStageType =
  | 'routing'
  | 'discussion'
  | 'pipeline'
  | 'chain'
  | 'broadcast'
  | 'review'

export interface DiscussionOverride {
  participants?: string[]
  min_rounds?: number
  max_rounds?: number
  min_successful_participants?: number
}

export interface ReviewOverride {
  max_iterations?: number
}

export interface LevelOverride {
  discussion?: DiscussionOverride
  review?: ReviewOverride
}

export interface RuntimeOverrides {
  levels?: Record<string, LevelOverride>
}

export interface HandoffSpec {
  from_step: string
  from_artifact: string
  to_artifact: string
}

export interface StepDraft {
  id: string
  type: 'team' | 'agent' | 'human-in-the-loop'
  team?: string
  agent?: string | undefined
  prompt?: string
  stage_type?: WorkflowStageType | undefined
  input_artifact: string
  result_artifact: string
  requested_result_type?: string
  brief_prefix?: string
  brief_suffix?: string
  include_initial_brief?: boolean
  mcp_requirements?: McpWorkflowCapabilityRequirement[]
  runtime_overrides?: RuntimeOverrides | undefined
  recovery_policy?: 'safe_retry' | 'idempotent' | 'manual' | 'never_retry'
  handoff?: HandoffSpec | undefined
}

export interface WorkflowDraft {
  id: string
  description: string
  matches?: string[]
  mcp_requirements?: McpWorkflowCapabilityRequirement[]
  input: { artifact: string }
  steps: StepDraft[]
  output: { from_step: string; artifact: string }
  on_blocked: 'stop' | 'escalate_to_user'
  on_failed: 'stop' | 'escalate_to_user'
}

export interface WorkflowCreateHandoff {
  targetMode: 'agents' | 'teams' | 'workflows'
  prompt: string
  reason: string
}

export interface GeneratorTurnResponse {
  message: string
  draft: WorkflowDraft | null
  warnings?: string[]
  handoff?: WorkflowCreateHandoff
}

export interface AgentEntry {
  name: string
  role: string
  tier?: string
  tools?: string[]
  agent_file?: string
}

export interface LevelEntry {
  id: string
  name?: string
  stage_type: string
  coordinator?: string
  participants?: string[]
  sequence?: string[]
  producer?: string
  reviewer?: string
  min_rounds?: number
  max_rounds?: number
  min_successful_participants?: number
  max_iterations?: number
  output_format?: string
}

export interface TeamEntry {
  id: string
  description?: string
  tags?: string[]
  default_input_artifact?: string
  default_output_artifact?: string
  has_discussion_level: boolean
  has_review_level: boolean
  level_ids: string[]
  levels?: LevelEntry[]
  agents: AgentEntry[]
}

export interface WorkflowTemplateEntry {
  id: string
  description?: string
  template_path?: string
  tags?: string[]
  capabilities?: string[]
  mcp_requirements?: McpWorkflowCapabilityRequirement[]
  input_artifact?: string
  output?: string
  steps?: Array<{
    id: string
    type?: 'team' | 'agent' | 'transform' | 'human-in-the-loop'
    team?: string
    agent?: string
    stage_type?: WorkflowStageType
    result_artifact?: string
    requested_result_type?: string
    mcp_requirements?: McpWorkflowCapabilityRequirement[]
    handoff?: string
    prompt?: string
  }>
}

export interface WorkflowGeneratorRegistry {
  teams: TeamEntry[]
  workflow_templates?: WorkflowTemplateEntry[]
}

export interface GeneratorTurnHttpSuccess {
  cancelled?: false
  jobId?: string
  message: string
  draft: WorkflowDraft | null
  warnings: string[]
  yaml: string | null
  mermaid: string | null
  handoff?: WorkflowCreateHandoff
  meta: { model: string; fallback: boolean; reason?: string }
}

export interface GeneratorTurnCancelledResponse {
  jobId: string
  cancelled: true
}

export type GeneratorTurnHttpResponse =
  | GeneratorTurnHttpSuccess
  | GeneratorTurnCancelledResponse

/**
 * What a Stop request came to.
 *
 * `completed` where the turn had already committed its outcome when Stop
 * landed. The acknowledgement waits for the job to settle, so it can say which
 * of the two actually happened — a boundary admitting only `cancelled` and
 * `pending` would force every race to be reported as a cancellation, including
 * the ones the turn won.
 *
 * A union rather than two independent fields, so the halves cannot drift: the
 * flag and the status are one statement about one turn, and nothing may pair a
 * cancelled job with a completed status or the reverse.
 */
export type CancelGeneratorJobResponse =
  | { jobId: string; cancelled: true; status: 'cancelled' | 'pending' }
  | { jobId: string; cancelled: false; status: 'completed' }

export interface ValidateWorkflowYamlResponse {
  valid: boolean
  draft: WorkflowDraft
  warnings: string[]
  errors: string[]
  mermaid: string | null
}

export interface SaveWorkflowResponse {
  workflowId?: string
  yamlPath: string
  registryPath: string
  filename: string
  warnings: string[]
}
