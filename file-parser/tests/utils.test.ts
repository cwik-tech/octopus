import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectType,
  shouldSkip,
  unsupportedFormat,
  EXTENSION_MAP,
  LEGACY_BINARY_OFFICE_FORMATS,
  REFUSED_FORMATS,
} from '../utils/detect.js'
import {
  REFUSED_UPLOAD_EXTENSIONS,
  UPLOADABLE_DOCUMENT_EXTENSIONS,
} from '../../contracts/uploadable-formats.js'
import { markdownTable, frontmatter, wrapDocument } from '../utils/markdown.js'

// ── detectType ──

test('detectType: PDF', () => {
  assert.equal(detectType('report.pdf'), 'pdf')
  assert.equal(detectType('REPORT.PDF'), 'pdf')
})

test('detectType: DOCX', () => {
  assert.equal(detectType('plan.docx'), 'docx')
})

test('detectType: XLSX and related', () => {
  assert.equal(detectType('data.xlsx'), 'xlsx')
  // OpenDocument is not OOXML; the OOXML reader cannot open it, officeparser can.
  assert.equal(detectType('sheet.ods'), 'generic')
})

test('detectType: images', () => {
  assert.equal(detectType('photo.jpg'), 'image')
  assert.equal(detectType('photo.jpeg'), 'image')
  assert.equal(detectType('icon.png'), 'image')
  assert.equal(detectType('anim.gif'), 'image')
  assert.equal(detectType('modern.webp'), 'image')
  assert.equal(detectType('apple.heic'), 'image')
})

test('detectType: PowerPoint', () => {
  assert.equal(detectType('slides.pptx'), 'pptx')
  // The pptx parser is officeparser-backed, and officeparser reads .odp.
  assert.equal(detectType('libre.odp'), 'pptx')
})

test('detectType: legacy binary Office formats are refused, not routed at a reader', () => {
  assert.equal(detectType('old.doc'), 'unsupported')
  assert.equal(detectType('legacy.xls'), 'unsupported')
  assert.equal(detectType('deck.ppt'), 'unsupported')
  assert.equal(detectType('SHOUTING.DOC'), 'unsupported')
})

test('detectType: every refused format has a refusal, and every refusal is refused', () => {
  assert.ok(
    Object.keys(LEGACY_BINARY_OFFICE_FORMATS).length > 0,
    'the legacy Office table is still part of the refusal set',
  )
  for (const [ext, format] of Object.entries(REFUSED_FORMATS)) {
    assert.equal(
      detectType(`file${ext}`),
      'unsupported',
      `${ext} has a refusal message, so detection must route it as unsupported`,
    )
    assert.equal(format.extension, ext, `${ext} refusal names its own extension`)
    assert.ok(format.format.includes(ext), `${ext} refusal names the format`)
    assert.ok(format.remedy.length > 0, `${ext} refusal carries a remedy`)
  }
})

test('detectType: a BMP is refused by name, because this sharp build cannot read one', () => {
  // libvips reads BMP only through its magick loader, and `sharp.format.magick.input.file` is
  // false in the build this package ships. Routing a .bmp at the image parser produced sharp's
  // own "Input file contains unsupported image format", which names no file and offers no way
  // out. Detection refuses it the way it refuses a .doc: by name, with a remedy.
  assert.equal(detectType('chart.bmp'), 'unsupported')
  assert.equal(detectType('CHART.BMP'), 'unsupported')
  assert.equal(unsupportedFormat('chart.bmp')?.reason, 'unreadable_image_codec')
  assert.ok(unsupportedFormat('chart.bmp')?.remedy.includes('.png'))
})

test('detectType: every image format that is still routed is one sharp can open', () => {
  // The other ten stay routed at the image parser, so refusing BMP must not have been a blanket
  // retreat from images.
  for (const extension of ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tiff', '.tif', '.svg']) {
    assert.equal(detectType(`photo${extension}`), 'image', `${extension} must still be parsed`)
  }
})

test('unsupportedFormat: names the format and the remedy, or nothing at all', () => {
  assert.equal(unsupportedFormat('old.doc')?.reason, 'legacy_binary_office')
  assert.ok(unsupportedFormat('old.doc')?.remedy.includes('.docx'))
  assert.ok(unsupportedFormat('legacy.xls')?.remedy.includes('.xlsx'))
  assert.ok(unsupportedFormat('deck.ppt')?.remedy.includes('.pptx'))
  assert.equal(unsupportedFormat('plan.docx'), null)
  assert.equal(unsupportedFormat('notes.txt'), null)
})

test('detectType: generic/text files', () => {
  assert.equal(detectType('notes.txt'), 'generic')
  assert.equal(detectType('readme.md'), 'generic')
  assert.equal(detectType('config.json'), 'generic')
  assert.equal(detectType('data.csv'), 'generic')
  assert.equal(detectType('data.yaml'), 'generic')
  assert.equal(detectType('doc.rtf'), 'generic')
  assert.equal(detectType('page.html'), 'generic')
})

test('detectType: unknown extension defaults to generic', () => {
  assert.equal(detectType('mystery.xyz'), 'generic')
  assert.equal(detectType('noext'), 'generic')
})

// ── shouldSkip ──

test('shouldSkip: hidden files', () => {
  assert.equal(shouldSkip('.DS_Store'), true)
  assert.equal(shouldSkip('.hidden'), true)
  assert.equal(shouldSkip('.gitignore'), true)
})

