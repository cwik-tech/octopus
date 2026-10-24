import ExcelJS from 'exceljs'
import {
  EXCEL_PREVIEW_SCHEMA_VERSION,
  type ExcelPreviewCell,
  type ExcelPreviewCellStyle,
  type ExcelPreviewSheet,
  type ExcelWorkbookPreview,
} from '../../contracts/excel-preview.js'

export { EXCEL_PREVIEW_SCHEMA_VERSION }
export type {
  ExcelPreviewCell,
  ExcelPreviewCellStyle,
  ExcelPreviewSheet,
  ExcelWorkbookPreview,
}

export const EXCEL_PREVIEW_MAX_SHEETS = 20
export const EXCEL_PREVIEW_MAX_ROWS = 300
export const EXCEL_PREVIEW_MAX_COLUMNS = 60
export const EXCEL_PREVIEW_MAX_FILE_BYTES = 25 * 1024 * 1024

/**
 * Convert a workbook into a bounded, data-only preview for the local UI.
 * Formulae are never evaluated here: cached results are displayed when
 * present, otherwise the formula itself is shown.
 */
export async function createExcelWorkbookPreview(
  content: Buffer,
): Promise<ExcelWorkbookPreview> {
  if (content.byteLength > EXCEL_PREVIEW_MAX_FILE_BYTES) {
    throw new Error(
      `Workbook exceeds the ${EXCEL_PREVIEW_MAX_FILE_BYTES / 1024 / 1024} MB preview limit.`,
    )
  }

  const workbook = new ExcelJS.Workbook()
  // exceljs declares its own `Buffer extends ArrayBuffer` type, which a Node
  // Buffer does not satisfy; hand it a plain ArrayBuffer copy instead.
  const arrayBuffer = new ArrayBuffer(content.byteLength)
  new Uint8Array(arrayBuffer).set(content)
  await workbook.xlsx.load(arrayBuffer, {
    ignoreNodes: ['dataValidations', 'extLst'],
  })

  const visibleSheets = workbook.worksheets.filter(
    (worksheet) => worksheet.state === 'visible',
  )
  const previewSheets = visibleSheets.slice(0, EXCEL_PREVIEW_MAX_SHEETS)

  return {
    hiddenSheetCount: workbook.worksheets.length - visibleSheets.length,
    schemaVersion: EXCEL_PREVIEW_SCHEMA_VERSION,
    sheets: previewSheets.map(createSheetPreview),
    totalVisibleSheetCount: visibleSheets.length,
    truncated: previewSheets.length < visibleSheets.length,
  }
}

function createSheetPreview(worksheet: ExcelJS.Worksheet): ExcelPreviewSheet {
  const totalRowCount = worksheet.rowCount
  const totalColumnCount = worksheet.columnCount
  const rowCount = Math.min(totalRowCount, EXCEL_PREVIEW_MAX_ROWS)
  const columnCount = Math.min(totalColumnCount, EXCEL_PREVIEW_MAX_COLUMNS)
  const rows: ExcelPreviewCell[][] = []
  const rowHeights: Array<number | null> = []

  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex)
    const cells: ExcelPreviewCell[] = []
    rowHeights.push(normalizeDimension(row.height))

    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      cells.push(createCellPreview(row.getCell(columnIndex)))
    }
    rows.push(cells)
  }

  const columnWidths = Array.from(
    { length: columnCount },
    (_, columnIndex) =>
      normalizeDimension(worksheet.getColumn(columnIndex + 1).width),
  )

  return {
    columnWidths,
    name: worksheet.name,
    rowHeights,
    rows,
    totalColumnCount,
    totalRowCount,
    truncated: rowCount < totalRowCount || columnCount < totalColumnCount,
  }
}

function createCellPreview(cell: ExcelJS.Cell): ExcelPreviewCell {
  if (cell.isMerged && cell.master.address !== cell.address) {
    return { value: '' }
  }

  const formula = readFormula(cell.value)
  const value = readCellDisplayValue(cell, formula)
  const style = readCellStyle(cell)

  return {
    ...(formula ? { formula } : {}),
    ...(style ? { style } : {}),
    value,
  }
}

function readCellDisplayValue(
  cell: ExcelJS.Cell,
  formula: string | undefined,
): string {
  if (formula && !hasFormulaResult(cell.value)) return `=${formula}`

  const rawValue = formula
    ? readFormulaResult(cell.value)
    : cell.value
  if (typeof rawValue === 'number') {
    return formatNumericValue(rawValue, cell.numFmt)
  }
  if (rawValue instanceof Date) {
    return formatDateValue(rawValue, cell.numFmt)
  }
  return cell.text
}

