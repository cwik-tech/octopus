/**
 * Octopus's MCP server for outside apps such as a voice layer
 * (docs/adr/2026-10-09-Voice-Control-Through-MCP.md).
 *
 * One path on the API server, `/_pipeline-mcp`, authorized by its own bearer
 * token. The API token is not accepted here, and this token is not accepted on
 * any REST route, because the API server compares only its own tokens.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type * as http from 'node:http'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod/v4'

import { ApiRequestError, readJsonBody } from '../../core/http-json-body.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'

export const APP_MCP_PATH = '/_pipeline-mcp'

const MAX_REQUEST_BYTES = 1_048_576
/** Enough for a voice layer and a few test clients; the oldest is dropped past it. */
const MAX_SESSIONS = 16

export interface AppMcpToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

export interface AppMcpToolContext {
  /** Aborted when the client cancels the call or the server shuts down. */
  readonly signal: AbortSignal
  /** Sends `notifications/progress` when the client asked for progress. */
  readonly sendProgress: (progress: number, message?: string) => Promise<void>
}

export interface AppMcpToolResult {
  /** One or two sentences that can be read aloud. Always the first text block. */
  readonly summary: string
  readonly structured: Record<string, unknown>
  readonly isError?: boolean
}

export interface AppMcpTool<Input = unknown> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly annotations: AppMcpToolAnnotations
  readonly input: z.ZodType<Input>
  readonly run: (input: Input, context: AppMcpToolContext) => Promise<AppMcpToolResult>
}

/** Erases a tool's input type so tools with different inputs share one list. */
export function defineAppMcpTool<Input>(tool: AppMcpTool<Input>): AppMcpTool<unknown> {
  return {
    ...tool,
    run: async (input, context) => {
      const parsed = tool.input.safeParse(input)
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, z.prettifyError(parsed.error))
      }
      return tool.run(parsed.data, context)
    },
  }
}

export interface AppMcpEndpoint {
  /** Answers the request when it is for the MCP path. Returns false otherwise. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean>
  close(): Promise<void>
}

interface LiveSession {
  readonly server: Server
  readonly transport: StreamableHTTPServerTransport
}

export function createAppMcpEndpoint(input: {
  readonly token: string
  readonly serverName: string
  readonly serverVersion: string
  readonly tools: readonly AppMcpTool<unknown>[]
}): AppMcpEndpoint {
  const expectedDigest = digest(`Bearer ${input.token}`)
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool] as const))
  const sdkTools: Tool[] = input.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputJsonSchema(tool.input),
    annotations: { title: tool.title, ...tool.annotations },
  }))
  const sessions = new Map<string, LiveSession>()
  const lifetime = new AbortController()

  const createServer = (): Server => {
    const server = new Server(
      { name: input.serverName, version: input.serverVersion },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: sdkTools }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = toolsByName.get(request.params.name)
      if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
      const signal = AbortSignal.any([extra.signal, lifetime.signal])
      const progressToken = request.params._meta?.progressToken
      const result = await tool.run(request.params.arguments ?? {}, {
        signal,
        sendProgress: async (progress, message) => {
          if (progressToken === undefined || signal.aborted) return
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress,
              ...(message === undefined ? {} : { message }),
            },
          })
        },
      })
      return {
        content: [{ type: 'text' as const, text: result.summary }],
        structuredContent: result.structured,
        ...(result.isError === true ? { isError: true } : {}),
      }
    })
    return server
  }

  const openSession = async (): Promise<LiveSession> => {
    const server = createServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, live)
        while (sessions.size > MAX_SESSIONS) {
          const oldest = sessions.keys().next()
          if (oldest.done) break
          const evicted = sessions.get(oldest.value)
          sessions.delete(oldest.value)
          void evicted?.server.close().catch(() => undefined)
        }
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId)
      },
    })
    const live: LiveSession = { server, transport }
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
    }
    await server.connect(new ExactOptionalMcpTransport(transport))
    return live
  }

  return {
    async handle(req, res, url) {
      if (url.pathname !== APP_MCP_PATH) return false
      res.setHeader('cache-control', 'no-store')
      if (url.search !== '') {
        writeError(res, 404, 'Not found')
        return true
      }
      if (req.headers.origin !== undefined) {
        writeError(res, 403, 'Origin not allowed')
        return true
      }
      if (!authorized(req.headers.authorization, expectedDigest)) {
        res.setHeader('www-authenticate', 'Bearer')
        writeError(res, 401, 'Unauthorized')
        return true
      }
      if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
        res.setHeader('allow', 'POST, GET, DELETE')
        writeError(res, 405, 'Method not allowed')
        return true
      }
      if (lifetime.signal.aborted) {
        writeError(res, 503, 'Shutting down')
        return true
      }
      let body: unknown
      try {
        body = req.method === 'POST' ? await readJsonBody(req, MAX_REQUEST_BYTES) : undefined
      } catch (error) {
        writeError(res, error instanceof ApiRequestError ? error.statusCode : 400, 'Invalid MCP request')
        return true
      }
      const sessionHeader = req.headers['mcp-session-id']
      const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined
      let live: LiveSession | undefined
      if (sessionId !== undefined) {
        live = sessions.get(sessionId)
        if (!live) {
          // The spec's answer to an unknown session: the client starts a new one.
          writeError(res, 404, 'Session not found')
          return true
        }
      } else if (isInitializeRequest(body)) {
        live = await openSession()
      } else {
        writeError(res, 400, 'Missing MCP session')
        return true
      }
      await live.transport.handleRequest(req, res, body)
      return true
    },
    async close() {
      lifetime.abort()
      const live = [...sessions.values()]
      sessions.clear()
      await Promise.allSettled(live.map((session) => session.server.close()))
    },
  }
}

function inputJsonSchema(schema: z.ZodType): Tool['inputSchema'] {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' })
  // A boolean schema (`true`/`false`) is valid JSON Schema but not a shape
  // MCP's tool list accepts, and these inputs never produce one.
  const properties: Record<string, object> = {}
  for (const [key, value] of Object.entries(json.properties ?? {})) {
    if (typeof value === 'object') properties[key] = value
  }
  const required = json.required
  return {
    type: 'object',
    properties,
    ...(Array.isArray(required) ? { required: required.filter((key): key is string => typeof key === 'string') } : {}),
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function authorized(header: string | undefined, expected: Buffer): boolean {
  if (typeof header !== 'string') return false
  return timingSafeEqual(digest(header), expected)
}

function isInitializeRequest(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'method' in value &&
    value.method === 'initialize'
  )
}

function writeError(res: http.ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: message }))
}