test('shouldSkip: manifest file', () => {
  assert.equal(shouldSkip('_manifest.json'), true)
})

test('shouldSkip: normal files pass through', () => {
  assert.equal(shouldSkip('report.pdf'), false)
  assert.equal(shouldSkip('photo.jpg'), false)
  assert.equal(shouldSkip('data.xlsx'), false)
})

// ── markdownTable ──

test('markdownTable: basic table', () => {
  const result = markdownTable(
    ['Name', 'Value'],
    [['Alice', '10'], ['Bob', '20']],
  )
  assert.ok(result.includes('| Name | Value |'))
  assert.ok(result.includes('| --- | --- |'))
  assert.ok(result.includes('| Alice | 10 |'))
  assert.ok(result.includes('| Bob | 20 |'))
})

test('markdownTable: escapes pipe characters', () => {
  const result = markdownTable(
    ['Data'],
    [['value|with|pipes']],
  )
  assert.ok(result.includes('value\\|with\\|pipes'))
})

test('markdownTable: empty headers returns empty string', () => {
  assert.equal(markdownTable([], []), '')
})

// ── frontmatter ──

test('frontmatter: generates YAML-like block', () => {
  const result = frontmatter({ type: 'pdf', pages: 5 })
  assert.ok(result.startsWith('---'))
  assert.ok(result.endsWith('---'))
  assert.ok(result.includes('type: "pdf"'))
  assert.ok(result.includes('pages: 5'))
})

test('frontmatter: skips null/undefined values', () => {
  const result = frontmatter({ a: 'yes', b: null, c: undefined })
  assert.ok(result.includes('a: "yes"'))
  assert.ok(!result.includes('b:'))
  assert.ok(!result.includes('c:'))
})

// ── wrapDocument ──

test('wrapDocument: includes source header and content', () => {
  const result = wrapDocument('file.pdf', 'Some text content')
  assert.ok(result.includes('# file.pdf'))
  assert.ok(result.includes('Some text content'))
})

test('wrapDocument: includes frontmatter when metadata provided', () => {
  const result = wrapDocument('file.pdf', 'Content', { type: 'pdf', pages: 3 })
  assert.ok(result.includes('---'))
  assert.ok(result.includes('source: "file.pdf"'))
  assert.ok(result.includes('type: "pdf"'))
})

// ── The desktop pickers and this package's routing agree ──

/**
 * An `accept` list that offers a format detection refuses is a trap: the file uploads and the card
 * next to it reads "error". One that leaves out a format detection routes at a reader is a
 * capability the app has and hides.
 *
 * The list is imported from `contracts/uploadable-formats.ts` — the same module the renderer, both
 * domain stores, and both HTTP routes read — rather than scraped out of the renderer's source. The
 * previous version of this file read the renderer alone, which is precisely why the picker could
 * grow nine extensions past the servers with every test still green.
 */
const accepted = new Set<string>(UPLOADABLE_DOCUMENT_EXTENSIONS)

test('detectType: the desktop pickers offer nothing this package refuses', () => {
  assert.ok(accepted.size > 8, 'The shared accept list was found')
  for (const extension of accepted) {
    assert.notEqual(
      detectType(`upload${extension}`),
      'unsupported',
      `${extension} is offered by a picker, so it must not be refused`,
    )
  }
})

test('detectType: no refused format is offered by a desktop picker', () => {
  for (const extension of Object.keys(REFUSED_FORMATS)) {
    assert.equal(
      accepted.has(extension),
      false,
      `${extension} is refused, so no picker may offer it`,
    )
  }
})

test('detectType: the refusal table and the renderer name the same refused formats', () => {
  assert.deepEqual(
    Object.keys(REFUSED_FORMATS).sort(),
    [...REFUSED_UPLOAD_EXTENSIONS].sort(),
    'a format refused here must be a format the renderer knows is refused',
  )
})

test('detectType: the OpenDocument formats this package reads are offered', () => {
  for (const extension of ['.odt', '.ods', '.odp']) {
    assert.ok(accepted.has(extension), `${extension} parses, so a picker should offer it`)
    assert.notEqual(detectType(`upload${extension}`), 'unsupported')
  }
})

/**
 * The reverse direction, which nothing asserted before: a format this package routes at a reader
 * and no picker offers is a capability the app has and hides.
 *
 * Images are the one exception, and a deliberate one. Project and team context is *document*
 * context — an image contributes no text to a brief — and the chat composer, which applies no
 * `accept` filter at all, is where a person attaches one. So images are excluded here by name
 * rather than by the list quietly omitting them.
 */
test('detectType: every non-image format this package reads is offered by a picker', () => {
  const hidden: string[] = []
  for (const [extension, parser] of Object.entries(EXTENSION_MAP)) {
    if (parser === 'image' || parser === 'unsupported') continue
    if (!accepted.has(extension)) hidden.push(extension)
  }
  assert.deepEqual(
    hidden,
    [],
    'these formats parse but no picker offers them; add them or route them elsewhere',
  )
})

test('detectType: the image formats a picker withholds are withheld on purpose, not by incapacity', () => {
  const images = Object.entries(EXTENSION_MAP)
    .filter(([, parser]) => parser === 'image')
    .map(([extension]) => extension)

  assert.ok(images.length >= 10, 'the image routes are still here to be withheld')
  for (const extension of images) {
    assert.equal(
      accepted.has(extension),
      false,
      `${extension} is document-context-excluded by choice; the docstring must stay true`,
    )
  }
})
