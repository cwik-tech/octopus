import assert from 'node:assert/strict'
import test from 'node:test'

import type { AcquisitionAttemptOutcome } from '../../domains/acquisition/acquisition-types.js'
import { browserProxyRetryApplies } from '../../services/research-web-tool-service.js'

/**
 * The rule that decides whether a managed-browser result earns one retry from a
 * different egress.
 *
 * It is tested here rather than only through a ladder because both ladders ask
 * the same question and the answer must not depend on which one asked.
 */

const HOST_SCOPED: readonly AcquisitionAttemptOutcome[] = [
  'access-denied',
  'challenge',
  'rate-limited',
]

const NOT_HOST_SCOPED: readonly AcquisitionAttemptOutcome[] = [
  'not-found',
  'insufficient',
  'timeout',
  'failed',
  'policy-denied',
  'cancelled',
  'unsupported',
  'usable',
]

function applies(
  overrides: Partial<Parameters<typeof browserProxyRetryApplies>[0]> = {},
): boolean {
  return browserProxyRetryApplies({
    outcome: 'access-denied',
    alreadyRetried: false,
    browserAttemptsUsed: 1,
    maximumBrowserFallbacks: 10,
    ...overrides,
  })
}

test('only an outcome that means this host refused this egress earns a retry', () => {
  for (const outcome of HOST_SCOPED) {
    assert.equal(applies({ outcome }), true, `${outcome} should retry`)
  }
  for (const outcome of NOT_HOST_SCOPED) {
    assert.equal(applies({ outcome }), false, `${outcome} should not retry`)
  }
  assert.equal(
    applies({ outcome: undefined }),
    false,
    'a rung that recorded no outcome cannot be retried',
  )
})

test('one acquisition earns at most one proxied browser retry', () => {
  assert.equal(applies({ alreadyRetried: true }), false)
})

test('the retry spends a browser-fallback slot and stops at the ceiling', () => {
  assert.equal(applies({ browserAttemptsUsed: 9, maximumBrowserFallbacks: 10 }), true)
  assert.equal(applies({ browserAttemptsUsed: 10, maximumBrowserFallbacks: 10 }), false)
  assert.equal(applies({ browserAttemptsUsed: 0, maximumBrowserFallbacks: 0 }), false)
})
