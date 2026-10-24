import type { ChatTurn } from '@contracts/workflow-generator'

export type ChatRole = ChatTurn['role']
export type { McpWorkflowCapabilityRequirement } from '@contracts/mcp'

export type {
  AgentEntry,
  CancelGeneratorJobResponse,
  ChatTurn,
  DiscussionOverride,
  GeneratorTurnCancelledResponse,
  GeneratorTurnHttpSuccess as GeneratorTurnResponse,
  HandoffSpec,
  LevelEntry,
  LevelOverride,
  ReviewOverride,
  RuntimeOverrides,
  SaveWorkflowResponse,
  StepDraft,
  TeamEntry,
  ValidateWorkflowYamlResponse,
  WorkflowCreateHandoff,
  WorkflowDraft,
  WorkflowGeneratorRegistry,
  WorkflowStageType,
  WorkflowTemplateEntry,
} from '@contracts/workflow-generator'
