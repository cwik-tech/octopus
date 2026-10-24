import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseTeamConfig } from '../../parsers/team-config.js'
import { parseAgentFrontmatter } from '../../parsers/load-agent.js'
import { readAgentModelChoice } from '../../contracts/agent-model-selection.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import {
  DEFAULT_MODEL,
  DEFAULT_ORCHESTRATION_MODEL,
  DEFAULT_PROVIDER,
  MINUTES_MODEL,
} from '../../core/constants.js'

const REPO_ROOT = process.cwd()
const HOST_SUBSCRIPTION_MODEL = 'gpt-5.4-mini'
const WORKER_SUBSCRIPTION_MODEL = 'default'

test('runtime defaults use the Codex subscription provider', () => {
  assert.equal(DEFAULT_PROVIDER, 'codex')
  assert.equal(DEFAULT_MODEL, WORKER_SUBSCRIPTION_MODEL)
  assert.equal(DEFAULT_ORCHESTRATION_MODEL, HOST_SUBSCRIPTION_MODEL)
  assert.equal(MINUTES_MODEL, WORKER_SUBSCRIPTION_MODEL)
})

test('explicit API host fallbacks reference environment values instead of literal key names', () => {
  const runtimeSource = [
    'index.ts',
    'host-model-preference.ts',
    'team-boot.ts',
    'level-tools.ts',
    'host-turn-lifecycle.ts',
    'runtime-teardown.ts',
  ]
    .map((file) => fs.readFileSync(path.join(REPO_ROOT, 'team-runtime', file), 'utf8'))
    .join('\n')
  assert.match(runtimeSource, /apiKey: "\$OPENAI_API_KEY"/)
  assert.match(runtimeSource, /apiKey: "\$ANTHROPIC_API_KEY"/)
  assert.doesNotMatch(runtimeSource, /apiKey: "(?:OPENAI|ANTHROPIC)_API_KEY"/)
})

/**
 * The bundled Teams that ship on the subscription host default, named rather
 * than discovered.
 *
 * Scanning every entry that configures a host turned the default into a rule:
 * a Team that deliberately pins a different host model failed this test for
 * using a choice the registry exists to offer. The default is a fallback for
 * the Teams shipped on it, so those Teams are listed, and a new Team joins the
 * list by being added to it rather than by not being noticed.
 */
const SUBSCRIPTION_DEFAULT_HOSTS = [
  'reception-desk',
  'problem-thinking-board',
  'writing-team',
  'research-team',
  'deep-research-publication-team',
  'youtube-extraction',
  'venture-capital-team',
  'workflow-architect',
  'resource-architect',
  'crypto-investment-board',
]

test('bundled subscription-default team hosts use the Codex subscription provider', () => {
  const result = parseTeamRegistry(path.join(REPO_ROOT, 'teams.yaml'))
  assert.deepEqual(result.errors, [])

  for (const name of SUBSCRIPTION_DEFAULT_HOSTS) {
    const entry = result.entries.find((candidate) => candidate.name === name)
    assert.ok(entry, `${name} is registered`)
    if (entry.type !== 'team') {
      assert.fail(`${name} is registered as ${entry.type}, not a team`)
    }
    assert.equal(entry.host_provider, 'codex', `${name} host provider`)
    assert.equal(entry.host_model, HOST_SUBSCRIPTION_MODEL, `${name} host model`)
  }
})

test('a registered Team may override the bundled subscription host default', () => {
  const result = parseTeamRegistry(path.join(REPO_ROOT, 'teams.yaml'))
  assert.deepEqual(result.errors, [])

  const entry = result.entries.find((candidate) => candidate.name === 'data-engineering-team')
  assert.ok(entry, 'data-engineering-team is registered')
  if (entry.type !== 'team') {
    assert.fail(`data-engineering-team is registered as ${entry.type}, not a team`)
  }
  assert.equal(entry.host_provider, 'codex', 'data-engineering-team host provider')
  assert.equal(entry.host_model, 'gpt-5.6-sol', 'data-engineering-team host model')
  // The override only proves anything while it differs from the default, and
  // only while the Team is outside the list above — otherwise this test and the
  // one before it would be asserting opposite things about the same entry.
  assert.notEqual(entry.host_model, DEFAULT_ORCHESTRATION_MODEL)
  assert.equal(SUBSCRIPTION_DEFAULT_HOSTS.includes('data-engineering-team'), false)
})

test('shipped teams declare no runtime model settings of their own', () => {
  const teamNames = [
    'reception-desk',
    'problem-thinking-board',
    'research-team',
    'writing-team',
    'venture-capital-team',
    'workflow-architect',
    'resource-architect',
  ]

  for (const teamName of teamNames) {
    const teamPath = path.join(REPO_ROOT, 'teams', teamName, 'team.yaml')
    const parsed = parseTeamConfig(teamPath)
    assert.deepEqual(parsed.errors, [], `${teamName} config errors`)
    assert.ok(parsed.config, `${teamName} config`)

    // A team decides coordination, not models. Nothing here may declare a
    // provider or a model for a member — the agent's own file does that.
    assert.equal(parsed.config.legacyModels, undefined, `${teamName} models table`)
    assert.equal(parsed.config.defaults?.provider, undefined, `${teamName} default provider`)
    for (const agent of parsed.config.agents) {
      assert.equal(agent.legacyProvider, undefined, `${teamName}/${agent.name} provider`)
      assert.equal(agent.legacyModel, undefined, `${teamName}/${agent.name} model`)
    }
    assert.deepEqual(parsed.warnings.filter((warning) =>
      /is ignored/.test(warning)
    ), [], `${teamName} retired-field warnings`)
  }
})

test('every bundled agent names a complete pair or inherits the app default', () => {
  // Each shipped agent must be readable under the two-choice rule: a complete
  // provider/model pair, or nothing at all. A half-configured agent would fail
  // at run time with a configuration error.
  const agentsRoot = path.join(REPO_ROOT, 'agents')
  for (const name of fs.readdirSync(agentsRoot)) {
    const personaPath = path.join(agentsRoot, name, `${name}.md`)
    if (!fs.existsSync(personaPath)) continue
    const { frontmatter } = parseAgentFrontmatter(personaPath)
    const reading = readAgentModelChoice({
      ...(frontmatter.provider ? { provider: frontmatter.provider } : {}),
      ...(frontmatter.model ? { model: frontmatter.model } : {}),
    })
    assert.ok(
      reading.choice,
      `${name}: ${reading.error?.message ?? 'unreadable model selection'}`,
    )
  }
})

test('the research-team evidence critic keeps its own reasoning level', () => {
  const parsed = parseTeamConfig(path.join(REPO_ROOT, 'teams', 'research-team', 'team.yaml'))

  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.config)
  const critic = parsed.config.agents.find((agent) => agent.name === 'evidence-critic')
  assert.ok(critic)
  // Reasoning level belongs to the agent's own file. The team declares the
  // failure policy that bounds the critic, not the model it thinks with.
  assert.equal(
    parseAgentFrontmatter(
      path.join(REPO_ROOT, 'agents', 'evidence-critic', 'evidence-critic.md'),
    ).frontmatter.thinking,
    'high',
  )
  assert.equal(critic?.on_failure?.policy, 'retry')
  assert.equal(critic?.on_failure?.max_retries, 1)
})
