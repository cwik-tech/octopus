import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import PDFDocument from 'pdfkit'
import type { ParseResult } from '../types.js'
import { parsePdf } from '../parsers/pdf.js'
import { parseDocx } from '../parsers/docx.js'
import { parseXlsx } from '../parsers/xlsx.js'
import { parseImage } from '../parsers/image.js'
import { parseGeneric } from '../parsers/generic.js'
import { parsePptx } from '../parsers/pptx.js'
import { parseUnsupported } from '../parsers/unsupported.js'
import { MIXED_OCR_FIXTURE } from './mixed-ocr-expectations.js'
import { BITMAP_FIXTURE } from './bitmap-fixture.js'
import { RICH_TEXT_FIXTURE } from './rich-text-fixture.js'
import { OCR_LANGUAGE_DATA_DIR_ENV } from '../ocr/tesseract-engine.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

/** Create a temp output dir, run fn, then clean up */
function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-parser-test-'))
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

function createTextHeavyPdf(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 })
    const stream = fs.createWriteStream(filePath)
    doc.pipe(stream)

    doc.fontSize(18).text('Operational Review', { underline: true })
    doc.moveDown()

    const paragraphs = [
      'This dummy report exists to validate text-heavy PDF parsing under the file parser test suite.',
      'It contains multiple long paragraphs with punctuation, headings, and narrative continuity so the parser can recover reading order and line joins.',
      'The farm automation program reduced harvest delays, stabilized labor planning, and improved packing throughput across the first pilot cohort.',
      'Management expects the next implementation wave to focus on margin expansion, service logistics, and reliability metrics tracked weekly by the operations team.',
      'This document should classify as text-heavy and should not require LM enrichment for basic downstream usage.',
    ]

    for (let i = 0; i < 6; i++) {
      for (const paragraph of paragraphs) {
        doc.fontSize(11).text(paragraph)
        doc.moveDown(0.5)
      }
    }

    stream.on('close', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.end()
  })
}

function createMixedTextPdf(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 })
    const stream = fs.createWriteStream(filePath)
    doc.pipe(stream)
    doc.fontSize(12).text('A substantial native-text page. '.repeat(80))
    doc.addPage()
    doc.image(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ), 48, 48, { width: 100 })
    stream.on('close', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.end()
  })
}

async function createVisualDeckFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-deck-test-'))
  const result = await parsePdf(path.join(FIXTURES, 'visual-deck.pdf'), dir)
  return { dir, result }
}

let visualDeckFixture: ReturnType<typeof createVisualDeckFixture> | undefined

function getVisualDeckFixture(): ReturnType<typeof createVisualDeckFixture> {
  visualDeckFixture ??= createVisualDeckFixture()
  return visualDeckFixture
}

