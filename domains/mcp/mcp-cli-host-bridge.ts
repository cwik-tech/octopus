import { whenDefined } from '../../core/optional-properties.js'
import { modelImagesSchema } from '../../contracts/model-image.js'
import type { AgentQuestionInterruption } from '../../contracts/agent-questions.js'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import * as http from 'node:http'
import type { Socket } from 'node:net'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'

import { ApiRequestError, readJsonBody } from '../../core/http-json-body.js'
import { normalizeMcpJsonValue } from './mcp-broker-policy.js'
import type {
  McpJsonObject,
  McpNamespacedTool,
} from './mcp-runtime.js'
import { ExactOptionalMcpTransport } from './mcp-transport-adapter.js'

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/
const SUPPORTED_METHODS = new Set(['POST', 'GET', 'DELETE'])

export interface McpCliHostBridgeCall {
  readonly toolCallId: string
  readonly namespacedToolName: string
  readonly arguments: McpJsonObject
  readonly signal: AbortSignal
  /**
   * Zero-based position of this call in the CLI turn's arrival order.
   *
   * A CLI provider runs its own tool loop inside a subprocess, so the host
   * never observes the model's call order directly. Arrival at this bridge is
   * the closest observable proxy, and it is captured before the dispatcher's
   * authorization, policy, and budget gates can reorder the calls.
   */
  readonly providerCallOrdinal?: number
}

export interface McpCliHostBridgeCallResult {
  readonly interruption?: AgentQuestionInterruption
  readonly content: string
  readonly isError?: boolean
  /** Callback data is validated before it crosses the provider boundary. */
  readonly images?: unknown
}

export interface McpCliHostBridgeOptions {
  /** The exact broker-authorized tool snapshot exposed for this one CLI turn. */
  readonly tools: readonly McpNamespacedTool[]
  readonly callTool: (
    call: McpCliHostBridgeCall,
  ) => McpCliHostBridgeCallResult | Promise<McpCliHostBridgeCallResult>
  /** Aborting the parent turn closes the bridge and cancels active callbacks. */
  readonly signal?: AbortSignal
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
}

export interface McpCliHostBridgeCounters {
  readonly toolCallsStarted: number
  readonly toolCallsCompleted: number
  readonly toolCallsFailed: number
  readonly activeToolCalls: number
}

export interface McpCliHostBridge {
  readonly url: string
  /** A per-turn capability. It must only be passed to the selected CLI process. */
  readonly bearerToken: string
  readonly toolMappings: ReadonlyMap<string, string>
  getCounters(): McpCliHostBridgeCounters
  close(): Promise<void>
}

export class McpCliHostBridgeError extends Error {
  constructor(
    readonly code: 'invalid_configuration' | 'cancelled' | 'startup_failed',
    message: string,
  ) {
    super(message)
    this.name = 'McpCliHostBridgeError'
  }
}

interface MutableMcpCliHostBridgeCounters {
  toolCallsStarted: number
  toolCallsCompleted: number
  toolCallsFailed: number
  activeToolCalls: number
}

interface BridgeToolBinding {
  readonly exposedName: string
  readonly namespacedToolName: string
  readonly sdkTool: Tool
}

