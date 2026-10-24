/**
 * What the MarkPDF mixed fixture contains, stated before anything reads it.
 *
 * Every value here is copied from the generator that produced
 * `tests/fixtures/markpdf-mixed-ocr.pdf` — the frozen `ADVERSARIAL` record in MarkPDF's
 * `cli/journeys/adversarialFixture.test-support.ts`, built by `buildAdversarialPdf("mixed")`.
 * None of it is copied back from what this parser returned, which is what makes a failure
 * here mean the parser is wrong rather than that the parser changed.
 *
 * If the binary fixture is ever regenerated, the change must carry the generator revision,
 * the new SHA-256, and a review of every value below.
 */
export const MIXED_OCR_FIXTURE = Object.freeze({
  fileName: 'markpdf-mixed-ocr.pdf',
  sha256: 'a13be7c0c673176272210a3be16fe9d57e805fb457304d043b410c6beae7b4b8',
  pageCount: 13,

  /** The page that exists only as pixels. */
  imageOnlyPage: 10,
  /** Drawn with nothing on it at all. */
  blankPage: 13,
  /** A picture of a chart: labels and numbers, none of them the answer. */
  chartPage: 12,
  /** Carries a mark far too small to be worth recognising: 80 x 40 pt = 3 200 pt². */
  logoPage: 2,
  /** Carries a figure large enough to qualify: 320 x 160 pt = 51 200 pt². */
  figurePage: 4,

  /** The answer, and it exists only as ink on page 10. */
  page10: Object.freeze({
    title: 'Approved operating plan',
    rowLabel: 'Sales & Marketing',
    columnPrefix: 'Approved',
    salesMarketing2028: '5170',
    row2026: '4110',
    row2027: '4620',
    row2029: '5890',
    rd2026: '3020',
    ga2026: '1180',
  }),

  /** Pixels on a text-rich page. These words appear in no text layer anywhere. */
  page4: Object.freeze({ label: 'Channel rebate', value2028: '6420' }),

  /** A table of the same shape, in real text, close enough to be tempting. */
  page3: Object.freeze({ rowLabel: 'Sales & Marketing', salesMarketing2028: '4980' }),

  /** A chart with adjacent labels and numbers, none of them the answer. */
  chart: Object.freeze({ marketing2028: '1140' }),

  /** Literals that exist in this document only as ink. */
  pixelOnlyLiterals: Object.freeze([
    'Approved operating plan',
    '5170',
    'Channel rebate',
    '6420',
    '1140',
  ]),

  /** Image areas in square points, either side of the single-image floor. */
  logoAreaPt2: 80 * 40,
  figureAreaPt2: 320 * 160,
  pageAreaPt2: 612 * 792,
} as const)
