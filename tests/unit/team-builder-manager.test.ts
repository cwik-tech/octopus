import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addTeamBuilderAgent,
  addTeamBuilderAgents,
  digestTeamYaml,
  createTeamBuilderTeam,
  listTeamBuilderTeams,
  readTeamBuilderTeam,
  removeTeamBuilderAgent,
  updateTeamBuilderTeam,
} from '../../domains/agent-generator/team-manager.js'
import { listAgents } from '../../domains/agent-generator/list-agents.js'
import { addAgentToTeam } from '../../domains/agent-generator/team-usage.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'

function withTempRepo(fn: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-builder-'))
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })
}

test('removeTeamBuilderAgent removes a referenced roster entry without deleting the agent persona', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamDir = path.join(repoRoot, 'teams', 'sample-team')
    const agentDir = path.join(repoRoot, 'agents', 'alpha')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.mkdirSync(agentDir, { recursive: true })
    const agentPath = path.join(agentDir, 'alpha.md')
    fs.writeFileSync(agentPath, '# Alpha\n')
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      `sample-team:
  type: team
  description: Sample team.
  team_path: ./teams/sample-team
`,
    )
    const teamYamlPath = path.join(teamDir, 'team.yaml')
    fs.writeFileSync(
      teamYamlPath,
      `team:
  name: sample-team
  description: Sample team.
  version: "0.1.0"

agents:
  - name: alpha
    type: agent
    role: Alpha role.
    tier: strategic
    tools: []
    agent_file: ../../agents/alpha/alpha.md

  - name: beta
    type: agent
    role: Beta role.
    tier: strategic
    tools: []

levels:
  - id: plan
    stage:
      type: chain
      sequence:
        - alpha
        - beta
`,
    )

    const team = await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'sample-team',
      agentName: 'alpha',
    })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.equal(team.agents.some((agent) => agent.name === 'alpha'), false)
    assert.equal(team.agents.some((agent) => agent.name === 'beta'), true)
    assert.doesNotMatch(savedYaml, /  - name: alpha\n/)
    assert.match(savedYaml, /  - name: beta\n/)
    assert.equal(fs.existsSync(agentPath), true)
  })
})

test('listAgents exposes persona runtime defaults for team roster binding', async () => {
  await withTempRepo(async (repoRoot) => {
    const agentDir = path.join(repoRoot, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, 'alpha.md'),
      `---
name: alpha
description: Alpha specialist.
tier: execution
provider: anthropic
model: claude-sonnet-4-6
thinking: high
---

# Alpha
`,
    )

    const agents = listAgents(repoRoot)

    assert.equal(agents.length, 1)
    assert.equal(requiredValue(agents[0], 'tests/unit/team-builder-manager.test.ts:108').name, 'alpha')
    assert.equal(requiredValue(agents[0], 'tests/unit/team-builder-manager.test.ts:109').description, 'Alpha specialist.')
    assert.equal(requiredValue(agents[0], 'tests/unit/team-builder-manager.test.ts:110').tier, 'execution')
    assert.equal(requiredValue(agents[0], 'tests/unit/team-builder-manager.test.ts:111').provider, 'anthropic')
    assert.equal(requiredValue(agents[0], 'tests/unit/team-builder-manager.test.ts:112').model, 'claude-sonnet-4-6')
    assert.equal(requiredValue(agents[0], 'tests/unit/team-builder-manager.test.ts:113').thinking, 'high')
  })
})

test('addTeamBuilderAgent saves the reference and role, never a model copy', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamDir = path.join(repoRoot, 'teams', 'sample-team')
    const agentDir = path.join(repoRoot, 'agents', 'alpha')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, 'alpha.md'),
      `---
name: alpha
tier: strategic
provider: anthropic
model: claude-sonnet-4-6
---

# Alpha
`,
    )
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      `sample-team:
  type: team
  description: Sample team.
  team_path: ./teams/sample-team
`,
    )
    const teamYamlPath = path.join(teamDir, 'team.yaml')
    fs.writeFileSync(
      teamYamlPath,
      `team:
  name: sample-team
  description: Sample team.
  version: "0.1.0"

models:
  strategic:
    model: deepseek-v4-flash
    thinking: medium
    provider: deepseek

agents: []
`,
    )

    const team = await addTeamBuilderAgent({
      repoRoot,
      teamId: 'sample-team',
      agentName: 'alpha',
    })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    // No grade, on the entry or in what the writer reports. Authoring stopped
    // producing one, and a roster entry written now says nothing about a value
    // nobody chose.
    assert.equal(
      requiredValue(team.agents[0], 'tests/unit/team-builder-manager.test.ts:171').tier,
      undefined,
    )
    assert.doesNotMatch(savedYaml, /^\s+tier:/m, savedYaml)
    // The roster records the reference, not a copy of the agent's model. The
    // legacy `models:` block above is untouched and still ignored.
    const rosterBlock = savedYaml.slice(savedYaml.indexOf('agents:'))
    assert.doesNotMatch(rosterBlock, /^\s+model:/m)
    assert.doesNotMatch(rosterBlock, /^\s+provider:/m)
  })
})

test('readTeamBuilderTeam reports the persona runtime instead of a team.yaml copy', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamDir = path.join(repoRoot, 'teams', 'sample-team')
    const agentDir = path.join(repoRoot, 'agents', 'alpha')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, 'alpha.md'),
      `---
name: alpha
tier: strategic
provider: codex
model: gpt-5.6-sol
---

# Alpha
`,
    )
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      `sample-team:
  type: team
  description: Sample team.
  team_path: ./teams/sample-team
`,
    )
    fs.writeFileSync(
      path.join(teamDir, 'team.yaml'),
      `team:
  name: sample-team
  description: Sample team.
  version: "0.1.0"

defaults:
  provider: claude

models:
  strategic:
    model: claude-haiku-4-5
    thinking: medium
    provider: claude

agents:
  - name: alpha
    type: agent
    role: Worker.
    tier: strategic
    tools: []
    agent_file: ../../agents/alpha/alpha.md
`,
    )

    const team = readTeamBuilderTeam(repoRoot, 'sample-team')
    const agent = requiredValue(team.agents[0], 'tests/unit/team-builder-manager.test.ts:persona-runtime')

    // The roster entry itself declares nothing; the persona file does.
    assert.equal(agent.legacyProvider, undefined)
    assert.equal(agent.legacyModel, undefined)
    assert.equal(agent.personaProvider, 'codex')
    assert.equal(agent.personaModel, 'gpt-5.6-sol')
  })
})

test('readTeamBuilderTeam flags a roster entry whose persona file is gone', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamDir = path.join(repoRoot, 'teams', 'sample-team')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      `sample-team:
  type: team
  description: Sample team.
  team_path: ./teams/sample-team
`,
    )
    fs.writeFileSync(
      path.join(teamDir, 'team.yaml'),
      `team:
  name: sample-team
  description: Sample team.
  version: "0.1.0"

models:
  strategic:
    model: claude-haiku-4-5
    thinking: medium
    provider: claude

agents:
  - name: ghost
    type: agent
    role: Worker.
    tier: strategic
    tools: []
    agent_file: ../../agents/ghost/ghost.md
`,
    )

    const team = readTeamBuilderTeam(repoRoot, 'sample-team')
    const agent = requiredValue(team.agents[0], 'tests/unit/team-builder-manager.test.ts:persona-missing')

    // loadAgent drops this entry at run time, so the roster must not present
    // the team tier as though the agent would start on it.
    assert.equal(agent.personaMissing, true)
    assert.ok(team.warnings.some((warning) => /ghost/.test(warning)))
    // The legacy tier table is reported as ignored, not obeyed.
    assert.ok(
      team.warnings.some((warning) => /models-by-tier table/.test(warning)),
    )
  })
})

test('updateTeamBuilderTeam renames an existing team id and folder', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamDir = path.join(repoRoot, 'teams', 'sample-team')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      `sample-team:
  type: team
  description: Sample team.
  team_path: ./teams/sample-team
  tags:
    - old
`,
    )
    fs.writeFileSync(
      path.join(teamDir, 'team.yaml'),
      `team:
  name: sample-team
  description: Sample team.
  version: "0.1.0"

defaults:
  provider: deepseek

models:
  orchestration:
    model: deepseek-v4-flash
    thinking: medium
    provider: deepseek
  strategic:
    model: deepseek-v4-flash
    thinking: medium
    provider: deepseek
  execution:
    model: deepseek-v4-flash
    thinking: medium
    provider: deepseek

agents: []
`,
    )

    const team = await updateTeamBuilderTeam(repoRoot, 'sample-team', {
      id: 'renamed-team',
      description: 'Renamed team.',
      tags: ['new'],
    })

    const registry = fs.readFileSync(path.join(repoRoot, 'teams.yaml'), 'utf8')
    const savedYaml = fs.readFileSync(
      path.join(repoRoot, 'teams', 'renamed-team', 'team.yaml'),
      'utf8',
    )
    assert.equal(team.id, 'renamed-team')
    assert.equal(fs.existsSync(path.join(repoRoot, 'teams', 'sample-team')), false)
    assert.equal(fs.existsSync(path.join(repoRoot, 'teams', 'renamed-team')), true)
    assert.doesNotMatch(registry, /^sample-team:/m)
    assert.match(registry, /^renamed-team:/m)
    assert.match(registry, /team_path: "\.\/teams\/renamed-team"/)
    assert.match(savedYaml, /name: "renamed-team"/)
    assert.match(savedYaml, /description: >\n    Renamed team\./)
    assert.match(team.yaml, /name: "renamed-team"/)
    // The legacy defaults block the file already carried is left untouched:
    // reading and renaming a team never rewrites settings it no longer obeys.
    assert.match(readTeamBuilderTeam(repoRoot, 'renamed-team').yaml, /defaults:\n  provider: deepseek/)
  })
})

