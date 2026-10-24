/**
 * Refusals `removeTeamBuilderAgent` builds from the places in `team.yaml` that
 * name a member.
 *
 * Removal is refused while a single role names the member: a stage
 * coordinator, producer or reviewer, the workspace routing agent, a gate
 * transform agent or agent-run validator, or another member's failure
 * fallback. Stage membership lists are pruned instead. Other suites match one
 * label at a time with regexes, so these tests compare whole messages: several
 * labels together, the label defaults for missing ids and types, and the
 * refusal for a membership the text edit cannot clear. They also pin that a
 * member's fallback naming itself does not block its own removal.
 *
 * Each test writes a team into a temporary repository and calls
 * `removeTeamBuilderAgent`.
 */

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { removeTeamBuilderAgent } from '../../domains/agent-generator/team-manager.js'
import type { TeamBuilderDetail } from '../../contracts/agent-generator.js'

const TEAM_ID = 'reference-team'

/** Joins fixture lines into the exact text of a file. */
function text(...lines: string[]): string {
  return lines.join('\n')
}

/** A repository holding one registered team and the named library personas. */
function makeRepo(
  t: TestContext,
  teamYaml: string,
  personas: readonly string[],
): { repoRoot: string; teamYamlPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-yaml-references-'))
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  for (const name of personas) {
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
    text(`${TEAM_ID}:`, '  type: team', '  description: Reference fixture.', `  team_path: ./teams/${TEAM_ID}`, ''),
  )
  return { repoRoot, teamYamlPath }
}

/** One roster entry pointing at its library persona, plus any extra lines. */
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

/**
 * Removes `agentName` and reports what happened: the refusal message, or the
 * team the removal leaves. A refusal where success was expected, or the
 * reverse, then fails an assertion instead of escaping the test.
 */
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

test('a member named in several roles is refused once, listing stage roles, the routing agent, gate roles, then other members\' fallbacks, and nothing is written', async (t) => {
  // `writer` holds five single roles. It is also in the chain sequence, which
  // removal would prune, and it is the validator of an artifact_exists
  // condition, which runs no agent. Neither of those two is named.
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: Reference fixture.',
    'workspace:',
    '  path: ../../workspace',
    '  routing_agent: "writer"',
    'agents:',
    ...member('lead', ['    produces:', '      - path: "final-result.md"']),
    ...member('writer'),
    ...member('editor', ['    on_failure:', '      policy: fallback', '      fallback_agent: "writer"']),
    'levels:',
    '  - id: draft',
    '    name: Draft',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      sequence:',
    '        - "lead"',
    '        - "writer"',
    '  - id: check',
    '    name: Check',
    '    order: 1',
    '    stage:',
    '      type: review',
    '      producer: "writer"',
    '      reviewer: "editor"',
    'gates:',
    '  - from: draft',
    '    to: check',
    '    condition:',
    '      type: validation',
    '      validator: "writer"',
    '      strictness: hard',
    '    transform:',
    '      type: agent',
    '      agent: "writer"',
    '  - from: check',
    '    to: done',
    '    condition:',
    '      type: artifact_exists',
    '      artifact: "final-result.md"',
    '      validator: "writer"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['lead', 'writer', 'editor'])

  const { refusal } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(
    refusal,
    "Cannot remove 'writer' from team 'reference-team': it is the review producer of level 'check', " +
      "the workspace routing_agent, the gate transform agent of the gate from 'draft' to 'check', " +
      "the validation validator of the gate from 'draft' to 'check' and the on_failure.fallback_agent " +
      "of agent 'editor'. Name a different agent for each of those roles in the team configuration first.",
  )
  assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
})

test('a membership list under a quoted key is pruned, and the key keeps its quotes', async (t) => {
  // The parser reads the quoted `"participants":` key, so the text edit that
  // prunes membership lists reads it too. (It once matched only bare keys, and
  // this fixture was the one way to reach the "could not be cleared" refusal,
  // which is now a defensive check no known spelling reaches.)
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: Reference fixture.',
    'agents:',
    ...member('lead', ['    produces:', '      - path: "final-result.md"']),
    ...member('writer'),
    ...member('editor'),
    'levels:',
    '  - id: setup',
    '    name: Setup',
    '    order: 0',
    '    stage:',
    '      type: discussion',
    '      coordinator: "lead"',
    '      "participants":',
    '        - "writer"',
    '        - "editor"',
    'gates:',
    '  - from: setup',
    '    to: done',
    '    condition:',
    '      type: artifact_exists',
    '      artifact: "final-result.md"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['lead', 'writer', 'editor'])

  const { refusal } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(refusal, undefined)
  assert.equal(
    fs.readFileSync(teamYamlPath, 'utf8'),
    text(
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: Reference fixture.',
      'agents:',
      ...member('lead', ['    produces:', '      - path: "final-result.md"']),
      ...member('editor'),
      'levels:',
      '  - id: setup',
      '    name: Setup',
      '    order: 0',
      '    stage:',
      '      type: discussion',
      '      coordinator: "lead"',
      '      "participants":',
      '        - "editor"',
      'gates:',
      '  - from: setup',
      '    to: done',
      '    condition:',
      '      type: artifact_exists',
      '      artifact: "final-result.md"',
      '',
    ),
  )
})

test('a member whose own failure fallback names itself can be removed', async (t) => {
  // A fallback that names its own agent is a configuration error, so the team
  // starts unhealthy. Only another member's fallback blocks a removal, so
  // removing this member clears the error.
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: Reference fixture.',
    'agents:',
    ...member('lead', ['    produces:', '      - path: "final-result.md"']),
    ...member('writer', ['    on_failure:', '      policy: fallback', '      fallback_agent: "writer"']),
    ...member('editor'),
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
    '  - from: draft',
    '    to: done',
    '    condition:',
    '      type: artifact_exists',
    '      artifact: "final-result.md"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['lead', 'writer', 'editor'])

  const { refusal, detail } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(refusal, undefined)
  assert.ok(detail)
  assert.deepEqual(detail.agents.map((agent) => agent.name), ['lead', 'editor'])
  assert.deepEqual(detail.health.errors, [])
  assert.doesNotMatch(fs.readFileSync(teamYamlPath, 'utf8'), /writer/)
})

test("a level with no id is named by position, a stage with no type as a discussion, and a gate with no ends as from '' to ''", async (t) => {
  const teamYaml = text(
    'team:',
    `  name: "${TEAM_ID}"`,
    '  description: Reference fixture.',
    'agents:',
    ...member('writer'),
    ...member('editor'),
    'levels:',
    '  - name: Setup',
    '    order: 0',
    '    stage:',
    '      coordinator: "writer"',
    '      participants:',
    '        - "editor"',
    'gates:',
    '  - condition:',
    '      type: all_tasks_terminal',
    '    transform:',
    '      type: agent',
    '      agent: "writer"',
    '',
  )
  const { repoRoot, teamYamlPath } = makeRepo(t, teamYaml, ['writer', 'editor'])

  const { refusal } = await attemptRemoval(repoRoot, 'writer')
  assert.equal(
    refusal,
    "Cannot remove 'writer' from team 'reference-team': it is the discussion coordinator of level 'level-0' " +
      "and the gate transform agent of the gate from '' to ''. Name a different agent for each of those roles in the " +
      'team configuration first.',
  )
  assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), teamYaml)
})
