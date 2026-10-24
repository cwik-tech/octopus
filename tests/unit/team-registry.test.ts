import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { parseTeamConfig } from '../../parsers/team-config.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-registry-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeMinimalTeamYaml(dir: string, extra = ''): void {
  const agentDir = path.join(dir, 'agents', 'alpha')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha')
  fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: sample-team
workspace:
  path: workspace
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
      type: discussion
      coordinator: alpha
      participants:
        - alpha
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 1
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
${extra}
`)
}

test('parseTeamRegistry parses named team and agent entries from teams.yaml', () => {
  withTempDir((dir) => {
    const teamDir = path.join(dir, 'research-team')
    const writerDir = path.join(dir, 'agents')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.mkdirSync(writerDir, { recursive: true })
    fs.writeFileSync(path.join(writerDir, 'writer.md'), '# Writer')

    fs.writeFileSync(path.join(dir, 'teams.yaml'), `
research:
  type: team
  description: Research helpers
  team_path: ./research-team
  input_artifact: brief.md
  output_artifact: report.md
  tags:
    - research
    - analysis

writer:
  type: agent
  description: Writing specialist
  role: Writer
  tier: strategic
  agent_file: ./agents/writer.md
  tags:
    - writing
`)

    const result = parseTeamRegistry(path.join(dir, 'teams.yaml'))
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)
    assert.equal(result.entries.length, 2)

    const research = result.entries.find((entry) => entry.name === 'research')
    assert.ok(research)
    assert.equal(research!.type, 'team')
    assert.equal((research as any).team_path, teamDir)

    const writer = result.entries.find((entry) => entry.name === 'writer')
    assert.ok(writer)
    assert.equal(writer!.type, 'agent')
    assert.equal((writer as any).agent_file, path.join(dir, 'agents', 'writer.md'))
  })
})

test('parseTeamRegistry preserves host_model and host_provider on team entries', () => {
  withTempDir((dir) => {
    const teamDir = path.join(dir, 'reception-team')
    fs.mkdirSync(teamDir, { recursive: true })

    fs.writeFileSync(path.join(dir, 'teams.yaml'), `
reception:
  type: team
  description: Reception team
  team_path: ./reception-team
  host_model: gpt-5.4-mini
  host_provider: codex
`)

    const result = parseTeamRegistry(path.join(dir, 'teams.yaml'))
    assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)
    const reception = result.entries.find((entry) => entry.name === 'reception')
    assert.ok(reception)
    assert.equal(reception?.type, 'team')
    if (reception?.type === 'team') {
      assert.equal(reception.host_model, 'gpt-5.4-mini')
      assert.equal(reception.host_provider, 'codex')
    }
  })
})

test('parseTeamConfig loads explicit composition.team_registry entries', () => {
  withTempDir((dir) => {
    writeMinimalTeamYaml(dir, `
composition:
  team_registry: ./teams.yaml
`)

    const teamDir = path.join(dir, 'research-team')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'teams.yaml'), `
research:
  type: team
  description: Research team
  team_path: ./research-team
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected config, got errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0)
    assert.equal(result.config!.composition?.team_registry, path.join(dir, 'teams.yaml'))
    assert.equal(result.config!.composition?.registry_entries?.length, 1)
    assert.equal(result.config!.composition?.registry_entries?.[0]?.name, 'research')
  })
})

test('parseTeamConfig auto-loads colocated teams.yaml when composition.team_registry is omitted', () => {
  withTempDir((dir) => {
    writeMinimalTeamYaml(dir)

    const teamDir = path.join(dir, 'writing-team')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'teams.yaml'), `
writing:
  type: team
  description: Writing team
  team_path: ./writing-team
`)

    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config, `Expected config, got errors: ${result.errors.join('; ')}`)
    assert.equal(result.errors.length, 0)
    assert.equal(result.config!.composition?.team_registry, path.join(dir, 'teams.yaml'))
    assert.equal(result.config!.composition?.registry_entries?.length, 1)
    assert.equal(result.config!.composition?.registry_entries?.[0]?.name, 'writing')
  })
})

test('parseTeamRegistry includes the live writing-team entry', () => {
  const registryFile = path.resolve(process.cwd(), 'teams.yaml')
  const result = parseTeamRegistry(registryFile)

  assert.equal(result.errors.length, 0, `Expected no errors, got: ${result.errors.join('; ')}`)
  const entry = result.entries.find((candidate) => candidate.name === 'writing-team')
  assert.ok(entry)
  assert.equal(entry?.type, 'team')
  if (entry?.type === 'team') {
    assert.equal(entry.host_model, 'gpt-5.4-mini')
    assert.equal(entry.host_provider, 'codex')
    assert.match(entry.team_path, /teams\/writing-team$/)
  }
})

test('a registry entry carrying a retired grade is kept, not dropped', () => {
  // Dropping the entry removes the Agent from the library entirely: it stops
  // appearing, stops being addable to a Team, and nothing says why. The grade
  // selects nothing, so it cannot be what decides that.
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'agents', 'writer.md'), '# Writer')
    const yaml = `
writer:
  type: agent
  description: Writing specialist
  role: Writer
  tier: specialist
  agent_file: ./agents/writer.md
  tags:
    - writing
`
    fs.writeFileSync(path.join(dir, 'teams.yaml'), yaml)

    const result = parseTeamRegistry(path.join(dir, 'teams.yaml'))

    assert.deepEqual(result.errors, [], result.errors.join('; '))
    assert.deepEqual(result.entries.map((entry) => entry.name), ['writer'])
    const writer = result.entries[0]
    assert.equal(writer?.type, 'agent')
    // The raw label survives exactly as written — not normalized to one of the
    // runtime's old words, and not dropped.
    assert.equal(writer?.type === 'agent' ? writer.tier : undefined, 'specialist')
    // And it is disclosed rather than silently ignored (§5).
    assert.ok(
      result.warnings.some(
        (warning) => warning.includes("tier 'specialist'") && warning.includes('ignored'),
      ),
      `expected an ignored-tier warning, got: ${result.warnings.join('; ')}`,
    )
    assert.equal(fs.readFileSync(path.join(dir, 'teams.yaml'), 'utf8'), yaml)
  })
})

test('a registry entry with no agent_file is still refused', () => {
  // The control: this parser's real requirement is that an agent entry says
  // which file it is. That is untouched — only the grade stopped deciding.
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'teams.yaml'),
      `
writer:
  type: agent
  description: Writing specialist
  role: Writer
  tier: specialist
`,
    )

    const result = parseTeamRegistry(path.join(dir, 'teams.yaml'))

    assert.ok(
      result.errors.some((error) => error.includes("require 'agent_file'")),
      `a registry entry with no agent_file must still fail: ${result.errors.join('; ')}`,
    )
    assert.deepEqual(result.entries, [])
  })
})
