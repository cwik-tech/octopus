import test from 'node:test'
import assert from 'node:assert/strict'
import { requiredValue } from '../../core/required-value.js'

test('requiredValue returns a present value without changing it', () => {
  const value = { id: 'present' }

  assert.equal(requiredValue(value), value)
})

test('requiredValue rejects an absent value with its caller label', () => {
  assert.throws(
    () => requiredValue(undefined, 'first result'),
    /first result is required/,
  )
})
