/**
 * Team Builder commands on a member whose name or persona path holds a
 * double quote or a backslash.
 *
 * `yamlQuoted` writes such a value with JSON escapes (`\"`, `\\`). Two readers
 * then have to agree on what it says: `parseYaml`, which the Team Builder and
 * the runtime read the roster with, and the text locators that find a member's
 * lines when `team.yaml` is edited in place. A locator that still reads the
 * escaped spelling cannot find the member the parser names.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addTeamBuilderAgent,
  removeTeamBuilderAgent,
} from '../../domains/agent-generator/team-manager.js'

const TEAM_ID = 'escaped-team'

function lines(...blocks: ReadonlyArray<readonly string[]>): string {
  return blocks.flat().join('\n')
}

function writePersona(root: string, name: string): void {
  const dir = path.join(root, 'agents', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} persona.\n---\n\n# ${name}\n`,
  )
}

/** Registers the one team at `teamPath`, relative to `repoRoot`, and writes its team.yaml. */
function registerTeam(repoRoot: string, teamPath: string, teamYaml: string): string {
  fs.mkdirSync(repoRoot, { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    `${TEAM_ID}:\n  type: team\n  description: Escaped team.\n  team_path: ${teamPath}\n`,
  )
  const teamDir = path.resolve(repoRoot, teamPath)
  fs.mkdirSync(teamDir, { recursive: true })
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  fs.writeFileSync(teamYamlPath, teamYaml)
  return teamYamlPath
}

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-escaped-scalars-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const HEADER = [
  'team:',
  `  name: "${TEAM_ID}"`,
  '  description: Escaped team.',
  '  version: "0.1.0"',
  '',
]

function member(nameScalar: string, agentFile: string): string[] {
  return [
    `  - name: ${nameScalar}`,
    '    type: agent',
    '    role: A member.',
    '    tools: []',
    `    agent_file: "${agentFile}"`,
  ]
}

function levels(sequence: readonly string[], participants: string): string[] {
  return [
    'levels:',
    '  - id: relay',
    '    name: relay',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      sequence:',
    ...sequence.map((scalar) => `        - ${scalar}`),
    '  - id: talk',
    '    name: talk',
    '    order: 1',
    '    stage:',
    '      type: discussion',
    '      coordinator: "lead"',
    `      participants: ${participants}`,
  ]
}

const GATES = [
  '',
  'gates:',
  '  - from: relay',
  '    to: talk',
  '    condition:',
  '      type: all_tasks_terminal',
  '  - from: talk',
  '    to: done',
  '    condition:',
  '      type: all_tasks_terminal',
  '',
]

test('a member whose name holds a double quote is removed by that name from the roster, a block stage list and a flow stage list', async () => {
  await inTempDir(async (repoRoot) => {
    writePersona(repoRoot, 'lead')
    writePersona(repoRoot, 'quoted')
    // The name is a" #b. Written the way yamlQuoted writes it, it reads
    // "a\" #b". The " #" after the escaped quote is not a comment.
    const quoted = String.raw`"a\" #b"`
    const teamYamlPath = registerTeam(
      repoRoot,
      `./teams/${TEAM_ID}`,
      lines(
        HEADER,
        ['agents:'],
        member('"lead"', '../../agents/lead/lead.md'),
        [''],
        member(quoted, '../../agents/quoted/quoted.md'),
        [''],
        levels(['"lead"', quoted], `[${quoted}, "lead"]`),
        GATES,
      ),
    )

    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'a" #b' })

    assert.equal(
      fs.readFileSync(teamYamlPath, 'utf8'),
      lines(
        HEADER,
        ['agents:'],
        member('"lead"', '../../agents/lead/lead.md'),
        [''],
        levels(['"lead"'], '["lead"]'),
        GATES,
      ),
    )
  })
})

test('an Agent added from a repository whose path holds a double quote and a backslash reads back at its persona path', async () => {
  await inTempDir(async (dir) => {
    // The team lives outside the repository, so the relative persona path
    // written for the new member crosses the repository's own folder name.
    const repoRoot = path.join(dir, 'repo"x\\y')
    writePersona(repoRoot, 'gamma')
    writePersona(path.join(dir, 'outside'), 'lead')
    registerTeam(
      repoRoot,
      `../outside/${TEAM_ID}`,
      lines(
        HEADER,
        ['agents:'],
        member('"lead"', '../agents/lead/lead.md'),
        [''],
        [
          'levels:',
          '  - id: relay',
          '    name: relay',
          '    order: 0',
          '    stage:',
          '      type: chain',
          '      sequence:',
          '        - "lead"',
          '',
          'gates:',
          '  - from: relay',
          '    to: done',
          '    condition:',
          '      type: all_tasks_terminal',
          '',
        ],
      ),
    )

    const detail = await addTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

    assert.deepEqual(
      {
        agentFile: detail.agents.find((agent) => agent.name === 'gamma')?.agent_file,
        warnings: detail.warnings,
      },
      { agentFile: '../../repo"x\\y/agents/gamma/gamma.md', warnings: [] },
    )
  })
})
