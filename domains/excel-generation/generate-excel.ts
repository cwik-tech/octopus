import { whenDefined } from '../../core/optional-properties.js'
import ExcelJS from 'exceljs'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { stripArtifactFrontmatter } from '../runtime/artifacts.js'
import { loadExcelProfile } from './excel-profiles.js'
import type {
  ExcelGenerationProfile,
  GenerateExcelOptions,
  GenerateExcelResult,
} from './generate-excel-types.js'

const EXCEL_SHEET_NAME_LIMIT = 31

type MdNode = {
  type: string
  value?: string
  url?: string
  depth?: number
  align?: readonly (string | null)[]
  children?: MdNode[]
}

interface CellContent {
  readonly value: ExcelJS.CellValue
  readonly numFmt?: string
  readonly bold?: boolean
  /** Approximate rendered length, used for column sizing. */
  readonly displayLength: number
}

interface PendingSection {
  heading?: string
  notes: string[]
  tableCount: number
}

function isMdNode(value: unknown): value is MdNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (!('type' in value) || typeof value.type !== 'string') return false
  if ('children' in value && value.children !== undefined) {
    return Array.isArray(value.children) && value.children.every(isMdNode)
  }
  return true
}

/**
 * Convert Markdown into an Excel workbook. Every GFM table becomes one
 * worksheet named after its nearest preceding heading; paragraphs under that
 * heading become note rows above the table. Cells are typed (number, percent,
 * currency, date, boolean, `=formula`) and styled from the selected profile.
 */
