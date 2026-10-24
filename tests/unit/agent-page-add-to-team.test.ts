/**
 * The Agent page's "add to team" (`addAgentToTeam`, reached through
 * POST /create/agents/add-to-team), against real team folders.
 *
 * The first group pins what the page writes today and must keep writing: the
 * "Library agent." role fallback, `experience_enabled: true`, one final
 * newline, and an `agent_file` that reads back as the real relative path. The
 * rest say what the page writes once it renders the Team Builder's roster
 * entry and appends it the way the Team Builder does: member names and paths
 * that read back as written, one `agents` key, and a refusal for a roster it
 * cannot extend.
 */

import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { addAgentToTeam, listAgentTeamUsage } from '../../domains/agent-generator/team-usage.js'
import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'
import { parseTeamConfig } from '../../parsers/team-config.js'

const TEAM_ID = 'agent-page-team'

/** Joins fixture lines into the exact text of a file. */
function text(...parts: ReadonlyArray<string | readonly string[]>): string {
  return parts.flat().join('\n')
}

const TEAM = ['team:', `  name: "${TEAM_ID}"`, '  description: A hand-authored team.', '  version: "0.1.0"', '']

/** One chain level whose sequence names `member`. */
function levels(member: string): string[] {
  return [
    'levels:',
    '  - id: main',
    '    name: Main',
    '    order: 0',
    '    stage:',
    '      type: chain',
    '      sequence:',
    `        - "${member}"`,
  ]
}

const ALPHA = [
  '  - name: "alpha"',
  '    type: agent',
  '    role: Alpha.',
  '    tools: []',
  '    agent_file: "../../agents/alpha/alpha.md"',
]

interface Layout {
  repoRoot: string
  teamDir: string
  teamYamlPath: string
}

/**
 * A repository with the given personas and one registered team.
 *
 * `repoDir` names the repository's own directory. `teamOutside` puts the team
 * folder beside the repository instead of under `teams/`, so the relative
 * path from the team to a persona passes through the repository's name.
 */
function makeRepo(
  t: TestContext,
  params: {
    teamYaml: string
    personas: readonly string[]
    repoDir?: string
    teamOutside?: boolean
  },
): Layout {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-page-add-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const repoRoot = path.join(base, params.repoDir ?? 'repo')
  for (const name of params.personas) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} persona.\n---\n\n# ${name}\n`,
    )
  }
  const teamDir = params.teamOutside
    ? path.join(base, 'outside', TEAM_ID)
    : path.join(repoRoot, 'teams', TEAM_ID)
  fs.mkdirSync(teamDir, { recursive: true })
  const teamYamlPath = path.join(teamDir, 'team.yaml')
  fs.writeFileSync(teamYamlPath, params.teamYaml)
  const teamPath = params.teamOutside ? `../outside/${TEAM_ID}` : `./teams/${TEAM_ID}`
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    text(`${TEAM_ID}:`, '  type: team', '  description: Agent page fixture.', `  team_path: "${teamPath}"`, ''),
  )
  return { repoRoot, teamDir, teamYamlPath }
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

function isYamlObject(value: YamlValue | undefined): value is YamlObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The roster entries the parser reads from the saved file. */
function rosterEntries(teamYamlPath: string): YamlObject[] {
  const agents = parseYaml(readText(teamYamlPath)).agents
  assert.ok(Array.isArray(agents), `agents is not a list:\n${readText(teamYamlPath)}`)
  return agents.filter(isYamlObject)
}

/** Every roster entry's `name`, whatever type the parser gave it. */
function rosterNames(teamYamlPath: string): Array<YamlValue | undefined> {
  return rosterEntries(teamYamlPath).map((entry) => entry.name)
}

/** The one roster entry whose `agent_file` is `agentFile`. */
function entryWithAgentFile(teamYamlPath: string, agentFile: string): YamlObject {
  const entry = rosterEntries(teamYamlPath).find((candidate) => candidate.agent_file === agentFile)
  assert.ok(entry, `no roster entry has agent_file ${agentFile}:\n${readText(teamYamlPath)}`)
  return entry
}

/** The path from the team folder to a persona, as a roster writes it. */
function relativeAgentFile(layout: Layout, name: string): string {
  return path
    .relative(layout.teamDir, path.join(layout.repoRoot, 'agents', name, `${name}.md`))
    .split(path.sep)
    .join('/')
}

/** How many top-level `agents` keys the text declares. */
function topLevelAgentsKeys(yamlText: string): number {
  return yamlText.split('\n').filter((line) => /^agents:/u.test(line)).length
}

