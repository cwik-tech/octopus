import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseStartConfig } from '../../parsers/start-config.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { parseTeamConfig } from '../../parsers/team-config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'writing-template-validator-e2e')

test('writing-template-validator fixture start.yaml resolves reception-desk entry', () => {
  const startPath = path.join(fixtureRoot, 'start.yaml')
  const parsed = parseStartConfig(startPath)

  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.config?.entry, 'reception-desk')
  assert.equal(parsed.config?.registry, path.join(fixtureRoot, 'teams.yaml'))
})

test('writing-template-validator fixture registry includes reception-desk and writing-team entries', () => {
  const registryPath = path.join(fixtureRoot, 'teams.yaml')
  const parsed = parseTeamRegistry(registryPath)

  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.entries.some((entry) => entry.name === 'reception-desk'), true)
  const writingEntry = parsed.entries.find((entry) => entry.name === 'writing-team')
  assert.ok(writingEntry)
  if (writingEntry?.type === 'team') {
    assert.equal(writingEntry.input_artifact, 'incoming-brief.md')
    assert.equal(writingEntry.output_artifact, 'final-draft.md')
  }
})

test('writing-template-validator writing-team fixture includes the executive-summary template contract', () => {
  const teamPath = path.join(fixtureRoot, 'teams', 'writing-team', 'team.yaml')
  const parsed = parseTeamConfig(teamPath)

  assert.equal(parsed.errors.length, 0)
  assert.ok(parsed.config)
  const config = parsed.config!

  assert.equal(config.team.name, 'writing-team')
  assert.equal(config.levels[0]?.stage.type, 'chain')
  assert.equal(config.levels[1]?.stage.type, 'review')
  if (config.levels[1]?.stage.type === 'review') {
    assert.equal(config.levels[1].stage.config.max_iterations, 2)
    assert.equal(config.levels[1].stage.config.on_max_iterations, 'block')
  }
})
