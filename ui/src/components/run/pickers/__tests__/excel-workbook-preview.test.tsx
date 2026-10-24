import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ExcelWorkbookPreview } from '@/components/run/pickers/excel-workbook-preview'
import type { ExcelWorkbookPreview as ExcelWorkbookPreviewModel } from '@/lib/models/runtime-model'

const WORKBOOK: ExcelWorkbookPreviewModel = {
  hiddenSheetCount: 1,
  schemaVersion: 1,
  sheets: [
    {
      columnWidths: [20, 12],
      name: 'Summary',
      rowHeights: [24, null],
      rows: [
        [
          {
            style: {
              bold: true,
              fillColor: '#1F4E78',
              fontColor: '#FFFFFF',
            },
            value: 'Risk',
          },
          { value: 'Score' },
        ],
        [
          { value: 'Regulatory' },
          { formula: 'SUM(B2:B2)', value: '72%' },
        ],
      ],
      totalColumnCount: 2,
      totalRowCount: 2,
      truncated: false,
    },
    {
      columnWidths: [18],
      name: 'Notes',
      rowHeights: [null],
      rows: [[{ value: 'Review quarterly' }]],
      totalColumnCount: 1,
      totalRowCount: 1,
      truncated: false,
    },
  ],
  totalVisibleSheetCount: 2,
  truncated: false,
}

describe('ExcelWorkbookPreview', () => {
  it('renders workbook cells and switches between sheet tabs', async () => {
    const user = userEvent.setup()
    render(<ExcelWorkbookPreview workbook={WORKBOOK} />)

    expect(
      screen.getByRole('table', { name: 'Summary worksheet' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Regulatory')).toBeInTheDocument()
    expect(screen.getByText('72%')).toHaveAttribute(
      'title',
      'Formula: =SUM(B2:B2)',
    )
    expect(screen.getByText('Risk')).toHaveStyle({
      backgroundColor: '#1F4E78',
      color: '#FFFFFF',
      fontWeight: '600',
    })
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Notes' }))

    expect(
      screen.getByRole('table', { name: 'Notes worksheet' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Review quarterly')).toBeInTheDocument()
    expect(
      screen.queryByRole('table', { name: 'Summary worksheet' }),
    ).not.toBeInTheDocument()
  })

  it('explains hidden and truncated workbook content', () => {
    render(
      <ExcelWorkbookPreview
        workbook={{
          ...WORKBOOK,
          sheets: [WORKBOOK.sheets[0]!],
          totalVisibleSheetCount: 3,
          truncated: true,
        }}
      />,
    )

    expect(
      screen.getByText(/Showing 1 of 3 visible sheets/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/1 hidden sheet is not shown/),
    ).toBeInTheDocument()
  })
})
