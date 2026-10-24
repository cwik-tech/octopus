import { z } from 'zod/v4'

/** The chat's concrete model, sealed into one workflow task. */
export const workflowModelSelectionSchema = z.object({
  provider: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(500),
}).strict()

export type WorkflowModelSelection = z.infer<typeof workflowModelSelectionSchema>
