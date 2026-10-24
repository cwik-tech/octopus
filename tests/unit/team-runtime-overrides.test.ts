import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTeamConfig } from '../../parsers/team-config.js'
import { applyTeamRuntimeOverrides } from '../../core/team-runtime-overrides.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')

test('applyTeamRuntimeOverrides narrows the live discussion board and shortens the review loop', () => {
  const board = parseTeamConfig(path.join(repoRoot, 'teams', 'problem-thinking-board', 'team.yaml'))
  const writing = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))

  assert.ok(board.config)
  assert.ok(writing.config)

  const boardErrors = applyTeamRuntimeOverrides(board.config!, {
    levels: {
      deliberation: {
        discussion: {
          participants: ['contrarian', 'pragmatist', 'domain-researcher'],
          min_rounds: 1,
          max_rounds: 1,
          min_successful_participants: 2,
        },
      },
    },
  })

  const writingErrors = applyTeamRuntimeOverrides(writing.config!, {
    levels: {
      'editorial-review': {
        review: {
          max_iterations: 1,
        },
      },
    },
  })

  assert.deepEqual(boardErrors, [])
  assert.deepEqual(writingErrors, [])

  const boardLevel = board.config!.levels.find((level) => level.id === 'deliberation')
  const reviewLevel = writing.config!.levels.find((level) => level.id === 'editorial-review')

  assert.ok(boardLevel?.stage.type === 'discussion')
  assert.ok(reviewLevel?.stage.type === 'review')

  if (boardLevel?.stage.type === 'discussion') {
    assert.deepEqual(boardLevel.stage.participants, ['contrarian', 'pragmatist', 'domain-researcher'])
    assert.equal(boardLevel.stage.config.min_rounds, 1)
    assert.equal(boardLevel.stage.config.max_rounds, 1)
    assert.equal(boardLevel.stage.config.min_successful_participants, 2)
  }

  if (reviewLevel?.stage.type === 'review') {
    assert.equal(reviewLevel.stage.config.max_iterations, 1)
  }
})

test('applyTeamRuntimeOverrides isolates a selected team stage', () => {
  const writing = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))
  assert.ok(writing.config)

  const errors = applyTeamRuntimeOverrides(writing.config!, {
    stage_type: 'chain',
  })

  assert.deepEqual(errors, [])
  assert.equal(writing.config!.workflow?.entry_level, 'brief-and-draft')
  assert.equal(writing.config!.levels.length, 1)
  assert.equal(writing.config!.gates.length, 1)
  assert.deepEqual(writing.config!.gates[0], {
    from: 'brief-and-draft',
    to: 'done',
    condition: { type: 'artifact_exists', artifact: 'draft-package.md' },
  })
  assert.equal(
    writing.config!.workflow?.output_contract?.completion_artifact,
    'draft-package.md',
  )
  const level = writing.config!.levels[0]
  assert.equal(level?.stage.type, 'chain')
  if (level?.stage.type === 'chain') {
    assert.deepEqual(level.stage.sequence, ['brief-builder', 'writer'])
  }
})

test('applyTeamRuntimeOverrides rejects unavailable stages', () => {
  const writing = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))
  assert.ok(writing.config)

  const errors = applyTeamRuntimeOverrides(writing.config!, {
    stage_type: 'discussion',
  })

  assert.ok(errors.some((error) => error.includes("unavailable stage type 'discussion'")))
})
