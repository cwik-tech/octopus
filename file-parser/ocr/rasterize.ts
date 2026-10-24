/**
 * PDF rendering for recognition: document lifetime, page cleanup, streaming page images, and
 * region cropping.
 *
 * Nothing here recognizes text, and nothing outside this module opens a PDF for OCR. The
 * renderer is imported lazily, so importing the parser — and parsing non-PDF files — never
 * pays for it; a PDF with pages always loads it, because every text-bearing page is inspected
 * for qualifying pictures and every unread page is rendered. The recognition engine loads
 * later still, so a document whose text layer is complete and carries no qualifying picture
 * never starts it. That inspection price is measured in the ADR.
 *
 * The renderer is `pdfjs-dist` directly, because recognition owns the document's memory: each
 * rendered page is cleaned up before the next is touched, and closing the document destroys the
 * worker. `pdf-to-img`, which the visual-recovery renderer uses, exposes neither page cleanup
 * nor document destruction, and measured 15 MB retained per rendered page.
 */
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import sharp from 'sharp'
import {
  OcrCancelledError,
  type OcrPdfDocument,
  type OcrRegionBox,
  type PageDrawnImage,
  type PageImage,
  type PageRegionSelection,
  type PdfMatrix,
} from './contract.js'
import { regionFromPlacement } from './image-regions.js'

/**
 * How far a crop reaches past the regions it covers.
 *
 * The engine misses words that sit on the very edge of its input, so the padding keeps a region
 * boundary from becoming a word boundary. Ten points is a line's worth at body size.
 */
export const REGION_CROP_PADDING_PT = 10

/** The numeric operator codes this walk understands, injected so the renderer stays lazy. */
export interface ImageOperatorCodes {
  save: number
  restore: number
  transform: number
  paintImageXObject: number
  paintInlineImageXObject: number
  paintImageXObjectRepeat: number
  paintInlineImageXObjectGroup: number
}

/** The checked parts of the @napi-rs/canvas Canvas that pdf.js creates in Node. */
export interface NodeCanvas {
  readonly canvasContext: CanvasRenderingContext2D
  toBuffer(mime: 'image/png'): Buffer
}

function isNodeCanvasContext(
  value: unknown,
  canvas: object,
): value is CanvasRenderingContext2D {
  if (typeof value !== 'object' || value === null) return false
  if (Reflect.get(value, 'canvas') !== canvas) return false
  return ['save', 'restore', 'transform', 'drawImage'].every(
    (method) => typeof Reflect.get(value, method) === 'function',
  )
}

/**
 * Prove a value is the canvas pdf.js hands out in Node.
 *
 * pdf.js types `PDFDocumentProxy.canvasFactory` as `Object` and the render target as
 * `HTMLCanvasElement` (types/src/display/api.d.ts), but in Node its own NodeCanvasFactory
 * supplies an @napi-rs/canvas Canvas (legacy/build/pdf.mjs, NodeCanvasFactory._createCanvas).
 * This boundary validates the canvas, its 2D context, and the PNG result. PDF.js supports
 * rendering through `canvasContext` with `canvas: null`, so no DOM-canvas assertion is needed.
 */
export function proveNodeCanvas(value: unknown): NodeCanvas {
  if (typeof value !== 'object' || value === null) {
    throw new Error('pdfjs-dist did not supply its Node canvas')
  }
  const getContext: unknown = Reflect.get(value, 'getContext')
  const toBuffer: unknown = Reflect.get(value, 'toBuffer')
  if (typeof getContext !== 'function' || typeof toBuffer !== 'function') {
    throw new Error('pdfjs-dist did not supply its Node canvas')
  }
  const canvasContext: unknown = Reflect.apply(getContext, value, ['2d'])
  if (!isNodeCanvasContext(canvasContext, value)) {
    throw new Error('pdfjs-dist did not supply its Node canvas 2D context')
  }
  return {
    canvasContext,
    toBuffer(mime) {
      const image: unknown = Reflect.apply(toBuffer, value, [mime])
      if (!Buffer.isBuffer(image)) {
        throw new Error('pdfjs-dist Node canvas did not return a PNG buffer')
      }
      return image
    },
  }
}

