import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { DoneView } from '../stage-renderers/done'

vi.mock('@/lib/clients/runtime-client', () => ({
  fetchArtifact: vi.fn(),
  fetchExcelWorkbookPreview: vi.fn(),
}))

vi.mock('@/components/markdown-viewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => (
    <div data-testid="markdown-viewer">{content}</div>
  ),
}))

import { fetchArtifact } from '@/lib/clients/runtime-client'
const mockFetchArtifact = vi.mocked(fetchArtifact)

describe('DoneView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading skeleton initially', () => {
    mockFetchArtifact.mockImplementation(() => new Promise(() => {})) // never resolves
    render(<DoneView taskId="t1" runId="run-1" artifactPath="output.md" />)
    // Skeleton elements present while loading
    expect(screen.queryByTestId('markdown-viewer')).not.toBeInTheDocument()
  })

  it('renders completion banner and artifact markdown on success', async () => {
    mockFetchArtifact.mockResolvedValue('# Result\nHello world')
    render(<DoneView taskId="t1" runId="run-1" artifactPath="output.md" />)
    await waitFor(() => {
      expect(screen.getByTestId('markdown-viewer')).toBeInTheDocument()
    })
    expect(screen.getByText(/# Result/)).toBeInTheDocument()
    // Completion banner
    expect(screen.getByText(/Task complete/i)).toBeInTheDocument()
    expect(mockFetchArtifact).toHaveBeenCalledWith('run-1', 'output.md')
  })

  it('shows error message and retry button on fetch failure', async () => {
    mockFetchArtifact.mockRejectedValue(new Error('Network error'))
    render(<DoneView taskId="t1" runId="run-1" artifactPath="output.md" />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    })
    expect(screen.queryByTestId('markdown-viewer')).not.toBeInTheDocument()
  })

  it('retries fetch when retry button is clicked', async () => {
    mockFetchArtifact
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('# Retry worked')
    render(<DoneView taskId="t1" runId="run-1" artifactPath="output.md" />)
    await waitFor(() => screen.getByRole('button', { name: /retry/i }))
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => {
      expect(screen.getByTestId('markdown-viewer')).toBeInTheDocument()
    })
    expect(mockFetchArtifact).toHaveBeenCalledTimes(2)
  })

  it('shows error when artifactPath is empty', async () => {
    render(<DoneView taskId="t1" runId="run-1" artifactPath="" />)
    await waitFor(() => {
      expect(screen.queryByTestId('markdown-viewer')).not.toBeInTheDocument()
    })
    // Should show error state (no artifact)
    expect(mockFetchArtifact).not.toHaveBeenCalled()
  })
})
