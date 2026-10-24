import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJsonObject } from '../../contracts/canonical-json.js'
import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import {
  buildAgentTurnStartedPayload,
  buildAgentTurnPreparedPayload,
  reduceAgentTurnStream,
} from '../../domains/agent-execution/agent-turn-journal.js'

function makeEvent(type: string, revision: number, payload: CanonicalJsonObject): ExecutionJournalEvent {
  return {
    schemaVersion: 1, eventId: `assignment:${revision}`, sequence: revision,
    recordedAt: '2026-10-09T12:00:00.000Z', scopeKind: 'assignment',
    scopeId: 'assignment', tenantId: 'local', streamKind: 'agent.turn',
    streamId: 'assignment', streamRevision: revision, type,
    payloadSchemaVersion: 1, appendRequestDigest: 'digest', correlationId: 'turn',
    previousEventHash: 'previous', eventHash: 'hash', payload,
  }
}

function makeStart() {
  return makeEvent('agent.turn.started', 1, buildAgentTurnStartedPayload({
    turnId: 'turn', replyId: 'reply', speakerOrdinal: 0,
    agentPath: 'agents/analyst', requestedModel: 'fixture/model',
  }))
}

test('an Agent that has nothing to add finishes successfully without claiming a transcript message', () => {
  const summary = reduceAgentTurnStream('assignment', [
    makeStart(),
    makeEvent('agent.turn.passed', 2, {
      turnId: 'turn', replyId: 'reply', route: 'mcp-native',
      resolvedModel: 'fixture/resolved', declaredToolCount: 2, executedToolCount: 0,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }),
  ])

  assert.equal(summary.state, 'passed')
  assert.equal(summary.route, 'mcp-native')
  assert.equal(summary.model, 'fixture/resolved')
  assert.equal(summary.assistantMessageId, undefined)
  assert.equal(summary.failure, undefined)
  assert.equal(summary.terminalSequence, 2)
})

test('a pass cannot follow a prepared publication or name a stored message', () => {
  const prepared = makeEvent('agent.turn.prepared', 2, buildAgentTurnPreparedPayload({
    turnId: 'turn', replyId: 'reply', assistantMessageId: 'message',
    outcome: 'success', route: 'mcp-native', outputByteLength: 5,
  }))
  const afterPreparation = reduceAgentTurnStream('assignment', [
    makeStart(), prepared,
    makeEvent('agent.turn.passed', 3, { turnId: 'turn', replyId: 'reply', route: 'mcp-native' }),
  ])
  const claimingMessage = reduceAgentTurnStream('assignment', [
    makeStart(), makeEvent('agent.turn.passed', 2, {
      turnId: 'turn', replyId: 'reply', route: 'mcp-native', assistantMessageId: 'message',
    }),
  ])

  assert.equal(afterPreparation.state, 'invalid')
  assert.equal(claimingMessage.state, 'invalid')
})

test('a pass with a different reply identity or malformed usage is invalid', () => {
  const wrongReply = reduceAgentTurnStream('assignment', [
    makeStart(), makeEvent('agent.turn.passed', 2, {
      turnId: 'turn', replyId: 'other-reply', route: 'mcp-native',
    }),
  ])
  const malformedUsage = reduceAgentTurnStream('assignment', [
    makeStart(), makeEvent('agent.turn.passed', 2, {
      turnId: 'turn', replyId: 'reply', route: 'mcp-native',
      usage: { inputTokens: -1, outputTokens: 2, totalTokens: 1 },
    }),
  ])

  assert.equal(wrongReply.state, 'invalid')
  assert.equal(malformedUsage.state, 'invalid')
})