/** The part of pdf.js's canvas factory this renderer uses. */
interface NodeCanvasFactory {
  create(width: number, height: number): { canvas: unknown }
  destroy(entry: { canvas: unknown }): void
}

function isNodeCanvasFactory(value: unknown): value is NodeCanvasFactory {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'create') === 'function' &&
    typeof Reflect.get(value, 'destroy') === 'function'
  )
}

/** The parts of a resolved operator list the walk reads. */
export interface PageOperatorList {
  fnArray: ArrayLike<number>
  argsArray: unknown[][]
}

/** Matrix `m2` applied after matrix `m1`, in PDF's row form. */
function composeMatrix(m1: PdfMatrix, m2: PdfMatrix): PdfMatrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

function finiteSix(value: unknown): PdfMatrix | null {
  if (!Array.isArray(value) || value.length !== 6) return null
  if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null
  const [a, b, c, d, e, f] = value
  return [a, b, c, d, e, f]
}

/** A repeat group's positions arrive as a Float32Array; a plain array is the same shape. */
function isNumberSequence(value: unknown): value is ArrayLike<number> {
  return Array.isArray(value) || value instanceof Float32Array
}

/**
 * The image placements of one page's drawing instructions, in PDF user space.
 *
 * The walk mirrors the renderer's own canvas pass: an image paints into the unit square under
 * the transform in effect, so the graphics-state transform stack is all the placement needs.
 * The origin offset moves the boxes into the page's own frame when a media box does not start
 * at (0, 0).
 *
 * Two ops arrive pre-packed by the worker's optimizer. A repeat group is a collapsed
 * save/transform/paint/restore block: `[name, scaleX, scaleY, positions]` with `positions` a
 * Float32Array of (x, y) pairs, and each position paints the unit square under
 * `[scaleX, 0, 0, scaleY, x, y]` — the scale entries are the original transforms' a and d, so
 * the intrinsic pixel size plays no part (pdf.worker.mjs queueGroupedOps; pdf.mjs
 * CanvasGraphics.paintImageXObjectRepeat). An inline image group packs a run of inline images
 * into one bitmap: `[imgData, map]`, where every map entry carries its original transform and
 * paints the unit square under it (pdf.mjs CanvasGraphics.paintInlineImageXObjectGroup).
 *
 * Malformed arguments are dropped rather than fatal: a page whose instructions do not validate
 * simply reports fewer placements, which is the conservative answer for region recognition.
 * Image masks (`paintImageMaskXObject`) are stencil bits for other drawing, not pictures a
 * reader could read, so they are not placements.
 */
export function imagePlacementsFromOperatorList(
  operatorList: PageOperatorList,
  codes: ImageOperatorCodes,
  originOffset: { x: number; y: number } = { x: 0, y: 0 },
): PageDrawnImage[] {
  const images: PageDrawnImage[] = []
  let ctm: PdfMatrix = [1, 0, 0, 1, -originOffset.x, -originOffset.y]
  const stack: PdfMatrix[] = []

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index]
    const args = operatorList.argsArray[index] ?? []
    if (fn === codes.save) {
      stack.push(ctm)
    } else if (fn === codes.restore) {
      ctm = stack.pop() ?? ctm
    } else if (fn === codes.transform) {
      // The transform op's args are the six matrix entries themselves, not a wrapped array.
      const matrix = finiteSix(args)
      if (matrix !== null) ctm = composeMatrix(ctm, matrix)
    } else if (fn === codes.paintImageXObject || fn === codes.paintInlineImageXObject) {
      images.push(regionFromPlacement(ctm))
    } else if (fn === codes.paintImageXObjectRepeat) {
      const [, scaleX, scaleY, positions] = args
      if (
        typeof scaleX !== 'number' ||
        !Number.isFinite(scaleX) ||
        typeof scaleY !== 'number' ||
        !Number.isFinite(scaleY) ||
        !isNumberSequence(positions)
      ) continue
      for (let at = 0; at + 1 < positions.length; at += 2) {
        const x = positions[at]
        const y = positions[at + 1]
        if (typeof x !== 'number' || typeof y !== 'number') continue
        images.push(regionFromPlacement(composeMatrix(ctm, [scaleX, 0, 0, scaleY, x, y])))
      }
    } else if (fn === codes.paintInlineImageXObjectGroup) {
      const map = args[1]
      if (!Array.isArray(map)) continue
      for (const entry of map) {
        if (typeof entry !== 'object' || entry === null) continue
        const matrix = finiteSix(Reflect.get(entry, 'transform'))
        if (matrix !== null) images.push(regionFromPlacement(composeMatrix(ctm, matrix)))
      }
    }
  }
  return images
}