test('concurrent team creation preserves every registry entry', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

    await Promise.all([
      createTeamBuilderTeam(repoRoot, {
        id: 'first-team',
        description: 'First concurrent team.',
        tags: ['first'],
      }),
      createTeamBuilderTeam(repoRoot, {
        id: 'second-team',
        description: 'Second concurrent team.',
        tags: ['second'],
      }),
    ])

    assert.deepEqual(
      listTeamBuilderTeams(repoRoot).map((team) => team.id).sort(),
      ['first-team', 'second-team'],
    )
    const registry = fs.readFileSync(path.join(repoRoot, 'teams.yaml'), 'utf8')
    assert.match(registry, /^first-team:/m)
    assert.match(registry, /^second-team:/m)
  })
})

test('team creation registers a supported host independently of its worker provider', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

    const team = await createTeamBuilderTeam(repoRoot, {
      id: 'claude-worker-team',
      description: 'Claude workers with a supported Team host.',
    })

    const registry = fs.readFileSync(path.join(repoRoot, 'teams.yaml'), 'utf8')
    // A Team the user just created pins no host pair. Writing one here decides
    // a model on their behalf and, worse, outranks the coordinator Agent's own
    // choice for the life of the Team — the registry entry is preferred over
    // the coordinator. Leaving it out lets the host resolve from the
    // coordinator, or from the application default when it names none.
    assert.doesNotMatch(registry, /host_model:/)
    assert.doesNotMatch(registry, /host_provider:/)
    // A new team declares no runtime settings of its own at all.
    assert.doesNotMatch(team.yaml, /^models:/m)
    assert.doesNotMatch(team.yaml, /^defaults:/m)
  })
})

test('concurrent retries for one orchestrator publish one team', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    const input = {
      id: 'single-team',
      description: 'One durable team.',
      tags: ['durable'],
      orchestratorKey: 'plan-1:create-team',
    }

    const [first, second] = await Promise.all([
      createTeamBuilderTeam(repoRoot, input),
      createTeamBuilderTeam(repoRoot, input),
    ])

    assert.equal(first.id, 'single-team')
    assert.equal(second.id, 'single-team')
    assert.deepEqual(listTeamBuilderTeams(repoRoot).map((team) => team.id), [
      'single-team',
    ])
    assert.deepEqual(
      fs.readdirSync(path.join(repoRoot, 'teams')).filter((name) => name === 'single-team'),
      ['single-team'],
    )
  })
})

test('orchestrated team creation publishes a completed stage after a boundary failure', async () => {
  await withTempRepo(async (repoRoot) => {
    const input = {
      id: 'recoverable-team',
      description: 'Recoverable team.',
      tags: ['recovery'],
      orchestratorKey: 'plan-1:create-team',
    }
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

    await assert.rejects(
      createTeamBuilderTeam(repoRoot, input, {
        onPersistenceBoundary(boundary) {
          if (boundary === 'after_team_staged') {
            throw new Error('simulated process loss after staging')
          }
        },
      }),
      /simulated process loss after staging/,
    )

    assert.equal(fs.existsSync(path.join(repoRoot, 'teams', 'recoverable-team')), false)
    assert.equal(
      fs.readdirSync(path.join(repoRoot, 'teams', '.create-staging')).length,
      1,
    )

    const recovered = await createTeamBuilderTeam(repoRoot, input)

    assert.equal(recovered.id, 'recoverable-team')
    assert.equal(fs.existsSync(path.join(repoRoot, 'teams', '.create-staging')), false)
    assert.deepEqual(listTeamBuilderTeams(repoRoot).map((team) => team.id), [
      'recoverable-team',
    ])
  })
})

test('orchestrated team creation registers a published folder after a boundary failure', async () => {
  await withTempRepo(async (repoRoot) => {
    const input = {
      id: 'recoverable-team',
      description: 'Recoverable team.',
      tags: ['recovery'],
      orchestratorKey: 'plan-1:create-team',
    }
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

    await assert.rejects(
      createTeamBuilderTeam(repoRoot, input, {
        onPersistenceBoundary(boundary) {
          if (boundary === 'after_team_published') {
            throw new Error('simulated process loss before registration')
          }
        },
      }),
      /simulated process loss before registration/,
    )

    assert.equal(fs.existsSync(path.join(repoRoot, 'teams', 'recoverable-team')), true)
    assert.deepEqual(listTeamBuilderTeams(repoRoot), [])

    const recovered = await createTeamBuilderTeam(repoRoot, input)

    assert.equal(recovered.id, 'recoverable-team')
    assert.deepEqual(
      fs.readdirSync(path.join(repoRoot, 'teams')).filter(
        (name) => name.startsWith('recoverable-team'),
      ),
      ['recoverable-team'],
    )
    assert.deepEqual(listTeamBuilderTeams(repoRoot).map((team) => team.id), [
      'recoverable-team',
    ])
  })
})

test('listTeamBuilderTeams reports the entry level stage type', async () => {
  await withTempRepo(async (repoRoot) => {
    const boardDir = path.join(repoRoot, 'teams', 'board')
    const lineDir = path.join(repoRoot, 'teams', 'line')
    fs.mkdirSync(boardDir, { recursive: true })
    fs.mkdirSync(lineDir, { recursive: true })
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      `board:
  type: team
  description: Discussion board.
  team_path: ./teams/board

line:
  type: team
  description: Chain team.
  team_path: ./teams/line
`,
    )
    fs.writeFileSync(
      path.join(boardDir, 'team.yaml'),
      `team:
  name: board
workflow:
  entry_level: deliberation
agents:
  - name: lead
    type: agent
    tier: orchestration
levels:
  - id: warmup
    name: Warmup
    order: 0
    stage:
      type: chain
      sequence:
        - lead
  - id: deliberation
    name: Deliberation
    order: 1
    stage:
      type: discussion
      coordinator: lead
      participants: []
`,
    )
    fs.writeFileSync(
      path.join(lineDir, 'team.yaml'),
      `team:
  name: line
agents: []
levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence: []
`,
    )

    const teams = listTeamBuilderTeams(repoRoot)
    const board = requiredValue(teams.find((team) => team.id === 'board'))
    const line = requiredValue(teams.find((team) => team.id === 'line'))

    assert.equal(board.entryStageType, 'discussion')
    assert.deepEqual(board.agentNames, ['lead'])
    // No entry_level declared — the first level remains the default entry.
    assert.equal(line.entryStageType, 'chain')
  })
})

test('listTeamBuilderTeams reports whether a team may be invoked by a user', async () => {
  await withTempRepo(async (repoRoot) => {
    for (const id of ['open-team', 'internal-team', 'silent-team']) {
      fs.mkdirSync(path.join(repoRoot, 'teams', id), { recursive: true })
    }
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      `open-team:
  type: team
  description: User invocable.
  team_path: ./teams/open-team

internal-team:
  type: team
  description: Declares team-only invocation.
  team_path: ./teams/internal-team

silent-team:
  type: team
  description: Declares nothing.
  team_path: ./teams/silent-team
`,
    )
    fs.writeFileSync(
      path.join(repoRoot, 'teams', 'open-team', 'team.yaml'),
      `team:
  name: open-team
workflow:
  entry_level: setup
  user_facing: true
  invocation_modes:
    - user
    - team
agents: []
levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence: []
`,
    )
    fs.writeFileSync(
      path.join(repoRoot, 'teams', 'internal-team', 'team.yaml'),
      `team:
  name: internal-team
workflow:
  entry_level: setup
  user_facing: false
  invocation_modes:
    - team
agents: []
levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence: []
`,
    )
    fs.writeFileSync(
      path.join(repoRoot, 'teams', 'silent-team', 'team.yaml'),
      `team:
  name: silent-team
agents: []
levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence: []
`,
    )

    const teams = listTeamBuilderTeams(repoRoot)
    const byId = new Map(teams.map((team) => [team.id, team]))
    assert.equal(byId.get('open-team')?.userInvocable, true)
    assert.equal(byId.get('internal-team')?.userInvocable, false)
    // Nothing declared means nothing is forbidden — stay permissive.
    assert.equal(byId.get('silent-team')?.userInvocable, true)

    // The architect still lists every team; only the chat catalog filters.
    assert.equal(teams.length, 3)
  })
})

// ─── Team-member removal: Team-local reference integrity ─────────────────────

/**
 * Write a minimal repository around one team.yaml: a registry entry, the team
 * folder, and a shared persona file per named agent.
 */
