/**
 * What `removeTeamBuilderAgent` writes to team.yaml, byte for byte.
 *
 * Removal edits the file as text: it deletes the member's roster entry and
 * the member's entries in each stage membership list, block or flow style.
 * These tests compare the whole saved file for removal shapes the other Team
 * Builder suites do not compare byte for byte.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { removeTeamBuilderAgent } from '../../domains/agent-generator/team-manager.js'
import { parseTeamConfig } from '../../parsers/team-config.js'

const TEAM_ID = 'removal-team'

/** Joins fixture lines into the exact text of a file. */
function yaml(...blocks: ReadonlyArray<readonly string[]>): string {
  return blocks.flat().join('\n')
}

const HEADER = [
  'team:',
  `  name: "${TEAM_ID}"`,
  '  description: Removal team.',
  '  version: "0.1.0"',
  '',
]

/** One roster entry, written the way the Team Builder writes one. */
function member(name: string): string[] {
  return [
    `  - name: "${name}"`,
    '    type: agent',
    `    role: ${name} persona.`,
    '    tools: []',
    `    agent_file: "../../agents/${name}/${name}.md"`,
  ]
}

/** A level item with the given stage lines under `stage:`. */
function level(id: string, order: number, stage: readonly string[]): string[] {
  return [
    `  - id: ${id}`,
    `    name: ${id}`,
    `    order: ${order}`,
    '    stage:',
    ...stage,
  ]
}

/** A `gates:` block walking the level ids in order, then to `done`. */
function gates(levelIds: readonly string[]): string[] {
  const targets = [...levelIds.slice(1), 'done']
  return [
    '',
    'gates:',
    ...levelIds.flatMap((from, index) => [
      `  - from: ${from}`,
      `    to: ${targets[index] ?? 'done'}`,
      '    condition:',
      '      type: all_tasks_terminal',
    ]),
    '',
  ]
}

/**
 * Seeds a repository holding one registered team and a persona per name, runs
 * `fn` against it, and removes the repository afterwards.
 */
async function withTeam(
  teamYaml: string,
  personas: readonly string[],
  fn: (repoRoot: string, teamYamlPath: string) => Promise<void>,
): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-removal-text-'))
  try {
    const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
    fs.mkdirSync(teamDir, { recursive: true })
    for (const persona of personas) {
      const agentDir = path.join(repoRoot, 'agents', persona)
      fs.mkdirSync(agentDir, { recursive: true })
      fs.writeFileSync(
        path.join(agentDir, `${persona}.md`),
        `---\nname: ${persona}\ndescription: ${persona} persona.\n---\n\n# ${persona}\n`,
      )
    }
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      `${TEAM_ID}:\n  type: team\n  description: Removal team.\n  team_path: ./teams/${TEAM_ID}\n`,
    )
    const teamYamlPath = path.join(teamDir, 'team.yaml')
    fs.writeFileSync(teamYamlPath, teamYaml)
    // The seeded file must itself be a valid team, or a rejected removal could
    // be blamed on the fixture rather than on the edit.
    assert.deepEqual(parseTeamConfig(teamYamlPath).errors, [], 'seeded team.yaml is valid')
    await fn(repoRoot, teamYamlPath)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

const LEAD_WRITER_EDITOR_ROSTER = [
  'agents:',
  ...member('lead'),
  '',
  ...member('writer'),
  '',
  ...member('editor'),
  '',
]

const LEAD_EDITOR_ROSTER = ['agents:', ...member('lead'), '', ...member('editor'), '']

test('removing a member deletes each of its lines from every stage type block list, and nothing else', async () => {
  const levelIds = ['draft', 'relay', 'spread', 'build']
  const seeded = yaml(
    HEADER,
    LEAD_WRITER_EDITOR_ROSTER,
    ['levels:'],
    level('draft', 0, [
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants:   # who talks',
      '        - "writer"',
      '        - "editor"',
    ]),
    level('relay', 1, [
      '      type: chain',
      '      sequence:',
      '        - "lead"',
      '        - "writer"',
      '        - "editor"',
      '        - "writer"',
    ]),
    level('spread', 2, [
      '      type: broadcast',
      '      fan_out:',
      '        - "editor"',
      '        - "writer"',
    ]),
    level('build', 3, [
      '      type: pipeline',
      '      participants:',
      '        - "writer"',
      '        - "lead"',
    ]),
    gates(levelIds),
  )

  await withTeam(seeded, ['lead', 'writer', 'editor'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'writer' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        HEADER,
        LEAD_EDITOR_ROSTER,
        ['levels:'],
        level('draft', 0, [
          '      type: discussion',
          '      coordinator: "lead"',
          '      participants:   # who talks',
          '        - "editor"',
        ]),
        level('relay', 1, [
          '      type: chain',
          '      sequence:',
          '        - "lead"',
          '        - "editor"',
        ]),
        level('spread', 2, ['      type: broadcast', '      fan_out:', '        - "editor"']),
        level('build', 3, ['      type: pipeline', '      participants:', '        - "lead"']),
        gates(levelIds),
      ),
    )
  })
})

