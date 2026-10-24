import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'
import {
  addTeamBuilderAgent,
  addTeamBuilderAgents,
  createTeamBuilderTeam,
  digestTeamYaml,
  listTeamBuilderTeams,
  updateTeamBuilderTeam,
} from '../../domains/agent-generator/team-manager.js'
import { AGENT_TIER, STAGE_TYPE } from '../../core/constants.js'
import type { AgentRosterEntry, LevelConfig } from '../../core/types.js'

const FINAL_RESULT = 'final-result.md'

function withTempRepo(run: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-health-cleanup-'))
  return Promise.resolve(run(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })
}

function writePersona(repoRoot: string, name: string): void {
  const agentDir = path.join(repoRoot, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    `---
name: ${name}
description: ${name} specialist.
tier: strategic
---

# ${name}
`,
  )
}

function isYamlObject(value: unknown): value is YamlObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function artifactPaths(value: YamlValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isYamlObject(entry) || typeof entry.path !== 'string') return []
    return [entry.path]
  })
}

function finalResultProducers(yaml: string): string[] {
  const raw = parseYaml(yaml)
  if (!Array.isArray(raw.agents)) return []
  return raw.agents.flatMap((entry) => {
    if (!isYamlObject(entry) || typeof entry.name !== 'string') return []
    return artifactPaths(entry.produces).includes(FINAL_RESULT) ? [entry.name] : []
  })
}

function stageMembers(yaml: string, stageType: string, key: string): string[] {
  const raw = parseYaml(yaml)
  if (!Array.isArray(raw.levels)) return []
  const level = raw.levels.find((entry) => {
    if (!isYamlObject(entry) || !isYamlObject(entry.stage)) return false
    return entry.stage.type === stageType
  })
  if (!isYamlObject(level) || !isYamlObject(level.stage)) return []
  const members = level.stage[key]
  return Array.isArray(members) ? members.map(String) : []
}

function customDiscussionYaml(): string {
  return `team:
  name: "custom-discussion"
  description: Custom discussion topology.
  version: "0.1.0"

workflow:
  entry_level: deliberation
  output_contract:
    artifacts:
      - path: "final-result.md"
        required: true
    completion_artifact: "final-result.md"

agents:
  - name: "lead"
    type: agent
    role: Discussion lead and selected final artifact owner.
    tier: orchestration
    tools: []
    agent_file: "../../agents/lead/lead.md"
    produces:
      - path: "final-result.md"

  - name: "participant"
    type: agent
    role: Discussion participant.
    tier: strategic
    tools: []
    agent_file: "../../agents/participant/participant.md"

levels:
  - id: deliberation
    name: Deliberation
    order: 0
    stage:
      type: discussion
      coordinator: "lead"
      participants:
        - "participant"
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: "final-result.md"
          user_review: false

gates:
  - from: deliberation
    to: done
    condition:
      type: artifact_exists
      artifact: "final-result.md"
`
}

function writeCustomDiscussionRepo(repoRoot: string): string {
  for (const name of ['lead', 'participant', 'new-participant']) {
    writePersona(repoRoot, name)
  }
  const teamDir = path.join(repoRoot, 'teams', 'custom-discussion')
  fs.mkdirSync(teamDir, { recursive: true })
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  fs.writeFileSync(teamYamlPath, customDiscussionYaml())
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    `custom-discussion:
  type: team
  description: Custom discussion topology.
  team_path: ./teams/custom-discussion
`,
  )
  return teamYamlPath
}

function makeAgent(name: string): AgentRosterEntry {
  return {
    name,
    type: 'agent',
    role: `${name} role`,
    agent_file: `agents/${name}/${name}.md`,
  }
}

function coordinatorAndSynthesisLevels(synthesisAgent = 'lead'): LevelConfig[] {
  return [
    {
      id: 'deliberation',
      name: 'Deliberation',
      order: 0,
      stage: {
        type: STAGE_TYPE.DISCUSSION,
        coordinator: 'lead',
        participants: ['specialist'],
        config: {
          mode: 'deliberate',
          min_rounds: 1,
          max_rounds: 2,
          constraints: { max_time_minutes: 5, max_budget_usd: 1 },
          output: { format: 'deliberation.md', user_review: false },
        },
      },
    },
    {
      id: 'synthesis',
      name: 'Synthesis',
      order: 1,
      stage: {
        type: STAGE_TYPE.CHAIN,
        sequence: [synthesisAgent],
        config: {
          output: { format: FINAL_RESULT, user_review: false },
        },
      },
    },
  ]
}