function writeTeamRepo(params: {
  repoRoot: string
  teamId: string
  personas: string[]
  teamYaml: string
}): string {
  const teamDir = path.join(params.repoRoot, 'teams', params.teamId)
  fs.mkdirSync(teamDir, { recursive: true })
  for (const persona of params.personas) {
    const agentDir = path.join(params.repoRoot, 'agents', persona)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${persona}.md`),
      `---
name: ${persona}
description: ${persona} persona.
tier: strategic
---

# ${persona}
`,
    )
  }
  fs.writeFileSync(
    path.join(params.repoRoot, 'teams.yaml'),
    `${params.teamId}:
  type: team
  description: ${params.teamId} team.
  team_path: ./teams/${params.teamId}
`,
  )
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  fs.writeFileSync(teamYamlPath, params.teamYaml)
  return teamYamlPath
}

function isYamlObject(value: unknown): value is YamlObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Read one stage field of one level out of a saved team.yaml. */
function savedStageField(
  teamYamlPath: string,
  levelId: string,
  field: string,
): YamlValue | undefined {
  const raw = parseYaml(fs.readFileSync(teamYamlPath, 'utf8'))
  const levels = Array.isArray(raw.levels) ? raw.levels : []
  for (const level of levels) {
    if (!isYamlObject(level) || level.id !== levelId) continue
    const stage = level.stage
    if (!isYamlObject(stage)) return undefined
    return stage[field]
  }
  return undefined
}

function savedStageList(
  teamYamlPath: string,
  levelId: string,
  field: string,
): string[] {
  const value = savedStageField(teamYamlPath, levelId, field)
  return Array.isArray(value) ? value.map(String) : []
}

function discussionTeamYaml(): string {
  return `team:
  name: "teaching-team"
  description: >
    Discussion team that reviews teaching manuals.
  version: "0.1.0"

workspace:
  path: ../../workspace
  watch: false

workflow:
  entry_level: setup

agents:
  - name: "teaching-team-lead"
    type: agent
    role: >
      Orchestration Lead
    tier: orchestration
    tools: []
    agent_file: "../../agents/teaching-team-lead/teaching-team-lead.md"
    experience_enabled: true
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: >
      Manuscript Writer
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"
    experience_enabled: true

  - name: "editor"
    type: agent
    role: >
      Manuscript Editor
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"
    experience_enabled: true

levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: discussion
      coordinator: "teaching-team-lead"
      participants:
        - "writer"
        - "editor"
      on_agent_failure: skip
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        output:
          format: "final-result.md"
          user_review: false

gates:
  - from: setup
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`
}

test('removeTeamBuilderAgent clears the removed member from discussion participants and saves a valid team', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'teaching-team',
      personas: ['teaching-team-lead', 'writer', 'editor'],
      teamYaml: discussionTeamYaml(),
    })

    const team = await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'teaching-team',
      agentName: 'writer',
    })

    assert.equal(team.agents.some((agent) => agent.name === 'writer'), false)
    assert.deepEqual(savedStageList(teamYamlPath, 'setup', 'participants'), ['editor'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'agents', 'writer', 'writer.md')),
      true,
    )
  })
})

test('removeTeamBuilderAgent rejects removing the discussion coordinator and leaves team.yaml unchanged', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'teaching-team',
      personas: ['teaching-team-lead', 'writer', 'editor'],
      teamYaml: discussionTeamYaml(),
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      removeTeamBuilderAgent({
        repoRoot,
        teamId: 'teaching-team',
        agentName: 'teaching-team-lead',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Cannot remove 'teaching-team-lead'/)
        assert.match(error.message, /the discussion coordinator of level 'setup'/)
        return true
      },
    )

    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

test('removeTeamBuilderAgent clears the removed member from chain, broadcast, and pipeline lists', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'multi-mode-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "multi-mode-team"
  description: Multi mode team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: draft
    name: Draft
    order: 0
    stage:
      type: chain
      sequence:
        - "writer"
        - "editor"
  - id: spread
    name: Spread
    order: 1
    stage:
      type: broadcast
      fan_out: ["writer", "editor"]
  - id: build
    name: Build
    order: 2
    stage:
      type: pipeline
      participants:
        - "writer"
        - "lead"

gates:
  - from: draft
    to: spread
    condition:
      type: artifact_exists
      artifact: "final-result.md"
  - from: spread
    to: build
    condition:
      type: all_tasks_terminal
  - from: build
    to: done
    condition:
      type: all_tasks_terminal
`,
    })

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'multi-mode-team',
      agentName: 'writer',
    })

    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'sequence'), ['editor'])
    assert.deepEqual(savedStageList(teamYamlPath, 'spread', 'fan_out'), ['editor'])
    assert.deepEqual(savedStageList(teamYamlPath, 'build', 'participants'), ['lead'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removeTeamBuilderAgent rejects every singleton team-local reference to the member', async () => {
  const cases = [
    {
      name: 'review producer',
      expected: /the review producer of level 'setup'/,
      stage: `      type: review
      producer: "writer"
      reviewer: "editor"`,
      extra: '',
    },
    {
      name: 'review reviewer',
      expected: /the review reviewer of level 'setup'/,
      stage: `      type: review
      producer: "editor"
      reviewer: "writer"`,
      extra: '',
    },
    {
      name: 'routing coordinator',
      expected: /the routing coordinator of level 'setup'/,
      stage: `      type: routing
      coordinator: "writer"`,
      extra: '',
    },
    {
      name: 'workspace routing_agent',
      expected: /the workspace routing_agent/,
      stage: `      type: chain
      sequence:
        - "editor"`,
      extra: `
workspace:
  path: ../../workspace
  routing_agent: "writer"
`,
    },
    {
      name: 'gate transform agent',
      expected: /the gate transform agent of the gate from 'setup' to 'done'/,
      stage: `      type: chain
      sequence:
        - "editor"`,
      extra: '',
      gate: `  - from: setup
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
    transform:
      type: agent
      agent: "writer"
`,
    },
    {
      name: 'agent_verdict validator',
      expected: /the agent_verdict validator of the gate from 'setup' to 'done'/,
      stage: `      type: chain
      sequence:
        - "editor"`,
      extra: '',
      gate: `  - from: setup
    to: done
    condition:
      type: agent_verdict
      validator: "writer"
      verdict: approved
`,
    },
    {
      name: 'fallback agent',
      expected: /the on_failure\.fallback_agent of agent 'editor'/,
      stage: `      type: chain
      sequence:
        - "editor"`,
      extra: '',
      editorExtra: `    on_failure:
      policy: fallback
      fallback_agent: "writer"
`,
    },
  ]

  for (const singletonCase of cases) {
    await withTempRepo(async (repoRoot) => {
      const teamYamlPath = writeTeamRepo({
        repoRoot,
        teamId: 'singleton-team',
        personas: ['writer', 'editor'],
        teamYaml: `team:
  name: "singleton-team"
  description: Singleton team.
  version: "0.1.0"
${singletonCase.extra}
agents:
  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"
    produces:
      - path: "final-result.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"
${singletonCase.editorExtra ?? ''}
levels:
  - id: setup
    name: Setup
    order: 0
    stage:
${singletonCase.stage}

gates:
${singletonCase.gate ?? `  - from: setup
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`}`,
      })
      const before = fs.readFileSync(teamYamlPath, 'utf8')

      await assert.rejects(
        removeTeamBuilderAgent({
          repoRoot,
          teamId: 'singleton-team',
          agentName: 'writer',
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error, `${singletonCase.name}: expected an Error`)
          assert.match(error.message, /Cannot remove 'writer'/)
          assert.match(error.message, singletonCase.expected)
          return true
        },
        singletonCase.name,
      )

      assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before, singletonCase.name)
    })
  }
})

test('removeTeamBuilderAgent rejects a removal that would strip a gate artifact of its only producer', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'artifact-team',
      personas: ['writer', 'editor'],
      teamYaml: `team:
  name: "artifact-team"
  description: Artifact team.
  version: "0.1.0"

agents:
  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"
    produces:
      - path: "final-result.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence:
        - "writer"
        - "editor"

gates:
  - from: setup
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`,
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      removeTeamBuilderAgent({
        repoRoot,
        teamId: 'artifact-team',
        agentName: 'writer',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /final-result\.md/)
        return true
      },
    )

    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

/** The `agents:` list of a saved team.yaml, exactly as YAML sees it. */
function savedRosterEntries(teamYamlPath: string): YamlValue[] {
  const raw = parseYaml(fs.readFileSync(teamYamlPath, 'utf8'))
  return Array.isArray(raw.agents) ? raw.agents : []
}

function rosterEntryNamed(entries: YamlValue[], name: string): YamlValue | undefined {
  return entries.find((entry) => isYamlObject(entry) && entry.name === name)
}

