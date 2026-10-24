/**
 * Exact `team.yaml` bytes for the add-path cases no other suite pins.
 *
 * Each test writes a team into a temporary repository, calls
 * `addTeamBuilderAgent` or `addTeamBuilderAgents`, and compares the whole file
 * that is left on disk with a literal.
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

const TEAM_ID = 'addition-team'

/** Joins fixture lines into the exact text of a file. */
function text(...lines: string[]): string {
  return lines.join('\n')
}

/** A repository holding one registered team and the named personas. */
function makeRepo(
  t: TestContext,
  teamYaml: string,
  personas: readonly string[],
): { repoRoot: string; teamYamlPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-addition-'))
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
    text(`${TEAM_ID}:`, '  type: team', '  description: Addition fixture.', `  team_path: ./teams/${TEAM_ID}`, ''),
  )
  return { repoRoot, teamYamlPath }
}

/** The `team:` and `workflow:` blocks of a team this app generated. */
const GENERATED_HEADER = [
  'team:',
  `  name: "${TEAM_ID}"`,
  '  description: A generated team.',
  '  created_by: "team-builder"',
  'workflow:',
  '  entry_level: setup',
  '  output_contract:',
  '    completion_artifact: "final-result.md"',
  '',
]

test('a batch add extends the list of the level the workflow names as its entry, not an earlier pipeline list', async (t) => {
  // The earlier level is a pipeline with a block list. The entry level is a
  // discussion with a flow list.
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: A warmup, then a debate.',
    'workflow:',
    '  entry_level: debate',
    'agents:',
    '  - name: "alpha"',
    '    type: agent',
    '    role: Runs the warmup and leads the debate.',
    '    tools: []',
    '    agent_file: "../../agents/alpha/alpha.md"',
    'levels:',
    '  - id: warmup',
    '    name: Warmup',
    '    order: 0',
    '    stage:',
    '      type: pipeline',
    '      participants:',
    '        - "alpha"',
    '  - id: debate',
    '    name: Debate',
    '    order: 1',
    '    stage:',
    '      type: discussion',
    '      coordinator: "alpha"',
    '      participants: ["alpha"]',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'beta'])

  await addTeamBuilderAgents({
    repoRoot,
    teamId: TEAM_ID,
    expectedRevision: digestTeamYaml(teamYaml),
    agents: [
      {
        name: 'beta',
        role: 'Argues the opposing side of every motion so that each claim is tested before the coordinator writes the answer.',
      },
    ],
  })

  // The new entry follows the last one after one blank line, and its role is
  // folded at 76 columns. Only the `debate` level's list gains the name; the
  // `warmup` list is unchanged.
  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: A warmup, then a debate.',
      'workflow:',
      '  entry_level: debate',
      'agents:',
      '  - name: "alpha"',
      '    type: agent',
      '    role: Runs the warmup and leads the debate.',
      '    tools: []',
      '    agent_file: "../../agents/alpha/alpha.md"',
      '',
      '  - name: "beta"',
      '    type: agent',
      '    role: >',
      '      Argues the opposing side of every motion so that each claim is tested before',
      '      the coordinator writes the answer.',
      '    tools: []',
      '    agent_file: "../../agents/beta/beta.md"',
      '    experience_enabled: true',
      'levels:',
      '  - id: warmup',
      '    name: Warmup',
      '    order: 0',
      '    stage:',
      '      type: pipeline',
      '      participants:',
      '        - "alpha"',
      '  - id: debate',
      '    name: Debate',
      '    order: 1',
      '    stage:',
      '      type: discussion',
      '      coordinator: "alpha"',
      '      participants: ["alpha", "beta"]',
      '',
    ),
  )
})

test('a block participant list indented four spaces under its key gains the new name at that same depth', async (t) => {
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
    '    name: Debate',
    '    order: 0',
    '    stage:',
    '      type: discussion',
    '      coordinator: "alpha"',
    '      participants:',
    '          - "alpha"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'beta'])

  await addTeamBuilderAgents({
    repoRoot,
    teamId: TEAM_ID,
    expectedRevision: digestTeamYaml(teamYaml),
    agents: [{ name: 'beta' }],
  })

  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: One debate.',
      'agents:',
      '  - name: "alpha"',
      '    type: agent',
      '    role: Leads the debate.',
      '    tools: []',
      '    agent_file: "../../agents/alpha/alpha.md"',
      '',
      '  - name: "beta"',
      '    type: agent',
      '    role: >',
      '      beta persona.',
      '    tools: []',
      '    agent_file: "../../agents/beta/beta.md"',
      '    experience_enabled: true',
      'levels:',
      '  - id: debate',
      '    name: Debate',
      '    order: 0',
      '    stage:',
      '      type: discussion',
      '      coordinator: "alpha"',
      '      participants:',
      '          - "alpha"',
      '          - "beta"',
      '',
    ),
  )
})

