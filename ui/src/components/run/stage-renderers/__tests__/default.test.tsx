/**
 * What the fallback stage renderer says about a refused tool call.
 *
 * Every refusal gate writes `tool.execution_failed`, so a renderer that keys on
 * the type alone calls a refusal a failure: the error red, the title "Tool
 * failed", and the one sentence the reader could act on dropped. The live
 * execution timeline was taught to tell them apart; this renderer is the same
 * event on the same table, and the moment a stage picks it the run would go
 * back to reporting a decline as a break.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CAPABILITY_DENIAL_USER_MESSAGES } from '@contracts/capability-policy-denial'

import type { EngineEventEnvelope } from '@/lib/models/runtime-model'

import { DefaultRenderer } from '../default'
import type { RunEvent } from '../index'

/** The accent a row that broke wears, and the one a refusal must not. */
const ERROR_ACCENT = 'hsl(8 72% 52%)'
const REFUSAL_ACCENT = 'hsl(38 84% 44%)'

function refusedToolEvent(
  payload: Record<string, unknown>,
): RunEvent {
  const envelope: EngineEventEnvelope = {
    schema_version: 1,
    timestamp: '2026-09-12T10:00:00.000Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'tool.execution_failed',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'writing-team',
    payload: {
      tool_name: 'dispatch',
      agent_name: 'Research Lead',
      is_error: true,
      ...payload,
    },
  }
  return {
    id: 'event-1',
    type: 'tool.execution_failed',
    ts: Date.parse(envelope.timestamp),
    runId: 'root-run',
    agentName: 'Research Lead',
    content: 'Tool failed',
    sourceEnvelope: envelope,
  }
}

function renderDefault(events: RunEvent[]) {
  return render(
    <DefaultRenderer events={events} stageType="unknown-stage" runId="root-run" />,
  )
}

function firstRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector('tbody tr')
  expect(row).not.toBeNull()
  return row as HTMLElement
}

describe('DefaultRenderer refusal rows', () => {
  it('tells the reader why the runtime refused the tool call', () => {
    const { container } = renderDefault([
      refusedToolEvent({
        blocked_by_capability_policy: true,
        policy_code: 'tool_not_allowed_in_level',
        reason: "Tool 'dispatch' is not available in the current level.",
      }),
    ])

    expect(
      screen.getByText(
        'Research Lead was not allowed to use dispatch · ' +
          CAPABILITY_DENIAL_USER_MESSAGES.tool_not_allowed_in_level,
      ),
    ).toBeInTheDocument()
    expect(firstRow(container)).toHaveStyle({
      borderLeftColor: REFUSAL_ACCENT,
    })
    expect(firstRow(container)).not.toHaveStyle({
      borderLeftColor: ERROR_ACCENT,
    })
  })

  it('reads the bypass and tool-safety gates as refusals too', () => {
    // Three gates write this event and only the first sets
    // `blocked_by_capability_policy`. Each one left out reads as a break.
    const { container } = renderDefault([
      refusedToolEvent({
        tool_name: 'bash',
        blocked_capability_bypass: true,
        policy_code: 'ungoverned_tool_call',
        reason: "Tool 'bash' has no Team Runtime capability registration.",
      }),
      refusedToolEvent({
        tool_name: 'bash',
        blocked_tool_safety: true,
        policy_code: 'unsafe_bash_command',
        reason: 'Command would remove files outside the run folder.',
      }),
    ])

    expect(
      screen.getByText(
        'Research Lead was not allowed to use bash · ' +
          CAPABILITY_DENIAL_USER_MESSAGES.ungoverned_tool_call,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Research Lead was not allowed to use bash · ' +
          CAPABILITY_DENIAL_USER_MESSAGES.unsafe_bash_command,
      ),
    ).toBeInTheDocument()
    for (const row of container.querySelectorAll('tbody tr')) {
      expect(row).toHaveStyle({ borderLeftColor: REFUSAL_ACCENT })
    }
  })

  it('keeps the error accent for a tool call that genuinely failed', () => {
    const { container } = renderDefault([
      refusedToolEvent({ error: 'Sub-team exited before reporting.' }),
    ])

    expect(screen.getByText('Tool failed')).toBeInTheDocument()
    expect(firstRow(container)).toHaveStyle({ borderLeftColor: ERROR_ACCENT })
  })

  it('keeps the policy code and the runtime reason out of the row', () => {
    const { container } = renderDefault([
      refusedToolEvent({
        blocked_by_capability_policy: true,
        policy_code: 'duplicate_level_tool',
        reason:
          "Tool 'dispatch' was already used in coordinator turn 1 for level 'draft'.",
      }),
    ])

    const body = container.querySelector('tbody')?.textContent ?? ''
    expect(body).not.toContain('duplicate_level_tool')
    expect(body).not.toContain('already used in coordinator turn')
    expect(body).toContain(CAPABILITY_DENIAL_USER_MESSAGES.duplicate_level_tool)
  })
})
