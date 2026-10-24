import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STAGE_TYPE, LEVEL_STATUS, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import type { RuntimeState, TeamConfig } from '../../core/types.js'

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    runAgent: mock.fn(async () => ({
      text: '## Executive Summary\n\n- Summary generated.',
      cost: 0.25,
      durationMs: 10,
      inputTokens: 10,
      outputTokens: 10,
      contextTokens: 20,
      model: 'test-model',
    })),
  },
})

const { generateMinutes } = await import('../../domains/agent-execution/minutes.js')
const { setRuntimeDefaultModelState } = await import(
  '../../domains/provider/default-model-selection.js'
)

test('minutes header includes the completed summarization cost', async () => {
  const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-cost-test-'))
  // The template the helper reads is staged by `tests/run-tests.mjs`, where the
  // compiled tree is built. This test used to create and then recursively
  // remove that shared directory, which any other suite reading it could lose
  // underneath itself. Asserted rather than created: a missing template makes
  // minutes fall back mechanically, and mechanical minutes cost nothing — which
  // is the wrong thing for a test about cost to be measuring.
  const compiledTemplatePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'examples',
    'minutes-template.md',
  )
  assert.ok(
    fs.existsSync(compiledTemplatePath),
    `the minutes template must be readable at ${compiledTemplatePath}`,
  )
  const teamConfig: TeamConfig = {
    team: { name: 'Test Team', description: 'Test team', version: '1.0.0' },
    workspace: { path: outputPath, watch: false },
    gates: [],
    agents: [],
    levels: [{
      id: 'discussion',
      name: 'Discussion',
      order: 1,
      stage: {
        type: STAGE_TYPE.DISCUSSION,
        coordinator: 'facilitator',
        participants: ['analyst'],
        config: {
          mode: 'deliberate',
          min_rounds: 1,
          max_rounds: 1,
          constraints: { max_time_minutes: 1, max_budget_usd: 2 },
          output: { format: 'discussion.md', user_review: false },
        },
      },
    }],
  }
  const runtimeState: RuntimeState = {
    sessionId: 'minutes-cost-session',
    currentLevelIndex: 0,
    levelStates: new Map([['discussion', {
      status: LEVEL_STATUS.COMPLETED,
      stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
      engineState: {
        type: STAGE_TYPE.DISCUSSION,
        round: 1,
        messages: [{
          from: 'analyst',
          to: 'facilitator',
          round: 1,
          timestamp: new Date().toISOString(),
          type: 'position',
          message: 'The selected approach is ready.',
        }],
        outputPath,
      },
      loopbackCount: 0,
    }]]),
    totalCost: 1,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }

  // Stated, because there is no implicit model any more: writing minutes owns
  // no Agent, so it uses the one application default or writes them
  // mechanically — and mechanical minutes cost nothing, which is the wrong
  // thing for a test about cost to be measuring.
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'connection:minutes-fixture',
    model: 'app-default-minutes-model',
  })
  try {
    const minutes = await generateMinutes(teamConfig, runtimeState, outputPath)

    assert.equal(runtimeState.totalCost, 1.25)
    assert.match(minutes, /\*\*Cost:\*\* \$1\.25/)
    assert.match(fs.readFileSync(path.join(outputPath, 'minutes.md'), 'utf8'), /\*\*Cost:\*\* \$1\.25/)
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
    fs.rmSync(outputPath, { recursive: true, force: true })
  }
})
