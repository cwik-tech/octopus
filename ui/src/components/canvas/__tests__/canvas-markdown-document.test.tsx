import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canvasDocumentActionSchema, type CanvasDocument } from '@contracts/canvas-documents'
import { CanvasMarkdownDocument } from '../canvas-markdown-document'
import { useCanvasDocument } from '../use-canvas-document'

const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00001'
const target = { runId: 'canvas-run', artifactPath: 'files/garden.md' }
function makeDocument(): CanvasDocument {
  return { schemaVersion: 1, id: 'a'.repeat(64), sessionId, origin: target, snapshotDigest: 'b'.repeat(64), revision: 0, content: '# Garden\n\nRoses bloom.', proposal: null }
}
// The component also looks up optional Word snapshots. Keep that HTTP route
// separate from Markdown actions, matching the real API's empty-state response.
function markdownFetch(handler: typeof fetch) {
  return vi.fn<typeof fetch>((input, init) => String(input).endsWith('/office/word-snapshot/state')
    ? Promise.resolve(Response.json(null))
    : handler(input, init))
}
function show() { return render(<CanvasMarkdownDocument sessionId={sessionId} target={target} originContent={'# Garden\n\nRoses bloom.'} />) }
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

it('saves a working copy against its displayed revision', async () => {
  let document = makeDocument()
  // jsdom has no desktop API. Only HTTP is replaced; a real API and persisted
  // store are exercised by canvas-editing.spec.ts and backend integrations.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => {
    if (init?.method === 'POST') {
      const raw: unknown = JSON.parse(String(init.body))
      const action = canvasDocumentActionSchema.parse(raw)
      if (action.kind !== 'save' || action.expectedRevision !== 0) return Response.json({ error: 'Wrong base', code: 'revision_conflict' }, { status: 409 })
      document = { ...document, revision: 1, content: action.content }
    }
    return Response.json(document)
  }))
  show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fireEvent.change(editor, { target: { value: '# Garden\n\nLilies bloom.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('All changes saved', { exact: true })
  expect(document.content).toBe('# Garden\n\nLilies bloom.')
  expect(editor).toHaveValue('# Garden\n\nLilies bloom.')
})

it('keeps unsaved local text when another view saves a new revision', async () => {
  let document = makeDocument()
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async () => Response.json(document)))
  show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fireEvent.change(editor, { target: { value: 'My unsaved draft' } })
  document = { ...document, revision: 1, content: 'Saved in the other window' }
  fireEvent.focus(window)
  await screen.findByText('A newer saved revision is available. Your draft has been kept.', { exact: true })
  expect(editor).toHaveValue('My unsaved draft')
  fireEvent.click(screen.getByRole('button', { name: 'Review saved revision' }))
  expect(screen.getByLabelText('Current saved Markdown')).toHaveTextContent('Saved in the other window')
  expect(editor).toHaveValue('My unsaved draft')
})

it('restores an unsaved draft after its editor closes and reopens', async () => {
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async () => Response.json(makeDocument())))
  const view = show()
  fireEvent.change(await screen.findByRole('textbox', { name: 'Markdown document' }), { target: { value: 'Keep after close' } })
  view.unmount()
  show()
  expect(await screen.findByRole('textbox', { name: 'Markdown document' })).toHaveValue('Keep after close')
})

