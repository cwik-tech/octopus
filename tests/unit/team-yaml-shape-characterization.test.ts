/**
 * Exact `team.yaml` bytes and refusals for changing how a saved team works
 * together.
 *
 * The ADR promises that a shape change replaces the keys that describe the
 * shape and leaves every other line as it was
 * (docs/adr/2026-09-14-Team-Interaction-Shapes.md). Other suites check the
 * inside of the stage with regexes, so these tests compare whole files against
 * literals. They also pin which saved teams may be rewritten, the exact
 * refusals, and the publication check that compares a built stage with its
 * admitted shape.
 *
 * Each test writes a team into a temporary repository and drives a public
 * entry: `changeSavedTeamShape`, `readTeamBuilderTeam` or
 * `finishTeamBuilderPublication`.
 */

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addTeamBuilderAgent,
  changeSavedTeamShape,
  createTeamBuilderTeam,
  digestTeamYaml,
  finishTeamBuilderPublication,
  isTeamBuilding,
  readTeamBuilderTeam,
  TeamRevisionConflictError,
  TeamShapeNotEditableError,
  TeamShapeRosterError,
} from '../../domains/agent-generator/team-manager.js'
import type { TeamShape } from '../../contracts/schemas/team-shape.js'

const TEAM_ID = 'shape-team'
const SAVED = 'this is how the team is set up now.'

/** Joins fixture lines into the exact text of a file. */
function text(...lines: string[]): string {
  return lines.join('\n')
}

function writePersona(repoRoot: string, name: string): void {
  const agentDir = path.join(repoRoot, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} persona.\ntier: strategic\n---\n\n# ${name}\n`,
  )
}

/** A repository holding one registered team and the named personas. */
function makeRepo(
  t: TestContext,
  teamYaml: string,
  personas: readonly string[],
): { repoRoot: string; teamYamlPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-shape-'))
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  for (const name of personas) writePersona(repoRoot, name)
  const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
  fs.mkdirSync(teamDir, { recursive: true })
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  fs.writeFileSync(teamYamlPath, teamYaml)
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    text(`${TEAM_ID}:`, '  type: team', '  description: Shape fixture.', `  team_path: ./teams/${TEAM_ID}`, ''),
  )
  return { repoRoot, teamYamlPath }
}

/** A repository with an empty registry, for teams the builder creates. */
function makeEmptyRepo(t: TestContext, personas: readonly string[]): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-shape-'))
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  for (const name of personas) writePersona(repoRoot, name)
  return repoRoot
}

