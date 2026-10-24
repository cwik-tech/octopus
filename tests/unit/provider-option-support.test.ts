/**
 * Which of an Agent's settings survive a switch to another provider.
 *
 * §4.3 of the model-selection plan requires options to be *re-evaluated* on an
 * approved switch to the application default, and forbids carrying incompatible
 * ones from the failed Agent's provider. Both halves matter. Carrying
 * everything sends a vendor's field to a vendor that does not have it; dropping
 * everything discards settings the new provider applies perfectly well, and
 * silently, which a person cannot tell apart from a provider ignoring them.
 *
 * Two kinds of setting are treated differently on purpose. A *behavioural*
 * setting says how the model should answer — how long, how hot, how hard to
 * think — and travels if the new provider applies it. Everything else names
 * where the request goes, who it claims to be from, what raw body to merge, or
 * what the process may do; none of that describes the model, and carrying it
 * across a provider switch would move an endpoint or a permission the person
 * approving a model never agreed to.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  behaviouralProviderOptions,
  retainCompatibleProviderOptions,
} from '../../providers/provider-option-support.js'

/**
 * A direct call at the middle thinking level.
 *
 * The level is stated rather than omitted because it is not optional: where an
 * adapter fills a setting in from it, a missing level would let the coupled
 * check be skipped by accident instead of decided.
 */
const direct = (provider: string) => ({
  provider,
  route: 'direct' as const,
  thinking: 'medium',
})

test('a setting the new provider applies travels with the approved pair', () => {
  // `providers/configured-provider.ts:134-138` reads exactly these two.
  const outcome = retainCompatibleProviderOptions(direct('connection:anything'), {
    max_tokens: 4_096,
    temperature: 0.2,
  })

  assert.deepEqual(outcome.kept, { max_tokens: 4_096, temperature: 0.2 })
  assert.deepEqual(outcome.dropped, [])
})

test('a setting the new provider does not apply is dropped, and named', () => {
  // A configured connection has no reasoning-effort field and no thinking
  // budget. Keeping them would claim a setting is in force when the adapter
  // never reads it.
  const outcome = retainCompatibleProviderOptions(direct('connection:anything'), {
    max_tokens: 4_096,
    thinking_budget: 2_048,
    reasoning: false,
  })

  assert.deepEqual(outcome.kept, { max_tokens: 4_096 })
  assert.deepEqual(
    outcome.dropped,
    ['reasoning', 'thinking_budget'],
    'a dropped setting is reported by name, so a person can see it stopped applying',
  )
})

test('an endpoint, an identity or a raw body never travels, even to a provider that reads it', () => {
  // The heart of the rule. `providers/openai.ts:73-86` really does honour
  // `base_url`, and the request is signed with the *parent's* credentials, so
  // carrying one across a switch would redirect those credentials somewhere the
  // person approving a model never agreed to. `extra_body` is arbitrary request
  // injection and `sandbox` is a process permission; neither describes a model.
  const outcome = retainCompatibleProviderOptions(direct('openai'), {
    base_url: 'https://elsewhere.example/v1',
    // A scalar, because that is all an Agent file can express
    // (`parsers/load-agent.ts:122-146`) — and a JSON string is exactly how
    // someone would try to smuggle a whole request body through one.
    extra_body: '{"tools":[]}',
    sandbox: 'danger-full-access',
    http_referer: 'https://elsewhere.example',
    max_output_tokens: 8_192,
  })

  assert.deepEqual(outcome.kept, { max_output_tokens: 8_192 })
  assert.deepEqual(outcome.dropped, [
    'base_url',
    'extra_body',
    'http_referer',
    'sandbox',
  ])
})

test('a provider that reads no settings at all keeps none', () => {
  // A CLI turn has no request body to write settings into, so approving one
  // would be a claim with nothing behind it.
  const outcome = retainCompatibleProviderOptions(direct('claude'), {
    max_tokens: 4_096,
    temperature: 0.2,
  })

  assert.deepEqual(outcome.kept, {})
  assert.deepEqual(outcome.dropped, ['max_tokens', 'temperature'])
})

test('nothing to re-evaluate is not the same as everything dropped', () => {
  assert.deepEqual(retainCompatibleProviderOptions(direct('openai'), undefined), {
    kept: undefined,
    dropped: [],
  })
  assert.deepEqual(retainCompatibleProviderOptions(direct('openai'), {}), {
    kept: {},
    dropped: [],
  })
})

