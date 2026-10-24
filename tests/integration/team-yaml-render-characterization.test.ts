/**
 * The `team.yaml` and `teams.yaml` bytes Team Manager writes when it creates a
 * team, edits its metadata, renames or deletes it, or applies a shape to a team
 * still being built.
 *
 * Other suites mostly read these files back through the parser. A few match
 * single lines, such as the quoted `team_path` and the four-space description
 * indent in `team-builder-manager.test.ts`, but most changes to key order,
 * quoting, indentation, blank lines or the artifact names these files carry
 * still pass them. These tests compare whole files instead, including the
 * current quirks: a metadata edit re-renders the whole `team:` block (version
 * reset, unmodelled keys and comments dropped, `published_by` moved), an edit
 * without tags empties the registry tags and drops `requested_capability` and
 * `mount`, a block replace takes the blank lines and column-zero comments
 * before the next key with it, a registry removal collapses blank-line runs in
 * the whole file except inside another entry's `|` or `>` block scalar, where
 * blank lines are part of the value, and a `team:` block appended to an empty
 * file starts with a blank line.
 *
 * Each test writes a repository into a temporary directory and calls the
 * exported Team Manager operation against it.
 */

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  applyTeamBuilderShape,
  createTeamBuilderTeam,
  deleteTeamBuilderTeam,
  updateTeamBuilderTeam,
} from '../../domains/agent-generator/team-manager.js'
import type { TeamShape } from '../../contracts/schemas/team-shape.js'
import { parseYaml } from '../../core/yaml-parser.js'

/** Joins fixture lines into the exact text of a file. */
function text(...lines: string[]): string {
  return lines.join('\n')
}

/**
 * A temporary repository: a `teams.yaml` when one is given (absent otherwise),
 * one `teams/<id>/team.yaml` per entry of `teams`, and a library persona for
 * each name in `personas`.
 */
function makeRepo(
  t: TestContext,
  setup: {
    registry?: string
    teams?: Readonly<Record<string, string>>
    personas?: readonly string[]
  } = {},
): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-render-'))
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  for (const name of setup.personas ?? []) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} persona.\n---\n\n# ${name}\n`,
    )
  }
  for (const [id, teamYaml] of Object.entries(setup.teams ?? {})) {
    const teamDir = path.join(repoRoot, 'teams', id)
    fs.mkdirSync(teamDir, { recursive: true })
    fs.writeFileSync(path.join(teamDir, 'team.yaml'), teamYaml)
  }
  if (setup.registry !== undefined) {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), setup.registry)
  }
  return repoRoot
}

function readRegistry(repoRoot: string): string {
  return fs.readFileSync(path.join(repoRoot, 'teams.yaml'), 'utf8')
}

function readTeamYaml(repoRoot: string, teamId: string): string {
  return fs.readFileSync(path.join(repoRoot, 'teams', teamId, 'team.yaml'), 'utf8')
}

/** A hand-written registry entry pointing at `./teams/<id>`. */
function registryEntry(id: string, description: string): string[] {
  return [`${id}:`, '  type: team', `  description: ${description}`, `  team_path: ./teams/${id}`]
}

/** One roster entry as the Team Builder add path renders it. */
function member(name: string, extra: readonly string[] = []): string[] {
  return [
    `  - name: "${name}"`,
    '    type: agent',
    '    role: >',
    `      ${name} persona.`,
    '    tools: []',
    `    agent_file: "../../agents/${name}/${name}.md"`,
    ...extra,
  ]
}

const OWNS_RESULT = ['    produces:', '      - path: "final-result.md"']

