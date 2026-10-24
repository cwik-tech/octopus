/**
 * The two-choice rule: an Agent runs with its own explicit provider/model
 * pair, or with the one application-wide default. Team membership is not an
 * input, and catalog order is never a fallback.
 */

import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PROVIDER_CHOSEN_DEFAULT_PROVIDERS,
  describeModelSelection,
  readAgentModelChoice,
  readModelSelectionRecord,
  resolveAgentModelChoice,
} from '../../contracts/agent-model-selection.js'

test('resolveAgentModelChoice runs an explicit agent pair exactly as chosen', () => {
  assert.deepEqual(
    resolveAgentModelChoice(
      { mode: 'explicit', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { status: 'available', provider: 'openrouter', model: 'openai/gpt-4o-mini' },
    ),
    {
      ok: true,
      selection: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        source: 'agent',
        reason: 'explicit-agent-choice',
      },
    },
  )
})

test('resolveAgentModelChoice reports the app default as the source in default mode', () => {
  assert.deepEqual(
    resolveAgentModelChoice(
      { mode: 'app-default' },
      { status: 'available', provider: 'openrouter', model: 'openai/gpt-4o-mini' },
    ),
    {
      ok: true,
      selection: {
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        source: 'app-default',
        reason: 'agent-default',
      },
    },
  )
})

