/**
 * Carrying one approved retry into the process that dispatches the agent.
 *
 * The approval is made in the API process; the agent runs in a child. What
 * travels is an authorization, not a configuration: no team config is merged,
 * no roster entry is rewritten, and it names the one agent and the exact pair
 * the user was shown. Anything that is not a complete, well-formed payload is
 * read as "no authorization", which leaves the agent running on its own pair —
 * the same outcome as before the approval, and the safe direction.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { ApprovedModelChoiceAuthorization } from '../../contracts/model-choice.js'
import {
  APPROVED_MODEL_CHOICE_ENV,
  approvedModelChoiceEnvironment,
  getRuntimeApprovedModelChoice,
  setRuntimeApprovedModelChoice,
} from '../../domains/provider/approved-model-choice.js'

const AUTHORIZATION: ApprovedModelChoiceAuthorization = {
  offerId: 'offer-1',
  agentName: 'reviewer',
  failedChoice: { provider: 'anthropic', model: 'claude-opus-4-6' },
  proposedDefault: { provider: 'connection:abc', model: 'gpt-5.4-mini' },
}

function withEnvironment(encoded: string | undefined, fn: () => void): void {
  const original = process.env[APPROVED_MODEL_CHOICE_ENV]
  if (encoded === undefined) delete process.env[APPROVED_MODEL_CHOICE_ENV]
  else process.env[APPROVED_MODEL_CHOICE_ENV] = encoded
  setRuntimeApprovedModelChoice(undefined)
  try {
    fn()
  } finally {
    if (original === undefined) delete process.env[APPROVED_MODEL_CHOICE_ENV]
    else process.env[APPROVED_MODEL_CHOICE_ENV] = original
    setRuntimeApprovedModelChoice(undefined)
  }
}

test('an authorization reaches a child process through the environment', () => {
  const environment = approvedModelChoiceEnvironment(AUTHORIZATION)
  const encoded = environment[APPROVED_MODEL_CHOICE_ENV]
  assert.ok(encoded)

  withEnvironment(encoded, () => {
    assert.deepEqual(getRuntimeApprovedModelChoice(), AUTHORIZATION)
  })
})

test('no authorization contributes no environment at all', () => {
  assert.deepEqual(approvedModelChoiceEnvironment(undefined), {})
})

test('an unset environment means no authorization', () => {
  withEnvironment(undefined, () => {
    assert.equal(getRuntimeApprovedModelChoice(), undefined)
  })
})

test('an unreadable payload is read as no authorization, never as a partial one', () => {
  for (const payload of [
    'not-base64-json',
    Buffer.from('{"offerId":"offer-1"}', 'utf8').toString('base64'),
    Buffer.from('[]', 'utf8').toString('base64'),
    Buffer.from('null', 'utf8').toString('base64'),
  ]) {
    withEnvironment(payload, () => {
      assert.equal(getRuntimeApprovedModelChoice(), undefined, payload)
    })
  }
})

test('setting the authorization in-process publishes it to children too', () => {
  withEnvironment(undefined, () => {
    setRuntimeApprovedModelChoice(AUTHORIZATION)
    assert.deepEqual(getRuntimeApprovedModelChoice(), AUTHORIZATION)
    assert.ok(process.env[APPROVED_MODEL_CHOICE_ENV])
  })
})
