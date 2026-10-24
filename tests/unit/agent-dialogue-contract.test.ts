import assert from 'node:assert/strict'
import test from 'node:test'

import { startAgentDialogueRequestSchema } from '../../contracts/agent-dialogue.js'

test('a dialogue start defaults to text and twelve saved replies', () => {
  assert.deepEqual(startAgentDialogueRequestSchema.parse({ agents: ['alpha', 'beta'], topic: 'Pricing' }), {
    agents: ['alpha', 'beta'], topic: 'Pricing', delivery: 'text', maxTurns: 12,
  })
})

test('a dialogue rejects duplicate participants, fewer than two and more than five', () => {
  assert.equal(startAgentDialogueRequestSchema.safeParse({ agents: ['alpha', 'alpha'], topic: 'Pricing' }).success, false)
  assert.equal(startAgentDialogueRequestSchema.safeParse({ agents: ['alpha'], topic: 'Pricing' }).success, false)
  assert.equal(startAgentDialogueRequestSchema.safeParse({ agents: ['a', 'b', 'c', 'd', 'e', 'f'], topic: 'Pricing' }).success, false)
})

test('a dialogue refuses reply ceilings above fifty and empty topics', () => {
  assert.equal(startAgentDialogueRequestSchema.safeParse({ agents: ['alpha', 'beta'], topic: 'Pricing', maxTurns: 51 }).success, false)
  assert.equal(startAgentDialogueRequestSchema.safeParse({ agents: ['alpha', 'beta'], topic: '   ' }).success, false)
})

test('a dialogue start retains its validated selected project context', () => {
  const projectContext = { projectId: '00000000-0000-4000-8000-000000000123', includeBrief: true, fileNames: ['evidence.md'] }
  assert.deepEqual(startAgentDialogueRequestSchema.parse({ agents: ['alpha', 'beta'], topic: 'Pricing', projectContext }), {
    agents: ['alpha', 'beta'], topic: 'Pricing', delivery: 'text', maxTurns: 12, projectContext,
  })
  assert.equal(startAgentDialogueRequestSchema.safeParse({ agents: ['alpha', 'beta'], topic: 'Pricing', projectContext: { projectId: 'other-chat' } }).success, false)
})

test('a dialogue refuses more than three selected prior results', () => {
  assert.equal(startAgentDialogueRequestSchema.safeParse({ agents: ['alpha', 'beta'], topic: 'Pricing', contextResultIds: ['a', 'b', 'c', 'd'] }).success, false)
})