/** Everything above `levels:`, with the result owned by `owner`. */
function above(owner: 'alpha' | 'beta' | 'nobody', teamKeys = ['  created_by: "team-builder"']): string[] {
  return [
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: A generated team.',
    ...teamKeys,
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
    // A per-member pin nothing in this feature knows about.
    '    model: pinned/alpha-model',
    ...(owner === 'alpha' ? ['    produces:', '      - path: "final-result.md"'] : []),
    '  - name: "beta"',
    '    type: agent',
    '    role: Beta.',
    '    tools: []',
    '    agent_file: "../../agents/beta/beta.md"',
    ...(owner === 'beta' ? ['    produces:', '      - path: "final-result.md"'] : ['    produces: []']),
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

/**
 * A published chain the author has made their own inside the stage: notes on
 * both headers, a note at the margin, a blank line and a nested note inside
 * `sequence:`, a note on the end of the handoff setting, a setting only a chain
 * has, a constraint list, `user_review` turned on by hand, a note and a stage
 * setting written after the config block, and a margin note that introduces
 * `gates:`.
 */
const AUTHORED_CHAIN = text(
  ...above('beta'),
  'levels:',
  '  - id: setup',
  '    name: Setup',
  '    order: 0',
  '    stage:  # stage note',
  '      type: chain',
  '# margin note inside the stage',
  '      sequence:',
  '        - "alpha"',
  '',
  '        # between members',
  '        - "beta"',
  '      # before config',
  '      config:  # config note',
  '        handoff_format: markdown  # handoff note',
  '        mode: strict',
  '        constraints:',
  '          - Quote the clause first.',
  '        output:',
  '          format: "final-result.md"',
  '          user_review: true',
  '      # after config',
  '      on_agent_failure: skip',
  '',
  '# note before gates',
  ...GATES,
)

/** The lines of AUTHORED_CHAIN's stage that are the author's, after a rewrite. */
const KEPT_STAGE_LINES = [
  '# margin note inside the stage',
  '',
  '        # between members',
  '      # before config',
  '      config:  # config note',
]
const KEPT_CONFIG_LINES = [
  '        # handoff note',
  '        constraints:',
  '          - Quote the clause first.',
  '        output:',
  '          format: "final-result.md"',
  '          user_review: true',
  // After the config block, so neither line is the rewrite's to touch.
  '      # after config',
  '      on_agent_failure: skip',
  '',
  '# note before gates',
  ...GATES,
]
const SETUP_HEAD = ['levels:', '  - id: setup', '    name: Setup', '    order: 0', '    stage:  # stage note']

async function changeAuthoredChain(t: TestContext, shape: TeamShape): Promise<{ written: string; reported: unknown }> {
  const { repoRoot, teamYamlPath } = makeRepo(t, AUTHORED_CHAIN, ['alpha', 'beta'])
  const detail = await changeSavedTeamShape({
    repoRoot,
    teamId: TEAM_ID,
    shape,
    expectedRevision: digestTeamYaml(AUTHORED_CHAIN),
  })
  return { written: fs.readFileSync(teamYamlPath, 'utf8'), reported: detail.shape }
}

test('changing an authored chain into a discussion replaces only the keys that describe the shape', async (t) => {
  const { written, reported } = await changeAuthoredChain(t, {
    kind: 'discussion', rationale: 'r', depth: 'standard', coordinator: 'alpha', participants: ['beta'],
  })
  // The new keys lead the stage and the config; every line the author wrote
  // follows them in its original order. The note on the removed handoff line
  // stays at that key's indent. `mode` belonged to the chain and goes. The note
  // and setting after the config block stay where they were.
  assert.equal(
    written,
    text(
      ...above('alpha'),
      ...SETUP_HEAD,
      '      type: discussion',
      '      coordinator: "alpha"',
      '      participants:',
      '        - "beta"',
      ...KEPT_STAGE_LINES,
      '        min_rounds: 1',
      '        max_rounds: 3',
      ...KEPT_CONFIG_LINES,
    ),
  )
  assert.deepEqual(reported, {
    kind: 'discussion', rationale: SAVED, depth: 'standard', coordinator: 'alpha', participants: ['beta'],
  })
})

test('changing an authored chain into a review replaces only the keys that describe the shape', async (t) => {
  const { written, reported } = await changeAuthoredChain(t, {
    kind: 'review', rationale: 'r', depth: 'thorough', producer: 'beta', reviewer: 'alpha',
  })
  assert.equal(
    written,
    text(
      ...above('nobody'),
      ...SETUP_HEAD,
      '      type: review',
      '      producer: "beta"',
      '      reviewer: "alpha"',
      ...KEPT_STAGE_LINES,
      '        max_iterations: 5',
      '        on_max_iterations: escalate_to_user',
      ...KEPT_CONFIG_LINES,
    ),
  )
  assert.deepEqual(reported, {
    kind: 'review', rationale: SAVED, depth: 'thorough', producer: 'beta', reviewer: 'alpha',
  })
})

test('changing an authored chain into a new order rewrites the sequence and reports the one depth a chain has', async (t) => {
  const { written, reported } = await changeAuthoredChain(t, {
    kind: 'chain', rationale: 'r', depth: 'thorough', order: ['beta', 'alpha'],
  })
  assert.equal(
    written,
    text(
      ...above('alpha'),
      ...SETUP_HEAD,
      '      type: chain',
      '      sequence:',
      '        - "beta"',
      '        - "alpha"',
      ...KEPT_STAGE_LINES,
      '        handoff_format: markdown',
      ...KEPT_CONFIG_LINES,
    ),
  )
  // A chain runs each member once, so it reads back as `quick` whatever depth
  // the change asked for.
  assert.deepEqual(reported, { kind: 'chain', rationale: SAVED, depth: 'quick', order: ['beta', 'alpha'] })
})

/** A published two-member team with the given stage lines under `stage:`. */
function savedTeam(stage: readonly string[], options: { gates?: string[]; levelId?: string; teamKeys?: string[] } = {}): string {
  return text(
    ...above('nobody', options.teamKeys),
    'levels:',
    `  - id: ${options.levelId ?? 'setup'}`,
    '    name: Setup',
    '    order: 0',
    '    stage:',
    ...stage,
    '',
    ...(options.gates ?? GATES),
  )
}

const CHAIN_STAGE = [
  '      type: chain',
  '      sequence:',
  '        - "alpha"',
  '        - "beta"',
  '      config:',
  '        handoff_format: markdown',
  '        output:',
  '          format: "final-result.md"',
  '          user_review: false',
]

test('a saved team whose arrangement this app does not recognise reports no shape and is not rewritten', async (t) => {
  const gate = (from: string, to: string, type: string): string[] => [
    'gates:', `  - from: ${from}`, `    to: ${to}`, '    condition:', `      type: ${type}`, '      artifact: "final-result.md"', '',
  ]
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['the gate leaves from another level', savedTeam(CHAIN_STAGE, { gates: gate('warmup', 'done', 'artifact_exists') })],
    ['the gate leads somewhere else', savedTeam(CHAIN_STAGE, { gates: gate('setup', 'review', 'artifact_exists') })],
    ['the gate waits on something else', savedTeam(CHAIN_STAGE, { gates: gate('setup', 'done', 'agent_verdict') })],
    ['there is no gate', savedTeam(CHAIN_STAGE, { gates: ['gates: []', ''] })],
    ['the level is not the setup level', savedTeam(CHAIN_STAGE, { levelId: 'main' })],
  ]
  for (const [name, teamYaml] of cases) {
    const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['alpha', 'beta'])
    assert.equal(readTeamBuilderTeam(repoRoot, TEAM_ID).shape, undefined, `${name}: a shape was offered`)
    await assert.rejects(
      changeSavedTeamShape({
        repoRoot,
        teamId: TEAM_ID,
        shape: { kind: 'discussion', rationale: 'r', depth: 'quick', coordinator: 'alpha', participants: ['beta'] },
        expectedRevision: digestTeamYaml(teamYaml),
      }),
      TeamShapeNotEditableError,
      name,
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml, `${name}: the file was rewritten`)
  }
})