/**
 * Open a PDF for recognition.
 *
 * The renderer is imported here rather than at module load, so importing the parser costs
 * nothing. The document itself opens — and PDF.js loads — whenever the coordinating read has
 * a page to recognize or a text-bearing page to inspect for qualifying pictures, which is any
 * PDF with pages at all. What still never loads for a complete text layer is the recognition
 * engine.
 */
export async function openOcrPdfDocument(filePath: string): Promise<OcrPdfDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const require = createRequire(import.meta.url)
  const pdfjsPath = path.dirname(require.resolve('pdfjs-dist/package.json'))
  const data = new Uint8Array(await fs.readFile(filePath))
  const document = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: path.join(pdfjsPath, `standard_fonts${path.sep}`),
    cMapUrl: path.join(pdfjsPath, `cmaps${path.sep}`),
    cMapPacked: true,
  }).promise

  const factory: unknown = document.canvasFactory
  if (!isNodeCanvasFactory(factory)) {
    await document.destroy()
    throw new Error('pdfjs-dist did not supply its Node canvas factory')
  }

  const openPage = async (page: number) => document.getPage(page)

  return {
    pageCount: document.numPages,
    async renderPage(page, dpi) {
      const pdfPage = await openPage(page)
      try {
        const viewport = pdfPage.getViewport({ scale: dpi / 72 })
        const canvasEntry = factory.create(viewport.width, viewport.height)
        let image: Uint8Array
        try {
          const canvas = proveNodeCanvas(canvasEntry.canvas)
          await pdfPage.render({ canvas: null, canvasContext: canvas.canvasContext, viewport }).promise
          image = new Uint8Array(canvas.toBuffer('image/png'))
        } finally {
          // The canvas surface is a page-sized raster: hand it back before the PNG leaves,
          // or the collector keeps native surfaces alive for lack of heap pressure.
          factory.destroy(canvasEntry)
        }
        // The PNG header carries the extent a crop needs; sharp reads it without decoding pixels.
        const metadata = await sharp(image).metadata()
        return {
          page,
          image,
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
        }
      } finally {
        // One page's operator list, image data and canvases are released before the next page
        // is touched: memory must grow with one rendered page, not with the document.
        pdfPage.cleanup()
      }
    },
    async readPageDrawingOperations(page) {
      const pdfPage = await openPage(page)
      try {
        const operatorList = await pdfPage.getOperatorList()
        const [x1, y1, x2, y2] = pdfPage.view
        return {
          page,
          images: imagePlacementsFromOperatorList(
            operatorList,
            pdfjs.OPS,
            { x: x1 ?? 0, y: y1 ?? 0 },
          ),
          pageBox: { width: (x2 ?? 0) - (x1 ?? 0), height: (y2 ?? 0) - (y1 ?? 0) },
          rotation: pdfPage.rotate,
        }
      } finally {
        pdfPage.cleanup()
      }
    },
    async close() {
      // Destroys the document and terminates its worker; a close that skipped this would keep
      // every page's retained resources until process exit.
      await document.destroy()
    },
  }
}

