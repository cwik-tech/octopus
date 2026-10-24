import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acquisitionSettingsCloudOptions,
  reportCloudCleanupWarning,
} from '../../server/tools/research-web.js'

/**
 * That a session which may still be billing reaches a person.
 *
 * Two separable things: how the warning reads, and whether the application is
 * wired to emit it at all. The wiring half matters because the settings service
 * is usually **injected** — the desktop builds its own — so a channel installed
 * only inside the module that sometimes builds it is a channel the real
 * application does not have.
 */

function captured(): {
  readonly lines: readonly string[]
  log: (scope: string, message: string) => void
} {
  const lines: string[] = []
  return { lines, log: (scope, message) => lines.push(`[${scope}] ${message}`) }
}

test('a session that could not be stopped is named and bounded', () => {
  const sink = captured()

  reportCloudCleanupWarning(
    {
      kind: 'session-not-stopped',
      provider: 'browser-use',
      sessionId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      timeoutAt: '2026-08-30T10:01:00.000Z',
      providerTimeoutMinutes: 2,
      failure: 'stop_rejected',
    },
    sink.log,
  )

  const message = sink.lines.join('')
  assert.match(message, /research-web\/cloud-browser/u, 'operators find this by its scope')
  assert.match(message, /3f2504e0-4f89-11d3-9a0c-0305e82c3301/u, 'the session must be nameable')
  assert.match(message, /2 minute/u, 'and bounded, so nobody has to guess')
})

test('a session that cannot be named has no id invented for it', () => {
  const sink = captured()

  reportCloudCleanupWarning(
    {
      kind: 'session-indeterminate',
      provider: 'browser-use',
      providerTimeoutMinutes: 1,
      failure: 'create_response_lost',
    },
    sink.log,
  )

  assert.match(sink.lines.join(''), /cannot be named/u)
})

test('every owner of the settings service gets the cleanup channel', () => {
  // The desktop applies exactly these options to the service it injects. If the
  // channel were dropped from this factory — or from the desktop's use of it —
  // a billing session would fail silently.
  const options = acquisitionSettingsCloudOptions({ allowHttpLocalhost: false })

  assert.equal(typeof options.onCloudCleanupWarning, 'function')
  assert.equal(options.allowHttpLocalhost, false)
})
