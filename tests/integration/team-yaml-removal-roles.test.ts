/**
 * What blocks `removeTeamBuilderAgent`, and what it prunes.
 *
 * A role blocks removal only where the runtime reads it: a coordinator on any
 * stage (a level's coordinator is its host), a producer or reviewer on a review
 * stage, and a gate transform's agent when the transform runs an agent. A key
 * the runtime never reads for that stage or transform type is inert and does
 * not block. A membership list is pruned whichever spelling of its key the
 * parser reads.
 */

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { removeTeamBuilderAgent } from '../../domains/agent-generator/team-manager.js'
import type { TeamBuilderDetail } from '../../contracts/agent-generator.js'
import { parseYaml } from '../../core/yaml-parser.js'

const TEAM_ID = 'removal-roles-team'

function text(...lines: string[]): string {
  return lines.join('\n')
}

function makeRepo(t: TestContext, teamYaml: string): { repoRoot: string; teamYamlPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-removal-roles-'))
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  for (const name of ['lead', 'writer', 'editor']) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} persona.\nprovider: lm-studio\nmodel: local-model\n---\n\n# ${name}\n`,
    )
  }
  const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
  fs.mkdirSync(teamDir, { recursive: true })
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  fs.writeFileSync(teamYamlPath, teamYaml)
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    text(`${TEAM_ID}:`, '  type: team', '  description: Removal roles fixture.', `  team_path: ./teams/${TEAM_ID}`, ''),
  )
  return { repoRoot, teamYamlPath }
}

function member(name: string, extra: readonly string[] = []): string[] {
  return [
    `  - name: "${name}"`,
    '    type: agent',
    `    role: ${name} persona.`,
    '    tools: []',
    `    agent_file: "../../agents/${name}/${name}.md"`,
    ...extra,
  ]
}

const HEADER = ['team:', `  name: "${TEAM_ID}"`, '  description: Removal roles fixture.']
const ROSTER = [
  'agents:',
  ...member('lead', ['    produces:', '      - path: "final-result.md"']),
  ...member('writer'),
  ...member('editor'),
]
const DONE_GATE = [
  '  - from: draft',
  '    to: done',
  '    condition:',
  '      type: artifact_exists',
  '      artifact: "final-result.md"',
]

async function attemptRemoval(
  repoRoot: string,
  agentName: string,
): Promise<{ refusal?: string; detail?: TeamBuilderDetail }> {
  try {
    return { detail: await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName }) }
  } catch (error) {
    assert.ok(error instanceof Error)
    return { refusal: error.message }
  }
}

function parsedStage(yaml: string): Record<string, unknown> {
  const levels = parseYaml(yaml).levels
  assert.ok(Array.isArray(levels))
  const [level] = levels
  assert.ok(isRecord(level) && isRecord(level.stage))
  return level.stage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The expected head of a file once `writer` is removed: the team block and
 * the roster with `lead` and `editor`, written out literally rather than
 * built from the fixture helpers above.
 */
const EXPECTED_HEAD_WITHOUT_WRITER = [
  'team:',
  '  name: "removal-roles-team"',
  '  description: Removal roles fixture.',
  'agents:',
  '  - name: "lead"',
  '    type: agent',
  '    role: lead persona.',
  '    tools: []',
  '    agent_file: "../../agents/lead/lead.md"',
  '    produces:',
  '      - path: "final-result.md"',
  '  - name: "editor"',
  '    type: agent',
  '    role: editor persona.',
  '    tools: []',
  '    agent_file: "../../agents/editor/editor.md"',
]

/** The expected gate to `done`, written out literally. */
const EXPECTED_DONE_GATE = [
  'gates:',
  '  - from: draft',
  '    to: done',
  '    condition:',
  '      type: artifact_exists',
  '      artifact: "final-result.md"',
]

test('a producer and a reviewer written on a chain stage are inert and do not block removal', async (t) => {
  const teamYaml = text(
    ...HEADER,
    ...ROSTER,
    'levels:',
    '  - id: draft',
    '    name: Draft',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      producer: "writer"',
    '      reviewer: "writer"',
    '      sequence:',
    '        - "lead"',
    '        - "writer"',
    '        - "editor"',
    'gates:',
    ...DONE_GATE,
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  const { refusal, detail } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(refusal, undefined)
  assert.deepEqual(detail?.agents.map((agent) => agent.name), ['lead', 'editor'])
  // The inert producer and reviewer lines are the author's and stay as written.
  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      ...EXPECTED_HEAD_WITHOUT_WRITER,
      'levels:',
      '  - id: draft',
      '    name: Draft',
      '    order: 0',
      '    stage:',
      '      type: chain',
      '      producer: "writer"',
      '      reviewer: "writer"',
      '      sequence:',
      '        - "lead"',
      '        - "editor"',
      ...EXPECTED_DONE_GATE,
      '',
    ),
  )
})

test('a script gate transform with a stray agent key does not block removal', async (t) => {
  const teamYaml = text(
    ...HEADER,
    ...ROSTER,
    'levels:',
    '  - id: draft',
    '    name: Draft',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      sequence:',
    '        - "lead"',
    '        - "writer"',
    '        - "editor"',
    'gates:',
    ...DONE_GATE,
    '    transform:',
    '      type: script',
    '      script: ./tidy.sh',
    '      agent: "writer"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  const { refusal, detail } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(refusal, undefined)
  assert.deepEqual(detail?.agents.map((agent) => agent.name), ['lead', 'editor'])
  // The script transform, its stray agent line included, stays as written.
  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      ...EXPECTED_HEAD_WITHOUT_WRITER,
      'levels:',
      '  - id: draft',
      '    name: Draft',
      '    order: 0',
      '    stage:',
      '      type: chain',
      '      sequence:',
      '        - "lead"',
      '        - "editor"',
      ...EXPECTED_DONE_GATE,
      '    transform:',
      '      type: script',
      '      script: ./tidy.sh',
      '      agent: "writer"',
      '',
    ),
  )
})

