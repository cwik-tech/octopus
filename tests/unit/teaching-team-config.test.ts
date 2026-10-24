import assert from 'node:assert/strict'
import * as path from 'node:path'
import test from 'node:test'

import { parseTeamConfig } from '../../parsers/team-config.js'

/**
 * The teaching team is a review board: one lead convenes the specialists whose
 * perspective the manual actually needs. A chain would run every agent in a
 * fixed order and would list the lead among its own peers, which is what the
 * Run sidebar then showed.
 */
test('the teaching team deliberates under one lead that is never also a participant', () => {
  const parsed = parseTeamConfig(
    path.join(process.cwd(), 'teams', 'teaching-team', 'team.yaml'),
  )
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.config)

  const config = parsed.config
  const entryLevel = config.levels.find(
    (level) => level.id === config.workflow?.entry_level,
  )
  assert.ok(entryLevel, 'the declared entry level must exist')
  if (entryLevel.stage.type !== 'discussion') {
    assert.fail(`teaching-team entry stage must be a discussion, got ${entryLevel.stage.type}`)
  }

  assert.equal(entryLevel.stage.coordinator, 'teaching-team-lead')
  assert.deepEqual(entryLevel.stage.participants, [
    'brief-builder',
    'editor',
    'teaching-pedagogy-specialist',
    'subject-matter-technical-reviewer',
  ])
  assert.equal(entryLevel.stage.config.min_rounds, 2)
  assert.equal(entryLevel.stage.config.max_rounds, 6)
  assert.ok(
    !entryLevel.stage.participants.includes('teaching-team-lead'),
    'the lead must not also be dispatched as a participant',
  )
})
