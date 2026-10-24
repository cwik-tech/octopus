/**
 * Who declares `produces: final-result.md` in a team this app wrote, byte for
 * byte.
 *
 * Every team.yaml writer ends by settling that declaration onto the one member
 * the stage says writes the deliverable: a chain's last sequence member, a
 * discussion's coordinator, and nobody in a review. The edit is made as text,
 * and its bytes feed the revision digest a restarted caller uses to recognize
 * its own write, so these tests pin whole files rather than parsed owners.
 * Whitespace and quoting are part of the contract.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addTeamBuilderAgent,
  addTeamBuilderAgents,
  applyTeamBuilderShape,
  changeSavedTeamShape,
  digestTeamYaml,
  extendGeneratedStageMembership,
  removeTeamBuilderAgent,
} from '../../domains/agent-generator/team-manager.js'
import { addAgentToTeam } from '../../domains/agent-generator/team-usage.js'
import type { TeamShape } from '../../contracts/schemas/team-shape.js'

const TEAM_ID = 'owned-team'
const BUILDER_PROVENANCE = '  created_by: "team-builder"'

/** Joins fixture lines into the exact text of a file. */
function yaml(...blocks: ReadonlyArray<readonly string[]>): string {
  return blocks.flat().join('\n')
}

/** The `team:` and `workflow:` blocks, with whatever `team:` keys are given. */
function header(teamKeys: readonly string[] = [BUILDER_PROVENANCE]): string[] {
  return [
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: A generated team.',
    '  version: "0.1.0"',
    ...teamKeys,
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
}

/** One roster entry as a person would write it, with no `produces:` key. */
function member(name: string): string[] {
  return [
    `  - name: "${name}"`,
    '    type: agent',
    `    role: ${name} persona.`,
    '    tools: []',
    `    agent_file: "../../agents/${name}/${name}.md"`,
  ]
}

const OWNS_RESULT = ['    produces:', '      - path: "final-result.md"']
const OWNS_NOTHING = ['    produces: []']

/** The single `setup` level every generated team runs. */
function setupLevel(stage: readonly string[]): string[] {
  return ['levels:', '  - id: setup', '    name: Setup', '    order: 0', '    stage:', ...stage]
}

const CHAIN_CONFIG = [
  '      config:',
  '        handoff_format: markdown',
  '        output:',
  '          format: "final-result.md"',
  '          user_review: false',
]

const DISCUSSION_CONFIG = [
  '      config:',
  '        min_rounds: 1',
  '        max_rounds: 1',
  '        output:',
  '          format: "final-result.md"',
  '          user_review: false',
]

const REVIEW_STAGE = [
  '      type: review',
  '      producer: "alpha"',
  '      reviewer: "beta"',
  '      config:',
  '        max_iterations: 1',
  '        on_max_iterations: escalate_to_user',
  '        output:',
  '          format: "final-result.md"',
  '          user_review: false',
]

const GATE = [
  '',
  'gates:',
  '  - from: setup',
  '    to: done',
  '    condition:',
  '      type: artifact_exists',
  '      artifact: "final-result.md"',
  '',
]

// ---------------------------------------------------------------------------
// extendGeneratedStageMembership: string in, string out.
// ---------------------------------------------------------------------------

interface MembershipCase {
  input: string
  agentName: string
  expected: string
}

/** A generated chain whose sequence has not learned beta, with alpha owning. */
const CHAIN_CASE: MembershipCase = {
  input: yaml(
    header(),
    ['agents:', ...member('alpha'), ...OWNS_RESULT, '', ...member('beta'), ''],
    setupLevel(['      type: chain', '      sequence:', '        - "alpha"', ...CHAIN_CONFIG]),
    GATE,
  ),
  agentName: 'beta',
  expected: yaml(
    header(),
    ['agents:', ...member('alpha'), ...OWNS_NOTHING, '', ...member('beta'), ...OWNS_RESULT, ''],
    setupLevel([
      '      type: chain',
      '      sequence:',
      '        - "alpha"',
      '        - "beta"',
      ...CHAIN_CONFIG,
    ]),
    GATE,
  ),
}

/** A generated discussion whose coordinator already owns the result. */
const DISCUSSION_CASE: MembershipCase = {
  input: yaml(
    header(),
    ['agents:', ...member('lead'), ...OWNS_RESULT, '', ...member('alpha'), '', ...member('beta'), ''],
    setupLevel([
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants:',
      '        - "alpha"',
      ...DISCUSSION_CONFIG,
    ]),
    GATE,
  ),
  agentName: 'beta',
  expected: yaml(
    header(),
    ['agents:', ...member('lead'), ...OWNS_RESULT, '', ...member('alpha'), '', ...member('beta'), ''],
    setupLevel([
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants:',
      '        - "alpha"',
      '        - "beta"',
      ...DISCUSSION_CONFIG,
    ]),
    GATE,
  ),
}

/**
 * A generated discussion where a participant holds the result and the
 * coordinator's list is an annotated `produces: []`.
 */
const COORDINATOR_CASE: MembershipCase = {
  input: yaml(
    header(),
    [
      'agents:',
      ...member('lead'),
      '    produces: [] # lead writes the answer',
      '',
      ...member('alpha'),
      ...OWNS_RESULT,
      '',
    ],
    setupLevel([
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants:',
      '        - "alpha"',
      ...DISCUSSION_CONFIG,
    ]),
    GATE,
  ),
  agentName: 'lead',
  expected: yaml(
    header(),
    [
      'agents:',
      ...member('lead'),
      '    produces: # lead writes the answer',
      '      - path: "final-result.md"',
      '',
      ...member('alpha'),
      ...OWNS_NOTHING,
      '',
    ],
    setupLevel([
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants:',
      '        - "alpha"',
      ...DISCUSSION_CONFIG,
    ]),
    GATE,
  ),
}

/**
 * A generated review whose producer declares the result, description-first,
 * beside an artifact of its own.
 */
const REVIEW_CASE: MembershipCase = {
  input: yaml(
    header(),
    [
      'agents:',
      ...member('alpha'),
      '    produces:',
      '      - description: The deliverable, written description-first.',
      '        path: final-result.md',
      '      - path: "notes.md"',
      '        description: Working notes.',
      '',
      ...member('beta'),
      '',
    ],
    setupLevel(REVIEW_STAGE),
    GATE,
  ),
  agentName: 'beta',
  expected: yaml(
    header(),
    [
      'agents:',
      ...member('alpha'),
      '    produces:',
      '      - path: "notes.md"',
      '        description: Working notes.',
      '',
      ...member('beta'),
      '',
    ],
    setupLevel(REVIEW_STAGE),
    GATE,
  ),
}

/** Provenance recorded only by the older Architect marker. */
const LEGACY_PROVENANCE_CASE: MembershipCase = {
  input: yaml(
    header(['  created_by_orchestrator: "plan-1"']),
    [
      'agents:',
      ...member('alpha'),
      ...OWNS_RESULT,
      '',
      ...member('beta'),
      '    produces:',
      '      - path: "notes.md"',
      '',
    ],
    setupLevel([
      '      type: chain',
      '      sequence:',
      '        - "alpha"',
      '        - "beta"',
      ...CHAIN_CONFIG,
    ]),
    GATE,
  ),
  agentName: 'beta',
  expected: yaml(
    header(['  created_by_orchestrator: "plan-1"']),
    [
      'agents:',
      ...member('alpha'),
      ...OWNS_NOTHING,
      '',
      ...member('beta'),
      '    produces:',
      '      - path: "notes.md"',
      '      - path: "final-result.md"',
      '',
    ],
    setupLevel([
      '      type: chain',
      '      sequence:',
      '        - "alpha"',
      '        - "beta"',
      ...CHAIN_CONFIG,
    ]),
    GATE,
  ),
}

/** A roster written as a sequence at column zero, which YAML allows. */
const INDENTLESS_CASE: MembershipCase = {
  input: yaml(
    header(),
    [
      'agents:',
      '- name: "alpha"',
      '  type: agent',
      '  role: alpha persona.',
      '  tools: []',
      '  agent_file: "../../agents/alpha/alpha.md"',
      '  produces:',
      '    - path: "final-result.md"',
      '',
      '- name: "beta"',
      '  type: agent',
      '  role: beta persona.',
      '  tools: []',
      '  agent_file: "../../agents/beta/beta.md"',
      '',
    ],
    setupLevel(['      type: chain', '      sequence:', '        - "alpha"', ...CHAIN_CONFIG]),
    GATE,
  ),
  agentName: 'beta',
  expected: yaml(
    header(),
    [
      'agents:',
      '- name: "alpha"',
      '  type: agent',
      '  role: alpha persona.',
      '  tools: []',
      '  agent_file: "../../agents/alpha/alpha.md"',
      '  produces: []',
      '',
      '- name: "beta"',
      '  type: agent',
      '  role: beta persona.',
      '  tools: []',
      '  agent_file: "../../agents/beta/beta.md"',
      '  produces:',
      '    - path: "final-result.md"',
      '',
    ],
    setupLevel([
      '      type: chain',
      '      sequence:',
      '        - "alpha"',
      '        - "beta"',
      ...CHAIN_CONFIG,
    ]),
    GATE,
  ),
}

/** The chain case, in a file with no provenance marker at all. */
const HAND_AUTHORED_INPUT = CHAIN_CASE.input.replace(`${BUILDER_PROVENANCE}\n`, '')

test('a generated chain names the added member in its sequence and hands it the final result', () => {
  assert.equal(
    extendGeneratedStageMembership(CHAIN_CASE.input, CHAIN_CASE.agentName),
    CHAIN_CASE.expected,
  )
})

test('a generated discussion gains the participant and its coordinator stays the only owner', () => {
  assert.equal(
    extendGeneratedStageMembership(DISCUSSION_CASE.input, DISCUSSION_CASE.agentName),
    DISCUSSION_CASE.expected,
  )
})

test("naming a discussion's coordinator moves the result onto it, keeps its note, and leaves the participants alone", () => {
  assert.equal(
    extendGeneratedStageMembership(COORDINATOR_CASE.input, COORDINATOR_CASE.agentName),
    COORDINATOR_CASE.expected,
  )
})

test("a generated review drops a member's final-result declaration and keeps its other artifacts", () => {
  assert.equal(
    extendGeneratedStageMembership(REVIEW_CASE.input, REVIEW_CASE.agentName),
    REVIEW_CASE.expected,
  )
})

test('the older created_by_orchestrator marker still lets the result move onto the last member', () => {
  assert.equal(
    extendGeneratedStageMembership(LEGACY_PROVENANCE_CASE.input, LEGACY_PROVENANCE_CASE.agentName),
    LEGACY_PROVENANCE_CASE.expected,
  )
})

test('an indentless roster keeps its own indentation when the result moves', () => {
  assert.equal(
    extendGeneratedStageMembership(INDENTLESS_CASE.input, INDENTLESS_CASE.agentName),
    INDENTLESS_CASE.expected,
  )
})

test('a team.yaml without provenance comes back exactly as given', () => {
  assert.notEqual(HAND_AUTHORED_INPUT, CHAIN_CASE.input)
  assert.equal(extendGeneratedStageMembership(HAND_AUTHORED_INPUT, 'beta'), HAND_AUTHORED_INPUT)
})

test('applying the same membership edit twice changes nothing the second time', () => {
  const cases: Record<string, MembershipCase> = {
    chain: CHAIN_CASE,
    discussion: DISCUSSION_CASE,
    coordinator: COORDINATOR_CASE,
    review: REVIEW_CASE,
    legacyProvenance: LEGACY_PROVENANCE_CASE,
    indentless: INDENTLESS_CASE,
  }
  for (const [label, { input, agentName }] of Object.entries(cases)) {
    const once = extendGeneratedStageMembership(input, agentName)
    assert.equal(extendGeneratedStageMembership(once, agentName), once, label)
  }
})

// ---------------------------------------------------------------------------
// The public writers, against a real team folder.
// ---------------------------------------------------------------------------

function writePersona(repoRoot: string, name: string): void {
  const agentDir = path.join(repoRoot, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} persona.\n---\n\n# ${name}\n`,
  )
}

