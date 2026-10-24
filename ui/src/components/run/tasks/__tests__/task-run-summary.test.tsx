import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskRunSummary } from '../task-run-summary'
import type { RunEvent } from '@/components/run/stage-renderers'
import type { TaskRunEntry } from '../task-strip'

function makeTask(overrides: Partial<TaskRunEntry> = {}): TaskRunEntry {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    label: 'YouTube manual',
    mode: 'blocked',
    ...overrides,
  }
}

function searchCapabilityBlockedEvent(
  overrides: Partial<RunEvent> = {},
): RunEvent {
  return {
    id: 'event-capability',
    type: 'research.search_capability.blocked',
    ts: 1_755_530_000_000,
    searchCapabilityBlocked: true,
    searchCapabilityRemediation:
      'Add an Exa or Brave Search API key in acquisition settings, then re-run the research.',
    searchCapabilityProviderPriority: ['exa', 'brave'],
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TaskRunSummary', () => {
  it('labels a blocked workflow as Blocked instead of Error', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    expect(screen.getByText('Blocked')).toBeInTheDocument()
    expect(screen.queryByText('Error')).not.toBeInTheDocument()
  })

  it('names a pending model choice rather than calling the run ready', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[]}
        isResuming={false}
        task={makeTask({ mode: 'awaiting_model_choice' })}
      />,
    )

    expect(screen.getByText('Model choice required')).toBeInTheDocument()
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
  })

  // This state used to read as running, which left the stop control live. The
  // run is unfinished and abandoning it is still the user's call, so the
  // control stays usable rather than becoming dead while the offer is up.
  it('keeps the stop control usable while a model choice is pending', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[]}
        isResuming={false}
        onCancel={() => {}}
        task={makeTask({ mode: 'awaiting_model_choice' })}
      />,
    )

    expect(screen.getByRole('button', { name: 'Stop workflow' })).toBeEnabled()
  })

  // The run has stopped but is not over, and `getElapsedDurationMs` measures it
  // to the current time. If the view never re-renders, the number it shows is
  // frozen at whenever the pane last drew, which is not how long anything has
  // taken.
  it('keeps the elapsed time moving while a model choice is pending', () => {
    vi.useFakeTimers()
    const startedAt = Date.now() - 5_000
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[]}
        isResuming={false}
        task={makeTask({ mode: 'awaiting_model_choice', startedAt })}
      />,
    )
    const elapsedValue = (): string =>
      screen.getByText('Elapsed').parentElement?.textContent ?? ''
    // Exact, so this proves elapsed time rather than merely a re-render.
    expect(elapsedValue()).toContain('00:05')
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(elapsedValue()).toContain('00:08')
  })

  it('shows a search capability metric when the run blocked on a missing credential', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[searchCapabilityBlockedEvent({
          searchCapabilityFailureCodes: ['not_configured'],
        })]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    expect(screen.getByText('Search capability')).toBeInTheDocument()
    expect(screen.getByText('API key missing')).toBeInTheDocument()
  })

  it('does not blame a missing key when the run blocked on a runtime fault', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[searchCapabilityBlockedEvent({
          searchCapabilityFailureCodes: ['internal'],
          searchCapabilityCause:
            'Every recorded search failed (`internal` \u00d75). That means the runtime could not complete the search.',
          searchCapabilityRemediation:
            'Clear the recorded discovery failure (`internal`), or restore the managed browser.',
        })]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    expect(screen.getByText('Search capability')).toBeInTheDocument()
    expect(screen.getByText('No discovery path')).toBeInTheDocument()
    expect(screen.queryByText('API key missing')).not.toBeInTheDocument()
    // The recorded cause travels with the metric itself, so the diagnosis is
    // available without hovering a tooltip.
    expect(
      screen.getByRole('button', { name: /Every recorded search failed/ }),
    ).toBeInTheDocument()
  })

  it('claims nothing about a legacy blocker event that recorded no cause', async () => {
    const user = userEvent.setup()
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[searchCapabilityBlockedEvent()]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    await user.hover(
      screen.getByRole('button', { name: /Search capability details/ }),
    )

    // The event predating the cause fields says nothing about which discovery
    // paths ran, so the fallback must not describe the run's searches or
    // browser as having found nothing.
    expect(
      await screen.findByText(
        'This run recorded a search-capability blocker. The event predates the recorded cause fields, so it carries no cause.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Nothing found a source/)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Add an Exa or Brave Search API key in acquisition settings, then re-run the research.',
      ),
    ).toBeInTheDocument()
  })

  it('keeps the search capability metric separate from source issues', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[searchCapabilityBlockedEvent()]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    const sourceIssues = screen
      .getByText('Source issues')
      .closest('div.min-w-0')
    const searchCapability = screen
      .getByText('Search capability')
      .closest('div.min-w-0')
    expect(sourceIssues).not.toBe(searchCapability)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('omits the search capability metric for ordinary runs', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    expect(screen.queryByText('Search capability')).not.toBeInTheDocument()
  })
})

// ── The host's own model ────────────────────────────────────────────────────

describe('host default disclosure', () => {
  function hostStart(overrides: Partial<RunEvent> = {}): RunEvent {
    return {
      id: 'event-1',
      type: 'host.agent_start',
      ts: 1,
      runId: 'run-1',
      agentName: 'reviewer',
      coordinatorRunId: 1,
      hostInstanceId: 'process-a',
      modelSelection: {
        provider: 'lm-studio',
        model: 'loopback-b',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      },
      ...overrides,
    } as RunEvent
  }

  const warnings: unknown[][] = []
  beforeEach(() => {
    warnings.length = 0
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnings.push(args)
    })
  })

  it('does not render a model-default card for the host', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[hostStart()]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    expect(screen.queryByRole('note', { name: 'Model selection' })).toBeNull()
  })

  it('keeps replayed host diagnostics out of the summary', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[hostStart({ id: 'a' }), hostStart({ id: 'b' }), hostStart({ id: 'c' })]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    expect(screen.queryByRole('note', { name: 'Model selection' })).toBeNull()
  })

  it('says nothing when the host ran on a pair somebody chose', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[
          hostStart({
            modelSelection: {
              provider: 'lm-studio',
              model: 'loopback-b',
              source: 'agent',
              reason: 'explicit-agent-choice',
              caller: 'agent',
            },
          }),
        ]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    expect(screen.queryByRole('note', { name: 'Model selection' })).toBeNull()
  })

  it('keeps diagnostics for multiple host attempts out of the summary', () => {
    render(
      <TaskRunSummary
        declaredStages={[]}
        events={[
          hostStart({ id: 'a', coordinatorRunId: 1, hostInstanceId: 'process-a' }),
          hostStart({ id: 'b', coordinatorRunId: 1, hostInstanceId: 'process-b' }),
        ]}
        isResuming={false}
        task={makeTask()}
      />,
    )

    expect(screen.queryByRole('note', { name: 'Model selection' })).toBeNull()
    expect(
      warnings.flat().some((entry) => /same key|unique "key"/i.test(String(entry))),
    ).toBe(false)
  })
})
