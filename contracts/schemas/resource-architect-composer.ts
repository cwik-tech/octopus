import * as z from 'zod/v4'

/** The displayed pair and its origin, captured once for a complete turn chain. */
export const resourceArchitectComposerSelectionSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  origin: z.enum(['user-choice', 'default']),
}).readonly()

export type ResourceArchitectComposerSelection = z.infer<typeof resourceArchitectComposerSelectionSchema>