test('removeTeamBuilderAgent leaves every remaining roster entry exactly as it was', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'preserving-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "preserving-team"
  description: Preserving team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    color: 33
    experience_file: "../../agents/lead/experience.md"
    provider_config:
      base_url: "https://example.invalid"
    mount:
      - from: "shared"
        to: "workspace/shared"
    on_failure:
      policy: fallback
      fallback_agent: "editor"
      max_retries: 2
    produces:
      - path: "final-result.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "sub-team"
    type: team
    role: Delegated sub-team.
    tier: strategic
    tools: []
    team_path: "../sub-team"
    input_artifact: "incoming-brief.md"
    output_artifact: "sub-result.md"

levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence:
        - "lead"
        - "writer"
        - "editor"

gates:
  - from: setup
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`,
    })
    const entriesBefore = savedRosterEntries(teamYamlPath)

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'preserving-team',
      agentName: 'writer',
    })

    // The saved roster must be the old roster minus exactly one entry: no
    // remaining entry may lose a field team.yaml supports and had.
    assert.deepEqual(
      savedRosterEntries(teamYamlPath),
      entriesBefore.filter((entry) => !isYamlObject(entry) || entry.name !== 'writer'),
    )
    assert.equal(rosterEntryNamed(savedRosterEntries(teamYamlPath), 'writer'), undefined)
    assert.deepEqual(savedStageList(teamYamlPath, 'setup', 'sequence'), ['lead', 'editor'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removeTeamBuilderAgent rejects a removal that resolves its own reference but leaves the team invalid', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'already-broken-team',
      personas: ['lead', 'writer'],
      teamYaml: `team:
  name: "already-broken-team"
  description: Already broken team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence:
        - "lead"
        - "writer"
  - id: review
    name: Review
    order: 1
    stage:
      type: chain
      sequence:
        - "ghost"

gates:
  - from: setup
    to: review
    condition:
      type: artifact_exists
      artifact: "final-result.md"
  - from: review
    to: done
    condition:
      type: all_tasks_terminal
`,
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    // Removing 'writer' does clear every reference to 'writer'. The team is
    // still broken by an unrelated dangling reference, so nothing is saved.
    await assert.rejects(
      removeTeamBuilderAgent({
        repoRoot,
        teamId: 'already-broken-team',
        agentName: 'writer',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Cannot remove 'writer'/)
        assert.match(error.message, /'ghost' not found in agent roster/)
        return true
      },
    )

    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

function rosterNames(teamYamlPath: string): string[] {
  return savedRosterEntries(teamYamlPath).flatMap((entry) =>
    isYamlObject(entry) && typeof entry.name === 'string' ? [entry.name] : [],
  )
}

/**
 * One member's raw block, from its `- name:` line to the next entry.
 *
 * Compared as text rather than as parsed values: a re-render can produce an
 * equivalent structure while destroying comments, key order and keys the writer
 * does not model, and that is exactly what these assertions are watching for.
 */
function rawRosterBlock(yaml: string, name: string): string {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`  - name: "${name}"`))
  assert.ok(start >= 0, `no roster block for ${name}`)
  let end = start + 1
  while (end < lines.length && !/^ {2}- name:/.test(lines[end]!) && !/^\S/.test(lines[end]!)) {
    end += 1
  }
  return lines.slice(start, end).join('\n')
}

function concurrentTeamYaml(): string {
  return `team:
  name: "concurrent-team"
  description: Concurrent team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: draft
    name: Draft
    order: 0
    stage:
      type: chain
      sequence:
        - "lead"
        - "writer"
        - "editor"

gates:
  - from: draft
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`
}

test('two concurrent removals both take effect instead of one overwriting the other', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'concurrent-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: concurrentTeamYaml(),
    })

    await Promise.all([
      removeTeamBuilderAgent({ repoRoot, teamId: 'concurrent-team', agentName: 'writer' }),
      removeTeamBuilderAgent({ repoRoot, teamId: 'concurrent-team', agentName: 'editor' }),
    ])

    // Neither removal may be resurrected by the other writing back its own
    // stale snapshot of the roster.
    assert.deepEqual(rosterNames(teamYamlPath), ['lead'])
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'sequence'), ['lead'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('a removal concurrent with an addition preserves both mutations', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'concurrent-team',
      personas: ['lead', 'writer', 'editor', 'reviewer'],
      teamYaml: concurrentTeamYaml(),
    })

    await Promise.all([
      addTeamBuilderAgent({ repoRoot, teamId: 'concurrent-team', agentName: 'reviewer' }),
      removeTeamBuilderAgent({ repoRoot, teamId: 'concurrent-team', agentName: 'writer' }),
    ])

    assert.deepEqual([...rosterNames(teamYamlPath)].sort(), ['editor', 'lead', 'reviewer'])
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'sequence'), ['lead', 'editor'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removeTeamBuilderAgent rejects a removal that would leave a stage with no agents', async () => {
  const cases = [
    {
      name: 'chain sequence',
      expected: /the chain sequence of level 'solo'/,
      stage: `      type: chain
      sequence:
        - "writer"`,
    },
    {
      name: 'broadcast fan_out',
      expected: /the broadcast fan_out of level 'solo'/,
      stage: `      type: broadcast
      fan_out:
        - "writer"`,
    },
    {
      name: 'discussion participants',
      expected: /the discussion participants of level 'solo'/,
      stage: `      type: discussion
      coordinator: "lead"
      participants:
        - "writer"`,
    },
  ]

  for (const emptyCase of cases) {
    await withTempRepo(async (repoRoot) => {
      const teamYamlPath = writeTeamRepo({
        repoRoot,
        teamId: 'solo-stage-team',
        personas: ['lead', 'writer'],
        teamYaml: `team:
  name: "solo-stage-team"
  description: Solo stage team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

levels:
  - id: solo
    name: Solo
    order: 0
    stage:
${emptyCase.stage}

gates:
  - from: solo
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`,
      })
      const before = fs.readFileSync(teamYamlPath, 'utf8')

      await assert.rejects(
        removeTeamBuilderAgent({
          repoRoot,
          teamId: 'solo-stage-team',
          agentName: 'writer',
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error, `${emptyCase.name}: expected an Error`)
          assert.match(error.message, /Cannot remove 'writer'/)
          assert.match(error.message, emptyCase.expected)
          return true
        },
        emptyCase.name,
      )

      assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before, emptyCase.name)
    })
  }
})

test('removeTeamBuilderAgent deletes a roster entry written as an indentless sequence', async () => {
  await withTempRepo(async (repoRoot) => {
    // YAML allows a sequence at the same indent as its key, and the repository
    // parser accepts it. A team.yaml written that way is a real team.
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'indentless-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "indentless-team"
  description: Indentless team.
  version: "0.1.0"

agents:
- name: "lead"
  type: agent
  role: Lead.
  tier: strategic
  tools: []
  agent_file: "../../agents/lead/lead.md"
  color: 33
  on_failure:
    policy: fallback
    fallback_agent: "editor"
  produces:
    - path: "final-result.md"
- name: "writer"
  type: agent
  role: Writer.
  tier: strategic
  tools: []
  agent_file: "../../agents/writer/writer.md"
- name: "editor"
  type: agent
  role: Editor.
  tier: strategic
  tools: []
  agent_file: "../../agents/editor/editor.md"

levels:
- id: draft
  name: Draft
  order: 0
  stage:
    type: chain
    sequence:
    - "lead"
    - "writer"
    - "editor"

gates:
- from: draft
  to: done
  condition:
    type: artifact_exists
    artifact: "final-result.md"
`,
    })
    const entriesBefore = savedRosterEntries(teamYamlPath)

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'indentless-team',
      agentName: 'writer',
    })

    assert.deepEqual(rosterNames(teamYamlPath), ['lead', 'editor'])
    assert.deepEqual(
      savedRosterEntries(teamYamlPath),
      entriesBefore.filter((entry) => !isYamlObject(entry) || entry.name !== 'writer'),
    )
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'sequence'), ['lead', 'editor'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removeTeamBuilderAgent prunes a stage membership indented beyond the usual two spaces', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'deep-stage-indent-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "deep-stage-indent-team"
  description: Deep stage indentation team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: draft
    name: Draft
    order: 0
    stage:
        type: chain
        sequence:
          - "lead"
          - "writer"
          - "editor"
        config:
          output:
            format: "final-result.md"
            user_review: false

gates:
  - from: draft
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`,
    })
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'deep-stage-indent-team',
      agentName: 'writer',
    })

    assert.deepEqual(rosterNames(teamYamlPath), ['lead', 'editor'])
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'sequence'), ['lead', 'editor'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removeTeamBuilderAgent finds a stage key indented beyond the usual level depth', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'deep-level-indent-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "deep-level-indent-team"
  description: Deep level indentation team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: draft
      name: Draft
      order: 0
      stage:
          type: chain
          sequence:
            - "lead"
            - "writer"
            - "editor"
          config:
            output:
              format: "final-result.md"
              user_review: false

gates:
  - from: draft
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`,
    })
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'deep-level-indent-team',
      agentName: 'writer',
    })

    assert.deepEqual(rosterNames(teamYamlPath), ['lead', 'editor'])
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'sequence'), ['lead', 'editor'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removeTeamBuilderAgent prunes only stage membership lists, not lookalike nested keys', async () => {
  await withTempRepo(async (repoRoot) => {
    // `participants` and `sequence` appear here twice more: once inside the
    // stage's own `config`, once under a level's `permissions`. Neither is a
    // stage membership field, and neither is the removal's business.
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'lookalike-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "lookalike-team"
  description: Lookalike team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: draft
    name: Draft
    order: 0
    permissions:
      loopback:
        - "writer"
    stage:
      type: discussion
      coordinator: "lead"
      participants:
        - "writer"
        - "editor"
      config:
        mode: deliberate
        transcript:
          participants:
            - "writer"
          sequence:
            - "writer"
        output:
          format: "final-result.md"
          user_review: false

gates:
  - from: draft
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`,
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'lookalike-team',
      agentName: 'writer',
    })

    const saved = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'participants'), ['editor'])
    // The two edits the operation is entitled to make, and nothing else: the
    // whole file is compared byte for byte against exactly those.
    const expected = before
      .replace(
        '  - name: "writer"\n' +
          '    type: agent\n' +
          '    role: Writer.\n' +
          '    tier: strategic\n' +
          '    tools: []\n' +
          '    agent_file: "../../agents/writer/writer.md"\n\n',
        '',
      )
      .replace(
        '      participants:\n        - "writer"\n        - "editor"\n',
        '      participants:\n        - "editor"\n',
      )
    assert.equal(saved, expected)
    assert.match(
      saved,
      /        transcript:\n          participants:\n            - "writer"\n          sequence:\n            - "writer"\n/,
    )
    assert.match(saved, /    permissions:\n      loopback:\n        - "writer"\n/)
  })
})

test('removeTeamBuilderAgent rejects a member still named as a validation gate validator', async () => {
  // Both validator-bearing condition types resolve their `validator` through
  // the agent roster at run time (`engines/gate-checker.ts:74` and `:86`), so
  // both are singleton references. Only `agent_verdict` was recognised.
  const cases = [
    {
      name: 'validation',
      expected: /the validation validator of the gate from 'draft' to 'done'/,
      condition: `      type: validation
      validator: "writer"
      strictness: hard`,
    },
    {
      name: 'agent_verdict',
      expected: /the agent_verdict validator of the gate from 'draft' to 'done'/,
      condition: `      type: agent_verdict
      validator: "writer"
      verdict: approved`,
    },
  ]

  for (const validatorCase of cases) {
    await withTempRepo(async (repoRoot) => {
      const teamYamlPath = writeTeamRepo({
        repoRoot,
        teamId: 'validator-team',
        personas: ['lead', 'writer', 'editor'],
        teamYaml: `team:
  name: "validator-team"
  description: Validator team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: draft
    name: Draft
    order: 0
    stage:
      type: chain
      sequence:
        - "lead"
        - "editor"

gates:
  - from: draft
    to: done
    condition:
${validatorCase.condition}
`,
      })
      const before = fs.readFileSync(teamYamlPath, 'utf8')

      await assert.rejects(
        removeTeamBuilderAgent({
          repoRoot,
          teamId: 'validator-team',
          agentName: 'writer',
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error, `${validatorCase.name}: expected an Error`)
          assert.match(error.message, /Cannot remove 'writer'/)
          assert.match(error.message, validatorCase.expected)
          return true
        },
        validatorCase.name,
      )

      assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before, validatorCase.name)
    })
  }
})

test('removeTeamBuilderAgent leaves a flow-style membership untouched unless the member is in it', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'flow-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "flow-team"
  description: Flow team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: draft
    name: Draft
    order: 0
    stage:
      type: discussion
      coordinator: "lead"
      participants: [writer,  editor]   # keep this note
  - id: spread
    name: Spread
    order: 1
    stage:
      type: broadcast
      fan_out: [lead,  editor]   # preserve-this-comment

gates:
  - from: draft
    to: spread
    condition:
      type: artifact_exists
      artifact: "final-result.md"
  - from: spread
    to: done
    condition:
      type: all_tasks_terminal
`,
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'flow-team',
      agentName: 'writer',
    })

    const saved = fs.readFileSync(teamYamlPath, 'utf8')
    // The broadcast never named the departing member, so its line is not this
    // operation's to reformat.
    assert.match(saved, /      fan_out: \[lead,  editor\]   # preserve-this-comment\n/)
    // The discussion did, so it is edited — keeping its inline comment and the
    // original spelling of the members that stay.
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'participants'), ['editor'])
    assert.match(saved, /      participants: \[editor\]   # keep this note\n/)
    assert.equal(
      saved,
      before
        .replace(
          '  - name: "writer"\n' +
            '    type: agent\n' +
            '    role: Writer.\n' +
            '    tier: strategic\n' +
            '    tools: []\n' +
            '    agent_file: "../../agents/writer/writer.md"\n\n',
          '',
        )
        .replace(
          '      participants: [writer,  editor]   # keep this note\n',
          '      participants: [editor]   # keep this note\n',
        ),
    )
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removing the last roster entry keeps the comments and blank lines that follow it', async () => {
  await withTempRepo(async (repoRoot) => {
    // `agents:` as an indentless sequence, with a top-level comment between its
    // last entry and `levels:`. That comment belongs to the document, not to
    // the entry that happens to precede it.
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'trailing-comment-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "trailing-comment-team"
  description: Trailing comment team.
  version: "0.1.0"

agents:
- name: "lead"
  type: agent
  role: Lead.
  tier: strategic
  tools: []
  agent_file: "../../agents/lead/lead.md"
  produces:
    - path: "final-result.md"
- name: "editor"
  type: agent
  role: Editor.
  tier: strategic
  tools: []
  agent_file: "../../agents/editor/editor.md"
- name: "writer"
  type: agent
  role: Writer.
  tier: strategic
  tools: []
  agent_file: "../../agents/writer/writer.md"

# The setup level is the only level this team runs.
levels:
- id: draft
  name: Draft
  order: 0
  stage:
    type: chain
    sequence:
    - "lead"
    - "writer"
    - "editor"

gates:
- from: draft
  to: done
  condition:
    type: artifact_exists
    artifact: "final-result.md"
`,
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'trailing-comment-team',
      agentName: 'writer',
    })

    const saved = fs.readFileSync(teamYamlPath, 'utf8')
    assert.match(saved, /\n\n# The setup level is the only level this team runs\.\nlevels:\n/)
    assert.deepEqual(rosterNames(teamYamlPath), ['lead', 'editor'])
    assert.equal(
      saved,
      before
        .replace(
          '- name: "writer"\n' +
            '  type: agent\n' +
            '  role: Writer.\n' +
            '  tier: strategic\n' +
            '  tools: []\n' +
            '  agent_file: "../../agents/writer/writer.md"\n',
          '',
        )
        .replace('    - "lead"\n    - "writer"\n', '    - "lead"\n'),
    )
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removeTeamBuilderAgent prunes only the membership key its stage type actually uses', async () => {
  await withTempRepo(async (repoRoot) => {
    // A chain reads `sequence`; `parseChainStage` never looks at a direct
    // `participants` key, and a broadcast never looks at `sequence`. Those
    // lookalikes are inert configuration, not rosters.
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'wrong-key-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: `team:
  name: "wrong-key-team"
  description: Wrong key team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

levels:
  - id: draft
    name: Draft
    order: 0
    stage:
      type: chain
      participants:
        - "writer"
        - "editor"
      sequence:
        - "lead"
        - "writer"
  - id: spread
    name: Spread
    order: 1
    stage:
      type: broadcast
      sequence: [writer,  editor]
      fan_out:
        - "lead"
        - "writer"

gates:
  - from: draft
    to: spread
    condition:
      type: artifact_exists
      artifact: "final-result.md"
  - from: spread
    to: done
    condition:
      type: all_tasks_terminal
`,
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'wrong-key-team',
      agentName: 'writer',
    })

    const saved = fs.readFileSync(teamYamlPath, 'utf8')
    // Pruned: the key each stage type genuinely reads.
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'sequence'), ['lead'])
    assert.deepEqual(savedStageList(teamYamlPath, 'spread', 'fan_out'), ['lead'])
    // Untouched: the same names under a key that stage type never reads.
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'participants'), ['writer', 'editor'])
    assert.match(saved, /      sequence: \[writer,  editor\]\n/)
    assert.equal(
      saved,
      before
        .replace(
          '  - name: "writer"\n' +
            '    type: agent\n' +
            '    role: Writer.\n' +
            '    tier: strategic\n' +
            '    tools: []\n' +
            '    agent_file: "../../agents/writer/writer.md"\n\n',
          '',
        )
        .replace('      sequence:\n        - "lead"\n        - "writer"\n', '      sequence:\n        - "lead"\n')
        .replace('      fan_out:\n        - "lead"\n        - "writer"\n', '      fan_out:\n        - "lead"\n'),
    )
  })
})

test('a removal concurrent with the Agent page adding to a team preserves both mutations', async () => {
  await withTempRepo(async (repoRoot) => {
    // `addAgentToTeam` is the other public writer of team.yaml — the Agent
    // page's "add to team" — and it must serialize against removal too.
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'concurrent-team',
      personas: ['lead', 'writer', 'editor', 'reviewer'],
      teamYaml: concurrentTeamYaml(),
    })

    const [added] = await Promise.all([
      addAgentToTeam({ repoRoot, teamId: 'concurrent-team', agentName: 'reviewer' }),
      removeTeamBuilderAgent({ repoRoot, teamId: 'concurrent-team', agentName: 'writer' }),
    ])

    assert.equal(added.added, true)
    assert.equal(added.agentName, 'reviewer')
    assert.equal(added.teamId, 'concurrent-team')
    assert.equal(added.teamYamlPath, teamYamlPath)
    assert.deepEqual([...rosterNames(teamYamlPath)].sort(), ['editor', 'lead', 'reviewer'])
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'sequence'), ['lead', 'editor'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('the Agent page adds a member without writing a grade, and leaves the existing ones alone', async () => {
  await withTempRepo(async (repoRoot) => {
    // `addAgentToTeam` used to read a grade off the persona, silently default a
    // missing or unrecognized one to `strategic`, and write a `tier:` line into
    // the roster entry. Nothing new authors a grade now, so the entry it writes
    // must not have one — while every member that was already on the roster
    // keeps the exact block somebody wrote by hand.
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'concurrent-team',
      personas: ['lead', 'writer', 'editor', 'reviewer'],
      // A comment and a key this writer does not model, inside an existing
      // member's own block. Re-rendering the roster would lose both.
      teamYaml: concurrentTeamYaml().replace(
        '  - name: "writer"\n    type: agent\n    role: Writer.\n',
        '  # kept by hand: the writer drafts before the editor sees it\n' +
          '  - name: "writer"\n    type: agent\n    role: Writer.\n    handoff_note: "drafts first"\n',
      ),
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    const added = await addAgentToTeam({
      repoRoot,
      teamId: 'concurrent-team',
      agentName: 'reviewer',
      role: 'Reviews the draft.',
    })

    assert.equal(added.added, true)
    const saved = fs.readFileSync(teamYamlPath, 'utf8')
    const entries = savedRosterEntries(teamYamlPath)
    const addedEntry = entries.find(
      (entry) => isYamlObject(entry) && entry.name === 'reviewer',
    )
    assert.ok(isYamlObject(addedEntry), saved)
    assert.equal(addedEntry.tier, undefined, saved)
    assert.equal(addedEntry.role, 'Reviews the draft.')
    assert.equal(addedEntry.agent_file, '../../agents/reviewer/reviewer.md')

    // The persona this member was added from still carries a grade, and it was
    // not copied into the roster and not removed from the persona.
    assert.match(
      fs.readFileSync(path.join(repoRoot, 'agents', 'reviewer', 'reviewer.md'), 'utf8'),
      /^tier: strategic$/m,
    )

    // Every seeded member's own block is still there verbatim — grade, hand
    // comment and unmodelled key included — so nothing was re-rendered.
    for (const seeded of ['lead', 'writer', 'editor']) {
      assert.ok(
        saved.includes(rawRosterBlock(before, seeded)),
        `${seeded}'s block was rewritten:\n${saved}`,
      )
      const seededEntry = entries.find(
        (entry) => isYamlObject(entry) && entry.name === seeded,
      )
      assert.ok(isYamlObject(seededEntry))
      assert.equal(seededEntry.tier, 'strategic', `${seeded} kept its grade`)
    }
    assert.match(saved, /# kept by hand: the writer drafts before the editor sees it/)
    assert.match(saved, /^ {4}handoff_note: "drafts first"$/m)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

test('removing a name that is not on the roster rewrites nothing', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'concurrent-team',
      personas: ['lead', 'writer', 'editor'],
      teamYaml: concurrentTeamYaml(),
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')
    const modifiedBefore = fs.statSync(teamYamlPath).mtimeMs

    const team = await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'concurrent-team',
      agentName: 'nobody',
    })

    assert.deepEqual(team.agents.map((agent) => agent.name), ['lead', 'writer', 'editor'])
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
    assert.equal(fs.statSync(teamYamlPath).mtimeMs, modifiedBefore)
  })
})

