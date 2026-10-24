/**
 * One versioned contract for every way this package reads a page it could not extract.
 *
 * Everything here is either a shape crossing the boundary between pure logic and the modules
 * that do input and output, or a setting that changes what recognition returns. A change to a
 * recognition setting is a change to {@link OCR_CONTRACT_VERSION}, because a stored result
 * produced under an older setting is no longer the result this contract describes.
 */

/**
 * What became of a page, which is not the same question as where its text came from.
 *
 * - `read` — native extraction or recognition returned usable content.
 * - `empty` — a reader ran and found nothing. A genuinely blank page.
 * - `unresolved` — no successful reader established whether the page was blank. Its emptiness
 *   is a gap, not a fact about the document, and anything that stores or serves it has to say
 *   so; otherwise the next reader cannot tell it apart from `empty` and never goes back for it.
 */
export type PdfPageReadStatus = 'read' | 'empty' | 'unresolved'

/**
 * Where a page's final text came from.
 *
 * `mixed` means the page carries native text plus recognized content from one or more embedded
 * image regions. `none` means nothing read it.
 */
export type PdfPageTextSource = 'pdf' | 'ocr' | 'mixed' | 'none'

/** One page of the deterministic document, with the provenance a reader needs to trust it. */
export interface PdfPageReadResult {
  /** 1-based, as page numbers are at every application boundary. */
  page: number
  /** The text to use for this page. Empty exactly when `source` is `none`. */
  markdown: string
  status: PdfPageReadStatus
  source: PdfPageTextSource
  /** True when the structural extractor could not read the page, whatever happened afterwards. */
  originallyNeededOcr: boolean
}

/**
 * The outcome of one document's recognition.
 *
 * `partial` means at least one page that needed reading was not read. A caller that reports a
 * partial document as complete has told somebody the words are all there when they are not.
 */
export type OcrReadStatus = 'complete' | 'partial' | 'cancelled'

/**
 * What local OCR did to one document, as the parse manifest records it.
 *
 * Page-level source and status detail lives in `<file>.parse.json`; this summary is what a
 * consumer needs to decide whether the deterministic document is complete.
 */
export interface PdfOcrSummary {
  /** The recognition settings this result was produced under. */
  contractVersion: number
  contractIdentity: string
  engine: string
  status: OcrReadStatus
  /** True when recognition contributed text to the document. */
  applied: boolean
  /** 1-based page numbers, ascending. */
  requestedPages: number[]
  readPages: number[]
  emptyPages: number[]
  unresolvedPages: number[]
  elapsedMs: number
}

/**
 * Version 1 is the first contract in which this package recognizes text itself. Version 2 adds
 * recognition of qualifying image regions on text-bearing pages, which changes what the same
 * document's reading contains.
 */
export const OCR_CONTRACT_VERSION = 2

/** The recognition engine this contract is measured against. */
export const OCR_ENGINE = 'tesseract.js'

/** The only bundled language. Adding another is a separate product decision. */
export const OCR_LANGUAGE = 'eng'

/**
 * The recognition settings, named so a change to any of them is visible as a contract change.
 *
 * The engine's **default page segmentation** is selected by the absence of an override, and it
 * is the reading that keeps a table's rows whole — one row per line, with word positions
 * recoverable — which is what table reconstruction clusters. Sparse-text segmentation returns
 * every cell as its own paragraph and destroys row structure.
 */
export interface OcrIndexProfile {
  engine: 'LSTM_ONLY'
  pageSegmentation: 'default'
  preserveInterwordSpaces: boolean
  /** Rasterization resolution in dots per inch. */
  dpi: number
  /** Whether qualifying image regions on text-bearing pages are recognized. */
  regionRecognition: boolean
}

export function ocrIndexProfile(): OcrIndexProfile {
  return {
    engine: 'LSTM_ONLY',
    pageSegmentation: 'default',
    preserveInterwordSpaces: true,
    dpi: 200,
    regionRecognition: true,
  }
}

/**
 * The identity a stored parse result carries so a later contract change regenerates it.
 *
 * Every field that changes what recognition returns is in the string. A result recorded under a
 * different identity was produced by different settings and cannot be reused.
 */
export function ocrContractIdentity(): string {
  const profile = ocrIndexProfile()
  return [
    `v${OCR_CONTRACT_VERSION}`,
    OCR_ENGINE,
    OCR_LANGUAGE,
    profile.engine,
    profile.pageSegmentation,
    `${profile.dpi}dpi`,
    `spaces=${profile.preserveInterwordSpaces ? '1' : '0'}`,
    `regions=${profile.regionRecognition ? '1' : '0'}`,
  ].join(':')
}

/** The x extent a recognized word occupies, which is all column association needs. */
export interface OcrWordBox {
  text: string
  x0: number
  x1: number
}

/** One recognized line: its text, its box, and its words. */
export interface OcrLineBox {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
  words: OcrWordBox[]
}

/** A recognized page: the engine's own text, which is authoritative, and the geometry it found. */
export interface RecognizedPage {
  text: string
  lines: OcrLineBox[]
}

/** The recognition seam, so the composition can be exercised without starting a real engine. */
export interface TextRecognizer {
  recognize(image: Uint8Array): Promise<RecognizedPage>
  close(): Promise<void>
}

/** One rendered page. PNG bytes, with the pixel extent a crop needs. */
export interface PageImage {
  /** 1-based, matching every other page number in this package. */
  page: number
  image: Uint8Array
  width: number
  height: number
}

