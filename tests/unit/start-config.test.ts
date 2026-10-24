import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseStartConfig } from '../../parsers/start-config.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-config-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('parseStartConfig parses entry and resolves explicit registry path', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'start.yaml'), `
entry: reception-desk
registry: ./teams.yaml
`)

    const result = parseStartConfig(path.join(dir, 'start.yaml'))
    assert.ok(result.config, `Expected config, got errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0)
    assert.equal(result.config!.entry, 'reception-desk')
    assert.equal(result.config!.registry, path.join(dir, 'teams.yaml'))
  })
})

test('start.yaml entry can resolve to a team entry in teams.yaml', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'teams', 'reception-desk'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'start.yaml'), `
entry: reception-desk
registry: ./teams.yaml
`)
    fs.writeFileSync(path.join(dir, 'teams.yaml'), `
reception-desk:
  type: team
  description: Default entrypoint
  team_path: .
`)

    const start = parseStartConfig(path.join(dir, 'start.yaml'))
    assert.ok(start.config)
    const registry = parseTeamRegistry(start.config!.registry!)
    assert.equal(registry.errors.length, 0, `Expected no registry errors, got: ${registry.errors.join('; ')}`)
    const entry = registry.entries.find((candidate) => candidate.name === start.config!.entry)
    assert.ok(entry)
    assert.equal(entry!.type, 'team')
  })
})
