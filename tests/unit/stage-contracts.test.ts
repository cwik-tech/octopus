import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  deriveEffectiveStageContracts,
  deriveEffectiveStageContractsForTeam,
  deriveEffectiveWorkflowTemplateContracts,
} from '../../domains/stage/stage-contracts.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { STAGE_TYPE } from '../../core/constants.js'
import type { LevelConfig } from '../../core/types.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-contracts-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function makeChainLevel(id: string, format: string): LevelConfig {
  return {
    id,
    name: id,
    order: 0,
    stage: {
      type: STAGE_TYPE.CHAIN,
      coordinator: 'editor',
      sequence: ['writer'],
      config: {
        output: { format, user_review: false },
      },
    },
  }
}

function makeReviewLevel(id: string, format: string): LevelConfig {
  return {
    id,
    name: id,
    order: 1,
    stage: {
      type: STAGE_TYPE.REVIEW,
      coordinator: 'editor',
      producer: 'writer',
      reviewer: 'editor',
      config: {
        max_iterations: 3,
        output: { format, user_review: false },
      },
    },
  }
}

test('parseTeamConfig parses explicit stage input/output contracts', () => {
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: contract-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: review
      coordinator: alpha
      producer: alpha
      reviewer: alpha
      config:
        max_iterations: 2
        output:
          format: output.md
        input_contract:
          artifacts:
            - path: brief.md
              required: true
              description: Upstream brief
          structured:
            schema: schemas/review-input.json
            description: Review input envelope
        output_contract:
          artifacts:
            - path: output.md
              required: true
              description: Reviewed output
          structured:
            schema: schemas/review-output.json
            description: Review output envelope
          completion_artifact: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.errors.length, 0)
    assert.ok(result.config)

    const level = result.config!.levels[0]
    if (requiredValue(level, 'tests/unit/stage-contracts.test.ts:119').stage.type !== STAGE_TYPE.REVIEW) throw new Error('Expected review stage')

    assert.equal(requiredValue(level, 'tests/unit/stage-contracts.test.ts:121').stage.config.input_contract?.artifacts?.[0]?.path, 'brief.md')
    assert.equal(requiredValue(level, 'tests/unit/stage-contracts.test.ts:122').stage.config.input_contract?.artifacts?.[0]?.required, true)
    assert.equal(requiredValue(level, 'tests/unit/stage-contracts.test.ts:123').stage.config.input_contract?.structured?.schema, 'schemas/review-input.json')
    assert.equal(requiredValue(level, 'tests/unit/stage-contracts.test.ts:124').stage.config.output_contract?.artifacts?.[0]?.path, 'output.md')
    assert.equal(requiredValue(level, 'tests/unit/stage-contracts.test.ts:125').stage.config.output_contract?.structured?.schema, 'schemas/review-output.json')
    assert.equal(requiredValue(level, 'tests/unit/stage-contracts.test.ts:126').stage.config.output_contract?.completion_artifact, 'output.md')
  })
})

test('parseTeamConfig parses explicit workflow template contracts and metadata', () => {
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: contract-team
workflow:
  entry_level: l1
  capabilities:
    - writing
    - editing
  invocation_modes:
    - user
    - team
  user_facing: true
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
  output_contract:
    artifacts:
      - path: final-report.md
        required: true
    completion_artifact: final-report.md
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: final-report.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: chain
      coordinator: alpha
      sequence:
        - alpha
      config:
        output:
          format: final-report.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: final-report.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.errors.length, 0)
    assert.ok(result.config)
    assert.equal(result.config!.workflow?.entry_level, 'l1')
    assert.deepEqual(result.config!.workflow?.capabilities, ['writing', 'editing'])
    assert.deepEqual(result.config!.workflow?.invocation_modes, ['user', 'team'])
    assert.equal(result.config!.workflow?.user_facing, true)
    assert.equal(result.config!.workflow?.input_contract?.artifacts?.[0]?.path, 'incoming-brief.md')
    assert.equal(result.config!.workflow?.output_contract?.completion_artifact, 'final-report.md')
  })
})

test('deriveEffectiveStageContracts falls back to previous output and current output format', () => {
  const levels = [
    makeChainLevel('brief-and-draft', 'draft-package.md'),
    makeReviewLevel('editorial-review', 'final-draft.md'),
  ]

  const contracts = deriveEffectiveStageContracts(levels, 'editorial-review')

  assert.equal(contracts.input.artifacts?.[0]?.path, 'draft-package.md')
  assert.equal(contracts.output.artifacts?.[0]?.path, 'final-draft.md')
  assert.equal(contracts.output.completion_artifact, 'final-draft.md')
})

test('deriveEffectiveStageContracts preserves configured output.path between stages', () => {
  const levels: LevelConfig[] = [
    {
      id: 'deliberation',
      name: 'Deliberation',
      order: 0,
      stage: {
        type: STAGE_TYPE.DISCUSSION,
        coordinator: 'editor',
        participants: ['writer'],
        config: {
          mode: 'deliberate',
          min_rounds: 1,
          max_rounds: 2,
          constraints: { max_time_minutes: 1, max_budget_usd: 1 },
          output: { path: 'output', format: 'minutes.md', user_review: false },
        },
      },
    },
    {
      id: 'memo-synthesis',
      name: 'Memo Synthesis',
      order: 1,
      stage: {
        type: STAGE_TYPE.CHAIN,
        coordinator: 'editor',
        sequence: ['writer'],
        config: {
          output: { path: 'output', format: 'investment-memo.md', user_review: false },
        },
      },
    },
  ]

  const contracts = deriveEffectiveStageContracts(levels, 'memo-synthesis')

  assert.equal(contracts.input.artifacts?.[0]?.path, 'output/minutes.md')
  assert.equal(contracts.output.artifacts?.[0]?.path, 'output/investment-memo.md')
  assert.equal(contracts.output.completion_artifact, 'output/investment-memo.md')
})

