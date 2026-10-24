import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildWorkflowYaml } from '../../domains/workflow-generator/yaml-builder.js'
import { parseWorkflowTemplate } from '../../workflows/loader.js'
import type { WorkflowDraft } from '../../domains/workflow-generator/workflow-draft.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-yaml-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const baseDraft: WorkflowDraft = {
  id: 'discuss-then-write',
  description:
    'Pressure-test the problem on the thinking board, then deliver a draft via the writing team.',
  matches: ['brainstorm_then_write', 'think_then_draft'],
  input: { artifact: 'incoming-request.md' },
  steps: [
    {
      id: 'discuss',
      type: 'team',
      team: 'problem-thinking-board',
      input_artifact: 'incoming-brief.md',
      result_artifact: 'output/decomposition-plan.md',
      requested_result_type: 'artifact:output/decomposition-plan.md',
      runtime_overrides: {
        levels: {
          deliberation: {
            discussion: {
              participants: ['contrarian', 'pragmatist', 'domain-researcher'],
              min_rounds: 1,
              max_rounds: 1,
            },
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
      requested_result_type: 'artifact:final-draft.md',
      include_initial_brief: true,
      brief_prefix: 'Convert the prior analysis into a one-page draft.',
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

test('buildWorkflowYaml round-trips through the workflow loader', () => {
  withTempDir((dir) => {
    const yaml = buildWorkflowYaml(baseDraft)
    const filePath = path.join(dir, 'draft.yaml')
    fs.writeFileSync(filePath, yaml)

    const result = parseWorkflowTemplate(filePath)
    assert.deepEqual(result.errors, [])
    const template = result.template
    assert.ok(template, 'template should parse')

    assert.equal(template.id, baseDraft.id)
    assert.equal(template.description?.trim().startsWith('Pressure-test'), true)
    assert.equal(template.input?.artifact, 'incoming-request.md')
    assert.equal(template.steps.length, 2)

    const [discuss, write] = template.steps
    assert.equal(requiredValue(discuss, 'tests/unit/workflow-generator-yaml.test.ts:84').id, 'discuss')
    assert.equal(requiredValue(discuss, 'tests/unit/workflow-generator-yaml.test.ts:85').team, 'problem-thinking-board')
    assert.equal(requiredValue(discuss, 'tests/unit/workflow-generator-yaml.test.ts:86').result_artifact, 'output/decomposition-plan.md')

    assert.equal(requiredValue(write, 'tests/unit/workflow-generator-yaml.test.ts:88').id, 'write')
    assert.equal(requiredValue(write, 'tests/unit/workflow-generator-yaml.test.ts:89').team, 'writing-team')
    assert.equal(requiredValue(write, 'tests/unit/workflow-generator-yaml.test.ts:90').handoff?.from_step, 'discuss')
    assert.equal(requiredValue(write, 'tests/unit/workflow-generator-yaml.test.ts:91').handoff?.from_artifact, 'output/decomposition-plan.md')
    assert.equal(requiredValue(write, 'tests/unit/workflow-generator-yaml.test.ts:92').include_initial_brief, true)

    assert.equal(template.output.from_step, 'write')
    assert.equal(template.output.artifact, 'final-draft.md')
    assert.equal(template.on_blocked, 'stop')
    assert.equal(template.on_failed, 'stop')
  })
})

test('buildWorkflowYaml omits empty optional blocks', () => {
  const minimal: WorkflowDraft = {
    id: 'minimal',
    description: 'Minimal one-step workflow.',
    input: { artifact: 'incoming-request.md' },
    steps: [
      {
        id: 'only',
        type: 'team',
        team: 'problem-thinking-board',
        input_artifact: 'incoming-brief.md',
        result_artifact: 'output/decomposition-plan.md',
      },
    ],
    output: { from_step: 'only', artifact: 'output/decomposition-plan.md' },
    on_blocked: 'stop',
    on_failed: 'stop',
  }
  const yaml = buildWorkflowYaml(minimal)
  assert.ok(!yaml.includes('runtime_overrides'))
  assert.ok(!yaml.includes('handoff'))
  assert.ok(!yaml.includes('matches'))
  assert.ok(!yaml.includes('brief_prefix'))
})

test('buildWorkflowYaml quotes values with special characters', () => {
  const draft: WorkflowDraft = {
    ...baseDraft,
    description: 'Has a colon: in the description, and a comma, too.',
    matches: ['has:colon', 'has,comma'],
  }
  const yaml = buildWorkflowYaml(draft)
  assert.match(yaml, /'has:colon'/)
  assert.match(yaml, /'has,comma'/)
})

test('buildWorkflowYaml round-trips stage-scoped agent steps', () => {
  withTempDir((dir) => {
    const draft: WorkflowDraft = {
      ...baseDraft,
      steps: [{
        id: 'draft',
        type: 'agent',
        team: 'writing-team',
        agent: 'writer',
        stage_type: 'chain',
        input_artifact: 'incoming-brief.md',
        result_artifact: 'draft-package.md',
      }],
      output: { from_step: 'draft', artifact: 'draft-package.md' },
    }
    const filePath = path.join(dir, 'agent.yaml')
    fs.writeFileSync(filePath, buildWorkflowYaml(draft))

    const parsed = parseWorkflowTemplate(filePath)
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.template?.steps[0]?.type, 'agent')
    assert.equal(parsed.template?.steps[0]?.team, 'writing-team')
    assert.equal(parsed.template?.steps[0]?.agent, 'writer')
    assert.equal(parsed.template?.steps[0]?.stage_type, 'chain')
  })
})

test('buildWorkflowYaml round-trips a human-in-the-loop step without executable fields', () => {
  withTempDir((dir) => {
    const draft = {
      ...baseDraft,
      steps: [
        baseDraft.steps[0],
        {
          id: 'human-feedback',
          type: 'human-in-the-loop',
          prompt: 'Review the discussion and direct the next draft.',
          input_artifact: 'review/discussion.md',
          result_artifact: 'feedback/discussion.json',
          handoff: {
            from_step: 'discuss',
            from_artifact: 'output/decomposition-plan.md',
            to_artifact: 'review/discussion.md',
          },
        },
        {
          ...baseDraft.steps[1],
          handoff: {
            from_step: 'human-feedback',
            from_artifact: 'feedback/discussion.json',
            to_artifact: 'incoming-brief.md',
          },
        },
      ],
    } as unknown as WorkflowDraft
    const filePath = path.join(dir, 'human-input.yaml')
    const yaml = buildWorkflowYaml(draft)
    fs.writeFileSync(filePath, yaml)

    assert.match(yaml, /type: human-in-the-loop/)
    assert.match(yaml, /prompt: Review the discussion and direct the next draft\./)
    assert.doesNotMatch(
      yaml.split('    - id: human-feedback')[1]!.split('    - id: write')[0]!,
      /\n      team:/,
    )
    const parsed = parseWorkflowTemplate(filePath)
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.template?.steps[1]?.type, 'human-in-the-loop')
    assert.equal(
      parsed.template?.steps[1]?.prompt,
      'Review the discussion and direct the next draft.',
    )
  })
})