after(async () => {
  if (!visualDeckFixture) return
  const { dir } = await visualDeckFixture
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── PDF Parser ──

test('parsePdf: visual PDF extracts text and classifies correctly', async () => {
    const { dir, result } = await getVisualDeckFixture()

    if (result.status === 'error') console.log('PDF error:', result.error)
    assert.equal(result.status, 'success')
    assert.equal(result.type, 'pdf')
    assert.equal(result.classification, 'visual')
    assert.ok(result.outputs.text)
    assert.ok(result.outputs.structure)
    assert.ok(result.outputs.parse)
    assert.equal(result.requiresLlm, true)
    assert.ok((result.flaggedPages?.length ?? 0) > 0)

    // Should have written a .md file
    const mdPath = path.join(dir, result.outputs.text)
    assert.ok(fs.existsSync(mdPath), `Expected ${mdPath} to exist`)

    const md = fs.readFileSync(mdPath, 'utf-8')
    assert.ok(md.includes('ExampleCo'), 'MD should include extracted text')
    assert.ok(md.includes('ExampleCo has No Competition'), 'MD should preserve semantic headings')

    const structuredPath = path.join(dir, result.outputs.structure)
    assert.ok(fs.existsSync(structuredPath), 'Structured markdown should exist')
    const structured = fs.readFileSync(structuredPath, 'utf-8')
    assert.ok(structured.includes('ExampleCo has No Competition'))
    assert.ok(structured.includes('|---|'))

    const parsePath = path.join(dir, result.outputs.parse)
    assert.ok(fs.existsSync(parsePath), 'Parse diagnostics JSON should exist')
    const parseJson = JSON.parse(fs.readFileSync(parsePath, 'utf-8'))
    assert.equal(parseJson.classification, 'visual')
    assert.equal(parseJson.needs_lm_enrichment, true)
    assert.equal(Array.isArray(parseJson.page_diagnostics), true)
    assert.ok(parseJson.page_diagnostics.length > 0)
    assert.ok(parseJson.page_diagnostics[0].lines > 1)
    assert.ok(parseJson.page_diagnostics.some((page: { bullets: number }) => page.bullets > 0))
    assert.ok(parseJson.page_diagnostics.every((page: { title: string }) => page.title.length <= 80))
    assert.equal(parseJson.document_kind, 'slide-deck')
    assert.equal(result.metadata.title, 'PowerPoint Presentation')

    // Visual PDFs should render pages
    assert.ok(result.outputs.pages, 'Visual PDF should have rendered pages')
    const pagesDir = path.join(dir, result.outputs.pages)
    assert.ok(fs.existsSync(pagesDir), 'Pages directory should exist')
    const pages = fs.readdirSync(pagesDir).filter(f => f.endsWith('.jpg'))
    assert.ok(pages.length > 0, 'Should have rendered at least one page')
  })

test('parsePdf: native PDF extraction preserves semantic tables and layout diagnostics', async () => {
    const { dir, result } = await getVisualDeckFixture()

    assert.equal(result.status, 'success')
    assert.equal(result.metadata.pdf_engine, 'pdf-inspector')
    const structured = fs.readFileSync(path.join(dir, result.outputs.structure), 'utf-8')
    assert.match(structured, /\|---\|/)
    assert.match(structured, /# ExampleCo has No Competition/)

    const parseJson = JSON.parse(
      fs.readFileSync(path.join(dir, result.outputs.parse), 'utf-8'),
    )
    assert.ok(parseJson.pages_with_tables.includes(6))
    assert.ok(parseJson.pages_with_columns.includes(5))
    assert.ok(result.flaggedPages?.includes(5))
    assert.ok(result.flaggedPages?.includes(6))
    assert.notEqual(
      fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8'),
      structured,
    )
    assert.match(structured, /## Page 8/)
  })

test('parsePdf: model-facing PDF artifacts include page-addressable semantic anchors', async () => {
    const { dir, result } = await getVisualDeckFixture()

    assert.equal(result.status, 'success')
    assert.ok(result.outputs.pageMap)
    const pageMap = fs.readFileSync(path.join(dir, result.outputs.pageMap), 'utf-8')
    assert.match(pageMap, /# PDF Page Locator/)
    assert.match(pageMap, /- Page 3: ExampleCo has No Competition/)
    assert.match(pageMap, /- Page 8: \[No text extracted\]/)
  })

test('parsePdf: page-level OCR signals render the affected visual page', async () => {
    const { dir, result } = await getVisualDeckFixture()

    assert.equal(result.status, 'success')
    assert.equal(result.needsOcr, true)
    assert.ok(result.flaggedPages?.includes(8))
    assert.deepEqual(result.metadata.pages_needing_ocr, [8])
    assert.equal((result.metadata.rendered_page_numbers as number[])[0], 8)
    assert.equal((result.metadata.rendered_page_numbers as number[]).length, 3)
    assert.ok(
      fs.existsSync(path.join(dir, result.outputs.pages, 'page-008.jpg')),
      'The page requiring OCR should be rendered for visual recovery',
    )
  })

test('parsePdf: scanned PDF classifies as scanned', () =>
  withTempDir(async (dir) => {
    const pdfPath = path.join(FIXTURES, 'scanned.pdf')
    if (!fs.existsSync(pdfPath)) return

    const result = await parsePdf(pdfPath, dir)

    assert.equal(result.status, 'success')
    assert.equal(result.classification, 'scanned')
    assert.ok((result.charsPerPage ?? 0) < 100, 'Scanned PDF should have very few chars/page')
    assert.equal(result.needsOcr, true)
    assert.equal(result.requiresLlm, true)

    const mdPath = path.join(dir, result.outputs.text)
    assert.ok(fs.existsSync(mdPath))
  }))

test('parsePdf: text-heavy PDF emits strong deterministic artifacts', () =>
  withTempDir(async (dir) => {
    const pdfPath = path.join(dir, 'text-heavy.pdf')
    await createTextHeavyPdf(pdfPath)

    const result = await parsePdf(pdfPath, dir)

    assert.equal(result.status, 'success')
    assert.equal(result.classification, 'text-heavy')
    assert.ok(result.outputs.text)
    assert.ok(result.outputs.structure)
    assert.ok(result.outputs.parse)
    const pageEvidence = JSON.parse(fs.readFileSync(path.join(dir, result.outputs.parse), 'utf8'))
    assert.equal(pageEvidence.pages.length, result.metadata.pages)
    assert.equal(pageEvidence.pages[0].page, 1)
    assert.match(pageEvidence.pages[0].markdown, /Operational Review/)
    assert.equal(pageEvidence.pages[0].status, 'read')
    assert.equal(result.lmScope, 'none')
    assert.equal(result.parseQuality, 'high')
    assert.ok((result.qualityScore ?? 0) >= 0.75)
    assert.equal(result.metadata.pdf_engine, 'pdf-inspector')

    const structured = fs.readFileSync(path.join(dir, result.outputs.structure), 'utf-8')
    assert.ok(structured.includes('# Operational Review'))
  }))

test('parsePdf: malformed native-parser input falls back to pdf-parse', () =>
  withTempDir(async (dir) => {
    const pdfPath = path.join(FIXTURES, 'malformed-trailer.pdf')

    const result = await parsePdf(pdfPath, dir)

    assert.equal(result.status, 'success')
    assert.equal(result.metadata.pdf_engine, 'pdf-parse')
    assert.equal(typeof result.metadata.pdf_engine_fallback_reason, 'string')
    assert.ok(String(result.metadata.pdf_engine_fallback_reason).length > 0)
    assert.ok(fs.statSync(path.join(dir, result.outputs.text)).size > 0)
  }))

test('parsePdf: missing native binary uses the compatibility parser', () =>
  withTempDir(async (dir) => {
    const pdfPath = path.join(dir, 'native-unavailable.pdf')
    await createTextHeavyPdf(pdfPath)

    const result = await parsePdf(pdfPath, dir, {
      inspectPdf: async () => {
        throw Object.assign(new Error('native binding unavailable'), { code: 'ERR_DLOPEN_FAILED' })
      },
    })

    assert.equal(result.status, 'success')
    assert.equal(result.metadata.pdf_engine, 'pdf-parse')
    assert.match(String(result.metadata.pdf_engine_fallback_reason), /native binding unavailable/)
  }))

test('parsePdf: fallback reports only pages whose text requires OCR', () =>
  withTempDir(async (dir) => {
    const pdfPath = path.join(dir, 'mixed-text.pdf')
    await createMixedTextPdf(pdfPath)

    const result = await parsePdf(pdfPath, dir, {
      inspectPdf: async () => { throw new Error('force compatibility parser') },
    })
    const parseJson = JSON.parse(fs.readFileSync(path.join(dir, result.outputs.parse), 'utf-8'))

    assert.equal(result.metadata.pdf_engine, 'pdf-parse')
    assert.deepEqual(parseJson.pages_needing_ocr, [2])
    assert.equal(parseJson.pages_with_columns, null)
    assert.equal(parseJson.column_layout_detection, 'unavailable')
  }))

test('parsePdf: internal inspector analysis errors do not masquerade as engine fallback', () =>
  withTempDir(async (dir) => {
    const pdfPath = path.join(dir, 'analysis-error.pdf')
    await createTextHeavyPdf(pdfPath)

    const result = await parsePdf(pdfPath, dir, {
      inspectPdf: async () => ({
        pages: [{ page: 1, markdown: '# Page', needsOcr: false }],
        pagesWithTables: undefined as unknown as number[],
        pagesWithColumns: [],
        pagesNeedingOcr: [],
        ocrReasonsByPage: [],
        isComplexLayout: false,
        detectedType: 'TextBased',
        confidence: 1,
        hasEncodingIssues: false,
      }),
    })

    assert.equal(result.status, 'error')
    assert.match(String(result.error), /includes|iterable|undefined/i)
  }))

test('parsePdf: targeted rendering requests only bounded priority pages', () =>
  withTempDir(async (dir) => {
    const requestedPages: number[] = []
    const pdfPath = path.join(dir, 'targeted-render.pdf')
    await createTextHeavyPdf(pdfPath)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )

    const result = await parsePdf(pdfPath, dir, {
      inspectPdf: async () => ({
        markdown: '# Targeted render',
        pages: [{ page: 8, markdown: '', needsOcr: true }],
        pagesWithTables: [6],
        pagesWithColumns: [5],
        pagesNeedingOcr: [8],
        ocrReasonsByPage: [{ page: 8, reasons: ['image_only'] }],
        isComplexLayout: true,
        detectedType: 'Mixed',
        confidence: 1,
        hasEncodingIssues: false,
      }),
      openPdf: async () => ({
        length: 200,
        metadata: {},
        getPage: async (page: number) => {
          requestedPages.push(page)
          return png
        },
        async *[Symbol.asyncIterator]() {
          for (let page = 1; page <= 200; page++) {
            requestedPages.push(page)
            yield png
          }
        },
      }),
      maxRenderedPages: 1,
    })

    assert.equal(result.status, 'success')
    assert.deepEqual(requestedPages, [8])
    assert.deepEqual(result.metadata.rendered_page_numbers, [8])
  }))

test('parsePdf: native text layouts do not rasterize without a visual recovery need', () =>
  withTempDir(async (dir) => {
    const requestedPages: number[] = []
    const pdfPath = path.join(dir, 'native-table.pdf')
    await createTextHeavyPdf(pdfPath)

    const result = await parsePdf(pdfPath, dir, {
      inspectPdf: async () => ({
        markdown: '# Native table\n\n' + 'Substantial semantic table content. '.repeat(40),
        pages: [{
          page: 1,
          markdown: '# Native table\n\n' + 'Substantial semantic table content. '.repeat(40),
          needsOcr: false,
        }],
        pagesWithTables: [1],
        pagesWithColumns: [],
        pagesNeedingOcr: [],
        ocrReasonsByPage: [],
        isComplexLayout: true,
        detectedType: 'TextBased',
        confidence: 1,
        hasEncodingIssues: false,
      }),
      openPdf: async () => ({
        length: 1,
        metadata: {},
        getPage: async (page: number) => {
          requestedPages.push(page)
          throw new Error('unexpected rasterization')
        },
        async *[Symbol.asyncIterator]() {},
      }),
    })

    assert.equal(result.status, 'success')
    assert.deepEqual(requestedPages, [])
    assert.equal(result.outputs.pages, undefined)
    assert.ok(result.flaggedPages?.includes(1), 'Layout should still route to recovery metadata')
  }))

test('parsePdf: returns error for non-existent file', () =>
  withTempDir(async (dir) => {
    const result = await parsePdf('/nonexistent/file.pdf', dir)
    assert.equal(result.status, 'error')
    assert.ok(result.error)
  }))

// ── DOCX Parser ──

test('parseDocx: converts DOCX to markdown', () =>
  withTempDir(async (dir) => {
    const docxPath = path.join(FIXTURES, 'business-plan.docx')
    if (!fs.existsSync(docxPath)) {
      // Skip if fixture not available
      return
    }

    const result = await parseDocx(docxPath, dir)

    assert.equal(result.status, 'success')
    assert.equal(result.type, 'docx')
    assert.ok(result.outputs.text)

    const mdPath = path.join(dir, result.outputs.text)
    assert.ok(fs.existsSync(mdPath))

    const md = fs.readFileSync(mdPath, 'utf-8')
    assert.ok(md.includes('ExampleCo'), 'Markdown should include ExampleCo content')
    assert.ok(md.includes('business-plan.docx'), 'Should include source filename')
  }))

test('parseDocx: extracts embedded images', () =>
  withTempDir(async (dir) => {
    const docxPath = path.join(FIXTURES, 'business-plan.docx')
    if (!fs.existsSync(docxPath)) return

    const result = await parseDocx(docxPath, dir)

    assert.equal(result.status, 'success')
    const imageCount = (result.metadata.images_extracted as number) ?? 0
    assert.ok(imageCount >= 1, 'Should extract at least 1 embedded image')

    // Check that image file was written
    if (result.outputs.images) {
      const firstImage = result.outputs.images.split(',')[0].trim()
      assert.ok(fs.existsSync(path.join(dir, firstImage)), 'Image file should exist')
    }
  }))

test('parseDocx: preserves table row and column associations', () =>
  withTempDir(async (dir) => {
    const result = await parseDocx(path.join(FIXTURES, 'docx-table.docx'), dir)

    assert.equal(result.status, 'success')
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(
      md.includes('| Metric | Value |\n| --- | --- |\n| Growth | 12.5% |'),
      'A Word table must survive parsing as a Markdown table that keeps each value in its row and column',
    )
  }))

test('parseDocx: keeps document hyperlinks as Markdown links', () =>
  withTempDir(async (dir) => {
    const result = await parseDocx(path.join(FIXTURES, 'docx-table.docx'), dir)

    assert.equal(result.status, 'success')
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(
      md.includes('[Pipeline handbook](https://example.com/pipeline-handbook)'),
      'A Word hyperlink outside a table must remain an ordinary Markdown link',
    )
  }))

test('parseDocx: returns error for non-existent file', () =>
  withTempDir(async (dir) => {
    const result = await parseDocx('/nonexistent/file.docx', dir)
    assert.equal(result.status, 'error')
    assert.ok(result.error)
  }))

// ── XLSX Parser ──

test('parseXlsx: converts spreadsheet to markdown tables and JSON', () =>
  withTempDir(async (dir) => {
    const result = await parseXlsx(path.join(FIXTURES, 'financials.xlsx'), dir)

    if (result.status === 'error') console.log('XLSX error:', result.error)
    assert.equal(result.status, 'success')
    assert.equal(result.type, 'xlsx')
    assert.ok(result.outputs.text)
    assert.ok(result.outputs.data)

    // Check markdown
    const mdPath = path.join(dir, result.outputs.text)
    assert.ok(fs.existsSync(mdPath))
    const md = fs.readFileSync(mdPath, 'utf-8')
    assert.ok(md.includes('Yield Data'), 'Should include first sheet name')
    assert.ok(md.includes('Financials'), 'Should include second sheet name')
    assert.ok(md.includes('Farm Alpha'), 'Should include row data')

    // Check JSON
    const jsonPath = path.join(dir, result.outputs.data)
    assert.ok(fs.existsSync(jsonPath))
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    assert.ok(json['Yield Data'], 'JSON should have Yield Data sheet')
    assert.ok(json['Financials'], 'JSON should have Financials sheet')
    assert.equal(json['Yield Data'].length, 3, 'Yield Data should have 3 rows')
    assert.equal(json['Financials'].length, 4, 'Financials should have 4 rows')

    // Check metadata
    assert.equal(result.metadata.sheets, 2)
    assert.deepEqual(result.metadata.sheet_names, ['Yield Data', 'Financials'])
  }))

test('parseXlsx: handles empty spreadsheet', () =>
  withTempDir(async (dir) => {
    const result = await parseXlsx(path.join(FIXTURES, 'empty.xlsx'), dir)

    assert.equal(result.status, 'success')
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(md.includes('Empty sheet') || md.includes('Empty'))
  }))

test('parseXlsx: returns error for non-existent file', () =>
  withTempDir(async (dir) => {
    const result = await parseXlsx('/nonexistent/file.xlsx', dir)
    assert.equal(result.status, 'error')
  }))

// ── Image Parser ──

test('parseImage: extracts metadata from JPEG', () =>
  withTempDir(async (dir) => {
    const result = await parseImage(path.join(FIXTURES, 'test-photo.jpg'), dir)

    assert.equal(result.status, 'success')
    assert.equal(result.type, 'image')
    assert.equal(result.requiresLlm, true)
    assert.ok(result.outputs.metadata)
    assert.ok(result.outputs.thumbnail)

    // Check metadata JSON
    const metaPath = path.join(dir, result.outputs.metadata)
    assert.ok(fs.existsSync(metaPath))
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    assert.equal(meta.format, 'jpeg')
    assert.equal(meta.width, 100)
    assert.equal(meta.height, 80)
    assert.equal(meta.requires_llm, true)

    // Check thumbnail exists
    const thumbPath = path.join(dir, result.outputs.thumbnail)
    assert.ok(fs.existsSync(thumbPath))
  }))

test('parseImage: creates downsized thumbnail for large images', () =>
  withTempDir(async (dir) => {
    const result = await parseImage(path.join(FIXTURES, 'large-photo.jpg'), dir)

    assert.equal(result.status, 'success')
    assert.ok(result.outputs.thumbnail)

    // Thumbnail should be smaller than original
    const originalSize = fs.statSync(path.join(FIXTURES, 'large-photo.jpg')).size
    const thumbSize = fs.statSync(path.join(dir, result.outputs.thumbnail)).size
    assert.ok(thumbSize < originalSize, 'Thumbnail should be smaller than original')
  }))

test('parseImage: handles PNG files', () =>
  withTempDir(async (dir) => {
    const result = await parseImage(path.join(FIXTURES, 'icon.png'), dir)

    assert.equal(result.status, 'success')
    assert.equal(result.metadata.format, 'png')
    assert.equal(result.metadata.width, 50)
    assert.equal(result.metadata.height, 50)
  }))

test('parseImage: returns error for non-existent file', () =>
  withTempDir(async (dir) => {
    const result = await parseImage('/nonexistent/photo.jpg', dir)
    assert.equal(result.status, 'error')
  }))

// ── Generic Parser ──

test('parseGeneric: reads plain text files', () =>
  withTempDir(async (dir) => {
    const result = await parseGeneric(path.join(FIXTURES, 'notes.txt'), dir)

    assert.equal(result.status, 'success')
    assert.equal(result.type, 'generic')
    assert.ok(result.outputs.text)

    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(md.includes('Meeting notes'), 'Should include file content')
    assert.ok(md.includes('ExampleCo membrane'), 'Should include file content')
  }))

test('parseGeneric: reads markdown files', () =>
  withTempDir(async (dir) => {
    const result = await parseGeneric(path.join(FIXTURES, 'readme.md'), dir)

    assert.equal(result.status, 'success')
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(md.includes('Project Overview'))
  }))

test('parseGeneric: reads JSON files', () =>
  withTempDir(async (dir) => {
    const result = await parseGeneric(path.join(FIXTURES, 'config.json'), dir)

    assert.equal(result.status, 'success')
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(md.includes('"name"'))
    assert.ok(md.includes('"test"'))
  }))

test('parseGeneric: returns error for non-existent file', () =>
  withTempDir(async (dir) => {
    const result = await parseGeneric('/nonexistent/file.txt', dir)
    assert.equal(result.status, 'error')
  }))

// ── OpenDocument ──

test('parseGeneric: reads an OpenDocument text document', () =>
  withTempDir(async (dir) => {
    const result = await parseGeneric(path.join(FIXTURES, 'field-notes.odt'), dir)

    assert.equal(result.status, 'success', result.error)
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(md.includes('Membrane Rollout Notes'), 'Carries the heading')
    assert.ok(md.includes('packing throughput'), 'Carries the body text')
  }))

test('parseGeneric: reads an OpenDocument spreadsheet', () =>
  withTempDir(async (dir) => {
    const result = await parseGeneric(path.join(FIXTURES, 'yield-data.ods'), dir)

    assert.equal(result.status, 'success', result.error)
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(md.includes('Farm Beta'), 'Carries the cell values')
    assert.ok(md.includes('302%'), 'Carries the cell values')
  }))

test('parsePptx: reads an OpenDocument presentation', () =>
  withTempDir(async (dir) => {
    const result = await parsePptx(path.join(FIXTURES, 'pilot-review.odp'), dir)

    assert.equal(result.status, 'success', result.error)
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(md.includes('Pilot Cohort Review'), 'Carries the first slide')
    assert.ok(md.includes('Margin expansion'), 'Carries the second slide')
  }))

// ── Rich Text ──

/**
 * `.rtf` was added to the desktop pickers with nothing in the suite exercising it. It is neither a
 * ZIP nor readable as utf-8 prose — `parseGeneric` hands it to officeparser — so "the extension is
 * routed" was never evidence that any text came back.
 */
test('parseGeneric: reads a Rich Text document', () =>
  withTempDir(async (dir) => {
    const result = await parseGeneric(path.join(FIXTURES, RICH_TEXT_FIXTURE.fileName), dir)

    assert.equal(result.status, 'success', result.error)
    assert.equal(result.metadata['original_format'], 'rtf')
    const md = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(md.includes(RICH_TEXT_FIXTURE.heading), 'Carries the heading')
    assert.ok(md.includes(RICH_TEXT_FIXTURE.firstParagraph), 'Carries the first paragraph')
    assert.ok(md.includes(RICH_TEXT_FIXTURE.lastParagraph), 'Carries the last paragraph')
    assert.ok(!md.includes('\\rtf1'), 'Control words are not passed off as document text')
  }))

// ── Unsupported Formats ──

test('parseUnsupported: a legacy .doc refuses with the format and the remedy', () => {
  const result = parseUnsupported(path.join(FIXTURES, 'legacy-report.doc'))

  assert.equal(result.status, 'error')
  assert.equal(result.type, 'unsupported')
  assert.deepEqual(result.outputs, {}, 'Nothing is written for a refused format')
  assert.ok(result.sizeBytes > 0, 'The refusal still reports the file it refused')
  assert.equal(result.unsupported?.reason, 'legacy_binary_office')
  assert.equal(result.unsupported?.extension, '.doc')
  assert.ok(result.error?.includes('Word 97-2003 (.doc)'), result.error)
  assert.ok(result.error?.includes('.docx'), result.error)
})

test('parseUnsupported: .xls and .ppt each name their own remedy', () => {
  const xls = parseUnsupported(path.join(FIXTURES, 'legacy-book.xls'))
  assert.equal(xls.unsupported?.extension, '.xls')
  assert.ok(xls.error?.includes('.xlsx'), xls.error)

  const ppt = parseUnsupported(path.join(FIXTURES, 'legacy-deck.ppt'))
  assert.equal(ppt.unsupported?.extension, '.ppt')
  assert.ok(ppt.error?.includes('.pptx'), ppt.error)
})

test('parseUnsupported: a real BMP is refused by name rather than by sharp', () => {
  const result = parseUnsupported(path.join(FIXTURES, BITMAP_FIXTURE.fileName))

  assert.equal(result.status, 'error')
  assert.equal(result.type, 'unsupported')
  assert.ok(result.sizeBytes > 0, 'The fixture is a real bitmap, not an empty file')
  assert.equal(result.unsupported?.reason, 'unreadable_image_codec')
  assert.ok(result.error?.includes('Windows Bitmap (.bmp)'), result.error)
  assert.ok(result.error?.includes('.png'), result.error)
  assert.ok(
    !/Input file contains/i.test(result.error ?? ''),
    `sharp's own words reached the user: ${result.error}`,
  )
})

test('parseUnsupported: a refusal carries no library exception text', () => {
  for (const fixture of ['legacy-report.doc', 'legacy-book.xls', 'legacy-deck.ppt', BITMAP_FIXTURE.fileName]) {
    const message = parseUnsupported(path.join(FIXTURES, fixture)).error ?? ''
    assert.ok(
      /invalid signature|central directory|OfficeParser|github|ENOENT|0x[0-9a-f]{4,}/i.test(message) === false,
      `${fixture} refusal is written for a person: ${message}`,
    )
  }
})

// ── A file whose extension lies about its bytes ──

/**
 * What a person is told when the bytes are not the format the name claims.
 *
 * Every parser here delegates to a library, and every one of those libraries raises in its own
 * idiom: jszip points at its documentation, read-excel-file prints the first four bytes in hex,
 * officeparser prefixes itself in brackets, sharp names a codec. None of that is a sentence anyone
 * can act on, and `file-format.ts` renders `parserError` verbatim next to the upload. The library
 * keeps its words — they go to the manifest, where diagnosis happens — and the person gets the
 * name of their file and something to check.
 *
 * The path assertion is the second half: `fs` writes the absolute path of the file into its own
 * errors, and an uploaded file lives under a workspace temp directory nobody should be reading off
 * a card in the UI.
 */

/** Every shape of library noise these parsers have been seen to leak, in one pattern. */
const LIBRARY_NOISE =
  /central directory|jszip|stuk\.github\.io|invalid signature|OfficeParser|Input file contains|0x[0-9a-f]{4,}|ENOENT|https?:\/\//i

function writeMismatched(dir: string, name: string, body: Buffer): string {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, body)
  return filePath
}

const NOT_A_ZIP = Buffer.from('Meeting notes, saved under the wrong extension.\n', 'utf8')

test('a file whose extension lies about its bytes is refused in words, not in the library\'s', () =>
  withTempDir(async (dir) => {
    const cases: Array<{
      name: string
      body: Buffer
      run: (filePath: string) => Promise<ParseResult>
      readAs: string
    }> = [
      { name: 'quarterly.docx', body: NOT_A_ZIP, run: (p) => parseDocx(p, dir), readAs: 'Word' },
      { name: 'ledger.xlsx', body: NOT_A_ZIP, run: (p) => parseXlsx(p, dir), readAs: 'Excel' },
      { name: 'kickoff.pptx', body: NOT_A_ZIP, run: (p) => parsePptx(p, dir), readAs: 'PowerPoint' },
      { name: 'kickoff.odp', body: NOT_A_ZIP, run: (p) => parsePptx(p, dir), readAs: 'OpenDocument' },
      { name: 'field.odt', body: NOT_A_ZIP, run: (p) => parseGeneric(p, dir), readAs: 'OpenDocument' },
      { name: 'yield.ods', body: NOT_A_ZIP, run: (p) => parseGeneric(p, dir), readAs: 'OpenDocument' },
      { name: 'chart.png', body: NOT_A_ZIP, run: (p) => parseImage(p, dir), readAs: 'PNG' },
    ]

    for (const { name, body, run, readAs } of cases) {
      const result = await run(writeMismatched(dir, name, body))
      const message = result.error ?? ''

      assert.equal(result.status, 'error', `${name} must not report success`)
      assert.ok(message.includes(name), `${name} must be named in its own error: ${message}`)
      assert.ok(message.includes(readAs), `${name} must say what it was read as: ${message}`)
      assert.ok(
        !LIBRARY_NOISE.test(message),
        `${name} leaks the library's own words: ${message}`,
      )
      // The file is named by its basename and nothing else, so any separator is a leaked path.
      assert.ok(
        !message.includes(path.sep),
        `${name} leaks a filesystem path: ${message}`,
      )
      const diagnostic = result.metadata['library_error']
      assert.ok(
        typeof diagnostic === 'string' && diagnostic.length > 0,
        `${name} must keep the library's text for diagnosis, not discard it`,
      )
    }
  }))

test('an unreadable plain-text file names the file, not the directory it was uploaded to', () =>
  withTempDir(async (dir) => {
    const result = await parseGeneric(path.join(dir, 'missing-notes.txt'), dir)

    const message = result.error ?? ''
    assert.equal(result.status, 'error')
    assert.ok(message.includes('missing-notes.txt'), message)
    assert.ok(!LIBRARY_NOISE.test(message), `ENOENT text reached the user: ${message}`)
    assert.ok(!message.includes(path.sep), `the temp path reached the user: ${message}`)
    assert.ok(!message.includes(dir), `the temp path reached the user: ${message}`)
  }))

// ── Local PDF OCR ──

test('parsePdf: an image-only page is read locally without a PDF model', () =>
  withTempDir(async (dir) => {
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir)

    assert.equal(result.status, 'success')
    const merged = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(
      merged.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028),
      'The model-facing document must carry the value that exists only as pixels on page 10',
    )
    assert.ok(
      merged.includes(MIXED_OCR_FIXTURE.page10.title),
      'The model-facing document must carry the pictured page title',
    )
    assert.deepEqual(
      result.metadata.ocr_unresolved_pages,
      [],
      'No page of this fixture should be left unresolved',
    )
  }))

test('parsePdf: the pictured table keeps its row and column association', () =>
  withTempDir(async (dir) => {
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir)
    const merged = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    const page10 = merged.slice(merged.indexOf('## Page 10'), merged.indexOf('## Page 11'))

    const header = page10.split('\n').find((line) => line.includes('Line item'))
    const row = page10.split('\n').find((line) => line.includes(MIXED_OCR_FIXTURE.page10.rowLabel))
    assert.ok(header, 'The reconstructed table needs a header row')
    assert.ok(row, 'The reconstructed table needs the requested body row')

    const cells = (line: string): string[] =>
      line.split('|').slice(1, -1).map((cell) => cell.trim())
    const column = cells(header).indexOf(`${MIXED_OCR_FIXTURE.page10.columnPrefix} 2028`)
    assert.ok(column > 0, 'The approved 2028 column must be found by name')
    assert.equal(
      cells(row)[column],
      MIXED_OCR_FIXTURE.page10.salesMarketing2028,
      'The value at Sales & Marketing by Approved 2028 must be the approved figure',
    )
    // The superseded text table on page 3 carries a tempting near-miss for the same row.
    assert.notEqual(
      MIXED_OCR_FIXTURE.page10.salesMarketing2028,
      MIXED_OCR_FIXTURE.page3.salesMarketing2028,
    )
  }))