test('a saved shape change is refused by name, revision first, and writes nothing', async (t) => {
  const discussion: TeamShape = {
    kind: 'discussion', rationale: 'r', depth: 'quick', coordinator: 'alpha', participants: ['beta'],
  }
  const stale = `sha256:${'0'.repeat(64)}`
  const building = savedTeam(CHAIN_STAGE, { teamKeys: ['  created_by: "team-builder"', '  building: true'] })
  const foreign = savedTeam(CHAIN_STAGE, { teamKeys: [] })
  const plain = savedTeam(CHAIN_STAGE)
  const cases: ReadonlyArray<{
    name: string
    teamYaml: string
    shape: TeamShape
    revision: string
    refusal: (error: unknown) => boolean
  }> = [
    {
      name: 'a stale revision on a team that is also not editable',
      teamYaml: foreign,
      shape: discussion,
      revision: stale,
      refusal: (error) => error instanceof TeamRevisionConflictError,
    },
    {
      name: 'a team still being built',
      teamYaml: building,
      shape: discussion,
      revision: digestTeamYaml(building),
      refusal: (error) =>
        !(error instanceof TeamShapeNotEditableError) &&
        error instanceof Error &&
        error.message === `Team '${TEAM_ID}' is still being built. Wait for its build to finish.`,
    },
    {
      name: 'a team this app did not create',
      teamYaml: foreign,
      shape: discussion,
      revision: digestTeamYaml(foreign),
      refusal: (error) =>
        error instanceof TeamShapeNotEditableError &&
        error.message === `Team '${TEAM_ID}' was not created here, so how it works together cannot be changed from this app.`,
    },
    {
      name: 'a shape that leaves a member out',
      teamYaml: plain,
      shape: { ...discussion, participants: [] },
      revision: digestTeamYaml(plain),
      refusal: (error) =>
        error instanceof TeamShapeRosterError &&
        error.message === 'Every team member must appear in exactly one role. (beta)',
    },
  ]
  for (const scenario of cases) {
    const { repoRoot, teamYamlPath } = makeRepo(t, scenario.teamYaml, ['alpha', 'beta'])
    await assert.rejects(
      changeSavedTeamShape({ repoRoot, teamId: TEAM_ID, shape: scenario.shape, expectedRevision: scenario.revision }),
      (error: unknown) => {
        assert.ok(scenario.refusal(error), `${scenario.name}: ${String(error)}`)
        return true
      },
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), scenario.teamYaml, `${scenario.name}: the file was rewritten`)
  }
})