it('reviews and accepts a replacement for the exact captured selection', async () => {
  let document = makeDocument()
  // Only the unavailable desktop HTTP boundary is replaced; provider work and
  // revision application are covered at the real backend boundary.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => {
    if (init?.method === 'POST') {
      const raw: unknown = JSON.parse(String(init.body))
      const action = canvasDocumentActionSchema.parse(raw)
      if (action.kind === 'propose') document = { ...document, proposal: { id: 'proposal-1', status: 'ready', baseRevision: 0, baseContent: document.content, snapshotDigest: document.snapshotDigest, generation: 1, selectionStart: action.selectionStart, selectionEnd: action.selectionEnd, selectedText: action.selectedText, instruction: action.instruction, replacementText: 'Lilies', appliedRevision: null } }
      if (action.kind === 'accept') document = { ...document, revision: 1, content: '# Garden\n\nLilies bloom.', proposal: document.proposal ? { ...document.proposal, status: 'applied', appliedRevision: 1 } : null }
    }
    return Response.json(document)
  }))
  show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  expect(editor).toBeInstanceOf(HTMLTextAreaElement)
  if (!(editor instanceof HTMLTextAreaElement)) throw new Error('Markdown editor must support text selection')
  editor.setSelectionRange(10, 15)
  fireEvent.select(editor)
  fireEvent.change(screen.getByRole('textbox', { name: 'Revision instruction' }), { target: { value: 'Use lilies instead' } })
  fireEvent.click(screen.getByRole('button', { name: 'Request revision' }))
  await waitFor(() => expect(screen.getByLabelText('Captured selection')).toHaveTextContent('Roses'))
  expect(screen.getByLabelText('Proposed replacement')).toHaveTextContent('Lilies')
  fireEvent.click(screen.getByRole('button', { name: 'Accept revision' }))
  await waitFor(() => expect(editor).toHaveValue('# Garden\n\nLilies bloom.'))
})

it('disables proposal acceptance while local edits are unsaved', async () => {
  const original = makeDocument()
  const document = { ...original, proposal: { id: 'proposal-1', status: 'ready', baseRevision: 0, baseContent: original.content, snapshotDigest: original.snapshotDigest, generation: 1, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Use lilies', replacementText: 'Lilies', appliedRevision: null } }
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async () => Response.json(document)))
  show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fireEvent.change(editor, { target: { value: 'My pending edit' } })
  expect(screen.getByRole('button', { name: 'Accept revision' })).toBeDisabled()
  expect(editor).toHaveValue('My pending edit')
})

it('leaves an unverifiable original read-only and explains why editing was refused', async () => {
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => init?.method === 'POST'
    ? Response.json({ code: 'origin_unverifiable', error: 'The original has no trusted publication digest.' }, { status: 409 })
    : Response.json({ code: 'document_not_found', error: 'No working copy' }, { status: 404 })))
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Markdown' }))
  await act(async () => {})
  expect(await screen.findByRole('alert')).toHaveTextContent('The original has no trusted publication digest.')
  expect(screen.queryByRole('textbox', { name: 'Markdown document' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Garden' })).toBeVisible()
})

function pendingResponse() {
  let resolve: (response: Response) => void = () => { throw new Error('The pending response has not been arranged') }
  const response = new Promise<Response>((complete) => { resolve = complete })
  return { response, resolve }
}

function makeReadyDocument(): CanvasDocument {
  const document = makeDocument()
  return { ...document, proposal: { id: 'proposal-1', status: 'ready', baseRevision: 0, baseContent: document.content, snapshotDigest: document.snapshotDigest, generation: 1, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Use lilies', replacementText: 'Lilies', appliedRevision: null } }
}

it('keeps an action failure visible after refreshing an existing working copy', async () => {
  const document = makeDocument()
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => init?.method === 'POST'
    ? Response.json({ code: 'storage_unavailable', error: 'The document could not be saved.' }, { status: 503 })
    : Response.json(document)))
  show()
  fireEvent.change(await screen.findByRole('textbox', { name: 'Markdown document' }), { target: { value: 'Keep this draft' } })

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await act(async () => {})

  expect(screen.getByRole('alert')).toHaveTextContent('The document could not be saved.')
  expect(screen.getByRole('textbox', { name: 'Markdown document' })).toHaveValue('Keep this draft')
})

it('saves text typed during an earlier save against the revision that save created', async () => {
  let document = makeDocument()
  const pending = pendingResponse()
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => {
    if (init?.method !== 'POST') return Response.json(document)
    const action = canvasDocumentActionSchema.parse(JSON.parse(String(init.body)))
    if (action.kind !== 'save') throw new Error('Only saves are expected')
    if (action.expectedRevision !== document.revision) return Response.json({ code: 'revision_conflict', error: 'The saved revision changed.' }, { status: 409 })
    document = { ...document, revision: document.revision + 1, content: action.content }
    return document.revision === 1 ? pending.response : Response.json(document)
  }))
  show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fireEvent.change(editor, { target: { value: 'First edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  fireEvent.change(editor, { target: { value: 'Further typing while saving' } })

  await act(async () => { pending.resolve(Response.json(document)) })

  expect(editor).toHaveValue('Further typing while saving')
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('All changes saved', { exact: true })
  expect(document.content).toBe('Further typing while saving')
  expect(document.revision).toBe(2)
})

it('preserves local text entered while a proposal is being accepted', async () => {
  let document = makeReadyDocument()
  const pending = pendingResponse()
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => init?.method === 'POST' ? pending.response : Response.json(document)))
  const view = show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fireEvent.click(screen.getByRole('button', { name: 'Accept revision' }))
  fireEvent.change(editor, { target: { value: 'Typing that must survive acceptance' } })
  document = { ...document, revision: 1, content: '# Garden\n\nLilies bloom.', proposal: document.proposal ? { ...document.proposal, status: 'applied', appliedRevision: 1 } : null }

  await act(async () => { pending.resolve(Response.json(document)) })

  expect(editor).toHaveValue('Typing that must survive acceptance')
  expect(screen.getByText('A newer saved revision is available. Your draft has been kept.', { exact: true })).toBeVisible()
  view.unmount()
  show()
  expect(await screen.findByRole('textbox', { name: 'Markdown document' })).toHaveValue('Typing that must survive acceptance')
})

