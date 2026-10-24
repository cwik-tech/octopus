/**
 * A long image-only document, generated rather than committed.
 *
 * The resource question this answers is whether recognition memory grows with one rendered page
 * or with the document's page count, and answering it needs a document long enough for the
 * difference to show. A large repeated binary does not belong in the repository, so it is built
 * when the opt-in measurement runs and deleted afterwards.
 */
import * as fs from 'node:fs'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'

/** One page of ink, as a PNG. Drawn from SVG because the page has to be pixels, not text. */
export async function scannedPageImage(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1224" height="1584">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="90" y="150" font-family="Helvetica" font-size="44" font-weight="bold" fill="#000000">Quarterly archive</text>
    <text x="90" y="240" font-family="Helvetica" font-size="30" fill="#000000">Scanned page retained for resource bound verification.</text>
    <text x="90" y="290" font-family="Helvetica" font-size="30" fill="#000000">The content is repeated; only the page count matters.</text>
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** Write an image-only PDF of `pageCount` identical scanned pages. */
export async function writeScannedStressPdf(
  filePath: string,
  pageCount: number,
): Promise<void> {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error('A scanned stress PDF needs at least one page.')
  }
  const image = await scannedPageImage()
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0 })
    const stream = fs.createWriteStream(filePath)
    doc.pipe(stream)
    for (let page = 0; page < pageCount; page += 1) {
      if (page > 0) doc.addPage()
      doc.image(image, 0, 0, { width: 612, height: 792 })
    }
    stream.on('close', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.end()
  })
}