async function withTeam(
  teamYaml: string,
  personas: readonly string[],
  run: (repoRoot: string, teamYamlPath: string) => Promise<void>,
): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-ownership-'))
  try {
    for (const name of personas) writePersona(repoRoot, name)
    const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
    fs.mkdirSync(teamDir, { recursive: true })
    const teamYamlPath = path.join(teamDir, 'team.yaml')
    fs.writeFileSync(teamYamlPath, teamYaml)
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      [`${TEAM_ID}:`, '  type: team', '  description: A generated team.', `  team_path: ./teams/${TEAM_ID}`, ''].join('\n'),
    )
    await run(repoRoot, teamYamlPath)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

/** A roster entry exactly as the Team Builder add path renders it. */
function builderEntry(name: string): string[] {
  return [
    `  - name: "${name}"`,
    '    type: agent',
    '    role: >',
    `      ${name} persona.`,
    '    tools: []',
    `    agent_file: "../../agents/${name}/${name}.md"`,
    '    experience_enabled: true',
  ]
}

/** A generated chain of alpha and beta, beta owning the result. */
const PAIR_CHAIN_YAML = yaml(
  header(),
  ['agents:', ...member('alpha'), ...OWNS_NOTHING, '', ...member('beta'), ...OWNS_RESULT, ''],
  setupLevel([
    '      type: chain',
    '      sequence:',
    '        - "alpha"',
    '        - "beta"',
    ...CHAIN_CONFIG,
  ]),
  GATE,
)

