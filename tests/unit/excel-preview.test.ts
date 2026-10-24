import assert from 'node:assert/strict'
import test from 'node:test'

import ExcelJS from 'exceljs'

import {
  createExcelWorkbookPreview,
  EXCEL_PREVIEW_MAX_FILE_BYTES,
  EXCEL_PREVIEW_MAX_ROWS,
} from '../../domains/excel-generation/excel-preview.js'

test('Excel preview returns visible sheets, formatted cells, and workbook styling', async () => {
  const workbook = new ExcelJS.Workbook()
  const summary = workbook.addWorksheet('Summary')
  const detail = workbook.addWorksheet('Detail')
  workbook.addWorksheet('Internal', { state: 'hidden' })

  summary.mergeCells('A1:B1')
  summary.getCell('A1').value = 'Risk assessment'
  summary.getCell('A1').font = {
    bold: true,
    color: { argb: 'FFFFFFFF' },
    size: 16,
  }
  summary.getCell('A1').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E78' },
  }
  summary.getCell('A2').value = 'Score'
  summary.getCell('B2').value = 0.75
  summary.getCell('B2').numFmt = '0%'
  summary.getCell('B3').value = { formula: 'SUM(B2:B2)' }
  summary.getColumn(1).width = 24
  detail.addRow(['Risk', 'High'])

  const preview = await createExcelWorkbookPreview(
    Buffer.from(await workbook.xlsx.writeBuffer()),
  )

  assert.equal(preview.schemaVersion, 1)
  assert.equal(preview.hiddenSheetCount, 1)
  assert.equal(preview.totalVisibleSheetCount, 2)
  assert.deepEqual(preview.sheets.map((sheet) => sheet.name), [
    'Summary',
    'Detail',
  ])
  assert.equal(preview.sheets[0]?.rows[0]?.[0]?.value, 'Risk assessment')
  assert.equal(preview.sheets[0]?.rows[0]?.[1]?.value, '')
  assert.deepEqual(preview.sheets[0]?.rows[0]?.[0]?.style, {
    bold: true,
    fillColor: '#1F4E78',
    fontColor: '#FFFFFF',
    fontSize: 16,
  })
  assert.equal(preview.sheets[0]?.rows[1]?.[1]?.value, '75%')
  assert.equal(
    preview.sheets[0]?.rows[1]?.[1]?.style?.horizontalAlignment,
    'right',
  )
  assert.equal(preview.sheets[0]?.rows[2]?.[1]?.value, '=SUM(B2:B2)')
  assert.equal(preview.sheets[0]?.rows[2]?.[1]?.formula, 'SUM(B2:B2)')
  assert.equal(preview.sheets[0]?.columnWidths[0], 24)
})

test('Excel preview bounds large worksheets and rejects oversized files', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Long')
  sheet.getCell(EXCEL_PREVIEW_MAX_ROWS + 1, 1).value = 'outside preview'

  const preview = await createExcelWorkbookPreview(
    Buffer.from(await workbook.xlsx.writeBuffer()),
  )

  assert.equal(preview.sheets[0]?.rows.length, EXCEL_PREVIEW_MAX_ROWS)
  assert.equal(preview.sheets[0]?.totalRowCount, EXCEL_PREVIEW_MAX_ROWS + 1)
  assert.equal(preview.sheets[0]?.truncated, true)

  await assert.rejects(
    createExcelWorkbookPreview(
      Buffer.alloc(EXCEL_PREVIEW_MAX_FILE_BYTES + 1),
    ),
    /preview limit/,
  )
})
