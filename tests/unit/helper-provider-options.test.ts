/**
 * Which settings a helper request can carry, and what the values mean.
 *
 * A helper call is an Agent's turn like any other — the two Architects run on
 * their own agent files — so a setting that is valid in an Agent file has to
 * mean the same thing here as it does when that Agent runs anywhere else. Where
 * the two disagree, the same file is accepted on one path and refused on
 * another, and a person has no way to tell which reading is the real one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  helperProviderOptionTransport,
  mapHelperProviderOptions,
} from '../../domains/provider/model-client.js'

const ANTHROPIC = { kind: 'anthropic-messages' } as const

test('a thinking budget of zero is thinking off, not a budget below the floor', () => {
  // `providers/anthropic.ts:89-120` resolves the setting with `??`, so a
  // written 0 stays 0 and the adapter omits the thinking block entirely — which
  // is how an Agent turns extended thinking off. Refusing it here made the same
  // valid agent file stop an Architect turn before it sent anything, while
  // running fine everywhere else.
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 512 },
    { thinking_budget: 0, max_tokens: 512 },
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.equal(
    mapped.body.thinking,
    undefined,
    'thinking is off, not enabled with a budget nobody asked for',
  )
  assert.equal(mapped.body.max_tokens, 512)
})

test('a budget between zero and the vendor floor is still refused', () => {
  // Zero is a deliberate off switch; 512 is a budget Anthropic will not accept.
  // Widening the rule to admit one must not admit the other.
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 8192 },
    { thinking_budget: 512 },
  )

  assert.equal(mapped.ok, false)
  assert.equal('invalid' in mapped ? mapped.invalid : undefined, 'thinking_budget')
})

test('a budget with no room under its own ceiling is refused', () => {
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 8192 },
    { thinking_budget: 2048, max_tokens: 2048 },
  )

  assert.equal(mapped.ok, false)
  assert.equal('invalid' in mapped ? mapped.invalid : undefined, 'thinking_budget')
})

test('a valid budget is still enabled with the tokens it asked for', () => {
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 8192 },
    { thinking_budget: 2048, max_tokens: 8192 },
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.deepEqual(mapped.body.thinking, {
    type: 'enabled',
    budget_tokens: 2048,
  })
})

test('a thinking budget is refused by an endpoint that has no such field', () => {
  // The other side of the same rule: `thinking_budget` is Anthropic's, and
  // accepting it for a Chat Completions request would invent a field rather
  // than honour a setting.
  const mapped = mapHelperProviderOptions(
    { kind: 'chat-completions' },
    { thinking_budget: 0 },
  )

  assert.equal(mapped.ok, false)
  assert.equal(
    'unsupported' in mapped ? mapped.unsupported : undefined,
    'thinking_budget',
  )
})

test('a CLI provider names no transport, so nothing is mapped for it', () => {
  // A CLI turn has no request body to write settings into. Its own adapter
  // reads what it understands, so refusing here would remove a capability.
  assert.equal(helperProviderOptionTransport('claude'), undefined)
})

/**
 * A declared level is the answer where the Agent wrote none, and only there.
 *
 * The level says how much this Agent should think; a written `thinking_budget`
 * says exactly how much. The second is the more specific statement, so it wins
 * — for any value, not only the zero that turns thinking off. Reading it the
 * other way would let a level quietly overrule a number somebody chose.
 */
test('a written thinking budget wins over a declared level', () => {
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 20_000, thinking: 'high' },
    { thinking_budget: 2048 },
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.deepEqual(mapped.body.thinking, { type: 'enabled', budget_tokens: 2048 })
})

test('a declared level supplies the budget where the Agent wrote none', () => {
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 20_000, thinking: 'high' },
    undefined,
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  // The vendor's own number for that level, shared with the native adapter so
  // the two cannot drift.
  assert.deepEqual(mapped.body.thinking, { type: 'enabled', budget_tokens: 8192 })
})

