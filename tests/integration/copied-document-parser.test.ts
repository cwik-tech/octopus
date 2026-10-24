import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { parseDocumentCopy } from '../../domains/document-access/copied-document-parser.js'
import { makeTextPdf } from '../helpers/text-pdf.js'
import { readFile } from 'node:fs/promises'

test('legacy or selected project PDF originals can be read into a complete canonical page index', { timeout: 30_000 }, async () => {
  const original = makeTextPdf(2)
  const saved = Buffer.from(original)
  const result = await parseDocumentCopy({ name: 'evidence.pdf', contents: original, launcher: new SourceFileParserLauncher(process.cwd()), signal: AbortSignal.timeout(25_000) })
  assert.equal(result.pages?.length, 2)
  assert.match(result.pages?.[1]?.markdown ?? '', /PAGE_FACT_2=verified/)
  assert.match(result.text ?? '', /PAGE_FACT_2=verified/)
  assert.deepEqual(original, saved)
})

test('a 434-page PDF retains its final page in canonical evidence', { timeout: 30_000 }, async () => {
  const result = await parseDocumentCopy({ name: 'large.pdf', contents: makeTextPdf(434), launcher: new SourceFileParserLauncher(process.cwd()), signal: AbortSignal.timeout(25_000) })
  assert.equal(result.pages?.length, 434)
  assert.match(result.pages?.[433]?.markdown ?? '', /PAGE_FACT_434=verified/)
})

test('a captured JPG exposes its prepared visual content without requiring extracted text', async () => {
  const original = await readFile('file-parser/tests/fixtures/test-photo.jpg')
  const saved = Buffer.from(original)
  const result = await parseDocumentCopy({ name: 'SCREENSHOT.JPG', contents: original, launcher: new SourceFileParserLauncher(process.cwd()), signal: AbortSignal.timeout(10_000) })
  assert.equal(result.text, null)
  assert.equal(result.image?.mimeType, 'image/jpeg')
  assert.ok(result.image?.data)
  assert.deepEqual(Buffer.from(result.image.data, 'base64').subarray(0, 2), Buffer.from([0xff, 0xd8]))
  assert.deepEqual(original, saved)
})
