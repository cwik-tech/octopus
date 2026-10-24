import { renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useVoiceSessionRefresh } from '../use-voice-session-refresh'

const SESSION_ID = '6f1c2a7e-1b2c-4d3e-8f90-1234567890ab'
function installPreload() {
  let listener: ((target: unknown) => void) | undefined
  let unsubscribed = false
  // Electron is unavailable in the component runner; replace only its preload event boundary.
  window.pipeline = {
    selectBatchFolder: async () => null,
    selectSharedFolder: async () => null,
    onVoiceSessionChanged: (next) => {
      listener = next
      return () => { listener = undefined; unsubscribed = true }
    }
  }
  return { emit: (target: unknown) => listener?.(target), unsubscribed: () => unsubscribed }
}
afterEach(() => { delete window.pipeline })

test('external work refreshes only the chat already shown', () => {
  const preload = installPreload()
  const refresh = vi.fn()
  renderHook(() => useVoiceSessionRefresh(SESSION_ID, refresh))
  preload.emit({ sessionId: SESSION_ID })
  expect(refresh).toHaveBeenCalledOnce()
})

test('another session or an invalid event leaves the current chat untouched', () => {
  const preload = installPreload()
  const refresh = vi.fn()
  renderHook(() => useVoiceSessionRefresh(SESSION_ID, refresh))
  preload.emit({ sessionId: '7a1c2a7e-1b2c-4d3e-8f90-1234567890ab' })
  preload.emit({ sessionId: '../settings' })
  preload.emit('not an object')
  expect(refresh).not.toHaveBeenCalled()
})

test('unmounting stops external refreshes', () => {
  const preload = installPreload()
  const refresh = vi.fn()
  const { unmount } = renderHook(() => useVoiceSessionRefresh(SESSION_ID, refresh))
  unmount()
  preload.emit({ sessionId: SESSION_ID })
  expect(preload.unsubscribed()).toBe(true)
  expect(refresh).not.toHaveBeenCalled()
})
