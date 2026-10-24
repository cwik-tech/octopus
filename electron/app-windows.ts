import { APP_WINDOW_DEFAULT_SIZE, NEW_WINDOW_CASCADE_OFFSET } from './app-window-constants.js'
import type { Rectangle } from 'electron'
import { isValidSessionId } from '../contracts/sessions.js'

export type OpenWindowRequest = { readonly kind: 'new-chat' } | { readonly kind: 'session' | 'canvas'; readonly sessionId: string }
export interface WindowEntryView { readonly id: number; readonly sessionId: string | null; readonly focusOrder: number }
type Target = { readonly action: 'focus'; readonly windowId: number } | { readonly action: 'create' }

export function parseOpenWindowRequest(value: unknown): OpenWindowRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('kind' in value)) return null
  const keys = Object.keys(value)
  if (value.kind === 'new-chat' && keys.length === 1) return { kind: 'new-chat' }
  if ((value.kind === 'session' || value.kind === 'canvas') && keys.length === 2 && 'sessionId' in value &&
      typeof value.sessionId === 'string' && isValidSessionId(value.sessionId)) return { kind: value.kind, sessionId: value.sessionId }
  return null
}
export function isTrustedSender(input: { senderDestroyed: boolean; senderIsRegistered: boolean; frameIsSenderMainFrame: boolean }): boolean {
  return !input.senderDestroyed && input.senderIsRegistered && input.frameIsSenderMainFrame
}
export function decideActivateTarget(entries: readonly WindowEntryView[]): Target {
  const latest = entries.reduce<WindowEntryView | undefined>((previous, entry) =>
    previous === undefined || entry.focusOrder > previous.focusOrder ? entry : previous, undefined)
  return latest ? { action: 'focus', windowId: latest.id } : { action: 'create' }
}
export function decideShowTarget(sessionId: string, entries: readonly WindowEntryView[], excludedWindowIds: readonly number[] = []): Target {
  const eligible = entries.filter((entry) => !excludedWindowIds.includes(entry.id))
  const matching = eligible.filter((entry) => entry.sessionId === sessionId)
  return decideActivateTarget(matching.length > 0 ? matching : eligible)
}
export function relayTargets(entries: readonly { id: number; destroyed: boolean }[], senderId: number): readonly number[] {
  return entries.filter((entry) => !entry.destroyed && entry.id !== senderId).map((entry) => entry.id)
}
export function cascadeBounds(source: Rectangle | null, workArea: Rectangle): Rectangle {
  const width = Math.min(source?.width ?? APP_WINDOW_DEFAULT_SIZE.width, workArea.width)
  const height = Math.min(source?.height ?? APP_WINDOW_DEFAULT_SIZE.height, workArea.height)
  return {
    x: Math.max(workArea.x, Math.min((source?.x ?? workArea.x) + NEW_WINDOW_CASCADE_OFFSET, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min((source?.y ?? workArea.y) + NEW_WINDOW_CASCADE_OFFSET, workArea.y + workArea.height - height)),
    width, height,
  }
}
