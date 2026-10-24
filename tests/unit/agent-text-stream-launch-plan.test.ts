/**
 * Who gets a display-stream credential at launch, and what the child is told.
 *
 * The decision is worth isolating from the launch shell because it is the
 * whole of the authority question: one wrong `true` here hands a posting
 * credential to a run that has no participant text to show. Kept pure so it
 * can be stated as plain data, with the token minter passed in and observed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../../domains/runtime/agent-text-delta-tokens.js'
import { planAgentTextStreamLaunch } from '../../domains/runtime/agent-text-delta-launch.js'

const ENDPOINT = 'http://127.0.0.1:4321/internal/agent-text-stream'
const CHANNEL = '11111111-2222-4333-8444-555555555555'

/**
 * Records every minting request so "never issued" is observable.
 *
 * The channel is minted at launch rather than read off the task: nothing about
 * this channel is persisted, so there is no stored id to trust or to leak.
 */
function recordingMinter(
  grant: { channelId: string; token: string } = {
    channelId: CHANNEL,
    token: 'minted-token',
  },
) {
  const issued: Array<{ runId: string }> = []
  return {
    issued,
    issue: (params: { runId: string }) => {
      issued.push(params)
      return grant
    },
  }
}

function teamRun(overrides: Record<string, unknown> = {}) {
  return {
    targetKind: 'team-chat' as const,
    runId: 'run-1',
    endpointUrl: ENDPOINT,
    ...overrides,
  }
}

test('a Team run is told the address, the channel and its own token, as three values', () => {
  const minter = recordingMinter({
    channelId: CHANNEL,
    token: 'a-real-credential',
  })

  const plan = planAgentTextStreamLaunch(teamRun(), minter.issue)

  assert.ok(plan)
  assert.deepEqual(plan.env, {
    [AGENT_TEXT_STREAM_URL_ENV]: ENDPOINT,
    [AGENT_TEXT_STREAM_CHANNEL_ENV]: CHANNEL,
    [AGENT_TEXT_STREAM_TOKEN_ENV]: 'a-real-credential',
  })
  // The address is not a credential and must never become one by carrying the
  // token: URLs reach access logs and error text.
  assert.equal(plan.env[AGENT_TEXT_STREAM_URL_ENV]?.includes('a-real-credential'), false)
  // The id the child is told is the one that was just minted for this run,
  // not one carried on the task.
  assert.equal(plan.channelId, CHANNEL)
  assert.deepEqual(minter.issued, [{ runId: 'run-1' }])
})

test('a run that is not a Team is given nothing, and no token is minted for it', () => {
  const minter = recordingMinter()

  const plan = planAgentTextStreamLaunch(
    { ...teamRun(), targetKind: undefined },
    minter.issue,
  )

  assert.equal(plan, undefined)
  // Least authority: a workflow run shows no participant text, so it never
  // holds a credential that could post any.
  assert.deepEqual(minter.issued, [])
})

test('nothing is minted before the server has an address to give', () => {
  const minter = recordingMinter()

  const plan = planAgentTextStreamLaunch(
    { ...teamRun(), endpointUrl: undefined },
    minter.issue,
  )

  assert.equal(plan, undefined)
  assert.deepEqual(minter.issued, [])
})

test('each launch mints its own channel and token rather than reusing one', () => {
  let counter = 0
  const issue = () => {
    counter += 1
    return { channelId: `channel-${counter}`, token: `token-${counter}` }
  }

  const first = planAgentTextStreamLaunch(teamRun(), issue)
  const second = planAgentTextStreamLaunch(teamRun(), issue)

  assert.equal(first?.env[AGENT_TEXT_STREAM_TOKEN_ENV], 'token-1')
  assert.equal(first?.env[AGENT_TEXT_STREAM_CHANNEL_ENV], 'channel-1')
  assert.equal(second?.env[AGENT_TEXT_STREAM_TOKEN_ENV], 'token-2')
  assert.equal(second?.env[AGENT_TEXT_STREAM_CHANNEL_ENV], 'channel-2')
})
