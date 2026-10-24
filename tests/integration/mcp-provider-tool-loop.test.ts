import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  hostAuditedParallelReadEffect,
  serialCapabilityEffect,
} from '../../contracts/capability-effect.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import type { McpServerSettings } from '../../domains/mcp/mcp-settings.js'
import { createOpenAIChatCompletionsToolAdapter } from '../../domains/provider/openai-chat-completions-tool-adapter.js'
import {
  ProviderToolLoopError,
  runProviderToolLoop,
  type ProviderToolDefinition,
  type ProviderToolExecutor,
  type ProviderToolLoopResult,
} from '../../domains/provider/provider-tool-loop.js'

const repoRoot = process.cwd()
const providerFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'providers',
  'openai-tool-loop-server.mjs',
)
const mcpFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)
const timeoutMs = 5_000

interface ProviderFixture {
  readonly url: string
  readonly models: readonly string[]
  close(): Promise<void>
}

test('real OpenAI-compatible provider loop consumes MCP results and fails closed across protocol modes', async () => {
  const providerFixture = await startProviderFixture()
  const manager = new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
    closeTimeoutMs: 3_000,
  })
  const mcpServer = fixtureMcpServer()

  try {
    const modelsResponse = await fetch(`${providerFixture.url}/v1/models`)
    assert.equal(modelsResponse.status, 200)
    const modelsPayload = await modelsResponse.json() as {
      data: Array<{ id: string }>
    }
    assert.deepEqual(
      modelsPayload.data.map((model) => model.id),
      providerFixture.models,
    )

    const snapshot = await manager.connect(mcpServer)
    const discoveredTool = snapshot.tools.find(
      (tool) => tool.toolName === 'echo-marker',
    )
    assert.ok(discoveredTool)
    const tool: ProviderToolDefinition = {
      name: discoveredTool.namespacedName,
      ...whenDefined(discoveredTool.description, (description) => ({ description: description })),
      inputSchema: discoveredTool.inputSchema,
      effect: discoveredTool.effect,
    }

    let normalExecutions = 0
    const normal = await runFixtureModel({
      providerFixture,
      model: 'fixture/tool-loop',
      tool,
      executeTool: createMcpExecutor({
        manager,
        serverId: mcpServer.id,
        rawToolName: discoveredTool.toolName,
        expectedProviderToolName: discoveredTool.namespacedName,
        onExecute: () => { normalExecutions += 1 },
      }),
    })
    assert.equal(
      normal.text,
      'provider-consumed:echo-marker:provider-loop-marker',
    )
    assert.equal(normalExecutions, 1)
    assert.equal(normal.rounds, 2)
    assert.deepEqual(normal.usage, {
      inputTokens: 22,
      outputTokens: 14,
      totalTokens: 36,
    })

    const authenticated = await runFixtureModel({
      providerFixture,
      model: 'fixture/auth',
      apiKey: 'fixture-api-key',
      tool,
      executeTool: createMcpExecutor({
        manager,
        serverId: mcpServer.id,
        rawToolName: discoveredTool.toolName,
        expectedProviderToolName: discoveredTool.namespacedName,
        onExecute: () => undefined,
      }),
    })
    assert.equal(
      authenticated.text,
      'provider-consumed:echo-marker:provider-loop-marker',
    )
    const missingAuth = await captureToolLoopError(runFixtureModel({
      providerFixture,
      model: 'fixture/auth',
      tool,
      executeTool: createUnusedExecutor(),
    }))
    assert.equal(missingAuth.code, 'provider_request_failed')
    assert.equal(missingAuth.statusCode, 401)
    assert.equal(missingAuth.retryable, false)

    let repeatedExecutions = 0
    const repeated = await runFixtureModel({
      providerFixture,
      model: 'fixture/repeated-id',
      tool,
      executeTool: createMcpExecutor({
        manager,
        serverId: mcpServer.id,
        rawToolName: discoveredTool.toolName,
        expectedProviderToolName: discoveredTool.namespacedName,
        onExecute: () => { repeatedExecutions += 1 },
      }),
    })
    assert.equal(
      repeated.text,
      'provider-consumed:echo-marker:provider-loop-marker',
    )
    assert.equal(repeatedExecutions, 1)
    assert.equal(repeated.toolCallCount, 2)
    assert.equal(repeated.executedToolCallCount, 1)
    assert.equal(repeated.cachedToolCallCount, 1)

    let changedExecutions = 0
    const changedId = runFixtureModel({
      providerFixture,
      model: 'fixture/reused-id-changed',
      tool,
      executeTool: createMcpExecutor({
        manager,
        serverId: mcpServer.id,
        rawToolName: discoveredTool.toolName,
        expectedProviderToolName: discoveredTool.namespacedName,
        onExecute: () => { changedExecutions += 1 },
      }),
    })
    await assertToolLoopError(changedId, 'invalid_tool_call')
    assert.equal(changedExecutions, 1)

    for (const model of [
      'fixture/malformed',
      'fixture/duplicate',
      'fixture/empty-id',
    ]) {
      let invalidExecutions = 0
      const invalid = runFixtureModel({
        providerFixture,
        model,
        tool,
        executeTool: createMcpExecutor({
          manager,
          serverId: mcpServer.id,
          rawToolName: discoveredTool.toolName,
          expectedProviderToolName: discoveredTool.namespacedName,
          onExecute: () => { invalidExecutions += 1 },
        }),
      })
      await assertToolLoopError(invalid, 'invalid_tool_call')
      assert.equal(invalidExecutions, 0)
    }

    let callLimitExecutions = 0
    const callLimit = runFixtureModel({
      providerFixture,
      model: 'fixture/limit',
      tool,
      maxToolCalls: 2,
      executeTool: createMcpExecutor({
        manager,
        serverId: mcpServer.id,
        rawToolName: discoveredTool.toolName,
        expectedProviderToolName: discoveredTool.namespacedName,
        onExecute: () => { callLimitExecutions += 1 },
      }),
    })
    await assertToolLoopError(callLimit, 'limit_exceeded')
    assert.equal(callLimitExecutions, 0)

    let roundLimitExecutions = 0
    const roundLimit = runFixtureModel({
      providerFixture,
      model: 'fixture/round-limit',
      tool,
      maxRounds: 2,
      executeTool: createMcpExecutor({
        manager,
        serverId: mcpServer.id,
        rawToolName: discoveredTool.toolName,
        expectedProviderToolName: discoveredTool.namespacedName,
        onExecute: () => { roundLimitExecutions += 1 },
      }),
    })
    await assertToolLoopError(roundLimit, 'limit_exceeded')
    assert.equal(roundLimitExecutions, 2)

    const providerFailure = await captureToolLoopError(runFixtureModel({
      providerFixture,
      model: 'fixture/error',
      tool,
      executeTool: createUnusedExecutor(),
    }))
    assert.equal(providerFailure.code, 'provider_request_failed')
    assert.equal(providerFailure.statusCode, 503)
    assert.equal(
      providerFailure.message.includes('fixture-private-upstream-detail'),
      false,
    )

    await assertToolLoopError(runFixtureModel({
      providerFixture,
      model: 'fixture/invalid-json',
      tool,
      executeTool: createUnusedExecutor(),
    }), 'invalid_provider_response')

    await assertToolLoopError(runFixtureModel({
      providerFixture,
      model: 'fixture/oversized',
      tool,
      maxResponseBytes: 1_024,
      executeTool: createUnusedExecutor(),
    }), 'response_too_large')

    await assertToolLoopError(runFixtureModel({
      providerFixture,
      model: 'fixture/slow',
      tool,
      requestTimeoutMs: 30,
      executeTool: createUnusedExecutor(),
    }), 'timeout')

    await assertToolLoopError(runFixtureModel({
      providerFixture,
      model: 'fixture/tool-loop',
      tool,
      maxRequestBytes: 64,
      executeTool: createUnusedExecutor(),
    }), 'request_too_large')
  } finally {
    await manager.closeAll()
    await providerFixture.close()
  }
})