/** Everything a created team.yaml holds between its `team:` and `levels:` blocks. */
const CREATED_BODY = [
  '',
  'workspace:',
  '  path: ../../workspace',
  '  watch: false',
  '',
  'workflow:',
  '  entry_level: setup',
  '  invocation_modes:',
  '    - user',
  '    - team',
  '  user_facing: true',
  '  input_contract:',
  '    artifacts:',
  '      - path: "incoming-brief.md"',
  '        required: true',
  '        description: Runtime brief for the generated team.',
  '  output_contract:',
  '    artifacts:',
  '      - path: "final-result.md"',
  '        required: true',
  '        description: Final result produced by the generated team.',
  '    completion_artifact: "final-result.md"',
  '',
  'agents: []',
  '',
]

const SETUP_LEVEL = ['levels:', '  - id: setup', '    name: Setup', '    order: 0', '    stage:']

const STAGE_OUTPUT = [
  '        output:',
  '          format: "final-result.md"',
  '          user_review: false',
]

const GATES = [
  'gates:',
  '  - from: setup',
  '    to: done',
  '    condition:',
  '      type: artifact_exists',
  '      artifact: "final-result.md"',
]

test('a team created with no shape and no build writes these exact team.yaml and teams.yaml bytes', async (t) => {
  const repoRoot = makeRepo(t, { registry: '' })

  await createTeamBuilderTeam(repoRoot, {
    id: 'plain-team',
    description: 'Turns a brief into a short answer.',
  })

  assert.equal(
    readTeamYaml(repoRoot, 'plain-team'),
    text(
      'team:',
      '  name: "plain-team"',
      '  description: >',
      '    Turns a brief into a short answer.',
      '  version: "0.1.0"',
      '  created_by: "team-builder"',
      ...CREATED_BODY,
      // No roster yet, so the chain names no sequence.
      ...SETUP_LEVEL,
      '      type: chain',
      '      config:',
      '        handoff_format: markdown',
      ...STAGE_OUTPUT,
      '',
      ...GATES,
      '',
    ),
  )
  // Written into an empty file: the entry is the whole file, with no host pair.
  assert.equal(
    readRegistry(repoRoot),
    text(
      'plain-team:',
      '  type: team',
      '  description: "Turns a brief into a short answer."',
      '  team_path: "./teams/plain-team"',
      '  input_artifact: "incoming-brief.md"',
      '  output_artifact: "final-result.md"',
      '  tags: []',
      '',
    ),
  )
})

const EDITOR_LEADS: TeamShape = {
  kind: 'discussion',
  rationale: 'The editor runs the conversation.',
  depth: 'standard',
  coordinator: 'editor',
  participants: ['drafter', 'checker'],
}

test('a build-owned team created with a key, a shape, tags and a long description writes these exact bytes, and a second create appends after one blank line', async (t) => {
  const repoRoot = makeRepo(t)
  const releaseNotesEntry = [
    'release-notes:',
    '  type: team',
    '  description: "Drafts a customer-facing release note from the change list, then has a second reader challenge every claim before the note is published."',
    '  team_path: "./teams/release-notes"',
    '  input_artifact: "incoming-brief.md"',
    '  output_artifact: "final-result.md"',
    '  tags:',
    '    - "review"',
    '    - "writing"',
  ]

  await createTeamBuilderTeam(repoRoot, {
    id: 'release-notes',
    description:
      '  Drafts a customer-facing release note from the change list, then has a second reader challenge every claim before the note is published.  ',
    tags: ['writing', ' review ', 'writing', ''],
    orchestratorKey: 'plan-42:release-notes',
    shape: EDITOR_LEADS,
    building: true,
  })

  assert.equal(
    readTeamYaml(repoRoot, 'release-notes'),
    text(
      'team:',
      '  name: "release-notes"',
      '  description: >',
      '    Drafts a customer-facing release note from the change list, then has a',
      '    second reader challenge every claim before the note is published.',
      '  version: "0.1.0"',
      '  created_by: "team-builder"',
      '  building: true',
      '  created_by_orchestrator: "plan-42:release-notes"',
      ...CREATED_BODY,
      ...SETUP_LEVEL,
      '      type: discussion',
      '      coordinator: "editor"',
      '      participants:',
      '        - "drafter"',
      '        - "checker"',
      '      config:',
      '        min_rounds: 1',
      '        max_rounds: 3',
      ...STAGE_OUTPUT,
      '',
      ...GATES,
      '',
    ),
  )
  // Tags trimmed, emptied ones dropped, deduplicated and sorted.
  assert.equal(readRegistry(repoRoot), text(...releaseNotesEntry, ''))

  // A hand edit leaves the registry ending in blank lines.
  fs.appendFileSync(path.join(repoRoot, 'teams.yaml'), '\n\n')
  await createTeamBuilderTeam(repoRoot, { id: 'second-team' })

  assert.equal(
    readRegistry(repoRoot),
    text(
      ...releaseNotesEntry,
      '',
      'second-team:',
      '  type: team',
      '  description: "second-team team."',
      '  team_path: "./teams/second-team"',
      '  input_artifact: "incoming-brief.md"',
      '  output_artifact: "final-result.md"',
      '  tags: []',
      '',
    ),
  )
})

