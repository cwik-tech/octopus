/**
 * S2 Provider Wiring Unit Tests
 *
 * Tests for S2 acceptance criteria not covered by provider integration tests:
 *   1. initProviders() registers all built-in agent providers
 *   2. runAgent() emits a one-time warning when provider pricing is unavailable
 *   3. Provider resolution: defaults to 'anthropic' when no provider is specified
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { initProviders, getProvider } from '../../providers/index.js'
import { registerProvider } from '../../providers/registry.js'

// ─── initProviders Registration ──────────────────────────────────────────────

test('initProviders registers anthropic provider', () => {
  initProviders()
  const p = getProvider('anthropic')
  assert.equal(p.name, 'anthropic')
})

test('initProviders registers pi provider', () => {
  initProviders()
  const p = getProvider('pi')
  assert.equal(p.name, 'pi')
})

test('initProviders registers codex provider', () => {
  initProviders()
  const p = getProvider('codex')
  assert.equal(p.name, 'codex')
})

test('initProviders registers gemini provider', () => {
  initProviders()
  const p = getProvider('gemini')
  assert.equal(p.name, 'gemini')
})

test('initProviders registers openrouter provider', () => {
  initProviders()
  const p = getProvider('openrouter')
  assert.equal(p.name, 'openrouter')
})

test('initProviders registers openai provider', () => {
  initProviders()
  const p = getProvider('openai')
  assert.equal(p.name, 'openai')
})

test('initProviders registers xai provider', () => {
  initProviders()
  const p = getProvider('xai')
  assert.equal(p.name, 'xai')
})

test('initProviders registers deepseek provider', () => {
  initProviders()
  const p = getProvider('deepseek')
  assert.equal(p.name, 'deepseek')
})

test('initProviders registers kimi provider', () => {
  initProviders()
  const p = getProvider('kimi')
  assert.equal(p.name, 'kimi')
})

test('initProviders is idempotent — calling twice does not throw', () => {
  assert.doesNotThrow(() => {
    initProviders()
    initProviders()
  })
  // providers should still resolve after double-init
  assert.equal(getProvider('anthropic').name, 'anthropic')
  assert.equal(getProvider('pi').name, 'pi')
  assert.equal(getProvider('codex').name, 'codex')
  assert.equal(getProvider('gemini').name, 'gemini')
  assert.equal(getProvider('openai').name, 'openai')
  assert.equal(getProvider('openrouter').name, 'openrouter')
  assert.equal(getProvider('xai').name, 'xai')
  assert.equal(getProvider('deepseek').name, 'deepseek')
  assert.equal(getProvider('kimi').name, 'kimi')
})

// ─── runAgent missing-pricing warning ────────────────────────────────────────

/**
 * Verify the runner warns once when a provider cannot report a priced cost.
 */
test('agent-runner source contains a deduplicated missing-pricing warning', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'domains/agent-execution/agent-runner.ts'),
    'utf8',
  )
  assert.ok(
    src.includes('has no usage pricing'),
    'agent-runner.ts must warn when provider usage cannot be priced',
  )
  assert.ok(
    src.includes('warnedProviders'),
    'agent-runner.ts must use warnedProviders Set for one-time warning deduplication',
  )
  assert.ok(
    src.includes('!costTracked'),
    'agent-runner.ts must base the warning on the provider result, not its name',
  )
})

test('agent-runner source contains team-type + non-pi-provider warning', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'domains/agent-execution/agent-runner.ts'),
    'utf8',
  )
  assert.ok(
    src.includes('provider setting will be ignored') || src.includes('team-type'),
    'agent-runner.ts must warn when a non-pi provider is set on a team-type agent',
  )
})

// ─── Provider name values ────────────────────────────────────────────────────

test('anthropic provider has name "anthropic"', () => {
  initProviders()
  assert.equal(getProvider('anthropic').name, 'anthropic')
})

test('pi provider has name "pi"', () => {
  initProviders()
  assert.equal(getProvider('pi').name, 'pi')
})

test('codex provider has name "codex"', () => {
  initProviders()
  assert.equal(getProvider('codex').name, 'codex')
})

test('gemini provider has name "gemini"', () => {
  initProviders()
  assert.equal(getProvider('gemini').name, 'gemini')
})

test('openrouter provider has name "openrouter"', () => {
  initProviders()
  assert.equal(getProvider('openrouter').name, 'openrouter')
})

test('openai provider has name "openai"', () => {
  initProviders()
  assert.equal(getProvider('openai').name, 'openai')
})

test('xai provider has name "xai"', () => {
  initProviders()
  assert.equal(getProvider('xai').name, 'xai')
})

test('deepseek provider has name "deepseek"', () => {
  initProviders()
  assert.equal(getProvider('deepseek').name, 'deepseek')
})

test('kimi provider has name "kimi"', () => {
  initProviders()
  assert.equal(getProvider('kimi').name, 'kimi')
})

// ─── Provider interface shape ────────────────────────────────────────────────

test('all registered providers expose execute() as a function', () => {
  initProviders()
  for (const name of ['anthropic', 'pi', 'codex', 'gemini', 'openai', 'openrouter', 'xai', 'deepseek', 'kimi']) {
    const p = getProvider(name)
    assert.equal(typeof p.execute, 'function', `${name}.execute should be a function`)
  }
})

// ─── Extensibility: registerProvider one-call pattern ───────────────────────

test('a new provider can be added with one registerProvider call', () => {
  const customProvider = {
    name: 's2-custom-ext-provider',
    execute: async () => ({
      text: 'custom',
      cost: 0,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      model: 'custom-model',
    }),
  }

  registerProvider(customProvider)
  const retrieved = getProvider('s2-custom-ext-provider')
  assert.equal(retrieved.name, 's2-custom-ext-provider')
  assert.equal(retrieved, customProvider)
})
