/**
 * The generic run-chat assistant owns no agent persona, so it runs on the one
 * application default unless the user picks a pair for that single turn.
 *
 * Two things have to stay distinct here. An ad hoc pick belongs to the user,
 * not to an agent, so history must never label it a persona choice. And the
 * legacy `codex/default` composer value means "app default" under this
 * repository's own reading rule — it must resolve the deliberate default, not
 * quietly reach the Codex CLI and let it pick a model nobody selected.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { AppDefaultModelState } from '../../contracts/agent-model-selection.js'
import { resolveReceptionistModelSelection } from '../../domains/sessions/chat-llm.js'

const AVAILABLE: AppDefaultModelState = {
  status: 'available',
  provider: 'connection:abc',
  model: 'gpt-5.4-mini',
}

test('an ad hoc user pick is used unchanged and recorded as the user\'s choice', () => {
  const result = resolveReceptionistModelSelection({
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    appDefault: AVAILABLE,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.selection, {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    source: 'user',
    reason: 'explicit-user-choice',
    caller: 'generic-chat',
  })
})

test('no pick resolves the one application default', () => {
  const result = resolveReceptionistModelSelection({ appDefault: AVAILABLE })

  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.selection, {
    provider: 'connection:abc',
    model: 'gpt-5.4-mini',
    source: 'app-default',
    reason: 'agent-default',
    caller: 'generic-chat',
  })
})

test("the legacy 'codex/default' composer value means the app default, not the Codex CLI", () => {
  const result = resolveReceptionistModelSelection({
    provider: 'codex',
    model: 'default',
    appDefault: AVAILABLE,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.selection.provider, 'connection:abc')
  assert.equal(result.ok && result.selection.model, 'gpt-5.4-mini')
  assert.equal(result.ok && result.selection.source, 'app-default')
})

test('an unset default is reported, not replaced by a built-in fallback pair', () => {
  const result = resolveReceptionistModelSelection({ appDefault: { status: 'unset' } })

  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'app-default-unset')
})

test('an unavailable default still names the broken pair', () => {
  const result = resolveReceptionistModelSelection({
    appDefault: {
      status: 'unavailable',
      provider: 'connection:abc',
      model: 'gpt-5.4-mini',
      detail: 'connection removed',
    },
  })

  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'app-default-unavailable')
  assert.equal(!result.ok && result.error.provider, 'connection:abc')
  assert.equal(!result.ok && result.error.model, 'gpt-5.4-mini')
})

test("a provider the user picked keeps its own provider-chosen entry", () => {
  const result = resolveReceptionistModelSelection({
    provider: 'claude',
    model: 'default',
    appDefault: AVAILABLE,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.selection.provider, 'claude')
  assert.equal(result.ok && result.selection.model, 'default')
  assert.equal(result.ok && result.selection.source, 'user')
})

test('a model with no provider is refused rather than completed by guesswork', () => {
  const result = resolveReceptionistModelSelection({
    model: 'gpt-5.4-mini',
    appDefault: AVAILABLE,
  })

  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'agent-model-without-provider')
})
