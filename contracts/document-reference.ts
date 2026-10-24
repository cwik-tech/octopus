import * as z from 'zod/v4'
import { modelImageSchema } from './model-image.js'

export const documentIdSchema = z.string().regex(/^doc_[a-f0-9]{64}$/)
export const documentPageSchema = z.object({ page: z.number().int().positive(), markdown: z.string(), status: z.enum(['read', 'empty', 'unresolved']) })
export const documentPagesSchema = z.array(documentPageSchema).refine((pages) => pages.every((page, index) => page.page === index + 1), 'Page evidence must be contiguous and one-based')
export const pdfPageIndexSchema = z.object({ page_count: z.number().int().nonnegative(), pages: documentPagesSchema }).refine((value) => value.pages.length === value.page_count, 'Page evidence must cover every expected page')
export const documentSourceSchema = z.strictObject({
  id: documentIdSchema,
  name: z.string().min(1).max(512),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().nullable(),
  image: modelImageSchema.optional(),
  pages: documentPagesSchema.optional(),
  uploadedAt: z.string().max(64).optional(),
})
export type DocumentSource = z.infer<typeof documentSourceSchema>
export const documentReviewCoverageSchema = z.object({
  document: documentIdSchema, name: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['complete', 'partial', 'unavailable']), pageCoverage: z.enum(['known', 'unknown']),
  reviewedPages: z.array(z.number().int().positive()), unresolvedPages: z.array(z.number().int().positive()),
  reviewedCharacters: z.number().int().nonnegative(), totalCharacters: z.number().int().nonnegative(),
  uploadedAt: z.string().max(64).optional(),
}).refine((record) => {
  if (record.reviewedCharacters > record.totalCharacters) return false
  if (new Set(record.reviewedPages).size !== record.reviewedPages.length || new Set(record.unresolvedPages).size !== record.unresolvedPages.length) return false
  const pages = [...new Set([...record.reviewedPages, ...record.unresolvedPages])].sort((left, right) => left - right)
  if (record.pageCoverage === 'unknown' && pages.length > 0) return false
  if (record.pageCoverage === 'known' && !pages.every((page, index) => page === index + 1)) return false
  return record.state !== 'complete' || (record.unresolvedPages.length === 0 && record.reviewedCharacters === record.totalCharacters && (record.pageCoverage === 'unknown' || pages.length > 0))
}, 'Review coverage contradicts its completion state')
export type DocumentReviewCoverage = z.infer<typeof documentReviewCoverageSchema>
