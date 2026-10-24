/**
 * Generate test fixture files for file-parser tests.
 * Run once: npx tsx tests/create-fixtures.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import sharp from 'sharp'
import { writePublicFixtures } from './public-fixtures.js'
import writeXlsxFile from 'write-excel-file/node'
import { writeBitmapFixture } from './bitmap-fixture.js'
import { writeLegacyOfficeFixtures } from './legacy-office-fixture.js'
import { writeOpenDocumentFixtures } from './opendocument-fixture.js'
import { writeRichTextFixture } from './rich-text-fixture.js'

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures')
fs.mkdirSync(FIXTURES_DIR, { recursive: true })

// ── OpenDocument (.odt, .ods, .odp) and legacy binary Office (.doc, .xls, .ppt) ──
// Authored as real packages rather than exported from an office suite; see each module.
for (const created of await writeOpenDocumentFixtures(FIXTURES_DIR)) {
  console.log('Created', path.basename(created))
}
for (const created of writeLegacyOfficeFixtures(FIXTURES_DIR)) {
  console.log('Created', path.basename(created))
}

// ── Rich Text (.rtf), read by officeparser, and a Windows Bitmap (.bmp), refused by name ──
console.log('Created', path.basename(writeRichTextFixture(FIXTURES_DIR)))
console.log('Created', path.basename(writeBitmapFixture(FIXTURES_DIR)))

// Synthetic PDFs and DOCX; no private input-files are read.
await writePublicFixtures(FIXTURES_DIR)

// ── Small test image (100x80 red rectangle with blue stripe) ──
await sharp({
  create: {
    width: 100,
    height: 80,
    channels: 3,
    background: { r: 200, g: 50, b: 50 },
  },
})
  .jpeg({ quality: 90 })
  .toFile(path.join(FIXTURES_DIR, 'test-photo.jpg'))
console.log('Created test-photo.jpg')

// ── Large-ish test image (2000x1500 — will need thumbnail) ──
await sharp({
  create: {
    width: 2000,
    height: 1500,
    channels: 3,
    background: { r: 30, g: 100, b: 200 },
  },
})
  .jpeg({ quality: 85 })
  .toFile(path.join(FIXTURES_DIR, 'large-photo.jpg'))
console.log('Created large-photo.jpg')

// ── Small PNG image ──
await sharp({
  create: {
    width: 50,
    height: 50,
    channels: 4,
    background: { r: 0, g: 200, b: 0, alpha: 0.8 },
  },
})
  .png()
  .toFile(path.join(FIXTURES_DIR, 'icon.png'))
console.log('Created icon.png')

// ── XLSX with two sheets ──
const sheet1Data = [
  ['Name', 'Crop', 'Yield Increase', 'ROI Years'],
  ['Farm Alpha', 'Corn', '61%', '3'],
  ['Farm Beta', 'Soybeans', '88%', '2'],
  ['Farm Gamma', 'Cotton', '302%', '4'],
]
const sheet2Data = [
  ['Year', 'Revenue', 'Expenses', 'Profit'],
  ['2024', '$30,000', '$25,000', '$5,000'],
  ['2026', '$250,000', '$180,000', '$70,000'],
  ['2028', '$600,000', '$400,000', '$200,000'],
  ['2030', '$1,300,000', '$800,000', '$500,000'],
]
await writeXlsxFile([
  { sheet: 'Yield Data', data: sheet1Data },
  { sheet: 'Financials', data: sheet2Data },
]).toFile(path.join(FIXTURES_DIR, 'financials.xlsx'))
console.log('Created financials.xlsx')

// ── Empty XLSX (edge case) ──
await writeXlsxFile([{ sheet: 'Empty', data: [] }])
  .toFile(path.join(FIXTURES_DIR, 'empty.xlsx'))
console.log('Created empty.xlsx')

// ── Plain text file ──
fs.writeFileSync(
  path.join(FIXTURES_DIR, 'notes.txt'),
  'Meeting notes from 2026-03-15:\n\n- Discussed ExampleCo membrane installation timeline\n- Budget approved for 8 additional MICs\n- Next review: April 2026\n',
)
console.log('Created notes.txt')

// ── CSV file ──
fs.writeFileSync(
  path.join(FIXTURES_DIR, 'yield-data.csv'),
  'Farm,Crop,Yield Increase,ROI Years\nFarm Alpha,Corn,61%,3\nFarm Beta,Soybeans,88%,2\nFarm Gamma,Cotton,302%,4\n',
)
console.log('Created yield-data.csv')

// ── Markdown file ──
fs.writeFileSync(
  path.join(FIXTURES_DIR, 'readme.md'),
  '# Project Overview\n\nThis is a test markdown file.\n\n## Features\n\n- Feature A\n- Feature B\n',
)
console.log('Created readme.md')

// ── JSON file ──
fs.writeFileSync(
  path.join(FIXTURES_DIR, 'config.json'),
  JSON.stringify({ name: 'test', version: '1.0', enabled: true }, null, 2),
)
console.log('Created config.json')

// ── Hidden file (should be skipped) ──
fs.writeFileSync(path.join(FIXTURES_DIR, '.hidden'), 'should be ignored')
console.log('Created .hidden')

console.log('\nAll fixtures created in:', FIXTURES_DIR)
