import test from 'node:test'
import assert from 'node:assert/strict'
import { cascadeBounds, decideActivateTarget, decideShowTarget, isTrustedSender, parseOpenWindowRequest, relayTargets } from '../../electron/app-windows.js'
const id = 'ad605beb-dadc-403a-bca4-b05df6e00001'
test('window requests accept only the declared shapes and valid session IDs', () => {
  assert.deepEqual(parseOpenWindowRequest({ kind: 'new-chat' }), { kind: 'new-chat' })
  assert.deepEqual(parseOpenWindowRequest({ kind: 'session', sessionId: id }), { kind: 'session', sessionId: id })
  for (const value of [null, [], { kind: 'session', sessionId: '../' }, { kind: 'new-chat', extra: true }, { kind: 'bad' }]) assert.equal(parseOpenWindowRequest(value), null)
})
test('Canvas destinations accept only a valid saved-session shape', () => {
  assert.deepEqual(parseOpenWindowRequest({ kind: 'canvas', sessionId: id }), { kind: 'canvas', sessionId: id })
  assert.equal(parseOpenWindowRequest({ kind: 'canvas', sessionId: '../private' }), null)
  assert.equal(parseOpenWindowRequest({ kind: 'canvas', sessionId: id, sourceId: 1 }), null)
})
test('voice navigation chooses a chat view or creates one instead of targeting a Canvas-only window', () => {
  const chat = { id: 1, sessionId: null, focusOrder: 1 }
  const canvas = { id: 2, sessionId: null, focusOrder: 2 }
  assert.deepEqual(decideShowTarget(id, [chat, canvas], [canvas.id]), { action: 'focus', windowId: chat.id })
  assert.deepEqual(decideShowTarget(id, [canvas], [canvas.id]), { action: 'create' })
})
test('only live registered main frames can act on windows', () => {
  assert.equal(isTrustedSender({ senderDestroyed: false, senderIsRegistered: true, frameIsSenderMainFrame: true }), true)
  for (const input of [
    { senderDestroyed: true, senderIsRegistered: true, frameIsSenderMainFrame: true },
    { senderDestroyed: false, senderIsRegistered: false, frameIsSenderMainFrame: true },
    { senderDestroyed: false, senderIsRegistered: true, frameIsSenderMainFrame: false },
  ]) assert.equal(isTrustedSender(input), false)
})
test('voice show prefers a matching view and then recent focus; activate uses recent focus', () => {
  const entries = [{ id: 1, sessionId: id, focusOrder: 1 }, { id: 2, sessionId: null, focusOrder: 3 }, { id: 3, sessionId: id, focusOrder: 2 }]
  assert.deepEqual(decideShowTarget(id, entries), { action: 'focus', windowId: 3 })
  assert.deepEqual(decideShowTarget('other', entries), { action: 'focus', windowId: 2 })
  assert.deepEqual(decideShowTarget(id, []), { action: 'create' })
  assert.deepEqual(decideActivateTarget(entries), { action: 'focus', windowId: 2 })
  assert.deepEqual(decideActivateTarget([]), { action: 'create' })
})
test('session invalidations reach other live windows without echoing to the sender', () => {
  assert.deepEqual(relayTargets([{ id: 1, destroyed: false }, { id: 2, destroyed: false }, { id: 3, destroyed: true }], 1), [2])
})
test('a new window cascades and remains inside its source display work area', () => {
  assert.deepEqual(cascadeBounds({ x: 20, y: 30, width: 1200, height: 800 }, { x: 0, y: 0, width: 1800, height: 1200 }), { x: 52, y: 62, width: 1200, height: 800 })
  assert.deepEqual(cascadeBounds({ x: 2800, y: 800, width: 1440, height: 920 }, { x: 1920, y: 0, width: 1920, height: 1080 }), { x: 2400, y: 160, width: 1440, height: 920 })
  assert.deepEqual(cascadeBounds(null, { x: 0, y: 0, width: 900, height: 600 }), { x: 0, y: 0, width: 900, height: 600 })
})

test('a failed or timed-out window load destroys only its destination', async () => {
  const { openAppWindow } = await import('../../electron/open-app-window.js')
  let destroyed = false
  let timer: (() => void) | undefined
  let closed: (() => void) | undefined
  // Electron cannot run in node:test; inject only its native-window boundary.
  const destination = {
    destroy: () => { destroyed = true; closed?.() }, isDestroyed: () => destroyed,
    once: (_event: 'closed', listener: () => void) => { closed = listener },
    removeListener: (_event: 'closed', listener: () => void) => { if (closed === listener) closed = undefined },
  }
  const opening = openAppWindow({ create: () => destination, load: async () => new Promise<void>(() => {}),
    timeoutMs: 20_000, setTimer: (callback) => { timer = callback; return () => { timer = undefined } } })
  assert.ok(timer)
  timer()
  await assert.rejects(opening, /timed out/)
  assert.equal(destroyed, true)
  assert.equal(timer, undefined)
})

test('a successful window load clears its deadline without destroying it', async () => {
  const { openAppWindow } = await import('../../electron/open-app-window.js')
  let cancelled = false
  let destroyed = false
  const window = { destroy: () => { destroyed = true }, isDestroyed: () => destroyed,
    once: () => {}, removeListener: () => {} }
  await openAppWindow({ create: () => window, load: async () => {}, timeoutMs: 20_000,
    setTimer: () => () => { cancelled = true } })
  assert.equal(cancelled, true)
  assert.equal(destroyed, false)
})

test('a synchronous native load failure destroys the new window and clears its deadline', async () => {
  const { openAppWindow } = await import('../../electron/open-app-window.js')
  let destroyed = false
  let cancelled = false
  const window = { destroy: () => { destroyed = true }, isDestroyed: () => destroyed,
    once: () => {}, removeListener: () => {} }
  await assert.rejects(openAppWindow({ create: () => window, load: () => { throw new Error('Native load failed') }, timeoutMs: 20_000,
    setTimer: () => () => { cancelled = true } }), /load/)
  assert.equal(destroyed, true)
  assert.equal(cancelled, true)
})

test('overlapping opens finish independently when the second renderer loads first', async () => {
  const { openAppWindow } = await import('../../electron/open-app-window.js')
  let finishFirst = () => {}
  let finishSecond = () => {}
  let firstFinished = false
  const firstLoad = new Promise<void>((resolve) => { finishFirst = resolve })
  const secondLoad = new Promise<void>((resolve) => { finishSecond = resolve })
  const makeWindow = () => ({ destroy: () => {}, isDestroyed: () => false, once: () => {}, removeListener: () => {} })
  const first = openAppWindow({ create: makeWindow, load: () => firstLoad, timeoutMs: 20_000, setTimer: () => () => {} }).then(() => { firstFinished = true })
  const second = openAppWindow({ create: makeWindow, load: () => secondLoad, timeoutMs: 20_000, setTimer: () => () => {} })
  finishSecond()
  await second
  assert.equal(firstFinished, false)
  finishFirst()
  await first
  assert.equal(firstFinished, true)
})

test('closing a destination during load rejects its request without waiting for the load promise', async () => {
  const { EventEmitter } = await import('node:events')
  const { openAppWindow } = await import('../../electron/open-app-window.js')
  class WindowPort extends EventEmitter {
    closed = false
    isDestroyed() { return this.closed }
    destroy() { this.closed = true; this.emit('closed') }
  }
  const window = new WindowPort()
  const opened = openAppWindow({ create: () => window, load: async () => new Promise<void>(() => {}), timeoutMs: 20_000, setTimer: () => () => {} })
  window.destroy()
  await assert.rejects(opened, /closed before loading/)
})
