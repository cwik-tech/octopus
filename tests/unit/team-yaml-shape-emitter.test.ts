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
import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'
import type { TeamShape } from '../../contracts/schemas/team-shape.js'

function withTempRepo(fn: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-emitter-'))
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })
}

function writePersona(repoRoot: string, name: string): void {
  const dir = path.join(repoRoot, 'agents', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    dir + path.sep + `${name}.md`,
    `---\nname: ${name}\ndescription: ${name} persona.\ntier: strategic\n---\n\n# ${name}\n`,
  )
}

function isObject(value: unknown): value is YamlObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Build a generated team with a shape and a roster, and return its saved file. */
async function buildShapedTeam(params: {
  repoRoot: string
  shape: TeamShape
  roster: string[]
}): Promise<{ teamYamlPath: string; yaml: string; stage: YamlObject }> {
  fs.writeFileSync(path.join(params.repoRoot, 'teams.yaml'), '')
  for (const name of params.roster) writePersona(params.repoRoot, name)

  await createTeamBuilderTeam(params.repoRoot, {
    id: 'shaped-team',
    description: 'A shaped team.',
    shape: params.shape,
  })
  const teamYamlPath = path.join(params.repoRoot, 'teams', 'shaped-team', 'team.yaml')
  for (const name of params.roster) {
    await addTeamBuilderAgent({
      repoRoot: params.repoRoot,
      teamId: 'shaped-team',
      agentName: name,
    })
  }
  const yaml = fs.readFileSync(teamYamlPath, 'utf8')
  const raw = parseYaml(yaml)
  const level = Array.isArray(raw.levels) ? raw.levels[0] : undefined
  assert.ok(isObject(level) && isObject(level.stage), yaml)
  return { teamYamlPath, yaml, stage: level.stage }
}

/** Which roster entries declare the generated deliverable. */
function owners(yaml: string): string[] {
  const raw = parseYaml(yaml)
  const agents: YamlValue[] = Array.isArray(raw.agents) ? raw.agents : []
  return agents.flatMap((agent) => {
    if (!isObject(agent) || typeof agent.name !== 'string') return []
    const produces = Array.isArray(agent.produces) ? agent.produces : []
    return produces.some((item) => isObject(item) && item.path === 'final-result.md')
      ? [agent.name]
      : []
  })
}

test('a generated discussion names its coordinator and leaves it out of the participants', async () => {
  await withTempRepo(async (repoRoot) => {
    const { teamYamlPath, yaml, stage } = await buildShapedTeam({
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

    assert.equal(stage.type, 'discussion', yaml)
    assert.equal(stage.coordinator, 'lead', yaml)
    // The coordinator speaks as the coordinator, never also as a participant.
    assert.deepEqual(stage.participants, ['alpha', 'beta'], yaml)
    // Without a declared producer the gate has no owner and the team fails to
    // validate. The runtime self-registers for review only, never here.
    assert.deepEqual(owners(yaml), ['lead'], yaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], yaml)
  })
})

test('discussion depth becomes a bounded round count', async () => {
  await withTempRepo(async (repoRoot) => {
    const { yaml, stage } = await buildShapedTeam({
      repoRoot,
      shape: {
        kind: 'discussion',
        rationale: 'Go deep.',
        depth: 'thorough',
        coordinator: 'lead',
        participants: ['alpha'],
      },
      roster: ['lead', 'alpha'],
    })
    const config = stage.config
    assert.ok(isObject(config), yaml)
    assert.equal(config.max_rounds, 5, yaml)
    assert.equal(config.min_rounds, 1, yaml)
    // `user_review: true` is the parser's default and appends an instruction
    // telling the coordinator to stop and wait for approval.
    const output = config.output
    assert.ok(isObject(output), yaml)
    assert.equal(output.user_review, false, yaml)
  })
})

test('a generated review names both roles and never lets its cap ship an unapproved draft', async () => {
  await withTempRepo(async (repoRoot) => {
    const { teamYamlPath, yaml, stage } = await buildShapedTeam({
      repoRoot,
      shape: {
        kind: 'review',
        rationale: 'One writes, one checks.',
        depth: 'quick',
        producer: 'writer',
        reviewer: 'checker',
      },
      roster: ['writer', 'checker'],
    })

    assert.equal(stage.type, 'review', yaml)
    // Both names, always. The parser accepts a review with neither and the
    // failure surfaces only at run time as "Producer agent '' not found."
    assert.equal(stage.producer, 'writer', yaml)
    assert.equal(stage.reviewer, 'checker', yaml)
    const config = stage.config
    assert.ok(isObject(config), yaml)
    assert.equal(config.max_iterations, 1, yaml)
    // `block` is the engine default and stalls; `approve_latest_with_warnings`
    // publishes a draft no reviewer approved.
    assert.equal(config.on_max_iterations, 'escalate_to_user', yaml)
    // The runtime writes the review artifact, so no agent claims to.
    assert.deepEqual(owners(yaml), [], yaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], yaml)
  })
})

