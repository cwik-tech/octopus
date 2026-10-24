import { z } from 'zod'

export const reviewQuestionPhaseSchema = z.enum(['producer', 'reviewer'])
export type ReviewQuestionPhase = z.infer<typeof reviewQuestionPhaseSchema>