test('removing a member rewrites each flow list it is in with ", " between the entries that stay, as they were spelled', async () => {
  const levelIds = ['draft', 'relay', 'spread', 'build']
  const seeded = yaml(
    HEADER,
    LEAD_WRITER_EDITOR_ROSTER,
    ['levels:'],
    level('draft', 0, [
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants: ["editor", "writer"]',
    ]),
    level('relay', 1, ['      type: chain', '      sequence: [lead,writer,  editor]']),
    level('spread', 2, [
      '      type: broadcast',
      "      fan_out: ['writer', 'editor']  # fan-out note",
    ]),
    level('build', 3, ['      type: pipeline', '      participants:  [ writer , lead ]']),
    gates(levelIds),
  )

  await withTeam(seeded, ['lead', 'writer', 'editor'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'writer' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        HEADER,
        LEAD_EDITOR_ROSTER,
        ['levels:'],
        level('draft', 0, [
          '      type: discussion',
          '      coordinator: "lead"',
          '      participants: ["editor"]',
        ]),
        level('relay', 1, ['      type: chain', '      sequence: [lead, editor]']),
        level('spread', 2, ['      type: broadcast', "      fan_out: ['editor']  # fan-out note"]),
        level('build', 3, ['      type: pipeline', '      participants: [lead]']),
        gates(levelIds),
      ),
    )
  })
})

test('removing the only member of a pipeline list leaves `participants: []` in block and flow style', async () => {
  // Removal refuses to empty a chain, broadcast or discussion list, so a
  // pipeline is where an emptied list is written. In block style the key line
  // becomes `participants: []` and the comment lines inside the list stay
  // below it; a comment on the key line itself is not carried over. In flow
  // style the inline comment stays.
  const levelIds = ['build', 'check']
  const seeded = yaml(
    HEADER,
    LEAD_WRITER_EDITOR_ROSTER,
    ['levels:'],
    level('build', 0, [
      '      type: pipeline',
      '      coordinator: "lead"',
      '      participants:   # builders',
      '        # only the writer builds',
      '        - "writer"',
    ]),
    level('check', 1, [
      '      type: pipeline',
      '      coordinator: "editor"',
      '      participants: [writer]  # solo',
    ]),
    gates(levelIds),
  )

  await withTeam(seeded, ['lead', 'writer', 'editor'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'writer' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        HEADER,
        LEAD_EDITOR_ROSTER,
        ['levels:'],
        level('build', 0, [
          '      type: pipeline',
          '      coordinator: "lead"',
          '      participants: []',
          '        # only the writer builds',
        ]),
        level('check', 1, [
          '      type: pipeline',
          '      coordinator: "editor"',
          '      participants: []  # solo',
        ]),
        gates(levelIds),
      ),
    )
  })
})

test('a block list entry goes with its own inline comment, and the other entries keep theirs and their quoting', async () => {
  const levelIds = ['relay']
  const seeded = yaml(
    HEADER,
    LEAD_WRITER_EDITOR_ROSTER,
    ['levels:'],
    level('relay', 0, [
      '      type: chain',
      '      sequence:',
      '        - lead      # opens',
      "        - 'writer'  # drafts",
      '        - "editor"  # closes',
      '      # hand-off settings follow',
      '      config:',
      '        handoff_format: markdown',
    ]),
    gates(levelIds),
  )

  await withTeam(seeded, ['lead', 'writer', 'editor'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'writer' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        HEADER,
        LEAD_EDITOR_ROSTER,
        ['levels:'],
        level('relay', 0, [
          '      type: chain',
          '      sequence:',
          '        - lead      # opens',
          '        - "editor"  # closes',
          '      # hand-off settings follow',
          '      config:',
          '        handoff_format: markdown',
        ]),
        gates(levelIds),
      ),
    )
  })
})