function routingAndSynthesisLevels(): LevelConfig[] {
  return [
    {
      id: 'routing',
      name: 'Routing',
      order: 0,
      stage: {
        type: STAGE_TYPE.ROUTING,
        coordinator: 'lead',
        config: {
          output: { format: 'routing-decision.json', user_review: false },
        },
      },
    },
    {
      id: 'synthesis',
      name: 'Synthesis',
      order: 1,
      stage: {
        type: STAGE_TYPE.CHAIN,
        sequence: ['lead'],
        config: {
          output: { format: FINAL_RESULT, user_review: false },
        },
      },
    },
  ]
}

test('generated sequential additions move final-result.md ownership to the final sequence agent', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    writePersona(repoRoot, 'first-agent')
    writePersona(repoRoot, 'second-agent')
    const team = await createTeamBuilderTeam(repoRoot, {
      id: 'generated-team',
      description: 'Generated team.',
      tags: [],
    })
    const teamYamlPath = path.join(team.teamPath, 'team.yaml')

    await addTeamBuilderAgent({
      repoRoot,
      teamId: 'generated-team',
      agentName: 'first-agent',
    })
    await addTeamBuilderAgent({
      repoRoot,
      teamId: 'generated-team',
      agentName: 'second-agent',
    })

    const yaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(stageMembers(yaml, STAGE_TYPE.CHAIN, 'sequence'), [
      'first-agent',
      'second-agent',
    ])
    assert.deepEqual(finalResultProducers(yaml), ['second-agent'])
  })
})

test('generated batch additions keep one final-result.md owner at the end of the setup chain', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    writePersona(repoRoot, 'first-agent')
    writePersona(repoRoot, 'second-agent')
    const team = await createTeamBuilderTeam(repoRoot, {
      id: 'generated-team',
      description: 'Generated team.',
      tags: [],
    })
    const teamYamlPath = path.join(team.teamPath, 'team.yaml')

    await addTeamBuilderAgents({
      repoRoot,
      teamId: 'generated-team',
      expectedRevision: digestTeamYaml(fs.readFileSync(teamYamlPath, 'utf8')),
      agents: [{ name: 'first-agent' }],
    })
    await addTeamBuilderAgents({
      repoRoot,
      teamId: 'generated-team',
      expectedRevision: digestTeamYaml(fs.readFileSync(teamYamlPath, 'utf8')),
      agents: [{ name: 'second-agent' }],
    })

    const yaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(stageMembers(yaml, STAGE_TYPE.CHAIN, 'sequence'), [
      'first-agent',
      'second-agent',
    ])
    assert.deepEqual(finalResultProducers(yaml), ['second-agent'])
  })
})

test('adding a member to a custom discussion does not assign the final artifact', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeCustomDiscussionRepo(repoRoot)

    await addTeamBuilderAgent({
      repoRoot,
      teamId: 'custom-discussion',
      agentName: 'new-participant',
    })

    assert.deepEqual(
      finalResultProducers(fs.readFileSync(teamYamlPath, 'utf8')),
      ['lead'],
    )
  })
})

test('adding a discussion participant in an update preserves the selected final artifact owner', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeCustomDiscussionRepo(repoRoot)

    await addTeamBuilderAgents({
      repoRoot,
      teamId: 'custom-discussion',
      expectedRevision: digestTeamYaml(fs.readFileSync(teamYamlPath, 'utf8')),
      agents: [{ name: 'new-participant' }],
    })

    const yaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(stageMembers(yaml, STAGE_TYPE.DISCUSSION, 'participants'), [
      'participant',
      'new-participant',
    ])
    assert.deepEqual(finalResultProducers(yaml), ['lead'])
  })
})

test('updating a custom discussion preserves the selected final artifact owner', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamYamlPath = writeCustomDiscussionRepo(repoRoot)

    await updateTeamBuilderTeam(repoRoot, 'custom-discussion', {
      id: 'custom-discussion',
      description: 'Updated custom discussion topology.',
      tags: [],
    })

    assert.deepEqual(
      finalResultProducers(fs.readFileSync(teamYamlPath, 'utf8')),
      ['lead'],
    )
  })
})




test('affected shipped teams have no configuration health warnings', () => {
  const affectedTeamIds = [
    'app-brainstorm-team',
    'crypto-investment-board',
    'knowledge-systems-crew',
    'software-architecture-board',
    'teaching-team',
    'venture-capital-team',
    'writing-team',
  ]
  const teams = listTeamBuilderTeams(process.cwd())
  const affectedTeams = affectedTeamIds.flatMap((id) => {
    const team = teams.find((candidate) => candidate.id === id)
    return team ? [team] : []
  })

  assert.deepEqual(affectedTeams.map((team) => team.id), affectedTeamIds)
  assert.deepEqual(
    affectedTeams.flatMap((team) =>
      team.health.warnings.map((warning) => `${team.id}: ${warning}`),
    ),
    [],
  )
})
