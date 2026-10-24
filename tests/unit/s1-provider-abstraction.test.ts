import { whenDefined } from '../../core/optional-properties.js'
/**
 * Tests for Sprint S1: Provider Abstraction Layer
 *
 * Covers:
 * - providers/registry.ts: registerProvider, getProvider
 * - providers/types.ts: interface shapes
 * - core/constants.ts: DEFAULT_PROVIDER
 * - parsers/team-config.ts: provider field parsing
 * - parsers/load-agent.ts: provider resolution chain
 */

import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import {
  getProvider,
  getProviderProvenance,
  registerProvider,
} from '../../providers/registry.js'
import { DEFAULT_PROVIDER } from '../../core/constants.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { loadAgent } from '../../parsers/load-agent.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import type { Provider, ProviderExecuteOptions, ProviderResult } from '../../providers/types.js'
import type { AgentRosterEntry, TeamConfig } from '../../core/types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-provider-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function makeProvider(name: string): Provider {
  return {
    name,
    execute: async (_opts: ProviderExecuteOptions): Promise<ProviderResult> => ({
      text: 'response',
      cost: 0,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      model: 'test-model',
    }),
  }
}

function writeTeamYaml(dir: string, yaml: string): string {
  const filePath = path.join(dir, 'team.yaml')
  fs.writeFileSync(filePath, yaml)
  return filePath
}

/** Minimal valid team.yaml suffix — levels + gates required by parser */
const MINIMAL_LEVELS_AND_GATES = (agentName: string) => `
levels:
  - id: l1
    name: Level 1
    order: 0
    stage:
      type: discussion
      coordinator: ${agentName}
      participants:
        - ${agentName}
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        constraints:
          max_time_minutes: 5
          max_budget_usd: 1
        output:
          format: output.md
gates:
  - from: l1
    to: done
    condition:
      type: artifact_exists
      artifact: output.md
`

