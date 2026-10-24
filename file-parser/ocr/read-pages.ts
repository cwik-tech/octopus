/**
 * Read every page of a PDF: structure first, recognition where structure failed, and region
 * recognition where structure succeeded but a qualifying picture did not.
 *
 * This is the only production entry the PDF parser imports. It selects pages, coordinates
 * streaming recognition, merges results, and returns page provenance. It owns no engine and no
 * renderer: both arrive through the seams below. A text-only document still loads the renderer
 * to inspect drawing operations for qualifying pictures, but it never loads the recognizer.
 */
import {
  OCR_CONTRACT_VERSION,
  OCR_ENGINE,
  OcrCancelledError,
  ocrContractIdentity,
  ocrIndexProfile,
  type OcrPdfDocument,
  type OcrReadStatus,
  type PageImage,
  type PageRegionSelection,
  type PdfPageReadResult,
  type TextRecognizer,
} from './contract.js'
import {
  cropToRegions,
  openOcrPdfDocument,
  streamPageImages,
} from './rasterize.js'
import { findQualifyingImageRegions } from './image-regions.js'
import { createTesseractRecognizer } from './tesseract-engine.js'
import { reconstructTableFromLines } from './table-reconstruction.js'

/** What page selection needs to know about a page. A structural subset of the extractor's output. */
export interface OcrSourcePage {
  /** 1-based, as the extractor reports it. */
  page: number
  markdown: string
  needsOcr: boolean
}

export interface ReadPagesDependencies {
  openDocument?: (filePath: string) => Promise<OcrPdfDocument>
  createRecognizer?: () => Promise<TextRecognizer>
  /** Cutting a region out of a rendered page is input and output work, so it arrives as a seam. */
  cropImage?: (image: PageImage, region: PageRegionSelection) => Promise<Uint8Array>
  findImageRegions?: (
    document: OcrPdfDocument,
    pages: readonly number[],
    signal?: AbortSignal,
  ) => Promise<PageRegionSelection[]>
}

export interface ReadPagesInput {
  filePath: string
  /** Every page of the document, in order, as the structural extractor read it. */
  pages: readonly OcrSourcePage[]
  signal?: AbortSignal
  /**
   * Clock for elapsed-time reporting. Required, not defaulted: a coordinator has no business
   * owning a clock, so the caller at the parser boundary supplies it.
   */
  now: () => number
  dependencies?: ReadPagesDependencies
}

export interface OcrReadResult {
  status: OcrReadStatus
  contractVersion: number
  contractIdentity: string
  engine: string
  /** Every page of the document, in order, with its final text and provenance. */
  pages: PdfPageReadResult[]
  /** Pages recognition was offered, ascending. */
  requestedPages: number[]
  /** Pages recognition returned text for, ascending. */
  readPages: number[]
  /** Pages recognition ran on and found nothing, ascending. */
  emptyPages: number[]
  /** Pages that needed reading and did not get it, ascending. */
  unresolvedPages: number[]
  elapsedMs: number
  /** Why recognition could not complete, when it could not. Never document text. */
  failure?: string
}

/**
 * Whether this page still has to be read by recognizing it.
 *
 * Two ways in, and the second is the defensive one. The extractor's own flag decides the
 * ordinary case. But a page it says it read and returned nothing for has contradicted itself,
 * and believing the flag over the result is how a page with words on it gets stored as blank —
 * the one failure that looks exactly like a correct answer.
 *
 * Whitespace is nothing: a page whose text layer is a single newline has no words on it.
 */
export function pageNeedsRecognition(page: {
  needsOcr: boolean
  markdown: string
}): boolean {
  return page.needsOcr || page.markdown.trim().length === 0
}

