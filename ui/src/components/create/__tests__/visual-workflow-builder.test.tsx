import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import VisualWorkflowBuilder from '@/components/create/visual-workflow-builder'
import type {
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from '@/lib/models/workflow-generator-model'

const registry: WorkflowGeneratorRegistry = {
  teams: [{
    id: 'writers',
    default_input_artifact: 'incoming-brief.md',
    default_output_artifact: 'report.md',
    has_discussion_level: false,
    has_review_level: false,
    level_ids: ['write'],
    levels: [{ id: 'write', stage_type: 'chain', output_format: 'report.md' }],
    agents: [{ name: 'writer', role: 'Writes' }],
  }],
}

const executableDraft: WorkflowDraft = {
  id: 'two-step',
  description: 'Two executable steps.',
  input: { artifact: 'incoming-request.md' },
  steps: [
    {
      id: 'step-1',
      type: 'team',
      team: 'writers',
      stage_type: 'chain',
      input_artifact: 'incoming-brief.md',
      result_artifact: 'report.md',
    },
    {
      id: 'step-2',
      type: 'agent',
      team: 'writers',
      agent: 'writer',
      stage_type: 'chain',
      input_artifact: 'incoming-brief.md',
      result_artifact: 'final.md',
      handoff: {
        from_step: 'step-1',
        from_artifact: 'report.md',
        to_artifact: 'incoming-brief.md',
      },
    },
  ],
  output: { from_step: 'step-2', artifact: 'final.md' },
  on_blocked: 'stop',
  on_failed: 'stop',
}

function renderBuilder(
  draft: WorkflowDraft,
  overrides: Partial<React.ComponentProps<typeof VisualWorkflowBuilder>> & {
    onWorkflowTitleChange?: (title: string) => void
  } = {},
) {
  const props: React.ComponentProps<typeof VisualWorkflowBuilder> = {
    draft,
    registry,
    onWorkflowTitleChange: vi.fn(),
    onStepIdChange: vi.fn(() => true),
    onStepTeamChange: vi.fn(),
    onStepAgentChange: vi.fn(),
    onStepStageChange: vi.fn(),
    onConvertStepToHumanInput: vi.fn(),
    onHumanInputPromptChange: vi.fn(),
    onAddStep: vi.fn(),
    onRemoveStep: vi.fn(),
    onSaveWorkflow: vi.fn(),
    yamlPreviewProps: {
      yaml: '',
      onYamlChange: vi.fn(),
      warnings: [],
      errors: [],
      validating: false,
      dirty: false,
      saving: false,
      saved: null,
      saveError: null,
      onSave: vi.fn(),
    },
    ...overrides,
  }
  render(<VisualWorkflowBuilder {...props} />)
  return props
}

describe('VisualWorkflowBuilder human input authoring', () => {
  it('edits the Workflow title above the steps without a duplicate Step 1 header', () => {
    const onWorkflowTitleChange = vi.fn()
    renderBuilder(executableDraft, { onWorkflowTitleChange })

    const title = screen.getByLabelText('Workflow title')
    expect(title).toHaveValue('Two Step')
    expect(screen.queryByText('Step 1', { selector: 'div' })).not.toBeInTheDocument()

    fireEvent.change(title, { target: { value: 'Revenue strategy' } })
    fireEvent.blur(title)

    expect(onWorkflowTitleChange).toHaveBeenCalledWith('revenue-strategy')
  })

  it('leaves the saved confirmation to the application toast', () => {
    renderBuilder(executableDraft, {
      yamlPreviewProps: {
        yaml: '',
        onYamlChange: vi.fn(),
        warnings: [],
        errors: [],
        validating: false,
        dirty: false,
        saving: false,
        saved: {
          yamlPath: 'workflows/user-generated/test-1.yaml',
          filename: 'test-1.yaml',
        },
        saveError: null,
        onSave: vi.fn(),
      },
    })

    expect(screen.queryByText(/Saved\s+test-1\.yaml/)).not.toBeInTheDocument()
  })

  it('sets the clicked step to human-in-the-loop without using selected styling', () => {
    const onConvertStepToHumanInput = vi.fn()
    renderBuilder(executableDraft, { onConvertStepToHumanInput })

    const humanInTheLoop = screen.getByRole('button', {
      name: 'Set Step 2 type to human-in-the-loop',
    })
    expect(humanInTheLoop).toHaveTextContent('Human-in-the-loop')
    expect(humanInTheLoop).toHaveClass('border-border')
    expect(humanInTheLoop).not.toHaveClass('bg-primary/[0.08]')
    expect(screen.queryByText('Team: Writers')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Set Step 1 type to human-in-the-loop' }),
    ).not.toBeInTheDocument()

    fireEvent.click(humanInTheLoop)
    expect(onConvertStepToHumanInput).toHaveBeenCalledWith('step-2')
  })

  it('does not offer the human-in-the-loop Stage Type on a boundary step', () => {
    const humanDraft = {
      ...executableDraft,
      steps: [
        executableDraft.steps[0],
        {
          id: 'human-feedback',
          type: 'human-in-the-loop',
          prompt: 'Review the report.',
          input_artifact: 'review/report.md',
          result_artifact: 'feedback/report.json',
          handoff: {
            from_step: 'step-1',
            from_artifact: 'report.md',
            to_artifact: 'review/report.md',
          },
        },
        executableDraft.steps[1],
      ],
    } as WorkflowDraft
    renderBuilder(humanDraft)

    expect(
      screen.queryByRole('button', { name: 'Set Step 2 type to human-in-the-loop' }),
    ).not.toBeInTheDocument()
  })

  it('renders and edits a human-input prompt without Team controls', () => {
    const onHumanInputPromptChange = vi.fn()
    const humanDraft = {
      ...executableDraft,
      steps: [
        executableDraft.steps[0],
        {
          id: 'human-feedback',
          type: 'human-in-the-loop',
          prompt: 'Review the report.',
          input_artifact: 'review/report.md',
          result_artifact: 'feedback/report.json',
          handoff: {
            from_step: 'step-1',
            from_artifact: 'report.md',
            to_artifact: 'review/report.md',
          },
        },
        executableDraft.steps[1],
      ],
    } as WorkflowDraft
    renderBuilder(humanDraft, { onHumanInputPromptChange })

    expect(screen.getByText('Human-in-the-loop boundary')).toBeVisible()
    const prompt = screen.getByLabelText('Human-in-the-loop prompt')
    fireEvent.change(prompt, { target: { value: 'Focus on cost and risk.' } })
    expect(onHumanInputPromptChange).toHaveBeenCalledWith(
      'human-feedback',
      'Focus on cost and risk.',
    )
    const humanCard = prompt.closest<HTMLElement>('.overflow-hidden')
    expect(humanCard).not.toBeNull()
    expect(within(humanCard!).queryByText('Stage Type')).not.toBeInTheDocument()
    expect(within(humanCard!).queryByText('Assignee')).not.toBeInTheDocument()
  })
})