test('parsePdf: a qualifying figure on a text page is read, a small logo never triggers recognition', () =>
  withTempDir(async (dir) => {
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir)

    assert.equal(result.status, 'success')
    const merged = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    const page4 = merged.slice(merged.indexOf('## Page 4'), merged.indexOf('## Page 5'))
    assert.ok(
      page4.includes(MIXED_OCR_FIXTURE.page4.label),
      'The figure on page 4 contributes the label that exists only as pixels',
    )
    assert.ok(
      page4.includes(MIXED_OCR_FIXTURE.page4.value2028),
      'The figure on page 4 contributes the value that exists only as pixels',
    )

    // These words appear in no text layer anywhere: the extractor's own reading cannot carry them.
    assert.ok(result.outputs.native, 'Region recognition changed the document, so the native reading is kept')
    const native = fs.readFileSync(path.join(dir, result.outputs.native), 'utf-8')
    assert.ok(!native.includes(MIXED_OCR_FIXTURE.page4.label))
    assert.ok(!native.includes(MIXED_OCR_FIXTURE.page4.value2028))

    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, result.outputs.parse), 'utf-8'),
    )
    const ocr = (parsed as { ocr: { requestedPages: number[]; pages: Array<Record<string, unknown>> } }).ocr
    const byPage = new Map(ocr.pages.map((page) => [page.page, page]))
    assert.equal(byPage.get(MIXED_OCR_FIXTURE.figurePage)?.source, 'mixed')
    assert.equal(byPage.get(MIXED_OCR_FIXTURE.figurePage)?.status, 'read')
    // The 3 200 pt² logo on page 2 is under both region rules: the page keeps its native text
    // and is never offered to the recognizer.
    assert.equal(byPage.get(MIXED_OCR_FIXTURE.logoPage)?.source, 'pdf')
    assert.ok(ocr.requestedPages.includes(MIXED_OCR_FIXTURE.figurePage))
    assert.ok(!ocr.requestedPages.includes(MIXED_OCR_FIXTURE.logoPage))
  }))

