import assert from 'node:assert/strict'
import test from 'node:test'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { finishDialogueDelta, filterDialogueDelta, normalizeDialogueText, recoverDialogueRecord, settleDialogueTurn } from '../../domains/agent-dialogue/dialogue-policy.js'

const record = () => agentDialogueRecordSchema.parse({
  schemaVersion: 1, dialogueId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  topic: 'Pricing', participants: [{ id: 'alpha', label: 'Alpha', active: true, consecutiveFailures: 0 }, { id: 'beta', label: 'Beta', active: true, consecutiveFailures: 0 }],
  delivery: 'text', limits: { maxTurns: 2, runningMs: 0 }, status: 'running', nextSlot: 0,
  replyCount: 0, passStreak: 0, nextSpeaker: 0, epoch: 0,
  ownerLaunchId: '33333333-3333-4333-8333-333333333333', createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', stopRequested: false, events: [],
})
const timestamp = '2026-10-09T00:00:01Z'

test('pass markers are removed from complete replies without treating empty output as a pass', () => {
  assert.deepEqual(normalizeDialogueText(' [PaSS] '), { kind: 'pass' })
  assert.deepEqual(normalizeDialogueText('Useful point. [pass]'), { kind: 'reply', text: 'Useful point.' })
  assert.deepEqual(normalizeDialogueText('  '), { kind: 'failure' })
})

test('a split case-varied pass is never published', () => {
  const first = filterDialogueDelta({ pending: '', started: false }, '  [Pa')
  assert.equal(first.delta, '')
  const second = filterDialogueDelta(first.state, 'SS] ')
  assert.equal(second.delta, '')
  assert.equal(finishDialogueDelta(second.state), '')
})

test('a trailing pass is held across chunks without hiding a real reply', () => {
  const first = filterDialogueDelta({ pending: '', started: false }, 'Fair point. [pa')
  assert.equal(first.delta, 'Fair point.')
  const second = filterDialogueDelta(first.state, 'ss]')
  assert.equal(second.delta, '')
  assert.equal(finishDialogueDelta(second.state), '')
})

test('a held bracket prefix is released when it is real text', () => {
  const first = filterDialogueDelta({ pending: '', started: false }, '[pa')
  const second = filterDialogueDelta(first.state, 'nel] evidence')
  assert.equal(second.delta, '[panel] evidence')
  assert.equal(finishDialogueDelta(second.state), '')
})

test('a round of passes ends with no saved replies and consumes distinct slots', () => {
  const first = settleDialogueTurn(record(), { kind: 'pass' }, timestamp)
  assert.equal(first.status, 'running')
  assert.equal(first.nextSpeaker, 1)
  const second = settleDialogueTurn(first, { kind: 'pass' }, timestamp)
  assert.equal(second.endReason, 'passes')
  assert.equal(second.replyCount, 0)
  assert.equal(second.nextSlot, 2)
})

test('only saved replies reach the configured reply ceiling', () => {
  const first = settleDialogueTurn(record(), { kind: 'pass' }, timestamp)
  const second = settleDialogueTurn(first, { kind: 'reply' }, timestamp)
  assert.equal(second.replyCount, 1)
  assert.equal(second.passStreak, 0)
  const third = settleDialogueTurn(second, { kind: 'reply' }, timestamp)
  assert.equal(third.endReason, 'turn_limit')
  assert.equal(third.replyCount, 2)
})

test('a failed Agent leaves after its second consecutive failure', () => {
  const first = settleDialogueTurn(record(), { kind: 'failure' }, timestamp)
  const second = settleDialogueTurn(first, { kind: 'pass' }, timestamp)
  const third = settleDialogueTurn(second, { kind: 'failure' }, timestamp)
  assert.equal(third.participants[0]?.active, false)
  assert.equal(third.status, 'failed')
  assert.equal(third.endReason, 'too_few_speakers')
  assert.equal(third.replyCount, 0)
})

test('recovery counts a saved reply ahead of its record and never reuses an abandoned slot', () => {
  const initial = record()
  const recovered = recoverDialogueRecord({ ...initial, events: [{ sequence: 0, createdAt: timestamp, type: 'turn_started', slot: 2 }] }, [{
    id: `${initial.dialogueId}:reply:1`, role: 'assistant', text: 'Already saved.', createdAt: timestamp,
    schemaVersion: 2, kind: 'chat', source: { kind: 'agent-dialogue', dialogueId: initial.dialogueId, slot: 1 },
    speaker: { id: 'alpha', name: 'Alpha', type: 'agent' }, turnId: '44444444-4444-4444-8444-444444444444',
  }], timestamp)
  assert.equal(recovered.replyCount, 1)
  assert.equal(recovered.nextSlot, 3)
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.endReason, 'interrupted')
  assert.equal(recovered.epoch, 1)
})

test('a persisted stop request remains stopped on recovery', () => {
  const recovered = recoverDialogueRecord({ ...record(), stopRequested: true }, [], timestamp)
  assert.equal(recovered.status, 'stopped')
  assert.equal(recovered.endReason, 'stopped')
})

test('an Agent-authored topic never counts as a generated dialogue reply on recovery', () => {
  const initial = record()
  const recovered = recoverDialogueRecord(initial, [{
    id: `${initial.dialogueId}:user:topic`, role: 'assistant', text: 'The Agent selected this topic.', createdAt: timestamp,
    schemaVersion: 2, kind: 'chat', source: { kind: 'agent-dialogue', dialogueId: initial.dialogueId, slot: 0 },
    speaker: { id: 'alpha', name: 'Alpha', type: 'agent' }, turnId: initial.dialogueId,
  }], timestamp)
  assert.equal(recovered.replyCount, 0)
  assert.equal(recovered.nextSlot, 0)
})
