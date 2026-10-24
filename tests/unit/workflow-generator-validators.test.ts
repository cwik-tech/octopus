import { whenDefined } from '../../core/optional-properties.js'
import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateDraft } from '../../domains/workflow-generator/validators.js'
import type {
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from '../../domains/workflow-generator/workflow-draft.js'

const registry: WorkflowGeneratorRegistry = {
  teams: [
    {
      id: 'problem-thinking-board',
      description: 'Discussion board',
      has_discussion_level: true,
      has_review_level: false,
      level_ids: ['deliberation'],
      agents: [
        { name: 'contrarian', role: 'Challenges' },
        { name: 'pragmatist', role: 'Tests feasibility' },
      ],
    },
    {
      id: 'writing-team',
      description: 'Writes',
      has_discussion_level: false,
      has_review_level: true,
      level_ids: ['brief-and-draft', 'editorial-review'],
      agents: [
        { name: 'brief-builder', role: 'Brief' },
        { name: 'writer', role: 'Writer' },
        { name: 'editor', role: 'Editor' },
      ],
    },
    {
      id: 'reception-desk',
      description: 'Routes',
      has_discussion_level: false,
      has_review_level: false,
      level_ids: ['intake'],
      levels: [
        {
          id: 'intake',
          stage_type: 'routing',
        },
      ],
      agents: [
        { name: 'receptionist', role: 'Routes requests' },
      ],
    },
  ],
}

const validDraft: WorkflowDraft = {
  id: 'valid',
  description: 'Valid draft.',
  input: { artifact: 'incoming-request.md' },
  steps: [
    {
      id: 'discuss',
      type: 'team',
      team: 'problem-thinking-board',
      input_artifact: 'incoming-brief.md',
      result_artifact: 'output/decomposition-plan.md',
      runtime_overrides: {
        levels: {
          deliberation: {
            discussion: { participants: ['contrarian', 'pragmatist'] },
          },
        },
      },
    },
    {
      id: 'write',
      type: 'team',
      team: 'writing-team',
      input_artifact: 'incoming-brief.md',
      result_artifact: 'final-draft.md',
      handoff: {
        from_step: 'discuss',
        from_artifact: 'output/decomposition-plan.md',
        to_artifact: 'incoming-brief.md',
      },
    },
  ],
  output: { from_step: 'write', artifact: 'final-draft.md' },
  on_blocked: 'stop',
  on_failed: 'stop',
}

test('validateDraft accepts a well-formed draft', () => {
  const result = validateDraft(validDraft, registry)
  assert.deepEqual(result.errors, [])
})

test('validateDraft accepts a human-in-the-loop boundary between executable steps', () => {
  const draft = {
    ...validDraft,
    steps: [
      requiredValue(validDraft.steps[0], 'first valid workflow step'),
      {
        id: 'human-feedback',
        type: 'human-in-the-loop',
        prompt: 'Review the discussion.',
        input_artifact: 'review/discussion.md',
        result_artifact: 'feedback/discussion.json',
        handoff: {
          from_step: 'discuss',
          from_artifact: 'output/decomposition-plan.md',
          to_artifact: 'review/discussion.md',
        },
      },
      {
        ...requiredValue(validDraft.steps[1], 'second valid workflow step'),
        handoff: {
          from_step: 'human-feedback',
          from_artifact: 'feedback/discussion.json',
          to_artifact: 'incoming-brief.md',
        },
      },
    ],
  } as unknown as WorkflowDraft

  assert.deepEqual(validateDraft(draft, registry).errors, [])
})

test('validateDraft returns required-field feedback for a HITL step without a result artifact', () => {
  const draft = {
    ...validDraft,
    steps: [
      requiredValue(validDraft.steps[0], 'first valid workflow step'),
      {
        id: 'human-feedback',
        type: 'human-in-the-loop',
        input_artifact: 'review/discussion.md',
        handoff: {
          from_step: 'discuss',
          from_artifact: 'output/decomposition-plan.md',
          to_artifact: 'review/discussion.md',
        },
      },
      requiredValue(validDraft.steps[1], 'second valid workflow step'),
    ],
  } as unknown as WorkflowDraft

  const result = validateDraft(draft, registry)

  assert.ok(result.errors.some((error) =>
    error.includes("steps[1] ('human-feedback').result_artifact is required"),
  ))
})

test('validateDraft rejects a first, final, or executable human-in-the-loop step', () => {
  const humanStep = {
    id: 'human-feedback',
    type: 'human-in-the-loop',
    team: 'writing-team',
    input_artifact: 'review/discussion.md',
    result_artifact: 'feedback/discussion.json',
  }
  const draft = {
    ...validDraft,
    steps: [humanStep, requiredValue(validDraft.steps[0], 'first valid workflow step'), humanStep],
    output: { from_step: 'human-feedback', artifact: 'feedback/discussion.json' },
  } as unknown as WorkflowDraft

  const errors = validateDraft(draft, registry).errors
  assert.ok(errors.some((error) => error.includes('cannot be the first step')))
  assert.ok(errors.some((error) => error.includes('cannot be the final step')))
  assert.ok(errors.some((error) => error.includes('must not declare team')))
})

test('validateDraft rejects unknown teams', () => {
  const bad: WorkflowDraft = {
    ...validDraft,
    steps: [
      { ...requiredValue(validDraft.steps[0], 'first valid workflow step'), team: 'nonexistent-team' },
      requiredValue(validDraft.steps[1], 'second valid workflow step'),
    ],
  }
  const result = validateDraft(bad, registry)
  assert.ok(result.errors.some((e) => e.includes("team 'nonexistent-team'")))
})

test('validateDraft rejects participants not in the step team', () => {
  const bad: WorkflowDraft = {
    ...validDraft,
    steps: [
      {
        ...requiredValue(validDraft.steps[0], 'first valid workflow step'),
        runtime_overrides: {
          levels: {
            deliberation: { discussion: { participants: ['writer'] } },
          },
        },
      },
      requiredValue(validDraft.steps[1], 'second valid workflow step'),
    ],
  }
  const result = validateDraft(bad, registry)
  assert.ok(
    result.errors.some((e) =>
      e.includes("discussion participant 'writer' is not an agent of team 'problem-thinking-board'"),
    ),
  )
})

test('validateDraft rejects handoff that points to a later step', () => {
  const bad: WorkflowDraft = {
    ...validDraft,
    steps: [
      {
        ...requiredValue(validDraft.steps[0], 'first valid workflow step'),
        handoff: {
          from_step: 'write',
          from_artifact: 'final-draft.md',
          to_artifact: 'incoming-brief.md',
        },
      },
      requiredValue(validDraft.steps[1], 'second valid workflow step'),
    ],
  }
  const result = validateDraft(bad, registry)
  assert.ok(
    result.errors.some((e) => e.includes('must be an earlier step')),
  )
})

test('validateDraft rejects output.from_step that does not exist', () => {
  const bad: WorkflowDraft = {
    ...validDraft,
    output: { from_step: 'phantom', artifact: 'final-draft.md' },
  }
  const result = validateDraft(bad, registry)
  assert.ok(
    result.errors.some((e) =>
      e.includes("workflow.output.from_step 'phantom'"),
    ),
  )
})

test('validateDraft warns (not errors) on chained step without handoff', () => {
  const { handoff: _handoff, ...stepWithoutHandoff } = requiredValue(
    validDraft.steps[1],
    'second valid workflow step',
  )
  const sloppy: WorkflowDraft = {
    ...validDraft,
    steps: [
      requiredValue(validDraft.steps[0], 'first valid workflow step'),
      stepWithoutHandoff,
    ],
  }
  const result = validateDraft(sloppy, registry)
  assert.deepEqual(result.errors, [])
  assert.ok(result.warnings.some((w) => w.includes('handoff block')))
})

test('validateDraft warns on unknown level id but does not block', () => {
  const sloppy: WorkflowDraft = {
    ...validDraft,
    steps: [
      {
        ...requiredValue(validDraft.steps[0], 'first valid workflow step'),
        runtime_overrides: {
          levels: {
            'made-up-level': { discussion: { participants: ['contrarian'] } },
          },
        },
      },
      requiredValue(validDraft.steps[1], 'second valid workflow step'),
    ],
  }
  const result = validateDraft(sloppy, registry)
  assert.deepEqual(result.errors, [])
  assert.ok(
    result.warnings.some((w) => w.includes("unknown level 'made-up-level'")),
  )
})

test('validateDraft rejects discussion overrides on routing levels', () => {
  const bad: WorkflowDraft = {
    ...validDraft,
    steps: [
      {
        id: 'clarify',
        type: 'team',
        team: 'reception-desk',
        input_artifact: 'incoming-brief.md',
        result_artifact: 'output/clarified-brief.md',
        runtime_overrides: {
          levels: {
            intake: {
              discussion: {
                participants: ['receptionist'],
                min_rounds: 1,
                max_rounds: 1,
              },
            },
          },
        },
      },
    ],
    output: { from_step: 'clarify', artifact: 'output/clarified-brief.md' },
  }
  const result = validateDraft(bad, registry)
  assert.ok(
    result.errors.some((error) =>
      error.includes("runtime_overrides level 'intake' declares discussion settings") &&
      error.includes("level is type 'routing'"),
    ),
  )
})

test('validateDraft accepts a stage-scoped hosted agent and rejects cross-team agents', () => {
  const agentDraft: WorkflowDraft = {
    ...validDraft,
    steps: [{
      id: 'route',
      type: 'agent',
      team: 'reception-desk',
      agent: 'receptionist',
      stage_type: 'routing',
      input_artifact: 'incoming-brief.md',
      result_artifact: 'routing-decision.md',
    }],
    output: { from_step: 'route', artifact: 'routing-decision.md' },
  }
  assert.deepEqual(validateDraft(agentDraft, registry).errors, [])

  const invalid = {
    ...agentDraft,
    steps: [{
      ...requiredValue(agentDraft.steps[0], 'agent workflow step'),
      agent: 'writer',
    }],
  }
  assert.ok(
    validateDraft(invalid, registry).errors.some((error) =>
      error.includes("agent 'writer' is not on team 'reception-desk'"),
    ),
  )
})