test("the Agent page hands a generated chain's final result to the member it adds", async () => {
  await withTeam(PAIR_CHAIN_YAML, ['alpha', 'beta', 'gamma'], async (repoRoot, teamYamlPath) => {
    await addAgentToTeam({ repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        header(),
        [
          'agents:',
          ...member('alpha'),
          ...OWNS_NOTHING,
          '',
          ...member('beta'),
          ...OWNS_NOTHING,
          '',
          // The Agent page now renders the Team Builder's entry, quoted.
          ...builderEntry('gamma'),
          ...OWNS_RESULT,
        ],
        setupLevel([
          '      type: chain',
          '      sequence:',
          '        - "alpha"',
          '        - "beta"',
          '        - "gamma"',
          ...CHAIN_CONFIG,
        ]),
        GATE,
      ),
    )
  })
})

/** A generated discussion shell led by lead, with alpha as its participant. */
const DISCUSSION_SHELL_YAML = yaml(
  header(),
  ['agents: []', ''],
  setupLevel([
    '      type: discussion',
    '      coordinator: "lead"',
    '      participants:',
    '        - "alpha"',
    ...DISCUSSION_CONFIG,
  ]),
  GATE,
)

test('a discussion coordinator that joins after its participant ends as the only owner', async () => {
  await withTeam(DISCUSSION_SHELL_YAML, ['alpha', 'lead'], async (repoRoot, teamYamlPath) => {
    const stage = setupLevel([
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants:',
      '        - "alpha"',
      ...DISCUSSION_CONFIG,
    ])

    await addTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'alpha' })
    // The coordinator is not on the roster yet, so nobody declares the result.
    assert.equal(
      readText(teamYamlPath),
      yaml(header(), ['agents:', ...builderEntry('alpha'), ''], stage, GATE),
    )

    await addTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'lead' })
    // It owns the result and does not become its own participant.
    assert.equal(
      readText(teamYamlPath),
      yaml(
        header(),
        ['agents:', ...builderEntry('alpha'), '', ...builderEntry('lead'), ...OWNS_RESULT],
        stage,
        GATE,
      ),
    )
  })
})

