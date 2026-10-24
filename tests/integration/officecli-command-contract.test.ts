import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import JSZip from 'jszip'
import { JSDOM } from 'jsdom'
import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'
import { readOfficeTargets, applyOfficeOperations } from '../../services/office-document-capability-adapter.js'

// The native payload is an explicit platform prerequisite. Shipping macOS gates
// stage the pinned executable first; generic CI must not install it at runtime.
const nativeUnavailable = process.platform !== 'darwin' || !existsSync(path.join(process.cwd(), 'build', 'office-tools', `${process.platform}-${process.arch}`, 'manifest.json'))
test('a captured Word paragraph changes in candidate bytes while the original and styles remain intact', { skip: nativeUnavailable }, async () => {
  const bytes = (await generateWordBuffer('# Quarterly report\n\nKeep the other paragraph.', { renderMermaid: false })).buffer
  const input = { bytes, format: 'docx' as const, repoRoot: process.cwd(), signal: AbortSignal.timeout(15000) }
  const targets = await readOfficeTargets(input)
  assert.equal(targets.ok, true)
  const target = targets.targets.find((entry) => entry.text === 'Quarterly report')
  assert.ok(target)
  const edited = await applyOfficeOperations({ ...input, operations: [{ kind: 'text', target: target.id, text: 'Revised report' }] })
  assert.equal(edited.ok, true)
  const source = await JSZip.loadAsync(bytes)
  const candidate = await JSZip.loadAsync(edited.bytes)
  assert.match(await candidate.file('word/document.xml')?.async('string') ?? '', /Revised report/)
  assert.match(await candidate.file('word/document.xml')?.async('string') ?? '', /Keep the other paragraph/)
  assert.match(await source.file('word/document.xml')?.async('string') ?? '', /Quarterly report/)
  assert.deepEqual(styleProperties(await candidate.file('word/styles.xml')?.async('string')), styleProperties(await source.file('word/styles.xml')?.async('string')))
})

interface XmlProperties { name: string; attributes: [string, string][]; children: XmlProperties[] }
function styleProperties(xml: string | undefined): XmlProperties {
  assert.ok(xml)
  const dom = new JSDOM(xml, { contentType: 'application/xml' })
  const properties = (element: Element): XmlProperties => ({
    name: `${element.namespaceURI}:${element.localName}`,
    attributes: Array.from(element.attributes).filter((attribute) => attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/').map((attribute): [string, string] => [`${attribute.namespaceURI}:${attribute.localName}`, attribute.value]).sort(([a], [b]) => a.localeCompare(b)),
    children: Array.from(element.children, properties),
  })
  try { return properties(dom.window.document.documentElement) } finally { dom.window.close() }
}

test('unknown target identities cannot make native edits', { skip: nativeUnavailable }, async () => {
  const bytes = (await generateWordBuffer('# Safe report', { renderMermaid: false })).buffer
  const result = await applyOfficeOperations({ bytes, format: 'docx', repoRoot: process.cwd(), signal: AbortSignal.timeout(15000), operations: [{ kind: 'text', target: 'target-999999', text: 'Escape' }] })
  assert.deepEqual(result, { ok: false, code: 'invalid_output' })
})

test('Excel scalar edits preserve another cell and keep formula-looking text as a string', { skip: nativeUnavailable }, async () => {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Revenue')
  sheet.getCell('A1').value = 'Old value'
  sheet.getCell('B1').value = 99
  sheet.getCell('B1').font = { bold: true }
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const input = { bytes, format: 'xlsx' as const, repoRoot: process.cwd(), signal: AbortSignal.timeout(15000) }
  const captured = await readOfficeTargets(input)
  assert.equal(captured.ok, true)
  const target = captured.targets.find((entry) => entry.text === 'Old value')
  assert.ok(target)
  const edited = await applyOfficeOperations({ ...input, operations: [{ kind: 'cell', target: target.id, value: '=SUM(B1)' }] })
  assert.equal(edited.ok, true)
  const candidate = new ExcelJS.Workbook()
  await candidate.xlsx.load(Uint8Array.from(edited.bytes).buffer)
  assert.equal(candidate.getWorksheet('Revenue')?.getCell('A1').value, '=SUM(B1)')
  assert.equal(candidate.getWorksheet('Revenue')?.getCell('B1').value, 99)
  assert.equal(candidate.getWorksheet('Revenue')?.getCell('B1').font.bold, true)
})

test('PowerPoint shape text changes in candidate bytes and keeps the other slide', { skip: nativeUnavailable }, async (t) => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const { resolveOfficeBinary } = await import('../../services/officecli-binary-resolver.js')
  const { runOfficeProcess } = await import('../../services/officecli-process.js')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'office-slide-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const signal = AbortSignal.timeout(15000)
  const executable = await resolveOfficeBinary(process.cwd(), signal)
  assert.ok(executable)
  const file = path.join(directory, 'slides.pptx')
  assert.equal((await runOfficeProcess({ executable, directory, signal, args: ['create', file, '--json'] })).ok, true)
  assert.equal((await runOfficeProcess({ executable, directory, signal, args: ['add', file, '/', '--type', 'slide', '--prop', 'title=First slide', '--json'] })).ok, true)
  assert.equal((await runOfficeProcess({ executable, directory, signal, args: ['add', file, '/', '--type', 'slide', '--prop', 'title=Keep second slide', '--json'] })).ok, true)
  const bytes = await fs.readFile(file)
  const input = { bytes, format: 'pptx' as const, repoRoot: process.cwd(), signal }
  const captured = await readOfficeTargets(input)
  assert.equal(captured.ok, true)
  const target = captured.targets.find((entry) => entry.text === 'First slide')
  assert.ok(target)
  const edited = await applyOfficeOperations({ ...input, operations: [{ kind: 'text', target: target.id, text: 'Revised slide' }] })
  assert.equal(edited.ok, true)
  const candidate = await JSZip.loadAsync(edited.bytes)
  assert.match(await candidate.file('ppt/slides/slide1.xml')?.async('string') ?? '', /Revised slide/)
  assert.match(await candidate.file('ppt/slides/slide2.xml')?.async('string') ?? '', /Keep second slide/)
  assert.deepEqual(await fs.readFile(file), bytes)
})

