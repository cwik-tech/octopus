import test from 'node:test'
import assert from 'node:assert/strict'
import {
  pageNeedsRecognition,
  readPdfPagesWithOcr,
  type OcrSourcePage,
  type ReadPagesDependencies,
} from '../../ocr/read-pages.js'
import {
  OCR_CONTRACT_VERSION,
  ocrContractIdentity,
  type OcrPdfDocument,
  type PageImage,
  type PageRegionSelection,
  type RecognizedPage,
  type TextRecognizer,
} from '../../ocr/contract.js'

function makeSourcePage(
  page: number,
  markdown: string,
  needsOcr = false,
): OcrSourcePage {
  return { page, markdown, needsOcr }
}

function makeDocument(pageCount: number): OcrPdfDocument & { closed: number } {
  const state = {
    pageCount,
    closed: 0,
    async renderPage(page: number): Promise<PageImage> {
      return { page, image: Uint8Array.of(page), width: 1700, height: 2200 }
    },
    async close(): Promise<void> {
      state.closed += 1
    },
  }
  return state
}

/** A recognizer that answers from a stated table, so no expectation depends on a real engine. */
function makeRecognizer(
  textByPage: Readonly<Record<number, string | Error>>,
  lines: Readonly<Record<number, RecognizedPage['lines']>> = {},
): TextRecognizer & { created: number; closed: number; recognized: number[] } {
  const state = {
    created: 1,
    closed: 0,
    recognized: [] as number[],
    async recognize(image: Uint8Array): Promise<RecognizedPage> {
      const page = image[0] ?? 0
      state.recognized.push(page)
      const answer = textByPage[page]
      if (answer instanceof Error) throw answer
      return { text: answer ?? '', lines: lines[page] ?? [] }
    },
    async close(): Promise<void> {
      state.closed += 1
    },
  }
  return state
}

function makeDependencies(
  recognizer: TextRecognizer,
  overrides: Partial<ReadPagesDependencies> = {},
): ReadPagesDependencies & { recognizersCreated: number } {
  const counter = { recognizersCreated: 0 }
  return {
    openDocument: async () => makeDocument(13),
    // The fake pages are markers, not PNGs; cropping them is not what these tests are about.
    cropImage: async (image) => image.image,
    createRecognizer: async () => {
      counter.recognizersCreated += 1
      return recognizer
    },
    findImageRegions: async () => [],
    ...overrides,
    get recognizersCreated() {
      return counter.recognizersCreated
    },
  }
}

test('pageNeedsRecognition: a flagged page and a blank text layer are both offered to OCR', () => {
  assert.equal(pageNeedsRecognition(makeSourcePage(10, '', true)), true)
  // The extractor said it read this page and returned nothing. Believing the flag over the
  // result is how a page with words on it gets stored as blank.
  assert.equal(pageNeedsRecognition(makeSourcePage(12, '   \n \n', false)), true)
  assert.equal(pageNeedsRecognition(makeSourcePage(1, '# Operating Plan', false)), false)
})

test('readPdfPagesWithOcr: a recognized page carries its text, status and provenance', async () => {
  const recognizer = makeRecognizer({ 10: 'Approved operating plan\n5170' })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(1, '# Operating Plan'), makeSourcePage(10, '', true)],
    dependencies: makeDependencies(recognizer),
  })

  assert.equal(result.status, 'complete')
  assert.equal(result.contractVersion, OCR_CONTRACT_VERSION)
  assert.equal(result.contractIdentity, ocrContractIdentity())
  assert.deepEqual(result.requestedPages, [10])
  assert.deepEqual(result.readPages, [10])
  assert.deepEqual(result.unresolvedPages, [])
  assert.deepEqual(result.pages[0], {
    page: 1,
    markdown: '# Operating Plan',
    status: 'read',
    source: 'pdf',
    originallyNeededOcr: false,
  })
  assert.deepEqual(result.pages[1], {
    page: 10,
    markdown: 'Approved operating plan\n5170',
    status: 'read',
    source: 'ocr',
    originallyNeededOcr: true,
  })
})

test('readPdfPagesWithOcr: a page recognition ran on and found nothing is empty, not unresolved', async () => {
  const recognizer = makeRecognizer({ 13: '   \n' })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(1, '# Operating Plan'), makeSourcePage(13, '', true)],
    dependencies: makeDependencies(recognizer),
  })

  assert.equal(result.status, 'complete')
  assert.deepEqual(result.emptyPages, [13])
  assert.deepEqual(result.unresolvedPages, [])
  assert.equal(result.pages[1]?.status, 'empty')
  assert.equal(result.pages[1]?.source, 'none')
})