// ---------------------------------------------------------------------------
// What the Agent page writes today and keeps writing.
// ---------------------------------------------------------------------------

for (const { label, role } of [{ label: 'an empty', role: '' }, { label: 'a whitespace', role: '   ' }]) {
  test(`${label} role still writes "Library agent."`, async (t) => {
    const layout = makeRepo(t, {
      teamYaml: text(TEAM, 'agents:', ALPHA, '', levels('alpha'), ''),
      personas: ['alpha', 'gamma'],
    })

    await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma', role })

    const entry = entryWithAgentFile(layout.teamYamlPath, relativeAgentFile(layout, 'gamma'))
    assert.equal(entry.role, 'Library agent.', readText(layout.teamYamlPath))
  })
}

test('the member the Agent page adds still has experience_enabled: true', async (t) => {
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents:', ALPHA, '', levels('alpha'), ''),
    personas: ['alpha', 'gamma'],
  })

  await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

  const entry = entryWithAgentFile(layout.teamYamlPath, relativeAgentFile(layout, 'gamma'))
  assert.equal(entry.experience_enabled, true, readText(layout.teamYamlPath))
})

test('a team with no agents key that ends in one newline gains the member and still ends in exactly one', async (t) => {
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, levels('gamma'), ''),
    personas: ['gamma'],
  })

  await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

  const saved = readText(layout.teamYamlPath)
  assert.deepEqual(rosterNames(layout.teamYamlPath), ['gamma'], saved)
  assert.ok(saved.endsWith('\n'), JSON.stringify(saved.slice(-40)))
  assert.ok(!saved.endsWith('\n\n'), JSON.stringify(saved.slice(-40)))
})

// A bare header parses as null, like "agents: null", but it is an empty
// roster the page extends, not a scalar it refuses.
for (const { label, teamYaml } of [
  { label: 'before the levels', teamYaml: text(TEAM, 'agents:', '', levels('gamma'), '') },
  { label: 'as the last key', teamYaml: text(TEAM, levels('gamma'), '', 'agents:', '') },
]) {
  test(`a bare "agents:" header with no entries ${label} gains the member under that one key`, async (t) => {
    const layout = makeRepo(t, { teamYaml, personas: ['gamma'] })

    await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

    const saved = readText(layout.teamYamlPath)
    assert.deepEqual(rosterNames(layout.teamYamlPath), ['gamma'], saved)
    assert.equal(topLevelAgentsKeys(saved), 1, saved)
    assert.deepEqual(parseTeamConfig(layout.teamYamlPath).errors, [], saved)
  })
}

for (const { label, repoDir } of [
  { label: 'a backslash', repoDir: 'repo\\x' },
  { label: 'a double quote', repoDir: 'repo"x' },
]) {
  test(`an agent_file under a repository path holding ${label} reads back as the real relative path`, async (t) => {
    const layout = makeRepo(t, {
      teamYaml: text(TEAM, 'agents:', ALPHA, '', levels('alpha'), ''),
      personas: ['alpha', 'gamma'],
      repoDir,
      teamOutside: true,
    })
    const expected = relativeAgentFile(layout, 'gamma')
    assert.ok(expected.includes(repoDir), expected)

    await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

    const gamma = rosterEntries(layout.teamYamlPath).find((entry) => entry.name === 'gamma')
    assert.ok(gamma, readText(layout.teamYamlPath))
    assert.equal(gamma.agent_file, expected, readText(layout.teamYamlPath))
  })
}

// ---------------------------------------------------------------------------
// Rendering the Team Builder's entry and appending it the Team Builder's way.
// ---------------------------------------------------------------------------

for (const name of ['null', 'false', '007']) {
  test(`a member named ${name} stays the string "${name}" on the roster, and parseTeamConfig reports no errors`, async (t) => {
    const layout = makeRepo(t, {
      teamYaml: text(TEAM, 'agents:', ALPHA, '', levels('alpha'), ''),
      personas: ['alpha', name],
    })

    await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: name })

    const entry = entryWithAgentFile(layout.teamYamlPath, relativeAgentFile(layout, name))
    assert.equal(entry.name, name, readText(layout.teamYamlPath))
    assert.deepEqual(parseTeamConfig(layout.teamYamlPath).errors, [], readText(layout.teamYamlPath))
  })
}

