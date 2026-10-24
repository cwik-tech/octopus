import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OfficeDocument } from '@contracts/office-documents'
import { OFFICE_PROFILE, officePreviewRequestSchema } from '@contracts/office-documents'
import { CanvasWordSnapshot } from '../canvas-word-snapshot'

const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00001'
const target = { runId: 'source-run', artifactPath: 'files/report.md' }
function makeSnapshot() {
  const document: OfficeDocument = {
    schemaVersion: 1, id: 'a'.repeat(64), sessionId, origin: target,
    originalDigest: 'b'.repeat(64), format: 'docx', revision: 0,
    revisions: [{ revision: 0, digest: 'b'.repeat(64) }],
    highestRequestSequence: 0, proposal: null, receipts: [],
    source: { target, revision: 2, digest: 'c'.repeat(64), assets: [], profile: 'business-report', mermaid: 'keep-code', notices: [], forked: false },
  }
  return { document, stale: false }
}
function pendingResponse() {
  let resolve: (response: Response) => void = () => { throw new Error('Response not arranged') }
  const promise = new Promise<Response>((complete) => { resolve = complete })
  return { promise, resolve }
}
afterEach(() => vi.unstubAllGlobals())

it('previews the saved Word snapshot rather than sending its Markdown origin for Office conversion', async () => {
  const desktop: NonNullable<Window['pipeline']> = { openWindow: async () => {}, selectBatchFolder: async () => null, selectSharedFolder: async () => null }
  vi.stubGlobal('pipeline', desktop)
  // Replace HTTP only: the API accepts an owned binary revision, not .md bytes.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).endsWith('/preview')) return Response.json(makeSnapshot())
    const request = officePreviewRequestSchema.parse(JSON.parse(String(init?.body)))
    return 'documentId' in request && 'revision' in request && request.documentId === 'a'.repeat(64) && request.revision === 0
      ? Response.json({ html: '<h1>Saved Word</h1>', digest: 'b'.repeat(64), profile: OFFICE_PROFILE, notices: [] })
      : Response.json({ error: 'Markdown is not an Office package' }, { status: 415 })
  }))
  render(<CanvasWordSnapshot sessionId={sessionId} target={target} revision={2} disabled={false} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Preview Word snapshot' }))
  expect(await screen.findByTitle('HTML preview')).toBeVisible()
  expect(screen.queryByRole('tab', { name: 'Source' })).not.toBeInTheDocument()
})

it('keeps a newly generated snapshot when an older state lookup finishes later', async () => {
  const oldLookup = pendingResponse()
  // jsdom lacks the desktop API; replace only HTTP. Real generation and
  // persistence are exercised by canvas-word-snapshot.test.ts and Electron.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => String(input).endsWith('/state')
    ? oldLookup.promise : Response.json(makeSnapshot())))
  render(<CanvasWordSnapshot sessionId={sessionId} target={target} revision={2} disabled={false} />)

  fireEvent.click(screen.getByRole('button', { name: 'Generate Word snapshot' }))
  await screen.findByText('Word snapshot uses saved Markdown revision 2.')
  await act(async () => { oldLookup.resolve(Response.json(null)) })

  expect(screen.getByRole('button', { name: 'Download Word snapshot' })).toBeVisible()
})

it('reports a snapshot generated during a later Markdown save as out of date', async () => {
  const generation = pendingResponse()
  // Only HTTP is replaced because the desktop API is unavailable in jsdom.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => String(input).endsWith('/state')
    ? Response.json(null) : generation.promise))
  const view = render(<CanvasWordSnapshot sessionId={sessionId} target={target} revision={2} disabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Generate Word snapshot' }))
  view.rerender(<CanvasWordSnapshot sessionId={sessionId} target={target} revision={3} disabled={false} />)

  await act(async () => { generation.resolve(Response.json(makeSnapshot())) })

  expect(screen.getByText('Word snapshot is out of date.')).toBeVisible()
})

it('keeps a generated snapshot when a lookup triggered by a concurrent save returns later', async () => {
  const generation = pendingResponse()
  const laterLookup = pendingResponse()
  let lookups = 0
  // Only the unavailable desktop HTTP boundary is replaced.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => String(input).endsWith('/state')
    ? ++lookups === 1 ? Response.json(null) : laterLookup.promise : generation.promise))
  const view = render(<CanvasWordSnapshot sessionId={sessionId} target={target} revision={2} disabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Generate Word snapshot' }))
  view.rerender(<CanvasWordSnapshot sessionId={sessionId} target={target} revision={3} disabled={false} />)
  await act(async () => { generation.resolve(Response.json(makeSnapshot())) })

  await act(async () => { laterLookup.resolve(Response.json(null)) })

  expect(screen.getByText('Word snapshot is out of date.')).toBeVisible()
})
