/**
 * A shape on the plan has to reach the file the team runs from.
 *
 * The emitter can be correct and the feature still absent, if nothing carries
 * the chosen shape from the plan to the build. That is the "carried and
 * ignored" failure: the user picks "they take turns discussing it", the plan
 * records it, and a chain is built anyway.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createTeamBuildShell } from '../../domains/resource-architect/team-build-shell.js'
import {
  addTeamBuilderAgent,
  finishTeamBuilderPublication,
} from '../../domains/agent-generator/team-manager.js'
import { withFileMutationLock } from '../../core/file-mutation.js'
import { parseYaml, type YamlObject } from '../../core/yaml-parser.js'
import type { ResourceTeamPlan } from '../../contracts/resource-architect.js'
import type { TeamShape } from '../../contracts/schemas/team-shape.js'

function isObject(value: unknown): value is YamlObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The entry level's stage, read from the saved file.
 *
 * A shell has no roster yet, so it does not pass full validation: its gate
 * names an artifact no agent produces until members are added. The stage it
 * was built with is still on disk, and that is what this asserts on.
 */
function savedStage(teamYamlPath: string): YamlObject {
  const yaml = fs.readFileSync(teamYamlPath, 'utf8')
  const raw = parseYaml(yaml)
  const level = Array.isArray(raw.levels) ? raw.levels[0] : undefined
  assert.ok(isObject(level) && isObject(level.stage), yaml)
  return level.stage
}

function withTempRepo(fn: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-to-build-'))
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })
}

const basePlan: ResourceTeamPlan = {
  teamId: 'shaped-build',
  description: 'A team that discusses.',
  tags: [],
  existingAgents: [],
  newAgents: [],
  questionsResolved: [],
}

test('the shape chosen on the plan is the shape the built team runs', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

    const team = await createTeamBuildShell({
      repoRoot,
      // The service always passes the plan id here, and it is what marks the
      // built team as this app's own.
      orchestratorKey: 'plan-shaped-build',
      plan: {
        ...basePlan,
        shape: {
          kind: 'discussion',
          rationale: 'They disagree usefully.',
          depth: 'thorough',
          coordinator: 'lead',
          participants: ['alpha'],
        },
      },
    })

    const stage = savedStage(path.join(repoRoot, 'teams', team.id, 'team.yaml'))
    assert.equal(stage.type, 'discussion')
    assert.equal(stage.coordinator, 'lead')
    assert.ok(isObject(stage.config))
    assert.equal(stage.config.max_rounds, 5)
  })
})

test('a discussion publishes its whole eligible roster even when it has seven specialists', async () => {
  await withTempRepo(async (repoRoot) => {
    const participants = ['researcher', 'michigan', 'ip', 'privacy', 'risk', 'leverage', 'writer']
    const roster = ['lead', ...participants]
    const shape: TeamShape = {
      kind: 'discussion', rationale: 'The lead selects the relevant specialists.',
      depth: 'standard', coordinator: 'lead', participants,
    }
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    for (const name of roster) {
      const dir = path.join(repoRoot, 'agents', name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: Contract specialist\ntier: strategic\n---\n\n# ${name}\n`)
    }
    const team = await createTeamBuildShell({
      repoRoot, orchestratorKey: 'large-discussion', plan: { ...basePlan, shape },
    })
    for (const name of roster) {
      await addTeamBuilderAgent({ repoRoot, teamId: team.id, agentName: name })
    }
    await finishTeamBuilderPublication(repoRoot, team.id, {
      expectedRoster: roster, expectedShape: shape,
    })

    const stage = savedStage(path.join(repoRoot, 'teams', team.id, 'team.yaml'))
    assert.equal(stage.type, 'discussion')
    assert.equal(stage.coordinator, 'lead')
    assert.deepEqual(stage.participants, participants)
  })
})

test('a plan with no shape still builds the chain it always built', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

    const team = await createTeamBuildShell({
      repoRoot,
      orchestratorKey: 'plan-unshaped-build',
      plan: basePlan,
    })

    const stage = savedStage(path.join(repoRoot, 'teams', team.id, 'team.yaml'))
    assert.equal(stage.type, 'chain')
  })
})

