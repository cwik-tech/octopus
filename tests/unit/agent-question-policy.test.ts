import assert from 'node:assert/strict'
import test from 'node:test'

import { agentQuestionRequestSchema, agentQuestionAnswersSchema } from '../../contracts/agent-questions.js'
import { decideAgentQuestionRound, agentQuestionDispatchId } from '../../core/agent-question-policy.js'

const scope = { rootRunId: 'run-one', agentId: 'poetry/writer', logicalInvocationId: 'step-one' }
const digest = 'a'.repeat(64)
const accepted = { ...scope, requestDigest: digest, interactionId: 'question-one' }

test('continuation dispatches have distinct attempt identities under the same logical invocation', () => {
  assert.equal(agentQuestionDispatchId('slot#1#writer', 'attempt-one'), 'slot#1#writer@attempt-one')
  assert.equal(agentQuestionDispatchId('slot#1#writer', 'attempt-two'), 'slot#1#writer@attempt-two')
  assert.equal(agentQuestionDispatchId('slot#1#writer', undefined), 'slot#1#writer')
})

test('answer parsing rejects reserved keys before record normalization can hide them', () => {
  const input: unknown = JSON.parse('{"question-one:1":"Marta","__proto__":"unexpected"}')
  assert.equal(agentQuestionAnswersSchema.safeParse(input).success, false)
})

test('an agent can batch necessary questions without supplying continuation ownership', () => {
  const request = {
    progress: 'The dedication needs a recipient.',
    questions: [{ question: 'Who is it for?', reason: 'The request requires a named recipient.' }],
  }
  assert.deepEqual(agentQuestionRequestSchema.parse(request), request)
  assert.equal(agentQuestionRequestSchema.safeParse({ ...request, agentId: 'another-agent' }).success, false)
})

test('empty or excessive question rounds are rejected at the provider boundary', () => {
  assert.equal(agentQuestionRequestSchema.safeParse({ progress: 'Ready', questions: [] }).success, false)
  assert.equal(agentQuestionRequestSchema.safeParse({
    progress: 'Ready',
    questions: Array.from({ length: 6 }, () => ({ question: 'Who?', reason: 'Required.' })),
  }).success, false)
  assert.equal(agentQuestionRequestSchema.safeParse({
    progress: 'Ready', questions: [{ question: ' ', reason: 'Required.' }],
  }).success, false)
})

test('question content is bounded and cannot carry hidden ownership fields', () => {
  assert.equal(agentQuestionRequestSchema.safeParse({
    progress: ' ', questions: [{ question: 'Who?', reason: 'Required.' }],
  }).success, false)
  assert.equal(agentQuestionRequestSchema.safeParse({
    progress: 'x'.repeat(8_001), questions: [{ question: 'Who?', reason: 'Required.' }],
  }).success, false)
  assert.equal(agentQuestionRequestSchema.safeParse({
    progress: 'Ready', questions: [{ question: 'x'.repeat(2_001), reason: 'Required.' }],
  }).success, false)
  assert.equal(agentQuestionRequestSchema.safeParse({
    progress: 'Ready', questions: [{ question: 'Who?', reason: 'x'.repeat(2_001) }],
  }).success, false)
  assert.equal(agentQuestionRequestSchema.safeParse({
    progress: 'Ready', questions: [{ question: 'Who?', reason: 'Required.', agentId: 'another-agent' }],
  }).success, false)
})

test('the first question round is allowed for an agent in a logical run', () => {
  assert.deepEqual(decideAgentQuestionRound({ ...scope, requestDigest: digest }, []), { kind: 'allow' })
})

test('replaying an accepted request returns its original interaction', () => {
  assert.deepEqual(decideAgentQuestionRound({ ...scope, requestDigest: digest }, [accepted]), {
    kind: 'replay', interactionId: 'question-one',
  })
})

test('the same agent cannot earn another round by revisiting a stage', () => {
  assert.deepEqual(decideAgentQuestionRound({
    ...scope, logicalInvocationId: 'step-two', requestDigest: digest,
  }, [accepted]), { kind: 'rejected', code: 'question_limit_reached' })
})

test('changing the question payload cannot replay an accepted round', () => {
  assert.deepEqual(decideAgentQuestionRound({
    ...scope, requestDigest: 'b'.repeat(64),
  }, [accepted]), { kind: 'rejected', code: 'question_limit_reached' })
})

test('another agent retains its own question round', () => {
  assert.deepEqual(decideAgentQuestionRound({
    ...scope, agentId: 'poetry/editor', requestDigest: digest,
  }, [accepted]), { kind: 'allow' })
})

test('a new user run gives the same agent a new question round', () => {
  assert.deepEqual(decideAgentQuestionRound({
    ...scope, rootRunId: 'run-two', requestDigest: digest,
  }, [accepted]), { kind: 'allow' })
})
