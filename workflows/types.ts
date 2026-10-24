import type { TeamRuntimeOverrides } from '../core/types.js'
import type { AgentQuestionsState } from '../contracts/agent-questions.js'
import type {
  ApprovedModelChoiceAuthorization,
  ModelChoiceOffer,
} from '../contracts/model-choice.js'
import type { McpWorkflowCapabilityRequirement } from '../contracts/mcp.js'
import type { WorkflowStageType } from '../contracts/workflow-generator.js'
import type {
  DurableWorkflowStatus,
  DurableWorkflowStepStatus,
} from '../contracts/workflows.js'

export type {
  DurableWorkflowStatus,
  DurableWorkflowStepStatus,
} from '../contracts/workflows.js'

export type { WorkflowRegistryEntry } from '../contracts/workflows.js'

export interface WorkflowStepHandoff {
  from_step: string
  from_artifact: string
  to_artifact: string
}

export type WorkflowArtifactHandoff = WorkflowStepHandoff

/**
 * An additional immutable source artifact whose factual provenance must survive
 * an editorial handoff before a publication transform is allowed to run.
 */
export interface WorkflowProvenanceHandoff {
  from_step: string
  from_artifact: string
  evidence_graph_artifact?: string
  audit_artifact?: string
}

export type WorkflowTransformType =
  | 'generate_word'
  | 'markdown_to_docx'
  | 'generate_excel'

export interface WorkflowWordOptions {
  profile?: string
  table_of_contents?: boolean
  render_mermaid?: boolean
  mermaid_failure?: 'error' | 'keep-code'
}

export interface WorkflowExcelOptions {
  profile?: string
  /** When set, the step input artifact is JSON data poured into this template. */
  template?: string
}

export interface WorkflowStep {
  id: string
  type: 'team' | 'agent' | 'transform' | 'human-in-the-loop'
  /** Absent for a human-in-the-loop boundary. */
  team?: string
  agent?: string
  transform?: WorkflowTransformType
  word?: WorkflowWordOptions
  excel?: WorkflowExcelOptions
  stage_type?: WorkflowStageType
  input_artifact: string
  result_artifact: string
  result_artifacts?: string[]
  /** Bounded file patterns collected from the completed child assignment. */
  result_artifact_globs?: string[]
  /** Bounded file patterns collected when present without making the step fail when absent. */
  optional_result_artifact_globs?: string[]
  requested_result_type?: string
  brief_prefix?: string
  brief_suffix?: string
  include_initial_brief?: boolean
  mcp_requirements?: McpWorkflowCapabilityRequirement[]
  handoff?: WorkflowStepHandoff
  /** Additional immutable artifacts copied into a delegated team assignment. */
  context_handoffs?: WorkflowArtifactHandoff[]
  provenance_handoff?: WorkflowProvenanceHandoff
  runtime_overrides?: TeamRuntimeOverrides
  recovery_policy?: WorkflowStepRecoveryPolicy
  /** Optional human-facing instruction for a human-in-the-loop step. */
  prompt?: string
}

export interface WorkflowOutputArtifact {
  from_step?: string
  artifact: string
  media_type?: string
  label?: string
}

/** A bounded assignment-relative file pattern published as one artifact per match. */
export interface WorkflowOutputArtifactGlob {
  from_step?: string
  glob: string
  media_type?: string
  label?: string
}

export interface WorkflowTemplate {
  id: string
  description?: string
  matches?: string[]
  mcp_requirements?: McpWorkflowCapabilityRequirement[]
  input?: {
    artifact?: string
  }
  steps: WorkflowStep[]
  output: {
    from_step: string
    artifact: string
    secondary_artifacts?: WorkflowOutputArtifact[]
    primary_artifact_globs?: WorkflowOutputArtifactGlob[]
    secondary_artifact_globs?: WorkflowOutputArtifactGlob[]
  }
  on_blocked?: 'stop' | 'escalate_to_user'
  on_failed?: 'stop' | 'escalate_to_user'
}

export interface WorkflowExecutionArtifact {
  stepId: string
  relativePath: string
  artifactPath: string
  role: 'primary' | 'secondary'
  mediaType?: string
  label?: string
}

export interface WorkflowExecutionStepArtifact {
  relativePath: string
  artifactPath: string
}

export interface WorkflowExecutionStepResult {
  stepId: string
  team?: string
  status: 'completed' | 'completed_with_warnings' | 'blocked' | 'failed'
  artifactPath?: string
  artifacts?: WorkflowExecutionStepArtifact[]
  requestedResultType: string
  assignmentPath: string
  childSessionId: string
  summary: string
  cost: number
  costTracked?: boolean
}

export interface WorkflowExecutionResult {
  workflowId: string
  status: 'completed' | 'completed_with_warnings' | 'blocked' | 'failed'
  primaryArtifact?: string
  artifacts?: WorkflowExecutionArtifact[]
  requestedResultType?: string
  totalCost: number
  steps: WorkflowExecutionStepResult[]
  summary: string
  escalation?: {
    target: 'user'
    stepId: string
    reason: 'blocked' | 'failed'
  }
}

export type WorkflowRunOutcome =
  | {
      kind: 'awaiting_agent_input'
      interaction: import('../contracts/agent-questions.js').AgentQuestionInteraction
      workflowRevision: number
    }
  | {
      kind: 'terminal'
      result: WorkflowExecutionResult
    }
  | {
      kind: 'awaiting_input'
      interaction: HumanInputInteraction
      workflowRevision: number
    }
  /**
   * A step's explicit model failed in a way a user may authorize a retry for.
   *
   * Returned instead of a terminal failure so committed predecessor work stays
   * committed and only the affected step has to run again. Nothing here
   * consents on the user's behalf: the run waits.
   */
  | {
      kind: 'awaiting_model_choice'
      offer: ModelChoiceOffer
      stepId: string
      workflowRevision: number
    }