test('a generated chain is unchanged: ordered sequence, last member owns the deliverable', async () => {
  await withTempRepo(async (repoRoot) => {
    const { teamYamlPath, yaml, stage } = await buildShapedTeam({
      repoRoot,
      shape: {
        kind: 'chain',
        rationale: 'One hands to the next.',
        depth: 'standard',
        order: ['alpha', 'beta'],
      },
      roster: ['alpha', 'beta'],
    })

    assert.equal(stage.type, 'chain', yaml)
    assert.deepEqual(stage.sequence, ['alpha', 'beta'], yaml)
    assert.deepEqual(owners(yaml), ['beta'], yaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], yaml)
  })
})

// A stage with no `type:` key parses as a discussion, not a chain
// (`stage-parsers.ts:255`) — and a discussion with no coordinator is a hard
// parse error. Every shape must therefore write `type:` explicitly.
test('every emitted shape writes its stage type explicitly', async () => {
  const shapes: TeamShape[] = [
    { kind: 'chain', rationale: 'r', depth: 'quick', order: ['alpha'] },
    {
      kind: 'discussion', rationale: 'r', depth: 'quick',
      coordinator: 'alpha', participants: ['beta'],
    },
    {
      kind: 'review', rationale: 'r', depth: 'quick',
      producer: 'alpha', reviewer: 'beta',
    },
  ]
  for (const shape of shapes) {
    await withTempRepo(async (repoRoot) => {
      const roster = shape.kind === 'chain' ? ['alpha'] : ['alpha', 'beta']
      const { yaml } = await buildShapedTeam({ repoRoot, shape, roster })
      assert.match(yaml, /^\s+type: \w+$/mu, yaml)
    })
  }
})

// An omitted shape is the pre-shape contract: today's chain, unchanged.
test('a team created without a shape still emits the default chain', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    writePersona(repoRoot, 'alpha')
    await createTeamBuilderTeam(repoRoot, {
      id: 'unshaped-team',
      description: 'No shape chosen.',
    })
    const teamYamlPath = path.join(repoRoot, 'teams', 'unshaped-team', 'team.yaml')
    await addTeamBuilderAgent({ repoRoot, teamId: 'unshaped-team', agentName: 'alpha' })
    const yaml = fs.readFileSync(teamYamlPath, 'utf8')
    const raw = parseYaml(yaml)
    const level = Array.isArray(raw.levels) ? raw.levels[0] : undefined
    assert.ok(isObject(level) && isObject(level.stage), yaml)
    assert.equal(level.stage.type, 'chain', yaml)
    assert.deepEqual(level.stage.sequence, ['alpha'], yaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], yaml)
  })
})

// The user picks an order, or picks a coordinator, and the build must honour it.
// Membership arriving from the roster in insertion order is how a chosen
// topology quietly becomes whatever order the agents happened to be added in.
test('a chain runs in the order the shape chose, not the order agents were added', async () => {
  await withTempRepo(async (repoRoot) => {
    const { teamYamlPath, yaml, stage } = await buildShapedTeam({
      repoRoot,
      shape: {
        kind: 'chain',
        rationale: 'Beta drafts, alpha refines.',
        depth: 'standard',
        order: ['beta', 'alpha'],
      },
      // Added alpha first, then beta. The shape says the opposite.
      roster: ['alpha', 'beta'],
    })

    assert.deepEqual(stage.sequence, ['beta', 'alpha'], yaml)
    // The last member of the chosen order owns the deliverable, not the last
    // one added.
    assert.deepEqual(owners(yaml), ['alpha'], yaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], yaml)
  })
})

test('a discussion convenes participants in the order the shape chose', async () => {
  await withTempRepo(async (repoRoot) => {
    const { teamYamlPath, yaml, stage } = await buildShapedTeam({
      repoRoot,
      shape: {
        kind: 'discussion',
        rationale: 'Beta opens, alpha answers.',
        depth: 'standard',
        coordinator: 'lead',
        participants: ['beta', 'alpha'],
      },
      roster: ['lead', 'alpha', 'beta'],
    })

    // Order is load-bearing here: `engines/discussion.ts:790` dispatches
    // participants in list order and each one reads what the earlier ones said.
    assert.deepEqual(stage.participants, ['beta', 'alpha'], yaml)
    assert.deepEqual(owners(yaml), ['lead'], yaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], yaml)
  })
})
