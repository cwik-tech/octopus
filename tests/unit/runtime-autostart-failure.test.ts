import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldRecordRuntimeAutostartFailure } from '../../domains/runtime/runtime-autostart-failure.js'

test('host shutdown cancellation is not recorded as a product failure', () => {
  const shutdown = new AbortController()

  assert.equal(shouldRecordRuntimeAutostartFailure(shutdown.signal), true)
  shutdown.abort()
  assert.equal(shouldRecordRuntimeAutostartFailure(shutdown.signal), false)
})
