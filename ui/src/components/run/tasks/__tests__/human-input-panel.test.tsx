import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HumanInputPanel } from '@/components/run/tasks/human-input-panel'

const fetchMock = vi.fn<(...args: unknown[]) => unknown>()
// Typed `unknown` because vitest types its matchers as `any`.
const ANY_STRING: unknown = expect.any(String)

vi.mock('@/lib/clients/session-client', () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  getHumanInputInteraction: (...args: unknown[]) => fetchMock(...args),
  submitHumanInput: (...args: unknown[]) => fetchMock(...args),
}))

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() { return values.size },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  })
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function pendingSnapshot(revision = 4) {
  return {
    workflowRevision: revision,
    sourceText: 'Round one findings.',
    sourceTruncated: false,
    sourceByteLength: 20,
    interaction: {
      interactionId: 'interaction-1',
      sourceArtifact: { sha256: 'a'.repeat(64) },
      status: 'pending',
      eligibleRecipients: [
        { id: 'writer', mentionToken: 'writer', displayName: 'Writer' },
        { id: 'editor', mentionToken: 'editor', displayName: 'Editor' },
      ],
    },
  }
}

describe('HumanInputPanel', () => {
  it('keeps Continue workflow unavailable until feedback has text', async () => {
    fetchMock.mockResolvedValueOnce(pendingSnapshot())
    render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)

    await screen.findByText('Human input required')
    expect(screen.getByRole('button', { name: 'Continue workflow' })).toBeDisabled()
  })

  it('submits a literal @mention to its frozen recipient', async () => {
    fetchMock
      .mockResolvedValueOnce({
        workflowRevision: 4,
        sourceText: 'Round one findings.',
        sourceTruncated: false,
        sourceByteLength: 20,
        interaction: {
          interactionId: 'interaction-1',
          sourceArtifact: { sha256: 'a'.repeat(64) },
          status: 'pending',
          eligibleRecipients: [{ id: 'writer', mentionToken: 'writer', displayName: 'Writer' }],
        },
      })
      .mockResolvedValueOnce({})
    const onSubmitted = vi.fn()

    render(
      <HumanInputPanel
        sessionId="session-1"
        taskId="task-1"
        onSubmitted={onSubmitted}
      />,
    )

    await screen.findByText('Human input required')
    fireEvent.change(screen.getByLabelText('Feedback message 1'), {
      target: { value: '@writer Address the rollout risk.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue workflow' }))

    await waitFor(() => {
      // The panel mints both ids, so they only have to be strings.
      expect(fetchMock).toHaveBeenLastCalledWith('session-1', 'task-1', 'interaction-1', {
        submissionId: ANY_STRING,
        expectedWorkflowRevision: 4,
        expectedSourceArtifactSha256: 'a'.repeat(64),
        mode: 'feedback',
        messages: [{
          id: ANY_STRING,
          text: '@writer Address the rollout risk.',
          recipients: ['writer'],
        }],
      })
    })
    expect(onSubmitted).toHaveBeenCalledOnce()
    expect(
      await screen.findByText('Human feedback was submitted. The workflow will continue shortly.'),
    ).toBeVisible()
  })

  it('submits multiple feedback messages in display order with independent recipients', async () => {
    fetchMock.mockResolvedValueOnce(pendingSnapshot()).mockResolvedValueOnce({})
    render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)

    await screen.findByText('Human input required')
    fireEvent.change(screen.getByLabelText('Feedback message 1'), {
      target: { value: 'Writer feedback.' },
    })
    fireEvent.click(within(screen.getByLabelText('Feedback message 1 recipients')).getByRole('button', { name: '@writer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add feedback message' }))
    fireEvent.change(screen.getByLabelText('Feedback message 2'), {
      target: { value: 'Editor feedback.' },
    })
    fireEvent.click(within(screen.getByLabelText('Feedback message 2 recipients')).getByRole('button', { name: '@editor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue workflow' }))

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      'session-1',
      'task-1',
      'interaction-1',
      expect.objectContaining({
        messages: [
          expect.objectContaining({ text: 'Writer feedback.', recipients: ['writer'] }),
          expect.objectContaining({ text: 'Editor feedback.', recipients: ['editor'] }),
        ],
      }),
    ))
  })

  it('falls back to Everyone when the final direct recipient is deselected', async () => {
    fetchMock.mockResolvedValueOnce(pendingSnapshot()).mockResolvedValueOnce({})
    render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)

    await screen.findByText('Human input required')
    fireEvent.change(screen.getByLabelText('Feedback message 1'), {
      target: { value: 'Shared feedback.' },
    })
    const recipients = screen.getByLabelText('Feedback message 1 recipients')
    fireEvent.click(within(recipients).getByRole('button', { name: '@writer' }))
    fireEvent.click(within(recipients).getByRole('button', { name: '@writer' }))
    expect(within(recipients).getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Continue workflow' }))

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      'session-1',
      'task-1',
      'interaction-1',
      expect.objectContaining({
        messages: [expect.objectContaining({ recipients: 'all' })],
      }),
    ))
  })

  it('refreshes a stale interaction and preserves the draft for retry', async () => {
    fetchMock
      .mockResolvedValueOnce(pendingSnapshot(4))
      .mockRejectedValueOnce(new Error('Workflow revision changed'))
      .mockResolvedValueOnce(pendingSnapshot(5))
      .mockResolvedValueOnce({})
    render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)

    await screen.findByText('Human input required')
    fireEvent.change(screen.getByLabelText('Feedback message 1'), {
      target: { value: 'Keep this draft.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue workflow' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('refreshed')
    expect(screen.getByLabelText('Feedback message 1')).toHaveValue('Keep this draft.')
    fireEvent.click(screen.getByRole('button', { name: 'Continue workflow' }))

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      'session-1',
      'task-1',
      'interaction-1',
      expect.objectContaining({ expectedWorkflowRevision: 5 }),
    ))
  })

  it('restores an unsent feedback draft after the panel remounts', async () => {
    fetchMock.mockResolvedValue(pendingSnapshot())
    const first = render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)
    await screen.findByText('Human input required')
    fireEvent.change(screen.getByLabelText('Feedback message 1'), {
      target: { value: 'Persisted locally.' },
    })
    await waitFor(() => expect(window.localStorage.length).toBe(1))
    first.unmount()

    render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)
    expect(await screen.findByLabelText('Feedback message 1')).toHaveValue('Persisted locally.')
  })

  it('inserts a recipient mention with the keyboard', async () => {
    fetchMock.mockResolvedValueOnce(pendingSnapshot())
    render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)
    const feedback = await screen.findByLabelText('Feedback message 1')

    fireEvent.change(feedback, { target: { value: '@ed' } })
    fireEvent.keyDown(feedback, { key: 'ArrowDown' })
    fireEvent.keyDown(feedback, { key: 'Enter' })

    expect(feedback).toHaveValue('@editor ')
  })

  it('inserts a recipient mention with the pointer', async () => {
    fetchMock.mockResolvedValueOnce(pendingSnapshot())
    render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)
    const feedback = await screen.findByLabelText('Feedback message 1')

    fireEvent.change(feedback, { target: { value: '@wr' } })
    fireEvent.click(screen.getByRole('option', { name: '@writer · Writer' }))

    expect(feedback).toHaveValue('@writer ')
  })

  it('clears a prior mention error when the draft is corrected', async () => {
    fetchMock.mockResolvedValueOnce(pendingSnapshot())
    render(<HumanInputPanel sessionId="session-1" taskId="task-1" />)
    const feedback = await screen.findByLabelText('Feedback message 1')

    fireEvent.change(feedback, { target: { value: '@unknown Review this.' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown recipient @unknown')
    fireEvent.change(feedback, { target: { value: '@writer Review this.' } })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