/** A published team's file from `workspace:` on, left byte-identical by a metadata edit. */
const PUBLISHED_BODY = [
  'workspace:',
  '  path: ../../workspace',
  '  watch: false',
  '',
  'workflow:',
  '  entry_level: setup',
  '  output_contract:',
  '    artifacts:',
  '      - path: "final-result.md"',
  '        required: true',
  '    completion_artifact: "final-result.md"',
  '',
  'agents:',
  ...member('writer', OWNS_RESULT),
  '',
  ...SETUP_LEVEL,
  '      type: chain',
  '      sequence:',
  '        - "writer"',
  '      config:',
  '        handoff_format: markdown',
  ...STAGE_OUTPUT,
  '',
  ...GATES,
  '',
]

/** A published team's file, with `published_by` first as publication writes it. */
function publishedTeamYaml(extraTeamKeys: readonly string[]): string {
  return text(
    'team:',
    '  published_by: "plan-7"',
    '  name: "meta-team"',
    '  description: >',
    '    The old description.',
    ...extraTeamKeys,
    '  created_by: "team-builder"',
    '  created_by_orchestrator: "plan-7:meta-team"',
    '  version: "2.0.0"',
    '  owner_note: kept by hand',
    '  # A note inside the team block.',
    '',
    '# A column-zero note before the workspace.',
    ...PUBLISHED_BODY,
  )
}

test("editing a published team's metadata rewrites only its team: block, in the renderer's order", async (t) => {
  const setup = {
    registry: text(...registryEntry('meta-team', 'Meta.'), ''),
    personas: ['writer'],
  }
  const published = makeRepo(t, { ...setup, teams: { 'meta-team': publishedTeamYaml([]) } })
  // Hand-made, not a lifecycle state: publication removes `building` when it writes `published_by`.
  const building = makeRepo(t, {
    ...setup,
    teams: { 'meta-team': publishedTeamYaml(['  building: true']) },
  })
  const edit = {
    id: 'meta-team',
    description: 'Writes the weekly summary for the operations channel.',
  }

  await updateTeamBuilderTeam(published, 'meta-team', edit)
  await updateTeamBuilderTeam(building, 'meta-team', edit)

  // Version reset, the unmodelled key and the note inside the team block
  // gone, the blank line before the column-zero note gone, and `published_by`
  // after `created_by`. The column-zero note before `workspace:` belongs to
  // `workspace:` and stays.
  assert.equal(
    readTeamYaml(published, 'meta-team'),
    text(
      'team:',
      '  name: "meta-team"',
      '  description: >',
      '    Writes the weekly summary for the operations channel.',
      '  version: "0.1.0"',
      '  created_by: "team-builder"',
      '  published_by: "plan-7"',
      '  created_by_orchestrator: "plan-7:meta-team"',
      '# A column-zero note before the workspace.',
      ...PUBLISHED_BODY,
    ),
  )
  // The building marker is kept, between `created_by` and `published_by`.
  assert.equal(
    readTeamYaml(building, 'meta-team'),
    text(
      'team:',
      '  name: "meta-team"',
      '  description: >',
      '    Writes the weekly summary for the operations channel.',
      '  version: "0.1.0"',
      '  created_by: "team-builder"',
      '  building: true',
      '  published_by: "plan-7"',
      '  created_by_orchestrator: "plan-7:meta-team"',
      '# A column-zero note before the workspace.',
      ...PUBLISHED_BODY,
    ),
  )
})