test('readPdfPagesWithOcr: a worker that will not start leaves pages unresolved, never empty', async () => {
  const dependencies = makeDependencies(makeRecognizer({}), {
    createRecognizer: async () => {
      throw new Error('wasm core unavailable')
    },
  })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(1, '# Operating Plan'), makeSourcePage(10, '', true)],
    dependencies,
  })

  assert.equal(result.status, 'partial')
  assert.deepEqual(result.unresolvedPages, [10])
  assert.deepEqual(result.emptyPages, [])
  assert.equal(result.pages[1]?.status, 'unresolved')
  assert.equal(result.pages[1]?.source, 'none')
  assert.ok(result.failure?.includes('wasm core unavailable'))
  // The page nobody had trouble with is still readable.
  assert.equal(result.pages[0]?.markdown, '# Operating Plan')
})

test('readPdfPagesWithOcr: one page failing recognition does not erase the others', async () => {
  const recognizer = makeRecognizer({
    10: 'Approved operating plan 5170',
    12: new Error('page could not be read'),
  })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [
      makeSourcePage(1, '# Operating Plan'),
      makeSourcePage(10, '', true),
      makeSourcePage(12, '', true),
    ],
    dependencies: makeDependencies(recognizer),
  })

  assert.equal(result.status, 'partial')
  assert.deepEqual(result.readPages, [10])
  assert.deepEqual(result.unresolvedPages, [12])
  assert.equal(result.pages[1]?.markdown, 'Approved operating plan 5170')
  assert.equal(result.pages[2]?.status, 'unresolved')
  assert.equal(recognizer.closed, 1, 'The worker is closed on the failure path too')
})

test('readPdfPagesWithOcr: one worker serves the whole document and is always closed', async () => {
  const recognizer = makeRecognizer({ 10: 'a', 12: 'b', 13: 'c' })
  const dependencies = makeDependencies(recognizer)

  await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [
      makeSourcePage(10, '', true),
      makeSourcePage(12, '', true),
      makeSourcePage(13, '', true),
    ],
    dependencies,
  })

  assert.equal(dependencies.recognizersCreated, 1)
  assert.equal(recognizer.closed, 1)
})

test('readPdfPagesWithOcr: a text-only document never starts a recognizer', async () => {
  const dependencies = makeDependencies(makeRecognizer({}))

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(1, '# Operating Plan'), makeSourcePage(2, 'Method')],
    dependencies,
  })

  assert.equal(result.status, 'complete')
  assert.deepEqual(result.requestedPages, [])
  assert.equal(dependencies.recognizersCreated, 0)
  assert.deepEqual(
    result.pages.map((page) => page.source),
    ['pdf', 'pdf'],
  )
})

test('readPdfPagesWithOcr: cancellation is an outcome, and what was read survives it', async () => {
  const controller = new AbortController()
  const recognizer = makeRecognizer({ 10: 'Approved operating plan 5170', 12: 'chart' })
  const dependencies = makeDependencies({
    ...recognizer,
    async recognize(image: Uint8Array) {
      const page = await recognizer.recognize(image)
      controller.abort()
      return page
    },
  } as TextRecognizer)

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(10, '', true), makeSourcePage(12, '', true)],
    signal: controller.signal,
    dependencies,
  })

  assert.equal(result.status, 'cancelled')
  assert.equal(result.pages[0]?.markdown, 'Approved operating plan 5170')
  assert.equal(result.pages[0]?.status, 'read')
  // Cancelled before anything read it: a gap, not a blank page.
  assert.equal(result.pages[1]?.status, 'unresolved')
})

