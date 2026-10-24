import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { listTeamBuilderTeams } from '../../domains/agent-generator/team-manager.js'

function withTempRepo(run: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-health-'))
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

test('Team catalog isolates a malformed Team and keeps the remaining Teams visible', () => {
  withTempRepo((repoRoot) => {
    registerTeam(
      repoRoot,
      'malformed-team',
      `team:
  name: malformed-team
agents: [null]
levels: []
gates: []
`,
    )
    registerTeam(
      repoRoot,
      'healthy-team',
      `team:
  name: healthy-team
agents: []
levels: []
gates: []
`,
    )

    const teams = listTeamBuilderTeams(repoRoot)
    const malformed = teams.find((team) => team.id === 'malformed-team')
    const healthy = teams.find((team) => team.id === 'healthy-team')

    assert.ok(malformed)
    assert.equal(malformed.health.status, 'error')
    assert.match(malformed.health.errors.join('\n'), /could not be validated/i)
    assert.ok(healthy)
  })
})

test('Team catalog reports a dangling stage participant as a blocking health error', () => {
  withTempRepo((repoRoot) => {
    registerTeam(
      repoRoot,
      'broken-team',
      `team:
  name: broken-team
agents:
  - name: lead
    type: agent
    role: Lead
    tier: orchestration
    agent_file: ./lead.md
levels:
  - id: discuss
    name: Discuss
    order: 0
    stage:
      type: discussion
      coordinator: lead
      participants: [missing-writer]
gates: []
`,
    )

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.equal(team.health.status, 'error')
    assert.match(team.health.errors.join('\n'), /missing-writer.*not found in agent roster/i)
  })
})

for (const scenario of [
  {
    name: 'chain with no sequence',
    stage: `type: chain
      sequence: []`,
    expected: /chain stage 'work' requires at least one sequence agent/i,
  },
  {
    name: 'broadcast with no fan-out',
    stage: `type: broadcast
      fan_out: []`,
    expected: /broadcast stage 'work' requires at least one fan-out agent/i,
  },
  {
    name: 'discussion with no participants',
    stage: `type: discussion
      coordinator: worker
      participants: []`,
    expected: /discussion stage 'work' requires at least one participant/i,
  },
] as const) {
  test(`Team catalog reports a ${scenario.name} as an unrunnable health error`, () => {
    withTempRepo((repoRoot) => {
      registerTeam(
        repoRoot,
        'empty-stage-team',
        `team:
  name: empty-stage-team
models:
  strategic:
    model: local-model
    thinking: low
    provider: lm-studio
agents:
  - name: worker
    type: agent
    role: Worker
    tier: strategic
    agent_file: ./worker.md
levels:
  - id: work
    name: Work
    order: 0
    stage:
      ${scenario.stage}
gates: []
`,
      )
      fs.writeFileSync(
        path.join(repoRoot, 'teams', 'empty-stage-team', 'worker.md'),
        `---
name: worker
description: Worker.
provider: lm-studio
model: local-model
---

Do the work.
`,
      )

      const team = listTeamBuilderTeams(repoRoot)[0]

      assert.ok(team)
      assert.equal(team.health.status, 'error')
      assert.match(team.health.errors.join('\n'), scenario.expected)
    })
  })
}

test('Team catalog reports parser advisories as warning health', () => {
  withTempRepo((repoRoot) => {
    registerTeam(
      repoRoot,
      'warning-team',
      `team:
  name: warning-team
workspace:
  path: workspace
  watch: "sometimes"
models:
  strategic:
    model: local-model
    thinking: low
    provider: lm-studio
agents:
  - name: worker
    type: agent
    role: Worker
    tier: strategic
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
    fs.writeFileSync(
      path.join(repoRoot, 'teams', 'warning-team', 'worker.md'),
      `---
name: worker
description: Worker.
provider: lm-studio
model: local-model
---

Do the work.
`,
    )

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.equal(team.health.status, 'warning')
    assert.equal(team.health.errors.length, 0)
    assert.match(team.health.warnings.join('\n'), /workspace\.watch.*not a recognized boolean/i)
  })
})

test('Team catalog retains a registered Team whose configuration file is missing', () => {
  withTempRepo((repoRoot) => {
    registerTeam(repoRoot, 'missing-team')

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.equal(team.id, 'missing-team')
    assert.equal(team.health.status, 'error')
    assert.match(team.health.errors.join('\n'), /configuration file.*missing/i)
  })
})

test('Team catalog warns about a roster member no stage actually uses', () => {
  // How a Team ends up here: removing a member strips it from the stage, and
  // adding it back to a hand-authored Team with the single add restores only
  // the roster entry, since that add edits stage membership only for a
  // generated or default setup stage. The Team stays
  // valid and runnable, so this is not an error; but the Run sidebar would
  // otherwise list a member the discussion will never dispatch.
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
    tier: orchestration
    agent_file: ./lead.md
  - name: writer
    type: agent
    role: Writer
    tier: strategic
    agent_file: ./writer.md
  - name: editor
    type: agent
    role: Editor
    tier: strategic
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
    // lm-studio, like the other fixtures in this file: health is what is under
    // test here, not provider readiness. A CLI provider such as `claude` makes
    // the assertion below depend on whether that binary happens to be installed
    // — present on a developer's box, absent on a CI runner, where preflight
    // then fills `health.errors` with 'cannot use provider' and the Team reads
    // as unrunnable for a reason this test never meant to exercise. lm-studio
    // needs no binary and no credential, so the roster stays runnable
    // everywhere and the orphan warning is the only signal left.
    for (const persona of ['lead', 'writer', 'editor']) {
      fs.writeFileSync(
        path.join(repoRoot, 'teams', 'orphan-member-team', `${persona}.md`),
        `---\nname: ${persona}\nprovider: lm-studio\nmodel: local-model\n---\n\n# ${persona}\n`,
      )
    }

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.equal(
      team.health.errors.join('\n'),
      '',
      'the Team is still valid and runnable',
    )
    assert.equal(team.health.status, 'warning')
    assert.match(
      team.health.warnings.join('\n'),
      /'editor'.*no stage/i,
    )
    assert.doesNotMatch(team.health.warnings.join('\n'), /'writer'/)
  })
})

