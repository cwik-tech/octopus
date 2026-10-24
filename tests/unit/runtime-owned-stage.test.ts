import assert from 'node:assert/strict'
import test from 'node:test'

import { STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { LevelConfig } from '../../core/types.js'
import {
  canRuntimeAutostartInline,
  resolveRuntimeRecoveryStageStatus,
  resolveRuntimeAutostartOwnership,
  resolveRuntimeOwnedStageTool,
} from '../../domains/runtime/runtime-owned-stage.js'

function fixedLevel(
  type:
    | typeof STAGE_TYPE.PIPELINE
    | typeof STAGE_TYPE.CHAIN
    | typeof STAGE_TYPE.BROADCAST
    | typeof STAGE_TYPE.REVIEW,
): LevelConfig {
  switch (type) {
    case STAGE_TYPE.PIPELINE:
      return {
        id: 'pipeline',
        name: 'Pipeline',
        order: 0,
        stage: {
          type,
          coordinator: 'lead',
          config: {
            parallel: false,
            gate: { type: 'all_tasks_terminal', strictness: 'hard' },
          },
        },
      }
    case STAGE_TYPE.CHAIN:
      return {
        id: 'chain',
        name: 'Chain',
        order: 0,
        stage: {
          type,
          coordinator: 'lead',
          sequence: ['writer'],
          config: {
            output: { format: 'draft.md', user_review: false },
          },
        },
      }
    case STAGE_TYPE.BROADCAST:
      return {
        id: 'broadcast',
        name: 'Broadcast',
        order: 0,
        stage: {
          type,
          coordinator: 'lead',
          fan_out: ['reviewer'],
          config: {
            aggregation: 'merge',
            output: { format: 'reviews.md', user_review: false },
          },
        },
      }
    case STAGE_TYPE.REVIEW:
      return {
        id: 'review',
        name: 'Review',
        order: 0,
        stage: {
          type,
          coordinator: 'lead',
          producer: 'writer',
          reviewer: 'reviewer',
          config: {
            max_iterations: 2,
            output: { format: 'approved.md', user_review: false },
          },
        },
      }
  }
}

test('fixed-flow Team arrangements remain runtime-owned when they declare a coordinator', () => {
  assert.deepEqual(
    [
      STAGE_TYPE.PIPELINE,
      STAGE_TYPE.CHAIN,
      STAGE_TYPE.BROADCAST,
      STAGE_TYPE.REVIEW,
    ].map((type) => resolveRuntimeOwnedStageTool(fixedLevel(type))),
    ['dispatch', 'handoff', 'broadcast', 'submit_for_review'],
  )
})

test('a coordinator does not defer an inline runtime-owned transition', () => {
  for (const type of [
    STAGE_TYPE.PIPELINE,
    STAGE_TYPE.CHAIN,
    STAGE_TYPE.BROADCAST,
    STAGE_TYPE.REVIEW,
  ] as const) {
    assert.equal(canRuntimeAutostartInline(fixedLevel(type)), true)
  }
})

test('routing and discussion transitions remain runtime-owned', () => {
  const routing: LevelConfig = {
    id: 'routing',
    name: 'Routing',
    order: 0,
    stage: {
      type: STAGE_TYPE.ROUTING,
      coordinator: 'lead',
      config: {
        output: { format: 'routing-decision.md', user_review: false },
      },
    },
  }
  const discussion: LevelConfig = {
    id: 'discussion',
    name: 'Discussion',
    order: 1,
    stage: {
      type: STAGE_TYPE.DISCUSSION,
      coordinator: 'lead',
      participants: ['reviewer'],
      config: {
        mode: 'deliberate',
        min_rounds: 1,
        max_rounds: 2,
        constraints: { max_time_minutes: 5, max_budget_usd: 1 },
        output: { format: 'discussion.md', user_review: false },
      },
    },
  }

  assert.equal(canRuntimeAutostartInline(routing), true)
  assert.equal(canRuntimeAutostartInline(discussion), true)
})

test('explicit recovery reopens a failed runtime-owned stage before mode-specific execution', () => {
  assert.equal(
    resolveRuntimeRecoveryStageStatus(
      STAGE_LIFECYCLE_STATUS.FAILED,
      true,
    ),
    STAGE_LIFECYCLE_STATUS.READY,
  )
  assert.equal(
    resolveRuntimeRecoveryStageStatus(
      STAGE_LIFECYCLE_STATUS.FAILED,
      false,
    ),
    STAGE_LIFECYCLE_STATUS.FAILED,
  )
  assert.equal(
    resolveRuntimeRecoveryStageStatus(
      STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
      true,
    ),
    STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
  )
})

test('an output review flag does not hand a runtime-owned stage to a host model', () => {
  const level = fixedLevel(STAGE_TYPE.REVIEW)
  assert.equal(level.stage.type, STAGE_TYPE.REVIEW)
  level.stage.config.output.user_review = true

  assert.equal(canRuntimeAutostartInline(level), true)
})

test('a completed source autostart cannot overwrite the destination ownership decision', () => {
  assert.equal(
    resolveRuntimeAutostartOwnership({
      startingLevelId: 'draft',
      activeLevelId: 'discussion',
      started: true,
      activeLevelOwnership: false,
    }),
    false,
  )
  assert.equal(
    resolveRuntimeAutostartOwnership({
      startingLevelId: 'discussion',
      activeLevelId: 'discussion',
      started: true,
      activeLevelOwnership: false,
    }),
    true,
  )
})
