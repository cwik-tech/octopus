import { z } from 'zod'
import { canvasTabSchema, CANVAS_MAX_PREVIEW_BYTES } from './canvas-workspace.js'

export const CANVAS_DOCUMENT_MAX_BYTES = CANVAS_MAX_PREVIEW_BYTES
export const CANVAS_DOCUMENT_REQUEST_BYTES = CANVAS_DOCUMENT_MAX_BYTES * 3
export const CANVAS_PROPOSAL_TIMEOUT_MS = 120_000
export const CANVAS_MAX_PROPOSAL_HISTORY = 64
export const CANVAS_DOCUMENT_STORE_MAX_BYTES = CANVAS_DOCUMENT_MAX_BYTES * 8
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const content = z.string().max(CANVAS_DOCUMENT_MAX_BYTES)
const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const canvasProposalSchema = z.strictObject({
  id: identifier,
  status: z.enum(['generating', 'ready', 'conflicted', 'discarded', 'applied', 'failed', 'superseded']),
  baseRevision: revision,
  baseContent: content,
  snapshotDigest: digest,
  generation: revision,
  selectionStart: revision,
  selectionEnd: revision,
  selectedText: content,
  instruction: z.string().min(1).max(8000),
  replacementText: content.nullable(),
  appliedRevision: revision.nullable(),
})
export type CanvasProposal = z.infer<typeof canvasProposalSchema>
export const canvasDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: digest,
  sessionId: z.string().min(1).max(200),
  origin: canvasTabSchema,
  snapshotDigest: digest,
  revision,
  content,
  proposal: canvasProposalSchema.nullable(),
})
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>
export const canvasDocumentAggregateSchema = z.strictObject({
  document: canvasDocumentSchema,
  proposalHistory: z.array(z.strictObject({ id: identifier, status: z.enum(['applied', 'discarded', 'superseded']), appliedRevision: revision.nullable() })).max(CANVAS_MAX_PROPOSAL_HISTORY),
})
export type CanvasDocumentAggregate = z.infer<typeof canvasDocumentAggregateSchema>
export const canvasDocumentActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), target: canvasTabSchema }),
  z.strictObject({ kind: z.literal('save'), target: canvasTabSchema, expectedRevision: revision, content }),
  z.strictObject({ kind: z.literal('propose'), target: canvasTabSchema, expectedRevision: revision, selectionStart: revision, selectionEnd: revision, selectedText: content, instruction: z.string().trim().min(1).max(8000) }),
  z.strictObject({ kind: z.literal('accept'), target: canvasTabSchema, proposalId: identifier, hasUnsavedDraft: z.boolean() }),
  z.strictObject({ kind: z.literal('discard'), target: canvasTabSchema, proposalId: identifier }),
])
export type CanvasDocumentAction = z.infer<typeof canvasDocumentActionSchema>
export const canvasProposalCompletionSchema = z.strictObject({ proposalId: identifier, baseRevision: revision, generation: revision, replacementText: content })
export type CanvasProposalCompletion = z.infer<typeof canvasProposalCompletionSchema>
export const canvasDocumentErrorSchema = z.strictObject({ code: z.string(), error: z.string() })