// A build that failed leaves an owned shell behind. The user may then change
// the shape and press Retry. Returning the existing shell unchanged means the
// amendment the endpoint accepted is silently not built, and the team that
// appears is not the one the card described.
test('retrying an owned shell after the shape changed builds the new shape', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

    const first = await createTeamBuildShell({
      repoRoot,
      orchestratorKey: 'plan-retry',
      plan: {
        ...basePlan,
        shape: {
          kind: 'discussion',
          rationale: 'They disagree usefully.',
          depth: 'standard',
          coordinator: 'lead',
          participants: ['alpha'],
        },
      },
    })
    const teamYamlPath = path.join(repoRoot, 'teams', first.id, 'team.yaml')
    assert.equal(savedStage(teamYamlPath).type, 'discussion')

    // The same plan, amended, retried under the same ownership.
    const retried = await createTeamBuildShell({
      repoRoot,
      orchestratorKey: 'plan-retry',
      plan: {
        ...basePlan,
        shape: {
          kind: 'review',
          rationale: 'One writes, one checks.',
          depth: 'quick',
          producer: 'lead',
          reviewer: 'alpha',
        },
      },
    })

    assert.equal(retried.id, first.id, 'the retry reused the owned shell')
    const stage = savedStage(path.join(repoRoot, 'teams', retried.id, 'team.yaml'))
    assert.equal(stage.type, 'review')
    assert.equal(stage.producer, 'lead')
    assert.equal(stage.reviewer, 'alpha')
  })
})

// A retry that did not change the shape must leave the file exactly as it was,
// so an ordinary retry is not an excuse to rewrite bytes nobody asked about.
test('retrying an owned shell with the same shape rewrites nothing', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    const shape = {
      kind: 'discussion' as const,
      rationale: 'They disagree usefully.',
      depth: 'standard' as const,
      coordinator: 'lead',
      participants: ['alpha'],
    }
    const built = await createTeamBuildShell({
      repoRoot,
      orchestratorKey: 'plan-same',
      plan: { ...basePlan, shape },
    })
    const teamYamlPath = path.join(repoRoot, 'teams', built.id, 'team.yaml')
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await createTeamBuildShell({
      repoRoot,
      orchestratorKey: 'plan-same',
      plan: { ...basePlan, shape },
    })

    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

// Every part of a shape is executable: the order a chain runs in, the order a
// discussion speaks in, and how far either may go. A retry that compared only
// the kind and the role names accepted an amendment and then built the old
// arrangement anyway.
const RECONCILE_CASES: ReadonlyArray<{
  readonly name: string
  readonly from: TeamShape
  readonly to: TeamShape
  readonly expect: (stage: YamlObject) => void
}> = [
  {
    name: 'chain order',
    from: { kind: 'chain', rationale: 'r', depth: 'quick', order: ['alpha', 'beta'] },
    to: { kind: 'chain', rationale: 'r', depth: 'quick', order: ['beta', 'alpha'] },
    expect: (stage) => assert.deepEqual(stage.sequence, ['beta', 'alpha']),
  },
  {
    name: 'discussion participant order',
    from: {
      kind: 'discussion', rationale: 'r', depth: 'quick',
      coordinator: 'alpha', participants: ['beta', 'gamma'],
    },
    to: {
      kind: 'discussion', rationale: 'r', depth: 'quick',
      coordinator: 'alpha', participants: ['gamma', 'beta'],
    },
    expect: (stage) => assert.deepEqual(stage.participants, ['gamma', 'beta']),
  },
  {
    name: 'discussion depth',
    from: {
      kind: 'discussion', rationale: 'r', depth: 'quick',
      coordinator: 'alpha', participants: ['beta'],
    },
    to: {
      kind: 'discussion', rationale: 'r', depth: 'thorough',
      coordinator: 'alpha', participants: ['beta'],
    },
    expect: (stage) => {
      assert.ok(isObject(stage.config))
      assert.equal(stage.config.max_rounds, 5)
    },
  },
  {
    name: 'review depth',
    from: {
      kind: 'review', rationale: 'r', depth: 'quick',
      producer: 'alpha', reviewer: 'beta',
    },
    to: {
      kind: 'review', rationale: 'r', depth: 'thorough',
      producer: 'alpha', reviewer: 'beta',
    },
    expect: (stage) => {
      assert.ok(isObject(stage.config))
      assert.equal(stage.config.max_iterations, 5)
    },
  },
]

for (const scenario of RECONCILE_CASES) {
  test(`retrying an owned shell applies a changed ${scenario.name}`, async () => {
    await withTempRepo(async (repoRoot) => {
      fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
      const key = `plan-${scenario.name.replace(/\s+/gu, '-')}`
      const built = await createTeamBuildShell({
        repoRoot,
        orchestratorKey: key,
        plan: { ...basePlan, shape: scenario.from },
      })
      const retried = await createTeamBuildShell({
        repoRoot,
        orchestratorKey: key,
        plan: { ...basePlan, shape: scenario.to },
      })
      assert.equal(retried.id, built.id)
      scenario.expect(savedStage(path.join(repoRoot, 'teams', retried.id, 'team.yaml')))
    })
  })
}

// Reconciliation exists so a retry can finish a shell the previous attempt left
// half-built. A team whose build completed is not that: it is a published team
// someone may already be running, and rewriting its stage from a plan changes
// what it does with no one asking.
test('retrying a plan whose team was already published does not rewrite it', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    for (const name of ['lead', 'alpha']) {
      const dir = path.join(repoRoot, 'agents', name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: d\ntier: strategic\n---\n\n# ${name}\n`,
      )
    }

    const chain: TeamShape = {
      kind: 'chain',
      rationale: 'One hands to the next.',
      depth: 'standard',
      order: ['lead', 'alpha'],
    }
    const built = await createTeamBuildShell({
      repoRoot,
      orchestratorKey: 'plan-published',
      plan: { ...basePlan, shape: chain },
    })
    const teamYamlPath = path.join(repoRoot, 'teams', built.id, 'team.yaml')
    for (const name of ['lead', 'alpha']) {
      await addTeamBuilderAgent({ repoRoot, teamId: built.id, agentName: name })
    }
    await finishTeamBuilderPublication(repoRoot, built.id, {
      expectedRoster: ['lead', 'alpha'],
      expectedShape: chain,
    })
    const published = fs.readFileSync(teamYamlPath, 'utf8')

    // The same owner retries with a different shape. The published team is not
    // the retry's to rewrite.
    await assert.rejects(
      createTeamBuildShell({
        repoRoot,
        orchestratorKey: 'plan-published',
        plan: {
          ...basePlan,
          shape: {
            kind: 'review',
            rationale: 'One writes, one checks.',
            depth: 'quick',
            producer: 'lead',
            reviewer: 'alpha',
          },
        },
      }),
      /already been built|already published/iu,
    )

    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), published)
  })
})

