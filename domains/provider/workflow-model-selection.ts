import {
  workflowModelSelectionSchema,
  type WorkflowModelSelection,
} from '../../contracts/workflow-model-selection.js'

export const WORKFLOW_MODEL_SELECTION_ENV = 'PIPELINE_WORKFLOW_MODEL_SELECTION'

/** Explicitly clear an inherited choice when the next task has none. */
export function workflowModelEnvironment(
  selection: WorkflowModelSelection | undefined,
): Record<string, string> {
  return {
    [WORKFLOW_MODEL_SELECTION_ENV]: selection
      ? Buffer.from(JSON.stringify(workflowModelSelectionSchema.parse(selection)), 'utf8').toString('base64')
      : '',
  }
}

/** Invalid task transport must never silently restore a saved provider. */
export function readWorkflowModelSelection(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowModelSelection | undefined {
  const encoded = environment[WORKFLOW_MODEL_SELECTION_ENV]
  if (!encoded) return undefined
  let parsed: unknown
  try {
    if (encoded.length > 8192) throw new Error('Oversized model transport')
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch (cause) {
    throw new Error('Invalid workflow model selection', { cause })
  }
  const result = workflowModelSelectionSchema.safeParse(parsed)
  if (!result.success) throw new Error('Invalid workflow model selection', { cause: result.error })
  return result.data
}
