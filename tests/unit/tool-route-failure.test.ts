import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatToolRouteFailure,
  reportToolRouteFailureToStderr,
  toolRouteFailureDiagnostic,
} from '../../server/tool-route-failure.js'

const CORRELATION = { requestId: 'request-1', toolCallId: 'call-1' } as const

test('an error whose class name is not an ordinary identifier is logged as unnamed', () => {
  // A class takes its name from the key it was defined under, so a name can
  // carry any text, including the detail the log must not hold.
  const classes = { ['Leak /Users/someone token=sk-live-123']: class extends Error {} }
  const Hostile = classes['Leak /Users/someone token=sk-live-123']

  const diagnostic = toolRouteFailureDiagnostic('browser', new Hostile('private'), CORRELATION)

  assert.equal(diagnostic.errorClass, 'unnamed')
})

test('an error class keeps its name even when its name property was rewritten', () => {
  const error = new TypeError('private')
  error.name = 'journal at /Users/someone'

  const diagnostic = toolRouteFailureDiagnostic('youtube', error, CORRELATION)

  assert.equal(diagnostic.errorClass, 'TypeError')
})

test('a failure before the request was read carries no correlation ids', () => {
  assert.deepEqual(toolRouteFailureDiagnostic('generate-word', new Error('private'), undefined), {
    event: 'tool_route_unexpected_failure',
    tool: 'generate-word',
    errorClass: 'Error',
  })
})

test('the stderr reporter writes one parseable JSON line', (context) => {
  const written: string[] = []
  context.mock.method(process.stderr, 'write', (chunk: string) => {
    written.push(chunk)
    return true
  })
  const diagnostic = toolRouteFailureDiagnostic('generate-excel', new Error('private'), CORRELATION)

  reportToolRouteFailureToStderr(diagnostic)

  assert.deepEqual(written, [formatToolRouteFailure(diagnostic)])
  const line = written.join('')
  assert.ok(line.endsWith('\n'))
  assert.equal(line.trimEnd().includes('\n'), false)
  assert.deepEqual(JSON.parse(line), {
    event: 'tool_route_unexpected_failure',
    tool: 'generate-excel',
    requestIdDigest: 'e66b757f1b602c8a',
    toolCallIdDigest: '13b37792a1e6758f',
    errorClass: 'Error',
  })
})
