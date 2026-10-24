import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDelegatedRoutingAutostartPlan } from '../../domains/delegation/delegated-routing-autostart.js'
import type { LevelConfig, TeamConfig } from '../../core/types.js'

const level: LevelConfig = {
  id: 'intake',
  name: 'Intake',
  order: 0,
  stage: {
    type: 'routing',
    coordinator: 'receptionist',
    config: {
      output: { format: 'routing-decision.md', user_review: false },
    },
  },
}

const teamConfig: TeamConfig = {
  team: { name: 'reception-desk', description: 'Routing', version: '1' },
  workspace: { path: '/tmp', watch: false },
  workflow: {
    entry_level: 'intake',
    output_contract: { completion_artifact: 'routing-decision.md' },
  },
  defaults: { provider: 'codex' },
  agents: [],
  levels: [level],
  gates: [],
}

test('delegated routing autostart preserves the user request and completion artifact', () => {
  const plan = buildDelegatedRoutingAutostartPlan(
    teamConfig,
    level,
    '---\nartifact_type: brief\n---\n\nUSER: Discuss US foreign policy.\n\nASSISTANT: Which angle?',
    ['problem-thinking-board', 'writing-team'],
  )

  assert.equal(plan.outputArtifact, 'routing-decision.md')
  assert.match(plan.userMessage, /Discuss US foreign policy\./)
  assert.doesNotMatch(plan.userMessage, /Which angle\?/)
  assert.match(plan.userMessage, /problem-thinking-board/)
})

test('delegated routing autostart forbids follow-up questions and nested team spawning', () => {
  const plan = buildDelegatedRoutingAutostartPlan(
    teamConfig,
    level,
    'USER: Broad topic.',
    [],
  )

  assert.match(plan.systemPrompt, /Do not ask the user questions/i)
  assert.match(plan.systemPrompt, /spawn teams/i)
  assert.match(plan.systemPrompt, /missing.*non-blocking/i)
})

test('managed routing allows a necessary question without asking for routine framing approval', () => {
  const plan = buildDelegatedRoutingAutostartPlan(teamConfig, level, 'Prepare the required named dedication.', [], undefined, { humanQuestions: true })
  assert.doesNotMatch(plan.systemPrompt, /Do not ask the user questions/)
  assert.match(plan.systemPrompt, /managed question/)
  assert.match(plan.systemPrompt, /non-blocking/)
})
