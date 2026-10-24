import { z } from 'zod'
import { CANVAS_MAX_PREVIEW_BYTES, canvasTabSchema } from './canvas-workspace.js'

export const OFFICE_VERSION = '1.0.157'
export const OFFICE_PROFILE = 'static-offline-1'
export const OFFICE_TOOLS_DIRECTORY = 'office-tools'
export const OFFICE_MANIFEST_FILE = 'manifest.json'
export const OFFICE_INPUT_MAX_BYTES = 10 * 1024 * 1024
export const OFFICE_EXPANDED_MAX_BYTES = 64 * 1024 * 1024
export const OFFICE_ARCHIVE_MAX_ENTRIES = 4096
export const OFFICE_ARCHIVE_MAX_RATIO = 100
export const OFFICE_HTML_MAX_BYTES = CANVAS_MAX_PREVIEW_BYTES
export const OFFICE_STDERR_MAX_BYTES = 64 * 1024
export const OFFICE_JOB_TIMEOUT_MS = 15_000
export const OFFICE_KILL_GRACE_MS = 1000
export const OFFICE_QUEUE_TIMEOUT_MS = 2000
export const OFFICE_ACTIVE_JOBS = 2
export const OFFICE_QUEUED_JOBS = 8
export const OFFICE_CACHE_MAX_BYTES = 32 * 1024 * 1024
export const OFFICE_MAX_INSTRUCTION_CHARS = 8000
export const OFFICE_MAX_OPERATIONS = 64
export const OFFICE_FORMATS = ['docx', 'xlsx', 'pptx'] as const
export const officeFormatSchema = z.enum(OFFICE_FORMATS)
export type OfficeFormat = z.infer<typeof officeFormatSchema>
export const OFFICE_ERROR_CODES = ['unsafe_package', 'origin_unavailable', 'origin_unverifiable', 'document_not_found', 'invalid_saved_document', 'revision_conflict', 'proposal_busy', 'request_expired', 'request_conflict', 'storage_limit', 'foreign_origin', 'capability_unavailable', 'cancelled', 'timeout', 'output_limit', 'process_failed', 'cleanup_pending', 'queue_full', 'invalid_output'] as const
export const officeFailureSchema = z.strictObject({ ok: z.literal(false), code: z.enum(OFFICE_ERROR_CODES) })
export type OfficeFailure = z.infer<typeof officeFailureSchema>
export const officePreviewSchema = z.strictObject({
  html: z.string().max(OFFICE_HTML_MAX_BYTES), digest: z.string().regex(/^[a-f0-9]{64}$/),
  profile: z.literal(OFFICE_PROFILE), notices: z.array(z.string().max(500)).max(16),
})
export type OfficePreview = z.infer<typeof officePreviewSchema>
export const officeBinaryManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), version: z.literal(OFFICE_VERSION), platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['arm64', 'x64']), file: z.enum(['officecli', 'officecli.exe']),
  upstreamSha256: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const OFFICE_PACKAGE_PARTS = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' } as const