for (const header of ['agents: []', 'agents: [] # none yet']) {
  test(`"${header}" gains the member under its one agents key`, async (t) => {
    const layout = makeRepo(t, {
      teamYaml: text(TEAM, header, '', levels('gamma'), ''),
      personas: ['gamma'],
    })

    await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

    const saved = readText(layout.teamYamlPath)
    assert.deepEqual(rosterNames(layout.teamYamlPath), ['gamma'], saved)
    assert.equal(topLevelAgentsKeys(saved), 1, saved)
    assert.deepEqual(parseTeamConfig(layout.teamYamlPath).errors, [], saved)
  })
}

test('an empty "agents: # none yet" header gains the member under its one agents key', async (t) => {
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents: # none yet', '', levels('gamma'), ''),
    personas: ['gamma'],
  })

  await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

  const saved = readText(layout.teamYamlPath)
  assert.deepEqual(rosterNames(layout.teamYamlPath), ['gamma'], saved)
  assert.equal(topLevelAgentsKeys(saved), 1, saved)
  assert.deepEqual(parseTeamConfig(layout.teamYamlPath).errors, [], saved)
})

test('"agents: # the crew" over a block roster keeps alpha and gains the member in the same block', async (t) => {
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents: # the crew', ALPHA, '', levels('alpha'), ''),
    personas: ['alpha', 'gamma'],
  })

  await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

  const saved = readText(layout.teamYamlPath)
  assert.deepEqual(rosterNames(layout.teamYamlPath), ['alpha', 'gamma'], saved)
  assert.equal(topLevelAgentsKeys(saved), 1, saved)
  assert.deepEqual(parseTeamConfig(layout.teamYamlPath).errors, [], saved)
})

test('an agent_file whose relative path holds " #" keeps its full path, and the team usage listing finds the member', async (t) => {
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents:', [
      '  - name: "alpha"',
      '    type: agent',
      '    role: Alpha.',
      '    tools: []',
      '    agent_file: "../../repo #1/agents/alpha/alpha.md"',
    ], '', levels('alpha'), ''),
    personas: ['alpha', 'gamma'],
    repoDir: 'repo #1',
    teamOutside: true,
  })
  const expected = relativeAgentFile(layout, 'gamma')
  assert.ok(expected.includes(' #'), expected)

  await addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' })

  const gamma = rosterEntries(layout.teamYamlPath).find((entry) => entry.name === 'gamma')
  assert.ok(gamma, readText(layout.teamYamlPath))
  assert.equal(gamma.agent_file, expected, readText(layout.teamYamlPath))
  assert.deepEqual(
    listAgentTeamUsage(layout.repoRoot).get('gamma'),
    [{ teamId: TEAM_ID, teamName: TEAM_ID }],
  )
})

// ---------------------------------------------------------------------------
// A roster the Agent page cannot extend is refused, and the file is untouched.
// ---------------------------------------------------------------------------

for (const header of ['agents: null', 'agents: ~', 'agents: the whole crew']) {
  test(`"${header}" is refused as a roster that is not a list, and team.yaml is unchanged`, async (t) => {
    const layout = makeRepo(t, {
      teamYaml: text(TEAM, header, '', levels('gamma'), ''),
      personas: ['gamma'],
    })
    const before = readText(layout.teamYamlPath)

    await assert.rejects(
      addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' }),
      new RegExp(`Team '${TEAM_ID}' declares a roster that is not a list, so it cannot take new members`, 'u'),
    )
    assert.equal(readText(layout.teamYamlPath), before)
  })
}

test('a roster written as a flow list with members is refused, and team.yaml is unchanged', async (t) => {
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents: ["alpha"]', '', levels('alpha'), ''),
    personas: ['alpha', 'gamma'],
  })
  const before = readText(layout.teamYamlPath)

  await assert.rejects(
    addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' }),
    new RegExp(`Team '${TEAM_ID}' declares its roster as a flow list with members, so it cannot take new members`, 'u'),
  )
  assert.equal(readText(layout.teamYamlPath), before)
})

for (const header of ['agents :', '"agents":']) {
  test(`a roster under "${header}", which parses as agents but is not written "agents:", is refused, and team.yaml is unchanged`, async (t) => {
    const layout = makeRepo(t, {
      teamYaml: text(TEAM, header, ALPHA, '', levels('alpha'), ''),
      personas: ['alpha', 'gamma'],
    })
    const before = readText(layout.teamYamlPath)
    assert.deepEqual(rosterNames(layout.teamYamlPath), ['alpha'], before)

    await assert.rejects(
      addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' }),
      new RegExp(`Team '${TEAM_ID}' declares its roster under a key not written "agents:", so it cannot take new members`, 'u'),
    )
    assert.equal(readText(layout.teamYamlPath), before)
  })
}

