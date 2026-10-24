import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { inspectOfficePackage } from '../../core/office-package.js'

async function docx() {
  return new JSZip().file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    .file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p></w:body></w:document>').generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
test('accepts a bounded Word package and retains the actual XML bytes', async () => {
  const result = inspectOfficePackage(await docx(), 'docx')
  assert.equal(result.ok, true)
  assert.match(result.entries.get('word/document.xml')?.toString() ?? '', /Report/)
})
test('refuses macro content and a package whose declared format is wrong', async () => {
  const zip = new JSZip().file('[Content_Types].xml', '<Types/>').file('word/vbaProject.bin', 'macro')
  assert.deepEqual(inspectOfficePackage(await zip.generateAsync({ type: 'nodebuffer' }), 'docx'), { ok: false, code: 'unsafe_package' })
  assert.deepEqual(inspectOfficePackage(await docx(), 'xlsx'), { ok: false, code: 'unsafe_package' })
})
test('refuses a compressed payload whose actual inflation exceeds the archive budget', async () => {
  const bytes = await new JSZip().file('[Content_Types].xml', 'x').file('word/document.xml', 'A'.repeat(1024 * 1024)).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  assert.deepEqual(inspectOfficePackage(bytes, 'docx'), { ok: false, code: 'unsafe_package' })
})
test('refuses truncated ZIP data instead of passing it to the native parser', async () => {
  const bytes = await docx()
  assert.deepEqual(inspectOfficePackage(bytes.subarray(0, bytes.length - 9), 'docx'), { ok: false, code: 'unsafe_package' })
})
test('refuses external image/file relationships and XML entity declarations before native parsing', async () => {
  const remote = await JSZip.loadAsync(await docx())
  remote.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///private/secret.png" TargetMode="External"/></Relationships>')
  assert.deepEqual(inspectOfficePackage(await remote.generateAsync({ type: 'nodebuffer' }), 'docx'), { ok: false, code: 'unsafe_package' })
  const entities = await JSZip.loadAsync(await docx())
  entities.file('word/document.xml', '<!DOCTYPE document [<!ENTITY secret SYSTEM "file:///private/secret">]><document>&secret;</document>')
  assert.deepEqual(inspectOfficePackage(await entities.generateAsync({ type: 'nodebuffer' }), 'docx'), { ok: false, code: 'unsafe_package' })
})
