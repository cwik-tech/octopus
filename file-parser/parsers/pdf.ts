/**
 * PDF Parser
 *
 * Extracts page-aware text with pdf-parse, cleans and scores the extraction,
 * writes both raw and structured markdown artifacts, and conditionally renders
 * page images for visual recovery.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import pdfParse from 'pdf-parse'
import { pdf } from 'pdf-to-img'
import sharp from 'sharp'
import { createLmEnricherFromEnv } from '../lm/index.js'
import type { EnrichmentRequest, EnrichmentResult } from '../lm/types.js'
import {
  extractPdfWithInspector,
  type PdfInspectorExtraction,
} from './pdf-inspector.js'
import type {
  LmEnrichmentScope,
  ParseQuality,
  ParseResult,
  PdfClassification,
  PdfOcrSummary,
} from '../types.js'
import {
  OCR_CONTRACT_VERSION,
  ocrContractIdentity,
  type PdfPageReadResult,
} from '../ocr/contract.js'
import {
  readPdfPagesWithOcr,
  type OcrReadResult,
  type ReadPagesDependencies,
} from '../ocr/read-pages.js'
import { wrapDocument } from '../utils/markdown.js'

const SCANNED_THRESHOLD = 100
const VISUAL_THRESHOLD = 500
const FULL_DOCUMENT_LM_PAGE_THRESHOLD = 0.4
const DEFAULT_MAX_RENDERED_PAGES = 3

interface PdfPageDiagnostics {
  page: number
  title: string
  chars: number
  words: number
  lines: number
  bullets: number
  heading_candidates: number
  fragmentation_ratio: number
  symbol_ratio: number
  uppercase_ratio: number
  quality_score: number
  parse_quality: ParseQuality
  likely_visual: boolean
  likely_table: boolean
  likely_columns?: boolean
  needs_ocr?: boolean
  ocr_reasons?: string[]
  notes: string[]
}

interface PdfDocumentAnalysis {
  pages: string[]
  cleanedPages: string[]
  diagnostics: PdfPageDiagnostics[]
  repeatedLines: string[]
  rawText: string
  structuredText: string
  qualityScore: number
  parseQuality: ParseQuality
  flaggedPages: number[]
  needsOcr: boolean
  requiresLlm: boolean
  lmScope: LmEnrichmentScope
  documentKind: 'report' | 'slide-deck' | 'mixed'
  pagesNeedingOcr: number[]
  pagesWithTables: number[]
  pagesWithColumns: number[]
  columnLayoutDetection: 'native' | 'unavailable'
  isComplexLayout: boolean
  detectedPdfType?: string
  detectionConfidence?: number
  hasEncodingIssues?: boolean
}

interface PdfMetadataInfo {
  Title?: string
  Author?: string
}

interface PdfTextItem {
  str: string
  transform: number[]
}

interface PdfPageData {
  getTextContent(options: {
    normalizeWhitespace: boolean
    disableCombineTextItems: boolean
  }): Promise<{ items: PdfTextItem[] }>
}

type PdfRenderDocument = Awaited<ReturnType<typeof pdf>>
type OpenPdfDocument = (
  input: string,
  options?: Parameters<typeof pdf>[1],
) => Promise<PdfRenderDocument>

export interface PdfParserDependencies {
  inspectPdf?: typeof extractPdfWithInspector
  openPdf?: OpenPdfDocument
  maxRenderedPages?: number
  /** Seams for the local OCR module, so a focused test can drive it without a real engine. */
  ocr?: ReadPagesDependencies
  /** Turns local OCR off, for callers proving the deterministic no-OCR artifact is unchanged. */
  disableLocalOcr?: boolean
  signal?: AbortSignal
}

interface AppliedEnrichment {
  markdown: string
  json: Record<string, unknown>
  result: EnrichmentResult
}

function classify(charsPerPage: number): PdfClassification {
  if (charsPerPage < SCANNED_THRESHOLD) return 'scanned'
  if (charsPerPage < VISUAL_THRESHOLD) return 'visual'
  return 'text-heavy'
}

function getMaxRenderedPages(): number {
  const raw = process.env["FILE_PARSER_MAX_RENDERED_PAGES"]
  if (!raw) return DEFAULT_MAX_RENDERED_PAGES

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RENDERED_PAGES
}

async function renderPages(
  filePath: string,
  pagesDir: string,
  priorityPages: number[] = [],
  maxPages = getMaxRenderedPages(),
  openPdf: OpenPdfDocument = pdf,
): Promise<number[]> {
  fs.mkdirSync(pagesDir, { recursive: true })

  const doc = await openPdf(filePath, { scale: 2.0 })
  const validPriorityPages = [...new Set(priorityPages)]
    .filter((page) => Number.isInteger(page) && page > 0 && page <= doc.length)
  const requestedPages = (validPriorityPages.length > 0
    ? validPriorityPages
    : Array.from({ length: Math.min(doc.length, maxPages) }, (_, index) => index + 1))
    .slice(0, maxPages)

  for (const pageNum of requestedPages) {
    const pageBuffer = await doc.getPage(pageNum)
    const num = String(pageNum).padStart(3, '0')
    const outputPath = path.join(pagesDir, `page-${num}.jpg`)

    await sharp(pageBuffer)
      .jpeg({ quality: 85 })
      .toFile(outputPath)
  }

  return requestedPages
}

function normalizeTextLine(line: string): string {
  return line
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function isBulletLine(line: string): boolean {
  return /^([•●◦▪■-]|\d+[.)])\s+/.test(line)
}