test('publication refuses a discussion or review that differs from its admitted shape in any executable field', async (t) => {
  const builtDiscussion: TeamShape = {
    kind: 'discussion', rationale: 'r', depth: 'standard', coordinator: 'alpha', participants: ['beta', 'gamma'],
  }
  const builtReview: TeamShape = {
    kind: 'review', rationale: 'r', depth: 'standard', producer: 'alpha', reviewer: 'beta',
  }
  const cases: ReadonlyArray<{ built: TeamShape; admitted: TeamShape; refusal?: string }> = [
    { built: builtDiscussion, admitted: { ...builtDiscussion, coordinator: 'beta', participants: ['alpha', 'gamma'] }, refusal: "it was admitted with 'beta' leading it." },
    { built: builtDiscussion, admitted: { ...builtDiscussion, participants: ['gamma', 'beta'] }, refusal: 'its participants are not the ones this build was admitted with.' },
    { built: builtDiscussion, admitted: { ...builtDiscussion, depth: 'quick' }, refusal: 'it was admitted to go 1 round(s).' },
    { built: builtReview, admitted: { ...builtReview, producer: 'beta', reviewer: 'alpha' }, refusal: "it was admitted with 'beta' writing." },
    { built: builtReview, admitted: { ...builtReview, reviewer: 'gamma' }, refusal: "it was admitted with 'gamma' checking." },
    { built: builtReview, admitted: { ...builtReview, depth: 'thorough' }, refusal: 'it was admitted to allow 5 attempt(s).' },
    { built: builtReview, admitted: builtReview },
  ]
  for (const scenario of cases) {
    const roster = scenario.built.kind === 'discussion' ? ['alpha', 'beta', 'gamma'] : ['alpha', 'beta']
    const repoRoot = makeEmptyRepo(t, roster)
    await createTeamBuilderTeam(repoRoot, { id: TEAM_ID, description: 'A build.', building: true, shape: scenario.built })
    for (const name of roster) await addTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: name })
    const publishing = finishTeamBuilderPublication(repoRoot, TEAM_ID, {
      expectedRoster: roster,
      expectedShape: scenario.admitted,
    })
    if (scenario.refusal === undefined) {
      await publishing
      assert.equal(isTeamBuilding(repoRoot, TEAM_ID), false)
      continue
    }
    await assert.rejects(publishing, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, `Cannot publish team '${TEAM_ID}': ${scenario.refusal}`)
      return true
    })
    assert.equal(isTeamBuilding(repoRoot, TEAM_ID), true, scenario.refusal)
  }
})
