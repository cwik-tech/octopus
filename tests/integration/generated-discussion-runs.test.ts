/**
 * What the runtime receives when it loads a generated team.
 *
 * The engine unit tests build a `DiscussionStageConfig` by hand, so they prove
 * nothing about what the emitter writes. This one starts from the real create
 * and add paths, loads the saved file with `parseTeamConfig` — the same
 * function the runtime loads a team with — and asserts on the stage the engine
 * would actually be handed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addTeamBuilderAgent,
  createTeamBuilderTeam,
} from '../../domains/agent-generator/team-manager.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { STAGE_TYPE } from '../../core/constants.js'
import type { TeamConfig } from '../../core/types.js'
import type { TeamShape } from '../../contracts/schemas/team-shape.js'

function withTempRepo(fn: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-runs-'))
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })
}

async function loadGeneratedTeam(params: {
  repoRoot: string
  shape: TeamShape
  roster: string[]
}): Promise<TeamConfig> {
  fs.writeFileSync(path.join(params.repoRoot, 'teams.yaml'), '')
  for (const name of params.roster) {
    const dir = path.join(params.repoRoot, 'agents', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} persona.\ntier: strategic\n---\n\n# ${name}\n`,
    )
  }
  await createTeamBuilderTeam(params.repoRoot, {
    id: 'runnable-team',
    description: 'A runnable generated team.',
    shape: params.shape,
  })
  for (const name of params.roster) {
    await addTeamBuilderAgent({
      repoRoot: params.repoRoot,
      teamId: 'runnable-team',
      agentName: name,
    })
  }
  const teamYamlPath = path.join(params.repoRoot, 'teams', 'runnable-team', 'team.yaml')
  const result = parseTeamConfig(teamYamlPath)
  assert.deepEqual(result.errors, [], fs.readFileSync(teamYamlPath, 'utf8'))
  assert.ok(result.config, 'the generated team did not parse into a config')
  return result.config
}

test('the runtime is handed a discussion whose roster matches the team it was built from', async () => {
  await withTempRepo(async (repoRoot) => {
    const config = await loadGeneratedTeam({
      repoRoot,
      shape: {
        kind: 'discussion',
        rationale: 'They disagree usefully.',
        depth: 'standard',
        coordinator: 'lead',
        participants: ['alpha', 'beta'],
      },
      roster: ['lead', 'alpha', 'beta'],
    })

    const level = config.levels[0]
    assert.ok(level, 'the generated team has no entry level')
    const stage = level.stage
    assert.equal(stage.type, STAGE_TYPE.DISCUSSION)
    assert.ok(stage.type === STAGE_TYPE.DISCUSSION)
    assert.equal(stage.coordinator, 'lead')
    // Every member the user put on the roster is convened, and the
    // coordinator is not convened twice.
    assert.deepEqual(stage.participants, ['alpha', 'beta'])
    assert.equal(stage.config.max_rounds, 3)
    assert.equal(stage.config.min_rounds, 1)
    // The gate's artifact has a declared producer, or the run cannot pass it.
    const producers = config.agents
      .filter((agent) => agent.produces?.some((item) => item.path === 'final-result.md'))
      .map((agent) => agent.name)
    assert.deepEqual(producers, ['lead'])
  })
})

test('the runtime is handed a review with both roles filled and a cap that does not stall', async () => {
  await withTempRepo(async (repoRoot) => {
    const config = await loadGeneratedTeam({
      repoRoot,
      shape: {
        kind: 'review',
        rationale: 'One writes, one checks.',
        depth: 'thorough',
        producer: 'writer',
        reviewer: 'checker',
      },
      roster: ['writer', 'checker'],
    })

    const level = config.levels[0]
    assert.ok(level, 'the generated team has no entry level')
    const stage = level.stage
    assert.equal(stage.type, STAGE_TYPE.REVIEW)
    assert.ok(stage.type === STAGE_TYPE.REVIEW)
    // A review with an empty producer parses clean and fails only at run time,
    // as "Producer agent '' not found." Both names must survive the parser.
    assert.equal(stage.producer, 'writer')
    assert.equal(stage.reviewer, 'checker')
    assert.equal(stage.config.max_iterations, 5)
    assert.equal(stage.config.on_max_iterations, 'escalate_to_user')
  })
})

test('a generated chain still reaches the runtime as an ordered sequence', async () => {
  await withTempRepo(async (repoRoot) => {
    const config = await loadGeneratedTeam({
      repoRoot,
      shape: {
        kind: 'chain',
        rationale: 'One hands to the next.',
        depth: 'quick',
        order: ['alpha', 'beta'],
      },
      roster: ['alpha', 'beta'],
    })

    const level = config.levels[0]
    assert.ok(level, 'the generated team has no entry level')
    const stage = level.stage
    assert.equal(stage.type, STAGE_TYPE.CHAIN)
    assert.ok(stage.type === STAGE_TYPE.CHAIN)
    assert.deepEqual(stage.sequence, ['alpha', 'beta'])
  })
})
