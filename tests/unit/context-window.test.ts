import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONNECTION_KINDS,
  CONTEXT_WINDOW_TABLE,
  contextWindowMayRefuse,
  resolveContextWindow,
} from '../../domains/provider/context-window.js'
import { contextLimit } from '../../core/context-limits.js'
import {
  HOST_ANTHROPIC_PROVIDER,
  HOST_CODEX_PROVIDER,
  HOST_OPENAI_PROVIDER,
  KNOWN_AGENT_PROVIDER_NAMES,
} from '../../domains/provider/provider-preflight.js'

test('the table answers for the first-party HTTP routes, which have no catalog at all', () => {
  // anthropic, openai, deepseek, xai and kimi are hardcoded URLs in
  // model-client.ts, not connections, so ProviderModelInfo never carries a
  // contextLength for them. If the table did not answer here, the most heavily
  // used route in the product would resolve to a guess.
  for (const provider of ['anthropic', 'openai', 'deepseek', 'xai', 'kimi']) {
    const resolved = resolveContextWindow({ provider, model: 'whatever-they-ship' })
    assert.equal(resolved.source, 'table', `${provider} fell through to ${resolved.source}`)
    assert.ok(resolved.tokens > 0)
  }
})

test('every provider the repo knows about has a table entry', () => {
  // Derived from the provider vocabulary rather than a list copied into this
  // file. A hardcoded list can only assert that the names someone remembered
  // are covered, which is how `openai-host` — a key no caller ever passes —
  // sat in the table looking like coverage while the real
  // `openai-responses-api` resolved to a guess.
  const known = [
    ...KNOWN_AGENT_PROVIDER_NAMES,
    HOST_ANTHROPIC_PROVIDER,
    HOST_OPENAI_PROVIDER,
    HOST_CODEX_PROVIDER,
  ]
  const missing = known.filter((provider) => !Object.hasOwn(CONTEXT_WINDOW_TABLE, provider))
  assert.deepEqual(missing, [], `providers with no window table entry: ${missing.join(', ')}`)
})

test('the table contains no key no caller can produce', () => {
  // The other half of coverage. A row keyed on a name nothing dispatches under
  // is dead weight that reads as coverage.
  const reachable = new Set<string>([
    ...KNOWN_AGENT_PROVIDER_NAMES,
    HOST_ANTHROPIC_PROVIDER,
    HOST_OPENAI_PROVIDER,
    HOST_CODEX_PROVIDER,
    // Connection kinds, reachable through the `connection:` prefix.
    'openrouter', 'openai-compatible', 'ollama', 'lm-studio',
  ])
  const unreachable = Object.keys(CONTEXT_WINDOW_TABLE).filter((key) => !reachable.has(key))
  assert.deepEqual(unreachable, [], `unreachable table keys: ${unreachable.join(', ')}`)
})

test('a model named in the table beats the provider default', () => {
  const opus = resolveContextWindow({ provider: 'claude', model: 'opus' })
  const unknown = resolveContextWindow({ provider: 'claude', model: 'not-a-model' })
  assert.equal(opus.tokens, 1_000_000)
  assert.equal(opus.source, 'table')
  assert.ok(unknown.tokens > 0, 'an unknown model still gets the provider default')
})

test('a live catalog window overrides the checked-in table', () => {
  // The table is a floor of coverage, not a claim to know better. Where a
  // connection actually reports the window of the model the user chose, that
  // is more specific than anything checked in months earlier.
  const resolved = resolveContextWindow({
    provider: 'openai-compatible',
    model: 'some-local-model',
    catalogContextLength: 42_000,
  })
  assert.equal(resolved.tokens, 42_000)
  assert.equal(resolved.source, 'catalog')
})

test("a window learned from a provider's own refusal beats everything", () => {
  const resolved = resolveContextWindow({
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    catalogContextLength: 42_000,
    learnedContextLength: 200_000,
  })
  assert.equal(resolved.tokens, 200_000)
  assert.equal(resolved.source, 'provider-error')
})

test('an unknown provider is assumed, and says so', () => {
  const resolved = resolveContextWindow({ provider: 'something-new', model: 'x' })
  assert.equal(resolved.tokens, contextLimit('window.assumedTokens'))
  assert.equal(resolved.source, 'assumed')
})

test('only a window we actually know may end a turn before dispatch', () => {
  // The whole product degrades silently today; nothing outside Deep Research
  // refuses. Turning a guess into a refusal would be a new user-visible
  // failure built on two guesses — an assumed window and a byte estimate.
  assert.equal(contextWindowMayRefuse('table'), true)
  assert.equal(contextWindowMayRefuse('catalog'), true)
  assert.equal(contextWindowMayRefuse('provider-error'), true)
  assert.equal(contextWindowMayRefuse('assumed'), false)
})

test('a non-positive or absurd catalog value is ignored rather than trusted', () => {
  for (const bad of [0, -1, Number.NaN, 10]) {
    const resolved = resolveContextWindow({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      catalogContextLength: bad,
    })
    assert.equal(resolved.source, 'table', `catalog value ${bad} should have been ignored`)
  }
})