test('each provider declares the behavioural settings its own adapter reads', () => {
  // Stated per provider rather than as one shared list, because the adapters
  // genuinely differ: the Responses API takes `max_output_tokens` and a
  // reasoning flag and applies neither `temperature` nor `top_p`, while a
  // configured connection applies `max_tokens` and `temperature` and has
  // neither of the others. A single list would be wrong for both.
  assert.deepEqual(
    [...behaviouralProviderOptions(direct('openai'))].sort(),
    ['max_output_tokens', 'max_tokens', 'reasoning'],
  )
  assert.deepEqual(
    [...behaviouralProviderOptions(direct('anthropic'))].sort(),
    ['max_tokens', 'temperature', 'thinking_budget'],
  )
  assert.deepEqual(
    [...behaviouralProviderOptions(direct('kimi-cli'))].sort(),
    ['max_steps_per_turn'],
  )
  assert.deepEqual([...behaviouralProviderOptions(direct('codex'))].sort(), [])
  // Every configured connection routes through the same adapter, so the answer
  // cannot depend on which connection it is.
  assert.deepEqual(
    [...behaviouralProviderOptions(direct('connection:one'))].sort(),
    [...behaviouralProviderOptions(direct('connection:two'))].sort(),
  )
})

test('an unknown provider is treated as reading nothing', () => {
  // The safe direction for a question this cannot answer: a setting that does
  // not travel is visible in the dropped list, while one invented for a
  // provider nobody has described would be a claim with nothing behind it.
  assert.deepEqual([...behaviouralProviderOptions(direct('not-a-provider'))], [])
})

// ── The value has to be one the adapter will actually use ───────────────────

test('a setting whose value the adapter would ignore is not reported as kept', () => {
  // An Agent file proves a setting is a scalar and nothing more
  // (`parsers/load-agent.ts:122-146`), while every adapter reads numbers
  // through `numberConfig`, which ignores anything that is not a finite number.
  // A string here does not survive the switch; it silently does nothing, and
  // saying it was kept would be the same false claim as carrying it.
  const outcome = retainCompatibleProviderOptions(direct('connection:anything'), {
    max_tokens: 'many',
    temperature: 0.2,
  })

  assert.deepEqual(outcome.kept, { temperature: 0.2 })
  assert.deepEqual(outcome.dropped, ['max_tokens'])
})

test('a flag the adapter reads as a boolean is not satisfied by the word for it', () => {
  // `providers/openai.ts:87` turns reasoning off only on an actual `false`.
  // The string 'false' is truthy, so the setting would read as its opposite.
  const outcome = retainCompatibleProviderOptions(direct('openai'), {
    reasoning: 'false',
  })

  assert.deepEqual(outcome.kept, {})
  assert.deepEqual(outcome.dropped, ['reasoning'])
})

test('a thinking budget outside its own bounds does not travel', () => {
  // Anthropic refuses a budget below 1024, and a budget at or above the
  // answer's own ceiling leaves no room for an answer. Both would be rejected
  // by the vendor, so neither is a setting that survived the switch.
  // Below the vendor's floor, whatever else is set.
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('anthropic'), {
      max_tokens: 8_192,
      thinking_budget: 512,
    }),
    { kept: { max_tokens: 8_192 }, dropped: ['thinking_budget'] },
  )
  // At the ceiling beside it, which leaves no room for an answer. The budget is
  // the explicit override that goes; the ceiling then has to hold the adapter's
  // own budget for this level, and 2048 is below `medium`'s 4096, so it goes too.
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('anthropic'), {
      max_tokens: 2_048,
      thinking_budget: 2_048,
    }),
    { kept: {}, dropped: ['max_tokens', 'thinking_budget'] },
  )
  // A pair that fits is left alone.
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('anthropic'), {
      max_tokens: 8_192,
      thinking_budget: 4_096,
    }),
    { kept: { max_tokens: 8_192, thinking_budget: 4_096 }, dropped: [] },
  )
})

// ── The route matters as much as the provider ───────────────────────────────