test('Deep Research writer fixture completes when document tools are available without Browser', async () => {
  const providerFixture = await startProviderFixture()
  let toolExecutions = 0
  try {
    const result = await runProviderToolLoop({
      messages: [
        { role: 'system', content: '# Writer\n\nProduce the reviewed report.' },
        {
          role: 'user',
          content: 'Fixture source URL: http://localhost/evidence',
        },
      ],
      tools: [{
        name: 'generate_word',
        description: 'Generate a Word document from Markdown.',
        effect: serialCapabilityEffect('mutating'),
        inputSchema: {
          type: 'object',
          properties: { markdown: { type: 'string' } },
          required: ['markdown'],
        },
      }],
      adapter: createOpenAIChatCompletionsToolAdapter({
        apiUrl: `${providerFixture.url}/v1/chat/completions`,
        model: 'fixture/deep-research',
        requestTimeoutMs: 3_000,
      }),
      executeTool: async () => {
        toolExecutions += 1
        return { content: 'unexpected document-tool execution' }
      },
    })

    assert.match(result.text, /^# Deep Research Launch Report/m)
    assert.match(result.text, /http:\/\/localhost\/evidence/)
    assert.equal(result.toolCallCount, 0)
    assert.equal(result.executedToolCallCount, 0)
    assert.equal(toolExecutions, 0)
  } finally {
    await providerFixture.close()
  }
})

test('OpenAI-compatible tool requests omit host-internal effect metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-wire-effect-'))
  const requestLogPath = path.join(directory, 'requests.jsonl')
  const providerFixture = await startProviderFixture({ requestLogPath })
  const tool: ProviderToolDefinition = {
    name: 'mcp__fixture__echo_marker',
    description: 'Returns a deterministic marker.',
    effect: hostAuditedParallelReadEffect(),
    inputSchema: {
      type: 'object',
      properties: { marker: { type: 'string' } },
      required: ['marker'],
      additionalProperties: false,
    },
  }

  try {
    await runFixtureModel({
      providerFixture,
      model: 'fixture/tool-loop',
      tool,
      executeTool: async () => ({
        content: JSON.stringify({
          content: [{
            type: 'text',
            text: 'echo-marker:provider-loop-marker',
          }],
        }),
      }),
    })

    const requests = readRequestLog(requestLogPath)
    assert.ok(requests.length > 0)
    const tools = requests[0]?.tools
    assert.ok(Array.isArray(tools))
    const wireTool = tools[0]
    assert.ok(isRecord(wireTool))
    assert.deepEqual(Object.keys(wireTool).sort(), ['function', 'type'])
    assert.equal(wireTool.type, 'function')
    const wireFunction = wireTool.function
    assert.ok(isRecord(wireFunction))
    assert.deepEqual(
      Object.keys(wireFunction).sort(),
      ['description', 'name', 'parameters'],
    )
    assert.equal('effect' in wireTool, false)
    assert.equal('effect' in wireFunction, false)
    assert.equal('concurrency' in wireFunction, false)
    assert.equal('kind' in wireFunction, false)
  } finally {
    await providerFixture.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

async function runFixtureModel(params: {
  providerFixture: ProviderFixture
  model: string
  tool: ProviderToolDefinition
  executeTool: ProviderToolExecutor
  apiKey?: string
  maxRounds?: number
  maxToolCalls?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
}): Promise<ProviderToolLoopResult> {
  return runProviderToolLoop({
    messages: [
      { role: 'system', content: 'Use the marker tool before answering.' },
      { role: 'user', content: 'Return proof from the marker tool.' },
    ],
    tools: [params.tool],
    adapter: createOpenAIChatCompletionsToolAdapter({
      apiUrl: `${params.providerFixture.url}/v1/chat/completions`,
      model: params.model,
      ...whenDefined(params.apiKey, (apiKey) => ({ apiKey: apiKey })),
      requestTimeoutMs: params.requestTimeoutMs ?? 3_000,
      ...whenDefined(params.maxRequestBytes, (maxRequestBytes) => ({ maxRequestBytes: maxRequestBytes })),
      ...whenDefined(params.maxResponseBytes, (maxResponseBytes) => ({ maxResponseBytes: maxResponseBytes })),
    }),
    executeTool: params.executeTool,
    ...whenDefined(params.maxRounds, (maxRounds) => ({ maxRounds: maxRounds })),
    ...whenDefined(params.maxToolCalls, (maxToolCalls) => ({ maxToolCalls: maxToolCalls })),
  })
}

function createMcpExecutor(params: {
  manager: McpClientManager
  serverId: string
  rawToolName: string
  expectedProviderToolName: string
  onExecute(): void
}): ProviderToolExecutor {
  return async (call, context) => {
    assert.equal(call.name, params.expectedProviderToolName)
    params.onExecute()
    const result = await params.manager.callTool(
      params.serverId,
      { name: params.rawToolName, arguments: call.arguments },
      { signal: context.signal, timeoutMs: 3_000 },
    )
    return { content: JSON.stringify(result) }
  }
}

function createUnusedExecutor(): ProviderToolExecutor {
  return async () => {
    assert.fail('Tool executor should not be called')
  }
}

function fixtureMcpServer(): McpServerSettings {
  return {
    id: 'provider-loop-fixture',
    name: 'Provider loop fixture',
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [mcpFixturePath],
      cwd: repoRoot,
      encryptedEnvironment: {},
    },
    status: 'unvalidated',
    capabilities: { logging: false },
  }
}