export async function generateExcelBuffer(
  markdown: string,
  options: GenerateExcelOptions = {},
): Promise<GenerateExcelResult> {
  if (options.signal?.aborted) throw abortError()
  const profile = loadExcelProfile(options.profile, options.profilePath)
  const cleanMarkdown = stripArtifactFrontmatter(markdown).trim()
  if (!cleanMarkdown) throw new Error('Generate Excel received an empty Markdown document.')
  const parsed: unknown = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(cleanMarkdown)
  if (!isMdNode(parsed)) throw new Error('Markdown parser returned an invalid syntax tree.')
  const root = parsed

  const warnings: string[] = []
  const workbook = new ExcelJS.Workbook()
  workbook.creator = options.creator ?? 'Pipeline'

  const usedNames = new Set<string>()
  const section: PendingSection = { ...whenDefined(options.title, (heading) => ({ heading })), notes: [], tableCount: 0 }
  let documentTitle: string | undefined
  let sawTable = false

  for (const node of root.children ?? []) {
    if (options.signal?.aborted) throw abortError()
    switch (node.type) {
      case 'heading': {
        if (section.notes.length > 0 && section.tableCount === 0 && section.heading !== documentTitle) {
          warnSkippedSection(warnings, section.heading)
        }
        const text = inlineText(node)
        if (node.depth === 1 && documentTitle === undefined) {
          documentTitle = text
        }
        section.heading = text
        section.notes = []
        section.tableCount = 0
        break
      }
      case 'paragraph': {
        const text = inlineText(node).trim()
        if (text) section.notes.push(text)
        break
      }
      case 'table': {
        sawTable = true
        section.tableCount += 1
        const baseName = section.heading?.trim() ||
          documentTitle?.trim() ||
          `Sheet ${usedNames.size + 1}`
        const sheetName = uniqueSheetName(
          section.tableCount > 1 ? `${baseName} ${section.tableCount}` : baseName,
          usedNames,
        )
        renderTableSheet(workbook, sheetName, node, {
          profile,
          title: section.heading ?? documentTitle,
          notes: section.notes,
          warnings,
        })
        section.notes = []
        break
      }
      default:
        break
    }
  }
  if (section.notes.length > 0 && section.tableCount === 0 && section.heading !== documentTitle) {
    warnSkippedSection(warnings, section.heading)
  }
  if (!sawTable) {
    throw new Error(
      'Generate Excel requires at least one Markdown table; the source document contains none.',
    )
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  return {
    buffer,
    profile,
    warnings,
    sheetNames: workbook.worksheets.map((sheet) => sheet.name),
  }
}

function warnSkippedSection(warnings: string[], heading: string | undefined): void {
  warnings.push(
    `Section ${heading ? `'${heading}'` : 'without heading'} contains no table and was not exported.`,
  )
}

interface TableRenderContext {
  readonly profile: ExcelGenerationProfile
  readonly title: string | undefined
  readonly notes: readonly string[]
  readonly warnings: string[]
}

function renderTableSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  table: MdNode,
  context: TableRenderContext,
): void {
  const { profile } = context
  const worksheet = workbook.addWorksheet(sheetName)
  const rows = table.children ?? []
  if (rows.length === 0) return
  const columnCount = Math.max(
    ...rows.map((row) => row.children?.length ?? 0),
    1,
  )
  const align = table.align ?? []

  let rowNumber = 1
  if (profile.sheet.includeTitleRow && context.title) {
    const cell = worksheet.getCell(rowNumber, 1)
    cell.value = context.title
    cell.font = {
      name: profile.fonts.body,
      size: profile.fonts.titleSize,
      bold: true,
      color: { argb: argb(profile.colors.title) },
    }
    if (columnCount > 1) worksheet.mergeCells(rowNumber, 1, rowNumber, columnCount)
    rowNumber += 1
    for (const note of context.notes) {
      const noteCell = worksheet.getCell(rowNumber, 1)
      noteCell.value = note
      noteCell.font = {
        name: profile.fonts.body,
        size: profile.fonts.noteSize,
        italic: true,
        color: { argb: argb(profile.colors.note) },
      }
      noteCell.alignment = { wrapText: true, vertical: 'top' }
      if (columnCount > 1) worksheet.mergeCells(rowNumber, 1, rowNumber, columnCount)
      rowNumber += 1
    }
    rowNumber += 1
  }

  const headerRowNumber = rowNumber
  const columnWidths = new Array<number>(columnCount).fill(0)

  rows.forEach((row, rowIndex) => {
    const isHeader = rowIndex === 0
    const targetRow = headerRowNumber + rowIndex
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cellNode = row.children?.[columnIndex]
      const content = cellNode ? typedCellContent(cellNode, profile) : undefined
      const cell = worksheet.getCell(targetRow, columnIndex + 1)
      if (content) cell.value = content.value
      const width = content?.displayLength ?? 0
      const currentWidth = columnWidths[columnIndex] ?? 0
      if (width > currentWidth) columnWidths[columnIndex] = width

      if (isHeader) {
        cell.font = {
          name: profile.fonts.body,
          size: profile.fonts.headerSize,
          bold: true,
          color: { argb: argb(profile.colors.headerText) },
        }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: argb(profile.colors.headerFill) },
        }
      } else {
        cell.font = {
          name: profile.fonts.body,
          size: profile.fonts.bodySize,
          ...whenDefined(content?.bold || undefined, (bold) => ({ bold })),
          color: { argb: argb(profile.colors.ink) },
        }
        if (profile.table.zebraStripes && rowIndex % 2 === 0) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: argb(profile.colors.zebraFill) },
          }
        }
        if (content?.numFmt) cell.numFmt = content.numFmt
      }
      const horizontal = columnAlignment(align[columnIndex], isHeader)
      if (horizontal) cell.alignment = { ...cell.alignment, horizontal }
      cell.border = {
        top: borderSide(profile),
        left: borderSide(profile),
        bottom: borderSide(profile),
        right: borderSide(profile),
      }
    }
  })

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    worksheet.getColumn(columnIndex + 1).width = Math.min(
      profile.table.maxColumnWidth,
      Math.max(
        profile.table.minColumnWidth,
        (columnWidths[columnIndex] ?? 0) + profile.table.columnPadding,
      ),
    )
  }
  const lastRowNumber = headerRowNumber + rows.length - 1
  if (profile.table.freezeHeaderRow) {
    worksheet.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRowNumber }]
  }
  if (profile.table.autoFilter && rows.length > 1) {
    worksheet.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: lastRowNumber, column: columnCount },
    }
  }
}

