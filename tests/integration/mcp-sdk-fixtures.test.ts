import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const repoRoot = process.cwd()
const resourceUri = 'mcp-fixture://resources/marker'
const requestTimeoutMs = 3_000
const cleanupTimeoutMs = 4_000

function fixturePath(name: string): string {
  return path.join(repoRoot, 'tests', 'fixtures', 'mcp', name)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs = cleanupTimeoutMs,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  return withTimeout(
    new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
    timeoutMs,
    'fixture process exit',
  )
}

async function forceStop(child: ChildProcess | null, pid: number | null): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return
  if (child) {
    child.kill('SIGKILL')
    await waitForChildExit(child).catch(() => undefined)
    return
  }

  process.kill(pid, 'SIGKILL')
  await waitForCondition(
    () => !isProcessAlive(pid),
    cleanupTimeoutMs,
    'forced fixture process cleanup',
  ).catch(() => undefined)
}

async function exerciseFixtureClient(
  client: Client,
  expectedServerName: string,
  marker: string,
): Promise<void> {
  assert.deepEqual(client.getServerVersion(), {
    name: expectedServerName,
    version: '1.0.0',
  })

  const capabilities = client.getServerCapabilities()
  assert.ok(capabilities?.tools)
  assert.ok(capabilities?.resources)

  const tools = await client.listTools(undefined, { timeout: requestTimeoutMs })
  assert.equal(tools.tools.length, 1)
  assert.equal(tools.tools[0]?.name, 'echo-marker')
  assert.equal(tools.tools[0]?.annotations?.readOnlyHint, true)

  const resources = await client.listResources(undefined, { timeout: requestTimeoutMs })
  assert.deepEqual(
    resources.resources.map((resource) => resource.uri),
    [resourceUri],
  )

  const toolResult = await client.callTool(
    { name: 'echo-marker', arguments: { marker } },
    undefined,
    { timeout: requestTimeoutMs },
  )
  assert.deepEqual(toolResult.content, [
    { type: 'text', text: `echo-marker:${marker}` },
  ])

  const resource = await client.readResource(
    { uri: resourceUri },
    { timeout: requestTimeoutMs },
  )
  assert.deepEqual(resource.contents, [{
    uri: resourceUri,
    mimeType: 'text/plain',
    text: 'mcp-resource-marker',
  }])

  const ping = await client.ping({ timeout: requestTimeoutMs })
  assert.equal(typeof ping, 'object')
}

type HttpReadyMessage = {
  type: 'ready'
  transport: 'streamable-http'
  pid: number
  url: string
}

async function waitForHttpReady(
  child: ChildProcess,
  readStderr: () => string,
): Promise<HttpReadyMessage> {
  if (!child.stdout) throw new Error('HTTP fixture stdout is unavailable')
  const stdout = child.stdout

  return withTimeout(
    new Promise<HttpReadyMessage>((resolve, reject) => {
      let buffer = ''

      const cleanup = () => {
        stdout.off('data', onData)
        child.off('exit', onExit)
      }
      const finish = (message: HttpReadyMessage) => {
        cleanup()
        resolve(message)
      }
      const fail = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(new Error(
          `HTTP fixture exited before readiness (code=${code}, signal=${signal}): ${readStderr()}`,
        ))
      }
      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) {
            try {
              const message = JSON.parse(line) as Partial<HttpReadyMessage>
              if (
                message.type === 'ready'
                && message.transport === 'streamable-http'
                && typeof message.pid === 'number'
                && typeof message.url === 'string'
              ) {
                finish(message as HttpReadyMessage)
                return
              }
            } catch (error) {
              fail(new Error(`Invalid HTTP fixture readiness message: ${String(error)}`))
              return
            }
          }
          newline = buffer.indexOf('\n')
        }
      }

      stdout.on('data', onData)
      child.once('exit', onExit)
    }),
    requestTimeoutMs,
    'HTTP fixture readiness',
  )
}

test('real MCP SDK stdio fixture completes the protocol handshake and exits on close', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath('stdio-server.mjs')],
    cwd: repoRoot,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'pipeline-mcp-fixture-test', version: '1.0.0' })
  let stderr = ''
  let pid: number | null = null

  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })

  try {
    await client.connect(new ExactOptionalMcpTransport(transport), { timeout: requestTimeoutMs })
    pid = transport.pid
    assert.ok(pid)
    await waitForCondition(
      () => stderr.includes('"transport":"stdio"'),
      requestTimeoutMs,
      'stdio fixture readiness',
    )

    await exerciseFixtureClient(client, 'pipeline-mcp-stdio-fixture', 'stdio')
    await client.close()
    await waitForCondition(
      () => !isProcessAlive(pid!),
      cleanupTimeoutMs,
      'stdio fixture process cleanup',
    )
    assert.equal(isProcessAlive(pid), false)
  } finally {
    await client.close().catch(() => undefined)
    await forceStop(null, pid)
  }
})

test('real MCP SDK Streamable HTTP fixture completes the protocol handshake and shuts down', async () => {
  let child: ChildProcess | null = null
  let client: Client | null = null
  let pid: number | null = null
  let stderr = ''

  try {
    child = spawn(process.execPath, [fixturePath('streamable-http-server.mjs')], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    const ready = await waitForHttpReady(child, () => stderr)
    pid = ready.pid
    assert.equal(pid, child.pid)
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

    const transport = new StreamableHTTPClientTransport(new URL(ready.url))
    client = new Client({ name: 'pipeline-mcp-fixture-test', version: '1.0.0' })
    await client.connect(new ExactOptionalMcpTransport(transport), { timeout: requestTimeoutMs })
    assert.ok(transport.sessionId)

    await exerciseFixtureClient(client, 'pipeline-mcp-http-fixture', 'http')
    await transport.terminateSession()
    assert.equal(transport.sessionId, undefined)
    await client.close()
    client = null

    assert.equal(child.kill('SIGTERM'), true)
    const exit = await waitForChildExit(child)
    assert.deepEqual(exit, { code: 0, signal: null }, stderr)
    assert.equal(isProcessAlive(pid), false)

    await assert.rejects(withTimeout(
      fetch(ready.url, { signal: AbortSignal.timeout(1_000) }),
      1_500,
      'closed HTTP fixture endpoint',
    ))
  } finally {
    await client?.close().catch(() => undefined)
    await forceStop(child, pid)
  }
})
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
