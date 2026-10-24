/**
 * The launch-lifecycle port: who opens a channel, who revokes a credential,
 * and in what order.
 *
 * The hard case is recovery. An interrupted run is still active, and its
 * relaunch reuses the same run id, so a naive "issue a credential at launch"
 * would leave the previous attempt's token working against a channel whose
 * bubble belongs to an attempt that is gone. Order matters here, so the fakes
 * below record one sequence rather than separate call lists.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../../domains/runtime/agent-text-delta-tokens.js'
import { createAgentTextStreamLaunchPort } from '../../domains/runtime/agent-text-delta-launch.js'

const ENDPOINT = 'http://127.0.0.1:4321/internal/agent-text-stream'

function createFakes() {
  const log: string[] = []
  let channelCounter = 0
  let tokenCounter = 0
  const openChannels = new Map<string, string>()
  const liveRuns = new Set<string>()

  return {
    log,
    openChannels,
    liveRuns,
    hub: {
      openChannel(channelId: string, ownerId: string) {
        log.push(`open:${channelId}:${ownerId}`)
        openChannels.set(channelId, ownerId)
      },
      closeChannel(channelId: string) {
        log.push(`close:${channelId}`)
        openChannels.delete(channelId)
      },
    },
    tokens: {
      issue(params: { channelId: string; runId: string }) {
        tokenCounter += 1
        log.push(`issue:${params.runId}:${params.channelId}`)
        liveRuns.add(params.runId)
        return `token-${tokenCounter}`
      },
      revokeByRun(runId: string) {
        log.push(`revoke:${runId}`)
        liveRuns.delete(runId)
      },
    },
    endpoint: { url: ENDPOINT },
    newChannelId: () => `channel-${(channelCounter += 1)}`,
  }
}

function createPort(fakes: ReturnType<typeof createFakes>) {
  return createAgentTextStreamLaunchPort({
    hub: fakes.hub,
    tokens: fakes.tokens,
    endpoint: fakes.endpoint,
    newChannelId: fakes.newChannelId,
  })
}

const TEAM_LAUNCH = {
  sessionId: 'session-1',
  runId: 'run-1',
  targetKind: 'team-chat',
}

test('a Team launch opens a session-owned channel and hands back its three values', () => {
  const fakes = createFakes()
  const port = createPort(fakes)

  const granted = port.grant(TEAM_LAUNCH)

  assert.ok(granted)
  assert.equal(granted.channelId, 'channel-1')
  assert.deepEqual(granted.env, {
    [AGENT_TEXT_STREAM_URL_ENV]: ENDPOINT,
    [AGENT_TEXT_STREAM_CHANNEL_ENV]: 'channel-1',
    [AGENT_TEXT_STREAM_TOKEN_ENV]: 'token-1',
  })
  // Owned by the session, so the channel id alone grants nothing.
  assert.equal(fakes.openChannels.get('channel-1'), 'session-1')
  // Opened before the credential exists, so there is never a live token
  // pointing at a channel nobody can read.
  assert.deepEqual(fakes.log, ['open:channel-1:session-1', 'issue:run-1:channel-1'])
})

test('a relaunch of the same run retires the previous attempt before the new one exists', () => {
  const fakes = createFakes()
  const port = createPort(fakes)

  const first = port.grant(TEAM_LAUNCH)
  assert.ok(first)
  fakes.log.length = 0

  // An interrupted run is still active: recovery relaunches under the same run
  // id rather than a new one.
  const second = port.grant(TEAM_LAUNCH)

  assert.ok(second)
  assert.notEqual(second.channelId, first.channelId)
  assert.deepEqual(fakes.log, [
    'revoke:run-1',
    'close:channel-1',
    'open:channel-2:session-1',
    'issue:run-1:channel-2',
  ])
  // The previous attempt's channel is gone rather than left serving a bubble
  // that belongs to an attempt nobody is running any more.
  assert.equal(fakes.openChannels.has('channel-1'), false)
  assert.equal(fakes.openChannels.get('channel-2'), 'session-1')
})

test('rolling back a failed launch leaves no channel and no working credential', () => {
  const fakes = createFakes()
  const port = createPort(fakes)

  const granted = port.grant(TEAM_LAUNCH)
  assert.ok(granted)
  fakes.log.length = 0

  port.rollback(granted.channelId)

  assert.deepEqual(fakes.log, ['revoke:run-1', 'close:channel-1'])
  assert.equal(fakes.openChannels.size, 0)
  assert.equal(fakes.liveRuns.size, 0)
})

test('rolling back twice is harmless', () => {
  const fakes = createFakes()
  const port = createPort(fakes)
  const granted = port.grant(TEAM_LAUNCH)
  assert.ok(granted)

  port.rollback(granted.channelId)
  fakes.log.length = 0
  port.rollback(granted.channelId)

  assert.deepEqual(fakes.log, [])
})

test('a run that is not a Team touches nothing at all', () => {
  const fakes = createFakes()
  const port = createPort(fakes)

  const granted = port.grant({ ...TEAM_LAUNCH, targetKind: undefined })

  assert.equal(granted, undefined)
  assert.deepEqual(fakes.log, [])
})

test('a terminal run gives up its channel and its credential together', () => {
  const fakes = createFakes()
  const port = createPort(fakes)
  const granted = port.grant(TEAM_LAUNCH)
  assert.ok(granted)
  fakes.log.length = 0

  port.retire('run-1')

  assert.deepEqual(fakes.log, ['revoke:run-1', 'close:channel-1'])
  assert.equal(fakes.openChannels.size, 0)
})