test('the output ceiling is reported where a route states one', () => {
  // Nothing in ProviderModelInfo records a model's maximum output, so a derived
  // reserve sent as max_tokens can exceed what the route accepts. The table
  // carries it so the reserve can be clamped.
  const resolved = resolveContextWindow({ provider: 'anthropic', model: 'claude-sonnet-5' })
  assert.ok(
    resolved.maxOutputTokens !== undefined && resolved.maxOutputTokens > 0,
    'anthropic should state an output ceiling',
  )
  assert.ok(resolved.maxOutputTokens < resolved.tokens)
})

test('a real model id resolves to its row, not just the CLI alias', () => {
  // Table rows were keyed on CLI aliases (opus, sonnet) while configurations
  // carry full ids like claude-opus-4-6. Exact matching meant every real model
  // fell through to the route default, so the 1M-token rows were unreachable
  // from the actual call path and the resolver quietly under-promised.
  for (const model of ['claude-opus-4-6', 'claude-opus-4-1-20250805', 'opus']) {
    const resolved = resolveContextWindow({ provider: 'claude', model })
    assert.equal(resolved.tokens, 1_000_000, `${model} should resolve to the opus row`)
  }
  for (const model of ['claude-sonnet-5', 'sonnet']) {
    assert.equal(resolveContextWindow({ provider: 'claude', model }).tokens, 1_000_000)
  }
  // Haiku is a 200k model and must not be caught by a looser match.
  assert.equal(resolveContextWindow({ provider: 'claude', model: 'claude-haiku-4-5' }).tokens, 200_000)
})

test('the host provider aliases resolve, because those are the names in use', () => {
  // normalizeRepoHostProvider rewrites anthropic/openai/codex to these before
  // dispatch, so a table keyed only on the short names never matches.
  for (const provider of ['anthropic-api', 'openai-responses-api', 'openai-codex']) {
    const resolved = resolveContextWindow({ provider, model: 'whatever' })
    assert.notEqual(resolved.source, 'assumed', `${provider} resolved to a guess`)
  }
})

test('a connection-routed provider resolves to its connection kind', () => {
  // Chat speakers on a user connection carry provider 'connection:<id>'. Without
  // normalization every one of them resolved to the assumed window, which can
  // never refuse — silently disabling admission for that whole route.
  const withKind = resolveContextWindow({
    provider: 'connection:abc123',
    model: 'llama-3',
    connectionKind: 'lm-studio',
  })
  assert.equal(withKind.source, 'table')
  assert.equal(withKind.tokens, 32_000)

  // Without a stated kind it takes the smallest window any connection kind
  // claims. A connection is as likely to be a local model as a hosted endpoint,
  // and guessing the larger over-promises exactly the users who cannot absorb
  // it: a local model that overflows fails outright, while a hosted one merely
  // gets a shorter prompt than it could have read.
  const withoutKind = resolveContextWindow({ provider: 'connection:abc123', model: 'llama-3' })
  assert.equal(withoutKind.source, 'table')
  assert.equal(withoutKind.tokens, 32_000)
})

test('an older generation does not inherit a newer one\'s window', () => {
  // Segment matching made every `sonnet` a 1M `sonnet`, including
  // claude-3-5-sonnet-20241022, whose real window is 200k. Over-promising is
  // the one direction this module must not fail in: under-promising trims a
  // prompt that would have fitted, while over-promising sends a request the
  // provider refuses outright.
  assert.equal(resolveContextWindow({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }).tokens, 200_000)
  assert.equal(resolveContextWindow({ provider: 'anthropic', model: 'claude-3-opus-20240229' }).tokens, 200_000)

  // The current generations still resolve to their real windows.
  assert.equal(resolveContextWindow({ provider: 'anthropic', model: 'claude-opus-4-6' }).tokens, 1_000_000)
  assert.equal(resolveContextWindow({ provider: 'anthropic', model: 'claude-sonnet-5' }).tokens, 1_000_000)

  // A bare alias names whatever is current, so it keeps the row's window.
  assert.equal(resolveContextWindow({ provider: 'anthropic', model: 'opus' }).tokens, 1_000_000)
  assert.equal(resolveContextWindow({ provider: 'anthropic', model: 'sonnet' }).tokens, 1_000_000)
})

test('the unknown-kind fallback really is the smallest connection window', () => {
  // The fallback is computed from the kind list rather than named, so a kind
  // added later with a smaller window becomes the fallback on its own. This
  // pins that invariant: naming one would have gone stale silently.
  const unknown = resolveContextWindow({ provider: 'connection:unknown', model: 'x' })
  for (const kind of CONNECTION_KINDS) {
    const known = resolveContextWindow({
      provider: 'connection:abc',
      model: 'x',
      connectionKind: kind,
    })
    assert.ok(
      unknown.tokens <= known.tokens,
      `unknown-kind resolved ${unknown.tokens}, larger than ${kind}'s ${known.tokens}`,
    )
  }
})

test('the kind list matches the connection kinds the settings layer defines', () => {
  // These have to agree or the fallback is computed over the wrong set.
  assert.deepEqual(
    [...CONNECTION_KINDS].sort(),
    ['lm-studio', 'ollama', 'openai-compatible', 'openrouter'],
  )
})
