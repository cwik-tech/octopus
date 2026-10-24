import JSZip from 'jszip'
import { JSDOM } from 'jsdom'

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const BORDER_ORDER = ['top', 'left', 'bottom', 'right', 'between', 'bar'] as const
const STYLES_PART = 'word/styles.xml'
const DOCUMENT_PART = 'word/document.xml'

/** Correct docx 9.7's fixed top/bottom/left ordering without changing border appearance.
 * Only the buffer just produced by our generator enters JSZip; untrusted input
 * uses the separate bounded archive preflight before native parsing.
 */
export async function normalizeGeneratedWordBorders(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  const archive = await JSZip.loadAsync(bytes)
  for (const part of [STYLES_PART, DOCUMENT_PART]) {
    const xml = await archive.file(part)?.async('string')
    if (!xml) continue
    const dom = new JSDOM(xml, { contentType: 'application/xml' })
    try {
      const borders = Array.from(dom.window.document.getElementsByTagNameNS(WORD_NAMESPACE, 'pBdr'))
      for (const border of borders) {
        const children = Array.from(border.children)
        for (const name of BORDER_ORDER) for (const child of children) if (child.localName === name) border.appendChild(child)
      }
      if (borders.length > 0) archive.file(part, dom.serialize())
    } finally { dom.window.close() }
  }
  signal?.throwIfAborted()
  const output = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  signal?.throwIfAborted()
  return output
}