/** A generated team's file, enough for Team Manager to read and edit it. */
function generatedTeamYaml(id: string): string {
  return text(
    'team:',
    `  name: "${id}"`,
    '  description: >',
    `    ${id} fixture.`,
    '  version: "0.1.0"',
    '  created_by: "team-builder"',
    ...CREATED_BODY,
    ...SETUP_LEVEL,
    '      type: chain',
    '      config:',
    '        handoff_format: markdown',
    ...STAGE_OUTPUT,
    '',
    ...GATES,
    '',
  )
}

test('a metadata edit without tags empties the registry tags, keeps the artifact and host fields, and drops fields it does not model', async (t) => {
  const repoRoot = makeRepo(t, {
    registry: text(
      ...registryEntry('first-team', 'First team.'),
      '',
      'edited-team:',
      '  type: team',
      '  description: "Old description."',
      '  team_path: ./teams/edited-team',
      '  input_artifact: brief.md',
      '  output_artifact: answer.md',
      '  host_model: local-model',
      '  host_provider: lm-studio',
      '  requested_capability: research',
      '  mount:',
      '    - from: ./shared',
      '      to: shared',
      '  tags:',
      '    - "old"',
      '',
      ...registryEntry('last-team', 'Last team.'),
      '',
    ),
    teams: { 'edited-team': generatedTeamYaml('edited-team') },
  })

  await updateTeamBuilderTeam(repoRoot, 'edited-team', {
    id: 'edited-team',
    description: 'Edited description.',
  })

  // The entry is replaced up to the next key, so the blank line that
  // separated it from `last-team:` goes with it.
  assert.equal(
    readRegistry(repoRoot),
    text(
      ...registryEntry('first-team', 'First team.'),
      '',
      'edited-team:',
      '  type: team',
      '  description: "Edited description."',
      '  team_path: "./teams/edited-team"',
      '  input_artifact: "brief.md"',
      '  output_artifact: "answer.md"',
      '  host_model: "local-model"',
      '  host_provider: "lm-studio"',
      '  tags: []',
      ...registryEntry('last-team', 'Last team.'),
      '',
    ),
  )
})

test('renaming a team moves its registry entry to the end and collapses blank-line runs elsewhere', async (t) => {
  // Two blank lines before `beta-team:` and three before `omega-team:`, both
  // away from the entry being renamed.
  const repoRoot = makeRepo(t, {
    registry: text(
      'old-name:',
      '  type: team',
      '  description: "Old name."',
      '  team_path: "./teams/old-name"',
      '  input_artifact: "incoming-brief.md"',
      '  output_artifact: "final-result.md"',
      '  tags: []',
      '',
      ...registryEntry('alpha-team', 'Alpha.'),
      '',
      '',
      ...registryEntry('beta-team', 'Beta.'),
      '',
      '',
      '',
      ...registryEntry('omega-team', 'Omega.'),
      '',
    ),
    teams: { 'old-name': generatedTeamYaml('old-name') },
  })

  await updateTeamBuilderTeam(repoRoot, 'old-name', {
    id: 'new-name',
    description: 'Renamed team.',
    tags: ['kept'],
  })

  assert.equal(
    readRegistry(repoRoot),
    text(
      ...registryEntry('alpha-team', 'Alpha.'),
      '',
      ...registryEntry('beta-team', 'Beta.'),
      '',
      ...registryEntry('omega-team', 'Omega.'),
      '',
      'new-name:',
      '  type: team',
      '  description: "Renamed team."',
      '  team_path: "./teams/new-name"',
      '  input_artifact: "incoming-brief.md"',
      '  output_artifact: "final-result.md"',
      '  tags:',
      '    - "kept"',
      '',
    ),
  )
})

