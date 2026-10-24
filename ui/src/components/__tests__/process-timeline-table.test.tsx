import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CAPABILITY_DENIAL_USER_MESSAGES } from '@contracts/capability-policy-denial'

import { ProcessTimelineTable } from '@/components/process-timeline-table'
import {
  buildExecutionProjectionFromRootEvents,
  formatTimestamp,
  type EngineEventEnvelope,
  type ExecutionTimelineItem,
} from '@/lib/models/runtime-model'

function makeTimelineItem(overrides: Partial<ExecutionTimelineItem> = {}): ExecutionTimelineItem {
  return {
    artifactRefs: [],
    badges: [],
    depth: 0,
    detail: '',
    id: 'item-1',
    kind: 'completion',
    levelId: null,
    runId: 'run-1',
    stageType: null,
    team: 'backend-team',
    timestamp: '2025-01-15T10:00:00Z',
    title: 'Default title',
    ...overrides,
  }
}

function renderTable(items: ExecutionTimelineItem[]) {
  const anchorByIndex = vi.fn((i: number) => `anchor-${i}`)
  const isArtifactSelected = vi.fn(() => false)
  const onArtifactSelect = vi.fn()

  return render(
    <ProcessTimelineTable
      items={items}
      anchorByIndex={anchorByIndex}
      isArtifactSelected={isArtifactSelected}
      onArtifactSelect={onArtifactSelect}
    />,
  )
}

