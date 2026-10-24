import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCanvasWorkspace } from '../use-canvas-workspace'

const a = 'ad605beb-dadc-403a-bca4-b05df6e00001'
const b = 'ad605beb-dadc-403a-bca4-b05df6e00002'
const targetA = { runId: 'run-a', artifactPath: 'files/pending.md' }
const targetB = { runId: 'run-b', artifactPath: 'files/other.md' }
function state(revision: number, target: typeof targetA) {
  return { schemaVersion: 1, revision, tabs: [target], activeKey: JSON.stringify([target.runId, target.artifactPath]) }
}
function View({ sessionId }: { sessionId: string }) {
  const canvas = useCanvasWorkspace(sessionId)
  return <><button onClick={() => canvas.open(targetA)}>Open</button><output aria-label="Active document">{canvas.workspace.activeKey}</output></>
}
afterEach(() => vi.unstubAllGlobals())

it('an old chat action cannot overwrite the next chat after its response arrives', async () => {
  let finish: ((response: Response) => void) | undefined
  const pending = new Promise<Response>((resolve) => { finish = resolve })
  // No desktop API exists in jsdom. Control only HTTP responses; the hook and
  // component are real, paired with the real API/store Electron journeys.
  const boundary = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? pending : Response.json(state(1, targetB)))
  vi.stubGlobal('fetch', boundary)
  const view = render(<View sessionId={a} />)
  await waitFor(() => expect(screen.getByLabelText('Active document')).toHaveTextContent('run-b'))
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  await waitFor(() => expect(boundary).toHaveBeenCalledTimes(2))
  view.rerender(<View sessionId={b} />)
  await waitFor(() => expect(boundary).toHaveBeenCalledTimes(3))
  await act(async () => { finish?.(Response.json(state(100, targetA))); await pending })
  expect(screen.getByLabelText('Active document').textContent).toBe('["run-b","files/other.md"]')
})

it('a new chat accepts its lower revision instead of retaining the previous chat workspace', async () => {
  // Only the unavailable desktop HTTP boundary is substituted.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => Response.json(String(url).includes(a) ? state(100, targetA) : state(1, targetB))))
  const view = render(<View sessionId={a} />)
  await waitFor(() => expect(screen.getByLabelText('Active document')).toHaveTextContent('run-a'))
  view.rerender(<View sessionId={b} />)
  await waitFor(() => expect(screen.getByLabelText('Active document').textContent).toBe('["run-b","files/other.md"]'))
})