test('a batch that adds both roles of a generated review declares the result on neither', async () => {
  const shell = yaml(header(), ['agents: []', ''], setupLevel(REVIEW_STAGE), GATE)
  await withTeam(shell, ['alpha', 'beta'], async (repoRoot, teamYamlPath) => {
    await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: digestTeamYaml(shell),
      agents: [{ name: 'alpha' }, { name: 'beta' }],
    })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        header(),
        ['agents:', ...builderEntry('alpha'), '', ...builderEntry('beta'), ''],
        setupLevel(REVIEW_STAGE),
        GATE,
      ),
    )
  })
})

test('removing the last of three chain members hands the result to the new last member', async () => {
  const seeded = yaml(
    header(),
    [
      'agents:',
      ...member('alpha'),
      ...OWNS_NOTHING,
      '',
      ...member('beta'),
      ...OWNS_NOTHING,
      '',
      ...member('gamma'),
      ...OWNS_RESULT,
      '',
    ],
    setupLevel([
      '      type: chain',
      '      sequence:',
      '        - "alpha"',
      '        - "beta"',
      '        - "gamma"',
      ...CHAIN_CONFIG,
    ]),
    GATE,
  )
  await withTeam(seeded, ['alpha', 'beta', 'gamma'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

    // beta's `produces: []` becomes the declaration; alpha's stays empty.
    assert.equal(
      readText(teamYamlPath),
      yaml(
        header(),
        ['agents:', ...member('alpha'), ...OWNS_NOTHING, '', ...member('beta'), ...OWNS_RESULT, ''],
        setupLevel([
          '      type: chain',
          '      sequence:',
          '        - "alpha"',
          '        - "beta"',
          ...CHAIN_CONFIG,
        ]),
        GATE,
      ),
    )
  })
})

