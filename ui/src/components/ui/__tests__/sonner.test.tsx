import { act, render, screen } from '@testing-library/react'
import { ThemeProvider } from 'next-themes'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Toaster } from '@/components/ui/sonner'

describe('Toaster', () => {
  beforeEach(() => {
    // jsdom does not implement matchMedia, and both next-themes and Sonner
    // call it to resolve the system theme. This answers "not dark" so the
    // system theme resolves to light.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows the system theme when the app theme is one Sonner does not know', async () => {
    render(
      <ThemeProvider attribute="class" themes={['light', 'dark', 'sepia']} defaultTheme="sepia">
        <Toaster />
      </ThemeProvider>,
    )

    act(() => {
      toast('Saved')
    })
    await screen.findByText('Saved')

    const toaster = document.querySelector('[data-sonner-toaster]')
    expect(toaster?.getAttribute('data-sonner-theme')).toBe('light')
  })
})