test('deleting a team removes its registry entry, collapses blank-line runs across the whole file and trims the trailing blank line', async (t) => {
  // The comment after `gone-team` sits inside its range, two blank lines
  // separate `keep-last` from `keep-tail`, and the file ends in a blank line.
  const repoRoot = makeRepo(t, {
    registry: text(
      ...registryEntry('keep-first', 'First.'),
      '',
      ...registryEntry('gone-team', 'Gone.'),
      '# A column-zero note after gone-team.',
      '',
      ...registryEntry('keep-last', 'Last.'),
      '',
      '',
      ...registryEntry('keep-tail', 'Tail.'),
      '',
      '',
    ),
    teams: { 'gone-team': generatedTeamYaml('gone-team') },
  })

  await deleteTeamBuilderTeam(repoRoot, 'gone-team')

  assert.equal(
    readRegistry(repoRoot),
    text(
      ...registryEntry('keep-first', 'First.'),
      '',
      ...registryEntry('keep-last', 'Last.'),
      '',
      ...registryEntry('keep-tail', 'Tail.'),
      '',
    ),
  )
})

/** A registry entry whose literal description holds two blank lines. */
const LITERAL_ENTRY = [
  'keep-literal:',
  '  type: team',
  '  description: |',
  '    a',
  '',
  '',
  '    b',
  '  team_path: ./teams/keep-literal',
]

test('deleting a team keeps the blank lines inside another entry\'s literal description', async (t) => {
  const repoRoot = makeRepo(t, {
    registry: text(
      ...LITERAL_ENTRY,
      '',
      ...registryEntry('gone-team', 'Gone.'),
      '',
    ),
    teams: { 'gone-team': generatedTeamYaml('gone-team') },
  })

  await deleteTeamBuilderTeam(repoRoot, 'gone-team')

  assert.equal(readRegistry(repoRoot), text(...LITERAL_ENTRY, ''))
  // The value the parser reads is the one it read before the delete.
  const entryAfter = parseYaml(readRegistry(repoRoot))['keep-literal']
  const entryBefore = parseYaml(text(...LITERAL_ENTRY, ''))['keep-literal']
  assert.ok(entryAfter && typeof entryAfter === 'object' && !Array.isArray(entryAfter))
  assert.ok(entryBefore && typeof entryBefore === 'object' && !Array.isArray(entryBefore))
  assert.equal(entryAfter.description, entryBefore.description)
  assert.match(String(entryAfter.description), /^a\n\n\nb/u)
})

test('deleting a team keeps the blank lines inside another entry\'s folded description, where they mark line breaks', async (t) => {
  const foldedEntry = [
    'keep-folded:',
    '  type: team',
    '  description: >-',
    '    first paragraph',
    '',
    '',
    '    second paragraph',
    '  team_path: ./teams/keep-folded',
  ]
  const repoRoot = makeRepo(t, {
    registry: text(
      ...registryEntry('gone-team', 'Gone.'),
      '',
      ...foldedEntry,
      '',
    ),
    teams: { 'gone-team': generatedTeamYaml('gone-team') },
  })

  await deleteTeamBuilderTeam(repoRoot, 'gone-team')

  assert.equal(readRegistry(repoRoot), text(...foldedEntry, ''))
})