async function startProviderFixture(
  options: { readonly requestLogPath?: string } = {},
): Promise<ProviderFixture> {
  const child = spawn(process.execPath, [providerFixturePath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(options.requestLogPath
        ? { PROVIDER_FIXTURE_REQUEST_LOG: options.requestLogPath }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  let ready: { url: string; models: string[] }
  try {
    ready = await waitForProviderReady(child, () => stderr)
  } catch (error) {
    await stopChild(child)
    throw error
  }
  return {
    url: ready.url,
    models: ready.models,
    close: () => stopChild(child),
  }
}

function readRequestLog(
  filePath: string,
): readonly Readonly<Record<string, unknown>>[] {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) throw new Error('Provider request log entry is invalid')
      return parsed
    })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function waitForProviderReady(
  child: ChildProcess,
  readStderr: () => string,
): Promise<{ url: string; models: string[] }> {
  if (!child.stdout) throw new Error('Provider fixture stdout is unavailable')
  const stdout = child.stdout
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Provider fixture startup timed out: ${readStderr()}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      child.off('exit', onExit)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(
        `Provider fixture exited before readiness (code=${code}, signal=${signal}): ${readStderr()}`,
      ))
    }
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk)
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line) {
          try {
            const message = JSON.parse(line) as {
              type?: string
              url?: string
              models?: unknown
            }
            if (
              message.type === 'ready' &&
              typeof message.url === 'string' &&
              Array.isArray(message.models) &&
              message.models.every((model) => typeof model === 'string')
            ) {
              cleanup()
              resolve({ url: message.url, models: message.models })
              return
            }
          } catch (error) {
            cleanup()
            reject(new Error(`Invalid provider fixture output: ${String(error)}`))
            return
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForChildExit(child)
  } catch {
    child.kill('SIGKILL')
    await waitForChildExit(child).catch(() => undefined)
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Provider fixture shutdown timed out'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    child.once('exit', onExit)
  })
}

async function assertToolLoopError(
  promise: Promise<unknown>,
  code: ProviderToolLoopError['code'],
): Promise<void> {
  const error = await captureToolLoopError(promise)
  assert.equal(error.code, code)
}

async function captureToolLoopError(
  promise: Promise<unknown>,
): Promise<ProviderToolLoopError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ProviderToolLoopError)
    return error
  }
  assert.fail('Expected provider tool loop to reject')
}
