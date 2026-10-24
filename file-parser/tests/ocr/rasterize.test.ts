import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import sharp from 'sharp'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  REGION_CROP_PADDING_PT,
  cropToRegions,
  imagePlacementsFromOperatorList,
  openOcrPdfDocument,
  proveNodeCanvas,
  streamPageImages,
} from '../../ocr/rasterize.js'
import { OcrCancelledError, ocrIndexProfile, type OcrPdfDocument, type PageImage } from '../../ocr/contract.js'
import { MIXED_OCR_FIXTURE } from '../mixed-ocr-expectations.js'

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures')

/** A document that records what it was asked to render and when. */
function makeRecordingDocument(pageCount: number): OcrPdfDocument & {
  rendered: number[]
  peakConcurrentRenders: number
  closed: number
} {
  let inFlight = 0
  const state = {
    pageCount,
    rendered: [] as number[],
    peakConcurrentRenders: 0,
    closed: 0,
    async renderPage(page: number): Promise<PageImage> {
      inFlight += 1
      state.peakConcurrentRenders = Math.max(state.peakConcurrentRenders, inFlight)
      await Promise.resolve()
      state.rendered.push(page)
      inFlight -= 1
      return { page, image: Uint8Array.of(page), width: 10, height: 10 }
    },
    async close(): Promise<void> {
      state.closed += 1
    },
  }
  return state
}

test('streamPageImages: pages are rendered one at a time, in ascending order', async () => {
  const document = makeRecordingDocument(13)
  const seen: number[] = []

  for await (const image of streamPageImages(document, { pages: [12, 10, 10, 13] })) {
    // Nothing beyond the page just handed over may have been rendered yet: the point of the
    // stream is that a document's page images never all exist at once.
    assert.deepEqual(document.rendered, [...seen, image.page])
    seen.push(image.page)
  }

  assert.deepEqual(seen, [10, 12, 13])
  assert.equal(document.peakConcurrentRenders, 1)
})

test('streamPageImages: pages outside the document are ignored', async () => {
  const document = makeRecordingDocument(3)
  const seen: number[] = []

  for await (const image of streamPageImages(document, { pages: [0, 2, 4, -1] })) {
    seen.push(image.page)
  }

  assert.deepEqual(seen, [2])
})

test('streamPageImages: cancellation before the first render raises rather than rendering', async () => {
  const document = makeRecordingDocument(3)
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(async () => {
    for await (const _image of streamPageImages(document, { pages: [1], signal: controller.signal })) {
      assert.fail('No page should be rendered after cancellation')
    }
  }, OcrCancelledError)

  assert.deepEqual(document.rendered, [])
})

test('streamPageImages: cancellation between pages stops before the next render', async () => {
  const document = makeRecordingDocument(3)
  const controller = new AbortController()

  await assert.rejects(async () => {
    for await (const image of streamPageImages(document, {
      pages: [1, 2, 3],
      signal: controller.signal,
    })) {
      assert.equal(image.page, 1)
      controller.abort()
    }
  }, OcrCancelledError)

  assert.deepEqual(document.rendered, [1])
})

test('cropToRegions: the padded union of a page box is cut in image pixels', async () => {
  // Stated independently: a page 612 x 792 pt rendered at scale 2 is 1224 x 1584 px, and the
  // page-4 figure sits at (60, 300) and measures 320 x 160 pt with its origin bottom-left.
  // Padded by 10 pt and converted to top-left pixels that is x 100..780, y 644..1004.
  const expected = { left: 100, top: 644, width: 680, height: 360 }
  assert.equal(REGION_CROP_PADDING_PT, 10)

  const page = await sharp({
    create: { width: 1224, height: 1584, channels: 3, background: '#ffffff' },
  })
    .composite([
      {
        input: await sharp({
          create: { width: expected.width, height: expected.height, channels: 3, background: '#000000' },
        }).png().toBuffer(),
        left: expected.left,
        top: expected.top,
      },
    ])
    .png()
    .toBuffer()

  const cropped = await cropToRegions(
    { page: 4, image: page, width: 1224, height: 1584 },
    {
      page: 4,
      boxes: [{ x: 60, y: 300, width: 320, height: 160 }],
      pageBox: { width: 612, height: 792 },
    },
  )

  const { width, height } = await sharp(Buffer.from(cropped)).metadata()
  assert.equal(width, expected.width)
  assert.equal(height, expected.height)
  const { channels } = await sharp(Buffer.from(cropped)).stats()
  // Colour channels only: an opaque alpha channel is 255 everywhere and says nothing about ink.
  assert.deepEqual(
    channels.slice(0, 3).map((channel) => channel.max),
    [0, 0, 0],
    'The crop must contain only the region, not the white page around it',
  )
})