test('readPdfPagesWithOcr: region recognition runs by default when the document can report drawing operations', async () => {
  // No findImageRegions seam: the production default must find the qualifying figure from the
  // document's drawing operations, the way a real parse does.
  const recognizer = makeRecognizer({ 4: 'Channel rebate 6420' })
  const dependencies = makeDependencies(recognizer, {
    openDocument: async () => ({
      pageCount: 13,
      async renderPage(page: number): Promise<PageImage> {
        return { page, image: Uint8Array.of(page), width: 1700, height: 2200 }
      },
      async close(): Promise<void> {},
      async readPageDrawingOperations(page: number) {
        return {
          page,
          images: [{ x: 60, y: 300, width: 320, height: 160, areaPt2: 51_200 }],
          pageBox: { width: 612, height: 792 },
          rotation: 0,
        }
      },
    }),
  })
  delete (dependencies as { findImageRegions?: unknown }).findImageRegions

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(4, '# Marketing\n\nMarketing owns demand generation.')],
    dependencies,
  })

  assert.equal(result.status, 'complete')
  assert.deepEqual(result.requestedPages, [4])
  assert.equal(result.pages[0]?.source, 'mixed')
  assert.ok(result.pages[0]?.markdown.includes('Channel rebate 6420'))
})

test('readPdfPagesWithOcr: a renderer that cannot open leaves text pages uninspected and unresolved', async () => {
  const dependencies = makeDependencies(makeRecognizer({}), {
    openDocument: async () => {
      throw new Error('renderer could not open the document')
    },
  })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(4, '# Marketing\n\nMarketing owns demand generation.')],
    dependencies,
  })

  assert.equal(result.status, 'partial')
  assert.deepEqual(result.unresolvedPages, [4])
  assert.equal(result.pages[0]?.status, 'read')
  assert.equal(result.pages[0]?.source, 'pdf')
  assert.equal(result.pages[0]?.markdown, '# Marketing\n\nMarketing owns demand generation.')
  assert.ok(result.failure?.includes('renderer could not open the document'))
})

test('readPdfPagesWithOcr: a qualifying region adds only what the page does not already say', async () => {
  const recognizer = makeRecognizer({ 4: 'Incentive schedule\nMarketing\nChannel rebate 6420' })
  const regions: PageRegionSelection[] = [
    { page: 4, boxes: [{ x: 60, y: 300, width: 320, height: 160 }], pageBox: { width: 612, height: 792 } },
  ]
  const dependencies = makeDependencies(recognizer, {
    findImageRegions: async () => regions,
  })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(4, '# Marketing\n\nMarketing owns demand generation.')],
    dependencies,
  })

  assert.equal(result.status, 'complete')
  assert.equal(result.pages[0]?.source, 'mixed')
  assert.equal(result.pages[0]?.status, 'read')
  assert.ok(result.pages[0]?.markdown.includes('Channel rebate 6420'))
  assert.ok(result.pages[0]?.markdown.startsWith('# Marketing'))
  assert.equal(
    result.pages[0]?.markdown.match(/Marketing owns demand generation/g)?.length,
    1,
    'A picture that merely repeats the words beside it must not be added twice',
  )
})

test('readPdfPagesWithOcr: a region crop that fails leaves the region unresolved, keeps the native text, and reads on', async () => {
  const recognizer = makeRecognizer({ 10: 'Approved operating plan 5170' })
  const dependencies = makeDependencies(recognizer, {
    findImageRegions: async () => [
      { page: 4, boxes: [{ x: 60, y: 300, width: 320, height: 160 }], pageBox: { width: 612, height: 792 } },
    ],
    cropImage: async () => {
      throw new Error('extract area outside image')
    },
  })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [
      makeSourcePage(4, '# Marketing\n\nMarketing owns demand generation.'),
      makeSourcePage(10, '', true),
    ],
    dependencies,
  })

  // The region attempt nobody completed is unresolved, and an unread attempt is never empty.
  assert.deepEqual(result.unresolvedPages, [4])
  assert.deepEqual(result.emptyPages, [])
  assert.equal(result.status, 'partial')
  // The failure cost the page its region reading, not the text the extractor already had.
  assert.equal(result.pages[0]?.status, 'read')
  assert.equal(result.pages[0]?.source, 'pdf')
  assert.equal(result.pages[0]?.markdown, '# Marketing\n\nMarketing owns demand generation.')
  // One page's crop failure must not abort the run: later pages are still recognized.
  assert.equal(result.pages[1]?.status, 'read')
  assert.equal(result.pages[1]?.markdown, 'Approved operating plan 5170')
})