test('a participants key nested under the entry stage config is left alone, and the list the stage itself declares gains the name', async (t) => {
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: One debate with a breakout.',
    'agents:',
    '  - name: "alpha"',
    '    type: agent',
    '    role: Leads the debate.',
    '    tools: []',
    '    agent_file: "../../agents/alpha/alpha.md"',
    'levels:',
    '  - id: debate',
    '    name: Debate',
    '    order: 0',
    '    stage:',
    '      type: discussion',
    '      coordinator: "alpha"',
    '      config:',
    '        breakout:',
    '          participants: ["alpha"]',
    '      participants:',
    '        - "alpha"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'beta'])

  await addTeamBuilderAgents({
    repoRoot,
    teamId: TEAM_ID,
    expectedRevision: digestTeamYaml(teamYaml),
    agents: [{ name: 'beta' }],
  })

  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: One debate with a breakout.',
      'agents:',
      '  - name: "alpha"',
      '    type: agent',
      '    role: Leads the debate.',
      '    tools: []',
      '    agent_file: "../../agents/alpha/alpha.md"',
      '',
      '  - name: "beta"',
      '    type: agent',
      '    role: >',
      '      beta persona.',
      '    tools: []',
      '    agent_file: "../../agents/beta/beta.md"',
      '    experience_enabled: true',
      'levels:',
      '  - id: debate',
      '    name: Debate',
      '    order: 0',
      '    stage:',
      '      type: discussion',
      '      coordinator: "alpha"',
      '      config:',
      '        breakout:',
      '          participants: ["alpha"]',
      '      participants:',
      '        - "alpha"',
      '        - "beta"',
      '',
    ),
  )
})

test('a generated chain with no sequence gains one under its type line, naming each new member once in batch order', async (t) => {
  const teamYaml = text(
    ...GENERATED_HEADER,
    'agents: []',
    '',
    'levels:',
    '  - id: setup',
    '    name: Setup',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      config:',
    '        handoff_format: markdown',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'beta'])

  await addTeamBuilderAgents({
    repoRoot,
    teamId: TEAM_ID,
    expectedRevision: digestTeamYaml(teamYaml),
    agents: [{ name: 'alpha' }, { name: 'beta' }, { name: 'alpha' }],
  })

  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      ...GENERATED_HEADER,
      'agents:',
      '  - name: "alpha"',
      '    type: agent',
      '    role: >',
      '      alpha persona.',
      '    tools: []',
      '    agent_file: "../../agents/alpha/alpha.md"',
      '    experience_enabled: true',
      '',
      '  - name: "beta"',
      '    type: agent',
      '    role: >',
      '      beta persona.',
      '    tools: []',
      '    agent_file: "../../agents/beta/beta.md"',
      '    experience_enabled: true',
      '    produces:',
      '      - path: "final-result.md"',
      '',
      'levels:',
      '  - id: setup',
      '    name: Setup',
      '    order: 0',
      '    stage:',
      '      type: chain',
      '      sequence:',
      '        - "alpha"',
      '        - "beta"',
      '      config:',
      '        handoff_format: markdown',
      '',
    ),
  )
})

test('a generated review refuses every member no role names, names each of them, and writes nothing', async (t) => {
  const teamYaml = text(
    ...GENERATED_HEADER,
    'agents: []',
    '',
    'levels:',
    '  - id: setup',
    '    name: Setup',
    '    order: 0',
    '    stage:',
    '      type: review',
    '      producer: "alpha"',
    '      reviewer: "beta"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'gamma', 'delta'])

  await assert.rejects(
    addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: digestTeamYaml(teamYaml),
      agents: [{ name: 'alpha' }, { name: 'gamma' }, { name: 'delta' }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(
        error.message,
        'A review team is one writer and one checker, so gamma and delta cannot be added: ' +
          'a review stage has no membership list, and the agent would never run. ' +
          'Change how this team works together first, or replace the writer or the checker.',
      )
      return true
    },
  )

  assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
})

test('a team with no roster gains one at the end of the file, after one blank line', async (t) => {
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: Not staffed yet.',
    'levels: []',
    '',
    '',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha'])

  await addTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'alpha' })

  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: Not staffed yet.',
      'levels: []',
      '',
      'agents:',
      '  - name: "alpha"',
      '    type: agent',
      '    role: >',
      '      alpha persona.',
      '    tools: []',
      '    agent_file: "../../agents/alpha/alpha.md"',
      '    experience_enabled: true',
      '',
    ),
  )
})
