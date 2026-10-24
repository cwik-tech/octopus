import test from 'node:test'
import assert from 'node:assert/strict'

import { whenDefined } from '../../core/optional-properties.js'

test('whenDefined omits only undefined values', () => {
  assert.deepEqual(whenDefined(undefined, (value) => ({ value })), {})
  assert.deepEqual(whenDefined(false, (value) => ({ value })), { value: false })
  assert.deepEqual(whenDefined(0, (value) => ({ value })), { value: 0 })
  assert.deepEqual(whenDefined('', (value) => ({ value })), { value: '' })
  assert.deepEqual(whenDefined(null, (value) => ({ value })), { value: null })
})
