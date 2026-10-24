import { FileSpreadsheet } from 'lucide-react'
import { useMemo, useState, type CSSProperties } from 'react'

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import type {
  ExcelPreviewCell,
  ExcelPreviewCellStyle,
  ExcelPreviewSheet,
  ExcelWorkbookPreview as ExcelWorkbookPreviewModel,
} from '@/lib/models/runtime-model'

interface ExcelWorkbookPreviewProps {
  workbook: ExcelWorkbookPreviewModel
}

export function ExcelWorkbookPreview({
  workbook,
}: ExcelWorkbookPreviewProps) {
  const [activeSheetName, setActiveSheetName] = useState(
    workbook.sheets[0]?.name ?? '',
  )
  const activeSheet = useMemo(
    () =>
      workbook.sheets.find((sheet) => sheet.name === activeSheetName) ??
      workbook.sheets[0],
    [activeSheetName, workbook.sheets],
  )

  if (!activeSheet) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        This workbook has no visible sheets to preview.
      </div>
    )
  }

  return (
    <Tabs
      className="h-full min-h-0 gap-0"
      value={activeSheet.name}
      onValueChange={setActiveSheetName}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-3 border-b border-border/60 bg-muted/20 px-3">
        <FileSpreadsheet className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
        <TabsList
          aria-label="Workbook sheets"
          className="h-10 min-w-0 justify-start overflow-x-auto rounded-none bg-transparent p-0"
          variant="line"
        >
          {workbook.sheets.map((sheet) => (
            <TabsTrigger
              className="h-9 shrink-0 px-3 text-xs"
              key={sheet.name}
              value={sheet.name}
            >
              {sheet.name}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent
        className="min-h-0 overflow-hidden"
        key={activeSheet.name}
        value={activeSheet.name}
      >
        <WorksheetGrid sheet={activeSheet} />
      </TabsContent>

      {workbook.truncated || workbook.hiddenSheetCount > 0 ? (
        <div className="shrink-0 border-t border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {workbook.truncated
            ? `Showing ${workbook.sheets.length} of ${workbook.totalVisibleSheetCount} visible sheets.`
            : null}
          {workbook.truncated && workbook.hiddenSheetCount > 0 ? ' ' : null}
          {workbook.hiddenSheetCount > 0
            ? `${workbook.hiddenSheetCount} hidden ${workbook.hiddenSheetCount === 1 ? 'sheet is' : 'sheets are'} not shown.`
            : null}
        </div>
      ) : null}
    </Tabs>
  )
}

function WorksheetGrid({ sheet }: { sheet: ExcelPreviewSheet }) {
  const columnCount = sheet.columnWidths.length

  if (sheet.rows.length === 0 || columnCount === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {sheet.name} is empty.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          aria-label={`${sheet.name} worksheet`}
          className="border-separate border-spacing-0 text-xs"
        >
          <colgroup>
            <col className="w-11" />
            {sheet.columnWidths.map((width, columnIndex) => (
              <col
                key={columnIndex}
                style={{ width: columnWidthToPixels(width) }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                aria-label="Row numbers"
                className="sticky left-0 top-0 z-30 h-7 min-w-11 border-b border-r border-border bg-muted px-2 text-center font-mono text-xs font-medium text-muted-foreground"
                scope="col"
              />
              {sheet.columnWidths.map((_, columnIndex) => (
                <th
                  className="sticky top-0 z-20 h-7 border-b border-r border-border bg-muted px-2 text-center font-mono text-xs font-medium text-muted-foreground"
                  key={columnIndex}
                  scope="col"
                >
                  {columnName(columnIndex + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                style={{
                  height: rowHeightToPixels(sheet.rowHeights[rowIndex]),
                }}
              >
                <th
                  className="sticky left-0 z-10 min-w-11 border-b border-r border-border bg-muted px-2 text-center font-mono text-xs font-medium text-muted-foreground"
                  scope="row"
                >
                  {rowIndex + 1}
                </th>
                {row.map((cell, columnIndex) => (
                  <WorksheetCell
                    cell={cell}
                    key={`${rowIndex}:${columnIndex}`}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sheet.truncated ? (
        <div className="shrink-0 border-t border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Preview limited to {sheet.rows.length} of {sheet.totalRowCount} rows
          {' '}and {columnCount} of {sheet.totalColumnCount} columns.
        </div>
      ) : null}
    </div>
  )
}

function WorksheetCell({ cell }: { cell: ExcelPreviewCell }) {
  return (
    <td
      className="min-w-18 max-w-80 border-b border-r border-border/75 bg-background px-2 py-1.5 align-top text-foreground"
      style={cellStyle(cell.style)}
      title={cell.formula ? `Formula: =${cell.formula}` : undefined}
    >
      {cell.value || '\u00a0'}
    </td>
  )
}

function cellStyle(style: ExcelPreviewCellStyle | undefined): CSSProperties {
  if (!style) return {}
  return {
    backgroundColor: style.fillColor,
    color: style.fontColor,
    fontSize: style.fontSize,
    fontStyle: style.italic ? 'italic' : undefined,
    fontWeight: style.bold ? 600 : undefined,
    textAlign: style.horizontalAlignment,
    whiteSpace: style.wrapText ? 'pre-wrap' : 'nowrap',
  }
}

function columnWidthToPixels(width: number | null): number {
  if (width === null) return 112
  return Math.min(320, Math.max(72, Math.round(width * 7 + 12)))
}

function rowHeightToPixels(height: number | null | undefined): number | undefined {
  return height === null || height === undefined
    ? undefined
    : Math.min(160, Math.max(28, Math.round(height * 4 / 3)))
}

function columnName(columnNumber: number): string {
  let current = columnNumber
  let name = ''
  while (current > 0) {
    current -= 1
    name = String.fromCharCode(65 + (current % 26)) + name
    current = Math.floor(current / 26)
  }
  return name
}
