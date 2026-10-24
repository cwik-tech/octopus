import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import {
  McpResourceClientError,
  McpResourceClientService,
} from '../../domains/mcp/mcp-resource-client-service.js'
import {
  McpSettingsService,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'

const repoRoot = process.cwd()
const fixtureDirectory = path.join(repoRoot, 'tests', 'fixtures', 'mcp')
const rootUri = 'mcp-resource-fixture://resources'
const cleanupTimeoutMs = 5_000

const codec: McpSecretCodec = {
  encrypt(value) {
    return Buffer.from(
      Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa7),
    ).toString('base64')
  },
  decrypt(value) {
    return Buffer.from(
      Buffer.from(value, 'base64').map((byte) => byte ^ 0xa7),
    ).toString('utf8')
  },
}

interface LifecycleEvent {
  readonly event: 'ready' | 'stopped'
  readonly pid: number
}

interface HttpFixture {
  readonly child: ChildProcess
  readonly pid: number
  readonly url: string
  readonly lifecyclePath: string
  readonly readStderr: () => string
}

function createWorkspace(prefix: string): {
  directory: string
  storagePath: string
  lifecyclePath: string
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    directory,
    storagePath: path.join(directory, 'mcp-settings.json'),
    lifecyclePath: path.join(directory, 'fixture-lifecycle.jsonl'),
  }
}

function readLifecycle(filePath: string): LifecycleEvent[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LifecycleEvent)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = cleanupTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`Timed out waiting for ${description}`)
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)))
  }
}

async function waitForLifecycle(
  filePath: string,
  event: LifecycleEvent['event'],
  pid: number,
): Promise<void> {
  await waitForCondition(
    () => readLifecycle(filePath).some(
      (entry) => entry.event === event && entry.pid === pid,
    ),
    `${event} lifecycle event for ${pid}`,
  )
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error('Timed out waiting for fixture process exit')),
        cleanupTimeoutMs,
      )
    }),
  ])
}

async function stopChild(child: ChildProcess, pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return
  child.kill('SIGTERM')
  await waitForChildExit(child).catch(async () => {
    if (isProcessAlive(pid)) child.kill('SIGKILL')
    await waitForChildExit(child).catch(() => undefined)
  })
}

async function startHttpFixture(
  lifecyclePath: string,
): Promise<HttpFixture> {
  const child = spawn(
    process.execPath,
    [path.join(fixtureDirectory, 'resource-streamable-http-server.mjs')],
    {
      cwd: repoRoot,
      env: { ...process.env, MCP_FIXTURE_LIFECYCLE_PATH: lifecyclePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  if (!child.stdout) throw new Error('HTTP resource fixture stdout is unavailable')
  const stdout = child.stdout

  const ready = await Promise.race([
    new Promise<{ pid: number; url: string }>((resolve, reject) => {
      let buffer = ''
      const cleanup = () => {
        stdout.off('data', onData)
        child.off('exit', onExit)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        reject(new Error(
          `HTTP resource fixture exited early (code=${code}, signal=${signal}): ${stderr}`,
        ))
      }
      const onData = (chunk: Buffer | string) => {
        buffer += String(chunk)
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) {
            try {
              const message = JSON.parse(line) as {
                type?: string
                pid?: number
                url?: string
              }
              if (
                message.type === 'ready'
                && typeof message.pid === 'number'
                && typeof message.url === 'string'
              ) {
                cleanup()
                resolve({ pid: message.pid, url: message.url })
                return
              }
            } catch (error) {
              cleanup()
              reject(error)
              return
            }
          }
          newline = buffer.indexOf('\n')
        }
      }
      stdout.on('data', onData)
      child.once('exit', onExit)
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`Timed out waiting for HTTP resource fixture: ${stderr}`)),
        4_000,
      )
    }),
  ])

  return {
    child,
    pid: ready.pid,
    url: ready.url,
    lifecyclePath,
    readStderr: () => stderr,
  }
}

function expectResourceError(code: McpResourceClientError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpResourceClientError && error.code === code
}

async function exerciseResourceProtocol(
  service: McpResourceClientService,
  serverId: string,
): Promise<void> {
  const listedUris: string[] = []
  let cursor: string | undefined
  do {
    const page = await service.listResources({
      serverId,
      limit: 3,
      ...(cursor ? { cursor } : {}),
    })
    listedUris.push(...page.resources.map((resource) => resource.uri))
    cursor = page.nextCursor
  } while (cursor)

  assert.equal(listedUris.length, 8)
  assert.equal(new Set(listedUris).size, 8)
  assert.ok(listedUris.includes(`${rootUri}/text`))
  assert.ok(listedUris.includes(`${rootUri}/malformed`))

  const text = await service.readResource({
    serverId,
    uri: `${rootUri}/text`,
  })
  assert.equal(text.contents.length, 1)
  assert.equal(text.contents[0]?.kind, 'text')
  assert.equal(
    text.contents[0]?.kind === 'text' ? text.contents[0].text : null,
    'mcp-resource-text-marker',
  )
  assert.equal(text.contents[0]?.mimeType, 'text/plain')

  const binary = await service.readResource({
    serverId,
    uri: `${rootUri}/binary`,
  })
  assert.equal(binary.contents[0]?.kind, 'binary')
  assert.equal(
    binary.contents[0]?.kind === 'binary'
      ? Buffer.from(binary.contents[0].base64, 'base64').toString('hex')
      : null,
    '89504e470d0a1a0a',
  )

  const multiple = await service.readResource({
    serverId,
    uri: `${rootUri}/multiple`,
  })
  assert.deepEqual(
    multiple.contents.map((content) => content.kind),
    ['text', 'binary'],
  )
  assert.equal(multiple.totalBytes, 34)

  await assert.rejects(
    service.readResource({ serverId, uri: `${rootUri}/oversize` }),
    expectResourceError('result_too_large'),
  )
  await assert.rejects(
    service.readResource({ serverId, uri: `${rootUri}/blocked` }),
    expectResourceError('configuration_invalid'),
  )
  await assert.rejects(
    service.readResource({ serverId, uri: `${rootUri}/malformed` }),
    expectResourceError('protocol_error'),
  )

  const cancelled = new AbortController()
  const cancellation = setTimeout(() => cancelled.abort(), 30)
  try {
    await assert.rejects(
      service.readResource({
        serverId,
        uri: `${rootUri}/slow`,
        signal: cancelled.signal,
        timeoutMs: 1_000,
      }),
      expectResourceError('cancelled'),
    )
  } finally {
    clearTimeout(cancellation)
  }

  await assert.rejects(
    service.readResource({
      serverId,
      uri: `${rootUri}/slow`,
      timeoutMs: 30,
    }),
    expectResourceError('timeout'),
  )

  await assert.rejects(
    service.readResource({ serverId, uri: `${rootUri}/source-failure` }),
    (error: unknown) =>
      expectResourceError('protocol_error')(error)
      && !String(error).includes('MCP_FIXTURE_SECRET_DO_NOT_EXPOSE'),
  )
}

