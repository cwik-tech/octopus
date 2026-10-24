import { createServer } from 'node:http'
import * as fs from 'node:fs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as z from 'zod/v4'

const RESOURCE_URI = 'mcp-fixture://resources/marker'
const lifecyclePath = process.env.MCP_FIXTURE_LIFECYCLE_PATH

function recordLifecycle(event) {
  if (!lifecyclePath) return
  fs.appendFileSync(lifecyclePath, `${JSON.stringify({
    event,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  })}\n`)
}

const mcpServer = new McpServer({
  name: 'pipeline-mcp-http-fixture',
  version: '1.0.0',
})

mcpServer.registerTool(
  'echo-marker',
  {
    description: 'Echoes a deterministic marker without changing external state.',
    inputSchema: {
      marker: z.string(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ marker }) => ({
    content: [{ type: 'text', text: `echo-marker:${marker}` }],
  }),
)

mcpServer.registerResource(
  'fixture-marker',
  RESOURCE_URI,
  {
    description: 'Deterministic MCP fixture resource.',
    mimeType: 'text/plain',
  },
  async () => ({
    contents: [{
      uri: RESOURCE_URI,
      mimeType: 'text/plain',
      text: 'mcp-resource-marker',
    }],
  }),
)

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => `fixture-session-${process.pid}`,
})

async function readJsonBody(request) {
  const chunks = []
  let byteCount = 0

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    byteCount += buffer.byteLength
    if (byteCount > 1_048_576) {
      throw new Error('MCP fixture request exceeded 1 MiB')
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
    process.stderr.write(`HTTP fixture request failed: ${String(error)}\n`)
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

let shuttingDown = false

async function closeHttpServer() {
  if (!httpServer.listening) return

  await new Promise((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve())
    httpServer.closeAllConnections()
  })
}

async function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true

  try {
    await mcpServer.close()
    await closeHttpServer()
    recordLifecycle('stopped')
  } catch (error) {
    process.stderr.write(`HTTP fixture shutdown failed: ${String(error)}\n`)
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
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('HTTP fixture did not receive a TCP address')
  }

  recordLifecycle('ready')

  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    transport: 'streamable-http',
    pid: process.pid,
    url: `http://127.0.0.1:${address.port}/mcp`,
  })}\n`)
} catch (error) {
  process.stderr.write(`HTTP fixture startup failed: ${String(error)}\n`)
  await shutdown(1)
}
