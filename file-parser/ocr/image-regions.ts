/**
 * Which pages carry a picture worth reading on a page the extractor already read.
 *
 * The structural extractor decides a page is a scan from the balance of text to picture, so an
 * ordinary text page carrying one figure is never flagged and everything inside the figure is
 * unreachable. Finding those figures is not an extraction question — the text layer is complete
 * — it is a question about the page's drawing instructions.
 *
 * A page qualifies on two rules, both measured against the mixed fixture:
 *
 * - total image coverage of at least {@link MIN_IMAGE_COVERAGE} of the page — the fixture's logo
 *   covers 0.66 %, its figure 10.6 %, so 5 % separates them with room on both sides; and
 * - at least one single image of at least {@link MIN_SINGLE_IMAGE_AREA_PT2} square points — the
 *   logo is 3 200 pt², the figure 51 200 pt², so the floor keeps a page of many small marks away
 *   from the recognizer even when the marks together clear the coverage rule.
 *
 * This module returns validated page coordinates. It recognizes nothing.
 */
import {
  OcrCancelledError,
  type OcrPdfDocument,
  type OcrRegionBox,
  type PageDrawingOperations,
  type PageDrawnImage,
  type PageRegionSelection,
  type PdfMatrix,
} from './contract.js'

export type { PageDrawingOperations }

export const MIN_IMAGE_COVERAGE = 0.05
export const MIN_SINGLE_IMAGE_AREA_PT2 = 10_000

/**
 * The rectangle an image occupies on the page: the unit square it paints into, under the
 * transform in effect.
 *
 * A flipped or mirrored placement still occupies a rectangle, so the extents are taken from the
 * four transformed corners and the area from the determinant's magnitude.
 */
export function regionFromPlacement(ctm: PdfMatrix): PageDrawnImage {
  const [a, b, c, d, e, f] = ctm
  const xs = [e, a + e, c + e, a + c + e]
  const ys = [f, b + f, d + f, b + d + f]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
    areaPt2: Math.abs(a * d - b * c),
  }
}

function validBox(image: PageDrawnImage): OcrRegionBox | null {
  const { x, y, width, height, areaPt2 } = image
  if (![x, y, width, height, areaPt2].every((value) => Number.isFinite(value))) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * The qualifying regions on one page, or `null` when the page does not qualify.
 *
 * Pages turned sideways decline: the crop arithmetic is stated for upright pages, and declining
 * is the honest answer where qualifying would be a guess.
 */
export function qualifyingRegionsForPage(
  operations: PageDrawingOperations,
): PageRegionSelection | null {
  const { width, height } = operations.pageBox
  if (![width, height].every((extent) => Number.isFinite(extent) && extent > 0)) return null
  if (operations.rotation !== 0) return null

  const boxes: OcrRegionBox[] = []
  let totalArea = 0
  let largestArea = 0
  for (const image of operations.images) {
    const box = validBox(image)
    if (box === null) return null
    boxes.push(box)
    totalArea += image.areaPt2
    largestArea = Math.max(largestArea, image.areaPt2)
  }
  if (boxes.length === 0) return null

  const coverage = Math.min(1, totalArea / (width * height))
  if (coverage < MIN_IMAGE_COVERAGE) return null
  if (largestArea < MIN_SINGLE_IMAGE_AREA_PT2) return null

  return { page: operations.page, boxes, pageBox: { width, height } }
}

/**
 * Inspect the named pages for qualifying image regions.
 *
 * A renderer that cannot report drawing operations reports no regions, which turns region
 * recognition off rather than guessing at page geometry.
 */
export async function findQualifyingImageRegions(
  document: OcrPdfDocument,
  pages: readonly number[],
  signal?: AbortSignal,
): Promise<PageRegionSelection[]> {
  const readOperations = document.readPageDrawingOperations
  if (readOperations === undefined) return []

  const selections: PageRegionSelection[] = []
  for (const page of [...new Set(pages)].sort((left, right) => left - right)) {
    if (signal?.aborted === true) throw new OcrCancelledError()
    if (!Number.isInteger(page) || page < 1 || page > document.pageCount) continue
    const selection = qualifyingRegionsForPage(await readOperations.call(document, page))
    if (selection !== null) selections.push(selection)
  }
  return selections
}