test('parsePdf: page provenance records what read each page and what became of it', () =>
  withTempDir(async (dir) => {
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir)
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, result.outputs.parse), 'utf-8'),
    )
    assert.ok(parsed && typeof parsed === 'object' && 'ocr' in parsed)
    const ocr = parsed.ocr as { pages: Array<Record<string, unknown>> }

    const byPage = new Map(ocr.pages.map((page) => [page.page, page]))
    assert.equal(byPage.get(1)?.source, 'pdf')
    assert.equal(byPage.get(1)?.status, 'read')
    assert.equal(byPage.get(MIXED_OCR_FIXTURE.imageOnlyPage)?.source, 'ocr')
    assert.equal(byPage.get(MIXED_OCR_FIXTURE.imageOnlyPage)?.status, 'read')
    assert.equal(byPage.get(MIXED_OCR_FIXTURE.imageOnlyPage)?.originallyNeededOcr, true)
    assert.equal(byPage.get(MIXED_OCR_FIXTURE.blankPage)?.status, 'empty')
    assert.equal(byPage.get(MIXED_OCR_FIXTURE.blankPage)?.source, 'none')
    // Page numbers stay one-based at every boundary.
    assert.deepEqual(
      ocr.pages.map((page) => page.page),
      Array.from({ length: MIXED_OCR_FIXTURE.pageCount }, (_unused, index) => index + 1),
    )
  }))

