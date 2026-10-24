import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'

test('distributed workbook and document fixtures identify only synthetic contributors', async () => {
  const workbook = await JSZip.loadAsync(await readFile(
    path.resolve('domains/excel-generation/templates/risk-register/template.xlsx'),
  ))
  const document = await JSZip.loadAsync(await readFile(
    path.resolve('file-parser/tests/fixtures/business-plan.docx'),
  ))

  assert.match(await workbook.file('docProps/core.xml')?.async('string') ?? '',
    /<dc:creator>Pipeline Contributors<\/dc:creator>/,
    'The shipped workbook must use a generic creator, including its metadata')
  assert.doesNotMatch(await workbook.file('xl/workbook.xml')?.async('string') ?? '',
    /<(?:\w+:)?absPath\b/, 'The shipped workbook must not retain its original local folder')
  assert.match(await workbook.file('xl/sharedStrings.xml')?.async('string') ?? '',
    /<t>CEO<\/t>/, 'The owner list must offer a generic CEO role')
  assert.match(await document.file('word/document.xml')?.async('string') ?? '',
    /ExampleCo/, 'The parser fixture must contain a synthetic business example')
  assert.match(await document.file('docProps/core.xml')?.async('string') ?? '',
    /<dc:creator>Pipeline Contributors<\/dc:creator>/,
    'The parser fixture must use a generic creator')
})