export const OFFICE_CONTENT_TYPES_PART = '[Content_Types].xml'
export const OFFICE_PACKAGE_TYPES = { docx: 'wordprocessingml.document.main+xml', xlsx: 'spreadsheetml.sheet.main+xml', pptx: 'presentationml.presentation.main+xml' } as const
export const OFFICE_ZIP = { end: 0x06054b50, central: 0x02014b50, local: 0x04034b50, endBytes: 22, commentMax: 65535, centralBytes: 46, localBytes: 30, zip64Count: 65535, zip64Size: 0xffffffff } as const
export const OFFICE_DOCUMENT_DIRECTORY = 'canvas-office-documents'
export const OFFICE_BLOB_DIRECTORY = 'blobs'
export const OFFICE_METADATA_MAX_BYTES = 128 * 1024
export const OFFICE_BLOB_QUOTA_BYTES = 64 * 1024 * 1024
export const OFFICE_MAX_REVISIONS = 128
export const officeDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const officeMarkdownSourceSchema = z.strictObject({ target: canvasTabSchema, revision: z.number().int().nonnegative(), digest: officeDigestSchema, assets: z.array(z.strictObject({ path: z.string().max(1024), digest: officeDigestSchema })).max(128), profile: z.literal('business-report'), mermaid: z.literal('keep-code'), notices: z.array(z.string().max(500)).max(128), forked: z.boolean() })
export const officeRevisionSchema = z.strictObject({ revision: z.number().int().nonnegative(), digest: officeDigestSchema, source: officeMarkdownSourceSchema.optional() })
export const OFFICE_RECEIPT_LIMIT = 32
export const officeProposalRequestSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(), instruction: z.string().trim().min(1).max(OFFICE_MAX_INSTRUCTION_CHARS),
  requestSequence: z.number().int().positive(), requestId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
})
export const officeProposalInputSchema = officeProposalRequestSchema.extend({ fingerprint: officeDigestSchema })
export type OfficeProposalRequest = z.infer<typeof officeProposalRequestSchema>
export type OfficeProposalInput = z.infer<typeof officeProposalInputSchema>
export const officeProposalSchema = officeProposalInputSchema.extend({
  id: z.string().min(1).max(200), generation: z.number().int().positive(), baseDigest: officeDigestSchema,
  status: z.enum(['generating', 'ready', 'failed', 'interrupted']),
  candidateDigest: officeDigestSchema.nullable(), summary: z.string().max(8000),
})
export const officeProposalReceiptSchema = z.strictObject({
  proposalId: z.string().min(1).max(200), requestId: z.string().min(1).max(200), requestSequence: z.number().int().positive(),
  fingerprint: officeDigestSchema, outcome: z.enum(['accepted', 'discarded', 'failed', 'interrupted']), revision: z.number().int().nonnegative(),
})
export const officeProposalCompletionSchema = z.strictObject({
  proposalId: z.string().min(1).max(200), generation: z.number().int().positive(), baseRevision: z.number().int().nonnegative(),
  baseDigest: officeDigestSchema, candidateDigest: officeDigestSchema, summary: z.string().max(8000),
})
export type OfficeProposalCompletion = z.infer<typeof officeProposalCompletionSchema>
export const officeProposalDispositionSchema = z.strictObject({ proposalId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(), kind: z.enum(['accept', 'discard']) })
export type OfficeProposalDisposition = z.infer<typeof officeProposalDispositionSchema>
export const officeDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1), id: officeDigestSchema, sessionId: z.string().uuid(), origin: canvasTabSchema,
  originalDigest: officeDigestSchema, format: officeFormatSchema, revision: z.number().int().nonnegative(),
  revisions: z.array(officeRevisionSchema).min(1).max(OFFICE_MAX_REVISIONS),
  highestRequestSequence: z.number().int().nonnegative().default(0), proposal: officeProposalSchema.nullable().default(null),
  receipts: z.array(officeProposalReceiptSchema).max(OFFICE_RECEIPT_LIMIT).default([]),
  source: officeMarkdownSourceSchema.optional(),
})
export type OfficeDocument = z.infer<typeof officeDocumentSchema>
export type OfficeDocumentResult = { readonly ok: true; readonly document: OfficeDocument } | OfficeFailure
export const officeCreateRequestSchema = z.strictObject({ target: canvasTabSchema })
export const officeWordSnapshotRequestSchema = officeCreateRequestSchema.extend({ expectedRevision: z.number().int().nonnegative() })
export const wordSnapshotSchema = z.strictObject({ document: officeDocumentSchema, stale: z.boolean() })
export const officePreviewRequestSchema = z.union([
  officeCreateRequestSchema,
  z.strictObject({ documentId: officeDigestSchema, revision: z.union([z.number().int().nonnegative(), z.literal('original')]) }),
  z.strictObject({ documentId: officeDigestSchema, proposalId: z.string().min(1).max(200) }),
])
export type OfficePreviewRequest = z.infer<typeof officePreviewRequestSchema>
export const OFFICE_MAX_TARGETS = 512
export const OFFICE_TARGET_CONTEXT_CHARS = 32 * 1024
export const officeReplacementSchema = z.string().max(OFFICE_MAX_INSTRUCTION_CHARS).refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFE\uFFFF\uD800-\uDFFF]/u.test(value))
export const officeOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), target: z.string().regex(/^target-\d+$/), text: officeReplacementSchema }),
  z.strictObject({ kind: z.literal('cell'), target: z.string().regex(/^target-\d+$/), value: z.union([officeReplacementSchema, z.number().finite(), z.boolean(), z.null()]) }),
])
export const officeOperationsSchema = z.array(officeOperationSchema).min(1).max(OFFICE_MAX_OPERATIONS)
export type OfficeOperation = z.infer<typeof officeOperationSchema>
export const officeTargetSchema = z.strictObject({ id: z.string().regex(/^target-\d+$/), path: z.string().min(1).max(1024), text: z.string().max(OFFICE_MAX_INSTRUCTION_CHARS), kind: z.enum(['text', 'cell']) })
export type OfficeTarget = z.infer<typeof officeTargetSchema>
