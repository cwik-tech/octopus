/**
 * Recognize one page of the mixed fixture with every outbound network path closed.
 *
 * Run as a child process by `tesseract-engine.test.ts`, because the block has to be installed
 * before anything loads and has to reach the engine's worker thread.
 *
 * Prints the recognized text on stdout so the caller can assert on a known line.
 */
import * as path from 'node:path'
import { openOcrPdfDocument } from '../../ocr/rasterize.js'
import { createTesseractRecognizer } from '../../ocr/tesseract-engine.js'
import { ocrIndexProfile } from '../../ocr/contract.js'

const page = Number(process.argv[2] ?? '10')
const fixture = path.join(import.meta.dirname, '..', 'fixtures', 'markpdf-mixed-ocr.pdf')

const document = await openOcrPdfDocument(fixture)
const recognizer = await createTesseractRecognizer()
try {
  const image = await document.renderPage(page, ocrIndexProfile().dpi)
  const recognized = await recognizer.recognize(image.image)
  process.stdout.write(recognized.text)
} finally {
  await recognizer.close()
  await document.close()
}