function isLikelyHeading(line: string): boolean {
  if (line.length === 0 || line.length > 80) return false
  if (isBulletLine(line)) return false
  if (/[:.;]$/.test(line)) return false

  const letters = [...line].filter((char) => /[A-Za-z]/.test(char))
  if (letters.length === 0) return false
  const uppercaseLetters = letters.filter((char) => char === char.toUpperCase()).length
  const uppercaseRatio = uppercaseLetters / letters.length

  return uppercaseRatio >= 0.6 || /^[A-Z][A-Za-z0-9/&(),+ -]+$/.test(line)
}

function shouldJoinLines(previous: string, current: string): boolean {
  if (!previous || !current) return false
  if (isBulletLine(previous) || isBulletLine(current)) return false
  if (isLikelyHeading(previous) || isLikelyHeading(current)) return false
  if (/[.!?:]$/.test(previous)) return false
  if (/^[A-Z0-9]/.test(current)) return false
  return true
}

function stripRepeatedLines(pages: string[]): { pages: string[]; repeatedLines: string[] } {
  const repeated = new Map<string, Set<number>>()

  pages.forEach((page, pageIndex) => {
    const seenOnPage = new Set<string>()
    for (const line of page.split('\n').map(normalizeTextLine)) {
      if (!line || line.length > 90) continue
      if (seenOnPage.has(line)) continue
      seenOnPage.add(line)
      const pagesSet = repeated.get(line) ?? new Set<number>()
      pagesSet.add(pageIndex)
      repeated.set(line, pagesSet)
    }
  })

  const repeatedLines = [...repeated.entries()]
    .filter(([, pageIndexes]) => pageIndexes.size >= 2)
    .map(([line]) => line)
    .filter((line) => line.length > 0)

  if (repeatedLines.length === 0) {
    return { pages, repeatedLines: [] }
  }

  const filteredPages = pages.map((page) => {
    const lines = page.split('\n').map(normalizeTextLine)
    const filtered = lines.filter((line) => !repeatedLines.includes(line))
    return filtered.join('\n')
  })

  return { pages: filteredPages, repeatedLines }
}

function cleanPageText(pageText: string): string {
  const normalizedLines = pageText
    .split('\n')
    .map(normalizeTextLine)
    .filter(Boolean)

  const merged: string[] = []
  for (const line of normalizedLines) {
    const previous = merged[merged.length - 1]
    if (previous && shouldJoinLines(previous, line)) {
      merged[merged.length - 1] = `${previous} ${line}`
      continue
    }
    merged.push(line)
  }

  return merged.join('\n')
}

