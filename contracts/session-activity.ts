import { z } from 'zod/v4'

export const sessionActivityClaimSchema = z.object({
  kind: z.enum(['dialogue', 'chat', 'task']),
  claimId: z.string().min(1),
  ownerLaunchId: z.string().min(1),
  processId: z.number().int().positive(),
}).strict()

export const sessionActivityClaimInputSchema = sessionActivityClaimSchema.omit({ processId: true })
export const sessionActivityClaimsSchema = z.array(sessionActivityClaimSchema)
export type SessionActivityClaim = z.infer<typeof sessionActivityClaimSchema>
export type SessionActivityClaimInput = z.infer<typeof sessionActivityClaimInputSchema>
export type SessionActivityClaimResult = 'claimed' | 'not_found' | 'dialogue_active' | 'chat_active' | 'tasks_active'
