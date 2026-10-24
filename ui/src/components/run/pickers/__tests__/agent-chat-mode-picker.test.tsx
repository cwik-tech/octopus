import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { AgentChatModePicker } from '../agent-chat-mode-picker'

describe('AgentChatModePicker', () => {
  it('defaults to Discussion and changes mode only when the user chooses it', async () => {
    const onModeChange = vi.fn()
    const { rerender } = render(
      <AgentChatModePicker selectedCount={2} onModeChange={onModeChange} />,
    )

    expect(screen.getByRole('tab', { name: 'Discussion mode' })).toHaveAttribute('aria-selected', 'true')
    expect(onModeChange).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('tab', { name: 'Talk to each other' }))
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith('dialogue')
    rerender(
      <AgentChatModePicker selectedCount={2} mode="dialogue" onModeChange={onModeChange} />,
    )
    expect(screen.getByRole('tab', { name: 'Talk to each other' })).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps Discussion available when more than five Agents are selected', async () => {
    const onModeChange = vi.fn()
    render(
      <AgentChatModePicker selectedCount={6} onModeChange={onModeChange} />,
    )

    expect(screen.getByRole('tab', { name: 'Discussion mode' })).toBeEnabled()
    const dialogue = screen.getByRole('tab', { name: 'Talk to each other' })
    // Base UI keeps disabled tabs focusable and uses aria-disabled.
    expect(dialogue).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(dialogue)
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('prevents changing modes while a dialogue owns the session', async () => {
    const onModeChange = vi.fn()
    render(
      <AgentChatModePicker selectedCount={2} mode="dialogue" locked onModeChange={onModeChange} />,
    )

    const discussion = screen.getByRole('tab', { name: 'Discussion mode' })
    expect(discussion).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(discussion)
    expect(onModeChange).not.toHaveBeenCalled()
  })
})
