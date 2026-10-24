import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useCanvasWindow } from '../use-canvas-window'

const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00001'
const original = window.pipeline
afterEach(() => { Object.defineProperty(window, 'pipeline', { configurable: true, writable: true, value: original }) })
function View() {
  const state = useCanvasWindow(sessionId)
  return <div>{state.detached ? 'Detached' : 'Docked'}</div>
}

it('a native close notification wins over an older initial detached-state query', async () => {
  let finishQuery: ((value: unknown) => void) | undefined
  const query = new Promise<unknown>((resolve) => { finishQuery = resolve })
  let nativeEvent: ((value: unknown) => void) | undefined
  // Electron is unavailable in jsdom; replace only the external preload bridge.
  window.pipeline = {
    selectBatchFolder: async () => null,
    selectSharedFolder: async () => null,
    getCanvasWindowState: () => query,
    onCanvasWindowState: (listener) => { nativeEvent = listener; return () => { nativeEvent = undefined } },
  }
  render(<View />)
  act(() => nativeEvent?.({ sessionId, detached: true, epoch: 2 }))
  expect(screen.getByText('Detached')).toBeInTheDocument()
  act(() => nativeEvent?.({ sessionId, detached: false, epoch: 3 }))
  expect(screen.getByText('Docked')).toBeInTheDocument()
  await act(async () => { finishQuery?.({ sessionId, detached: true, epoch: 1 }); await query })
  expect(screen.getByText('Docked')).toBeInTheDocument()
  act(() => nativeEvent?.({ sessionId: 'other-session', detached: true, epoch: 4 }))
  expect(screen.getByText('Docked')).toBeInTheDocument()
})
