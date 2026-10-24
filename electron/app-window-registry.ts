import { decideActivateTarget, isTrustedSender, type WindowEntryView } from './app-windows.js'

interface Sender { readonly mainFrame?: unknown; isDestroyed(): boolean }
interface RegistryWindow {
  readonly id: number
  readonly webContents: Sender
  isDestroyed(): boolean
  on(event: 'focus' | 'closed', listener: () => void): unknown
}
/** Session IDs are routing hints only; every app window may view any saved chat. */
export class AppWindowRegistry<W extends RegistryWindow> {
  private readonly windows = new Map<number, { window: W; sessionId: string | null; focusOrder: number }>()
  private focusOrder = 0
  add(window: W): void {
    this.windows.set(window.id, { window, sessionId: null, focusOrder: ++this.focusOrder })
    window.on('focus', () => {
      const entry = this.windows.get(window.id)
      if (entry) entry.focusOrder = ++this.focusOrder
    })
    window.on('closed', () => { this.windows.delete(window.id) })
  }
  entries(): readonly WindowEntryView[] {
    return [...this.windows.values()].filter(({ window }) => !window.isDestroyed()).map(({ window, sessionId, focusOrder }) => ({ id: window.id, sessionId, focusOrder }))
  }
  windowById(id: number): W | null {
    const window = this.windows.get(id)?.window
    return window && !window.isDestroyed() ? window : null
  }
  latest(): W | null {
    const target = decideActivateTarget(this.entries())
    return target.action === 'focus' ? this.windowById(target.windowId) : null
  }
  setSessionHint(sender: Sender, sessionId: string | null): void {
    const entry = [...this.windows.values()].find(({ window }) => window.webContents === sender && !window.isDestroyed())
    if (entry) entry.sessionId = sessionId
  }
  trustedWindowFor(sender: Sender, senderFrame: unknown): W | null {
    const entry = [...this.windows.values()].find(({ window }) => window.webContents === sender && !window.isDestroyed())
    return isTrustedSender({ senderDestroyed: sender.isDestroyed(), senderIsRegistered: entry !== undefined,
      frameIsSenderMainFrame: senderFrame !== undefined && senderFrame === sender.mainFrame }) ? entry?.window ?? null : null
  }
}