test('resolveAgentModelChoice keeps an explicit pair explicit when it equals the app default', () => {
  const result = resolveAgentModelChoice(
    { mode: 'explicit', provider: 'openrouter', model: 'openai/gpt-4o-mini' },
    { status: 'available', provider: 'openrouter', model: 'openai/gpt-4o-mini' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.selection.source, 'agent')
  assert.equal(result.ok && result.selection.reason, 'explicit-agent-choice')
})

test('resolveAgentModelChoice refuses default mode when no default is configured', () => {
  assert.deepEqual(
    resolveAgentModelChoice({ mode: 'app-default' }, { status: 'unset' }),
    {
      ok: false,
      error: {
        code: 'app-default-unset',
        message:
          'No application default model is selected. Choose one in Settings → AI Providers.',
      },
    },
  )
})

test('resolveAgentModelChoice keeps an unavailable default identified instead of choosing another model', () => {
  const result = resolveAgentModelChoice(
    { mode: 'app-default' },
    {
      status: 'unavailable',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      detail: 'connection disabled',
    },
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'app-default-unavailable')
  assert.equal(!result.ok && result.error.provider, 'openrouter')
  assert.equal(!result.ok && result.error.model, 'openai/gpt-4o-mini')
})

test('resolveAgentModelChoice refuses a default that cannot serve the required capability', () => {
  const result = resolveAgentModelChoice(
    { mode: 'app-default' },
    {
      status: 'available',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      capabilities: ['chat'],
    },
    { requiredCapability: 'pdf' },
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'incompatible-capability')
})

test('readAgentModelChoice keeps a complete persona pair as an explicit choice', () => {
  assert.deepEqual(
    readAgentModelChoice({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    {
      choice: { mode: 'explicit', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      diagnostics: [],
    },
  )
})

test('readAgentModelChoice treats an empty persona as app-default mode', () => {
  assert.deepEqual(readAgentModelChoice({}), {
    choice: { mode: 'app-default' },
    diagnostics: [],
  })
})

test('readAgentModelChoice normalizes the legacy bare "default" model to app-default mode', () => {
  const reading = readAgentModelChoice({ model: 'default' })
  assert.deepEqual(reading.choice, { mode: 'app-default' })
  assert.deepEqual(
    reading.diagnostics.map((entry) => entry.code),
    ['legacy-default-sentinel'],
  )
})

test('readAgentModelChoice normalizes the legacy codex/default sentinel to app-default mode', () => {
  const reading = readAgentModelChoice({ provider: 'codex', model: 'default' })
  assert.deepEqual(reading.choice, { mode: 'app-default' })
  assert.deepEqual(
    reading.diagnostics.map((entry) => entry.code),
    ['legacy-builtin-default-pair'],
  )
})

test('readAgentModelChoice rejects a concrete model with no provider instead of guessing one', () => {
  const reading = readAgentModelChoice({ model: 'claude-sonnet-4-6' })
  assert.equal(reading.choice, undefined)
  assert.equal(reading.error?.code, 'agent-model-without-provider')
})

test('readAgentModelChoice rejects a provider that names no model at all', () => {
  const reading = readAgentModelChoice({ provider: 'gemini' })
  assert.equal(reading.choice, undefined)
  assert.equal(reading.error?.code, 'agent-provider-without-model')
})

test("readAgentModelChoice keeps a provider's own 'default' entry as an explicit, unpinned choice", () => {
  // A CLI agent's catalog offers a "let me choose" entry, and its adapter
  // implements it by leaving the model flag off the command line. Selecting
  // one is a deliberate choice of that provider, and must never be turned into
  // the application default — which would send a foreign model id to that CLI.
  // `codex` is the one exception, and it is checked separately below.
  for (const provider of PROVIDER_CHOSEN_DEFAULT_PROVIDERS) {
    const reading = readAgentModelChoice({ provider, model: 'default' })
    assert.deepEqual(
      reading.choice,
      { mode: 'explicit', provider, model: 'default' },
      provider,
    )
    assert.deepEqual(
      reading.diagnostics.map((entry) => entry.code),
      ['provider-chosen-default'],
      provider,
    )
  }
})

test("'default' is refused for a provider whose adapter cannot express it", () => {
  // An API adapter has no "omit the model" request. It puts whatever it is
  // given in the `model` field, so `openrouter/default` would ask OpenRouter
  // for a model literally named `default` and fail at the provider. Reading it
  // as a valid unpinned choice would promise a behaviour nothing implements,
  // so it is reported as the ambiguous legacy value it is.
  for (const provider of [
    'openrouter',
    'lm-studio',
    'anthropic',
    'openai',
    'deepseek',
    'xai',
    'kimi',
    'connection:some-endpoint',
  ]) {
    const reading = readAgentModelChoice({ provider, model: 'default' })
    assert.equal(reading.choice, undefined, provider)
    assert.equal(reading.error?.code, 'agent-provider-without-model', provider)
    assert.match(String(reading.error?.message), /choose its own model/i)
  }
})

test('the provider-chosen allowlist matches the adapters that actually omit the model', () => {
  // The contract is pure and cannot read the adapters, so this is what keeps
  // the two in step. Adding a CLI provider without an entry here, or listing
  // one whose adapter sends the literal string, breaks this test.
  assert.deepEqual(
    [...PROVIDER_CHOSEN_DEFAULT_PROVIDERS].sort(),
    ['claude', 'gemini', 'kimi-cli', 'pi', 'qwen'],
  )
})

test("only the built-in codex placeholder reads as inheritance", () => {
  // The asymmetry is deliberate and worth pinning: `codex/default` is the
  // sentinel shipped configurations used to mean "nothing chosen", while every
  // other provider's `default` names that provider's own entry.
  assert.deepEqual(readAgentModelChoice({ provider: 'codex', model: 'default' }).choice, {
    mode: 'app-default',
  })
  assert.deepEqual(readAgentModelChoice({ provider: 'claude', model: 'default' }).choice, {
    mode: 'explicit',
    provider: 'claude',
    model: 'default',
  })
})

// ─── Durable provenance ─────────────────────────────────────────────────────

test('readModelSelectionRecord accepts a complete persisted record', () => {
  assert.deepEqual(
    readModelSelectionRecord({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    }),
    {
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    },
  )
})

test('readModelSelectionRecord keeps the pair an approved retry displaced', () => {
  const record = readModelSelectionRecord({
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    source: 'app-default',
    reason: 'user-approved-retry',
    caller: 'agent',
    requestedProvider: 'anthropic',
    requestedModel: 'claude-sonnet-4-6',
  })
  assert.equal(record?.requestedProvider, 'anthropic')
  assert.equal(record?.requestedModel, 'claude-sonnet-4-6')
})

test('readModelSelectionRecord refuses anything it cannot fully read', () => {
  // A half-read record would let a notice claim something no execution
  // recorded, so a partial record is no record.
  for (const value of [
    null,
    'app-default',
    [],
    { provider: 'openrouter', source: 'app-default', reason: 'agent-default', caller: 'agent' },
    { provider: 'openrouter', model: 'm', source: 'team', reason: 'agent-default', caller: 'agent' },
    { provider: 'openrouter', model: 'm', source: 'agent', reason: 'invented', caller: 'agent' },
    { provider: 'openrouter', model: 'm', source: 'agent', reason: 'agent-default' },
    {
      provider: 'openrouter',
      model: 'm',
      source: 'app-default',
      reason: 'user-approved-retry',
      caller: 'agent',
      requestedProvider: 'anthropic',
    },
  ]) {
    assert.equal(readModelSelectionRecord(value), undefined, JSON.stringify(value))
  }
})

test('readModelSelectionRecord refuses a present but unreadable requested pair', () => {
  // A displaced pair that is present and unreadable is not the same as one that
  // was never recorded. Normalising both halves away turns a corrupt record into
  // a clean-looking one, and the notice then says an approved retry displaced
  // nothing. Both-invalid is the case that slips past a symmetry check alone.
  for (const requested of [
    { requestedProvider: 42, requestedModel: null },
    { requestedProvider: '', requestedModel: '' },
    { requestedProvider: '   ', requestedModel: '   ' },
    { requestedProvider: {}, requestedModel: [] },
    { requestedProvider: 42, requestedModel: 'claude-sonnet-4-6' },
    { requestedProvider: 'anthropic', requestedModel: null },
    // One unreadable half with the other half absent. A symmetry check alone
    // reads both as "nothing displaced" and lets the record through.
    { requestedProvider: 42 },
    { requestedModel: null },
  ]) {
    const value = {
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      source: 'app-default',
      reason: 'user-approved-retry',
      caller: 'agent',
      ...requested,
    }
    assert.equal(readModelSelectionRecord(value), undefined, JSON.stringify(value))
  }
})

test('readModelSelectionRecord still reads a record that never had a displaced pair', () => {
  // The rejection above must not swallow the ordinary record. An absent key and
  // an explicit undefined both mean "nothing was displaced", because a value of
  // undefined does not survive the JSON these records travel as.
  const base = {
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    source: 'app-default',
    reason: 'agent-default',
    caller: 'agent',
  } as const
  assert.equal(readModelSelectionRecord(base)?.provider, 'openrouter')
  assert.equal(
    readModelSelectionRecord({
      ...base,
      requestedProvider: undefined,
      requestedModel: undefined,
    })?.provider,
    'openrouter',
  )
})

test('describeModelSelection names the agent, the pair, and the reason', () => {
  assert.equal(
    describeModelSelection('Reviewer', {
      provider: 'OpenRouter',
      model: 'gpt-4o-mini',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    }),
    'Reviewer is using the app default: OpenRouter / gpt-4o-mini. Reason: no Agent model selected.',
  )
})

test('describeModelSelection does not call an explicit choice a default', () => {
  assert.equal(
    describeModelSelection('Reviewer', {
      provider: 'OpenRouter',
      model: 'gpt-4o-mini',
      source: 'agent',
      reason: 'explicit-agent-choice',
      caller: 'agent',
    }),
    'Reviewer used OpenRouter / gpt-4o-mini.',
  )
})