test('renaming a team keeps the blank lines inside another entry\'s literal description', async (t) => {
  const repoRoot = makeRepo(t, {
    registry: text(
      'old-name:',
      '  type: team',
      '  description: "Old name."',
      '  team_path: "./teams/old-name"',
      '  input_artifact: "incoming-brief.md"',
      '  output_artifact: "final-result.md"',
      '  tags: []',
      '',
      ...LITERAL_ENTRY,
      '',
    ),
    teams: { 'old-name': generatedTeamYaml('old-name') },
  })

  await updateTeamBuilderTeam(repoRoot, 'old-name', { id: 'new-name', description: 'Renamed team.', tags: [] })

  assert.equal(
    readRegistry(repoRoot),
    text(
      ...LITERAL_ENTRY,
      '',
      'new-name:',
      '  type: team',
      '  description: "Renamed team."',
      '  team_path: "./teams/new-name"',
      '  input_artifact: "incoming-brief.md"',
      '  output_artifact: "final-result.md"',
      '  tags: []',
      '',
    ),
  )
})

test('a team.yaml with no team: block gains one at the end, and an empty one gains a leading blank line', async (t) => {
  const handAuthored = text(
    'workspace:',
    '  path: ../../workspace',
    '',
    'agents: []',
    '',
    ...SETUP_LEVEL,
    '      type: chain',
    '      config:',
    '        handoff_format: markdown',
    '',
    '',
    '',
  )
  const repoRoot = makeRepo(t, {
    registry: text(...registryEntry('no-meta', 'No meta.'), '', ...registryEntry('empty-meta', 'Empty.'), ''),
    teams: { 'no-meta': handAuthored, 'empty-meta': '' },
  })

  await updateTeamBuilderTeam(repoRoot, 'no-meta', { id: 'no-meta', description: 'Has no team block yet.' })
  await updateTeamBuilderTeam(repoRoot, 'empty-meta', { id: 'empty-meta', description: 'Was empty.' })

  // Trailing blank lines dropped, one blank line, then the block. No
  // provenance is minted on a file that never recorded any.
  assert.equal(
    readTeamYaml(repoRoot, 'no-meta'),
    text(
      'workspace:',
      '  path: ../../workspace',
      '',
      'agents: []',
      '',
      ...SETUP_LEVEL,
      '      type: chain',
      '      config:',
      '        handoff_format: markdown',
      '',
      'team:',
      '  name: "no-meta"',
      '  description: >',
      '    Has no team block yet.',
      '  version: "0.1.0"',
      '',
    ),
  )
  assert.equal(
    readTeamYaml(repoRoot, 'empty-meta'),
    text(
      '',
      'team:',
      '  name: "empty-meta"',
      '  description: >',
      '    Was empty.',
      '  version: "0.1.0"',
      '',
    ),
  )
})

/** A generated pair still being built: a chain of alpha then beta, beta owning the result. */
function buildingPairYaml(provenance: readonly string[]): string {
  return text(
    'team:',
    '  name: "shaped-team"',
    '  description: >',
    '    A team still being built.',
    '  version: "0.1.0"',
    ...provenance,
    '  building: true',
    '',
    'workspace:',
    '  path: ../../workspace',
    '  watch: false',
    '',
    'workflow:',
    '  entry_level: setup',
    '  output_contract:',
    '    artifacts:',
    '      - path: "final-result.md"',
    '        required: true',
    '    completion_artifact: "final-result.md"',
    '',
    'agents:',
    ...member('alpha'),
    '',
    ...member('beta', OWNS_RESULT),
    '',
    ...SETUP_LEVEL,
    '      type: chain',
    '      sequence:',
    '        - "alpha"',
    '        - "beta"',
    '      config:',
    '        handoff_format: markdown',
    ...STAGE_OUTPUT,
    '',
    '# Gates follow the setup level.',
    ...GATES,
    '',
  )
}

const BUILDER_PROVENANCE = [
  '  created_by: "team-builder"',
  '  created_by_orchestrator: "plan-9:shaped-team"',
]

