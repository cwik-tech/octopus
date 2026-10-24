import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import {
  McpCliHostBridgeError,
  startMcpCliHostBridge,
  type McpCliHostBridge,
  type McpCliHostBridgeCall,
} from '../../domains/mcp/mcp-cli-host-bridge.js'
import {
  classifyMcpToolRisk,
  mcpToolRequiresApproval,
  namespaceMcpToolName,
  type McpNamespacedTool,
} from '../../domains/mcp/mcp-runtime.js'

const requestTimeoutMs = 3_000

test('CLI providers receive image content returned by an admitted tool over MCP', async () => {
  const tool = createTool('documents', 'document_read')
  const image = { mimeType: 'image/jpeg', data: '/9j/2Q==' }
  const bridge = await startMcpCliHostBridge({ tools: [tool], callTool: async () => ({ content: 'Captured screenshot', images: [image] }) })
  const client = new Client({ name: 'visual-cli', version: '1.0.0' })
  try {
    await client.connect(new ExactOptionalMcpTransport(new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { authorization: `Bearer ${bridge.bearerToken}` } },
    })), { timeout: requestTimeoutMs })
    const result = await client.callTool({ name: tool.namespacedName, arguments: {} }, undefined, { timeout: requestTimeoutMs })
    assert.deepEqual(result.content, [
      { type: 'text', text: 'Captured screenshot' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' },
    ])
    assert.equal(result.isError, undefined)
  } finally { await client.close(); await bridge.close() }
})

test('CLI tool image payloads obey the response byte limit', async () => {
  const tool = createTool('documents', 'document_read')
  const bridge = await startMcpCliHostBridge({ tools: [tool], maxResponseBytes: 100, callTool: async () => ({
    content: 'image', images: [{ mimeType: 'image/jpeg', data: Buffer.alloc(100).toString('base64') }],
  }) })
  const client = new Client({ name: 'bounded-visual-cli', version: '1.0.0' })
  try {
    await client.connect(new ExactOptionalMcpTransport(new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { authorization: `Bearer ${bridge.bearerToken}` } },
    })), { timeout: requestTimeoutMs })
    const result = await client.callTool({ name: tool.namespacedName, arguments: {} }, undefined, { timeout: requestTimeoutMs })
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, [{ type: 'text', text: 'Pipeline MCP tool result exceeded the size limit.' }])
  } finally { await client.close(); await bridge.close() }
})

test('CLI tool results reject malformed image payloads without exposing them', async () => {
  const tool = createTool('documents', 'document_read')
  const bridge = await startMcpCliHostBridge({ tools: [tool], callTool: async () => ({
    content: 'image', images: [{ mimeType: 'image/jpeg', data: 'private invalid payload' }],
  }) })
  const client = new Client({ name: 'validated-visual-cli', version: '1.0.0' })
  try {
    await client.connect(new ExactOptionalMcpTransport(new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { authorization: `Bearer ${bridge.bearerToken}` } },
    })), { timeout: requestTimeoutMs })
    const result = await client.callTool({ name: tool.namespacedName, arguments: {} }, undefined, { timeout: requestTimeoutMs })
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, [{ type: 'text', text: 'Pipeline MCP tool execution failed.' }])
    assert.doesNotMatch(JSON.stringify(result), /private invalid payload/)
  } finally { await client.close(); await bridge.close() }
})