test('a roster entry goes with the comment inside its block, while the comment line above it stays', async () => {
  // Removal deletes from the entry's `- name:` line up to the next entry, so a
  // comment line above `- name:` at the entry's own indent is not deleted and
  // ends up above the entry that follows.
  const levelIds = ['relay']
  const stage = [
    '      type: chain',
    '      sequence:',
    '        - "lead"',
    '        - "editor"',
  ]
  const leadEntry = ['  # the lead opens every run', ...member('lead')]
  const editorEntry = [
    '  - name: "editor"   # added later',
    '    type: agent',
    '    role: editor persona.',
    '    tools: []',
    '    agent_file: "../../agents/editor/editor.md"',
  ]
  const seeded = yaml(
    HEADER,
    [
      'agents:',
      ...leadEntry,
      '',
      '  # the writer drafts first',
      '  - name: "writer"',
      '    type: agent',
      '    # drafts are markdown',
      '    role: writer persona.',
      '    tools: []',
      '    agent_file: "../../agents/writer/writer.md"',
      '',
      ...editorEntry,
      '',
    ],
    ['levels:'],
    level('relay', 0, stage),
    gates(levelIds),
  )

  await withTeam(seeded, ['lead', 'writer', 'editor'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'writer' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        HEADER,
        ['agents:', ...leadEntry, '', '  # the writer drafts first', ...editorEntry, ''],
        ['levels:'],
        level('relay', 0, stage),
        gates(levelIds),
      ),
    )
  })
})

test('removing a member leaves a member whose name starts with the same text', async () => {
  const levelIds = ['draft', 'spread']
  const seeded = yaml(
    HEADER,
    ['agents:', ...member('lead'), '', ...member('writer'), '', ...member('writer-lead'), ''],
    ['levels:'],
    level('draft', 0, [
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants:',
      '        - "writer-lead"',
      '        - "writer"',
    ]),
    level('spread', 1, ['      type: broadcast', '      fan_out: [writer, writer-lead]']),
    gates(levelIds),
  )

  await withTeam(seeded, ['lead', 'writer', 'writer-lead'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'writer' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        HEADER,
        ['agents:', ...member('lead'), '', ...member('writer-lead'), ''],
        ['levels:'],
        level('draft', 0, [
          '      type: discussion',
          '      coordinator: "lead"',
          '      participants:',
          '        - "writer-lead"',
        ]),
        level('spread', 1, ['      type: broadcast', '      fan_out: [writer-lead]']),
        gates(levelIds),
      ),
    )
  })
})

test('a stage with no type is pruned as a discussion, through its participants list', async () => {
  const levelIds = ['draft']
  const seeded = yaml(
    HEADER,
    LEAD_WRITER_EDITOR_ROSTER,
    ['levels:'],
    level('draft', 0, [
      '      coordinator: "lead"',
      '      participants:',
      '        - "writer"',
      '        - "editor"',
    ]),
    gates(levelIds),
  )

  await withTeam(seeded, ['lead', 'writer', 'editor'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'writer' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        HEADER,
        LEAD_EDITOR_ROSTER,
        ['levels:'],
        level('draft', 0, [
          '      coordinator: "lead"',
          '      participants:',
          '        - "editor"',
        ]),
        gates(levelIds),
      ),
    )
  })
})

test('removing the only roster member is refused because the team would have no agents, and team.yaml is unchanged', async () => {
  // Removal writes the emptied roster as `agents: []`, so validation reports
  // only the empty roster. A bare `agents:` would also be reported as a
  // missing `agents` array.
  const levelIds = ['build']
  const seeded = yaml(
    HEADER,
    ['agents:', ...member('writer'), ''],
    ['levels:'],
    level('build', 0, ['      type: pipeline', '      participants:', '        - "writer"']),
    gates(levelIds),
  )

  await withTeam(seeded, ['writer'], async (repoRoot, teamYamlPath) => {
    await assert.rejects(
      removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'writer' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(
          error.message,
          `Cannot remove 'writer' from team '${TEAM_ID}': the resulting team ` +
            'configuration would be invalid — At least one agent is required',
        )
        return true
      },
    )

    assert.equal(readText(teamYamlPath), seeded)
  })
})