/** The shaped-pair file from `team:` through the end of `workflow:`, unchanged by a shape. */
const SHAPED_HEAD = [
  'team:',
  '  name: "shaped-team"',
  '  description: >',
  '    A team still being built.',
  '  version: "0.1.0"',
  ...BUILDER_PROVENANCE,
  '  building: true',
  '',
  'workspace:',
  '  path: ../../workspace',
  '  watch: false',
  '',
  'workflow:',
  '  entry_level: setup',
  '  output_contract:',
  '    artifacts:',
  '      - path: "final-result.md"',
  '        required: true',
  '    completion_artifact: "final-result.md"',
  '',
]

const ALPHA_WRITES_BETA_CHECKS: TeamShape = {
  kind: 'review',
  rationale: 'One drafts, one checks.',
  depth: 'thorough',
  producer: 'alpha',
  reviewer: 'beta',
}

const BETA_THEN_ALPHA: TeamShape = {
  kind: 'chain',
  rationale: 'Beta hands the draft to alpha.',
  depth: 'quick',
  order: ['beta', 'alpha'],
}

test('applying a review shape and a chain shape to a build-owned team rewrites levels: and the produces: entries under agents:', async (t) => {
  const personas = ['alpha', 'beta']
  const registry = text(...registryEntry('shaped-team', 'Shaped.'), '')
  const seeded = buildingPairYaml(BUILDER_PROVENANCE)
  const reviewRepo = makeRepo(t, { registry, personas, teams: { 'shaped-team': seeded } })
  const chainRepo = makeRepo(t, { registry, personas, teams: { 'shaped-team': seeded } })
  // Building, but carrying neither `created_by` nor `created_by_orchestrator`.
  const unmarked = buildingPairYaml([])
  const unmarkedRepo = makeRepo(t, { registry, personas, teams: { 'shaped-team': unmarked } })

  await applyTeamBuilderShape({ repoRoot: reviewRepo, teamId: 'shaped-team', shape: ALPHA_WRITES_BETA_CHECKS })
  await applyTeamBuilderShape({ repoRoot: chainRepo, teamId: 'shaped-team', shape: BETA_THEN_ALPHA })

  // `levels:` is replaced up to `gates:`. The author's column-zero comment
  // before `gates:` belongs to `gates:` and stays; the blank line before it
  // goes with the replaced block (a kept formatting quirk). A review leaves
  // nobody declaring the result.
  assert.equal(
    readTeamYaml(reviewRepo, 'shaped-team'),
    text(
      ...SHAPED_HEAD,
      'agents:',
      ...member('alpha'),
      '',
      ...member('beta', ['    produces: []']),
      '',
      ...SETUP_LEVEL,
      '      type: review',
      '      producer: "alpha"',
      '      reviewer: "beta"',
      '      config:',
      '        max_iterations: 5',
      '        on_max_iterations: escalate_to_user',
      ...STAGE_OUTPUT,
      '# Gates follow the setup level.',
      ...GATES,
      '',
    ),
  )
  // A chain's last member, now alpha, owns the result.
  assert.equal(
    readTeamYaml(chainRepo, 'shaped-team'),
    text(
      ...SHAPED_HEAD,
      'agents:',
      ...member('alpha', OWNS_RESULT),
      '',
      ...member('beta', ['    produces: []']),
      '',
      ...SETUP_LEVEL,
      '      type: chain',
      '      sequence:',
      '        - "beta"',
      '        - "alpha"',
      '      config:',
      '        handoff_format: markdown',
      ...STAGE_OUTPUT,
      '# Gates follow the setup level.',
      ...GATES,
      '',
    ),
  )
  // A team with no provenance is refused and left byte-identical.
  await assert.rejects(
    applyTeamBuilderShape({ repoRoot: unmarkedRepo, teamId: 'shaped-team', shape: ALPHA_WRITES_BETA_CHECKS }),
    {
      message:
        "Cannot change how team 'shaped-team' works together: it was not created here, so its stage is its author's to change.",
    },
  )
  assert.equal(readTeamYaml(unmarkedRepo, 'shaped-team'), unmarked)
})
