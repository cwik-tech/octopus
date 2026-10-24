import assert from 'node:assert/strict'
import { test } from 'node:test'

import { composerSelectionRecord, describeModelSelection, readModelSelectionRecord } from '../../contracts/agent-model-selection.js'
import { resourceArchitectTurnRequestSchema } from '../../contracts/schemas/builder-requests.js'

const snapshot = { provider: 'openai', model: 'composer-model', origin: 'default' }

test('captured selection records distinguish an untouched default from a deliberate choice of the same pair', () => {
  assert.deepEqual(composerSelectionRecord({ ...snapshot, origin: 'default' }), {
    provider: 'openai', model: 'composer-model', source: 'app-default',
    reason: 'composer-default', caller: 'authoring',
  })
  assert.deepEqual(composerSelectionRecord({ ...snapshot, origin: 'user-choice' }), {
    provider: 'openai', model: 'composer-model', source: 'user',
    reason: 'explicit-user-choice', caller: 'authoring',
  })
})

test('a turn retains the visible composer default and its origin', () => {
  const result = resourceArchitectTurnRequestSchema.parse({
    history: [], currentPlan: null, composerSelection: snapshot,
  })
  assert.deepEqual(result.composerSelection, snapshot)
})

test('a turn rejects conflicting legacy and captured composer pairs', () => {
  const result = resourceArchitectTurnRequestSchema.safeParse({
    history: [], currentPlan: null, provider: 'openai', model: 'other-model',
    composerSelection: snapshot,
  })
  assert.equal(result.success, false)
})

for (const composerSelection of [
  { ...snapshot, provider: '' },
  { ...snapshot, model: '' },
  { ...snapshot, origin: 'automatic-retry' },
  { provider: 'openai', model: 'composer-model' },
]) {
  test(`a turn refuses an unresolved or unsupported composer snapshot ${JSON.stringify(composerSelection)}`, () => {
    assert.equal(resourceArchitectTurnRequestSchema.safeParse({
      history: [], currentPlan: null, composerSelection,
    }).success, false)
  })
}

test('stored composer defaults say the displayed default was captured without claiming a user choice', () => {
  const selection = {
    provider: 'openai', model: 'composer-model', source: 'app-default',
    reason: 'composer-default', caller: 'authoring',
  }
  const read = readModelSelectionRecord(selection)
  assert.deepEqual(read, selection)
  assert.ok(read)
  assert.equal(describeModelSelection('Agent Architect', read),
    'Agent Architect used the Create composer default captured at submission: openai / composer-model.')
})