test('parsePdf: the extractor own reading stays available beside the merged document', () =>
  withTempDir(async (dir) => {
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir)

    assert.ok(result.outputs.native, 'The native extraction is kept for regression comparison')
    const native = fs.readFileSync(path.join(dir, result.outputs.native), 'utf-8')
    const merged = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(
      !native.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028),
      'The extractor never read the pictured page, so its own reading cannot contain the answer',
    )
    assert.ok(merged.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028))
  }))

test('parsePdf: a text-only document keeps the deterministic artifact it already produced', () =>
  withTempDir(async (withOcr) =>
    withTempDir(async (withoutOcr) => {
      const source = path.join(withOcr, 'text-heavy.pdf')
      await createTextHeavyPdf(source)

      const enabled = await parsePdf(source, withOcr)
      const disabled = await parsePdf(source, withoutOcr, { disableLocalOcr: true })

      assert.equal(enabled.status, 'success')
      assert.equal(enabled.ocr?.applied, false)
      assert.equal(enabled.outputs.native, undefined)
      assert.deepEqual(
        fs.readFileSync(path.join(withOcr, enabled.outputs.text)),
        fs.readFileSync(path.join(withoutOcr, disabled.outputs.text)),
        'A document that needs no OCR produces byte-identical canonical markdown',
      )
    })))