export async function startMcpCliHostBridge(
  options: McpCliHostBridgeOptions,
): Promise<McpCliHostBridge> {
  if (options.signal?.aborted) {
    throw new McpCliHostBridgeError(
      'cancelled',
      'The MCP CLI bridge was cancelled before startup.',
    )
  }
  const maxRequestBytes = positiveByteLimit(
    options.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
  )
  const maxResponseBytes = positiveByteLimit(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
  )
  const bindings = createToolBindings(options.tools)
  const bindingByExposedName = new Map(
    bindings.map((binding) => [binding.exposedName, binding] as const),
  )
  const toolMappings = new Map(
    bindings.map((binding) => [
      binding.exposedName,
      binding.namespacedToolName,
    ] as const),
  )
  const bearerToken = randomBytes(32).toString('base64url')
  const expectedAuthorization = Buffer.from(`Bearer ${bearerToken}`)
  const noncePath = `/_pipeline-mcp/${randomBytes(24).toString('hex')}`
  const lifecycleController = new AbortController()
  const counters: MutableMcpCliHostBridgeCounters = {
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
    toolCallsFailed: 0,
    activeToolCalls: 0,
  }

  const createMcpServer = (): Server => {
    const server = new Server(
      { name: 'pipeline', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: bindings.map((binding) => binding.sdkTool),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const binding = bindingByExposedName.get(request.params.name)
      if (!binding) {
        throw new McpError(ErrorCode.InvalidParams, 'Unknown Pipeline MCP tool.')
      }
      const toolCallId = randomUUID()
      const signal = AbortSignal.any([extra.signal, lifecycleController.signal])
      const providerCallOrdinal = counters.toolCallsStarted
      counters.toolCallsStarted += 1
      counters.activeToolCalls += 1
      try {
        if (signal.aborted) {
          counters.toolCallsFailed += 1
          return toolErrorResult('Pipeline MCP tool execution was cancelled.')
        }
        const result = await options.callTool({
          toolCallId,
          providerCallOrdinal,
          namespacedToolName: binding.namespacedToolName,
          arguments: normalizeToolArguments(request.params.arguments),
          signal,
        })
        if (result.interruption) {
          // Withhold the tool response until the owner has stopped the CLI and
          // closes this bridge. Returning it earlier lets the CLI buy a model turn.
          if (!signal.aborted) await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return toolErrorResult('Provider turn is suspended.')
        }
        const validatedImages = modelImagesSchema.parse(result.images ?? [])
        const responseBytes = Buffer.byteLength(result.content, 'utf8')
          + validatedImages.reduce((bytes, image) => bytes + Buffer.byteLength(image.data, 'utf8'), 0)
        if (responseBytes > maxResponseBytes) {
          counters.toolCallsFailed += 1
          return toolErrorResult('Pipeline MCP tool result exceeded the size limit.')
        }
        if (result.isError === true) counters.toolCallsFailed += 1
        return {
          content: [
            { type: 'text' as const, text: result.content },
            ...validatedImages.map((image) => ({ type: 'image' as const, mimeType: image.mimeType, data: image.data })),
          ],
          ...(result.isError === true ? { isError: true } : {}),
        }
      } catch {
        counters.toolCallsFailed += 1
        return toolErrorResult(
          signal.aborted
            ? 'Pipeline MCP tool execution was cancelled.'
            : 'Pipeline MCP tool execution failed.',
        )
      } finally {
        counters.toolCallsCompleted += 1
        counters.activeToolCalls -= 1
      }
    })
    return server
  }
  const createTransport = (): StreamableHTTPServerTransport =>
    new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
  let mcpServer = createMcpServer()
  let transport = createTransport()
  const httpServer = http.createServer()
  const sockets = new Set<Socket>()
  let expectedHost = ''
  let closePromise: Promise<void> | null = null

  httpServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  httpServer.on('request', (request, response) => {
    void handleHttpRequest(request, response).catch(() => {
      if (response.headersSent) response.destroy()
      else writeHttpError(response, 500, 'MCP request failed')
    })
  })

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = closeBridge()
    return closePromise
  }
  const abortListener = () => {
    void close().catch(() => undefined)
  }
  try {
    await mcpServer.connect(new ExactOptionalMcpTransport(transport))
    if (options.signal?.aborted) throw cancelledDuringStartup()
    await listenOnLoopback(httpServer, options.signal)
    options.signal?.addEventListener('abort', abortListener, { once: true })
    const address = httpServer.address()
    if (!address || typeof address === 'string') {
      throw new Error('MCP CLI bridge did not receive a TCP address.')
    }
    expectedHost = `127.0.0.1:${address.port}`
    if (options.signal?.aborted) {
      await close()
      throw cancelledDuringStartup()
    }
    return {
      url: `http://${expectedHost}${noncePath}`,
      bearerToken,
      toolMappings,
      getCounters: () => ({ ...counters }),
      close,
    }
  } catch (error) {
    await close().catch(() => undefined)
    if (error instanceof McpCliHostBridgeError) throw error
    throw new McpCliHostBridgeError(
      'startup_failed',
      'The MCP CLI bridge could not start.',
    )
  }

  async function handleHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (requestUrl.pathname !== noncePath || requestUrl.search !== '') {
      writeHttpError(response, 404, 'Not found')
      return
    }
    if (request.headers.host !== expectedHost) {
      writeHttpError(response, 403, 'Host not allowed')
      return
    }
    if (request.headers.origin !== undefined) {
      writeHttpError(response, 403, 'Origin not allowed')
      return
    }
    if (!hasExpectedAuthorization(request.headers.authorization)) {
      response.setHeader('www-authenticate', 'Bearer')
      writeHttpError(response, 401, 'Unauthorized')
      return
    }
    if (!SUPPORTED_METHODS.has(request.method ?? '')) {
      response.setHeader('allow', 'POST, GET, DELETE')
      writeHttpError(response, 405, 'Method not allowed')
      return
    }
    if (lifecycleController.signal.aborted) {
      writeHttpError(response, 503, 'Bridge closed')
      return
    }

    try {
      const body = request.method === 'POST'
        ? await readJsonBody(request, maxRequestBytes)
        : undefined
      if (
        transport.sessionId &&
        request.headers['mcp-session-id'] === undefined &&
        isInitializeRequest(body)
      ) {
        await mcpServer.close()
        mcpServer = createMcpServer()
        transport = createTransport()
        await mcpServer.connect(new ExactOptionalMcpTransport(transport))
      } else if (
        transport.sessionId &&
        request.headers['mcp-session-id'] === undefined
      ) {
        // FastMCP-based CLI clients currently omit the negotiated session
        // header on later requests. This bridge has exactly one authenticated
        // client per turn, so restoring its sole session is unambiguous.
        request.headers['mcp-session-id'] = transport.sessionId
      }
      await transport.handleRequest(request, response, body)
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof ApiRequestError) {
        writeHttpError(response, error.statusCode, 'Invalid MCP request')
        return
      }
      writeHttpError(response, 500, 'MCP request failed')
    }
  }

  function hasExpectedAuthorization(value: string | undefined): boolean {
    if (typeof value !== 'string') return false
    const received = Buffer.from(value)
    return received.length === expectedAuthorization.length &&
      timingSafeEqual(received, expectedAuthorization)
  }

  async function closeBridge(): Promise<void> {
    lifecycleController.abort()
    options.signal?.removeEventListener('abort', abortListener)
    await mcpServer.close().catch(() => undefined)
    await closeHttpServer(httpServer, sockets)
  }
}

