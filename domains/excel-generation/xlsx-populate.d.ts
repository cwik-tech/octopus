// xlsx-populate ships no TypeScript types; this covers the surface the
// template filler uses (cells, ranges, defined names, buffer output).
declare module 'xlsx-populate' {
  interface XlsxPopulateCell {
    value(): unknown
    value(value: unknown): XlsxPopulateCell
    formula(): string | undefined
    relativeCell(rowOffset: number, columnOffset: number): XlsxPopulateCell
  }

  interface XlsxPopulateRange {
    startCell(): XlsxPopulateCell
    value(value: unknown): XlsxPopulateRange
  }

  interface XlsxPopulateSheet {
    name(): string
    cell(address: string): XlsxPopulateCell
    cell(row: number, column: number): XlsxPopulateCell
  }

  interface XlsxPopulateWorkbook {
    sheet(nameOrIndex: string | number): XlsxPopulateSheet | undefined
    sheets(): XlsxPopulateSheet[]
    definedName(name: string): XlsxPopulateCell | XlsxPopulateRange | undefined
    outputAsync(): Promise<Buffer>
  }

  const XlsxPopulate: {
    fromDataAsync(data: Buffer | ArrayBuffer): Promise<XlsxPopulateWorkbook>
    fromFileAsync(path: string): Promise<XlsxPopulateWorkbook>
    fromBlankAsync(): Promise<XlsxPopulateWorkbook>
    dateToNumber(date: Date): number
    numberToDate(value: number): Date
  }

  export default XlsxPopulate
}
