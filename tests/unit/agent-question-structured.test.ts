import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentQuestionDecision, withoutAgentQuestionDecision } from '../../domains/mcp/agent-question-structured-adapter.js'

test('a structured question extracts only the human request from the nullable decision envelope', () => {
  assert.deepEqual(parseAgentQuestionDecision(JSON.stringify({
    decision: 'needs_input', agents: null, rosterRationale: null,
    progress: 'I need a recipient.', questions: [{ question: 'Who?', reason: 'A dedication requires a recipient.' }],
  })), { progress: 'I need a recipient.', questions: [{ question: 'Who?', reason: 'A dedication requires a recipient.' }] })
})

test('a normal lead decision remains available to its existing selection parser', () => {
  assert.equal(parseAgentQuestionDecision('{"agents":["writer"],"rosterRationale":{"writer":"Write"}}'), undefined)
  assert.equal(parseAgentQuestionDecision('{"decision":"complete","reason":"Done","finalResponse":"A poem."}'), undefined)
})

test('a malformed question is rejected instead of becoming a lead decision', () => {
  assert.throws(() => parseAgentQuestionDecision('{"decision":"needs_input","progress":"Missing detail","questions":[]}'))
})

test('a spent lead allowance removes the question branch and preserves its required final decision', () => {
  const schema = { type: 'object', properties: { decision: { enum: ['complete', 'needs_input'] } }, required: ['decision'], additionalProperties: false }
  assert.deepEqual(withoutAgentQuestionDecision(schema), {
    type: 'object', properties: { decision: { enum: ['complete'] } }, required: ['decision'], additionalProperties: false,
  })
  assert.deepEqual(schema.properties.decision.enum, ['complete', 'needs_input'])
})
