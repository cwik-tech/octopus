import JSZip from 'jszip'
import { JSDOM } from 'jsdom'
import { inspectOfficePackage } from '../core/office-package.js'
import type { OfficeFailure } from '../contracts/office-documents.js'
const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
/** The SDK emits valid prefixed SpreadsheetML that ExcelJS 4.4 cannot read.
 * Normalize namespace spelling only, after bounded archive admission. */
export async function normalizeOfficeWorkbook(bytes: Buffer, signal: AbortSignal): Promise<{ ok: true; bytes: Buffer } | OfficeFailure> {
  const checked = inspectOfficePackage(bytes, 'xlsx')
  if (!checked.ok) return checked
  const zip = await JSZip.loadAsync(bytes)
  for (const [name, content] of checked.entries) {
    signal.throwIfAborted()
    if (!name.startsWith('xl/') || !name.endsWith('.xml')) continue
    const dom = new JSDOM(content.toString('utf8'), { contentType: 'application/xml' })
    try {
      const document = dom.window.document
      for (const element of document.getElementsByTagName('*')) {
        for (const attribute of Array.from(element.attributes)) {
          if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/' && attribute.value === spreadsheetNamespace && attribute.name !== 'xmlns') element.removeAttributeNode(attribute)
        }
      }
      const elements = Array.from(document.getElementsByTagNameNS(spreadsheetNamespace, '*'))
      for (const element of elements) {
        if (!element.prefix) continue
        const replacement = document.createElementNS(spreadsheetNamespace, element.localName)
        for (const attribute of element.attributes) replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
        if (element === document.documentElement) replacement.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', spreadsheetNamespace)
        while (element.firstChild) replacement.append(element.firstChild)
        element.replaceWith(replacement)
      }
      zip.file(name, new dom.window.XMLSerializer().serializeToString(document))
    } finally { dom.window.close() }
  }
  const result = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  signal.throwIfAborted()
  return { ok: true, bytes: result }
}