test('a later key that decodes to agents hides the roster the page would extend, so the add is refused, and team.yaml is unchanged', async (t) => {
  // "agent\u0073" decodes to agents, so the parser reads this later key and
  // not the canonical one above it, where an appended entry would land.
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents:', ALPHA, '', levels('beta'), '', String.raw`"agent\u0073":`, [
      '  - name: "beta"',
      '    type: agent',
      '    role: Beta.',
      '    tools: []',
      '    agent_file: "../../agents/beta/beta.md"',
    ], ''),
    personas: ['alpha', 'beta', 'gamma'],
  })
  const before = readText(layout.teamYamlPath)
  assert.deepEqual(rosterNames(layout.teamYamlPath), ['beta'], before)

  await assert.rejects(
    addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' }),
    new RegExp(`Team '${TEAM_ID}' has a roster this page cannot extend without hiding or losing a member, so it cannot take new members`, 'u'),
  )
  assert.equal(readText(layout.teamYamlPath), before)
})

test('an indentless roster, which an appended entry would cut off from its levels, is refused, and team.yaml is unchanged', async (t) => {
  // Entries at column zero under "agents:" parse as the roster, but an entry
  // appended in the usual two-space form lands above them, and the file then
  // reads without alpha and without its levels.
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents:', ALPHA.map((line) => line.slice(2)), '', levels('alpha'), ''),
    personas: ['alpha', 'gamma'],
  })
  const before = readText(layout.teamYamlPath)
  assert.deepEqual(rosterNames(layout.teamYamlPath), ['alpha'], before)
  assert.ok(Array.isArray(parseYaml(before).levels), before)

  await assert.rejects(
    addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' }),
    new RegExp(`Team '${TEAM_ID}' has a roster this page cannot extend without hiding or losing a member, so it cannot take new members`, 'u'),
  )
  assert.equal(readText(layout.teamYamlPath), before)
})

test('an indentless roster after the levels, which an appended entry would cut off from alpha, is refused, and team.yaml is unchanged', async (t) => {
  // With the levels first, the appended entry costs alpha but not the levels,
  // and parseTeamConfig accepts the file as written.
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, levels('alpha'), '', 'agents:', ALPHA.map((line) => line.slice(2)), ''),
    personas: ['alpha', 'gamma'],
  })
  const before = readText(layout.teamYamlPath)
  assert.deepEqual(rosterNames(layout.teamYamlPath), ['alpha'], before)
  assert.deepEqual(parseTeamConfig(layout.teamYamlPath).errors, [], before)

  await assert.rejects(
    addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' }),
    new RegExp(`Team '${TEAM_ID}' has a roster this page cannot extend without hiding or losing a member, so it cannot take new members`, 'u'),
  )
  assert.equal(readText(layout.teamYamlPath), before)
})

test('a roster indented four spaces, where an appended two-space entry would not be read, is refused, and team.yaml is unchanged', async (t) => {
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents:', ALPHA.map((line) => `  ${line}`), '', levels('alpha'), ''),
    personas: ['alpha', 'gamma'],
  })
  const before = readText(layout.teamYamlPath)
  assert.deepEqual(rosterNames(layout.teamYamlPath), ['alpha'], before)
  assert.deepEqual(parseTeamConfig(layout.teamYamlPath).errors, [], before)

  await assert.rejects(
    addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'gamma' }),
    new RegExp(`Team '${TEAM_ID}' has a roster this page cannot extend without hiding or losing a member, so it cannot take new members`, 'u'),
  )
  assert.equal(readText(layout.teamYamlPath), before)
})

test('a team.yaml with two top-level agents keys is refused, and team.yaml is unchanged', async (t) => {
  // The shape today's Agent page leaves behind after adding gamma to a team
  // that declared "agents: []": the empty key stays and a second one follows.
  const layout = makeRepo(t, {
    teamYaml: text(TEAM, 'agents: []', '', levels('gamma'), '', 'agents:', [
      '  - name: gamma',
      '    type: agent',
      '    role: >',
      '      gamma persona.',
      '    tools: []',
      '    agent_file: ../../agents/gamma/gamma.md',
      '    experience_enabled: true',
    ], ''),
    personas: ['gamma', 'delta'],
  })
  const before = readText(layout.teamYamlPath)

  await assert.rejects(
    addAgentToTeam({ repoRoot: layout.repoRoot, teamId: TEAM_ID, agentName: 'delta' }),
    new RegExp(`Team '${TEAM_ID}' declares more than one roster, so it cannot take new members`, 'u'),
  )
  assert.equal(readText(layout.teamYamlPath), before)
})
