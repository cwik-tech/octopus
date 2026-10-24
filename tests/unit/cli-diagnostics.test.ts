import assert from 'node:assert/strict'
import test from 'node:test'
import { readCliDiagnostic } from '../../providers/cli-diagnostics.js'

test('answer content mentioning errors or retries is excluded from CLI diagnostics', () => {
  assert.equal(readCliDiagnostic({ type: 'assistant', message: { content: 'API Error: 429; retrying private text' } }, 'stdout'), undefined)
  assert.equal(readCliDiagnostic('', 'stderr'), undefined)
})

test('implausible retry numbers are omitted rather than retained as diagnostic data', () => {
  assert.deepEqual(readCliDiagnostic('Retrying in 999999999 seconds (attempt 4111111111111111)', 'stderr'),
    { kind: 'provider-cli-diagnostic', channel: 'stderr', category: 'retry' })
})

test('structured retries retain only bounded metadata', () => {
  assert.deepEqual(readCliDiagnostic({ type: 'system', subtype: 'api_retry', attempt: 2, retry_delay_ms: 1500, error_status: 503,
    message: 'private provider payload', token: 'private token' }, 'stdout'),
    { kind: 'provider-cli-diagnostic', channel: 'stdout', category: 'retry', statusCode: 503, attempt: 2, retryDelayMs: 1500 })
})

test('an explicit HTTP error status uses the shared provider failure taxonomy', () => {
  assert.deepEqual(readCliDiagnostic('API Error: 503 private upstream detail', 'stderr'),
    { kind: 'provider-cli-diagnostic', channel: 'stderr', category: 'overloaded', statusCode: 503 })
})

test('allowed quota information and warnings are not classified as rate-limit failures', () => {
  assert.equal(readCliDiagnostic({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, 'stdout'), undefined)
  assert.equal(readCliDiagnostic({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, 'stdout'), undefined)
  assert.equal(readCliDiagnostic({ type: 'rate_limit_event', rate_limit_info: {} }, 'stdout'), undefined)
})

test('rejected quota information remains a rate-limit diagnostic', () => {
  assert.deepEqual(readCliDiagnostic({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, 'stdout'),
    { kind: 'provider-cli-diagnostic', channel: 'stdout', category: 'rate_limit' })
})
