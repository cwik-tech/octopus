/**
 * OpenDocument fixture builder.
 *
 * An OpenDocument file is a ZIP holding a `mimetype` entry and a `content.xml`, so the fixtures
 * are authored here rather than exported from an office suite. officeparser routes .odt/.ods/.odp
 * to its OpenDocument reader and then picks the body shape from the `mimetype` entry, so each
 * fixture carries both the extension and the matching mimetype.
 *
 * The bytes live in `tests/fixtures/` and are tracked; this module records how they were made and
 * lets `create-fixtures.ts` regenerate them.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import JSZip from 'jszip'

const OFFICE_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
].join(' ')

function documentContent(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${OFFICE_NS} office:version="1.3"><office:body>${body}</office:body></office:document-content>\n`
}

/** ODT body: a heading and two paragraphs. */
function textBody(): string {
  return [
    '<office:text>',
    '<text:h text:outline-level="1">Membrane Rollout Notes</text:h>',
    '<text:p>Farm Beta reported a yield increase after the second install window.</text:p>',
    '<text:p>The operations team reviews packing throughput every Thursday.</text:p>',
    '</office:text>',
  ].join('')
}

/** ODS body: one named sheet with a header row and two data rows. */
function spreadsheetBody(): string {
  const cell = (value: string): string =>
    `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`
  const row = (values: string[]): string =>
    `<table:table-row>${values.map(cell).join('')}</table:table-row>`
  return [
    '<office:spreadsheet>',
    '<table:table table:name="Yield Data">',
    row(['Farm', 'Crop', 'Yield Increase']),
    row(['Farm Beta', 'Soybeans', '88%']),
    row(['Farm Gamma', 'Cotton', '302%']),
    '</table:table>',
    '</office:spreadsheet>',
  ].join('')
}

/** ODP body: two slides, each a text box inside a frame. */
function presentationBody(): string {
  const slide = (name: string, lines: string[]): string =>
    `<draw:page draw:name="${name}"><draw:frame><draw:text-box>${lines
      .map((line) => `<text:p>${line}</text:p>`)
      .join('')}</draw:text-box></draw:frame></draw:page>`
  return [
    '<office:presentation>',
    slide('page1', ['Pilot Cohort Review', 'Harvest delays fell across every site.']),
    slide('page2', ['Next Wave', 'Margin expansion and service logistics.']),
    '</office:presentation>',
  ].join('')
}

const OPEN_DOCUMENT_FIXTURES = [
  {
    fileName: 'field-notes.odt',
    mimetype: 'application/vnd.oasis.opendocument.text',
    content: documentContent(textBody()),
  },
  {
    fileName: 'yield-data.ods',
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    content: documentContent(spreadsheetBody()),
  },
  {
    fileName: 'pilot-review.odp',
    mimetype: 'application/vnd.oasis.opendocument.presentation',
    content: documentContent(presentationBody()),
  },
] as const

/**
 * Write the three OpenDocument fixtures into `fixturesDir` and return their paths.
 *
 * `mimetype` is written first and uncompressed, the way the ODF package spec requires, so the
 * files are real OpenDocument packages rather than something only this repo's reader accepts.
 */
export async function writeOpenDocumentFixtures(fixturesDir: string): Promise<string[]> {
  const written: string[] = []
  for (const fixture of OPEN_DOCUMENT_FIXTURES) {
    const zip = new JSZip()
    zip.file('mimetype', fixture.mimetype, { compression: 'STORE' })
    zip.file('content.xml', fixture.content)
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const filePath = path.join(fixturesDir, fixture.fileName)
    fs.writeFileSync(filePath, buffer)
    written.push(filePath)
  }
  return written
}
