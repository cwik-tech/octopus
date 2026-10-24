import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as z from 'zod/v4'

const RESOURCE_URI = 'mcp-fixture://resources/marker'
const lifecyclePath = process.env.MCP_FIXTURE_LIFECYCLE_PATH
const callsPath = process.env.MCP_FIXTURE_CALLS_PATH
const descendantPidPath = process.env.MCP_FIXTURE_DESCENDANT_PID_PATH
const toolStartedPath = process.env.MCP_FIXTURE_TOOL_STARTED_PATH
const toolGatePath = process.env.MCP_FIXTURE_TOOL_GATE_PATH
const toolGateMarker = process.env.MCP_FIXTURE_TOOL_GATE_MARKER ??
  'wait-for-lifecycle'
const toolResponseMarker = process.env.MCP_FIXTURE_RESPONSE_MARKER
const startupGatePath = process.env.MCP_FIXTURE_STARTUP_GATE_PATH
const startupWaitingPath = process.env.MCP_FIXTURE_STARTUP_WAITING_PATH

if (descendantPidPath) {
  const descendant = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ],
    { stdio: 'ignore' },
  )
  if (!descendant.pid) throw new Error('Fixture descendant PID is unavailable')
  fs.writeFileSync(descendantPidPath, String(descendant.pid), 'utf8')
}

function recordLifecycle(event) {
  if (!lifecyclePath) return
  fs.appendFileSync(lifecyclePath, `${JSON.stringify({
    event,
    pid: process.pid,
    secretPresent: Boolean(process.env.MCP_FIXTURE_TEST_SECRET),
    timestamp: new Date().toISOString(),
  })}\n`)
}

const server = new McpServer({
  name: 'pipeline-mcp-stdio-fixture',
  version: '1.0.0',
})

server.registerTool(
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
  async ({ marker }, extra) => {
    if (toolStartedPath && toolGatePath && marker === toolGateMarker) {
      fs.writeFileSync(toolStartedPath, String(process.pid), 'utf8')
      await waitForGate(toolGatePath, extra.signal)
    }
    if (callsPath) {
      fs.appendFileSync(callsPath, `${JSON.stringify({
        tool: 'echo-marker',
        marker,
        pid: process.pid,
        timestamp: new Date().toISOString(),
      })}\n`)
    }
    return {
      content: [{
        type: 'text',
        text: `echo-marker:${toolResponseMarker ?? marker}`,
      }],
    }
  },
)

async function waitForGate(gatePath, signal) {
  while (!fs.existsSync(gatePath)) {
    if (signal.aborted) throw new Error('Fixture tool call was cancelled')
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, 20)
      const onAbort = () => {
        cleanup()
        reject(new Error('Fixture tool call was cancelled'))
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }
}

server.registerResource(
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

let shuttingDown = false

async function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true

  try {
    await server.close()
    recordLifecycle('stopped')
  } catch (error) {
    process.stderr.write(`stdio fixture shutdown failed: ${String(error)}\n`)
    exitCode = 1
  }

  process.exit(exitCode)
}

process.stdin.once('end', () => void shutdown(0))
process.once('SIGINT', () => void shutdown(0))
process.once('SIGTERM', () => void shutdown(0))

try {
  if (startupGatePath) {
    if (startupWaitingPath) {
      fs.writeFileSync(startupWaitingPath, String(process.pid), 'utf8')
    }
    while (!fs.existsSync(startupGatePath)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  await server.connect(new StdioServerTransport())
  recordLifecycle('ready')
  process.stderr.write(`${JSON.stringify({ type: 'ready', transport: 'stdio' })}\n`)
} catch (error) {
  process.stderr.write(`stdio fixture startup failed: ${String(error)}\n`)
  await shutdown(1)
}
