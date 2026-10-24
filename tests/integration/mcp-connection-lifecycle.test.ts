import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  McpClientManager,
  McpClientManagerError,
} from '../../domains/mcp/mcp-client-manager.js'
import {
  McpSettingsService,
  McpSettingsServiceError,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'

const repoRoot = process.cwd()
const fixtureDirectory = path.join(repoRoot, 'tests', 'fixtures', 'mcp')
const cleanupTimeoutMs = 4_000

const codec: McpSecretCodec = {
  encrypt(value) {
    return Buffer.from(
      Buffer.from(value, 'utf8').map((byte) => byte ^ 0x93),
    ).toString('base64')
  },
  decrypt(value) {
    return Buffer.from(
      Buffer.from(value, 'base64').map((byte) => byte ^ 0x93),
    ).toString('utf8')
  },
}

type LifecycleEvent = {
  event: 'ready' | 'stopped'
  pid: number
  secretPresent?: boolean
}

type HttpFixture = {
  child: ChildProcess
  pid: number
  url: string
  lifecyclePath: string
  readStderr: () => string
}

function createWorkspace(prefix: string): { directory: string; storagePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { directory, storagePath: path.join(directory, 'mcp-settings.json') }
}

function stdioTrustDigest(transport: Record<string, unknown>): string {
  const environment = transport.encryptedEnvironment as Record<
    string,
    { format: string; ciphertext: string }
  >
  return createHash('sha256').update(JSON.stringify({
    command: transport.command,
    args: transport.args,
    cwd: transport.cwd ?? null,
    encryptedEnvironment: Object.entries(environment)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => [key, value.format, value.ciphertext]),
  }), 'utf8').digest('hex')
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

function readLifecycle(filePath: string): LifecycleEvent[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LifecycleEvent)
}

async function waitForLifecycle(
  filePath: string,
  event: LifecycleEvent['event'],
  pid: number,
): Promise<LifecycleEvent> {
  await waitForCondition(
    () => readLifecycle(filePath).some((entry) => entry.event === event && entry.pid === pid),
    cleanupTimeoutMs,
    `${event} lifecycle event for ${pid}`,
  )
  return readLifecycle(filePath).find(
    (entry) => entry.event === event && entry.pid === pid,
  )!
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for child exit')), cleanupTimeoutMs),
    ),
  ])
}

async function stopChild(child: ChildProcess, pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return
  child.kill('SIGTERM')
  await waitForChildExit(child).catch(async () => {
    if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
    await waitForChildExit(child).catch(() => undefined)
  })
}

