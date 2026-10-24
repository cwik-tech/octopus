/**
 * File Parser Toolkit — Shared Types
 */

/**
 * The OCR page and summary contract, owned by `ocr/contract.ts` and re-exported here so the
 * package has one spelling of it. Re-exported rather than restated: a second hand-written copy
 * is a second thing to keep true.
 */
export type {
  PdfPageReadResult,
  PdfPageReadStatus,
  PdfPageTextSource,
  OcrReadStatus as PdfOcrStatus,
  PdfOcrSummary,
} from './ocr/contract.js'

import type { PdfOcrSummary } from './ocr/contract.js'

/**
 * Supported parser types.
 *
 * `unsupported` is not a parser: it is the routing outcome for a format nothing here can read, so
 * that detection refuses it by name instead of handing it to a reader that will throw.
 */
export type ParserType = 'pdf' | 'docx' | 'xlsx' | 'image' | 'pptx' | 'generic' | 'unsupported'

/**
 * Why a file was refused before any parser ran.
 *
 * - `legacy_binary_office`: an OLE compound file from 1997 that no reader here opens.
 * - `unreadable_image_codec`: an image format this build of sharp has no loader for.
 */
export type UnsupportedReason = 'legacy_binary_office' | 'unreadable_image_codec'

/**
 * A refusal a person can act on, recorded alongside the `error` message a caller displays.
 *
 * Manifest-level, and only that. `FileSourceRepository` builds every record the desktop app sees
 * and maps `error` alone, so this field stops at `_manifest.json`; it is read by this package's
 * own orchestrator and tests, and by anyone diagnosing a parse from the manifest on disk. The
 * refusal a person needs — the format and the remedy — travels in `error`, which does cross.
 * Do not write app code that branches on this field without carrying it across first.
 */
export interface UnsupportedFormat {
  reason: UnsupportedReason
  /** The refused extension, lowercase and dotted, e.g. `.doc` */
  extension: string
  /** The format's name as a person knows it, e.g. `Word 97-2003 (.doc)` */
  format: string
  /** What to do about it, e.g. `save it as .docx and upload it again` */
  remedy: string
}

/** PDF text density classification */
export type PdfClassification = 'scanned' | 'visual' | 'text-heavy'
export type ParseQuality = 'low' | 'medium' | 'high'
export type LmEnrichmentScope = 'none' | 'flagged_pages' | 'full_document'

/** Parse status for a single file */
export type ParseStatus = 'success' | 'error' | 'skipped'

/** Result returned by each parser */
export interface ParseResult {
  source: string
  type: ParserType
  sizeBytes: number
  outputs: Record<string, string>
  metadata: Record<string, unknown>
  status: ParseStatus
  error?: string
  /**
   * Set when the format itself is refused, rather than a parse having failed.
   * Written to the manifest; not carried into the app. See `UnsupportedFormat`.
   */
  unsupported?: UnsupportedFormat
  /** PDF-specific classification */
  classification?: PdfClassification
  /** Average chars per page (PDF only) */
  charsPerPage?: number
  /** Overall parser confidence bucket */
  parseQuality?: ParseQuality
  /** Overall parser confidence score from 0-1 */
  qualityScore?: number
  /** Flag for files that need LLM analysis */
  requiresLlm?: boolean
  /** Whether the structural extractor flagged OCR before recognition ran */
  needsOcr?: boolean
  /** What local OCR did, when this parser ran it */
  ocr?: PdfOcrSummary
  /** Optional LM enrichment scope */
  lmScope?: LmEnrichmentScope
  /** 1-based page numbers worth escalating */
  flaggedPages?: number[]
  /** Whether LM enrichment actually ran */
  enrichmentApplied?: boolean
  /** Provider used for enrichment when applied */
  enrichmentProvider?: string
  /** Human-readable note */
  note?: string
}

/** Manifest written to _manifest.json */
export interface Manifest {
  generated_at: string
  parser_version: string
  input_dir: string
  files: ParseResult[]
}

/** Info about a file to be parsed */
export interface FileInfo {
  /** Filename (not full path) */
  name: string
  /** Full absolute path */
  path: string
  /** File size in bytes */
  sizeBytes: number
  /** Detected parser type */
  type: ParserType
}

/** Options for the orchestrator */
export interface ParseOptions {
  /** Input directory containing files to parse */
  inputDir: string
  /** Force re-parse even if output exists */
  force: boolean
}
