/**
 * Who may see and launch a team that is still being built.
 *
 * `listPublishedTeams` on its own is a helper, not enforcement. The catalogs the
 * user actually reads and the paths a run actually takes each have to ask the
 * question, or an unfinished team is still offered and still launched.
 *
 * The builder's own view is the other half of the contract: reconciliation,
 * ownership reservation and member mutation must keep seeing the shell, because
 * they are the only things that can finish it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addTeamBuilderAgent,
  createTeamBuilderTeam,
  finishTeamBuilderPublication,
  listPublishedTeams,
  listTeamBuilderTeams,
  readTeamBuilderTeam,
} from '../../domains/agent-generator/team-manager.js'
import {
  addAgentToTeam,
  listAgentTeamOptions,
} from '../../domains/agent-generator/team-usage.js'
import {
  addTeamBuilderTeamAgent,
  deleteTeamBuilderTeamById,
  listTeamBuilderTeamSummaries,
  readTeamBuilderTeamDetail,
  removeTeamBuilderTeamAgent,
  updateTeamBuilderTeamDetail,
} from '../../services/team-builder-service.js'
import { buildFrontDoorCatalog } from '../../services/front-door-context.js'
import { measureResourceArchitectPrompt } from '../../domains/resource-architect/resource-architect-llm.js'

async function withBuildingTeam(
  fn: (repoRoot: string) => void | Promise<void>,
): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-consumers-'))
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  const agentDir = path.join(repoRoot, 'agents', 'alpha')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, 'alpha.md'),
    '---\nname: alpha\ndescription: d\ntier: strategic\n---\n\n# alpha\n',
  )
  await createTeamBuilderTeam(repoRoot, {
    id: 'half-built',
    description: 'Still being assembled.',
    building: true,
  })
  await addTeamBuilderAgent({ repoRoot, teamId: 'half-built', agentName: 'alpha' })
  try {
    await fn(repoRoot)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

test('the Create catalog does not offer a team that is still being built', async () => {
  await withBuildingTeam(async (repoRoot) => {
    assert.deepEqual(
      listTeamBuilderTeamSummaries(repoRoot).map((team) => team.id),
      [],
    )
    await finishTeamBuilderPublication(repoRoot, 'half-built')
    assert.deepEqual(
      listTeamBuilderTeamSummaries(repoRoot).map((team) => team.id),
      ['half-built'],
    )
  })
})

test('the Agent page does not offer a team that is still being built', async () => {
  await withBuildingTeam(async (repoRoot) => {
    assert.deepEqual(listAgentTeamOptions(repoRoot).map((team) => team.id), [])
    await finishTeamBuilderPublication(repoRoot, 'half-built')
    assert.deepEqual(listAgentTeamOptions(repoRoot).map((team) => team.id), ['half-built'])
  })
})

test('the front door does not offer a team that is still being built', async () => {
  await withBuildingTeam(async (repoRoot) => {
    assert.doesNotMatch(
      JSON.stringify(buildFrontDoorCatalog({ repoRootPath: repoRoot })),
      /half-built/u,
    )
    await finishTeamBuilderPublication(repoRoot, 'half-built')
    assert.match(JSON.stringify(buildFrontDoorCatalog({ repoRootPath: repoRoot })), /half-built/u)
  })
})

// The other half. Hiding the shell from its own builder would make it
// impossible to finish, and reconciliation could never recover it.
test('the builder still sees the shell it is assembling', async () => {
  await withBuildingTeam(async (repoRoot) => {
    assert.deepEqual(
      listTeamBuilderTeams(repoRoot).map((team) => team.id),
      ['half-built'],
    )
    assert.equal(readTeamBuilderTeam(repoRoot, 'half-built').id, 'half-built')
    // And it can still take the members that will finish it.
    await addTeamBuilderAgent({ repoRoot, teamId: 'half-built', agentName: 'alpha' })
  })
})

// Hiding the shell from a picker is not the same as protecting it. An ordinary
// product edit reaches the writer directly — a stale page, a direct request —
// and the roster of a team being built belongs to that build, not to whoever
// asks next.
test('the Agent page cannot add a member to a team that is still being built', async () => {
  await withBuildingTeam(async (repoRoot) => {
    const teamYamlPath = path.join(repoRoot, 'teams', 'half-built', 'team.yaml')
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      addAgentToTeam({ repoRoot, teamId: 'half-built', agentName: 'alpha' }),
      /being built/iu,
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)

    // Once the build finishes, the ordinary edit is allowed again.
    await finishTeamBuilderPublication(repoRoot, 'half-built')
    await addAgentToTeam({ repoRoot, teamId: 'half-built', agentName: 'alpha' })
  })
})

// And the build's own path keeps working, because it is the thing that has to
// finish the team.
test('the build itself can still add members while the team is being built', async () => {
  await withBuildingTeam(async (repoRoot) => {
    const agentDir = path.join(repoRoot, 'agents', 'beta')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, 'beta.md'),
      '---\nname: beta\ndescription: d\ntier: strategic\n---\n\n# beta\n',
    )

    await addTeamBuilderAgent({ repoRoot, teamId: 'half-built', agentName: 'beta' })
    assert.match(
      fs.readFileSync(path.join(repoRoot, 'teams', 'half-built', 'team.yaml'), 'utf8'),
      /name: "beta"/u,
    )
  })
})

// The Create service's own write methods reach the same files. A stale page or
// a direct request goes through these, not through a picker.
const GUARDED_CREATE_WRITES: ReadonlyArray<{
  readonly name: string
  readonly run: (repoRoot: string) => Promise<unknown>
}> = [
  {
    name: 'renaming it',
    run: (repoRoot) =>
      updateTeamBuilderTeamDetail({
        repoRootPath: repoRoot,
        teamId: 'half-built',
        input: { id: 'renamed', description: 'Renamed mid-build.' },
      }),
  },
  {
    name: 'adding a member',
    run: (repoRoot) =>
      addTeamBuilderTeamAgent({
        repoRootPath: repoRoot,
        teamId: 'half-built',
        input: { agentName: 'alpha' },
      }),
  },
  {
    name: 'removing a member',
    run: (repoRoot) =>
      removeTeamBuilderTeamAgent({
        repoRootPath: repoRoot,
        teamId: 'half-built',
        agentName: 'alpha',
      }),
  },
  {
    name: 'deleting it',
    run: (repoRoot) =>
      deleteTeamBuilderTeamById({ repoRootPath: repoRoot, teamId: 'half-built' }),
  },
]

for (const scenario of GUARDED_CREATE_WRITES) {
  test(`the Create service refuses ${scenario.name} while the build owns it`, async () => {
    await withBuildingTeam(async (repoRoot) => {
      const teamYamlPath = path.join(repoRoot, 'teams', 'half-built', 'team.yaml')
      const before = fs.readFileSync(teamYamlPath, 'utf8')

      await assert.rejects(scenario.run(repoRoot), /being built/iu)
      assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
    })
  })
}

// Reading is not writing. A half-built team still has to be readable, or its
// own builder cannot show what it is assembling.
test('the Create service still reads a team that is being built', async () => {
  await withBuildingTeam(async (repoRoot) => {
    assert.equal(
      readTeamBuilderTeamDetail({ repoRootPath: repoRoot, teamId: 'half-built' }).id,
      'half-built',
    )
  })
})

/** The minimal architect config `measureResourceArchitectPrompt` needs. */
function seedArchitectConfig(repoRoot: string): void {
  const teamDir = path.join(repoRoot, 'teams', 'resource-architect')
  const agentDir = path.join(repoRoot, 'agents', 'resource-architect')
  fs.mkdirSync(teamDir, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, 'resource-architect.md'),
    '---\nname: resource-architect\ndescription: d\ntier: strategic\n---\n\n' +
      'You are the Agent and Team Architect\n',
  )
  fs.writeFileSync(
    path.join(teamDir, 'team.yaml'),
    [
      'team:',
      '  name: "resource-architect"',
      '  description: Architect.',
      'agents:',
      '  - name: "resource-architect"',
      '    type: agent',
      '    role: Architect.',
      '    tools: []',
      '    agent_file: "../../agents/resource-architect/resource-architect.md"',
      '',
    ].join('\n'),
  )
}

// The Architect proposes reusing teams from its own inventory. Offering one
// that is still being built would have it plan around a team that does not
// finally exist, and whose roster is not yet what it will be.
//
// Measured through the prompt the Architect is actually given, so reverting the
// wiring to the builder's list fails this. A test that called the published
// list itself and fed the result in would pass either way.
test('the Architect prompt does not carry a team that is still being built', async () => {
  await withBuildingTeam(async (repoRoot) => {
    seedArchitectConfig(repoRoot)
    const measure = () =>
      measureResourceArchitectPrompt({ repoRoot, operation: 'conversation' })
        .context.teamLibraryChars

    const whileBuilding = measure()
    await finishTeamBuilderPublication(repoRoot, 'half-built')
    const oncePublished = measure()

    // The only team in the repo, so publishing it is the only thing that can
    // make the library longer.
    assert.ok(
      oncePublished > whileBuilding,
      `team library did not grow on publication: ${whileBuilding} -> ${oncePublished}`,
    )
  })
})
