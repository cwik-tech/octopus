import { createHash } from 'node:crypto'
import * as fs from 'node:fs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'

const lifecyclePath = process.env.MCP_FIXTURE_LIFECYCLE_PATH
const callsPath = process.env.MCP_FIXTURE_CALLS_PATH
const url = process.env.MCP_FIXTURE_ELICITATION_URL ??
  'https://example.test/pipeline-mcp-authorization'

function appendJsonLine(filePath, value) {
  if (!filePath) return
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`)
}

function recordLifecycle(event) {
  appendJsonLine(lifecyclePath, {
    event,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  })
}

function recordCall(value) {
  appendJsonLine(callsPath, {
    ...value,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  })
}

const server = new McpServer({
  name: 'pipeline-mcp-interactive-fixture',
  version: '1.0.0',
})

server.registerTool(
  'approval-write',
  {
    description: 'Writes a deterministic marker after explicit user approval.',
    inputSchema: { marker: z.string() },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ marker }) => {
    recordCall({ tool: 'approval-write', marker })
    return {
      content: [{ type: 'text', text: `approval-write:${marker}` }],
    }
  },
)

server.registerTool(
  'elicit-form',
  {
    description: 'Collects non-sensitive structured preferences from the user.',
    inputSchema: { marker: z.string() },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ marker }) => {
    const result = await server.server.elicitInput({
      mode: 'form',
      message: 'Choose the public-data result format for this request.',
      requestedSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            title: 'Topic',
            description: 'A non-sensitive public-data topic.',
            minLength: 2,
            maxLength: 80,
          },
          resultCount: {
            type: 'integer',
            title: 'Result count',
            minimum: 1,
            maximum: 10,
            default: 3,
          },
          includeSources: {
            type: 'boolean',
            title: 'Include sources',
            default: true,
          },
          category: {
            type: 'string',
            title: 'Category',
            enum: ['general', 'technical', 'business'],
            default: 'general',
          },
          formats: {
            type: 'array',
            title: 'Formats',
            items: {
              type: 'string',
              enum: ['summary', 'table', 'links'],
            },
            minItems: 1,
            maxItems: 2,
            default: ['summary'],
          },
        },
        required: ['topic', 'resultCount'],
      },
    })
    recordCall({
      tool: 'elicit-form',
      marker,
      action: result.action,
      ...(result.content
        ? {
            valuesHash: createHash('sha256')
              .update(JSON.stringify(result.content), 'utf8')
              .digest('hex'),
          }
        : {}),
    })
    return {
      content: [{ type: 'text', text: `elicit-form:${result.action}:${marker}` }],
    }
  },
)

server.registerTool(
  'elicit-url',
  {
    description: 'Requests an external authorization page from the user.',
    inputSchema: { marker: z.string() },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ marker }) => {
    const result = await server.server.elicitInput({
      mode: 'url',
      message: 'Open the trusted authorization page to continue.',
      url,
      elicitationId: `fixture-url-${marker}`,
    })
    recordCall({ tool: 'elicit-url', marker, action: result.action })
    return {
      content: [{ type: 'text', text: `elicit-url:${result.action}:${marker}` }],
    }
  },
)

let shuttingDown = false

async function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await server.close()
    recordLifecycle('stopped')
  } catch (error) {
    process.stderr.write(`interactive stdio fixture shutdown failed: ${String(error)}\n`)
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
  process.stderr.write(`${JSON.stringify({ type: 'ready', transport: 'stdio' })}\n`)
} catch (error) {
  process.stderr.write(`interactive stdio fixture startup failed: ${String(error)}\n`)
  await shutdown(1)
}