test('removeTeamBuilderAgent prunes a block membership list that has a comment and a blank line inside it', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'interrupted-list-team',
      personas: ['lead', 'writer', 'editor', 'reviewer'],
      teamYaml: `team:
  name: "interrupted-list-team"
  description: Interrupted list team.
  version: "0.1.0"

agents:
  - name: "lead"
    type: agent
    role: Lead.
    tier: strategic
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "editor"
    type: agent
    role: Editor.
    tier: strategic
    tools: []
    agent_file: "../../agents/editor/editor.md"

  - name: "writer"
    type: agent
    role: Writer.
    tier: strategic
    tools: []
    agent_file: "../../agents/writer/writer.md"

  - name: "reviewer"
    type: agent
    role: Reviewer.
    tier: strategic
    tools: []
    agent_file: "../../agents/reviewer/reviewer.md"

levels:
  - id: draft
    name: Draft
    order: 0
    stage:
      type: discussion
      coordinator: "lead"
      participants:
        - "editor"
        # the writer joins late in the cycle
        - "writer"

        - "reviewer"
      config:
        mode: deliberate
        output:
          format: "final-result.md"
          user_review: false

gates:
  - from: draft
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`,
    })
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'interrupted-list-team',
      agentName: 'writer',
    })

    const saved = fs.readFileSync(teamYamlPath, 'utf8')
    // A comment or a blank line inside the list does not end it.
    assert.deepEqual(savedStageList(teamYamlPath, 'draft', 'participants'), [
      'editor',
      'reviewer',
    ])
    // Both survive exactly, in place, with only the departing member's line gone.
    assert.match(
      saved,
      /        - "editor"\n        # the writer joins late in the cycle\n\n        - "reviewer"\n/,
    )
    assert.equal(
      saved,
      before
        .replace(
          '  - name: "writer"\n' +
            '    type: agent\n' +
            '    role: Writer.\n' +
            '    tier: strategic\n' +
            '    tools: []\n' +
            '    agent_file: "../../agents/writer/writer.md"\n\n',
          '',
        )
        .replace('        - "writer"\n', ''),
    )
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

