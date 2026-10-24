import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as http from 'node:http'
import test from 'node:test'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import type { McpServerSettings } from '../../domains/mcp/mcp-settings.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'

/** A server whose one tool reports progress twice before it answers. */
async function startProgressServer(): Promise<{ url: string; close(): Promise<void> }> {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString('utf8')
      const body: unknown = text === '' ? undefined : JSON.parse(text)
      const header = req.headers['mcp-session-id']
      let transport = typeof header === 'string' ? transports.get(header) : undefined
      if (!transport) {
        const server = new Server({ name: 'progress', version: '1.0.0' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: 'slow', inputSchema: { type: 'object' as const } }],
        }))
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          const progressToken = request.params._meta?.progressToken
          if (progressToken !== undefined) {
            for (const progress of [1, 2]) {
              await extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress, message: `step ${progress}` },
              })
            }
          }
          return { content: [{ type: 'text' as const, text: 'Finished.' }] }
        })
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sessionId) => {
            transports.set(sessionId, created)
          },
        })
        await server.connect(new ExactOptionalMcpTransport(created))
        transport = created
      }
      await transport.handleRequest(req, res, body)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('No port.')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await Promise.allSettled([...transports.values()].map((transport) => transport.close()))
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
        httpServer.closeAllConnections()
      })
    },
  }
}

function httpServerSettings(url: string): McpServerSettings {
  return {
    id: 'progress-server',
    name: 'Progress server',
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: 'streamable-http',
      url,
      encryptedHeaders: {},
      authentication: { type: 'none' },
    },
    status: 'unvalidated',
    capabilities: { logging: false },
  }
}

test('a caller that asks for progress receives it through the client manager', async () => {
  const server = await startProgressServer()
  const manager = new McpClientManager()
  try {
    await manager.connect(httpServerSettings(server.url))
    const seen: number[] = []

    await manager.callTool('progress-server', { name: 'slow' }, {
      timeoutMs: 30_000,
      idleTimeoutMs: 10_000,
      onprogress: (progress) => {
        seen.push(progress.progress)
      },
    })

    assert.deepEqual(seen, [1, 2])
  } finally {
    await manager.closeAll()
    await server.close()
  }
})
