import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseStartConfig } from '../../parsers/start-config.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { listAgents } from '../../domains/agent-generator/list-agents.js'
import { listTeamBuilderTeams } from '../../domains/agent-generator/team-manager.js'
import { loadRegistry as loadWorkflowGeneratorRegistry } from '../../domains/workflow-generator/registry.js'
import { getAutoRegisteredTeamEntries } from '../../domains/runtime/runtime-roster.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'reception-to-writing-e2e')

test('live receptionist remains the runtime entry while hidden from user resource catalogs', () => {
  const start = parseStartConfig(path.join(repoRoot, 'start.yaml'))
  const registry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  const receptionDesk = registry.entries.find((entry) => entry.name === 'reception-desk')
  const receptionTeam = parseTeamConfig(
    path.join(repoRoot, 'teams', 'reception-desk', 'team.yaml'),
  )
  const receptionist = listAgents(repoRoot).find((agent) => agent.name === 'receptionist')
  const visibleTeams = listTeamBuilderTeams(repoRoot)
  const workflowTeams = loadWorkflowGeneratorRegistry(repoRoot).teams

  assert.equal(start.errors.length, 0)
  assert.equal(start.config?.entry, 'reception-desk')
  assert.ok(receptionDesk)
  assert.equal(receptionDesk.tags?.includes('internal'), true)
  assert.equal(receptionTeam.errors.length, 0)
  assert.equal(receptionTeam.config?.workflow?.user_facing, false)
  assert.equal(receptionist?.uiHidden, true)
  assert.equal(
    visibleTeams.some((entry) => entry.id === 'reception-desk'),
    false,
  )
  assert.equal(
    workflowTeams.some((entry) => entry.id === 'reception-desk'),
    false,
  )
})

test('reception-to-writing fixture start.yaml resolves reception-desk entry', () => {
  const startPath = path.join(fixtureRoot, 'start.yaml')
  const parsed = parseStartConfig(startPath)

  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.config?.entry, 'reception-desk')
  assert.equal(parsed.config?.registry, path.join(fixtureRoot, 'teams.yaml'))
})

test('reception-to-writing fixture registry includes receptionist and writing-team entries', () => {
  const registryPath = path.join(fixtureRoot, 'teams.yaml')
  const parsed = parseTeamRegistry(registryPath)

  assert.equal(parsed.errors.length, 0)
  const receptionDesk = parsed.entries.find((entry) => entry.name === 'reception-desk')
  const writingTeam = parsed.entries.find((entry) => entry.name === 'writing-team')

  assert.ok(receptionDesk)
  assert.ok(writingTeam)
  assert.equal(writingTeam?.type, 'team')
  if (writingTeam?.type === 'team') {
    assert.equal(writingTeam.input_artifact, 'incoming-brief.md')
    assert.equal(writingTeam.output_artifact, 'final-draft.md')
  }
})

test('reception-desk fixture enables spawn_team and references writing-team', () => {
  const teamPath = path.join(fixtureRoot, 'teams', 'reception-desk', 'team.yaml')
  const parsed = parseTeamConfig(teamPath)

  assert.equal(parsed.errors.length, 0)
  assert.ok(parsed.config)
  const config = parsed.config!

  assert.equal(config.team.name, 'reception-desk')
  assert.equal(config.composition?.registry_entries?.some((entry) => entry.name === 'writing-team'), true)
  assert.equal(config.levels[0]?.permissions?.spawn_teams, true)
  assert.equal(config.levels[0]?.stage.type, 'routing')
})

test('live reception-desk derives specialist teams from the registry without hardcoding them in team.yaml', () => {
  const teamPath = path.join(repoRoot, 'teams', 'reception-desk', 'team.yaml')
  const parsed = parseTeamConfig(teamPath)

  assert.equal(parsed.errors.length, 0)
  assert.ok(parsed.config)
  const config = parsed.config!
  const registry = new Map((config.composition?.registry_entries ?? []).map((entry) => [entry.name, entry]))
  const autoTeams = getAutoRegisteredTeamEntries(config, registry)

  assert.equal(config.agents.some((agent) => agent.type === 'team'), false)
  assert.equal(config.composition?.registry_entries?.some((entry) => entry.name === 'venture-capital-team'), true)
  assert.equal(autoTeams.some((entry) => entry.name === 'venture-capital-team' && entry.type === 'team'), true)
  assert.equal(autoTeams.some((entry) => entry.name === 'problem-thinking-board'), true)
  assert.equal(autoTeams.some((entry) => entry.name === 'writing-team'), true)
})

test('writing-team fixture parses as chain + review pipeline with stable output artifacts', () => {
  const teamPath = path.join(fixtureRoot, 'teams', 'writing-team', 'team.yaml')
  const parsed = parseTeamConfig(teamPath)

  assert.equal(parsed.errors.length, 0)
  assert.ok(parsed.config)
  const config = parsed.config!

  assert.equal(config.team.name, 'writing-team')
  assert.equal(config.levels.length, 2)
  assert.equal(config.levels[0]?.stage.type, 'chain')
  assert.equal(config.levels[1]?.stage.type, 'review')
  assert.equal(config.gates[0]?.condition.type, 'artifact_exists')
  assert.equal(config.gates[1]?.condition.type, 'artifact_exists')

  const chainStage = config.levels[0]?.stage
  const reviewStage = config.levels[1]?.stage

  if (chainStage.type === 'chain') {
    assert.equal(chainStage.coordinator, undefined)
    assert.equal(chainStage.config.output.path, undefined)
    assert.equal(chainStage.config.output.format, 'draft-package.md')
    assert.equal(chainStage.config.constraints?.agent_timeout_minutes, 2)
  }

  if (reviewStage.type === 'review') {
    assert.equal(reviewStage.coordinator, undefined)
    assert.equal(reviewStage.config.output.path, undefined)
    assert.equal(reviewStage.config.output.format, 'final-draft.md')
    assert.equal(reviewStage.config.constraints?.agent_timeout_minutes, 2)
  }
})