/** Write a persona file the team builder can bind a roster entry to. */
function writePersona(repoRoot: string, name: string): void {
  const agentDir = path.join(repoRoot, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    `---
name: ${name}
description: ${name} persona.
tier: strategic
---

# ${name}
`,
  )
}

/** The `produces:` paths one roster entry declares in a saved team.yaml. */
function producedPaths(teamYamlPath: string, agentName: string): string[] {
  const entry = rosterEntryNamed(savedRosterEntries(teamYamlPath), agentName)
  assert.ok(isYamlObject(entry), `roster entry '${agentName}' is missing`)
  const produces = entry.produces
  if (!Array.isArray(produces)) return []
  return produces.flatMap((artifact) =>
    isYamlObject(artifact) && typeof artifact.path === 'string' ? [artifact.path] : [],
  )
}

// Adding a member moves `produces: final-result.md` to the newest agent and
// leaves the previous owner with a literal `produces: []`. Removing that newest
// member has to hand ownership back, or validation refuses the write and the
// user cannot undo the addition they just made.
test('removing the newest generated-team member returns the final artifact to the agent before it', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    writePersona(repoRoot, 'alpha')
    writePersona(repoRoot, 'beta')

    await createTeamBuilderTeam(repoRoot, {
      id: 'generated-team',
      description: 'A generated team.',
    })
    const teamYamlPath = path.join(repoRoot, 'teams', 'generated-team', 'team.yaml')

    await addTeamBuilderAgent({ repoRoot, teamId: 'generated-team', agentName: 'alpha' })
    await addTeamBuilderAgent({ repoRoot, teamId: 'generated-team', agentName: 'beta' })

    // Precondition: the addition moved ownership to beta, exactly as P1 describes.
    assert.deepEqual(producedPaths(teamYamlPath, 'alpha'), [])
    assert.deepEqual(producedPaths(teamYamlPath, 'beta'), ['final-result.md'])

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'generated-team',
      agentName: 'beta',
    })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(
      savedRosterEntries(teamYamlPath).flatMap((entry) =>
        isYamlObject(entry) && typeof entry.name === 'string' ? [entry.name] : [],
      ),
      ['alpha'],
      savedYaml,
    )
    // Ownership is back with the last sequence member, and only with it.
    assert.deepEqual(producedPaths(teamYamlPath, 'alpha'), ['final-result.md'])
    // One owner, never two: a duplicate producer is a visible health warning.
    assert.deepEqual(
      savedRosterEntries(teamYamlPath).flatMap((entry) =>
        isYamlObject(entry) && typeof entry.name === 'string' &&
        producedPaths(teamYamlPath, entry.name).includes('final-result.md')
          ? [entry.name]
          : [],
      ),
      ['alpha'],
      savedYaml,
    )
    // And the saved file still parses as a valid team.
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], savedYaml)
  })
})

// The inverse case. Removing a member who does not own the output must not
// hand a second copy to the agent who already owns it: two producers for one
// artifact is a duplicate-producer health warning, visible to the user.
test('removing a generated-team member who owns nothing leaves the existing owner alone', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    writePersona(repoRoot, 'alpha')
    writePersona(repoRoot, 'beta')

    await createTeamBuilderTeam(repoRoot, {
      id: 'generated-team',
      description: 'A generated team.',
    })
    const teamYamlPath = path.join(repoRoot, 'teams', 'generated-team', 'team.yaml')

    await addTeamBuilderAgent({ repoRoot, teamId: 'generated-team', agentName: 'alpha' })
    await addTeamBuilderAgent({ repoRoot, teamId: 'generated-team', agentName: 'beta' })

    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'generated-team',
      agentName: 'alpha',
    })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(producedPaths(teamYamlPath, 'beta'), ['final-result.md'], savedYaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], savedYaml)
  })
})

// A hand-authored team may legitimately use the same conventional output name
// a generated team uses. Matching on that name alone is not provenance: it lets
// the ownership transfer reach a file its author arranged deliberately, and the
// removal that should be refused silently succeeds instead.
test('a hand-authored team using the generated output name is still protected from ownership transfer', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'conventional-team',
      personas: ['alpha', 'beta'],
      teamYaml: `team:
  name: "conventional-team"
  description: Hand-authored, no orchestrator provenance.
  version: "0.1.0"

workflow:
  entry_level: setup
  output_contract:
    artifacts:
      - path: "final-result.md"
        required: true
    completion_artifact: "final-result.md"

agents:
  - name: "alpha"
    type: agent
    role: Alpha.
    tools: []
    agent_file: "../../agents/alpha/alpha.md"
    produces:
      - path: "final-result.md"

  - name: "beta"
    type: agent
    role: Beta.
    tools: []
    agent_file: "../../agents/beta/beta.md"

levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence:
        - "alpha"
        - "beta"

gates:
  - from: setup
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`,
    })
    // The author's arrangement parses cleanly and alpha owns the deliverable.
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
    assert.deepEqual(producedPaths(teamYamlPath, 'alpha'), ['final-result.md'])
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      removeTeamBuilderAgent({
        repoRoot,
        teamId: 'conventional-team',
        agentName: 'alpha',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /final-result\.md/)
        return true
      },
    )

    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