test('resource client uses real stdio MCP pagination, reads, failures, cancellation, and cleanup', { timeout: 20_000 }, async () => {
  const workspace = createWorkspace('mcp-resource-stdio-')
  const manager = new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 1_000,
    closeTimeoutMs: 3_000,
  })
  const settings = new McpSettingsService({
    storagePath: workspace.storagePath,
    secretCodec: codec,
    clientManager: manager,
  })
  let fixturePid: number | null = null

  try {
    const created = await settings.saveServer({
      id: 'resource-stdio',
      name: 'Resource stdio fixture',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(fixtureDirectory, 'resource-stdio-server.mjs')],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_FIXTURE_LIFECYCLE_PATH: {
            operation: 'replace',
            value: workspace.lifecyclePath,
          },
        },
      },
    })
    const connected = await settings.validateServer(created.id, {
      stdioTrustAcknowledged: true,
    })
    assert.equal(connected.status, 'connected')
    const snapshot = manager.getSnapshot(created.id)
    fixturePid = snapshot?.processId ?? null
    assert.ok(fixturePid)
    assert.equal(snapshot?.resources.length, 8)
    assert.equal(snapshot?.resources[7]?.uri, `${rootUri}/malformed`)
    await waitForLifecycle(workspace.lifecyclePath, 'ready', fixturePid)

    const resources = new McpResourceClientService({
      settingsService: settings,
      clientManager: manager,
      maxContentBytes: 1_024,
      maxAggregateBytes: 2_048,
      requestTimeoutMs: 1_000,
    })
    await exerciseResourceProtocol(resources, created.id)

    await settings.closeAll()
    await waitForLifecycle(workspace.lifecyclePath, 'stopped', fixturePid)
    await waitForCondition(
      () => !isProcessAlive(fixturePid!),
      `stdio resource fixture ${fixturePid} exit`,
    )
    assert.equal(manager.isConnected(created.id), false)
  } finally {
    await settings.closeAll()
    if (fixturePid && isProcessAlive(fixturePid)) {
      process.kill(fixturePid, 'SIGKILL')
    }
    fs.rmSync(workspace.directory, { recursive: true, force: true })
  }
})

test('resource client uses real Streamable HTTP MCP pagination, reads, failures, cancellation, and cleanup', { timeout: 20_000 }, async () => {
  const workspace = createWorkspace('mcp-resource-http-')
  let fixture: HttpFixture | null = null
  const manager = new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 1_000,
    closeTimeoutMs: 3_000,
  })
  const settings = new McpSettingsService({
    storagePath: workspace.storagePath,
    secretCodec: codec,
    clientManager: manager,
  })

  try {
    fixture = await startHttpFixture(workspace.lifecyclePath)
    await waitForLifecycle(fixture.lifecyclePath, 'ready', fixture.pid)
    const created = await settings.saveServer({
      id: 'resource-http',
      name: 'Resource HTTP fixture',
      transport: {
        type: 'streamable-http',
        url: fixture.url,
        secretHeaders: {
          'X-Resource-Fixture-Secret': {
            operation: 'replace',
            value: 'HTTP_RESOURCE_SECRET_DO_NOT_EXPOSE',
          },
        },
      },
    })
    const connected = await settings.validateServer(created.id)
    assert.equal(connected.status, 'connected')
    const snapshot = manager.getSnapshot(created.id)
    assert.equal(snapshot?.serverVersion?.name, 'pipeline-mcp-resource-http-fixture')
    assert.equal(snapshot?.resources.length, 8)
    assert.equal(snapshot?.resources[7]?.uri, `${rootUri}/malformed`)

    const resources = new McpResourceClientService({
      settingsService: settings,
      clientManager: manager,
      maxContentBytes: 1_024,
      maxAggregateBytes: 2_048,
      requestTimeoutMs: 1_000,
    })
    await exerciseResourceProtocol(resources, created.id)

    await settings.closeAll()
    assert.equal(manager.isConnected(created.id), false)
    assert.equal(isProcessAlive(fixture.pid), true)
    await stopChild(fixture.child, fixture.pid)
    await waitForLifecycle(fixture.lifecyclePath, 'stopped', fixture.pid)
    assert.equal(isProcessAlive(fixture.pid), false, fixture.readStderr())
  } finally {
    await settings.closeAll()
    if (fixture) await stopChild(fixture.child, fixture.pid)
    fs.rmSync(workspace.directory, { recursive: true, force: true })
  }
})