test('parsePdf: an unrecognized page is named as unresolved and the readable pages survive', () =>
  withTempDir(async (dir) => {
    // The recognition boundary is substituted narrowly: the real renderer streams the real
    // fixture, and only the engine's answer for the chart page is replaced. Recognition targets
    // run in page order — figure region 4, then whole pages 10, 12, 13 — so the chart page is
    // the third call.
    let call = 0
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir, {
      ocr: {
        createRecognizer: async () => {
          const { createTesseractRecognizer } = await import('../ocr/tesseract-engine.js')
          const real = await createTesseractRecognizer()
          return {
            async recognize(image) {
              call += 1
              if (call === 3) throw new Error('recognition failed for this page')
              return real.recognize(image)
            },
            close: () => real.close(),
          }
        },
      },
    })

    assert.equal(result.status, 'success', 'One unreadable page is not a failed document')
    assert.equal(result.ocr?.status, 'partial')
    assert.deepEqual(result.ocr?.unresolvedPages, [MIXED_OCR_FIXTURE.chartPage])
    assert.ok(!result.ocr?.emptyPages.includes(MIXED_OCR_FIXTURE.chartPage))

    const merged = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    const page12 = merged.slice(merged.indexOf('## Page 12'), merged.indexOf('## Page 13'))
    assert.match(page12, /could not be read/)
    assert.ok(
      merged.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028),
      'The page that was read stays readable when another page is unresolved',
    )
  }))

