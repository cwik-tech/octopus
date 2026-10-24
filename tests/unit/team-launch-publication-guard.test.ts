/**
 * A team that is still being built cannot be launched.
 *
 * Filtering the catalogs stops it being offered. It does not stop a launch by
 * id — a workflow step that names it, a `spawn_team` call, a saved Team Chat
 * target — and an unfinished team fails at run time in a way the user did not
 * cause and cannot read.
 *
 * The check lives with the shared contract resolver, which every delegated
 * launch goes through: `workflows/runner.ts` for a workflow step and
 * `engines/spawn-tools.ts` for `spawn_team`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { resolveChildTeamContract } from '../../domains/delegation/delegation-contracts.js'
import type { TeamRegistryEntry } from '../../core/types.js'

function teamEntry(teamPath: string): TeamRegistryEntry {
  return {
    name: 'half-built',
    type: 'team',
    description: 'Still being assembled.',
    team_path: teamPath,
  } as TeamRegistryEntry
}

function withTeam(building: boolean, fn: (teamPath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-guard-'))
  const teamPath = path.join(root, 'half-built')
  fs.mkdirSync(path.join(teamPath, 'agents', 'alpha'), { recursive: true })
  fs.writeFileSync(
    path.join(teamPath, 'agents', 'alpha', 'alpha.md'),
    '---\nname: alpha\ndescription: d\ntier: strategic\n---\n\n# alpha\n',
  )
  fs.writeFileSync(
    path.join(teamPath, 'team.yaml'),
    [
      'team:',
      '  name: "half-built"',
      '  description: Still being assembled.',
      ...(building ? ['  building: true'] : []),
      'agents:',
      '  - name: "alpha"',
      '    type: agent',
      '    role: Alpha.',
      '    tools: []',
      '    agent_file: "./agents/alpha/alpha.md"',
      'levels:',
      '  - id: setup',
      '    name: Setup',
      '    order: 0',
      '    stage:',
      '      type: chain',
      '      sequence:',
      '        - "alpha"',
      'gates: []',
      '',
    ].join('\n'),
  )
  try {
    fn(teamPath)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('a delegated launch refuses a team that is still being built', () => {
  withTeam(true, (teamPath) => {
    assert.throws(
      () => resolveChildTeamContract(teamEntry(teamPath)),
      /still being built/iu,
    )
  })
})

test('a delegated launch accepts the same team once it is published', () => {
  withTeam(false, (teamPath) => {
    const contract = resolveChildTeamContract(teamEntry(teamPath))
    assert.ok(contract.inputArtifact)
  })
})
