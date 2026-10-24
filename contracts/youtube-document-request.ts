import { z } from 'zod/v4'

export const youtubeDocumentRequestSchema = z.object({
  formats: z.array(z.enum(['markdown', 'docx'])).min(1).max(2)
    .refine((formats) => new Set(formats).size === formats.length, 'Output formats must be unique.'),
  purpose: z.enum(['instructions', 'takeaways']),
  instructions: z.string().trim().min(1).max(8_000),
}).strict()

export type YoutubeDocumentRequest = z.infer<typeof youtubeDocumentRequestSchema>