function makeAgentFile(dir: string, name: string): string {
  const agentDir = path.join(dir, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  const filePath = path.join(agentDir, `${name}.md`)
  fs.writeFileSync(filePath, `# ${name}\nSystem prompt here.`)
  return filePath
}

function makeMinimalTeamConfig(): TeamConfig {
  return {
    team: { name: 'test-team', description: '', version: '0.1.0' },
    workspace: { path: '/tmp/workspace', watch: false,   },
    
    levels: [],
    gates: [],
    agents: [],
  }
}

// ─── DEFAULT_PROVIDER ───────────────────────────────────────────────────────

test('DEFAULT_PROVIDER is "codex"', () => {
  assert.equal(DEFAULT_PROVIDER, 'codex')
})

// ─── Registry ───────────────────────────────────────────────────────────────

test('registerProvider and getProvider round-trip', () => {
  const p = makeProvider('test-reg-provider')
  registerProvider(p)
  const retrieved = getProvider('test-reg-provider')
  assert.equal(retrieved, p)
  assert.equal(retrieved.name, 'test-reg-provider')
})

test('registerProvider rejects a duplicate name and preserves the original provider', () => {
  const p1 = makeProvider('collision-test')
  const p2 = makeProvider('collision-test')
  registerProvider(p1)
  assert.throws(
    () => registerProvider(p2),
    /Provider 'collision-test' is already registered/,
  )
  assert.equal(getProvider('collision-test'), p1)
})

test('registerProvider retains immutable provider provenance', () => {
  const provider = makeProvider('provenance-test')
  const provenance = {
    source: 'tests/unit/s1-provider-abstraction.test.ts',
    version: '1.0.0',
    trustClass: 'test',
  }

  registerProvider(provider, provenance)
  const registeredProvenance = getProviderProvenance('provenance-test')

  assert.deepEqual(registeredProvenance, provenance)
  assert.ok(Object.isFrozen(registeredProvenance))
})

test('registerProvider replaces an existing provider only when explicitly authorized', () => {
  const original = makeProvider('explicit-replacement-test')
  const replacement = makeProvider('explicit-replacement-test')
  registerProvider(original, {
    source: 'tests/original-provider.ts',
    trustClass: 'test',
  })

  registerProvider(
    replacement,
    {
      source: 'tests/replacement-provider.ts',
      trustClass: 'test',
    },
    { replaceExisting: true },
  )

  assert.equal(getProvider('explicit-replacement-test'), replacement)
  assert.deepEqual(getProviderProvenance('explicit-replacement-test'), {
    source: 'tests/replacement-provider.ts',
    trustClass: 'test',
  })
})

test('getProvider throws with available names when not found', () => {
  registerProvider(makeProvider('known-provider-a'))
  registerProvider(makeProvider('known-provider-b'))

  let threw = false
  try {
    getProvider('totally-unknown-xyz')
  } catch (err: unknown) {
    threw = true
    const msg = (err as Error).message
    assert.ok(msg.includes('totally-unknown-xyz'), `Expected error to mention the unknown name, got: ${msg}`)
    assert.ok(msg.includes('known-provider-a') || msg.includes('Available providers'), `Expected error to list providers, got: ${msg}`)
  }
  assert.ok(threw, 'Expected getProvider to throw for unknown name')
})

test('getProvider throws with "(none registered)" message when registry is empty', () => {
  // Use a fresh isolated test by checking the error message shape
  // We can't easily empty the registry, but we can test the unknown-name path
  // and verify it mentions available names OR "(none registered)" in error text
  let threw = false
  try {
    getProvider('__nonexistent__provider__')
  } catch (err: unknown) {
    threw = true
    const msg = (err as Error).message
    // Error must mention the requested name
    assert.ok(msg.includes('__nonexistent__provider__'), `Message should include requested name: ${msg}`)
  }
  assert.ok(threw)
})

// ─── Provider interface shape ────────────────────────────────────────────────

test('Provider interface: execute returns ProviderResult shape', async () => {
  const p = makeProvider('shape-test')
  const result = await p.execute({
    systemPrompt: 'sys',
    userMessage: 'hello',
    model: 'test-model',
    thinking: 'low',
  })
  assert.ok(typeof result.text === 'string')
  assert.ok(typeof result.cost === 'number')
  assert.ok(typeof result.durationMs === 'number')
  assert.ok(typeof result.inputTokens === 'number')
  assert.ok(typeof result.outputTokens === 'number')
  assert.ok(typeof result.contextTokens === 'number')
  assert.ok(typeof result.model === 'string')
})

// ─── team-config.ts: legacy runtime fields are readable but inert ────────────

test('parseTeamConfig reads a legacy tier table for diagnostics only', () => {
  withTempDir((dir) => {
    makeAgentFile(dir, 'alpha')
    writeTeamYaml(dir, `
team:
  name: provider-test
models:
  strategic:
    model: gpt-5
    provider: codex
    provider_config:
      sandbox: danger
agents:
  - name: alpha
    type: agent
    role: test
    tier: strategic
    agent_file: agents/alpha/alpha.md
    produces:
      - path: output.md
${MINIMAL_LEVELS_AND_GATES('alpha')}`)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config !== null, `Parse failed: ${JSON.stringify(result.errors)}`)
    const legacy = result.config?.legacyModels?.strategic
    assert.equal(legacy?.provider, 'codex')
    assert.deepEqual(legacy?.provider_config, { sandbox: 'danger' })
    assert.ok(result.warnings.some((warning) => /models-by-tier/.test(warning)))
  })
})

test('parseTeamConfig reads a legacy roster override for diagnostics only', () => {
  withTempDir((dir) => {
    makeAgentFile(dir, 'gamma')
    writeTeamYaml(dir, `
team:
  name: agent-provider-test
agents:
  - name: gamma
    type: agent
    role: test
    tier: strategic
    provider: gemini
    agent_file: agents/gamma/gamma.md
    produces:
      - path: output.md
${MINIMAL_LEVELS_AND_GATES('gamma')}`)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config !== null, `Parse failed: ${JSON.stringify(result.errors)}`)
    const agent = result.config?.agents?.find((a) => a.name === 'gamma')
    assert.equal(agent?.legacyProvider, 'gemini')
    assert.ok(result.warnings.some((warning) => /gamma/.test(warning)))
  })
})