test('readPdfPagesWithOcr: a page stream that dies before a region page still accounts for that page', async () => {
  // Page 2 is rendered and recognized; the renderer then dies before page 4, a text-bearing
  // page with a qualifying region, is ever yielded. Its region attempt never happened.
  const recognizer = makeRecognizer({ 2: 'Approved operating plan 5170' })
  const dependencies = makeDependencies(recognizer, {
    openDocument: async () => ({
      pageCount: 13,
      async renderPage(page: number): Promise<PageImage> {
        if (page === 4) throw new Error('renderer lost the page')
        return { page, image: Uint8Array.of(page), width: 1700, height: 2200 }
      },
      async close(): Promise<void> {},
    }),
    findImageRegions: async () => [
      { page: 4, boxes: [{ x: 60, y: 300, width: 320, height: 160 }], pageBox: { width: 612, height: 792 } },
    ],
  })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [
      makeSourcePage(2, '', true),
      makeSourcePage(4, '# Marketing\n\nMarketing owns demand generation.'),
    ],
    dependencies,
  })

  // What the picture on page 4 said is a gap, not a fact: the page is unresolved, the document
  // is partial, and a page nobody read whole is never counted as empty.
  assert.deepEqual(result.unresolvedPages, [4])
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.emptyPages, [])
  // The failure cost the page its region reading, not the text the extractor already had.
  assert.equal(result.pages[1]?.status, 'read')
  assert.equal(result.pages[1]?.source, 'pdf')
  assert.equal(result.pages[1]?.markdown, '# Marketing\n\nMarketing owns demand generation.')
  // The page the stream did reach keeps its recognized text.
  assert.equal(result.pages[0]?.status, 'read')
  assert.equal(result.pages[0]?.markdown, 'Approved operating plan 5170')
  assert.ok(result.failure?.includes('renderer lost the page'))
})

test('readPdfPagesWithOcr: a region that recognizes to nothing leaves the page as native text', async () => {
  const recognizer = makeRecognizer({ 2: '  ' })
  const dependencies = makeDependencies(recognizer, {
    findImageRegions: async () => [
      { page: 2, boxes: [{ x: 460, y: 700, width: 80, height: 40 }], pageBox: { width: 612, height: 792 } },
    ],
  })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(2, '# Method')],
    dependencies,
  })

  assert.equal(result.pages[0]?.status, 'read')
  assert.equal(result.pages[0]?.source, 'pdf')
  assert.equal(result.pages[0]?.markdown, '# Method')
  assert.equal(result.status, 'complete')
  // Whole-page recognition never ran here, and the page has native text: nothing about it is
  // empty, so it must not be counted among the empty pages.
  assert.deepEqual(result.emptyPages, [])
})

test('readPdfPagesWithOcr: reported elapsed time comes from the injected clock', async () => {
  // The coordinator reads the clock twice: once when the read starts, once when it reports.
  const readings = [1000, 1750]
  let call = 0

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    pages: [makeSourcePage(1, '# Operating Plan')],
    now: () => readings[Math.min(call++, readings.length - 1)]!,
    dependencies: makeDependencies(makeRecognizer({})),
  })

  assert.equal(result.elapsedMs, 750)
})

test('readPdfPagesWithOcr: word geometry that supports columns becomes a markdown table', async () => {
  const columns = [0, 300, 600, 900]
  const rows = [
    ['Line item', 'Approved 2026', 'Approved 2027', 'Approved 2028'],
    ['Sales & Marketing', '4110', '4620', '5170'],
    ['R&D', '3020', '3310', '3640'],
    ['G&A', '1180', '1240', '1310'],
  ]
  const lines = rows.map((cells, index) => {
    const words = cells.flatMap((cell, column) => {
      let cursor = columns[column]!
      return cell.split(' ').map((word) => {
        const box = { text: word, x0: cursor, x1: cursor + word.length * 10 }
        cursor = box.x1 + 10
        return box
      })
    })
    return {
      text: cells.join('  '),
      bbox: { x0: 0, y0: index * 40, x1: 1000, y1: index * 40 + 20 },
      words,
    }
  })
  const recognizer = makeRecognizer({ 10: 'flat engine text' }, { 10: lines })

  const result = await readPdfPagesWithOcr({
    filePath: '/does/not/matter.pdf',
    now: Date.now,
    pages: [makeSourcePage(10, '', true)],
    dependencies: makeDependencies(recognizer),
  })

  assert.ok(
    result.pages[0]?.markdown.includes('| Sales & Marketing | 4110 | 4620 | 5170 |'),
    'Reconstruction replaces the flat reading when the geometry supports columns',
  )
})