test('cropToRegions: a page whose boxes do not validate is read whole', async () => {
  const image: PageImage = { page: 4, image: Uint8Array.of(1, 2, 3), width: 100, height: 100 }

  assert.equal(
    await cropToRegions(image, {
      page: 4,
      boxes: [{ x: 0, y: 0, width: 0, height: -5 }],
      pageBox: { width: 612, height: 792 },
    }),
    image.image,
  )
  assert.equal(
    await cropToRegions(image, {
      page: 4,
      boxes: [{ x: 10, y: 10, width: 10, height: 10 }],
      pageBox: { width: 0, height: 792 },
    }),
    image.image,
  )
})

test('cropToRegions: a placement entirely outside the page is read whole, not extracted', async () => {
  // Stated independently: a page 612 x 792 pt rendered at scale 2 is 1224 x 1584 px, and a box
  // starting at x 700 pt never touches it. Extracting its padded union would ask sharp for an
  // area outside the image, so the page is read whole instead.
  const page = await sharp({
    create: { width: 1224, height: 1584, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  const image: PageImage = { page: 4, image: page, width: 1224, height: 1584 }

  const cropped = await cropToRegions(image, {
    page: 4,
    boxes: [{ x: 700, y: 300, width: 100, height: 160 }],
    pageBox: { width: 612, height: 792 },
  })

  assert.equal(cropped, image.image)
})

test('cropToRegions: a box reaching past the page edge is clipped to the page and still cropped', async () => {
  // Stated independently: the first box starts 100 pt off the left edge and reaches x 100 pt;
  // the second sits entirely past the right edge and intersects nothing. Clipped to the page,
  // only the first box survives, and its padded extent in top-left pixels is x 0..220,
  // y 644..1004 — the off-page boxes must neither widen the crop nor discard it.
  const expected = { left: 0, top: 644, width: 220, height: 360 }

  const page = await sharp({
    create: { width: 1224, height: 1584, channels: 3, background: '#ffffff' },
  })
    .composite([
      {
        input: await sharp({
          create: { width: expected.width, height: expected.height, channels: 3, background: '#000000' },
        }).png().toBuffer(),
        left: expected.left,
        top: expected.top,
      },
    ])
    .png()
    .toBuffer()

  const cropped = await cropToRegions(
    { page: 4, image: page, width: 1224, height: 1584 },
    {
      page: 4,
      boxes: [
        { x: -100, y: 300, width: 200, height: 160 },
        { x: 700, y: 300, width: 100, height: 160 },
      ],
      pageBox: { width: 612, height: 792 },
    },
  )

  const { width, height } = await sharp(Buffer.from(cropped)).metadata()
  assert.equal(width, expected.width)
  assert.equal(height, expected.height)
  const { channels } = await sharp(Buffer.from(cropped)).stats()
  // Colour channels only: an opaque alpha channel is 255 everywhere and says nothing about ink.
  assert.deepEqual(
    channels.slice(0, 3).map((channel) => channel.max),
    [0, 0, 0],
    'The crop must contain only the clipped region, not the white page around it',
  )
})

test('openOcrPdfDocument: drawing operations report the figure on page 4 and the logo on page 2', async () => {
  // Stated from the generator's drawing record (see mixed-ocr-expectations.ts): the logo is
  // 80 x 40 pt at (460, 700) and the figure 320 x 160 pt at (60, 300), on upright LETTER pages.
  const document = await openOcrPdfDocument(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName))
  try {
    assert.ok(
      document.readPageDrawingOperations,
      'A document opened for recognition must be able to report its drawing operations',
    )

    const figure = await document.readPageDrawingOperations(MIXED_OCR_FIXTURE.figurePage)
    assert.deepEqual(figure.pageBox, { width: 612, height: 792 })
    assert.equal(figure.rotation, 0)
    assert.deepEqual(figure.images, [
      { x: 60, y: 300, width: 320, height: 160, areaPt2: MIXED_OCR_FIXTURE.figureAreaPt2 },
    ])

    const logo = await document.readPageDrawingOperations(MIXED_OCR_FIXTURE.logoPage)
    assert.deepEqual(logo.images, [
      { x: 460, y: 700, width: 80, height: 40, areaPt2: MIXED_OCR_FIXTURE.logoAreaPt2 },
    ])
  } finally {
    await document.close()
  }
})

test('openOcrPdfDocument: close releases the document, so nothing can be rendered afterwards', async () => {
  const document = await openOcrPdfDocument(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName))
  await document.renderPage(MIXED_OCR_FIXTURE.imageOnlyPage, 72)
  await document.close()

  // The point of close is that the renderer's worker and its caches are actually gone: a
  // close that releases nothing would let this render succeed.
  await assert.rejects(() => document.renderPage(1, 72))
})

test('imagePlacementsFromOperatorList: the transform stack, inline images and groups place boxes', () => {
  // Stated independently from the renderer's own paint path (pdf.mjs CanvasGraphics): every
  // image op paints the unit square under the transform in effect.
  //
  // - `transform [2, 0, 0, 2, 3, 4]` then an inline paint is the box (3, 4, 2 x 2).
  // - `transform [100, 0, 0, 50, 10, 20]` then a named paint is (10, 20, 100 x 50); a further
  //   `transform [1, 0, 0, 1, 5, 5]` inside save/restore moves it to (510, 270), and restore
  //   returns to (10, 20). A malformed transform changes nothing.
  // - A repeat group is the worker optimizer's collapse of a save/transform/paint/restore
  //   block: args are [name, scaleX, scaleY, positions] with positions a Float32Array, and
  //   each position paints under [scaleX, 0, 0, scaleY, x, y] (pdf.worker.mjs queueGroupedOps,
  //   pdf.mjs paintImageXObjectRepeat). `['img2', 20, 10, [100, 200]]` is therefore a 20 x 10
  //   box at (100, 200) — the intrinsic pixel size plays no part in the placement.
  // - An inline image group carries each entry's original transform: {x: 7, y: 9} with
  //   [30, 0, 0, 15, 7, 9] is the box (7, 9, 30 x 15) (pdf.mjs paintInlineImageXObjectGroup).
  const images = imagePlacementsFromOperatorList(
    {
      fnArray: [
        OPS.save,
        OPS.transform,
        OPS.paintInlineImageXObject,
        OPS.restore,
        OPS.save,
        OPS.transform,
        OPS.paintImageXObject,
        OPS.save,
        OPS.transform,
        OPS.paintImageXObject,
        OPS.restore,
        OPS.transform,
        OPS.paintImageXObject,
        OPS.restore,
        OPS.paintImageXObjectRepeat,
        OPS.paintInlineImageXObjectGroup,
      ],
      argsArray: [
        [],
        [2, 0, 0, 2, 3, 4],
        [{}],
        [],
        [],
        [100, 0, 0, 50, 10, 20],
        ['img1'],
        [],
        [1, 0, 0, 1, 5, 5],
        ['img1'],
        [],
        ['not a matrix'],
        ['img1'],
        [],
        ['img2', 20, 10, Float32Array.from([100, 200])],
        [{}, [{ transform: [30, 0, 0, 15, 7, 9], x: 0, y: 0, w: 4, h: 2 }, { transform: 'bad' }]],
      ],
    },
    OPS,
  )

  assert.deepEqual(images, [
    { x: 3, y: 4, width: 2, height: 2, areaPt2: 4 },
    { x: 10, y: 20, width: 100, height: 50, areaPt2: 5_000 },
    { x: 510, y: 270, width: 100, height: 50, areaPt2: 5_000 },
    { x: 10, y: 20, width: 100, height: 50, areaPt2: 5_000 },
    { x: 100, y: 200, width: 20, height: 10, areaPt2: 200 },
    { x: 7, y: 9, width: 30, height: 15, areaPt2: 450 },
  ])
})

test('imagePlacementsFromOperatorList: repeat positions must be an indexed numeric sequence', () => {
  // The worker builds positions as a Float32Array (pdf.worker.mjs queueGroupedOps). Anything
  // without indexed numeric elements — a DataView views bytes, not elements — is not a
  // positions sequence, even if somebody patched indices onto it.
  const repeat = (positions: unknown) => ({
    fnArray: [OPS.paintImageXObjectRepeat],
    argsArray: [['img', 20, 10, positions]],
  })
  const box = { x: 100, y: 200, width: 20, height: 10, areaPt2: 200 }

  assert.deepEqual(imagePlacementsFromOperatorList(repeat(Float32Array.from([100, 200])), OPS), [box])
  assert.deepEqual(imagePlacementsFromOperatorList(repeat([100, 200]), OPS), [box])

  const patchedView = Object.assign(new DataView(new ArrayBuffer(16)), { 0: 100, 1: 200, length: 2 })
  for (const positions of [
    patchedView,
    Float64Array.from([100, 200]),
    Int32Array.from([100, 200]),
    BigInt64Array.from([100n, 200n]),
    '100,200',
    { 0: 100, 1: 200, length: 2 },
    { length: 2 },
  ]) {
    assert.deepEqual(
      imagePlacementsFromOperatorList(repeat(positions), OPS),
      [],
      'A positions value without genuinely indexed numeric elements declines the group',
    )
  }
})

test('proveNodeCanvas: the canvas boundary refuses anything but the Node canvas shape', () => {
  for (const value of [
    null,
    undefined,
    {},
    { toBuffer: 'not a function' },
    { toBuffer: () => Buffer.alloc(0) },
    { toBuffer: () => Buffer.alloc(0), getContext: () => null },
    42,
  ]) {
    assert.throws(() => proveNodeCanvas(value), /Node canvas/)
  }

  const canvas = {
    toBuffer: (mime: 'image/png') => Buffer.from(mime),
    getContext: (_contextType: '2d') => context,
  }
  const context = {
    canvas,
    save() {},
    restore() {},
    transform() {},
    drawImage() {},
  }

  const proven = proveNodeCanvas(canvas)
  assert.equal(proven.canvasContext, context)
  assert.deepEqual(proven.toBuffer('image/png'), Buffer.from('image/png'))
})

test('openOcrPdfDocument: the mixed fixture renders its pictured page at the profile resolution', async () => {
  const document = await openOcrPdfDocument(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName))
  try {
    assert.equal(document.pageCount, MIXED_OCR_FIXTURE.pageCount)

    const rendered = await document.renderPage(MIXED_OCR_FIXTURE.imageOnlyPage, ocrIndexProfile().dpi)

    // A 612 x 792 pt page at 200 dpi is 1700 x 2200 px.
    assert.equal(rendered.page, MIXED_OCR_FIXTURE.imageOnlyPage)
    assert.equal(rendered.width, Math.ceil(612 * (ocrIndexProfile().dpi / 72)))
    assert.equal(rendered.height, Math.ceil(792 * (ocrIndexProfile().dpi / 72)))
    const { width, height } = await sharp(Buffer.from(rendered.image)).metadata()
    assert.equal(width, rendered.width)
    assert.equal(height, rendered.height)
  } finally {
    await document.close()
  }
})
