import assert from 'node:assert/strict'
import * as path from 'node:path'
import test, { after, before } from 'node:test'

import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import { loadAgent } from '../../parsers/load-agent.js'
import { parseTeamConfig } from '../../parsers/team-config.js'

const REPO_ROOT = process.cwd()
const BOARD_CONFIG = path.join(REPO_ROOT, 'teams', 'problem-thinking-board', 'team.yaml')
const BRAINSTORM_CONFIG = path.join(REPO_ROOT, 'teams', 'app-brainstorm-team', 'team.yaml')

/**
 * The `problem-thinking-board` personas must not demand an Anthropic API key.
 *
 * Regression from `95334ed0`. These built-in personas declared
 * `provider: anthropic`, which the preflight rejects without
 * `ANTHROPIC_API_KEY`, so the board failed configuration validation before
 * contacting any provider. That is what blocked the AC15 live canary: the
 * `discuss` step's child exited 1 reporting
 * "Team cannot start: agent 'money-maker' cannot use provider 'anthropic': missing ANTHROPIC_API_KEY".
 *
 * The installed Claude CLI is the intended path; its provider authenticates
 * itself and explicitly unsets `ANTHROPIC_API_KEY` and `CLAUDE_API_KEY`
 * (`providers/claude.ts:31`).
 *
 * Asserted through `loadAgent` against the shipped team files, because that is
 * the function the runtime calls. Nothing here starts a CLI or reads
 * credentials.
 */

/**
 * Every board persona now resolves from its own declaration.
 *
 * `problem-decomposer` used to be the exception: its board roster entry carried
 * an explicit `provider: codex` override that displaced the persona file. Team
 * roster overrides are gone, so its own `provider: claude` decides — which is
 * also what the live failure this test was written for wanted.
 */
const BOARD_PERSONA_RESOLVED = [
  'money-maker',
  'innovator',
  'first-principles-fool',
  'pattern-matcher',
  'problem-decomposer',
] as const

/**
 * Pin the app-wide default model selection off for these tests.
 *
 * `loadAgent` consults it (Settings → AI Providers) whenever the winning layer
 * left the model unresolved, so a developer machine carrying a default could
 * otherwise decide the answer. These assertions are about what the repository
 * ships, so the only inputs allowed are the shipped files.
 */
let previousDefaultSelection: ReturnType<typeof getRuntimeDefaultModelState>

before(() => {
  previousDefaultSelection = getRuntimeDefaultModelState()
  setRuntimeDefaultModelState({ status: 'unset' })
})

after(() => {
  setRuntimeDefaultModelState(previousDefaultSelection)
})

/** Every roster entry of a shipped team, loaded the way the runtime loads it. */
function resolvedProviders(teamConfigPath: string): Map<string, string> {
  const parsed = parseTeamConfig(teamConfigPath)
  assert.deepEqual(parsed.errors, [], `${teamConfigPath} parses cleanly`)
  assert.ok(parsed.config, `${teamConfigPath} loads`)

  const roster = parsed.config.agents ?? []
  assert.ok(roster.length > 0, `${teamConfigPath} has a roster`)

  const providers = new Map<string, string>()
  for (const entry of roster) {
    const loaded = loadAgent(entry, parsed.config, 0)
    assert.ok(loaded, `${entry.name} loads from its shipped agent file`)
    providers.set(entry.name, loaded.provider)
  }
  return providers
}

test('no agent on the problem-thinking-board resolves to the Anthropic API', () => {
  for (const [name, provider] of resolvedProviders(BOARD_CONFIG)) {
    assert.notEqual(provider, 'anthropic', `${name} still resolves to the Anthropic API`)
  }
})

test('every board persona resolves to the Claude CLI from its own declaration', () => {
  const providers = resolvedProviders(BOARD_CONFIG)

  for (const name of BOARD_PERSONA_RESOLVED) {
    assert.equal(
      providers.get(name),
      'claude',
      `${name} must run on the installed Claude CLI, not the Anthropic API`,
    )
  }

  assert.equal(
    providers.get('problem-decomposer'),
    'claude',
    'the retired board roster override no longer displaces its own declaration',
  )
})

/**
 * The `problem-decomposer` correction is load-bearing somewhere, or it is not a
 * correction at all.
 *
 * Its board entry overrides the provider, so the board alone cannot show that
 * the persona file matters. `app-brainstorm-team` lists the same persona with
 * no override, which is where its own declaration decides the run.
 */
test('problem-decomposer resolves to claude on the team that does not override it', () => {
  const providers = resolvedProviders(BRAINSTORM_CONFIG)
  assert.equal(providers.get('problem-decomposer'), 'claude')
  for (const [name, provider] of providers) {
    assert.notEqual(provider, 'anthropic', `${name} still resolves to the Anthropic API`)
  }
})
