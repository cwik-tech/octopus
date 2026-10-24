import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseWorkflowRegistry } from '../../workflows/loader.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { isGeneratedTarget } from '../../services/generated-target-registry.js'

/**
 * What a new installation is allowed to contain.
 *
 * `scheduled-agent-*` and `team-chat-*` wrappers are materialized on demand by
 * `services/scheduled-agent-target.ts` and `services/team-chat-target.ts` when
 * somebody schedules an agent or chats to a team. They are per-installation
 * run state, so a copy of one in the repository is a developer's own run that
 * was committed — it names teams and agents that installation happened to use
 * and nothing regenerates or removes it.
 *
 * Both registries report a path that does not resolve as a *warning*, not an
 * error (`workflows/loader.ts:202`, `parsers/team-registry.ts:74`), so a
 * catalog entry left behind by a deleted file is silent at parse time. The
 * resolution tests below are what makes such an entry fail.
 */

const REPO_ROOT = process.cwd()
const WORKFLOW_REGISTRY = path.join(REPO_ROOT, 'workflows', 'registry.yaml')
const TEAM_REGISTRY = path.join(REPO_ROOT, 'teams.yaml')

/** The prefix `wrapperIdentifier` gives every generated scheduling wrapper. */
const SCHEDULED_AGENT_WRAPPER_PREFIX = 'scheduled-agent-'

test('the shipped workflow registry lists no generated run wrapper', () => {
  const registry = parseWorkflowRegistry(WORKFLOW_REGISTRY)
  assert.deepEqual(registry.errors, [])

  const generated = registry.entries
    .filter((entry) => isGeneratedTarget(entry.tags))
    .map((entry) => entry.name)

  assert.deepEqual(
    generated,
    [],
    'a chat- or scheduler-generated wrapper is run state from one installation; ' +
      'the shipped catalog must ship only authored templates',
  )
})

test('every shipped workflow registry entry resolves to a template file that exists', () => {
  const registry = parseWorkflowRegistry(WORKFLOW_REGISTRY)
  assert.deepEqual(registry.errors, [])

  const dangling = registry.entries
    .filter((entry) => !fs.existsSync(entry.template_path))
    .map((entry) => `${entry.name} → ${path.relative(REPO_ROOT, entry.template_path)}`)

  assert.deepEqual(dangling, [], 'a registered workflow must have a template to run')
})

test('the shipped team registry lists no generated scheduling wrapper', () => {
  const registry = parseTeamRegistry(TEAM_REGISTRY)
  assert.deepEqual(registry.errors, [])

  const generated = registry.entries
    .filter((entry) => entry.name.startsWith(SCHEDULED_AGENT_WRAPPER_PREFIX))
    .map((entry) => entry.name)

  assert.deepEqual(
    generated,
    [],
    'a single-agent scheduling wrapper is materialized per installation; ' +
      'the shipped registry must ship only authored teams',
  )
})

test('every shipped team registry entry resolves to a team.yaml that exists', () => {
  const registry = parseTeamRegistry(TEAM_REGISTRY)
  assert.deepEqual(registry.errors, [])

  const dangling = registry.entries
    .filter((entry) => entry.type === 'team')
    .filter((entry) => !fs.existsSync(path.join(entry.team_path, 'team.yaml')))
    .map((entry) => `${entry.name} → ${path.relative(REPO_ROOT, entry.team_path)}`)

  assert.deepEqual(dangling, [], 'a registered team must have a team.yaml to load')
})
