import * as fs from 'node:fs'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const ROOT = 'mcp-resource-fixture://resources'
const lifecyclePath = process.env.MCP_FIXTURE_LIFECYCLE_PATH

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

const server = new Server(
  { name: 'pipeline-mcp-resource-stdio-fixture', version: '1.0.0' },
  { capabilities: { resources: { listChanged: false, subscribe: false } } },
)

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const cursor = request.params?.cursor
  if (cursor === undefined) {
    return { resources: resources.slice(0, 4), nextCursor: 'fixture-page-2' }
  }
  if (cursor === 'fixture-page-2') {
    return { resources: resources.slice(4) }
  }
  throw new McpError(ErrorCode.InvalidParams, 'Unknown resource cursor')
})

server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
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
      recordLifecycle('read_started')
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

let shuttingDown = false

async function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await server.close()
    recordLifecycle('stopped')
  } catch (error) {
    process.stderr.write(`resource stdio fixture shutdown failed: ${String(error)}\n`)
    exitCode = 1
  }
  process.exit(exitCode)
}

process.stdin.once('end', () => void shutdown(0))
process.once('SIGINT', () => void shutdown(0))
process.once('SIGTERM', () => void shutdown(0))

try {
  await server.connect(new StdioServerTransport())
  recordLifecycle('ready')
  process.stderr.write(`${JSON.stringify({
    type: 'ready',
    transport: 'stdio',
  })}\n`)
} catch (error) {
  process.stderr.write(`resource stdio fixture startup failed: ${String(error)}\n`)
  await shutdown(1)
}