function readFormula(value: ExcelJS.CellValue): string | undefined {
  if (
    value &&
    typeof value === 'object' &&
    'formula' in value &&
    typeof value.formula === 'string'
  ) {
    return value.formula
  }
  return undefined
}

function readFormulaResult(value: ExcelJS.CellValue): ExcelJS.CellValue {
  if (value && typeof value === 'object' && 'result' in value) {
    return value.result as ExcelJS.CellValue
  }
  return value
}

function hasFormulaResult(value: ExcelJS.CellValue): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'result' in value &&
    value.result !== undefined &&
    value.result !== null,
  )
}

function formatNumericValue(value: number, numberFormat: string): string {
  const format = numberFormat || 'General'
  const decimalPlaces = decimalPlacesForFormat(format)
  const formatOptions: Intl.NumberFormatOptions = {
    maximumFractionDigits: decimalPlaces,
    minimumFractionDigits: format === 'General' ? 0 : decimalPlaces,
    useGrouping: format.includes(','),
  }
  if (format.includes('%')) {
    return `${new Intl.NumberFormat('en-US', formatOptions).format(value * 100)}%`
  }

  const currencySymbol = format.match(/[$€£]/)?.[0]
  const formatted = new Intl.NumberFormat('en-US', formatOptions).format(value)
  return currencySymbol ? `${currencySymbol}${formatted}` : formatted
}

function decimalPlacesForFormat(format: string): number {
  const numericSection = format.split(';')[0]?.split('%')[0] ?? format
  const decimalMatch = numericSection.match(/\.([0#]+)/)
  if (!decimalMatch) {
    return format === 'General' ? 20 : 0
  }
  return Math.min(decimalMatch[1]?.length ?? 0, 10)
}

function formatDateValue(value: Date, numberFormat: string): string {
  if (/[ymd]/i.test(numberFormat)) {
    const year = String(value.getUTCFullYear()).padStart(4, '0')
    const month = String(value.getUTCMonth() + 1).padStart(2, '0')
    const day = String(value.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return value.toISOString()
}

function readCellStyle(cell: ExcelJS.Cell): ExcelPreviewCellStyle | undefined {
  const fillColor = cell.fill?.type === 'pattern'
    ? colorToCss(cell.fill.fgColor)
    : undefined
  const fontColor = colorToCss(cell.font?.color)
  const horizontalAlignment = normalizeHorizontalAlignment(
    cell.alignment?.horizontal,
    cell.type,
  )
  const fontSize = typeof cell.font?.size === 'number'
    ? Math.min(28, Math.max(8, cell.font.size))
    : undefined
  const style: ExcelPreviewCellStyle = {
    ...(cell.font?.bold ? { bold: true } : {}),
    ...(fillColor ? { fillColor } : {}),
    ...(fontColor ? { fontColor } : {}),
    ...(fontSize ? { fontSize } : {}),
    ...(horizontalAlignment ? { horizontalAlignment } : {}),
    ...(cell.font?.italic ? { italic: true } : {}),
    ...(cell.alignment?.wrapText ? { wrapText: true } : {}),
  }

  return Object.keys(style).length > 0 ? style : undefined
}

function colorToCss(color: Partial<ExcelJS.Color> | undefined): string | undefined {
  const argb = color && 'argb' in color ? color.argb : undefined
  if (!argb || !/^[\dA-F]{8}$/i.test(argb)) return undefined
  return `#${argb.slice(2)}`
}

function normalizeHorizontalAlignment(
  alignment: ExcelJS.Alignment['horizontal'] | undefined,
  cellType: ExcelJS.ValueType,
): ExcelPreviewCellStyle['horizontalAlignment'] | undefined {
  if (
    alignment === 'center' ||
    alignment === 'centerContinuous' ||
    alignment === 'distributed'
  ) {
    return 'center'
  }
  if (alignment === 'right') return 'right'
  if (alignment === 'left' || alignment === 'fill' || alignment === 'justify') {
    return 'left'
  }
  if (cellType === ExcelJS.ValueType.Number || cellType === ExcelJS.ValueType.Date) {
    return 'right'
  }
  if (cellType === ExcelJS.ValueType.Boolean) return 'center'
  return undefined
}

function normalizeDimension(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}
