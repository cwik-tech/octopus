import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversationMessage } from '../../core/types.js'
import { deriveDiscussionContributionStatus } from '../../core/discussion-continuation-control.js'

function makeMessage(target: string, type: 'position' | 'error', round = 1): ConversationMessage {
  return { from: target, target, to: 'all', round, type, timestamp: '2026-10-03T00:00:00Z', message: type === 'position' ? 'Accepted evidence.' : 'Contribution failed.' }
}

test('accepted replies count distinct approved participants across passes, including fallback replies', () => {
  const messages = [makeMessage('a', 'position'), makeMessage('a', 'position', 2), { ...makeMessage('b', 'position'), from: 'fallback' }, makeMessage('outsider', 'position')]
  assert.deepEqual(deriveDiscussionContributionStatus(messages, ['a', 'b']), { successfulCount: 2, failedParticipants: [] })
})

test('a failed follow-up preserves an earlier contribution and identifies the missing work', () => {
  assert.deepEqual(deriveDiscussionContributionStatus([makeMessage('a', 'position'), makeMessage('a', 'error', 2)], ['a']), { successfulCount: 1, failedParticipants: ['a'] })
})

test('a later accepted reply clears the earlier failure without counting it twice', () => {
  assert.deepEqual(deriveDiscussionContributionStatus([makeMessage('a', 'error'), makeMessage('a', 'position', 2)], ['a']), { successfulCount: 1, failedParticipants: [] })
})

test('failed and unapproved participants cannot satisfy the successful participant minimum', () => {
  assert.deepEqual(deriveDiscussionContributionStatus([makeMessage('a', 'error'), makeMessage('outsider', 'position')], ['a', 'b']), { successfulCount: 0, failedParticipants: ['a'] })
})