test("removing a discussion participant leaves the coordinator's declaration byte for byte", async () => {
  const seeded = yaml(
    header(),
    ['agents:', ...member('lead'), ...OWNS_RESULT, '', ...member('alpha'), '', ...member('beta'), ''],
    setupLevel([
      '      type: discussion',
      '      coordinator: "lead"',
      '      participants:',
      '        - "alpha"',
      '        - "beta"',
      ...DISCUSSION_CONFIG,
    ]),
    GATE,
  )
  await withTeam(seeded, ['lead', 'alpha', 'beta'], async (repoRoot, teamYamlPath) => {
    await removeTeamBuilderAgent({ repoRoot, teamId: TEAM_ID, agentName: 'beta' })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        header(),
        ['agents:', ...member('lead'), ...OWNS_RESULT, '', ...member('alpha'), ''],
        setupLevel([
          '      type: discussion',
          '      coordinator: "lead"',
          '      participants:',
          '        - "alpha"',
          ...DISCUSSION_CONFIG,
        ]),
        GATE,
      ),
    )
  })
})

/** A generated chain of three, still being built, with gamma owning the result. */
const BUILDING_TRIO_YAML = yaml(
  header([BUILDER_PROVENANCE, '  building: true']),
  [
    'agents:',
    ...member('alpha'),
    ...OWNS_NOTHING,
    '',
    ...member('beta'),
    ...OWNS_NOTHING,
    '',
    ...member('gamma'),
    ...OWNS_RESULT,
    '',
  ],
  setupLevel([
    '      type: chain',
    '      sequence:',
    '        - "alpha"',
    '        - "beta"',
    '        - "gamma"',
    ...CHAIN_CONFIG,
  ]),
  GATE,
)

const ALPHA_LEADS: TeamShape = {
  kind: 'discussion',
  rationale: 'They argue it out.',
  depth: 'quick',
  coordinator: 'alpha',
  participants: ['beta', 'gamma'],
}

test('applying a discussion shape to a team being built hands the result to its coordinator', async () => {
  await withTeam(BUILDING_TRIO_YAML, ['alpha', 'beta', 'gamma'], async (repoRoot, teamYamlPath) => {
    await applyTeamBuilderShape({ repoRoot, teamId: TEAM_ID, shape: ALPHA_LEADS })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        header([BUILDER_PROVENANCE, '  building: true']),
        [
          'agents:',
          ...member('alpha'),
          ...OWNS_RESULT,
          '',
          ...member('beta'),
          ...OWNS_NOTHING,
          '',
          ...member('gamma'),
          ...OWNS_NOTHING,
          '',
        ],
        setupLevel([
          '      type: discussion',
          '      coordinator: "alpha"',
          '      participants:',
          '        - "beta"',
          '        - "gamma"',
          ...DISCUSSION_CONFIG,
        ]),
        // The levels block is replaced up to the next top-level key, so the
        // blank line that separated it from `gates:` goes with it.
        [
          'gates:',
          '  - from: setup',
          '    to: done',
          '    condition:',
          '      type: artifact_exists',
          '      artifact: "final-result.md"',
          '',
        ],
      ),
    )
  })
})

