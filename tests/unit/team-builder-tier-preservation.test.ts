/**
 * What a Team file already says about a member survives an unrelated edit.
 *
 * Retiring `tier` from authoring is about what new writes produce. It must not
 * reach back into files that already carry one — and two of the three writers
 * here re-render the whole `agents:` block from a parsed model, so anything the
 * model does not carry faithfully is rewritten as a side effect of an edit that
 * had nothing to do with it. Editing a Team's description, or adding one new
 * member, is not authorization to change what another member already declares.
 *
 * The batch writer is already covered elsewhere, and is the safe one: it
 * appends the new entries and leaves every other byte alone. These two are the
 * ones that re-render, and they are what this guards.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'

import {
  addTeamBuilderAgent,
  updateTeamBuilderTeam,
} from '../../domains/agent-generator/team-manager.js'

const TEAM_ID = 'contract-review-team'
const SEEDED = 'michigan-contract-lawyer'
const ADDED = 'scoping-lawyer'

/**
 * A grade this codebase's own normalizer does not recognise.
 *
 * `normalizeTier` answers `strategic` for anything outside its list, so a value
 * a person actually wrote is replaced by one nobody chose. Using a recognised
 * value here would let that pass unnoticed.
 */
const LEGACY_TIER = 'tactical'

function persona(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} description.\n---\n\n# ${name}\n`
}

/** A comment and a key the roster model does not carry, inside the member. */
const MEMBER_COMMENT = '    # Kept on the roster for the Michigan filings.'
const UNKNOWN_FIELD = '    escalation_contact: contracts@example.test'

const TEAM_YAML = [
  '# Contract review board. Do not renumber the levels.',
  'team:',
  `  name: "${TEAM_ID}"`,
  '  description: Reviews contracts.',
  '  version: 0.1.0',
  'agents:',
  `  - name: ${SEEDED}`,
  '    type: agent',
  MEMBER_COMMENT,
  '    role: >',
  '      Reviews Michigan contracts.',
  `    tier: ${LEGACY_TIER}`,
  UNKNOWN_FIELD,
  '    tools: []',
  `    agent_file: ../../agents/${SEEDED}/${SEEDED}.md`,
  'levels:',
  '  - id: review',
  '    name: Review',
  '    order: 0',
  '    agents:',
  `      - ${SEEDED}`,
  '    stage:',
  '      type: pipeline',
  '      config:',
  '        output:',
  '          format: review.md',
  '          user_review: false',
  '',
].join('\n')

function makeRepo(teamYaml: string = TEAM_YAML): string {
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'team-tier-preserve-')),
  )
  for (const name of [SEEDED, ADDED]) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, `${name}.md`), persona(name))
  }
  const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
  fs.mkdirSync(teamDir, { recursive: true })
  fs.writeFileSync(path.join(teamDir, 'team.yaml'), teamYaml)
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    [
      `${TEAM_ID}:`,
      '  type: team',
      '  description: Reviews contracts.',
      `  team_path: ./teams/${TEAM_ID}`,
      '  tags: []',
      '',
    ].join('\n'),
  )
  return repoRoot
}

/**
 * One member's own lines, from its `- name:` to the next member or block.
 *
 * Read per member rather than file-wide: a count of `tier:` lines would be
 * satisfied by the right number attached to the wrong member.
 */
