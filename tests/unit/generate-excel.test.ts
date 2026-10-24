import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import ExcelJS from 'exceljs'
import XlsxPopulate from 'xlsx-populate'

import {
  generateExcelBuffer,
} from '../../domains/excel-generation/generate-excel.js'
import {
  listExcelProfiles,
  loadExcelProfile,
} from '../../domains/excel-generation/excel-profiles.js'
import {
  fillExcelTemplate,
  listExcelTemplates,
  loadExcelTemplate,
  parseExcelTemplateData,
} from '../../domains/excel-generation/excel-templates.js'
import type { ExcelTemplateManifest } from '../../domains/excel-generation/generate-excel-types.js'

test('Generate Excel exposes reusable data-driven profiles', () => {
  assert.deepEqual(
    listExcelProfiles().map(({ id }) => id),
    ['business-workbook', 'financial-model', 'plain-data'],
  )
})

test('Generate Excel accepts a fully data-driven custom profile file', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-excel-profile-'))
  try {
    const profileFile = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'domains', 'excel-generation', 'profiles.json'),
      'utf8',
    ))
    profileFile.profiles['business-workbook'].displayName = 'Custom Workbook'
    profileFile.profiles['business-workbook'].table.maxColumnWidth = 99
    const profilePath = path.join(workspace, 'profiles.json')
    fs.writeFileSync(profilePath, JSON.stringify(profileFile))

    const profile = loadExcelProfile('business-workbook', profilePath)

    assert.equal(profile.displayName, 'Custom Workbook')
    assert.equal(profile.table.maxColumnWidth, 99)
    assert.ok(Object.isFrozen(profile.table))
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('Generate Excel converts Markdown tables into typed styled worksheets', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-excel-typed-'))
  try {
    const generated = await generateExcelBuffer(`# Portfolio Review

## Revenue by Quarter

Quarterly revenue for the fund.

| Quarter | Revenue | Growth | Closed |
| --- | ---: | ---: | :-: |
| Q1 2026 | $1,200,000 | 12% | 2026-03-31 |
| Q2 2026 | $1,500,000 | 25% | 2026-06-30 |
| Total | =SUM(B5:B6) | | |

## Team

| Name | Role |
| --- | --- |
| **Ada** | CEO |
| [Site](https://example.com) | Link |
`, { profile: 'business-workbook' })

    assert.deepEqual(generated.sheetNames, ['Revenue by Quarter', 'Team'])
    assert.deepEqual(generated.warnings, [])
    assert.equal(generated.profile.id, 'business-workbook')

    const xlsxPath = path.join(workspace, 'portfolio.xlsx')
    fs.writeFileSync(xlsxPath, generated.buffer)
    const workbookXml = unzip(xlsxPath, '-p', 'xl/workbook.xml')
    assert.match(workbookXml, /Revenue by Quarter/)
    assert.match(workbookXml, /Team/)

    const sheetXml = unzip(xlsxPath, '-p', 'xl/worksheets/sheet1.xml')
    assert.match(sheetXml, /<v>1200000<\/v>/)
    assert.match(sheetXml, /<v>0.12<\/v>/)
    assert.match(sheetXml, /<f>SUM\(B5:B6\)<\/f>/)
    assert.match(sheetXml, /<autoFilter ref="A4:D7"\/>/)
    assert.match(sheetXml, /state="frozen"/)

    const sharedStrings = unzip(xlsxPath, '-p', 'xl/sharedStrings.xml')
    assert.match(sharedStrings, /Revenue by Quarter/)
    assert.match(sharedStrings, /Quarterly revenue for the fund\./)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('Generate Excel rejects Markdown without tables', async () => {
  await assert.rejects(
    generateExcelBuffer('# Notes\n\nProse only, no data.\n'),
    /requires at least one Markdown table/,
  )
})

test('Excel templates fill named cells and table regions while preserving formulas', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-template-'))
  const templatesRoot = path.join(root, 'excel-templates')
  const templateDirectory = path.join(templatesRoot, 'risk-test')
  try {
    fs.mkdirSync(templateDirectory, { recursive: true })
    await writeTemplateWorkbook(path.join(templateDirectory, 'template.xlsx'))
    const manifest: ExcelTemplateManifest = {
      id: 'risk-test',
      displayName: 'Risk Test',
      description: 'Synthetic risk workbook used by tests.',
      templateFile: 'template.xlsx',
      inputs: {
        cells: {
          startup_name: { type: 'string', required: true, range: 'StartupName' },
          discount_rate: { type: 'percent', sheet: 'Model', cell: 'B2' },
        },
        tables: {
          cash_flows: {
            sheet: 'Model',
            startCell: 'A4',
            maxRows: 3,
            columns: [
              { key: 'year', type: 'number' },
              { key: 'amount', type: 'number' },
            ],
          },
        },
      },
    }
    fs.writeFileSync(
      path.join(templateDirectory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    )

    const listed = listExcelTemplates(templatesRoot)
    assert.deepEqual(listed.warnings, [])
    assert.deepEqual(listed.templates.map((entry) => entry.manifest.id), ['risk-test'])

    const template = loadExcelTemplate(templatesRoot, 'risk-test')
    const filled = await fillExcelTemplate(template, parseExcelTemplateData({
      cells: { startup_name: 'Acme Robotics', discount_rate: 0.18 },
      tables: {
        cash_flows: [
          { year: 2026, amount: 100 },
          { year: 2027, amount: 200 },
        ],
      },
    }))
    assert.deepEqual(filled.warnings, [])

    const workbook = await XlsxPopulate.fromDataAsync(filled.buffer)
    const sheet = workbook.sheet('Model')
    assert.ok(sheet)
    assert.equal(sheet.cell('B1').value(), 'Acme Robotics')
    assert.equal(sheet.cell('B2').value(), 0.18)
    assert.equal(sheet.cell('A4').value(), 2026)
    assert.equal(sheet.cell('B5').value(), 200)
    assert.equal(sheet.cell('A6').value(), undefined)
    assert.equal(sheet.cell('B6').value(), undefined)

    const filledPath = path.join(root, 'filled.xlsx')
    fs.writeFileSync(filledPath, filled.buffer)
    const sheetXml = unzip(filledPath, '-p', 'xl/worksheets/sheet1.xml')
    assert.match(sheetXml, /<f>SUM\(B4:B6\)<\/f>/)

    const overflow = await fillExcelTemplate(template, parseExcelTemplateData({
      cells: { startup_name: 'Acme Robotics' },
      tables: {
        cash_flows: [
          { year: 2026, amount: 1 },
          { year: 2027, amount: 2 },
          { year: 2028, amount: 3 },
          { year: 2029, amount: 4 },
        ],
      },
    }))
    assert.equal(overflow.warnings.length, 1)
    assert.match(overflow.warnings[0]!, /1 extra rows were dropped/)

    await assert.rejects(
      fillExcelTemplate(template, parseExcelTemplateData({ cells: {} })),
      /Required template cell 'startup_name' is missing/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Excel template data parsing rejects unsupported shapes', () => {
  assert.throws(() => parseExcelTemplateData([]), /must be a JSON object/)
  assert.throws(
    () => parseExcelTemplateData({ rows: [] }),
    /key 'rows' is not supported/,
  )
  assert.throws(
    () => parseExcelTemplateData({ cells: { name: { nested: true } } }),
    /must be a string, number, or boolean/,
  )
  assert.throws(
    () => parseExcelTemplateData({ tables: { flows: [{ amount: [1] }] } }),
    /must be a string, number, or boolean/,
  )
})

async function writeTemplateWorkbook(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Model')
  sheet.getCell('A1').value = 'Startup'
  sheet.getCell('B1').value = 'SAMPLE NAME'
  sheet.getCell('B1').name = 'StartupName'
  sheet.getCell('A2').value = 'Discount rate'
  sheet.getCell('B2').value = 0.1
  // Stale sample rows inside the writable region; filling must clear them.
  sheet.getCell('A4').value = 2001
  sheet.getCell('B4').value = 111
  sheet.getCell('A5').value = 2002
  sheet.getCell('B5').value = 222
  sheet.getCell('A6').value = 2003
  sheet.getCell('B6').value = 333
  sheet.getCell('A7').value = 'Total'
  sheet.getCell('B7').value = { formula: 'SUM(B4:B6)' }
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  fs.writeFileSync(filePath, buffer)
}

function unzip(filePath: string, ...args: string[]): string {
  const commandArgs = args[0] === '-p'
    ? ['-p', filePath, ...args.slice(1)]
    : [...args, filePath]
  const result = spawnSync('unzip', commandArgs, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