test('applying the same shape twice to a team being built writes identical bytes', async () => {
  await withTeam(BUILDING_TRIO_YAML, ['alpha', 'beta', 'gamma'], async (repoRoot, teamYamlPath) => {
    await applyTeamBuilderShape({ repoRoot, teamId: TEAM_ID, shape: ALPHA_LEADS })
    const afterFirst = readText(teamYamlPath)

    await applyTeamBuilderShape({ repoRoot, teamId: TEAM_ID, shape: ALPHA_LEADS })

    assert.equal(readText(teamYamlPath), afterFirst)
  })
})

const ALPHA_WRITES_BETA_CHECKS: TeamShape = {
  kind: 'review',
  rationale: 'One writes, one checks.',
  depth: 'quick',
  producer: 'alpha',
  reviewer: 'beta',
}

test('changing a saved chain into a review leaves no member declaring the result', async () => {
  await withTeam(PAIR_CHAIN_YAML, ['alpha', 'beta'], async (repoRoot, teamYamlPath) => {
    await changeSavedTeamShape({
      repoRoot,
      teamId: TEAM_ID,
      shape: ALPHA_WRITES_BETA_CHECKS,
      expectedRevision: digestTeamYaml(PAIR_CHAIN_YAML),
    })

    assert.equal(
      readText(teamYamlPath),
      yaml(
        header(),
        ['agents:', ...member('alpha'), ...OWNS_NOTHING, '', ...member('beta'), ...OWNS_NOTHING, ''],
        setupLevel(REVIEW_STAGE),
        GATE,
      ),
    )
  })
})

test('changing a saved team to the same shape twice writes identical bytes', async () => {
  // Reversing the chain moves the result from beta to alpha on the first change,
  // so the second finds alpha already the owner.
  const betaThenAlpha: TeamShape = {
    kind: 'chain',
    rationale: 'Beta drafts, alpha finishes.',
    depth: 'quick',
    order: ['beta', 'alpha'],
  }
  await withTeam(PAIR_CHAIN_YAML, ['alpha', 'beta'], async (repoRoot, teamYamlPath) => {
    await changeSavedTeamShape({
      repoRoot,
      teamId: TEAM_ID,
      shape: betaThenAlpha,
      expectedRevision: digestTeamYaml(PAIR_CHAIN_YAML),
    })
    const afterFirst = readText(teamYamlPath)

    await changeSavedTeamShape({
      repoRoot,
      teamId: TEAM_ID,
      shape: betaThenAlpha,
      expectedRevision: digestTeamYaml(afterFirst),
    })

    assert.equal(readText(teamYamlPath), afterFirst)
  })
})

test('re-applying a batch to a generated chain rewrites no byte and reports the revision already on disk', async () => {
  // alpha holds the result although beta is last, so the first write has an
  // ownership move to make and the retry has none.
  const seeded = yaml(
    header(),
    ['agents:', ...member('alpha'), ...OWNS_RESULT, '', ...member('beta'), ''],
    setupLevel([
      '      type: chain',
      '      sequence:',
      '        - "alpha"',
      '        - "beta"',
      ...CHAIN_CONFIG,
    ]),
    GATE,
  )
  await withTeam(seeded, ['alpha', 'beta', 'gamma'], async (repoRoot, teamYamlPath) => {
    await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: digestTeamYaml(seeded),
      agents: [{ name: 'gamma' }],
    })
    const afterFirst = readText(teamYamlPath)

    let intendedRevision: string | undefined
    await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: digestTeamYaml(afterFirst),
      agents: [{ name: 'gamma' }],
      onIntendedRevision: (revision) => {
        intendedRevision = revision
      },
    })

    assert.equal(readText(teamYamlPath), afterFirst)
    assert.equal(intendedRevision, digestTeamYaml(afterFirst))
  })
})