function scorePageQuality(cleanedPage: string): PdfPageDiagnostics {
  const lines = cleanedPage.split('\n').filter(Boolean)
  const words = cleanedPage.match(/\b[\p{L}\p{N}][\p{L}\p{N}'/-]*\b/gu) ?? []
  const chars = cleanedPage.length
  const bullets = lines.filter(isBulletLine).length
  const headingCandidates = lines.filter(isLikelyHeading).length
  const fragmentedLines = lines.filter((line) => line.length > 0 && line.length < 45).length
  const symbolChars = [...cleanedPage].filter((char) => /[^A-Za-z0-9\s.,;:!?%$()/'"-]/.test(char)).length
  const alphaChars = [...cleanedPage].filter((char) => /[A-Za-z]/.test(char))
  const uppercaseChars = alphaChars.filter((char) => char === char.toUpperCase()).length

  let score = 1
  const notes: string[] = []

  const fragmentationRatio = lines.length > 0 ? fragmentedLines / lines.length : 1
  const symbolRatio = chars > 0 ? symbolChars / chars : 0
  const uppercaseRatio = alphaChars.length > 0 ? uppercaseChars / alphaChars.length : 0
  const likelyVisual = chars < 250 || (lines.length > 0 && words.length / lines.length < 3.5)
  const likelyTable = lines.some((line) => /\s{2,}\S+\s{2,}\S+/.test(line)) || lines.some((line) => /\|\s*[^|]+\s*\|/.test(line))

  if (chars < 120) {
    score -= 0.45
    notes.push('very_low_text')
  } else if (chars < 300) {
    score -= 0.2
    notes.push('low_text')
  }

  if (fragmentationRatio > 0.6) {
    score -= 0.2
    notes.push('fragmented_lines')
  }

  if (symbolRatio > 0.15) {
    score -= 0.15
    notes.push('high_symbol_noise')
  }

  if (uppercaseRatio > 0.7 && words.length > 20) {
    score -= 0.05
    notes.push('mostly_uppercase')
  }

  if (likelyVisual) {
    score -= 0.15
    notes.push('likely_visual')
  }

  if (likelyTable) {
    notes.push('likely_table')
  }

  score = Math.max(0, Math.min(1, score))
  const parseQuality: ParseQuality = score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low'
  const title = (lines.find(isLikelyHeading) ?? lines.find(Boolean) ?? 'Untitled page').slice(0, 80)

  return {
    page: 0,
    title,
    chars,
    words: words.length,
    lines: lines.length,
    bullets,
    heading_candidates: headingCandidates,
    fragmentation_ratio: Number(fragmentationRatio.toFixed(3)),
    symbol_ratio: Number(symbolRatio.toFixed(3)),
    uppercase_ratio: Number(uppercaseRatio.toFixed(3)),
    quality_score: Number(score.toFixed(3)),
    parse_quality: parseQuality,
    likely_visual: likelyVisual,
    likely_table: likelyTable,
    notes,
  }
}

function classifyDocumentKind(
  diagnostics: PdfPageDiagnostics[],
): 'report' | 'slide-deck' | 'mixed' {
  const populatedPages = diagnostics.filter((page) => page.chars > 0)
  const visualPages = diagnostics.filter((page) => page.likely_visual || page.needs_ocr).length
  const slideLikePages = populatedPages.filter((page) =>
    page.bullets >= 2 || (page.heading_candidates >= 1 && page.chars < VISUAL_THRESHOLD))

  if (
    visualPages > 0 &&
    slideLikePages.length >= Math.ceil(Math.max(populatedPages.length, 1) / 2)
  ) return 'slide-deck'
  return visualPages > 0 ? 'mixed' : 'report'
}

function analyzeDocument(rawPages: string[]): PdfDocumentAnalysis {
  const withoutRepeated = stripRepeatedLines(rawPages)
  const cleanedPages = withoutRepeated.pages.map(cleanPageText)
  const diagnostics = cleanedPages.map((page, index) => ({
    ...scorePageQuality(page),
    page: index + 1,
  }))

  const qualityScore = diagnostics.length > 0
    ? Number((diagnostics.reduce((sum, page) => sum + page.quality_score, 0) / diagnostics.length).toFixed(3))
    : 0
  const parseQuality: ParseQuality = qualityScore >= 0.75 ? 'high' : qualityScore >= 0.45 ? 'medium' : 'low'
  const flaggedPages = diagnostics
    .filter((page) => page.parse_quality !== 'high' || page.likely_visual || page.likely_table)
    .map((page) => page.page)
  const pagesNeedingOcr = diagnostics.filter((page) => page.chars < 120).map((page) => page.page)
  const visualPages = diagnostics.filter((page) => page.likely_visual).length

  const needsOcr = pagesNeedingOcr.length > 0
  const flaggedRatio = flaggedPages.length / Math.max(diagnostics.length, 1)
  const requiresLlm = parseQuality !== 'high' || visualPages > 0
  const lmScope: LmEnrichmentScope = !requiresLlm
    ? 'none'
    : flaggedRatio >= FULL_DOCUMENT_LM_PAGE_THRESHOLD
      ? 'full_document'
      : 'flagged_pages'

  const documentKind = classifyDocumentKind(diagnostics)

  const rawText = cleanedPages
    .map((page, index) => `## Page ${index + 1}\n\n${page || '_No text extracted on this page._'}`)
    .join('\n\n')

  const structuredText = diagnostics
    .map((page) => [
      `## Page ${page.page} — ${page.title}`,
      '',
      `- parse_quality: ${page.parse_quality}`,
      `- quality_score: ${page.quality_score}`,
      `- chars: ${page.chars}`,
      `- words: ${page.words}`,
      `- lines: ${page.lines}`,
      `- bullets: ${page.bullets}`,
      `- likely_visual: ${page.likely_visual}`,
      `- likely_table: ${page.likely_table}`,
      page.notes.length > 0 ? `- notes: ${page.notes.join(', ')}` : '- notes: none',
      '',
      '### Extracted Content',
      '',
      cleanedPages[page.page - 1] || '_No text extracted on this page._',
    ].join('\n'))
    .join('\n\n')

  return {
    pages: rawPages,
    cleanedPages,
    diagnostics,
    repeatedLines: withoutRepeated.repeatedLines,
    rawText,
    structuredText,
    qualityScore,
    parseQuality,
    flaggedPages,
    needsOcr,
    requiresLlm,
    lmScope,
    documentKind,
    pagesNeedingOcr,
    pagesWithTables: diagnostics.filter((page) => page.likely_table).map((page) => page.page),
    pagesWithColumns: [],
    columnLayoutDetection: 'unavailable',
    isComplexLayout: diagnostics.some((page) => page.likely_table),
  }
}

function markdownForScoring(markdown: string): string {
  return markdown
    .replace(/<!--.*?-->/gs, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[*+]\s+/gm, '- ')
    .replace(/[*_`~|]/g, ' ')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function analyzeInspectorDocument(
  extraction: PdfInspectorExtraction,
): PdfDocumentAnalysis {
  const pages = extraction.pages.map((page) => page.markdown.trim())
  const pagesNeedingOcr = [...new Set([
    ...extraction.pagesNeedingOcr,
    ...extraction.pages.filter((page) => page.needsOcr).map((page) => page.page),
  ])].sort((a, b) => a - b)
  const reasonsByPage = new Map(
    extraction.ocrReasonsByPage.map((entry) => [entry.page, entry.reasons]),
  )
  const diagnostics = extraction.pages.map((page) => {
    const scored = scorePageQuality(markdownForScoring(page.markdown))
    const likelyTable = extraction.pagesWithTables.includes(page.page)
    const likelyColumns = extraction.pagesWithColumns.includes(page.page)
    const needsOcr = pagesNeedingOcr.includes(page.page)
    const ocrReasons = [
      ...(reasonsByPage.get(page.page) ?? []),
      ...(page.ocrReason ? [page.ocrReason] : []),
    ]
    const notes = [...scored.notes]
    if (likelyTable) notes.push('native_table')
    if (likelyColumns) notes.push('native_columns')
    if (needsOcr) notes.push('needs_ocr')

    return {
      ...scored,
      page: page.page,
      likely_table: likelyTable,
      likely_columns: likelyColumns,
      needs_ocr: needsOcr,
      ...(ocrReasons.length > 0 ? { ocr_reasons: [...new Set(ocrReasons)] } : {}),
      notes: [...new Set(notes)],
    }
  })
  const qualityScore = diagnostics.length > 0
    ? Number((diagnostics.reduce((sum, page) => sum + page.quality_score, 0) / diagnostics.length).toFixed(3))
    : 0
  const parseQuality: ParseQuality = qualityScore >= 0.75 ? 'high' : qualityScore >= 0.45 ? 'medium' : 'low'
  const flaggedPages = diagnostics
    .filter((page) =>
      page.needs_ocr ||
      page.parse_quality !== 'high' ||
      page.likely_visual ||
      page.likely_table ||
      page.likely_columns)
    .map((page) => page.page)
  const needsOcr = pagesNeedingOcr.length > 0
  const requiresLlm = needsOcr || extraction.hasEncodingIssues || flaggedPages.length > 0
  const flaggedRatio = flaggedPages.length / Math.max(diagnostics.length, 1)
  const lmScope: LmEnrichmentScope = !requiresLlm
    ? 'none'
    : flaggedRatio >= FULL_DOCUMENT_LM_PAGE_THRESHOLD
      ? 'full_document'
      : 'flagged_pages'
  const documentKind = classifyDocumentKind(diagnostics)
  const semanticText = extraction.markdown ?? extraction.pages
    .map((page) => page.markdown || '_No text extracted on this page._')
    .join('\n\n')

  return {
    pages,
    cleanedPages: pages,
    diagnostics,
    repeatedLines: [],
    rawText: semanticText,
    structuredText: diagnostics.map((page) => [
      `## Page ${page.page} — ${page.title}`,
      '',
      `- parse_quality: ${page.parse_quality}`,
      `- quality_score: ${page.quality_score}`,
      `- chars: ${page.chars}`,
      `- words: ${page.words}`,
      `- lines: ${page.lines}`,
      `- bullets: ${page.bullets}`,
      `- likely_visual: ${page.likely_visual}`,
      `- likely_table: ${page.likely_table}`,
      `- likely_columns: ${page.likely_columns ?? false}`,
      `- needs_ocr: ${page.needs_ocr ?? false}`,
      page.notes.length > 0 ? `- notes: ${page.notes.join(', ')}` : '- notes: none',
      '',
      '### Extracted Content',
      '',
      pages[page.page - 1] || '_No text extracted on this page._',
    ].join('\n')).join('\n\n'),
    qualityScore,
    parseQuality,
    flaggedPages,
    needsOcr,
    requiresLlm,
    lmScope,
    documentKind,
    pagesNeedingOcr,
    pagesWithTables: [...extraction.pagesWithTables],
    pagesWithColumns: [...extraction.pagesWithColumns],
    columnLayoutDetection: 'native',
    isComplexLayout: extraction.isComplexLayout,
    detectedPdfType: extraction.detectedType,
    detectionConfidence: extraction.confidence,
    hasEncodingIssues: extraction.hasEncodingIssues,
  }
}

/**
 * The model-facing document, in page order, with every page accounted for.
 *
 * A page nothing could read is named as unresolved rather than left blank: a reader that cannot
 * tell a gap from a genuinely empty page will never go back for it.
 */
function buildMergedMarkdown(pages: readonly PdfPageReadResult[]): string {
  return pages
    .map((page) => {
      const body = page.status === 'read' && page.markdown.trim().length > 0
        ? page.markdown.trim()
        : page.status === 'empty'
          ? '_This page is blank._'
          : '_This page could not be read. Local text recognition did not resolve it._'
      return `## Page ${page.page}\n\n${body}`
    })
    .join('\n\n')
}

function summarizeOcr(read: OcrReadResult, applied: boolean): PdfOcrSummary {
  return {
    contractVersion: read.contractVersion,
    contractIdentity: read.contractIdentity,
    engine: read.engine,
    status: read.status,
    applied,
    requestedPages: read.requestedPages,
    readPages: read.readPages,
    emptyPages: read.emptyPages,
    unresolvedPages: read.unresolvedPages,
    elapsedMs: read.elapsedMs,
  }
}

/** "page 12" or "pages 12, 13" — the pages a reader still has to go back for. */
function formatUnreadPages(pages: readonly number[]): string {
  return `${pages.length === 1 ? 'page' : 'pages'} ${pages.join(', ')}`
}

/**
 * Whether recognition changed the document.
 *
 * Only a page whose final text differs from what the extractor returned counts. A document OCR
 * was offered and contributed nothing to keeps the artifact it has today, byte for byte.
 */
function ocrChangedTheDocument(
  read: OcrReadResult,
  extracted: readonly string[],
): boolean {
  return read.pages.some((page, index) => {
    if (page.source === 'ocr' || page.source === 'mixed') return true
    if (page.status === 'unresolved') return true
    return page.markdown.trim() !== (extracted[index] ?? '').trim()
  })
}

function buildParseJson(params: {
  fileName: string
  pageCount: number
  charsPerPage: number
  classification: PdfClassification
  analysis: PdfDocumentAnalysis
  pdfEngine: 'pdf-inspector' | 'pdf-parse'
  fallbackReason?: string
  enrichment?: AppliedEnrichment
  ocr?: { summary: PdfOcrSummary; pages: readonly PdfPageReadResult[] }
}): Record<string, unknown> {
  return {
    source: params.fileName,
    type: 'pdf',
    page_count: params.pageCount,
    // Canonical page evidence is independent of headings inside untrusted source text.
    pages: params.ocr?.pages ?? params.analysis.cleanedPages.map((markdown, index) => ({
      page: index + 1,
      markdown,
      status: params.analysis.pagesNeedingOcr.includes(index + 1) ? 'unresolved' : markdown.trim() ? 'read' : 'empty',
    })),
    chars_per_page: params.charsPerPage,
    classification: params.classification,
    pdf_engine: params.pdfEngine,
    pdf_engine_fallback_reason: params.fallbackReason ?? null,
    parse_quality: params.analysis.parseQuality,
    quality_score: params.analysis.qualityScore,
    needs_ocr: params.analysis.needsOcr,
    needs_lm_enrichment: params.analysis.requiresLlm,
    lm_scope: params.analysis.lmScope,
    flagged_pages: params.analysis.flaggedPages,
    document_kind: params.analysis.documentKind,
    pages_needing_ocr: params.analysis.pagesNeedingOcr,
    pages_with_tables: params.analysis.pagesWithTables,
    pages_with_columns: params.analysis.columnLayoutDetection === 'native'
      ? params.analysis.pagesWithColumns
      : null,
    column_layout_detection: params.analysis.columnLayoutDetection,
    complex_layout: params.analysis.isComplexLayout,
    pdf_inspector_type: params.analysis.detectedPdfType ?? null,
    pdf_inspector_confidence: params.analysis.detectionConfidence ?? null,
    has_encoding_issues: params.analysis.hasEncodingIssues ?? false,
    repeated_lines_removed: params.analysis.repeatedLines,
    page_diagnostics: params.analysis.diagnostics,
    ocr: params.ocr
      ? {
        ...params.ocr.summary,
        pages: params.ocr.pages,
      }
      : null,
    enrichment_applied: Boolean(params.enrichment),
    enrichment_provider: params.enrichment?.result.provider ?? null,
    enrichment_model: params.enrichment?.result.model ?? null,
    enrichment_confidence: params.enrichment?.result.response.confidence ?? null,
  }
}

function buildStructuredMarkdown(params: {
  fileName: string
  pageCount: number
  charsPerPage: number
  classification: PdfClassification
  analysis: PdfDocumentAnalysis
  metadata: Record<string, unknown>
  pdfEngine: 'pdf-inspector' | 'pdf-parse'
}): string {
  return wrapDocument(
    `${params.fileName} (structured)`,
    [
      '## Summary',
      '',
      `- classification: ${params.classification}`,
      `- document_kind: ${params.analysis.documentKind}`,
      `- parse_quality: ${params.analysis.parseQuality}`,
      `- quality_score: ${params.analysis.qualityScore}`,
      `- pages: ${params.pageCount}`,
      `- chars_per_page: ${params.charsPerPage}`,
      `- needs_ocr: ${params.analysis.needsOcr}`,
      `- needs_lm_enrichment: ${params.analysis.requiresLlm}`,
      `- lm_scope: ${params.analysis.lmScope}`,
      `- column_layout_detection: ${params.analysis.columnLayoutDetection}`,
      params.analysis.flaggedPages.length > 0
        ? `- flagged_pages: ${params.analysis.flaggedPages.join(', ')}`
        : '- flagged_pages: none',
      params.analysis.repeatedLines.length > 0
        ? `- repeated_lines_removed: ${params.analysis.repeatedLines.join(' | ')}`
        : '- repeated_lines_removed: none',
      '',
      '## Per-Page Structure',
      '',
      params.analysis.structuredText,
    ].join('\n'),
    {
      ...params.metadata,
      artifact: 'structured',
      parse_quality: params.analysis.parseQuality,
      quality_score: params.analysis.qualityScore,
      needs_ocr: params.analysis.needsOcr,
      needs_lm_enrichment: params.analysis.requiresLlm,
      lm_scope: params.analysis.lmScope,
      document_kind: params.analysis.documentKind,
    },
  )
}

function buildPageMapMarkdown(
  fileName: string,
  analysis: PdfDocumentAnalysis,
): string {
  const pageAnchors = analysis.diagnostics.map((page) => {
    const hasText = Boolean(analysis.cleanedPages[page.page - 1]?.trim())
    return `- Page ${page.page}: ${hasText ? page.title : '[No text extracted]'}`
  })

  return [
    '# PDF Page Locator',
    '',
    `Source: ${fileName}`,
    '',
    'Use these semantic anchors to resolve parser and enrichment page references against the canonical document.',
    '',
    ...pageAnchors,
  ].join('\n')
}

function buildEnrichedMarkdown(params: {
  fileName: string
  metadata: Record<string, unknown>
  enrichment: AppliedEnrichment
}): string {
  const response = params.enrichment.result.response
  return wrapDocument(
    `${params.fileName} (enriched)`,
    [
      '## Summary',
      '',
      response.document_summary,
      '',
      `- document_kind: ${response.document_kind}`,
      `- confidence: ${response.confidence}`,
      response.recommended_pages.length > 0
        ? `- recommended_pages: ${response.recommended_pages.join(', ')}`
        : '- recommended_pages: none',
      '',
      '## Key Entities',
      '',
      ...(response.key_entities.length > 0 ? response.key_entities.map((item) => `- ${item}`) : ['- none']),
      '',
      '## Key Metrics',
      '',
      ...(response.key_metrics.length > 0
        ? response.key_metrics.map((metric) => `- ${metric.label}: ${metric.value}${metric.page ? ` (page ${metric.page})` : ''}`)
        : ['- none']),
      '',
      '## Per-Page Enrichment',
      '',
      ...response.page_summaries.flatMap((page) => [
        `### Page ${page.page} — ${page.title}`,
        '',
        page.summary,
        '',
        page.visual_elements.length > 0
          ? `- visual_elements: ${page.visual_elements.join(', ')}`
          : '- visual_elements: none',
        `- table_like: ${page.table_like}`,
        ...(page.extracted_key_values && page.extracted_key_values.length > 0
          ? [
            '',
            '#### Extracted Key Values',
            '',
            ...page.extracted_key_values.map((item) => `- ${item.label}: ${item.value}`),
          ]
          : []),
        ...(page.extracted_claims && page.extracted_claims.length > 0
          ? [
            '',
            '#### Extracted Claims',
            '',
            ...page.extracted_claims.map((item) => `- ${item}`),
          ]
          : []),
        ...(page.extracted_table_markdown
          ? [
            '',
            '#### Extracted Table',
            '',
            page.extracted_table_markdown,
          ]
          : []),
        '',
      ]),
    ].join('\n'),
    {
      ...params.metadata,
      artifact: 'enriched',
      enrichment_provider: params.enrichment.result.provider,
      enrichment_model: params.enrichment.result.model,
      enrichment_confidence: response.confidence,
    },
  )
}

function shouldApplyLmEnrichment(params: {
  analysis: PdfDocumentAnalysis
  classification: PdfClassification
}): boolean {
  if (!params.analysis.requiresLlm) return false
  if (
    params.classification === 'text-heavy' &&
    params.analysis.parseQuality === 'high' &&
    !params.analysis.needsOcr &&
    !params.analysis.isComplexLayout &&
    !params.analysis.hasEncodingIssues
  ) return false
  return true
}

async function maybeApplyLmEnrichment(params: {
  fileName: string
  classification: PdfClassification
  analysis: PdfDocumentAnalysis
  pagesDir?: string
}): Promise<AppliedEnrichment | null> {
  if (!shouldApplyLmEnrichment({ analysis: params.analysis, classification: params.classification })) {
    return null
  }

  const enricher = createLmEnricherFromEnv()
  if (!enricher) return null

  const request: EnrichmentRequest = {
    source: params.fileName,
    classification: params.classification,
    parseQuality: params.analysis.parseQuality,
    qualityScore: params.analysis.qualityScore,
    lmScope: params.analysis.lmScope,
    flaggedPages: params.analysis.flaggedPages,
    documentKind: params.analysis.documentKind,
    pages: params.analysis.diagnostics
      .filter((page) => params.analysis.lmScope === 'full_document' || params.analysis.flaggedPages.includes(page.page))
      .map((page) => {
        const imagePath = params.pagesDir && fs.existsSync(path.join(params.pagesDir, `page-${String(page.page).padStart(3, '0')}.jpg`))
          ? path.join(params.pagesDir, `page-${String(page.page).padStart(3, '0')}.jpg`)
          : undefined
        return {
          page: page.page,
          title: page.title,
          parseQuality: page.parse_quality,
          qualityScore: page.quality_score,
          text: params.analysis.cleanedPages[page.page - 1] || '',
          ...(imagePath ? { imagePath } : {}),
        }
      }),
  }

  if (request.pages.length === 0) return null

  const result = await enricher.enrichPdf(request)
  const markdown = buildEnrichedMarkdown({
    fileName: params.fileName,
    metadata: {
      type: 'pdf',
      artifact: 'enriched',
    },
    enrichment: {
      markdown: '',
      json: {},
      result,
    },
  })

  return {
    markdown,
    json: {
      provider: result.provider,
      model: result.model,
      response: result.response,
      raw_text: result.rawText,
    },
    result,
  }
}

function normalizePdfMetadataInfo(value: unknown): PdfMetadataInfo {
  if (!value || typeof value !== 'object') return {}
  const metadata = value as Record<string, unknown>
  return {
    ...(typeof metadata["Title"] === 'string' ? { Title: metadata["Title"] } : {}),
    ...(typeof metadata["Author"] === 'string' ? { Author: metadata["Author"] } : {}),
  }
}

async function extractPages(
  buffer: Uint8Array,
): Promise<{ text: string; pages: string[]; info: PdfMetadataInfo }> {
  const pages: string[] = []
  // PDF.js accepts Uint8Array, but the legacy @types/pdf-parse declaration
  // narrows this input to Buffer. Passing Buffer itself intermittently breaks
  // XRef parsing for otherwise valid PDFKit documents.
  const data = await pdfParse(buffer as Buffer, {
    pagerender: async (pageData: PdfPageData) => {
      const textContent = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      })

      let lastY: number | undefined
      let text = ''
      for (const item of textContent.items) {
        if (lastY === undefined || lastY === item.transform[5]) {
          text += item.str
        } else {
          text += `\n${item.str}`
        }
        lastY = item.transform[5]
      }

      pages.push(text)
      return text
    },
  })

  return { text: data.text, pages, info: normalizePdfMetadataInfo(data.info as unknown) }
}

export async function parsePdf(
  filePath: string,
  outputDir: string,
  dependencies: PdfParserDependencies = {},
): Promise<ParseResult> {
  const fileName = path.basename(filePath)

  try {
    const sizeBytes = fs.statSync(filePath).size
    const buffer = Uint8Array.from(fs.readFileSync(filePath))
    let pdfEngine: 'pdf-inspector' | 'pdf-parse' = 'pdf-inspector'
    let pdfEngineFallbackReason: string | undefined
    let extractedInfo: PdfMetadataInfo | undefined
    let inspectorTitle: string | undefined
    let analysis: PdfDocumentAnalysis | undefined
    let inspected: PdfInspectorExtraction | undefined
    let metadataOcrError: string | undefined
    const inspectPdf = dependencies.inspectPdf ?? extractPdfWithInspector

    try {
      inspected = await inspectPdf(buffer)
      if (inspected.pages.length === 0) {
        throw new Error('pdf-inspector returned no pages')
      }
    } catch (error) {
      pdfEngine = 'pdf-parse'
      pdfEngineFallbackReason = (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
      const extracted = await extractPages(buffer)
      extractedInfo = extracted.info
      analysis = analyzeDocument(extracted.pages)
    }
    if (inspected) {
      inspectorTitle = inspected.title
      analysis = analyzeInspectorDocument(inspected)
    }
    if (!analysis) throw new Error('PDF analysis did not produce a result')

    // Local recognition runs only behind PDF Inspector, which is the extractor that reports
    // which pages it could not read. The `pdf-parse` compatibility fallback keeps the behaviour
    // it has today.
    let ocrRead: OcrReadResult | undefined
    if (inspected && !dependencies.disableLocalOcr) {
      try {
        ocrRead = await readPdfPagesWithOcr({
          filePath,
          pages: inspected.pages.map((page) => ({
            page: page.page,
            markdown: page.markdown,
            needsOcr: analysis.pagesNeedingOcr.includes(page.page),
          })),
          // The clock lives at this parser boundary; the coordinator only reads it.
          now: Date.now,
          ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          ...(dependencies.ocr ? { dependencies: dependencies.ocr } : {}),
        })
      } catch (err) {
        // Recognition that could not run at all leaves the deterministic document alone; the
        // reason is recorded rather than swallowed.
        metadataOcrError = err instanceof Error ? err.message : String(err)
      }
    }

    // Recognition only replaces the model-facing document when it actually contributed. A
    // document that needed no OCR keeps the artifact it has today, byte for byte.
    const ocrApplied = Boolean(ocrRead && ocrChangedTheDocument(ocrRead, analysis.pages))

    const pageCount = analysis.pages.length
    const totalChars = analysis.cleanedPages.join('\n').length
    const charsPerPage = pageCount > 0 ? Math.round(totalChars / pageCount) : 0
    const classification = classify(charsPerPage)

    const metadata: Record<string, unknown> = {
      type: 'pdf',
      pages: pageCount,
      pdf_engine: pdfEngine,
      ...(pdfEngineFallbackReason ? { pdf_engine_fallback_reason: pdfEngineFallbackReason } : {}),
      classification,
      chars_per_page: charsPerPage,
      parse_quality: analysis.parseQuality,
      quality_score: analysis.qualityScore,
      needs_ocr: analysis.needsOcr,
      needs_lm_enrichment: analysis.requiresLlm,
      lm_scope: analysis.lmScope,
      document_kind: analysis.documentKind,
      pages_needing_ocr: analysis.pagesNeedingOcr,
      pages_with_tables: analysis.pagesWithTables,
      pages_with_columns: analysis.columnLayoutDetection === 'native'
        ? analysis.pagesWithColumns
        : null,
      column_layout_detection: analysis.columnLayoutDetection,
      complex_layout: analysis.isComplexLayout,
      ...(analysis.detectedPdfType ? { pdf_inspector_type: analysis.detectedPdfType } : {}),
      ...(analysis.detectionConfidence === undefined
        ? {}
        : { pdf_inspector_confidence: analysis.detectionConfidence }),
      has_encoding_issues: analysis.hasEncodingIssues ?? false,
    }
    const ocrSummary = ocrRead ? summarizeOcr(ocrRead, ocrApplied) : undefined
    if (ocrSummary) {
      metadata["ocr_contract_version"] = ocrSummary.contractVersion
      metadata["ocr_contract_identity"] = ocrSummary.contractIdentity
      metadata["ocr_engine"] = ocrSummary.engine
      metadata["ocr_status"] = ocrSummary.status
      metadata["ocr_applied"] = ocrSummary.applied
      metadata["ocr_requested_pages"] = ocrSummary.requestedPages
      metadata["ocr_read_pages"] = ocrSummary.readPages
      metadata["ocr_empty_pages"] = ocrSummary.emptyPages
      metadata["ocr_unresolved_pages"] = ocrSummary.unresolvedPages
      metadata["ocr_elapsed_ms"] = ocrSummary.elapsedMs
      // Never the recognized text: logs and metadata carry page numbers and outcomes only.
      if (ocrRead?.failure) metadata["ocr_failure"] = ocrRead.failure
    } else if (pdfEngine === 'pdf-parse') {
      // The compatibility engine legitimately produces no recognition. The result still names
      // the contract it ran under, so a later run can tell it from a manifest written before
      // local recognition existed instead of reparsing it forever.
      metadata["ocr_contract_version"] = OCR_CONTRACT_VERSION
      metadata["ocr_contract_identity"] = ocrContractIdentity()
    }
    if (metadataOcrError) metadata["ocr_error"] = metadataOcrError
    if (inspectorTitle) metadata["title"] = inspectorTitle
    if (extractedInfo?.Title) metadata["title"] = extractedInfo.Title
    if (extractedInfo?.Author) metadata["author"] = extractedInfo.Author

    const nativeContent = pdfEngine === 'pdf-inspector'
      ? analysis.rawText || '_No text extracted._'
      : wrapDocument(fileName, analysis.rawText || '_No text extracted._', metadata)
    const mdContent = ocrApplied && ocrRead
      ? buildMergedMarkdown(ocrRead.pages)
      : nativeContent
    const mdPath = path.join(outputDir, `${fileName}.md`)
    fs.writeFileSync(mdPath, mdContent)

    // The extractor's own reading stays available for diagnostics and regression comparison. It
    // is additive: it never replaces the merged model-facing document.
    let nativeOutputName: string | undefined
    if (ocrApplied) {
      nativeOutputName = `${fileName}.native.md`
      fs.writeFileSync(path.join(outputDir, nativeOutputName), nativeContent)
    }

    const structureContent = buildStructuredMarkdown({
      fileName,
      pageCount,
      charsPerPage,
      classification,
      analysis,
      metadata,
      pdfEngine,
    })
    const structurePath = path.join(outputDir, `${fileName}.structure.md`)
    fs.writeFileSync(structurePath, structureContent)

    const pageMapFileName = analysis.flaggedPages.length > 0
      ? `${fileName}.pages.md`
      : undefined
    if (pageMapFileName) {
      fs.writeFileSync(
        path.join(outputDir, pageMapFileName),
        buildPageMapMarkdown(fileName, analysis),
      )
    }

    const parseJsonPath = path.join(outputDir, `${fileName}.parse.json`)

    const outputs: Record<string, string> = {
      text: `${fileName}.md`,
      structure: `${fileName}.structure.md`,
      ...(nativeOutputName ? { native: nativeOutputName } : {}),
      ...(pageMapFileName ? { pageMap: pageMapFileName } : {}),
      parse: `${fileName}.parse.json`,
    }

    let pagesDirPath: string | undefined

    if (classification !== 'text-heavy' || analysis.needsOcr) {
      const pagesDir = path.join(outputDir, `${fileName}.pages`)
      try {
        const renderPriority = [
          ...analysis.pagesNeedingOcr,
          ...analysis.pagesWithTables,
          ...analysis.pagesWithColumns,
          ...analysis.flaggedPages,
        ]
        const maxRenderedPages = dependencies.maxRenderedPages ?? getMaxRenderedPages()
        const renderedPages = await renderPages(
          filePath,
          pagesDir,
          renderPriority,
          maxRenderedPages,
          dependencies.openPdf,
        )
        outputs["pages"] = `${fileName}.pages/`
        metadata["rendered_pages"] = renderedPages.length
        metadata["rendered_page_numbers"] = renderedPages
        metadata["rendered_page_limit"] = maxRenderedPages
        pagesDirPath = pagesDir
      } catch (err) {
        metadata["page_render_error"] = err instanceof Error ? err.message : String(err)
      }
    }

    let enrichment: AppliedEnrichment | null = null
    try {
      enrichment = await maybeApplyLmEnrichment({
        fileName,
        classification,
        analysis,
        ...(pagesDirPath ? { pagesDir: pagesDirPath } : {}),
      })
    } catch (err) {
      metadata["enrichment_error"] = err instanceof Error ? err.message : String(err)
    }

    if (enrichment) {
      const enrichedPath = path.join(outputDir, `${fileName}.enriched.md`)
      const enrichmentJsonPath = path.join(outputDir, `${fileName}.enrichment.json`)
      fs.writeFileSync(enrichedPath, enrichment.markdown)
      fs.writeFileSync(enrichmentJsonPath, JSON.stringify(enrichment.json, null, 2))
      outputs["enriched"] = `${fileName}.enriched.md`
      outputs["enrichment"] = `${fileName}.enrichment.json`
      metadata["enrichment_provider"] = enrichment.result.provider
      metadata["enrichment_model"] = enrichment.result.model
      metadata["enrichment_confidence"] = enrichment.result.response.confidence
    }

    const parseJson = buildParseJson({
      fileName,
      pageCount,
      charsPerPage,
      classification,
      analysis,
      pdfEngine,
      ...(pdfEngineFallbackReason ? { fallbackReason: pdfEngineFallbackReason } : {}),
      ...(enrichment ? { enrichment } : {}),
      ...(ocrSummary && ocrRead ? { ocr: { summary: ocrSummary, pages: ocrRead.pages } } : {}),
    })
    fs.writeFileSync(parseJsonPath, JSON.stringify(parseJson, null, 2))

    return {
      source: fileName,
      type: 'pdf',
      sizeBytes,
      outputs,
      metadata,
      classification,
      charsPerPage,
      parseQuality: analysis.parseQuality,
      qualityScore: analysis.qualityScore,
      requiresLlm: analysis.requiresLlm,
      needsOcr: analysis.needsOcr,
      lmScope: analysis.lmScope,
      flaggedPages: analysis.flaggedPages,
      ...(ocrSummary ? { ocr: ocrSummary } : {}),
      enrichmentApplied: Boolean(enrichment),
      ...(enrichment ? { enrichmentProvider: enrichment.result.provider } : {}),
      note: analysis.requiresLlm
        ? enrichment
          ? `LM enrichment applied through ${enrichment.result.provider}:${enrichment.result.model}.`
          : ocrSummary && ocrSummary.unresolvedPages.length > 0
            ? `Deterministic extraction is incomplete: ${formatUnreadPages(ocrSummary.unresolvedPages)} could not be read by local recognition. Recommended LM scope: ${analysis.lmScope}.`
            : ocrSummary
              ? ocrSummary.applied
                ? `Text the extractor could not read was recovered locally; optional semantic interpretation remains available. Recommended LM scope: ${analysis.lmScope}.`
                : `Deterministic extraction read every page; optional semantic interpretation remains available. Recommended LM scope: ${analysis.lmScope}.`
              : `Deterministic extraction is incomplete for some pages. Recommended LM scope: ${analysis.lmScope}.`
        : 'Deterministic extraction looks strong enough for downstream use.',
      status: 'success',
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      source: fileName,
      type: 'pdf',
      sizeBytes: 0,
      outputs: {},
      metadata: {},
      status: 'error',
      error: errMsg,
    }
  }
}
