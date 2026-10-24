/**
 * A schedule runs an Agent; it does not choose the Agent's model.
 *
 * Injecting a pair into the wrapper roster made the same Agent behave
 * differently depending on how it was started, which is exactly the
 * where-did-this-model-come-from problem the two-choice rule removes. New
 * writes are refused rather than accepted-and-ignored, because returning
 * success for a control that does nothing is worse than failing.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { parseTeamConfig } from '../../parsers/team-config.js'
import {
  scheduleCreateRequestSchema,
  schedulePatchRequestSchema,
} from '../../contracts/schemas/scheduling-requests.js'
import { ensureScheduledAgentTarget } from '../../services/scheduled-agent-target.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

test('a schedule request may no longer name a model override', () => {
  const result = scheduleCreateRequestSchema.safeParse({
    name: 'Nightly review',
    kind: 'agent',
    target: 'client-lens',
    prompt: 'Review the latest brief.',
    cron: '0 9 * * *',
    timezone: 'UTC',
    modelOverride: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  })
  assert.equal(result.success, false)
  assert.match(
    result.success ? '' : (result.error.issues[0]?.message ?? ''),
    /'modelOverride' is no longer supported/,
  )
})

test('a schedule patch may no longer name a model override', () => {
  const result = schedulePatchRequestSchema.safeParse({
    modelOverride: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  })
  assert.equal(result.success, false)
  assert.match(
    result.success ? '' : (result.error.issues[0]?.message ?? ''),
    /'modelOverride' is no longer supported/,
  )
})

test('a scheduled target writes the agent reference and no model', async () => {
  const fixture = createSchedulerFixture('scheduled-agent-no-override-')
  try {
    const target = await ensureScheduledAgentTarget(
      { agentName: fixture.agentName },
      {
        repoRootPath: fixture.repoRootPath,
        workflowsRegistryPath: fixture.workflowsRegistryPath,
      },
    )
    const yaml = fs.readFileSync(
      path.join(fixture.repoRootPath, 'teams', target.workflowId, 'team.yaml'),
      'utf8',
    )
    assert.doesNotMatch(yaml, /^\s+provider:/m)
    assert.doesNotMatch(yaml, /^\s+model:/m)

    const team = parseTeamConfig(
      path.join(fixture.repoRootPath, 'teams', target.workflowId, 'team.yaml'),
    )
    assert.ok(team.config)
    assert.equal(team.config.agents[0]?.legacyProvider, undefined)
    assert.equal(team.config.agents[0]?.legacyModel, undefined)
  } finally {
    fixture.cleanup()
  }
})