test('a pipeline level does not silence the orphan-roster warning for other levels', () => {
  // A pipeline dispatches whoever its plan names at run time, so an agent it
  // does not declare cannot be called unreferenced. That uncertainty belongs
  // to the pipeline, not to the whole Team: treating every roster member as
  // reachable turned one pipeline level into a team-wide off switch.
  withTempRepo((repoRoot) => {
    registerTeam(
      repoRoot,
      'pipeline-and-chain-team',
      `team:
  name: pipeline-and-chain-team
agents:
  - name: lead
    type: agent
    role: Lead
    tier: orchestration
    agent_file: ./lead.md
  - name: planner
    type: agent
    role: Planner
    tier: strategic
    agent_file: ./planner.md
  - name: orphan
    type: agent
    role: Orphan
    tier: strategic
    agent_file: ./orphan.md
levels:
  - id: plan
    name: Plan
    order: 0
    stage:
      type: pipeline
      coordinator: lead
      participants: [planner]
      config:
        parallel: false
  - id: write
    name: Write
    order: 1
    stage:
      type: chain
      sequence: [planner]
gates: []
`,
    )
    for (const persona of ['lead', 'planner', 'orphan']) {
      fs.writeFileSync(
        path.join(repoRoot, 'teams', 'pipeline-and-chain-team', `${persona}.md`),
        `---\nname: ${persona}\nprovider: claude\nmodel: haiku\n---\n\n# ${persona}\n`,
      )
    }

    const team = listTeamBuilderTeams(repoRoot)[0]

    assert.ok(team)
    assert.match(team.health.warnings.join('\n'), /'orphan'.*no stage/i)
    assert.doesNotMatch(team.health.warnings.join('\n'), /'planner'/)
  })
})
