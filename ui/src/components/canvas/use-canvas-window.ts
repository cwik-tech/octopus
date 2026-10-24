import { useCallback, useEffect, useState } from 'react'
import { canvasWindowStateSchema, type CanvasWindowState } from '@contracts/canvas-workspace'

export function useCanvasWindow(sessionId: string | null) {
  const [state, setState] = useState<CanvasWindowState>({ sessionId: sessionId ?? '', detached: false, epoch: 0 })
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!sessionId) return
    let disposed = false
    const accept = (raw: unknown) => {
      const parsed = canvasWindowStateSchema.safeParse(raw)
      if (disposed || !parsed.success || parsed.data.sessionId !== sessionId) return
      const next = parsed.data
      setState((previous) => next.epoch >= previous.epoch ? next : previous)
    }
    // Subscribe first. A close notification may race the initial query reply.
    const unsubscribe = window.pipeline?.onCanvasWindowState?.(accept)
    const query = window.pipeline?.getCanvasWindowState?.(sessionId)
    if (query) void query.then(accept).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : 'Canvas window state is unavailable')
    })
    return () => { disposed = true; unsubscribe?.() }
  }, [sessionId])
  const detach = useCallback(() => {
    const open = window.pipeline?.openWindow
    if (!open || opening || !sessionId) return
    setOpening(true)
    setError(null)
    void open({ kind: 'canvas', sessionId }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Could not open Canvas window')
    }).finally(() => setOpening(false))
  }, [opening, sessionId])
  return { detached: state.detached, opening, error, detach, canDetach: typeof window.pipeline?.openWindow === 'function' }
}
