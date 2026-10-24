import { z } from 'zod'

export const broadcastSettledSlotSchema = z.object({
  slot: z.number().int().nonnegative(), agent: z.string().min(1), text: z.string(),
  cost: z.number().finite().nonnegative(), halted: z.boolean(), succeeded: z.boolean(),
}).strict()
export const broadcastSettledSlotsSchema = z.array(broadcastSettledSlotSchema).refine((slots) =>
  new Set(slots.map((entry) => entry.slot)).size === slots.length,
)
export type BroadcastSettledSlot = z.infer<typeof broadcastSettledSlotSchema>

export const pipelineQuestionTaskIdsSchema = z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length)
export type PipelineQuestionTaskIds = z.infer<typeof pipelineQuestionTaskIdsSchema>