async function startHttpFixture(directory: string): Promise<HttpFixture> {
  const lifecyclePath = path.join(directory, 'http-lifecycle.jsonl')
  const child = spawn(
    process.execPath,
    [path.join(fixtureDirectory, 'streamable-http-server.mjs')],
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
  if (!child.stdout) throw new Error('HTTP fixture stdout is unavailable')
  const stdout = child.stdout
  const ready = await Promise.race([
    new Promise<{ pid: number; url: string }>((resolve, reject) => {
      let buffer = ''
      const onExit = () => reject(new Error(`HTTP fixture exited early: ${stderr}`))
      const onData = (chunk: Buffer | string) => {
        buffer += String(chunk)
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        try {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            type?: string
            pid?: number
            url?: string
          }
          if (
            message.type === 'ready' &&
            typeof message.pid === 'number' &&
            typeof message.url === 'string'
          ) {
            stdout.off('data', onData)
            child.off('exit', onExit)
            resolve({ pid: message.pid, url: message.url })
          }
        } catch (error) {
          reject(error)
        }
      }
      stdout.on('data', onData)
      child.once('exit', onExit)
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for HTTP fixture')), 3_000),
    ),
  ])
  return {
    child,
    pid: ready.pid,
    url: ready.url,
    lifecyclePath,
    readStderr: () => stderr,
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function errorText(error: unknown): string {
  return `${String(error)} ${JSON.stringify(error)}`
}

test('stdio settings validate, reconnect, hydrate, disable, enable, delete, and close real processes', { timeout: 20_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-stdio-lifecycle-')
  const lifecyclePath = path.join(directory, 'stdio-lifecycle.jsonl')
  const secret = 'stdio-runtime-secret-713d'
  const manager = new McpClientManager({ connectTimeoutMs: 3_000, requestTimeoutMs: 3_000 })
  const service = new McpSettingsService({ storagePath, secretCodec: codec, clientManager: manager })
  let reloadedService: McpSettingsService | null = null

  try {
    const created = await service.saveServer({
      id: 'stdio-tools',
      name: 'Local tools',
      transport: {
        type: 'stdio',
        command: 'node',
        args: [path.join(fixtureDirectory, 'stdio-server.mjs')],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_FIXTURE_LIFECYCLE_PATH: { operation: 'replace', value: lifecyclePath },
          MCP_FIXTURE_TEST_SECRET: { operation: 'replace', value: secret },
        },
      },
    })
    assert.equal(created.status, 'unvalidated')
    assert.equal(manager.isConnected(created.id), false)

    const connected = await service.validateServer(created.id, {
      stdioTrustAcknowledged: true,
    })
    assert.equal(connected.status, 'connected')
    const firstSnapshot = manager.getSnapshot(created.id)
    const firstPid = firstSnapshot?.processId
    assert.ok(firstPid)
    assert.deepEqual(firstSnapshot.capabilities, {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: false },
      logging: false,
    })
    assert.deepEqual(firstSnapshot.tools.map((tool) => tool.namespacedName), [
      'mcp__stdio-tools__echo-marker',
    ])
    assert.deepEqual(firstSnapshot.resources.map((resource) => resource.uri), [
      'mcp-fixture://resources/marker',
    ])
    const ready = await waitForLifecycle(lifecyclePath, 'ready', firstPid)
    assert.equal(ready.secretPresent, true)

    const toolResult = await manager.callTool(created.id, {
      name: 'echo-marker',
      arguments: { marker: 'service-lifecycle' },
    }) as { content: unknown[] }
    assert.deepEqual(toolResult.content, [
      { type: 'text', text: 'echo-marker:service-lifecycle' },
    ])
    const resource = await manager.readResource(
      created.id,
      'mcp-fixture://resources/marker',
    ) as { contents: unknown[] }
    assert.deepEqual(resource.contents, [{
      uri: 'mcp-fixture://resources/marker',
      mimeType: 'text/plain',
      text: 'mcp-resource-marker',
    }])

    await service.validateServer(created.id)
    const secondPid = manager.getSnapshot(created.id)?.processId
    assert.ok(secondPid)
    assert.notEqual(secondPid, firstPid)
    await waitForLifecycle(lifecyclePath, 'stopped', firstPid)
    assert.equal(isProcessAlive(firstPid), false)

    await service.closeAll()
    await waitForLifecycle(lifecyclePath, 'stopped', secondPid)
    assert.equal(manager.isConnected(created.id), false)
    assert.equal(isProcessAlive(secondPid), false)
    await assert.rejects(
      manager.callTool(created.id, { name: 'echo-marker' }),
      (error: unknown) =>
        error instanceof McpClientManagerError && error.code === 'connection_failed',
    )

    const reloadedManager = new McpClientManager({ connectTimeoutMs: 3_000 })
    reloadedService = new McpSettingsService({
      storagePath,
      secretCodec: codec,
      clientManager: reloadedManager,
    })
    await reloadedService.hydrate()
    const hydratedPid = reloadedManager.getSnapshot(created.id)?.processId
    assert.ok(hydratedPid)
    assert.equal((await reloadedService.getServer(created.id))?.status, 'connected')

    const disabled = await reloadedService.setServerEnabled(created.id, false)
    assert.equal(disabled.status, 'disabled')
    await waitForLifecycle(lifecyclePath, 'stopped', hydratedPid)
    assert.equal(reloadedManager.isConnected(created.id), false)
    assert.equal(isProcessAlive(hydratedPid), false)

    const enabled = await reloadedService.setServerEnabled(created.id, true)
    assert.equal(enabled.status, 'connected')
    const enabledPid = reloadedManager.getSnapshot(created.id)?.processId
    assert.ok(enabledPid)
    assert.equal(isProcessAlive(enabledPid), true)

    process.kill(enabledPid, 'SIGTERM')
    await waitForLifecycle(lifecyclePath, 'stopped', enabledPid)
    await waitForCondition(
      () => !reloadedManager.isConnected(created.id),
      cleanupTimeoutMs,
      'unexpected stdio disconnect cleanup',
    )
    const reenabled = await reloadedService.setServerEnabled(created.id, true)
    assert.equal(reenabled.status, 'connected')
    const reenabledPid = reloadedManager.getSnapshot(created.id)?.processId
    assert.ok(reenabledPid)
    assert.notEqual(reenabledPid, enabledPid)

    assert.equal(await reloadedService.deleteServer(created.id), true)
    await waitForLifecycle(lifecyclePath, 'stopped', reenabledPid)
    assert.equal(reloadedManager.isConnected(created.id), false)
    assert.equal(isProcessAlive(reenabledPid), false)
    assert.equal(await reloadedService.getServer(created.id), null)

    const persisted = fs.readFileSync(storagePath, 'utf8')
    assert.equal(persisted.includes(secret), false)
    assert.equal(persisted.includes(lifecyclePath), false)
  } finally {
    await reloadedService?.closeAll()
    await service.closeAll()
    for (const event of readLifecycle(lifecyclePath).filter((entry) => entry.event === 'ready')) {
      if (isProcessAlive(event.pid)) process.kill(event.pid, 'SIGKILL')
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('stdio disable terminates a stubborn descendant tree without signaling the parent process', { timeout: 15_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-stdio-process-tree-')
  const lifecyclePath = path.join(directory, 'stdio-tree-lifecycle.jsonl')
  const descendantPidPath = path.join(directory, 'stdio-descendant.pid')
  const manager = new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
    closeTimeoutMs: 300,
  })
  const service = new McpSettingsService({
    storagePath,
    secretCodec: codec,
    clientManager: manager,
  })
  let rootProcessId: number | undefined
  let descendantProcessId: number | undefined

  try {
    await service.saveServer({
      id: 'stdio-tree-tools',
      name: 'Local process tree tools',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(fixtureDirectory, 'stdio-server.mjs')],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_FIXTURE_LIFECYCLE_PATH: {
            operation: 'replace',
            value: lifecyclePath,
          },
          MCP_FIXTURE_DESCENDANT_PID_PATH: {
            operation: 'replace',
            value: descendantPidPath,
          },
        },
      },
    })
    const connected = await service.validateServer('stdio-tree-tools', {
      stdioTrustAcknowledged: true,
    })
    assert.equal(connected.status, 'connected')
    rootProcessId = manager.getSnapshot('stdio-tree-tools')?.processId
    assert.ok(rootProcessId)
    await waitForCondition(
      () => fs.existsSync(descendantPidPath),
      cleanupTimeoutMs,
      'stdio descendant pid',
    )
    descendantProcessId = Number(fs.readFileSync(descendantPidPath, 'utf8'))
    assert.equal(isProcessAlive(rootProcessId), true)
    assert.equal(isProcessAlive(descendantProcessId), true)
    assert.equal(isProcessAlive(process.pid), true)

    const disabled = await service.setServerEnabled('stdio-tree-tools', false)
    assert.equal(disabled.status, 'disabled')
    await waitForCondition(
      () => !isProcessAlive(rootProcessId!),
      cleanupTimeoutMs,
      'stdio tree root exit',
    )
    await waitForCondition(
      () => !isProcessAlive(descendantProcessId!),
      cleanupTimeoutMs,
      'stdio tree descendant exit',
    )
    assert.equal(manager.isConnected('stdio-tree-tools'), false)
    assert.equal(isProcessAlive(process.pid), true)
  } finally {
    await service.closeAll().catch(() => undefined)
    for (const processId of [descendantProcessId, rootProcessId]) {
      if (processId && isProcessAlive(processId)) {
        process.kill(processId, 'SIGKILL')
      }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Streamable HTTP settings discover real capabilities and remove the live client on delete', { timeout: 15_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-http-lifecycle-')
  const fixture = await startHttpFixture(directory)
  const manager = new McpClientManager({ connectTimeoutMs: 3_000, requestTimeoutMs: 3_000 })
  const service = new McpSettingsService({ storagePath, secretCodec: codec, clientManager: manager })
  const secret = 'http-runtime-secret-94a0'

  try {
    const created = await service.saveServer({
      id: 'http-tools',
      name: 'Remote tools',
      transport: {
        type: 'streamable-http',
        url: fixture.url,
        secretHeaders: {
          'X-Fixture-Token': { operation: 'replace', value: secret },
        },
      },
    })
    const connected = await service.validateServer(created.id)
    assert.equal(connected.status, 'connected')
    const snapshot = manager.getSnapshot(created.id)
    assert.equal(snapshot?.serverVersion?.name, 'pipeline-mcp-http-fixture')
    assert.deepEqual(snapshot?.tools.map((tool) => tool.toolName), ['echo-marker'])
    assert.deepEqual(snapshot?.resources.map((resource) => resource.uri), [
      'mcp-fixture://resources/marker',
    ])
    const toolResult = await manager.callTool(created.id, {
      name: 'echo-marker',
      arguments: { marker: 'http-service' },
    }) as { content: unknown[] }
    assert.deepEqual(toolResult.content, [{ type: 'text', text: 'echo-marker:http-service' }])

    assert.equal(await service.deleteServer(created.id), true)
    assert.equal(manager.isConnected(created.id), false)
    await assert.rejects(manager.readResource(created.id, 'mcp-fixture://resources/marker'))
    assert.equal(fs.readFileSync(storagePath, 'utf8').includes(secret), false)
    assert.equal(isProcessAlive(fixture.pid), true)

    await stopChild(fixture.child, fixture.pid)
    await waitForLifecycle(fixture.lifecyclePath, 'stopped', fixture.pid)
    assert.equal(isProcessAlive(fixture.pid), false, fixture.readStderr())
    await assert.rejects(fetch(fixture.url, { signal: AbortSignal.timeout(750) }))
  } finally {
    await service.closeAll()
    await stopChild(fixture.child, fixture.pid)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('HTTP credentials never follow redirects and stored headers are inactive outside secret-header mode', { timeout: 10_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-http-security-')
  let redirectedRequests = 0
  const receivedAuthorization: Array<string | undefined> = []
  const sink = createServer((_request, response) => {
    redirectedRequests += 1
    response.writeHead(500).end()
  })
  const sinkPort = await listen(sink)
  const redirector = createServer((request, response) => {
    receivedAuthorization.push(request.headers.authorization)
    response.writeHead(307, {
      location: `http://127.0.0.1:${sinkPort}/captured`,
    }).end()
  })
  const redirectPort = await listen(redirector)
  const manager = new McpClientManager({ connectTimeoutMs: 1_000 })
  const service = new McpSettingsService({ storagePath, secretCodec: codec, clientManager: manager })
  const secret = 'redirect-authorization-secret-203f'

  try {
    const created = await service.saveServer({
      id: 'redirect-tools',
      name: 'Redirect tools',
      transport: {
        type: 'streamable-http',
        url: `http://127.0.0.1:${redirectPort}/mcp`,
        secretHeaders: {
          Authorization: { operation: 'replace', value: `Bearer ${secret}` },
        },
        authentication: { type: 'secret-headers' },
      },
    })
    await assert.rejects(
      service.validateServer(created.id),
      (error: unknown) => {
        assert.ok(error instanceof McpSettingsServiceError)
        assert.equal(error.code, 'connection_failed')
        assert.doesNotMatch(errorText(error), new RegExp(secret))
        return true
      },
    )
    assert.deepEqual(receivedAuthorization, [`Bearer ${secret}`])
    assert.equal(redirectedRequests, 0)

    receivedAuthorization.length = 0
    const withoutHeaderMode = await service.updateServer(created.id, {
      name: 'Redirect tools',
      transport: {
        type: 'streamable-http',
        url: `http://127.0.0.1:${redirectPort}/mcp`,
        authentication: { type: 'none' },
      },
    })
    assert.equal(withoutHeaderMode.transport.type, 'streamable-http')
    assert.deepEqual(
      withoutHeaderMode.transport.type === 'streamable-http'
        ? withoutHeaderMode.transport.headerKeys
        : [],
      ['authorization'],
    )
    await assert.rejects(service.validateServer(created.id))
    assert.deepEqual(receivedAuthorization, [undefined])
    assert.equal(redirectedRequests, 0)
    assert.equal(manager.isConnected(created.id), false)
    assert.equal(fs.readFileSync(storagePath, 'utf8').includes(secret), false)
  } finally {
    await service.closeAll()
    await closeServer(redirector)
    await closeServer(sink)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('failed, timed-out, and cancelled stdio validation is sanitized and kills child processes', { timeout: 20_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-failure-cleanup-')
  const failureManager = new McpClientManager({ connectTimeoutMs: 1_000 })
  const failureService = new McpSettingsService({
    storagePath,
    secretCodec: codec,
    clientManager: failureManager,
  })
  const secret = 'failure-secret-62bb'

  try {
    await failureService.saveServer({
      id: 'exiting-tools',
      name: 'Exiting tools',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(2)'],
        secretEnvironment: {
          FAILURE_SECRET: { operation: 'replace', value: secret },
        },
      },
    })
    await assert.rejects(
      failureService.validateServer('exiting-tools', {
        stdioTrustAcknowledged: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpSettingsServiceError)
        assert.equal(error.code, 'connection_failed')
        assert.equal(error.server?.status, 'error')
        assert.doesNotMatch(errorText(error), /failure-secret/)
        return true
      },
    )
    assert.equal(failureManager.isConnected('exiting-tools'), false)

    const timeoutPidPath = path.join(directory, 'timeout.pid')
    const timeoutManager = new McpClientManager({ connectTimeoutMs: 200 })
    const timeoutService = new McpSettingsService({
      storagePath: path.join(directory, 'timeout-settings.json'),
      secretCodec: codec,
      clientManager: timeoutManager,
    })
    await timeoutService.saveServer({
      id: 'timeout-tools',
      name: 'Timeout tools',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
          timeoutPidPath,
        ],
      },
    })
    await assert.rejects(
      timeoutService.validateServer('timeout-tools', {
        stdioTrustAcknowledged: true,
      }),
      (error: unknown) =>
        error instanceof McpSettingsServiceError && error.code === 'timeout',
    )
    assert.equal(fs.existsSync(timeoutPidPath), true)
    const timeoutPid = Number(fs.readFileSync(timeoutPidPath, 'utf8'))
    await waitForCondition(() => !isProcessAlive(timeoutPid), cleanupTimeoutMs, 'timeout child exit')
    assert.equal(timeoutManager.isConnected('timeout-tools'), false)

    const cancelledPidPath = path.join(directory, 'cancelled.pid')
    const cancelledManager = new McpClientManager({
      connectTimeoutMs: 5_000,
      closeTimeoutMs: 100,
    })
    const cancelledService = new McpSettingsService({
      storagePath: path.join(directory, 'cancelled-settings.json'),
      secretCodec: codec,
      clientManager: cancelledManager,
    })
    await cancelledService.saveServer({
      id: 'cancelled-tools',
      name: 'Cancelled tools',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
          cancelledPidPath,
        ],
      },
    })
    const validation = assert.rejects(
      cancelledService.validateServer('cancelled-tools', {
        stdioTrustAcknowledged: true,
      }),
      (error: unknown) =>
        error instanceof McpSettingsServiceError && error.code === 'cancelled',
    )
    await waitForCondition(
      () => fs.existsSync(cancelledPidPath),
      2_000,
      'cancelled child pid file',
    )
    const cancelledPid = Number(fs.readFileSync(cancelledPidPath, 'utf8'))
    await cancelledService.closeAll()
    await validation
    await waitForCondition(
      () => !isProcessAlive(cancelledPid),
      cleanupTimeoutMs,
      'cancelled child exit',
    )
    assert.equal(cancelledManager.isConnected('cancelled-tools'), false)

    const persisted = [
      fs.readFileSync(storagePath, 'utf8'),
      fs.readFileSync(path.join(directory, 'timeout-settings.json'), 'utf8'),
      fs.readFileSync(path.join(directory, 'cancelled-settings.json'), 'utf8'),
    ].join('\n')
    assert.equal(persisted.includes(secret), false)
    await timeoutService.closeAll()
  } finally {
    await failureService.closeAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('hydrate reconnects independent validated servers concurrently and isolates failures', { timeout: 10_000 }, async () => {
  const { directory, storagePath } = createWorkspace('mcp-hydrate-concurrent-')
  const initial = new McpSettingsService({ storagePath, secretCodec: codec })
  const pidPaths = [path.join(directory, 'first.pid'), path.join(directory, 'second.pid')]
  const hangingScript = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)"

  try {
    for (const [index, pidPath] of pidPaths.entries()) {
      await initial.saveServer({
        id: `hydrate-tools-${index + 1}`,
        name: `Hydrate tools ${index + 1}`,
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: ['-e', hangingScript, pidPath],
        },
      })
    }
    const document = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
      servers: Array<Record<string, unknown>>
    }
    for (const server of document.servers) {
      server.status = 'connected'
      server.lastCheckedAt = '2026-07-12T12:00:00.000Z'
      server.stdioTrustDigest = stdioTrustDigest(
        server.transport as Record<string, unknown>,
      )
    }
    fs.writeFileSync(storagePath, JSON.stringify(document))

    const manager = new McpClientManager({ connectTimeoutMs: 300 })
    const service = new McpSettingsService({ storagePath, secretCodec: codec, clientManager: manager })
    const startedAt = Date.now()
    await service.hydrate()
    const elapsedMs = Date.now() - startedAt

    assert.ok(elapsedMs < 3_750, `Expected concurrent hydration, received ${elapsedMs}ms`)
    const views = await service.listServers()
    assert.deepEqual(views.map((view) => view.status), ['error', 'error'])
    for (const [index, pidPath] of pidPaths.entries()) {
      assert.equal(fs.existsSync(pidPath), true)
      const pid = Number(fs.readFileSync(pidPath, 'utf8'))
      await waitForCondition(() => !isProcessAlive(pid), cleanupTimeoutMs, 'hydration child exit')
      assert.equal(manager.isConnected(`hydrate-tools-${index + 1}`), false)
    }
    await service.closeAll()
  } finally {
    await initial.closeAll()
    for (const pidPath of pidPaths) {
      if (!fs.existsSync(pidPath)) continue
      const pid = Number(fs.readFileSync(pidPath, 'utf8'))
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