test('CLI host bridge exposes only mapped tools and forwards authenticated calls', async () => {
  const echoTool = createTool('server-1', 'echo-marker')
  const unsafeSourceName = 'mcp__server-2__catalog/lookup'
  const unsafeTool = {
    ...createTool('server-2', 'catalog-lookup'),
    namespacedName: unsafeSourceName,
  }
  const calls: McpCliHostBridgeCall[] = []
  let bridge: McpCliHostBridge | null = null
  let client: Client | null = null

  try {
    bridge = await startMcpCliHostBridge({
      tools: [echoTool, unsafeTool],
      callTool: async (call) => {
        calls.push(call)
        if (call.namespacedToolName === unsafeSourceName) {
          return { content: 'lookup-denied', isError: true }
        }
        if (call.arguments.marker === 'throw') {
          throw new Error('credential-bearing callback detail')
        }
        return { content: `echo:${String(call.arguments.marker)}` }
      },
    })

    const url = new URL(bridge.url)
    assert.equal(url.hostname, '127.0.0.1')
    assert.match(url.pathname, /^\/_pipeline-mcp\/[a-f0-9]{48}$/)
    assert.equal(url.search, '')
    assert.equal(url.username, '')
    assert.equal(url.password, '')
    assert.equal(bridge.bearerToken.length, 43)

    const unauthorized = await fetch(bridge.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.headers.get('cache-control'), 'no-store')
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer')

    const wrongPath = await fetch(`${url.origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.bearerToken}` },
      body: '{}',
    })
    assert.equal(wrongPath.status, 404)
    assert.equal(calls.length, 0)

    const browserOrigin = await fetch(bridge.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridge.bearerToken}`,
        origin: 'https://untrusted.example',
      },
      body: '{}',
    })
    assert.equal(browserOrigin.status, 403)
    assert.equal(calls.length, 0)

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { authorization: `Bearer ${bridge.bearerToken}` },
      },
    })
    client = new Client({ name: 'pipeline-cli-bridge-test', version: '1.0.0' })
    await client.connect(new ExactOptionalMcpTransport(transport), { timeout: requestTimeoutMs })
    assert.deepEqual(client.getServerVersion(), {
      name: 'pipeline',
      version: '1.0.0',
    })

    const listed = await client.listTools(undefined, { timeout: requestTimeoutMs })
    const exposedNames = [...bridge.toolMappings.keys()]
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      exposedNames,
    )
    assert.equal(listed.tools.length, 2)
    assert.deepEqual(listed.tools[0]?.inputSchema, echoTool.inputSchema)
    assert.deepEqual(listed.tools[0]?.annotations, echoTool.annotations)
    assert.equal(bridge.toolMappings.get(echoTool.namespacedName), echoTool.namespacedName)
    const mappedUnsafeName = exposedNames[1]
    assert.ok(mappedUnsafeName)
    assert.match(mappedUnsafeName, MCP_SAFE_TOOL_NAME_PATTERN)
    assert.equal(bridge.toolMappings.get(mappedUnsafeName), unsafeSourceName)

    const echo = await client.callTool(
      { name: echoTool.namespacedName, arguments: { marker: 'bridge' } },
      undefined,
      { timeout: requestTimeoutMs },
    )
    assert.deepEqual(echo.content, [{ type: 'text', text: 'echo:bridge' }])
    assert.equal(echo.isError, undefined)

    const denied = await client.callTool(
      { name: mappedUnsafeName, arguments: { query: 'private' } },
      undefined,
      { timeout: requestTimeoutMs },
    )
    assert.deepEqual(denied.content, [{ type: 'text', text: 'lookup-denied' }])
    assert.equal(denied.isError, true)

    const callbackFailure = await client.callTool(
      { name: echoTool.namespacedName, arguments: { marker: 'throw' } },
      undefined,
      { timeout: requestTimeoutMs },
    )
    assert.equal(callbackFailure.isError, true)
    assert.deepEqual(callbackFailure.content, [{
      type: 'text',
      text: 'Pipeline MCP tool execution failed.',
    }])
    assert.doesNotMatch(JSON.stringify(callbackFailure), /credential-bearing/)

    await client.close()
    const reconnectTransport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { authorization: `Bearer ${bridge.bearerToken}` },
      },
    })
    client = new Client({
      name: 'pipeline-cli-bridge-reconnect-test',
      version: '1.0.0',
    })
    await client.connect(
      new ExactOptionalMcpTransport(reconnectTransport),
      { timeout: requestTimeoutMs },
    )
    const reconnected = await client.callTool(
      { name: echoTool.namespacedName, arguments: { marker: 'reconnected' } },
      undefined,
      { timeout: requestTimeoutMs },
    )
    assert.deepEqual(reconnected.content, [{
      type: 'text',
      text: 'echo:reconnected',
    }])

    await assert.rejects(
      client.callTool(
        { name: 'not-authorized', arguments: {} },
        undefined,
        { timeout: requestTimeoutMs },
      ),
      /Unknown Pipeline MCP tool/,
    )
    assert.equal(calls.length, 4)
    assert.notEqual(calls[0]?.toolCallId, calls[1]?.toolCallId)
    assert.notEqual(calls[1]?.toolCallId, calls[2]?.toolCallId)
    for (const call of calls) {
      assert.match(call.toolCallId, UUID_PATTERN)
      assert.equal(call.signal.aborted, false)
    }
    assert.deepEqual(bridge.getCounters(), {
      toolCallsStarted: 4,
      toolCallsCompleted: 4,
      toolCallsFailed: 2,
      activeToolCalls: 0,
    })
  } finally {
    await client?.close().catch(() => undefined)
    await bridge?.close()
  }
})

test('CLI host bridge bounds HTTP requests and tool results', async () => {
  const tool = createTool('server-1', 'large-result')
  const bridge = await startMcpCliHostBridge({
    tools: [tool],
    maxRequestBytes: 1_024,
    maxResponseBytes: 8,
    callTool: async () => ({ content: '123456789' }),
  })
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: {
      headers: { authorization: `Bearer ${bridge.bearerToken}` },
    },
  })
  const client = new Client({ name: 'pipeline-cli-bridge-test', version: '1.0.0' })

  try {
    const oversizedRequest = await fetch(bridge.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridge.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ padding: 'x'.repeat(2_048) }),
    })
    assert.equal(oversizedRequest.status, 413)
    assert.equal(oversizedRequest.headers.get('cache-control'), 'no-store')

    await client.connect(new ExactOptionalMcpTransport(transport), { timeout: requestTimeoutMs })
    const result = await client.callTool(
      { name: tool.namespacedName, arguments: {} },
      undefined,
      { timeout: requestTimeoutMs },
    )
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, [{
      type: 'text',
      text: 'Pipeline MCP tool result exceeded the size limit.',
    }])
    assert.deepEqual(bridge.getCounters(), {
      toolCallsStarted: 1,
      toolCallsCompleted: 1,
      toolCallsFailed: 1,
      activeToolCalls: 0,
    })
  } finally {
    await client.close().catch(() => undefined)
    await bridge.close()
  }
})

test('CLI host bridge aborts active calls and closes its loopback listener', async () => {
  const controller = new AbortController()
  const tool = createTool('server-1', 'wait')
  let callbackEntered!: () => void
  const entered = new Promise<void>((resolve) => { callbackEntered = resolve })
  let callbackAborted = false
  const bridge = await startMcpCliHostBridge({
    tools: [tool],
    signal: controller.signal,
    callTool: async ({ signal }) => {
      callbackEntered()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          callbackAborted = true
          reject(new Error('cancelled'))
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
      return { content: 'unreachable' }
    },
  })
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: {
      headers: { authorization: `Bearer ${bridge.bearerToken}` },
    },
  })
  const client = new Client({ name: 'pipeline-cli-bridge-test', version: '1.0.0' })

  try {
    await client.connect(new ExactOptionalMcpTransport(transport), { timeout: requestTimeoutMs })
    const pendingCall = client.callTool(
      { name: tool.namespacedName, arguments: {} },
      undefined,
      { timeout: requestTimeoutMs },
    )
    await entered
    assert.equal(bridge.getCounters().activeToolCalls, 1)

    controller.abort()
    await Promise.all([bridge.close(), bridge.close()])
    await assert.rejects(pendingCall)
    await waitForCondition(
      () => bridge.getCounters().activeToolCalls === 0,
      requestTimeoutMs,
      'bridge callback cancellation',
    )
    assert.equal(callbackAborted, true)
    assert.deepEqual(bridge.getCounters(), {
      toolCallsStarted: 1,
      toolCallsCompleted: 1,
      toolCallsFailed: 1,
      activeToolCalls: 0,
    })
    await assert.rejects(fetch(bridge.url))
  } finally {
    await client.close().catch(() => undefined)
    await bridge.close()
  }
})

test('CLI host bridge rejects an already-cancelled turn without opening a server', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    startMcpCliHostBridge({
      tools: [],
      signal: controller.signal,
      callTool: async () => ({ content: 'unreachable' }),
    }),
    (error: unknown) =>
      error instanceof McpCliHostBridgeError && error.code === 'cancelled',
  )
})

test('CLI host bridge cancellation during pending listen cannot open a late listener', async () => {
  const controller = new AbortController()
  const prototype = http.Server.prototype as unknown as {
    listen: (...args: unknown[]) => http.Server
  }
  const originalListen = prototype.listen
  let capturedServer: http.Server | undefined
  let releaseListen!: () => void
  const listenGate = new Promise<void>((resolve) => {
    releaseListen = resolve
  })
  let reportListenEntered!: () => void
  const listenEntered = new Promise<void>((resolve) => {
    reportListenEntered = resolve
  })

  prototype.listen = function delayedListen(...args: unknown[]): http.Server {
    capturedServer = this as unknown as http.Server
    reportListenEntered()
    void listenGate.then(() => {
      originalListen.apply(this, args)
    })
    return capturedServer
  }

  try {
    const pending = startMcpCliHostBridge({
      tools: [],
      signal: controller.signal,
      callTool: async () => ({ content: 'unreachable' }),
    })
    await listenEntered
    controller.abort()
    releaseListen()
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof McpCliHostBridgeError && error.code === 'cancelled',
    )
    assert.equal(capturedServer?.listening, false)
  } finally {
    prototype.listen = originalListen
    releaseListen()
    if (capturedServer?.listening) {
      await new Promise<void>((resolve) => capturedServer?.close(() => resolve()))
    }
  }
})

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MCP_SAFE_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

function createTool(serverId: string, toolName: string): McpNamespacedTool {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const
  const risk = classifyMcpToolRisk(annotations)
  return {
    serverId,
    serverName: serverId,
    toolName,
    namespacedName: namespaceMcpToolName(serverId, toolName),
    description: `Deterministic ${toolName} tool.`,
    inputSchema: {
      type: 'object',
      properties: {
        marker: { type: 'string' },
        query: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations,
    risk,
    effect: serialCapabilityEffect('read-only'),
    requiresApproval: mcpToolRequiresApproval(risk),
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`Timed out waiting for ${description}`)
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)))
  }
}
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'

test('CLI host bridge stamps each call with its arrival order in the turn', async () => {
  // CLI providers run their own tool loop in a subprocess, so the host never
  // sees the model's call order except as arrival order at this bridge — and
  // that is observed before any authorization, policy, or budget gate can
  // reorder the calls downstream.
  const tool = createTool('server-1', 'echo-marker')
  const ordinals: Array<number | undefined> = []
  let bridge: McpCliHostBridge | null = null
  let client: Client | null = null

  try {
    bridge = await startMcpCliHostBridge({
      tools: [tool],
      callTool: async (call) => {
        ordinals.push(call.providerCallOrdinal)
        return { content: `echo:${String(call.arguments.marker)}` }
      },
    })
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: {
        headers: { authorization: `Bearer ${bridge.bearerToken}` },
      },
    })
    client = new Client({ name: 'pipeline-cli-bridge-test', version: '1.0.0' })
    await client.connect(new ExactOptionalMcpTransport(transport), { timeout: requestTimeoutMs })
    const proxyName = [...bridge.toolMappings.keys()][0]
    assert.ok(proxyName)

    for (const marker of ['first', 'second', 'third']) {
      await client.callTool(
        { name: proxyName, arguments: { marker } },
        undefined,
        { timeout: requestTimeoutMs },
      )
    }

    assert.deepEqual(ordinals, [0, 1, 2])
  } finally {
    await client?.close().catch(() => undefined)
    await bridge?.close()
  }
})