function memberBlock(yaml: string, name: string): string[] {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^  - name: "?${name}"?\\s*$`).test(line))
  if (start < 0) return []
  const block = [lines[start] as string]
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,2}\S/.test(line) && !/^\s+/.test(line.slice(0, 3))) break
    if (/^  - /.test(line)) break
    block.push(line)
  }
  return block
}

/** The grade that member declares, or nothing where it declares none. */
function memberTier(yaml: string, name: string): string | undefined {
  for (const line of memberBlock(yaml, name)) {
    const match = /^\s*tier:\s*(\S+)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/** The entry stage's own execution order, as the file declares it. */
function entryStageSequence(parsed: YamlObject): string[] {
  const levels = Array.isArray(parsed.levels) ? parsed.levels : []
  const level = levels[0]
  if (typeof level !== 'object' || level === null || Array.isArray(level)) return []
  const stage = (level as { stage?: YamlValue }).stage
  if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) return []
  const sequence = (stage as { sequence?: YamlValue }).sequence
  return Array.isArray(sequence) ? sequence.map((entry) => String(entry)) : []
}

/** Which roster members declare they produce this artifact. */
function rosterOwnersOf(parsed: YamlObject, artifact: string): string[] {
  const agents = Array.isArray(parsed.agents) ? parsed.agents : []
  const owners: string[] = []
  for (const agent of agents) {
    if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) continue
    const produces = (agent as { produces?: YamlValue }).produces
    if (!Array.isArray(produces)) continue
    const owns = produces.some((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
      return String((entry as { path?: YamlValue }).path) === artifact
    })
    if (owns) owners.push(String((agent as { name?: YamlValue }).name))
  }
  return owners
}

function readTeamYaml(repoRoot: string): string {
  return fs.readFileSync(path.join(repoRoot, 'teams', TEAM_ID, 'team.yaml'), 'utf8')
}

test("editing a Team's metadata leaves an existing member's tier alone", async () => {
  const repoRoot = makeRepo()
  try {
    const detail = await updateTeamBuilderTeam(repoRoot, TEAM_ID, {
      id: TEAM_ID,
      description: 'Reviews contracts, carefully.',
    } as Parameters<typeof updateTeamBuilderTeam>[2])

    // The edit landed, read from what the writer returned rather than from a
    // guess at how it formats a description — the renderer folds it.
    assert.equal(detail.description, 'Reviews contracts, carefully.')
    // And the member said `tactical`. Nothing about a description change is
    // permission to say otherwise.
    const after = readTeamYaml(repoRoot)
    assert.equal(
      memberTier(after, SEEDED),
      LEGACY_TIER,
      `the metadata edit rewrote that member's own tier:\n${after}`,
    )
    // And what the writer reports back says the same thing. A summary that
    // normalized the grade would describe the Team differently from its file.
    assert.equal(
      detail.agents.find((agent) => agent.name === SEEDED)?.tier,
      LEGACY_TIER,
      JSON.stringify(detail.agents),
    )
    // And the rest of what that member declares. Keeping the grade while
    // dropping a comment or a key the roster model does not carry would be the
    // same defect wearing a different name.
    const block = memberBlock(after, SEEDED).join('\n')
    assert.match(block, /Kept on the roster for the Michigan filings\./, block)
    assert.match(block, /escalation_contact: contracts@example\.test/, block)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('adding one member leaves the existing member’s tier alone and gives the new one none', async () => {
  const repoRoot = makeRepo()
  try {
    const detail = await addTeamBuilderAgent({
      repoRoot,
      teamId: TEAM_ID,
      agentName: ADDED,
      role: 'Scope reviewer',
    })

    // Roster identity from what the writer returned: the file quotes names, and
    // asserting on its quoting would be testing the renderer rather than this.
    assert.deepEqual(
      detail.agents.map((agent) => agent.name).sort(),
      [SEEDED, ADDED].sort(),
    )
    // One grade in the file, and it is the one that was already there: the
    // existing member keeps its own, and the new member is given none.
    const after = readTeamYaml(repoRoot)
    // The member that had one keeps its own, with everything else it declares.
    assert.equal(
      memberTier(after, SEEDED),
      LEGACY_TIER,
      `the single add rewrote the existing member's tier:\n${after}`,
    )
    const block = memberBlock(after, SEEDED).join('\n')
    assert.match(block, /Kept on the roster for the Michigan filings\./, block)
    assert.match(block, /escalation_contact: contracts@example\.test/, block)
    // And the member this write created is given none.
    assert.equal(
      memberTier(after, ADDED),
      undefined,
      `a new member was given a grade nobody chose:\n${after}`,
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

/*
 * The refusal for a request that *names* a tier is deliberately not here.
 *
 * These are typed domain functions; once the field is gone from their argument
 * types, a case for it could only be written by forcing an extra property past
 * the type system, and satisfying it would mean adding business-layer
 * validation for input the type already excludes. A user's request arrives as
 * unknown JSON at an HTTP schema, which is where that refusal belongs and where
 * `resource-architect-tier-request-boundary.test.ts` and the team-builder route
 * cases assert it, with their typed response and no file written.
 */

/**
 * The same guarantee on a Team whose levels are a generated setup chain.
 *
 * The two cases above use a Team with its own levels, and they cannot reach the
 * branch that rebuilds the roster for a chain. That branch is the common shape
 * for a generated Team, and rebuilding is exactly what loses a member's
 * comments and unmodelled keys — so the chain needs its own proof rather than
 * an exception.
 *
 * What the chain genuinely needs is narrower than a rebuild: the final member
 * owns the generated output artifact, and the entry stage's sequence names the
 * members. The batch writer already does both surgically, and this asks the
 * single add to reach the same end.
 */
const CHAIN_TEAM_YAML = [
  '# Generated board. Do not renumber the sequence.',
  'team:',
  `  name: "${TEAM_ID}"`,
  '  description: Reviews contracts.',
  '  version: 0.1.0',
  // What every team this app creates records. Ownership of the generated
  // artifact moves only inside a file the builder authored, so a fixture
  // standing for a generated board has to say it is one.
  '  created_by: "team-builder"',
  'workflow:',
  '  output_contract:',
  '    completion_artifact: final-result.md',
  'agents:',
  `  - name: ${SEEDED}`,
  '    type: agent',
  MEMBER_COMMENT,
  '    role: >',
  '      Reviews Michigan contracts.',
  `    tier: ${LEGACY_TIER}`,
  UNKNOWN_FIELD,
  '    tools: []',
  `    agent_file: ../../agents/${SEEDED}/${SEEDED}.md`,
  '    produces:',
  '      - path: final-result.md',
  'levels:',
  '  - id: setup',
  '    name: Setup',
  '    order: 0',
  '    agents:',
  `      - ${SEEDED}`,
  '    stage:',
  '      type: chain',
  // The shape the writer supports, matching the batch fixture: the sequence is
  // the stage's own key rather than a config entry.
  '      sequence:',
  `        - "${SEEDED}"`,
  '      config:',
  '        handoff_format: markdown',
  '',
].join('\n')

test('adding one member to a generated setup chain keeps the old entry whole', async () => {
  const repoRoot = makeRepo(CHAIN_TEAM_YAML)
  try {
    await addTeamBuilderAgent({
      repoRoot,
      teamId: TEAM_ID,
      agentName: ADDED,
      role: 'Scope reviewer',
    })

    const after = readTeamYaml(repoRoot)
    const block = memberBlock(after, SEEDED).join('\n')
    // Everything the existing member declared, including what no model carries.
    assert.equal(memberTier(after, SEEDED), LEGACY_TIER, after)
    assert.match(block, /Kept on the roster for the Michigan filings\./, after)
    assert.match(block, /escalation_contact: contracts@example\.test/, after)
    // The new member is given no grade.
    assert.equal(memberTier(after, ADDED), undefined, after)
    // Parsed, not matched: a sequence rebuilt to contain only the added member
    // would satisfy a regex looking for that name while silently dropping the
    // original from execution.
    const parsed = parseYaml(after)
    assert.deepEqual(
      entryStageSequence(parsed),
      [SEEDED, ADDED],
      `the chain's execution sequence changed:\n${after}`,
    )
    // And exactly one member owns the generated output — the newest.
    assert.deepEqual(
      rosterOwnersOf(parsed, 'final-result.md'),
      [ADDED],
      `the generated output is not owned once, by the last member:\n${after}`,
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

/**
 * Adding a library Agent does not schedule it into an existing discussion.
 *
 * The surgical roster insertion applies to every topology, but the levels are a
 * different question. A setup chain's sequence has always been extended by this
 * path; a discussion's participants have not, and adding a member to a roster
 * is not a decision to put them in a debate.
 */
const DISCUSSION_TEAM_YAML = [
  'team:',
  `  name: "${TEAM_ID}"`,
  '  description: Reviews contracts.',
  '  version: 0.1.0',
  'agents:',
  `  - name: ${SEEDED}`,
  '    type: agent',
  MEMBER_COMMENT,
  '    role: >',
  '      Reviews Michigan contracts.',
  `    tier: ${LEGACY_TIER}`,
  UNKNOWN_FIELD,
  '    tools: []',
  `    agent_file: ../../agents/${SEEDED}/${SEEDED}.md`,
  'levels:',
  '  - id: debate',
  '    name: Debate',
  '    order: 0',
  '    stage:',
  '      type: discussion',
  '      participants:',
  `        - "${SEEDED}"`,
  '      config:',
  '        rounds: 2',
  '',
].join('\n')

test('adding one member leaves an existing discussion’s participants alone', async () => {
  const repoRoot = makeRepo(DISCUSSION_TEAM_YAML)
  try {
    await addTeamBuilderAgent({
      repoRoot,
      teamId: TEAM_ID,
      agentName: ADDED,
      role: 'Scope reviewer',
    })

    const after = readTeamYaml(repoRoot)
    const parsed = parseYaml(after)
    const levels = Array.isArray(parsed.levels) ? parsed.levels : []
    const level = levels[0] as { stage?: { participants?: YamlValue } } | undefined
    const participants = level?.stage?.participants
    assert.ok(Array.isArray(participants), after)
    assert.deepEqual(
      participants.map((entry) => String(entry)),
      [SEEDED],
      `the add scheduled a new member into an existing discussion:\n${after}`,
    )
    // The roster still gained the member, surgically.
    assert.match(after, new RegExp(`name: "?${ADDED}"?`), after)
    assert.equal(memberTier(after, ADDED), undefined, after)
    const block = memberBlock(after, SEEDED).join('\n')
    assert.match(block, /escalation_contact: contracts@example\.test/, after)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})
