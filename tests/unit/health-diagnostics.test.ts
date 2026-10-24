import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { Diagnostic } from '../../contracts/health.js'
import { listTeamBuilderTeams } from '../../domains/agent-generator/team-manager.js'

/**
 * One Team catalog, one vocabulary for what is wrong with it.
 *
 * The Run and Create sidebars both draw Team state from this payload, and a
 * reader has to be able to tell a structural fault (the file says something
 * impossible) from a configuration fault (the machine is missing a key) without
 * parsing English. The severity decides the icon; the kind decides the advice;
 * the subject names who it is about.
 */

function withTempRepo(run: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-diagnostics-'))
  try {
    run(repoRoot)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

function registerTeam(repoRoot: string, id: string, teamYaml?: string): void {
  fs.appendFileSync(
    path.join(repoRoot, 'teams.yaml'),
    `${id}:
  type: team
  description: ${id} fixture.
  team_path: ./teams/${id}
`,
  )
  if (teamYaml === undefined) return
  const teamRoot = path.join(repoRoot, 'teams', id)
  fs.mkdirSync(teamRoot, { recursive: true })
  fs.writeFileSync(path.join(teamRoot, 'team.yaml'), teamYaml)
}

function writePersona(
  repoRoot: string,
  teamId: string,
  name: string,
  provider: string,
): void {
  fs.writeFileSync(
    path.join(repoRoot, 'teams', teamId, `${name}.md`),
    `---\nname: ${name}\nprovider: ${provider}\nmodel: fixture-model\n---\n\n# ${name}\n`,
  )
}

test('a roster member no stage names becomes one structural warning diagnostic about that Team', () => {
  withTempRepo((repoRoot) => {
    registerTeam(
      repoRoot,
      'orphan-member-team',
      `team:
  name: orphan-member-team
agents:
  - name: lead
    type: agent
    role: Lead
    agent_file: ./lead.md
  - name: writer
    type: agent
    role: Writer
    agent_file: ./writer.md
  - name: editor
    type: agent
    role: Editor
    agent_file: ./editor.md
levels:
  - id: discuss
    name: Discuss
    order: 0
    stage:
      type: discussion
      coordinator: lead
      participants: [writer]
gates: []
`,
    )
    for (const persona of ['lead', 'writer', 'editor']) {
      writePersona(repoRoot, 'orphan-member-team', persona, 'lm-studio')
    }

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.ok(team.health.diagnostics)
    const diagnostics: Diagnostic[] = team.health.diagnostics
    assert.equal(diagnostics.length, 1)
    const [orphan] = diagnostics
    assert.ok(orphan)
    assert.equal(orphan.severity, 'warning')
    assert.equal(orphan.kind, 'structure')
    assert.equal(orphan.subject.teamName, 'orphan-member-team')
    assert.match(orphan.message, /'editor'/)
  })
})

test('an agent whose provider is not connected becomes one config error diagnostic naming the agent and the provider', () => {
  withTempRepo((repoRoot) => {
    registerTeam(
      repoRoot,
      'unconnected-team',
      `team:
  name: unconnected-team
agents:
  - name: worker
    type: agent
    role: Worker
    agent_file: ./worker.md
levels:
  - id: work
    name: Work
    order: 0
    stage:
      type: chain
      sequence: [worker]
gates: []
`,
    )
    writePersona(repoRoot, 'unconnected-team', 'worker', 'connection:absent')

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.ok(team.health.diagnostics)
    const errors = team.health.diagnostics.filter(
      (diagnostic: Diagnostic) => diagnostic.severity === 'error',
    )
    assert.equal(errors.length, 1)
    const [unconnected] = errors
    assert.ok(unconnected)
    assert.equal(unconnected.kind, 'config')
    assert.equal(unconnected.subject.agentName, 'worker')
    assert.equal(unconnected.subject.provider, 'connection:absent')
    assert.equal(unconnected.subject.teamName, 'unconnected-team')
    assert.match(unconnected.message, /worker/)
    assert.match(unconnected.message, /connection:absent/)
  })
})

test('a Team whose configuration file is missing becomes one structural error diagnostic naming the Team', () => {
  withTempRepo((repoRoot) => {
    registerTeam(repoRoot, 'missing-team')

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.ok(team.health.diagnostics)
    assert.equal(team.health.diagnostics.length, 1)
    const [missing] = team.health.diagnostics
    assert.ok(missing)
    assert.equal(missing.severity, 'error')
    assert.equal(missing.kind, 'structure')
    assert.equal(missing.subject.teamName, 'missing-team')
    assert.match(missing.message, /missing/i)
  })
})

test('the legacy error and warning strings still carry every diagnostic message', () => {
  // Both sidebars read `diagnostics`; the HTTP contract keeps `errors` and
  // `warnings` so an older reader of the same payload is not left blank.
  withTempRepo((repoRoot) => {
    registerTeam(
      repoRoot,
      'unconnected-team',
      `team:
  name: unconnected-team
agents:
  - name: worker
    type: agent
    role: Worker
    agent_file: ./worker.md
levels:
  - id: work
    name: Work
    order: 0
    stage:
      type: chain
      sequence: [worker]
gates: []
`,
    )
    writePersona(repoRoot, 'unconnected-team', 'worker', 'connection:absent')

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.ok(team.health.diagnostics)
    const diagnostics: Diagnostic[] = team.health.diagnostics
    assert.deepEqual(
      diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.message),
      team.health.errors,
    )
    assert.deepEqual(
      diagnostics
        .filter((diagnostic) => diagnostic.severity === 'warning')
        .map((diagnostic) => diagnostic.message),
      team.health.warnings,
    )
  })
})
