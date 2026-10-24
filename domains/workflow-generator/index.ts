/**
 * Public surface for the workflow-generator feature.
 *
 * Backend-only. The Create tab UI calls into these via the /create/*
 * endpoints registered in server/api-server.ts.
 */

export { loadRegistry } from './registry.js'
export { runGeneratorTurn } from './generator-llm.js'
export { buildWorkflowYaml } from './yaml-builder.js'
export { parseWorkflowYaml } from './yaml-parser.js'
export { buildWorkflowMermaid, emptyDiagram } from './mermaid-builder.js'
export { validateDraft } from './validators.js'
export {
  saveWorkflow,
  saveWorkflowYaml,
  updateExistingWorkflowYaml,
} from './save-workflow.js'
export { deleteWorkflow, WorkflowDeleteNotFoundError } from './delete-workflow.js'
export type {
  WorkflowDraft,
  StepDraft,
  ChatTurn,
  GeneratorTurnResponse,
  WorkflowGeneratorRegistry,
  TeamEntry,
  AgentEntry,
} from './workflow-draft.js'
export type { DraftValidationResult } from './validators.js'
export type {
  SaveWorkflowResult,
  UpdateExistingWorkflowYamlResult,
} from './save-workflow.js'
export type { DeleteWorkflowResult } from './delete-workflow.js'
export type { RunGeneratorTurnResult } from './generator-llm.js'
