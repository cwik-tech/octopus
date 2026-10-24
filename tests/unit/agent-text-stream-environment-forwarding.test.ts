/**
 * Carrying the display-stream values one process hop further.
 *
 * The run child spawns the Team runtime with an explicit environment rather
 * than inheriting one, so anything the launch handed the child stops there
 * unless it is named. These three have to make that hop — the engines that
 * produce the text run in the Team runtime — and nothing else may ride along
 * with them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../../domains/runtime/agent-text-delta-tokens.js'
import { forwardAgentTextStreamEnvironment } from '../../domains/runtime/agent-text-delta-launch.js'

test('the three values are carried across, and nothing else is', () => {
  const forwarded = forwardAgentTextStreamEnvironment({
    [AGENT_TEXT_STREAM_URL_ENV]: 'http://127.0.0.1:4321/internal/agent-text-stream',
    [AGENT_TEXT_STREAM_CHANNEL_ENV]: '11111111-2222-4333-8444-555555555555',
    [AGENT_TEXT_STREAM_TOKEN_ENV]: 'a-working-credential',
    ANTHROPIC_API_KEY: 'someone-elses-secret',
    PATH: '/usr/bin',
  })

  assert.deepEqual(forwarded, {
    [AGENT_TEXT_STREAM_URL_ENV]: 'http://127.0.0.1:4321/internal/agent-text-stream',
    [AGENT_TEXT_STREAM_CHANNEL_ENV]: '11111111-2222-4333-8444-555555555555',
    [AGENT_TEXT_STREAM_TOKEN_ENV]: 'a-working-credential',
  })
})

test('a run with no grant carries nothing', () => {
  // A workflow run is never given these, and the hop must not invent them.
  assert.deepEqual(forwardAgentTextStreamEnvironment({ PATH: '/usr/bin' }), {})
})

test('a partial grant is not forwarded at all', () => {
  // An address without its credential is not a usable grant, and passing half
  // of one on would leave the runtime trying to post without authorization.
  const forwarded = forwardAgentTextStreamEnvironment({
    [AGENT_TEXT_STREAM_URL_ENV]: 'http://127.0.0.1:4321/internal/agent-text-stream',
    [AGENT_TEXT_STREAM_CHANNEL_ENV]: '11111111-2222-4333-8444-555555555555',
  })

  assert.deepEqual(forwarded, {})
})
