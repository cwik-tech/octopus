import assert from 'node:assert/strict'
import test from 'node:test'

import { describeSpeakerFailure } from '../../services/agent-chat-service.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { McpAgentToolServiceError } from '../../services/mcp-agent-tool-service.js'

/**
 * What a failed turn writes down about the provider it was asking.
 *
 * This is the only place a provider error becomes the journal's record of it,
 * so it is the only place a stated reset can be captured. Miss it and every
 * layer downstream is correct about a fact that was never recorded: the
 * projection expires on a reset it never receives, and a usage limit stands
 * until something else disproves it.
 *
 * The clock is a parameter because the provider states a wall-clock time and
 * often omits the year. It is read once, here, when the failure happens.
 */

const READ_AT = new Date(2026, 7, 19, 15, 0, 0)
const ASKED = { provider: 'codex', model: 'gpt-5.5' }

const CODEX_USAGE_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
  'to purchase more credits or try again at Aug 19th, 2026 11:32 PM.'

test('a usage limit the provider dated is recorded with that moment', () => {
  const { failure } = describeSpeakerFailure(
    new ProviderError({
      provider: 'codex',
      message: CODEX_USAGE_LIMIT,
      retryable: false,
    }),
    ASKED,
    READ_AT,
  )

  assert.equal(failure.providerKind, 'usage_limit')
  assert.equal(failure.resetsAt, new Date(2026, 7, 19, 23, 32, 0).toISOString())
})

test('a usage limit the provider did not date records no moment', () => {
  // Nothing is guessed. A limit with no stated reset is exactly the case the
  // allowance reading exists for.
  const { failure } = describeSpeakerFailure(
    new ProviderError({
      provider: 'codex',
      message: "You've hit your usage limit.",
      retryable: false,
    }),
    ASKED,
    READ_AT,
  )

  assert.equal(failure.providerKind, 'usage_limit')
  assert.equal(failure.resetsAt, undefined)
})

test('a failure that is not a usage limit records no reset', () => {
  const { failure } = describeSpeakerFailure(
    new ProviderError({
      provider: 'codex',
      message: 'Invalid API key',
      statusCode: 401,
      retryable: false,
    }),
    ASKED,
    READ_AT,
  )

  assert.equal(failure.resetsAt, undefined)
})

test('a reset the worker boundary already resolved is carried, not re-read', () => {
  // The parent turn read the provider's sentence against its own clock and
  // sent the instant across. Re-deriving it here would resolve the same
  // ambiguity a second time, against a clock that has moved.
  const resetsAt = '2026-09-14T21:45:00.000Z'
  const { failure } = describeSpeakerFailure(
    new McpAgentToolServiceError(
      'provider_usage_limit',
      'Parent worker turn failed.',
      false,
      {
        layer: 'mcp-service',
        phase: 'provider-request',
        route: 'mcp-cli',
        providerKind: 'usage_limit',
        resetsAt,
      },
    ),
    ASKED,
    READ_AT,
  )

  assert.equal(failure.providerKind, 'usage_limit')
  assert.equal(failure.resetsAt, resetsAt)
})