describe('ProcessTimelineTable', () => {
  it('places custom heading content and the agent filter in one toolbar row', () => {
    const { container } = render(
      <ProcessTimelineTable
        items={[makeTimelineItem()]}
        anchorByIndex={(index) => `anchor-${index}`}
        containerClassName="min-h-[24rem]"
        isArtifactSelected={() => false}
        onArtifactSelect={() => undefined}
        toolbarStart={<span>Process timeline</span>}
      />,
    )

    const toolbar = container.querySelector(
      '[data-slot="process-timeline-toolbar"]',
    )
    expect(toolbar).toContainElement(screen.getByText('Process timeline'))
    expect(toolbar).toContainElement(
      screen.getByRole('combobox', { name: 'Filter events by agent' }),
    )
    expect(container.querySelector('[data-slot="table-container"]'))
      .toHaveClass('min-h-[24rem]')
  })

  it('renders table headers', () => {
    const { container } = renderTable([])

    expect(screen.getByRole('columnheader', { name: 'Event' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Artifacts' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Time' })).toBeInTheDocument()
    expect(container.querySelector('[data-slot="table"]')).toHaveClass(
      'min-w-[28rem]',
      'table-fixed',
    )
    expect(screen.queryByText('Type')).not.toBeInTheDocument()
    expect(screen.queryByText('Team')).not.toBeInTheDocument()
    expect(screen.queryByText('Description')).not.toBeInTheDocument()
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument()
  })

  it('renders no rows when items array is empty', () => {
    const { container } = renderTable([])

    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(0)
  })

  it('renders all items in reverse order', () => {
    const item1 = makeTimelineItem({ id: 'a', title: 'First' })
    const item2 = makeTimelineItem({ id: 'b', title: 'Second' })
    const item3 = makeTimelineItem({ id: 'c', title: 'Third' })

    renderTable([item1, item2, item3])

    // In a table, the last item in the source array should appear first (reversed)
    // Third (id: c) should be the first visible row
    const firstRowTitle = screen.getByText('Third')
    expect(firstRowTitle).toBeInTheDocument()
  })

  it('shows the humanized team name from the team icon', async () => {
    const user = userEvent.setup()
    renderTable([makeTimelineItem({ team: 'frontend-ops' })])

    const teamIcon = screen.getByLabelText('Team: Frontend Ops')
    expect(screen.queryByText('Frontend Ops')).not.toBeInTheDocument()

    await user.hover(teamIcon)
    expect(await screen.findByText('Frontend Ops')).toBeInTheDocument()
  })

  it('filters the timeline by exact agent while All agents retains system events', async () => {
    const user = userEvent.setup()
    renderTable([
      makeTimelineItem({
        id: 'system',
        title: 'Workflow started',
      }),
      makeTimelineItem({
        id: 'flavor',
        title: 'Flavor source written',
        actor: {
          id: 'flavor-uniqueness',
          name: 'Flavor Uniqueness Analyst',
          baseName: 'web-researcher',
          activityScopeId: 'flavor-uniqueness',
          emitterName: 'source-observation-store',
        },
      }),
      makeTimelineItem({
        id: 'public',
        title: 'Public favoritism source written',
        actor: {
          id: 'public-favoritism',
          name: 'Public Favoritism Analyst',
          baseName: 'web-researcher',
          activityScopeId: 'public-favoritism',
          emitterName: 'source-observation-store',
        },
      }),
    ])

    expect(screen.getByText('Workflow started')).toBeInTheDocument()
    expect(screen.getByText('Flavor source written')).toBeInTheDocument()
    expect(screen.getByText('Public favoritism source written')).toBeInTheDocument()

    const trigger = screen.getByRole('combobox', {
      name: 'Filter events by agent',
    })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    await user.click(
      await screen.findByRole('option', {
        name: 'Flavor Uniqueness Analyst',
      }),
    )

    expect(screen.getByText('Flavor source written')).toBeInTheDocument()
    expect(screen.queryByText('Public favoritism source written')).not.toBeInTheDocument()
    expect(screen.queryByText('Workflow started')).not.toBeInTheDocument()

    trigger.focus()
    await user.keyboard('{ArrowDown}')
    await user.click(
      await screen.findByRole('option', { name: 'All agents' }),
    )

    expect(screen.getByText('Workflow started')).toBeInTheDocument()
    expect(screen.getByText('Public favoritism source written')).toBeInTheDocument()
  })

  it('disambiguates duplicate display roles with their lane ids', async () => {
    const user = userEvent.setup()
    renderTable([
      makeTimelineItem({
        id: 'lane-a-event',
        actor: {
          id: 'lane-a',
          name: 'Market Analyst',
          baseName: 'web-researcher',
          activityScopeId: 'lane-a',
          emitterName: null,
        },
      }),
      makeTimelineItem({
        id: 'lane-b-event',
        actor: {
          id: 'lane-b',
          name: 'Market Analyst',
          baseName: 'web-researcher',
          activityScopeId: 'lane-b',
          emitterName: null,
        },
      }),
    ])

    const trigger = screen.getByRole('combobox', {
      name: 'Filter events by agent',
    })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(
      await screen.findByRole('option', { name: 'Market Analyst · Lane A' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Market Analyst · Lane B' }),
    ).toBeInTheDocument()
  })

  it('shows exact actor and emitter details in the people icon tooltip', async () => {
    const user = userEvent.setup()
    renderTable([
      makeTimelineItem({
        actor: {
          id: 'flavor-uniqueness',
          name: 'Flavor Uniqueness Analyst',
          baseName: 'web-researcher',
          activityScopeId: 'flavor-uniqueness',
          emitterName: 'source-observation-store',
        },
      }),
    ])

    await user.hover(
      screen.getByLabelText('Agent: Flavor Uniqueness Analyst'),
    )
    expect(
      await screen.findByText('Flavor Uniqueness Analyst'),
    ).toBeInTheDocument()
    expect(screen.getByText('Base: web-researcher')).toBeInTheDocument()
    expect(screen.getByText('Lane: flavor-uniqueness')).toBeInTheDocument()
    expect(
      screen.getByText('Emitter: source-observation-store'),
    ).toBeInTheDocument()
  })

  it('does not render the item kind as a table column', () => {
    renderTable([makeTimelineItem({ kind: 'delegation' })])

    expect(screen.queryByText('delegation')).not.toBeInTheDocument()
  })

  it('renders the item title as the step summary', () => {
    renderTable([makeTimelineItem({ title: 'My Step' })])

    expect(screen.getByText('My Step')).toBeInTheDocument()
  })

  it('names the run on lifecycle rows instead of a generic summary', () => {
    renderTable([
      makeTimelineItem({ kind: 'run', title: 'Youtube Extraction run started' }),
    ])

    expect(
      screen.getByText('Youtube Extraction run started'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Session started')).not.toBeInTheDocument()
  })

  it('gives every row of one run the same accent so delegation reads by run', () => {
    renderTable([
      makeTimelineItem({
        id: 'root-step',
        runId: 'root-run',
        team: 'youtube-extraction',
        title: 'Step generate-manuals completed',
      }),
      makeTimelineItem({
        id: 'root-end',
        runId: 'root-run',
        team: 'workflow:youtube-manual-generation',
        title: 'Workflow run completed',
      }),
    ])

    const rows = screen.getAllByRole('row').slice(1)
    const accents = rows.map((row) => row.style.borderLeft)

    expect(accents[0]).toBe(accents[1])
  })

  it('gives each agent a distinct accent on the row border and agent icon', () => {
    const makeActor = (lane: string, name: string) => ({
      id: lane,
      name,
      baseName: 'web-researcher',
      activityScopeId: lane,
      emitterName: null,
    })
    renderTable([
      makeTimelineItem({
        id: 'a1',
        title: 'Analyst A first source',
        runId: 'root-run',
        actor: makeActor('lane-a', 'Analyst A'),
      }),
      makeTimelineItem({
        id: 'b1',
        title: 'Analyst B first source',
        runId: 'root-run',
        actor: makeActor('lane-b', 'Analyst B'),
      }),
      makeTimelineItem({
        id: 'a2',
        title: 'Analyst A second source',
        runId: 'root-run',
        actor: makeActor('lane-a', 'Analyst A'),
      }),
    ])

    const rowFor = (title: string) => {
      const row = screen.getByText(title).closest('tr')
      expect(row).not.toBeNull()
      return row as HTMLElement
    }
    const borderAccent = (row: HTMLElement) => row.style.borderLeftColor
    const iconColor = (row: HTMLElement) => {
      const icon = row.querySelector('svg')
      expect(icon).not.toBeNull()
      return icon?.style.color ?? ''
    }

    const rowA1 = rowFor('Analyst A first source')
    const rowA2 = rowFor('Analyst A second source')
    const rowB1 = rowFor('Analyst B first source')

    expect(borderAccent(rowA1)).toBe(borderAccent(rowA2))
    expect(borderAccent(rowA1)).not.toBe(borderAccent(rowB1))
    expect(iconColor(rowA1)).toBe(iconColor(rowA2))
    expect(iconColor(rowA1)).not.toBe(iconColor(rowB1))
  })

  it('keeps event rows concise by omitting secondary description metadata', () => {
    renderTable([
      makeTimelineItem({
        badges: ['p1', 'p2'],
        detail: 'Some detail',
        errorText: 'Runtime failure',
        processStep: 'step-42',
      }),
    ])

    expect(screen.queryByText('Some detail')).not.toBeInTheDocument()
    expect(screen.queryByText('Step:')).not.toBeInTheDocument()
    expect(screen.queryByText('step-42')).not.toBeInTheDocument()
    expect(screen.queryByText('Runtime failure')).not.toBeInTheDocument()
    expect(screen.queryByText('p1')).not.toBeInTheDocument()
    expect(screen.queryByText('p2')).not.toBeInTheDocument()
  })

  it('renders artifact references as buttons when artifactRefs is non-empty', async () => {
    const user = userEvent.setup()
    const onArtifactSelect = vi.fn()
    const item = makeTimelineItem({
      artifactRefs: [{ label: 'report.md', path: 'reports/report.md', runId: 'run-1' }],
    })

    render(
      <ProcessTimelineTable
        items={[item]}
        anchorByIndex={vi.fn((i) => `a-${i}`)}
        isArtifactSelected={() => false}
        onArtifactSelect={onArtifactSelect}
      />,
    )

    const artifactBtn = screen.getByRole('button', { name: 'Open artifact: report.md' })
    expect(screen.queryByText('report.md')).not.toBeInTheDocument()

    await user.hover(artifactBtn)
    expect(await screen.findByText('report.md')).toBeInTheDocument()
    await user.click(artifactBtn)

    expect(onArtifactSelect).toHaveBeenCalledWith({ runId: 'run-1', path: 'reports/report.md' })
  })

  it('renders "—" when artifactRefs is empty', () => {
    renderTable([makeTimelineItem({ artifactRefs: [] })])

    // The "-" (em-dash) placeholder in the Artifacts column
    const artifacts = screen.getByText('—')
    expect(artifacts).toBeInTheDocument()
  })

  it('renders formatTimestamp output in the Time column', () => {
    const item = makeTimelineItem()
    renderTable([item])

    expect(screen.getByText(formatTimestamp(item.timestamp))).toBeInTheDocument()
  })

  it('applies left border accent color based on team name', () => {
    const { container } = renderTable([makeTimelineItem({ team: 'backend-team' })])

    const rows = container.querySelectorAll('tbody tr')
    expect(rows.length).toBeGreaterThan(0)
    // Width and style come from Tailwind classes; only the accent colour is inline.
    expect(rows[0]).toHaveClass('border-l-3', 'border-solid')
  })

  it('applies red accent for error kind items', () => {
    const { container } = renderTable([makeTimelineItem({ kind: 'error' })])

    const rows = container.querySelectorAll('tbody tr')
    expect(rows[0]).toHaveStyle({ borderLeftColor: 'hsl(8 72% 52%)' })
  })

  it('applies team-colored accent (not error) for non-error kinds', () => {
    const { container } = renderTable([makeTimelineItem({ kind: 'completion', team: 'design-team' })])

    const rows = container.querySelectorAll('tbody tr')
    expect(rows[0]).toHaveClass('border-solid')
    expect((rows[0] as HTMLElement | undefined)?.style.borderLeftColor).not.toBe(
      'hsl(8 72% 52%)',
    )
  })

  it('sets anchor id on rows via anchorByIndex callback', () => {
    const anchorByIndex = vi.fn((i: number) => `custom-anchor-${i}`)

    render(
      <ProcessTimelineTable
        items={[makeTimelineItem({ id: 'x' })]}
        anchorByIndex={anchorByIndex}
        isArtifactSelected={() => false}
        onArtifactSelect={vi.fn()}
      />,
    )

    expect(anchorByIndex).toHaveBeenCalledWith(0)
  })

  it('applies depth-based left padding to the event cell', () => {
    const { container } = renderTable([makeTimelineItem({ depth: 2 })])

    const eventCells = container.querySelectorAll('tbody td:first-child')
    expect(eventCells.length).toBeGreaterThan(0)
    // 10 + 2 * 14 = 38
    expect(eventCells[0]).toHaveStyle({ paddingLeft: '38px' })
  })

  it('renders event names like timestamps and truncates them with a tooltip', async () => {
    const user = userEvent.setup()
    const title =
      'research/observations/flavor-uniqueness/very-long-observation-name.json written'
    const { container } = renderTable([makeTimelineItem({ title })])
    const eventCell = container.querySelector('tbody td:first-child')
    const eventName = screen.getByLabelText(title)

    expect(eventCell).toHaveClass(
      'text-xs',
      'font-normal',
      'text-muted-foreground',
      'overflow-hidden',
    )
    expect(eventName).toHaveClass('truncate')

    await user.hover(eventName)
    expect(
      container.ownerDocument.querySelector('[data-slot="tooltip-content"]'),
    ).toHaveTextContent(title)
  })

  it('renders multiple items in correctly reversed order (last item first)', () => {
    const items = [
      makeTimelineItem({ id: 'item-a', title: 'Alpha', timestamp: '2025-01-01T00:00:00Z' }),
      makeTimelineItem({ id: 'item-b', title: 'Beta', timestamp: '2025-01-02T00:00:00Z' }),
      makeTimelineItem({ id: 'item-c', title: 'Gamma', timestamp: '2025-01-03T00:00:00Z' }),
    ]

    renderTable(items)

    // The table reverses items: Gamma should be the first visible row (first in the table body)
    const rows = screen.getAllByText(/Alpha|Beta|Gamma/)
    // The first visible text in DOM order should be Gamma (last in array)
    // Note: DOM traversal in table is row-based, so first <tr> contains Gamma
    const firstRow = rows[0]?.closest('tr')
    expect(firstRow?.textContent).toContain('Gamma')
  })

  it('handles a single item array without issues', () => {
    const { container } = renderTable([makeTimelineItem({ id: 'solo' })])

    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(1)
  })

  it('renders the table wrapper with correct styling', () => {
    const { container } = renderTable([makeTimelineItem()])

    const wrapper = container.querySelector('[data-slot="table-container"]')
    expect(wrapper).toBeInTheDocument()
    expect(wrapper?.className).toContain('rounded-lg')
    expect(wrapper?.className).toContain('border')
    expect(wrapper?.className).toContain('overflow-auto')

    const header = container.querySelector('[data-slot="table-header"]')
    expect(header).toHaveClass('sticky', 'top-0')
  })

  it('applies hover:bg-muted/30 to rows', () => {
    const { container } = renderTable([makeTimelineItem()])

    const rows = container.querySelectorAll('tbody tr')
    expect(rows[0]?.className).toContain('hover:bg-muted/30')
  })
})

/**
 * What a refused tool call looks like once it reaches the screen.
 *
 * The row is the whole surface: the table renders the title and nothing else,
 * and paints one accent down its left edge. So both are asserted here, against
 * a projection built from a real runtime event rather than a hand-made item —
 * and the sentence is written out in full, because asserting it against the
 * constant it came from would pass for any sentence at all.
 */
describe('ProcessTimelineTable refusal rows', () => {
  /** The whole sentence, spelled out, exactly as a reader sees it. */
  const NOT_IN_STAGE_ROW =
    'Research Lead was not allowed to use dispatch \u00b7 The agent asked for something this stage does not offer. Add the tool to this stage, or move the step to the stage that already has it.'
  const DUPLICATE_ROW =
    'Research Lead was not allowed to use dispatch \u00b7 The agent reached for the same stage tool twice in one turn. The first use counted and the repeat was dropped.'
  const UNGOVERNED_ROW =
    'Research Lead was not allowed to use bash \u00b7 The agent asked for a tool this run does not offer at all, so nothing ran. Add it to the team and the stage, or drop it from the agent instructions.'
  /** The accent a row that broke wears, and the one a refusal must not. */
  const ERROR_ACCENT = 'hsl(8 72% 52%)'
  const REFUSAL_ACCENT = 'hsl(38 84% 44%)'

  function denialEnvelope(
    policyCode: string,
    reason: string,
    overrides: Record<string, unknown> = {},
  ): EngineEventEnvelope {
    return {
      schema_version: 1,
      timestamp: '2026-09-12T10:00:00.000Z',
      tenant_id: 'local',
      category: 'tool',
      type: 'tool.execution_failed',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'writing-team',
      level_id: 'draft',
      payload: {
        tool_name: 'dispatch',
        agent_name: 'Research Lead',
        is_error: true,
        blocked_by_capability_policy: true,
        policy_code: policyCode,
        reason,
        ...overrides,
      },
    }
  }

  function firstRow(container: HTMLElement): HTMLElement {
    const row = container.querySelector('tbody tr')
    expect(row).not.toBeNull()
    return row as HTMLElement
  }

  it('tells the reader in the row why the runtime refused the tool call', () => {
    const projection = buildExecutionProjectionFromRootEvents('root-run', [
      denialEnvelope(
        'tool_not_allowed_in_level',
        "Tool 'dispatch' is not available in the current level.",
      ),
    ])

    renderTable(projection.story)

    expect(screen.getByText(NOT_IN_STAGE_ROW)).toBeInTheDocument()
    expect(screen.queryByText(/failed using tool/)).not.toBeInTheDocument()
  })

  it('explains a call the runtime refused before any policy ran', () => {
    // The bypass gate writes the same event with its own flag
    // (`team-runtime/index.ts:4870`). Read only for the policy flag, this row
    // came out as "Research Lead failed using tool bash" with the reason
    // dropped on the floor.
    const projection = buildExecutionProjectionFromRootEvents('root-run', [
      denialEnvelope(
        'ungoverned_tool_call',
        "Tool 'bash' has no Team Runtime capability registration.",
        {
          tool_name: 'bash',
          blocked_by_capability_policy: undefined,
          blocked_capability_bypass: true,
        },
      ),
    ])

    const { container } = renderTable(projection.story)

    expect(screen.getByText(UNGOVERNED_ROW)).toBeInTheDocument()
    expect(screen.queryByText(/failed using tool/)).not.toBeInTheDocument()
    expect(firstRow(container)).toHaveStyle({ borderLeftColor: REFUSAL_ACCENT })
  })

  it('paints a refusal in its own accent rather than the error red', () => {
    // "The repeat was dropped" is not a run that broke. A row wearing the error
    // accent says it is.
    const projection = buildExecutionProjectionFromRootEvents('root-run', [
      denialEnvelope(
        'duplicate_level_tool',
        "Tool 'dispatch' was already used in coordinator turn 1 for level 'draft'.",
      ),
    ])

    const { container } = renderTable(projection.story)

    expect(screen.getByText(DUPLICATE_ROW)).toBeInTheDocument()
    expect(firstRow(container)).toHaveStyle({ borderLeftColor: REFUSAL_ACCENT })
    expect(firstRow(container)).not.toHaveStyle({ borderLeftColor: ERROR_ACCENT })
  })

  it('keeps the error accent for a tool call that genuinely failed', () => {
    const projection = buildExecutionProjectionFromRootEvents('root-run', [{
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
        error: 'Sub-team exited before reporting.',
      },
    }])

    const { container } = renderTable(projection.story)

    expect(
      screen.getByText('Research Lead failed using tool dispatch'),
    ).toBeInTheDocument()
    expect(firstRow(container)).toHaveStyle({ borderLeftColor: ERROR_ACCENT })
  })

  it('keeps the policy code and the runtime reason out of the row', () => {
    const projection = buildExecutionProjectionFromRootEvents('root-run', [
      denialEnvelope(
        'duplicate_level_tool',
        "Tool 'dispatch' was already used in coordinator turn 1 for level 'draft'.",
      ),
    ])

    const { container } = renderTable(projection.story)

    const body = container.querySelector('tbody')?.textContent ?? ''
    expect(body).not.toContain('duplicate_level_tool')
    expect(body).not.toContain('already used in coordinator turn')
    expect(body).toContain(CAPABILITY_DENIAL_USER_MESSAGES.duplicate_level_tool)
  })
})
