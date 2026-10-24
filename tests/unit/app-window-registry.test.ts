import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AppWindowRegistry } from '../../electron/app-window-registry.js'

// Native windows are unavailable in node:test. Real event emitters model only
// that external boundary; registry decisions and identity checks remain real.
class WindowPort extends EventEmitter {
  readonly webContents = { mainFrame: {}, isDestroyed: () => this.closed }
  closed = false
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.closed }
  close(): void { this.closed = true; this.emit('closed') }
}
test('reports change only their sender and closing a window preserves other registered windows', () => {
  const registry = new AppWindowRegistry<WindowPort>()
  const first = new WindowPort(1)
  const second = new WindowPort(2)
  registry.add(first)
  registry.add(second)
  registry.setSessionHint(first.webContents, 'first-session')
  assert.equal(registry.entries().find((entry) => entry.id === 1)?.sessionId, 'first-session')
  assert.equal(registry.entries().find((entry) => entry.id === 2)?.sessionId, null)
  first.emit('focus')
  assert.equal(registry.latest(), first)
  assert.equal(registry.trustedWindowFor(first.webContents, first.webContents.mainFrame), first)
  assert.equal(registry.trustedWindowFor(second.webContents, second.webContents.mainFrame), second)
  assert.equal(registry.trustedWindowFor(first.webContents, {}), null)
  const foreign = new WindowPort(3)
  assert.equal(registry.trustedWindowFor(foreign.webContents, foreign.webContents.mainFrame), null)
  first.close()
  assert.equal(registry.windowById(1), null)
  assert.equal(registry.latest(), second)
  assert.equal(registry.trustedWindowFor(first.webContents, first.webContents.mainFrame), null)
})
