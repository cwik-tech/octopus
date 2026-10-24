import assert from 'node:assert/strict'
import test from 'node:test'
import { readClaudeProgress } from '../../providers/claude-progress.js'
import { agentProgressUpdateSchema } from '../../contracts/agent-progress.js'

test('thinking deltas report activity without retaining reasoning text', () => {
  assert.deepEqual(readClaudeProgress({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'PRIVATE_REASONING' } } }),
    { kind: 'observed', phase: 'thinking' })
})

test('a retry reports bounded structured metadata without provider text', () => {
  assert.deepEqual(readClaudeProgress({ type: 'system', subtype: 'api_retry', attempt: 2, retry_delay_ms: 1500, error_status: 503, error: 'server_error', message: 'PRIVATE_PAYLOAD' }),
    { kind: 'observed', phase: 'retry', attempt: 2, retryDelayMs: 1500 })
})

test('a retry attempt beyond the progress contract still shows a valid retry status', () => {
  const update = readClaudeProgress({ type: 'system', subtype: 'api_retry', attempt: 1500, retry_delay_ms: 1500 })
  assert.deepEqual(update, { kind: 'observed', phase: 'retry', retryDelayMs: 1500 })
  assert.equal(agentProgressUpdateSchema.safeParse(update).success, true)
})

test('quota permission events cannot masquerade as blocked work', () => {
  assert.equal(readClaudeProgress({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), undefined)
  assert.equal(readClaudeProgress({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }), undefined)
  assert.deepEqual(readClaudeProgress({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }), { kind: 'observed', phase: 'rate_limited' })
})

test('answer activity contains no answer text and malformed events are ignored', () => {
  assert.deepEqual(readClaudeProgress({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PRIVATE_ANSWER' } } }), { kind: 'observed', phase: 'answering' })
  assert.equal(readClaudeProgress({ type: 'stream_event', event: 'invalid' }), undefined)
  assert.equal(readClaudeProgress(null), undefined)
})
