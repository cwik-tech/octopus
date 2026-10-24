import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MCP_WORKER_TURN_CONTRACT_VERSION,
  parseMcpWorkerTurnRequest,
  parseMcpWorkerTurnResponse,
} from '../../domains/mcp/mcp-worker-turn.js'
import { createMcpWorkerTurnRequestSchema } from '../../contracts/schemas/tool-requests.js'
import { isValidSessionId } from '../../contracts/sessions.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import { normalizeMcpAgentPath } from '../../domains/mcp/mcp-settings.js'
import { BEHAVIOURAL_PROVIDER_OPTION_NAMES } from '../../providers/provider-option-support.js'

const questionContext = { logicalInvocationId: 'chain-step-one', dispatchId: 'dispatch-one', teamId: 'poets', stageId: 'chain' }
const request = {
  version: MCP_WORKER_TURN_CONTRACT_VERSION,
  sessionId: '11111111-1111-4111-8111-111111111111', runId: 'root-one', assignmentId: 'child-one',
  taskId: 'task-one', processIdentity: 'process-one', workflowId: 'workflow-one', workflowStepId: 'write',
  agentPath: 'agents/writer', provider: 'openai', model: 'fixture-model', thinking: 'low',
  systemPrompt: 'Write a dedication.', userMessage: 'Ask for the recipient.', questionContext,
}
const routeSchema = createMcpWorkerTurnRequestSchema({
  contractVersion: MCP_WORKER_TURN_CONTRACT_VERSION, isSessionId: isValidSessionId, isSafePathSegment,
  normalizeAgentPath: normalizeMcpAgentPath, utf8ByteLength: (value) => Buffer.byteLength(value, 'utf8'),
  behaviouralProviderOptions: BEHAVIOURAL_PROVIDER_OPTION_NAMES,
})

test('the worker and HTTP boundary retain the same resumable invocation context', () => {
  assert.deepEqual(parseMcpWorkerTurnRequest(request).questionContext, questionContext)
  assert.deepEqual(routeSchema.parse(request).questionContext, questionContext)
})

test('a structured lead question retains its output schema through both request boundaries', () => {
  const questionOutputSchema = { type: 'object', properties: { decision: { enum: ['select', 'needs_input'] } }, required: ['decision'] }
  const structured = { ...request, questionOutputSchema }
  assert.deepEqual(parseMcpWorkerTurnRequest(structured).questionOutputSchema, questionOutputSchema)
  assert.deepEqual(routeSchema.parse(structured).questionOutputSchema, questionOutputSchema)
  assert.throws(() => parseMcpWorkerTurnRequest({ ...structured, questionContext: undefined }))
  assert.throws(() => routeSchema.parse({ ...structured, questionContext: undefined }))
})

test('a question context cannot select another agent or carry a filesystem path', () => {
  assert.throws(() => parseMcpWorkerTurnRequest({ ...request, questionContext: { ...questionContext, agentId: 'editor' } }))
  assert.throws(() => routeSchema.parse({ ...request, questionContext: { ...questionContext, assignmentPath: '/tmp/elsewhere' } }))
})

test('the worker receives a typed wait with incurred usage and no completed response', () => {
  const response = {
    version: MCP_WORKER_TURN_CONTRACT_VERSION, kind: 'awaiting_input',
    interruption: { kind: 'awaiting_input', interactionId: 'question-one' }, model: 'fixture-model',
    usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    availableToolCount: 1, toolCallCount: 1, executedToolCallCount: 1,
  }
  assert.deepEqual(parseMcpWorkerTurnResponse(response), response)
  assert.throws(() => parseMcpWorkerTurnResponse({ ...response, text: 'A supposedly completed poem.' }))
  assert.throws(() => parseMcpWorkerTurnResponse({ ...response, interruption: { kind: 'awaiting_input', interactionId: '' } }))
})

test('a consumed question allowance crosses the worker boundary as a terminal blocker', () => {
  const response = {
    version: MCP_WORKER_TURN_CONTRACT_VERSION, kind: 'blocked',
    interruption: { kind: 'blocked', code: 'question_limit_reached' }, model: 'fixture-model',
    usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    availableToolCount: 1, toolCallCount: 1, executedToolCallCount: 1,
  }
  assert.deepEqual(parseMcpWorkerTurnResponse(response), response)
})
