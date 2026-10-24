import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { requiredValue } from '../../core/required-value.js'
import type { TeamConfig } from '../../core/types.js'
import { buildDelegatedRoutingAutostartPlan } from '../../domains/delegation/delegated-routing-autostart.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'
import {
  readRuntimeAutostartInput,
  resolveRuntimeAutostartOutputOverride,
} from '../../domains/stage/runtime-autostart-input.js'
import { isLevelReadyForGate } from '../../team-runtime/level-lifecycle.js'

function makeTeamConfig(workspacePath: string): TeamConfig {
  return {
    team: { name: 'later-discussion', description: 'Input handoff fixture.', version: '1.0.0' },
    workspace: { path: workspacePath, watch: false },
    defaults: {},
    agents: [],
    levels: [
      {
        id: 'draft',
        name: 'Draft',
        order: 0,
        stage: {
          type: 'chain',
          sequence: ['writer'],
          config: {
            output: { format: 'draft.md', user_review: false },
          },
        },
      },
      {
        id: 'discussion',
        name: 'Discussion',
        order: 1,
        stage: {
          type: 'discussion',
          coordinator: 'lead',
          participants: ['reviewer'],
          config: {
            mode: 'deliberate',
            min_rounds: 1,
            max_rounds: 2,
            constraints: { max_time_minutes: 5, max_budget_usd: 1 },
            output: { format: 'review.md', user_review: false },
          },
        },
      },
    ],
    gates: [],
    workflow: {
      entry_level: 'draft',
      input_contract: {
        artifacts: [{ path: 'incoming-brief.md', required: true }],
      },
    },
  }
}

function makeRoutingTeamConfig(workspacePath: string): TeamConfig {
  return {
    team: { name: 'routing-review', description: 'Routing output fixture.', version: '1.0.0' },
    workspace: { path: workspacePath, watch: false },
    defaults: {},
    agents: [],
    levels: [
      {
        id: 'route',
        name: 'Route',
        order: 0,
        stage: {
          type: 'routing',
          coordinator: 'lead',
          config: {
            output: { format: 'route.md', user_review: false },
          },
        },
      },
      {
        id: 'review',
        name: 'Review',
        order: 1,
        stage: {
          type: 'review',
          producer: 'writer',
          reviewer: 'editor',
          config: {
            max_iterations: 2,
            output: { format: 'final-result.md', user_review: false },
          },
        },
      },
    ],
    gates: [],
    workflow: {
      entry_level: 'route',
      output_contract: {
        artifacts: [{ path: 'final-result.md', required: true }],
        completion_artifact: 'final-result.md',
      },
    },
  }
}

test('runtime autostart gives a later lead the previous stage output, not the original run input', () => {
  const assignmentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-stage-input-'))
  try {
    fs.writeFileSync(path.join(assignmentPath, 'incoming-brief.md'), 'ORIGINAL REQUEST')
    fs.writeFileSync(path.join(assignmentPath, 'draft.md'), 'PREVIOUS STAGE OUTPUT')
    const teamConfig = makeTeamConfig(assignmentPath)
    const entryLevel = requiredValue(teamConfig.levels[0], 'entry level')
    const laterLevel = requiredValue(teamConfig.levels[1], 'later level')

    assert.equal(
      readRuntimeAutostartInput({
        assignmentPath,
        teamConfig,
        level: entryLevel,
        delegatedInputArtifact: 'incoming-brief.md',
      }),
      'ORIGINAL REQUEST',
    )
    assert.equal(
      readRuntimeAutostartInput({
        assignmentPath,
        teamConfig,
        level: laterLevel,
        delegatedInputArtifact: 'incoming-brief.md',
      }),
      'PREVIOUS STAGE OUTPUT',
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('runtime autostart does not give an entry routing stage the terminal stage output', () => {
  const teamConfig = makeRoutingTeamConfig('/tmp/routing-review')
  const routingLevel = requiredValue(teamConfig.levels[0], 'routing level')

  assert.equal(
    resolveRuntimeAutostartOutputOverride({
      teamConfig,
      level: routingLevel,
      delegatedOutputArtifact: 'final-result.md',
    }),
    undefined,
  )
})

test('runtime autostart accepts the delegated output when routing is the terminal stage', () => {
  const teamConfig = makeRoutingTeamConfig('/tmp/single-routing')
  const routingLevel = requiredValue(teamConfig.levels[0], 'routing level')
  teamConfig.levels = [routingLevel]

  assert.equal(
    resolveRuntimeAutostartOutputOverride({
      teamConfig,
      level: routingLevel,
      delegatedOutputArtifact: 'final-result.md',
    }),
    'final-result.md',
  )
})

test('terminal routing is ready after runtime writes its effective completion artifact', () => {
  const assignmentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-routing-output-'))
  try {
    const teamConfig = makeRoutingTeamConfig(assignmentPath)
    const routingLevel = requiredValue(teamConfig.levels[0], 'routing level')
    teamConfig.levels = [routingLevel]
    const outputOverride = resolveRuntimeAutostartOutputOverride({
      teamConfig,
      level: routingLevel,
      delegatedOutputArtifact: 'final-result.md',
    })
    const plan = buildDelegatedRoutingAutostartPlan(
      teamConfig,
      routingLevel,
      '# Request\n\nRoute this work.',
      [],
      outputOverride,
    )
    fs.writeFileSync(path.join(assignmentPath, plan.outputArtifact), 'Routing complete.')
    const ctx = {
      teamConfig,
      state: { levelStates: new Map() },
    } as RuntimeContext

    assert.equal(plan.outputArtifact, 'final-result.md')
    assert.equal(isLevelReadyForGate(routingLevel, assignmentPath, ctx), true)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})
