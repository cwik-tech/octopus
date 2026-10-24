import { CANVAS_MAX_TABS, canvasTabKey, type CanvasAction, type CanvasWorkspace } from '../contracts/canvas-workspace.js'

export function emptyCanvasWorkspace(): CanvasWorkspace {
  return { schemaVersion: 1, revision: 0, tabs: [], activeKey: null }
}

/** MUST preserve unique tab identity and a valid active selection. */
export type CanvasActionResult = { ok: true; workspace: CanvasWorkspace } | { ok: false; reason: 'tab_limit' }

export function applyCanvasAction(state: CanvasWorkspace, action: CanvasAction): CanvasActionResult {
  if (action.kind === 'open') {
    const key = canvasTabKey(action.target)
    const exists = state.tabs.some((tab) => canvasTabKey(tab) === key)
    if (!exists && state.tabs.length >= CANVAS_MAX_TABS) return { ok: false, reason: 'tab_limit' }
    if (exists && state.activeKey === key) return { ok: true, workspace: state }
    return { ok: true, workspace: { ...state, revision: state.revision + 1, tabs: exists ? state.tabs : [...state.tabs, action.target], activeKey: key } }
  }
  const index = state.tabs.findIndex((tab) => canvasTabKey(tab) === action.key)
  if (index < 0) return { ok: true, workspace: state }
  if (action.kind === 'select') {
    return { ok: true, workspace: state.activeKey === action.key ? state : { ...state, revision: state.revision + 1, activeKey: action.key } }
  }
  const tabs = state.tabs.filter((tab) => canvasTabKey(tab) !== action.key)
  const neighbor = tabs[index] ?? tabs[index - 1]
  return { ok: true, workspace: { ...state, revision: state.revision + 1, tabs, activeKey: state.activeKey === action.key ? (neighbor ? canvasTabKey(neighbor) : null) : state.activeKey } }
}