test('the parent MCP tool loop carries no settings, whatever the provider reads', () => {
  // `domains/provider/openai-chat-completions-tool-adapter.ts:137-149` sends
  // only the model, the messages, the tools and the tool choice, and
  // `services/mcp-agent-tool-service.ts:599-610` hands it no options at all.
  // The same pair that keeps `max_tokens` on a direct call keeps nothing here,
  // and reporting otherwise would describe a request that never carries it.
  const target = {
    provider: 'connection:anything',
    route: 'mcp-tool-loop' as const,
    thinking: 'medium',
  }

  assert.deepEqual([...behaviouralProviderOptions(target)], [])
  assert.deepEqual(
    retainCompatibleProviderOptions(target, { max_tokens: 4_096 }),
    { kept: {}, dropped: ['max_tokens'] },
  )
})

// ── Regressions ─────────────────────────────────────────────────────────────

test('every direct adapter that reads a behavioural setting is described here', () => {
  // `providers/xai.ts:61-62,79-80` applies both, and was missing — so a retry
  // onto xAI dropped two settings it would have honoured. Stated as an
  // enumeration rather than a spot check, because the failure mode is a
  // provider nobody remembered to add.
  for (const provider of ['xai', 'deepseek', 'kimi', 'lm-studio', 'openrouter']) {
    const applied = behaviouralProviderOptions(direct(provider))
    assert.ok(applied.has('max_tokens'), `${provider} applies max_tokens`)
    assert.ok(applied.has('temperature'), `${provider} applies temperature`)
  }
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('xai'), {
      max_tokens: 4_096,
      temperature: 0.2,
    }),
    { kept: { max_tokens: 4_096, temperature: 0.2 }, dropped: [] },
  )
})

test('a setting named after something on Object.prototype is refused, not inherited', () => {
  // An allow-list held in a plain object answers for `toString` and
  // `__proto__` as readily as for a real key, so a lookup that does not ask
  // for an *own* property will either hand back an inherited function and call
  // the setting supported, or hand back a non-function and throw. Both come
  // from an Agent file, which accepts any non-credential key name
  // (`parsers/load-agent.ts:122-146`).
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('openai'), {
      toString: 'x',
      valueOf: 1,
      constructor: true,
    }),
    { kept: {}, dropped: ['constructor', 'toString', 'valueOf'] },
  )
  // `JSON.parse` makes `__proto__` an *own* property rather than reaching the
  // prototype, which is how a parsed Agent file would deliver it. It is refused
  // like any other name the allow-list does not contain, and named, rather than
  // throwing on a lookup that found `Object.prototype` instead of a check.
  assert.deepEqual(
    retainCompatibleProviderOptions(
      direct('openai'),
      JSON.parse('{"__proto__":"x","max_tokens":4096}') as Record<string, unknown>,
    ),
    { kept: { max_tokens: 4_096 }, dropped: ['__proto__'] },
  )
  // The provider lookup has the same hazard from the other direction.
  assert.deepEqual([...behaviouralProviderOptions(direct('toString'))], [])
  assert.deepEqual([...behaviouralProviderOptions(direct('constructor'))], [])
})

test('a step ceiling the CLI would refuse is not reported as kept', () => {
  // `providers/kimi-cli.ts:135-137` passes `--max-steps-per-turn` only for a
  // whole number above zero, so anything else is dropped by the CLI itself.
  for (const value of [-1, 0, 1.5]) {
    assert.deepEqual(
      retainCompatibleProviderOptions(direct('kimi-cli'), {
        max_steps_per_turn: value,
      }),
      { kept: {}, dropped: ['max_steps_per_turn'] },
      `${value} is not a step ceiling the CLI applies`,
    )
  }
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('kimi-cli'), {
      max_steps_per_turn: 12,
    }),
    { kept: { max_steps_per_turn: 12 }, dropped: [] },
  )
})

