/**
 * Releasing a run's channel when the run is genuinely over.
 *
 * The launch shell gives a grant back when a launch fails, but a run that
 * started successfully outlives that call, so something else has to notice it
 * ending. The store already reports terminal assignments to whoever asks;
 * `CapabilityDispatchRuntime` is the precedent for subscribing once and
 * releasing on that signal.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentTextStreamLaunchRuntime } from '../../domains/runtime/agent-text-delta-launch.js'
import type { SessionTaskTerminalListener } from '../../domains/sessions/session-store.js'

const ENDPOINT = 'http://127.0.0.1:4321/internal/agent-text-stream'

function createRuntimeFakes() {
  const log: string[] = []
  const listeners: SessionTaskTerminalListener[] = []
  let unsubscribed = 0
  let counter = 0
  return {
    log,
    listeners,
    unsubscribedCount: () => unsubscribed,
    deps: {
      hub: {
        openChannel: (channelId: string, ownerId: string) =>
          log.push(`open:${channelId}:${ownerId}`),
        closeChannel: (channelId: string) => log.push(`close:${channelId}`),
      },
      tokens: {
        issue: ({ runId, channelId }: { runId: string; channelId: string }) => {
          log.push(`issue:${runId}:${channelId}`)
          return 'token'
        },
        revokeByRun: (runId: string) => log.push(`revoke:${runId}`),
      },
      endpoint: { url: ENDPOINT },
      newChannelId: () => `channel-${(counter += 1)}`,
      assignmentLifecycle: {
        subscribeTaskTerminal: (listener: SessionTaskTerminalListener) => {
          listeners.push(listener)
          return () => {
            unsubscribed += 1
          }
        },
      },
    },
  }
}

test('a run reported terminal gives up its channel and its credential', async () => {
  const fakes = createRuntimeFakes()
  const runtime = createAgentTextStreamLaunchRuntime(fakes.deps)

  const granted = runtime.port.grant({
    sessionId: 'session-1',
    runId: 'run-1',
    targetKind: 'team-chat',
  })
  assert.ok(granted)
  fakes.log.length = 0

  assert.equal(fakes.listeners.length, 1, 'expected exactly one subscription')
  await fakes.listeners[0]?.({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })

  assert.deepEqual(fakes.log, ['revoke:run-1', 'close:channel-1'])
})

test('a terminal report for some other run leaves this one alone', async () => {
  const fakes = createRuntimeFakes()
  const runtime = createAgentTextStreamLaunchRuntime(fakes.deps)
  runtime.port.grant({
    sessionId: 'session-1',
    runId: 'run-1',
    targetKind: 'team-chat',
  })
  fakes.log.length = 0

  await fakes.listeners[0]?.({
    sessionId: 'session-1',
    runId: 'run-2',
    assignmentId: 'assignment-2',
  })

  assert.deepEqual(fakes.log, [])
})

test('disposing the runtime stops listening exactly once', () => {
  const fakes = createRuntimeFakes()
  const runtime = createAgentTextStreamLaunchRuntime(fakes.deps)

  runtime.dispose()
  runtime.dispose()

  assert.equal(fakes.unsubscribedCount(), 1)
})
