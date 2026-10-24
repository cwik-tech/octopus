/**
 * The server, not the model, owns the Team revision an update proposal is
 * pinned to. The revision is a deterministic digest of the exact registered
 * `team.yaml` bytes, so a Team edited between proposal and apply no longer
 * matches the revision the plan recorded.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { computeTeamRevision } from '../../domains/resource-architect/resource-revision.js'

/**
 * Known-literal expectation. The digest below was produced once, outside the
 * implementation, from exactly these bytes; the test must not recompute it
 * with the production algorithm.
 */
const FIXTURE_TEAM_YAML =
  'team:\n  name: "revision-fixture-team"\nagents: []\nlevels: []\n'
const FIXTURE_TEAM_REVISION =
  'sha256:b17e9c9494817fd26c0f00aaf02f20f64b95a50f89ab0f90161a654719231ab1'

function makeRepoWithTeam(teamId: string, yaml: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-revision-'))
  const teamDir = path.join(repoRoot, 'teams', teamId)
  fs.mkdirSync(teamDir, { recursive: true })
  fs.writeFileSync(path.join(teamDir, 'team.yaml'), yaml)
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    [
      `${teamId}:`,
      '  type: team',
      '  description: Revision fixture.',
      `  team_path: ./teams/${teamId}`,
      '  tags: []',
      '',
    ].join('\n'),
  )
  return repoRoot
}

test('a Team revision is a sha256 digest of the exact registered team.yaml bytes', () => {
  const repoRoot = makeRepoWithTeam('revision-fixture-team', FIXTURE_TEAM_YAML)
  try {
    assert.equal(
      computeTeamRevision(repoRoot, 'revision-fixture-team'),
      FIXTURE_TEAM_REVISION,
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('a Team revision changes when any byte of team.yaml changes', () => {
  const repoRoot = makeRepoWithTeam('revision-fixture-team', FIXTURE_TEAM_YAML)
  try {
    const before = computeTeamRevision(repoRoot, 'revision-fixture-team')
    fs.writeFileSync(
      path.join(repoRoot, 'teams', 'revision-fixture-team', 'team.yaml'),
      `${FIXTURE_TEAM_YAML}# a later edit\n`,
    )
    const after = computeTeamRevision(repoRoot, 'revision-fixture-team')

    assert.equal(before, FIXTURE_TEAM_REVISION)
    assert.notEqual(after, before)
    assert.match(after, /^sha256:[0-9a-f]{64}$/)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('an unregistered Team has no revision', () => {
  const repoRoot = makeRepoWithTeam('revision-fixture-team', FIXTURE_TEAM_YAML)
  try {
    assert.throws(
      () => computeTeamRevision(repoRoot, 'no-such-team'),
      /no-such-team/,
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})