test('a member holding one role is told to reassign that role', async (t) => {
  const teamYaml = text(
    ...HEADER,
    ...ROSTER,
    'levels:',
    '  - id: draft',
    '    name: Draft',
    '    order: 0',
    '    stage:',
    '      type: review',
    '      producer: "writer"',
    '      reviewer: "editor"',
    'gates:',
    ...DONE_GATE,
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  const { refusal } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(
    refusal,
    "Cannot remove 'writer' from team 'removal-roles-team': it is the review producer of level 'draft'. " +
      'Name a different agent for that role in the team configuration first.',
  )
  assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
})

test('a quoted flow-list key keeps its quotes when the list is rewritten', async (t) => {
  const teamYaml = text(
    ...HEADER,
    ...ROSTER,
    'levels:',
    '  - id: draft',
    '    name: Draft',
    '    order: 0',
    '    stage:',
    '      type: discussion',
    '      coordinator: "lead"',
    '      "participants": ["writer", "editor"]',
    'gates:',
    ...DONE_GATE,
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  const { refusal } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(refusal, undefined)
  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      ...EXPECTED_HEAD_WITHOUT_WRITER,
      'levels:',
      '  - id: draft',
      '    name: Draft',
      '    order: 0',
      '    stage:',
      '      type: discussion',
      '      coordinator: "lead"',
      '      "participants": ["editor"]',
      ...EXPECTED_DONE_GATE,
      '',
    ),
  )
})

test('a quoted key whose list is emptied keeps its quotes', async (t) => {
  // A pipeline's participants are advisory, so emptying them is allowed.
  const teamYaml = text(
    ...HEADER,
    ...ROSTER,
    'levels:',
    '  - id: draft',
    '    name: Draft',
    '    order: 0',
    '    stage:',
    '      type: pipeline',
    "      'participants':",
    '        - "writer"',
    'gates:',
    ...DONE_GATE,
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  const { refusal } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(refusal, undefined)
  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      ...EXPECTED_HEAD_WITHOUT_WRITER,
      'levels:',
      '  - id: draft',
      '    name: Draft',
      '    order: 0',
      '    stage:',
      '      type: pipeline',
      "      'participants': []",
      ...EXPECTED_DONE_GATE,
      '',
    ),
  )
})

test('a participants key spelled with a unicode escape is pruned like a plain one, and keeps its spelling', async (t) => {
  // "partic", a backslash, "u0069", "pants": the parser decodes the escape to
  // `i` and reads the key as participants. Built from character codes so the
  // fixture holds a real backslash.
  const backslash = String.fromCharCode(92)
  const escapedKeyLine = `      "partic${backslash}u0069pants":`
  assert.ok(escapedKeyLine.includes(backslash), 'the fixture key holds a backslash')
  assert.equal(escapedKeyLine.length, '      "participants":'.length + 5)
  const teamYaml = text(
    ...HEADER,
    ...ROSTER,
    'levels:',
    '  - id: draft',
    '    name: Draft',
    '    order: 0',
    '    stage:',
    '      type: discussion',
    '      coordinator: "lead"',
    escapedKeyLine,
    '        - "writer"',
    '        - "editor"',
    'gates:',
    ...DONE_GATE,
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)
  assert.deepEqual(parsedStage(teamYaml).participants, ['writer', 'editor'], 'the parser reads the escaped key')

  const { refusal } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(refusal, undefined)
  const written = fs.readFileSync(teamYamlPath, 'utf8')
  assert.equal(
    written,
    text(
      ...EXPECTED_HEAD_WITHOUT_WRITER,
      'levels:',
      '  - id: draft',
      '    name: Draft',
      '    order: 0',
      '    stage:',
      '      type: discussion',
      '      coordinator: "lead"',
      `      "partic${String.fromCharCode(92)}u0069pants":`,
      '        - "editor"',
      ...EXPECTED_DONE_GATE,
      '',
    ),
  )
  assert.deepEqual(parsedStage(written).participants, ['editor'])
})

// Each key line and the line expected in the written file, spelled out
// separately so the expectation does not reuse the input.
for (const [label, keyLine, expectedKeyLine] of [
  ['single-quoted', "      'participants':", "      'participants':"],
  ['spaced', '      participants :', '      participants :'],
] as const) {
  test(`a ${label} participants key is pruned like a plain one`, async (t) => {
    const teamYaml = text(
      ...HEADER,
      ...ROSTER,
      'levels:',
      '  - id: draft',
      '    name: Draft',
      '    order: 0',
      '    stage:',
      '      type: discussion',
      '      coordinator: "lead"',
      keyLine,
      '        - "writer"',
      '        - "editor"',
      'gates:',
      ...DONE_GATE,
      '',
    )
    const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

    const { refusal } = await attemptRemoval(repoRoot, 'writer')
    assert.equal(refusal, undefined)
    const written = fs.readFileSync(teamYamlPath, 'utf8')
    assert.equal(
      written,
      text(
        ...EXPECTED_HEAD_WITHOUT_WRITER,
        'levels:',
        '  - id: draft',
        '    name: Draft',
        '    order: 0',
        '    stage:',
        '      type: discussion',
        '      coordinator: "lead"',
        expectedKeyLine,
        '        - "editor"',
        ...EXPECTED_DONE_GATE,
        '',
      ),
    )
    assert.deepEqual(parsedStage(written).participants, ['editor'])
  })
}
