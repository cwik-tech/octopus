export const EXCEL_PREVIEW_SCHEMA_VERSION = 1 as const

export interface ExcelPreviewCellStyle {
  readonly bold?: boolean
  readonly fillColor?: string
  readonly fontColor?: string
  readonly fontSize?: number
  readonly horizontalAlignment?: 'left' | 'center' | 'right'
  readonly italic?: boolean
  readonly wrapText?: boolean
}

export interface ExcelPreviewCell {
  readonly formula?: string
  readonly style?: ExcelPreviewCellStyle
  readonly value: string
}

export interface ExcelPreviewSheet {
  readonly columnWidths: readonly (number | null)[]
  readonly name: string
  readonly rowHeights: readonly (number | null)[]
  readonly rows: readonly (readonly ExcelPreviewCell[])[]
  readonly totalColumnCount: number
  readonly totalRowCount: number
  readonly truncated: boolean
}

export interface ExcelWorkbookPreview {
  readonly hiddenSheetCount: number
  readonly schemaVersion: typeof EXCEL_PREVIEW_SCHEMA_VERSION
  readonly sheets: readonly ExcelPreviewSheet[]
  readonly totalVisibleSheetCount: number
  readonly truncated: boolean
}