export interface StreamPageImagesOptions {
  /** 1-based page numbers. Anything outside the document is ignored. */
  pages: readonly number[]
  dpi?: number
  signal?: AbortSignal
}

/**
 * Render selected pages one at a time, in ascending order.
 *
 * A generator rather than an array, so a document's page images never all exist at once: the
 * consumer releases each page before the next is rendered. Cancellation is read before every
 * render, because one page's render is not preemptible.
 */
export async function* streamPageImages(
  document: OcrPdfDocument,
  options: StreamPageImagesOptions,
): AsyncIterable<PageImage> {
  // Read through a call: after one direct `signal.aborted === true` check the compiler narrows
  // the property to `false` and every later check becomes provably dead code.
  const cancelled = (): boolean => options.signal?.aborted === true
  const dpi = options.dpi ?? 200

  for (const page of [...new Set(options.pages)].sort((left, right) => left - right)) {
    if (cancelled()) throw new OcrCancelledError()
    if (!Number.isInteger(page) || page < 1 || page > document.pageCount) continue
    yield await document.renderPage(page, dpi)
  }
  if (cancelled()) throw new OcrCancelledError()
}

/** One box measurement, when it really is four finite numbers with a positive extent. */
function validRegionBox(value: OcrRegionBox): OcrRegionBox | null {
  const { x, y, width, height } = value
  if (![x, y, width, height].every((coordinate) => Number.isFinite(coordinate))) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * The part of a box that lies on the page, in the box's own coordinates.
 *
 * A renderer may report a placement that reaches past the page edge or misses the page entirely.
 * Only the intersection is real: anything else would hand the engine an extract area outside the
 * image, which sharp refuses, so an empty intersection is no box at all.
 */
function clipRegionBoxToPage(
  value: OcrRegionBox,
  pageBox: { width: number; height: number },
): OcrRegionBox | null {
  const x = Math.max(value.x, 0)
  const y = Math.max(value.y, 0)
  const width = Math.min(value.x + value.width, pageBox.width) - x
  const height = Math.min(value.y + value.height, pageBox.height) - y
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * Cut the padded union of a page's regions out of its rendered image.
 *
 * The boxes arrive in page points with the origin at the bottom-left; the rendered image counts
 * pixels from the top-left. Each box is clipped to the page first, so a placement that reaches
 * past the edge contributes only its on-page part, and the padding is clamped at the page edge,
 * because a crop that reached outside the page would hand the engine invented margins.
 *
 * A page whose boxes or page box do not validate is read whole rather than not read: a
 * geometrically invalid region must not cost the page its recognition.
 */
export async function cropToRegions(
  image: PageImage,
  region: PageRegionSelection,
): Promise<Uint8Array> {
  const { width: pageWidth, height: pageHeight } = region.pageBox
  if (![pageWidth, pageHeight].every((extent) => Number.isFinite(extent) && extent > 0)) {
    return image.image
  }
  if (image.width <= 0 || image.height <= 0) return image.image

  const boxes = region.boxes
    .map(validRegionBox)
    .filter((box): box is OcrRegionBox => box !== null)
    .map((box) => clipRegionBoxToPage(box, region.pageBox))
    .filter((box): box is OcrRegionBox => box !== null)
  if (boxes.length === 0) return image.image

  const scale = image.width / pageWidth

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }

  const left = Math.round(Math.max(0, (minX - REGION_CROP_PADDING_PT) * scale))
  const right = Math.round(Math.min(image.width, (maxX + REGION_CROP_PADDING_PT) * scale))
  const top = Math.round(Math.max(0, (pageHeight - maxY - REGION_CROP_PADDING_PT) * scale))
  const bottom = Math.round(Math.min(image.height, (pageHeight - minY + REGION_CROP_PADDING_PT) * scale))
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)

  return Uint8Array.from(
    await sharp(Buffer.from(image.image))
      .extract({ left, top, width, height })
      .png()
      .toBuffer(),
  )
}
