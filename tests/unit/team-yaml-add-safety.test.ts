/**
 * Adds that must not corrupt a hand-authored `team.yaml`.
 *
 * Each test writes a team into a temporary repository and calls one of the
 * three roster writers: the Team Builder's single add, its batch add, or the
 * Agent page's add. A writer either extends the roster and keeps every
 * authored member and the levels, or refuses and leaves the file byte for
 * byte unchanged.
 */

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addTeamBuilderAgent,
  addTeamBuilderAgents,
  digestTeamYaml,
} from '../../domains/agent-generator/team-manager.js'
import { addAgentToTeam } from '../../domains/agent-generator/team-usage.js'
import { rosterEditKeepsTeam } from '../../domains/agent-generator/team-yaml-addition.js'
import { parseYaml } from '../../core/yaml-parser.js'

const TEAM_ID = 'safety-team'

function text(...lines: string[]): string {
  return lines.join('\n')
}

function makeRepo(
  t: TestContext,
  teamYaml: string,
  personas: readonly string[],
): { repoRoot: string; teamYamlPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-add-safety-'))
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  for (const name of personas) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} persona.\n---\n\n# ${name}\n`,
    )
  }
  const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
  fs.mkdirSync(teamDir, { recursive: true })
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  fs.writeFileSync(teamYamlPath, teamYaml)
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    text(`${TEAM_ID}:`, '  type: team', '  description: Safety fixture.', `  team_path: ./teams/${TEAM_ID}`, ''),
  )
  return { repoRoot, teamYamlPath }
}

const ALPHA_ENTRY_INDENTLESS = [
  '- name: alpha',
  '  type: agent',
  '  role: Leads.',
  '  tools: []',
  '  agent_file: ../../agents/alpha/alpha.md',
]

const CHAIN_LEVELS = [
  'levels:',
  '  - id: work',
  '    stage:',
  '      type: chain',
  '      sequence:',
  '        - alpha',
]

/** Both Team Builder adds, so each shape is checked against each writer. */
const TEAM_BUILDER_ADDS = [
  {
    label: 'the single add',
    add: (repoRoot: string, _yaml: string) =>
      addTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'bravo' }),
  },
  {
    label: 'the batch add',
    add: (repoRoot: string, yaml: string) =>
      addTeamBuilderAgents({
        repoRoot,
        teamId: TEAM_ID,
        expectedRevision: digestTeamYaml(yaml),
        agents: [{ name: 'bravo' }],
      }),
  },
]

for (const writer of TEAM_BUILDER_ADDS) {
  test(`${writer.label} refuses an indentless roster before the levels and leaves the file unchanged`, async (t) => {
    const teamYaml = text(
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: Hand-authored.',
      'agents:',
      ...ALPHA_ENTRY_INDENTLESS,
      ...CHAIN_LEVELS,
      '',
    )
    const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'bravo'])

    await assert.rejects(writer.add(repoRoot, teamYaml), /cannot take new members/u)
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
  })

  test(`${writer.label} refuses a roster indented four spaces and leaves the file unchanged`, async (t) => {
    const teamYaml = text(
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: Hand-authored.',
      'agents:',
      '    - name: alpha',
      '      type: agent',
      '      role: Leads.',
      '      tools: []',
      '      agent_file: ../../agents/alpha/alpha.md',
      ...CHAIN_LEVELS,
      '',
    )
    const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'bravo'])

    await assert.rejects(writer.add(repoRoot, teamYaml), /cannot take new members/u)
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
  })

  test(`${writer.label} refuses \`agents: null\` as a roster that is not a list and leaves the file unchanged`, async (t) => {
    const teamYaml = text(
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: Hand-authored.',
      'agents: null',
      ...CHAIN_LEVELS,
      '',
    )
    const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'bravo'])

    await assert.rejects(
      writer.add(repoRoot, teamYaml),
      /declares a roster that is not a list, so it cannot take new members/u,
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
  })
}

test('the Agent page refuses an indentless roster with a nameless entry after the levels, rather than dropping that entry', async (t) => {
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: Hand-authored.',
    ...CHAIN_LEVELS,
    'agents:',
    '- plain-roster-note',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['bravo'])

  await assert.rejects(
    addAgentToTeam({ repoRoot, agentName: 'bravo', teamId: TEAM_ID }),
    /cannot take new members/u,
  )
  assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
})

test('a participants header with a trailing comment gains the new name under it, and the comment is kept', async (t) => {
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: One debate.',
    'agents:',
    '  - name: "alpha"',
    '    type: agent',
    '    role: Leads the debate.',
    '    tools: []',
    '    agent_file: "../../agents/alpha/alpha.md"',
    'levels:',
    '  - id: debate',
    '    stage:',
    '      type: discussion',
    '      coordinator: "alpha"',
    '      participants: # who is convened',
    '        - "alpha"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'bravo'])

  await addTeamBuilderAgents({
    repoRoot,
    teamId: TEAM_ID,
    expectedRevision: digestTeamYaml(teamYaml),
    agents: [{ name: 'bravo' }],
  })

  const written = fs.readFileSync(teamYamlPath, 'utf8')
  assert.match(written, /^ {6}participants: # who is convened$/mu)
  const stage = firstStage(written)
  assert.deepEqual(stage.participants, ['alpha', 'bravo'])
})

test('stage keys indented four spaces under `stage:` keep one participants key, which gains the new name', async (t) => {
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: One debate.',
    'agents:',
    '  - name: "alpha"',
    '    type: agent',
    '    role: Leads the debate.',
    '    tools: []',
    '    agent_file: "../../agents/alpha/alpha.md"',
    'levels:',
    '  - id: debate',
    '    stage:',
    '        type: discussion',
    '        coordinator: "alpha"',
    '        participants:',
    '          - "alpha"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'bravo'])

  await addTeamBuilderAgents({
    repoRoot,
    teamId: TEAM_ID,
    expectedRevision: digestTeamYaml(teamYaml),
    agents: [{ name: 'bravo' }],
  })

  const written = fs.readFileSync(teamYamlPath, 'utf8')
  assert.equal(written.match(/^\s*participants:/gmu)?.length, 1, written)
  assert.deepEqual(firstStage(written).participants, ['alpha', 'bravo'])
})

test('the pre-write check refuses a result that keeps every roster member but loses the levels', () => {
  const roster = [{ name: 'alpha', type: 'agent' }, 'plain-roster-note']
  const levels = [{ id: 'work', stage: { type: 'chain', sequence: ['alpha'] } }]
  const before = { agents: roster, levels }

  assert.equal(
    rosterEditKeepsTeam(before, { agents: [...roster, { name: 'bravo' }], levels }, ['bravo']),
    true,
  )
  assert.equal(
    rosterEditKeepsTeam(before, { agents: [...roster, { name: 'bravo' }] }, ['bravo']),
    false,
  )
})

function firstStage(yaml: string): Record<string, unknown> {
  const parsed = parseYaml(yaml)
  const levels = parsed.levels
  assert.ok(Array.isArray(levels), 'levels must parse as a list')
  const [level] = levels
  assert.ok(isRecord(level) && isRecord(level.stage), 'the first level must have a stage')
  return level.stage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