/** A box in the page's own coordinate system: points, origin bottom-left, y rising. */
export interface OcrRegionBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * An open PDF, and the right to close it.
 *
 * Opening a document is the expensive part of reading one, so a whole parse shares one handle:
 * page selection, rendering and region inspection all work from it, and whoever opened it is the
 * only one entitled to release it.
 */
export interface OcrPdfDocument {
  pageCount: number
  /** Render one page to PNG bytes and release that page's resources before returning. */
  renderPage(page: number, dpi: number): Promise<PageImage>
  /**
   * One page's image placements, when this renderer can report them.
   *
   * Optional because finding a picture on a page the extractor already read is a question about
   * drawing instructions, and a renderer that cannot answer it must report no regions rather
   * than guess. A document without this method simply does no region recognition.
   */
  readPageDrawingOperations?(page: number): Promise<PageDrawingOperations>
  close(): Promise<void>
}

/** An affine transform in PDF's row form: [a, b, c, d, e, f]. */
export type PdfMatrix = readonly [number, number, number, number, number, number]

/** One image placed on a page, in PDF user space: points, origin bottom-left, y rising. */
export interface PageDrawnImage extends OcrRegionBox {
  /** Device-space area in square points: |det CTM| for the unit square the image paints into. */
  areaPt2: number
}

/** What one page draws, as far as region recognition is concerned. */
export interface PageDrawingOperations {
  page: number
  images: readonly PageDrawnImage[]
  /** The page box the boxes above are measured in. */
  pageBox: { width: number; height: number }
  /** Page rotation in degrees. Anything but zero declines to qualify. */
  rotation: number
}

/** Qualifying image regions on one page, and the page box they are measured in. */
export interface PageRegionSelection {
  page: number
  boxes: readonly OcrRegionBox[]
  pageBox: { width: number; height: number }
}

/**
 * Cancellation is an expected outcome, not a parser error.
 *
 * Raised where a cancellation is observed inside input or output work, so the coordinating read
 * can report the operation as cancelled rather than as a document that failed.
 */
export class OcrCancelledError extends Error {
  constructor() {
    super('OCR was cancelled.')
    this.name = 'OcrCancelledError'
  }
}

/**
 * Whether a stored parse result was produced under the recognition settings in force now.
 *
 * A stored result is external input: it was written by whatever version of this package was
 * installed when it ran, so it is read as `unknown` and validated rather than trusted. A result
 * whose recognition summary names a different contract identity cannot be reused, because
 * different settings produce a different reading of the same page. A result with no recognition
 * summary at all passes here either way: whether it predates local recognition or the current
 * parser legitimately produced none is a staleness question, and the orchestrator's
 * `pdfOcrResultIsUnfinished` answers it from the contract identity the parser records in
 * metadata.
 */
export function parsedResultMatchesOcrContract(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return true
  const ocr: unknown = Reflect.get(entry, 'ocr')
  if (ocr === undefined || ocr === null) return true
  if (typeof ocr !== 'object') return false
  return Reflect.get(ocr, 'contractIdentity') === ocrContractIdentity()
}

/**
 * Page lists in a stored summary are one-based and ascending: zero, negative, and fractional
 * numbers are not pages this package wrote.
 */
function wholePageList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((page: unknown): page is number => typeof page === 'number' && Number.isInteger(page) && page >= 1)) {
    return null
  }
  return [...value].sort((left, right) => left - right)
}

/**
 * The one validator every consumer of a stored OCR summary trusts, failing closed.
 *
 * A manifest is persisted external input: it may have been written by an older parser, a newer
 * one, or a hand edit. Anything that is not exactly the shape the PDF parser writes —
 * a status outside the declared union, a missing or malformed page list, a page number that is
 * not a positive one-based integer — is `null`, and `null` must route to distrust: the
 * orchestrator reparses, the reader gate keeps asking for a reader. Trusting a record that only
 * resembles the contract is how a document with unread pages gets served as complete, which is
 * the one failure that looks exactly like a correct answer.
 */
export function parsePdfOcrSummary(value: unknown): PdfOcrSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const status: unknown = Reflect.get(value, 'status')
  if (status !== 'complete' && status !== 'partial' && status !== 'cancelled') return null
  const contractVersion: unknown = Reflect.get(value, 'contractVersion')
  if (contractVersion !== OCR_CONTRACT_VERSION) return null
  const contractIdentity: unknown = Reflect.get(value, 'contractIdentity')
  if (contractIdentity !== ocrContractIdentity()) return null
  const engine: unknown = Reflect.get(value, 'engine')
  if (engine !== OCR_ENGINE) return null
  const applied: unknown = Reflect.get(value, 'applied')
  if (typeof applied !== 'boolean') return null
  const elapsedMs: unknown = Reflect.get(value, 'elapsedMs')
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null
  const requestedPages = wholePageList(Reflect.get(value, 'requestedPages'))
  const readPages = wholePageList(Reflect.get(value, 'readPages'))
  const emptyPages = wholePageList(Reflect.get(value, 'emptyPages'))
  const unresolvedPages = wholePageList(Reflect.get(value, 'unresolvedPages'))
  if (!requestedPages || !readPages || !emptyPages || !unresolvedPages) return null
  return {
    contractVersion,
    contractIdentity,
    engine,
    status,
    applied,
    requestedPages,
    readPages,
    emptyPages,
    unresolvedPages,
    elapsedMs,
  }
}
