import { renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { useVoiceNavigation } from '../use-voice-navigation'

/**
 * The Electron preload is the boundary: it hands the renderer whatever the main
 * process sent. These tests stand in for it on `window.pipeline`.
 */
function installPreload(): { emit(target: unknown): void; unsubscribed: () => boolean } {
  let listener: ((target: unknown) => void) | undefined
  let unsubscribed = false
  window.pipeline = {
    selectBatchFolder: vi.fn(async () => null),
    selectSharedFolder: vi.fn(async () => null),
    onVoiceNavigate: (next) => {
      listener = next
      return () => {
        unsubscribed = true
        listener = undefined
      }
    },
  }
  return {
    emit: (target) => listener?.(target),
    unsubscribed: () => unsubscribed,
  }
}

afterEach(() => {
  delete window.pipeline
})

const SESSION_ID = '6f1c2a7e-1b2c-4d3e-8f90-1234567890ab'

test('a voice request to show a session opens that session', () => {
  const preload = installPreload()
  const openSession = vi.fn()
  renderHook(() => useVoiceNavigation(openSession))

  preload.emit({ sessionId: SESSION_ID, taskId: '7a1c2a7e-1b2c-4d3e-8f90-1234567890ab' })

  expect(openSession).toHaveBeenCalledWith(SESSION_ID)
})

test('a request that does not name a session by ID opens nothing', () => {
  const preload = installPreload()
  const openSession = vi.fn()
  renderHook(() => useVoiceNavigation(openSession))

  preload.emit({ sessionId: '../settings' })
  preload.emit('not an object')
  preload.emit({})

  expect(openSession).not.toHaveBeenCalled()
})

test('the subscription ends when the app unmounts', () => {
  const preload = installPreload()
  const { unmount } = renderHook(() => useVoiceNavigation(vi.fn()))

  unmount()

  expect(preload.unsubscribed()).toBe(true)
})
