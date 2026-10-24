import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canvasTabKey } from '@contracts/canvas-workspace'
import { OFFICE_PROFILE } from '@contracts/office-documents'
import { CanvasContext, type CanvasController } from '../canvas-context'
import { CanvasPanel } from '../canvas-panel'

function renderOffice(extension: string) {
  const target = { runId: 'office-run', artifactPath: `files/report.${extension}` }
  const controller: CanvasController = { sessionId: 'ad605beb-dadc-403a-bca4-b05df6e00001', workspace: { schemaVersion: 1, revision: 1, tabs: [target], activeKey: canvasTabKey(target) }, error: null, hidden: false, requested: true, expanded: false, detached: false, standalone: false, opening: false, canDetach: false, detach: () => {}, act: () => {}, open: () => {}, show: () => {}, hide: () => {}, toggleExpanded: () => {} }
  return render(<CanvasContext value={controller}><CanvasPanel /></CanvasContext>)
}
const preview = { html: '<html><body><h1>Quarterly revenue</h1></body></html>', digest: 'a'.repeat(64), profile: OFFICE_PROFILE, notices: ['Local fonts'] }
beforeEach(() => {
  // jsdom lacks the desktop bridge; actual rendering is checked in Electron.
  const desktop: NonNullable<Window['pipeline']> = { openWindow: async () => {}, selectBatchFolder: async () => null, selectSharedFolder: async () => null }
  vi.stubGlobal('pipeline', desktop)
})
afterEach(() => vi.unstubAllGlobals())

it.each(['docx', 'xlsx', 'pptx'])('opens %s as a document preview without source or editing controls', async (extension) => {
  // Only the unavailable desktop HTTP endpoint is replaced.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => Response.json(String(input).endsWith('/lookup') ? null : preview)))
  renderOffice(extension)
  await screen.findByTitle('HTML preview')
  expect(screen.getByLabelText(`Download report.${extension}`)).toBeVisible()
  expect(screen.queryByRole('tab', { name: 'Source' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'Preview' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Create working copy' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Revision instruction' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Retained original|Saved revision/)).not.toBeInTheDocument()
})

it('retains the last Office preview and its failure message after a failed refresh', async () => {
  let previews = 0
  // The local API is unavailable in jsdom; replace only HTTP.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => String(input).endsWith('/lookup') ? Response.json(null) : ++previews === 1 ? Response.json(preview) : Response.json({ error: 'Conversion failed' }, { status: 503 })))
  renderOffice('docx')
  const frame = await screen.findByTitle('HTML preview')
  fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Showing the last loaded preview. Conversion failed'))
  expect(screen.getByTitle('HTML preview')).toBe(frame)
})
