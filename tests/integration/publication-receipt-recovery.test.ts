/**
 * A build that published its team, then stopped before recording that it had.
 *
 * Publication is the durable fact. The job receipt is bookkeeping written after
 * it, so a stop in between leaves a team that is finished and a job that says
 * otherwise — and offering a retry then fails, because a published team is not
 * the retry's to rewrite. Recovery has to recognise the publication it already
 * made, and recognise it by ownership rather than by name.
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
} from '../../domains/agent-generator/team-manager.js'
import { ResourceArchitectStore } from '../../server/resource-architect-store.js'
import { reconcileInterruptedResourceBuilds } from '../../services/resource-architect-service.js'
import type { ResourceBuildJobSnapshot } from '../../contracts/resource-architect.js'

const PLAN_ID = 'plan-receipt'

function interruptedJob(
  admittedRevision?: string,
): ResourceBuildJobSnapshot {
  return {
    jobId: 'job-receipt',
    planId: PLAN_ID,
    ...(admittedRevision === undefined ? {} : { admittedRevision }),
    status: 'running',
    items: [{
      plannedResource: { kind: 'team', id: 'receipt-team' },
      planIndex: 0,
      status: 'generating',
    }],
    events: [],
    selectedResource: null,
  }
}

async function withRepo(
  fn: (repoRoot: string, store: ResourceArchitectStore) => Promise<void>,
): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-recovery-'))
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  const agentDir = path.join(repoRoot, 'agents', 'alpha')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, 'alpha.md'),
    '---\nname: alpha\ndescription: d\ntier: strategic\n---\n\n# alpha\n',
  )
  try {
    await fn(repoRoot, new ResourceArchitectStore())
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

test('a build whose team was published before the stop recovers as completed', async () => {
  await withRepo(async (repoRoot, store) => {
    await createTeamBuilderTeam(repoRoot, {
      id: 'receipt-team',
      description: 'Published before the receipt was written.',
      orchestratorKey: PLAN_ID,
      building: true,
    })
    await addTeamBuilderAgent({ repoRoot, teamId: 'receipt-team', agentName: 'alpha' })
    await finishTeamBuilderPublication(repoRoot, 'receipt-team')
    await store.saveJob(interruptedJob())

    const [recovered] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    })

    assert.equal(recovered?.status, 'completed', JSON.stringify(recovered))
    // Nothing to retry, so nothing that would fail on a published team.
    assert.equal(recovered?.error, undefined)
  })
})

// The evidence is ownership, not a matching name. A team someone else made with
// the same id says nothing about this plan's build.
test('a same-named team this plan did not build does not count as its completion', async () => {
  await withRepo(async (repoRoot, store) => {
    await createTeamBuilderTeam(repoRoot, {
      id: 'receipt-team',
      description: 'Someone else made this.',
      orchestratorKey: 'a-different-plan',
    })
    await addTeamBuilderAgent({ repoRoot, teamId: 'receipt-team', agentName: 'alpha' })
    await store.saveJob(interruptedJob())

    const [recovered] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    })

    assert.notEqual(recovered?.status, 'completed', JSON.stringify(recovered))
  })
})

// And a shell this plan owns but never finished publishing is still unfinished.
test('an owned team that was never published still needs the build', async () => {
  await withRepo(async (repoRoot, store) => {
    await createTeamBuilderTeam(repoRoot, {
      id: 'receipt-team',
      description: 'Half built.',
      orchestratorKey: PLAN_ID,
      building: true,
    })
    await store.saveJob(interruptedJob())

    const [recovered] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    })

    assert.notEqual(recovered?.status, 'completed', JSON.stringify(recovered))
  })
})

// Absence of the marker is not proof of publication. Teams built before this
// marker existed carry nothing, so inferring "finished" from "not marked
// building" reports an empty shell as a completed build.
test('a legacy owned shell with no marker is not reported as completed', async () => {
  await withRepo(async (repoRoot, store) => {
    const teamDir = path.join(repoRoot, 'teams', 'receipt-team')
    fs.mkdirSync(teamDir, { recursive: true })
    // What a build before this marker left behind: owned, and empty.
    fs.writeFileSync(
      path.join(teamDir, 'team.yaml'),
      [
        'team:',
        '  name: "receipt-team"',
        '  description: Legacy shell.',
        `  created_by_orchestrator: "${PLAN_ID}"`,
        'agents: []',
        '',
      ].join('\n'),
    )
    fs.writeFileSync(
      path.join(repoRoot, 'teams.yaml'),
      'receipt-team:\n  type: team\n  description: Legacy shell.\n  team_path: ./teams/receipt-team\n',
    )
    await store.saveJob(interruptedJob())

    const [recovered] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    })
    assert.notEqual(recovered?.status, 'completed', JSON.stringify(recovered))
  })
})

// And a legacy shell that parses but holds fewer members than the build was
// admitted with is equally unfinished.
test('a legacy owned team short of its admitted roster is not reported as completed', async () => {
  await withRepo(async (repoRoot, store) => {
    await createTeamBuilderTeam(repoRoot, {
      id: 'receipt-team',
      description: 'Legacy, one member.',
      orchestratorKey: PLAN_ID,
    })
    await addTeamBuilderAgent({ repoRoot, teamId: 'receipt-team', agentName: 'alpha' })
    // Created without the building marker, exactly as a pre-marker build would.
    const teamYamlPath = path.join(repoRoot, 'teams', 'receipt-team', 'team.yaml')
    fs.writeFileSync(
      teamYamlPath,
      fs.readFileSync(teamYamlPath, 'utf8').replace(/^\s*building: true\n/mu, ''),
    )
    await store.saveJob(interruptedJob())

    const [recovered] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    })
    assert.notEqual(recovered?.status, 'completed', JSON.stringify(recovered))
  })
})

// One plan can be amended between attempts, so its id says nothing about which
// attempt's work is on disk. A team published by the attempt admitted at one
// revision is not the completion of a job admitted at another.
test('a team published by an earlier attempt does not complete a later one', async () => {
  const REVISION_A = 'sha256:' + 'a'.repeat(64)
  const REVISION_B = 'sha256:' + 'b'.repeat(64)
  await withRepo(async (repoRoot, store) => {
    await createTeamBuilderTeam(repoRoot, {
      id: 'receipt-team',
      description: 'Published by the first attempt.',
      orchestratorKey: PLAN_ID,
      building: true,
    })
    await addTeamBuilderAgent({ repoRoot, teamId: 'receipt-team', agentName: 'alpha' })
    await finishTeamBuilderPublication(repoRoot, 'receipt-team', {
      admittedRevision: REVISION_A,
    })
    // The job that stopped was admitted against a different revision of the
    // same plan, so the team on disk is not the team it was approved to build.
    await store.saveJob(interruptedJob(REVISION_B))

    const [recovered] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    })

    assert.notEqual(recovered?.status, 'completed', JSON.stringify(recovered))
  })
})

// And the attempt that did publish it recovers as completed, so the comparison
// is not simply refusing everything.
test('the attempt that published the team recovers as completed', async () => {
  const REVISION_A = 'sha256:' + 'a'.repeat(64)
  await withRepo(async (repoRoot, store) => {
    await createTeamBuilderTeam(repoRoot, {
      id: 'receipt-team',
      description: 'Published by this attempt.',
      orchestratorKey: PLAN_ID,
      building: true,
    })
    await addTeamBuilderAgent({ repoRoot, teamId: 'receipt-team', agentName: 'alpha' })
    await finishTeamBuilderPublication(repoRoot, 'receipt-team', {
      admittedRevision: REVISION_A,
    })
    await store.saveJob(interruptedJob(REVISION_A))

    const [recovered] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store,
      isActive: () => false,
    })

    assert.equal(recovered?.status, 'completed', JSON.stringify(recovered))
    assert.equal(recovered?.error, undefined)
  })
})
