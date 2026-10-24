import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_IMAGE_COVERAGE,
  MIN_SINGLE_IMAGE_AREA_PT2,
  findQualifyingImageRegions,
  regionFromPlacement,
  qualifyingRegionsForPage,
  type PageDrawingOperations,
} from '../../ocr/image-regions.js'
import type { OcrPdfDocument, PageImage } from '../../ocr/contract.js'
import { MIXED_OCR_FIXTURE } from '../mixed-ocr-expectations.js'

const LETTER = { width: 612, height: 792 }

function makePage(
  page: number,
  images: PageDrawingOperations['images'],
  overrides: Partial<PageDrawingOperations> = {},
): PageDrawingOperations {
  return { page, images, pageBox: LETTER, rotation: 0, ...overrides }
}

/** The fixture's own two cases, stated as the generator draws them. */
const LOGO = { x: 460, y: 700, width: 80, height: 40, areaPt2: MIXED_OCR_FIXTURE.logoAreaPt2 }
const FIGURE = { x: 60, y: 300, width: 320, height: 160, areaPt2: MIXED_OCR_FIXTURE.figureAreaPt2 }

test('qualifyingRegionsForPage: a small logo does not earn recognition', () => {
  // 3 200 pt² on a 484 704 pt² page is 0.66 % coverage: under both rules with room to spare.
  assert.equal(MIXED_OCR_FIXTURE.logoAreaPt2, 3_200)
  assert.ok(MIXED_OCR_FIXTURE.logoAreaPt2 < MIN_SINGLE_IMAGE_AREA_PT2)
  assert.ok(MIXED_OCR_FIXTURE.logoAreaPt2 / MIXED_OCR_FIXTURE.pageAreaPt2 < MIN_IMAGE_COVERAGE)

  assert.equal(qualifyingRegionsForPage(makePage(MIXED_OCR_FIXTURE.logoPage, [LOGO])), null)
})

test('qualifyingRegionsForPage: a qualifying figure earns recognition', () => {
  // 51 200 pt² is 10.6 % coverage: over both rules with room to spare.
  assert.equal(MIXED_OCR_FIXTURE.figureAreaPt2, 51_200)
  assert.ok(MIXED_OCR_FIXTURE.figureAreaPt2 >= MIN_SINGLE_IMAGE_AREA_PT2)
  assert.ok(MIXED_OCR_FIXTURE.figureAreaPt2 / MIXED_OCR_FIXTURE.pageAreaPt2 >= MIN_IMAGE_COVERAGE)

  const selection = qualifyingRegionsForPage(makePage(MIXED_OCR_FIXTURE.figurePage, [FIGURE]))

  assert.ok(selection)
  assert.equal(selection.page, MIXED_OCR_FIXTURE.figurePage)
  assert.deepEqual(selection.pageBox, LETTER)
  assert.deepEqual(selection.boxes, [{ x: 60, y: 300, width: 320, height: 160 }])
})

test('qualifyingRegionsForPage: many small marks together do not qualify one of them', () => {
  // Coverage alone is not enough: without one image over the single-image floor, a page of
  // decorative marks would go to the recogniser.
  const manyLogos = Array.from({ length: 12 }, (_unused, index) => ({
    ...LOGO,
    y: 100 + index * 50,
  }))
  const coverage = manyLogos.reduce((sum, mark) => sum + mark.areaPt2, 0) / MIXED_OCR_FIXTURE.pageAreaPt2
  assert.ok(coverage >= MIN_IMAGE_COVERAGE, 'These marks clear the coverage rule together')

  assert.equal(qualifyingRegionsForPage(makePage(2, manyLogos)), null)
})

test('qualifyingRegionsForPage: a rotated page declines rather than guessing at its geometry', () => {
  assert.equal(
    qualifyingRegionsForPage(makePage(4, [FIGURE], { rotation: 90 })),
    null,
    'The crop arithmetic is stated for upright pages',
  )
})

test('qualifyingRegionsForPage: a page with no usable box reports nothing', () => {
  assert.equal(qualifyingRegionsForPage(makePage(4, [FIGURE], { pageBox: { width: 0, height: 792 } })), null)
  assert.equal(
    qualifyingRegionsForPage(makePage(4, [{ ...FIGURE, width: Number.NaN }])),
    null,
  )
})

test('regionFromPlacement: an image box is the unit square it paints into, under the transform', () => {
  // A 320 x 160 image placed at (60, 300) is the transform [320, 0, 0, 160, 60, 300].
  assert.deepEqual(regionFromPlacement([320, 0, 0, 160, 60, 300]), {
    x: 60,
    y: 300,
    width: 320,
    height: 160,
    areaPt2: 51_200,
  })

  // A flipped image still occupies the same rectangle, and area stays positive.
  assert.deepEqual(regionFromPlacement([320, 0, 0, -160, 60, 460]), {
    x: 60,
    y: 300,
    width: 320,
    height: 160,
    areaPt2: 51_200,
  })
})

test('findQualifyingImageRegions: a document that cannot report drawing operations reports none', async () => {
  const document: OcrPdfDocument = {
    pageCount: 13,
    async renderPage(page: number): Promise<PageImage> {
      return { page, image: Uint8Array.of(page), width: 1, height: 1 }
    },
    async close(): Promise<void> {},
  }

  assert.deepEqual(await findQualifyingImageRegions(document, [2, 4]), [])
})

test('findQualifyingImageRegions: only qualifying pages are returned, in page order', async () => {
  const operations = new Map<number, PageDrawingOperations>([
    [MIXED_OCR_FIXTURE.logoPage, makePage(MIXED_OCR_FIXTURE.logoPage, [LOGO])],
    [MIXED_OCR_FIXTURE.figurePage, makePage(MIXED_OCR_FIXTURE.figurePage, [FIGURE])],
  ])
  const document: OcrPdfDocument = {
    pageCount: 13,
    async renderPage(page: number): Promise<PageImage> {
      return { page, image: Uint8Array.of(page), width: 1, height: 1 }
    },
    async close(): Promise<void> {},
    async readPageDrawingOperations(page: number) {
      return operations.get(page) ?? makePage(page, [])
    },
  }

  assert.deepEqual(
    (await findQualifyingImageRegions(document, [4, 2, 1])).map((region) => region.page),
    [MIXED_OCR_FIXTURE.figurePage],
  )
})
