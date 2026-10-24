import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { isLevelReadyForGate } from '../../team-runtime/level-lifecycle.js'
import { isPipelineComplete } from '../../engines/pipeline.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'
import type { LevelConfig } from '../../core/types.js'

test('a blocked pipeline cannot advance from terminal task statuses alone', () => {
  const assignmentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-pipeline-gate-'))
  const planPath = path.join(assignmentPath, 'plan.md')
  try {
    fs.writeFileSync(planPath, `
# Plan: Completed tasks with blocked finalization
**Status:** executing

### S1: Research
#### T1: Collect evidence
- **Agent:** web-researcher
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** research/evidence/T1.json
`)
    const level: LevelConfig = {
      id: 'collect-evidence',
      name: 'Collect Evidence',
      order: 0,
      stage: {
        type: 'pipeline',
        config: {
          parallel: true,
          gate: { type: 'all_tasks_terminal', strictness: 'hard' },
        },
      },
    }
    const ctx = {
      state: {
        levelStates: new Map([[
          level.id,
          {
            status: 'active',
            stageStatus: 'blocked',
            engineState: null,
            loopbackCount: 0,
          },
        ]]),
      },
    } as unknown as RuntimeContext

    assert.equal(isPipelineComplete(planPath), true)
    assert.equal(
      isLevelReadyForGate(level, assignmentPath, ctx, planPath),
      false,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})
