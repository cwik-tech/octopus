import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateUsageCost } from '../../providers/cost.js'
import { applyCostTrackingPolicy } from '../../domains/agent-execution/agent-runner.js'
import { DEFAULT_SESSION_BUDGET_USD } from '../../core/constants.js'
import { ProviderError } from '../../domains/provider/provider-error.js'

test('calculateUsageCost prefers an API-reported cost, including zero', () => {
  assert.deepEqual(calculateUsageCost({
    provider: 'openrouter',
    model: 'model-a',
    inputTokens: 100,
    outputTokens: 50,
    reportedCost: 0,
  }), {
    cost: 0,
    tracked: true,
    source: 'reported',
  })
})

test('calculateUsageCost uses provider-configured per-million token rates', () => {
  const result = calculateUsageCost({
    provider: 'openai',
    model: 'priced-model',
    inputTokens: 2_000_000,
    outputTokens: 500_000,
    providerConfig: {
      input_cost_per_million_usd: 2,
      output_cost_per_million_usd: 8,
    },
  })
  assert.equal(result.cost, 8)
  assert.equal(result.tracked, true)
  assert.equal(result.source, 'provider_config')
})

test('calculateUsageCost supports exact and wildcard environment pricing', () => {
  const previous = process.env.TEAM_PROVIDER_PRICING_JSON
  process.env.TEAM_PROVIDER_PRICING_JSON = JSON.stringify({
    'deepseek:*': { inputPerMillion: 1, outputPerMillion: 3 },
    'deepseek:exact': { inputPerMillion: 2, outputPerMillion: 4 },
  })
  try {
    assert.equal(calculateUsageCost({
      provider: 'deepseek',
      model: 'exact',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }).cost, 6)
    assert.equal(calculateUsageCost({
      provider: 'deepseek',
      model: 'other',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }).cost, 4)
  } finally {
    if (previous === undefined) delete process.env.TEAM_PROVIDER_PRICING_JSON
    else process.env.TEAM_PROVIDER_PRICING_JSON = previous
  }
})

test('calculateUsageCost marks missing pricing as untracked', () => {
  const previous = process.env.TEAM_PROVIDER_PRICING_JSON
  delete process.env.TEAM_PROVIDER_PRICING_JSON
  try {
    assert.deepEqual(calculateUsageCost({
      provider: 'xai',
      model: 'unknown',
      inputTokens: 10,
      outputTokens: 20,
    }), {
      cost: 0,
      tracked: false,
      source: 'untracked',
    })
  } finally {
    if (previous !== undefined) process.env.TEAM_PROVIDER_PRICING_JSON = previous
  }
})

test('hard budgets fail closed when provider pricing is missing', () => {
  assert.throws(
    () => applyCostTrackingPolicy({
      provider: 'openai',
      costTracked: false,
      budgetPolicy: 'halt',
      text: 'result',
    }),
    (error) => error instanceof ProviderError && error.retryable === false,
  )
})

test('advisory budgets preserve output and disclose missing pricing', () => {
  const result = applyCostTrackingPolicy({
    provider: 'openai',
    costTracked: false,
    budgetPolicy: 'warn',
    text: 'result',
  })
  assert.match(result, /^result/)
  assert.match(result, /Budget tracking warning/)
})

// Characterization, not a new rule: a stage whose output is a machine contract
// only survives a configured budget because a tracked cost leaves the response
// text exactly as the provider wrote it.
test('a tracked cost returns the provider text with nothing appended', () => {
  const text = '{"schemaVersion":1,"decision":"APPROVE"}'
  assert.equal(
    applyCostTrackingPolicy({
      provider: 'openai',
      costTracked: true,
      budgetPolicy: 'warn',
      text,
    }),
    text,
  )
})

test('default session budget is finite', () => {
  assert.equal(Number.isFinite(DEFAULT_SESSION_BUDGET_USD), true)
  assert.ok(DEFAULT_SESSION_BUDGET_USD > 0)
})
