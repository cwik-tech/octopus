import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@contracts/sessions'
import { canvasActionSchema, type CanvasWorkspace } from '@contracts/canvas-workspace'
import { CanvasSession } from '../canvas-session'
import { useCanvas } from '../canvas-context'
import { useCanvasDeliveries } from '../use-canvas-deliveries'

const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00001'
function message(id: string, createdAt: string): ChatMessage {
  return { id, createdAt, role: 'assistant', text: 'Created a document', delivery: { taskId: id, artifacts: [{ runId: id, path: 'files/report.md', role: 'final' }] } }
}
function View({ messages }: { messages: ChatMessage[] }) {
  useCanvasDeliveries(sessionId, messages)
  const canvas = useCanvas()
  return <><output aria-label="Active document">{canvas?.workspace.activeKey}</output><output aria-label="Visibility">{canvas?.hidden ? 'Hidden' : 'Shown'}</output><button onClick={canvas?.hide}>Hide</button><button onClick={() => canvas?.act({ kind: 'close', key: canvas.workspace.activeKey ?? '' })}>Close</button></>
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('opens new deliveries, restores a hidden pane and respects closed tabs and historical deliveries', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-18T20:00:00Z'))
  let workspace: CanvasWorkspace = { schemaVersion: 1, revision: 0, tabs: [], activeKey: null }
  // jsdom has no desktop API: substitute only HTTP, paired with J3's real
  // Electron/API/filesystem journey. No internal modules are replaced.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const action = canvasActionSchema.parse(JSON.parse(init.body))
      if (action.kind === 'open') workspace = { schemaVersion: 1, revision: workspace.revision + 1, tabs: [...workspace.tabs, action.target], activeKey: JSON.stringify([action.target.runId, action.target.artifactPath]) }
      if (action.kind === 'close') workspace = { ...workspace, revision: workspace.revision + 1, tabs: [], activeKey: null }
    }
    return Response.json(workspace)
  }))
  const old = message('old', '2026-10-18T19:00:00Z')
  const fresh = message('new', '2026-10-18T20:00:01Z')
  const view = render(<CanvasSession sessionId={sessionId}><View messages={[old]} /></CanvasSession>)
  expect(screen.getByLabelText('Active document').textContent).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
  view.rerender(<CanvasSession sessionId={sessionId}><View messages={[old, fresh]} /></CanvasSession>)
  await waitFor(() => expect(screen.getByLabelText('Active document')).toHaveTextContent('["new","files/report.md"]'))
  expect(screen.getByLabelText('Visibility')).toHaveTextContent('Shown')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.getByLabelText('Active document').textContent).toBe(''))
  view.rerender(<CanvasSession sessionId={sessionId}><View messages={[{ ...old }, { ...fresh }]} /></CanvasSession>)
  expect(screen.getByLabelText('Active document').textContent).toBe('')
})


it('hides internal Office source tabs restored from history and opens only the new Office delivery', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-18T20:00:00Z'))
  const source = { runId: 'office', artifactPath: 'files/report.md' }
  let workspace: CanvasWorkspace = { schemaVersion: 1, revision: 1, tabs: [source], activeKey: JSON.stringify(['office', source.artifactPath]) }
  // Replace only HTTP, including persisted workspace reconciliation.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const action = canvasActionSchema.parse(JSON.parse(init.body))
      if (action.kind === 'open') workspace = { ...workspace, revision: workspace.revision + 1, tabs: [...workspace.tabs, action.target], activeKey: JSON.stringify([action.target.runId, action.target.artifactPath]) }
      if (action.kind === 'close') workspace = { ...workspace, revision: workspace.revision + 1, tabs: workspace.tabs.filter((tab) => JSON.stringify([tab.runId, tab.artifactPath]) !== action.key), activeKey: null }
    }
    return Response.json(workspace)
  }))
  const delivery: ChatMessage = { ...message('office', '2026-10-18T19:00:00Z'), delivery: { taskId: 'office', artifacts: [
    { runId: 'office', path: 'files/report.docx', role: 'final' },
    { runId: 'office', path: 'files/report.md', role: 'secondary', title: 'report.md - Markdown source' },
  ] } }
  const view = render(<CanvasSession sessionId={sessionId}><View messages={[delivery]} /></CanvasSession>)
  await waitFor(() => expect(workspace.tabs).toEqual([]))
  view.rerender(<CanvasSession sessionId={sessionId}><View messages={[{ ...delivery, createdAt: '2026-10-18T20:00:01Z' }]} /></CanvasSession>)
  await waitFor(() => expect(screen.getByLabelText('Active document')).toHaveTextContent('["office","files/report.docx"]'))
  expect(workspace.tabs).toEqual([{ runId: 'office', artifactPath: 'files/report.docx' }])
})


it('keeps portable ZIP downloads out of Canvas, including restored tabs', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-18T20:00:00Z'))
  const archive = { runId: 'manual', artifactPath: 'files/manual.zip' }
  let workspace: CanvasWorkspace = { schemaVersion: 1, revision: 1, tabs: [archive], activeKey: JSON.stringify(['manual', archive.artifactPath]) }
  // jsdom lacks the desktop API; replace only its HTTP workspace transport.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const action = canvasActionSchema.parse(JSON.parse(init.body))
      if (action.kind === 'open') workspace = { ...workspace, revision: workspace.revision + 1, tabs: [...workspace.tabs, action.target], activeKey: JSON.stringify([action.target.runId, action.target.artifactPath]) }
      if (action.kind === 'close') workspace = { ...workspace, revision: workspace.revision + 1, tabs: workspace.tabs.filter((tab) => JSON.stringify([tab.runId, tab.artifactPath]) !== action.key), activeKey: null }
    }
    return Response.json(workspace)
  }))
  const delivery: ChatMessage = { ...message('manual', '2026-10-18T19:00:00Z'), delivery: { taskId: 'manual', artifacts: [
    { runId: 'manual', path: 'files/manual.md', role: 'final' },
    { runId: 'manual', path: 'files/manual.zip', role: 'secondary', mediaType: 'application/zip' },
  ] } }
  const view = render(<CanvasSession sessionId={sessionId}><View messages={[delivery]} /></CanvasSession>)
  await waitFor(() => expect(workspace.tabs).toEqual([]))
  view.rerender(<CanvasSession sessionId={sessionId}><View messages={[{ ...delivery, createdAt: '2026-10-18T20:00:01Z' }]} /></CanvasSession>)
  await waitFor(() => expect(screen.getByLabelText('Active document')).toHaveTextContent('["manual","files/manual.md"]'))
  expect(workspace.tabs).toEqual([{ runId: 'manual', artifactPath: 'files/manual.md' }])
})
