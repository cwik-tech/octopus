import { JSDOM } from 'jsdom'
import { OFFICE_HTML_MAX_BYTES, OFFICE_PROFILE, type OfficePreview, type OfficeFailure } from '../contracts/office-documents.js'

/** Never execute renderer output in the host. Script execution occurs only in the opaque Canvas frame. */
export function assembleOfficeHtml(html: string, digest: string): OfficePreview | OfficeFailure {
  if (Buffer.byteLength(html) > OFFICE_HTML_MAX_BYTES || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) return { ok: false, code: 'invalid_output' }
  const dom = new JSDOM(html)
  try {
    const document = dom.window.document
    for (const element of document.querySelectorAll('script[src],script[type="module"],script[type="importmap"],link[href],base,iframe,object,embed,meta[http-equiv]')) element.remove()
    for (const image of document.querySelectorAll('img[src]')) {
      if (!image.getAttribute('src')?.startsWith('data:image/')) image.removeAttribute('src')
    }
    const notices = ['Preview uses local fonts; pagination may differ from Microsoft Office. Equations and unsupported media may have a partial preview.']
    const content = dom.serialize()
    if (Buffer.byteLength(content) > OFFICE_HTML_MAX_BYTES) return { ok: false, code: 'output_limit' }
    return { html: content, digest, profile: OFFICE_PROFILE, notices }
  } finally { dom.window.close() }
}
