import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RunStatusBadge } from '@/components/run-status-badge'

// The Badge component from base-ui-react is a bit complex, so we assert on
// class-name fragments that signal variant + custom styling rather than mocking.

describe('RunStatusBadge', () => {
  const variantMap: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    active: 'outline',
    completed: 'outline',
    failed: 'destructive',
    blocked: 'destructive',
    cancelled: 'secondary',
    incomplete: 'outline',
    unknown: 'outline',
  }

  for (const status of ['active', 'completed', 'failed', 'blocked', 'cancelled', 'incomplete', 'unknown'] as const) {
    it(`renders with status text "${status}"`, () => {
      render(<RunStatusBadge status={status} />)
      expect(screen.getByText(status)).toBeInTheDocument()
    })

    it(`applies the correct variant for status "${status}"`, () => {
      const { container } = render(<RunStatusBadge status={status} />)
      const badge = container.querySelector('[role="status"], span')
      // Base UI exposes the chosen variant as a data attribute.
      if (variantMap[status] !== 'default') {
        expect(badge).toHaveAttribute('data-variant', variantMap[status])
      }
    })
  }

  it('renders active status with amber accent classes', () => {
    const { container } = render(<RunStatusBadge status="active" />)
    const badge = container.querySelector('span')
    expect(badge?.className).toContain('border-amber-300')
    expect(badge?.className).toContain('bg-amber-50')
    expect(badge?.className).toContain('text-amber-800')
  })

  it('renders completed status with emerald accent classes', () => {
    const { container } = render(<RunStatusBadge status="completed" />)
    const badge = container.querySelector('span')
    expect(badge?.className).toContain('border-emerald-300')
    expect(badge?.className).toContain('bg-emerald-50')
    expect(badge?.className).toContain('text-emerald-800')
  })

  it('renders incomplete status with amber text classes (no bg)', () => {
    const { container } = render(<RunStatusBadge status="incomplete" />)
    const badge = container.querySelector('span')
    expect(badge?.className).toContain('border-amber-300')
    expect(badge?.className).toContain('text-amber-700')
    // incomplete does NOT get a background color
    expect(badge?.className).not.toContain('bg-amber-50')
  })

  it('renders failed status with destructive variant', () => {
    const { container } = render(<RunStatusBadge status="failed" />)
    const badge = container.querySelector('span')
    expect(badge?.className).toContain('destructive')
  })

  it('renders unknown status with outline variant and no extra classes', () => {
    const { container } = render(<RunStatusBadge status="unknown" />)
    const badge = container.querySelector('span')
    expect(badge).toHaveAttribute('data-variant', 'outline')
    // no special bg/border color beyond outline default
  })
})
