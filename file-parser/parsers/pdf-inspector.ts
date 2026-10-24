export interface PdfInspectorPage {
  page: number
  markdown: string
  needsOcr: boolean
  ocrReason?: string
}

export interface PdfInspectorExtraction {
  markdown?: string
  title?: string
  pages: PdfInspectorPage[]
  pagesWithTables: number[]
  pagesWithColumns: number[]
  pagesNeedingOcr: number[]
  ocrReasonsByPage: Array<{ page: number; reasons: string[] }>
  isComplexLayout: boolean
  detectedType: string
  confidence: number
  hasEncodingIssues: boolean
}

interface InspectorDocumentResult {
  markdown?: string
  title?: string
  pagesNeedingOcr: number[]
  ocrReasonsByPage: Array<{ page: number; reasons: string[] }>
  pagesWithTables: number[]
  pagesWithColumns: number[]
  isComplexLayout: boolean
  pdfType: string
  confidence: number
  hasEncodingIssues: boolean
}

interface InspectorPagesResult {
  pages: Array<{ page: number; markdown: string; needsOcr: boolean; ocrReason?: string }>
  pagesNeedingOcr: number[]
  ocrReasonsByPage: Array<{ page: number; reasons: string[] }>
  pagesWithTables: number[]
  pagesWithColumns: number[]
  isComplex: boolean
}

interface PdfInspectorModule {
  processPdf(buffer: Buffer): InspectorDocumentResult
  extractPagesMarkdown(buffer: Buffer): InspectorPagesResult
}

export type LoadPdfInspector = () => Promise<PdfInspectorModule>

const loadPdfInspector: LoadPdfInspector = async () => import('@firecrawl/pdf-inspector')

/**
 * Load the native dependency at the parser boundary so a missing or
 * incompatible platform binary can fall back to the existing PDF.js parser.
 */
export async function extractPdfWithInspector(
  buffer: Uint8Array,
  loadInspector: LoadPdfInspector = loadPdfInspector,
): Promise<PdfInspectorExtraction> {
  const { extractPagesMarkdown, processPdf } = await loadInspector()
  const nativeBuffer = Buffer.from(buffer)
  const fullResult = processPdf(nativeBuffer)
  const pageResult = extractPagesMarkdown(nativeBuffer)
  const pagesNeedingOcr = [...new Set([
    ...fullResult.pagesNeedingOcr,
    ...pageResult.pagesNeedingOcr,
  ])].sort((a, b) => a - b)
  const reasonsByPage = new Map<number, Set<string>>()
  for (const entry of [
    ...fullResult.ocrReasonsByPage,
    ...pageResult.ocrReasonsByPage,
  ]) {
    const reasons = reasonsByPage.get(entry.page) ?? new Set<string>()
    for (const reason of entry.reasons) reasons.add(reason)
    reasonsByPage.set(entry.page, reasons)
  }

  return {
    ...(fullResult.markdown?.trim() ? { markdown: fullResult.markdown.trim() } : {}),
    ...(fullResult.title?.trim() ? { title: fullResult.title.trim() } : {}),
    pages: pageResult.pages.map((page) => ({
      page: page.page + 1,
      markdown: page.markdown.trim(),
      needsOcr: page.needsOcr,
      ...(page.ocrReason ? { ocrReason: page.ocrReason } : {}),
    })),
    pagesWithTables: [...new Set([
      ...fullResult.pagesWithTables,
      ...pageResult.pagesWithTables,
    ])].sort((a, b) => a - b),
    pagesWithColumns: [...new Set([
      ...fullResult.pagesWithColumns,
      ...pageResult.pagesWithColumns,
    ])].sort((a, b) => a - b),
    pagesNeedingOcr,
    ocrReasonsByPage: [...reasonsByPage.entries()]
      .sort(([left], [right]) => left - right)
      .map(([page, reasons]) => ({ page, reasons: [...reasons] })),
    isComplexLayout: fullResult.isComplexLayout || pageResult.isComplex,
    detectedType: fullResult.pdfType,
    confidence: fullResult.confidence,
    hasEncodingIssues: fullResult.hasEncodingIssues,
  }
}
