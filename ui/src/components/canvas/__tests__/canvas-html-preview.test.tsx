import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canvasTabKey } from '@contracts/canvas-workspace'
import { CanvasContext, type CanvasController } from '../canvas-context'
import { CanvasPanel } from '../canvas-panel'

const source = '<!doctype html><html><body><h1>Interactive sample</h1><script>document.body.dataset.ready = "yes"</script></body></html>'
const target = { runId: 'html-run', artifactPath: 'files/sample.html' }
function makeController(): CanvasController {
  return { sessionId: 'ad605beb-dadc-403a-bca4-b05df6e00001', workspace: { schemaVersion: 1, revision: 1, tabs: [target], activeKey: canvasTabKey(target) }, error: null, hidden: false, requested: true, expanded: false, detached: false, standalone: false, opening: false, canDetach: false, detach: () => {}, act: () => {}, open: () => {}, show: () => {}, hide: () => {}, toggleExpanded: () => {} }
}
beforeEach(() => {
  // jsdom has no native desktop bridge. Substitute only platform availability;
  // Chromium security and native navigation guards use the real Electron app.
  const desktop: NonNullable<Window['pipeline']> = { openWindow: async () => {}, selectBatchFolder: async () => null, selectSharedFolder: async () => null }
  vi.stubGlobal('pipeline', desktop)
})
afterEach(() => vi.unstubAllGlobals())

it('opens HTML as a preview and lets the user read the exact source without resetting the preview', async () => {
  // jsdom has no local desktop API. Only its HTTP boundary is substituted;
  // actual HTML execution and security are covered by the Electron journey.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ content: source })))
  render(<CanvasContext value={makeController()}><CanvasPanel /></CanvasContext>)
  const preview = await screen.findByTitle('HTML preview')

  fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
  expect(screen.getByLabelText('HTML source').textContent).toBe(source)
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }))
  expect(screen.getByTitle('HTML preview')).toBe(preview)
})

it('keeps the last HTML preview and source available after a failed refresh', async () => {
  // Replace only the unavailable HTTP transport, including its failure result.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ content: source })).mockResolvedValueOnce(Response.json({ error: 'Generation failed' }, { status: 503 })))
  render(<CanvasContext value={makeController()}><CanvasPanel /></CanvasContext>)
  const preview = await screen.findByTitle('HTML preview')

  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Showing the last loaded preview. Generation failed'))
  expect(screen.getByTitle('HTML preview')).toBe(preview)
  fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
  expect(screen.getByLabelText('HTML source').textContent).toBe(source)
})

it('keeps the successful HTML preview usable while a newer generation is loading', async () => {
  let finish: ((response: Response) => void) | undefined
  const pending = new Promise<Response>((resolve) => { finish = resolve })
  // Only the unavailable desktop HTTP boundary is substituted. A controlled
  // response models regeneration without a timer or replaced internal module.
  const boundary = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ content: source })).mockReturnValueOnce(pending)
  vi.stubGlobal('fetch', boundary)
  render(<CanvasContext value={makeController()}><CanvasPanel /></CanvasContext>)
  const preview = await screen.findByTitle('HTML preview')

  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(boundary).toHaveBeenCalledTimes(2))
  expect(screen.getByTitle('HTML preview')).toBe(preview)
  fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
  expect(screen.getByLabelText('HTML source').textContent).toBe(source)
  await act(async () => { finish?.(Response.json({ content: '<h1>Next generation</h1>' })); await pending })
  expect(screen.getByLabelText('HTML source').textContent).toBe('<h1>Next generation</h1>')
  expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true')
})

it('shows HTML source without executing a preview outside the desktop app', async () => {
  vi.stubGlobal('pipeline', undefined)
  // Only the unavailable HTTP transport is substituted.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ content: source })))
  render(<CanvasContext value={makeController()}><CanvasPanel /></CanvasContext>)

  expect((await screen.findByLabelText('HTML source')).textContent).toBe(source)
  expect(screen.queryByTitle('HTML preview')).not.toBeInTheDocument()
  expect(screen.getByText('Interactive HTML previews are available in the desktop app.')).toBeVisible()
})