test('parsePdf: cancellation is an outcome, not a parse error', () =>
  withTempDir(async (dir) => {
    const controller = new AbortController()
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir, {
      signal: controller.signal,
      ocr: {
        createRecognizer: async () => ({
          async recognize() {
            controller.abort()
            return { text: 'Approved operating plan 5170', lines: [] }
          },
          async close() {},
        }),
      },
    })

    assert.equal(result.status, 'success')
    assert.equal(result.ocr?.status, 'cancelled')
    const merged = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
    assert.ok(merged.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028))
    const page13 = merged.slice(merged.indexOf('## Page 13'))
    assert.match(page13, /could not be read/, 'A page cancellation prevented is a gap, not a blank')
  }))

test('parsePdf: a recognition cancelled after its last page does not claim missing text', () =>
  withTempDir(async (dir) => {
    // The signal fires as the final targeted page's recognition returns: every page owed a
    // reading got one, and the cancellation is observed at the boundary right after it.
    const controller = new AbortController()
    let call = 0
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir, {
      signal: controller.signal,
      ocr: {
        createRecognizer: async () => ({
          async recognize() {
            call += 1
            if (call === 4) controller.abort()
            return { text: 'Approved operating plan 5170', lines: [] }
          },
          async close() {},
        }),
      },
    })

    assert.equal(result.status, 'success')
    assert.equal(result.ocr?.status, 'cancelled')
    assert.deepEqual(
      result.ocr?.unresolvedPages,
      [],
      'Every page that needed reading was read before the cancellation was observed',
    )

    const note = result.note ?? ''
    assert.doesNotMatch(
      note,
      /incomplete|could not be read|unread/i,
      'No page remains unread, so the note must not claim missing text whatever the status',
    )
  }))