test('the Agent’s own ceiling outranks the one the request would otherwise carry', () => {
  // A high level needs 8192, which does not fit under 5000 — but the Agent
  // named a larger ceiling, and its own setting is the more specific one. The
  // level fits under that, so the turn runs rather than being refused for a
  // limit nobody is using.
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 5000, thinking: 'high' },
    { max_tokens: 20_000 },
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.deepEqual(mapped.body.thinking, { type: 'enabled', budget_tokens: 8192 })
  assert.equal(mapped.body.max_tokens, 20_000)
})

test('a level whose budget cannot fit the ceiling is refused, naming both', () => {
  // Neither half is adjusted: raising the ceiling spends tokens nobody
  // authorised, and dropping the level answers at a depth the Agent did not
  // ask for. Refused as a conflict rather than as one setting's bad value,
  // because each is valid on its own.
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 5000, thinking: 'high', maxTokensLabel: 'the request limit' },
    undefined,
  )

  assert.equal(mapped.ok, false)
  const conflict = 'conflict' in mapped ? mapped.conflict : ''
  assert.match(conflict, /high/)
  assert.match(conflict, /8192/)
  assert.match(conflict, /5000/)
})

test('a declared level adds nothing to a Chat Completions request', () => {
  // Not a statement that this endpoint has no field for reasoning — it does,
  // and mapping it is its own work with its own evidence. What is pinned here
  // is only that Anthropic's `thinking` object, which this endpoint genuinely
  // does not take, is not sent to it.
  const mapped = mapHelperProviderOptions(
    { kind: 'chat-completions', maxTokens: 20_000, thinking: 'high' },
    undefined,
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.equal(mapped.body.thinking, undefined)
})

// ─── The widened effort vocabulary on the helper route ──────────────────────

const CHAT_COMPLETIONS = {
  kind: 'chat-completions',
  tokenParameter: 'max_completion_tokens',
  reasoningModel: true,
  model: 'gpt-5.5',
} as const

test('a widened level already travels this route unchanged', () => {
  // A characterization test, not a new capability: `model-client.ts` assigns
  // `transport.thinking` straight into the body, so it never capped the three
  // levels the rest of the application used to allow. Recorded here so that a
  // later change to the gates around it cannot quietly start capping them.
  const mapped = mapHelperProviderOptions(
    { ...CHAT_COMPLETIONS, thinking: 'xhigh' },
    undefined,
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.equal(mapped.body.reasoning_effort, 'xhigh')
})

test('an explicit provider default sends no effort at all', () => {
  const mapped = mapHelperProviderOptions(
    { ...CHAT_COMPLETIONS, thinking: 'provider-default' },
    undefined,
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.equal(
    mapped.body.reasoning_effort,
    undefined,
    'the literal words "provider-default" are not an effort level any vendor knows',
  )
})

test('thinking off is sent in the wire spelling this endpoint uses', () => {
  const mapped = mapHelperProviderOptions(
    { ...CHAT_COMPLETIONS, thinking: 'off' },
    undefined,
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.equal(mapped.body.reasoning_effort, 'none')
})

test('an Anthropic helper call refuses a level its budget table cannot express', () => {
  const mapped = mapHelperProviderOptions(
    { ...ANTHROPIC, maxTokens: 32_000, thinking: 'xhigh' },
    undefined,
  )

  assert.equal(mapped.ok, false, 'a level nobody can honour must not run at another depth')
})

test('a helper call honours off even when the older suppressor is set', () => {
  const mapped = mapHelperProviderOptions(
    { ...CHAT_COMPLETIONS, thinking: 'off' },
    { reasoning: false },
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.equal(mapped.body.reasoning_effort, 'none')
})

test('a helper call refuses a widened level that the suppressor would erase', () => {
  const mapped = mapHelperProviderOptions(
    { ...CHAT_COMPLETIONS, thinking: 'minimal' },
    { reasoning: false },
  )

  assert.equal(mapped.ok, false)
})

test('a helper call leaves the three legacy levels suppressed as before', () => {
  const mapped = mapHelperProviderOptions(
    { ...CHAT_COMPLETIONS, thinking: 'high' },
    { reasoning: false },
  )

  assert.ok(mapped.ok, JSON.stringify(mapped))
  assert.equal(mapped.body.reasoning_effort, undefined)
})