test('the thinking budget is judged against what the request will actually carry', () => {
  // `providers/anthropic.ts:43-52,89-94` fills in both halves from the thinking
  // level when the Agent sets neither, so comparing only the two keys the Agent
  // happened to write answers a different question from the one that matters.
  //
  // At `low` the adapter's own ceiling is 4096, so an explicit budget of 8192
  // is above it — the vendor would refuse the request. It is not a setting that
  // survived the switch.
  assert.deepEqual(
    retainCompatibleProviderOptions(
      { provider: 'anthropic', route: 'direct', thinking: 'low' },
      { thinking_budget: 8_192 },
    ),
    { kept: {}, dropped: ['thinking_budget'] },
  )
  // The same budget is fine at `high`, where the ceiling is 12288.
  assert.deepEqual(
    retainCompatibleProviderOptions(
      { provider: 'anthropic', route: 'direct', thinking: 'high' },
      { thinking_budget: 8_192 },
    ),
    { kept: { thinking_budget: 8_192 }, dropped: [] },
  )
  // And the mirror image: a ceiling low enough that the adapter's *implicit*
  // budget for this thinking level no longer fits under it. Keeping it would
  // produce a request the vendor refuses, so it is dropped and named rather
  // than quietly clamped.
  assert.deepEqual(
    retainCompatibleProviderOptions(
      { provider: 'anthropic', route: 'direct', thinking: 'low' },
      { max_tokens: 512 },
    ),
    { kept: {}, dropped: ['max_tokens'] },
  )
  assert.deepEqual(
    retainCompatibleProviderOptions(
      { provider: 'anthropic', route: 'direct', thinking: 'low' },
      { max_tokens: 8_192 },
    ),
    { kept: { max_tokens: 8_192 }, dropped: [] },
  )
})

test('an override that is itself dropped does not vouch for the one beside it', () => {
  // The two settings have to be judged as the tuple the request will carry,
  // not one at a time. A budget of 0 is refused on its own terms — but if the
  // ceiling beside it is then judged against that same refused budget, a
  // ceiling of 512 looks fine, and the adapter goes on to send its own budget
  // of 4096 underneath it. The vendor refuses that request.
  // `thinking_budget: 0` is thinking *off*, not a budget below the floor, so
  // there is no budget for the ceiling beside it to have to accommodate. That
  // case is covered under "zero is a value, not an absence"; here the budget is
  // one the vendor refuses outright.
  assert.deepEqual(
    retainCompatibleProviderOptions(
      { provider: 'anthropic', route: 'direct', thinking: 'medium' },
      { max_tokens: 1_500, thinking_budget: 500 },
    ),
    { kept: {}, dropped: ['max_tokens', 'thinking_budget'] },
  )
  // A ceiling that leaves room for the adapter's own budget is kept, even
  // though the budget written beside it was refused.
  assert.deepEqual(
    retainCompatibleProviderOptions(
      { provider: 'anthropic', route: 'direct', thinking: 'medium' },
      { max_tokens: 8_192, thinking_budget: 500 },
    ),
    { kept: { max_tokens: 8_192 }, dropped: ['thinking_budget'] },
  )
})

test('zero is a value, not an absence', () => {
  // Two distinct hazards, both about a number that is falsy.
  //
  // `providers/anthropic.ts:89-120` resolves `thinking_budget` with `??`, so a
  // written 0 is kept as 0 rather than replaced by the level's default, and the
  // adapter then omits the thinking block entirely. Zero is how an Agent turns
  // thinking off on this provider — dropping it would turn thinking back on,
  // which is the opposite of what was asked for.
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('anthropic'), {
      thinking_budget: 0,
      max_tokens: 512,
    }),
    { kept: { thinking_budget: 0, max_tokens: 512 }, dropped: [] },
    'thinking off leaves no budget to fit under the ceiling',
  )
  // And a ceiling of zero is not a ceiling. The vendor refuses a request that
  // allows no output at all, so it is not a setting that survives.
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('anthropic'), { max_tokens: 0 }),
    { kept: {}, dropped: ['max_tokens'] },
  )
  assert.deepEqual(
    retainCompatibleProviderOptions(direct('connection:anything'), {
      max_tokens: 0,
    }),
    { kept: {}, dropped: ['max_tokens'] },
  )
})

test('a budget that is neither off nor above the vendor floor does not travel', () => {
  for (const value of [-1, 0.5, 512, 1_023]) {
    assert.deepEqual(
      retainCompatibleProviderOptions(direct('anthropic'), {
        max_tokens: 8_192,
        thinking_budget: value,
      }),
      { kept: { max_tokens: 8_192 }, dropped: ['thinking_budget'] },
      `${value} is neither off nor a budget Anthropic accepts`,
    )
  }
})