test('parsePdf: a missing OCR asset is an installation error, not a blank document', () =>
  withTempDir(async (dir) =>
    withTempDir(async (emptyAssetDir) => {
      const previous = process.env[OCR_LANGUAGE_DATA_DIR_ENV]
      process.env[OCR_LANGUAGE_DATA_DIR_ENV] = emptyAssetDir
      try {
        const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir)

        assert.equal(result.status, 'success')
        assert.equal(result.ocr?.status, 'partial')
        // The qualifying figure region on page 4 is owed a reading too, and an engine that
        // cannot start owes it as much as the pages that needed recognition outright.
        assert.deepEqual(result.ocr?.unresolvedPages, [
          MIXED_OCR_FIXTURE.figurePage,
          MIXED_OCR_FIXTURE.imageOnlyPage,
          MIXED_OCR_FIXTURE.chartPage,
          MIXED_OCR_FIXTURE.blankPage,
        ])
        assert.deepEqual(result.ocr?.emptyPages, [], 'An unread page is never recorded as blank')

        const failure = String(result.metadata.ocr_failure ?? '')
        assert.match(failure, /language data is missing/)
        assert.ok(
          !failure.includes(emptyAssetDir),
          'Product-facing text names the logical asset, never a path on the user machine',
        )

        const merged = fs.readFileSync(path.join(dir, result.outputs.text), 'utf-8')
        assert.ok(merged.includes('Operating Plan'), 'Native pages survive a missing OCR asset')
        assert.ok(!merged.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028))
      } finally {
        if (previous === undefined) delete process.env[OCR_LANGUAGE_DATA_DIR_ENV]
        else process.env[OCR_LANGUAGE_DATA_DIR_ENV] = previous
      }
    })))

test('parsePdf: a fully OCR-recovered document does not claim its text is still missing', () =>
  withTempDir(async (dir) => {
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir)

    assert.equal(result.status, 'success')
    assert.equal(result.ocr?.status, 'complete')
    assert.deepEqual(result.ocr?.unresolvedPages, [])
    assert.equal(
      result.requiresLlm,
      true,
      'requiresLlm stays a pre-recognition signal: flagged pages may still warrant interpretation',
    )

    const note = result.note ?? ''
    assert.doesNotMatch(
      note,
      /incomplete|could not be read|unread/i,
      'No page remains unread, so the note must not claim missing text',
    )
    assert.match(note, /recovered locally/i, 'The note says the text was recovered locally')
    assert.match(
      note,
      /semantic interpretation/i,
      'The note distinguishes recovered text from the remaining optional interpretation',
    )
  }))

test('parsePdf: the parser boundary supplies the recognition clock', () =>
  withTempDir(async (dir) => {
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir, {
      ocr: {
        createRecognizer: async () => ({
          async recognize() {
            return { text: 'seam reading', lines: [] }
          },
          async close() {},
        }),
      },
    })

    assert.equal(result.status, 'success')
    // The coordinator owns no clock: without one supplied at this boundary there is no summary.
    const elapsedMs = result.ocr?.elapsedMs
    assert.ok(
      typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0,
      'A real parse reports real elapsed time, measured on the clock the parser supplied',
    )
    assert.equal(result.metadata.ocr_error, undefined, 'Recognition ran, not errored')
  }))

test('parsePdf: a document with genuinely unresolved pages still says its text is incomplete', () =>
  withTempDir(async (dir) => {
    // The recognition boundary is substituted narrowly: only the engine's answer for the
    // chart page — the third recognition target, after figure region 4 and whole page 10 —
    // is replaced, leaving that page genuinely unresolved.
    let call = 0
    const result = await parsePdf(path.join(FIXTURES, MIXED_OCR_FIXTURE.fileName), dir, {
      ocr: {
        createRecognizer: async () => {
          const { createTesseractRecognizer } = await import('../ocr/tesseract-engine.js')
          const real = await createTesseractRecognizer()
          return {
            async recognize(image) {
              call += 1
              if (call === 3) throw new Error('recognition failed for this page')
              return real.recognize(image)
            },
            close: () => real.close(),
          }
        },
      },
    })

    assert.equal(result.ocr?.status, 'partial')
    assert.deepEqual(result.ocr?.unresolvedPages, [MIXED_OCR_FIXTURE.chartPage])

    const note = result.note ?? ''
    assert.match(note, /incomplete/i, 'An unresolved page is missing text and the note must say so')
    assert.match(
      note,
      /could not be read/i,
      'The note still says pages remain unread when they do',
    )
    assert.ok(
      note.includes(String(MIXED_OCR_FIXTURE.chartPage)),
      'The note names the page that remains unread',
    )
  }))
