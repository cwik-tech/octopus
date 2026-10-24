/**
 * Saved-shape changes that must rewrite the real stage, or refuse.
 *
 * `changeSavedTeamShape` rewrites the keys that describe how a saved team
 * works together and keeps every other line. These tests pin the files where
 * it used to write into the wrong place, report success without writing, leave
 * a stray line, or leave a second copy of a key behind.
 */

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  changeSavedTeamShape,
  digestTeamYaml,
  TeamShapeNotEditableError,
} from '../../domains/agent-generator/team-manager.js'
import { parseYaml } from '../../core/yaml-parser.js'

const TEAM_ID = 'shape-safety-team'

function text(...lines: string[]): string {
  return lines.join('\n')
}

function makeRepo(t: TestContext, teamYaml: string): { repoRoot: string; teamYamlPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-shape-safety-'))
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  for (const name of ['alpha', 'beta']) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} persona.\ntier: strategic\n---\n\n# ${name}\n`,
    )
  }
  const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
  fs.mkdirSync(teamDir, { recursive: true })
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  fs.writeFileSync(teamYamlPath, teamYaml)
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    text(`${TEAM_ID}:`, '  type: team', '  description: Shape safety fixture.', `  team_path: ./teams/${TEAM_ID}`, ''),
  )
  return { repoRoot, teamYamlPath }
}

function teamHeader(description: readonly string[] = ['  description: A generated team.']): string[] {
  return [
    'team:',
    `  name: "${TEAM_ID}"`,
    ...description,
    '  created_by: "team-builder"',
    '',
    'workflow:',
    '  entry_level: setup',
    '  output_contract:',
    '    completion_artifact: "final-result.md"',
    '',
    'agents:',
    '  - name: "alpha"',
    '    type: agent',
    '    role: Alpha.',
    '    tools: []',
    '    agent_file: "../../agents/alpha/alpha.md"',
    '  - name: "beta"',
    '    type: agent',
    '    role: Beta.',
    '    tools: []',
    '    agent_file: "../../agents/beta/beta.md"',
    '    produces:',
    '      - path: "final-result.md"',
    '',
  ]
}

const GATES = [
  'gates:',
  '  - from: setup',
  '    to: done',
  '    condition:',
  '      type: artifact_exists',
  '      artifact: "final-result.md"',
  '',
]

const CHAIN_STAGE = [
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
  '        output:',
  '          format: "final-result.md"',
  '',
]

function setupStage(yaml: string): Record<string, unknown> {
  const levels = parseYaml(yaml).levels
  assert.ok(Array.isArray(levels), 'levels must parse as a list')
  const [level] = levels
  assert.ok(isRecord(level) && isRecord(level.stage), 'the setup level must have a stage')
  return level.stage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test('a description line reading `stage:` is left alone, and the setup stage is the one rewritten', async (t) => {
  const header = teamHeader([
    '  description: >',
    '    Work moves through one',
    '    stage:',
    '    then it is done.',
  ])
  const teamYaml = text(...header, ...CHAIN_STAGE, ...GATES)
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  const detail = await changeSavedTeamShape({
    repoRoot,
    teamId: TEAM_ID,
    shape: { kind: 'discussion', rationale: 'r', depth: 'standard', coordinator: 'alpha', participants: ['beta'] },
    expectedRevision: digestTeamYaml(teamYaml),
  })

  const written = fs.readFileSync(teamYamlPath, 'utf8')
  // The `team:` block, description included, is exactly as written. (The
  // roster below it changes on purpose: a discussion's lead owns the result.)
  const teamBlock = header.slice(0, header.indexOf('  created_by: "team-builder"') + 1).join('\n')
  assert.ok(written.startsWith(`${teamBlock}\n`), `the team block changed:\n${written}`)
  assert.equal(setupStage(written).type, 'discussion')
  assert.equal(detail.shape?.kind, 'discussion')
})

test('an indentless levels list is refused rather than reported changed with the file untouched', async (t) => {
  const teamYaml = text(
    ...teamHeader(),
    'levels:',
    '- id: setup',
    '  name: Setup',
    '  order: 0',
    '  stage:',
    '    type: chain',
    '    sequence:',
    '      - "alpha"',
    '      - "beta"',
    '    config:',
    '      handoff_format: markdown',
    '      output:',
    '        format: "final-result.md"',
    '',
    ...GATES,
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  await assert.rejects(
    changeSavedTeamShape({
      repoRoot,
      teamId: TEAM_ID,
      shape: { kind: 'discussion', rationale: 'r', depth: 'standard', coordinator: 'alpha', participants: ['beta'] },
      expectedRevision: digestTeamYaml(teamYaml),
    }),
    TeamShapeNotEditableError,
  )
  assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
})

test('removing a quoted shape value that holds `#` leaves no stray line', async (t) => {
  const teamYaml = text(
    ...teamHeader(),
    'levels:',
    '  - id: setup',
    '    name: Setup',
    '    order: 0',
    '    stage:',
    '      type: discussion # the lead',
    '      coordinator: "risk#lead"',
    '      participants:',
    '        - "alpha"',
    '        - "beta"',
    '      config:',
    '        min_rounds: 1',
    '        max_rounds: 3',
    '        output:',
    '          format: "final-result.md"',
    '',
    ...GATES,
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  await changeSavedTeamShape({
    repoRoot,
    teamId: TEAM_ID,
    shape: { kind: 'chain', rationale: 'r', depth: 'standard', order: ['alpha', 'beta'] },
    expectedRevision: digestTeamYaml(teamYaml),
  })

  const written = fs.readFileSync(teamYamlPath, 'utf8')
  assert.doesNotMatch(written, /lead"/u, written)
  // A real note on a removed key is the author's and stays.
  assert.match(written, /^ {6}# the lead$/mu)
  assert.equal(setupStage(written).type, 'chain')
})

test('a shape key written after the config block is replaced, not left as a second copy', async (t) => {
  const teamYaml = text(
    ...teamHeader(),
    'levels:',
    '  - id: setup',
    '    name: Setup',
    '    order: 0',
    '    stage:',
    '      sequence:',
    '        - "alpha"',
    '        - "beta"',
    '      config:',
    '        handoff_format: markdown',
    '        output:',
    '          format: "final-result.md"',
    '      type: chain',
    '',
    ...GATES,
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml)

  const detail = await changeSavedTeamShape({
    repoRoot,
    teamId: TEAM_ID,
    shape: { kind: 'discussion', rationale: 'r', depth: 'standard', coordinator: 'alpha', participants: ['beta'] },
    expectedRevision: digestTeamYaml(teamYaml),
  })

  const written = fs.readFileSync(teamYamlPath, 'utf8')
  // Counted inside the levels block only; the gate's condition has a `type:`
  // at the same depth.
  const levelsBlock = written.slice(written.indexOf('\nlevels:'), written.indexOf('\ngates:'))
  assert.equal(levelsBlock.match(/^ {6}type:/gmu)?.length, 1, written)
  assert.equal(setupStage(written).type, 'discussion')
  assert.equal(detail.shape?.kind, 'discussion')
})