// `orchestratorKey` is an optional input that names the plan a build came from,
// for resuming an interrupted one. It is not what makes a team this app's own:
// `createTeamBuilderTeamDetail` (services/team-builder-service.ts:68) creates
// teams without it, and those are app-created too. Keying managed behaviour on
// that optional parameter left the documented public create-then-add path with
// a gate nobody produces.
test('a team created through the public path, with no orchestrator key, still owns its output', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    writePersona(repoRoot, 'alpha')
    writePersona(repoRoot, 'beta')

    await createTeamBuilderTeam(repoRoot, {
      id: 'public-team',
      description: 'Created without an orchestrator key.',
    })
    const teamYamlPath = path.join(repoRoot, 'teams', 'public-team', 'team.yaml')

    await addTeamBuilderAgent({ repoRoot, teamId: 'public-team', agentName: 'alpha' })
    assert.deepEqual(
      parseTeamConfig(teamYamlPath).errors,
      [],
      fs.readFileSync(teamYamlPath, 'utf8'),
    )
    await addTeamBuilderAgent({ repoRoot, teamId: 'public-team', agentName: 'beta' })
    assert.deepEqual(
      parseTeamConfig(teamYamlPath).errors,
      [],
      fs.readFileSync(teamYamlPath, 'utf8'),
    )
    assert.deepEqual(producedPaths(teamYamlPath, 'beta'), ['final-result.md'])

    // And the addition is still undoable, which is what V1 fixed.
    await removeTeamBuilderAgent({ repoRoot, teamId: 'public-team', agentName: 'beta' })
    assert.deepEqual(producedPaths(teamYamlPath, 'alpha'), ['final-result.md'])
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
  })
})

/** The `team:` block's provenance marker, or undefined when it has none. */
function recordedProvenance(teamYamlPath: string): unknown {
  const raw = parseYaml(fs.readFileSync(teamYamlPath, 'utf8'))
  return isYamlObject(raw.team) ? raw.team.created_by : undefined
}

/** A hand-authored team.yaml using the same conventional output name. */
function conventionalTeamYaml(name: string): string {
  return `team:
  name: "${name}"
  description: Hand-authored, no provenance.
  version: "0.1.0"

workflow:
  entry_level: setup
  output_contract:
    artifacts:
      - path: "final-result.md"
        required: true
    completion_artifact: "final-result.md"

agents:
  - name: "alpha"
    type: agent
    role: Alpha.
    tools: []
    agent_file: "../../agents/alpha/alpha.md"
    produces:
      - path: "final-result.md"

  - name: "beta"
    type: agent
    role: Beta.
    tools: []
    agent_file: "../../agents/beta/beta.md"

levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: chain
      sequence:
        - "alpha"
        - "beta"

gates:
  - from: setup
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`
}

// Provenance is recorded at creation and nowhere else. A metadata edit that
// re-renders the `team:` block would otherwise mint the marker on a file this
// app did not author, and the very next removal would rewrite its ownership.
// The marker is only a safe compatibility mechanism if every writer preserves
// its meaning, including its absence.
test('editing a hand-authored team description does not manufacture provenance', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'conventional-team',
      personas: ['alpha', 'beta'],
      teamYaml: conventionalTeamYaml('conventional-team'),
    })
    assert.equal(recordedProvenance(teamYamlPath), undefined)

    await updateTeamBuilderTeam(repoRoot, 'conventional-team', {
      id: 'conventional-team',
      description: 'Only a description edit.',
    })

    assert.equal(recordedProvenance(teamYamlPath), undefined)
    // And the guard that absence buys is still in force.
    const before = fs.readFileSync(teamYamlPath, 'utf8')
    await assert.rejects(
      removeTeamBuilderAgent({
        repoRoot,
        teamId: 'conventional-team',
        agentName: 'alpha',
      }),
      /final-result\.md/,
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

test('renaming a hand-authored team does not manufacture provenance', async () => {
  await withTempRepo(async (repoRoot) => {
    writeTeamRepo({
      repoRoot,
      teamId: 'conventional-team',
      personas: ['alpha', 'beta'],
      teamYaml: conventionalTeamYaml('conventional-team'),
    })

    await updateTeamBuilderTeam(repoRoot, 'conventional-team', {
      id: 'renamed-team',
      description: 'Renamed, still hand-authored.',
    })

    const renamedPath = path.join(repoRoot, 'teams', 'renamed-team', 'team.yaml')
    assert.equal(recordedProvenance(renamedPath), undefined)
    await assert.rejects(
      removeTeamBuilderAgent({ repoRoot, teamId: 'renamed-team', agentName: 'alpha' }),
      /final-result\.md/,
    )
  })
})

// The converse: an edit to a team this app did author must not lose the marker,
// or an ordinary rename would turn a generated team into an unmanaged one.
test('editing a generated team keeps its provenance', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    writePersona(repoRoot, 'alpha')
    await createTeamBuilderTeam(repoRoot, {
      id: 'generated-team',
      description: 'A generated team.',
    })

    await updateTeamBuilderTeam(repoRoot, 'generated-team', {
      id: 'generated-renamed',
      description: 'Renamed.',
    })

    const renamedPath = path.join(repoRoot, 'teams', 'generated-renamed', 'team.yaml')
    assert.equal(recordedProvenance(renamedPath), 'team-builder')
  })
})

/** Every roster entry that declares the generated deliverable. */
function generatedOwnerNames(teamYamlPath: string): string[] {
  return savedRosterEntries(teamYamlPath).flatMap((entry) =>
    isYamlObject(entry) &&
    typeof entry.name === 'string' &&
    producedPaths(teamYamlPath, entry.name).includes('final-result.md')
      ? [entry.name]
      : [],
  )
}

// The ownership editors match `produces:` as an exact line. A trailing comment
// on that key is ordinary YAML the shipped parser reads without complaint, and
// it made the previous owner invisible to the stripper — so the artifact ended
// up declared twice and the team carried a duplicate-producer warning.
test('a commented produces: header still yields exactly one output owner after an add', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    for (const name of ['alpha', 'beta', 'gamma']) writePersona(repoRoot, name)
    await createTeamBuilderTeam(repoRoot, {
      id: 'commented-team',
      description: 'A generated team.',
    })
    const teamYamlPath = path.join(repoRoot, 'teams', 'commented-team', 'team.yaml')
    await addTeamBuilderAgent({ repoRoot, teamId: 'commented-team', agentName: 'alpha' })
    await addTeamBuilderAgent({ repoRoot, teamId: 'commented-team', agentName: 'beta' })

    // Ordinary YAML: a comment on the key beta already owns.
    fs.writeFileSync(
      teamYamlPath,
      fs.readFileSync(teamYamlPath, 'utf8').replace(
        /^(\s*)produces:$/mu,
        '$1produces: # the deliverable',
      ),
    )
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
    assert.deepEqual(generatedOwnerNames(teamYamlPath), ['beta'])

    await addTeamBuilderAgent({ repoRoot, teamId: 'commented-team', agentName: 'gamma' })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(generatedOwnerNames(teamYamlPath), ['gamma'], savedYaml)
    const parsed = parseTeamConfig(teamYamlPath)
    assert.deepEqual(parsed.errors, [], savedYaml)
    assert.deepEqual(
      parsed.warnings.filter((warning) => /declared as produced by both/u.test(warning)),
      [],
      savedYaml,
    )
  })
})

// Returning ownership rewrites one declaration. Everything else in that entry
// is the author's, including a comment beside an unrelated artifact.
test('returning ownership keeps unrelated declarations and their comments', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    for (const name of ['alpha', 'beta']) writePersona(repoRoot, name)
    await createTeamBuilderTeam(repoRoot, {
      id: 'annotated-team',
      description: 'A generated team.',
    })
    const teamYamlPath = path.join(repoRoot, 'teams', 'annotated-team', 'team.yaml')
    await addTeamBuilderAgent({ repoRoot, teamId: 'annotated-team', agentName: 'alpha' })
    await addTeamBuilderAgent({ repoRoot, teamId: 'annotated-team', agentName: 'beta' })

    // alpha keeps an unrelated output of its own, with a note beside it.
    fs.writeFileSync(
      teamYamlPath,
      fs.readFileSync(teamYamlPath, 'utf8').replace(
        '    produces: []',
        '    produces: # Keep unrelated output annotation\n      - path: "notes.md"',
      ),
    )
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])

    await removeTeamBuilderAgent({ repoRoot, teamId: 'annotated-team', agentName: 'beta' })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(
      producedPaths(teamYamlPath, 'alpha').sort(),
      ['final-result.md', 'notes.md'],
      savedYaml,
    )
    assert.match(savedYaml, /Keep unrelated output annotation/u, savedYaml)
    assert.deepEqual(generatedOwnerNames(teamYamlPath), ['alpha'], savedYaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], savedYaml)
  })
})

// The inline branch: ownership removal writes `produces: []`, and an author may
// annotate that key. Granting ownership back replaces the value, not the note.
test('granting ownership onto an annotated empty list keeps the note', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    for (const name of ['alpha', 'beta']) writePersona(repoRoot, name)
    await createTeamBuilderTeam(repoRoot, {
      id: 'inline-annotated-team',
      description: 'A generated team.',
    })
    const teamYamlPath = path.join(repoRoot, 'teams', 'inline-annotated-team', 'team.yaml')
    await addTeamBuilderAgent({ repoRoot, teamId: 'inline-annotated-team', agentName: 'alpha' })
    await addTeamBuilderAgent({ repoRoot, teamId: 'inline-annotated-team', agentName: 'beta' })

    // alpha's list was emptied when beta took ownership. Annotate that key.
    fs.writeFileSync(
      teamYamlPath,
      fs.readFileSync(teamYamlPath, 'utf8').replace(
        '    produces: []',
        '    produces: [] # alpha writes nothing of its own',
      ),
    )
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])

    // Removing beta hands ownership back to alpha through the inline branch.
    await removeTeamBuilderAgent({
      repoRoot,
      teamId: 'inline-annotated-team',
      agentName: 'beta',
    })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(generatedOwnerNames(teamYamlPath), ['alpha'], savedYaml)
    assert.match(savedYaml, /alpha writes nothing of its own/u, savedYaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], savedYaml)
  })
})

