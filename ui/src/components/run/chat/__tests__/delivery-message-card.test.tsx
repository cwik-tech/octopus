import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DeliveryMessageCard } from '../delivery-message-card'
import type { ChatMessageDelivery } from '@/lib/models/session-model'
import {
  fetchArtifact,
  fetchExcelWorkbookPreview,
} from '@/lib/clients/runtime-client'

vi.mock('@/lib/clients/runtime-client', () => ({
  artifactUrl: (runId: string, artifactPath: string) =>
    `/api/runs/${runId}/assignments/${artifactPath}`,
  fetchArtifact: vi.fn(),
  fetchExcelWorkbookPreview: vi.fn(),
}))

const makeDelivery = (
  artifacts: ChatMessageDelivery['artifacts'],
): ChatMessageDelivery => ({
  taskId: 'task-1',
  artifacts,
})

describe('DeliveryMessageCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchArtifact).mockResolvedValue('# Report\n\nThe finished body.')
    vi.mocked(fetchExcelWorkbookPreview).mockResolvedValue({
      hiddenSheetCount: 0,
      schemaVersion: 1,
      sheets: [
        {
          columnWidths: [18, 12],
          name: 'Risk Register',
          rowHeights: [null, null],
          rows: [
            [{ value: 'Risk' }, { value: 'Score' }],
            [{ value: 'Regulatory' }, { value: '8' }],
          ],
          totalColumnCount: 2,
          totalRowCount: 2,
          truncated: false,
        },
      ],
      totalVisibleSheetCount: 1,
      truncated: false,
    })
  })

  it('renders nothing when the delivery has no artifacts', () => {
    const { container } = render(
      <DeliveryMessageCard delivery={makeDelivery([])} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it.each(['docx', 'xlsx'])('hides the internal Markdown source paired with a %s delivery', (extension) => {
    render(<DeliveryMessageCard delivery={makeDelivery([
      { runId: 'run-1', path: `output/report.${extension}`, role: 'final' },
      { runId: 'run-1', path: 'output/report.md', role: 'secondary', title: 'Report — Markdown source' },
      { runId: 'run-1', path: 'requested-notes.md', role: 'final' },
    ])} />)
    expect(screen.getByText(`output/report.${extension}`)).toBeVisible()
    expect(screen.queryByText('Report — Markdown source')).not.toBeInTheDocument()
    expect(screen.getByText('requested-notes.md')).toBeVisible()
  })

  it('keeps explicitly delivered Markdown and unrelated supporting files visible', () => {
    render(<DeliveryMessageCard delivery={makeDelivery([
      { runId: 'run-1', path: 'report.docx', role: 'final' },
      { runId: 'run-1', path: 'report.md', role: 'final' },
      { runId: 'run-2', path: 'report.md', role: 'secondary', title: 'Other run source' },
      { runId: 'run-1', path: 'notes.md', role: 'secondary' },
    ])} />)
    expect(screen.getByText('report.md')).toBeVisible()
    expect(screen.getByText('Other run source')).toBeVisible()
    expect(screen.getByText('notes.md')).toBeVisible()
  })

  it('hides a generated Markdown source whose filename differs from the Word output', () => {
    render(<DeliveryMessageCard delivery={makeDelivery([
      { runId: 'run-1', path: 'exports/report.docx', role: 'final' },
      { runId: 'run-1', path: 'drafts/input.md', role: 'secondary', title: 'input.md - Markdown source' },
      { runId: 'run-2', path: 'drafts/input.md', role: 'secondary', title: 'Other run notes' },
    ])} />)
    expect(screen.queryByText('input.md - Markdown source')).not.toBeInTheDocument()
    expect(screen.getByText('Other run notes')).toBeVisible()
  })

  it('renders one card per artifact and marks only supporting files', () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([
          { runId: 'run-1', path: 'output/final.md', role: 'final' },
          { runId: 'run-1', path: 'notes.json', role: 'secondary' },
        ])}
      />,
    )

    expect(screen.getByText('output/final.md')).toBeInTheDocument()
    expect(screen.getByText('notes.json')).toBeInTheDocument()
    expect(screen.queryByText('Final delivery')).not.toBeInTheDocument()
    expect(screen.getByText('Supporting file')).toBeInTheDocument()
  })

  it('uses a lighter surface for artifact cards on the dark chat background', () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([
          { runId: 'run-1', path: 'output/final.md', role: 'final' },
        ])}
      />,
    )

    expect(screen.getByText('output/final.md').closest('section')).toHaveClass(
      'bg-secondary',
    )
  })

  it('prefers the artifact title over the path when provided', () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([
          {
            runId: 'run-1',
            path: 'output/final.md',
            role: 'final',
            title: 'Adoption report',
          },
        ])}
      />,
    )

    expect(screen.getByText('Adoption report')).toBeInTheDocument()
    expect(screen.queryByText('output/final.md')).not.toBeInTheDocument()
  })

  it('opens Markdown in the full view without rendering content inline', async () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([
          { runId: 'run-1', path: 'output/final.md', role: 'final' },
        ])}
      />,
    )

    // No inline preview: nothing is fetched until the sheet opens.
    expect(fetchArtifact).not.toHaveBeenCalled()
    expect(screen.queryByText('The finished body.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open full view' }))

    await waitFor(() => {
      expect(fetchArtifact).toHaveBeenCalledWith('run-1', 'output/final.md')
    })
    expect(
      await screen.findByRole('heading', { name: /final\.md/i }),
    ).toBeInTheDocument()
    // The sheet's top bar offers copy + download actions.
    expect(screen.getByLabelText('Copy content')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Download final.md'),
    ).toHaveAttribute('href', '/api/runs/run-1/assignments/output/final.md')
  })

  it('offers DOCX artifacts as a download instead of a preview', () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([
          { runId: 'run-1', path: 'output/report.docx', role: 'final' },
        ])}
      />,
    )

    const link = screen.getByRole('link', { name: 'Download output/report.docx' })
    expect(link).toHaveAttribute(
      'href',
      '/api/runs/run-1/assignments/output/report.docx',
    )
    expect(link).toHaveAttribute('download', 'report.docx')
    expect(fetchArtifact).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Open full view' })).not.toBeInTheDocument()
  })

  it('offers retained video artifacts as downloads without decoding them as text', () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([{
          runId: 'run-1',
          path: 'output/manuals/video/run/source-video.mp4',
          mediaType: 'video/mp4',
          role: 'secondary',
        }])}
      />,
    )

    const link = screen.getByRole('link', {
      name: 'Download output/manuals/video/run/source-video.mp4',
    })
    expect(link).toHaveAttribute('download', 'source-video.mp4')
    expect(fetchArtifact).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Open full view' })).not.toBeInTheDocument()
  })

  it('offers extension-matched video artifacts as downloads even without a mediaType', () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([{
          runId: 'run-1',
          path: 'output/manuals/video/run/source-video.mp4',
          role: 'secondary',
        }])}
      />,
    )

    const link = screen.getByRole('link', {
      name: 'Download output/manuals/video/run/source-video.mp4',
    })
    expect(link).toHaveAttribute('download', 'source-video.mp4')
    expect(fetchArtifact).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Open full view' })).not.toBeInTheDocument()
  })

  it('offers extension-matched WebM artifacts as downloads even without a mediaType', () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([{
          runId: 'run-1',
          path: 'output/manuals/video/run/source-video.webm',
          role: 'secondary',
        }])}
      />,
    )

    expect(
      screen.getByRole('link', { name: 'Download output/manuals/video/run/source-video.webm' }),
    ).toHaveAttribute('download', 'source-video.webm')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('opens the preview sheet for non-Markdown, non-DOCX artifacts', async () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([
          { runId: 'run-1', path: 'research/data.json', role: 'secondary' },
        ])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open full view' }))

    await waitFor(() => {
      expect(fetchArtifact).toHaveBeenCalledWith('run-1', 'research/data.json')
    })
    expect(
      await screen.findByRole('heading', { name: /data\.json/i }),
    ).toBeInTheDocument()
  })

  it('opens XLSX artifacts as workbook sheets without decoding ZIP bytes as text', async () => {
    render(
      <DeliveryMessageCard
        delivery={makeDelivery([
          {
            runId: 'run-1',
            path: 'output/risk-scoring-framework.xlsx',
            role: 'final',
          },
        ])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open full view' }))

    await waitFor(() => {
      expect(fetchExcelWorkbookPreview).toHaveBeenCalledWith(
        'run-1',
        'output/risk-scoring-framework.xlsx',
      )
    })
    expect(fetchArtifact).not.toHaveBeenCalled()
    expect(
      await screen.findByRole('table', { name: 'Risk Register worksheet' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Regulatory')).toBeInTheDocument()
    expect(screen.queryByLabelText('Copy content')).not.toBeInTheDocument()
    expect(
      screen.getByLabelText('Download risk-scoring-framework.xlsx'),
    ).toHaveAttribute(
      'href',
      '/api/runs/run-1/assignments/output/risk-scoring-framework.xlsx',
    )
  })
})

it('downloads a portable Markdown ZIP without attempting a document preview', () => {
  render(<DeliveryMessageCard delivery={makeDelivery([{ runId: 'run-1', path: 'output/manual.zip', role: 'secondary', mediaType: 'application/zip' }])} />)
  expect(screen.getByRole('link', { name: 'Download output/manual.zip' })).toHaveAttribute('download', 'manual.zip')
  expect(screen.queryByRole('button', { name: /Open full view|Open in Canvas/ })).not.toBeInTheDocument()
})