/** Controls what recovery may do with a step whose previous process died. */
export type WorkflowStepRecoveryPolicy =
  | 'safe_retry'
  | 'idempotent'
  | 'manual'
  | 'never_retry'

/** A content-addressed artifact owned by one exact child assignment. */
export interface WorkflowArtifactReference {
  childRunId: string
  relativePath: string
  sha256: string
  byteLength: number
}

export interface HumanInputRecipient {
  /** Canonical Agent identity. In v1 this is the Agent name. */
  id: string
  mentionToken: string
  displayName: string
}

export interface HumanInputMessage {
  id: string
  text: string
  recipients: 'all' | string[]
}

export type HumanInputSubmissionMode =
  | 'feedback'
  | 'continue_without_feedback'

export interface HumanInputSubmission {
  submissionId: string
  mode: HumanInputSubmissionMode
  messages: HumanInputMessage[]
  submittedAt: string
  canonicalHash: string
}

export interface HumanInputInteraction {
  interactionId: string
  taskId: string
  sessionId: string
  workflowId: string
  stepId: string
  ownerExecutionAttemptId: string
  sourceArtifact: WorkflowArtifactReference
  successorStepId: string
  eligibleRecipients: HumanInputRecipient[]
  prompt?: string
  requestedAt: string
  status: 'pending' | 'submitted' | 'consumed' | 'cancelled'
  submission?: HumanInputSubmission
  continuationAdmissionRequestId?: string
  feedbackArtifact?: WorkflowArtifactReference
}

export interface WorkflowPublishedArtifactReference {
  stepId: string
  role: 'primary' | 'secondary'
  artifact: WorkflowArtifactReference
  mediaType?: string
  label?: string
}

export type DurableWorkflowTerminalStatus = Exclude<
  DurableWorkflowStatus,
  'running' | 'awaiting_input' | 'interrupted'
>

/**
 * Self-contained terminal publication contract. It is committed in the same
 * revision as the terminal workflow status so a replacement process can
 * reconstruct the exact root result without rerunning a child.
 */
export interface DurableWorkflowTerminalOutcome {
  status: DurableWorkflowTerminalStatus
  summary: string
  requestedResultType: string
  outputStepId: string
  primaryArtifact?: WorkflowArtifactReference
  artifacts?: WorkflowPublishedArtifactReference[]
  rootWrapperBody: string
  rootWrapperSha256: string
}

/** Immutable compatibility boundary for a logical workflow execution. */
export interface WorkflowExecutionManifest {
  schemaVersion: 1
  taskId: string
  sessionId: string
  rootRunId: string
  workflowId: string
  workflowDefinitionHash: string
  briefHash: string
  teamDefinitionHashes: Record<string, string>
  runtimeVersion: string
  createdAt: string
}

export interface DurableWorkflowStepState {
  stepId: string
  stepIndex: number
  stepType: WorkflowStep['type']
  team?: string
  definitionHash: string
  status: DurableWorkflowStepStatus
  recoveryPolicy: WorkflowStepRecoveryPolicy
  childRunId: string
  inputArtifact: string
  resultArtifact: string
  resultArtifacts?: string[]
  resultArtifactGlobs?: string[]
  requestedResultType: string
  attemptCount: number
  costUsd: number
  costTracked?: boolean
  idempotencyKey?: string
  artifact?: WorkflowArtifactReference
  artifacts?: WorkflowArtifactReference[]
  summary?: string
  error?: string
  startedAt?: string
  completedAt?: string
  /** Present only for a human-in-the-loop step after the request is persisted. */
  humanInput?: HumanInputInteraction
  modelChoice?: ModelChoiceOffer
  approvedModelChoice?: ApprovedModelChoiceAuthorization
  /**
   * The admission that authorized the continuation of an approved model choice.
   *
   * Recorded for the same reason a human-input continuation records one: a
   * retransmitted admission must be answered from the attempt it already
   * started rather than starting a second one.
   */
  modelChoiceContinuationAdmissionRequestId?: string
}

/** Revisioned source of truth used to resume one logical workflow run. */
export interface DurableWorkflowState {
  agentQuestions?: AgentQuestionsState
  schemaVersion: 2
  revision: number
  taskId: string
  sessionId: string
  rootRunId: string
  workflowId: string
  ownerExecutionAttemptId: string
  status: DurableWorkflowStatus
  terminalOutcome?: DurableWorkflowTerminalOutcome
  currentStepId?: string
  totalCostUsd: number
  recoveryCount: number
  createdAt: string
  updatedAt: string
  steps: DurableWorkflowStepState[]
}

export interface WorkflowStepStateSeed {
  stepId: string
  stepIndex: number
  stepType: WorkflowStep['type']
  team?: string
  definitionHash: string
  recoveryPolicy: WorkflowStepRecoveryPolicy
  childRunId?: string
  inputArtifact: string
  resultArtifact: string
  resultArtifacts?: string[]
  resultArtifactGlobs?: string[]
  requestedResultType: string
  idempotencyKey?: string
}

export interface WorkflowCompletionReceipt {
  schemaVersion: 1
  taskId: string
  rootRunId: string
  workflowId: string
  stepId: string
  childRunId: string
  executionAttemptId: string
  status: 'completed' | 'completed_with_warnings' | 'blocked' | 'failed'
  requestedResultType?: string
  artifact?: WorkflowArtifactReference
  artifacts?: WorkflowArtifactReference[]
  summary: string
  costUsd: number
  costTracked?: boolean
  completedAt: string
}