/** Text as a reader would compare it, so a repeated line is recognised as repeated. */
function comparableText(value: string): string {
  return value
    .replace(/[*_`~|#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * A region's reading merged into the page's native text: the native text, a blank line, then
 * whatever the recognition said that the page does not already say.
 *
 * Deduplicated line by line, because a picture that merely repeats the text beside it would
 * otherwise be stored twice. Appended rather than interleaved — a documented limitation —
 * because there is no way back to where on the page the picture sat relative to the words.
 */
export function mergeRegionText(nativeMarkdown: string, regionText: string): string {
  const native = comparableText(nativeMarkdown)
  const kept: string[] = []
  for (const line of regionText.split('\n')) {
    const comparable = comparableText(line)
    if (comparable.length === 0) continue
    if (native.includes(comparable)) continue
    if (kept.some((existing) => comparableText(existing) === comparable)) continue
    kept.push(line.trim())
  }
  if (kept.length === 0) return nativeMarkdown
  return `${nativeMarkdown}\n\n${kept.join('\n')}`
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

interface RecognitionOutcome {
  textByPage: Map<number, string>
  askedPages: Set<number>
  /** Pages whose reading attempt failed, whether whole-page or region. */
  failedPages: Set<number>
  cancelled: boolean
  failure?: string
}

/**
 * Render and recognize the selected pages, one page at a time.
 *
 * One recognizer serves the whole document and is closed on every path out. A page that fails
 * is left out of the answer rather than recorded as empty, so the caller can tell a page nobody
 * read from a page that was read and found blank.
 */
async function recognizeSelectedPages(params: {
  document: OcrPdfDocument
  pages: readonly number[]
  regionsByPage: ReadonlyMap<number, PageRegionSelection>
  createRecognizer: () => Promise<TextRecognizer>
  cropImage: (image: PageImage, region: PageRegionSelection) => Promise<Uint8Array>
  signal?: AbortSignal
}): Promise<RecognitionOutcome> {
  const outcome: RecognitionOutcome = {
    textByPage: new Map<number, string>(),
    askedPages: new Set<number>(),
    failedPages: new Set<number>(),
    cancelled: false,
  }
  if (params.pages.length === 0) return outcome

  const cancelled = (): boolean => params.signal?.aborted === true
  if (cancelled()) {
    outcome.cancelled = true
    return outcome
  }

  let recognizer: TextRecognizer | null = null
  try {
    const images = streamPageImages(params.document, {
      pages: params.pages,
      dpi: ocrIndexProfile().dpi,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    })

    for await (const image of images) {
      // Recognition of one page is not preemptible — the engine offers no cancellation — so the
      // signal is read between pages and nothing pretends otherwise.
      if (cancelled()) {
        outcome.cancelled = true
        break
      }
      recognizer ??= await params.createRecognizer()
      outcome.askedPages.add(image.page)

      const region = params.regionsByPage.get(image.page)
      try {
        // Cutting the region out is part of this page's reading attempt: a crop that fails is
        // one unresolved page, not a failed document.
        const target = region === undefined ? image.image : await params.cropImage(image, region)
        const recognized = await recognizer.recognize(target)
        // Reconstruction is a pure function of the recognized lines; when it declines the page,
        // the engine's own line breaks are preserved.
        const text = (reconstructTableFromLines(recognized.lines) ?? recognized.text).trim()
        outcome.textByPage.set(image.page, text)
      } catch (error) {
        // One page that could not be read is one unresolved page, not a failed document.
        outcome.askedPages.delete(image.page)
        outcome.failedPages.add(image.page)
        outcome.failure ??= failureMessage(error)
      }
      // Read the instant recognition returns, because it is long and not preemptible.
      if (cancelled()) {
        outcome.cancelled = true
        break
      }
    }
  } catch (error) {
    if (error instanceof OcrCancelledError) {
      outcome.cancelled = true
    } else {
      // The stream or the renderer died mid-document: pages it never yielded never got their
      // attempt. A whole-page target among them is already reported unresolved by omission, but
      // a region target keeps its native text either way, so only this ledger records that its
      // region reading never happened.
      for (const page of params.pages) {
        if (!outcome.askedPages.has(page)) outcome.failedPages.add(page)
      }
      outcome.failure ??= failureMessage(error)
    }
  } finally {
    if (recognizer !== null) {
      try {
        await recognizer.close()
      } catch (closeError) {
        // Cleanup failure must not replace the original failure as the reported cause.
        outcome.failure ??= failureMessage(closeError)
      }
    }
  }

  return outcome
}

/**
 * Which text-bearing pages are worth a look for a qualifying picture.
 *
 * A page the extractor could not read is already going to be recognized whole; looking for
 * pictures on it would ask the same question twice.
 */
function regionCandidatePages(pages: readonly OcrSourcePage[]): number[] {
  return pages.filter((page) => !pageNeedsRecognition(page)).map((page) => page.page)
}

export async function readPdfPagesWithOcr(input: ReadPagesInput): Promise<OcrReadResult> {
  const now = input.now
  const startedAt = now()
  const dependencies = input.dependencies ?? {}
  const openDocument = dependencies.openDocument ?? openOcrPdfDocument
  const createRecognizer = dependencies.createRecognizer ?? createTesseractRecognizer
  const cropImage = dependencies.cropImage ?? cropToRegions
  const findImageRegions = dependencies.findImageRegions ?? findQualifyingImageRegions
  const cancelled = (): boolean => input.signal?.aborted === true

  const unread = input.pages.filter(pageNeedsRecognition).map((page) => page.page)
  // Every text-bearing page is looked at for a qualifying picture: the renderer reports drawing
  // operations, and a page that has none simply contributes no regions.
  const regionCandidates = regionCandidatePages(input.pages)

  let outcome: RecognitionOutcome = {
    textByPage: new Map<number, string>(),
    askedPages: new Set<number>(),
    failedPages: new Set<number>(),
    cancelled: cancelled(),
  }
  let regionsByPage = new Map<number, PageRegionSelection>()

  if (!outcome.cancelled && (unread.length > 0 || regionCandidates.length > 0)) {
    let document: OcrPdfDocument | null = null
    try {
      document = await openDocument(input.filePath)
      const regions = regionCandidates.length > 0
        ? await findImageRegions(
            document,
            regionCandidates,
            ...(input.signal === undefined ? [] : [input.signal]),
          )
        : []
      regionsByPage = new Map(regions.map((region) => [region.page, region]))

      const targets = [...new Set([...unread, ...regionsByPage.keys()])].sort(
        (left, right) => left - right,
      )
      if (targets.length > 0) {
        outcome = await recognizeSelectedPages({
          document,
          pages: targets,
          regionsByPage,
          createRecognizer,
          cropImage,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      }
    } catch (error) {
      if (error instanceof OcrCancelledError) {
        outcome.cancelled = true
      } else {
        // Opening the renderer and inspecting drawing operations are the only way to establish
        // whether a text-bearing page carries a pictured region. If either fails, every page
        // still awaiting that inspection is unresolved even though its native text survives.
        for (const page of regionCandidates) outcome.failedPages.add(page)
        outcome.failure ??= failureMessage(error)
      }
    } finally {
      if (document !== null) {
        try {
          await document.close()
        } catch (closeError) {
          outcome.failure ??= failureMessage(closeError)
        }
      }
    }
  }

  const pages: PdfPageReadResult[] = input.pages.map((source) => {
    if (pageNeedsRecognition(source)) {
      const text = outcome.textByPage.get(source.page)?.trim() ?? ''
      if (text.length > 0) {
        return {
          page: source.page,
          markdown: text,
          status: 'read',
          source: 'ocr',
          originallyNeededOcr: true,
        }
      }
      return {
        page: source.page,
        markdown: '',
        status: outcome.askedPages.has(source.page) ? 'empty' : 'unresolved',
        source: 'none',
        originallyNeededOcr: true,
      }
    }

    const native = source.markdown.trim()
    const reading = outcome.textByPage.get(source.page)?.trim() ?? ''
    const merged = reading.length > 0 ? mergeRegionText(native, reading) : native
    return {
      page: source.page,
      markdown: merged,
      status: 'read',
      source: merged === native ? 'pdf' : 'mixed',
      originallyNeededOcr: false,
    }
  })

  // A page is unresolved when no reader answered for it — including a text-bearing page whose
  // region attempt failed, because what the picture said is then a gap, not a fact.
  const unresolvedPages = [
    ...new Set([
      ...pages.filter((page) => page.status === 'unresolved').map((page) => page.page),
      ...outcome.failedPages,
    ]),
  ].sort((left, right) => left - right)
  // Empty means whole-page recognition ran and found nothing. A text-bearing page whose region
  // reading came back blank is not empty — its words came from the text layer.
  const wholePageTargets = new Set(unread)
  const requestedPages = [...new Set([...unread, ...regionsByPage.keys()])].sort(
    (left, right) => left - right,
  )

  return {
    status: outcome.cancelled ? 'cancelled' : unresolvedPages.length > 0 ? 'partial' : 'complete',
    contractVersion: OCR_CONTRACT_VERSION,
    contractIdentity: ocrContractIdentity(),
    engine: OCR_ENGINE,
    pages,
    requestedPages,
    readPages: [...outcome.textByPage.entries()]
      .filter(([, text]) => text.trim().length > 0)
      .map(([page]) => page)
      .sort((left, right) => left - right),
    emptyPages: [...outcome.askedPages]
      .filter(
        (page) =>
          wholePageTargets.has(page) && (outcome.textByPage.get(page)?.trim() ?? '').length === 0,
      )
      .sort((left, right) => left - right),
    unresolvedPages,
    elapsedMs: now() - startedAt,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
  }
}