test('deriveEffectiveStageContracts merges declared and derived output artifacts without duplicates', () => {
  const reviewLevel = makeReviewLevel('editorial-review', 'final-draft.md')
  if (reviewLevel.stage.type !== STAGE_TYPE.REVIEW) throw new Error('Expected review stage')
  reviewLevel.stage.config.output_contract = {
    artifacts: [
      { path: 'final-draft.md', required: true },
      { path: 'review-summary.md', required: false },
    ],
    completion_artifact: 'final-draft.md',
  }

  const levels = [
    makeChainLevel('brief-and-draft', 'draft-package.md'),
    reviewLevel,
  ]

  const contracts = deriveEffectiveStageContracts(levels, 'editorial-review')
  assert.deepEqual(
    contracts.output.artifacts?.map((artifact) => artifact.path),
    ['final-draft.md', 'review-summary.md'],
  )
})

test('deriveEffectiveStageContractsForTeam merges workflow input artifacts into the entry level', () => {
  const levels = [
    makeChainLevel('brief-and-draft', 'draft-package.md'),
    makeReviewLevel('editorial-review', 'final-draft.md'),
  ]

  const teamConfig = {
    team: { name: 'writing-team', description: 'Writing team', version: '0.1.0' },
    workspace: { path: '/tmp/workspace', watch: false },
    workflow: {
      entry_level: 'brief-and-draft',
      input_contract: {
        artifacts: [
          { path: 'incoming-brief.md', required: true },
        ],
      },
      output_contract: {
        artifacts: [
          { path: 'final-draft.md', required: true },
        ],
        completion_artifact: 'final-draft.md',
      },
    },
    models: {
      orchestration: { model: 'gpt-5.4-mini', thinking: 'medium' as const },
      strategic: { model: 'gpt-5.4-mini', thinking: 'medium' as const },
      execution: { model: 'gpt-5.4-mini', thinking: 'low' as const },
    },
    levels,
    gates: [
      {
        from: 'editorial-review',
        to: 'done',
        condition: { type: 'artifact_exists' as const, artifact: 'final-draft.md' },
      },
    ],
    agents: [],
  }

  const entryContracts = deriveEffectiveStageContractsForTeam(teamConfig as any, 'brief-and-draft')
  assert.deepEqual(
    entryContracts.input.artifacts?.map((artifact) => artifact.path),
    ['incoming-brief.md'],
  )

  const terminalContracts = deriveEffectiveStageContractsForTeam(teamConfig as any, 'editorial-review')
  assert.equal(terminalContracts.output.completion_artifact, 'final-draft.md')
  assert.deepEqual(
    terminalContracts.output.artifacts?.map((artifact) => artifact.path),
    ['final-draft.md'],
  )
})

test('deriveEffectiveWorkflowTemplateContracts falls back to stage graph entry and terminal gate output', () => {
  const levels = [
    makeChainLevel('brief-and-draft', 'draft-package.md'),
    makeReviewLevel('editorial-review', 'final-draft.md'),
  ]

  const teamConfig = {
    team: { name: 'writing-team', description: 'Writing team', version: '0.1.0' },
    workspace: { path: '/tmp/workspace', watch: false },
    models: {
      orchestration: { model: 'gpt-5.4-mini', thinking: 'medium' as const },
      strategic: { model: 'gpt-5.4-mini', thinking: 'medium' as const },
      execution: { model: 'gpt-5.4-mini', thinking: 'low' as const },
    },
    levels,
    gates: [
      {
        from: 'editorial-review',
        to: 'done',
        condition: { type: 'artifact_exists' as const, artifact: 'final-draft.md' },
      },
    ],
    agents: [],
  }

  const contracts = deriveEffectiveWorkflowTemplateContracts(teamConfig)
  assert.equal(contracts.entry_level, 'brief-and-draft')
  assert.equal(contracts.input.artifacts, undefined)
  assert.equal(contracts.output.completion_artifact, 'final-draft.md')
  assert.equal(contracts.output.artifacts?.[0]?.path, 'final-draft.md')
})

test('parseTeamConfig errors when output_contract completion_artifact is not declared', () => {
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: invalid-contract-team
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: chain
      coordinator: alpha
      sequence:
        - alpha
      config:
        output:
          format: output.md
        output_contract:
          artifacts:
            - path: review.md
          completion_artifact: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    assert.match(result.errors.join('\n'), /completion_artifact 'output\.md' is not declared/)
  })
})

test('parseTeamConfig errors when workflow entry_level is unknown', () => {
  withTempDir((dir) => {
    const agentDir = path.join(dir, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')

    fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: invalid-workflow-team
workflow:
  entry_level: missing-level
agents:
  - name: alpha
    type: agent
    role: test agent
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: chain
      coordinator: alpha
      sequence:
        - alpha
      config:
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.equal(result.config, null)
    assert.match(result.errors.join('\n'), /Workflow template entry_level 'missing-level' does not match any declared level/)
  })
})
