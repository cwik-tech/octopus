/**
 * XLSX / Spreadsheet Parser
 *
 * Reads spreadsheets with a bounded XLSX-only parser, outputs markdown tables + raw JSON.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import readXlsxFile, { type CellValue } from 'read-excel-file/node'
import type { ParseResult } from '../types.js'
import { parseFailureResult } from '../utils/parse-failure.js'
import { markdownTable, wrapDocument } from '../utils/markdown.js'

export async function parseXlsx(
  filePath: string,
  outputDir: string,
): Promise<ParseResult> {
  const fileName = path.basename(filePath)

  try {
    const sizeBytes = fs.statSync(filePath).size
    const workbook = await readXlsxFile(filePath)
    const sheetNames = workbook.map((sheet) => sheet.sheet)
    const mdSections: string[] = []
    const jsonData: Record<string, unknown[]> = {}

    for (const sheet of workbook) {
      const sheetName = sheet.sheet
      const [headerRow, ...dataRows] = sheet.data
      const headers = (headerRow ?? []).map((value, index) =>
        String(value ?? '').trim() || `Column ${index + 1}`,
      )
      const rows = dataRows
        .filter((row) => row.some((value) => value !== null && value !== ''))
        .map((row) => Object.fromEntries(
          headers.map((header, index) => [header, normalizeCellValue(row[index])]),
        ))
      jsonData[sheetName] = rows

      if (rows.length === 0) {
        mdSections.push(`## ${sheetName}\n\n_Empty sheet._`)
        continue
      }

      const tableRows = rows.map(row =>
        headers.map(h => String(row[h] ?? ''))
      )

      mdSections.push(`## ${sheetName}\n\n${markdownTable(headers, tableRows)}`)
    }

    const metadata: Record<string, unknown> = {
      type: 'xlsx',
      sheets: sheetNames.length,
      sheet_names: sheetNames,
      total_rows: Object.values(jsonData).reduce((sum, rows) => sum + rows.length, 0),
    }

    // Write markdown
    const mdContent = wrapDocument(fileName, mdSections.join('\n\n'), metadata)
    const mdPath = path.join(outputDir, `${fileName}.md`)
    fs.writeFileSync(mdPath, mdContent)

    // Write JSON
    const jsonPath = path.join(outputDir, `${fileName}.json`)
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2))

    return {
      source: fileName,
      type: 'xlsx',
      sizeBytes,
      outputs: {
        text: `${fileName}.md`,
        data: `${fileName}.json`,
      },
      metadata,
      status: 'success',
    }
  } catch (err) {
    return parseFailureResult({ fileName, type: 'xlsx', cause: err })
  }
}

function normalizeCellValue(value: CellValue | null | undefined): unknown {
  if (value instanceof Date) return value.toISOString()
  return value ?? ''
}
