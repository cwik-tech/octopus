/**
 * runAgent tells the operator, once per provider, that a provider's turns
 * cannot be priced.
 *
 * Real providers and real HTTP to a local scripted chat-completions server.
 * The server reports token usage but no cost, and no pricing is configured,
 * so each turn comes back untracked.
 *
 * agent-runner remembers which providers it has warned about for the life of
 * the process, so each test here uses providers no other test in this file
 * runs.
 */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { runAgent } from '../../domains/agent-execution/agent-runner.js'
import { MCP_WORKER_TURN_URL_ENV } from '../../domains/mcp/mcp-worker-turn.js'
import { globalCircuitBreaker } from '../../domains/runtime/circuit-breaker.js'
import { initProviders } from '../../providers/index.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

initProviders()

const MISSING_PRICING = 'has no usage pricing'

/** Set variables for one test and put the previous values back after it. */
function useEnvironment(
  t: TestContext,
  values: Readonly<Record<string, string | undefined>>,
): void {
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

/** Start the scripted model and route every chat-completions provider to it. */
async function startUnpricedModel(t: TestContext): Promise<string> {
  globalCircuitBreaker.resetAll()
  useEnvironment(t, {
    // Pricing from the environment would make the turn tracked.
    TEAM_PROVIDER_PRICING_JSON: undefined,
    [MCP_WORKER_TURN_URL_ENV]: undefined,
    DEEPSEEK_API_KEY: 'pricing-warning-deepseek-key',
    XAI_API_KEY: 'pricing-warning-xai-key',
    OPENROUTER_API_KEY: 'pricing-warning-openrouter-key',
    KIMI_API_KEY: 'pricing-warning-kimi-key',
    MOONSHOT_API_KEY: undefined,
  })
  const server = await startFakeChatCompletionsServer({
    script: [{ content: 'Answer from the scripted model.' }],
  })
  t.after(() => server.close())
  return `${server.url}/v1/chat/completions`
}

function runTurn(
  provider: string,
  providerConfig: Record<string, unknown>,
): ReturnType<typeof runAgent> {
  return runAgent({
    systemPrompt: 'You answer briefly.',
    userMessage: 'Say something.',
    model: 'scripted-model',
    thinking: 'low',
    provider,
    providerConfig,
  })
}

function missingPricingWarnings(
  calls: ReadonlyArray<{ readonly arguments: readonly unknown[] }>,
): string[] {
  return calls
    .map((call) => call.arguments[0])
    .filter((message): message is string =>
      typeof message === 'string' && message.includes(MISSING_PRICING),
    )
}

test('an unpriced provider is warned about once, however many turns it runs', async (t) => {
  const baseUrl = await startUnpricedModel(t)
  const warn = t.mock.method(console, 'warn')

  const first = await runTurn('deepseek', { base_url: baseUrl })
  const second = await runTurn('deepseek', { base_url: baseUrl })

  assert.equal(first.text, 'Answer from the scripted model.')
  assert.equal(second.text, 'Answer from the scripted model.')
  assert.equal(first.costTracked, false)
  assert.equal(second.costTracked, false)
  assert.deepEqual(missingPricingWarnings(warn.mock.calls), [
    "[team-runtime] Warning: provider 'deepseek' has no usage pricing. " +
      'Configure input_cost_per_million_usd and output_cost_per_million_usd ' +
      'before enabling a hard USD budget.',
  ])
})

test('a second unpriced provider gets its own warning after the first one warned', async (t) => {
  const baseUrl = await startUnpricedModel(t)
  const warn = t.mock.method(console, 'warn')

  await runTurn('xai', { base_url: baseUrl })
  await runTurn('openrouter', { base_url: baseUrl })
  await runTurn('xai', { base_url: baseUrl })

  const warnings = missingPricingWarnings(warn.mock.calls)
  assert.equal(warnings.length, 2, `expected one warning per provider, got: ${JSON.stringify(warnings)}`)
  assert.match(warnings[0] ?? '', /provider 'xai' has no usage pricing/)
  assert.match(warnings[1] ?? '', /provider 'openrouter' has no usage pricing/)
})

test('a provider whose usage is priced by its configuration is not warned about', async (t) => {
  const baseUrl = await startUnpricedModel(t)
  const warn = t.mock.method(console, 'warn')

  const result = await runTurn('kimi', {
    base_url: baseUrl,
    input_cost_per_million_usd: 1,
    output_cost_per_million_usd: 2,
  })

  assert.equal(result.costTracked, true)
  assert.equal(result.costSource, 'provider_config')
  assert.deepEqual(missingPricingWarnings(warn.mock.calls), [])
})
