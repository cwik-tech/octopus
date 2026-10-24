import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { extractPdfWithInspector } from '../parsers/pdf-inspector.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

test('pdf inspector adapter preserves the real package page numbering and title', async () => {
  const buffer = fs.readFileSync(path.join(FIXTURES, 'visual-deck.pdf'))

  const result = await extractPdfWithInspector(buffer)

  assert.equal(result.pages[0]?.page, 1)
  assert.ok(result.pagesNeedingOcr.includes(8))
  assert.ok(result.pagesWithTables.includes(6))
  assert.equal(result.title, 'PowerPoint Presentation')
})

test('pdf inspector adapter merges document and page recovery signals', async () => {
  const result = await extractPdfWithInspector(new Uint8Array([1]), async () => ({
    processPdf: () => ({
      markdown: '# Canonical',
      pagesNeedingOcr: [2],
      ocrReasonsByPage: [{ page: 2, reasons: ['document_reason'] }],
      pagesWithTables: [2],
      pagesWithColumns: [4],
      isComplexLayout: true,
      pdfType: 'Mixed',
      confidence: 0.8,
      hasEncodingIssues: false,
      title: 'Merged title',
    }),
    extractPagesMarkdown: () => ({
      pages: [{ page: 0, markdown: '# First page', needsOcr: false }],
      pagesNeedingOcr: [2, 3],
      ocrReasonsByPage: [{ page: 2, reasons: ['page_reason'] }],
      pagesWithTables: [3],
      pagesWithColumns: [5],
      isComplex: true,
    }),
  }))

  assert.deepEqual(result.pagesNeedingOcr, [2, 3])
  assert.deepEqual(result.pagesWithTables, [2, 3])
  assert.deepEqual(result.pagesWithColumns, [4, 5])
  assert.deepEqual(result.ocrReasonsByPage, [{
    page: 2,
    reasons: ['document_reason', 'page_reason'],
  }])
  assert.equal(result.pages[0]?.page, 1)
  assert.equal(result.title, 'Merged title')
})
