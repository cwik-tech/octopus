import assert from 'node:assert/strict'
import test from 'node:test'
import { providerAbortSource } from '../../contracts/provider-abort.js'

for (const [description, reason] of [
  ['absent reasons', undefined], ['null reasons', null], ['arbitrary text', 'private account token'],
  ['unknown objects', {}], ['foreign reason types', { kind: 'foreign', source: 'user-stop' }],
  ['unrecognized sources', { kind: 'provider-abort', source: 'private account token' }],
] as const) {
  test(`classifies ${description} without retaining their contents`, () => {
    assert.equal(providerAbortSource(reason), 'caller-abort')
  })
}