for (const value of [42, false, null] as const) {
  test(`Excel scalar ${String(value)} survives independent workbook reopening`, { skip: nativeUnavailable }, async () => {
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Values').getCell('A1').value = 'Replace me'
    const input = { bytes: Buffer.from(await workbook.xlsx.writeBuffer()), format: 'xlsx' as const, repoRoot: process.cwd(), signal: AbortSignal.timeout(15000) }
    const targets = await readOfficeTargets(input)
    assert.equal(targets.ok, true)
    const target = targets.targets.find((entry) => entry.text === 'Replace me')
    assert.ok(target)

    const edited = await applyOfficeOperations({ ...input, operations: [{ kind: 'cell', target: target.id, value }] })

    assert.equal(edited.ok, true)
    const reopened = new ExcelJS.Workbook()
    await reopened.xlsx.load(Uint8Array.from(edited.bytes).buffer)
    assert.equal(reopened.getWorksheet('Values')?.getCell('A1').value, value)
  })
}

test('existing formula cells are excluded from editable targets and survive scalar edits', { skip: nativeUnavailable }, async () => {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Values')
  sheet.getCell('A1').value = { formula: '1+1', result: 2 }
  sheet.getCell('B1').value = 'Editable text'
  const input = { bytes: Buffer.from(await workbook.xlsx.writeBuffer()), format: 'xlsx' as const, repoRoot: process.cwd(), signal: AbortSignal.timeout(15000) }

  const captured = await readOfficeTargets(input)

  assert.equal(captured.ok, true)
  assert.equal(captured.targets.some((target) => target.path === '/Values/A1'), false, 'A numeric cached result does not make a formula cell editable')
  const scalar = captured.targets.find((target) => target.path === '/Values/B1')
  assert.ok(scalar)
  const edited = await applyOfficeOperations({ ...input, operations: [{ kind: 'cell', target: scalar.id, value: 'Changed scalar' }] })
  assert.equal(edited.ok, true)
  const reopened = new ExcelJS.Workbook()
  await reopened.xlsx.load(Uint8Array.from(edited.bytes).buffer)
  assert.deepEqual(reopened.getWorksheet('Values')?.getCell('A1').value, { formula: '1+1', result: 2 })
  assert.equal(reopened.getWorksheet('Values')?.getCell('B1').value, 'Changed scalar')
})