function borderSide(profile: ExcelGenerationProfile): ExcelJS.Border {
  return {
    style: 'thin',
    color: { argb: argb(profile.colors.border) },
  }
}

function columnAlignment(
  align: string | null | undefined,
  isHeader: boolean,
): 'left' | 'right' | 'center' | undefined {
  if (align === 'right') return isHeader ? 'right' : 'right'
  if (align === 'center') return 'center'
  if (align === 'left') return 'left'
  return undefined
}

const CURRENCY_PATTERN = /^-?([$€£])\s?([\d,]+(?:\.\d+)?)$/
const PERCENT_PATTERN = /^-?[\d,]+(?:\.\d+)?\s?%$/
const NUMBER_PATTERN = /^-?[\d,]+(?:\.\d+)?$/
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function typedCellContent(
  cellNode: MdNode,
  profile: ExcelGenerationProfile,
): CellContent {
  const children = cellNode.children ?? []
  const raw = inlineText(cellNode).trim()
  const bold = children.length === 1 && children[0]?.type === 'strong'

  if (!raw) return { value: null, displayLength: 0 }

  if (raw.startsWith('=') && raw.length > 1) {
    return {
      value: { formula: raw.slice(1) },
      displayLength: profile.table.minColumnWidth,
      bold,
    }
  }
  const currencyMatch = raw.match(CURRENCY_PATTERN)
  const currencySymbol = currencyMatch?.[1]
  const currencyAmount = currencyMatch?.[2]
  if (currencySymbol && currencyAmount) {
    const amount = Number(currencyAmount.replaceAll(',', ''))
    if (Number.isFinite(amount)) {
      return {
        value: raw.startsWith('-') ? -amount : amount,
        numFmt: `"${currencySymbol}"${profile.numberFormats.currency}`,
        displayLength: raw.length,
        bold,
      }
    }
  }
  if (PERCENT_PATTERN.test(raw)) {
    const amount = Number(raw.replace('%', '').replaceAll(',', '').trim())
    if (Number.isFinite(amount)) {
      return {
        value: amount / 100,
        numFmt: profile.numberFormats.percent,
        displayLength: raw.length,
        bold,
      }
    }
  }
  if (NUMBER_PATTERN.test(raw)) {
    const amount = Number(raw.replaceAll(',', ''))
    if (Number.isFinite(amount)) {
      return {
        value: amount,
        numFmt: raw.includes('.')
          ? profile.numberFormats.decimal
          : profile.numberFormats.integer,
        displayLength: raw.length,
        bold,
      }
    }
  }
  if (ISO_DATE_PATTERN.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`)
    if (!Number.isNaN(date.getTime())) {
      return {
        value: date,
        numFmt: profile.numberFormats.date,
        displayLength: raw.length,
        bold,
      }
    }
  }
  if (/^(true|false)$/i.test(raw)) {
    return {
      value: raw.toLowerCase() === 'true',
      displayLength: raw.length,
      bold,
    }
  }
  if (children.length === 1 && children[0]?.type === 'link' && children[0].url) {
    return {
      value: { text: raw, hyperlink: children[0].url },
      displayLength: raw.length,
      bold,
    }
  }
  return { value: raw, displayLength: raw.length, bold }
}

function inlineText(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  return (node.children ?? []).map(inlineText).join('')
}

function uniqueSheetName(candidate: string, used: Set<string>): string {
  const base = sanitizeSheetName(candidate)
  let name = base
  let suffix = 2
  while (used.has(name.toLowerCase())) {
    const suffixText = ` ${suffix}`
    name = base.slice(0, EXCEL_SHEET_NAME_LIMIT - suffixText.length) + suffixText
    suffix += 1
  }
  used.add(name.toLowerCase())
  return name
}

function sanitizeSheetName(name: string): string {
  const cleaned = name
    .replace(/[\\/*?:[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, EXCEL_SHEET_NAME_LIMIT)
    .trim()
  return cleaned || 'Sheet'
}

function argb(hex: string): string {
  return `FF${hex.toUpperCase()}`
}

function abortError(): Error {
  const error = new Error('Excel generation was cancelled.')
  error.name = 'AbortError'
  return error
}