function isInitializeRequest(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { method?: unknown }).method === 'initialize',
  )
}

function createToolBindings(
  tools: readonly McpNamespacedTool[],
): readonly BridgeToolBinding[] {
  const sourceNames = new Set<string>()
  const exposedNames = new Set<string>()
  return tools.map((tool) => {
    if (sourceNames.has(tool.namespacedName)) {
      throw new McpCliHostBridgeError(
        'invalid_configuration',
        'The MCP CLI bridge tool list contains a duplicate tool.',
      )
    }
    sourceNames.add(tool.namespacedName)
    const exposedName = safeExposedToolName(tool.namespacedName)
    if (exposedNames.has(exposedName)) {
      throw new McpCliHostBridgeError(
        'invalid_configuration',
        'The MCP CLI bridge tool list contains a name collision.',
      )
    }
    exposedNames.add(exposedName)
    return {
      exposedName,
      namespacedToolName: tool.namespacedName,
      sdkTool: {
        name: exposedName,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Tool['inputSchema'],
        ...(tool.outputSchema
          ? { ...whenDefined(tool.outputSchema as Tool['outputSchema'], (outputSchema) => ({ outputSchema })) }
          : {}),
        annotations: { ...tool.annotations },
      },
    }
  })
}

function safeExposedToolName(namespacedToolName: string): string {
  if (MCP_TOOL_NAME_PATTERN.test(namespacedToolName)) return namespacedToolName
  const sanitized = namespacedToolName
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const hash = createHash('sha256')
    .update(namespacedToolName)
    .digest('hex')
    .slice(0, 16)
  const prefix = (sanitized || 'pipeline_tool').slice(0, 111)
  return `${prefix}_${hash}`
}

function normalizeToolArguments(value: unknown): McpJsonObject {
  if (value === undefined) return {}
  const normalized = normalizeMcpJsonValue(value)
  if (!isMcpJsonObject(normalized)) {
    throw new McpError(ErrorCode.InvalidParams, 'Tool arguments must be an object.')
  }
  return normalized
}

function isMcpJsonObject(value: unknown): value is McpJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function positiveByteLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new McpCliHostBridgeError(
      'invalid_configuration',
      'MCP CLI bridge byte limits must be positive integers.',
    )
  }
  return value
}

function toolErrorResult(message: string): {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  readonly isError: true
} {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

function writeHttpError(
  response: http.ServerResponse,
  statusCode: number,
  message: string,
): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: message }))
}

function listenOnLoopback(
  server: http.Server,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let aborted = false
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      server.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onError = (error: Error) =>
      finish(aborted || signal?.aborted ? cancelledDuringStartup() : error)
    const onAbort = () => {
      aborted = true
      if (server.listening) {
        server.close(() => finish(cancelledDuringStartup()))
      }
    }
    if (signal?.aborted) {
      finish(cancelledDuringStartup())
      return
    }
    server.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    server.listen(0, '127.0.0.1', () => {
      if (aborted || signal?.aborted) {
        server.close(() => finish(cancelledDuringStartup()))
        return
      }
      finish()
    })
  })
}

function cancelledDuringStartup(): McpCliHostBridgeError {
  return new McpCliHostBridgeError(
    'cancelled',
    'The MCP CLI bridge was cancelled during startup.',
  )
}

function closeHttpServer(
  server: http.Server,
  sockets: ReadonlySet<Socket>,
): Promise<void> {
  if (!server.listening) {
    for (const socket of sockets) socket.destroy()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
    for (const socket of sockets) socket.destroy()
  })
}
