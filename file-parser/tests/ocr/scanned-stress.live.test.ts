/**
 * Opt-in resource measurement: a 60-page image-only document.
 *
 * Recognition holds one rendered page and one worker, so memory must grow with the page, not
 * with the document. Run with `npm --prefix file-parser run test:ocr:stress`; the default suite
 * skips it because the run costs about a minute and builds a large temporary file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parsePdf } from '../../parsers/pdf.js'
import { writeScannedStressPdf } from './scanned-stress.test-support.js'

const STRESS_ENV = 'FILE_PARSER_OCR_STRESS'
const PAGE_COUNT = 60

test('a 60-page scan is read one page at a time inside the parser process timeout', async (t) => {
  if (process.env[STRESS_ENV] !== '1') {
    t.skip(`Set ${STRESS_ENV}=1 to run the opt-in OCR resource measurement`)
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-stress-'))
  const source = path.join(dir, 'quarterly-archive.pdf')
  try {
    await writeScannedStressPdf(source, PAGE_COUNT)

    const startRss = process.memoryUsage().rss
    let peakRss = startRss
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }, 25)
    const startedAt = Date.now()
    const result = await parsePdf(source, dir)
    const elapsedMs = Date.now() - startedAt
    clearInterval(sampler)

    t.diagnostic(
      `${PAGE_COUNT} pages in ${elapsedMs} ms (${Math.round(elapsedMs / PAGE_COUNT)} ms/page), ` +
      `peak RSS ${Math.round(peakRss / 1_048_576)} MB`,
    )

    assert.equal(result.status, 'success')
    assert.equal(result.ocr?.status, 'complete')
    assert.equal(result.ocr?.readPages.length, PAGE_COUNT)
    assert.deepEqual(result.ocr?.unresolvedPages, [])
    // The parser child process is terminated after five minutes.
    assert.ok(
      elapsedMs < 5 * 60 * 1_000,
      `A ${PAGE_COUNT}-page scan must finish inside the parser process timeout`,
    )
    // Recognition holds one rendered page and one worker. With `pdfjs-dist` as the renderer,
    // each page's canvas, operator list and image data are released before the next page is
    // rendered and `close()` destroys the document: a post-GC probe is flat from page 10 to
    // page 60. What remains in the sampled peak is garbage the collector had not yet run
    // against, not retention.
    //
    // Measured on this branch: peak 1 164 MB and 4.4 MB per sampled page, against 1 863 MB
    // and 15.5 MB per page with the previous `pdf-to-img` renderer (which exposed no cleanup).
    // The assertions below are ceilings taken from that measurement with headroom; the old
    // renderer violates both.
    const perPageMb = (peakRss - startRss) / 1_048_576 / PAGE_COUNT
    const peakMb = Math.round(peakRss / 1_048_576)
    t.diagnostic(`peak ${peakMb} MB, sampled growth ${perPageMb.toFixed(1)} MB per page`)
    assert.ok(
      peakMb < 1_400,
      `Peak RSS ${peakMb} MB exceeds the measured ceiling for a ${PAGE_COUNT}-page scan`,
    )
    assert.ok(
      perPageMb < 6,
      `Per-page growth ${perPageMb.toFixed(1)} MB suggests whole page rasters are being retained`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
