import assert from 'node:assert/strict'
import test from 'node:test'
import { updateAgentProgress, agentProgressSnapshotSchema, agentProgressUpdateSchema } from '../../contracts/agent-progress.js'

test('observed progress is throttled without inventing activity or retaining reasoning', () => {
  const first = updateAgentProgress(undefined, { kind: 'observed', phase: 'thinking' }, 1000)
  assert.equal(first.updatedAt, 1000)
  assert.equal(first.revision, 1)
  assert.equal(updateAgentProgress(first, { kind: 'observed', phase: 'thinking' }, 1001), first)
  const next = updateAgentProgress(first, { kind: 'observed', phase: 'thinking' }, 4000)
  assert.equal(next.updatedAt, 4000)
  assert.equal(next.history.length, 1)
  assert.equal(next.revision, 2)
})

test('the stream schema rejects raw payloads and malformed progress', () => {
  assert.equal(agentProgressSnapshotSchema.safeParse({ revision: 1, startedAt: 0, updatedAt: 1, current: { kind: 'observed', phase: 'thinking', raw: 'PRIVATE' }, history: [] }).success, false)
  assert.equal(agentProgressSnapshotSchema.safeParse({ revision: -1, current: { kind: 'observed', phase: 'unknown' } }).success, false)
})

test('agent reports have a bounded checklist with stable unique identities', () => {
  assert.equal(agentProgressUpdateSchema.safeParse({ kind: 'reported', summary: 'Updating calendar', tasks: [{ id: 'calendar', label: 'Calendar', status: 'active' }] }).success, true)
  assert.equal(agentProgressUpdateSchema.safeParse({ kind: 'reported', summary: 'Updating calendar', tasks: [{ id: 'calendar', label: 'Calendar', status: 'active' }, { id: 'calendar', label: 'Duplicate', status: 'pending' }] }).success, false)
  assert.equal(agentProgressUpdateSchema.safeParse({ kind: 'reported', summary: 'x'.repeat(161) }).success, false)
})

test('observed activity does not erase the agent-reported milestone or its task list', () => {
  const reported = updateAgentProgress(undefined, { kind: 'reported', summary: 'Updating calendar', tasks: [{ id: 'calendar', label: 'Calendar', status: 'active' }] }, 1000)
  const waiting = updateAgentProgress(reported, { kind: 'observed', phase: 'thinking' }, 2000)
  const next = updateAgentProgress(waiting, { kind: 'reported', summary: 'Checking calendar' }, 3000)
  assert.equal(waiting.reported?.summary, 'Updating calendar')
  assert.deepEqual(next.reported?.tasks, [{ id: 'calendar', label: 'Calendar', status: 'active' }])
})
