import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useTheme } from '../use-theme'

function changeStoredTheme(value: string | null) {
  if (value === null) localStorage.removeItem('pipeline-theme')
  else localStorage.setItem('pipeline-theme', value)
  window.dispatchEvent(new StorageEvent('storage', {
    key: 'pipeline-theme', newValue: value, storageArea: localStorage,
  }))
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  delete document.documentElement.dataset.theme
})

describe('shared application theme', () => {
  it('uses the saved light theme when a window opens', () => {
    localStorage.setItem('pipeline-theme', 'light')
    const { result } = renderHook(useTheme)

    expect(result.current[0]).toBe('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('updates an open window when another window selects light or dark mode', () => {
    localStorage.setItem('pipeline-theme', 'dark')
    const { result } = renderHook(useTheme)
    expect(document.documentElement).toHaveClass('dark')

    act(() => changeStoredTheme('light'))

    expect(result.current[0]).toBe('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).not.toHaveClass('dark')

    act(() => changeStoredTheme('dark'))

    expect(result.current[0]).toBe('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveClass('dark')
  })

  it('persists a local theme selection for the next window', () => {
    const { result, unmount } = renderHook(useTheme)

    act(() => result.current[1]('dark'))
    expect(localStorage.getItem('pipeline-theme')).toBe('dark')
    unmount()
    const reopened = renderHook(useTheme)

    expect(reopened.result.current[0]).toBe('dark')
    expect(document.documentElement).toHaveClass('dark')
  })

  it('ignores changes to unrelated preferences and session storage', () => {
    const { result } = renderHook(useTheme)

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'other-preference', newValue: 'dark', storageArea: localStorage,
      }))
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pipeline-theme', newValue: 'dark', storageArea: sessionStorage,
      }))
    })

    expect(result.current[0]).toBe('light')
    expect(document.documentElement).not.toHaveClass('dark')
  })
})
