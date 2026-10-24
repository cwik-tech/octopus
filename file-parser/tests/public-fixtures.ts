/** Synthetic fixtures only: never copy private input-files into the test suite. */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { Document, ImageRun, Packer, Paragraph } from 'docx'

/** Minimal PDF with direct metadata, explicit text positions and a synthetic image. */
async function writePdf(file: string, pages: string[], image: Buffer): Promise<void> {
  const objects: Buffer[] = []
  const add = (text: string | Buffer) => objects.push(Buffer.isBuffer(text) ? text : Buffer.from(text))
  const pageIds = pages.map((_, index) => 6 + index * 2)
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  add('<< /Title (PowerPoint Presentation) /Author (Pipeline Contributors) >>')
  add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 640 /Height 360 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]))
  for (const [index, content] of pages.entries()) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 540] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 5 0 R >> >> /Contents ${7 + index * 2} 0 R >>`)
    add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  }
  const chunks = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  let length = chunks[0]?.length ?? 0
  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    chunks.push(chunk)
    length += chunk.length
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${length}\n%%EOF\n`))
  await writeFile(file, Buffer.concat(chunks))
}

function text(value: string, x: number, y: number, size = 14): string {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${value}) Tj ET\n`
}

export async function writePublicFixtures(directory: string): Promise<void> {
  const image = await sharp({ create: {
    width: 640, height: 360, channels: 3, background: '#dceaf4',
  } }).composite([{ input: Buffer.from(
    '<svg width="640" height="360"><text x="40" y="100" font-size="32">ExampleCo sample chart</text><rect x="60" y="180" width="100" height="120" fill="#245580"/><rect x="210" y="140" width="100" height="160" fill="#247060"/></svg>',
  ) }]).png().toBuffer()

  const document = new Document({
    creator: 'Pipeline Contributors', lastModifiedBy: 'Pipeline Contributors',
    title: 'ExampleCo synthetic business plan',
    sections: [{ children: [
      new Paragraph({ text: 'ExampleCo business plan', style: 'Title' }),
      new Paragraph('This synthetic parser fixture describes an example business. It contains no real customer information.'),
      new Paragraph({ children: [new ImageRun({
        type: 'png', data: image, transformation: { width: 480, height: 270 },
      })] }),
    ] }],
  })
  await writeFile(path.join(directory, 'business-plan.docx'), await Packer.toBuffer(document))

  const imagePage = 'q 640 0 0 360 40 80 cm /Im1 Do Q'
  const pages: string[] = []
  for (let page = 1; page <= 9; page++) {
    if (page === 8) {
      pages.push(imagePage)
      continue
    }
    let content = text(page === 3 ? 'ExampleCo has No Competition' : `ExampleCo demonstration ${page}`, 40, 490, 24)
    if (page === 5) {
      for (let row = 0; row < 12; row++) {
        content += text('Planning the example delivery', 40, 430 - row * 20, 12)
        content += text('Operations review the sample', 400, 423 - row * 20, 12)
      }
    } else if (page === 6) {
      for (let row = 0; row < 5; row++) {
        content += text(['Metric', 'Revenue', 'Expenses', 'Profit', 'Forecast'][row] ?? '', 50, 420 - row * 35, 12)
        content += text(`Sample ${100 + row * 10}`, 300, 420 - row * 35, 12)
        content += text(`Sample ${200 + row * 10}`, 500, 420 - row * 35, 12)
        content += `40 ${440 - row * 35} m 650 ${440 - row * 35} l S\n`
      }
      content += '40 265 m 650 265 l S\n40 265 m 40 440 l S\n280 265 m 280 440 l S\n480 265 m 480 440 l S\n650 265 m 650 440 l S\n'
    } else {
      content += text('- Synthetic planning example', 40, 420)
      content += text('- Public test data only', 40, 395)
      content += text('- No customer records included', 40, 370)
      content += text('This demonstration describes an imaginary product and a fictional delivery plan.', 40, 300, 12)
    }
    pages.push(content)
  }
  const jpeg = await sharp(image).jpeg().toBuffer()
  await writePdf(path.join(directory, 'visual-deck.pdf'), pages, jpeg)
  await writePdf(path.join(directory, 'scanned.pdf'), [imagePage], jpeg)
}