/**
 * Rewrites one line inside the `agents:` block only.
 *
 * The workflow output contract declares the same artifact with the same
 * indentation, so a plain replace edits that instead and the roster is left
 * untouched — a fixture that proves nothing.
 */
function editRosterBlock(
  teamYamlPath: string,
  find: string,
  replacement: string,
): void {
  const yaml = fs.readFileSync(teamYamlPath, 'utf8')
  const rosterStart = yaml.indexOf('\nagents:')
  assert.ok(rosterStart >= 0, yaml)
  const head = yaml.slice(0, rosterStart)
  const roster = yaml.slice(rosterStart)
  assert.ok(roster.includes(find), roster)
  fs.writeFileSync(teamYamlPath, head + roster.replace(find, replacement))
}

/** A generated two-member team whose beta owns the deliverable. */
async function generatedPairTeam(repoRoot: string, teamId: string): Promise<string> {
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  for (const name of ['alpha', 'beta', 'gamma']) writePersona(repoRoot, name)
  await createTeamBuilderTeam(repoRoot, { id: teamId, description: 'A generated team.' })
  await addTeamBuilderAgent({ repoRoot, teamId, agentName: 'alpha' })
  await addTeamBuilderAgent({ repoRoot, teamId, agentName: 'beta' })
  return path.join(repoRoot, 'teams', teamId, 'team.yaml')
}

// A mapping's keys have no required order. An item written description-first is
// the same declaration as one written path-first, and the shipped parser reads
// both. Matching list items by a leading `- path:` made an unrelated artifact
// look like part of the generated one, and removing ownership deleted it.
test('an unrelated artifact written description-first survives an ownership move', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = await generatedPairTeam(repoRoot, 'field-order-team')
    editRosterBlock(
      teamYamlPath,
      '      - path: "final-result.md"',
      [
        '      - path: "final-result.md"',
        '      - description: Independent notes with description first.',
        '        path: notes.md',
      ].join('\n'),
    )
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
    assert.deepEqual(producedPaths(teamYamlPath, 'beta').sort(), ['final-result.md', 'notes.md'])

    await addTeamBuilderAgent({ repoRoot, teamId: 'field-order-team', agentName: 'gamma' })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    // beta gives up the deliverable and keeps everything that was its own.
    assert.deepEqual(producedPaths(teamYamlPath, 'beta'), ['notes.md'], savedYaml)
    assert.match(savedYaml, /Independent notes with description first/u, savedYaml)
    assert.deepEqual(generatedOwnerNames(teamYamlPath), ['gamma'], savedYaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], savedYaml)
  })
})

// The same blindness in the other direction: a generated declaration written
// description-first was not recognised at all, so the previous owner kept it
// and the artifact ended up declared twice.
test('a generated declaration written description-first is still moved, not duplicated', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = await generatedPairTeam(repoRoot, 'path-second-team')
    editRosterBlock(
      teamYamlPath,
      '      - path: "final-result.md"',
      [
        '      - description: Final result with description first.',
        '        path: final-result.md',
      ].join('\n'),
    )
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [])
    assert.deepEqual(generatedOwnerNames(teamYamlPath), ['beta'])

    await addTeamBuilderAgent({ repoRoot, teamId: 'path-second-team', agentName: 'gamma' })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(generatedOwnerNames(teamYamlPath), ['gamma'], savedYaml)
    const parsed = parseTeamConfig(teamYamlPath)
    assert.deepEqual(parsed.errors, [], savedYaml)
    assert.deepEqual(
      parsed.warnings.filter((warning) => /declared as produced by both/u.test(warning)),
      [],
      savedYaml,
    )
  })
})

// The batch writer takes the same path, so one authorized multi-member add must
// leave exactly one owner too.
test('a batch addition also leaves exactly one output owner', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = await generatedPairTeam(repoRoot, 'batch-owner-team')
    const revision = digestTeamYaml(fs.readFileSync(teamYamlPath, 'utf8'))

    await addTeamBuilderAgents({
      repoRoot,
      teamId: 'batch-owner-team',
      expectedRevision: revision,
      agents: [{ name: 'gamma' }],
    })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(generatedOwnerNames(teamYamlPath), ['gamma'], savedYaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], savedYaml)
  })
})

/** A generated team whose stage is a two-role review over alpha and beta. */
async function generatedReviewTeam(repoRoot: string, teamId: string): Promise<string> {
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  for (const name of ['alpha', 'beta', 'gamma']) writePersona(repoRoot, name)
  await createTeamBuilderTeam(repoRoot, {
    id: teamId,
    description: 'A generated review team.',
    shape: {
      kind: 'review',
      rationale: 'One writes, one checks.',
      depth: 'quick',
      producer: 'alpha',
      reviewer: 'beta',
    },
  })
  await addTeamBuilderAgent({ repoRoot, teamId, agentName: 'alpha' })
  await addTeamBuilderAgent({ repoRoot, teamId, agentName: 'beta' })
  return path.join(repoRoot, 'teams', teamId, 'team.yaml')
}

// A review stage has no membership list, so a third member joins the roster and
// is never dispatched. Accepting it tells the user their agent is on the team
// when nothing will ever run it.
test('a review team refuses a third member, and says why', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = await generatedReviewTeam(repoRoot, 'two-role-team')
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      addTeamBuilderAgent({ repoRoot, teamId: 'two-role-team', agentName: 'gamma' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /one writer and one checker/iu)
        assert.match(error.message, /gamma/u)
        return true
      },
    )

    // Refused before anything was written.
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

test('the batch writer refuses the same third member', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = await generatedReviewTeam(repoRoot, 'two-role-batch-team')
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      addTeamBuilderAgents({
        repoRoot,
        teamId: 'two-role-batch-team',
        expectedRevision: digestTeamYaml(before),
        agents: [{ name: 'gamma' }],
      }),
      /one writer and one checker/iu,
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

test('the Agent page refuses the same third member', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = await generatedReviewTeam(repoRoot, 'two-role-usage-team')
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      addAgentToTeam({
        repoRoot,
        teamId: 'two-role-usage-team',
        agentName: 'gamma',
      }),
      /one writer and one checker/iu,
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

// A hand-authored review is the author's own arrangement and is not governed by
// the generated two-role contract.
test('a hand-authored review team is left to its author', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeTeamRepo({
      repoRoot,
      teamId: 'authored-review',
      personas: ['alpha', 'beta', 'gamma'],
      teamYaml: `team:
  name: "authored-review"
  description: Hand-authored review.
  version: "0.1.0"

agents:
  - name: "alpha"
    type: agent
    role: Writer.
    tools: []
    agent_file: "../../agents/alpha/alpha.md"

  - name: "beta"
    type: agent
    role: Checker.
    tools: []
    agent_file: "../../agents/beta/beta.md"

levels:
  - id: setup
    name: Setup
    order: 0
    stage:
      type: review
      producer: "alpha"
      reviewer: "beta"

gates: []
`,
    })

    await addTeamBuilderAgent({ repoRoot, teamId: 'authored-review', agentName: 'gamma' })
    assert.match(fs.readFileSync(teamYamlPath, 'utf8'), /name: "gamma"/u)
  })
})

// Being allowed onto the roster is not the same as being run. A discussion has
// a participants list, and a member added through any page has to reach it or
// it sits on the team and never speaks.
test('the Agent page wires a new discussion member into the stage', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    for (const name of ['alpha', 'beta', 'gamma']) writePersona(repoRoot, name)
    await createTeamBuilderTeam(repoRoot, {
      id: 'usage-discussion',
      description: 'A generated discussion team.',
      shape: {
        kind: 'discussion',
        rationale: 'They disagree usefully.',
        depth: 'quick',
        coordinator: 'alpha',
        participants: ['beta'],
      },
    })
    const teamYamlPath = path.join(repoRoot, 'teams', 'usage-discussion', 'team.yaml')
    await addTeamBuilderAgent({ repoRoot, teamId: 'usage-discussion', agentName: 'alpha' })
    await addTeamBuilderAgent({ repoRoot, teamId: 'usage-discussion', agentName: 'beta' })

    await addAgentToTeam({ repoRoot, teamId: 'usage-discussion', agentName: 'gamma' })

    const savedYaml = fs.readFileSync(teamYamlPath, 'utf8')
    const stage = savedStageOf(teamYamlPath)
    assert.deepEqual(stage.participants, ['beta', 'gamma'], savedYaml)
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], savedYaml)
  })
})

/** The entry level's stage, as the saved file records it. */
function savedStageOf(teamYamlPath: string): YamlObject {
  const raw = parseYaml(fs.readFileSync(teamYamlPath, 'utf8'))
  const level = Array.isArray(raw.levels) ? raw.levels[0] : undefined
  assert.ok(isYamlObject(level) && isYamlObject(level.stage))
  return level.stage
}
