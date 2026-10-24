import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MINIMUM_TABLE_LINES,
  reconstructTableFromLines,
} from '../../ocr/table-reconstruction.js'
import type { OcrLineBox, OcrWordBox } from '../../ocr/contract.js'

/**
 * Word boxes are stated here, never measured from a recogniser. Every expectation below is a
 * property of these literals, so a failure means reconstruction is wrong rather than that the
 * recogniser changed.
 */
function makeWord(text: string, x0: number, width = text.length * 10): OcrWordBox {
  return { text, x0, x1: x0 + width }
}

function makeLine(words: readonly OcrWordBox[], y0: number): OcrLineBox {
  const first = words[0]
  const last = words[words.length - 1]
  return {
    text: words.map((word) => word.text).join(' '),
    bbox: { x0: first?.x0 ?? 0, y0, x1: last?.x1 ?? 0, y1: y0 + 20 },
    words: [...words],
  }
}

/** Four columns at 0, 300, 600 and 900, with a gutter far wider than a space. */
const TABLE_COLUMNS = [0, 300, 600, 900]

/** `null` leaves a column empty on that row, which is not the same as shifting the row left. */
type TableRow = readonly [string, string | null, string | null, string | null]

function makeTableLines(rows: readonly TableRow[]): OcrLineBox[] {
  return rows.map((cells, index) =>
    makeLine(
      cells.flatMap((cell, column) => {
        if (cell === null) return []
        // A multiword cell keeps ordinary single-space gaps inside itself, which is what
        // separates an intra-cell space from a column gutter.
        let cursor = TABLE_COLUMNS[column]!
        return cell.split(' ').map((word) => {
          const box = makeWord(word, cursor)
          cursor = box.x1 + 10
          return box
        })
      }),
      index * 40,
    ),
  )
}

function makeFinancialTable(): OcrLineBox[] {
  return makeTableLines([
    ['Line item', 'Approved 2026', 'Approved 2027', 'Approved 2028'],
    ['Sales & Marketing', '4110', '4620', '5170'],
    ['R&D', '3020', '3310', '3640'],
    ['G&A', '1180', '1240', '1310'],
  ])
}

test('reconstructTableFromLines: repeated column geometry becomes a markdown table', () => {
  const markdown = reconstructTableFromLines(makeFinancialTable())

  assert.ok(markdown, 'Four aligned rows across four columns are a table')
  const rows = markdown.split('\n')
  assert.equal(rows[0], '| Line item | Approved 2026 | Approved 2027 | Approved 2028 |')
  assert.equal(rows[1], '| --- | --- | --- | --- |')
  assert.equal(rows[2], '| Sales & Marketing | 4110 | 4620 | 5170 |')
  assert.equal(rows[3], '| R&D | 3020 | 3310 | 3640 |')
  assert.equal(rows[4], '| G&A | 1180 | 1240 | 1310 |')
})

test('reconstructTableFromLines: a missing cell stays empty instead of shifting its row left', () => {
  // `R&D` has no 2027 figure. Its 2028 figure must stay under 2028.
  const lines = makeTableLines([
    ['Line item', 'Approved 2026', 'Approved 2027', 'Approved 2028'],
    ['Sales & Marketing', '4110', '4620', '5170'],
    ['R&D', '3020', null, '3640'],
    ['G&A', '1180', '1240', '1310'],
  ])

  const markdown = reconstructTableFromLines(lines)

  assert.ok(markdown)
  assert.equal(markdown.split('\n')[3], '| R&D | 3020 |  | 3640 |')
})

test('reconstructTableFromLines: aligned prose is not manufactured into a table', () => {
  // Two lines cannot establish a majority, whatever their alignment.
  const lines = [
    makeLine([makeWord('Marketing', 0), makeWord('owns', 300)], 0),
    makeLine([makeWord('demand', 0), makeWord('generation', 300)], 40),
  ]

  assert.equal(reconstructTableFromLines(lines), null)
  assert.equal(MINIMUM_TABLE_LINES, 3)
})

test('reconstructTableFromLines: one column of aligned words is not a table', () => {
  const lines = [
    makeLine([makeWord('Definitions', 0), makeWord('and', 130)], 0),
    makeLine([makeWord('sources', 0), makeWord('for', 90)], 40),
    makeLine([makeWord('the', 0), makeWord('schedules', 50)], 80),
  ]

  assert.equal(
    reconstructTableFromLines(lines),
    null,
    'A single column of left-aligned prose is prose',
  )
})

test('reconstructTableFromLines: lines without word geometry keep the engine text', () => {
  const lines: OcrLineBox[] = [
    { text: 'Approved operating plan', bbox: { x0: 0, y0: 0, x1: 400, y1: 20 }, words: [] },
    { text: 'Sales & Marketing 4110', bbox: { x0: 0, y0: 40, x1: 400, y1: 60 }, words: [] },
    { text: 'R&D 3020', bbox: { x0: 0, y0: 80, x1: 400, y1: 100 }, words: [] },
  ]

  assert.equal(reconstructTableFromLines(lines), null)
})

test('reconstructTableFromLines: a title above a table keeps its place', () => {
  const table = makeFinancialTable()
  const titled = [
    makeLine([makeWord('Approved', 0), makeWord('operating', 100), makeWord('plan', 210)], -40),
    ...table,
  ]

  const markdown = reconstructTableFromLines(titled)

  assert.ok(markdown)
  assert.equal(markdown.split('\n')[0], 'Approved operating plan')
  assert.ok(markdown.includes('| Sales & Marketing | 4110 | 4620 | 5170 |'))
})
