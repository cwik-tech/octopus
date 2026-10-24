import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { handleMcpWorkerTurnRoute } from '../../server/routes/mcp-worker-turn.js'
import { MCP_WORKER_TURN_CONTRACT_VERSION } from '../../domains/mcp/mcp-worker-turn.js'

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
  governedWebEvidenceMode: 'acquire',
  systemPrompt: 'Use tools for evidence.',
  userMessage: 'Research this question.',
} as const

test('private worker route is no-store, POST-only, and registers only parsed requests', async () => {
  let activeRegistrations = 0
  let settledRegistrations = 0
  let serviceCalls = 0
  let observedGovernedWebEvidenceMode: string | undefined
  const server = http.createServer((req, res) => {
    void handleMcpWorkerTurnRoute({
      req,
      res,
      service: {
        runTurn: async (request) => {
          serviceCalls += 1
          observedGovernedWebEvidenceMode = request.governedWebEvidenceMode
          return {
            version: MCP_WORKER_TURN_CONTRACT_VERSION,
            kind: 'no-tools' as const,
            providerSupport: {
              provider: 'openai',
              state: 'supported' as const,
              mode: 'native-tool-loop' as const,
            },
          }
        },
      },
      onActiveController: () => { activeRegistrations += 1 },
      onSettledController: () => { settledRegistrations += 1 },
    })
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/private-worker`

  try {
    const methodResponse = await fetch(url)
    assert.equal(methodResponse.status, 405)
    assert.equal(methodResponse.headers.get('allow'), 'POST')
    assert.equal(methodResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await methodResponse.json(), { error: 'Method not allowed' })

    const malformedResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(malformedResponse.status, 400)
    assert.equal(malformedResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await malformedResponse.json(), {
      error: 'MCP worker request is invalid',
    })
    assert.equal(activeRegistrations, 0)

    const oversizedResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(5 * 1_024 * 1_024 + 1, 0x20),
    })
    assert.equal(oversizedResponse.status, 413)
    assert.equal(oversizedResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await oversizedResponse.json(), {
      error: 'MCP worker request is invalid',
    })
    assert.equal(activeRegistrations, 0)

    const injectedProviderTargetResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validRequest,
        providerConfig: {
          base_url: 'http://127.0.0.1:9999/v1',
          site_url: 'https://worker-controlled.invalid',
          site_name: 'Worker controlled',
          headers: { 'X-Worker-Injected': 'true' },
        },
      }),
    })
    assert.equal(injectedProviderTargetResponse.status, 400)
    assert.equal(
      injectedProviderTargetResponse.headers.get('cache-control'),
      'no-store',
    )
    assert.deepEqual(await injectedProviderTargetResponse.json(), {
      error: 'MCP worker request is invalid',
    })
    assert.equal(activeRegistrations, 0)
    assert.equal(serviceCalls, 0)

    const oversizedUtf8PromptResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validRequest,
        userMessage: '😀'.repeat((2 * 1_024 * 1_024) / 4 + 1),
      }),
    })
    assert.equal(oversizedUtf8PromptResponse.status, 400)
    assert.equal(
      oversizedUtf8PromptResponse.headers.get('cache-control'),
      'no-store',
    )
    assert.deepEqual(await oversizedUtf8PromptResponse.json(), {
      error: 'MCP worker request is invalid',
    })
    assert.equal(activeRegistrations, 0)
    assert.equal(serviceCalls, 0)

    for (const invalidRequest of [
      { ...validRequest, activityScopeId: null },
      { ...validRequest, thinking: 1 },
      { ...validRequest, governedWebEvidenceMode: 'optional' },
    ]) {
      const invalidResponse = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invalidRequest),
      })
      assert.equal(invalidResponse.status, 400)
      assert.equal(invalidResponse.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await invalidResponse.json(), {
        error: 'MCP worker request is invalid',
      })
      assert.equal(activeRegistrations, 0)
      assert.equal(serviceCalls, 0)
    }

    const originDenied = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.com',
      },
      body: JSON.stringify(validRequest),
    })
    assert.equal(originDenied.status, 403)
    assert.equal(originDenied.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await originDenied.json(), { error: 'Origin not allowed' })

    const validResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest),
    })
    assert.equal(validResponse.status, 200)
    assert.equal(validResponse.headers.get('cache-control'), 'no-store')
    assert.equal(activeRegistrations, 1)
    assert.equal(serviceCalls, 1)
    assert.equal(observedGovernedWebEvidenceMode, 'acquire')
    assert.equal(settledRegistrations, 8)
  } finally {
    await close(server)
  }
})

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
