import assert from 'node:assert/strict'
import test from 'node:test'

import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import type { LevelConfig, TeamConfig } from '../../core/types.js'
import {
  entryLevelActivation,
  pendingLevelStates,
  resolveTeamBoot,
  toRosterEntrySlim,
  type TeamBootEnvironment,
} from '../../team-runtime/team-boot.js'

/**
 * Direct checks on the boot decisions in `team-runtime/team-boot.ts`.
 *
 * The entrypoint tests in `tests/integration/team-runtime-boot-state.test.ts`
 * boot the runtime and read what it leaves. They cannot reach an entry index
 * with no level, because `resolveEntryLevelIndex` falls back to the first
 * level, they cannot see the config object a boot parsed or whether two
 * calls share a level-state object, and they see the budget ledger only
 * through a metered provider dispatch. These pin those.
 */

const NO_ENV: TeamBootEnvironment = {
  configOverridesJson: undefined,
  bootEntryJson: undefined,
  budgetCap: undefined,
  budgetPolicy: undefined,
}

function routingLevel(id: string, order: number): LevelConfig {
  return {
    id,
    name: id,
    order,
    stage: {
      type: 'routing',
      coordinator: 'intake-agent',
      config: { output: { format: `${id}.md`, user_review: false } },
    },
  }
}

function makeConfig(): TeamConfig {
  return {
    team: { name: 'fixture-desk', description: 'Fixture', version: '1' },
    workspace: { path: '/tmp/fixture-workspace', watch: false },
    agents: [{
      name: 'intake-agent',
      type: 'agent',
      role: 'coordinator',
      agent_file: 'agents/intake-agent.md',
      mount: [{ from: 'sources', to: 'input' }],
    }],
    levels: [routingLevel('intake', 0), routingLevel('handover', 1)],
    gates: [],
    budget: { cap_usd: 5, enforce: true, on_exceed: 'halt' },
  }
}

test('the entry level activation names the level at the entry index and refuses an index with no level', () => {
  const levels = [routingLevel('intake', 0), routingLevel('handover', 1)]

  assert.deepEqual(entryLevelActivation(levels, 1), {
    levelId: 'handover',
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.READY,
  })
  assert.equal(entryLevelActivation([], 0), undefined)
  assert.throws(() => entryLevelActivation(levels, 2), {
    message: 'Team configuration has no initial level',
  })
})

test('the boot decisions leave the config they read unchanged, and each call gives new pending level states', () => {
  const config = makeConfig()

  resolveTeamBoot({
    config,
    warnings: ['a warning'],
    resolvedEntry: undefined,
    env: { ...NO_ENV, budgetCap: '7', budgetPolicy: 'warn' },
  })
  for (const entry of config.agents) toRosterEntrySlim(entry)
  const first = pendingLevelStates(config.levels)
  const second = pendingLevelStates(config.levels)
  entryLevelActivation(config.levels, 0)

  assert.deepEqual(config, makeConfig())
  const pending = {
    status: LEVEL_STATUS.PENDING,
    stageStatus: STAGE_LIFECYCLE_STATUS.NOT_STARTED,
    engineState: null,
    loopbackCount: 0,
  }
  assert.deepEqual(first, [['intake', pending], ['handover', pending]])
  assert.notEqual(first[0]?.[1], first[1]?.[1])
  assert.notEqual(first[0]?.[1], second[0]?.[1])
})

test('the budget ledger takes a positive TEAM_BUDGET_CAP over the config, a halt or warn TEAM_BUDGET_POLICY over its on_exceed, and none when the config opts out and no cap is given', () => {
  const budgetFor = (budget: NonNullable<TeamConfig['budget']>, env: Partial<TeamBootEnvironment>) =>
    resolveTeamBoot({
      config: { ...makeConfig(), budget },
      warnings: undefined,
      resolvedEntry: undefined,
      env: { ...NO_ENV, ...env },
    }).budget

  assert.deepEqual(budgetFor({ cap_usd: 5, enforce: true, on_exceed: 'halt' }, {}), { capUsd: 5, policy: 'halt' })
  assert.deepEqual(
    budgetFor({ cap_usd: 5, enforce: true, on_exceed: 'halt' }, { budgetCap: '9', budgetPolicy: 'warn' }),
    { capUsd: 9, policy: 'warn' },
  )
  assert.deepEqual(
    budgetFor({ cap_usd: 5, enforce: true, on_exceed: 'halt' }, { budgetPolicy: 'stop' }),
    { capUsd: 5, policy: 'halt' },
    'a policy other than halt or warn falls back to the config',
  )
  assert.equal(budgetFor({ cap_usd: 5, enforce: false, on_exceed: 'halt' }, {}), undefined)
  assert.deepEqual(
    budgetFor({ cap_usd: 5, enforce: false, on_exceed: 'halt' }, { budgetCap: '3' }),
    { capUsd: 3, policy: 'halt' },
    'a positive TEAM_BUDGET_CAP keeps a ledger although the config opts out',
  )
})