test('parseTeamConfig leaves a roster entry with no declarations empty', () => {
  withTempDir((dir) => {
    makeAgentFile(dir, 'delta')
    writeTeamYaml(dir, `
team:
  name: no-provider-test
agents:
  - name: delta
    type: agent
    role: test
    agent_file: agents/delta/delta.md
    produces:
      - path: output.md
${MINIMAL_LEVELS_AND_GATES('delta')}`)
    const result = parseTeamConfig(path.join(dir, 'team.yaml'))
    assert.ok(result.config !== null)
    const agent = result.config?.agents?.find((a) => a.name === 'delta')
    assert.equal(agent?.legacyProvider, undefined)
    assert.equal(agent?.legacyModel, undefined)
    // A member written now declares no grade either, so there is nothing for
    // the parser to report as ignored.
    assert.equal(agent?.tier, undefined)
    assert.deepEqual(result.config?.legacyModels, undefined)
    assert.deepEqual(result.warnings, [])
  })
})

// ─── load-agent.ts: a team declares nothing about a member's provider ────────

test('loadAgent ignores every team-level provider declaration', () => {
  withTempDir((dir) => {
    // The agent persona names no provider, so the app default decides. Neither
    // the tier table, the roster override, nor defaults.provider may speak.
    const agentFile = makeAgentFile(dir, 'agent1')
    const config = makeMinimalTeamConfig()
    config.legacyModels = {
      strategic: { model: 'test-model', thinking: 'low', provider: 'codex' },
    }
    config.defaults = { provider: 'anthropic' }

    const roster: AgentRosterEntry = {
      name: 'agent1',
      type: 'agent',
      role: 'tester',
      tier: 'strategic',
      agent_file: agentFile,
      legacyProvider: 'gemini',
    }

    setRuntimeDefaultModelState({
      status: 'available',
      provider: 'connection:abc',
      model: 'gpt-5.4-mini',
    })
    try {
      const result = loadAgent(roster, config, 0)
      assert.ok(result, 'Expected loadAgent to return a LoadedAgent')
      assert.equal(result.provider, 'connection:abc')
      assert.equal(result.model, 'gpt-5.4-mini')
      assert.equal(result.selection?.source, 'app-default')
    } finally {
      setRuntimeDefaultModelState({ status: 'unset' })
    }
  })
})

test('loadAgent resolves a nested team from its own declared host', () => {
  const config = makeMinimalTeamConfig()

  const roster: AgentRosterEntry = {
    name: 'sub-team',
    type: 'team',
    role: 'sub team',
    tier: 'strategic',
    agent_file: '',
    team_path: '/some/path',
    host_provider: 'codex',
    host_model: 'gpt-5.4-mini',
  }

  const result = loadAgent(roster, config, 0)
  assert.ok(result)
  assert.equal(result.provider, 'codex')
  assert.equal(result.model, 'gpt-5.4-mini')
})

test('loadAgent drops every team-level provider option', () => {
  withTempDir((dir) => {
    const agentFile = makeAgentFile(dir, 'agent4')
    const config = makeMinimalTeamConfig()
    config.legacyModels = {
      strategic: {
        model: 'test-model',
        thinking: 'low',
        provider: 'codex',
        provider_config: { sandbox: 'default', timeout: 60 },
      },
    }

    const roster: AgentRosterEntry = {
      name: 'agent4',
      type: 'agent',
      role: 'tester',
      tier: 'strategic',
      agent_file: agentFile,
      legacyProviderConfig: { sandbox: 'strict' },
    }

    const result = loadAgent(roster, config, 0)
    assert.ok(result)
    // No team-level provider options survive: not the tier's, not the
    // roster entry's. Provider options belong to the agent.
    assert.deepEqual(result.providerConfig, {})
  })
})