it('does not revive a discarded proposal when an earlier refresh returns the same content revision', async () => {
  let document = makeReadyDocument()
  const stale = pendingResponse()
  let deferRefresh = false
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => {
    if (init?.method === 'POST') {
      document = { ...document, proposal: document.proposal ? { ...document.proposal, status: 'discarded' } : null }
      return Response.json(document)
    }
    return deferRefresh ? stale.response : Response.json(document)
  }))
  show()
  await screen.findByRole('button', { name: 'Accept revision' })
  deferRefresh = true
  const earlier = document
  fireEvent.focus(window)
  fireEvent.click(screen.getByRole('button', { name: 'Discard revision' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Agent revision review' })).not.toBeInTheDocument())

  await act(async () => { stale.resolve(Response.json(earlier)) })

  expect(screen.queryByRole('region', { name: 'Agent revision review' })).not.toBeInTheDocument()
})

it('ignores a previous chat save that finishes after the editor switches chat owners', async () => {
  const pending = pendingResponse()
  const secondSessionId = 'ad605beb-dadc-403a-bca4-b05df6e00002'
  const secondDocument = { ...makeDocument(), sessionId: secondSessionId, content: 'Second chat document' }
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (url, init) => {
    if (init?.method === 'POST') return pending.response
    return Response.json(String(url).includes(secondSessionId) ? secondDocument : makeDocument())
  }))
  const view = show()
  fireEvent.change(await screen.findByRole('textbox', { name: 'Markdown document' }), { target: { value: 'First chat edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  view.rerender(<CanvasMarkdownDocument sessionId={secondSessionId} target={target} originContent="Second chat original" />)
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown document' })).toHaveValue('Second chat document'))

  await act(async () => { pending.resolve(Response.json({ ...makeDocument(), revision: 1, content: 'First chat edit' })) })

  expect(screen.getByRole('textbox', { name: 'Markdown document' })).toHaveValue('Second chat document')
})

it.each(['generating', 'ready'] as const)('discards an admitted %s request and does not revive its late response', async (status) => {
  let document = makeDocument()
  const ready = makeReadyDocument()
  const pending = pendingResponse()
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => {
    if (init?.method !== 'POST') return Response.json(document)
    const action = canvasDocumentActionSchema.parse(JSON.parse(String(init.body)))
    if (action.kind === 'propose') {
      document = { ...ready, proposal: ready.proposal ? { ...ready.proposal, status, replacementText: status === 'generating' ? null : 'Lilies' } : null }
      return pending.response
    }
    if (action.kind !== 'discard' || action.proposalId !== 'proposal-1') throw new Error('Discard must target the admitted proposal')
    document = { ...document, proposal: document.proposal ? { ...document.proposal, status: 'discarded' } : null }
    return Response.json(document)
  }))
  const { result } = renderHook(() => useCanvasDocument(sessionId, target))
  await waitFor(() => expect(result.current.document?.content).toBe('# Garden\n\nRoses bloom.'))
  let proposing = Promise.resolve()
  act(() => { proposing = result.current.mutate({ kind: 'propose', target, expectedRevision: 0, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Use lilies' }) })

  await act(async () => { await result.current.discardGenerating() })

  expect(result.current.document?.proposal?.status).toBe('discarded')
  await act(async () => { pending.resolve(Response.json(ready)); await proposing })
  expect(result.current.document?.proposal?.status).toBe('discarded')
  expect(result.current.document?.content).toBe('# Garden\n\nRoses bloom.')
})

it('keeps a newer request busy when a previously discarded request finishes', async () => {
  let document = makeDocument()
  const first = pendingResponse()
  const second = pendingResponse()
  const ready = makeReadyDocument()
  let admitted = 0
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => {
    if (init?.method !== 'POST') return Response.json(document)
    const action = canvasDocumentActionSchema.parse(JSON.parse(String(init.body)))
    if (action.kind === 'propose') {
      admitted += 1
      document = { ...ready, proposal: ready.proposal ? { ...ready.proposal, id: `proposal-${admitted}`, generation: admitted, status: 'generating', replacementText: null } : null }
      return admitted === 1 ? first.response : second.response
    }
    if (action.kind !== 'discard') throw new Error('Only proposal admission and discard are expected')
    document = { ...document, proposal: document.proposal ? { ...document.proposal, status: 'discarded' } : null }
    return Response.json(document)
  }))
  const { result } = renderHook(() => useCanvasDocument(sessionId, target))
  await waitFor(() => expect(result.current.document?.revision).toBe(0))
  let firstRequest = Promise.resolve()
  act(() => { firstRequest = result.current.mutate({ kind: 'propose', target, expectedRevision: 0, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Use lilies' }) })
  await act(async () => { await result.current.discardGenerating() })
  const discarded = document
  let secondRequest = Promise.resolve()
  act(() => { secondRequest = result.current.mutate({ kind: 'propose', target, expectedRevision: 0, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Use lilies' }) })

  await act(async () => { first.resolve(Response.json(discarded)); await firstRequest })

  expect(result.current.busy).toBe('propose')
  await act(async () => { second.resolve(Response.json({ ...ready, proposal: ready.proposal ? { ...ready.proposal, id: 'proposal-2', generation: 2 } : null })); await secondRequest })
  expect(result.current.document?.proposal?.generation).toBe(2)
  expect(result.current.busy).toBeNull()
})

it('keeps a request pending when discard arrives before proposal admission', async () => {
  const document = makeDocument()
  const pending = pendingResponse()
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => init?.method === 'POST' ? pending.response : Response.json(document)))
  const { result } = renderHook(() => useCanvasDocument(sessionId, target))
  await waitFor(() => expect(result.current.document?.revision).toBe(0))
  let proposing = Promise.resolve()
  act(() => { proposing = result.current.mutate({ kind: 'propose', target, expectedRevision: 0, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Use lilies' }) })

  await act(async () => { await result.current.discardGenerating() })

  expect(result.current.error).toContain('not yet admitted')
  expect(result.current.busy).toBe('propose')
  expect(result.current.document?.proposal).toBeNull()
  await act(async () => { pending.resolve(Response.json(makeReadyDocument())); await proposing })
  expect(result.current.document?.proposal?.status).toBe('ready')
})

function fillDraftStorageQuota() {
  // The installed jsdom default is 5,000,000 code units. Leave less room
  // than a draft key needs and exercise its real QuotaExceededError boundary.
  localStorage.setItem('quota-fixture', 'q'.repeat(4_999_950))
}

it('keeps a local storage failure visible through refresh until the draft is persisted', async () => {
  // Only the unavailable desktop HTTP boundary is replaced; storage is real.
  vi.stubGlobal('fetch', markdownFetch(async () => Response.json(makeDocument())))
  const view = show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fillDraftStorageQuota()
  fireEvent.change(editor, { target: { value: 'Latest text that could not be stored' } })
  expect(screen.getByRole('alert')).toHaveTextContent('Your draft could not be saved locally. Keep this window open:')

  fireEvent.focus(window)
  await act(async () => {})

  expect(screen.getByRole('alert')).toHaveTextContent('Your draft could not be saved locally. Keep this window open:')
  expect(editor).toHaveValue('Latest text that could not be stored')
  localStorage.removeItem('quota-fixture')
  fireEvent.change(editor, { target: { value: 'Draft saved after storage was freed' } })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  view.unmount()
  show()
  expect(await screen.findByRole('textbox', { name: 'Markdown document' })).toHaveValue('Draft saved after storage was freed')
})

it('keeps a local storage failure visible until a pending document save succeeds', async () => {
  let document = makeDocument()
  const pending = pendingResponse()
  // Only the unavailable desktop HTTP boundary is replaced; storage is real.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => init?.method === 'POST' ? pending.response : Response.json(document)))
  show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fillDraftStorageQuota()
  fireEvent.change(editor, { target: { value: 'Keep until the server saves this text' } })

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

  expect(screen.getByRole('alert')).toHaveTextContent('Your draft could not be saved locally. Keep this window open:')
  expect(editor).toHaveValue('Keep until the server saves this text')
  document = { ...document, revision: 1, content: 'Keep until the server saves this text' }
  await act(async () => { pending.resolve(Response.json(document)) })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('All changes saved', { exact: true })).toBeVisible()
  expect(editor).toHaveValue('Keep until the server saves this text')
})

it('clears a local storage failure when the user discards the unsaved text', async () => {
  // Only the unavailable desktop HTTP boundary is replaced; storage is real.
  vi.stubGlobal('fetch', markdownFetch(async () => Response.json(makeDocument())))
  show()
  const editor = await screen.findByRole('textbox', { name: 'Markdown document' })
  fillDraftStorageQuota()
  fireEvent.change(editor, { target: { value: 'Discard this unpersisted draft' } })
  expect(screen.getByRole('alert')).toHaveTextContent('Your draft could not be saved locally. Keep this window open:')

  fireEvent.click(screen.getByRole('button', { name: 'Discard local changes' }))

  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(editor).toHaveValue('# Garden\n\nRoses bloom.')
})

it('keeps a newer request failure visible when an obsolete request succeeds', async () => {
  let document = makeDocument()
  const pending = pendingResponse()
  let requests = 0
  const ready = makeReadyDocument()
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', markdownFetch(async (_url, init) => {
    if (init?.method !== 'POST') return Response.json(document)
    const action = canvasDocumentActionSchema.parse(JSON.parse(String(init.body)))
    if (action.kind === 'propose') {
      requests += 1
      if (requests === 1) { document = ready; return pending.response }
      return Response.json({ code: 'model_unavailable', error: 'The newer revision request failed.' }, { status: 503 })
    }
    if (action.kind !== 'discard') throw new Error('Only proposals and discard are expected')
    document = { ...document, proposal: document.proposal ? { ...document.proposal, status: 'discarded' } : null }
    return Response.json(document)
  }))
  const { result } = renderHook(() => useCanvasDocument(sessionId, target))
  await waitFor(() => expect(result.current.document?.revision).toBe(0))
  let firstRequest = Promise.resolve()
  act(() => { firstRequest = result.current.mutate({ kind: 'propose', target, expectedRevision: 0, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Use lilies' }) })
  await act(async () => { await result.current.discardGenerating() })
  await act(async () => { await result.current.mutate({ kind: 'propose', target, expectedRevision: 0, selectionStart: 10, selectionEnd: 15, selectedText: 'Roses', instruction: 'Try a newer request' }) })
  expect(result.current.error).toBe('The newer revision request failed.')

  await act(async () => { pending.resolve(Response.json(document)); await firstRequest })

  expect(result.current.error).toBe('The newer revision request failed.')
  expect(result.current.document?.content).toBe('# Garden\n\nRoses bloom.')
})
