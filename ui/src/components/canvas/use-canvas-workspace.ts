import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CANVAS_CHANGE_CHANNEL_PREFIX, type CanvasAction, type CanvasTab, type CanvasWorkspace } from '@contracts/canvas-workspace'
import { fetchCanvasWorkspace, canvasWorkspaceUrl } from '@/lib/clients/canvas-client'

const empty: CanvasWorkspace = { schemaVersion: 1, revision: 0, tabs: [], activeKey: null }
interface SessionScope {
  sessionId: string | null
}
interface SessionTransport {
  scope: SessionScope
  pending: Promise<void>
  channel: BroadcastChannel | null
  disposed: boolean
}
interface ViewState {
  scope: SessionScope
  workspace: CanvasWorkspace
  error: string | null
  hidden: boolean
  expanded: boolean
  requested: boolean
}
function initialState(scope: SessionScope): ViewState {
  return { scope, workspace: empty, error: null, hidden: false, expanded: false, requested: false }
}

export function useCanvasWorkspace(sessionId: string | null) {
  const scope = useMemo<SessionScope>(() => ({ sessionId }), [sessionId])
  const transport = useRef<SessionTransport | null>(null)
  const [state, setState] = useState(() => initialState(scope))
  // Reset this hook's state, keeping the composer/provider subtree mounted.
  if (state.scope !== scope) setState(initialState(scope))
  const current = state.scope === scope ? state : initialState(scope)
  const update = useCallback((change: (value: ViewState) => ViewState) => {
    setState((value) => value.scope === scope ? change(value) : value)
  }, [scope])
  const accept = useCallback((next: CanvasWorkspace) => {
    update((value) => ({ ...value, workspace: next.revision >= value.workspace.revision ? next : value.workspace, error: null }))
  }, [update])
  const refuse = useCallback((cause: unknown) => {
    update((value) => ({ ...value, error: cause instanceof Error ? cause.message : 'Canvas request failed' }))
  }, [update])
  useEffect(() => {
    if (!sessionId) return
    const connection: SessionTransport = { scope, pending: Promise.resolve(), channel: null, disposed: false }
    transport.current = connection
    const controller = new AbortController()
    const refresh = () => {
      void fetchCanvasWorkspace(sessionId, controller.signal).then((next) => {
        if (!controller.signal.aborted) accept(next)
      }).catch((cause: unknown) => { if (!controller.signal.aborted) refuse(cause) })
    }
    const changes = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`${CANVAS_CHANGE_CHANNEL_PREFIX}${canvasWorkspaceUrl(sessionId)}`)
    connection.channel = changes
    // Messages are invalidation hints only; payloads never become saved state.
    if (changes) changes.onmessage = refresh
    window.addEventListener('focus', refresh)
    refresh()
    return () => { connection.disposed = true; controller.abort(); changes?.close(); connection.channel = null; window.removeEventListener('focus', refresh) }
  }, [accept, refuse, scope, sessionId])
  const act = useCallback((action: CanvasAction) => {
    const connection = transport.current
    if (!sessionId || !connection || connection.scope !== scope) return
    // Complete an admitted action for its original chat, but never deliver its
    // state, errors or notices into a later session generation.
    connection.pending = connection.pending.then(async () => {
      try {
        const next = await fetchCanvasWorkspace(sessionId, new AbortController().signal, action)
        if (!connection.disposed) { accept(next); connection.channel?.postMessage(null) }
      } catch (cause) { if (!connection.disposed) refuse(cause) }
    })
  }, [accept, refuse, scope, sessionId])
  const open = useCallback((target: CanvasTab) => { update((value) => ({ ...value, requested: true, hidden: false })); act({ kind: 'open', target }) }, [act, update])
  return { sessionId: sessionId ?? '', workspace: current.workspace, error: current.error, hidden: current.hidden, expanded: current.expanded, requested: current.requested, act, open, show: () => update((value) => ({ ...value, requested: true, hidden: false })), hide: () => update((value) => ({ ...value, hidden: true })), dock: () => update((value) => ({ ...value, expanded: false })), toggleExpanded: () => update((value) => ({ ...value, expanded: !value.expanded })) }
}
