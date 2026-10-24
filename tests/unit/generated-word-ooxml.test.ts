import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { JSDOM } from 'jsdom'
import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'

test('generated Word numbering and paragraph borders follow the Office XML schema', async () => {
  const bytes = (await generateWordBuffer('# Report\n\n```text\nSample code\n```', { renderMermaid: false })).buffer
  const archive = await JSZip.loadAsync(bytes)
  const numbering = await archive.file('word/numbering.xml')?.async('string')
  assert.ok(numbering)
  assert.doesNotMatch(numbering, /<w:lvlJc w:val="start"/)
  const styles = await archive.file('word/styles.xml')?.async('string')
  assert.ok(styles)
  const dom = new JSDOM(styles, { contentType: 'application/xml' })
  try {
    const code = dom.window.document.querySelector('[w\\:styleId="GeneratedWordCodeBlock"]')
    assert.ok(code)
    const border = code.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'pBdr')[0]
    assert.ok(border)
    assert.deepEqual(Array.from(border.children, (child) => child.localName), ['top', 'left', 'bottom', 'right'])
  } finally { dom.window.close() }
})
