import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { MessageResponse } from '@/components/ai-elements/message'

interface StreamdownMockProps {
  children?: ReactNode
  className?: string
  mermaid?: {
    config?: {
      securityLevel?: string
      theme?: string
    }
  }
  plugins?: {
    mermaid?: {
      name?: string
    }
  }
}

const streamdownImport = vi.hoisted(() => {
  let resolve!: () => void
  const pending = new Promise<void>((resolvePending) => {
    resolve = resolvePending
  })

  return { pending, resolve }
})

vi.mock('streamdown', async () => {
  await streamdownImport.pending

  return {
    Streamdown: ({ children, className, mermaid, plugins }: StreamdownMockProps) => (
      <div
        className={className}
        data-has-mermaid-plugin={plugins?.mermaid?.name === 'mermaid' ? 'true' : 'false'}
        data-mermaid-security={mermaid?.config?.securityLevel ?? ''}
        data-mermaid-theme={mermaid?.config?.theme ?? ''}
        data-testid="streamdown"
      >
        {children}
      </div>
    ),
  }
})

describe('MessageResponse', () => {
  it('shows an accessible text fallback, then configures Mermaid after loading', async () => {
    render(
      <MessageResponse>
        {'```mermaid\nflowchart LR\n  A --> B\n```'}
      </MessageResponse>,
    )

    const fallback = screen.getByRole('status')
    expect(fallback).toHaveAttribute('aria-live', 'polite')
    expect(fallback).toHaveClass('whitespace-pre-wrap')
    expect(fallback).toHaveTextContent('flowchart LR')
    expect(fallback).toHaveTextContent('Formatting response')

    await act(async () => {
      streamdownImport.resolve()
      await streamdownImport.pending
    })

    const streamdown = await screen.findByTestId('streamdown')
    expect(streamdown).toHaveAttribute('data-has-mermaid-plugin', 'true')
    expect(streamdown).toHaveAttribute('data-mermaid-security', 'strict')
    expect(streamdown).toHaveAttribute('data-mermaid-theme', 'neutral')
    expect(streamdown).toHaveTextContent('flowchart LR')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
