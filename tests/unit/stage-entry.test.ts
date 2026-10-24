import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStageEntryFollowUp, buildToolFailureFollowUp } from '../../domains/stage/stage-entry.js'
import { STAGE_TYPE } from '../../core/constants.js'
import type { LevelConfig } from '../../core/types.js'

function makeLevel(type: LevelConfig['stage']['type'], id = 'level-1'): LevelConfig {
  switch (type) {
    case STAGE_TYPE.ROUTING:
      return {
        id,
        name: 'Level 1',
        order: 0,
        stage: {
          type,
          coordinator: 'coord',
          config: {
            output: { format: 'routing-decision.md', user_review: false },
          },
        },
      }
    case STAGE_TYPE.DISCUSSION:
      return {
        id,
        name: 'Level 1',
        order: 0,
        stage: {
          type,
          coordinator: 'coord',
          participants: ['a', 'b'],
          config: {
            mode: 'brainstorm',
            min_rounds: 1,
            max_rounds: 3,
            constraints: { max_time_minutes: 10, max_budget_usd: 5 },
            output: { format: 'out.md', user_review: false },
          },
        },
      }
    case STAGE_TYPE.PIPELINE:
      return {
        id,
        name: 'Level 1',
        order: 0,
        stage: {
          type,
          config: {
            parallel: false,
            gate: { type: 'all_tasks_terminal', strictness: 'hard' },
          },
        },
      }
    case STAGE_TYPE.CHAIN:
      return {
        id,
        name: 'Level 1',
        order: 0,
        stage: {
          type,
          sequence: ['a', 'b'],
          config: {
            output: { format: 'out.md', user_review: false },
          },
        },
      }
    case STAGE_TYPE.BROADCAST:
      return {
        id,
        name: 'Level 1',
        order: 0,
        stage: {
          type,
          fan_out: ['a', 'b'],
          config: {
            aggregation: 'merge',
            output: { format: 'out.md', user_review: false },
          },
        },
      }
    case STAGE_TYPE.REVIEW:
      return {
        id,
        name: 'Level 1',
        order: 0,
        stage: {
          type,
          producer: 'writer',
          reviewer: 'editor',
          config: {
            max_iterations: 3,
            output: { format: 'out.md', user_review: false },
          },
        },
      }
  }
}

test('buildStageEntryFollowUp gives deterministic review bootstrap instructions', () => {
  const text = buildStageEntryFollowUp(makeLevel(STAGE_TYPE.REVIEW, 'editorial-review'))
  assert.match(text, /Continue the team workflow from level 'editorial-review'/)
  assert.match(text, /Call `submit_for_review` with no arguments/)
})

test('buildStageEntryFollowUp gives deterministic routing bootstrap instructions', () => {
  const text = buildStageEntryFollowUp(makeLevel(STAGE_TYPE.ROUTING, 'intake'))
  assert.match(text, /Route this request with minimal intake/)
  assert.match(text, /call `spawn_team` or `spawn_workflow` directly/i)
  assert.match(text, /runtime will write the job request and routing decision artifacts/i)
  assert.match(text, /treat the tool result as authoritative/i)
  assert.match(text, /After `spawn_team` or `spawn_workflow` returns/i)
  assert.match(text, /acknowledge success only if it succeeded/i)
  assert.doesNotMatch(text, /Set or confirm the roster first/)
})

test('buildStageEntryFollowUp routes delegated requests without waiting for user input', () => {
  const text = buildStageEntryFollowUp(
    makeLevel(STAGE_TYPE.ROUTING, 'intake'),
    '/tmp/incoming-brief.md',
    'USER: lets discuss polish foreign policy',
    { isDelegatedAutostart: true },
  )

  assert.match(text, /Do not ask follow-up questions or wait for approval/i)
  assert.match(text, /Treat the delegated brief as sufficient for this routing pass/i)
  assert.match(text, /Choose the best available specialist team and call `spawn_team` now/i)
})

test('buildStageEntryFollowUp gives deterministic chain bootstrap instructions', () => {
  const text = buildStageEntryFollowUp(makeLevel(STAGE_TYPE.CHAIN, 'brief-and-draft'))
  assert.match(text, /Call `handoff` once/)
})

test('buildStageEntryFollowUp includes delegated artifact and brief when provided', () => {
  const text = buildStageEntryFollowUp(
    makeLevel(STAGE_TYPE.PIPELINE),
    '/tmp/incoming-brief.md',
    'Write the report.',
  )
  assert.match(text, /Delegated input artifact: `\/tmp\/incoming-brief.md`/)
  assert.match(text, /Delegated brief:/)
  assert.match(text, /Write the report\./)
})

test('buildToolFailureFollowUp embeds the exact tool failure reason when provided', () => {
  const text = buildToolFailureFollowUp(
    'intake',
    'spawn_workflow',
    2,
    "Workflow 'discussion-to-writing' finished with status failed after 1 step(s). Terminal step 'discuss' (problem-thinking-board) status: failed. Reason: [Child team process completed without producing the expected output artifact: output/decomposition-plan.md]",
  )

  assert.match(text, /Continue the team workflow from level 'intake'/)
  assert.match(text, /The previous call to `spawn_workflow` failed in coordinator turn 2\./)
  assert.match(text, /Report the failure concisely using the exact tool result and stop\./)
  assert.match(text, /Use this exact failure reason directly: Workflow 'discussion-to-writing' finished with status failed/)
  assert.doesNotMatch(text, /If the tool result includes a specific failure reason/)
})
