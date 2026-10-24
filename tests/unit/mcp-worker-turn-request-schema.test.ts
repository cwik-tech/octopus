/**
 * The vocabulary a worker turn may name, at the boundary a real child meets.
 *
 * The HTTP route builds its own schema rather than reusing
 * `parseMcpWorkerTurnRequest`, so the two have to agree about what a request
 * may contain — a child accepted by one and refused by the other is a boundary
 * that agrees with nothing.
 *
 * What the closed set is for: `providerConfig` carries endpoints, headers and
 * process permissions, and `domains/mcp/mcp-provider-tool-target.ts:36-44`
 * honours a `base_url` using the **parent's** credentials. Settings describing
 * how a model should answer are the Agent's and may cross; nothing else may,
 * and an unrecognised name is refused rather than ignored, because ignoring it
 * lets a child keep asking.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpWorkerTurnRequestSchema } from '../../contracts/schemas/tool-requests.js'
import { MCP_WORKER_TURN_CONTRACT_VERSION } from '../../domains/mcp/mcp-worker-turn.js'
import { isValidSessionId } from '../../contracts/sessions.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import { normalizeMcpAgentPath } from '../../domains/mcp/mcp-settings.js'
import { BEHAVIOURAL_PROVIDER_OPTION_NAMES } from '../../providers/provider-option-support.js'

const schema = createMcpWorkerTurnRequestSchema({
  contractVersion: MCP_WORKER_TURN_CONTRACT_VERSION,
  isSessionId: isValidSessionId,
  isSafePathSegment,
  normalizeAgentPath: normalizeMcpAgentPath,
  utf8ByteLength: (value) => Buffer.byteLength(value, 'utf8'),
  behaviouralProviderOptions: BEHAVIOURAL_PROVIDER_OPTION_NAMES,
})

const validRequest = {
  version: MCP_WORKER_TURN_CONTRACT_VERSION,
  sessionId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  assignmentId: 'child-33333333-3333-4333-8333-333333333333',
  taskId: '22222222-2222-4222-8222-222222222222',
  processIdentity: '44444444-4444-4444-8444-444444444444',
  workflowId: 'research-workflow',
  workflowStepId: 'research-step',
  agentPath: 'agents/researcher',
  provider: 'openai',
  model: 'fixture/tool-loop',
  thinking: 'medium',
  systemPrompt: 'Answer.',
  userMessage: 'A question.',
} as const

test('behavioural settings are accepted, as the scalars they are', () => {
  const parsed = schema.parse({
    ...validRequest,
    providerOptions: { max_tokens: 4096, temperature: 0.2, reasoning: false },
  })

  assert.deepEqual(parsed.providerOptions, {
    max_tokens: 4096,
    temperature: 0.2,
    reasoning: false,
  })
})

test('a request with no settings is unchanged', () => {
  assert.equal(schema.parse(validRequest).providerOptions, undefined)
  assert.equal(
    schema.parse({ ...validRequest, providerOptions: {} }).providerOptions,
    undefined,
  )
})

test('a name outside the vocabulary refuses the whole request', () => {
  for (const providerOptions of [
    // Names where the request goes. The parent's credentials sign it.
    { base_url: 'https://elsewhere.invalid/v1' },
    // Names what the process may do.
    { sandbox: 'danger-full-access' },
    // Names who the request claims to be from.
    { http_referer: 'https://elsewhere.invalid' },
    // A raw body to merge into the request.
    { extra_body: '{"tools":[]}' },
    // Alongside a legitimate one, which must not carry it through.
    { max_tokens: 4096, base_url: 'https://elsewhere.invalid/v1' },
  ]) {
    assert.throws(
      () => schema.parse({ ...validRequest, providerOptions }),
      `${Object.keys(providerOptions).join(',')} must refuse the request`,
    )
  }
})

test('a reserved name JSON can carry is refused like any other', () => {
  // `__proto__` cannot be written as an own property by an object literal, but
  // `JSON.parse` makes one — which is exactly how a request body arrives. The
  // installed Zod strips it from a `record` before any refinement can see it,
  // so a check written over the parsed value would silently accept the request
  // as though the key had never been sent. The two parsers must agree, and both
  // must refuse it.
  assert.throws(() =>
    schema.parse({
      ...validRequest,
      providerOptions: JSON.parse('{"__proto__":"x"}') as Record<
        string,
        unknown
      >,
    }))
  assert.throws(() =>
    schema.parse({
      ...validRequest,
      providerOptions: JSON.parse(
        '{"__proto__":"x","max_tokens":4096}',
      ) as Record<string, unknown>,
    }))
})

test('a value that is not a scalar refuses the whole request', () => {
  for (const providerOptions of [
    { max_tokens: { value: 4096 } },
    { max_tokens: [4096] },
    { max_tokens: null },
  ]) {
    assert.throws(() =>
      schema.parse({ ...validRequest, providerOptions: providerOptions as never }))
  }
  assert.throws(() =>
    schema.parse({ ...validRequest, providerOptions: 'max_tokens=4096' as never }))
  assert.throws(() =>
    schema.parse({ ...validRequest, providerOptions: [] as never }))
})

test('the raw provider config is still refused whole', () => {
  assert.throws(() =>
    schema.parse({
      ...validRequest,
      providerConfig: { max_tokens: 4096 },
    } as never))
})

test('a number that is not a number refuses the whole request', () => {
  // JSON cannot carry these, but the schema is a boundary for anything that
  // reaches it, and a token ceiling of `NaN` is not a setting.
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() =>
      schema.parse({ ...validRequest, providerOptions: { max_tokens: value } }))
  }
})

test('a worker turn may name any effort level this application can express', () => {
  for (const thinking of ['off', 'minimal', 'xhigh', 'max', 'ultra', 'provider-default']) {
    assert.equal(schema.parse({ ...validRequest, thinking }).thinking, thinking)
  }
})

test('a worker turn may not name a level that is not one of ours', () => {
  assert.throws(() => schema.parse({ ...validRequest, thinking: 'adaptive' }))
})