// The caller-side check is not enough. Publication takes the same lock, so a
// team that was unfinished when a retry decided to reconcile it can be
// published by the time that retry actually holds the lock.
test('a retry queued behind a publication does not rewrite the team it publishes', async () => {
  await withTempRepo(async (repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
    for (const name of ['lead', 'alpha']) {
      const dir = path.join(repoRoot, 'agents', name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: d\ntier: strategic\n---\n\n# ${name}\n`,
      )
    }
    const chain: TeamShape = {
      kind: 'chain',
      rationale: 'One hands to the next.',
      depth: 'standard',
      order: ['lead', 'alpha'],
    }
    const built = await createTeamBuildShell({
      repoRoot,
      orchestratorKey: 'plan-race',
      plan: { ...basePlan, shape: chain },
    })
    for (const name of ['lead', 'alpha']) {
      await addTeamBuilderAgent({ repoRoot, teamId: built.id, agentName: name })
    }
    const teamYamlPath = path.join(repoRoot, 'teams', built.id, 'team.yaml')

    // Hold the lock both operations need, queue them behind it in order, then
    // let go. No timers: the gate is the lock itself.
    const registryPath = path.join(repoRoot, 'teams.yaml')
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocking = withFileMutationLock(registryPath, async () => {
      await held
    })

    const publishing = finishTeamBuilderPublication(repoRoot, built.id, {
      expectedRoster: ['lead', 'alpha'],
      expectedShape: chain,
    })
    const retrying = createTeamBuildShell({
      repoRoot,
      orchestratorKey: 'plan-race',
      plan: {
        ...basePlan,
        shape: {
          kind: 'review',
          rationale: 'One writes, one checks.',
          depth: 'quick',
          producer: 'lead',
          reviewer: 'alpha',
        },
      },
    })

    release()
    await blocking
    await publishing
    await assert.rejects(retrying, /already been built/iu)

    const saved = fs.readFileSync(teamYamlPath, 'utf8')
    assert.match(saved, /type: chain/u, saved)
    assert.doesNotMatch(saved, /type: review/u, saved)
  })
})
