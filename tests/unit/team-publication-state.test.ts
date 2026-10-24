/**
 * A team that is still being built is not a team anyone can use yet.
 *
 * Its roster is half-assembled and its stage may name members that do not exist,
 * so launching it produces a failure the user did not cause. The state lives in
 * `team.yaml` rather than on the registry entry deliberately: a registry marker
 * would have to survive two independent allowlists — the runtime parser's
 * (`parsers/team-registry.ts:78-92`) and the builder's own rewriter
 * (`team-yaml-render.ts` `renderRegistryBlock`) — and an ordinary rename would
 * erase it.
 *
 * The catalog the user sees and the list the builder works from are different
 * questions. One list cannot answer both: the builder, reconciliation and member
 * mutation must keep seeing an unfinished shell, or they cannot finish it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { TeamShape } from '../../contracts/schemas/team-shape.js'
import {
  addTeamBuilderAgent,
  createTeamBuilderTeam,
  finishTeamBuilderPublication,
  isTeamBuilding,
  listPublishedTeams,
  listTeamBuilderTeams,
  readTeamBuilderTeam,
} from '../../domains/agent-generator/team-manager.js'

function withTempRepo(fn: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-publication-'))
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })
}

test('a team created for a build starts unpublished', async () => {
  await withTempRepo(async (repoRoot) => {
    await createTeamBuilderTeam(repoRoot, {
      id: 'half-built',
      description: 'Still being assembled.',
      building: true,
    })

    assert.equal(isTeamBuilding(repoRoot, 'half-built'), true)
    // Not offered to the user…
    assert.deepEqual(listPublishedTeams(repoRoot).map((team) => team.id), [])
    // …and still visible to the builder that owns it.
    assert.deepEqual(listTeamBuilderTeams(repoRoot).map((team) => team.id), ['half-built'])
    assert.equal(readTeamBuilderTeam(repoRoot, 'half-built').id, 'half-built')
  })
})

/** A generated team with a roster that satisfies its own gate. */
async function buildableTeam(repoRoot: string, teamId: string): Promise<void> {
  for (const name of ['alpha']) {
    const dir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: d\ntier: strategic\n---\n\n# ${name}\n`,
    )
  }
  await createTeamBuilderTeam(repoRoot, {
    id: teamId,
    description: 'A generated team.',
    building: true,
  })
  await addTeamBuilderAgent({ repoRoot, teamId, agentName: 'alpha' })
}

test('finishing the build publishes a team that is actually complete', async () => {
  await withTempRepo(async (repoRoot) => {
    await buildableTeam(repoRoot, 'now-done')
    await finishTeamBuilderPublication(repoRoot, 'now-done')

    assert.equal(isTeamBuilding(repoRoot, 'now-done'), false)
    assert.deepEqual(listPublishedTeams(repoRoot).map((team) => team.id), ['now-done'])
  })
})

// Publication is the moment a team becomes launchable, so it is the last place
// that can refuse. A shell with no roster cannot satisfy its own gate, and
// publishing it hands the user a team that fails the moment they run it.
test('a team that does not yet parse is not published', async () => {
  await withTempRepo(async (repoRoot) => {
    await createTeamBuilderTeam(repoRoot, {
      id: 'empty-shell',
      description: 'No roster yet.',
      building: true,
    })

    await assert.rejects(
      finishTeamBuilderPublication(repoRoot, 'empty-shell'),
      /agent/i,
    )
    assert.equal(isTeamBuilding(repoRoot, 'empty-shell'), true)
    assert.deepEqual(listPublishedTeams(repoRoot).map((team) => team.id), [])
  })
})

// A trailing comment is ordinary YAML. Matching the line exactly left the team
// hidden forever with no way to publish it.
test('a commented publication marker is still cleared', async () => {
  await withTempRepo(async (repoRoot) => {
    await buildableTeam(repoRoot, 'commented')
    const teamYamlPath = path.join(repoRoot, 'teams', 'commented', 'team.yaml')
    fs.writeFileSync(
      teamYamlPath,
      fs.readFileSync(teamYamlPath, 'utf8').replace(
        /^(\s*building: true)$/mu,
        '$1 # pending',
      ),
    )

    await finishTeamBuilderPublication(repoRoot, 'commented')
    assert.equal(isTeamBuilding(repoRoot, 'commented'), false)
  })
})

// `building` is a key under `team:`, not any line that reads like one. A team
// may carry the same word somewhere else entirely.
test('publication leaves an unrelated nested building field alone', async () => {
  await withTempRepo(async (repoRoot) => {
    await buildableTeam(repoRoot, 'nested')
    const teamYamlPath = path.join(repoRoot, 'teams', 'nested', 'team.yaml')
    fs.writeFileSync(
      teamYamlPath,
      `${fs.readFileSync(teamYamlPath, 'utf8')}\nmetadata:\n  unrelated:\n    building: true\n`,
    )

    await finishTeamBuilderPublication(repoRoot, 'nested')

    const saved = fs.readFileSync(teamYamlPath, 'utf8')
    assert.equal(isTeamBuilding(repoRoot, 'nested'), false)
    assert.match(saved, /metadata:\n  unrelated:\n    building: true/u, saved)
  })
})

