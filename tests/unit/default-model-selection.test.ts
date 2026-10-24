/**
 * Tests for domains/provider/default-model-selection.ts — the transport that
 * carries the one application default, and its state, to every process that
 * admits an execution.
 *
 * The transported value is a *state*, not a pair: a configured-but-unavailable
 * default must stay identifiable so the user is told which selection is broken
 * instead of being moved silently onto a different model.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { AppDefaultModelState } from '../../contracts/agent-model-selection.js'
import {
  defaultModelStateEnvironment,
  getRuntimeDefaultModelState,
  runtimeAppDefaultPair,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import { DEFAULT_MODEL_SELECTION_ENV } from '../../domains/provider/provider-settings.js'

const AVAILABLE: AppDefaultModelState = {
  status: 'available',
  provider: 'connection:abc',
  model: 'gpt-5.4-mini',
}

function withEnvironment(encoded: string | undefined, fn: () => void): void {
  const original = process.env[DEFAULT_MODEL_SELECTION_ENV]
  if (encoded === undefined) delete process.env[DEFAULT_MODEL_SELECTION_ENV]
  else process.env[DEFAULT_MODEL_SELECTION_ENV] = encoded
  setRuntimeDefaultModelState(undefined)
  try {
    fn()
  } finally {
    if (original === undefined) delete process.env[DEFAULT_MODEL_SELECTION_ENV]
    else process.env[DEFAULT_MODEL_SELECTION_ENV] = original
    setRuntimeDefaultModelState({ status: 'unset' })
  }
}

test('an unconfigured process reports the default as unset', () => {
  withEnvironment(undefined, () => {
    assert.deepEqual(getRuntimeDefaultModelState(), { status: 'unset' })
    assert.equal(runtimeAppDefaultPair(), null)
  })
})

test('an available default round-trips to a child process unchanged', () => {
  const environment = defaultModelStateEnvironment(AVAILABLE)
  withEnvironment(environment[DEFAULT_MODEL_SELECTION_ENV], () => {
    assert.deepEqual(getRuntimeDefaultModelState(), AVAILABLE)
    assert.deepEqual(runtimeAppDefaultPair(), {
      provider: 'connection:abc',
      model: 'gpt-5.4-mini',
    })
  })
})

test('a configured but unavailable default keeps its identity in the child process', () => {
  // Erasing the pair here would let a child re-resolve some other model. The
  // child must be able to say *which* default is broken.
  const unavailable: AppDefaultModelState = {
    status: 'unavailable',
    provider: 'connection:abc',
    model: 'gpt-5.4-mini',
    detail: 'connection disabled',
  }
  const environment = defaultModelStateEnvironment(unavailable)
  withEnvironment(environment[DEFAULT_MODEL_SELECTION_ENV], () => {
    assert.deepEqual(getRuntimeDefaultModelState(), unavailable)
    assert.equal(runtimeAppDefaultPair(), null)
  })
})

test('an unset default publishes no environment variable', () => {
  assert.deepEqual(defaultModelStateEnvironment({ status: 'unset' }), {})
})

test('a malformed environment payload is rejected rather than trusted', () => {
  for (const payload of [
    'not-base64-json',
    Buffer.from('{"status":"available"}', 'utf8').toString('base64'),
    Buffer.from('{"status":"nonsense","provider":"p","model":"m"}', 'utf8').toString('base64'),
    Buffer.from('{"provider":123,"model":null}', 'utf8').toString('base64'),
    Buffer.from('[]', 'utf8').toString('base64'),
  ]) {
    withEnvironment(payload, () => {
      assert.deepEqual(getRuntimeDefaultModelState(), { status: 'unset' })
    })
  }
})

test('a legacy bare provider/model payload is read as an available default', () => {
  const legacy = Buffer.from(
    JSON.stringify({ provider: 'connection:abc', model: 'gpt-5.4-mini' }),
    'utf8',
  ).toString('base64')
  withEnvironment(legacy, () => {
    assert.deepEqual(getRuntimeDefaultModelState(), AVAILABLE)
  })
})

test('setting the state in-process also updates the environment for children', () => {
  setRuntimeDefaultModelState(AVAILABLE)
  try {
    const encoded = process.env[DEFAULT_MODEL_SELECTION_ENV]
    assert.ok(encoded)
    assert.deepEqual(
      JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')),
      AVAILABLE,
    )
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
  }
  assert.equal(process.env[DEFAULT_MODEL_SELECTION_ENV], undefined)
})
