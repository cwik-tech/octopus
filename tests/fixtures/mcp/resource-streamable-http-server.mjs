import * as fs from 'node:fs'
import { createServer } from 'node:http'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const ROOT = 'mcp-resource-fixture://resources'
const lifecyclePath = process.env.MCP_FIXTURE_LIFECYCLE_PATH
const requestedPort = process.env.MCP_FIXTURE_PORT
  ? Number(process.env.MCP_FIXTURE_PORT)
  : 0

if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error('MCP_FIXTURE_PORT must be a valid TCP port')
}

const resources = [
  {
    uri: `${ROOT}/text`,
    name: 'Fixture text',
    description: 'Deterministic UTF-8 text resource.',
    mimeType: 'text/plain; charset=utf-8',
  },
  {
    uri: `${ROOT}/binary`,
    name: 'Fixture PNG',
    description: 'Deterministic binary resource.',
    mimeType: 'image/png',
  },
  {
    uri: `${ROOT}/multiple`,
    name: 'Fixture multiple contents',
    description: 'Text and binary contents returned together.',
  },
  {
    uri: `${ROOT}/oversize`,
    name: 'Fixture oversized text',
    mimeType: 'text/plain',
  },
  {
    uri: `${ROOT}/blocked`,
    name: 'Fixture blocked HTML',
    mimeType: 'text/html',
  },
  {
    uri: `${ROOT}/slow`,
    name: 'Fixture slow text',
    mimeType: 'text/plain',
  },
  {
    uri: `${ROOT}/source-failure`,
    name: 'Fixture source failure',
    mimeType: 'text/plain',
  },
  {
    uri: `${ROOT}/malformed`,
    name: 'Fixture malformed response',
    mimeType: 'text/plain',
  },
]

const mcpServer = new Server(
  { name: 'pipeline-mcp-resource-http-fixture', version: '1.0.0' },
  { capabilities: { resources: { listChanged: false, subscribe: false } } },
)

mcpServer.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const cursor = request.params?.cursor
  if (cursor === undefined) {
    return { resources: resources.slice(0, 4), nextCursor: 'fixture-page-2' }
  }
  if (cursor === 'fixture-page-2') {
    return { resources: resources.slice(4) }
  }
  throw new McpError(ErrorCode.InvalidParams, 'Unknown resource cursor')
})

mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
  const { uri } = request.params
  switch (uri) {
    case `${ROOT}/text`:
      return {
        contents: [{
          uri,
          mimeType: 'text/plain; charset=utf-8',
          text: 'mcp-resource-text-marker',
        }],
      }
    case `${ROOT}/binary`:
      return {
        contents: [{
          uri,
          mimeType: 'image/png',
          blob: 'iVBORw0KGgo=',
        }],
      }
    case `${ROOT}/multiple`:
      return {
        contents: [
          {
            uri: `${uri}#text`,
            mimeType: 'text/plain',
            text: 'mcp-resource-multiple-text',
          },
          {
            uri: `${uri}#binary`,
            mimeType: 'image/png',
            blob: 'iVBORw0KGgo=',
          },
        ],
      }
    case `${ROOT}/oversize`:
      return {
        contents: [{ uri, mimeType: 'text/plain', text: 'x'.repeat(1_048_577) }],
      }
    case `${ROOT}/blocked`:
      return {
        contents: [{ uri, mimeType: 'text/html', text: '<script>blocked</script>' }],
      }
    case `${ROOT}/slow`:
      await delay(2_000, extra.signal)
      return {
        contents: [{ uri, mimeType: 'text/plain', text: 'slow-resource' }],
      }
    case `${ROOT}/source-failure`:
      throw new McpError(
        ErrorCode.InternalError,
        'fixture source failed with MCP_FIXTURE_SECRET_DO_NOT_EXPOSE',
      )
    case `${ROOT}/malformed`:
      return {
        contents: [{ uri, mimeType: 'text/plain', unsupported: true }],
      }
    default:
      throw new McpError(ErrorCode.InvalidParams, 'Resource not found')
  }
})

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new McpError(ErrorCode.RequestTimeout, 'Fixture read cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function recordLifecycle(event) {
  if (!lifecyclePath) return
  fs.appendFileSync(lifecyclePath, `${JSON.stringify({
    event,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  })}\n`)
}

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => `resource-fixture-session-${process.pid}`,
})

async function readJsonBody(request) {
  const chunks = []
  let byteCount = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    byteCount += buffer.byteLength
    if (byteCount > 1_048_576) {
      throw new Error('MCP resource fixture request exceeded 1 MiB')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const httpServer = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (pathname !== '/mcp') {
    response.writeHead(404).end()
    return
  }

  try {
    const body = request.method === 'POST' ? await readJsonBody(request) : undefined
    await transport.handleRequest(request, response, body)
  } catch (error) {
    process.stderr.write(`resource HTTP fixture request failed: ${String(error)}\n`)
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      }))
    } else {
      response.destroy()
    }
  }
})

async function closeHttpServer() {
  if (!httpServer.listening) return
  await new Promise((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve())
    httpServer.closeAllConnections()
  })
}

let shuttingDown = false

async function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await mcpServer.close()
    await closeHttpServer()
    recordLifecycle('stopped')
  } catch (error) {
    process.stderr.write(`resource HTTP fixture shutdown failed: ${String(error)}\n`)
    exitCode = 1
  }
  process.exit(exitCode)
}

process.once('SIGINT', () => void shutdown(0))
process.once('SIGTERM', () => void shutdown(0))

try {
  await mcpServer.connect(transport)
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    httpServer.once('error', onError)
    httpServer.listen(requestedPort, '127.0.0.1', () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Resource HTTP fixture did not receive a TCP address')
  }
  recordLifecycle('ready')
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    transport: 'streamable-http',
    pid: process.pid,
    url: `http://127.0.0.1:${address.port}/mcp`,
  })}\n`)
} catch (error) {
  process.stderr.write(`resource HTTP fixture startup failed: ${String(error)}\n`)
  await shutdown(1)
}