// A team created without a build — the public create path — is finished the
// moment it exists, so nothing is hidden that was never being built.
test('a team created outside a build is published immediately', async () => {
  await withTempRepo(async (repoRoot) => {
    await createTeamBuilderTeam(repoRoot, { id: 'plain', description: 'Made directly.' })

    assert.equal(isTeamBuilding(repoRoot, 'plain'), false)
    assert.deepEqual(listPublishedTeams(repoRoot).map((team) => team.id), ['plain'])
  })
})

// Every team that existed before this marker did is published. Absence means
// published, so no migration is needed and no existing team disappears.
test('a hand-authored team with no marker is published', async () => {
  await withTempRepo(async (repoRoot) => {
    const teamDir = path.join(repoRoot, 'teams', 'authored')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.writeFileSync(
      path.join(teamDir, 'team.yaml'),
      'team:\n  name: "authored"\n  description: Hand-authored.\nagents: []\n',
    )
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      'authored:\n  type: team\n  description: Hand-authored.\n  team_path: ./teams/authored\n',
    )

    assert.equal(isTeamBuilding(repoRoot, 'authored'), false)
    assert.deepEqual(listPublishedTeams(repoRoot).map((team) => team.id), ['authored'])
  })
})

// Parser validity is not completion. A build that was meant to assemble three
// agents and stopped after one still leaves a file that parses, so publication
// is tied to the roster and shape the build was admitted with rather than to
// whatever happens to be on disk.
test('a team missing members the build was admitted with is not published', async () => {
  await withTempRepo(async (repoRoot) => {
    await buildableTeam(repoRoot, 'short-roster')

    await assert.rejects(
      finishTeamBuilderPublication(repoRoot, 'short-roster', {
        expectedRoster: ['alpha', 'beta'],
      }),
      /beta/u,
    )
    assert.equal(isTeamBuilding(repoRoot, 'short-roster'), true)
  })
})

// Same kind, different arrangement. Each of these is a different team from the
// one the build was admitted to produce, and comparing only the kind accepts
// all of them.
const ADMITTED_MISMATCHES: ReadonlyArray<{ name: string; shape: TeamShape; expect: RegExp }> = [
  {
    name: 'a chain in a different order',
    shape: { kind: 'chain', rationale: 'r', depth: 'standard', order: ['beta', 'alpha'] },
    expect: /order/u,
  },
  {
    name: 'a different kind entirely',
    shape: {
      kind: 'discussion', rationale: 'r', depth: 'standard',
      coordinator: 'alpha', participants: ['beta'],
    },
    expect: /discussion/u,
  },
]

for (const scenario of ADMITTED_MISMATCHES) {
  test(`publication refuses ${scenario.name}`, async () => {
    await withTempRepo(async (repoRoot) => {
      await buildableTeam(repoRoot, 'mismatch')
      await assert.rejects(
        finishTeamBuilderPublication(repoRoot, 'mismatch', {
          expectedRoster: ['alpha'],
          expectedShape: scenario.shape,
        }),
        scenario.expect,
      )
      assert.equal(isTeamBuilding(repoRoot, 'mismatch'), true)
    })
  })
}

// An extra member is as wrong as a missing one: it is on a team nobody approved.
test('a team carrying a member the build was not admitted with is not published', async () => {
  await withTempRepo(async (repoRoot) => {
    await buildableTeam(repoRoot, 'extra-member')
    await assert.rejects(
      finishTeamBuilderPublication(repoRoot, 'extra-member', { expectedRoster: [] }),
      /unexpected/u,
    )
    assert.equal(isTeamBuilding(repoRoot, 'extra-member'), true)
  })
})

test('a team that matches what the build was admitted with is published', async () => {
  await withTempRepo(async (repoRoot) => {
    await buildableTeam(repoRoot, 'as-admitted')

    await finishTeamBuilderPublication(repoRoot, 'as-admitted', {
      expectedRoster: ['alpha'],
      expectedShape: {
        kind: 'chain',
        rationale: 'One after another.',
        depth: 'standard',
        order: ['alpha'],
      },
    })
    assert.equal(isTeamBuilding(repoRoot, 'as-admitted'), false)
  })
})

// Cancellation has to be honoured at the publication boundary itself. The lock
// can be held by another writer for as long as that writer takes, so an abort
// arriving while this call waits for it must still stop the publication.
test('a publication cancelled while it waits for the lock does not happen', async () => {
  await withTempRepo(async (repoRoot) => {
    await buildableTeam(repoRoot, 'cancelled-late')
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      finishTeamBuilderPublication(repoRoot, 'cancelled-late', {
        expectedRoster: ['alpha'],
        signal: controller.signal,
      }),
      /cancel|abort/iu,
    )
    assert.equal(isTeamBuilding(repoRoot, 'cancelled-late'), true)
    assert.deepEqual(listPublishedTeams(repoRoot).map((team) => team.id), [])
  })
})
