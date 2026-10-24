import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canvasDocumentActionSchema, type CanvasDocument } from '@contracts/canvas-documents'
import { CanvasMarkdownDocument } from '../canvas-markdown-document'

const target = { runId: 'actions-run', artifactPath: 'files/report.md' }
const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00005'
const makeDocument = (): CanvasDocument => ({ schemaVersion: 1, id: 'e'.repeat(64), sessionId, origin: target, snapshotDigest: 'f'.repeat(64), revision: 0, content: 'Original text', proposal: null })
const show = () => render(<CanvasMarkdownDocument sessionId={sessionId} target={target} originContent="Original text" />)
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

it('lets the user discard local changes and return to the saved Markdown', async () => {
  // Only the unavailable desktop HTTP boundary is substituted.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(makeDocument())))
  show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fireEvent.change(editor, { target: { value: 'Unwanted local edits' } })

  fireEvent.click(screen.getByRole('button', { name: 'Discard local changes' }))

  expect(editor).toHaveValue('Original text')
  expect(screen.getByText('All changes saved')).toBeVisible()
})

it('offers discard while a selected-text revision is still being generated', async () => {
  let document = makeDocument()
  let finish: ((response: Response) => void) | undefined
  const pending = new Promise<Response>((resolve) => { finish = resolve })
  // Only HTTP/provider timing is replaced. No internal module is stubbed.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== 'POST') return Response.json(document)
    const raw: unknown = JSON.parse(String(init.body))
    const action = canvasDocumentActionSchema.parse(raw)
    if (action.kind === 'propose') {
      document = { ...document, proposal: { id: 'pending-1', status: 'generating', baseRevision: 0, baseContent: document.content, snapshotDigest: document.snapshotDigest, generation: 1, selectionStart: action.selectionStart, selectionEnd: action.selectionEnd, selectedText: action.selectedText, instruction: action.instruction, replacementText: null, appliedRevision: null } }
      return pending
    }
    if (action.kind === 'discard' && document.proposal) document = { ...document, proposal: { ...document.proposal, status: 'discarded' } }
    return Response.json(document)
  }))
  show()
  await screen.findByRole('textbox', { name: 'Markdown document' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Revision instruction' }), { target: { value: 'Add a sentence' } })
  fireEvent.click(screen.getByRole('button', { name: 'Request revision' }))

  fireEvent.click(await screen.findByRole('button', { name: 'Discard pending revision' }))

  await waitFor(() => expect(document.proposal?.status).toBe('discarded'))
  await act(async () => { finish?.(Response.json(document)); await pending })
  expect(screen.queryByRole('button', { name: 'Accept revision' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Markdown document' })).toHaveValue('Original text')
})
