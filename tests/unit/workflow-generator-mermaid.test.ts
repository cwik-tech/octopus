import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWorkflowMermaid,
  emptyDiagram,
} from '../../domains/workflow-generator/mermaid-builder.js'
import type { WorkflowDraft } from '../../domains/workflow-generator/workflow-draft.js'

const draft: WorkflowDraft = {
  id: 'discuss-then-write',
  description: 'Two-step workflow.',
  input: { artifact: 'incoming-request.md' },
  steps: [
    {
      id: 'discuss',
      type: 'team',
      team: 'problem-thinking-board',
      input_artifact: 'incoming-brief.md',
      result_artifact: 'output/decomposition-plan.md',
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

test('buildWorkflowMermaid emits a left-to-right flowchart with handoff edges', () => {
  const out = buildWorkflowMermaid(draft)
  const firstLine = out.split('\n')[0]
  assert.equal(firstLine, 'flowchart LR')
  assert.match(out, /start\(\["incoming-request\.md"\]\)/)
  assert.match(out, /discuss\["problem-thinking-board/)
  assert.match(out, /write\["writing-team/)
  assert.match(out, /start --> discuss/)
  assert.match(out, /discuss -->\|output\/decomposition-plan\.md\| write/)
  assert.match(out, /write --> done/)
})

test('buildWorkflowMermaid sanitizes step ids with special characters', () => {
  const fancy: WorkflowDraft = {
    ...draft,
    steps: [
      {
        id: 'has-dashes',
        type: 'team',
        team: 'problem-thinking-board',
        input_artifact: 'incoming-brief.md',
        result_artifact: 'output/decomposition-plan.md',
      },
    ],
    output: { from_step: 'has-dashes', artifact: 'output/decomposition-plan.md' },
  }
  const out = buildWorkflowMermaid(fancy)
  // mermaid node ids cannot contain dashes; emitter should sanitize to underscore
  assert.match(out, /has_dashes\["problem-thinking-board/)
  assert.ok(!/^\s*has-dashes\[/.test(out))
})

test('emptyDiagram returns valid mermaid placeholder', () => {
  const out = emptyDiagram()
  assert.equal(out.split('\n')[0], 'flowchart LR')
  assert.match(out, /draft\["draft/)
})
