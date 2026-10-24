export interface WorkflowSummary {
  id: string
  description?: string
  tags?: string[]
  capabilities?: string[]
}

export type WorkflowSummaryWithTags = WorkflowSummary

export interface WorkflowDiscussionStageInfo {
  levelId: string
  participants?: string[]
  minRounds?: number
  maxRounds?: number
}

export interface WorkflowStageInfo {
  id: string
  team?: string
  inputArtifact?: string
  resultArtifact?: string
  discussions?: WorkflowDiscussionStageInfo[]
}

export interface WorkflowRegistryEntry {
  name: string
  description?: string
  template_path: string
  tags?: string[]
  capabilities?: string[]
}

/**
 * Durable workflow state is separate from the public workflow result. These
 * statuses describe what a replacement process or read model may continue.
 */
export type DurableWorkflowStatus =
  | 'running'
  | 'awaiting_input'
  | 'awaiting_model_choice'
  | 'interrupted'
  | 'completed'
  | 'completed_with_warnings'
  | 'blocked'
  | 'failed'
  | 'cancelled'

export type DurableWorkflowStepStatus =
  | 'pending'
  | 'awaiting_input'
  | 'awaiting_model_choice'
  | 'launching'
  | 'running'
  | 'interrupted'
  | 'indeterminate'
  | 'completed'
  | 'completed_with_warnings'
  | 'blocked'
  | 'failed'
  | 'cancelled'
